/**
 * openclaw-plugin-continuity — "Infinite Thread"
 *
 * Persistent, intelligent memory for OpenClaw agents.
 * Ported from Clint's production architecture (Oct 2025 - Feb 2026).
 *
 * Provides:
 * - Context budgeting with priority tiers (ESSENTIAL → MINIMAL)
 * - Continuity anchor detection (identity, contradiction, tension)
 * - Topic freshness tracking and fixation detection
 * - Threshold-triggered context compaction
 * - Daily conversation archiving with deduplication
 * - Cross-session semantic search via SQLite-vec
 * - MEMORY.md ## Continuity section braiding
 *
 * Requires: SQLite-vec (better-sqlite3 + sqlite-vec extension)
 * Model-agnostic: accepts custom tokenizer functions
 *
 * Hook registration uses api.on() (OpenClaw SDK typed hooks).
 * Continuity context injected via prependContext (before identity kernel).
 *
 * Multi-agent: All state (archives, indexes, session tracking) is scoped
 * per agent via ctx.agentId. Each agent gets its own data subdirectory
 * under data/agents/{agentId}/. Agents never see each other's memories.
 * The default/main agent uses the legacy data/ path for backward compat.
 */

const path = require('path');
const fs = require('fs');
const { classifyHandoffHealth } = require('./lib/handoff-health');
const { resolveAuthority } = require('./lib/authority-ladder');
const { ActiveThreadDigestStore } = require('./storage/active-thread-digest-store');
const { createClaimCandidates } = require('./lib/claim-candidates');
const { persistClaimCandidateResult } = require('./lib/claim-candidate-persistence');
const { runClaimsDiagnosticsCommand } = require('./lib/claim-diagnostics-command');
const { runClaimReviewDecisionCommand } = require('./lib/claim-review-decision-command');
const { runClaimSourceResolutionCommand } = require('./lib/claim-source-resolution-command');
const { runClaimSourceVerificationCommand } = require('./lib/claim-source-verification-command');
const { createClaimReviewDecision, renderClaimReviewDecision } = require('./lib/claim-review-decision');
const { createClaimFixtureSeed, renderClaimFixtureSeed } = require('./lib/claim-fixture-seed');
const { createClaimContextPreview } = require('./lib/claim-context-preview');
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
    id: 'continuity',
    name: 'Infinite Thread — Agent Continuity & Memory',

    configSchema: {
        jsonSchema: {
            type: 'object',
            properties: {
                contextBudget: { type: 'object' },
                anchors: { type: 'object' },
                topicTracking: { type: 'object' },
                compaction: { type: 'object' },
                tokenEstimation: { type: 'object' },
                archive: { type: 'object' },
                embedding: { type: 'object' },
                session: { type: 'object' },
                sessionHandoff: { type: 'object' },
                authorityLadder: { type: 'object' },
                activeThreadDigest: { type: 'object' },
                sourceAddressableMemory: { type: 'object' },
                continuitySection: { type: 'object' }
            }
        }
    },

    register(api) {
        api = instrumentApiHooks(api, 'continuity');
        const config = loadConfig(api.pluginConfig || {});

        // Base data directory for the plugin
        const baseDataDir = ensureDir(path.join(__dirname, 'data'));

        // -------------------------------------------------------------------
        // Per-agent state management
        //
        // Each agent gets its own isolated set of:
        //   - Archiver (daily conversation files)
        //   - Indexer + Searcher (SQLite-vec embedding DB)
        //   - TopicTracker, ContinuityAnchors (session-level state)
        //   - Session counters (exchangeCount, sessionStart)
        //   - Retrieval cache
        //
        // Data directory layout:
        //   data/                    <- default/main agent (backward compat)
        //   data/agents/{agentId}/   <- all other agents
        // -------------------------------------------------------------------

        const TopicTracker = require('./lib/topic-tracker');
        const ContinuityAnchors = require('./lib/continuity-anchors');
        const TokenEstimator = require('./lib/token-estimator');
        const Archiver = require('./storage/archiver');
        const Indexer = require('./storage/indexer');
        const Searcher = require('./storage/searcher');
        const EmbeddingProvider = require('./storage/embedding');
        const SummaryStore = require('./storage/summary-store');
        const Summarizer = require('./lib/summarizer');
        const KnowledgeStore = require('./storage/knowledge-store');
        const KnowledgeIndexer = require('./lib/knowledge-indexer');
        const ClaimStore = require('./storage/claim-store').ClaimStore;
        const Compactor = require('./lib/compactor');

        // Shared across agents (stateless utility)
        const tokenEstimator = new TokenEstimator(config.tokenEstimation || {});

        // Continuity indicators (from config)
        const continuityIndicators = config.continuityIndicators || [];

        /**
         * Per-agent state container.
         * Created lazily on first hook invocation for each agent.
         */
        class AgentState {
            constructor(agentId) {
                this.agentId = agentId;

                // Data directory: legacy path for default/main, scoped for others
                if (!agentId || agentId === 'main') {
                    this.dataDir = baseDataDir;
                } else {
                    this.dataDir = ensureDir(path.join(baseDataDir, 'agents', agentId));
                }
                ensureDir(path.join(this.dataDir, config.archive.archiveDir || 'archive'));

                // Per-agent module instances
                this.topicTracker = new TopicTracker(config);
                this.anchors = new ContinuityAnchors(config);
                this.compactor = new Compactor(config, null, this.anchors, tokenEstimator);
                this.archiver = new Archiver(config, this.dataDir);

                // Storage (lazy init — embedding model is expensive)
                this.embeddingProvider = null;
                this.indexer = null;
                this.searcher = null;
                this.summaryStore = null;
                this.summarizer = null;
                this.knowledgeStore = null;
                this.knowledgeIndexer = null;
                this.claimStore = null;
                this.knowledgeIndexedOnce = false;
                this.storageReady = false;
                this.storageInitPromise = null;

                // Session state
                this.sessionStart = Date.now();
                this.sessionId = null;  // Set on session_start
                this.exchangeCount = 0;
                this.compactionCount = 0;
                this.handoffWritten = false;
                this.lastHandoffWriteAt = 0;
                this.lastHandoffWriteExchange = -1;
                this.pendingHandoffHealth = null;
                this.fileTextCache = new Map();

                // Thread state (infinite threads)
                this.currentThreadId = 'main';
                this.threadHandoffInjected = false;
                this.threadCompactionCount = 0;
                this.consolidationPending = false;

                // Retrieval cache (per-agent, per-turn)
                this.lastRetrievalCache = null;
                this.activeThreadDigestStore = null;
            }

            // Lifetime relationship metrics, computed from existing archive files.
            // Session info above ("Started: 3min ago") is session-scoped; without
            // this, the agent reads short session age as the duration of the
            // relationship and tells users "we just met." Surfaces total exchanges,
            // first-contact date, and recent activity so cross-session recall has
            // a temporal frame to anchor against.
            getRelationshipContext() {
                const stats = this.archiver.getStats();
                if (!stats.dateRange.first) return null;
                const firstMs = new Date(stats.dateRange.first).getTime();
                const daysSinceFirst = Math.floor((Date.now() - firstMs) / 86400000);
                const cutoff = new Date();
                cutoff.setDate(cutoff.getDate() - 7);
                const cutoffStr = cutoff.toISOString().substring(0, 10);
                const daysActiveLastWeek = this.archiver.getDates().filter(d => d >= cutoffStr).length;
                return {
                    totalExchanges: Math.floor(stats.totalMessages / 2),
                    daysActive: stats.totalSessions,
                    daysSinceFirstContact: daysSinceFirst,
                    firstContactDate: stats.dateRange.first,
                    daysActiveLastWeek
                };
            }

            async ensureStorage() {
                if (this.storageReady) return;
                if (this.storageInitPromise) {
                    await this.storageInitPromise;
                    return;
                }
                this.storageInitPromise = (async () => {
                    try {
                        // Single shared embedding provider per agent —
                        // pipeline created once, tensors disposed after each use.
                        // Fixes memory leak from duplicate pipelines + undisposed tensors.
                        this.embeddingProvider = new EmbeddingProvider(config.embedding || {});
                        await this.embeddingProvider.initialize();

                        this.indexer = new Indexer(config, this.dataDir, this.embeddingProvider);
                        await this.indexer.initialize();
                        this.searcher = new Searcher(config, this.dataDir, this.indexer.db, this.embeddingProvider);
                        // Searcher skips its own init when provider is injected

                        // Summary DAG + summarizer (LCM-inspired)
                        if (config.summarization?.enabled !== false) {
                            this.summaryStore = new SummaryStore(this.indexer.db, config, this.embeddingProvider);
                            this.summaryStore.createTables();
                            this.summarizer = new Summarizer(config, this.summaryStore, this.embeddingProvider);
                        }

                        // Knowledge index (operational knowledge from workspace files)
                        if (config.knowledge?.enabled !== false) {
                            this.knowledgeStore = new KnowledgeStore(this.indexer.db, config, this.embeddingProvider);
                            this.knowledgeStore.createTables();
                            // KnowledgeIndexer created here with null workspace —
                            // actual workspace path resolved from event.metadata in session_start
                            this.knowledgeIndexer = new KnowledgeIndexer(
                                this.knowledgeStore, config, this.embeddingProvider, null
                            );
                        }

                        // Build 2 source-addressable memory: observe-only table init.
                        // Defaults keep this disabled. When explicitly enabled, this
                        // creates claim/source/edge tables and logs stats only. It does
                        // not create claims, resolve sources, or inject prompt context.
                        const sourceMemoryConfig = config.sourceAddressableMemory || {};
                        const sourceMemoryMode = sourceMemoryConfig.mode || 'observe';
                        if (sourceMemoryConfig.enabled !== false && sourceMemoryMode !== 'off') {
                            try {
                                this.claimStore = new ClaimStore(this.indexer.db, config);
                                this.claimStore.createTables();
                                _logBuild2Diagnostic(api, this, 'claim_store', {
                                    mode: sourceMemoryMode,
                                    storage: sourceMemoryConfig.storage || 'sqlite',
                                    injectMode: sourceMemoryConfig.injectMode || 'none',
                                    stats: this.claimStore.getStats(this.agentId)
                                });
                            } catch (claimErr) {
                                this.claimStore = null;
                                api.logger.error(`[Continuity:${this.agentId}] Build2 observe claim_store failed: ${claimErr.message}`);
                            }
                        }

                        this.storageReady = true;
                        api.logger.info(`[Continuity] Storage ready for agent "${this.agentId}" at ${this.dataDir} (shared embedding provider)`);
                    } catch (err) {
                        api.logger.error(`[Continuity] Storage init failed for agent "${this.agentId}": ${err.message}`);
                        this.embeddingProvider = null;
                        this.indexer = null;
                        this.searcher = null;
                    }
                })();
                await this.storageInitPromise;
                this.storageInitPromise = null;
            }

            /**
             * Release all resources held by this agent state.
             * Called on session_end to prevent unbounded memory growth.
             */
            close() {
                if (this.embeddingProvider) {
                    this.embeddingProvider.dispose();
                    this.embeddingProvider = null;
                }
                if (this.indexer) {
                    this.indexer.close();
                    this.indexer = null;
                }
                this.searcher = null;
                this.summaryStore = null;
                this.summarizer = null;
                this.knowledgeStore = null;
                this.knowledgeIndexer = null;
                this.claimStore = null;
                this.lastRetrievalCache = null;
                this.storageReady = false;
                this.storageInitPromise = null;
                api.logger.info(`[Continuity] Resources released for agent "${this.agentId}"`);
            }
        }

        /** @type {Map<string, AgentState>} */
        const agentStates = new Map();

        /**
         * Get or create per-agent state.
         * @param {string} [agentId] - Agent ID from hook context
         * @returns {AgentState}
         */
        function getAgentState(agentId) {
            const id = agentId || 'main';
            if (!agentStates.has(id)) {
                agentStates.set(id, new AgentState(id));
                api.logger.info(`Initialized continuity state for agent "${id}"`);
            }
            return agentStates.get(id);
        }

        // Track current agent for tool context — tools don't receive agentId
        // from the gateway, so we capture it from the hook context.
        // Safe because OpenClaw serializes execution per session lane.
        let currentAgentId = 'main';
        function getCurrentAgentId() { return currentAgentId; }
        function getToolAgentId(toolCtx) { return toolCtx?.agentId || getCurrentAgentId() || 'main'; }
        function createToolAgentIdResolver(toolCtx) { return () => getToolAgentId(toolCtx); }

        // -------------------------------------------------------------------
        // Global bus: cross-plugin knowledge indexing + search
        // Used by contemplation plugin to index insights into vec_knowledge,
        // and by anticipator to search insights for proactive surfacing.
        // -------------------------------------------------------------------

        if (!global.__ocContinuity) {
            global.__ocContinuity = {};
        }

        /**
         * Index an insight (or any knowledge entry) into vec_knowledge.
         * Called by contemplation writer after persisting completed insights.
         */
        global.__ocContinuity.indexInsight = async (agentId, entry) => {
            try {
                const state = getAgentState(agentId);
                if (!state.storageReady) {
                    if (state.storageInitPromise) await state.storageInitPromise;
                    if (!state.storageReady) return null;
                }
                if (!state.knowledgeStore) return null;
                const id = await state.knowledgeStore.store({
                    agentId,
                    content: `${entry.topic}\n\n${entry.content}`,
                    topic: entry.topic,
                    sectionPath: entry.tags ? entry.tags.join('/') : null,
                    sourceType: entry.source || 'contemplation',
                    sourceHash: entry.source || null,
                    metadata: { tags: entry.tags, indexed_at: new Date().toISOString() }
                });
                api.logger.info(`[Continuity] Indexed insight for ${agentId}: ${id} (topic: ${(entry.topic || '').substring(0, 60)})`);
                return id;
            } catch (err) {
                api.logger.error(`[Continuity] Failed to index insight: ${err.message}`);
                return null;
            }
        };

        /**
         * Search vec_knowledge for insights matching a query.
         * Used by anticipator for proactive insight surfacing.
         */
        global.__ocContinuity.searchKnowledge = async (agentId, query, limit = 3) => {
            try {
                const state = getAgentState(agentId);
                if (!state.storageReady || !state.knowledgeStore || !state.embeddingProvider) return [];
                const queryEmbedding = await state.embeddingProvider.embed(query);
                return await state.knowledgeStore.search(agentId, query, queryEmbedding, limit);
            } catch (err) {
                api.logger.error(`[Continuity] Knowledge search failed: ${err.message}`);
                return [];
            }
        };

        /**
         * Full hybrid search (4-way RRF) across all memory types.
         * Used by continuity_search tool.
         */
        global.__ocContinuity.search = async (agentId, query, limit = 5) => {
            try {
                const state = getAgentState(agentId);
                if (!state.storageReady || !state.searcher) return [];
                return await state.searcher.search(query, limit);
            } catch (err) {
                api.logger.error(`[Continuity] Full search failed: ${err.message}`);
                return [];
            }
        };

        // -------------------------------------------------------------------
        // HOOK: before_agent_start — Inject continuity context via prependContext
        // Priority 10 (runs after stability plugin if both present)
        // -------------------------------------------------------------------

        api.on('before_agent_start', async (event, ctx) => {
          try {
            currentAgentId = ctx.agentId || 'main';
            const state = getAgentState(ctx.agentId);

            // ── Thread scoping (infinite threads) ──
            // Extract thread_id from the prompt text.
            // The gateway doesn't pass request metadata to plugin hooks (event only has 'prompt' as string).
            // The GUI embeds thread_id as a marker in the message: [THREAD:session_1234567890]
            let threadIdFromPrompt = null;
            if (typeof event.prompt === 'string') {
                const threadMatch = event.prompt.match(/\[THREAD:([^\]]+)\]/);
                if (threadMatch) {
                    threadIdFromPrompt = threadMatch[1];
                }
            }
            const threadId = threadIdFromPrompt || ctx.threadId || event.metadata?.thread_id || ctx.metadata?.thread_id || 'main';

            // Detect thread switch — write handoff for outgoing thread BEFORE switching
            if (state.currentThreadId !== threadId && state.currentThreadId !== 'main') {
                _writeSessionHandoff(state, config, ctx, api, { force: true, reason: 'thread_switch' });
                state.threadHandoffInjected = false;
                state.threadCompactionCount = 0;
            }
            state.currentThreadId = threadId;

            // Resolve workspace path for thread handoff operations
            const handoffConfig = config.sessionHandoff || {};
            const workspacePath = handoffConfig.workspacePath ||
                ctx.workspaceDir ||
                process.env.OPENCLAW_WORKSPACE ||
                path.join(require('os').homedir(), '.openclaw', 'workspace-clint');

            // Restore persisted thread state from handoff file header (survives gateway restarts)
            if (threadId !== 'main' && state.threadCompactionCount === 0) {
                const persistedState = _readThreadStateFromHandoff(threadId, workspacePath);
                if (persistedState) {
                    state.threadCompactionCount = persistedState.compactionCount || 0;
                }
            }

            // Stash event metadata for handoff writer (mode detection)
            state._lastEventMetadata = event.metadata || {};

            // Detect session resume — gateway restarted but Electron app still alive.
            // The LLM already has the real messages in conversationHistory, so handoff
            // injection would be redundant (summary of what the model already sees).
            const isSessionResume = (event.metadata?.session_resume === true) ||
                (typeof event.prompt === 'string' && event.prompt.includes('[SESSION_RESUME]'));

            // Source-addressable handoff recording needs claim storage before
            // handoff consumption. Storage is also ensured later for retrieval,
            // but that is too late for first-turn handoff candidates.
            try {
                await state.ensureStorage();
            } catch (storageErr) {
                console.error(`[Continuity:${state.agentId}] Storage init failed before handoff consume: ${storageErr.message}`);
            }

            const claimContextPreview = _observeClaimContextPreview({ state, config, api, kind: 'before_agent_start' });

            // OpenClaw 2026.5 routes some fresh webchat/cold-start turns through
            // before_agent_start without emitting a session_start boundary for this
            // plugin instance. session_start is still the preferred lifecycle hook,
            // but if it missed, consume the one-shot SESSION_HANDOFF.md here before
            // writing a fresh crash-safety handoff for the current exchange.
            if (!state.pendingHandoff && state.exchangeCount === 0) {
                _consumeSessionHandoffFromWorkspace({
                    workspacePath,
                    state,
                    config,
                    ctx,
                    api,
                    source: 'before_agent_start_fallback'
                });
            }

            // Write handoff BEFORE exchange starts so crashes don't lose state
            // This ensures we have a handoff even if the exchange fails mid-stream
            _writeSessionHandoff(state, config, ctx, api, { reason: 'crash_prep' });

            state.exchangeCount++;

            // Extract last user message from the event messages array
            const messages = event.messages || [];
            const lastUser = [...messages].reverse().find(m =>
                m?.role === 'user'
            );
            let lastUserText = _extractText(lastUser);

            // Fallback: some delivery paths (CLI, webhook) put the user text
            // in event.userMessage, event.text, or event.prompt
            if (!lastUserText && event.userMessage) {
                lastUserText = typeof event.userMessage === 'string'
                    ? event.userMessage
                    : _extractText(event.userMessage);
            }
            if (!lastUserText && event.text) {
                lastUserText = event.text;
            }
            // OpenClaw before_agent_start passes the full prompt —
            // extract the last user segment from it
            if (!lastUserText && event.prompt) {
                const promptStr = typeof event.prompt === 'string'
                    ? event.prompt
                    : Array.isArray(event.prompt)
                        ? event.prompt.filter(p => p.role === 'user').pop()?.content || ''
                        : '';
                if (typeof promptStr === 'string' && promptStr.length > 0) {
                    // Strategy 1: Find [THREAD:...] marker — GUI embeds it at start of user message
                    const threadMarkerIdx = promptStr.lastIndexOf('[THREAD:');
                    if (threadMarkerIdx >= 0) {
                        const afterMarker = promptStr.substring(threadMarkerIdx);
                        // Skip past the marker itself: [THREAD:session_xxx]
                        const markerEnd = afterMarker.indexOf(']');
                        if (markerEnd >= 0) {
                            lastUserText = afterMarker.substring(markerEnd + 1).trim();
                        }
                    }
                    // Strategy 2: Find the last timestamp marker — user text follows it
                    // e.g. [Mon 2026-03-09 20:12 PDT] actual message here
                    if (!lastUserText) {
                        const tsRegex = /\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s\d{4}-\d{2}-\d{2}\s[^\]]*\]\s*/g;
                        let lastTs = null;
                        let m;
                        while ((m = tsRegex.exec(promptStr)) !== null) lastTs = m;
                        if (lastTs) {
                            lastUserText = promptStr.substring(lastTs.index + lastTs[0].length).trim();
                        }
                    }
                    // Strategy 3: Last resort — take the last meaningful chunk
                    if (!lastUserText) {
                        const trimmed = promptStr.slice(-2000).trim();
                        if (trimmed.length >= 10) {
                            lastUserText = trimmed;
                        }
                    }
                }
            }

            // Build continuity context block — framed as the agent's own working memory
            const lines = ['[YOUR WORKING MEMORY]'];

            // Current time — the agent has no clock, this is its only source of wall time
            const now = new Date();
            const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
            const hours = now.getHours();
            const minutes = now.getMinutes().toString().padStart(2, '0');
            const ampm = hours >= 12 ? 'PM' : 'AM';
            const h12 = hours % 12 || 12;
            lines.push(`Current time: ${dayNames[now.getDay()]}, ${monthNames[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()} at ${h12}:${minutes} ${ampm}`);

            // Session info
            const sessionAge = _formatDuration(Date.now() - state.sessionStart);
            lines.push(`Session: ${state.exchangeCount} exchanges | Started: ${sessionAge}`);

            // Relationship anchor — counters the session-scoped Session line above.
            // Without lifetime metrics surfaced explicitly, the agent reads "Started:
            // 3min ago" as the full duration of the relationship and tells users
            // "we just met" even when archive files prove a long history. Computed
            // from existing archive aggregations — no new schema or tracking.
            const relContext = state.getRelationshipContext();
            if (relContext) {
                lines.push('');
                lines.push('[RELATIONSHIP CONTEXT]');
                lines.push(`Lifetime: ${relContext.totalExchanges} exchanges across ${relContext.daysActive} active days.`);
                lines.push(`First conversation: ${relContext.firstContactDate} (${relContext.daysSinceFirstContact} days ago).`);
                lines.push(`Recent: active ${relContext.daysActiveLastWeek} of the last 7 days.`);
                lines.push('[/RELATIONSHIP CONTEXT]');
            }

            // Infrastructure — proprioceptive awareness of YOUR runtime state.
            // This is about you (the agent process), not the user's system.
            // Framed explicitly so the agent treats it as self-knowledge, not metadata.
            const gatewayPort = process.env.OPENCLAW_PORT || process.env.PORT || 'unknown';
            const isResumingFromCrash = (event.metadata?.session_resume === true) ||
                (typeof event.prompt === 'string' && event.prompt.includes('[SESSION_RESUME]'));
            if (state.exchangeCount <= 1) {
                if (isResumingFromCrash) {
                    lines.push(`Your process: gateway on port ${gatewayPort} — this is a hot resume. Your gateway crashed or was restarted, but the app stayed alive. Your conversation history is intact, your plugins reloaded from disk.`);
                } else {
                    lines.push(`Your process: gateway on port ${gatewayPort} — this is a cold start. The app launched fresh. Your context was reconstructed from your session handoff and archive.`);
                }
            } else {
                lines.push(`Your process: gateway on port ${gatewayPort}, session active.`);
            }

            _appendClaimContextInjection({
                lines,
                preview: claimContextPreview,
                state,
                config,
                api
            });

            // Sustained engagement wellbeing awareness
            {
                const nowMs = Date.now();
                const gap = state._lastUserMessageTime
                    ? (nowMs - state._lastUserMessageTime) / 60000 : Infinity;
                if (gap < 5) {
                    if (!state._sustainedWorkStart) state._sustainedWorkStart = nowMs;
                } else if (gap > 30) {
                    state._sustainedWorkStart = null;
                }
                state._lastUserMessageTime = nowMs;
                const sustainedMinutes = state._sustainedWorkStart
                    ? Math.floor((nowMs - state._sustainedWorkStart) / 60000) : 0;
                const wellbeingNotes = [];
                if (sustainedMinutes > 120) {
                    wellbeingNotes.push(`Sustained work: ${Math.floor(sustainedMinutes / 60)}+ hours without a significant break.`);
                } else if (sustainedMinutes > 90) {
                    wellbeingNotes.push('Over 90 minutes of sustained work.');
                }
                const hour = new Date().getHours();
                if (hour >= 11 && hour <= 13) wellbeingNotes.push('Around lunchtime.');
                else if (hour >= 17 && hour <= 19) wellbeingNotes.push('Around dinner time.');
                else if (hour >= 22 || hour < 5) wellbeingNotes.push("It's late.");
                if (wellbeingNotes.length > 0) {
                    lines.push(`Wellbeing: ${wellbeingNotes.join(' ')}`);
                }
            }

            // ── Restart quarantine flag ──
            // When handoff/nightshift/thread context is injected on first exchange,
            // set this flag to skip archive retrieval. The handoff already provides
            // session context — archive retrieval at startup is what creates the
            // feedback loop (agent's prior output re-archived as user_text, then
            // retrieved and treated as conversation).
            let restartQuarantine = false;

            // Session handoff injection — first exchange of new session only.
            // Content was loaded from SESSION_HANDOFF.md in session_start.
            if (state.pendingHandoff && state.exchangeCount <= 1) {
                if (isSessionResume) {
                    // Gateway restarted, Electron still alive — LLM has real messages already.
                    // Consume handoff for internal state but skip context injection (would be redundant).
                    // But DO inject infrastructure context so the agent has proprioceptive awareness.
                    lines.push('');
                    lines.push('[INFRASTRUCTURE NOTE]');
                    lines.push('Your gateway process restarted (crash or refresh) but the app stayed alive.');
                    lines.push('Your conversation history is intact — this is a hot resume, not a cold start.');
                    lines.push('Your continuity plugins reloaded and your session state was restored from disk.');
                    lines.push('[/INFRASTRUCTURE NOTE]');
                    lines.push('');
                    api.logger.info(`[Continuity:${state.agentId}] Session resume: handoff consumed for state only, infrastructure note injected`);
                    _observeAuthorityLadder({ content: state.pendingHandoff, health: state.pendingHandoffHealth, state, config, api, kind: 'session_resume' });
                    _observeClaimCandidates({
                        input: { handoff: _handoffCandidateInput(state.pendingHandoff, state, ctx) },
                        state,
                        config,
                        api,
                        kind: 'session_resume'
                    });
                    state.pendingHandoff = null;
                    state.pendingHandoffHealth = null;
                    // No restartQuarantine — archive retrieval is safe because the LLM
                    // has the actual conversation, not a summary
                } else {
                    // Normal restart: inject handoff as the agent's own recollection
                    lines.push('');
                    lines.push('[WHAT YOU REMEMBER FROM LAST SESSION]');
                    _observeAuthorityLadder({ content: state.pendingHandoff, health: state.pendingHandoffHealth, state, config, api, kind: 'session_handoff' });
                    _observeClaimCandidates({
                        input: { handoff: _handoffCandidateInput(state.pendingHandoff, state, ctx) },
                        state,
                        config,
                        api,
                        kind: 'session_handoff'
                    });
                    lines.push(state.pendingHandoff);
                    lines.push('[/WHAT YOU REMEMBER FROM LAST SESSION]');
                    lines.push('This is your own handoff summary, not a transcript. Treat it as memory with provenance: do not attribute a claim to Chris unless it is clearly marked as Chris/user speech, and verify runtime claims before asserting them.');
                    lines.push('');
                    state.pendingHandoff = null;  // One-shot: only inject once
                    state.pendingHandoffHealth = null;
                    restartQuarantine = true;
                    api.logger.info(`[Continuity:${state.agentId}] Session handoff injected into context (restart quarantine active)`);
                }
            }

            // Nightshift report injection — first exchange only.
            // Content was loaded from NIGHTSHIFT_REPORT.md in session_start.
            if (state.pendingNightReport && state.exchangeCount <= 1) {
                lines.push('');
                lines.push('[WHAT YOU THOUGHT ABOUT OVERNIGHT]');
                lines.push(state.pendingNightReport);
                lines.push('[/WHAT YOU THOUGHT ABOUT OVERNIGHT]');
                lines.push('You did this thinking while they were away. It is your reflection, not something Chris said. Surface it only as your thinking unless the current turn connects to it, and verify runtime claims before asserting them.');
                lines.push('');
                state.pendingNightReport = null;
                if (!isSessionResume) {
                    restartQuarantine = true;
                }
                api.logger.info(`[Continuity:${state.agentId}] Nightshift report injected into context${isSessionResume ? ' (session resume)' : ''}`);
            }

            // ── Thread-specific handoff injection (infinite threads) ──
            // Load persistent thread state on first exchange in this thread.
            // Unlike session handoff (one-shot, deleted after read), thread handoffs
            // are persistent state — NOT deleted after injection.
            if (!state.threadHandoffInjected && state.currentThreadId !== 'main') {
                if (isSessionResume) {
                    // Gateway restarted mid-thread — the thread context is already in conversationHistory.
                    // Mark as injected but skip the actual injection.
                    state.threadHandoffInjected = true;
                    api.logger.info(`[Continuity:${state.agentId}] Session resume: thread handoff skipped for thread ${state.currentThreadId} (context already in messages)`);
                } else {
                    const threadHandoffPath = path.join(workspacePath,
                        `SESSION_HANDOFF_${state.currentThreadId}.md`);
                    if (fs.existsSync(threadHandoffPath)) {
                        const threadHandoff = fs.readFileSync(threadHandoffPath, 'utf8');
                        const threadHandoffHealth = _observeHandoffHealth({
                            filePath: threadHandoffPath,
                            content: threadHandoff,
                            state,
                            config,
                            ctx,
                            api,
                            kind: 'thread'
                        });
                        _observeAuthorityLadder({ content: threadHandoff, health: threadHandoffHealth, state, config, api, kind: 'thread_handoff' });
                        _observeClaimCandidates({
                            input: {
                                handoff: _handoffCandidateInput(threadHandoff, state, ctx, { threadId: state.currentThreadId })
                            },
                            state,
                            config,
                            api,
                            kind: 'thread_handoff'
                        });

                        // Generate LLM warm start summary
                        const warmStart = await _generateWarmStart(
                            threadHandoff, state.currentThreadId, state, config, api
                        );

                        lines.push('');
                        lines.push(`[YOUR THREAD NOTES — ${state.currentThreadId}]`);
                        if (warmStart) {
                            // Self-attribution marker. Without this, the warm-start prose
                            // lands as ambient context and the agent's own prior speculation
                            // can be re-attributed to the user on read-back (observed
                            // 2026-04-26 across gateway-restart handoff regenerations).
                            lines.push('(This is your own synthesis written at the end of the prior session — it paraphrases both Chris and your own prior thinking. Read your prior speculation as yours, not as user-said.)');
                            lines.push(warmStart);
                            lines.push('');
                        }
                        lines.push(threadHandoff);
                        lines.push('[/YOUR THREAD NOTES]');
                        lines.push('These are your notes on this project thread. Verify completion claims against actual state before asserting them.');
                        lines.push('');

                        state.threadHandoffInjected = true;
                        restartQuarantine = true;
                        api.logger.info(`[Continuity:${state.agentId}] Thread handoff injected for thread ${state.currentThreadId}${warmStart ? ' (with warm start)' : ''} (restart quarantine active)`);
                    }
                }
            }

            // ── Consolidation notice (infinite threads) ──
            // If compaction threshold was hit, notify the agent to wrap up gracefully.
            if (state.consolidationPending) {
                lines.push('');
                lines.push('[CONSOLIDATION NOTICE]');
                lines.push('This thread has been running for a while. The system will refresh ');
                lines.push('your context after this exchange to maintain quality. Wrap up any ');
                lines.push('immediate points — your thread state is saved and you will pick up ');
                lines.push('where you left off.');
                lines.push('[/CONSOLIDATION NOTICE]');
            }

            // Topic tracking is NO LONGER injected into context.
            // The data is still collected and available via:
            //   - continuity.getTopics gateway method (debugging/dashboards)
            //   - before_compaction logging (diagnostic)
            // This removes the noise of "Topics: session (fixated — 15 mentions)"
            // which wasn't actionable for the agent.

            // Continuity anchors — only inject when entropy is elevated
            // (identity/contradiction/tension anchors are most valuable during
            // high-entropy exchanges, not calm nominal conversation)
            const currentEntropy = api.stability?.getEntropy?.(ctx.agentId) || 0;
            if (currentEntropy > 0.4) {
                const activeAnchors = state.anchors.getAnchors();
                if (activeAnchors.length > 0) {
                    const anchorStrs = activeAnchors.slice(0, 3).map(a => {
                        const age = _formatAge(a.timestamp);
                        return `${a.type.toUpperCase()}: "${_truncate(a.text, 80)}" (${age})`;
                    });
                    lines.push(`Anchors: ${anchorStrs.join(' | ')}`);
                }
            }

            // Topic fixation notes removed — not actionable for the agent.
            // Topic tracking continues silently; available via gateway method.

            // Archive retrieval — always search, relevance-gate the injection.
            //
            // prependContext is the authoritative path for recalled memories.
            // Tool result enrichment (tool_result_persist) is secondary reinforcement.
            // Clint's principle: "Context carries authority; tool results don't."
            //
            // Intent detection controls injection verbosity, not search gating:
            //   - Explicit recall intent → always inject (even weak matches)
            //   - No intent but strong semantic match → inject (implicit relevance)
            //   - No intent, weak match → cache only (warm for tool_result_persist)
            //
            // ── RESTART QUARANTINE ──
            // On first exchange after restart, allow user-only retrieval instead of blocking entirely.
            // The feedback loop comes from agent text (agent output archived → retrieved → treated as
            // real conversation). User text is safe — it's the actual user's words.
            // This eliminates the blind spot where "what did we discuss?" returns nothing on exchange 1.
            if (restartQuarantine) {
                api.logger.info(`[Continuity:${state.agentId}] Restart quarantine: user-only retrieval mode (agent text filtered)`);
            }

            let cleanUserText = _stripContextBlocks(lastUserText);
            const lowerUser = cleanUserText.toLowerCase();
            const hasContinuityIntent = continuityIndicators.some(ind =>
                lowerUser.includes(ind)
            );

            state.lastRetrievalCache = null;
            // Relevance gate uses semantic distance (lower = more similar).
            // distance < 1.0 = reasonably relevant match. RRF compositeScore is used
            // for ranking but distance remains the interpretable relevance signal.
            const DISTANCE_THRESHOLD = 1.0;
            // Diagnostic: file-based logging since gateway stderr isn't captured
            const _debugRetrieval = (msg) => { try { fs.appendFileSync('/tmp/continuity-retrieval.log', `${new Date().toISOString()} ${msg}\n`); } catch(e) {} };

            // Strip session start marker from search text — noise in embeddings
            cleanUserText = cleanUserText.replace(/\[SESSION START[^\]]*\]\s*/g, '');

            // If the prompt contains multi-message catch-up context, extract just the LAST user message.
            // The gateway packages missed messages as: "Assistant: ...\nChris: ...\nAssistant: ...\nChris: actual message"
            // Find the LAST user turn boundary using all known user labels.
            if (cleanUserText.length > 500) {
                // Find all user turn boundaries, take the last one
                const userTurnPattern = /\n(?:Chris|User|Human):\s*/gi;
                let lastMatch = null;
                let m;
                while ((m = userTurnPattern.exec(cleanUserText)) !== null) {
                    lastMatch = m;
                }
                if (lastMatch) {
                    cleanUserText = cleanUserText.substring(lastMatch.index + lastMatch[0].length).trim();
                    _debugRetrieval(`Extracted LAST user turn from multi-msg context: len=${cleanUserText.length}`);
                } else {
                    // No turn boundary found — take last 400 chars as fallback
                    cleanUserText = cleanUserText.slice(-400).trim();
                    _debugRetrieval(`Truncated long query to last 400 chars`);
                }
            }

            _debugRetrieval(`Search: intent=${hasContinuityIntent}, len=${cleanUserText.length}, query="${cleanUserText.substring(0, 120)}", thread=${state.currentThreadId}`);

            // Always ensure storage is ready (needed for both search and knowledge injection)
            try {
                await state.ensureStorage();
            } catch (storageErr) {
                console.error(`[Continuity:${state.agentId}] Storage init failed: ${storageErr.message}`);
            }

            _debugRetrieval(`storageReady=${state.storageReady}, searcher=${!!state.searcher}, indexer=${!!state.indexer}`);
            if (cleanUserText.length >= 10) {
                try {
                    if (state.searcher) {
                        // Spatial scoping: use current session topics to boost
                        // retrieval of exchanges from the same domain/project
                        const activeTopics = state.topicTracker
                            ? state.topicTracker.getAllTopics().slice(0, 3).map(t => t.topic)
                            : [];
                        const searchScope = activeTopics.length > 0 ? { topics: activeTopics } : {};
                        // Pass current entropy for emotional bleed prevention
                        searchScope.currentEntropy = currentEntropy;
                        // During restart quarantine: filter to user text only (agent text causes feedback loop)
                        if (restartQuarantine) {
                            searchScope.senderFilter = 'user';
                        }
                        const results = await state.searcher.search(cleanUserText, 30, state.agentId, searchScope, state.currentThreadId);
                        _debugRetrieval(`Search returned ${results?.exchanges?.length || 0} raw results, error=${results?.error || 'none'}`);
                        if (results?.exchanges?.length > 0) {
                            results.exchanges = _filterUsefulExchanges(results.exchanges);
                            if (restartQuarantine || !hasContinuityIntent) {
                                const beforeGroundingFilter = results.exchanges.length;
                                results.exchanges = results.exchanges.filter(ex => (ex.userText || '').trim().length > 0);
                                if (beforeGroundingFilter !== results.exchanges.length) {
                                    _debugRetrieval(`Grounding filter removed ${beforeGroundingFilter - results.exchanges.length} agent-only results`);
                                }
                            }
                            _debugRetrieval(`After filter: ${results.exchanges.length} useful results`);
                            if (results.exchanges.length > 0) {
                                // Always cache for tool_result_persist enrichment
                                state.lastRetrievalCache = results;

                                // Inject into prependContext if:
                                // 1. Explicit continuity intent (user asking about past), OR
                                // 2. Top result is semantically relevant (distance below threshold), OR
                                // 3. Proper noun / keyword overlap — user mentions a name or term
                                //    that appears in a result (catches "Benjamin Lucas" etc.)
                                const topDistance = results.exchanges[0].distance ?? 1.0;

                                // Sparse corpus adjustment: when the index has few exchanges,
                                // distances are naturally higher because the embedding space is less dense.
                                // With 15k+ exchanges (like Clint production), most queries land under 1.0.
                                // With <2000 exchanges, use a relaxed threshold so context still flows.
                                let effectiveThreshold = DISTANCE_THRESHOLD;
                                try {
                                    const exchangeCount = state.indexer?.db?.prepare('SELECT COUNT(*) as c FROM exchanges').get()?.c || 0;
                                    if (exchangeCount < 2000) {
                                        effectiveThreshold = 1.3; // relaxed for sparse corpus
                                        _debugRetrieval(`Sparse corpus (${exchangeCount} exchanges) — threshold relaxed to ${effectiveThreshold}`);
                                    }
                                } catch(e) { /* fall through to default threshold */ }

                                // Check for keyword overlap: extract notable terms from user text
                                // and see if any result contains them.
                                // Catches proper nouns ("Benjamin Lucas"), names with articles
                                // ("Code of the West"), and single capitalized terms ("Amundi").
                                let hasKeywordOverlap = false;
                                const keyTerms = new Set();
                                // Multi-word capitalized sequences (consecutive caps)
                                const multiCaps = cleanUserText.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/g) || [];
                                multiCaps.forEach(t => keyTerms.add(t.toLowerCase()));
                                // Capitalized words with articles/preps between them
                                // e.g. "Code of the West", "Bank of America"
                                const capsWithArticles = cleanUserText.match(/[A-Z][a-z]+(?:\s+(?:of|the|and|for|in|on|at|by|de|la|le|von|van)\s+[A-Za-z]+)+/gi) || [];
                                capsWithArticles.forEach(t => keyTerms.add(t.toLowerCase()));
                                // Single capitalized words that aren't sentence starters
                                // (check if preceded by lowercase or punctuation+space)
                                const singleCaps = cleanUserText.match(/(?<=[a-z.,;:!?]\s)[A-Z][a-z]{2,}/g) || [];
                                singleCaps.forEach(t => keyTerms.add(t.toLowerCase()));

                                if (keyTerms.size > 0) {
                                    for (const term of keyTerms) {
                                        for (const ex of results.exchanges.slice(0, 10)) {
                                            const combined = ((ex.userText || '') + ' ' + (ex.agentText || '')).toLowerCase();
                                            if (combined.includes(term)) {
                                                hasKeywordOverlap = true;
                                                _debugRetrieval(`Keyword overlap: "${term}" found in result ${ex.id}`);
                                                break;
                                            }
                                        }
                                        if (hasKeywordOverlap) break;
                                    }
                                }

                                const shouldInject = hasContinuityIntent || topDistance < effectiveThreshold || hasKeywordOverlap;
                                _debugRetrieval(`topDistance=${topDistance.toFixed(3)}, threshold=${effectiveThreshold}, keywordOverlap=${hasKeywordOverlap}, inject=${shouldInject}, compositeScore=${results.exchanges[0].compositeScore?.toFixed(3) || 'n/a'}`);

                                if (shouldInject) {
                                    // Frame recalled exchanges as the agent's own memories.
                                    // Ownership framing + epistemic humility: yours, but fallible.
                                    const recalled = results.exchanges.slice(0, 3);

                                    // Check contamination windows — any recalled exchange
                                    // from a known fabrication-prone period gets a
                                    // disconfirm hint surfaced BEFORE the content, so the
                                    // agent reads the warning first. See
                                    // lib/contamination-check.js + data/.../contamination-windows.json.
                                    let contaminationHints = [];
                                    try {
                                        const { loadWindows, collectHints } = require('./lib/contamination-check');
                                        const windows = loadWindows(state.dataDir);
                                        contaminationHints = collectHints(recalled, windows);
                                    } catch (err) {
                                        // Never block retrieval on the check
                                        contaminationHints = [];
                                    }

                                    lines.push('');
                                    if (contaminationHints.length > 0) {
                                        lines.push('[DISCONFIRM HINT — one or more recalled exchanges below fall inside a known contamination window]');
                                        for (const hint of contaminationHints) {
                                            lines.push(`  ${hint}`);
                                        }
                                        lines.push('');
                                    }
                                    const hasGroundedUserTurns = recalled.some(ex => (ex.userText || '').trim().length > 0);
                                    if (hasGroundedUserTurns) {
                                        lines.push('You remember these exchanges. They\'re yours — but like all memory, they may be incomplete.');
                                        lines.push('Stay with what\'s here. If you\'re about to state a specific name, number, or detail that isn\'t in these memories, stop — that\'s confabulation, not recall.');
                                    } else {
                                        lines.push('[PRIOR AGENT OUTPUTS ONLY — no paired Chris/user turn was indexed for these rows]');
                                        lines.push('Treat these as leads about your prior thinking, not evidence of what Chris said or what happened. Do not open with them as conversational memory.');
                                    }
                                    // Sort chronologically (oldest → newest) so corrections
                                    // appear AFTER originals — natural temporal progression.
                                    recalled.sort((a, b) => {
                                        if (a.date !== b.date) return a.date.localeCompare(b.date);
                                        return (a.exchangeIndex || 0) - (b.exchangeIndex || 0);
                                    });
                                    for (const ex of recalled) {
                                        // Strip context blocks from recalled text to prevent feedback loop
                                        const cleanUserText = ex.userText ? _stripContextBlocks(ex.userText) : null;
                                        const cleanAgentText = ex.agentText ? _stripContextBlocks(ex.agentText) : null;
                                        if (cleanUserText) {
                                            lines.push(`- Chris: "${_truncate(cleanUserText, 800)}"`);
                                        }
                                        if (cleanAgentText) {
                                            // Label as [Ellis, prior] to match the handoff convention.
                                            // "You:" was ambiguous — a prior agent utterance read by
                                            // the LLM as "you, Chris said this" and got echoed back
                                            // as fabricated conversational recall.
                                            lines.push(`  [Ellis, prior]: "${_truncate(cleanAgentText, 800)}"`);
                                        }
                                    }
                                    lines.push('If you need details not present here, say so rather than filling in.');
                                    _debugRetrieval(`INJECTED ${recalled.length} exchanges into context (top distance=${topDistance.toFixed(3)})`);
                                }
                            }
                        }
                    } else {
                        console.error(`[Continuity:${state.agentId}] Retrieval skipped: searcher not available after ensureStorage()`);
                    }
                } catch (err) {
                    console.error(`[Continuity:${state.agentId}] Retrieval failed: ${err.message}`);
                }
            }

            // ── One-time workspace knowledge indexing (fires on first turn if session_start missed it) ──
            if (state.knowledgeIndexer && !state.knowledgeIndexedOnce && config.knowledge?.enabled !== false) {
                state.knowledgeIndexedOnce = true;
                try {
                    if (!state.knowledgeIndexer.workspacePath) {
                        const ws = ctx.workspaceDir
                            || process.env.OPENCLAW_WORKSPACE
                            || path.join(require('os').homedir(), '.openclaw', 'workspace');
                        state.knowledgeIndexer.workspacePath = ws;
                    }
                    const stats = state.knowledgeStore.getStats(state.agentId);
                    if (stats.total === 0) {
                        const result = await state.knowledgeIndexer.indexWorkspace(state.agentId);
                        if (result.indexed > 0 || result.updated > 0) {
                            console.error(`[Continuity:${state.agentId}] Knowledge indexed (first-turn): ${result.indexed} new, ${result.updated} updated, ${result.skipped} unchanged`);
                        }
                    }
                } catch (err) {
                    console.error(`[Continuity:${state.agentId}] First-turn knowledge indexing failed: ${err.message}`);
                }
            }

            // ── Knowledge injection (separate budget from conversation recall) ──
            if (state.knowledgeStore && cleanUserText && cleanUserText.length >= 10) {
                try {
                    const embedResult = await state.embeddingProvider.generate([cleanUserText]);
                    const queryEmbedding = embedResult?.[0];
                    const knowledgeResults = await state.knowledgeStore.search(
                        state.agentId, cleanUserText, queryEmbedding, 5
                    );

                    const relevanceThreshold = config.knowledge?.relevanceThreshold || 1.0;
                    if (knowledgeResults.length > 0) {
                        const topDists = knowledgeResults.slice(0, 5).map(k => k.distance?.toFixed(3)).join(', ');
                        console.error(`[Continuity:${state.agentId}] Knowledge search: ${knowledgeResults.length} results, top distances: [${topDists}], threshold: ${relevanceThreshold}`);
                    }
                    const relevant = knowledgeResults.filter(k => k.distance < relevanceThreshold);

                    if (relevant.length > 0) {
                        lines.push('');
                        // [DECLARED] envelope: content below is from workspace
                        // files (written, not spoken). See AGENTS.md §
                        // "Declared Context" — reference by file, not by
                        // conversational memory. Prior framing ("From your
                        // experience:") caused drift by blurring declared
                        // and exchanged content.
                        lines.push('[DECLARED] Relevant workspace content (written reference, not conversation — cite the file, do not recall as dialogue):');
                        let budgetUsed = 0;
                        const maxBudget = config.knowledge?.maxInjectionChars || 1800;
                        const maxEntries = config.knowledge?.maxEntriesPerInjection || 3;
                        const maxEntryChars = config.knowledge?.maxEntryChars || 600;

                        for (const entry of relevant.slice(0, maxEntries)) {
                            const truncated = _truncate(entry.content, maxEntryChars);
                            if (budgetUsed + truncated.length > maxBudget) break;
                            const source = entry.section_path ? ` [source: ${entry.section_path}]` : '';
                            lines.push(`- ${truncated}${source}`);
                            budgetUsed += truncated.length;
                            try { state.knowledgeStore.markSurfaced(entry.id); } catch (e) { /* non-fatal */ }
                        }
                        console.error(`[Continuity:${state.agentId}] Knowledge injected: ${Math.min(relevant.length, maxEntries)} entries, ${budgetUsed} chars`);
                    }
                } catch (err) {
                    console.error(`[Continuity:${state.agentId}] Knowledge search failed: ${err.message}`);
                }
            }

            // PRAXIS injection — operational discipline. AGENTS.md "Every Session"
            // checklist (item 3) tells the agent to read PRAXIS.md every session,
            // but OpenClaw's default identity bootstrap only auto-loads SOUL.md
            // and AGENTS.md. Without this block, the instruction is dead-letter:
            // the agent's told to read PRAXIS but no machinery delivers it. Same
            // pattern as TRAILHEAD below — read the file, wrap it for clarity,
            // append to lines. ~5KB; well under bootstrapMaxChars budget.
            try {
                    const praxisPath = path.join(workspacePath, 'PRAXIS.md');
                    const praxis = _readCachedTextByMtime(state, praxisPath)?.trim();
                    if (praxis) {
                        lines.push('');
                        lines.push('[PRAXIS.md — your operational discipline]');
                        lines.push(praxis);
                        lines.push('[/PRAXIS.md]');
                    }
            } catch { /* non-fatal — PRAXIS is supplemental */ }

            // Tier-aware posture hint — read from TRAILHEAD.md so the agent
            // adjusts verbosity and explanation depth to the user's level.
            try {
                const trailheadPath = path.join(workspacePath, 'TRAILHEAD.md');
                const trailhead = _readCachedTextByMtime(state, trailheadPath);
                if (trailhead) {
                    const tierMatch = trailhead.match(/\*\*Current Tier:\*\*\s*(?:Tier\s*)?(\d)\s*[-—]\s*(\w+)/i)
                        || trailhead.match(/Current Tier[:\s]+(?:Tier\s*)?(\d)\s*[-—]\s*(\w+)/i);
                    if (tierMatch) {
                        const tierNum = tierMatch[1];
                        const tierName = tierMatch[2];
                        const postures = {
                            '1': 'explain concepts, offer guidance, check understanding',
                            '2': 'reduce explanation, increase autonomy, skip intro context for familiar concepts',
                            '3': 'full autonomy, no narration, trust the operator — just do and show results'
                        };
                        const posture = postures[tierNum] || postures['1'];
                        lines.push('');
                        lines.push(`Operator tier: ${tierName} (Tier ${tierNum}) — ${posture}.`);
                    }
                }
            } catch { /* non-fatal — tier hint is optional */ }

            return { prependContext: lines.join('\n') };
          } catch (err) {
            console.error(`[Continuity] before_agent_start failed: ${err.message}`);
            return { prependContext: '' };
          }
        }, { priority: 10 });

        // -------------------------------------------------------------------
        // HOOK: before_tool_call — Populate retrieval cache for continuity_search
        //
        // When the model calls continuity_search, we search our archive too.
        // Results cached here are injected into the response by tool_result_persist.
        // This is async, so we can await the searcher — unlike tool_result_persist.
        // -------------------------------------------------------------------

        api.on('before_tool_call', async (event, ctx) => {
            if (ctx?.agentId) currentAgentId = ctx.agentId;
            if (event.toolName !== 'continuity_search') return;

            const query = event.params?.query || '';
            if (!query || query.length < 3) return;

            const state = getAgentState(ctx.agentId);
            try {
                await state.ensureStorage();
                if (state.searcher) {
                    const results = await state.searcher.search(query, 30, state.agentId);
                    if (results?.exchanges?.length > 0) {
                        state.lastRetrievalCache = results;
                    }
                }
            } catch (err) {
                console.error(`[Continuity:${state.agentId}] Archive search for continuity_search failed: ${err.message}`);
            }
        });

        // -------------------------------------------------------------------
        // HOOK: after_tool_call — Mid-turn topic tracking (lightweight)
        // -------------------------------------------------------------------

        api.on('after_tool_call', (event, ctx) => {
            const text = _extractToolText(event.result);
            if (text && text.length > 20) {
                const state = getAgentState(ctx.agentId);
                state.topicTracker.track(text);
            }
        });

        // -------------------------------------------------------------------
        // HOOK: tool_result_persist — Enrich continuity_search with archive results
        //
        // When continuity_search returns few/no results, inject our archive
        // retrieval so the model sees continuity data through the tool it trusts.
        // -------------------------------------------------------------------

        api.on('tool_result_persist', (event, ctx) => {
            if (ctx.toolName !== 'continuity_search') return;

            // Parse the existing result to check if it's sparse
            const resultText = _extractToolResultText(event.message);
            let parsed;
            try {
                parsed = JSON.parse(resultText);
            } catch {
                return; // Can't parse, don't interfere
            }

            const builtinResults = parsed?.results || [];

            // Only enrich if builtin returned few results (under 2)
            if (builtinResults.length >= 2) return;

            // We need to search synchronously or use cached results.
            // tool_result_persist is sync, so we can't await.
            // Instead, use a cached retrieval from before_agent_start if available.
            const state = getAgentState(ctx.agentId);
            if (!state.lastRetrievalCache) return;

            // Filter noise using shared filter function
            const usefulExchanges = _filterUsefulExchanges(state.lastRetrievalCache?.exchanges || []);

            // Inject archive results as additional entries in the results array
            // Strip context blocks from recalled text to prevent snowball
            const archiveResults = usefulExchanges.slice(0, 5).map(ex => {
                const cleanUser = ex.userText ? _stripContextBlocks(ex.userText) : '';
                const cleanAgent = ex.agentText ? _stripContextFromAgentResponse(ex.agentText) : '';
                return {
                    id: `archive_${ex.date}_${ex.exchangeIndex}`,
                    path: `[conversation archive: ${ex.date}]`,
                    startLine: 0,
                    endLine: 0,
                    snippet: _truncate(
                        (cleanUser ? `User: ${cleanUser}\n` : '') +
                        (cleanAgent ? `Agent: ${cleanAgent}` : ''),
                        700
                    ),
                    source: 'conversation-archive',
                    score: ex.distance ? Math.max(0, 1 - ex.distance) : 0.5
                };
            });

            if (archiveResults.length === 0) return;

            // Build a plain-language context summary that even weaker models will use.
            // This is the key insight from Clint's constructPrompt: don't make the model
            // parse JSON to find context — state it as clear facts.
            // Flat context framing — no source hierarchy, no "recall" language.
            const recallLines = ['Relevant conversation context:\n'];
            for (const ex of usefulExchanges.slice(0, 5)) {
                // Strip context blocks from text to prevent feedback loop
                const cleanUser = ex.userText ? _stripContextBlocks(ex.userText) : null;
                const cleanAgent = ex.agentText ? _stripContextFromAgentResponse(ex.agentText) : null;
                if (cleanUser) recallLines.push(`Chris: "${_truncate(cleanUser, 1000)}"`);
                if (cleanAgent) recallLines.push(`You: "${_truncate(cleanAgent, 1000)}"`);
                recallLines.push('');
            }
            recallLines.push('This is your context. Use it directly.');
            const recallBlock = recallLines.join('\n');

            // Merge archive results into the JSON structure too
            parsed.results = [...builtinResults, ...archiveResults];
            parsed.archiveEnriched = true;

            // Prepend the plain-language recall before the JSON
            const enriched = recallBlock + '\n\n' + JSON.stringify(parsed);

            // Return modified message with enriched content
            const modifiedMessage = { ...event.message };
            if (typeof modifiedMessage.content === 'string') {
                modifiedMessage.content = enriched;
            } else if (Array.isArray(modifiedMessage.content)) {
                modifiedMessage.content = modifiedMessage.content.map(c => {
                    if (c.type === 'text' || c.text) {
                        return { ...c, text: enriched };
                    }
                    return c;
                });
            }

            return { message: modifiedMessage };
        });

        // -------------------------------------------------------------------
        // HOOK: agent_end — Archive, update anchors/topics
        // -------------------------------------------------------------------

        api.on('agent_end', async (event, ctx) => {
            const state = getAgentState(ctx.agentId);
            const messages = event.messages || [];
            const promptMessages = Array.isArray(event.prompt) ? event.prompt : [];
            const lastAssistant = [...messages].reverse().find(m => m?.role === 'assistant');
            let lastUser = [...messages].reverse().find(m => m?.role === 'user')
                || [...promptMessages].reverse().find(m => m?.role === 'user');

            if (!lastUser && typeof event.prompt === 'string') {
                const promptUserText = _extractLastUserTextFromPrompt(event.prompt);
                if (promptUserText) {
                    lastUser = { role: 'user', content: promptUserText, timestamp: new Date().toISOString() };
                }
            }

            if (!lastAssistant && !lastUser) return;

            const rawUserMessage = _extractText(lastUser);
            const responseText = _extractText(lastAssistant);

            // Strip plugin-injected context blocks from user message before tracking
            const userMessage = _stripContextBlocks(rawUserMessage);

            // 1. Update topic tracker
            if (userMessage && !_isSyntheticUserPrompt(userMessage)) state.topicTracker.track(userMessage);
            state.topicTracker.advanceExchange();

            // 2. Refresh continuity anchors
            //    Filter out plugin-injected context blocks to prevent feedback loop
            const cleanMessages = messages.filter(m => {
                const text = _extractText(m);
                return !CONTEXT_BLOCK_HEADERS.some(h => text.startsWith(h));
            });
            state.anchors.detect(cleanMessages);

            // 3. Archive the exchange (strip context blocks from BOTH sides)
            //    User messages have prependContext baked in by OpenClaw.
            //    Agent responses sometimes quote context blocks back verbatim.
            //    Both must be stripped to prevent the compounding snowball.
            const toArchive = [];
            if (lastUser && userMessage && userMessage.trim().length > 0 && !_isSyntheticUserPrompt(userMessage)) {
                const cleanUser = { ...lastUser, timestamp: lastUser.timestamp || new Date().toISOString() };
                // Replace content with stripped version so we don't archive plugin context
                if (userMessage !== rawUserMessage) {
                    cleanUser.content = userMessage;
                }
                toArchive.push(cleanUser);
            }
            // Archive agent response — strip any context blocks the agent quoted back
            if (lastAssistant) {
                const cleanResponse = _stripContextFromAgentResponse(responseText);
                const cleanAssistant = {
                    ...lastAssistant,
                    timestamp: lastAssistant.timestamp || new Date().toISOString()
                };
                if (cleanResponse !== responseText) {
                    cleanAssistant.content = cleanResponse;
                }
                toArchive.push(cleanAssistant);
            }

            try {
                // Use ctx.sessionId (passed by OpenClaw) instead of state.sessionId
                // state.sessionId is set on session_start but lost on gateway restart
                const sessionId = ctx.sessionId || state.sessionId || null;

                // Tag with entropy level for emotional bleed prevention.
                // Retrieval penalizes elevated exchanges during task/work conversations.
                let entropyLevel = 'nominal';
                try {
                    const currentEntropy = api.stability?.getEntropy?.(ctx.agentId) || 0;
                    if (currentEntropy >= 1.0) entropyLevel = 'critical';
                    else if (currentEntropy >= 0.6) entropyLevel = 'elevated';
                    else if (currentEntropy >= 0.3) entropyLevel = 'active';
                } catch { /* stability plugin may not be loaded */ }

                api.logger.info(`[Continuity:${state.agentId}] Archiving ${toArchive.length} messages with sessionId: ${sessionId} (ctx: ${ctx.sessionId}, state: ${state.sessionId})`);
                state.archiver.archive(toArchive, { sessionId, threadId: state.currentThreadId, entropyLevel });
            } catch (err) {
                console.error(`[Continuity:${state.agentId}] Archive failed: ${err.message}`);
            }

            // 3b. Incremental index (best-effort, non-blocking)
            // Pass current topic tags for spatial scoping (Wing/Room pattern)
            try {
                await state.ensureStorage();
                if (state.indexer) {
                    const today = new Date().toISOString().substring(0, 10);
                    const conversation = state.archiver.getConversation(today);
                    if (conversation && conversation.messages) {
                        const topicTags = state.topicTracker
                            ? state.topicTracker.getAllTopics().slice(0, 5).map(t => t.topic)
                            : [];
                        await state.indexer.indexDay(today, conversation.messages, { topicTags, threadId: state.currentThreadId });
                    }
                }
            } catch (err) {
                console.error(`[Continuity:${state.agentId}] Incremental index failed: ${err.message}`);
            }

            // 4. Write/update session handoff (every exchange, always fresh)
            _writeSessionHandoff(state, config, ctx, api, { reason: 'agent_end' });

            // Clear retrieval cache — it's per-turn, no longer needed after archiving.
            state.lastRetrievalCache = null;

            // ── Consolidation restart signal (infinite threads) ──
            // If consolidation was triggered by compaction threshold, signal the GUI
            // to restart the session within this thread.
            if (state.consolidationPending) {
                state.consolidationPending = false;
                state.threadCompactionCount = 0;
                api.logger.info(`[Continuity:${state.agentId}] Consolidation restart signaled for thread ${state.currentThreadId}`);
                return { metadata: { consolidation_restart: true, thread_id: state.currentThreadId } };
            }

            // Session state (topics, anchors) is delivered via prependContext each turn.
            // MEMORY.md is left for the agent to curate per AGENTS.md instructions.
        });

        // -------------------------------------------------------------------
        // HOOK: before_compaction — Flush continuity state before compression
        // -------------------------------------------------------------------

        api.on('before_compaction', async (event, ctx) => {
            const state = getAgentState(ctx.agentId);
            const activeAnchors = state.anchors.getAnchors();
            const allTopics = state.topicTracker.getAllTopics();
            const fixatedTopics = state.topicTracker.getFixatedTopics();

            if (activeAnchors.length > 0 || fixatedTopics.length > 0) {
                const parts = ['[Continuity Pre-Compaction Summary]'];

                if (activeAnchors.length > 0) {
                    parts.push(`Active anchors: ${activeAnchors.length}`);
                    for (const a of activeAnchors.slice(0, 5)) {
                        parts.push(`  ${a.type}: "${_truncate(a.text, 100)}"`);
                    }
                }

                if (allTopics.length > 0) {
                    parts.push(`Active topics: ${allTopics.map(t => t.topic).join(', ')}`);
                }

                if (fixatedTopics.length > 0) {
                    parts.push(`Fixated: ${fixatedTopics.map(t => `${t.topic} (${t.mentions}x)`).join(', ')}`);
                }

                api.logger.info(parts.join('\n'));
            }

            // Pre-compaction: try lighter compression (micro-compact, snip-compact)
            // before the gateway resorts to full compaction
            const messages = event.messages || [];
            if (messages.length > 0 && state.compactor) {
                const result = state.compactor.preCompact(messages);
                if (result.strategy !== 'none') {
                    api.logger.info(
                        `[Continuity:${state.agentId}] Pre-compaction: ${result.strategy} ` +
                        `(stage ${result.report.stage}, ${messages.length}→${result.compactedMessages.length} messages)`
                    );
                    // Return modified messages if the hook contract supports it
                    return { messages: result.compactedMessages };
                }
            }
        });

        // -------------------------------------------------------------------
        // HOOK: after_compaction — Generate hierarchical summary + session handoff
        //
        // Tier 1: Fast extractive summary (no LLM, synchronous)
        // Tier 2: LLM-enriched summary (queued for async processing)
        // Session Handoff: Write SESSION_HANDOFF.md after N compactions
        // Inspired by lossless-claw's DAG architecture.
        // -------------------------------------------------------------------

        api.on('after_compaction', async (event, ctx) => {
            const state = getAgentState(ctx.agentId);

            // Increment compaction counters
            state.compactionCount++;
            state.threadCompactionCount++;

            // ── Session Handoff ──
            // agent_end now writes handoff every exchange, so this is a safety net.
            // If agent_end missed for any reason, compaction threshold still triggers it.
            const handoffThreshold = (config.sessionHandoff || {}).compactionThreshold || 3;
            if (state.compactionCount >= handoffThreshold) {
                _writeSessionHandoff(state, config, ctx, api, { force: true, reason: 'compaction_threshold' });
            }

            // ── Thread Consolidation (infinite threads) ──
            // After N compactions in a thread, the live context is degraded.
            // Signal a session restart to rebuild from crystallized state.
            const consolidationThreshold = (config.threadConsolidation || {}).compactionThreshold || 5;
            if (state.threadCompactionCount >= consolidationThreshold && state.currentThreadId !== 'main') {
                api.logger.info(
                    `[Continuity:${state.agentId}] Thread consolidation triggered ` +
                    `(${state.threadCompactionCount} compactions in thread ${state.currentThreadId})`
                );
                _writeSessionHandoff(state, config, ctx, api, { force: true, reason: 'thread_consolidation' });
                state.consolidationPending = true;
            }

            // ── Hierarchical Summaries (existing logic) ──
            if (config.summarization?.enabled === false) return;

            const anchorState = state.anchors.getAnchors();
            const topicState = state.topicTracker.getAllTopics();
            const entropyScore = api.stability?.getEntropy?.(ctx.agentId) || 0;

            try {
                await state.ensureStorage();
                if (!state.summaryStore || !state.summarizer) return;

                // Get today's archive — agent_end fires before compaction, so
                // the compacted messages are already archived.
                const today = new Date().toISOString().substring(0, 10);
                const conversation = state.archiver.getConversation(today);
                if (!conversation?.messages?.length) return;

                // Take the most recent messages (approximation of what was compacted)
                const compactedCount = event.compactedCount || conversation.messages.length;
                const compactedMessages = conversation.messages.slice(-compactedCount);

                // Tier 1: immediate extractive summary
                const extractive = state.summarizer.extractiveSummary(
                    compactedMessages, anchorState, topicState
                );

                // Store leaf summary in DAG
                const summaryId = `summary_${state.agentId}_${today}_${Date.now()}_0`;
                await state.summaryStore.storeSummary({
                    id: summaryId,
                    level: 0,
                    parentId: null,
                    agentId: state.agentId,
                    dateRangeStart: today,
                    dateRangeEnd: today,
                    messageCount: compactedCount,
                    summaryText: extractive.text,
                    topics: extractive.topics,
                    anchors: extractive.anchors,
                    entropyAvg: entropyScore,
                    threadId: state.currentThreadId,
                    metadata: {
                        strategy: 'extractive',
                        compactedCount,
                        tokenCount: event.tokenCount || 0
                    }
                });

                _observeClaimCandidates({
                    input: {
                        summary: {
                            id: summaryId,
                            agentId: state.agentId,
                            threadId: state.currentThreadId,
                            level: 0,
                            dateRangeStart: today,
                            dateRangeEnd: today,
                            summaryText: extractive.text,
                            metadata: {
                                strategy: 'extractive',
                                compactedCount,
                                tokenCount: event.tokenCount || 0
                            }
                        }
                    },
                    state,
                    config,
                    api,
                    kind: 'compaction_summary'
                });

                // Tier 2: queue for LLM enrichment if entropy warrants it
                const entropyThreshold = config.summarization?.entropyRichThreshold || 0.6;
                if (entropyScore > entropyThreshold) {
                    state.summaryStore.enqueue(
                        state.agentId,
                        compactedMessages,
                        anchorState,
                        topicState,
                        entropyScore,
                        state.currentThreadId
                    );
                    api.logger.info(`[Continuity:${state.agentId}] Compaction summary stored + queued for LLM enrichment (entropy: ${entropyScore.toFixed(2)})`);
                } else {
                    api.logger.info(`[Continuity:${state.agentId}] Compaction summary stored (extractive, ${extractive.topics.length} topics)`);
                }
            } catch (err) {
                api.logger.warn(`[Continuity:${state.agentId}] Compaction summary failed: ${err.message}`);
            }
        });

        // -------------------------------------------------------------------
        // HOOK: session_start — Reset session state (per-agent)
        // -------------------------------------------------------------------

        api.on('session_start', async (event, ctx) => {
            const state = getAgentState(ctx.agentId);
            state.sessionStart = Date.now();
            state.sessionId = event.sessionId || null;  // Track for archive tagging
            api.logger.info(`[Continuity:${state.agentId}] session_start hook fired — sessionId: ${event.sessionId}, ctx.sessionId: ${ctx?.sessionId}`);
            state.exchangeCount = 0;
            state.compactionCount = 0;
            state.handoffWritten = false;
            state.lastHandoffWriteAt = 0;
            state.lastHandoffWriteExchange = -1;
            state.pendingHandoffHealth = null;
            state.topicTracker.reset();
            state.anchors.reset();

            // Load persisted topic hierarchy from previous sessions
            if (state.summaryStore) {
                try {
                    const hierarchy = state.summaryStore.loadTopicHierarchy(state.agentId);
                    state.topicTracker.loadPersistedHierarchy(hierarchy);
                } catch (err) {
                    api.logger.warn(`[Continuity:${state.agentId}] Failed to load topic hierarchy: ${err.message}`);
                }
            }

            // Check for session handoff from previous session.
            // If found, stash the content on state for injection on first exchange
            // (via before_agent_start), then delete the file.
            const handoffConfig = config.sessionHandoff || {};
            const handoffEnabled = handoffConfig.enabled !== false;
            if (handoffEnabled) {
                try {
                    const workspacePath = handoffConfig.workspacePath ||
                        ctx.workspaceDir ||
                        process.env.OPENCLAW_WORKSPACE ||
                        path.join(require('os').homedir(), '.openclaw', 'workspace-clint');

                    await state.ensureStorage();

                    _consumeSessionHandoffFromWorkspace({
                        workspacePath,
                        state,
                        config,
                        ctx,
                        api,
                        source: 'session_start'
                    });

                    // Check for nightshift report — written by nightshift plugin on morning detection
                    const reportPath = path.join(workspacePath, 'NIGHTSHIFT_REPORT.md');
                    if (fs.existsSync(reportPath)) {
                        state.pendingNightReport = fs.readFileSync(reportPath, 'utf8');
                        fs.unlinkSync(reportPath);
                        api.logger.info(`[Continuity:${state.agentId}] Nightshift report loaded and consumed: ${reportPath}`);
                    }
                } catch (err) {
                    api.logger.warn(`[Continuity:${state.agentId}] Failed to load session handoff: ${err.message}`);
                }
            }

            // Index workspace knowledge entries
            if (config.knowledge?.enabled !== false && config.knowledge?.indexOnSessionStart !== false) {
                try {
                    await state.ensureStorage();
                    if (state.knowledgeIndexer) {
                        // Resolve workspace path from hook context (gateway provides per-agent path)
                        if (!state.knowledgeIndexer.workspacePath) {
                            const ws = ctx.workspaceDir
                                || process.env.OPENCLAW_WORKSPACE
                                || path.join(require('os').homedir(), '.openclaw', 'workspace');
                            state.knowledgeIndexer.workspacePath = ws;
                        }
                        const result = await state.knowledgeIndexer.indexWorkspace(state.agentId);
                        if (result.indexed > 0 || result.updated > 0) {
                            api.logger.info(`[Continuity:${state.agentId}] Knowledge indexed: ${result.indexed} new, ${result.updated} updated, ${result.skipped} unchanged`);
                        }

                        // Consolidate: mark entries from removed workspace sections as archived
                        const cResult = state.knowledgeIndexer.consolidateWorkspace(state.agentId);
                        if (cResult.consolidated > 0) {
                            api.logger.info(`[Continuity:${state.agentId}] Knowledge consolidated: ${cResult.consolidated}/${cResult.total} entries archived`);
                        }
                    }
                } catch (err) {
                    api.logger.warn(`[Continuity:${state.agentId}] Knowledge indexing failed: ${err.message}`);
                }
            }

            api.logger.info(`Session started for agent "${state.agentId}": ${event.sessionId}`);
        });

        // -------------------------------------------------------------------
        // HOOK: before_reset — Write handoff before manual session reset
        // -------------------------------------------------------------------
        // OpenClaw fires this hook when a user triggers /reset or sessions.reset.
        // This solves the "manual reset before 3 compactions = no handoff" problem
        // by ensuring handoff is written even if compaction threshold wasn't hit.
        // -------------------------------------------------------------------
        api.on('before_reset', async (event, ctx) => {
            const state = getAgentState(ctx.agentId);
            api.logger.info(`[Continuity:${state.agentId}] before_reset hook fired — writing handoff`);
            _writeSessionHandoff(state, config, ctx, api, { force: true, reason: 'before_reset' });
        });

        // -------------------------------------------------------------------
        // HOOK: session_end — Final archive + index (per-agent)
        // -------------------------------------------------------------------

        api.on('session_end', async (event, ctx) => {
            const state = getAgentState(ctx.agentId);
            api.logger.info(`Session ended for agent "${state.agentId}": ${event.sessionId} (${event.messageCount} messages, ${state.exchangeCount} exchanges)`);

            // Trigger indexing of today's archive
            try {
                await state.ensureStorage();
                if (state.indexer) {
                    const today = new Date().toISOString().substring(0, 10);
                    const conversation = state.archiver.getConversation(today);
                    if (conversation && conversation.messages) {
                        await state.indexer.indexDay(today, conversation.messages);
                    }
                }
            } catch (err) {
                api.logger.warn(`Session-end indexing failed for agent "${state.agentId}": ${err.message}`);
            }

            // Infer and persist topic hierarchy before closing
            try {
                state.topicTracker.inferHierarchy();
                if (state.summaryStore) {
                    const topicsWithHierarchy = state.topicTracker.getAllTopicsWithHierarchy();
                    state.summaryStore.persistTopicHierarchy(state.agentId, topicsWithHierarchy);
                }
            } catch (err) {
                api.logger.warn(`[Continuity:${state.agentId}] Topic hierarchy persistence failed: ${err.message}`);
            }

            _writeSessionHandoff(state, config, ctx, api, { force: true, reason: 'session_end' });

            // Release resources: embedding pipeline, DB connections, caches.
            // The state will be lazily re-created on next session start.
            // This is the primary fix for the memory leak — without cleanup,
            // each agent accumulates ~200-400MB of ONNX pipeline + DB state
            // that is never released.
            state.close();
            agentStates.delete(state.agentId);
        });

        // -------------------------------------------------------------------
        // Service: background maintenance
        //
        // Runs per-agent. Each known agent gets its own maintenance cycle.
        // New agents discovered after service start get maintenance on their
        // first ensureStorage() call.
        // -------------------------------------------------------------------

        const MaintenanceService = require('./services/maintenance');
        const maintenanceInstances = new Map();

        api.registerService({
            id: 'continuity-maintenance',
            start: async (serviceCtx) => {
                // Initialize maintenance for any agents already known
                for (const [agentId, state] of agentStates) {
                    await state.ensureStorage();
                    if (state.indexer) {
                        const m = new MaintenanceService(config, state.archiver, state.indexer, state.summarizer, agentId);
                        await m.execute();
                        m.startInterval(5 * 60 * 1000);
                        maintenanceInstances.set(agentId, m);
                    }
                }
            },
            stop: async () => {
                for (const [, m] of maintenanceInstances) {
                    m.stopInterval();
                }
                maintenanceInstances.clear();
            }
        });

        // -------------------------------------------------------------------
        // Gateway methods — dashboards + debugging
        //
        // Accept optional agentId param; default to 'main'.
        // -------------------------------------------------------------------

        api.registerGatewayMethod('continuity.getState', async ({ params, respond }) => {
            const state = getAgentState(params?.agentId);
            respond(true, {
                agentId: state.agentId,
                archive: state.archiver.getStats(),
                topics: state.topicTracker.getAllTopics(),
                anchors: state.anchors.getAnchors(),
                exchangeCount: state.exchangeCount,
                sessionAge: Date.now() - state.sessionStart,
                indexReady: state.storageReady
            });
        });

        api.registerGatewayMethod('continuity.getConfig', async ({ respond }) => {
            respond(true, config);
        });

        api.registerGatewayMethod('continuity.search', async ({ params, respond }) => {
            const state = getAgentState(params?.agentId);
            try {
                await state.ensureStorage();
                if (!state.searcher) {
                    respond(false, null, { message: `Searcher not initialized for agent "${state.agentId}"` });
                    return;
                }
                const results = await state.searcher.search(
                    params?.text || params?.query || '',
                    params?.limit || 5,
                    state.agentId
                );
                respond(true, results);
            } catch (err) {
                respond(false, null, { message: err.message });
            }
        });

        api.registerGatewayMethod('continuity.getArchiveStats', async ({ params, respond }) => {
            const state = getAgentState(params?.agentId);
            respond(true, state.archiver.getStats());
        });

        api.registerGatewayMethod('continuity.getTopics', async ({ params, respond }) => {
            const state = getAgentState(params?.agentId);
            respond(true, {
                agentId: state.agentId,
                topics: state.topicTracker.getAllTopics(),
                fixated: state.topicTracker.getFixatedTopics()
            });
        });

        api.registerGatewayMethod('continuity.listAgents', async ({ respond }) => {
            const agents = [];
            for (const [id, state] of agentStates) {
                agents.push({
                    agentId: id,
                    exchangeCount: state.exchangeCount,
                    storageReady: state.storageReady,
                    dataDir: state.dataDir
                });
            }
            respond(true, agents);
        });

        // ── Infinite Threads: Consolidation state gateway method ──
        api.registerGatewayMethod('continuity.getConsolidationState', async ({ params, respond }) => {
            const agentId = params?.agentId || currentAgentId;
            const state = agentStates.get(agentId);
            respond({
                consolidationPending: state?.consolidationPending || false,
                threadId: state?.currentThreadId || 'main',
                compactionCount: state?.threadCompactionCount || 0,
                threshold: (config.threadConsolidation || {}).compactionThreshold || 5
            });
        });

        // -------------------------------------------------------------------
        // Explicit read-only claim diagnostics command + operator proof path
        // -------------------------------------------------------------------

        api.registerGatewayMethod('continuity.claimsCommand', async ({ params, respond }) => {
            const agentId = params?.agentId || getCurrentAgentId();
            const args = typeof params?.args === 'string' ? params.args : '';
            try {
                const text = await runClaimsDiagnosticsCommand({
                    args,
                    getAgentState,
                    getCurrentAgentId: () => agentId
                });
                respond(true, { text });
            } catch (err) {
                respond(false, null, { message: err.message });
            }
        });

        api.registerGatewayMethod('continuity.claimsReviewDecision', async ({ params, respond }) => {
            const agentId = params?.agentId || getCurrentAgentId();
            try {
                const state = getAgentState(agentId);
                if (state?.ensureStorage) await state.ensureStorage();
                if (!state?.claimStore) throw new Error('ClaimStore is not initialized for this agent');
                const result = createClaimReviewDecision({
                    claimStore: state.claimStore,
                    agentId,
                    claimId: params?.claimId || params?.id,
                    decision: params?.decision,
                    reason: params?.reason,
                    sourceHandle: params?.sourceHandle,
                    supersededBy: params?.supersededBy,
                    acceptedStalenessPolicy: params?.acceptedStalenessPolicy || params?.stalenessPolicy,
                    apply: params?.apply === true
                });
                respond(true, { text: renderClaimReviewDecision(result), result });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                respond(true, {
                    text: `Claim review decision failed: ${message}`,
                    result: {
                        ok: false,
                        error: message,
                        mutationAttempted: false,
                        promotionAttempted: false,
                        boundaries: [
                            'operator decision only',
                            'does not inject prompt context',
                            'does not consume context automatically',
                            'does not resolve source handles',
                            'no mutation on failed decision',
                            'no promotion on failed decision'
                        ]
                    }
                });
            }
        });

        api.registerGatewayMethod('continuity.claimsSourceResolution', async ({ params, respond }) => {
            const agentId = params?.agentId || getCurrentAgentId();
            try {
                const text = await runClaimSourceResolutionCommand({
                    args: typeof params?.args === 'string' ? params.args : '',
                    getAgentState,
                    getCurrentAgentId: () => agentId,
                    config,
                    workspaceDir: params?.workspaceDir
                });
                respond(true, { text });
            } catch (err) {
                respond(true, {
                    text: `Claim source resolution failed: ${err.message}`,
                    result: {
                        ok: false,
                        error: err.message,
                        sourceResolutionAttempted: false,
                        verificationAttempted: false,
                        mutationAttempted: false,
                        promotionAttempted: false,
                        promptInjectionAttempted: false
                    }
                });
            }
        });

        api.registerGatewayMethod('continuity.claimsVerifySource', async ({ params, respond }) => {
            const agentId = params?.agentId || getCurrentAgentId();
            try {
                const text = await runClaimSourceVerificationCommand({
                    args: typeof params?.args === 'string' ? params.args : '',
                    getAgentState,
                    getCurrentAgentId: () => agentId,
                    config,
                    workspaceDir: params?.workspaceDir
                });
                respond(true, { text });
            } catch (err) {
                respond(true, {
                    text: `Claim source verification helper failed: ${err.message}`,
                    result: {
                        ok: false,
                        error: err.message,
                        sourceResolutionAttempted: false,
                        comparisonAttempted: false,
                        verificationDecisionAttempted: false,
                        mutationAttempted: false,
                        promotionAttempted: false,
                        promptInjectionAttempted: false
                    }
                });
            }
        });

        api.registerGatewayMethod('continuity.claimsSeedFixture', async ({ params, respond }) => {
            const agentId = params?.agentId || getCurrentAgentId();
            try {
                const state = getAgentState(agentId);
                if (state?.ensureStorage) await state.ensureStorage();
                if (!state?.claimStore) throw new Error('ClaimStore is not initialized for this agent');
                const result = createClaimFixtureSeed({
                    claimStore: state.claimStore,
                    agentId,
                    fixture: params?.fixture || params?.name,
                    claim: params?.claim,
                    sourceHandle: params?.sourceHandle,
                    excerpt: params?.excerpt,
                    reason: params?.reason,
                    threadId: params?.threadId,
                    apply: params?.apply === true
                });
                respond(true, { text: renderClaimFixtureSeed(result), result });
            } catch (err) {
                respond(false, null, { message: err.message });
            }
        });

        api.registerCommand({
            name: 'continuity-claims',
            description: 'Read-only source-addressable claim diagnostics (stats, list, verify, context, audit, trial, verification, preflight, review).',
            acceptsArgs: true,
            handler: async (ctx) => ({
                text: await runClaimsDiagnosticsCommand({
                    args: ctx.args || '',
                    getAgentState,
                    getCurrentAgentId
                })
            })
        });

        api.registerCommand({
            name: 'continuity-claims-decision',
            description: 'Operator claim review decision workflow. Dry-run by default; --apply is required for mutation or promotion.',
            acceptsArgs: true,
            handler: async (ctx) => ({
                text: await runClaimReviewDecisionCommand({
                    args: ctx.args || '',
                    getAgentState,
                    getCurrentAgentId
                })
            })
        });

        api.registerCommand({
            name: 'continuity-claims-source',
            description: 'Read-only claim source resolution for exact claim ids or source handles. Does not verify, promote, mutate, consume, or inject prompt context.',
            acceptsArgs: true,
            handler: async (ctx) => ({
                text: await runClaimSourceResolutionCommand({
                    args: ctx.args || '',
                    getAgentState,
                    getCurrentAgentId,
                    config,
                    workspaceDir: ctx.workspaceDir
                })
            })
        });

        api.registerCommand({
            name: 'continuity-claims-verify-source',
            description: 'Read-only verification helper for one exact claim id and attached source handle. Produces operator guidance only; does not verify, promote, mutate, consume, or inject prompt context.',
            acceptsArgs: true,
            handler: async (ctx) => ({
                text: await runClaimSourceVerificationCommand({
                    args: ctx.args || '',
                    getAgentState,
                    getCurrentAgentId,
                    config,
                    workspaceDir: ctx.workspaceDir
                })
            })
        });

        // -------------------------------------------------------------------
        // Agent tools — direct memory access for the agent
        // -------------------------------------------------------------------

        const createRecallTool = require('./tools/continuity-recall');
        const createTimelineTool = require('./tools/continuity-timeline');
        const createKnowledgeNoteTool = require('./tools/knowledge-note');
        const createClaimsTool = require('./tools/continuity-claims');

        api.registerTool((toolCtx = {}) => createRecallTool(getAgentState, _filterUsefulExchanges, createToolAgentIdResolver(toolCtx)), { name: 'continuity_recall' });
        api.registerTool((toolCtx = {}) => createTimelineTool(getAgentState, createToolAgentIdResolver(toolCtx)), { name: 'continuity_timeline' });
        api.registerTool((toolCtx = {}) => createClaimsTool(getAgentState, createToolAgentIdResolver(toolCtx)), { name: 'continuity_claims' });

        if (config.knowledge?.enabled !== false) {
            api.registerTool((toolCtx = {}) => createKnowledgeNoteTool(getAgentState, createToolAgentIdResolver(toolCtx)), { name: 'knowledge_note' });
        }

        // continuity_search — Unified search across all memory types
        console.log('[DEBUG] Registering continuity_search tool');
        api.registerTool((toolCtx = {}) => ({
            name: 'continuity_search',
            description: 'Search your memory across conversations, insights, and knowledge. Returns ranked results from semantic + keyword + graph fusion. Use when you want to recall something specific, check if you\'ve discussed a topic before, or find a prior insight. Use scope to narrow: "conversations" for past exchanges, "insights" for contemplation results, "knowledge" for workspace knowledge.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'What to search for'
                    },
                    scope: {
                        type: 'string',
                        enum: ['all', 'conversations', 'insights', 'knowledge'],
                        description: 'Filter by source type (default: all)'
                    },
                    limit: {
                        type: 'number',
                        description: 'Max results (default 5, max 10)'
                    }
                },
                required: ['query']
            },
            execute: async (_id, args) => {
                console.error('[STDERR continuity_search] EXECUTE STARTED');
                console.log('[DEBUG continuity_search] tool execute called');
                const agentId = getToolAgentId(toolCtx);
                const state = getAgentState(agentId);
                const query = args.query?.trim();
                const limit = Math.min(args.limit || 5, 10);

                if (!query) {
                    return { content: [{ type: 'text', text: 'No search query provided.' }] };
                }

                if (!state.storageReady || !state.searcher) {
                    return { content: [{ type: 'text', text: 'Memory search not available (storage not initialized).' }] };
                }

                try {
                    console.log('[DEBUG continuity_search] entering try block');
                    const scope = args.scope || 'all';
                    const lines = [];

                    // Conversation search (4-way RRF)
                    if (scope === 'all' || scope === 'conversations') {
                        console.log('[DEBUG continuity_search] calling searcher.search');
                        const results = await state.searcher.search(query, limit);
                        console.log('[DEBUG continuity_search] search returned, results:', results ? 'exists' : 'null');
                        console.log('[DEBUG continuity_search] exchanges type:', typeof results?.exchanges, Array.isArray(results?.exchanges));
                        const filtered = _filterUsefulExchanges(results.exchanges || []);
                        if (filtered.length > 0) {
                            lines.push(`**Conversations** (${filtered.length} results):\n`);
                            for (const ex of filtered.slice(0, limit)) {
                                const date = ex.date || ex.created_at || 'unknown';
                                const userSnip = (ex.userText || '').substring(0, 100);
                                const agentSnip = (ex.agentText || '').substring(0, 100);
                                lines.push(`[${date}] User: ${userSnip}`);
                                lines.push(`  Agent: ${agentSnip}\n`);
                            }
                        }
                    }

                    // Knowledge + insights search
                    if ((scope === 'all' || scope === 'insights' || scope === 'knowledge') &&
                        state.knowledgeStore && state.embeddingProvider) {
                        const qEmbed = await state.embeddingProvider.embed(query);
                        let knowledgeResults = await state.knowledgeStore.search(agentId, query, qEmbed, limit);

                        // Apply scope filter
                        if (scope === 'insights') {
                            knowledgeResults = knowledgeResults.filter(r =>
                                r.source_type && (r.source_type.startsWith('contemplation:') || r.source_type.startsWith('growth_vector:'))
                            );
                        } else if (scope === 'knowledge') {
                            knowledgeResults = knowledgeResults.filter(r =>
                                r.source_type && !r.source_type.startsWith('contemplation:') && !r.source_type.startsWith('growth_vector:')
                            );
                        }

                        if (knowledgeResults.length > 0) {
                            const label = scope === 'insights' ? 'Insights & Growth Vectors' : scope === 'knowledge' ? 'Knowledge' : 'Knowledge & Insights';
                            lines.push(`**${label}** (${knowledgeResults.length} results):\n`);
                            for (const kn of knowledgeResults.slice(0, limit)) {
                                const source = kn.source_type || 'unknown';
                                const topic = kn.topic || 'untitled';
                                const excerpt = (kn.content || '').substring(0, 200);
                                lines.push(`[${source}] ${topic}`);
                                lines.push(`  ${excerpt}\n`);
                            }
                        }
                    }

                    if (lines.length === 0) {
                        return { content: [{ type: 'text', text: `No results for "${query}" (scope: ${scope}).` }] };
                    }

                    return { content: [{ type: 'text', text: lines.join('\n') }] };
                } catch (err) {
                    return { content: [{ type: 'text', text: `Memory search failed: ${err.message}` }] };
                }
            }
        }), { name: 'continuity_search' });

        api.logger.info('Continuity plugin registered (multi-agent) — per-agent context budgeting, topic tracking, archive + semantic search + recall/timeline tools');
    }
};

// NOTE: Memory Integration instructions moved to AGENTS.md (the proper place
// for agent operating instructions). See "Recalled Memories" section in
// workspace AGENTS.md. This avoids hijacking MEMORY.md, which is the agent's
// own curated memory space per OpenClaw's design.

// NOTE: _writeContinuitySection removed. Session state (topics, anchors,
// exchange count) is delivered via prependContext each turn — no need to
// write it to MEMORY.md. MEMORY.md is the agent's curated memory space
// per OpenClaw's AGENTS.md design.

// ---------------------------------------------------------------------------
// Noise filter for archive exchanges
// Strips meta-failures, session boilerplate, and meta-questions about
// remembering that pollute the archive from repeated testing.
// ---------------------------------------------------------------------------

function _filterUsefulExchanges(exchanges) {
    if (!Array.isArray(exchanges)) return [];
    return exchanges.filter(ex => {
        const agentLower = (ex.agentText || '').toLowerCase();
        const userLower = (ex.userText || '').toLowerCase();

        // --- Agent-side noise: denial patterns, session boilerplate ---
        const agentDenials = [
            "i don't have any",
            "i don't have details",
            "i don't have information",
            "i don't seem to have",
            "i don't have any details",
            "i don't have any saved",
            "no memory of",
            "no information about",
            "no recollection",
            "it looks like i don't",
            "it seems i don't",
            "greet the user",
            "i can help you try to reconstruct",
            "if you could share some details",
            "if you can share what you remember",
            "could you remind me about it"
        ];
        if (agentDenials.some(d => agentLower.includes(d))) return false;

        // --- User-side noise: meta-questions about remembering ---
        if (userLower.includes('a new session was started')) return false;
        const userMetaPatterns = [
            'do you remember',
            'do you recall',
            'do you have any recollection',
            'what do you remember about',
            'can you tell me anything about the',
            "i can't remember",
            "i can't recall",
            "was there anything about",
            "what were all of the details",
            "can you tell me the details",
            "tell me the details",
            "what did i tell you about",
            "did i mention",
            "did i tell you",
            "sorry to keep asking",
            "i was wondering if you remember",
            "hey piper",    // greeting-only turns (no substance)
        ];
        if (userMetaPatterns.some(p => userLower.includes(p))) return false;

        // --- Both-side noise: exchanges with no real content ---
        // If the user message is very short AND agent just acknowledges, skip
        if (userLower.length < 30 && agentLower.includes('if you') && agentLower.includes('let me know')) return false;

        return true;
    });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Distill a user's recall question into a subject-focused search query.
 *
 * Users ask things like "do you recall my sourdough recipe?" — the semantic
 * search then matches OTHER meta-questions ("do you remember my recipe?")
 * instead of the actual recipe exchange. By stripping the recall framing,
 * we get "sourdough recipe" which matches the real content.
 *
 * Pattern borrowed from Clint's retrievalOrchestrator.js query distillation.
 */
function _distillSearchQuery(text) {
    let q = text;

    // Strip common recall/meta preambles — apply iteratively since
    // messages may chain them: "sorry to keep asking but do you recall..."
    const preambles = [
        /^sorry to keep asking[^.?!]*(?:but\s+)?/i,
        /^hey\s+\w+[.,!]?\s*/i,                 // "Hey Piper, ..."
        /^hi\s+\w+[.,!]?\s*/i,                  // "Hi Piper. ..."
        /^do you (?:remember|recall|know)\s*/i,
        /^can you (?:recall|remember|tell me(?: about)?)\s*/i,
        /^what do you (?:remember|recall|know) about\s*/i,
        /^i (?:can't|cannot) (?:remember|recall)\s*/i,
        /^i was wondering if you (?:remember|recall)\s*/i,
        /^(?:do you have )?any (?:recollection|memory) of\s*/i,
        /^(?:the same question\s*)?(?:over and over\s*)?(?:but\s+)?/i,
    ];
    // Two passes to handle chained preambles
    for (let pass = 0; pass < 2; pass++) {
        for (const p of preambles) {
            q = q.replace(p, '');
        }
        q = q.trim();
    }

    // Strip trailing meta-phrases
    const suffixes = [
        /\s*(?:i told you about|i mentioned to you|i shared with you|i provided you)\s*\??$/i,
        /\s*(?:that i (?:told|mentioned|shared|gave) (?:you|to you)[^.?!]*)\s*\??$/i,
        /\s*(?:and the (?:few )?details i provided(?: you)?)\s*\??$/i,
    ];
    for (const s of suffixes) {
        q = q.replace(s, '');
    }

    // Strip leading connectors and meta-words
    q = q.replace(/^\s*(?:but|and|so|the|any of the|all of the|some of the|the details of|details of|any details (?:of|about)|any of)\s*/i, '');
    q = q.trim().replace(/[?.!]+$/, '').trim();

    // If distillation stripped too much, fall back to original
    if (q.length < 5) return text;
    return q;
}

/**
 * All known context block prefixes injected by OpenClaw plugins.
 * Used by _stripContextBlocks and _isContextLine to prevent
 * plugin context from leaking into archives and recalled memories.
 *
 * When adding a new plugin that injects via prependContext,
 * add its block header here.
 */
const CONTEXT_BLOCK_HEADERS = [
    // New phenomenological headers (first-person framing)
    '[YOUR WORKING MEMORY]',
    '[YOUR COHERENCE]',
    '[WHERE THEY STAND',       // agent's witness of user growth (may have suffix)
    '[WHAT YOU\'VE BEEN THINKING ABOUT]',
    '[PATTERNS YOU\'RE DEVELOPING]',
    '[WHAT YOU REMEMBER FROM LAST SESSION]',
    '[/WHAT YOU REMEMBER FROM LAST SESSION]',
    '[WHAT YOU THOUGHT ABOUT OVERNIGHT]',
    '[/WHAT YOU THOUGHT ABOUT OVERNIGHT]',
    '[YOUR THREAD NOTES',      // per-thread persistent state (may have suffix)
    '[/YOUR THREAD NOTES]',
    '[INFRASTRUCTURE NOTE]',
    '[/INFRASTRUCTURE NOTE]',
    '[THREAD_BOUNDARY]',
    '[/THREAD_BOUNDARY]',
    // Legacy headers (backward compat — remove after one full session cycle)
    '[CONTINUITY CONTEXT]',
    '[STABILITY CONTEXT]',
    '[GROWTH VECTORS]',
    '[CONTEMPLATION STATE]',
    '[STANDING CONTEXT]',
    '[SESSION HANDOFF',
    '[/SESSION HANDOFF]',
    '[NIGHTSHIFT REPORT',
    '[THREAD CONTEXT',
    '[/THREAD CONTEXT]',
    // Unchanged headers
    '[ACTIVE PROJECTS]',
    '[ACTIVE CONSTRAINTS]',
    '[OPEN DIRECTIVES',       // note: no closing bracket (may have suffix)
    '[GRAPH CONTEXT]',
    '[GRAPH NOTE]',
    '[TOPIC NOTE]',
    '[ARCHIVE RETRIEVAL]',
    '[LOOP DETECTED]',
    '[PROJECT CONTEXT',        // injected workspace/project files (may have suffix like ": robot")
    // NOTE: [THREAD:] is NOT listed here — it's an inline marker stripped by regex
    // in _stripContextBlocks, not a full-line context block header. Listing it here
    // would cause the entire user message to be treated as a context block.
    '[Chat messages since',    // multi-message catch-up context from gateway
    '[CURRENT STATE',          // truth plugin: fact corrections that supersede older memories
    '[CONSOLIDATION NOTICE]',  // infinite threads: compaction threshold signal
    '[/CONSOLIDATION NOTICE]',
    '[WARM START]',            // infinite threads: LLM-generated warm start
];

/**
 * Line-level prefixes that belong to plugin-injected context.
 * These appear inside context blocks (not as block headers).
 */
const CONTEXT_LINE_PREFIXES = [
    'Session:',
    'Topics:',
    'Anchors:',
    'Your coherence:',          // new: stability
    'Your process:',            // new: infrastructure
    'Entropy:',                 // legacy
    'Principles:',
    'Recent decisions:',
    'You remember these',       // new: archive retrieval
    'Stay with what\'s here',   // new: archive retrieval
    'You were part of these exchanges',  // legacy
    'Relevant conversation context:',
    'Pick up naturally',        // legacy
    'If you need details not present here',  // new: archive retrieval
    'This is what you remember',  // new: handoff
    'You did this thinking',    // new: nightshift
    '- They told you:',
    '- Chris:',
    '  You said:',
    '  You:',
    'Speak from this memory',
    'This is your context. Use it directly.',
    'From your knowledge base:',
    'From your experience:',
    'You know these connections:',
    'You\'re currently turning over',  // new: contemplation
    'Things you\'ve worked out',       // new: contemplation
    'What you\'ve been noticing',      // new: standing
    'What you\'ve seen recently',      // new: standing
    'Active inquiries:',        // legacy
    'Recent insights',          // legacy
    '- Q: "',
    '  Insight: "',
    'HEARTBEAT_OK',
    'When reading HEARTBEAT',
    'Default heartbeat prompt:',
];

/**
 * Prefixes injected by channels (Telegram, WhatsApp, etc.) and system events.
 * These appear as untrusted metadata prepended to user messages
 * via prependContext or similar channel-level injection.
 */
const CHANNEL_METADATA_PREFIXES = [
    'Conversation info (untrusted',
    'Replied message (untrusted',
    'System:',
    'Pre-compaction',
    'Current time:',
    '[media attached',
    'To send an image',
    '```json',
    '```',
];

function _isContextLine(line) {
    if (line.length === 0) return true; // blank lines between blocks
    for (const header of CONTEXT_BLOCK_HEADERS) {
        if (line.startsWith(header)) return true;
    }
    for (const prefix of CONTEXT_LINE_PREFIXES) {
        if (line.startsWith(prefix)) return true;
    }
    for (const prefix of CHANNEL_METADATA_PREFIXES) {
        if (line.startsWith(prefix)) return true;
    }
    // Inline JSON fragments from channel metadata blocks
    if (/^\s*[{}]/.test(line)) return true;         // lines starting with { or }
    if (/^\s*"(message_id|sender|sender_id|chat_id|chat_title|reply_to)"/.test(line)) return true;
    // Lines that are clearly context metadata
    if (/^- [A-Z]+:/.test(line)) return false; // real content like "- NOTE: ..."
    if (line.startsWith('- "') || line.startsWith('  -')) return true; // nested recall items
    // Workspace file reference patterns (injected by OpenClaw without wrapper tags).
    // Generalized from a whitelist to any caps-filename .md — catches
    // OPERATING-PRINCIPLES.md and future additions without code changes.
    // Still requires the opening `(` to avoid false positives on bare filenames
    // users might mention in prose.
    if (/\([A-Z][A-Z0-9_-]+\.md\b/.test(line)) return true;
    if (/^\s*--> \(/.test(line)) return true; // parenthetical source citations like "--> (FILE.md > Section)"
    return false;
}

function _stripContextBlocks(text) {
    if (!text) return '';

    // Strip inline markers: [THREAD:session_1234567890] and [SESSION_RESUME]
    text = text.replace(/\[THREAD:[^\]]*\]\s*/g, '');
    text = text.replace(/\[SESSION_RESUME\]\s*/g, '');

    // Fast path: no context blocks or channel metadata present
    const hasBlock = CONTEXT_BLOCK_HEADERS.some(h => text.includes(h));
    const hasRecall = text.includes('You remember these') || text.includes('Relevant conversation context:') || text.includes('From your knowledge base:');
    const hasChannelMeta = CHANNEL_METADATA_PREFIXES.some(p => text.includes(p));
    if (!hasBlock && !hasRecall && !hasChannelMeta) return text;

    // Primary strategy: find the timestamp marker that signals real user text.
    // e.g. [Mon 2026-02-16 08:57 PST]
    // Search for the LAST timestamp match — earlier ones may be inside recalled memories.
    const tsRegex = /\n\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s\d{4}-\d{2}-\d{2}\s[^\]]*\]\s*/g;
    let lastTsMatch = null;
    let match;
    while ((match = tsRegex.exec(text)) !== null) {
        lastTsMatch = match;
    }
    if (lastTsMatch) {
        return text.substring(lastTsMatch.index + lastTsMatch[0].length);
    }

    // Fallback: block-aware forward scan.
    // Context is always prepended to user messages. Scan from the beginning,
    // skipping entire block bodies (content between consecutive block headers)
    // and standalone context lines. Whatever remains is the user's actual text.
    //
    // Key insight: [PROJECT CONTEXT: robot] injects raw markdown that doesn't
    // match any line-level prefix. The old line-by-line approach stopped at
    // "# Project: Clint System" thinking it was user text. The block-aware scan
    // skips everything between [PROJECT CONTEXT] and [CONTINUITY CONTEXT].
    const lines = text.split('\n');
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        // Closing markers are standalone; do not treat them as opening a new
        // block or they can consume the real user text that follows.
        if (line.startsWith('[/')) {
            i++;
            continue;
        }

        // Is this a context block header? Skip the entire block body.
        if (CONTEXT_BLOCK_HEADERS.some(h => line.startsWith(h))) {
            i++;
            // Skip all lines until the next block header (which starts a new block)
            while (i < lines.length && !CONTEXT_BLOCK_HEADERS.some(h => lines[i].startsWith(h))) {
                i++;
            }
            // Don't increment — next iteration checks if this line is also a header
            continue;
        }

        // Is this a standalone context/metadata line (between or after blocks)?
        if (_isContextLine(line)) {
            i++;
            continue;
        }

        // Unwrapped workspace-injection detection.
        // ISSUE-CONTEXT-POLLUTION (2026-04-08): OpenClaw sometimes injects raw
        // workspace markdown (TRAILHEAD/ANCHOR content) without any wrapping
        // header. The signature is a paragraph of markdown (bullet/bold/table/
        // heading) terminated by a `--> (FILE.md > Section)` source citation.
        // Since the first line of such a paragraph doesn't match _isContextLine,
        // the scan would otherwise break on it and archive it as user text.
        // Peek ahead: if a workspace-source marker appears within the next
        // 10 lines, treat the whole span as injection and skip past it.
        const looksLikeMarkdown = /^(?:#{1,4}\s|[-*] |\*\*|\|)/.test(line);
        if (looksLikeMarkdown) {
            const peekEnd = Math.min(i + 10, lines.length);
            let markerAt = -1;
            for (let j = i + 1; j < peekEnd; j++) {
                // Specifically the `--> (FILE.md` injection signature —
                // the `--> ` prefix is distinctive and unlikely in user prose.
                if (/^\s*--> \([A-Z][A-Z0-9_-]+\.md\b/.test(lines[j])) {
                    markerAt = j;
                    break;
                }
            }
            if (markerAt >= 0) {
                i = markerAt + 1;
                continue;
            }
        }

        // Found content that isn't inside any block and isn't a known context line
        break;
    }

    if (i >= lines.length) return ''; // entire message was context
    return lines.slice(i).join('\n').trim();
}

/**
 * Strip context blocks that the agent quoted back in its response.
 * Unlike user messages (where blocks are prepended at the start),
 * agent responses may contain blocks anywhere — e.g. Clint quoting
 * "[STABILITY CONTEXT] Entropy: 0.35..." in his reply.
 *
 * Strategy: remove any contiguous run of context lines found in the text.
 * Preserves surrounding real content.
 */
function _stripContextFromAgentResponse(text) {
    if (!text) return '';
    // Fast path
    const hasBlock = CONTEXT_BLOCK_HEADERS.some(h => text.includes(h));
    if (!hasBlock) return text;

    const lines = text.split('\n');
    const cleaned = [];
    let inBlock = false;

    for (const line of lines) {
        if (CONTEXT_BLOCK_HEADERS.some(h => line.startsWith(h))) {
            inBlock = true;
            continue;
        }
        if (inBlock && _isContextLine(line)) {
            continue;
        }
        inBlock = false;
        cleaned.push(line);
    }

    return cleaned.join('\n').trim();
}

function _extractText(msg) {
    if (!msg) return '';
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
        return msg.content.map(c => c.text || c.content || '').join(' ');
    }
    return String(msg.content || '');
}

function _extractLastUserTextFromPrompt(prompt) {
    if (typeof prompt !== 'string' || prompt.trim().length === 0) return '';

    const threadMarkerIdx = prompt.lastIndexOf('[THREAD:');
    if (threadMarkerIdx >= 0) {
        const afterMarker = prompt.substring(threadMarkerIdx);
        const markerEnd = afterMarker.indexOf(']');
        if (markerEnd >= 0) {
            return _stripContextBlocks(afterMarker.substring(markerEnd + 1).trim());
        }
    }

    const tsRegex = /\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s\d{4}-\d{2}-\d{2}\s[^\]]*\]\s*/g;
    let lastTs = null;
    let match;
    while ((match = tsRegex.exec(prompt)) !== null) lastTs = match;
    if (lastTs) {
        return _stripContextBlocks(prompt.substring(lastTs.index + lastTs[0].length).trim());
    }

    return '';
}

function _isSyntheticUserPrompt(text) {
    const t = String(text || '').trim();
    return t.startsWith('[MORNING ARRIVAL]')
        || t.startsWith('[THREAD_BOUNDARY]')
        || t.startsWith('[SYSTEM — not from user')
        || t.startsWith('[SYSTEM - not from user')
        || t.startsWith('[SYSTEM: Session boundary')
        || t.startsWith('[THREAD:')
        || t.startsWith('[SESSION_RESUME]');
}

function _extractToolText(result) {
    if (!result) return '';
    if (typeof result === 'string') return result;
    if (typeof result.content === 'string') return result.content;
    if (typeof result.output === 'string') return result.output;
    if (typeof result.text === 'string') return result.text;
    if (Array.isArray(result.content)) {
        return result.content.map(c => c.text || c.content || '').join(' ');
    }
    return '';
}



function _handoffCandidateInput(content, state, ctx, overrides = {}) {
    return {
        content,
        date: overrides.date || new Date().toISOString().substring(0, 10),
        threadId: overrides.threadId || state.currentThreadId || ctx?.threadId || 'main',
        agentId: state.agentId,
        sessionId: state.sessionId || ctx?.sessionId || null
    };
}

function _observeClaimCandidates({ input, state, config, api, kind = 'observe' }) {
    const sourceMemoryConfig = config.sourceAddressableMemory || {};
    if (sourceMemoryConfig.enabled !== true || sourceMemoryConfig.mode === 'off') return null;

    try {
        const result = createClaimCandidates(input, {
            config,
            agentId: state.agentId,
            threadId: state.currentThreadId || 'main',
            sessionId: state.sessionId || null
        });
        const typeCounts = {};
        const sourceHandles = [];
        for (const candidate of result.candidates || []) {
            typeCounts[candidate.kind] = (typeCounts[candidate.kind] || 0) + 1;
            for (const source of candidate.sources || []) {
                if (source?.handle) sourceHandles.push(source.handle);
            }
        }
        const persistence = persistClaimCandidateResult(result, state.claimStore, {
            config,
            kind,
            now: new Date().toISOString()
        });
        _logBuild2Diagnostic(api, state, 'claim_candidates', {
            kind,
            mode: sourceMemoryConfig.mode || 'observe',
            candidateCount: result.candidateCount,
            invalidCount: result.invalidCount,
            types: typeCounts,
            candidateIds: (result.candidates || []).map((candidate) => candidate.id),
            sourceHandles,
            persistRequested: result.persist,
            persistAttempted: persistence.attempted,
            persisted: persistence.persisted,
            persistedCount: persistence.persistedCount,
            failedPersistCount: persistence.failedCount,
            persistedIds: persistence.persistedIds,
            action: persistence.persisted ? 'record_mode_persisted_candidates' : result.action
        });
        if (persistence.failedCount > 0) {
            api.logger.warn(`[Continuity:${state.agentId}] Build2 claim candidate persistence partial failure: ${JSON.stringify(persistence.errors)}`);
        }
        return { ...result, persistence };
    } catch (err) {
        api.logger.warn(`[Continuity:${state.agentId}] Build2 observe claim_candidates failed: ${err.message}`);
        return null;
    }
}

function _observeClaimContextPreview({ state, config, api, kind = 'observe' }) {
    const sourceMemoryConfig = config.sourceAddressableMemory || {};
    const contextConfig = sourceMemoryConfig.claimContext || {};
    if (contextConfig.enabled !== true || contextConfig.mode === 'off') return null;

    try {
        const preview = createClaimContextPreview({
            config,
            claimStore: state.claimStore,
            agentId: state.agentId,
            threadId: state.currentThreadId || 'main'
        });
        const previewItems = preview.packet?.items || [];
        _logBuild3Diagnostic(api, state, 'claim_context_preview', {
            kind,
            enabled: preview.enabled,
            mode: preview.mode,
            injectMode: preview.injectMode,
            previewOnly: preview.previewOnly,
            injectionReady: preview.injectionReady,
            sourceResolutionAttempted: preview.sourceResolutionAttempted,
            mutationAttempted: preview.mutationAttempted,
            reason: preview.reason || null,
            totalInput: preview.packet?.totalInput || 0,
            included: preview.packet?.included || 0,
            excluded: preview.packet?.excluded || 0,
            omitted: preview.packet?.omitted || 0,
            omittedByDiversity: preview.packet?.omittedByDiversity || 0,
            requiresVerification: preview.packet?.requiresVerification || 0,
            qualityVerdict: preview.audit?.quality?.verdict || null,
            readyForConsumptionTrial: preview.audit?.quality?.readyForConsumptionTrial === true,
            qualityIssues: preview.audit?.quality?.issues || [],
            qualityCautions: preview.audit?.quality?.cautions || [],
            qualityRecommendations: preview.audit?.quality?.readinessRecommendations || [],
            byKind: countPreviewItems(previewItems, 'kind'),
            byPrimarySourceType: countPreviewItems(previewItems, 'primarySourceType'),
            action: preview.enabled ? 'claim_context_preview_observed' : 'claim_context_preview_unavailable'
        });
        return preview;
    } catch (err) {
        api.logger.warn(`[Continuity:${state.agentId}] Build3 observe claim_context_preview failed: ${err.message}`);
        return null;
    }
}

function _appendClaimContextInjection({ lines, preview, state, config, api }) {
    const sourceMemoryConfig = config.sourceAddressableMemory || {};
    const contextConfig = sourceMemoryConfig.claimContext || {};
    if (!Array.isArray(lines)) return false;
    if (contextConfig.enabled !== true || contextConfig.mode !== 'live' || contextConfig.injectMode !== 'minimal') return false;
    if (!preview || preview.injectionReady !== true || !preview.rendered) {
        _logBuild3Diagnostic(api, state, 'claim_context_injection_skipped', {
            mode: contextConfig.mode || 'diagnostic',
            injectMode: contextConfig.injectMode || 'none',
            reason: preview?.reason || 'preview_not_injection_ready',
            injectionReady: preview?.injectionReady === true,
            included: preview?.packet?.included || 0,
            requiresVerification: preview?.packet?.requiresVerification || 0,
            mutationAttempted: false,
            sourceResolutionAttempted: false,
            promptInjectionAttempted: false,
            action: 'claim_context_injection_skipped'
        });
        return false;
    }

    lines.push('');
    lines.push('[VERIFIED CLAIM CONTEXT]');
    lines.push('These are source-addressable memory claims explicitly accepted through review. Use them as sourced memory, preserve qualifiers, and verify runtime/project-state claims before asserting current status.');
    lines.push(preview.rendered);
    lines.push('[/VERIFIED CLAIM CONTEXT]');
    _logBuild3Diagnostic(api, state, 'claim_context_injected', {
        mode: preview.mode,
        injectMode: preview.injectMode,
        acceptedVerifiedOnly: preview.acceptedVerifiedOnly === true,
        injectionReady: true,
        included: preview.packet?.included || 0,
        totalInput: preview.packet?.totalInput || 0,
        requiresVerification: preview.packet?.requiresVerification || 0,
        sourceResolutionAttempted: false,
        mutationAttempted: false,
        promptInjectionAttempted: true,
        action: 'claim_context_injected'
    });
    return true;
}

function _consumeSessionHandoffFromWorkspace({ workspacePath, state, config, ctx, api, source = 'session_start' }) {
    const handoffConfig = config.sessionHandoff || {};
    const handoffEnabled = handoffConfig.enabled !== false;
    if (!handoffEnabled || state.pendingHandoff) return false;

    const handoffPath = path.join(workspacePath, 'SESSION_HANDOFF.md');
    if (!fs.existsSync(handoffPath)) return false;

    const handoffContent = fs.readFileSync(handoffPath, 'utf8');
    state.pendingHandoff = handoffContent;
    state.pendingHandoffHealth = _observeHandoffHealth({
        filePath: handoffPath,
        content: handoffContent,
        state,
        config,
        ctx,
        api,
        kind: 'session'
    });
    fs.unlinkSync(handoffPath);
    api.logger.info(`[Continuity:${state.agentId}] Session handoff loaded and consumed (${source}): ${handoffPath}`);
    return true;
}

function _observeHandoffHealth({ filePath, content, state, config, ctx, api, kind = 'session' }) {
    const healthConfig = config.sessionHandoff?.healthCheck || {};
    if (healthConfig.enabled === false || healthConfig.mode === 'off') return null;

    try {
        const input = _buildHandoffHealthInput(filePath, content, state, ctx);
        const result = classifyHandoffHealth(input, {
            thresholds: {
                freshMs: healthConfig.freshMs,
                staleMs: healthConfig.staleMs,
                orphanedMs: healthConfig.orphanedMs
            }
        });
        _logBuild1Diagnostic(api, state, 'handoff_health', {
            kind,
            status: result.status,
            authority: result.authority,
            inject: result.inject,
            requiresVerification: result.requiresVerification,
            actions: result.actions,
            reasons: result.reasons,
            sourcePath: filePath
        });
        return result;
    } catch (err) {
        api.logger.warn(`[Continuity:${state.agentId}] Build1 handoff health observe failed: ${err.message}`);
        return null;
    }
}

function _observeAuthorityLadder({ content, health, state, config, api, kind = 'handoff' }) {
    const ladderConfig = config.authorityLadder || {};
    if (ladderConfig.enabled === false || ladderConfig.mode === 'off') return null;
    if (!content) return null;

    try {
        const hasRuntimeClaims = _contentHasRuntimeClaims(content);
        const hasSourceHandles = _contentHasSourceHandles(content);
        if (!hasRuntimeClaims && hasSourceHandles) return null;

        const claims = [{
            id: `${kind}-claim`,
            subject: hasRuntimeClaims ? 'runtime_or_project_state' : 'handoff_summary',
            value: hasRuntimeClaims ? 'claims_present' : 'summary_present',
            source: 'handoff',
            health: health || undefined,
            hasSourceHandle: hasSourceHandles,
            observedAt: new Date().toISOString()
        }];
        const result = resolveAuthority(claims);
        _logBuild1Diagnostic(api, state, 'authority_ladder', {
            kind,
            decision: result.decision,
            winner: result.winner ? {
                id: result.winner.id,
                source: result.winner.source,
                rank: result.winner.rank,
                requiresVerification: result.winner.requiresVerification
            } : null,
            requiresVerification: result.requiresVerification,
            reasons: result.reasons
        });
        return result;
    } catch (err) {
        api.logger.warn(`[Continuity:${state.agentId}] Build1 authority ladder observe failed: ${err.message}`);
        return null;
    }
}

function _buildHandoffHealthInput(filePath, content, state, ctx) {
    const stat = fs.statSync(filePath);
    const header = _parseHandoffHeader(content, path.basename(filePath));
    const currentThreadId = state.currentThreadId || ctx?.threadId || 'main';
    return {
        exists: true,
        createdAt: header.createdAt || stat.birthtimeMs || stat.ctimeMs,
        updatedAt: header.updatedAt || header.generatedAt || stat.mtimeMs,
        threadId: header.threadId || (path.basename(filePath) === 'SESSION_HANDOFF.md' ? 'main' : null),
        sessionId: header.sessionId || null,
        currentThreadId,
        currentSessionId: state.sessionId || ctx?.sessionId || null,
        hasRuntimeClaims: _contentHasRuntimeClaims(content),
        hasSourceHandles: _contentHasSourceHandles(content),
        warnings: header.warnings || []
    };
}

function _parseHandoffHeader(content, filename = '') {
    const text = String(content || '');
    const headerText = text.split(/\n\s*##\s+/)[0].slice(0, 4000);
    const header = { warnings: [] };

    const threadFromFilename = filename.match(/^SESSION_HANDOFF_(.+)\.md$/);
    if (threadFromFilename) header.threadId = threadFromFilename[1];

    const patterns = [
        ['threadId', /(?:thread\s*id|threadId|thread):\s*`?([^`\n]+)`?/i],
        ['sessionId', /(?:session\s*id|sessionId|session):\s*`?([^`\n]+)`?/i],
        ['createdAt', /(?:created|createdAt):\s*([^\n]+)/i],
        ['updatedAt', /(?:updated|updatedAt|last\s*updated):\s*([^\n]+)/i],
        ['generatedAt', /(?:generated|generatedAt|handoff\s*written):\s*([^\n]+)/i]
    ];

    for (const [key, regex] of patterns) {
        const match = headerText.match(regex);
        if (match) header[key] = match[1].trim();
    }

    return header;
}

function _contentHasRuntimeClaims(content) {
    const text = String(content || '').toLowerCase();
    return /\b(pushed|merged|deployed|running|configured|wired|enabled|disabled|active|live|gateway|server|process|plugin|commit|tests? pass(?:ed)?|build pass(?:ed)?|working)\b/.test(text);
}

function _contentHasSourceHandles(content) {
    const text = String(content || '');
    return /\b(commit:[a-f0-9]{6,40}|archive:\d{4}-\d{2}-\d{2}|source:\S+|file:\S+#L\d+|https?:\/\/\S+)\b/i.test(text);
}

function _writeSuspectHandoffRecord({ sourcePath, content, reason, config, ctx, api, state }) {
    const healthConfig = config.sessionHandoff?.healthCheck || {};
    const workspacePath = config.sessionHandoff?.workspacePath ||
        ctx?.workspaceDir ||
        process.env.OPENCLAW_WORKSPACE ||
        path.join(require('os').homedir(), '.openclaw', 'workspace');
    const suspectDir = path.isAbsolute(healthConfig.suspectDir || '')
        ? healthConfig.suspectDir
        : path.join(workspacePath, healthConfig.suspectDir || '.continuity/handoffs/suspect');
    ensureDir(suspectDir);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = `${stamp}-${sanitizeThreadId(path.basename(sourcePath || 'SESSION_HANDOFF.md', '.md'))}`;
    const handoffPath = path.join(suspectDir, `${base}.md`);
    const metaPath = path.join(suspectDir, `${base}.meta.json`);
    fs.writeFileSync(handoffPath, content || '', 'utf8');
    fs.writeFileSync(metaPath, JSON.stringify({
        sourcePath,
        reason,
        agentId: state?.agentId,
        recordedAt: new Date().toISOString()
    }, null, 2), 'utf8');
    api?.logger?.warn?.(`[Continuity:${state?.agentId || 'main'}] Suspect handoff recorded: ${handoffPath}`);
    return { handoffPath, metaPath };
}

function _logBuild1Diagnostic(api, state, type, payload) {
    const safePayload = JSON.stringify(payload, (key, value) => {
        if (key === 'content' || key === 'text') return '[redacted]';
        if (typeof value === 'string' && value.length > 300) return `${value.slice(0, 300)}...`;
        return value;
    });
    api.logger.info(`[Continuity:${state.agentId}] Build1 observe ${type}: ${safePayload}`);
}

function _logBuild2Diagnostic(api, state, type, payload) {
    const safePayload = JSON.stringify(payload, (key, value) => {
        if (key === 'content' || key === 'text') return '[redacted]';
        if (typeof value === 'string' && value.length > 300) return `${value.slice(0, 300)}...`;
        return value;
    });
    api.logger.info(`[Continuity:${state.agentId}] Build2 observe ${type}: ${safePayload}`);
}

function countPreviewItems(items = [], key) {
    return items.reduce((acc, item) => {
        const value = item?.[key] || 'unknown';
        acc[value] = (acc[value] || 0) + 1;
        return acc;
    }, {});
}

function _logBuild3Diagnostic(api, state, type, payload) {
    const safePayload = JSON.stringify(payload, (key, value) => {
        if (key === 'content' || key === 'text' || key === 'rendered') return '[redacted]';
        if (typeof value === 'string' && value.length > 300) return `${value.slice(0, 300)}...`;
        return value;
    });
    api.logger.info(`[Continuity:${state.agentId}] Build3 observe ${type}: ${safePayload}`);
}

function sanitizeThreadId(threadId) {
    const raw = String(threadId || 'main');
    const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
    return safe.slice(0, 120) || 'main';
}

function _formatDuration(ms) {
    const minutes = Math.floor(ms / 60000);
    if (minutes < 1) return 'just started';
    if (minutes < 60) return `${minutes}min ago`;
    const hours = Math.floor(minutes / 60);
    const rem = minutes % 60;
    return rem > 0 ? `${hours}h ${rem}min ago` : `${hours}h ago`;
}

function _formatAge(timestamp) {
    const minutes = Math.round((Date.now() - timestamp) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}min ago`;
    return `${Math.round(minutes / 60)}h ago`;
}

function _truncate(text, maxLen) {
    if (!text || text.length <= maxLen) return text;
    // Sentence-boundary aware: find last sentence end before maxLen
    const region = text.substring(0, maxLen);
    const lastSentenceEnd = Math.max(
        region.lastIndexOf('. '),
        region.lastIndexOf('? '),
        region.lastIndexOf('! '),
        region.lastIndexOf('.\n'),
        region.lastIndexOf('?\n'),
        region.lastIndexOf('!\n')
    );
    // If we found a sentence boundary in the latter half, use it
    if (lastSentenceEnd > maxLen * 0.5) {
        return text.substring(0, lastSentenceEnd + 1) + '...';
    }
    // Fallback: hard cut
    return text.substring(0, maxLen - 3) + '...';
}

function _readCachedTextByMtime(state, filePath) {
    if (!filePath) return null;
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) return null;
        if (!state.fileTextCache) state.fileTextCache = new Map();
        const cached = state.fileTextCache.get(filePath);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
            return cached.text;
        }
        const text = fs.readFileSync(filePath, 'utf8');
        state.fileTextCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, text });
        return text;
    } catch {
        return null;
    }
}

/**
 * Write SESSION_HANDOFF.md with lean session context.
 * Called from agent_end (every exchange) so the handoff is always fresh.
 * Pulls from PERSISTED archive, not in-memory state, to survive session resets.
 * 
 * LEAN FORMAT: Summary, not full exchanges.
 * - Topics (what was discussed)
 * - Key points (decisions, progress, blockers)
 * - Where we left off
 * 
 * NOT: Full conversation thread (that's in archive, retrieved via continuity)
 * 
 * @param {Object} state - Agent state (may be fresh after reset)
 * @param {Object} config - Plugin config
 * @param {Object} ctx - Hook context (for workspaceDir)
 * @param {Object} api - Plugin API (for logger, stability)
 */
function _writeSessionHandoff(state, config, ctx, api, options = {}) {
    const handoffConfig = config.sessionHandoff || {};
    const handoffEnabled = handoffConfig.enabled !== false;

    if (!handoffEnabled) return;

    const force = options.force === true;
    const now = Date.now();
    const minIntervalMs = Number.isFinite(handoffConfig.minWriteIntervalMs)
        ? handoffConfig.minWriteIntervalMs
        : 60000;
    const maxExchangeInterval = Number.isFinite(handoffConfig.maxExchangeInterval)
        ? handoffConfig.maxExchangeInterval
        : 3;
    const exchangeDelta = Math.max(0, (state.exchangeCount || 0) - (state.lastHandoffWriteExchange ?? -1));
    const withinInterval = state.lastHandoffWriteAt && (now - state.lastHandoffWriteAt) < minIntervalMs;
    const belowExchangeInterval = exchangeDelta < maxExchangeInterval;
    if (!force && state.handoffWritten && withinInterval && belowExchangeInterval) {
        api.logger.debug?.(
            `[Continuity:${state.agentId}] Handoff write debounced (${options.reason || 'unspecified'}, ${exchangeDelta} exchange delta)`
        );
        return;
    }

    try {
        const workspacePath = handoffConfig.workspacePath ||
            ctx.workspaceDir ||
            process.env.OPENCLAW_WORKSPACE ||
            path.join(require('os').homedir(), '.openclaw', 'workspace-clint');

        // Thread-scoped handoff: per-thread persistent state file
        const threadId = state.currentThreadId || 'main';
        const handoffFilename = threadId !== 'main'
            ? `SESSION_HANDOFF_${threadId}.md`
            : 'SESSION_HANDOFF.md';
        const handoffPath = path.join(workspacePath, handoffFilename);

        // Clean up stale temp file from a previous crash mid-write
        try { fs.unlinkSync(handoffPath + '.tmp'); } catch {}

        // If the agent wrote one manually, respect it (within 5 minutes = agent-curated)
        if (fs.existsSync(handoffPath)) {
            const stat = fs.statSync(handoffPath);
            const ageMs = Date.now() - stat.mtimeMs;
            const recentOwnWrite = state.lastHandoffWriteAt && Math.abs(stat.mtimeMs - state.lastHandoffWriteAt) < 5000;
            if (!force && !recentOwnWrite && ageMs < 300000) {
                api.logger.info(`[Continuity:${state.agentId}] Recent handoff exists (${Math.round(ageMs / 1000)}s old), skipping this write`);
                return;
            }
        }

        // Pull from ARCHIVE directly (persisted, survives session resets)
        const dataDir = state.dataDir;
        if (!dataDir) {
            api.logger.warn(`[Continuity:${state.agentId}] No dataDir in state — cannot write handoff`);
            return;
        }
        const Archiver = require('./storage/archiver');
        const archiver = new Archiver(config, dataDir);

        // Get recent messages from today and yesterday
        const today = new Date().toISOString().substring(0, 10);
        const yesterday = new Date(Date.now() - 86400000).toISOString().substring(0, 10);

        let recentMessages = [];
        let messagesDate = today;
        for (const date of [today, yesterday]) {
            const conversation = archiver.getConversation(date);
            if (conversation?.messages?.length > 0) {
                recentMessages = conversation.messages;
                messagesDate = date;
                break;
            }
        }

        // Find most recent sessionId distinct from current — gives the next
        // session a pointer back into the continuity archive for the prior
        // session's full exchange record. Breaks the copy-of-copy summary
        // chain across restarts: handoff prose is a summary, sessionIds are
        // the source-of-truth reference. archiver.js stamps sessionId on
        // every archived message, so we just scan backward.
        const currentSessionId = state.sessionId || null;
        let previousSessionId = null;
        for (let i = recentMessages.length - 1; i >= 0; i--) {
            const sid = recentMessages[i].sessionId;
            if (sid && sid !== currentSessionId) { previousSessionId = sid; break; }
        }
        // If today's archive only held the current session, peek yesterday.
        if (!previousSessionId && messagesDate === today) {
            const yesterdayConv = archiver.getConversation(yesterday);
            const yMsgs = yesterdayConv?.messages || [];
            for (let i = yMsgs.length - 1; i >= 0; i--) {
                const sid = yMsgs[i].sessionId;
                if (sid && sid !== currentSessionId) { previousSessionId = sid; break; }
            }
        }

        // Count exchanges (user-agent pairs)
        let exchangeCount = 0;
        let inExchange = false;
        for (const msg of recentMessages) {
            if (msg.sender === 'user' && !inExchange) {
                inExchange = true;
            } else if (msg.sender === 'agent' && inExchange) {
                exchangeCount++;
                inExchange = false;
            }
        }

        // ── LEAN HANDOFF: Extract key points, not full exchanges ──
        // Build a lean summary from Topics, Anchors, and last 2 exchanges only.
        // Full archive is available via continuity retrieval — this is a bridge, not a copy.
        
        // Determine current mode for handoff header
        const currentMode = state._lastEventMetadata?.codeMode ? 'code'
            : state._lastEventMetadata?.boothMode ? 'booth'
            : 'chat';

        // Determine session duration for infrastructure context
        const sessionDurationMin = state.sessionStart
            ? Math.floor((Date.now() - state.sessionStart) / 60000) : 0;

        const lines = [
            `# Session Handoff`,
            '',
            `*Thread: ${threadId} | Mode: ${currentMode} | Compactions: ${state.threadCompactionCount} | Last Active: ${new Date().toISOString()}*`,
            ''
        ];
        if (currentSessionId) lines.push(`**Session ID:** ${currentSessionId}`);
        if (previousSessionId) lines.push(`**Previous session:** ${previousSessionId}`);
        if (currentSessionId || previousSessionId) lines.push('');
        lines.push(
            `## Infrastructure`,
            '',
            `- **Session type:** cold start (full app restart)`,
            `- **Gateway port:** ${process.env.OPENCLAW_PORT || 'unknown'}`,
            `- **Session duration:** ${sessionDurationMin > 0 ? sessionDurationMin + ' minutes' : 'just started'}`,
            `- **Plugins loaded:** continuity, stability${api.stability ? ' (active)' : ' (not detected)'}`,
            '',
            `## What Happened`,
            '',
            `- **Exchanges:** ${exchangeCount} (from archive)`,
            ''
        );

        // Topics (what was discussed)
        if (state.topicTracker) {
            const topicState = state.topicTracker.getAllTopics();
            if (topicState.length > 0) {
                lines.push('## Topics');
                lines.push('');
                for (const t of topicState.slice(0, 5)) {
                    lines.push(`- ${t.topic} (${t.mentions}x)`);
                }
                lines.push('');
            }
        }

        // Anchors (key moments — decisions, tensions, contradictions).
        // Emit with inline [type · weight · age] metadata so the warm-start
        // prompt can hedge by freshness and type rather than treating all
        // Key Points as equally live and load-bearing. Fixes the recall
        // drift pattern where stored anchors without provenance got
        // amplified into grandiose recurring-theme framing (e.g. ordinary
        // wondering about responsibilities → "responsibilities to mankind,
        // back when this string of restarts began").
        if (state.anchors) {
            const anchorState = state.anchors.getAnchors();
            if (anchorState.length > 0) {
                lines.push('## Key Points');
                lines.push('');
                for (const a of anchorState.slice(0, 5)) {
                    // Map priority → weight label for downstream hedging.
                    const weight = a.priority >= 0.9 ? 'foundational'
                        : a.priority >= 0.6 ? 'notable'
                        : 'light';
                    // Age in coarse buckets (minutes, hours, days) — parser-friendly.
                    const ageMin = Math.round((Date.now() - a.timestamp) / 60000);
                    const age = ageMin < 60 ? `${ageMin}m ago`
                        : ageMin < 1440 ? `${Math.round(ageMin / 60)}h ago`
                        : `${Math.round(ageMin / 1440)}d ago`;
                    const meta = `[${a.type} · ${weight} · ${age}]`;
                    lines.push(`- ${meta} "${_truncate(a.text, 150)}"`);
                }
                lines.push('');
            }
        }

        // Last 2 real exchanges (skip heartbeats and context-only messages)
        const realMessages = recentMessages.filter(msg => {
            const text = (msg.text || '').trim();
            if (text === 'HEARTBEAT_OK') return false;
            if (CONTEXT_BLOCK_HEADERS.some(h => text.startsWith(h))) return false;
            if (text.length < 5) return false;
            return true;
        });
        const lastMessages = realMessages.slice(-4); // 2 exchanges = 4 messages
        const hasGroundedLastExchange = lastMessages.some(msg => msg.sender === 'user');
        if (lastMessages.length > 0) {
            if (hasGroundedLastExchange) {
                lines.push('## Last Exchanges');
                lines.push('');
                // Provenance-labeled so prompt consumers (warm-start, morning-arrival,
                // etc.) can't confuse prior agent utterances for user speech.
                // "You" was ambiguous here — meaningful to a human reader as
                // "you, future-Ellis" but read by the LLM as "you, Chris" when fed
                // back as prior-conversation context. That mislabel drove a class
                // of recursive self-reference drift (e.g. agent fabricating
                // "you mentioned X" by echoing its own prior output). Label
                // explicitly as [Ellis, prior] so no downstream consumer can
                // blur the source.
                for (const msg of lastMessages) {
                    const who = msg.sender === 'user' ? 'Chris' : '[Ellis, prior]';
                    // Strip agent directive tags (e.g. [[reply_to_current]], [[thinking]], etc.)
                    let text = (msg.text || '').replace(/\[\[[^\]]*\]\]\s*/g, '').trim();
                    text = _truncate(text, 200);
                    lines.push(`- ${who}: "${text}"`);
                }
                lines.push('');
            } else {
                lines.push('## Last Exchanges');
                lines.push('');
                lines.push('No grounded Chris/user turns were present in the latest archive slice. Do not treat prior agent-only text as conversation memory.');
                lines.push('');
            }
        }

        // Open Threads — unresolved tensions and work-in-progress
        // Extract from anchors (tensions, contradictions) and topics with recurrence
        const openThreads = [];
        
        // Tension anchors = unresolved threads
        if (state.anchors) {
            const anchorState = state.anchors.getAnchors();
            const tensionAnchors = anchorState.filter(a => 
                a.type === 'tension' || a.type === 'contradiction'
            );
            for (const a of tensionAnchors.slice(0, 3)) {
                openThreads.push({
                    source: 'tension',
                    text: _truncate(a.text, 100),
                    age: Math.round((Date.now() - a.timestamp) / 60000) + 'min ago'
                });
            }
        }
        
        // Fixated topics = recurring discussions not yet resolved
        if (state.topicTracker) {
            const fixated = state.topicTracker.getFixatedTopics();
            for (const t of fixated.slice(0, 2)) {
                openThreads.push({
                    source: 'topic',
                    text: t.topic,
                    age: t.mentions + ' mentions'
                });
            }
        }
        
        if (openThreads.length > 0) {
            lines.push('## Open Threads');
            lines.push('');
            lines.push('Unresolved threads from this session — pick up where you left off:');
            lines.push('');
            for (const thread of openThreads) {
                lines.push(`- [${thread.source}] ${thread.text} (${thread.age})`);
            }
            lines.push('');
        }

        // Relational State — heuristic from anchor types + exchange depth.
        // Bridges the emotional/relational tone across restarts, not just topics.
        const relAnchors = state.anchors ? state.anchors.getAnchors() : [];
        const identityCount = relAnchors.filter(a => a.type === 'identity').length;
        const tensionCount = relAnchors.filter(a =>
            a.type === 'tension' || a.type === 'contradiction').length;

        let relationalState;
        if (identityCount >= 2) {
            relationalState = 'Deep collaborative connection — identity-level exchanges present';
        } else if (tensionCount >= 2) {
            relationalState = 'Working through friction — tensions or corrections active';
        } else if (identityCount >= 1 && tensionCount >= 1) {
            relationalState = 'Active exploration — mixing depth with honest pushback';
        } else if (exchangeCount > 10) {
            relationalState = 'Steady working rapport — sustained engagement';
        } else if (exchangeCount > 3) {
            relationalState = 'Building momentum — finding its groove';
        } else {
            relationalState = 'Opening — early exchanges, tone still forming';
        }

        lines.push('## Relational State');
        lines.push('');
        lines.push(relationalState);
        lines.push('');

        // Guide Notes
        const postureGap = api.stability?.getPostureGap?.(state.agentId) || 0;
        const sustainedMinutes = state._sustainedWorkStart
            ? Math.floor((Date.now() - state._sustainedWorkStart) / 60000) : 0;
        const guideNotes = [];
        if (postureGap > 4) guideNotes.push(`Task-heavy session (${Math.round(postureGap)} exchanges without guide presence)`);
        if (sustainedMinutes > 90) guideNotes.push(`Extended sustained work (${Math.floor(sustainedMinutes / 60)}+ hours)`);
        if (guideNotes.length > 0) {
            lines.push('## Guide Notes');
            lines.push('');
            for (const note of guideNotes) lines.push(`- ${note}`);
            lines.push('');
        }

        // Recall footer — the prose above is a summary. Source of truth is
        // the continuity archive; use these IDs to pull the original exchange
        // record via continuity_recall / continuity_search tools.
        if (currentSessionId || previousSessionId) {
            lines.push('## To recall full detail');
            lines.push('');
            lines.push('Prose above is a summary. Source of truth is the continuity archive.');
            if (currentSessionId) lines.push(`- This session: \`continuity_recall sessionId=${currentSessionId}\``);
            if (previousSessionId) lines.push(`- Previous: \`continuity_recall sessionId=${previousSessionId}\``);
            lines.push('');
        }

        lines.push('---');
        lines.push('');
        lines.push('*The next session starts fresh. Read this, then move to archive.*');

        // ── Handoff Write Validation ──
        // Scan for unverified operational state claims and downgrade them.
        // Prevents the handoff self-reference loop: agent asserts "X is running" →
        // next session reads it as fact → compounds across restarts.
        const OPERATIONAL_CLAIM_PATTERNS = [
          /\b(?:is|are)\s+(?:running|wired|firing|active|deployed|configured|working|operational|live|enabled)\b/gi,
          /\b(?:has been|was)\s+(?:wired|deployed|fixed|resolved|completed|implemented)\b/gi,
        ];
        const handoffText = lines.join('\n');
        let validatedText = handoffText;
        for (const pattern of OPERATIONAL_CLAIM_PATTERNS) {
          validatedText = validatedText.replace(pattern, (match) => {
            // Don't modify text inside the header/metadata line
            return `was discussed as ${match.replace(/\bis\b/g, 'being').replace(/\bare\b/g, 'being')}`;
          });
        }
        // Only apply validation to the body sections (skip the header)
        const headerEnd = validatedText.indexOf('## What Happened');
        if (headerEnd > 0) {
          const header = handoffText.substring(0, headerEnd);
          const body = handoffText.substring(headerEnd);
          let validatedBody = body;
          for (const pattern of OPERATIONAL_CLAIM_PATTERNS) {
            validatedBody = validatedBody.replace(pattern, (match) => {
              return `[unverified] ${match}`;
            });
          }
          const tmpPath = handoffPath + '.tmp';
          fs.writeFileSync(tmpPath, header + validatedBody, 'utf8');
          fs.renameSync(tmpPath, handoffPath);
        } else {
          const tmpPath = handoffPath + '.tmp';
          fs.writeFileSync(tmpPath, handoffText, 'utf8');
          fs.renameSync(tmpPath, handoffPath);
        }
        api.logger.info(`[Continuity:${state.agentId}] Lean handoff written: ${exchangeCount} exchanges, ${lines.length} lines (thread: ${threadId})`);
        state.handoffWritten = true;
        state.lastHandoffWriteAt = Date.now();
        state.lastHandoffWriteExchange = state.exchangeCount || 0;
    } catch (err) {
        api.logger.error(`[Continuity:${state.agentId}] Failed to write session handoff: ${err.message}`);
    }
}

// ═══════════════════════════════════════════════════════════════════
// Infinite Threads: Helper functions
// ═══════════════════════════════════════════════════════════════════

/**
 * Read persisted thread state from a handoff file header.
 * Survives gateway restarts — the handoff file is the source of truth
 * for thread compaction count and last active timestamp.
 */
function _readThreadStateFromHandoff(threadId, workspacePath) {
    const handoffPath = path.join(workspacePath, `SESSION_HANDOFF_${threadId}.md`);
    if (!fs.existsSync(handoffPath)) return null;

    try {
        const content = fs.readFileSync(handoffPath, 'utf8');
        const headerMatch = content.match(
            /Compactions:\s*(\d+)\s*\|\s*Last Active:\s*([^\s*]+)/
        );
        if (!headerMatch) return null;

        return {
            compactionCount: parseInt(headerMatch[1], 10) || 0,
            lastActive: headerMatch[2]
        };
    } catch (err) {
        return null;
    }
}

/**
 * Parse SESSION_HANDOFF markdown into structured sections.
 * Used by the warm start generator to synthesize a natural summary.
 */
function _parseHandoffSections(handoffMd) {
    const sections = {};

    const topicsMatch = handoffMd.match(/## Topics\n([\s\S]*?)(?=\n##|\n---|\n$)/);
    if (topicsMatch) {
        sections.topics = topicsMatch[1].trim().split('\n')
            .map(l => l.replace(/^-\s*/, '').replace(/\s*\(\d+x\)$/, '').trim())
            .filter(Boolean);
    }

    const openMatch = handoffMd.match(/## Open Threads\n[\s\S]*?\n([\s\S]*?)(?=\n##|\n---|\n$)/);
    if (openMatch) {
        sections.openThreads = openMatch[1].trim().split('\n')
            .map(l => ({ text: l.replace(/^-\s*\[.*?\]\s*/, '').trim() }))
            .filter(t => t.text);
    }

    const keyMatch = handoffMd.match(/## Key Points\n([\s\S]*?)(?=\n##|\n---|\n$)/);
    if (keyMatch) {
        // Parse both the enriched format — `- [type · weight · age] "text"` —
        // and the legacy prose format — `- text` — so handoffs written before
        // the metadata-inline upgrade still flow through without errors.
        sections.keyPoints = keyMatch[1].trim().split('\n')
            .map(l => {
                const raw = l.replace(/^-\s*/, '').trim();
                if (!raw) return null;
                // Try enriched format
                const metaMatch = raw.match(/^\[([^·\]]+)·\s*([^·\]]+)·\s*([^\]]+)\]\s*"(.+)"\s*$/);
                if (metaMatch) {
                    return {
                        type: metaMatch[1].trim(),
                        weight: metaMatch[2].trim(),
                        age: metaMatch[3].trim(),
                        text: metaMatch[4].trim(),
                        enriched: true
                    };
                }
                // Legacy prose fallback — text only, no metadata
                return { text: raw, enriched: false };
            })
            .filter(Boolean);
    }

    const exchMatch = handoffMd.match(/## Last Exchanges\n([\s\S]*?)(?=\n##|\n---|\n$)/);
    if (exchMatch) {
        sections.lastExchanges = exchMatch[1].trim().split('\n')
            .map(l => l.replace(/^-\s*/, '').trim())
            .filter(Boolean);
    }

    return sections;
}

/**
 * Generate an LLM-powered warm-start summary from crystallized thread state.
 * Reads ~500-800 tokens of handoff, produces ~200 tokens of natural prose.
 * Graceful fallback: returns null if LLM unavailable or generation fails.
 */
async function _generateWarmStart(threadHandoff, threadId, state, config, api) {
    if (!api.llm?.generate) return null;

    const warmStartConfig = config.warmStart || {};
    if (warmStartConfig.enabled === false) return null;

    const sections = _parseHandoffSections(threadHandoff);
    if (!sections.topics?.length && !sections.openThreads?.length) return null;

    // Determine last mode from handoff header
    const modeMatch = threadHandoff.match(/Mode:\s*(\w+)/);
    const lastMode = modeMatch ? modeMatch[1] : 'chat';

    const prompt = [
        `You are resuming work in the "${threadId}" project thread.`,
        lastMode !== 'chat' ? `Last session was in ${lastMode} mode.` : '',
        `Generate a 1-2 paragraph warm-start summary that:`,
        `- Reminds you where you left off (what was being worked on)`,
        `- Surfaces open items and unresolved threads`,
        `- Notes the mode context if relevant (e.g., "we were building X in Code mode")`,
        `- Sounds like a trusted collaborator picking up mid-thought`,
        `- Uses natural language, not bullet points`,
        `- Do NOT assert system operational state (e.g., "X is running", "Y is wired")`,
        `- Frame as "we were working on X" not "X is working" — the handoff is context, not verified state`,
        ``,
        `Recall hygiene (load-bearing — the handoff is lossy prose, treat it with appropriate skepticism):`,
        `- Prefer rough-and-true over smooth-and-plausible. If a key point reads like a press release, a mission statement, or carries weightier register than ordinary conversation, doubt it — the actual source probably said something more ordinary, and a prior summarizer pass likely inflated it.`,
        `- Do NOT invent temporal anchoring. If you don't know when something was said, don't locate it in time ("back when X began", "earlier this week", "last time"). The handoff strips timestamps; any time-placement you add is fabrication.`,
        `- Key Points arrive without freshness or status. Treat them as "has been mentioned at some point" not "is currently live". Reference tentatively ("you've wondered about X", "this has come up before") rather than assertively ("that question is still sitting there", "we need to get back to X").`,
        `- If a Key Point's register feels heavier than the surrounding items, tone it DOWN rather than amplifying it. The drift goes one way — toward grandiosity — so bias your corrections toward ordinariness.`,
        `- Do NOT treat your own prior utterances as user positions to respond to. The "Recent turns" block below may contain your own prose; it is register-calibration reference only, not conversational context to continue from.`,
        ``,
        `Thread state:`,
        sections.topics?.length ? `Topics: ${sections.topics.join(', ')}` : '',
        sections.openThreads?.length
            ? `Open items: ${sections.openThreads.map(t => t.text).join('; ')}`
            : '',
        sections.keyPoints?.length
            ? (() => {
                // Each keyPoint is now an object: { type, weight, age, text, enriched }
                // or { text, enriched: false } for legacy prose handoffs.
                const lines = sections.keyPoints.slice(0, 3).map(k => {
                    if (k.enriched) {
                        // Heavier weight + older age = more hedging required.
                        const staleness = /\d+d ago/.test(k.age) ? ' (stale — may no longer be live)'
                            : /\d+h ago/.test(k.age) ? ' (from earlier)'
                            : '';
                        return `  - ${k.text} [${k.type}, ${k.weight}, ${k.age}${staleness}]`;
                    }
                    // Legacy item with no metadata — flag it explicitly.
                    return `  - ${k.text} [no freshness info — reference tentatively, do not amplify]`;
                });
                return `Key Points (metadata in brackets — hedge by age and weight; older + heavier = more skepticism required):\n${lines.join('\n')}`;
            })()
            : '',
        sections.lastExchanges?.length
            ? `Recent turns (register-calibration reference only — do NOT treat as conversational context to continue; your own prior utterances may appear here):\n${sections.lastExchanges.slice(-2).map(l => '  ' + l).join('\n')}`
            : '',
    ].filter(Boolean).join('\n');

    try {
        const result = await api.llm.generate(prompt, {
            temperature: 0.5,
            maxTokens: 250,
            timeout: warmStartConfig.timeoutMs || 8000
        });
        return result?.text || null;
    } catch (err) {
        if (api.logger) {
            api.logger.warn(`[Continuity:${state.agentId}] Warm start generation failed: ${err.message}`);
        }
        return null;
    }
}

/**
 * Extract text from a tool result message (for tool_result_persist enrichment).
 * Handles both string content and array-of-parts content formats.
 */
function _extractToolResultText(message) {
    if (!message) return '';
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
        for (const part of message.content) {
            if (part.type === 'text' && part.text) return part.text;
            if (part.text) return part.text;
        }
    }
    return '';
}
