'use strict';

const { evaluateAutonomyPolicy, buildDryRunReceipt, summarizeAutonomyReview } = require('./claim-autonomy-policy');

const DEFAULT_STATUSES = ['verify_required', 'stale'];

async function reviewClaimStoreCandidates({
  claimStore,
  agentId = null,
  limit = 25,
  statuses = DEFAULT_STATUSES,
  kinds = null,
  evidenceByClaimId = {},
  evidenceProvider = null
} = {}) {
  if (!claimStore || typeof claimStore.listClaims !== 'function') throw new Error('claimStore with listClaims is required');
  const claims = claimStore.listClaims({
    agentId: agentId || undefined,
    statuses: Array.isArray(statuses) && statuses.length ? statuses : undefined,
    kinds: Array.isArray(kinds) && kinds.length ? kinds : undefined,
    includeSources: true,
    includeEdges: true,
    limit
  });
  const receipts = [];

  for (const claim of claims) {
    const candidate = normalizeStoredClaimCandidate(claim);
    const suppliedEvidence = evidenceByClaimId[claim.id] || claim.metadata?.autonomyEvidence || null;
    const evidence = suppliedEvidence || await maybeProvideEvidence(evidenceProvider, { claim, candidate });
    const normalizedEvidence = normalizeStoredClaimEvidence(claim, evidence || {});
    const evaluation = evaluateAutonomyPolicy(candidate, normalizedEvidence);
    receipts.push(buildDryRunReceipt(candidate, evaluation));
  }

  return {
    dryRun: true,
    mutationAttempted: false,
    promptInjectionEligibilityChanged: false,
    candidateCount: receipts.length,
    receipts,
    summary: summarizeAutonomyReview(receipts)
  };
}

function normalizeStoredClaimCandidate(claim = {}) {
  return {
    id: claim.id,
    claim: claim.claim,
    status: claim.status,
    sourceHandles: sourceHandlesForClaim(claim),
    category: categoryForClaimKind(claim.kind),
    confidence: claim.confidence,
    candidateMeta: {
      category: categoryForClaimKind(claim.kind),
      claimKind: claim.kind,
      stalenessPolicy: claim.freshness?.stalenessPolicy || null,
      source: 'claim_store'
    },
    metadata: {
      ...(claim.metadata || {}),
      claimKind: claim.kind,
      stalenessPolicy: claim.freshness?.stalenessPolicy || null
    }
  };
}

function normalizeStoredClaimEvidence(claim = {}, evidence = {}) {
  const sources = sourceHandlesForClaim(claim);
  const contradictionPresent = evidence.contradictionPresent === true || hasContradictionEdge(claim);
  const contradictionChecked = evidence.contradictionChecked === true
    ? true
    : evidence.contradictionPresent === true
      ? true
      : false;

  return {
    sourceResolutionStatus: evidence.sourceResolutionStatus || evidence.resolutionStatus || 'not_attempted',
    verificationAssessment: evidence.verificationAssessment || evidence.assessment || 'not_attempted',
    sourceType: evidence.sourceType || sourceTypeForClaim(claim),
    generatedSummaryOnly: evidence.generatedSummaryOnly === true || claim.kind === 'summary',
    sourceEchoClusterDetected: evidence.sourceEchoClusterDetected === true,
    contradictionChecked,
    contradictionPresent,
    staleRuntimeWarning: evidence.staleRuntimeWarning === true || claim.kind === 'runtime',
    sameRunRewrite: evidence.sameRunRewrite === true || claim.metadata?.sameRunRewrite === true,
    sourceHandlesPresent: sources.length > 0,
    historicalRewrite: evidence.historicalRewrite === true
  };
}

async function maybeProvideEvidence(provider, context) {
  if (typeof provider !== 'function') return null;
  return await provider(context);
}

function categoryForClaimKind(kind) {
  if (kind === 'project_state') return 'project_fact';
  if (kind === 'runtime') return 'runtime';
  if (kind === 'identity' || kind === 'user_preference' || kind === 'commitment') return 'user_sensitive';
  if (kind === 'interpretation') return 'relationship_interpretation';
  if (kind === 'summary') return 'summary';
  return kind || 'unknown';
}

function sourceTypeForClaim(claim = {}) {
  if (claim.kind === 'project_state') return 'project_artifact';
  if (claim.kind === 'runtime') return 'unknown';
  if (claim.kind === 'summary') return 'generated_summary';
  return 'candidate_record';
}

function sourceHandlesForClaim(claim = {}) {
  return [...new Set((claim.sources || []).map((source) => typeof source === 'string' ? source : source?.handle).filter(Boolean))];
}

function hasContradictionEdge(claim = {}) {
  return (claim.edges || []).some((edge) => edge.relation === 'contradicts');
}

module.exports = {
  DEFAULT_STATUSES,
  reviewClaimStoreCandidates,
  normalizeStoredClaimCandidate,
  normalizeStoredClaimEvidence
};
