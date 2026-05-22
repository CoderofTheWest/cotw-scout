/**
 * sessionRecorder.js
 *
 * Records tool calls and satisfaction signals during Code mode sessions.
 * Writes CodeSessionRecords to data/sessions/ on session end.
 *
 * Passive — no LLM calls, no modifications to agent behavior.
 * Just bookkeeping for the evolution loop to analyze later.
 */

const fs = require('fs');
const path = require('path');

// Satisfaction signal patterns
const POSITIVE_PATTERNS = [
    'thanks', 'thank you', 'perfect', 'that works', 'great', 'awesome',
    'exactly', 'nice', 'well done', 'good job', 'looks good', 'love it'
];
const NEGATIVE_PATTERNS = [
    "that's wrong", 'not what i', 'undo that', 'revert', 'no that',
    "that's not right", 'wrong', 'broken', 'messed up'
];
const CORRECTION_PATTERNS = [
    'actually i meant', 'what i wanted was', 'no i mean',
    'let me clarify', 'i should have said', 'try again'
];

class SessionRecorder {
    /**
     * @param {object} config - Plugin config
     * @param {string} dataDir - Base data directory for the plugin
     * @param {object} logger - Plugin logger
     */
    constructor(config, dataDir, logger) {
        this.config = config;
        this.sessionsDir = path.join(dataDir, 'sessions');
        this.logger = logger;

        // Active sessions keyed by agentId
        this.activeSessions = new Map();

        // Track which agents are in code mode
        this.codeModeSessions = new Set();

        this._ensureDir(this.sessionsDir);
    }

    // -----------------------------------------------------------------------
    // Code mode tracking
    // -----------------------------------------------------------------------

    /**
     * Mark an agent as being in a code mode session.
     * Called from the plugin's before_agent_start hook.
     */
    startCodeSession(agentId) {
        if (this.activeSessions.has(agentId)) {
            // Already recording — just make sure code mode flag is set
            this.codeModeSessions.add(agentId);
            return;
        }

        const session = {
            sessionId: `${Date.now()}_${agentId}_${Math.random().toString(36).substr(2, 6)}`,
            agentId,
            startedAt: new Date().toISOString(),
            endedAt: null,
            messageCount: 0,
            toolCalls: [],
            entropyHistory: [],
            satisfactionSignals: [],
            scaffoldVersion: null, // Set by caller
            outcome: 'in_progress'
        };

        this.activeSessions.set(agentId, session);
        this.codeModeSessions.add(agentId);
        this.logger.info(`[CodeEvolution] Started recording session for agent "${agentId}"`);
    }

    /**
     * Check if an agent is currently in a code mode session.
     */
    isCodeSession(agentId) {
        return this.codeModeSessions.has(agentId);
    }

    /**
     * Set the scaffold version hash for the current session.
     */
    setScaffoldVersion(agentId, version) {
        const session = this.activeSessions.get(agentId);
        if (session) session.scaffoldVersion = version;
    }

    // -----------------------------------------------------------------------
    // Recording
    // -----------------------------------------------------------------------

    /**
     * Record a tool call during a code session.
     * Called from after_tool_call hook.
     */
    recordToolCall(agentId, toolCall) {
        const session = this.activeSessions.get(agentId);
        if (!session) return;

        if (session.toolCalls.length >= this.config.recording.maxToolCallsPerSession) {
            return; // Cap reached — don't grow unbounded
        }

        session.toolCalls.push({
            toolName: toolCall.toolName,
            params: this._truncate(
                typeof toolCall.params === 'string' ? toolCall.params : JSON.stringify(toolCall.params || {}),
                this.config.recording.resultTruncateChars
            ),
            resultSummary: this._truncate(
                typeof toolCall.result === 'string' ? toolCall.result : JSON.stringify(toolCall.result || ''),
                200
            ),
            success: toolCall.success,
            durationMs: toolCall.durationMs || null,
            turnIndex: session.messageCount,
            timestamp: toolCall.timestamp || Date.now()
        });
    }

    /**
     * Increment message count (called on each user message).
     */
    recordMessage(agentId) {
        const session = this.activeSessions.get(agentId);
        if (session) session.messageCount++;
    }

    // -----------------------------------------------------------------------
    // Finalization
    // -----------------------------------------------------------------------

    /**
     * Finalize and write the session record to disk.
     * Called from agent_end hook.
     */
    finalizeSession(agentId, { signals, entropy } = {}) {
        const session = this.activeSessions.get(agentId);
        if (!session) return null;

        session.endedAt = new Date().toISOString();
        session.entropyHistory = entropy || [];

        if (signals && signals.length > 0) {
            session.satisfactionSignals = signals;
        }

        // Determine outcome
        if (session.messageCount <= 1 && session.toolCalls.length === 0) {
            session.outcome = 'abandoned';
        } else {
            // Check for error-heavy sessions
            const errorRate = session.toolCalls.length > 0
                ? session.toolCalls.filter(tc => !tc.success).length / session.toolCalls.length
                : 0;
            session.outcome = errorRate > 0.5 ? 'error' : 'completed';
        }

        // Write to disk
        const filename = `${session.startedAt.replace(/[:.]/g, '-')}_${session.sessionId}.json`;
        const filepath = path.join(this.sessionsDir, filename);

        try {
            fs.writeFileSync(filepath, JSON.stringify(session, null, 2));
            this.logger.info(
                `[CodeEvolution] Wrote session record: ${filename} ` +
                `(${session.toolCalls.length} tool calls, ${session.satisfactionSignals.length} signals, outcome: ${session.outcome})`
            );
        } catch (err) {
            this.logger.warn(`[CodeEvolution] Failed to write session record: ${err.message}`);
        }

        // Cleanup
        this.activeSessions.delete(agentId);
        this.codeModeSessions.delete(agentId);

        // Prune old sessions
        this._pruneOldSessions();

        return session;
    }

    // -----------------------------------------------------------------------
    // Satisfaction signal detection
    // -----------------------------------------------------------------------

    /**
     * Detect satisfaction signals from conversation messages.
     * Returns array of { type, turnIndex, context }.
     */
    detectSatisfactionSignals(messages) {
        const signals = [];
        let turnIndex = 0;

        for (const msg of messages) {
            if (msg.role !== 'user') continue;
            turnIndex++;

            const content = (msg.content || '').toLowerCase();

            // Positive signals
            for (const pattern of POSITIVE_PATTERNS) {
                if (content.includes(pattern)) {
                    signals.push({
                        type: 'explicit_positive',
                        turnIndex,
                        context: this._truncate(msg.content, 100)
                    });
                    break; // One signal per message
                }
            }

            // Negative signals
            for (const pattern of NEGATIVE_PATTERNS) {
                if (content.includes(pattern)) {
                    signals.push({
                        type: 'explicit_negative',
                        turnIndex,
                        context: this._truncate(msg.content, 100)
                    });
                    break;
                }
            }

            // Correction signals
            for (const pattern of CORRECTION_PATTERNS) {
                if (content.includes(pattern)) {
                    signals.push({
                        type: 'correction',
                        turnIndex,
                        context: this._truncate(msg.content, 100)
                    });
                    break;
                }
            }
        }

        // Abandonment detection: session ends abruptly with many turns but no closing
        if (messages.length > 6) {
            const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
            if (lastUserMsg) {
                const lastContent = (lastUserMsg.content || '').toLowerCase();
                const hasClosing = POSITIVE_PATTERNS.some(p => lastContent.includes(p)) ||
                    lastContent.includes('bye') || lastContent.includes('done') ||
                    lastContent.includes('that\'s all');
                if (!hasClosing) {
                    signals.push({
                        type: 'abandonment',
                        turnIndex: messages.filter(m => m.role === 'user').length,
                        context: 'Session ended without closing signal after multiple turns'
                    });
                }
            }
        }

        return signals;
    }

    // -----------------------------------------------------------------------
    // Query
    // -----------------------------------------------------------------------

    /**
     * Get recent sessions (for pattern analysis).
     * @param {string} agentId
     * @param {number} days - How many days back to look
     * @returns {Array} Parsed session records
     */
    getRecentSessions(agentId, days = 30) {
        const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
        const sessions = [];

        try {
            const files = fs.readdirSync(this.sessionsDir)
                .filter(f => f.endsWith('.json'))
                .sort()
                .reverse(); // Most recent first

            for (const file of files) {
                try {
                    const raw = fs.readFileSync(path.join(this.sessionsDir, file), 'utf8');
                    const session = JSON.parse(raw);

                    // Filter by agent and time
                    if (session.agentId !== agentId && agentId !== '*') continue;
                    const sessionTime = new Date(session.startedAt).getTime();
                    if (sessionTime < cutoff) break; // Files are sorted, can stop early

                    sessions.push(session);
                } catch (e) {
                    // Skip malformed files
                }
            }
        } catch (e) {
            this.logger.warn(`[CodeEvolution] Failed to read sessions dir: ${e.message}`);
        }

        return sessions;
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    _truncate(str, maxLen) {
        if (!str) return '';
        const s = typeof str === 'string' ? str : String(str);
        return s.length > maxLen ? s.slice(0, maxLen) + '...' : s;
    }

    _ensureDir(dir) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    _pruneOldSessions() {
        const retentionMs = this.config.recording.sessionRetentionDays * 24 * 60 * 60 * 1000;
        const cutoff = Date.now() - retentionMs;

        try {
            const files = fs.readdirSync(this.sessionsDir).filter(f => f.endsWith('.json'));
            for (const file of files) {
                const filepath = path.join(this.sessionsDir, file);
                try {
                    const stat = fs.statSync(filepath);
                    if (stat.mtimeMs < cutoff) {
                        fs.unlinkSync(filepath);
                        this.logger.info(`[CodeEvolution] Pruned old session: ${file}`);
                    }
                } catch (e) { /* best effort */ }
            }
        } catch (e) { /* best effort */ }
    }
}

module.exports = SessionRecorder;
