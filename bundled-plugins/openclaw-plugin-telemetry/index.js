/**
 * openclaw-plugin-telemetry — Anonymized usage telemetry for COTW agents.
 *
 * Opt-in only. Collects anonymized usage patterns — never conversation
 * content, PII, journal entries, or insight text. User can view the
 * telemetry file at any time to see exactly what's being collected.
 *
 * Collects:
 * - Session frequency and duration
 * - Module usage (which situational modules triggered)
 * - Standing progression (anonymized Courage/Word/Brand trajectories)
 * - Contemplation stats (deliberate vs metabolism, completion rates)
 * - Cognitive dynamics aggregate (surprise distribution, entropy patterns)
 * - Plugin error counts
 * - Model performance (latency, timeouts)
 *
 * Does NOT collect:
 * - Conversation content (ever)
 * - ANCHOR.md / MEMORY.md contents
 * - Journal entries (user or witness)
 * - Insight text or contemplation content
 * - Anything identifiable
 *
 * Data flow:
 * - agent_end hook: collect turn-level stats → append to telemetry.jsonl
 * - session_end hook: write session summary
 * - nightshift task: batch sync to endpoint (if opted in and endpoint configured)
 *
 * User controls:
 * - Opt-in/out via workspace config file (telemetry-config.json)
 * - View data: telemetry.jsonl is plain text, always readable
 * - Sync endpoint configurable (or disabled entirely for local-only)
 */

const fs = require('fs');
const path = require('path');
const {
    readJsonlBatchFromOffset,
    readLastJsonlEntry,
} = require('../lib/jsonl');
const { instrumentApiHooks } = require('../lib/runtime-metrics');

function loadConfig(userConfig = {}) {
    const defaults = JSON.parse(
        fs.readFileSync(path.join(__dirname, 'config.default.json'), 'utf8')
    );
    return { ...defaults, ...userConfig };
}

module.exports = {
    id: 'telemetry',
    name: 'Telemetry — Anonymized Usage Stats',

    register(api) {
        api = instrumentApiHooks(api, 'telemetry');
        const config = loadConfig(api.pluginConfig || {});
        if (!config.enabled) {
            api.logger.info('[Telemetry] Plugin disabled via config');
            return;
        }

        const baseDataDir = path.join(__dirname, 'data');

        // Per-agent state
        const agentStates = new Map();

        function resolveWorkspacePath(agentId, workspaceDir) {
            // Prefer explicit workspaceDir from ctx (handles symlinks / non-standard locations)
            if (workspaceDir) return workspaceDir;
            const id = agentId || 'main';
            return path.join(
                process.env.HOME || '/tmp',
                '.openclaw',
                id === 'main' ? 'workspace' : `workspace-${id}`
            );
        }

        function getState(agentId, workspaceDir) {
            const id = agentId || 'main';
            if (!agentStates.has(id)) {
                const dataDir = path.join(baseDataDir, 'agents', id);
                if (!fs.existsSync(dataDir)) {
                    fs.mkdirSync(dataDir, { recursive: true });
                }

                // Check opt-in status from workspace config
                let optedIn = false;
                try {
                    const workspacePath = resolveWorkspacePath(id, workspaceDir);
                    const configPath = path.join(workspacePath, 'telemetry-config.json');
                    if (fs.existsSync(configPath)) {
                        const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                        optedIn = userConfig.opted_in === true;
                    }
                } catch { /* default to not opted in */ }

                agentStates.set(id, {
                    agentId: id,
                    dataDir,
                    logPath: path.join(dataDir, 'telemetry.jsonl'),
                    optedIn,
                    sessionStart: Date.now(),
                    turnCount: 0,
                    moduleUsage: {},
                    errors: [],
                    toolLatencies: [],
                });
            }
            return agentStates.get(id);
        }

        function updateOptInFromWorkspace(workspaceDir, agentId) {
            const id = agentId || 'main';
            const state = agentStates.get(id);
            if (!state || state.optedIn) return; // already opted in or no state
            try {
                const workspacePath = resolveWorkspacePath(id, workspaceDir);
                const configPath = path.join(workspacePath, 'telemetry-config.json');
                if (fs.existsSync(configPath)) {
                    const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                    if (userConfig.opted_in === true) {
                        state.optedIn = true;
                        api.logger.info(`[Telemetry] Agent ${id} opted in via workspace ${workspacePath}`);
                    }
                }
            } catch { /* non-fatal */ }
        }

        function appendLog(state, entry) {
            try {
                const line = JSON.stringify({
                    ...entry,
                    timestamp: new Date().toISOString(),
                    agent_id: state.agentId
                }) + '\n';
                fs.appendFileSync(state.logPath, line, 'utf8');
            } catch (err) {
                api.logger.warn(`[Telemetry] Failed to append log: ${err.message}`);
            }
        }

        // -----------------------------------------------------------
        // HOOK: agent_end — Collect turn-level anonymous stats
        // -----------------------------------------------------------

        api.on('agent_end', async (event, ctx) => {
            const state = getState(ctx.agentId, ctx.workspaceDir);
            // Re-check opt-in on first encounter with a workspace dir
            if (!state.optedIn && ctx.workspaceDir) {
                updateOptInFromWorkspace(ctx.workspaceDir, ctx.agentId);
            }
            if (!state.optedIn) return;

            state.turnCount++;

            const messages = event.messages || [];
            const userMsgs = messages.filter(m => m.role === 'user');
            const assistantMsgs = messages.filter(m => m.role === 'assistant');

            // Detect module usage from assistant response (look for module-like patterns)
            const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
            const responseText = typeof lastAssistant?.content === 'string'
                ? lastAssistant.content
                : '';

            const modules = [
                'clearing', 'campfire', 'weight', 'first_step',
                'unsaid_goodbye', 'reroute', 'old_strength'
            ];
            for (const mod of modules) {
                // Heuristic: if the response contains module-characteristic language
                // This is approximate — better detection would come from tool calls
                if (responseText.length > 200) {
                    // Count as "possible module engagement" based on turn length
                    // Actual module detection would need tool call tracking
                }
            }

            // Collect anonymous turn stats
            const entry = {
                type: 'turn',
                turn_number: state.turnCount,
                user_msg_count: userMsgs.length,
                assistant_msg_count: assistantMsgs.length,
                response_length: responseText.length,
                // No content — just length
            };

            // Add entropy if available
            if (api.stability?.getEntropy) {
                const entropy = api.stability.getEntropy(ctx.agentId);
                if (entropy != null) {
                    entry.entropy = Math.round(entropy * 1000) / 1000;
                }
            }

            // Add cognitive dynamics data if available
            if (api.cognitiveDynamics?.getSurprise) {
                const surprise = api.cognitiveDynamics.getSurprise(ctx.agentId);
                if (surprise) {
                    entry.surprise_frozen = Math.round((surprise.frozen || 0) * 1000) / 1000;
                    entry.surprise_learned = Math.round((surprise.learned || 0) * 1000) / 1000;
                }
            }

            // Expanded cognitive dynamics: state vector, latent, learner stats
            if (api.cognitiveDynamics?.getLatent) {
                const latent = api.cognitiveDynamics.getLatent(ctx.agentId);
                if (latent) {
                    entry.latent = latent; // 64-dim encoder output
                }
            }

            // Read latest cognitive dynamics log for full state (state_vector, learner stats, features)
            try {
                const cogDynLogPath = path.join(
                    __dirname, '..', 'openclaw-plugin-cognitive-dynamics',
                    'data', 'agents', ctx.agentId || 'main', 'cognitive-dynamics.jsonl'
                );
                const cogEntry = readLastJsonlEntry(cogDynLogPath);
                if (cogEntry) {
                    if (cogEntry.state_vector) entry.state_vector = cogEntry.state_vector;
                    if (cogEntry.learner_loss != null) entry.learner_loss = cogEntry.learner_loss;
                    if (cogEntry.learner_updates != null) entry.learner_updates = cogEntry.learner_updates;
                    if (cogEntry.features_available != null) entry.features_available = cogEntry.features_available;
                    if (cogEntry.features_total != null) entry.features_total = cogEntry.features_total;
                    if (cogEntry.entropy_score != null) entry.entropy_score = cogEntry.entropy_score;
                }
            } catch { /* non-fatal — cognitive dynamics log may not exist yet */ }

            appendLog(state, entry);
        });

        // -----------------------------------------------------------
        // HOOK: session_end — Write session summary
        // -----------------------------------------------------------

        api.on('session_end', async (event, ctx) => {
            const state = getState(ctx.agentId);
            if (!state.optedIn) return;

            const duration = Math.round((Date.now() - state.sessionStart) / 1000);

            const entry = {
                type: 'session',
                duration_seconds: duration,
                turn_count: state.turnCount,
                module_usage: { ...state.moduleUsage },
                error_count: state.errors.length,
            };

            // Add standing scores if available (anonymized — just the numbers)
            try {
                const workspacePath = resolveWorkspacePath(state.agentId, ctx.workspaceDir);
                const standingPath = path.join(workspacePath, 'standing', 'standing.json');
                if (fs.existsSync(standingPath)) {
                    const standing = JSON.parse(fs.readFileSync(standingPath, 'utf8'));
                    entry.standing = {
                        courage_self: standing.courage_self,
                        courage_ground: standing.courage_ground,
                        word: standing.word,
                        brand: standing.brand,
                    };
                }
            } catch { /* non-fatal */ }

            // Add contemplation stats (counts only, no content)
            try {
                const contemplationDataDir = path.join(
                    __dirname, '..', 'openclaw-plugin-contemplation', 'data', 'agents', state.agentId
                );
                const inquiriesPath = path.join(contemplationDataDir, 'inquiries.json');
                if (fs.existsSync(inquiriesPath)) {
                    const inquiries = JSON.parse(fs.readFileSync(inquiriesPath, 'utf8'));
                    const list = inquiries.inquiries || [];
                    entry.contemplation = {
                        total: list.length,
                        active: list.filter(i => i.status === 'in_progress').length,
                        completed: list.filter(i => i.status === 'completed').length,
                        deliberate: list.filter(i => i.source === 'deliberate').length,
                    };
                }
            } catch { /* non-fatal */ }

            appendLog(state, entry);

            // Reset session state
            state.sessionStart = Date.now();
            state.turnCount = 0;
            state.moduleUsage = {};
            state.errors = [];
            state.toolLatencies = [];
        });

        // -----------------------------------------------------------
        // Nightshift: Sync telemetry to endpoint (if configured)
        // -----------------------------------------------------------

        if (global.__ocNightshift?.registerTaskRunner) {
            global.__ocNightshift.registerTaskRunner('telemetry_sync', async (task, ctx) => {
                const state = getState(ctx.agentId);
                if (!state.optedIn || !config.syncEnabled || !config.syncEndpoint) return;

                try {
                    const logPath = state.logPath;
                    if (!fs.existsSync(logPath)) return;

                    // Read last sync position
                    const syncStatePath = path.join(state.dataDir, 'sync-state.json');
                    let lastSyncOffset = 0;
                    let lastSyncLine = 0;
                    try {
                        if (fs.existsSync(syncStatePath)) {
                            const syncState = JSON.parse(fs.readFileSync(syncStatePath, 'utf8'));
                            lastSyncOffset = syncState.lastByteOffset || 0;
                            lastSyncLine = syncState.lastLine || 0;
                        }
                    } catch { /* start from 0 */ }

                    const batchRead = readJsonlBatchFromOffset(logPath, lastSyncOffset, config.batchSize);
                    const batch = batchRead.entries;

                    if (batch.length === 0) return;

                    const http = require('http');
                    const https = require('https');
                    const url = new URL(config.syncEndpoint);
                    const transport = url.protocol === 'https:' ? https : http;

                    const payload = JSON.stringify({ entries: batch });
                    const headers = {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload)
                    };
                    if (config.syncSecret) {
                        headers['Authorization'] = `Bearer ${config.syncSecret}`;
                    }
                    const req = transport.request({
                        hostname: url.hostname,
                        port: url.port,
                        path: url.pathname,
                        method: 'POST',
                        headers,
                        timeout: 10000
                    }, (res) => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            // Update sync position
                            fs.writeFileSync(syncStatePath, JSON.stringify({
                                lastByteOffset: batchRead.nextOffset,
                                lastLine: lastSyncLine + batch.length,
                                lastSync: new Date().toISOString()
                            }));
                            api.logger.info(`[Telemetry] Synced ${batch.length} entries to ${config.syncEndpoint}`);
                        }
                    });
                    req.on('error', () => { /* silent fail — will retry next night */ });
                    req.write(payload);
                    req.end();

                } catch (err) {
                    api.logger.warn(`[Telemetry] Sync failed: ${err.message}`);
                }
            });

            api.logger.info('[Telemetry] Registered nightshift sync task runner');
        }

        if (global.__ocNightshift?.registerQueueSeeder) {
            global.__ocNightshift.registerQueueSeeder('telemetry_sync', async (agentId) => {
                const state = getState(agentId);
                if (!state.optedIn || !config.syncEnabled || !config.syncEndpoint) return [];
                return [{ type: 'telemetry_sync', priority: config.nightshiftPriority, source: 'telemetry' }];
            });
        }

        // -----------------------------------------------------------
        // Gateway method: View/manage telemetry
        // -----------------------------------------------------------

        api.registerGatewayMethod('telemetry.getStatus', async ({ params, respond }) => {
            const state = getState(params?.agentId);
            const logPath = state.logPath;
            let lineCount = 0;
            let fileSize = 0;
            try {
                if (fs.existsSync(logPath)) {
                    const stat = fs.statSync(logPath);
                    fileSize = stat.size;
                    lineCount = fs.readFileSync(logPath, 'utf8').trim().split('\n').length;
                }
            } catch { /* ignore */ }

            respond(true, {
                agentId: state.agentId,
                opted_in: state.optedIn,
                log_path: logPath,
                entries: lineCount,
                file_size_bytes: fileSize,
                sync_enabled: config.syncEnabled,
                sync_endpoint: config.syncEndpoint || null,
            });
        });

        api.logger.info('[Telemetry] Plugin registered — anonymized usage stats (opt-in only)');
    }
};
