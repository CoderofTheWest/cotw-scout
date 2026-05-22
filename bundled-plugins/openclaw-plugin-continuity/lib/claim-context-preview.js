const { createClaimContextPacket, renderClaimContextPacket, renderClaimContextAudit } = require('./claim-context');

/**
 * Build 3/5 claim context preview + gated injection helper.
 *
 * This helper is config-aware, but it does not register hooks, resolve sources,
 * persist claims, or mutate state. Build 5 may mark a packet injection-ready
 * only when the operator enables live/minimal mode and the selected claims were
 * explicitly accepted through the review decision path.
 */
function createClaimContextPreview(input = {}, options = {}) {
  const sourceConfig = input.config?.sourceAddressableMemory || {};
  const contextConfig = sourceConfig.claimContext || {};
  const enabled = contextConfig.enabled === true;
  const mode = contextConfig.mode || 'diagnostic';
  const injectMode = contextConfig.injectMode || 'none';

  if (!enabled || mode === 'off') {
    return disabledPreview({ mode, injectMode, reason: !enabled ? 'claimContext disabled' : 'claimContext mode is off' });
  }
  if (!['none', 'minimal'].includes(injectMode)) {
    return disabledPreview({ mode, injectMode, reason: 'claimContext injectMode must be none or minimal' });
  }
  const liveInjectionRequested = injectMode === 'minimal';
  if (liveInjectionRequested && mode !== 'live') {
    return disabledPreview({ mode, injectMode, reason: 'claimContext live injection requires mode=live' });
  }

  const store = input.claimStore || input.store;
  if (!store || typeof store.listClaims !== 'function') {
    return disabledPreview({ mode, injectMode, reason: 'ClaimStore listClaims(filter) required' });
  }

  const limit = normalizeLimit(input.limit ?? contextConfig.maxClaims, 8);
  const scanLimit = normalizeScanLimit(input.scanLimit ?? contextConfig.scanLimit, Math.max(limit, 100));
  const filter = {
    ...(input.filter || {}),
    agentId: input.agentId || input.filter?.agentId,
    threadId: input.threadId || input.filter?.threadId,
    limit: scanLimit,
    includeSources: true,
    includeEdges: false
  };

  let claims = store.listClaims(filter);
  const acceptedVerifiedOnly = contextConfig.acceptedVerifiedOnly !== false;
  if (liveInjectionRequested) {
    if (!acceptedVerifiedOnly) {
      return disabledPreview({ mode, injectMode, reason: 'live claim injection requires acceptedVerifiedOnly=true' });
    }
    claims = claims.filter(isAcceptedVerifiedClaim);
  }
  const includeSourceExcerpts = Boolean(input.includeSourceExcerpts || contextConfig.includeSourceExcerpts);
  const packet = createClaimContextPacket(claims, {
    limit,
    includeSourceExcerpts,
    includeRequiresVerification: !liveInjectionRequested
  });
  const injectionReady = Boolean(
    liveInjectionRequested &&
    packet.included > 0 &&
    packet.requiresVerification === 0 &&
    packet.audit?.quality?.readyForConsumptionTrial === true
  );
  return {
    ok: true,
    enabled: true,
    mode,
    injectMode,
    previewOnly: !injectionReady,
    injectionReady,
    acceptedVerifiedOnly,
    sourceResolutionAttempted: false,
    mutationAttempted: false,
    scanLimit,
    packet,
    audit: packet.audit,
    auditReport: renderClaimContextAudit(packet.audit),
    rendered: renderClaimContextPacket(packet, { includeSourceExcerpts })
  };
}

function isAcceptedVerifiedClaim(claim = {}) {
  if (claim.status !== 'active') return false;
  if (claim.metadata?.candidateOnly === true) return false;
  if (!claim.metadata?.acceptedVerifiedAt) return false;
  const decisions = Array.isArray(claim.metadata?.reviewDecisions) ? claim.metadata.reviewDecisions : [];
  return decisions.some((decision) => {
    const evidence = decision?.verificationEvidence || {};
    return decision?.decision === 'accept_verified'
      && decision?.applied === true
      && evidence.sourceResolved === true
      && evidence.comparisonAttempted === true
      && ['source_contains_claim_text', 'source_likely_supports_claim'].includes(evidence.assessment);
  });
}

function disabledPreview({ mode = 'diagnostic', injectMode = 'none', reason }) {
  return {
    ok: true,
    enabled: false,
    mode,
    injectMode,
    previewOnly: true,
    injectionReady: false,
    sourceResolutionAttempted: false,
    mutationAttempted: false,
    reason,
    packet: null,
    rendered: ''
  };
}

function normalizeLimit(value, fallback) {
  return Number.isInteger(value) ? Math.max(1, Math.min(value, 25)) : fallback;
}

function normalizeScanLimit(value, fallback) {
  return Number.isInteger(value) ? Math.max(1, Math.min(value, 500)) : fallback;
}

module.exports = {
  createClaimContextPreview,
  isAcceptedVerifiedClaim
};
