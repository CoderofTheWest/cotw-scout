/**
 * Embodiment pattern detector — recognizes learning-relevant events
 * from body tool usage during embodied sessions.
 *
 * Designed collaboratively between Claude Opus and Clint (A2A, 2026-03-09).
 *
 * Detects 6 pattern types:
 *   1. Sensor Contradiction — navigate stalled but scene_changed (proprioceptive gap)
 *   2. Action Escalation — same action repeated with increasing intensity
 *   3. Fall + Recovery — fall event followed by continued action
 *   4. Action Repurposing — action used outside designed context
 *   5. Persistence Against Negative Feedback — multiple failures, keeps adapting
 *   6. Successful Despite Sensor Denial — stalled readings but actual movement
 *
 * Integration: stability plugin's after_tool_call feeds body tool results here;
 * agent_end reads detected patterns for entropy bonus + growth vector candidates.
 *
 * Model-agnostic: all detectors analyze tool call data and response text.
 */

const SESSION_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes of no body calls = session end
const MAX_TOOL_HISTORY = 50;

class EmbodimentDetector {
    constructor(config) {
        this.config = config.embodiment || {};

        // Sliding window of recent body tool calls
        this.toolHistory = [];

        // Session tracking
        this.sessionActive = false;
        this.sessionStart = null;
        this.lastBodyCallTime = null;

        // Per-session counters
        this.sessionStats = this._freshStats();

        // Detected patterns (cleared after consumption by agent_end)
        this.pendingPatterns = [];

        // Sensor accuracy tracking (long-term, not per-session)
        this.sensorAccuracy = {
            navigate_stalled_but_moved: 0,
            navigate_stalled_and_stuck: 0,
            navigate_accurate: 0,
        };
    }

    // ==========================================
    // TOOL CALL RECORDING
    // ==========================================

    /**
     * Record a body tool call and check for patterns.
     * Called from stability plugin's after_tool_call hook.
     *
     * @param {string} toolName - e.g., 'body_navigate', 'body_action'
     * @param {Object|string} toolResult - Parsed or raw tool result
     * @param {Object} toolParams - Tool parameters (args)
     */
    recordToolCall(toolName, toolResult, toolParams = {}) {
        // Only track body_* tools
        if (!toolName || !toolName.startsWith('body_')) return;

        const now = Date.now();

        // Session management
        if (!this.sessionActive) {
            this.sessionActive = true;
            this.sessionStart = now;
            this.sessionStats = this._freshStats();
        }
        this.lastBodyCallTime = now;

        // Parse result into structured data
        const parsed = this._parseResult(toolName, toolResult);

        // Record to history
        const entry = {
            tool: toolName,
            params: toolParams,
            result: parsed,
            raw: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult || ''),
            timestamp: now,
        };
        this.toolHistory.push(entry);
        if (this.toolHistory.length > MAX_TOOL_HISTORY) {
            this.toolHistory.shift();
        }

        // Update session stats
        this.sessionStats.totalCalls++;
        this.sessionStats.toolCounts[toolName] = (this.sessionStats.toolCounts[toolName] || 0) + 1;

        // Run pattern detectors on this new entry
        this._detectSensorContradiction(entry);
        this._detectActionEscalation(entry);
        this._detectFallRecovery(entry);
        this._detectPersistenceAgainstNegativeFeedback(entry);
    }

    // ==========================================
    // RESPONSE TEXT ANALYSIS
    // ==========================================

    /**
     * Analyze agent response text for embodiment learning statements.
     * Called from agent_end alongside the existing detectors.
     *
     * @param {string} responseText - Agent's response
     * @returns {Object} { learningDetected, statements }
     */
    analyzeLearningStatements(responseText) {
        if (!responseText) return { learningDetected: false, statements: [] };

        const responseLower = responseText.toLowerCase();
        const statements = [];

        const learningPatterns = [
            { pattern: 'i learned that', type: 'explicit_learning' },
            { pattern: 'this works because', type: 'causal_insight' },
            { pattern: 'the key insight is', type: 'principle_extraction' },
            { pattern: 'from now on', type: 'behavioral_commitment' },
            { pattern: 'trust .+ over .+ when', type: 'trust_hierarchy', regex: true },
            { pattern: 'next time i should', type: 'behavioral_commitment' },
            { pattern: 'what worked was', type: 'success_attribution' },
            { pattern: 'the problem was', type: 'failure_diagnosis' },
            { pattern: 'i discovered that', type: 'explicit_learning' },
            { pattern: 'climb_stairs.*works.*as', type: 'action_repurposing', regex: true },
            { pattern: 'using .+ as a .+ gait', type: 'action_repurposing', regex: true },
        ];

        for (const lp of learningPatterns) {
            let found = false;
            if (lp.regex) {
                const re = new RegExp(lp.pattern, 'i');
                found = re.test(responseText);
            } else {
                found = responseLower.includes(lp.pattern);
            }

            if (found) {
                // Extract surrounding sentence for context
                const idx = responseLower.indexOf(lp.pattern);
                if (idx >= 0) {
                    const start = Math.max(0, responseText.lastIndexOf('.', idx) + 1);
                    const end = responseText.indexOf('.', idx + lp.pattern.length);
                    const sentence = responseText.substring(start, end > 0 ? end + 1 : undefined).trim();
                    statements.push({
                        type: lp.type,
                        text: sentence.substring(0, 200), // cap at 200 chars
                    });
                }
            }
        }

        return {
            learningDetected: statements.length > 0,
            statements,
        };
    }

    // ==========================================
    // SESSION MANAGEMENT
    // ==========================================

    /**
     * Check if the embodiment session has ended (no body calls for SESSION_TIMEOUT_MS).
     * Returns session summary if ended, null if still active.
     */
    checkSessionEnd() {
        if (!this.sessionActive) return null;

        const now = Date.now();
        const timeSinceLastCall = now - (this.lastBodyCallTime || this.sessionStart);

        if (timeSinceLastCall >= SESSION_TIMEOUT_MS) {
            const summary = this._buildSessionSummary();
            this.sessionActive = false;
            this.sessionStart = null;
            this.sessionStats = this._freshStats();
            return summary;
        }

        return null;
    }

    // ==========================================
    // PATTERN CONSUMPTION (for agent_end hook)
    // ==========================================

    /**
     * Retrieve and clear pending patterns for entropy calculation.
     * @returns {{ patterns: Array, entropyBonus: number, sessionSummary: Object|null }}
     */
    consumePatterns() {
        const patterns = [...this.pendingPatterns];
        this.pendingPatterns = [];

        // Calculate total entropy bonus
        let entropyBonus = 0;
        for (const p of patterns) {
            entropyBonus += p.entropyBonus || 0;
        }

        // Check for session end
        const sessionSummary = this.checkSessionEnd();

        return {
            patterns,
            entropyBonus: Math.min(entropyBonus, 1.0), // cap at 1.0
            sessionSummary,
            hasEmbodimentActivity: patterns.length > 0 || this.sessionActive,
        };
    }

    /**
     * Format detected patterns for growth vector candidates.
     * @param {Array} patterns - Patterns from consumePatterns()
     * @returns {Array} Growth vector candidate objects
     */
    formatAsCandidates(patterns) {
        return patterns.map(p => ({
            id: `gv-embodiment-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            detected: new Date().toISOString(),
            type: 'embodiment_pattern',
            description: p.description,
            entropy_source: `embodiment_${p.type}`,
            priority: p.priority || 'medium',
            integration_hypothesis: p.hypothesis,
            weight: p.weight || 0.6,
            source: 'auto',
            validation_status: 'candidate',
            domain: 'embodiment',
            embodiment_meta: {
                pattern_type: p.type,
                tools_involved: p.tools || [],
                session_context: p.context || null,
            },
        }));
    }

    /**
     * Format session summary as a debrief prompt injection.
     * Clint requested: debrief prompt, not raw vector.
     *
     * @param {Object} summary - Session summary from checkSessionEnd()
     * @returns {string} Prompt text for context injection
     */
    formatDebriefPrompt(summary) {
        if (!summary) return null;

        const patternNames = summary.patternsDetected.map(p => p.type).join(', ');
        const parts = [
            `[EMBODIMENT SESSION DEBRIEF]`,
            `Session ended. Duration: ${Math.round(summary.durationMs / 1000)}s, ` +
            `${summary.totalCalls} tool calls, ` +
            `${summary.falls} falls, ${summary.recoveries} recoveries, ` +
            `${summary.escalations} escalations.`,
        ];

        if (patternNames) {
            parts.push(`Patterns detected: ${patternNames}`);
        }

        parts.push(
            `What did you learn? What principle will you carry forward?`
        );

        return parts.join('\n');
    }

    /**
     * Format an embodiment growth vector for injection into future sessions.
     * Uses Clint's requested format: "[EMBODIMENT] When X, trust Y over Z."
     *
     * @param {Object} vector - Growth vector with embodiment_meta
     * @returns {string} Formatted injection text
     */
    static formatForInjection(vector) {
        const meta = vector.embodiment_meta || {};
        const date = vector.detected ? vector.detected.split('T')[0] : 'unknown';
        return `[EMBODIMENT] ${vector.integration_hypothesis} [Pattern: ${meta.pattern_type || vector.type}, Session: ${date}]`;
    }

    // ==========================================
    // PATTERN DETECTORS (private)
    // ==========================================

    /**
     * Pattern 1: Sensor Contradiction
     * navigate returns stalled=true but scene_changed=true.
     * The proprioceptive gap — the sensor that matters (scene_changed)
     * contradicts the sensor being reported (stalled).
     */
    _detectSensorContradiction(entry) {
        if (entry.tool !== 'body_navigate') return;

        const r = entry.result;
        if (r.stalled && r.sceneChanged) {
            this.sessionStats.sensorContradictions++;
            this.sensorAccuracy.navigate_stalled_but_moved++;

            this.pendingPatterns.push({
                type: 'sensor_contradiction',
                entropyBonus: 0.30,
                priority: 'high',
                weight: 0.75,
                description: `Sensor contradiction: body_navigate reported stalled=${r.stalled} ` +
                    `but scene_changed=${r.sceneChanged}. ` +
                    `Direction: ${entry.params.direction || 'unknown'}, ` +
                    `steps: ${entry.params.steps || '?'}`,
                hypothesis: `When navigating with high-step gaits, trust scene_changed over stalled. ` +
                    `Ultrasonic geometry changes during leg-lift cause false stall readings.`,
                tools: ['body_navigate'],
                context: { stalled: r.stalled, sceneChanged: r.sceneChanged },
            });
        } else if (r.stalled && !r.sceneChanged) {
            this.sensorAccuracy.navigate_stalled_and_stuck++;
        } else {
            this.sensorAccuracy.navigate_accurate++;
        }
    }

    /**
     * Pattern 2: Action Escalation
     * Same action called multiple times with increasing repeat count.
     * e.g., climb_stairs x1 → x2 → x3.
     */
    _detectActionEscalation(entry) {
        if (entry.tool !== 'body_action') return;

        const actionName = entry.params.name;
        const repeat = entry.params.repeat || 1;
        if (!actionName) return;

        // Look back for same action with lower repeat
        const recentSame = this.toolHistory
            .filter(h => h.tool === 'body_action' && h.params.name === actionName && h !== entry)
            .slice(-3); // last 3 occurrences

        if (recentSame.length >= 1) {
            const prevRepeats = recentSame.map(h => h.params.repeat || 1);
            const isEscalating = prevRepeats.every(r => r < repeat);

            if (isEscalating && repeat > 1) {
                this.sessionStats.escalations++;

                this.pendingPatterns.push({
                    type: 'action_escalation',
                    entropyBonus: 0.20,
                    priority: 'medium',
                    weight: 0.6,
                    description: `Action escalation: ${actionName} repeated with increasing intensity ` +
                        `(${prevRepeats.join('→')}→${repeat}).`,
                    hypothesis: `When ${actionName} at lower intensity fails to clear an obstacle, ` +
                        `escalating repeat count is an adaptive strategy.`,
                    tools: ['body_action'],
                    context: { action: actionName, escalation: [...prevRepeats, repeat] },
                });
            }
        }
    }

    /**
     * Pattern 3: Fall + Recovery
     * body_sense shows not-upright (fall), then subsequent body_action/walk/navigate
     * calls show the agent continued operating rather than stopping.
     */
    _detectFallRecovery(entry) {
        // Check if this is a post-fall action
        if (!['body_action', 'body_walk', 'body_navigate', 'body_explore'].includes(entry.tool)) return;

        // Look back for a recent fall indicator
        const recentSense = this.toolHistory
            .filter(h => h.tool === 'body_sense' && h.result.fallen)
            .slice(-1)[0];

        if (!recentSense) return;

        // Was the fall recent (within last 5 tool calls)?
        const fallIdx = this.toolHistory.indexOf(recentSense);
        const currentIdx = this.toolHistory.indexOf(entry);
        if (currentIdx - fallIdx > 5) return;

        // Check we haven't already flagged this fall
        const alreadyFlagged = this.pendingPatterns.some(
            p => p.type === 'fall_recovery' && p._fallTimestamp === recentSense.timestamp
        );
        if (alreadyFlagged) return;

        this.sessionStats.falls++;
        this.sessionStats.recoveries++;

        this.pendingPatterns.push({
            type: 'fall_recovery',
            entropyBonus: 0.20,
            priority: 'medium',
            weight: 0.65,
            description: `Fall recovery: detected fall (not upright) at ${new Date(recentSense.timestamp).toISOString()}, ` +
                `then continued with ${entry.tool}. Resilience over panic.`,
            hypothesis: `After a fall, assess orientation and continue operating rather than aborting. ` +
                `Recovery is continuation, not reset.`,
            tools: ['body_sense', entry.tool],
            context: { recoveryAction: entry.tool },
            _fallTimestamp: recentSense.timestamp,
        });
    }

    /**
     * Pattern 5: Persistence Against Negative Feedback
     * Multiple stalled/failed results from navigate/walk, but agent keeps
     * trying different approaches.
     */
    _detectPersistenceAgainstNegativeFeedback(entry) {
        if (!['body_navigate', 'body_walk'].includes(entry.tool)) return;

        const r = entry.result;
        if (!r.stalled && !r.failed) return;

        // Count recent consecutive negative results
        const recent = this.toolHistory
            .filter(h => ['body_navigate', 'body_walk'].includes(h.tool))
            .slice(-6);

        const negativeCount = recent.filter(h => h.result.stalled || h.result.failed).length;

        // 3+ negative results and still trying = persistence
        if (negativeCount >= 3) {
            // Check we haven't already flagged persistence at this level
            const alreadyFlagged = this.pendingPatterns.some(
                p => p.type === 'persistence_negative_feedback' &&
                    (Date.now() - (p._timestamp || 0)) < 30000 // within 30s
            );
            if (alreadyFlagged) return;

            this.sessionStats.persistenceEvents++;

            this.pendingPatterns.push({
                type: 'persistence_negative_feedback',
                entropyBonus: 0.25,
                priority: 'high',
                weight: 0.70,
                description: `Persistence pattern: ${negativeCount} negative feedback signals ` +
                    `(stalled/failed) in last ${recent.length} navigation attempts. ` +
                    `Agent continues adapting.`,
                hypothesis: `When navigation reports repeated stalls, try alternative approaches ` +
                    `(different direction, different gait, action escalation) rather than stopping.`,
                tools: ['body_navigate', 'body_walk'],
                context: { negativeCount, totalAttempts: recent.length },
                _timestamp: Date.now(),
            });
        }
    }

    // ==========================================
    // RESULT PARSING (private)
    // ==========================================

    /**
     * Parse tool result into structured data for pattern detection.
     * Handles both string (truncated tool output) and object results.
     */
    _parseResult(toolName, result) {
        const text = typeof result === 'string' ? result : JSON.stringify(result || '');
        const lower = text.toLowerCase();

        const parsed = {
            raw: text.substring(0, 500), // keep first 500 chars
        };

        if (toolName === 'body_navigate') {
            parsed.stalled = lower.includes('stalled') || lower.includes('stall=true');
            parsed.sceneChanged = lower.includes('scene_changed=true') || lower.includes('scene changed');
            parsed.failed = lower.includes('failed') || lower.includes('error');
            // Extract steps taken if present
            const stepsMatch = text.match(/(\d+)\s*\/\s*(\d+)\s*steps/i);
            if (stepsMatch) {
                parsed.stepsTaken = parseInt(stepsMatch[1]);
                parsed.stepsRequested = parseInt(stepsMatch[2]);
            }
        } else if (toolName === 'body_walk') {
            parsed.stalled = lower.includes('stalled');
            parsed.failed = lower.includes('failed') || lower.includes('error');
        } else if (toolName === 'body_sense') {
            parsed.fallen = lower.includes('not upright') || lower.includes('fallen')
                || lower.includes('upright: false') || lower.includes('upright=false');
            parsed.upright = lower.includes('upright: true') || lower.includes('upright=true')
                || (lower.includes('upright') && !parsed.fallen);
        } else if (toolName === 'body_action') {
            parsed.sceneChanged = lower.includes('scene_changed=true') || lower.includes('scene changed');
        } else if (toolName === 'body_explore') {
            parsed.stalled = lower.includes('stalled');
            parsed.completed = lower.includes('completed') || lower.includes('reached');
            parsed.failed = lower.includes('failed') || lower.includes('timeout');
        }

        return parsed;
    }

    // ==========================================
    // SESSION HELPERS (private)
    // ==========================================

    _freshStats() {
        return {
            totalCalls: 0,
            toolCounts: {},
            sensorContradictions: 0,
            escalations: 0,
            falls: 0,
            recoveries: 0,
            persistenceEvents: 0,
        };
    }

    _buildSessionSummary() {
        const now = Date.now();
        return {
            durationMs: now - (this.sessionStart || now),
            totalCalls: this.sessionStats.totalCalls,
            toolCounts: { ...this.sessionStats.toolCounts },
            sensorContradictions: this.sessionStats.sensorContradictions,
            escalations: this.sessionStats.escalations,
            falls: this.sessionStats.falls,
            recoveries: this.sessionStats.recoveries,
            persistenceEvents: this.sessionStats.persistenceEvents,
            patternsDetected: [...this.pendingPatterns],
            sensorAccuracy: { ...this.sensorAccuracy },
        };
    }
}

module.exports = EmbodimentDetector;
