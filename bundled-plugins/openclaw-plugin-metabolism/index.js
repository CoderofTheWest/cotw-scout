/**
 * openclaw-plugin-metabolism
 *
 * Autonomous learning through conversation metabolism.
 * Lightweight design: decouple observation (fast) from processing (slow).
 *
 * Provides:
 * - Entropy-triggered candidate queuing (agent_end hook, <5ms)
 * - Batch LLM processing during heartbeat (async)
 * - Growth vector integration with stability plugin
 * - Knowledge gap extraction for future contemplative inquiry
 *
 * Architecture:
 * - FAST PATH: Write candidate file on high-entropy exchanges (synchronous)
 * - SLOW PATH: Process candidates through LLM during heartbeat (asynchronous)
 * - INTEGRATION: Write growth vectors to stability plugin's growth-vectors.json
 *
 * Multi-agent: All state scoped per agent via ctx.agentId.
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
    id: 'metabolism',
    name: 'Metabolism — Autonomous Learning',

    configSchema: {
        jsonSchema: {
            type: 'object',
            properties: {
                enabled: { type: 'boolean' },
                thresholds: { type: 'object' },
                processing: { type: 'object' },
                llm: { type: 'object' },
                storage: { type: 'object' },
                implications: { type: 'object' },
                integration: { type: 'object' }
            }
        }
    },

    register(api) {
        api = instrumentApiHooks(api, 'metabolism');
        const config = loadConfig(api.pluginConfig || {});

        if (!config.enabled) {
            api.logger.info('Metabolism plugin disabled via config');
            return;
        }

        // Base data directory
        const baseDataDir = ensureDir(path.join(__dirname, 'data'));

        // -------------------------------------------------------------------
        // Inter-plugin API via global scope
        // -------------------------------------------------------------------
        // The OpenClaw gateway gives each plugin registration pass its own
        // scoped `api` object, so api.metabolism doesn't cross plugin boundaries.
        // Use global.__ocMetabolism for inter-plugin communication instead.

        if (!global.__ocMetabolism) {
            global.__ocMetabolism = {};
        }
        if (!(global.__ocMetabolism.gapListenerRegistry instanceof Map)) {
            const legacyListeners = Array.isArray(global.__ocMetabolism.gapListeners)
                ? global.__ocMetabolism.gapListeners
                : [];
            global.__ocMetabolism.gapListenerRegistry = new Map();
            legacyListeners.forEach((listener, index) => {
                if (typeof listener === 'function') {
                    global.__ocMetabolism.gapListenerRegistry.set(`legacy-${index}`, listener);
                }
            });
        }
        Object.assign(global.__ocMetabolism, {
            registerGapListener(pluginId, listener) {
                if (!pluginId || typeof listener !== 'function') return;
                this.gapListenerRegistry.set(pluginId, listener);
            },
            unregisterGapListener(pluginId) {
                this.gapListenerRegistry.delete(pluginId);
            },
            getGapListeners() {
                return Array.from(this.gapListenerRegistry.values());
            },
            listenerCount() {
                return this.gapListenerRegistry.size;
            },
            emitGaps(gaps, agentId) {
                for (const listener of this.getGapListeners()) {
                    listener(gaps, agentId);
                }
            },
        });
        const gapBus = global.__ocMetabolism;

        const CandidateStore = require('./lib/candidateStore');
        const MetabolismProcessor = require('./lib/processor');

        /**
         * Per-agent state container.
         */
        class AgentState {
            constructor(agentId, workspacePath) {
                this.agentId = agentId;
                this.workspacePath = workspacePath || path.join(os.homedir(), '.openclaw', 'workspace');

                // Data directory: legacy path for default/main, scoped for others
                if (!agentId || agentId === 'main') {
                    this.dataDir = baseDataDir;
                } else {
                    this.dataDir = ensureDir(path.join(baseDataDir, 'agents', agentId));
                }

                this.candidateStore = new CandidateStore(config, this.dataDir);
                this.processor = new MetabolismProcessor(config, this.dataDir, null, api);

                // Cooldown tracking (by userId)
                this.lastMetabolismByUser = new Map();

                // Processing lock (prevent concurrent heartbeat processing)
                this.isProcessing = false;
            }

            /**
             * Check if user is in cooldown.
             */
            isInCooldown(userId) {
                const last = this.lastMetabolismByUser.get(userId);
                if (!last) return false;
                const cooldownMs = (config.thresholds?.cooldownMinutes || 30) * 60 * 1000;
                return (Date.now() - last) < cooldownMs;
            }

            /**
             * Mark user as metabolized.
             */
            markMetabolized(userId) {
                this.lastMetabolismByUser.set(userId, Date.now());
            }

            /**
             * Resolve growth vectors file path (integration with stability plugin).
             */
            getGrowthVectorsPath() {
                if (config.storage?.growthVectorsPath) {
                    return config.storage.growthVectorsPath;
                }
                // Default: workspace/memory/growth-vectors.json
                return path.join(this.workspacePath, 'memory', 'growth-vectors.json');
            }

            /**
             * DANGEROUS: Write growth vectors to stability plugin's file.
             * These vectors feed into crystallization and may become permanent character traits.
             */
            DANGEROUS_writeGrowthVectors(vectors, _reason = 'metabolism extraction') {
                const gvPath = this.getGrowthVectorsPath();
                const gvDir = path.dirname(gvPath);

                try {
                    ensureDir(gvDir);

                    // Load existing vectors
                    let existing = { vectors: [], candidates: [] };
                    if (fs.existsSync(gvPath)) {
                        try {
                            existing = JSON.parse(fs.readFileSync(gvPath, 'utf8'));
                        } catch (e) {
                            // Start fresh if corrupted
                        }
                    }

                    // Add new candidates
                    for (const v of vectors) {
                        existing.candidates = existing.candidates || [];
                        existing.candidates.push(v);
                    }

                    // Write back
                    fs.writeFileSync(gvPath, JSON.stringify(existing, null, 2));
                    return true;
                } catch (error) {
                    api.logger.error(`[Metabolism:${this.agentId}] Failed to write growth vectors:`, error.message);
                    return false;
                }
            }
        }

        /** @type {Map<string, AgentState>} */
        const agentStates = new Map();

        /**
         * Get or create per-agent state.
         */
        function getAgentState(agentId, workspacePath) {
            const id = agentId || 'main';
            if (!agentStates.has(id)) {
                agentStates.set(id, new AgentState(id, workspacePath));
                api.logger.info(`Initialized metabolism state for agent "${id}"`);
            }
            return agentStates.get(id);
        }

        /**
         * Extract text from message.
         */
        function extractText(msg) {
            if (!msg) return '';
            if (typeof msg.content === 'string') return msg.content;
            if (Array.isArray(msg.content)) {
                return msg.content.map(c => c.text || c.content || '').join(' ');
            }
            return String(msg.content || '');
        }

        // -------------------------------------------------------------------
        // Helper: Process pending candidates (heartbeat slow path)
        // -------------------------------------------------------------------
        const { tryAcquireLock, releaseLock, rollbackLock } = require('./lib/metabolismLock');

        async function _processHeartbeatCandidates(state, ctx, config, api, gapBus) {
            // Acquire file-based lock (crash-safe, multi-process coordinated)
            const lock = tryAcquireLock(state.dataDir, state.agentId);
            if (!lock) {
                api.logger.debug(`[Metabolism:${state.agentId}] Skipping heartbeat — locked by another process`);
                return;
            }

            // Get pending candidates
            const batchSize = config.processing?.batchSize || 3;
            const candidates = state.candidateStore.getPending(batchSize);

            if (candidates.length === 0) {
                releaseLock(state.dataDir, state.agentId);
                return; // Nothing to process
            }

            try {
                api.logger.info(`[Metabolism:${state.agentId}] Processing ${candidates.length} candidate(s)`);

                // Process batch through LLM
                const results = await state.processor.processBatch(candidates);

                // Handle results
                if (results.implications.length > 0) {
                    api.logger.info(
                        `[Metabolism:${state.agentId}] Extracted ${results.implications.length} implications, ` +
                        `${results.growthVectors.length} growth vectors, ${results.gaps.length} gaps`
                    );

                    // Write growth vectors to stability plugin
                    if (config.integration?.writeToStabilityVectors && results.growthVectors.length > 0) {
                        const written = state.DANGEROUS_writeGrowthVectors(results.growthVectors, 'heartbeat batch processing');
                        if (written) {
                            api.logger.info(`[Metabolism:${state.agentId}] Wrote ${results.growthVectors.length} growth vector candidate(s)`);
                        }
                    }

                    // Emit knowledge gaps to subscribed plugins (contemplation, etc.)
                    if (config.integration?.emitKnowledgeGaps && results.gaps.length > 0) {
                        api.logger.info(
                            `[Metabolism:${state.agentId}] Emitting ${results.gaps.length} gap(s) to ${gapBus.listenerCount()} listener(s)`
                        );
                        try {
                            gapBus.emitGaps(results.gaps, ctx.agentId);
                        } catch (e) {
                            api.logger.warn(`[Metabolism:${state.agentId}] Gap listener error:`, e.message);
                        }
                    }
                }

                // Mark processed
                for (const candidate of candidates) {
                    state.candidateStore.markProcessed(candidate.id, {
                        implications: results.processed.find(p => p.id === candidate.id)?.implicationCount || 0
                    });
                }

                // Success — release lock
                releaseLock(state.dataDir, state.agentId);

            } catch (error) {
                api.logger.error(`[Metabolism:${state.agentId}] Processing error:`, error.message);
                // Failure — rollback lock so next attempt can proceed
                rollbackLock(state.dataDir, state.agentId, lock.priorMtime);
            }
        }

        // -------------------------------------------------------------------
        // HOOK: agent_end — FAST PATH: Write candidate if significant
        // -------------------------------------------------------------------

        api.on('agent_end', async (event, ctx) => {
            // Skip heartbeat-originated turns — these are system-driven, not user conversation.
            // Without this guard, heartbeat turns create phantom candidates every ~30min
            // because the entropy fallback estimates 0.5 for sessions with >10 messages.
            if (event.metadata?.isHeartbeat) {
                api.logger.debug(`[Metabolism:${ctx.agentId || 'main'}] Skipping heartbeat-originated turn`);
                return;
            }

            const state = getAgentState(ctx.agentId, event.metadata?.workspace);

            // Get entropy from stability plugin (if available)
            let entropy = 0;
            if (api.stability?.getEntropy) {
                entropy = api.stability.getEntropy(ctx.agentId);
            } else {
                // Fallback: estimate from message characteristics
                const msgCount = (event.messages || []).length;
                entropy = msgCount > 10 ? 0.5 : msgCount > 5 ? 0.3 : 0.1;
            }

            // Get messages
            const messages = event.messages || [];
            const lastUser = [...messages].reverse().find(m => m?.role === 'user');

            if (!lastUser) return;

            const userId = event.metadata?.userId || event.profileId || 'unknown';
            const userText = extractText(lastUser);

            // Check thresholds
            const entropyMinimum = config.thresholds?.entropyMinimum || 0.6;
            const exchangeMinimum = config.thresholds?.exchangeMinimum || 3;
            const explicitMarkers = config.thresholds?.explicitMarkers || [];

            const isHighEntropy = entropy >= entropyMinimum;
            const isLongExchange = messages.length >= exchangeMinimum;
            const hasExplicitMarker = explicitMarkers.some(m =>
                userText.toLowerCase().includes(m.toLowerCase())
            );

            // Dual-threshold: detect natural conversation pauses
            // If entropy is below threshold but we're at a natural break (no tool calls
            // in last assistant turn + sufficient exchanges), still capture the exchange.
            // Uses 2x exchange minimum to avoid noise on short conversations.
            const lastAssistant = [...messages].reverse().find(m => m?.role === 'assistant');
            const lastTurnHadToolCalls = lastAssistant?.tool_calls?.length > 0 ||
                (lastAssistant?.content && typeof lastAssistant.content === 'string' &&
                 lastAssistant.content.includes('tool_use'));
            const isNaturalPause = !lastTurnHadToolCalls &&
                messages.length >= (exchangeMinimum * 2) &&
                !isHighEntropy;

            // Check cooldown
            const inCooldown = state.isInCooldown(userId);

            const shouldQueue = (isHighEntropy || isLongExchange || hasExplicitMarker || isNaturalPause) && !inCooldown;

            if (!shouldQueue) {
                api.logger.debug(
                    `[Metabolism:${state.agentId}] Skipping candidate (entropy: ${entropy.toFixed(2)}, ` +
                    `exchanges: ${messages.length}, explicit: ${hasExplicitMarker}, ` +
                    `naturalPause: ${isNaturalPause}, cooldown: ${inCooldown})`
                );
                return;
            }

            // FAST PATH: Write candidate file
            const candidateId = state.candidateStore.write({
                timestamp: new Date().toISOString(),
                userId,
                entropy,
                lowEntropy: isNaturalPause, // Flag for four-phase prompt adaptation
                messages: messages.slice(-10).map(m => ({
                    role: m.role,
                    content: extractText(m).substring(0, 2000) // Truncate for storage
                })),
                metadata: {
                    exchangeCount: messages.length,
                    sessionId: event.metadata?.sessionId,
                    trigger: isNaturalPause ? 'natural_pause' : isHighEntropy ? 'high_entropy' : hasExplicitMarker ? 'explicit' : 'long_exchange'
                }
            });

            api.logger.info(
                `[Metabolism:${state.agentId}] Queued candidate ${candidateId} ` +
                `(entropy: ${entropy.toFixed(2)}, exchanges: ${messages.length}, ` +
                `trigger: ${isNaturalPause ? 'natural_pause' : 'standard'})`
            );
        });

        // -------------------------------------------------------------------
        // HOOK: agent_end (heartbeat) — SLOW PATH: Process pending candidates
        // Runs on heartbeat-triggered turns only. Replaces invalid 'heartbeat'
        // hook — heartbeat is a trigger type, not a plugin hook name.
        // -------------------------------------------------------------------
        api.on('agent_end', async (event, ctx) => {
            if (ctx.trigger !== 'heartbeat') return;

            const state = getAgentState(ctx.agentId);
            await _processHeartbeatCandidates(state, ctx, config, api, gapBus);
        });

        // -------------------------------------------------------------------
        // HOOK: after_compaction — Ensure pending candidates survive compaction
        // The sessionFile on disk contains the full pre-compaction transcript,
        // so candidates referencing those exchanges remain valid.
        // -------------------------------------------------------------------
        api.on('after_compaction', async (event, ctx) => {
            const state = getAgentState(ctx.agentId);
            const stats = state.candidateStore.getStats();

            if (stats.pending > 0) {
                api.logger.info(
                    `[Metabolism:${state.agentId}] Post-compaction: ${stats.pending} pending candidate(s) ` +
                    `preserved (${event.compactedCount} messages compacted, transcript at ${event.sessionFile || 'unknown'})`
                );

                // If we have pending candidates and aren't already processing,
                // opportunistically process now — compaction means the context window
                // was full, so this is a natural checkpoint.
                if (!state.isProcessing && stats.pending >= (config.processing?.batchSize || 3)) {
                    api.logger.info(`[Metabolism:${state.agentId}] Triggering opportunistic processing after compaction`);
                    await _processHeartbeatCandidates(state, ctx, config, api, gapBus);
                }
            }
        });

        // -------------------------------------------------------------------
        // HOOK: session_end — Final cleanup
        // -------------------------------------------------------------------

        api.on('session_end', async (event, ctx) => {
            const state = getAgentState(ctx.agentId);

            // Clean old processed files (older than 7 days)
            const removed = state.candidateStore.cleanProcessed(7);
            if (removed > 0) {
                api.logger.info(`[Metabolism:${state.agentId}] Cleaned ${removed} old processed file(s)`);
            }
        });

        // -------------------------------------------------------------------
        // Gateway methods: monitoring & debugging
        // -------------------------------------------------------------------

        api.registerGatewayMethod('metabolism.getState', async ({ params, respond }) => {
            const state = getAgentState(params?.agentId);
            const stats = state.candidateStore.getStats();
            respond(true, {
                agentId: state.agentId,
                pending: stats.pending,
                processed: stats.processed,
                isProcessing: state.isProcessing,
                cooldowns: state.lastMetabolismByUser.size,
                growthVectorsPath: state.getGrowthVectorsPath()
            });
        });

        api.registerGatewayMethod('metabolism.getPending', async ({ params, respond }) => {
            const state = getAgentState(params?.agentId);
            const candidates = state.candidateStore.getPending(params?.limit || 10);
            respond(true, {
                agentId: state.agentId,
                candidates: candidates.map(c => ({
                    id: c.id,
                    timestamp: c.timestamp,
                    entropy: c.entropy,
                    messageCount: c.messages?.length || 0
                }))
            });
        });

        api.registerGatewayMethod('metabolism.trigger', async ({ params, respond }) => {
            const state = getAgentState(params?.agentId);

            if (state.isProcessing) {
                respond(false, { error: 'Already processing' });
                return;
            }

            const batchSize = params?.batchSize || config.processing?.batchSize || 3;
            const candidates = state.candidateStore.getPending(batchSize);

            if (candidates.length === 0) {
                respond(true, { message: 'No pending candidates' });
                return;
            }

            state.isProcessing = true;
            try {
                const results = await state.processor.processBatch(candidates);

                for (const candidate of candidates) {
                    state.candidateStore.markProcessed(candidate.id, {
                        implications: results.processed.find(p => p.id === candidate.id)?.implicationCount || 0
                    });
                }

                respond(true, {
                    processed: candidates.length,
                    implications: results.implications.length,
                    growthVectors: results.growthVectors.length,
                    gaps: results.gaps.length
                });
            } catch (error) {
                respond(false, { error: error.message });
            } finally {
                state.isProcessing = false;
            }
        });

        api.logger.info('Metabolism plugin registered — entropy-triggered learning with async processing');
    }
};
