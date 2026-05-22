'use strict';

const crypto = require('crypto');
const { CLAIM_STATUSES } = require('./claim-records');
const { normalizeSourceRefs } = require('./source-handles');

const APPLY_REVIEW_DECISIONS = Object.freeze({
  ARCHIVE_OPEN_QUESTION: 'archive_open_question',
  HOLD_AS_HYPOTHESIS: 'hold_as_hypothesis'
});

const AUTHORIZATION_MODES = Object.freeze({
  DRY_RUN: 'dry_run',
  AUTONOMOUS_LOW_RISK: 'autonomous_low_risk',
  OPERATOR_APPROVED: 'operator_approved',
  REFUSED: 'refused'
});

const ALLOWED_DECISIONS = new Set(Object.values(APPLY_REVIEW_DECISIONS));
const ALLOWED_CURRENT_STATUSES = new Set([CLAIM_STATUSES.VERIFY_REQUIRED, CLAIM_STATUSES.STALE]);

function createAutonomyReviewDecisionApply(input = {}, options = {}) {
  const claimStore = input.claimStore;
  if (!claimStore || typeof claimStore.getClaim !== 'function') throw new Error('claimStore with getClaim is required');
  const claimId = required(input.claimId || input.claim_id, 'claim_id');
  const decision = normalizeDecision(input.decision);
  const expectedStatus = required(input.expectedStatus || input.expected_status || input.expected_current_status, 'expected_status');
  const agentId = input.agentId || input.agent_id || null;
  const apply = input.apply === true;
  const now = options.now || input.now || new Date().toISOString();
  const reason = normalizeReason(input.reason);
  const operatorApproval = String(input.operatorApproval || input.operator_approval || '').trim();
  const requiredApproval = approvalString({ claimId, decision, expectedStatus });

  const claim = claimStore.getClaim(claimId);
  if (!claim) throw new Error(`claim not found: ${claimId}`);
  if (agentId && claim.agentId !== agentId) throw new Error(`claim ${claimId} does not belong to agent ${agentId}`);

  const preliminaryBlockers = evaluateBlockers({ claim, decision, expectedStatus, reason });
  const lowRisk = preliminaryBlockers.length === 0;
  const operatorApproved = operatorApproval === requiredApproval;
  const operatorApprovalRequired = apply === true && !lowRisk;
  const blockers = operatorApprovalRequired && !operatorApproved
    ? unique(preliminaryBlockers.concat('operator_approval_mismatch'))
    : preliminaryBlockers;
  const authorizationMode = authorizationModeFor({ apply, blockers, lowRisk, operatorApproved });
  const beforeReceipt = buildReceipt({ phase: 'before', claim, decision, expectedStatus, apply, now, reason, requiredApproval, blockers, mutationAttempted: false, authorizationMode, operatorApprovalRequired, operatorApprovalProvided: Boolean(operatorApproval) });
  const plannedClaim = buildPlannedClaim(claim, { decision, now, reason });
  const afterPreview = buildAfterPreview(claim, plannedClaim);

  if (!apply || blockers.length) {
    return {
      ok: blockers.length === 0,
      dryRun: true,
      mutationAttempted: false,
      promptInjectionEligibilityChanged: false,
      action: 'apply_review_decision',
      decision,
      claimId,
      agentId: claim.agentId,
      beforeStatus: claim.status,
      afterStatus: plannedClaim.status,
      expectedStatus,
      requiredApproval,
      operatorApprovalRequired,
      authorizationMode,
      blockers,
      beforeReceipt,
      afterPreview,
      boundaries: boundariesFor(decision, false)
    };
  }

  if (typeof claimStore.storeClaim !== 'function') throw new Error('claimStore with storeClaim is required for apply_review_decision apply=true');

  const beforeClaim = withAppendedReceipt(claim, beforeReceipt, now);
  claimStore.storeClaim(beforeClaim);

  const afterReceipt = buildReceipt({
    phase: 'after',
    claim: beforeClaim,
    decision,
    expectedStatus,
    apply,
    now,
    reason,
    requiredApproval,
    blockers: [],
    mutationAttempted: true,
    afterStatus: plannedClaim.status,
    authorizationMode,
    operatorApprovalRequired,
    operatorApprovalProvided: Boolean(operatorApproval)
  });
  const afterClaim = withAppendedReceipt(buildPlannedClaim(beforeClaim, { decision, now, reason }), afterReceipt, now);
  claimStore.storeClaim(afterClaim);

  return {
    ok: true,
    dryRun: false,
    mutationAttempted: true,
    promptInjectionEligibilityChanged: false,
    action: 'apply_review_decision',
    decision,
    claimId,
    agentId: claim.agentId,
    beforeStatus: claim.status,
    afterStatus: afterClaim.status,
    expectedStatus,
    requiredApproval,
    operatorApprovalRequired,
    authorizationMode,
    blockers: [],
    beforeReceipt,
    afterReceipt,
    afterPreview: buildAfterPreview(claim, afterClaim),
    boundaries: boundariesFor(decision, true)
  };
}

function createAutonomyReviewDecisionRollback(input = {}, options = {}) {
  const claimStore = input.claimStore;
  if (!claimStore || typeof claimStore.getClaim !== 'function') throw new Error('claimStore with getClaim is required');
  const claimId = required(input.claimId || input.claim_id, 'claim_id');
  const agentId = input.agentId || input.agent_id || null;
  const apply = input.apply === true;
  const now = options.now || input.now || new Date().toISOString();
  const reason = normalizeReason(input.reason);
  const receiptId = String(input.receiptId || input.receipt_id || '').trim();

  const claim = claimStore.getClaim(claimId);
  if (!claim) throw new Error(`claim not found: ${claimId}`);
  if (agentId && claim.agentId !== agentId) throw new Error(`claim ${claimId} does not belong to agent ${agentId}`);

  const receipts = Array.isArray(claim.metadata?.autonomyApplyReceipts) ? claim.metadata.autonomyApplyReceipts.slice() : [];
  const targetReceipt = selectRollbackReceipt(receipts, receiptId);
  const blockers = [];
  if (!targetReceipt) blockers.push(receiptId ? 'rollback_receipt_not_found' : 'no_rollback_receipt_found');
  if (!targetReceipt?.rollback) blockers.push('rollback_snapshot_missing');
  if (!reason) blockers.push('reason_required');

  const plannedClaim = targetReceipt?.rollback ? buildRolledBackClaim(claim, targetReceipt, { now }) : claim;
  const rollbackReceipt = buildRollbackReceipt({ claim, targetReceipt, apply, now, reason, blockers, mutationAttempted: false, afterStatus: plannedClaim.status });

  if (!apply || blockers.length) {
    return {
      ok: blockers.length === 0,
      dryRun: true,
      mutationAttempted: false,
      promptInjectionEligibilityChanged: false,
      action: 'rollback_review_decision',
      claimId,
      agentId: claim.agentId,
      receiptId: targetReceipt?.id || receiptId || null,
      beforeStatus: claim.status,
      afterStatus: plannedClaim.status,
      blockers,
      rollbackReceipt,
      afterPreview: buildAfterPreview(claim, plannedClaim),
      boundaries: rollbackBoundaries(false)
    };
  }

  if (typeof claimStore.storeClaim !== 'function') throw new Error('claimStore with storeClaim is required for rollback_review_decision apply=true');

  const afterClaim = buildRolledBackClaim(claim, targetReceipt, { now });
  const appliedReceipt = buildRollbackReceipt({ claim, targetReceipt, apply, now, reason, blockers: [], mutationAttempted: true, afterStatus: afterClaim.status });
  claimStore.storeClaim(withAppendedReceipt(afterClaim, appliedReceipt, now));

  return {
    ok: true,
    dryRun: false,
    mutationAttempted: true,
    promptInjectionEligibilityChanged: false,
    action: 'rollback_review_decision',
    claimId,
    agentId: claim.agentId,
    receiptId: targetReceipt.id,
    beforeStatus: claim.status,
    afterStatus: afterClaim.status,
    blockers: [],
    rollbackReceipt: appliedReceipt,
    afterPreview: buildAfterPreview(claim, afterClaim),
    boundaries: rollbackBoundaries(true)
  };
}

function evaluateBlockers({ claim, decision, expectedStatus, reason }) {
  const blockers = [];
  if (!ALLOWED_DECISIONS.has(decision)) blockers.push('unsupported_decision');
  if (claim.status !== expectedStatus) blockers.push('expected_status_mismatch');
  if (!ALLOWED_CURRENT_STATUSES.has(claim.status)) blockers.push('current_status_not_apply_target');
  if (claim.status === CLAIM_STATUSES.ACTIVE) blockers.push('active_claim_promotion_or_mutation_refused');
  if (decision === APPLY_REVIEW_DECISIONS.HOLD_AS_HYPOTHESIS && claim.kind !== 'summary' && claim.kind !== 'interpretation') blockers.push('hold_as_hypothesis_limited_to_summary_or_interpretation');
  if (!reason) blockers.push('reason_required');
  return unique(blockers);
}

function authorizationModeFor({ apply, blockers, lowRisk, operatorApproved }) {
  if (apply !== true) return AUTHORIZATION_MODES.DRY_RUN;
  if (blockers?.length) return AUTHORIZATION_MODES.REFUSED;
  if (operatorApproved) return AUTHORIZATION_MODES.OPERATOR_APPROVED;
  if (lowRisk) return AUTHORIZATION_MODES.AUTONOMOUS_LOW_RISK;
  return AUTHORIZATION_MODES.REFUSED;
}

function buildPlannedClaim(claim, { decision, now, reason }) {
  const next = {
    ...claim,
    updatedAt: now,
    metadata: {
      ...(claim.metadata || {}),
      autonomyReviewDecision: decision,
      autonomyReviewReason: reason,
      autonomyReviewUpdatedAt: now
    },
    freshness: { ...(claim.freshness || {}) },
    sources: normalizeSourceRefs(claim.sources || []),
    edges: Array.isArray(claim.edges) ? claim.edges.slice() : []
  };

  if (decision === APPLY_REVIEW_DECISIONS.ARCHIVE_OPEN_QUESTION) {
    next.status = CLAIM_STATUSES.RETRACTED;
    next.metadata.archivedOpenQuestionAt = now;
    next.metadata.archivedOpenQuestion = true;
    next.speechGuidance = 'Archived open question; do not assert as fact.';
  } else if (decision === APPLY_REVIEW_DECISIONS.HOLD_AS_HYPOTHESIS) {
    next.status = claim.status;
    next.metadata.candidateOnly = true;
    next.metadata.hypothesisOnly = true;
    next.metadata.heldAsHypothesisAt = now;
    next.speechGuidance = 'Hold as hypothesis only; do not assert as fact.';
  }

  return next;
}

function buildReceipt({ phase, claim, decision, expectedStatus, apply, now, reason, requiredApproval, blockers, mutationAttempted, afterStatus, authorizationMode, operatorApprovalRequired, operatorApprovalProvided }) {
  return {
    id: stableReceiptId({ phase, claimId: claim.id, decision, expectedStatus, now }),
    phase,
    action: 'apply_review_decision',
    claimId: claim.id,
    agentId: claim.agentId,
    decision,
    expectedStatus,
    beforeStatus: claim.status,
    afterStatus: afterStatus || null,
    reason,
    applyRequested: apply === true,
    dryRun: apply !== true || (blockers || []).length > 0,
    mutationAttempted: mutationAttempted === true,
    promptInjectionEligibilityChanged: false,
    sourceResolutionAttempted: false,
    promotionAttempted: false,
    requiredApproval,
    operatorApprovalRequired: operatorApprovalRequired === true,
    operatorApprovalProvided: operatorApprovalProvided === true,
    authorizationMode: authorizationMode || AUTHORIZATION_MODES.DRY_RUN,
    riskBoundary: 'low_risk_single_claim_review_decision',
    blockers: blockers || [],
    rollback: phase === 'before' ? rollbackSnapshot(claim) : null,
    createdAt: now
  };
}

function buildRollbackReceipt({ claim, targetReceipt, apply, now, reason, blockers, mutationAttempted, afterStatus }) {
  return {
    id: stableReceiptId({ phase: 'rollback', claimId: claim.id, restoresReceiptId: targetReceipt?.id || null, now }),
    phase: 'rollback',
    action: 'rollback_review_decision',
    claimId: claim.id,
    agentId: claim.agentId,
    restoresReceiptId: targetReceipt?.id || null,
    beforeStatus: claim.status,
    afterStatus: afterStatus || null,
    reason,
    applyRequested: apply === true,
    dryRun: apply !== true || (blockers || []).length > 0,
    mutationAttempted: mutationAttempted === true,
    promptInjectionEligibilityChanged: false,
    sourceResolutionAttempted: false,
    promotionAttempted: false,
    authorizationMode: apply === true && !(blockers || []).length ? AUTHORIZATION_MODES.OPERATOR_APPROVED : AUTHORIZATION_MODES.DRY_RUN,
    riskBoundary: 'operator_requested_rollback',
    blockers: blockers || [],
    rollback: null,
    createdAt: now
  };
}

function rollbackSnapshot(claim) {
  return {
    status: claim.status,
    speechGuidance: claim.speechGuidance || null,
    freshness: claim.freshness || {},
    metadata: claim.metadata || {}
  };
}

function selectRollbackReceipt(receipts = [], receiptId = '') {
  const beforeReceipts = receipts.filter((receipt) => receipt?.phase === 'before' && receipt.rollback);
  if (receiptId) return beforeReceipts.find((receipt) => receipt.id === receiptId) || null;
  return beforeReceipts[beforeReceipts.length - 1] || null;
}

function buildRolledBackClaim(claim, beforeReceipt, { now }) {
  const rollback = beforeReceipt.rollback || {};
  const existingReceipts = Array.isArray(claim.metadata?.autonomyApplyReceipts) ? claim.metadata.autonomyApplyReceipts.slice() : [];
  return {
    ...claim,
    status: rollback.status || claim.status,
    speechGuidance: rollback.speechGuidance,
    freshness: rollback.freshness || claim.freshness || {},
    metadata: {
      ...(rollback.metadata || {}),
      autonomyApplyReceipts: existingReceipts
    },
    updatedAt: now,
    sources: normalizeSourceRefs(claim.sources || []),
    edges: Array.isArray(claim.edges) ? claim.edges.slice() : []
  };
}

function withAppendedReceipt(claim, receipt, now) {
  const receipts = Array.isArray(claim.metadata?.autonomyApplyReceipts) ? claim.metadata.autonomyApplyReceipts.slice() : [];
  receipts.push(receipt);
  return {
    ...claim,
    updatedAt: now,
    sources: normalizeSourceRefs(claim.sources || []),
    metadata: {
      ...(claim.metadata || {}),
      autonomyApplyReceipts: receipts
    }
  };
}

function buildAfterPreview(beforeClaim, afterClaim) {
  return {
    beforeStatus: beforeClaim.status,
    afterStatus: afterClaim.status,
    beforeSpeechGuidance: beforeClaim.speechGuidance || null,
    afterSpeechGuidance: afterClaim.speechGuidance || null,
    metadataChanged: hashStable(beforeClaim.metadata || {}) !== hashStable(afterClaim.metadata || {}),
    sourcesChanged: hashStable(normalizeSourceRefs(beforeClaim.sources || [])) !== hashStable(normalizeSourceRefs(afterClaim.sources || [])),
    freshnessChanged: hashStable(beforeClaim.freshness || {}) !== hashStable(afterClaim.freshness || {})
  };
}

function renderAutonomyReviewDecisionApply(result = {}) {
  const lines = [];
  lines.push('# Claim Autonomy Review Decision');
  lines.push('');
  lines.push(`- Action: ${result.action || 'apply_review_decision'}`);
  lines.push(`- Dry run: ${result.dryRun === true ? 'yes' : 'no'}`);
  lines.push(`- Mutation attempted: ${result.mutationAttempted === true ? 'yes' : 'no'}`);
  lines.push(`- Prompt injection eligibility changed: ${result.promptInjectionEligibilityChanged === true ? 'yes' : 'no'}`);
  lines.push(`- Decision: ${result.decision || 'unknown'}`);
  lines.push(`- Claim: ${result.claimId || 'unknown'}`);
  lines.push(`- Status: ${result.beforeStatus || 'unknown'} -> ${result.afterStatus || 'unknown'}`);
  lines.push(`- Expected current status: ${result.expectedStatus || 'unknown'}`);
  lines.push('');
  lines.push('## Operator approval');
  lines.push(`- Required for low-risk apply: ${result.operatorApprovalRequired === true ? 'yes' : 'no'}`);
  lines.push(`- Exact approval string: ${result.requiredApproval || 'unknown'}`);
  if (result.authorizationMode) lines.push(`- Authorization mode: ${result.authorizationMode}`);
  if (result.blockers?.length) {
    lines.push('');
    lines.push('## Blockers');
    for (const blocker of result.blockers) lines.push(`- ${blocker}`);
  }
  lines.push('');
  lines.push('## Planned mutation');
  const preview = result.afterPreview || {};
  lines.push(`- Status: ${preview.beforeStatus || result.beforeStatus || 'unknown'} -> ${preview.afterStatus || result.afterStatus || 'unknown'}`);
  lines.push(`- Metadata changed: ${preview.metadataChanged === true ? 'yes' : 'no'}`);
  lines.push(`- Sources changed: ${preview.sourcesChanged === true ? 'yes' : 'no'}`);
  lines.push(`- Freshness changed: ${preview.freshnessChanged === true ? 'yes' : 'no'}`);
  lines.push('');
  lines.push('## Receipts');
  if (result.beforeReceipt) lines.push(`- before: ${result.beforeReceipt.id} / mutation=${result.beforeReceipt.mutationAttempted === true ? 'yes' : 'no'}`);
  if (result.afterReceipt) lines.push(`- after: ${result.afterReceipt.id} / mutation=${result.afterReceipt.mutationAttempted === true ? 'yes' : 'no'}`);
  lines.push('');
  lines.push('## Boundaries');
  for (const boundary of result.boundaries || boundariesFor(result.decision, result.mutationAttempted)) lines.push(`- ${boundary}`);
  return lines.join('\n');
}

function renderAutonomyReviewDecisionRollback(result = {}) {
  const lines = [];
  lines.push('# Claim Autonomy Review Rollback');
  lines.push('');
  lines.push(`- Action: ${result.action || 'rollback_review_decision'}`);
  lines.push(`- Dry run: ${result.dryRun === true ? 'yes' : 'no'}`);
  lines.push(`- Mutation attempted: ${result.mutationAttempted === true ? 'yes' : 'no'}`);
  lines.push(`- Prompt injection eligibility changed: ${result.promptInjectionEligibilityChanged === true ? 'yes' : 'no'}`);
  lines.push(`- Claim: ${result.claimId || 'unknown'}`);
  lines.push(`- Restores receipt: ${result.receiptId || 'latest rollback snapshot'}`);
  lines.push(`- Status: ${result.beforeStatus || 'unknown'} -> ${result.afterStatus || 'unknown'}`);
  if (result.blockers?.length) {
    lines.push('');
    lines.push('## Blockers');
    for (const blocker of result.blockers) lines.push(`- ${blocker}`);
  }
  lines.push('');
  lines.push('## Planned rollback');
  const preview = result.afterPreview || {};
  lines.push(`- Status: ${preview.beforeStatus || result.beforeStatus || 'unknown'} -> ${preview.afterStatus || result.afterStatus || 'unknown'}`);
  lines.push(`- Metadata changed: ${preview.metadataChanged === true ? 'yes' : 'no'}`);
  lines.push(`- Sources changed: ${preview.sourcesChanged === true ? 'yes' : 'no'}`);
  lines.push(`- Freshness changed: ${preview.freshnessChanged === true ? 'yes' : 'no'}`);
  lines.push('');
  lines.push('## Receipts');
  if (result.rollbackReceipt) lines.push(`- rollback: ${result.rollbackReceipt.id} / mutation=${result.rollbackReceipt.mutationAttempted === true ? 'yes' : 'no'}`);
  lines.push('');
  lines.push('## Boundaries');
  for (const boundary of result.boundaries || rollbackBoundaries(result.mutationAttempted)) lines.push(`- ${boundary}`);
  return lines.join('\n');
}

function boundariesFor(decision, applied) {
  return [
    'single claim only',
    `decision limited to ${Array.from(ALLOWED_DECISIONS).join(' or ')}`,
    'does not promote claims to active truth',
    'does not inject prompt context',
    'does not resolve source handles',
    'does not change source excerpts or provenance handles',
    'does not batch apply',
    'does not change prompt-injection eligibility',
    applied ? 'before and after audit receipts written to claim metadata' : 'dry-run/refusal only; no mutation'
  ];
}

function rollbackBoundaries(applied) {
  return [
    'single claim only',
    'restores only from a stored before-receipt rollback snapshot',
    'does not promote claims beyond the stored rollback state',
    'does not inject prompt context',
    'does not resolve source handles',
    'does not batch apply',
    applied ? 'rollback receipt written to claim metadata' : 'dry-run/refusal only; no mutation'
  ];
}

function normalizeDecision(value) {
  const decision = String(value || '').trim().toLowerCase();
  if (!ALLOWED_DECISIONS.has(decision)) throw new Error(`unsupported decision "${decision || '(empty)'}"; use: ${Array.from(ALLOWED_DECISIONS).join(', ')}`);
  return decision;
}

function normalizeReason(value) {
  return String(value || '').trim();
}

function approvalString({ claimId, decision, expectedStatus }) {
  return `approve:${claimId}:${decision}:${expectedStatus}`;
}

function stableReceiptId(input) {
  return `claim_apply_${crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16)}`;
}

function hashStable(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value || {})).digest('hex');
}

function required(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function unique(items = []) {
  return [...new Set(items.filter(Boolean))];
}

module.exports = {
  APPLY_REVIEW_DECISIONS,
  AUTHORIZATION_MODES,
  approvalString,
  createAutonomyReviewDecisionApply,
  createAutonomyReviewDecisionRollback,
  renderAutonomyReviewDecisionApply,
  renderAutonomyReviewDecisionRollback
};
