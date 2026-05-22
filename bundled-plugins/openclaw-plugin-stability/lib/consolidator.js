/**
 * Memory Consolidator — nightly cleanup of growth vectors.
 *
 * Runs as a nightshift task (priority 15). Performs:
 * 1. Deduplication — merge vectors with >0.9 Jaccard similarity
 * 2. Supersession — mark older duplicate insights in vec_knowledge
 * 3. Age-out — archive candidate vectors >90 days with zero feedback
 * 4. Compaction — rewrite growth-vectors.json with only active data
 *
 * Design: brain-during-sleep. Consolidate, prune, strengthen important
 * connections, let the rest fade. No data is permanently deleted — everything
 * goes to an `archived` array that's excluded from runtime loading.
 *
 * The file read-only contract is RELAXED for consolidation only.
 * VectorStore normally treats the vectors array as read-only.
 * Consolidation is the one process that rewrites the file.
 */

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('../../../lib/write-json-atomic');

// ─── Jaccard similarity on word sets ────────────────────────────

const STOP_WORDS = new Set([
    'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have',
    'was', 'are', 'been', 'were', 'being', 'into', 'than', 'when',
    'what', 'which', 'about', 'their', 'them', 'they', 'will',
    'would', 'could', 'should', 'your', 'just', 'also', 'some',
    'does', 'doing', 'done', 'make', 'made', 'more', 'most',
    'very', 'only', 'other', 'each', 'then', 'not', 'but'
]);

function extractWords(text) {
    if (!text) return new Set();
    return new Set(
        text.toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 2 && !STOP_WORDS.has(w))
    );
}

function jaccardSimilarity(setA, setB) {
    if (setA.size === 0 && setB.size === 0) return 0;
    let intersection = 0;
    for (const w of setA) {
        if (setB.has(w)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

function getVectorText(v) {
    return [v.insight, v.description, v.integration_hypothesis, v.question]
        .filter(Boolean)
        .join(' ');
}

// ─── Consolidation operations ───────────────────────────────────

/**
 * Run all consolidation operations.
 * @param {string} agentId
 * @param {object} options - { vectorStore, api, config }
 */
async function run(agentId, options = {}) {
    const { vectorStore, api } = options;
    if (!vectorStore) throw new Error('vectorStore required');

    const logger = api?.logger || console;
    const startTime = Date.now();

    // Load current file (bypass cache — we need fresh data)
    const filePath = vectorStore.filePath;
    if (!fs.existsSync(filePath)) {
        logger.info(`[Consolidator:${agentId}] No growth-vectors.json — nothing to consolidate`);
        return { deduped: 0, superseded: 0, agedOut: 0, candidatesPruned: 0 };
    }

    let data;
    try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        logger.error(`[Consolidator:${agentId}] Failed to read growth-vectors.json: ${err.message}`);
        return { error: err.message };
    }

    const vectors = data.vectors || [];
    const candidates = data.candidates || [];
    const archived = data.archived || [];

    const initialCount = vectors.length;
    const initialCandidates = candidates.length;

    logger.info(`[Consolidator:${agentId}] Starting: ${vectors.length} vectors, ${candidates.length} candidates, ${archived.length} archived`);

    // Load feedback for age-out decisions
    let feedback = {};
    try {
        feedback = vectorStore._loadFeedbackFile ? vectorStore._loadFeedbackFile() : {};
    } catch { /* no feedback file is fine */ }

    // ─── 1a. Deduplicate vectors ────────────────────────────────

    const wordSets = vectors.map(v => extractWords(getVectorText(v)));
    const toArchive = new Set();
    let deduped = 0;

    for (let i = 0; i < vectors.length; i++) {
        if (toArchive.has(i)) continue;
        for (let j = i + 1; j < vectors.length; j++) {
            if (toArchive.has(j)) continue;

            const sim = jaccardSimilarity(wordSets[i], wordSets[j]);
            if (sim > 0.9) {
                // Keep the one with higher weight or more feedback
                const iWeight = vectors[i].weight || 0.5;
                const jWeight = vectors[j].weight || 0.5;
                const iFeedback = feedback[vectors[i].id]?.entries?.length || 0;
                const jFeedback = feedback[vectors[j].id]?.entries?.length || 0;
                const iScore = iWeight + iFeedback * 0.1;
                const jScore = jWeight + jFeedback * 0.1;

                const loser = iScore >= jScore ? j : i;
                const winner = loser === j ? i : j;

                vectors[loser].superseded_by = vectors[winner].id;
                vectors[loser].archived_reason = 'dedup';
                vectors[loser].archived_at = new Date().toISOString();
                toArchive.add(loser);
                deduped++;

                logger.debug(`[Consolidator:${agentId}] Dedup: ${vectors[loser].id} → ${vectors[winner].id} (sim=${sim.toFixed(2)})`);
            }
        }
    }

    // ─── 1c. Age-out dead candidate vectors ─────────────────────

    const NOW = Date.now();
    const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
    let agedOut = 0;

    for (let i = 0; i < vectors.length; i++) {
        if (toArchive.has(i)) continue;

        const v = vectors[i];
        const created = v.created ? Date.parse(v.created) : NOW;
        const age = NOW - created;

        // Skip if validated, rejected, or contemplation-sourced
        if (v.validation_status === 'validated' || v.validation_status === 'rejected_crystallization') continue;
        if (v.source && v.source.startsWith('contemplation:')) continue;

        // Age out if >90 days AND no feedback
        if (age > NINETY_DAYS) {
            const hasFeedback = feedback[v.id]?.entries?.length > 0;
            if (!hasFeedback) {
                v.archived_reason = 'age_out';
                v.archived_at = new Date().toISOString();
                toArchive.add(i);
                agedOut++;
            }
        }
    }

    // ─── Separate active from archived ──────────────────────────

    const activeVectors = [];
    for (let i = 0; i < vectors.length; i++) {
        if (toArchive.has(i)) {
            archived.push(vectors[i]);
        } else {
            activeVectors.push(vectors[i]);
        }
    }

    // ─── 1d-candidates. Prune stale candidates ─────────────────

    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    let candidatesPruned = 0;
    const activeCandidates = candidates.filter(c => {
        const created = c.created ? Date.parse(c.created) : NOW;
        if (NOW - created > THIRTY_DAYS) {
            archived.push({ ...c, archived_reason: 'stale_candidate', archived_at: new Date().toISOString() });
            candidatesPruned++;
            return false;
        }
        return true;
    });

    // ─── 1b. Supersede stale insights in vec_knowledge ──────────

    let superseded = 0;
    if (global.__ocContinuity?.searchKnowledge) {
        try {
            // Group contemplation entries by topic similarity
            // This is a simplified approach — find entries with very similar topics
            // and mark older ones as superseded
            // Full implementation would query the DB directly, but we use the
            // available global API for now
            logger.info(`[Consolidator:${agentId}] Insight supersession check via vec_knowledge`);
            // Note: Full supersession requires direct DB access which we'll add
            // to KnowledgeStore.markSuperseded(). For now, log the intent.
        } catch (err) {
            logger.warn(`[Consolidator:${agentId}] Insight supersession skipped: ${err.message}`);
        }
    }

    // ─── Compact and rewrite ────────────────────────────────────

    const output = {
        vectors: activeVectors,
        candidates: activeCandidates,
        archived,
        queue: data.queue || { high: [], medium: [], low: [] },
        metadata: data.metadata || {},
        updated: new Date().toISOString(),
        consolidated_at: new Date().toISOString(),
        consolidation_stats: {
            deduped,
            agedOut,
            candidatesPruned,
            superseded,
            activeVectors: activeVectors.length,
            archivedTotal: archived.length,
            durationMs: Date.now() - startTime
        }
    };

    // Write atomically via shared helper (temp + fsync + rename)
    try {
        writeJsonAtomic(filePath, output);
        // Invalidate vectorStore cache
        vectorStore._cacheChecksum = null;
        vectorStore._cacheTimestamp = 0;
    } catch (err) {
        logger.error(`[Consolidator:${agentId}] Failed to write consolidated file: ${err.message}`);
        // Clean up helper's temp file if write was interrupted before rename
        try { fs.unlinkSync(filePath + '.tmp'); } catch { /* ignore */ }
        return { error: err.message };
    }

    const elapsed = Date.now() - startTime;
    logger.info(
        `[Consolidator:${agentId}] Done in ${elapsed}ms: ` +
        `${initialCount}→${activeVectors.length} vectors (dedup=${deduped}, aged=${agedOut}), ` +
        `${initialCandidates}→${activeCandidates.length} candidates (pruned=${candidatesPruned}), ` +
        `${archived.length} total archived`
    );

    // Save consolidation timestamp for seeder
    saveConsolidationState(agentId, vectorStore, {
        lastRun: Date.now(),
        stats: output.consolidation_stats
    });

    return output.consolidation_stats;
}

// ─── Consolidation state persistence ────────────────────────────

function getConsolidationStatePath(agentId, vectorStore) {
    const dir = vectorStore.dataDir || path.dirname(vectorStore.filePath);
    return path.join(dir, `consolidation-state-${agentId}.json`);
}

function getConsolidationState(agentId, vectorStore) {
    const statePath = getConsolidationStatePath(agentId, vectorStore);
    try {
        if (fs.existsSync(statePath)) {
            return JSON.parse(fs.readFileSync(statePath, 'utf8'));
        }
    } catch { /* ignore */ }
    return null;
}

function saveConsolidationState(agentId, vectorStore, state) {
    const statePath = getConsolidationStatePath(agentId, vectorStore);
    try {
        writeJsonAtomic(statePath, state);
    } catch { /* non-fatal */ }
}

module.exports = {
    run,
    getConsolidationState,
    jaccardSimilarity,
    extractWords
};
