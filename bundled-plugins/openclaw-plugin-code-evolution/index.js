/**
 * openclaw-plugin-code-evolution
 *
 * Self-evolving scaffolding for Code mode. Inspired by MiniMax M2.7's
 * self-evolution harness — the model weights never change, only the
 * system around them evolves.
 *
 * Phase 1 (this version):
 *   - Passive session recording (tool calls, satisfaction signals)
 *   - Day-one seed content injection (tool hints, baseline parameters)
 *   - Executable rule loading and firing
 *   - Code mode detection (metadata + content fallback)
 *
 * Future phases add:
 *   - Pattern analysis (heuristic + LLM)
 *   - Mutation generation (5 types)
 *   - Real replay evaluation
 *   - Nightshift integration for closed-loop evolution
 *
 * Hook registration uses api.on() (OpenClaw SDK typed hooks).
 * Evolved context injected via prependContext.
 */

const path = require('path');
const fs = require('fs');
const { instrumentApiHooks } = require('../lib/runtime-metrics');
const { analyzeSessionsForScaffoldProposals } = require('./lib/scaffoldProposalAnalyzer');

let evolutionLedger = null;
try {
    evolutionLedger = require('../../lib/evolution-ledger');
} catch {
    evolutionLedger = null;
}

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

function resolveBaseDataDir(config) {
    const configured = config.storage?.dataDir;
    if (configured && typeof configured === 'string') return ensureDir(path.resolve(configured));
    return ensureDir(path.join(__dirname, 'data'));
}

function resolveWorkspacePath(ctx) {
    return ctx?.workspaceDir || ctx?.workspacePath || process.env.OPENCLAW_WORKSPACE || null;
}

function resolveContinuityEvolutionDataDir() {
    return path.resolve(__dirname, '..', 'openclaw-plugin-continuity', 'data');
}

function normalizeGatewayParams(input) {
    return input?.params || input || {};
}

// ---------------------------------------------------------------------------
// Code mode detection — belt and suspenders
// ---------------------------------------------------------------------------

/**
 * Detect if the current session is Code mode.
 * Primary: metadata flag from companion app.
 * Fallback: scan messages for injection markers.
 */
function isCodeMode(event) {
    // Only check the explicit metadata flag set by callGatewayHTTP.
    // Do NOT scan conversation history — old Code mode messages persist
    // across restart and would falsely trigger code-evolution context
    // injection in normal chat mode.
    return event.metadata?.codeMode === true;
}

/**
 * Detect if a tool call result looks like an error.
 */
function isErrorResult(result) {
    if (!result) return true;
    const str = typeof result === 'string' ? result : JSON.stringify(result);
    if (!str || str.length === 0) return true;
    const lower = str.toLowerCase();
    return lower.startsWith('error:') ||
        lower.includes('enoent') ||
        lower.includes('syntaxerror') ||
        lower.includes('typeerror') ||
        lower.includes('referenceerror') ||
        lower.includes('permission denied') ||
        lower.includes('command failed') ||
        (lower.startsWith('{') && lower.includes('"error"'));
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

module.exports = {
    id: 'code-evolution',
    name: 'Code Mode Self-Evolution',

    configSchema: {
        jsonSchema: {
            type: 'object',
            properties: {
                enabled: { type: 'boolean' },
                recording: { type: 'object' },
                analysis: { type: 'object' },
                mutation: { type: 'object' },
                evaluation: { type: 'object' },
                nightshift: { type: 'object' },
                parameters: { type: 'object' }
            }
        }
    },

    register(api) {
        api = instrumentApiHooks(api, 'code-evolution');
        const config = loadConfig(api.pluginConfig || {});

        if (!config.enabled) {
            api.logger.info('[CodeEvolution] Plugin disabled via config');
            return;
        }

        const baseDataDir = resolveBaseDataDir(config);

        // Seed evolved scaffold files on first run
        const evolvedDir = ensureDir(path.join(baseDataDir, 'evolved'));
        ensureDir(path.join(evolvedDir, 'executables'));
        ensureDir(path.join(evolvedDir, 'history'));
        ensureDir(path.join(baseDataDir, 'sessions'));
        const seedFiles = {
            'tool-hints.json': JSON.stringify({
                plan_status: {
                    hint: 'Use this tool for any multi-step task. Create a plan before executing, update status as you progress. When a user asks you to build, fix, or change something that involves more than 2 steps, start with plan_status to outline the approach.',
                    source: 'seed',
                    confidence: 1.0
                }
            }, null, 2),
            'parameters.json': JSON.stringify({ 'glm-5:cloud': { temperature: 0.4, top_p: 0.9 } }, null, 2),
            'workflows.json': '[]',
            'thresholds.json': JSON.stringify({ scope: 'code-mode-only' }, null, 2),
            'code-mode-rules.md': ''
        };
        for (const [file, content] of Object.entries(seedFiles)) {
            const filePath = path.join(evolvedDir, file);
            if (!fs.existsSync(filePath)) {
                fs.writeFileSync(filePath, content);
                api.logger.info(`[CodeEvolution] Seeded ${file}`);
            }
        }

        // Initialize sub-modules
        const SessionRecorder = require('./lib/sessionRecorder');
        const ScaffoldManager = require('./lib/scaffoldManager');
        const ExecutableLoader = require('./lib/executableLoader');

        const sessionRecorder = new SessionRecorder(config, baseDataDir, api.logger);
        const scaffoldManager = new ScaffoldManager(config, baseDataDir, api.logger);
        const executableLoader = new ExecutableLoader(
            path.join(baseDataDir, 'evolved', 'executables'),
            api.logger
        );
        let lastProposalAnalysis = null;

        function runProposalAnalysis({ agentId = 'trail-guide', days = 7, ctx = null, now = new Date().toISOString() } = {}) {
            const sessions = sessionRecorder.getRecentSessions(agentId, days);
            const analysis = analyzeSessionsForScaffoldProposals({
                sessions,
                config,
                agentId,
                scaffoldVersion: scaffoldManager.getScaffoldVersion(),
                now
            });

            const result = {
                ...analysis,
                agentId,
                days,
                recorded: 0,
                ledger: analysis.skipped ? 'not-written' : 'unavailable'
            };

            if (!analysis.skipped && evolutionLedger) {
                const workspacePath = resolveWorkspacePath(ctx);
                const ledgerPath = workspacePath
                    ? evolutionLedger.resolveEvolutionLedgerPath({ workspacePath })
                    : evolutionLedger.resolveEvolutionLedgerPath({ pluginDataDir: resolveContinuityEvolutionDataDir(), agentId });
                for (const proposal of analysis.proposals) {
                    evolutionLedger.appendEvolutionEvent(ledgerPath, proposal, { now });
                    result.recorded += 1;
                }
                result.ledger = workspacePath ? 'workspace' : 'continuity-plugin-data';
            }

            if (!analysis.skipped) scaffoldManager.setLastAnalysisTime(Date.now());
            lastProposalAnalysis = {
                ...result,
                proposals: (analysis.proposals || []).map((proposal) => ({
                    id: proposal.id,
                    title: proposal.title,
                    risk: proposal.risk,
                    status: proposal.status,
                    confidence: proposal.metadata?.confidence || null
                }))
            };
            return result;
        }

        api.logger.info('[CodeEvolution] Plugin initialized');
        api.logger.info(`[CodeEvolution] Scaffold version: ${scaffoldManager.getScaffoldVersion()}`);

        // Expose for cross-plugin access
        const codeEvolutionApi = {
            isCodeMode,
            getScaffoldVersion: () => scaffoldManager.getScaffoldVersion(),
            getRecentSessions: (agentId, days) => sessionRecorder.getRecentSessions(agentId, days),
            getToolHints: () => scaffoldManager.loadToolHints(),
            getParameters: (modelId) => scaffoldManager.loadParameters(modelId),
            getThresholds: () => scaffoldManager.loadThresholds(),
            analyzeScaffoldProposals: runProposalAnalysis
        };
        api.codeEvolution = codeEvolutionApi;
        global.__ocCodeEvolution = codeEvolutionApi;

        // -------------------------------------------------------------------
        // HOOK: before_agent_start — Inject evolved scaffold context
        // Priority 15 (after stability at 5, before continuity at 10...
        //   actually let's go 20 to run after most other plugins)
        // -------------------------------------------------------------------

        api.on('before_agent_start', async (event, ctx) => {
            if (!isCodeMode(event)) return {};

            // Start recording session
            sessionRecorder.startCodeSession(ctx.agentId);
            sessionRecorder.setScaffoldVersion(ctx.agentId, scaffoldManager.getScaffoldVersion());

            // Build evolved context
            const execSummaries = executableLoader.getActiveRules();
            const context = scaffoldManager.formatEvolvedContext(execSummaries);

            if (!context) {
                api.logger.info(`[CodeEvolution:${ctx.agentId}] Code mode detected, no evolved context to inject yet`);
                return {};
            }

            api.logger.info(
                `[CodeEvolution:${ctx.agentId}] Injecting evolved context ` +
                `(${context.length} chars, scaffold v${scaffoldManager.getScaffoldVersion()})`
            );

            return { prependContext: context };
        });

        // -------------------------------------------------------------------
        // HOOK: after_tool_call — Record tool outcomes + fire executable rules
        // -------------------------------------------------------------------

        api.on('after_tool_call', (event, ctx) => {
            // Only record during code mode sessions
            if (!sessionRecorder.isCodeSession(ctx.agentId)) return {};

            const toolName = event.toolName || event.name || '';
            const toolParams = event.params || event.toolParams || {};
            const toolResult = event.result || event.toolResult || '';

            // Record the tool call
            sessionRecorder.recordToolCall(ctx.agentId, {
                toolName,
                params: toolParams,
                result: toolResult,
                success: !isErrorResult(toolResult),
                timestamp: Date.now()
            });

            // Fire any active executable rules
            return executableLoader.fireAfterTool(event, ctx);
        });

        // -------------------------------------------------------------------
        // HOOK: agent_end — Finalize session record
        // -------------------------------------------------------------------

        api.on('agent_end', async (event, ctx) => {
            if (!sessionRecorder.isCodeSession(ctx.agentId)) return;

            const messages = event.messages || [];

            // Detect satisfaction signals from the conversation
            const signals = sessionRecorder.detectSatisfactionSignals(messages);

            // Get entropy history if available from stability plugin
            const entropy = event.metadata?.entropyHistory || [];

            // Count messages
            const userMsgCount = messages.filter(m => m.role === 'user').length;
            for (let i = 0; i < userMsgCount; i++) {
                sessionRecorder.recordMessage(ctx.agentId);
            }

            // Finalize and write to disk
            const session = sessionRecorder.finalizeSession(ctx.agentId, { signals, entropy });

            if (session) {
                api.logger.info(
                    `[CodeEvolution:${ctx.agentId}] Session finalized: ` +
                    `${session.toolCalls.length} tool calls, ` +
                    `${session.satisfactionSignals.length} signals, ` +
                    `outcome=${session.outcome}`
                );
            }
        });

        // -------------------------------------------------------------------
        // Gateway methods — for monitoring and manual triggers
        // -------------------------------------------------------------------

        if (api.registerGatewayMethod) {
            api.registerGatewayMethod('code-evolution.getState', async () => {
                return {
                    scaffoldVersion: scaffoldManager.getScaffoldVersion(),
                    lastAnalysisTime: scaffoldManager.getLastAnalysisTime(),
                    toolHints: scaffoldManager.loadToolHints(),
                    parameters: scaffoldManager.loadParameters(),
                    thresholds: scaffoldManager.loadThresholds(),
                    activeRules: executableLoader.getActiveRules(),
                    rules: scaffoldManager.loadRules(),
                    workflows: scaffoldManager.loadWorkflows(),
                    proposalLoop: {
                        phase: 'proposal_only',
                        lastAnalysis: lastProposalAnalysis
                    }
                };
            });

            api.registerGatewayMethod('code-evolution.getSessions', async (input) => {
                const params = normalizeGatewayParams(input);
                const agentId = params?.agentId || '*';
                const days = params?.days || 7;
                return sessionRecorder.getRecentSessions(agentId, days);
            });

            api.registerGatewayMethod('code-evolution.trigger', async (input) => {
                const params = normalizeGatewayParams(input);
                const result = runProposalAnalysis({
                    agentId: params?.agentId || 'trail-guide',
                    days: params?.days || 7,
                    ctx: params?.ctx || null
                });
                return {
                    message: result.skipped
                        ? `Code Evolution proposal analysis skipped: ${result.reason}.`
                        : `Code Evolution proposal analysis recorded ${result.recorded} proposal receipt${result.recorded === 1 ? '' : 's'}.`,
                    scaffoldVersion: scaffoldManager.getScaffoldVersion(),
                    ...result
                };
            });
        }

        // -------------------------------------------------------------------
        // Nightshift integration — Phase 4, stub for now
        // -------------------------------------------------------------------

        if (global.__ocNightshift) {
            global.__ocNightshift.registerTaskRunner('code-evolution', async (task, ctx) => {
                const agentId = task.agentId || ctx?.agentId || 'main';
                const sessions = sessionRecorder.getRecentSessions(agentId, 30);

                if (sessions.length < config.analysis.minSessionsForPattern) {
                    api.logger.info(
                        `[CodeEvolution] Nightshift: insufficient data ` +
                        `(${sessions.length}/${config.analysis.minSessionsForPattern} sessions)`
                    );
                    return { skipped: true, reason: 'insufficient data', sessionCount: sessions.length };
                }

                const result = runProposalAnalysis({ agentId, days: 30, ctx });
                api.logger.info(
                    `[CodeEvolution] Nightshift: scanned ${result.sessionCount} session(s), ` +
                    `recorded ${result.recorded} proposal receipt(s)`
                );
                return result;
            });

            global.__ocNightshift.registerQueueSeeder('code-evolution', async (agentId) => {
                const sessions = sessionRecorder.getRecentSessions(agentId, 7);
                const lastAnalysis = scaffoldManager.getLastAnalysisTime();
                const hoursSince = (Date.now() - lastAnalysis) / 3600000;

                if (sessions.length >= config.analysis.minSessionsForPattern && hoursSince >= 24) {
                    return [{
                        type: config.nightshift.taskType,
                        priority: config.nightshift.priority,
                        source: 'code-evolution-seeder'
                    }];
                }
                return [];
            });

            api.logger.info('[CodeEvolution] Nightshift task runner and seeder registered');
        } else {
            api.logger.info('[CodeEvolution] Nightshift not available — evolution loop will not run automatically');
        }

        api.logger.info('[CodeEvolution] Phase 1 ready: session recording + seed scaffold injection');
    }
};
