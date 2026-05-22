'use strict';

const { reviewClaimStoreCandidates } = require('../bundled-plugins/openclaw-plugin-continuity/lib/claim-autonomy-review');
const {
  AUTONOMY_RISK_DECISIONS,
  classifyAutonomyRisk
} = require('./evolution-risk-classifier');
const {
  createMaturationCandidatePacketFromAutonomyReceipt,
  assertReadOnlyMaturationPacket,
  maturationPacketLabels
} = require('./agent-integration-spine');

async function listClaimEvolutionCandidates({ claimStore, agentId = 'trail-guide', limit = 80 } = {}) {
  if (!claimStore || typeof claimStore.listClaims !== 'function') {
    return { entries: [], review: null, error: 'ClaimStore listClaims(filter) required' };
  }
  const review = await reviewClaimStoreCandidates({ claimStore, agentId, limit });
  return {
    entries: reviewReceiptsToEvolutionEntries(review.receipts || []),
    review,
    error: null
  };
}

function reviewReceiptsToEvolutionEntries(receipts = []) {
  return receipts.map((receipt) => receiptToEvolutionEntry(receipt)).filter(Boolean);
}

function receiptToEvolutionEntry(receipt = {}) {
  if (!receipt.claimId) return null;
  const lane = safe(receipt.lane || 'unknown', 80);
  const decision = safe(receipt.policyDecision || 'unknown', 80);
  const reasonCodes = Array.isArray(receipt.reasonCodes) ? receipt.reasonCodes.slice(0, 10) : [];
  const sourceHandles = Array.isArray(receipt.sourceHandles) ? receipt.sourceHandles : [];
  const spinePacket = createMaturationCandidatePacketFromAutonomyReceipt(receipt);
  assertReadOnlyMaturationPacket(spinePacket);
  const spineLabels = maturationPacketLabels(spinePacket);
  const risk = riskForReceipt(receipt);
  const riskClassification = classifyAutonomyRisk(riskInputForReceipt({ receipt, lane, decision, risk }));
  const highRiskProtocol = highRiskProtocolForReceipt({ receipt, lane, decision, risk, riskClassification, sourceHandles });
  return {
    id: `candidate-${receipt.claimId}`,
    class: classForReceipt(receipt),
    title: `Review candidate: ${truncate(receipt.claimText || receipt.claimId, 96)}`,
    summary: summaryForReceipt({ decision, lane, reasonCodes, riskClassification, highRiskProtocol }),
    status: riskClassification.blocked ? 'blocked' : (highRiskProtocol ? 'held' : 'candidate'),
    risk,
    sourceCategory: lane,
    allowedBy: 'Build 7 read-only autonomy review; no mutation and no prompt injection.',
    expectedEffect: expectedEffectForDecision(decision),
    verification: sourceHandles.length
      ? `${sourceHandles.length} source handle${sourceHandles.length === 1 ? '' : 's'} present; dry-run only, source resolution not performed here.`
      : 'No source handles present; cannot mature autonomously.',
    rollback: 'No rollback needed. This is an unapplied dry-run candidate.',
    action: 'autonomy_review_dry_run',
    claimId: receipt.claimId,
    receiptId: null,
    rollbackAction: null,
    metadata: {
      lane,
      policyDecision: decision,
      reasonCodes,
      sensitivityFlags: receipt.sensitivityFlags || [],
      scopeFlags: receipt.scopeFlags || [],
      sourceHandles,
      eligibleForApply: receipt.eligibleForApply === true,
      eligibleForMinimalContext: receipt.eligibleForMinimalContext === true,
      promptInjectionEligibilityChanged: receipt.promptInjectionEligibilityChanged === true,
      mutationAttempted: receipt.mutationAttempted === true,
      synthesis: receipt.synthesis || null,
      spinePacket,
      spineLabels,
      riskClassification,
      highRiskProtocol,
      approvalCard: highRiskProtocol?.approvalCard || null
    }
  };
}

function classForReceipt(receipt = {}) {
  if (receipt.lane === 'hypothesis_synthesis') return 'hypothesis_held';
  if (receipt.lane === 'reject_or_archive') return 'memory_hygiene';
  return 'claim_review';
}

function riskForReceipt(receipt = {}) {
  if ((receipt.sensitivityFlags || []).length > 0) return 'high';
  if (receipt.policyDecision === 'chris_review' || receipt.policyDecision === 'ellis_review') return 'medium';
  return 'low';
}

function summaryForReceipt({ decision, lane, reasonCodes = [], riskClassification = {}, highRiskProtocol = null } = {}) {
  const base = `Dry-run recommends ${decision.replaceAll('_', ' ')} in ${lane.replaceAll('_', ' ')}.`;
  const reasons = reasonCodes.length ? ` Reasons: ${reasonCodes.join(', ')}.` : ' No reason codes recorded.';
  if (riskClassification.blocked) return `${base} Decision: blocked; no apply control may be exposed.${reasons}`;
  if (highRiskProtocol) return `${base} Decision: explicit approval required before any behavior-changing action.${reasons}`;
  return `${base}${reasons}`;
}

function highRiskProtocolForReceipt({ receipt = {}, lane, decision, risk, riskClassification = {}, sourceHandles = [] } = {}) {
  if (risk === 'low') return null;
  if (riskClassification.decision !== AUTONOMY_RISK_DECISIONS.APPROVAL_REQUIRED) return null;
  const reasonCodes = unique([...(receipt.reasonCodes || []), ...(riskClassification.reasonCodes || [])]);
  const target = `claim ${safe(receipt.claimId || 'unknown', 80)} · ${lane.replaceAll('_', ' ')}`;
  return {
    protocol: 'high_risk_candidate',
    posture: 'approval_required',
    candidateId: `candidate-${safe(receipt.claimId || 'unknown', 120)}`,
    actionId: 'high_risk_review_apply',
    effectClass: 'claim_maturation',
    authorityRequired: 'explicit_action_specific_user_or_operator_approval',
    targetRefs: {
      display: target,
      internal: safe(receipt.claimId || '', 160)
    },
    sourceRefs: sourceHandles.slice(0, 10),
    expiry: 'recheck required immediately before apply',
    requiredPrechecks: ['source_handle_review', 'risk_reclassification', 'rollback_plan_check', 'evolve_pre_action_gate'],
    requiredVerification: ['before_receipt', 'after_receipt', 'claim_status_readback', 'rollback_path_visible'],
    rollbackPlan: 'domain-specific claim review rollback receipt required before any apply',
    reasonCodes,
    approvalCard: {
      required: true,
      protocol: 'high_risk_candidate',
      summary: `High-risk candidate held for explicit approval. ${reasonCodes.length ? `Reasons: ${reasonCodes.join(', ')}.` : 'Reason: outside autonomous low-risk lane.'}`,
      target,
      before: 'Dry-run candidate only; no claim mutation, source resolution, prompt injection, scheduler linkage, or memory promotion has occurred.',
      after: `Only after explicit approval: ${expectedEffectForDecision(decision)}`,
      riskCategory: `${risk || 'high'} risk · ${riskClassification.policyRule || 'approval_required'}`,
      reversibility: 'Apply requires a domain-specific rollback receipt; otherwise remain dry-run only.',
      audit: `Approval must bind candidate id, action id, target refs, effect class, expiry, verification, and rollback. ${sourceHandles.length} source handle${sourceHandles.length === 1 ? '' : 's'} present.`
    }
  };
}

function riskInputForReceipt({ receipt = {}, lane, decision, risk } = {}) {
  return {
    action: decision,
    lane,
    category: lane,
    externality: 'local',
    reversibility: receipt.rollbackAvailable === false ? 'hard_to_rollback' : 'rollbackable',
    scope: (receipt.scopeFlags || []).some(flag => String(flag).includes('broad') || String(flag).includes('batch')) ? 'broad' : 'single',
    sensitivity: risk,
    promptInjection: receipt.promptInjectionEligibilityChanged === true,
    broadMemoryPromotion: receipt.eligibleForMinimalContext === true && risk !== 'low'
  };
}

function expectedEffectForDecision(decision) {
  if (decision === 'hold_as_hypothesis') return 'Keep useful synthesis available without treating it as verified belief.';
  if (decision === 'archive_open_question') return 'Keep broad or unresolved claim material out of trusted memory.';
  if (decision === 'reject') return 'Prevent unsupported candidate material from maturing.';
  if (decision === 'auto_accept') return 'Candidate may be safe to mature after verification gates pass.';
  return 'Route the candidate through the correct review lane before any memory change.';
}

function truncate(value, maxChars) {
  const text = safe(value, Math.max(1, maxChars * 2));
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function safe(value, maxChars) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function unique(items = []) {
  return [...new Set(items.filter(Boolean))];
}

module.exports = {
  listClaimEvolutionCandidates,
  reviewReceiptsToEvolutionEntries,
  receiptToEvolutionEntry
};
