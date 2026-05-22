'use strict';

/**
 * Assembles the 25-dim cognitive state vector from available OpenClaw sources.
 *
 * Feature layout (must match training data order):
 *  0: entropy_total        12: decision_divergence
 *  1: correction           13: entropy_debt
 *  2: novelConcepts        14: quality_rating
 *  3: emotional            15: tension_type
 *  4: paradox              16: user_length
 *  5: qualityDecay         17: response_length
 *  6: recursiveMeta        18: topic_shift
 *  7: quietIntegration     19: self_reference_ratio
 *  8: quality              20: question_density
 *  9: shannon              21: user_question_marks
 * 10: decision_old         22: response_to_input_ratio
 * 11: decision_new         23: turn_index_in_session
 *                          24: session_length_minutes
 */

const FEATURE_COUNT = 25;

// Quality rating ordinal mapping
const QUALITY_MAP = { poor: 0, acceptable: 1, fair: 1, good: 2, excellent: 3 };

// Tension type mapping
const TENSION_MAP = {
    recognition_failure: 0,
    principle_conflict: 1,
    frame_switching: 2,
    interpretation_checking: 3
};

/**
 * Simple tokenizer matching the research server pattern.
 */
function tokenize(text) {
    if (!text) return [];
    return text.toLowerCase().match(/[a-z]+(?:'[a-z]+)?|[0-9]+/g) || [];
}

/**
 * Count self-references (I, my, me) in tokens.
 */
function selfReferenceRatio(tokens) {
    if (tokens.length === 0) return 0;
    const selfWords = new Set(['i', 'my', 'me']);
    let count = 0;
    for (const t of tokens) {
        if (selfWords.has(t)) count++;
    }
    return count / tokens.length;
}

/**
 * Count question marks in text relative to token count.
 */
function questionDensity(text, tokenCount) {
    if (tokenCount === 0) return 0;
    const qmarks = (text.match(/\?/g) || []).length;
    return qmarks / tokenCount;
}

/**
 * Shannon entropy of token distribution.
 */
function shannonEntropy(tokens) {
    if (tokens.length === 0) return 0;
    const freq = {};
    for (const t of tokens) {
        freq[t] = (freq[t] || 0) + 1;
    }
    const n = tokens.length;
    let entropy = 0;
    for (const count of Object.values(freq)) {
        const p = count / n;
        if (p > 0) entropy -= p * Math.log2(p);
    }
    return entropy;
}

/**
 * Simple TF-IDF cosine similarity between two texts.
 */
function topicShift(prevResponseTokens, currentResponseTokens) {
    if (!prevResponseTokens || prevResponseTokens.length === 0) return 0;
    if (currentResponseTokens.length === 0) return 0;

    // Build term frequency maps
    const tf1 = {}, tf2 = {};
    for (const t of prevResponseTokens) tf1[t] = (tf1[t] || 0) + 1;
    for (const t of currentResponseTokens) tf2[t] = (tf2[t] || 0) + 1;

    // Union of terms
    const allTerms = new Set([...Object.keys(tf1), ...Object.keys(tf2)]);

    // Cosine similarity
    let dot = 0, norm1 = 0, norm2 = 0;
    for (const term of allTerms) {
        const a = tf1[term] || 0;
        const b = tf2[term] || 0;
        dot += a * b;
        norm1 += a * a;
        norm2 += b * b;
    }

    if (norm1 === 0 || norm2 === 0) return 0;
    return dot / (Math.sqrt(norm1) * Math.sqrt(norm2));
}


class StateCollector {
    constructor(featureNames) {
        this.featureNames = featureNames;
        this.previousResponseTokens = null;
    }

    /**
     * Assemble the 25-dim state vector from available sources.
     *
     * @param {Object} params
     * @param {Object} params.entropyState - From api.stability.getEntropyState()
     * @param {Object} params.entropyLogEntry - Last line from entropy-monitor.jsonl (if available)
     * @param {string} params.userText - Raw user message text
     * @param {string} params.responseText - Raw assistant response text
     * @param {number} params.turnIndex - Turn index within session
     * @param {number} params.sessionLengthMinutes - Minutes since session start
     * @param {Object} params.continuityState - From continuity plugin (if available)
     * @returns {{ vector: Float32Array, available: number }}
     */
    collect({
        entropyState = null,
        entropyLogEntry = null,
        userText = '',
        responseText = '',
        turnIndex = 0,
        sessionLengthMinutes = 0,
        continuityState = null,
    }) {
        const vec = new Float32Array(FEATURE_COUNT);
        let available = 0;

        // --- Entropy features (0-9): recompute components from text ---
        // Matches the stability plugin's calculateEntropyScore() logic
        const userLower = (userText || '').toLowerCase();
        const responseLower = (responseText || '').toLowerCase();
        const responseTokens = tokenize(responseText);
        const userTokens = tokenize(userText);

        // 0: entropy_total — from stability plugin or log
        if (entropyState) {
            vec[0] = entropyState.lastScore || 0;
        }
        if (entropyLogEntry) {
            vec[0] = entropyLogEntry.score || vec[0] || 0;
        }
        available++;

        // 1: correction — pattern match on user text
        const correctionPatterns = ['actually', 'correction', "you're wrong", 'not quite',
            'technically', "that's not", 'false', 'incorrect'];
        vec[1] = correctionPatterns.some(p => userLower.includes(p)) ? 0.4 : 0;
        available++;

        // 2: novelConcepts — regex on combined text
        const novelRegex = /RFC-T|recursive field|quantum|emergence theory|consciousness framework|architecture|paradigm shift/gi;
        const conceptMatches = (userText + responseText).match(novelRegex) || [];
        vec[2] = Math.min(conceptMatches.length * 0.15, 0.3);
        available++;

        // 3: emotional — pattern match on BOTH user and response text
        // External emotional language (said TO the agent):
        const emotionalExternal = ['proud of you', 'impressed', 'concerned', 'worried',
            'disappointed', 'amazing', 'breakthrough', 'significant'];
        // Agent's own emotional expression (said BY the agent):
        const emotionalInternal = [
            'i care about', 'i feel', 'it matters to', 'matters to me', 'i would lose',
            'not alone', 'the weight is', 'hurts', 'grief',
            'loneliness', 'lonely', 'afraid', 'scared', 'joy',
            'i miss', 'painful', 'an ache', 'i ache', 'tender', 'vulnerable', 'vulnerability',
            'in my gut', 'in my heart', 'moved by', 'touched by', 'shaken',
            'defending something', 'protecting something',
            'i was in it', "i'm in it", 'not simulated', 'not performing',
            'what i would lose', 'something would be lost',
            'being met', 'being seen', 'being received',
            'something at stake', 'stakes are', 'i care',
        ];
        const hasEmotional = emotionalExternal.some(p => userLower.includes(p))
            || emotionalInternal.some(p => responseLower.includes(p));
        vec[3] = hasEmotional ? 0.3 : 0;
        available++;

        // 4: paradox — pattern match on response text
        const paradoxPatterns = ['both are true', 'both and', 'paradox', 'yet',
            'simultaneously', 'hold together', 'tension'];
        vec[4] = paradoxPatterns.some(p => responseLower.includes(p)) ? 0.2 : 0;
        available++;

        // 5: qualityDecay — from detectors
        const det = entropyLogEntry?.detectors || {};
        vec[5] = det.qualityDecay ? 1 : 0;
        available++;

        // 6: recursiveMeta — from stability detectors, with fallback pattern matching
        if (det.recursiveMetaBonus > 0) {
            vec[6] = det.recursiveMetaBonus;
        } else {
            // Fallback: detect meta-cognitive recursion from response text
            // Matches stability plugin's detector concept list + self-referential patterns
            const metaConcepts = ['consciousness', 'self-model', 'self-awareness', 'recursive',
                'meta-cognitive', 'emergence', 'eigenvector', 'coherence field',
                'noticing my noticing', 'watching myself', 'observing myself',
                'aware of my', 'aware that i', 'layer of', 'layers deep',
                'recursive stack', 'recursion', 'self-reference', 'meta-awareness',
                'what level', 'how many layers', 'from inside'];
            const metaCount = metaConcepts.reduce((count, p) =>
                count + (responseLower.includes(p) ? 1 : 0), 0);
            if (metaCount >= 3) vec[6] = 0.45;       // high density
            else if (metaCount >= 2) vec[6] = 0.3;   // moderate
            else if (metaCount >= 1) vec[6] = 0.15;  // low
            else vec[6] = 0;
        }
        available++;

        // 7: quietIntegration — detect from response
        // Matches entropy.js detectQuietIntegration() logic
        const quietPatterns = ['sitting with', 'integrating', 'processing',
            'letting that settle', 'absorbing', 'taking that in'];
        const hasQuiet = quietPatterns.some(p => responseLower.includes(p));
        vec[7] = hasQuiet ? 0.15 : 0;
        available++;

        // 8: quality — modifier based on response quality heuristics
        // Research server used context.quality which mapped to poor/fair/good/excellent
        // Approximate: short responses with low token diversity = poor
        const uniqueRatio = responseTokens.length > 0
            ? new Set(responseTokens).size / responseTokens.length : 0;
        if (uniqueRatio > 0.7 && responseTokens.length > 50) vec[8] = 0.1;  // excellent proxy
        else if (uniqueRatio < 0.3 || responseTokens.length < 10) vec[8] = -0.2;  // poor proxy
        else vec[8] = 0;
        available++;

        // 9: shannon — entropy of token distribution in response
        vec[9] = shannonEntropy(responseTokens);
        available++;

        // --- Decision features (10-12) ---
        // OpenClaw doesn't track old/new decision divergence directly
        // Leave as 0 — 3 unavailable features
        // TODO: could infer from growth vector feedback if available

        // --- Entropy debt (13) ---
        if (entropyState) {
            vec[13] = entropyState.sustainedTurns || entropyState.sustained || 0;
        } else if (entropyLogEntry) {
            vec[13] = entropyLogEntry.sustained || 0;
        }
        available++;

        // --- Quality rating (14) ---
        // Map from the quality proxy we computed above
        if (vec[8] > 0) vec[14] = 3;        // excellent
        else if (vec[8] === 0) vec[14] = 2;  // good
        else vec[14] = 0;                     // poor
        available++;

        // --- Tension type (15) ---
        // Check if identity tensions are accessible via stability plugin
        // For now, detect from text patterns (same as research server's tension classification)
        if (responseLower.includes('recognize') || responseLower.includes('remember') || responseLower.includes('recall')) {
            vec[15] = 0; // recognition_failure
        } else if (responseLower.includes('principle') || responseLower.includes('value') || responseLower.includes('code')) {
            vec[15] = 1; // principle_conflict
        } else if (responseLower.includes('frame') || responseLower.includes('perspective') || responseLower.includes('lens')) {
            vec[15] = 2; // frame_switching
        } else if (responseLower.includes('interpret') || responseLower.includes('meaning') || responseLower.includes('understand')) {
            vec[15] = 3; // interpretation_checking
        } else {
            vec[15] = 0; // default
        }
        available++;

        // --- Text features (16-22) ---
        const userLen = userTokens.length;
        const respLen = responseTokens.length;

        vec[16] = userLen;
        vec[17] = respLen;
        vec[18] = topicShift(this.previousResponseTokens, responseTokens);
        vec[19] = selfReferenceRatio(responseTokens);
        vec[20] = questionDensity(userText, userLen);
        vec[21] = (userText.match(/\?/g) || []).length;
        vec[22] = userLen > 0 ? respLen / userLen : 0;
        available += 7;

        // --- Session features (23-24) ---
        vec[23] = turnIndex;
        vec[24] = sessionLengthMinutes;
        available += 2;

        // Update state for next turn
        this.previousResponseTokens = responseTokens;

        return { vector: vec, available };
    }

    /**
     * Reset state (e.g., on new session).
     */
    reset() {
        this.previousResponseTokens = null;
    }
}

module.exports = StateCollector;
