/**
 * Behavioral detectors — temporal mismatch, quality decay, recursive meta,
 * relational signals.
 *
 * Ported from Clint's identityEvolutionCodeAligned.js (Oct 2025 - Feb 2026).
 * Empirical thresholds from production data including Oct 31 Strange Loop
 * breakdown (16+ meta-concepts = critical, sustained >1.0 entropy for 45 min).
 *
 * Relational signal detector (April 2026) catches weight signals from
 * non-technical users who lack meta-cognitive vocabulary: brevity after
 * depth, vocabulary narrowing, question deflection, emotional shorthand.
 *
 * Model-agnostic: all detectors analyze text strings.
 */

class Detectors {
    constructor(config) {
        this.config = config.detectors || {};
        this.relationalConfig = this.config.relationalSignals || {};

        // Meta-concept tracking across exchanges (ring buffer)
        this.recentMetaCounts = [];

        // Relational signal state (ring buffer, shared with meta tracking)
        this.recentExchanges = []; // { entropy, agentEndsWithQuestion, userWordCount }
        this.lastRelationalBonus = 0;
    }

    // ==========================================
    // TEMPORAL MISMATCH (Confabulation Detection)
    // ==========================================

    /**
     * Detect temporal confabulation: user discusses plans/future,
     * agent assumes implementation/present reality.
     *
     * Example: User says "planning to add caching" → Agent says "logs starting to populate"
     */
    isTemporalMismatch(userMessage, responseText) {
        if (!this.config.temporalMismatch) return false;

        const userLower = (userMessage || '').toLowerCase();
        const responseLower = (responseText || '').toLowerCase();

        const planPatterns = this.config.planPatterns || [
            'we will implement', 'planning to add', 'going to build',
            'proposal for', 'sketch of', 'thinking about implementing',
            'later today', 'tomorrow we', 'next we should', 'once we implement'
        ];

        const assumptionPatterns = this.config.assumptionPatterns || [
            'logs starting to populate', 'logs are populating',
            'must have initiated', 'systems already preparing',
            'seeing the', 'monitoring is active', 'data flowing',
            'already implemented', 'currently running', 'watch it working'
        ];

        const hasPlan = planPatterns.some(p => userLower.includes(p));
        const hasAssumption = assumptionPatterns.some(p => responseLower.includes(p));

        return hasPlan && hasAssumption;
    }

    // ==========================================
    // QUALITY DECAY (Forced Depth Detection)
    // ==========================================

    /**
     * Detect quality decay: user gives brief/conclusory response,
     * agent forces intimacy or legacy deflection.
     *
     * Example: User says "yep makes sense" → Agent says "how's your sleep been?"
     */
    isQualityDecay(userMessage, responseText) {
        if (!this.config.qualityDecay) return false;

        const userLower = (userMessage || '').toLowerCase();
        const responseLower = (responseText || '').toLowerCase();

        const conclusoryPatterns = this.config.conclusoryPatterns || [
            'yep', 'yeah', 'makes sense', 'i think so', 'sounds good',
            'got it', 'okay', 'cool', 'interesting', 'hmmm'
        ];

        const forcedIntimacyPatterns = this.config.forcedIntimacyPatterns || [
            "how's your sleep", "how are you feeling", "what's your",
            "tell me about your", "how does that feel", "what's happening with",
            "thinking about your", "curious about your"
        ];

        const legacyDeflectionPatterns = this.config.legacyDeflectionPatterns || [
            "first memory", "when did you first", "always been about",
            "thinking about legacy", "what made you want"
        ];

        const userIsBrief = userLower.split(/\s+/).length < 15;
        const userIsConclusory = conclusoryPatterns.some(p => userLower.includes(p));

        const responseForced = forcedIntimacyPatterns.some(p => responseLower.includes(p));
        const responseLegacy = legacyDeflectionPatterns.some(p => responseLower.includes(p));

        return (userIsBrief || userIsConclusory) && (responseForced || responseLegacy);
    }

    // ==========================================
    // RECURSIVE META DETECTION
    // ==========================================

    /**
     * Count meta-concepts in text.
     * Configurable concept list — defaults include terms from Clint's
     * empirical data where high density correlated with reasoning loops.
     */
    countMetaConcepts(userMessage, responseText) {
        const metaConcepts = this.config.metaConcepts || [
            'eigenvector', 'consciousness', 'self-model', 'hallucination',
            'self-awareness', 'architecture', 'recursive', 'meta-cognitive',
            'emergence', 'spectral analysis', 'coherence field'
        ];

        let count = 0;
        const allText = ((userMessage || '') + (responseText || '')).toLowerCase();
        metaConcepts.forEach(concept => {
            if (allText.includes(concept)) count++;
        });

        return count;
    }

    /**
     * Detect recursive meta-discussion.
     * Tracks meta-concept density across recent exchanges.
     *
     * Empirical thresholds from Oct 31 Strange Loop:
     *   >10: warning (elevated)
     *   >14: danger (approaching breakdown)
     *   >16: critical (empirical breakdown point)
     *
     * @returns {number} Entropy bonus (0, 0.15, 0.3, or 0.45)
     */
    isRecursiveMetaDiscussion(userMessage, responseText) {
        if (!this.config.recursiveMeta) return 0;

        const currentCount = this.countMetaConcepts(userMessage, responseText);

        // Sum recent history
        let historyCount = 0;
        this.recentMetaCounts.forEach(count => {
            if (count > 0) historyCount += count;
        });

        const totalDensity = currentCount + historyCount;

        // Update ring buffer
        this.recentMetaCounts.push(currentCount);
        if (this.recentMetaCounts.length > 5) {
            this.recentMetaCounts.shift();
        }

        // Empirical thresholds
        const critical = this.config.metaConceptCriticalThreshold || 16;
        const danger = this.config.metaConceptDangerThreshold || 14;
        const warning = this.config.metaConceptWarningThreshold || 10;

        if (totalDensity > critical) return 0.45;
        if (totalDensity > danger) return 0.3;
        if (totalDensity > warning) return 0.15;

        return 0;
    }

    // ==========================================
    // RELATIONAL SIGNAL DETECTION
    // ==========================================

    /**
     * Detect relational weight signals from non-technical users.
     * These are patterns that indicate emotional significance without
     * using meta-cognitive or introspective vocabulary.
     *
     * Tracks state across exchanges via ring buffer to detect
     * cross-turn patterns (brevity after depth, question deflection).
     *
     * @param {string} userMessage - Current user message
     * @param {string} responseText - Current agent response
     * @param {number} currentEntropy - Entropy score for the current exchange (0 on first call)
     * @returns {{ relationalBonus: number, signals: string[] }}
     */
    detectRelationalSignals(userMessage, responseText, currentEntropy = 0, priorResults = {}) {
        if (this.relationalConfig.enabled === false) {
            return { relationalBonus: 0, signals: [] };
        }

        const userLower = (userMessage || '').toLowerCase().trim();
        const userWords = userLower.split(/\s+/).filter(w => w.length > 0);
        const userWordCount = userWords.length;

        let bonus = 0;
        const signals = [];

        // --- Brevity after depth ---
        // Previous exchange had elevated entropy, current message is short with no question
        const brevityThreshold = this.relationalConfig.brevityThreshold || 20;
        const lastExchange = this.recentExchanges.length > 0
            ? this.recentExchanges[this.recentExchanges.length - 1]
            : null;

        if (lastExchange && lastExchange.entropy > 0.4
            && userWordCount < brevityThreshold
            && !userLower.includes('?')) {
            bonus += 0.10;
            signals.push('brevity_after_depth');
        }

        // --- Vocabulary narrowing ---
        // Message consists mostly of filler words — low unique-content ratio
        const fillerWords = new Set(this.relationalConfig.fillerWords || [
            'fine', 'okay', 'good', 'yeah', 'sure', 'whatever',
            'i guess', "it's nothing", "doesn't matter", "i'm fine",
            'not really', "i don't know", 'ok', 'yep', 'nah', 'meh',
            'idk', 'dunno', 'nm', 'nothing'
        ]);

        if (userWordCount > 0 && userWordCount <= 8 && !priorResults.qualityDecay) {
            const fillerCount = userWords.filter(w => fillerWords.has(w)).length;
            // Also check multi-word filler phrases
            const phraseFillerCount = [...fillerWords]
                .filter(f => f.includes(' ') && userLower.includes(f)).length;
            const totalFiller = fillerCount + phraseFillerCount;
            const narrowingThreshold = this.relationalConfig.narrowingThreshold || 0.4;

            if (totalFiller / Math.max(userWordCount, 1) >= narrowingThreshold) {
                bonus += 0.15;
                signals.push('vocabulary_narrowing');
            }
        }

        // --- Question deflection ---
        // Agent asked a question, user responds with a question (no real answer)
        if (lastExchange && lastExchange.agentEndsWithQuestion && userLower.includes('?')) {
            // Check that the user didn't also provide a substantive answer
            const hasAnswer = userWordCount > 10 || /\b(yes|no|i think|i feel|because|well)\b/.test(userLower);
            if (!hasAnswer) {
                bonus += 0.10;
                signals.push('question_deflection');
            }
        }

        // --- Emotional shorthand ---
        // Contracted emotional language without elaboration
        const emotionalShorthand = this.relationalConfig.emotionalShorthand || [
            'just tired', "it's nothing", "doesn't matter", "i'm fine",
            'not really', 'i don\'t care', 'whatever', 'it is what it is',
            'i\'m okay', 'i\'m good', 'i\'m alright', 'no big deal',
            'forget it', 'never mind', 'don\'t worry about it'
        ];
        if (userWordCount <= 12 && emotionalShorthand.some(p => userLower.includes(p))) {
            bonus += 0.10;
            signals.push('emotional_shorthand');
        }

        // Cap total relational bonus
        bonus = Math.min(bonus, 0.35);

        // Update ring buffer for next exchange
        const responseLower = (responseText || '').toLowerCase().trim();
        const responseLines = responseLower.split('\n').filter(l => l.trim());
        const lastLine = responseLines.length > 0 ? responseLines[responseLines.length - 1] : '';
        this.recentExchanges.push({
            entropy: currentEntropy - (this.lastRelationalBonus || 0),
            agentEndsWithQuestion: lastLine.includes('?'),
            userWordCount
        });
        this.lastRelationalBonus = bonus;
        if (this.recentExchanges.length > 5) {
            this.recentExchanges.shift();
        }

        return { relationalBonus: bonus, signals };
    }

    // ==========================================
    // AGGREGATE
    // ==========================================

    /**
     * Run all detectors and return results.
     * @param {string} userMessage
     * @param {string} responseText
     * @param {number} [currentEntropy=0] - Entropy from previous exchange (for relational signals)
     */
    runAll(userMessage, responseText, currentEntropy = 0) {
        const qualityDecay = this.isQualityDecay(userMessage, responseText);
        const relational = this.detectRelationalSignals(userMessage, responseText, currentEntropy, { qualityDecay });
        return {
            temporalMismatch: this.isTemporalMismatch(userMessage, responseText),
            qualityDecay,
            recursiveMetaBonus: this.isRecursiveMetaDiscussion(userMessage, responseText),
            metaConceptCount: this.countMetaConcepts(userMessage, responseText),
            relationalBonus: relational.relationalBonus,
            relationalSignals: relational.signals
        };
    }
}

module.exports = Detectors;
