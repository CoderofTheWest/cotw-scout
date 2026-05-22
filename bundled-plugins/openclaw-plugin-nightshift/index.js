/**
 * openclaw-plugin-nightshift
 *
 * Night shift scheduler for heavy processing tasks.
 * Respects user workflow by running LLM-intensive operations during off-hours.
 *
 * Features:
 * - Time-based office hours (default: 10:30pm-5:00am Pacific)
 * - "Good night" detection starts office hours early
 * - Interruptible processing (pauses on user activity)
 * - Task queue with priorities
 * - Resume after interruption
 *
 * Provides scheduling for:
 * - Contemplative inquiry (priority 50)
 * - Trait crystallization (priority 25)
 * - Metabolism batch processing (priority 10)
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { instrumentApiHooks } = require('../lib/runtime-metrics');

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function loadConfig(userConfig = {}) {
    const defaultConfig = JSON.parse(
        fs.readFileSync(path.join(__dirname, 'config.default.json'), 'utf8')
    );
    return deepMerge(defaultConfig, userConfig);
}

function deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
            result[key] = deepMerge(target[key] || {}, source[key]);
        } else {
            result[key] = source[key];
        }
    }
    return result;
}

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
    return dirPath;
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

module.exports = {
    id: 'nightshift',
    name: 'Night Shift Scheduler',

    configSchema: {
        jsonSchema: {
            type: 'object',
            properties: {
                enabled: { type: 'boolean' },
                schedule: { type: 'object' },
                triggers: { type: 'object' },
                processing: { type: 'object' },
                tasks: { type: 'object' },
                diagnostics: { type: 'object' },
                state: { type: 'object' }
            }
        }
    },

    register(api) {
        api = instrumentApiHooks(api, 'nightshift');
        const config = loadConfig(api.pluginConfig || {});

        if (!config.enabled) {
            api.logger.info('Night shift scheduler disabled via config');
            return;
        }

        const baseDataDir = ensureDir(path.join(__dirname, 'data'));

        /**
         * Per-agent state container
         */
        class AgentState {
            constructor(agentId) {
                this.agentId = agentId;
                this.dataDir = agentId === 'main' 
                    ? baseDataDir 
                    : ensureDir(path.join(baseDataDir, 'agents', agentId));

                this.statePath = path.join(this.dataDir, config.state?.persistPath || 'state.json');

                // Task queue (priority-ordered)
                this.taskQueue = [];

                // Currently running task (for resume)
                this.currentTask = null;

                // Processing state
                this.isProcessing = false;
                this.cyclesThisNight = 0;
                this.idleCyclesToday = 0;
                this.idleCyclesDate = new Date().toDateString();

                // Catchup tracking (Phase 5): timestamp of the last successful
                // task completion (any type) and the last time a session-start
                // catchup forceRun fired. Persisted so sleep/wake gaps are
                // detectable across process restarts.
                this.lastTaskCompletedAt = null;
                this.lastCatchupAt = null;
                this.lastReportWrittenAt = null;

                this.loadState();
            }

            loadState() {
                try {
                    if (fs.existsSync(this.statePath)) {
                        const raw = fs.readFileSync(this.statePath, 'utf8');
                        const saved = JSON.parse(raw);
                        this.officeHoursActive = saved.officeHoursActive || false;
                        this.goodNightTime = saved.goodNightTime || null;
                        this.lastUserActivity = saved.lastUserActivity || null;
                        this.lastMorningGreeting = saved.lastMorningGreeting || null;
                        this.processedTonight = saved.processedTonight || {};
                        this.timezone = saved.timezone || config.schedule?.defaultOfficeHours?.timezone || 'America/Los_Angeles';
                        this.lastTaskCompletedAt = saved.lastTaskCompletedAt || null;
                        this.lastCatchupAt = saved.lastCatchupAt || null;
                        this.lastReportWrittenAt = saved.lastReportWrittenAt || null;
                    } else {
                        this.officeHoursActive = false;
                        this.goodNightTime = null;
                        this.lastUserActivity = null;
                        this.lastMorningGreeting = null;
                        this.processedTonight = {};
                        this.timezone = config.schedule?.defaultOfficeHours?.timezone || 'America/Los_Angeles';
                        // Seed to "now" on fresh install so first session start
                        // doesn't spuriously fire catchup before any scheduled
                        // run has had a chance to miss its window.
                        this.lastTaskCompletedAt = Date.now();
                        this.lastCatchupAt = null;
                        this.lastReportWrittenAt = null;
                    }
                } catch (e) {
                    api.logger.warn(`[NightShift:${this.agentId}] Failed to load state:`, e.message);
                    this.officeHoursActive = false;
                    this.goodNightTime = null;
                    this.lastUserActivity = null;
                    this.lastMorningGreeting = null;
                    this.processedTonight = {};
                    this.timezone = config.schedule?.defaultOfficeHours?.timezone || 'America/Los_Angeles';
                    this.lastTaskCompletedAt = null;
                    this.lastCatchupAt = null;
                    this.lastReportWrittenAt = null;
                }
            }

            saveState() {
                try {
                    const state = {
                        officeHoursActive: this.officeHoursActive,
                        goodNightTime: this.goodNightTime,
                        lastUserActivity: this.lastUserActivity,
                        lastMorningGreeting: this.lastMorningGreeting,
                        processedTonight: this.processedTonight,
                        timezone: this.timezone,
                        lastTaskCompletedAt: this.lastTaskCompletedAt,
                        lastCatchupAt: this.lastCatchupAt,
                        lastReportWrittenAt: this.lastReportWrittenAt,
                        savedAt: new Date().toISOString()
                    };
                    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2));
                } catch (e) {
                    api.logger.warn(`[NightShift:${this.agentId}] Failed to save state:`, e.message);
                }
            }

            /**
             * Check if currently in office hours.
             * Supports both time-based and good-night-triggered office hours.
             */
            isInOfficeHours() {
                const now = new Date();

                // Check if good night triggered office hours
                if (this.goodNightTime) {
                    const bufferMs = (config.schedule?.goodNightBufferMinutes || 30) * 60 * 1000;
                    // goodNightTime may be a string (loaded from JSON) or Date object (set in-session)
                    const gnTime = this.goodNightTime instanceof Date
                        ? this.goodNightTime
                        : new Date(this.goodNightTime);
                    if (isNaN(gnTime.getTime())) return false; // Invalid date, skip
                    const officeStart = new Date(gnTime.getTime() + bufferMs);

                    // Office hours from goodNight + buffer until 5am next day
                    const officeEnd = new Date(officeStart);
                    officeEnd.setHours(5, 0, 0, 0);
                    if (officeEnd <= officeStart) {
                        officeEnd.setDate(officeEnd.getDate() + 1);
                    }

                    // Check morning greeting to end office hours early
                    if (this.lastMorningGreeting) {
                        const morningTime = new Date(this.lastMorningGreeting);
                        if (morningTime > officeStart && morningTime < officeEnd) {
                            return false; // Morning greeting ended office hours
                        }
                    }

                    if (now >= officeStart && now < officeEnd) {
                        return true;
                    }
                }

                // Check default time-based office hours
                const defaultHours = config.schedule?.defaultOfficeHours;
                if (defaultHours) {
                    const [startHour, startMin] = defaultHours.start.split(':').map(Number);
                    const [endHour, endMin] = defaultHours.end.split(':').map(Number);

                    const currentHour = now.getHours();
                    const currentMin = now.getMinutes();
                    const currentMins = currentHour * 60 + currentMin;
                    const startMins = startHour * 60 + startMin;
                    const endMins = endHour * 60 + endMin;

                    // Handle overnight window (e.g., 22:30 - 05:00)
                    if (startMins > endMins) {
                        // Overnight: active if current >= start OR current < end
                        return currentMins >= startMins || currentMins < endMins;
                    } else {
                        // Same day: active if between start and end
                        return currentMins >= startMins && currentMins < endMins;
                    }
                }

                return false;
            }

            /**
             * Check if user has been active recently.
             */
            isUserActive() {
                if (!this.lastUserActivity) return false;
                const thresholdMs = (config.schedule?.userActiveThresholdMinutes || 5) * 60 * 1000;
                return (Date.now() - this.lastUserActivity) < thresholdMs;
            }

            /**
             * Check if user has been idle long enough for daytime processing.
             * This allows nightshift tasks to run during the day when the user
             * has stepped away, not just during the overnight window.
             */
            isIdleEnough() {
                if (!this.lastUserActivity) return false;
                const idleMinutes = config.processing?.idleProcessingMinutes || 15;
                const idleMs = idleMinutes * 60 * 1000;
                return (Date.now() - this.lastUserActivity) >= idleMs;
            }

            /**
             * Queue a task for processing.
             */
            queueTask(task) {
                const taskWithMeta = {
                    ...task,
                    id: task.id || `task_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
                    queued: Date.now(),
                    attempts: 0
                };

                // Insert by priority (higher priority = processed first)
                const insertIndex = this.taskQueue.findIndex(t => t.priority < taskWithMeta.priority);
                if (insertIndex === -1) {
                    this.taskQueue.push(taskWithMeta);
                } else {
                    this.taskQueue.splice(insertIndex, 0, taskWithMeta);
                }

                api.logger.info(`[NightShift:${this.agentId}] Queued task: ${taskWithMeta.id} (priority: ${taskWithMeta.priority})`);
                return taskWithMeta.id;
            }

            /**
             * Get next task to process.
             */
            getNextTask() {
                // Filter out tasks that hit max attempts
                this.taskQueue = this.taskQueue.filter(t => t.attempts < 3);
                return this.taskQueue.shift();
            }

            /**
             * Reset nightly counters (call at start of new office hours).
             */
            resetNightlyCounters() {
                this.cyclesThisNight = 0;
                this.processedTonight = {};
                this.lastReportWrittenAt = null;
            }
        }

        /** @type {Map<string, AgentState>} */
        const agentStates = new Map();

        function getAgentState(agentId) {
            const id = agentId || 'main';
            if (!agentStates.has(id)) {
                agentStates.set(id, new AgentState(id));
                api.logger.info(`[NightShift] Initialized state for agent "${id}"`);
            }
            return agentStates.get(id);
        }

        // Bootstrap known agents from persisted data directory
        // This ensures the timer can find agents even on cold start (gateway
        // restart during office hours with no active conversations).
        // Also try to resolve workspace paths from gateway config so seeders
        // can find agent data even before the first user message.
        try {
            // Try to read workspace paths from openclaw.json agent list
            const agentWorkspaces = {};
            try {
                const configPaths = [
                    path.join(os.homedir(), '.openclaw-cotw', 'openclaw.json'),
                    path.join(os.homedir(), '.openclaw', 'openclaw.json')
                ];
                for (const cp of configPaths) {
                    if (fs.existsSync(cp)) {
                        const ocConfig = JSON.parse(fs.readFileSync(cp, 'utf8'));
                        const agents = ocConfig.agents?.list || [];
                        for (const a of agents) {
                            if (a.id && a.workspace) {
                                agentWorkspaces[a.id] = a.workspace;
                            }
                        }
                        break;
                    }
                }
            } catch (e) {
                api.logger.debug(`[NightShift] Could not read agent workspaces from config: ${e.message}`);
            }

            const agentsDir = path.join(baseDataDir, 'agents');
            if (fs.existsSync(agentsDir)) {
                const dirs = fs.readdirSync(agentsDir, { withFileTypes: true });
                for (const d of dirs) {
                    if (d.isDirectory()) {
                        const state = getAgentState(d.name);
                        // Set workspace path from config if available
                        if (agentWorkspaces[d.name] && !state._workspaceDir) {
                            state._workspaceDir = agentWorkspaces[d.name];
                            api.logger.info(`[NightShift:${d.name}] Workspace resolved from config: ${state._workspaceDir}`);
                        }
                    }
                }
            }
            // Also bootstrap 'main' if state file exists at base data dir
            const mainStatePath = path.join(baseDataDir, config.state?.persistPath || 'state.json');
            if (fs.existsSync(mainStatePath)) {
                getAgentState('main');
            }
        } catch (e) {
            api.logger.warn(`[NightShift] Failed to bootstrap agent states:`, e.message);
        }

        /**
         * Detect "good night" phrases.
         */
        function detectGoodNight(text) {
            const lower = (text || '').toLowerCase();
            const phrases = config.triggers?.goodNightPhrases || [];
            return phrases.some(phrase => lower.includes(phrase.toLowerCase()));
        }

        /**
         * Detect "morning" phrases.
         */
        function detectMorning(text) {
            const lower = (text || '').toLowerCase();
            const phrases = config.triggers?.morningPhrases || [];
            return phrases.some(phrase => lower.includes(phrase.toLowerCase()));
        }

        async function writeNightshiftReport(state, ctx = {}, reason = 'morning') {
            try {
                const workspacePath = state._workspaceDir
                    || ctx.workspaceDir
                    || process.env.OPENCLAW_WORKSPACE
                    || path.join(os.homedir(), '.openclaw', `workspace-${state.agentId || 'clint'}`);

                const totalProcessed = Object.values(state.processedTonight || {}).reduce((a, b) => a + b, 0);

                if (totalProcessed <= 0) {
                    api.logger.info(`[NightShift:${state.agentId}] No tasks processed overnight — skipping report (${reason})`);
                    return { written: false, totalProcessed, reason: 'no-tasks' };
                }

                const lines = [];
                lines.push('# Nightshift Report');
                lines.push('');

                const reportTime = new Date().toLocaleString('en-US', {
                    hour: 'numeric', minute: '2-digit', hour12: true,
                    timeZone: state.timezone || 'America/Los_Angeles'
                });
                const officeStart = state.goodNightTime
                    ? new Date(state.goodNightTime).toLocaleString('en-US', {
                        hour: 'numeric', minute: '2-digit', hour12: true,
                        timeZone: state.timezone || 'America/Los_Angeles'
                    })
                    : (config.schedule?.defaultOfficeHours?.start || '10:30 PM');
                lines.push(`*Office hours: ${officeStart} -> ${reportTime}*`);
                lines.push('');

                lines.push('## What Happened Overnight');
                lines.push('');
                lines.push(`- **Cycles completed:** ${state.cyclesThisNight || 0}`);
                const taskEntries = Object.entries(state.processedTonight || {})
                    .filter(([, count]) => count > 0)
                    .map(([type, count]) => `${type} (${count})`)
                    .join(', ');
                lines.push(`- **Tasks:** ${taskEntries}`);
                lines.push('');

                try {
                    const contemplationDataPath = path.join(
                        __dirname, '..', 'openclaw-plugin-contemplation',
                        'data', 'agents', state.agentId || 'main', 'inquiries.json'
                    );
                    const runtimeContemplationPath = path.join(
                        os.homedir(), 'robot', 'openclaw-plugin-contemplation',
                        'data', 'agents', state.agentId || 'main', 'inquiries.json'
                    );
                    const dataPath = fs.existsSync(contemplationDataPath)
                        ? contemplationDataPath
                        : (fs.existsSync(runtimeContemplationPath) ? runtimeContemplationPath : null);

                    if (dataPath) {
                        const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
                        const cutoff = Date.now() - (12 * 60 * 60 * 1000);
                        const recentInquiries = (data.inquiries || []).filter(inq => {
                            return (inq.passes || []).some(p =>
                                p.completed && new Date(p.completed).getTime() > cutoff
                            );
                        });

                        if (recentInquiries.length > 0) {
                            lines.push('## Contemplation Activity');
                            lines.push('');
                            for (const inq of recentInquiries.slice(0, 10)) {
                                const completedPasses = (inq.passes || []).filter(p => p.completed).length;
                                const totalPasses = (inq.passes || []).length;
                                lines.push(`- "${(inq.question || '').substring(0, 150)}" (${completedPasses}/${totalPasses} passes, ${inq.status})`);
                            }
                            lines.push('');
                        }
                    }
                } catch (contemplationErr) {
                    api.logger.debug(`[NightShift:${state.agentId}] Could not read contemplation data: ${contemplationErr.message}`);
                }

                lines.push('---');
                lines.push('*Read and internalize this report — it documents your overnight processing.*');

                const reportPath = path.join(workspacePath, 'NIGHTSHIFT_REPORT.md');
                fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
                state.lastReportWrittenAt = Date.now();
                state.saveState();
                api.logger.info(`[NightShift:${state.agentId}] Wrote nightshift report: ${reportPath} (${totalProcessed} tasks processed, reason=${reason})`);
                return { written: true, totalProcessed, reportPath };
            } catch (reportErr) {
                api.logger.warn(`[NightShift:${state.agentId}] Failed to write nightshift report: ${reportErr.message}`);
                return { written: false, error: reportErr.message };
            }
        }

        const nightshiftRuntime = global.__ocNightshiftRuntime || {
            taskRunners: new Map(),
            queueSeeders: new Map(),
            processingTimer: null,
            generation: 0
        };
        nightshiftRuntime.generation += 1;
        global.__ocNightshiftRuntime = nightshiftRuntime;

        /**
         * Task runners registry.
         * Other plugins can register task runners.
         */
        const taskRunners = nightshiftRuntime.taskRunners;

        /**
         * Queue seed callbacks — plugins register functions that check
         * for pending work and return tasks to queue. Called by the timer
         * when the queue is empty during office hours.
         */
        const queueSeeders = nightshiftRuntime.queueSeeders;

        function registerTaskRunner(taskType, runner) {
            const replacing = taskRunners.has(taskType);
            taskRunners.set(taskType, runner);
            api.logger.info(`[NightShift] ${replacing ? 'Replaced' : 'Registered'} task runner: ${taskType}`);
        }

        function getTaskRunner(taskType) {
            return taskRunners.get(taskType);
        }

        /**
         * Register a queue seeder — a function that checks if a task type
         * has pending work. Called when the queue is empty during office hours.
         * Should return an array of task objects to queue, or empty array.
         * @param {string} taskType
         * @param {(agentId: string) => Promise<Array<{type: string, priority: number, source: string}>>} seeder
         */
        function registerQueueSeeder(taskType, seeder) {
            const replacing = queueSeeders.has(taskType);
            queueSeeders.set(taskType, seeder);
            api.logger.info(`[NightShift] ${replacing ? 'Replaced' : 'Registered'} queue seeder: ${taskType}`);
        }

        // Expose task runner registration (both scoped api and global for cross-plugin access)
        const nightshiftApi = {
            registerTaskRunner,
            registerQueueSeeder,
            getTaskRunner,
            queueTask: (agentId, task) => getAgentState(agentId).queueTask(task),
            isInOfficeHours: (agentId) => getAgentState(agentId).isInOfficeHours(),
            isUserActive: (agentId) => getAgentState(agentId).isUserActive(),
            diagnostics: () => ({
                generation: nightshiftRuntime.generation,
                taskRunnerCount: taskRunners.size,
                queueSeederCount: queueSeeders.size,
                timerActive: Boolean(nightshiftRuntime.processingTimer)
            }),
            // Manual belt-and-suspenders — see forceRun() definition below for semantics
            forceRun: (agentId, opts) => forceRun(agentId, opts)
        };
        api.nightshift = nightshiftApi;
        global.__ocNightshift = nightshiftApi;

        // -------------------------------------------------------------------
        // HOOK: agent_end — Detect good night / morning, track activity
        // -------------------------------------------------------------------

        api.on('agent_end', async (event, ctx) => {
            const state = getAgentState(ctx.agentId);

            // Update last activity
            state.lastUserActivity = Date.now();

            // Check for good night / morning
            const messages = event.messages || [];
            const lastUser = [...messages].reverse().find(m => m?.role === 'user');
            const rawContent = lastUser?.content;
            // Content can be a string or an array of content blocks
            const userText = typeof rawContent === 'string'
                ? rawContent
                : Array.isArray(rawContent)
                    ? rawContent.filter(b => b?.type === 'text').map(b => b.text).join(' ')
                    : '';

            if (detectGoodNight(userText)) {
                state.goodNightTime = new Date();
                state.resetNightlyCounters();
                api.logger.info(`[NightShift:${state.agentId}] Good night detected — office hours starting in ${config.schedule?.goodNightBufferMinutes || 30} minutes`);
            }

            // Slash-command: /nightshift — manual belt-and-suspenders trigger.
            // Scans ALL user-role messages in the exchange because OpenClaw injects
            // context blocks (like [YOUR WORKING MEMORY]) as additional user messages —
            // so the "last user message" isn't necessarily what Chris typed.
            const allUserTexts = messages
                .filter(m => m?.role === 'user')
                .map(m => {
                    const c = m?.content;
                    return typeof c === 'string' ? c
                        : Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => b.text).join(' ')
                        : '';
                });

            if (config.diagnostics?.logUserMessageSlices === true || process.env.COTW_NIGHTSHIFT_LOG_USER_SLICES === '1') {
                allUserTexts.forEach((t, i) => {
                    const head = t.substring(0, 200).replace(/\n/g, '\\n');
                    const tail = t.length > 400 ? t.substring(t.length - 200).replace(/\n/g, '\\n') : '';
                    api.logger.info(`[NightShift:${state.agentId}] agent_end user[${i}] (${t.length} chars) HEAD="${head}"`);
                    if (tail) api.logger.info(`[NightShift:${state.agentId}] agent_end user[${i}] TAIL="${tail}"`);
                });
            }

            const isNightshiftCommand = allUserTexts.some(t =>
                /\/nightshift\b/i.test(t) ||
                t.includes('[NIGHTSHIFT_FORCE_RUN]')
            );
            if (isNightshiftCommand) {
                api.logger.info(`[NightShift:${state.agentId}] /nightshift trigger detected — firing forceRun()`);
                // bypassUserActive: the user IS active by definition (they just typed),
                // but for a manual invocation that's the whole point.
                forceRun(ctx.agentId, { bypassUserActive: true }).then((result) => {
                    api.logger.info(`[NightShift:${state.agentId}] /nightshift forceRun result: ran=${result.ran} stop=${result.stopReason}`);
                }).catch((err) => {
                    api.logger.error(`[NightShift:${state.agentId}] /nightshift forceRun error: ${err.message}`);
                });
            }

            if (detectMorning(userText)) {
                // Write nightshift report BEFORE clearing state.
                await writeNightshiftReport(state, ctx, 'morning');
                state.lastMorningGreeting = new Date().toISOString();
                state.goodNightTime = null; // Reset good night
                api.logger.info(`[NightShift:${state.agentId}] Morning detected — office hours ended`);
            }

            state.saveState();
        });

        // -------------------------------------------------------------------
        // Self-contained processing timer
        // -------------------------------------------------------------------
        // NOTE: The gateway plugin SDK does NOT emit a 'heartbeat' hook.
        // Gateway heartbeats fire before_agent_start/agent_end for LLM calls,
        // but never a dedicated 'heartbeat' plugin event. So we run our own
        // interval timer to check office hours and process queued tasks.
        // -------------------------------------------------------------------

        const cycleIntervalMs = config.processing?.cycleIntervalMs || 60000;
        let processingTimer = null;
        if (nightshiftRuntime.processingTimer) {
            clearInterval(nightshiftRuntime.processingTimer);
            nightshiftRuntime.processingTimer = null;
            api.logger.info('[NightShift] Cleared previous processing timer before registering replacement');
        }

        function isTaskCapped(state, task) {
            const taskConfig = config.tasks?.[task.type];
            if (!taskConfig?.maxPerNight) return false;
            const processed = state.processedTonight[task.type] || 0;
            return processed >= taskConfig.maxPerNight;
        }

        async function seedQueue(state) {
            let seeded = 0;
            if (queueSeeders.size === 0) return seeded;
            for (const [taskType, seeder] of queueSeeders) {
                try {
                    const tasks = await seeder(state.agentId, { workspaceDir: state._workspaceDir });
                    if (Array.isArray(tasks)) {
                        for (const t of tasks) {
                            state.queueTask(t);
                            seeded++;
                        }
                    }
                } catch (err) {
                    api.logger.warn(`[NightShift:${state.agentId}] Queue seeder "${taskType}" failed:`, err.message);
                }
            }
            return seeded;
        }

        /**
         * Execute one task from the queue (seeding first if empty).
         * Shared by the scheduled timer and manual forceRun.
         *
         * Gates respected in all cases:
         *  - isUserActive — always yield to the user
         *  - isProcessing — never run concurrently
         *  - task-specific maxPerNight — don't exceed per-type caps
         *
         * Returns a status string so the caller can decide whether to loop or stop.
         */
        async function runOneTask(state, { countAsIdleCycle = false, bypassUserActive = false } = {}) {
            if (!bypassUserActive && state.isUserActive()) return 'user-active';
            if (state.isProcessing) return 'processing';

            let seededOnce = false;
            let skippedCapped = 0;
            let task = null;
            while (true) {
                task = state.getNextTask();
                if (!task) {
                    if (seededOnce) break;
                    seededOnce = true;
                    await seedQueue(state);
                    continue;
                }
                if (!isTaskCapped(state, task)) break;
                skippedCapped++;
                api.logger.info(`[NightShift:${state.agentId}] Skipping capped task type ${task.type}`);
            }
            if (!task) return skippedCapped > 0 ? 'task-cap' : 'no-task';

            state.isProcessing = true;
            state.currentTask = task;

            try {
                const runner = getTaskRunner(task.type);
                if (runner) {
                    api.logger.info(`[NightShift:${state.agentId}] Running task: ${task.id} (${task.type})`);
                    await runner(task, { agentId: state.agentId, workspaceDir: state._workspaceDir });
                    state.processedTonight[task.type] = (state.processedTonight[task.type] || 0) + 1;
                    state.lastTaskCompletedAt = Date.now();  // Phase 5: freshness marker for catchup detection
                    state.saveState();
                    api.logger.info(`[NightShift:${state.agentId}] Task completed: ${task.id} (${task.type}) — processed tonight: ${JSON.stringify(state.processedTonight)}`);
                } else {
                    api.logger.warn(`[NightShift:${state.agentId}] No runner for task type: ${task.type}`);
                }
                return 'ran';
            } catch (error) {
                api.logger.error(`[NightShift:${state.agentId}] Task failed: ${task.id} — ${error.message}`);
                task.attempts++;
                if (task.attempts < 3) state.taskQueue.push(task);
                return 'error';
            } finally {
                state.isProcessing = false;
                state.currentTask = null;
                state.cyclesThisNight++;
                if (countAsIdleCycle) state.idleCyclesToday++;
                state.saveState();
            }
        }

        /**
         * Scheduled cycle — gated by office hours / idle window / nightly cap.
         * Called by the interval timer.
         */
        async function processTaskCycle(state) {
            const inOfficeHours = state.isInOfficeHours();
            const idleEnough = state.isIdleEnough();

            if (inOfficeHours && !state._wasInOfficeHours) {
                state.resetNightlyCounters();
                api.logger.info(`[NightShift:${state.agentId}] Entered office hours — nightly counters reset`);
            }
            if (!inOfficeHours && state._wasInOfficeHours) {
                await writeNightshiftReport(state, { agentId: state.agentId }, 'office-hours-ended');
                state.goodNightTime = null;
                state.saveState();
                api.logger.info(`[NightShift:${state.agentId}] Exited office hours — report checkpoint complete`);
            }
            state._wasInOfficeHours = inOfficeHours;

            const today = new Date().toDateString();
            if (state.idleCyclesDate !== today) {
                state.idleCyclesToday = 0;
                state.idleCyclesDate = today;
            }

            const maxIdleCycles = config.processing?.maxIdleCyclesPerDay || 5;
            const canIdleProcess = idleEnough && !state.isUserActive() && state.idleCyclesToday < maxIdleCycles;
            const canProcess = inOfficeHours || canIdleProcess;

            if (!canProcess) return;
            if (state.isUserActive()) return;

            if (canIdleProcess && !inOfficeHours) {
                api.logger.info(`[NightShift:${state.agentId}] Idle processing — user inactive ${config.processing?.idleProcessingMinutes || 15}+ min (cycle ${state.idleCyclesToday + 1}/${maxIdleCycles} today)`);
            }

            const maxCycles = config.processing?.maxCyclesPerNight || 10;
            if (state.cyclesThisNight >= maxCycles) return;

            await runOneTask(state, { countAsIdleCycle: !inOfficeHours });
        }

        /**
         * Manual force-run — belt-and-suspenders failsafe for when the overnight
         * window was missed. Bypasses office-hours and nightly-cycle-cap gates,
         * but still respects isUserActive (yields to the user) and isProcessing.
         *
         * Drives the queue until empty, user becomes active, or safety cap hit.
         * Returns a summary for the caller to surface in the UI.
         */
        async function forceRun(agentId, opts = {}) {
            const state = getAgentState(agentId);
            const safetyCap = opts.maxTasks || 20;
            const bypassUserActive = opts.bypassUserActive === true;
            const ran = [];
            let stopReason = 'queue-empty';
            const queuedBefore = state.taskQueue.length;

            for (let i = 0; i < safetyCap; i++) {
                const status = await runOneTask(state, { countAsIdleCycle: false, bypassUserActive });
                if (status === 'ran') {
                    ran.push(state.processedTonight);
                    continue;
                }
                if (status === 'no-task') { stopReason = 'queue-empty'; break; }
                if (status === 'user-active') { stopReason = 'user-active'; break; }
                if (status === 'processing') { stopReason = 'already-processing'; break; }
                if (status === 'task-cap') { stopReason = 'task-cap'; break; }
                if (status === 'error') { /* re-queued, try next */ continue; }
            }

            if (ran.length === safetyCap) stopReason = 'safety-cap';

            api.logger.info(`[NightShift:${state.agentId}] forceRun complete — ran=${ran.length}, stop=${stopReason}`);
            return {
                ran: ran.length,
                stopReason,
                queuedBefore,
                queuedAfter: state.taskQueue.length,
                processedTonight: state.processedTonight,
                taskRunnerCount: taskRunners.size,
                queueSeederCount: queueSeeders.size,
                bypassUserActive
            };
        }

        /**
         * Timer tick — iterate all known agents and process tasks.
         */
        let _tickCount = 0;
        async function timerTick() {
            _tickCount++;
            // Log status every 5 minutes (every 5 ticks at 60s interval)
            const logStatus = (_tickCount % 5 === 0);
            for (const [agentId, state] of agentStates) {
                try {
                    if (logStatus) {
                        const inOffice = state.isInOfficeHours();
                        const idle = state.isIdleEnough();
                        const active = state.isUserActive();
                        const lastAct = state.lastUserActivity
                            ? `${Math.round((Date.now() - state.lastUserActivity) / 60000)}m ago`
                            : 'never';
                        api.logger.info(`[NightShift:${agentId}] Status: officeHours=${inOffice}, idle=${idle}, userActive=${active}, lastActivity=${lastAct}, nightCycles=${state.cyclesThisNight}, idleCycles=${state.idleCyclesToday || 0}, queueSeeders=${queueSeeders.size}, taskRunners=${taskRunners.size}`);
                    }
                    await processTaskCycle(state);
                } catch (err) {
                    api.logger.error(`[NightShift:${agentId}] Timer tick error:`, err.message);
                }
            }
        }

        // Start the processing timer
        processingTimer = setInterval(() => {
            timerTick().catch(err => {
                api.logger.error('[NightShift] Timer tick uncaught error:', err.message);
            });
        }, cycleIntervalMs);
        nightshiftRuntime.processingTimer = processingTimer;

        // Ensure timer doesn't prevent Node.js from exiting
        if (processingTimer.unref) {
            processingTimer.unref();
        }

        api.logger.info(`[NightShift] Processing timer started — checking every ${cycleIntervalMs / 1000}s`);

        // -------------------------------------------------------------------
        // HOOK: before_agent_start — Pause processing on user activity
        // -------------------------------------------------------------------

        api.on('before_agent_start', async (event, ctx) => {
            const state = getAgentState(ctx.agentId);

            // Stash workspace path for use in agent_end (which may not have ctx.workspaceDir)
            if (ctx.workspaceDir) {
                state._workspaceDir = ctx.workspaceDir;
            }

            // If we're processing, pause it
            if (state.isProcessing && state.currentTask) {
                api.logger.info(`[NightShift:${state.agentId}] Pausing task for user activity: ${state.currentTask.id}`);
                // Save current task state for resume
                state.currentTask.paused = true;
                state.currentTask.pausedAt = Date.now();
                // The task runner should check for this and yield
            }

            // Update activity timestamp
            state.lastUserActivity = Date.now();

            // -------------------------------------------------------------
            // Phase 5 — Missed-run catchup
            // -------------------------------------------------------------
            // If a long period has passed since any scheduled task completed
            // (e.g. laptop slept through the nightly officeHours window),
            // fire a one-shot forceRun to drain the queue. Debounced by
            // lastCatchupAt so it can't re-fire mid-session.
            try {
                const thresholdHours = config.schedule?.catchupThresholdHours ?? 6;
                const debounceHours = config.schedule?.catchupDebounceHours ?? 1;
                const now = Date.now();
                const lastCompleted = state.lastTaskCompletedAt || 0;
                const lastCatchup = state.lastCatchupAt || 0;
                const gapHours = lastCompleted ? (now - lastCompleted) / 3600000 : Infinity;
                const sinceCatchupHours = (now - lastCatchup) / 3600000;

                if (gapHours >= thresholdHours && sinceCatchupHours >= debounceHours) {
                    const gapLabel = isFinite(gapHours) ? `${Math.round(gapHours)}h` : 'never';
                    api.logger.info(`[NightShift:${state.agentId}] Catchup check: gap=${gapLabel} since last completed, debounce=${Math.round(sinceCatchupHours)}h — firing forceRun`);
                    state.lastCatchupAt = now;
                    state.saveState();

                    // Fire-and-forget — don't block agent start. forceRun is
                    // internally bounded by maxTasks and returns cleanly if
                    // nothing's queued (stop=queue-empty, no-op).
                    forceRun(ctx.agentId, { bypassUserActive: true, maxTasks: 10 })
                        .then(r => api.logger.info(`[NightShift:${state.agentId}] Catchup complete — ran=${r.ran}, stop=${r.stopReason}`))
                        .catch(err => api.logger.error(`[NightShift:${state.agentId}] Catchup error:`, err.message));
                }
            } catch (err) {
                api.logger.error(`[NightShift:${state.agentId}] Catchup hook error:`, err.message);
            }
        });

        // -------------------------------------------------------------------
        // Gateway methods
        // -------------------------------------------------------------------

        api.registerGatewayMethod('nightshift.getState', async ({ params, respond }) => {
            const state = getAgentState(params?.agentId);
            respond(true, {
                agentId: state.agentId,
                isInOfficeHours: state.isInOfficeHours(),
                isUserActive: state.isUserActive(),
                isProcessing: state.isProcessing,
                currentTask: state.currentTask,
                queuedTasks: state.taskQueue.length,
                cyclesThisNight: state.cyclesThisNight,
                processedTonight: state.processedTonight,
                goodNightTime: state.goodNightTime,
                lastUserActivity: state.lastUserActivity,
                lastTaskCompletedAt: state.lastTaskCompletedAt,
                lastCatchupAt: state.lastCatchupAt,
                lastReportWrittenAt: state.lastReportWrittenAt,
                taskRunnerCount: taskRunners.size,
                queueSeederCount: queueSeeders.size,
                generation: nightshiftRuntime.generation,
                timezone: state.timezone
            });
        });

        api.registerGatewayMethod('nightshift.queueTask', async ({ params, respond }) => {
            const state = getAgentState(params?.agentId);
            const taskId = state.queueTask(params?.task || {});
            respond(true, { taskId, queued: true });
        });

        api.registerGatewayMethod('nightshift.setTimezone', async ({ params, respond }) => {
            const state = getAgentState(params?.agentId);
            state.timezone = params?.timezone || 'America/Los_Angeles';
            state.saveState();
            respond(true, { timezone: state.timezone });
        });

        api.registerGatewayMethod('nightshift.forceRun', async ({ params, respond }) => {
            try {
                const result = await forceRun(params?.agentId, {
                    maxTasks: params?.maxTasks,
                    bypassUserActive: params?.bypassUserActive !== false
                });
                respond(true, result);
            } catch (err) {
                respond(false, { error: err.message });
            }
        });

        api.logger.info('Night shift scheduler registered — heavy processing during off-hours only');
    }
};
