/**
 * Authority Ladder candidate for the COTW Continuity Spine.
 *
 * Standalone and dependency-free. This does not touch OpenClaw runtime state.
 * Build 1 uses it to make source-conflict resolution deterministic before any
 * live continuity plugin port is proposed.
 */

const SOURCE = Object.freeze({
  LIVE_RUNTIME: 'live_runtime',
  LIVE_CONFIG: 'live_config',
  CURRENT_USER_CORRECTION: 'current_user_correction',
  CURRENT_SESSION: 'current_session',
  FRESH_HANDOFF: 'fresh_handoff',
  ARCHIVE: 'archive',
  MEMORY: 'memory',
  DIGEST: 'digest',
  STALE_HANDOFF: 'stale_handoff',
  STALE_SUMMARY: 'stale_summary',
  UNSOURCED_SUMMARY: 'unsourced_summary'
});

const DECISION = Object.freeze({
  USE: 'use',
  VERIFY_FIRST: 'verify_first',
  REJECT: 'reject',
  HOLD: 'hold'
});

const SOURCE_RANK = Object.freeze({
  [SOURCE.LIVE_RUNTIME]: 100,
  [SOURCE.LIVE_CONFIG]: 95,
  [SOURCE.CURRENT_USER_CORRECTION]: 90,
  [SOURCE.CURRENT_SESSION]: 85,
  [SOURCE.FRESH_HANDOFF]: 70,
  [SOURCE.ARCHIVE]: 55,
  [SOURCE.MEMORY]: 55,
  [SOURCE.DIGEST]: 35,
  [SOURCE.STALE_HANDOFF]: 25,
  [SOURCE.STALE_SUMMARY]: 20,
  [SOURCE.UNSOURCED_SUMMARY]: 10
});

const VERIFY_SENSITIVE_SOURCES = new Set([
  SOURCE.LIVE_RUNTIME,
  SOURCE.LIVE_CONFIG,
  SOURCE.DIGEST,
  SOURCE.STALE_HANDOFF,
  SOURCE.STALE_SUMMARY,
  SOURCE.UNSOURCED_SUMMARY
]);

/**
 * Resolve competing claims about one subject.
 *
 * Claim shape:
 * {
 *   id?: string,
 *   subject: string,
 *   value: string,
 *   source: SOURCE|string,
 *   verified?: boolean,
 *   hasSourceHandle?: boolean,
 *   freshness?: 'live'|'current'|'fresh'|'archived'|'stale'|'unknown',
 *   isCorrection?: boolean,
 *   health?: { authority?: string, requiresVerification?: boolean },
 *   observedAt?: string|number|Date
 * }
 */
function resolveAuthority(claims, options = {}) {
  if (!Array.isArray(claims) || claims.length === 0) {
    return {
      decision: DECISION.HOLD,
      winner: null,
      rejected: [],
      requiresVerification: false,
      reasons: ['no claims supplied']
    };
  }

  const normalized = claims.map((claim, index) => normalizeClaim(claim, index, options));
  const viable = normalized.filter((claim) => claim.decision !== DECISION.REJECT);

  if (viable.length === 0) {
    return {
      decision: DECISION.HOLD,
      winner: null,
      rejected: normalized,
      requiresVerification: true,
      reasons: ['all claims are non-authoritative or unsupported']
    };
  }

  viable.sort(compareClaims);
  const winner = viable[0];
  const rejected = normalized.filter((claim) => claim.id !== winner.id);
  const conflicts = rejected.filter((claim) => claim.subject === winner.subject && claim.value !== winner.value);
  const requiresVerification = winner.requiresVerification || conflicts.some((claim) => claim.rank >= 35 && claim.requiresVerification);

  const reasons = [
    `${winner.source} outranks ${conflicts.length ? conflicts.map((c) => c.source).join(', ') : 'other available sources'}`
  ];

  if (winner.verified) reasons.push('winner is verified');
  if (winner.isCorrection) reasons.push('current-session user correction supersedes older memory');
  if (requiresVerification) reasons.push('verify before asserting current runtime/state claims');
  if (!winner.hasSourceHandle && needsSourceHandle(winner)) reasons.push('winner lacks source handle; treat as non-current until verified');

  return {
    decision: requiresVerification ? DECISION.VERIFY_FIRST : DECISION.USE,
    winner,
    rejected,
    requiresVerification,
    reasons
  };
}

function rankClaim(claim, options = {}) {
  return normalizeClaim(claim, 0, options);
}

function normalizeClaim(claim, index, options) {
  const source = normalizeSource(claim.source, claim);
  const baseRank = SOURCE_RANK[source] ?? 0;
  const healthAuthority = claim.health?.authority;
  const hasSourceHandle = Boolean(claim.hasSourceHandle || claim.sessionId || claim.sourceHandle);
  const verified = Boolean(claim.verified);
  const isCorrection = Boolean(claim.isCorrection || source === SOURCE.CURRENT_USER_CORRECTION);

  let rank = baseRank;
  const reasons = [];
  let decision = DECISION.USE;
  let requiresVerification = Boolean(claim.requiresVerification || claim.health?.requiresVerification);

  if (verified) {
    rank += 8;
    reasons.push('verified');
  }

  if (isCorrection) {
    rank = Math.max(rank, SOURCE_RANK[SOURCE.CURRENT_USER_CORRECTION]);
    reasons.push('user correction');
  }

  if (healthAuthority === 'ignore' || healthAuthority === 'non_authoritative') {
    rank = Math.min(rank, 15);
    requiresVerification = true;
    reasons.push(`handoff health authority=${healthAuthority}`);
  } else if (healthAuthority === 'supporting') {
    rank = Math.min(rank, SOURCE_RANK[SOURCE.FRESH_HANDOFF]);
    requiresVerification = true;
    reasons.push('handoff is supporting only');
  }

  if (!hasSourceHandle && needsSourceHandle({ source })) {
    rank -= 15;
    requiresVerification = true;
    reasons.push('missing source handle');
  }

  if (VERIFY_SENSITIVE_SOURCES.has(source) && !verified) {
    requiresVerification = true;
    reasons.push('verification-sensitive source');
  }

  if (source === SOURCE.UNSOURCED_SUMMARY) {
    decision = DECISION.VERIFY_FIRST;
    rank = Math.min(rank, 10);
    requiresVerification = true;
    reasons.push('unsourced summary cannot assert current state');
  }

  if (claim.status === 'superseded' || claim.status === 'expired') {
    decision = DECISION.REJECT;
    rank = -100;
    reasons.push(`status=${claim.status}`);
  }

  return {
    ...claim,
    id: claim.id || `${source}-${index}`,
    source,
    rank,
    verified,
    hasSourceHandle,
    isCorrection,
    requiresVerification,
    decision,
    reasons
  };
}

function normalizeSource(source, claim) {
  if (source === 'current_user_correction') return SOURCE.CURRENT_USER_CORRECTION;
  if (source === 'current_session' && claim?.isCorrection) return SOURCE.CURRENT_USER_CORRECTION;
  if (source === 'handoff' && claim?.health?.status === 'fresh') return SOURCE.FRESH_HANDOFF;
  if (source === 'handoff') return SOURCE.STALE_HANDOFF;
  if (source === 'summary' && !claim?.hasSourceHandle) return SOURCE.UNSOURCED_SUMMARY;
  if (source === 'summary') return SOURCE.STALE_SUMMARY;
  return source || SOURCE.UNSOURCED_SUMMARY;
}

function needsSourceHandle(claim) {
  return [SOURCE.FRESH_HANDOFF, SOURCE.ARCHIVE, SOURCE.MEMORY, SOURCE.DIGEST, SOURCE.STALE_HANDOFF, SOURCE.STALE_SUMMARY, SOURCE.UNSOURCED_SUMMARY].includes(claim.source);
}

function compareClaims(a, b) {
  if (b.rank !== a.rank) return b.rank - a.rank;
  const aTime = toMs(a.observedAt);
  const bTime = toMs(b.observedAt);
  if (Number.isFinite(aTime) && Number.isFinite(bTime) && bTime !== aTime) return bTime - aTime;
  return String(a.id).localeCompare(String(b.id));
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
  SOURCE,
  DECISION,
  resolveAuthority,
  rankClaim,
};
