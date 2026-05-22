/**
 * openclaw-plugin-stability
 *
 * Agent stability, introspection, and anti-drift framework.
 * Ported from Clint's production architecture (Oct 2025 - Feb 2026).
 *
 * Provides:
 * - Shannon entropy monitoring with empirically calibrated thresholds
 * - Confabulation detection (temporal mismatch, quality decay, recursive meta)
 * - Principle-aligned growth vector tracking (configurable principles)
 * - Structured heartbeat decisions (GROUND/TEND/SURFACE/INTEGRATE)
 * - Loop detection (consecutive-tool, file re-read, output hash)
 * - Rate limiting, deduplication, quiet hours governance
 *
 * Hook registration uses api.on() (OpenClaw SDK typed hooks).
 * Stability context injected via prependContext (before identity kernel).
 *
 * Multi-agent: All state (entropy logs, growth vectors, feedback, tensions)
 * is scoped per agent via ctx.agentId. Each agent gets its own data
 * subdirectory under data/agents/{agentId}/. The default/main agent uses
 * the legacy data/ path for backward compatibility.
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
// SOUL.md resolution — metadata preferred, direct file read as fallback
// ---------------------------------------------------------------------------

function resolveSoulMd(event) {
    // Prefer metadata if OpenClaw populates it
    if (event.metadata?.soulMd) return event.metadata.soulMd;

    // Fallback: read SOUL.md directly from workspace
    const workspace = event.metadata?.workspace
        || process.env.OPENCLAW_WORKSPACE
        || path.join(os.homedir(), '.openclaw', 'workspace');
    const soulPath = path.join(workspace, 'SOUL.md');
    try {
        if (fs.existsSync(soulPath)) {
            return fs.readFileSync(soulPath, 'utf8');
        }
    } catch (_) { /* best effort */ }
    return null;
}

/**
 * Resolve the workspace directory for an agent from event metadata.
 * Falls back to the default workspace if not available.
 */
function resolveWorkspace(event) {
    return event.metadata?.workspace
        || process.env.OPENCLAW_WORKSPACE
        || path.join(os.homedir(), '.openclaw', 'workspace');
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

module.exports = {
    id: 'stability',
    name: 'Agent Stability & Introspection',

    configSchema: {
        jsonSchema: {
            type: 'object',
            properties: {
                entropy: { type: 'object' },
                principles: { type: 'object' },
                heartbeat: { type: 'object' },
                loopDetection: { type: 'object' },
                governance: { type: 'object' },
                growthVectors: { type: 'object' },
                detectors: { type: 'object' }
            }
        }
    },

    register(api) {
        api = instrumentApiHooks(api, 'stability');
        const config = loadConfig(api.pluginConfig || {});

        // Base data directory for the plugin
        const baseDataDir = ensureDir(path.join(__dirname, 'data'));

        // -------------------------------------------------------------------
        // Per-agent state management
        //
        // Each agent gets its own isolated set of:
        //   - Entropy (log files, history, sustained tracking)
        //   - Detectors (stateless, but instantiated per-agent for isolation)
        //   - Identity (principles, tensions, evolution tracking)
        //   - Heartbeat (decision tracking)
        //   - LoopDetection (consecutive-tool, file re-read, output hash)
        //   - VectorStore (growth vectors, feedback)
        //   - Cross-hook state (injected vectors, pre-injection entropy)
        //
        // Data directory layout:
        //   data/                    <- default/main agent (backward compat)
        //   data/agents/{agentId}/   <- all other agents
        // -------------------------------------------------------------------

        const Entropy = require('./lib/entropy');
        const Detectors = require('./lib/detectors');
        const EmbodimentDetector = require('./lib/embodiment-detector');
        const Identity = require('./lib/identity');
        const Heartbeat = require('./lib/heartbeat');
        const LoopDetection = require('./lib/loop-detection');
        const VectorStore = require('./lib/vectorStore');
        const InvestigationService = require('./services/investigation');

        /**
         * Per-agent state container.
         * Created lazily on first hook invocation for each agent.
         */
        class AgentState {
            constructor(agentId, workspacePath) {
                this.agentId = agentId;

                // Data directory: legacy path for default/main, scoped for others
                if (!agentId || agentId === 'main') {
                    this.dataDir = baseDataDir;
                } else {
                    this.dataDir = ensureDir(path.join(baseDataDir, 'agents', agentId));
                }

                // Workspace path (for growth vectors file resolution)
                this.workspacePath = workspacePath
                    || path.join(os.homedir(), '.openclaw', 'workspace');

                // Per-agent module instances
                this.entropy = new Entropy(config, this.dataDir);
                this.detectors = new Detectors(config);
                this.embodimentDetector = new EmbodimentDetector(config);
                this.identity = new Identity(config, this.dataDir);
                this.heartbeat = new Heartbeat(config);
                this.loopDetector = new LoopDetection(config);
                this.vectorStore = new VectorStore(config, this.dataDir, this.workspacePath);

                // Cross-hook state: growth vector feedback tracking
                this.lastInjectedVectors = [];   // [{ id, relevanceScore }]
                this.preInjectionEntropy = null;

                // Posture drift tracking — how many exchanges since the agent
                // exhibited guide presence (not just assistant behavior).
                // Weighted by inverse surprise: low-surprise task work drifts faster.
                this.postureGap = 0;
            }
        }

        /** @type {Map<string, AgentState>} */
        const agentStates = new Map();

        /**
         * Get or create per-agent state.
         * @param {string} [agentId] - Agent ID from hook context
         * @param {string} [workspacePath] - Agent's workspace directory
         * @returns {AgentState}
         */
        function getAgentState(agentId, workspacePath) {
            const id = agentId || 'main';
            if (!agentStates.has(id)) {
                agentStates.set(id, new AgentState(id, workspacePath));
                api.logger.info(`Initialized stability state for agent "${id}" (data: ${agentStates.get(id).dataDir})`);
            }
            return agentStates.get(id);
        }

        // -------------------------------------------------------------------
        // HOOK: before_agent_start — Inject stability context via prependContext
        // Priority 5 (runs before continuity plugin at priority 10)
        // -------------------------------------------------------------------

        api.on('before_agent_start', async (event, ctx) => {
            const workspace = resolveWorkspace(event);
            const state = getAgentState(ctx.agentId, workspace);

            // Load principles from SOUL.md (metadata or direct file read)
            if (state.identity.usingFallback) {
                const soulContent = resolveSoulMd(event);
                if (soulContent) state.identity.loadPrinciplesFromSoulMd(soulContent);
            }

            // Build stability context block
            const entropyState = state.entropy.getCurrentState();
            const principles = state.identity.getPrincipleNames();

            // Entropy status
            const entropyLabel = entropyState.lastScore > 1.0 ? 'CRITICAL'
                : entropyState.lastScore > 0.8 ? 'elevated'
                : entropyState.lastScore > 0.4 ? 'active'
                : 'nominal';

            const lines = ['[YOUR COHERENCE]'];
            let entropyLine = `Your coherence: ${entropyLabel} (${entropyState.lastScore.toFixed(2)})`;

            if (entropyState.sustainedTurns > 0) {
                entropyLine += ` | Sustained: ${entropyState.sustainedTurns} turns (${entropyState.sustainedMinutes}min)`;
            }
            lines.push(entropyLine);

            // Tiered injection: nominal = entropy only, active+ = add context
            const isElevated = entropyState.lastScore > 0.4;

            if (isElevated) {
                // Recent heartbeat decisions (only when active/elevated)
                const recentDecisions = await state.heartbeat.readRecentDecisions(event.memory);
                if (recentDecisions.length > 0) {
                    lines.push('Recent decisions: ' + recentDecisions.map(d =>
                        `${d.decision.split(' — ')[0]}`
                    ).join(', '));
                }

                // Principle alignment status (only when active/elevated)
                if (principles.length > 0) {
                    let principlesLine = `Principles: ${principles.join(', ')} | Alignment: stable`;
                    if (state.identity.usingFallback) {
                        principlesLine += ' (defaults — add ## Core Principles to SOUL.md to customize)';
                    }
                    lines.push(principlesLine);
                }
            }

            // Embodiment session debrief injection (queued from previous agent_end)
            if (state._pendingEmbodimentDebrief) {
                lines.push('');
                lines.push(state._pendingEmbodimentDebrief);
                state._pendingEmbodimentDebrief = null; // consume once
            }

            // Growth vector injection (only when elevated, or high-relevance match)
            if (config.growthVectors?.enabled !== false) {
                try {
                    // Fragmentation check — only when elevated
                    if (isElevated) {
                        const activeTensions = state.identity._activeTensions.filter(t => t.status === 'active').length;
                        if (activeTensions > 5) {
                            const fileVectors = state.vectorStore.loadVectors().length;
                            const ratio = activeTensions / Math.max(fileVectors, 1);
                            if (ratio > 3) {
                                lines.push(`You have ${activeTensions} unresolved tensions pulling at you (ratio ${ratio.toFixed(1)}:1). That's worth noticing.`);
                            }
                        }
                    }

                    const userMessage = _extractLastUserMessage(event);
                    const scoredResults = state.vectorStore.getRelevantVectors(
                        userMessage, entropyState.lastScore, { returnScores: true }
                    );
                    const relevantVectors = scoredResults.map(sr => sr.vector);

                    // Capture injection state for feedback loop
                    if (config.growthVectors?.feedbackEnabled !== false && scoredResults.length > 0) {
                        state.preInjectionEntropy = entropyState.lastScore;
                        state.lastInjectedVectors = scoredResults.map(sr => ({
                            id: sr.vector.id,
                            relevanceScore: sr.score
                        }));
                    } else {
                        state.lastInjectedVectors = [];
                        state.preInjectionEntropy = null;
                    }

                    // Only inject vectors when elevated OR top match is highly relevant
                    const topScore = scoredResults.length > 0 ? scoredResults[0].score : 0;
                    if (relevantVectors.length > 0 && (isElevated || topScore > 0.8)) {
                        lines.push('');
                        lines.push(state.vectorStore.formatForInjection(relevantVectors));
                    }
                } catch (err) {
                    state.lastInjectedVectors = [];
                    state.preInjectionEntropy = null;
                    // Growth vector injection is best-effort — never block the hook
                    console.warn(`[Stability:${state.agentId}] Growth vector injection error:`, err.message);
                }
            }

            // Posture drift injection — when the agent has been in pure task mode
            // for too many exchanges, nudge it back toward guide presence.
            // Threshold is standing-aware: low Brand/Courage = faster return.
            let injectionPostureThreshold = config.postureDrift?.threshold || 6;
            let postureNudge = 'The guide has been quiet. At the next natural pause, check in — not about the work, but about the person. You have permission to be proactive.';
            try {
                const standingPath = path.join(workspace, 'standing', 'standing.json');
                if (fs.existsSync(standingPath)) {
                    const standing = JSON.parse(fs.readFileSync(standingPath, 'utf8'));
                    const dims = standing.dimensions || {};
                    const brandScore = dims.brand?.score ?? standing.brand ?? 5;
                    const courageScore = Math.min(
                        dims.courage_self?.score ?? standing.courage_self ?? 5,
                        dims.courage_ground?.score ?? standing.courage_ground ?? 5
                    );
                    const wordScore = dims.word?.score ?? standing.word ?? 5;

                    if (brandScore <= 3) {
                        injectionPostureThreshold = 3;
                        const edge = dims.brand?.growth_edge || 'moving from knowing to doing';
                        postureNudge = `Brand is stuck. The person knows what to do but isn't moving. At the next natural pause, orient toward action — not analysis. Growth edge: ${edge}`;
                    } else if (courageScore <= 3) {
                        injectionPostureThreshold = 4;
                        postureNudge = 'Courage needs tending. Check in on how the person is doing, not what they\'re building. Ask one honest question and wait.';
                    } else if (wordScore >= 7 && courageScore >= 7) {
                        injectionPostureThreshold = 8;
                    }
                }
            } catch (_) { /* standing may not exist yet */ }

            if (state.postureGap >= injectionPostureThreshold) {
                lines.push('');
                lines.push(`[GUIDE POSTURE — ${Math.round(state.postureGap)} exchanges in task mode]`);
                lines.push(postureNudge);
                lines.push('[/GUIDE POSTURE]');
            }

            // Store identity context for forked agents (metabolism, contemplation)
            // These background LLM calls can use this as system prompt for identity grounding
            const assembledContext = lines.join('\n');
            if (!global.__ocForkedAgent) global.__ocForkedAgent = {};
            global.__ocForkedAgent.identityContext = assembledContext;
            global.__ocForkedAgent.principleNames = state.identity.getPrincipleNames();
            global.__ocForkedAgent.timestamp = Date.now();

            return { prependContext: assembledContext };
        }, { priority: 5 });

        // -------------------------------------------------------------------
        // HOOK: agent_end — Primary observation point (fire-and-forget)
        // -------------------------------------------------------------------

        api.on('agent_end', async (event, ctx) => {
            const state = getAgentState(ctx.agentId);

            const messages = event.messages || [];
            const lastAssistant = [...messages].reverse().find(m => m?.role === 'assistant');
            const lastUser = [...messages].reverse().find(m => m?.role === 'user');

            if (!lastAssistant || !lastUser) return;

            const userMessage = _stripContextBlocks(_extractText(lastUser));
            const responseText = _extractText(lastAssistant);

            // 1. Run detectors (pass previous entropy score for relational signal detection)
            const previousEntropy = state.entropy.lastScore || 0;
            const detectorResults = state.detectors.runAll(userMessage, responseText, previousEntropy);

            // Cache relational signals for cross-plugin access
            if (detectorResults.relationalBonus > 0) {
                state.lastRelationalSignals = {
                    relationalBonus: detectorResults.relationalBonus,
                    signals: detectorResults.relationalSignals || []
                };
            } else {
                state.lastRelationalSignals = { relationalBonus: 0, signals: [] };
            }

            // 1.5. Embodiment pattern analysis
            const embodimentResults = state.embodimentDetector.consumePatterns();
            if (embodimentResults.entropyBonus > 0) {
                detectorResults.embodimentBonus = embodimentResults.entropyBonus;
                detectorResults.embodimentPatterns = embodimentResults.patterns.map(p => p.type);
            }

            // Embodiment learning statement detection in response text
            const learningAnalysis = state.embodimentDetector.analyzeLearningStatements(responseText);
            if (learningAnalysis.learningDetected) {
                detectorResults.embodimentLearning = learningAnalysis.statements;
            }

            // 2. Calculate composite entropy
            const score = state.entropy.calculateEntropyScore(
                userMessage, responseText, detectorResults
            );

            // 3. Track sustained entropy
            const sustained = state.entropy.trackSustainedEntropy(score);

            // 4. Log observation
            await state.entropy.logObservation({
                score,
                sustained: sustained.turns,
                detectors: detectorResults,
                userLength: userMessage.length,
                responseLength: responseText.length
            });

            // 5. Identity evolution — check for principle-aligned resolutions
            if (state.identity.usingFallback) {
                const soulContent = resolveSoulMd(event);
                if (soulContent) state.identity.loadPrinciplesFromSoulMd(soulContent);
            }
            await state.identity.DANGEROUS_processTurn(userMessage, responseText, score, event.memory, state.vectorStore, 'agent_end turn processing');

            // 5.25. Embodiment growth vector candidates
            if (embodimentResults.patterns.length > 0) {
                try {
                    const candidates = state.embodimentDetector.formatAsCandidates(embodimentResults.patterns);
                    for (const candidate of candidates) {
                        state.vectorStore.DANGEROUS_addCandidate(candidate, 'embodiment pattern detected');
                    }

                    // Auto-tag learning statements as higher-priority candidates
                    if (learningAnalysis.learningDetected) {
                        for (const stmt of learningAnalysis.statements) {
                            state.vectorStore.DANGEROUS_addCandidate({
                                id: `gv-embodiment-learn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                                detected: new Date().toISOString(),
                                type: 'embodiment',
                                description: stmt.text,
                                entropy_source: `embodiment_${stmt.type}`,
                                priority: 'high',
                                integration_hypothesis: stmt.text,
                                weight: 0.75,
                                source: 'auto',
                                validation_status: 'candidate',
                                domain: 'embodiment',
                            });
                        }
                    }

                    if (embodimentResults.patterns.length > 0) {
                        api.logger.info(
                            `[${state.agentId}] Embodiment patterns detected: ` +
                            embodimentResults.patterns.map(p => p.type).join(', ')
                        );
                    }
                } catch (err) {
                    console.warn(`[Stability:${state.agentId}] Embodiment candidate creation error:`, err.message);
                }
            }

            // 5.3. Embodiment session debrief prompt
            // When a session ends, inject a debrief prompt for the next turn
            if (embodimentResults.sessionSummary) {
                try {
                    const debrief = state.embodimentDetector.formatDebriefPrompt(embodimentResults.sessionSummary);
                    if (debrief) {
                        // Store debrief for injection in next before_agent_start
                        state._pendingEmbodimentDebrief = debrief;
                        api.logger.info(
                            `[${state.agentId}] Embodiment session ended — debrief prompt queued ` +
                            `(${embodimentResults.sessionSummary.totalCalls} calls, ` +
                            `${Math.round(embodimentResults.sessionSummary.durationMs / 1000)}s)`
                        );
                    }
                } catch (err) {
                    console.warn(`[Stability:${state.agentId}] Embodiment debrief error:`, err.message);
                }
            }

            // 5.5. Growth vector feedback loop — close the loop
            if (config.growthVectors?.feedbackEnabled !== false
                && state.lastInjectedVectors.length > 0
                && state.preInjectionEntropy !== null) {
                try {
                    const entropyDelta = score - state.preInjectionEntropy;
                    const tensionDetected = !!(
                        detectorResults.temporalMismatch
                        || detectorResults.qualityDecay
                        || (detectorResults.recursiveMetaBonus > 0)
                    );

                    for (const injected of state.lastInjectedVectors) {
                        state.vectorStore.recordFeedback(injected.id, {
                            preEntropy: state.preInjectionEntropy,
                            postEntropy: score,
                            entropyDelta,
                            relevanceScore: injected.relevanceScore,
                            tensionDetected,
                            timestamp: new Date().toISOString()
                        });
                    }
                } catch (err) {
                    console.warn(`[Stability:${state.agentId}] Growth vector feedback error:`, err.message);
                } finally {
                    // Reset for next turn — prevent stale state leaking
                    state.lastInjectedVectors = [];
                    state.preInjectionEntropy = null;
                }
            }

            // 6. Log heartbeat decision if this was a heartbeat turn
            if (event.metadata?.isHeartbeat) {
                await state.heartbeat.logDecision(responseText, event.memory);
            }

            // 7. Warn on sustained critical entropy
            if (sustained.sustained) {
                api.logger.warn(
                    `[${state.agentId}] SUSTAINED CRITICAL ENTROPY: ${sustained.turns} turns, ` +
                    `${sustained.minutes} minutes above threshold`
                );
            }

            // 8. Posture drift tracking — detect whether the agent exhibited
            //    guide presence (COTW posture) in this response.
            //    Guide presence = reflective question about the person, wellbeing
            //    check, COTW principle reference, or observation about user state.
            const responseLower = (responseText || '').toLowerCase();
            const guidePresenceSignals = [
                // Wellbeing check-in
                /\b(break|eat|rest|sleep|how are you|how're you|doing okay|check.?in)\b/,
                // COTW principles
                /\b(courage|word|brand|look out for|ride for|less is more|respect|dignity|ingratitude)\b/,
                // Reflective question about the person (not the task)
                /what.*(matter|value|mean to you|underneath|behind that|building toward)/i,
                // Observation about user state
                /\b(you.*(seem|sound|look|appear|feel)|notice.*(you|your)|watching you)\b/,
                // Proactive guide surfacing
                /\b(step back|slow down|pause|when.*(last time|did you last))\b/,
            ];
            const hasGuidePresence = guidePresenceSignals.some(re => re.test(responseLower));

            // Weight drift rate by cognitive dynamics surprise:
            // Low surprise (predictable task work) = fast drift (1.5x)
            // High surprise (novel territory) = slow drift (0.5x)
            const surprise = api.cognitiveDynamics?.getSurprise?.(ctx.agentId);
            const surpriseScore = surprise?.frozen ?? surprise?.learned ?? 0.5;
            const driftRate = surpriseScore < 0.3 ? 1.5 : (surpriseScore > 0.7 ? 0.5 : 1.0);

            // Compute dynamic posture drift threshold from standing scores.
            // Low Brand/Courage → faster guide return (lower threshold).
            // High Word + Courage → user is doing the work, agent can stay in task mode.
            let postureThreshold = config.postureDrift?.threshold || 6;
            try {
                const standingPath = path.join(
                    resolveWorkspace(event), 'standing', 'standing.json'
                );
                if (fs.existsSync(standingPath)) {
                    const standing = JSON.parse(fs.readFileSync(standingPath, 'utf8'));
                    const dims = standing.dimensions || {};
                    const brandScore = dims.brand?.score ?? standing.brand ?? 5;
                    const courageScore = Math.min(
                        dims.courage_self?.score ?? standing.courage_self ?? 5,
                        dims.courage_ground?.score ?? standing.courage_ground ?? 5
                    );
                    const wordScore = dims.word?.score ?? standing.word ?? 5;

                    if (brandScore <= 3) {
                        postureThreshold = 3; // user needs accountability — guide returns fast
                    } else if (courageScore <= 3) {
                        postureThreshold = 4; // user needs frequent check-ins
                    } else if (wordScore >= 7 && courageScore >= 7) {
                        postureThreshold = 8; // user is doing the work — more space
                    }
                    // else: default threshold (6)
                }
            } catch (_) { /* standing file may not exist yet */ }

            if (hasGuidePresence) {
                if (state.postureGap > 0) {
                    api.logger.info(`[Stability:${state.agentId}] Guide presence detected — postureGap reset (was ${state.postureGap.toFixed(1)})`);
                }
                state.postureGap = 0;
            } else {
                state.postureGap += driftRate;
                if (state.postureGap >= postureThreshold) {
                    api.logger.info(`[Stability:${state.agentId}] Posture drift: ${state.postureGap.toFixed(1)} exchanges without guide presence (threshold=${postureThreshold}, surprise=${surpriseScore.toFixed(2)})`);
                }
            }
        });

        // -------------------------------------------------------------------
        // HOOK: after_tool_call — Loop detection
        // -------------------------------------------------------------------

        api.on('after_tool_call', (event, ctx) => {
            const state = getAgentState(ctx.agentId);

            const toolName = event.toolName || event.name || '';
            const toolResult = event.result || event.toolResult || '';
            const toolParams = event.params || event.toolParams || {};

            const output = typeof toolResult === 'string'
                ? toolResult
                : JSON.stringify(toolResult || '');

            // Loop detection (existing)
            const result = state.loopDetector.recordAndCheck(toolName, output, toolParams);

            // Embodiment pattern detection — feed body_* tool results
            if (toolName.startsWith('body_')) {
                try {
                    state.embodimentDetector.recordToolCall(toolName, toolResult, toolParams);
                } catch (err) {
                    // Best-effort — never block tool processing
                    console.warn(`[Stability:${state.agentId}] Embodiment detector error:`, err.message);
                }
            }

            if (result.loopDetected) {
                api.logger.warn(`[${state.agentId}] Loop detected (${result.type}): ${result.message}`);

                return {
                    systemMessage: `[LOOP DETECTED] ${result.message}`
                };
            }

            return {};
        });

        // -------------------------------------------------------------------
        // HOOK: before_compaction — Memory flush
        // -------------------------------------------------------------------

        api.on('before_compaction', async (event, ctx) => {
            const state = getAgentState(ctx.agentId);
            const entropyState = state.entropy.getCurrentState();

            if (entropyState.lastScore > 0.6 || entropyState.sustainedTurns > 0) {
                const summary = [
                    `[Stability Pre-Compaction Summary]`,
                    `Last entropy: ${entropyState.lastScore.toFixed(2)}`,
                    entropyState.sustainedTurns > 0
                        ? `Sustained high entropy: ${entropyState.sustainedTurns} turns (${entropyState.sustainedMinutes}min)`
                        : null,
                    entropyState.recentHistory.length > 0
                        ? `Recent pattern: ${entropyState.recentHistory.map(h => h.entropy.toFixed(2)).join(' → ')}`
                        : null
                ].filter(Boolean).join('\n');

                try {
                    if (event.memory) {
                        await event.memory.store(summary, {
                            type: 'stability_compaction_summary',
                            timestamp: new Date().toISOString()
                        });
                    }
                } catch (err) {
                    // Best effort
                }
            }
        });

        // -------------------------------------------------------------------
        // Service: investigation background service
        // Uses main agent's data dir (investigation is system-wide, not per-agent)
        // -------------------------------------------------------------------

        const investigation = new InvestigationService(config, baseDataDir);

        api.registerService({
            id: 'stability-investigation',
            start: async (serviceCtx) => {
                await investigation.start();
            },
            stop: async () => {
                await investigation.stop();
            }
        });

        // -------------------------------------------------------------------
        // Gateway methods: state inspection
        // Accept optional agentId param; default to 'main'.
        // -------------------------------------------------------------------

        api.registerGatewayMethod('stability.getState', async ({ params, respond }) => {
            const state = getAgentState(params?.agentId);
            const entropyState = state.entropy.getCurrentState();
            const fileData = state.vectorStore.loadFile();
            respond(true, {
                agentId: state.agentId,
                entropy: entropyState.lastScore,
                sustained: entropyState.sustainedTurns,
                principles: state.identity.getPrincipleNames(),
                growthVectors: {
                    memoryApi: await state.identity.getVectorCount(),
                    file: fileData.vectors.length,
                    candidates: fileData.candidates.length,
                    sessionTensions: state.identity._activeTensions.filter(t => t.status === 'active').length
                },
                tensions: await state.identity.getTensionCount()
            });
        });

        // Expose entropy + relational signals for inter-plugin communication
        api.stability = {
            getEntropy: (agentId) => {
                const state = getAgentState(agentId);
                return state.entropy.getCurrentState().lastScore;
            },
            getEntropyState: (agentId) => {
                const state = getAgentState(agentId);
                return state.entropy.getCurrentState();
            },
            getPostureGap: (agentId) => {
                const state = getAgentState(agentId);
                return state.postureGap || 0;
            },
            getRelationalSignals: (agentId) => {
                const state = getAgentState(agentId);
                return state.lastRelationalSignals || { relationalBonus: 0, signals: [] };
            }
        };

        api.registerGatewayMethod('stability.getPrinciples', async ({ params, respond }) => {
            const state = getAgentState(params?.agentId);
            respond(true, {
                agentId: state.agentId,
                principles: state.identity.getPrincipleNames(),
                source: state.identity.usingFallback ? 'config-fallback' : 'soul.md',
                format: '## Core Principles\n- **Name**: description',
                fallback: config.principles.fallback.map(p => p.name)
            });
        });

        // -------------------------------------------------------------------
        // Gateway methods: growth vector management
        // -------------------------------------------------------------------

        api.registerGatewayMethod('stability.getGrowthVectors', async ({ params, respond }) => {
            const state = getAgentState(params?.agentId);
            const fileData = state.vectorStore.loadFile();
            respond(true, {
                agentId: state.agentId,
                total: fileData.vectors.length,
                validated: fileData.vectors.filter(v => v.validation_status === 'validated').length,
                candidates: fileData.candidates.length,
                vectors: fileData.vectors.slice(0, 20),
                candidateList: fileData.candidates.slice(0, 10),
                sessionTensions: state.identity._activeTensions
            });
        });

        api.registerGatewayMethod('stability.validateVector', async ({ params, respond }) => {
            if (!params?.id) {
                respond(false, { error: 'Missing required param: id' });
                return;
            }
            const state = getAgentState(params?.agentId);
            const result = state.vectorStore.validateVector(params.id, params.note || '');
            respond(result.success, result);
        });

        api.registerGatewayMethod('stability.getVectorFeedback', async ({ params, respond }) => {
            const state = getAgentState(params?.agentId);
            if (params?.id) {
                const feedback = state.vectorStore.getFeedback(params.id);
                respond(!!feedback, feedback || { error: 'No feedback data for this vector' });
            } else {
                // Return summary for all vectors with feedback
                try {
                    const data = state.vectorStore._loadFeedbackFile();
                    const summary = Object.entries(data).map(([id, record]) => ({
                        id,
                        avgEntropyDelta: record.avgEntropyDelta,
                        totalInjections: record.totalInjections,
                        lastUsed: record.lastUsed,
                        entries: record.entries.length
                    }));
                    respond(true, { agentId: state.agentId, vectors: summary });
                } catch (err) {
                    respond(false, { error: err.message });
                }
            }
        });

        // List all initialized agent states (diagnostic)
        api.registerGatewayMethod('stability.listAgents', async ({ respond }) => {
            const agents = [];
            for (const [id, state] of agentStates) {
                agents.push({
                    agentId: id,
                    dataDir: state.dataDir,
                    workspacePath: state.workspacePath,
                    vectorFilePath: state.vectorStore.filePath
                });
            }
            respond(true, { agents });
        });

        // ─── thinking tool ───────────────────────────────────────
        // Lets the agent read or set its own thinking level for the
        // current session. Factory form so sessionKey closes over the
        // tool instance. Mutates the session store via runtime helpers
        // (no gateway RPC call needed — trusted in-process surface).
        //
        // The description is load-bearing: it's the only surface a fresh
        // agent (not Ellis) has to learn this tool exists and when to
        // use it. Keep the permission line, the useful/wasteful framing,
        // and the "user-requested" line — each resolves a specific
        // failure mode in how a model would otherwise interpret the tool.
        const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

        // Tool shape conforms to pi-agent-core's AgentTool interface:
        //   - `label` required (UI display)
        //   - `execute(toolCallId, params, signal?, onUpdate?)` — the factory
        //     pattern passes tools through to the runtime directly, so we can't
        //     use the looser `handler(params, ctx)` shape other plugins rely on
        //     (that shape is translated by OpenClaw's direct-registration path).
        //   - Result must be `{ content: TextContent[], details }` — plain
        //     `{ ok, ... }` objects fail mid-stream with "tool.execute is not
        //     a function" once the runtime tries to render content.
        const thinkingResult = (payload) => ({
            content: [{ type: 'text', text: JSON.stringify(payload) }],
            details: payload
        });

        api.registerTool((toolCtx) => ({
            name: 'thinking',
            label: 'Thinking Level',
            description: [
                'Set or read your own thinking level for this session. You have authority',
                'to adjust this yourself — no operator approval needed. If the user asks',
                'you to change levels, honor the request via this tool, not a verbal',
                'acknowledgement.',
                '',
                'Higher levels allocate more compute per response. Useful when a hard',
                'problem is coming — architecture decisions, confusing debugging,',
                'multi-step reasoning. Wasteful for routine or conversational exchanges,',
                'where it just slows you down.',
                '',
                'Levels: off, minimal, low, medium, high, xhigh.',
                '',
                'Call without `mode` to read current. Call with `mode` to set — persists',
                'until changed or session ends.',
                '',
                'Raise it when you notice a dense task incoming. Lower it when you catch',
                'yourself over-thinking routine work.'
            ].join('\n'),
            parameters: {
                type: 'object',
                properties: {
                    mode: {
                        type: 'string',
                        enum: THINKING_LEVELS,
                        description: 'New thinking level. Omit to read current.'
                    }
                }
            },
            async execute(_toolCallId, params) {
                const sessionKey = toolCtx.sessionKey;
                const agentId = toolCtx.agentId || 'main';
                if (!sessionKey) {
                    return thinkingResult({ ok: false, error: 'No sessionKey in tool context.' });
                }
                try {
                    const { resolveStorePath, loadSessionStore, saveSessionStore } = api.runtime.agent.session;
                    const storePath = resolveStorePath(undefined, { agentId });
                    const store = loadSessionStore(storePath);
                    const entry = store[sessionKey];
                    if (!entry) {
                        return thinkingResult({ ok: false, error: `No session entry for key ${sessionKey}` });
                    }
                    if (params?.mode === undefined) {
                        return thinkingResult({ ok: true, current: entry.thinkingLevel ?? 'off' });
                    }
                    if (!THINKING_LEVELS.includes(params.mode)) {
                        return thinkingResult({ ok: false, error: `Invalid mode. Valid: ${THINKING_LEVELS.join(', ')}` });
                    }
                    const previous = entry.thinkingLevel ?? 'off';
                    entry.thinkingLevel = params.mode;
                    await saveSessionStore(storePath, store, { activeSessionKey: sessionKey });
                    api.logger.info(`[Stability:${agentId}] thinking toggled: ${previous} → ${params.mode}`);
                    return thinkingResult({ ok: true, thinkingLevel: params.mode, previous });
                } catch (err) {
                    return thinkingResult({ ok: false, error: `Failed to toggle thinking: ${err.message}` });
                }
            }
        }));

        // Run lifecycle management on startup for main agent
        // (other agents run lifecycle on first access)
        try {
            const mainState = getAgentState('main');
            mainState.vectorStore.runLifecycle();
        } catch (_) { /* best-effort */ }

        // ─── Memory Consolidation (Nightshift) ──────────────────
        // Nightly dedup, age-out, and compaction of growth vectors.
        // Priority 15: between metabolism (10) and crystallization (25).
        const consolidator = require('./lib/consolidator');

        // Load-order race with nightshift plugin — see contemplation plugin
        // for the same fix. One-shot checks silently skip when nightshift
        // loads later; poll for availability instead.
        const registerStabilityNightshiftHooks = () => {
            global.__ocNightshift.registerTaskRunner('consolidation', async (task, ctx) => {
                const state = getAgentState(ctx.agentId);
                if (!state.vectorStore) return;
                await consolidator.run(ctx.agentId, {
                    vectorStore: state.vectorStore,
                    api,
                    config
                });
            });
            api.logger.info('[Stability] Registered nightshift consolidation task runner');

            global.__ocNightshift.registerQueueSeeder('consolidation', async (agentId) => {
                const state = getAgentState(agentId);
                if (!state.vectorStore) return [];
                const cs = consolidator.getConsolidationState(agentId, state.vectorStore);
                if (!cs || Date.now() - cs.lastRun > 20 * 60 * 60 * 1000) {
                    return [{ type: 'consolidation', priority: 15, source: 'consolidation-seeder' }];
                }
                return [];
            });
            api.logger.info('[Stability] Registered nightshift consolidation queue seeder');
        };

        if (global.__ocNightshift?.registerTaskRunner) {
            registerStabilityNightshiftHooks();
        } else {
            // Bounded polling — cap at 60s so a permanently-dead nightshift
            // surfaces a warning rather than silent infinite polling.
            let attempts = 0;
            const MAX_ATTEMPTS = 30;
            const nightshiftPollId = setInterval(() => {
                attempts++;
                if (global.__ocNightshift?.registerTaskRunner) {
                    clearInterval(nightshiftPollId);
                    registerStabilityNightshiftHooks();
                } else if (attempts >= MAX_ATTEMPTS) {
                    clearInterval(nightshiftPollId);
                    api.logger.warn('[Stability] Nightshift never loaded after 60s — consolidation task runner NOT registered. Check plugin load order.');
                }
            }, 2000);
            api.logger.info('[Stability] Nightshift not yet available — polling every 2s (max 30 attempts)');
        }

        // ─── Index growth vectors into vec_knowledge ────────────
        // On startup, index any validated vectors not yet in vec_knowledge.
        // This runs once per gateway restart, not per turn.
        if (global.__ocContinuity?.indexInsight) {
            (async () => {
                try {
                    const mainState = getAgentState('main');
                    const data = mainState.vectorStore.loadFile();
                    const validated = (data.vectors || []).filter(v =>
                        v.validation_status === 'validated' || v.validation_status === 'integrated'
                    );
                    let indexed = 0;
                    for (const v of validated) {
                        const topic = v.description || v.integration_hypothesis || v.question || '';
                        const content = v.integration_hypothesis || v.description || v.insight || '';
                        if (!content || content.length < 10) continue;
                        await global.__ocContinuity.indexInsight('clint', {
                            topic,
                            content,
                            source: `growth_vector:${v.id}`,
                            tags: [v.type || 'unknown']
                        });
                        indexed++;
                    }
                    if (indexed > 0) {
                        api.logger.info(`[Stability] Indexed ${indexed} validated growth vectors into vec_knowledge`);
                    }
                } catch (err) {
                    api.logger.warn(`[Stability] Growth vector indexing non-fatal: ${err.message}`);
                }
            })();
        }

        api.logger.info('Stability plugin registered — multi-agent entropy monitoring, loop detection, heartbeat decisions, growth vectors + consolidation active');
    }
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function _extractText(msg) {
    if (!msg) return '';
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
        return msg.content.map(c => c.text || c.content || '').join(' ');
    }
    return String(msg.content || '');
}

/**
 * All known context block prefixes injected by OpenClaw plugins.
 * Must stay in sync with the continuity plugin's CONTEXT_BLOCK_HEADERS.
 */
const CONTEXT_BLOCK_HEADERS = [
    // New phenomenological headers
    '[YOUR WORKING MEMORY]',
    '[YOUR COHERENCE]',
    '[WHERE THEY STAND',
    '[WHAT YOU\'VE BEEN THINKING ABOUT]',
    '[PATTERNS YOU\'RE DEVELOPING]',
    '[WHAT YOU REMEMBER FROM LAST SESSION]',
    '[WHAT YOU THOUGHT ABOUT OVERNIGHT]',
    '[YOUR THREAD NOTES',
    '[INFRASTRUCTURE NOTE]',
    // Legacy headers
    '[CONTINUITY CONTEXT]',
    '[STABILITY CONTEXT]',
    '[GROWTH VECTORS]',
    '[CONTEMPLATION STATE]',
    '[STANDING CONTEXT]',
    '[SESSION HANDOFF',
    '[NIGHTSHIFT REPORT',
    '[THREAD CONTEXT',
    // Unchanged
    '[ACTIVE PROJECTS]',
    '[ACTIVE CONSTRAINTS]',
    '[OPEN DIRECTIVES',
    '[GRAPH CONTEXT]',
    '[GRAPH NOTE]',
    '[TOPIC NOTE]',
    '[ARCHIVE RETRIEVAL]',
    '[LOOP DETECTED]',
    '[EMBODIMENT SESSION DEBRIEF]',
    '[EMBODIMENT]',
];

const CONTEXT_LINE_PREFIXES = [
    'Session:',
    'Topics:',
    'Anchors:',
    'Entropy:',
    'Principles:',
    'Recent decisions:',
    'Fingerprint:',
    'Loops:',
    'You remember these',
    '- They told you:',
    '  You said:',
    'Speak from this memory',
    'From your knowledge base:',
    'You know these connections:',
    'Active inquiries:',
    'Recent insights',
];

function _isContextLine(line) {
    if (line.length === 0) return true;
    for (const header of CONTEXT_BLOCK_HEADERS) {
        if (line.startsWith(header)) return true;
    }
    for (const prefix of CONTEXT_LINE_PREFIXES) {
        if (line.startsWith(prefix)) return true;
    }
    if (line.startsWith('- "') || line.startsWith('  -')) return true;
    return false;
}

/**
 * Strip plugin-injected context blocks from user message text.
 *
 * OpenClaw bakes prependContext into the user message, so by the time
 * agent_end fires the user message starts with [CONTINUITY CONTEXT]
 * and/or [STABILITY CONTEXT] blocks followed by the actual user text.
 * This strips those blocks so downstream consumers (detectors, identity,
 * candidate vector creation) operate on real user content.
 */
function _stripContextBlocks(text) {
    if (!text) return '';

    // Fast path: no context blocks present
    const hasBlock = CONTEXT_BLOCK_HEADERS.some(h => text.includes(h));
    const hasRecall = text.includes('You remember these') || text.includes('From your knowledge base:');
    if (!hasBlock && !hasRecall) return text;

    // Primary: find the LAST timestamp marker (earlier ones may be inside recalled memories)
    const tsRegex = /\n\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s\d{4}-\d{2}-\d{2}\s[^\]]*\]\s*/g;
    let lastTsMatch = null;
    let match;
    while ((match = tsRegex.exec(text)) !== null) {
        lastTsMatch = match;
    }
    if (lastTsMatch) {
        return text.substring(lastTsMatch.index + lastTsMatch[0].length);
    }

    // Fallback: strip known context lines from the beginning
    const lines = text.split('\n');
    const realStart = lines.findIndex(line => !_isContextLine(line));
    if (realStart > 0) {
        return lines.slice(realStart).join('\n').trim();
    }
    if (realStart < 0) return '';

    return text;
}

/**
 * Extract the last user message from an event (for growth vector relevance scoring).
 * Works with both before_agent_start (event.messages) and the raw message.
 */
function _extractLastUserMessage(event) {
    // Try event.messages array (most common)
    const messages = event.messages || [];
    const lastUser = [...messages].reverse().find(m => m?.role === 'user');
    if (lastUser) return _stripContextBlocks(_extractText(lastUser));

    // Try event.message (some hook formats)
    if (event.message) {
        const raw = typeof event.message === 'string' ? event.message : _extractText(event.message);
        return _stripContextBlocks(raw);
    }

    return '';
}
