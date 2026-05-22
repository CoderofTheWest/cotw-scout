const { CLAIM_STATUSES, assessClaimFreshness } = require('./claim-records');

/**
 * Claim diagnostics for Build 2 Patch 8.
 *
 * Runtime-inert: these helpers do not read storage, resolve sources, register
 * tools, or inject prompt context unless an explicit caller provides a store
 * and asks for a specific diagnostic. Source content is omitted by default.
 */
function createClaimDiagnostic(claim, options = {}) {
  if (!claim) {
    return {
      ok: false,
      found: false,
      action: 'missing',
      reasons: ['claim not found']
    };
  }

  const freshness = assessClaimFreshness(claim, options);
  const sources = normalizeSources(claim.sources || [], options);
  const action = chooseDiagnosticAction(claim, freshness, options);

  return {
    ok: true,
    found: true,
    id: claim.id,
    agentId: claim.agentId,
    threadId: claim.threadId || null,
    kind: claim.kind,
    claim: claim.claim,
    status: freshness.status,
    confidence: claim.confidence,
    authorityRank: claim.authorityRank,
    requiresVerification: freshness.requiresVerification,
    action,
    reasons: freshness.reasons,
    sourceCount: sources.length,
    sources,
    edgeCount: Array.isArray(claim.edges) ? claim.edges.length : 0,
    speechGuidance: claim.speechGuidance || null,
    updatedAt: claim.updatedAt || null,
    lastVerifiedAt: claim.freshness?.lastVerifiedAt || null,
    metadata: options.includeMetadata ? (claim.metadata || {}) : undefined
  };
}

function inspectClaim(store, claimId, options = {}) {
  if (!store || typeof store.getClaim !== 'function') {
    throw new Error('inspectClaim requires a ClaimStore-like object with getClaim(id)');
  }
  const claim = store.getClaim(claimId);
  return createClaimDiagnostic(claim, options);
}

async function inspectClaimWithResolvedSources(store, claimId, options = {}) {
  const diagnostic = inspectClaim(store, claimId, options);
  if (!diagnostic.ok || !options.resolveSources) return diagnostic;
  const resolver = options.resolver || options.sourceResolver;
  if (typeof resolver !== 'function') {
    return {
      ...diagnostic,
      resolvedSources: [],
      resolutionAttempted: false,
      resolutionError: 'resolver function required when resolveSources=true'
    };
  }
  const resolvedSources = [];
  for (const source of diagnostic.sources) {
    const result = await resolver(source.handle);
    resolvedSources.push(normalizeResolution(source, result, options));
  }
  return {
    ...diagnostic,
    resolutionAttempted: true,
    resolvedSources
  };
}

function summarizeClaimStore(store, filter = {}, options = {}) {
  if (!store || typeof store.listClaims !== 'function') {
    throw new Error('summarizeClaimStore requires a ClaimStore-like object with listClaims(filter)');
  }
  const claims = store.listClaims(filter);
  const diagnostics = claims.map((claim) => {
    if (options.includeSources && typeof store.getClaim === 'function') {
      return createClaimDiagnostic(store.getClaim(claim.id), options);
    }
    return createClaimDiagnostic(claim, { ...options, includeSourceExcerpts: false });
  });
  return {
    total: diagnostics.length,
    requiresVerification: diagnostics.filter((item) => item.requiresVerification).length,
    byAction: countBy(diagnostics, 'action'),
    byKind: countBy(diagnostics, 'kind'),
    claims: diagnostics
  };
}

function chooseDiagnosticAction(claim, freshness, options = {}) {
  if (!claim || freshness.status === CLAIM_STATUSES.RETRACTED) return 'do_not_use';
  if (freshness.status === CLAIM_STATUSES.SUPERSEDED) return 'do_not_use';
  if (claim.metadata?.candidateOnly === true) return 'do_not_use';
  if (claim.metadata?.fixtureOnly === true && options.includeFixtures !== true) return 'do_not_use';
  if (freshness.requiresVerification) return 'verify_before_asserting';
  return 'usable_with_qualification';
}

function normalizeSources(sources, options = {}) {
  return sources.map((source) => {
    const item = {
      handle: source.handle,
      role: source.role,
      sourceType: source.type || inferHandleType(source.handle),
      hasExcerpt: Boolean(source.excerpt),
      quoteHash: source.quoteHash || null
    };
    if (options.includeSourceExcerpts) {
      item.excerpt = truncate(source.excerpt || '', options.maxExcerptChars || 240);
    }
    if (options.includeSourceMetadata) {
      item.metadata = source.metadata || {};
    }
    return item;
  });
}

function normalizeResolution(source, result = {}, options = {}) {
  const ok = result?.ok !== false;
  const item = {
    handle: source.handle,
    ok,
    sourceType: result?.sourceType || source.sourceType || inferHandleType(source.handle),
    error: ok ? undefined : (result?.error || 'resolution failed'),
    timestamp: result?.timestamp || null,
    metadata: result?.metadata || {}
  };
  if (options.includeResolvedContent) {
    item.content = truncate(result?.content || '', options.maxResolvedContentChars || 500);
  } else {
    item.contentAvailable = Boolean(result?.content);
  }
  return stripUndefined(item);
}

function inferHandleType(handle) {
  const match = String(handle || '').match(/^([a-z_]+):/);
  return match ? match[1] : 'unknown';
}

function countBy(items, key) {
  return items.reduce((acc, item) => {
    const value = item[key] || 'unknown';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function truncate(value, maxChars) {
  const text = String(value || '');
  if (!Number.isFinite(maxChars) || text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function stripUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

module.exports = {
  createClaimDiagnostic,
  inspectClaim,
  inspectClaimWithResolvedSources,
  summarizeClaimStore,
  chooseDiagnosticAction
};
