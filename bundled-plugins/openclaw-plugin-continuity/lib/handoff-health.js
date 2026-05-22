/**
 * Handoff health classifier for the COTW Continuity Spine.
 *
 * This module is intentionally standalone and dependency-free. It does not touch
 * OpenClaw runtime state. Build 1 uses it as a candidate implementation before
 * any live continuity plugin changes are proposed.
 */

const HEALTH = Object.freeze({
  ABSENT: 'absent',
  FRESH: 'fresh',
  CONSUMED: 'consumed',
  STALE: 'stale',
  ORPHANED: 'orphaned',
  QUARANTINED: 'quarantined'
});

const AUTHORITY = Object.freeze({
  AUTHORITATIVE: 'authoritative',
  SUPPORTING: 'supporting',
  NON_AUTHORITATIVE: 'non_authoritative',
  IGNORE: 'ignore'
});

const DEFAULTS = Object.freeze({
  freshMs: 60 * 60 * 1000,
  staleMs: 24 * 60 * 60 * 1000,
  orphanedMs: 7 * 24 * 60 * 60 * 1000
});

/**
 * @typedef {Object} HandoffInput
 * @property {boolean} exists
 * @property {string|number|Date} [createdAt]
 * @property {string|number|Date} [updatedAt]
 * @property {string|number|Date} [consumedAt]
 * @property {boolean} [quarantined]
 * @property {string} [threadId]
 * @property {string} [sessionId]
 * @property {string} [currentThreadId]
 * @property {string} [currentSessionId]
 * @property {boolean} [hasRuntimeClaims]
 * @property {boolean} [hasSourceHandles]
 * @property {string[]} [warnings]
 */

/**
 * Classify whether a handoff should be injected as active context.
 *
 * Authority meaning:
 * - authoritative: may guide immediate resume posture.
 * - supporting: may inform but current evidence still wins.
 * - non_authoritative: can be mentioned as stale/suspect, not injected as truth.
 * - ignore: do not inject.
 */
function classifyHandoffHealth(input, options = {}) {
  const nowMs = toMs(options.now ?? Date.now());
  const thresholds = { ...DEFAULTS, ...(options.thresholds || {}) };
  const reasons = [];
  const actions = [];

  if (!input || input.exists === false) {
    return result(HEALTH.ABSENT, AUTHORITY.IGNORE, reasons, ['do_not_inject']);
  }

  if (input.quarantined) {
    reasons.push('handoff already marked quarantined');
    return result(HEALTH.QUARANTINED, AUTHORITY.IGNORE, reasons, ['do_not_inject', 'keep_quarantined']);
  }

  if (input.consumedAt) {
    reasons.push('handoff already consumed');
    return result(HEALTH.CONSUMED, AUTHORITY.IGNORE, reasons, ['do_not_inject', 'archive_if_needed']);
  }

  const updatedMs = toMs(input.updatedAt ?? input.createdAt);
  if (!Number.isFinite(updatedMs)) {
    reasons.push('handoff has no parseable timestamp');
    return result(HEALTH.ORPHANED, AUTHORITY.NON_AUTHORITATIVE, reasons, ['do_not_inject', 'quarantine']);
  }

  const ageMs = Math.max(0, nowMs - updatedMs);
  const threadMismatch = Boolean(input.currentThreadId && input.threadId && input.currentThreadId !== input.threadId);
  const sessionMismatch = Boolean(input.currentSessionId && input.sessionId && input.currentSessionId !== input.sessionId);

  if (ageMs >= thresholds.orphanedMs) {
    reasons.push(`handoff age ${ageMs}ms exceeds orphaned threshold ${thresholds.orphanedMs}ms`);
    actions.push('quarantine');
    actions.push('do_not_inject');
    return result(HEALTH.ORPHANED, AUTHORITY.NON_AUTHORITATIVE, reasons, actions, { ageMs });
  }

  if (threadMismatch) {
    reasons.push('handoff thread does not match current thread');
    actions.push('do_not_inject');
    actions.push('treat_as_cross_thread_reference_only');
    return result(HEALTH.ORPHANED, AUTHORITY.NON_AUTHORITATIVE, reasons, actions, { ageMs, threadMismatch });
  }

  if (sessionMismatch && ageMs >= thresholds.freshMs) {
    reasons.push('handoff session differs and is outside fresh window');
    actions.push('do_not_inject');
    actions.push('archive_or_mark_suspect');
    actions.push('verify_before_asserting_current_state');
    return result(HEALTH.STALE, AUTHORITY.NON_AUTHORITATIVE, reasons, actions, { ageMs, sessionMismatch });
  }

  if (ageMs >= thresholds.staleMs) {
    reasons.push(`handoff age ${ageMs}ms exceeds stale threshold ${thresholds.staleMs}ms`);
    actions.push('inject_only_as_stale_summary');
    actions.push('verify_before_asserting_current_state');
    return result(HEALTH.STALE, AUTHORITY.NON_AUTHORITATIVE, reasons, actions, { ageMs });
  }

  if (ageMs >= thresholds.freshMs) {
    reasons.push(`handoff age ${ageMs}ms exceeds fresh threshold ${thresholds.freshMs}ms`);
    actions.push('inject_as_supporting_context');
    actions.push('verify_runtime_claims');
    return result(HEALTH.STALE, AUTHORITY.SUPPORTING, reasons, actions, { ageMs });
  }

  if (input.hasRuntimeClaims && !input.hasSourceHandles) {
    reasons.push('fresh handoff has runtime claims without source handles');
    actions.push('inject_as_supporting_context');
    actions.push('verify_runtime_claims');
    return result(HEALTH.FRESH, AUTHORITY.SUPPORTING, reasons, actions, { ageMs });
  }

  reasons.push('handoff is fresh and matches current context');
  actions.push('inject_as_active_continuity');
  if (input.hasRuntimeClaims) actions.push('verify_runtime_claims_before_current_assertions');
  return result(HEALTH.FRESH, AUTHORITY.AUTHORITATIVE, reasons, actions, { ageMs });
}

function result(status, authority, reasons, actions, extra = {}) {
  return {
    status,
    authority,
    inject: authority === AUTHORITY.AUTHORITATIVE || authority === AUTHORITY.SUPPORTING,
    requiresVerification: actions.some((a) => /verify/.test(a)),
    reasons,
    actions,
    ...extra
  };
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
  HEALTH,
  AUTHORITY,
  classifyHandoffHealth,
};
