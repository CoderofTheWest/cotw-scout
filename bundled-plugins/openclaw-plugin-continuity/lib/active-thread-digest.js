/**
 * Active Thread Digest candidate for the COTW Continuity Spine.
 *
 * Standalone and dependency-free. This is candidate schema/storage logic only;
 * it does not touch OpenClaw runtime or the live continuity plugin.
 */

const DIGEST_STATUS = Object.freeze({
  FRESH: 'fresh',
  AGING: 'aging',
  STALE: 'stale',
  ORPHANED: 'orphaned'
});

const DEFAULT_THRESHOLDS = Object.freeze({
  agingMs: 24 * 60 * 60 * 1000,
  staleMs: 7 * 24 * 60 * 60 * 1000,
  orphanedMs: 30 * 24 * 60 * 60 * 1000
});

const REQUIRED_FIELDS = Object.freeze([
  'threadId',
  'agentId',
  'goal',
  'currentState',
  'decisions',
  'blockers',
  'lastVerifiedEvidence',
  'staleRiskNotes',
  'nextAction',
  'sourceHandles',
  'lastUpdated'
]);

function createActiveThreadDigest(input = {}, options = {}) {
  const now = options.now || new Date().toISOString();
  const sourceHandles = normalizeArray(input.sourceHandles);
  return {
    schemaVersion: 1,
    threadId: required(input.threadId, 'threadId'),
    agentId: required(input.agentId, 'agentId'),
    title: input.title || input.threadId,
    goal: input.goal || '',
    userIntent: input.userIntent || '',
    currentState: input.currentState || '',
    decisions: normalizeArray(input.decisions),
    blockers: normalizeArray(input.blockers),
    commitments: normalizeArray(input.commitments),
    lastVerifiedEvidence: normalizeEvidence(input.lastVerifiedEvidence),
    staleRiskNotes: normalizeArray(input.staleRiskNotes),
    nextAction: input.nextAction || '',
    posture: input.posture || '',
    sourceHandles,
    lastUpdated: input.lastUpdated || now,
    version: Number.isInteger(input.version) ? input.version : 1,
    verificationPolicy: input.verificationPolicy || (sourceHandles.length ? 'verify_if_stale' : 'verify_required'),
    metadata: input.metadata || {}
  };
}

function validateActiveThreadDigest(digest) {
  const errors = [];
  if (!digest || typeof digest !== 'object') return { ok: false, errors: ['digest must be an object'] };
  for (const field of REQUIRED_FIELDS) {
    if (digest[field] === undefined || digest[field] === null) errors.push(`missing ${field}`);
  }
  if (!Array.isArray(digest.decisions)) errors.push('decisions must be an array');
  if (!Array.isArray(digest.blockers)) errors.push('blockers must be an array');
  if (!Array.isArray(digest.staleRiskNotes)) errors.push('staleRiskNotes must be an array');
  if (!Array.isArray(digest.sourceHandles)) errors.push('sourceHandles must be an array');
  if (!Array.isArray(digest.lastVerifiedEvidence)) errors.push('lastVerifiedEvidence must be an array');
  if (!Number.isInteger(digest.version) || digest.version < 1) errors.push('version must be a positive integer');
  if (!Number.isFinite(toMs(digest.lastUpdated))) errors.push('lastUpdated must be parseable');
  return { ok: errors.length === 0, errors };
}

function assessDigestFreshness(digest, options = {}) {
  const nowMs = toMs(options.now ?? Date.now());
  const updatedMs = toMs(digest?.lastUpdated);
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) };
  if (!Number.isFinite(updatedMs)) {
    return {
      status: DIGEST_STATUS.ORPHANED,
      ageMs: null,
      requiresVerification: true,
      reasons: ['digest has no parseable lastUpdated timestamp']
    };
  }
  const ageMs = Math.max(0, nowMs - updatedMs);
  const reasons = [];
  let status = DIGEST_STATUS.FRESH;
  if (ageMs >= thresholds.orphanedMs) {
    status = DIGEST_STATUS.ORPHANED;
    reasons.push('digest exceeds orphaned threshold');
  } else if (ageMs >= thresholds.staleMs) {
    status = DIGEST_STATUS.STALE;
    reasons.push('digest exceeds stale threshold');
  } else if (ageMs >= thresholds.agingMs) {
    status = DIGEST_STATUS.AGING;
    reasons.push('digest exceeds aging threshold');
  } else {
    reasons.push('digest is fresh');
  }

  const hasSourceHandles = Array.isArray(digest?.sourceHandles) && digest.sourceHandles.length > 0;
  if (!hasSourceHandles) reasons.push('digest lacks source handles');

  return {
    status,
    ageMs,
    requiresVerification: status !== DIGEST_STATUS.FRESH || !hasSourceHandles || digest?.verificationPolicy === 'verify_required',
    reasons
  };
}

function updateActiveThreadDigest(existing, patch = {}, options = {}) {
  const base = existing ? createActiveThreadDigest(existing, options) : createActiveThreadDigest(patch, options);
  const now = options.now || new Date().toISOString();
  const merged = createActiveThreadDigest({
    ...base,
    ...patch,
    decisions: mergeUnique(base.decisions, patch.decisions),
    blockers: patch.blockers !== undefined ? normalizeArray(patch.blockers) : base.blockers,
    commitments: mergeUnique(base.commitments, patch.commitments),
    lastVerifiedEvidence: patch.lastVerifiedEvidence !== undefined
      ? normalizeEvidence(patch.lastVerifiedEvidence)
      : base.lastVerifiedEvidence,
    staleRiskNotes: mergeUnique(base.staleRiskNotes, patch.staleRiskNotes),
    sourceHandles: mergeUnique(base.sourceHandles, patch.sourceHandles),
    lastUpdated: patch.lastUpdated || now,
    version: (base.version || 1) + (existing ? 1 : 0)
  }, options);
  return merged;
}

function selectActiveThreadDigest(digests, query = '', options = {}) {
  const candidates = (digests || []).map((digest) => {
    const freshness = assessDigestFreshness(digest, options);
    return {
      digest,
      freshness,
      score: scoreDigest(digest, query, options) - freshnessPenalty(freshness)
    };
  });
  candidates.sort((a, b) => b.score - a.score || String(b.digest.lastUpdated).localeCompare(String(a.digest.lastUpdated)));
  const selected = candidates[0] || null;
  return {
    selected: selected?.digest || null,
    freshness: selected?.freshness || null,
    candidates
  };
}

function toMinimalInjection(digest, options = {}) {
  if (!digest) return null;
  const freshness = assessDigestFreshness(digest, options);
  const lines = [];
  lines.push(`thread: ${digest.threadId}`);
  if (digest.goal) lines.push(`goal: ${digest.goal}`);
  if (digest.currentState) lines.push(`current_state: ${digest.currentState}`);
  if (digest.nextAction) lines.push(`next_action: ${digest.nextAction}`);
  if (digest.blockers?.length) lines.push(`blockers: ${digest.blockers.join('; ')}`);
  if (digest.decisions?.length) lines.push(`decisions: ${digest.decisions.slice(-3).join('; ')}`);
  lines.push(`freshness: ${freshness.status}`);
  if (freshness.requiresVerification) lines.push('verification: verify before asserting current state');
  if (digest.staleRiskNotes?.length) lines.push(`stale_risk: ${digest.staleRiskNotes.join('; ')}`);
  return {
    text: lines.join('\n'),
    freshness,
    sourceHandles: digest.sourceHandles || []
  };
}

function activeThreadDigestJsonSchema() {
  return {
    type: 'object',
    required: [...REQUIRED_FIELDS],
    properties: {
      schemaVersion: { type: 'integer' },
      threadId: { type: 'string' },
      agentId: { type: 'string' },
      title: { type: 'string' },
      goal: { type: 'string' },
      userIntent: { type: 'string' },
      currentState: { type: 'string' },
      decisions: { type: 'array', items: { type: 'string' } },
      blockers: { type: 'array', items: { type: 'string' } },
      commitments: { type: 'array', items: { type: 'string' } },
      lastVerifiedEvidence: { type: 'array', items: { type: 'object' } },
      staleRiskNotes: { type: 'array', items: { type: 'string' } },
      nextAction: { type: 'string' },
      posture: { type: 'string' },
      sourceHandles: { type: 'array', items: { type: 'string' } },
      lastUpdated: { type: 'string' },
      version: { type: 'integer' },
      verificationPolicy: { type: 'string' },
      metadata: { type: 'object' }
    }
  };
}

function scoreDigest(digest, query, options) {
  let score = 0;
  if (options.currentThreadId && digest.threadId === options.currentThreadId) score += 100;
  const haystack = [
    digest.threadId,
    digest.title,
    digest.goal,
    digest.userIntent,
    digest.currentState,
    digest.nextAction,
    ...(digest.decisions || []),
    ...(digest.blockers || []),
    ...(digest.staleRiskNotes || [])
  ].join(' ').toLowerCase();
  const terms = tokenize(query);
  for (const term of terms) {
    if (haystack.includes(term)) score += 5;
  }
  if (digest.lastUpdated) {
    const nowMs = toMs(options.now ?? Date.now());
    score += Math.min(10, Math.max(0, 10 - (nowMs - toMs(digest.lastUpdated)) / (7 * 24 * 60 * 60 * 1000)));
  }
  return score;
}

function freshnessPenalty(freshness) {
  if (!freshness) return 50;
  if (freshness.status === DIGEST_STATUS.ORPHANED) return 60;
  if (freshness.status === DIGEST_STATUS.STALE) return 20;
  if (freshness.status === DIGEST_STATUS.AGING) return 5;
  return 0;
}

function normalizeEvidence(value) {
  return normalizeArray(value).map((entry) => typeof entry === 'string' ? { text: entry } : entry);
}

function normalizeArray(value) {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value.filter((entry) => entry !== undefined && entry !== null && entry !== '') : [value];
}

function mergeUnique(a, b) {
  return [...new Set([...normalizeArray(a), ...normalizeArray(b)])];
}

function tokenize(value) {
  return String(value || '').toLowerCase().match(/[a-z0-9_-]{3,}/g) || [];
}

function required(value, name) {
  if (value === undefined || value === null || value === '') throw new Error(`Missing required field: ${name}`);
  return value;
}

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

module.exports = {
  DIGEST_STATUS,
  DEFAULT_THRESHOLDS,
  createActiveThreadDigest,
  validateActiveThreadDigest,
  assessDigestFreshness,
  updateActiveThreadDigest,
  selectActiveThreadDigest,
  toMinimalInjection,
  activeThreadDigestJsonSchema,
};
