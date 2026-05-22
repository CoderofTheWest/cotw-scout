const { CLAIM_STATUSES, FRESHNESS_POLICIES } = require('./claim-records');
const { PROVENANCE_EDGE_TYPES } = require('./provenance');
const { normalizeSourceRefs } = require('./source-handles');

const REVIEW_DECISIONS = Object.freeze({
  DEFER: 'defer',
  VERIFY: 'verify',
  SUPERSEDE: 'supersede',
  RETRACT: 'retract',
  ACCEPT_VERIFIED: 'accept_verified'
});

const DECISION_VALUES = new Set(Object.values(REVIEW_DECISIONS));

function createClaimReviewDecision(input = {}, options = {}) {
  const claimStore = input.claimStore;
  if (!claimStore) throw new Error('claimStore is required');
  const claimId = required(input.claimId || input.id, 'claimId');
  const decision = normalizeDecision(input.decision);
  const agentId = input.agentId || null;
  const apply = input.apply === true;
  const now = options.now || input.now || new Date().toISOString();
  const reason = String(input.reason || '').trim();
  const sourceHandle = String(input.sourceHandle || '').trim();
  const supersededBy = String(input.supersededBy || '').trim();
  const acceptedStalenessPolicy = normalizeAcceptedStalenessPolicy(input.acceptedStalenessPolicy || input.stalenessPolicy, decision);

  if ((decision === REVIEW_DECISIONS.SUPERSEDE || decision === REVIEW_DECISIONS.RETRACT || decision === REVIEW_DECISIONS.VERIFY || decision === REVIEW_DECISIONS.ACCEPT_VERIFIED) && !reason) {
    throw new Error(`review decision "${decision}" requires a reason`);
  }
  if (decision === REVIEW_DECISIONS.SUPERSEDE && !sourceHandle) {
    throw new Error('supersede decision requires a sourceHandle');
  }
  if (decision === REVIEW_DECISIONS.VERIFY && !sourceHandle) {
    throw new Error('verify decision requires a sourceHandle');
  }
  if (decision === REVIEW_DECISIONS.ACCEPT_VERIFIED && !sourceHandle) {
    throw new Error('accept_verified decision requires a sourceHandle');
  }
  if (sourceHandle) validateDecisionSourceHandle(sourceHandle);
  const verificationEvidence = normalizeVerificationEvidence(input.verificationEvidence, decision, apply);

  const claim = claimStore.getClaim(claimId);
  if (!claim) throw new Error(`claim not found: ${claimId}`);
  if (agentId && claim.agentId !== agentId) throw new Error(`claim ${claimId} does not belong to agent ${agentId}`);

  const reviewEntry = {
    decision,
    decidedAt: now,
    reason: reason || null,
    sourceHandle: sourceHandle || null,
    supersededBy: supersededBy || null,
    acceptedStalenessPolicy: acceptedStalenessPolicy || null,
    verificationEvidence: verificationEvidence || null,
    applied: apply
  };
  const updated = buildUpdatedClaim(claim, reviewEntry, now);
  const edge = decision === REVIEW_DECISIONS.SUPERSEDE && supersededBy ? {
    fromClaimId: supersededBy,
    toClaimId: claim.id,
    relation: PROVENANCE_EDGE_TYPES.SUPERSEDES,
    sourceHandle: sourceHandle || null,
    createdAt: now,
    metadata: { reason: reason || null, operatorDecision: true }
  } : null;

  if (apply) {
    claimStore.storeClaim(updated);
    if (edge && typeof claimStore.storeEdge === 'function') claimStore.storeEdge(edge);
  }

  return {
    ok: true,
    dryRun: !apply,
    mutationAttempted: apply,
    promotionAttempted: apply && decision === REVIEW_DECISIONS.ACCEPT_VERIFIED,
    decision,
    claimId: claim.id,
    agentId: claim.agentId,
    kind: claim.kind,
    beforeStatus: claim.status,
    afterStatus: updated.status,
    beforeStalenessPolicy: claim.freshness?.stalenessPolicy || null,
    afterStalenessPolicy: updated.freshness?.stalenessPolicy || null,
    acceptedStalenessPolicy: acceptedStalenessPolicy || null,
    lastVerifiedAt: updated.freshness?.lastVerifiedAt || null,
    sourceHandle: sourceHandle || null,
    supersededBy: supersededBy || null,
    edgeRecorded: Boolean(apply && edge),
    boundaries: [
      'operator decision only',
      'does not inject prompt context',
      'does not consume context automatically',
      'does not resolve source handles itself',
      decision === REVIEW_DECISIONS.ACCEPT_VERIFIED ? 'accept_verified requires resolver-backed comparison evidence when applied' : 'does not promote claims to active',
      'verify preserves existing staleness policy',
      'accept_verified requires explicit accepted staleness policy',
      apply ? 'claim metadata/status may be updated' : 'dry-run only; no mutation'
    ]
  };
}

function buildUpdatedClaim(claim, reviewEntry, now) {
  const decisions = Array.isArray(claim.metadata?.reviewDecisions) ? claim.metadata.reviewDecisions.slice() : [];
  decisions.push(reviewEntry);
  const next = {
    ...claim,
    updatedAt: now,
    metadata: {
      ...(claim.metadata || {}),
      reviewDecisions: decisions
    },
    freshness: {
      ...(claim.freshness || {})
    },
    sources: normalizeSourceRefs(claim.sources || []),
    edges: claim.edges || []
  };

  if (reviewEntry.decision === REVIEW_DECISIONS.VERIFY) {
    next.freshness.lastVerifiedAt = now;
  } else if (reviewEntry.decision === REVIEW_DECISIONS.ACCEPT_VERIFIED) {
    next.status = CLAIM_STATUSES.ACTIVE;
    next.freshness.lastVerifiedAt = now;
    next.freshness.stalenessPolicy = reviewEntry.acceptedStalenessPolicy;
    next.sources = mergeDecisionSource(next.sources, reviewEntry.sourceHandle);
    next.metadata.candidateOnly = false;
    next.metadata.acceptedVerifiedAt = now;
  } else if (reviewEntry.decision === REVIEW_DECISIONS.SUPERSEDE) {
    next.status = CLAIM_STATUSES.SUPERSEDED;
  } else if (reviewEntry.decision === REVIEW_DECISIONS.RETRACT) {
    next.status = CLAIM_STATUSES.RETRACTED;
  }

  return next;
}

function renderClaimReviewDecision(result = {}) {
  const lines = [];
  lines.push('# Claim Review Decision');
  lines.push('');
  lines.push(`- Dry run: ${result.dryRun === true ? 'yes' : 'no'}`);
  lines.push(`- Mutation attempted: ${result.mutationAttempted === true ? 'yes' : 'no'}`);
  lines.push(`- Promotion attempted: ${result.promotionAttempted === true ? 'yes' : 'no'}`);
  lines.push(`- Decision: ${result.decision || 'unknown'}`);
  lines.push(`- Claim: ${result.claimId || 'unknown'} [${result.kind || 'unknown'}]`);
  lines.push(`- Status: ${result.beforeStatus || 'unknown'} -> ${result.afterStatus || 'unknown'}`);
  lines.push(`- Staleness policy: ${result.beforeStalenessPolicy || 'unknown'} -> ${result.afterStalenessPolicy || 'unknown'}`);
  lines.push(`- Accepted staleness policy: ${result.acceptedStalenessPolicy || 'none'}`);
  lines.push(`- Last verified at: ${result.lastVerifiedAt || 'none'}`);
  lines.push(`- Source handle: ${result.sourceHandle || 'none'}`);
  lines.push(`- Superseded by: ${result.supersededBy || 'none'}`);
  lines.push(`- Edge recorded: ${result.edgeRecorded === true ? 'yes' : 'no'}`);
  lines.push('');
  lines.push('## Boundaries');
  for (const boundary of result.boundaries || []) lines.push(`- ${boundary}`);
  return lines.join('\n');
}

function normalizeDecision(value) {
  const decision = String(value || '').trim().toLowerCase();
  if (!DECISION_VALUES.has(decision)) {
    throw new Error(`unsupported review decision "${decision || '(empty)'}"; use: ${Array.from(DECISION_VALUES).join(', ')}`);
  }
  return decision;
}

function normalizeAcceptedStalenessPolicy(value, decision) {
  if (decision !== REVIEW_DECISIONS.ACCEPT_VERIFIED) return null;
  const policy = String(value || '').trim();
  const allowed = [FRESHNESS_POLICIES.EVERGREEN, FRESHNESS_POLICIES.USER_CORRECTION_WINS, FRESHNESS_POLICIES.EXPIRES_AFTER];
  if (!policy) throw new Error('accept_verified decision requires an acceptedStalenessPolicy');
  if (!allowed.includes(policy)) {
    throw new Error(`accept_verified acceptedStalenessPolicy must be one of: ${allowed.join(', ')}`);
  }
  return policy;
}

const ACCEPTED_VERIFICATION_ASSESSMENTS = new Set(['source_contains_claim_text', 'source_likely_supports_claim']);

function normalizeVerificationEvidence(value, decision, apply) {
  if (decision !== REVIEW_DECISIONS.ACCEPT_VERIFIED) return null;
  if (!apply && !value) return null;
  if (!value || typeof value !== 'object') {
    throw new Error('accept_verified apply requires resolver-backed verificationEvidence');
  }
  const assessment = String(value.assessment || '').trim();
  if (value.sourceResolved !== true) throw new Error('accept_verified verificationEvidence requires sourceResolved=true');
  if (value.comparisonAttempted !== true) throw new Error('accept_verified verificationEvidence requires comparisonAttempted=true');
  if (!ACCEPTED_VERIFICATION_ASSESSMENTS.has(assessment)) {
    throw new Error(`accept_verified verificationEvidence assessment must be one of: ${Array.from(ACCEPTED_VERIFICATION_ASSESSMENTS).join(', ')}`);
  }
  return {
    sourceResolved: true,
    comparisonAttempted: true,
    assessment,
    coverage: Number.isFinite(Number(value.coverage)) ? Number(value.coverage) : null,
    exactPhrase: value.exactPhrase === true,
    sourceHandle: value.sourceHandle || null,
    checkedAt: value.checkedAt || null
  };
}

function validateDecisionSourceHandle(sourceHandle) {
  const source = normalizeSourceRefs([{ handle: sourceHandle, role: 'verification' }])[0];
  if (!source?.valid) throw new Error(`review decision sourceHandle is invalid: ${(source?.errors || []).join('; ')}`);
}

function mergeDecisionSource(sources = [], sourceHandle) {
  const normalized = normalizeSourceRefs(sources || []);
  if (!sourceHandle || normalized.some((source) => source.handle === sourceHandle && source.role === 'verification')) return normalized;
  return normalized.concat(normalizeSourceRefs([{ handle: sourceHandle, role: 'verification' }]));
}

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

module.exports = {
  REVIEW_DECISIONS,
  createClaimReviewDecision,
  renderClaimReviewDecision
};
