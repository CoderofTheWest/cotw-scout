const { shouldPersistClaimCandidates } = require('./claim-candidates');

/**
 * Persist candidate claim records only when Build 2 record-mode gates are all open.
 *
 * This helper only hands already-created candidate records to ClaimStore.storeClaim
 * when explicitly allowed by config.
 */
function persistClaimCandidateResult(result = {}, claimStore, options = {}) {
    const config = options.config || {};
    const candidates = Array.isArray(result.candidates) ? result.candidates : [];
    const allowed = shouldPersistClaimCandidates(config) && result.persist === true;
    const response = {
        allowed,
        attempted: false,
        persisted: false,
        candidateCount: candidates.length,
        persistedCount: 0,
        failedCount: 0,
        persistedIds: [],
        errors: []
    };

    if (!allowed || !claimStore || typeof claimStore.storeClaim !== 'function') return response;

    response.attempted = true;
    for (const candidate of candidates) {
        try {
            const claim = {
                ...candidate,
                metadata: {
                    ...(candidate.metadata || {}),
                    candidatePersisted: true,
                    candidatePersistedAt: options.now || new Date().toISOString(),
                    observationKind: options.kind || 'observe'
                }
            };
            const stored = claimStore.storeClaim(claim);
            response.persistedCount += 1;
            response.persistedIds.push(stored.id || candidate.id);
        } catch (err) {
            response.failedCount += 1;
            response.errors.push({ id: candidate?.id || null, message: err.message });
        }
    }
    response.persisted = response.persistedCount > 0;
    return response;
}

module.exports = { persistClaimCandidateResult };
