/**
 * Claim record primitives for Build 2 of the COTW Continuity Spine.
 *
 * Standalone candidate logic only. Claim records created here are structured
 * provenance envelopes; no live OpenClaw runtime or plugin storage is touched.
 */

const crypto = require('crypto');
const {
  normalizeSourceRefs,
  SOURCE_ROLES,
  sourceAuthorityRank,
  strongestSourceRank
} = require('./source-handles');

const CLAIM_KINDS = Object.freeze({
  PROJECT_STATE: 'project_state',
  USER_PREFERENCE: 'user_preference',
  IDENTITY: 'identity',
  COMMITMENT: 'commitment',
  RUNTIME: 'runtime',
  INTERPRETATION: 'interpretation',
  SUMMARY: 'summary'
});

const CLAIM_STATUSES = Object.freeze({
  ACTIVE: 'active',
  SUPERSEDED: 'superseded',
  STALE: 'stale',
  VERIFY_REQUIRED: 'verify_required',
  RETRACTED: 'retracted'
});

const FRESHNESS_POLICIES = Object.freeze({
  EVERGREEN: 'evergreen',
  SESSION_BOUND: 'session_bound',
  VERIFY_BEFORE_ASSERTING: 'verify_before_asserting',
  EXPIRES_AFTER: 'expires_after',
  USER_CORRECTION_WINS: 'user_correction_wins',
  RUNTIME_CHECK_REQUIRED: 'runtime_check_required'
});

const KIND_VALUES = new Set(Object.values(CLAIM_KINDS));
const STATUS_VALUES = new Set(Object.values(CLAIM_STATUSES));
const POLICY_VALUES = new Set(Object.values(FRESHNESS_POLICIES));

const STRICT_KIND_DEFAULTS = Object.freeze({
  [CLAIM_KINDS.RUNTIME]: FRESHNESS_POLICIES.RUNTIME_CHECK_REQUIRED,
  [CLAIM_KINDS.PROJECT_STATE]: FRESHNESS_POLICIES.VERIFY_BEFORE_ASSERTING,
  [CLAIM_KINDS.COMMITMENT]: FRESHNESS_POLICIES.VERIFY_BEFORE_ASSERTING,
  [CLAIM_KINDS.SUMMARY]: FRESHNESS_POLICIES.VERIFY_BEFORE_ASSERTING,
  [CLAIM_KINDS.USER_PREFERENCE]: FRESHNESS_POLICIES.USER_CORRECTION_WINS,
  [CLAIM_KINDS.IDENTITY]: FRESHNESS_POLICIES.EVERGREEN,
  [CLAIM_KINDS.INTERPRETATION]: FRESHNESS_POLICIES.VERIFY_BEFORE_ASSERTING
});

function createClaimRecord(input = {}, options = {}) {
  const now = options.now || new Date().toISOString();
  const kind = normalizeKind(input.kind);
  const sources = normalizeSourceRefs(input.sources || input.sourceHandles || [], { defaultRole: SOURCE_ROLES.EVIDENCE });
  const sourceRank = strongestSourceRank(sources);
  const policy = normalizePolicy(input.stalenessPolicy || input.freshness?.staleness_policy || STRICT_KIND_DEFAULTS[kind]);
  const hasValidSources = sources.some((source) => source.valid);
  const status = normalizeStatus(input.status || defaultStatusFor(kind, policy, hasValidSources));
  const claim = required(input.claim, 'claim');

  return {
    id: input.id || stableClaimId({ claim, kind, threadId: input.threadId || '', sources }, options.idPrefix),
    agentId: input.agentId || options.agentId || 'trail-guide',
    threadId: input.threadId || null,
    kind,
    claim,
    status,
    confidence: clampConfidence(input.confidence ?? defaultConfidence({ kind, sourceRank, hasValidSources })),
    authorityRank: Number.isFinite(input.authorityRank) ? input.authorityRank : sourceRank,
    createdAt: input.createdAt || input.created_at || now,
    updatedAt: input.updatedAt || input.updated_at || now,
    freshness: {
      lastVerifiedAt: input.lastVerifiedAt || input.freshness?.last_verified_at || (hasValidSources ? now : null),
      expiresAfter: input.expiresAfter || input.freshness?.expires_after || null,
      stalenessPolicy: policy
    },
    sources,
    contradicts: normalizeArray(input.contradicts),
    supersedes: normalizeArray(input.supersedes),
    speechGuidance: input.speechGuidance || defaultSpeechGuidance(kind, status, policy),
    metadata: input.metadata || {}
  };
}

function validateClaimRecord(claim) {
  const errors = [];
  if (!claim || typeof claim !== 'object') return { ok: false, errors: ['claim record must be an object'] };
  if (!claim.id) errors.push('missing id');
  if (!claim.agentId) errors.push('missing agentId');
  if (!KIND_VALUES.has(claim.kind)) errors.push(`unsupported kind: ${claim.kind}`);
  if (!claim.claim) errors.push('missing claim');
  if (!STATUS_VALUES.has(claim.status)) errors.push(`unsupported status: ${claim.status}`);
  if (!Number.isFinite(claim.confidence) || claim.confidence < 0 || claim.confidence > 1) errors.push('confidence must be between 0 and 1');
  if (!Number.isFinite(claim.authorityRank)) errors.push('authorityRank must be numeric');
  if (!Array.isArray(claim.sources)) errors.push('sources must be an array');
  if (claim.sources?.some((source) => !source.valid)) errors.push('all sources must have valid handles');
  if (!POLICY_VALUES.has(claim.freshness?.stalenessPolicy)) errors.push(`unsupported stalenessPolicy: ${claim.freshness?.stalenessPolicy}`);
  if (!Date.parse(claim.createdAt)) errors.push('createdAt must be parseable');
  if (!Date.parse(claim.updatedAt)) errors.push('updatedAt must be parseable');
  return { ok: errors.length === 0, errors };
}

function assessClaimFreshness(claim, options = {}) {
  const nowMs = toMs(options.now ?? Date.now());
  const updatedMs = toMs(claim?.updatedAt);
  const lastVerifiedMs = toMs(claim?.freshness?.lastVerifiedAt);
  const policy = claim?.freshness?.stalenessPolicy;
  const reasons = [];
  let status = claim?.status || CLAIM_STATUSES.VERIFY_REQUIRED;
  let requiresVerification = false;

  if (!claim || typeof claim !== 'object') {
    return { status: CLAIM_STATUSES.VERIFY_REQUIRED, requiresVerification: true, reasons: ['missing claim record'] };
  }
  if (claim.status === CLAIM_STATUSES.RETRACTED || claim.status === CLAIM_STATUSES.SUPERSEDED) {
    return { status: claim.status, requiresVerification: true, reasons: [`claim is ${claim.status}`] };
  }
  if (!Number.isFinite(updatedMs)) {
    status = CLAIM_STATUSES.VERIFY_REQUIRED;
    requiresVerification = true;
    reasons.push('claim updatedAt is not parseable');
  }

  if (claim.sources?.length === 0) {
    requiresVerification = true;
    reasons.push('claim lacks source handles');
  }

  if (policy === FRESHNESS_POLICIES.RUNTIME_CHECK_REQUIRED) {
    requiresVerification = true;
    reasons.push('runtime check required');
  } else if (policy === FRESHNESS_POLICIES.VERIFY_BEFORE_ASSERTING) {
    requiresVerification = true;
    reasons.push('verify before asserting');
  } else if (policy === FRESHNESS_POLICIES.SESSION_BOUND) {
    const sameSession = options.currentSessionId && claim.metadata?.sessionId === options.currentSessionId;
    requiresVerification = !sameSession;
    reasons.push(sameSession ? 'session-bound claim is in current session' : 'session-bound claim is outside current session');
  } else if (policy === FRESHNESS_POLICIES.EXPIRES_AFTER) {
    const expiryMs = durationToMs(claim.freshness?.expiresAfter);
    if (!Number.isFinite(lastVerifiedMs) || !Number.isFinite(expiryMs) || nowMs - lastVerifiedMs > expiryMs) {
      requiresVerification = true;
      status = CLAIM_STATUSES.STALE;
      reasons.push('claim freshness window expired');
    } else {
      reasons.push('claim freshness window is active');
    }
  } else if (policy === FRESHNESS_POLICIES.USER_CORRECTION_WINS || policy === FRESHNESS_POLICIES.EVERGREEN) {
    reasons.push(`${policy} claim is stable unless corrected`);
  }

  if (claim.status === CLAIM_STATUSES.VERIFY_REQUIRED || claim.status === CLAIM_STATUSES.STALE) {
    requiresVerification = true;
    reasons.push(`claim status is ${claim.status}`);
  }

  return { status, requiresVerification, reasons };
}

function claimRequiresVerification(claim, options = {}) {
  return assessClaimFreshness(claim, options).requiresVerification;
}

function createDigestClaims(digest, options = {}) {
  if (!digest) return [];
  const sourcesFor = (field) => normalizeSourceRefs([
    ...(digest.sourceHandles || []),
    `digest:${digest.threadId}#v${digest.version || 1}:${field}`
  ]);
  const base = {
    agentId: digest.agentId || options.agentId,
    threadId: digest.threadId,
    createdAt: options.now,
    updatedAt: digest.lastUpdated || options.now,
    confidence: 0.78
  };
  const claims = [];
  if (digest.goal) {
    claims.push(createClaimRecord({
      ...base,
      kind: CLAIM_KINDS.SUMMARY,
      claim: `Thread goal: ${digest.goal}`,
      sources: sourcesFor('goal'),
      stalenessPolicy: FRESHNESS_POLICIES.VERIFY_BEFORE_ASSERTING,
      speechGuidance: 'Use as compressed thread context; expand sources before treating as a decision.'
    }, options));
  }
  if (digest.currentState) {
    claims.push(createClaimRecord({
      ...base,
      kind: CLAIM_KINDS.PROJECT_STATE,
      claim: digest.currentState,
      sources: sourcesFor('currentState'),
      stalenessPolicy: FRESHNESS_POLICIES.VERIFY_BEFORE_ASSERTING,
      speechGuidance: 'Verify files/tools/runtime before asserting this as current state.'
    }, options));
  }
  for (const commitment of digest.commitments || []) {
    claims.push(createClaimRecord({
      ...base,
      kind: CLAIM_KINDS.COMMITMENT,
      claim: commitment,
      sources: sourcesFor('commitments'),
      stalenessPolicy: FRESHNESS_POLICIES.VERIFY_BEFORE_ASSERTING,
      speechGuidance: 'Track until completed, superseded, or abandoned.'
    }, options));
  }
  return claims;
}

function claimRecordSqlSchema() {
  return `CREATE TABLE IF NOT EXISTS claims (\n  id TEXT PRIMARY KEY,\n  agent_id TEXT NOT NULL,\n  thread_id TEXT,\n  kind TEXT NOT NULL,\n  claim TEXT NOT NULL,\n  status TEXT NOT NULL,\n  confidence REAL NOT NULL,\n  authority_rank INTEGER NOT NULL,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  last_verified_at TEXT,\n  expires_after TEXT,\n  staleness_policy TEXT NOT NULL,\n  speech_guidance TEXT\n);\n\nCREATE TABLE IF NOT EXISTS claim_sources (\n  claim_id TEXT NOT NULL,\n  handle TEXT NOT NULL,\n  role TEXT NOT NULL,\n  quote_hash TEXT,\n  excerpt TEXT,\n  created_at TEXT NOT NULL,\n  PRIMARY KEY (claim_id, handle, role)\n);\n\nCREATE TABLE IF NOT EXISTS claim_edges (\n  from_claim_id TEXT NOT NULL,\n  to_claim_id TEXT NOT NULL,\n  relation TEXT NOT NULL,\n  PRIMARY KEY (from_claim_id, to_claim_id, relation)\n);`;
}

function defaultStatusFor(kind, policy, hasValidSources) {
  if (!hasValidSources) return CLAIM_STATUSES.VERIFY_REQUIRED;
  if (policy === FRESHNESS_POLICIES.RUNTIME_CHECK_REQUIRED || policy === FRESHNESS_POLICIES.VERIFY_BEFORE_ASSERTING) {
    if (kind === CLAIM_KINDS.RUNTIME) return CLAIM_STATUSES.VERIFY_REQUIRED;
  }
  return CLAIM_STATUSES.ACTIVE;
}

function defaultConfidence({ kind, sourceRank, hasValidSources }) {
  if (!hasValidSources) return 0.35;
  if (kind === CLAIM_KINDS.INTERPRETATION) return 0.65;
  return Math.min(0.9, 0.55 + sourceRank * 0.07);
}

function defaultSpeechGuidance(kind, status, policy) {
  if (status === CLAIM_STATUSES.VERIFY_REQUIRED) return 'Do not assert as current fact until source is resolved or current state is checked.';
  if (kind === CLAIM_KINDS.RUNTIME) return 'Always run a current runtime check before speaking as present state.';
  if (kind === CLAIM_KINDS.PROJECT_STATE) return 'Verify files, git, tools, or runtime before speaking as present state.';
  if (policy === FRESHNESS_POLICIES.USER_CORRECTION_WINS) return 'Newer explicit user correction supersedes this claim.';
  return 'Use as sourced memory; preserve qualifiers and avoid overclaiming.';
}

function stableClaimId(input, prefix = 'claim') {
  const basis = JSON.stringify({
    claim: input.claim,
    kind: input.kind,
    threadId: input.threadId,
    sources: (input.sources || []).map((source) => source.handle).sort()
  });
  return `${prefix}_${crypto.createHash('sha256').update(basis).digest('hex').slice(0, 16)}`;
}

function normalizeKind(kind) {
  if (!KIND_VALUES.has(kind)) throw new Error(`Unsupported claim kind: ${kind}`);
  return kind;
}

function normalizeStatus(status) {
  return STATUS_VALUES.has(status) ? status : CLAIM_STATUSES.VERIFY_REQUIRED;
}

function normalizePolicy(policy) {
  return POLICY_VALUES.has(policy) ? policy : FRESHNESS_POLICIES.VERIFY_BEFORE_ASSERTING;
}

function clampConfidence(value) {
  return Math.max(0, Math.min(1, Number(value)));
}

function sourceAuthoritySort(a, b) {
  return sourceAuthorityRank(b) - sourceAuthorityRank(a);
}

function normalizeArray(value) {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value.filter((entry) => entry !== undefined && entry !== null && entry !== '') : [value];
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

function durationToMs(value) {
  if (!value) return NaN;
  const match = String(value).match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!match) return NaN;
  const [, days = 0, hours = 0, minutes = 0, seconds = 0] = match.map((part) => part === undefined ? 0 : Number(part));
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}


module.exports = {
  CLAIM_KINDS,
  CLAIM_STATUSES,
  FRESHNESS_POLICIES,
  createClaimRecord,
  validateClaimRecord,
  assessClaimFreshness,
  claimRequiresVerification,
  createDigestClaims,
  claimRecordSqlSchema
};
