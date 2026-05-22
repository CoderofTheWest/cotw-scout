/**
 * Anticipator — JEPA-modulated proactive insight surfacing.
 *
 * On every turn, compares the user's message against completed contemplation
 * insights indexed in continuity's vec_knowledge. When a strong semantic match
 * is found, surfaces a brief note so the agent can reference prior thinking.
 *
 * JEPA integration: Uses the cognitive dynamics plugin's surprise signal to
 * modulate the retrieval threshold. High surprise (phase transition detected)
 * → lower threshold (cast wider net). Low surprise (grounded state) → higher
 * threshold (only very strong matches). This makes anticipation adaptive rather
 * than threshold-static.
 *
 * Latency budget: ~10ms (embedding reuse from continuity + SQLite-vec query).
 * No LLM call. Safe to run on every turn.
 */

// Default thresholds — distance-based (lower = more similar)
// These get modulated by JEPA surprise
const BASE_THRESHOLD = 0.75;       // Default: match if distance < 0.75
const HIGH_SURPRISE_THRESHOLD = 0.90;  // Wider net when surprised (distance < 0.90)
const LOW_SURPRISE_THRESHOLD = 0.60;   // Tighter when grounded (distance < 0.60)

// JEPA surprise thresholds
const SURPRISE_HIGH = 0.5;   // Above this = high surprise (phase transition)
const SURPRISE_LOW = 0.15;   // Below this = low surprise (grounded)

/**
 * Compute adaptive threshold based on JEPA surprise signal.
 * @param {object|null} surprise - { frozen, learned } from cognitive dynamics
 * @returns {number} distance threshold for insight matching
 */
function computeThreshold(surprise) {
    if (!surprise || surprise.frozen == null) {
        return BASE_THRESHOLD; // No JEPA data → use default
    }

    const s = surprise.frozen; // Use frozen predictor (trained baseline)

    if (s > SURPRISE_HIGH) {
        // Phase transition — something unexpected. Cast wider net.
        return HIGH_SURPRISE_THRESHOLD;
    }
    if (s < SURPRISE_LOW) {
        // Grounded, predictable turn. Only surface very strong matches.
        return LOW_SURPRISE_THRESHOLD;
    }

    // Linear interpolation between low and high thresholds
    const t = (s - SURPRISE_LOW) / (SURPRISE_HIGH - SURPRISE_LOW);
    return LOW_SURPRISE_THRESHOLD + t * (HIGH_SURPRISE_THRESHOLD - LOW_SURPRISE_THRESHOLD);
}

/**
 * Search for contemplation insights matching the user's message.
 *
 * @param {string} agentId
 * @param {string} userMessage - raw user text (context blocks stripped)
 * @param {object} options
 * @param {object} [options.api] - plugin API (for cognitiveDynamics, stability access)
 * @param {object} [options.logger] - logger
 * @returns {Promise<{match: boolean, insight: object|null, threshold: number, surprise: number|null}>}
 */
async function findRelevantInsight(agentId, userMessage, options = {}) {
    const { api, logger } = options;

    if (!userMessage || userMessage.length < 15) {
        return { match: false, insight: null, threshold: BASE_THRESHOLD, surprise: null };
    }

    if (!global.__ocContinuity?.searchKnowledge) {
        return { match: false, insight: null, threshold: BASE_THRESHOLD, surprise: null };
    }

    // Get JEPA surprise to modulate threshold
    let surprise = null;
    if (api?.cognitiveDynamics?.getSurprise) {
        surprise = api.cognitiveDynamics.getSurprise(agentId);
    }
    let threshold = computeThreshold(surprise);

    // Relational signal override: when the stability plugin detects
    // relational weight signals (brevity after depth, vocabulary narrowing,
    // emotional shorthand), floor the surprise so familiar relational topics
    // still get contemplation insights surfaced. Without this, repeated
    // conversations about the same theme have low JEPA surprise, which
    // tightens the threshold and suppresses relevant insights.
    const relational = api?.stability?.getRelationalSignals?.(agentId);
    if (relational?.relationalBonus > 0 && threshold < BASE_THRESHOLD) {
        threshold = BASE_THRESHOLD; // Relational exchanges get at least the base threshold
        if (logger) {
            logger.info(`[Anticipator:${agentId}] Relational signal detected — threshold floored to ${BASE_THRESHOLD}`);
        }
    }

    try {
        // Search vec_knowledge — this returns results sorted by compositeScore
        // with distance field (lower = more similar)
        const results = await global.__ocContinuity.searchKnowledge(agentId, userMessage, 5);

        if (!results || results.length === 0) {
            return { match: false, insight: null, threshold, surprise: surprise?.frozen ?? null };
        }

        // Filter to contemplation-sourced entries only
        const contemplationResults = results.filter(r =>
            r.source_type && r.source_type.startsWith('contemplation')
        );

        if (contemplationResults.length === 0) {
            return { match: false, insight: null, threshold, surprise: surprise?.frozen ?? null };
        }

        // Recurring topic boost: if the user keeps returning to certain themes,
        // insights tagged with those topics get a relevance boost so they
        // surface even when the semantic distance is marginal.
        const recurringTopics = getRecurringTopics(agentId);
        if (recurringTopics.length > 0) {
            for (const r of contemplationResults) {
                const tags = (r.topic_tags || r.tags || '').toLowerCase().split(',').filter(Boolean);
                const overlap = tags.filter(t => recurringTopics.includes(t.trim())).length;
                if (overlap > 0 && r.distance != null) {
                    // Reduce effective distance for recurring topic matches
                    r.distance *= Math.max(0.7, 1 - 0.1 * overlap);
                }
            }
            // Re-sort after boost
            contemplationResults.sort((a, b) => (a.distance ?? 1) - (b.distance ?? 1));
        }

        const top = contemplationResults[0];

        // Distance check — lower distance = better match
        const distance = top.distance ?? 1.0;
        const isMatch = distance < threshold;

        if (isMatch && logger) {
            logger.info(
                `[Anticipator:${agentId}] Match: "${(top.topic || '').substring(0, 50)}" ` +
                `(dist=${distance.toFixed(3)}, threshold=${threshold.toFixed(2)}, ` +
                `surprise=${surprise?.frozen?.toFixed(3) ?? 'N/A'}` +
                `${recurringTopics.length > 0 ? `, recurring=[${recurringTopics.slice(0, 3).join(',')}]` : ''})`
            );
        }

        return {
            match: isMatch,
            insight: isMatch ? {
                topic: top.topic || '',
                content: top.content || '',
                source: top.source_type || '',
                distance,
            } : null,
            threshold,
            surprise: surprise?.frozen ?? null
        };
    } catch (err) {
        if (logger) {
            logger.error(`[Anticipator:${agentId}] Search failed: ${err.message}`);
        }
        return { match: false, insight: null, threshold, surprise: surprise?.frozen ?? null };
    }
}

/**
 * Get topic tags that recur across recent contemplation inquiries.
 * Topics appearing 3+ times are considered "recurring" — the user
 * keeps returning to these themes.
 *
 * @param {string} agentId
 * @returns {string[]} recurring topic tags (lowercased)
 */
function getRecurringTopics(agentId) {
    try {
        const InquiryStore = require('./inquiry');
        const path = require('path');
        const baseDir = path.join(__dirname, '..', 'data');
        const store = new InquiryStore(baseDir, agentId, {});
        const inquiries = store.list();

        const tagCounts = {};
        for (const inq of inquiries) {
            const tags = (inq.tags || []);
            for (const tag of tags) {
                const t = (typeof tag === 'string' ? tag : '').toLowerCase().trim();
                if (t) tagCounts[t] = (tagCounts[t] || 0) + 1;
            }
        }

        return Object.entries(tagCounts)
            .filter(([, count]) => count >= 3)
            .sort((a, b) => b[1] - a[1])
            .map(([tag]) => tag);
    } catch {
        return [];
    }
}

/**
 * Format an insight match for context injection.
 * @param {object} insight - { topic, content, source }
 * @returns {string} formatted context block
 */
function formatInsight(insight) {
    const topic = insight.topic.substring(0, 100);
    // Extract just the synthesis (content is "topic\n\ncontent")
    const parts = insight.content.split('\n\n');
    const synthesis = (parts.length > 1 ? parts.slice(1).join('\n\n') : insight.content)
        .substring(0, 200);

    return `[RELEVANT INSIGHT - YOUR OWN PRIOR CONTEMPLATION]\nYou contemplated: "${topic}"\nSynthesis: ${synthesis}...\nThis is your own synthesis, not a user quote. Do not say Chris named or said this unless current conversation history confirms it.`;
}

module.exports = {
    findRelevantInsight,
    formatInsight,
    computeThreshold,
    BASE_THRESHOLD,
};
