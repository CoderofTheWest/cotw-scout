'use strict';

const APPLY_GATE_DECISIONS = Object.freeze({
  REFUSE_NOT_IMPLEMENTED: 'refuse_not_implemented',
  DESIGN_REVIEW_REQUIRED: 'design_review_required'
});

const FUTURE_APPLY_PRECONDITIONS = Object.freeze([
  'operator_explicitly_confirms_apply_for_this_run',
  'all_targets_have_current_dry_run_receipts',
  'each_target_policy_decision_is_auto_accept',
  'each_target_receipt_is_apply_eligible',
  'no_target_is_synthesis_sensitive_operator_review_reject_or_archive',
  'no_prompt_injection_eligibility_change_is_allowed',
  'rollback_receipt_is_written_before_any_mutation',
  'post_apply_receipt_records_exact_mutation_and_verification_result'
]);

function evaluateApplyGate(input = {}) {
  const receipts = Array.isArray(input.receipts) ? input.receipts : [];
  const blockers = [];
  const warnings = [];
  const counters = summarizeReceipts(receipts);

  blockers.push('apply_not_implemented_in_build_7_slice');
  if (receipts.length === 0) blockers.push('no_current_dry_run_receipts_supplied');
  if (counters.notAutoAccept > 0) blockers.push('non_auto_accept_receipts_present');
  if (counters.notApplyEligible > 0) blockers.push('non_apply_eligible_receipts_present');
  if (counters.synthesis > 0) blockers.push('synthesis_cards_are_never_apply_targets');
  if (counters.sensitive > 0) blockers.push('sensitive_or_operator_review_receipts_require_human_review');
  if (counters.rejectedOrArchived > 0) blockers.push('rejected_or_archived_receipts_cannot_apply');
  if (counters.promptEligibilityChanges > 0) blockers.push('prompt_injection_eligibility_change_requested');
  if (counters.mutationAttempts > 0) blockers.push('receipt_already_records_mutation_attempt');

  if (counters.autoAccept > 0 && counters.autoAccept === receipts.length) {
    warnings.push('auto_accept_is_a_review_classification_not_mutation_permission');
  }

  return {
    gate: 'claim_autonomy_apply',
    requested: input.requested === true,
    decision: APPLY_GATE_DECISIONS.REFUSE_NOT_IMPLEMENTED,
    executionAllowed: false,
    dryRun: true,
    mutationAttempted: false,
    promptInjectionEligibilityChanged: false,
    rollbackRequiredBeforeMutation: true,
    receiptRequiredBeforeMutation: true,
    blockers: unique(blockers),
    warnings: unique(warnings),
    counters,
    futureApplyPreconditions: [...FUTURE_APPLY_PRECONDITIONS]
  };
}

function renderApplyGateRefusal(gate = evaluateApplyGate()) {
  const lines = [];
  lines.push('ERROR: apply mode is not implemented in Build 7 Slice 1; no mutations attempted.');
  lines.push('Apply gate: refused.');
  if (gate.blockers?.length) lines.push(`Blockers: ${gate.blockers.join(', ')}`);
  lines.push('Required before any future apply: explicit operator confirmation, current dry-run receipts, rollback receipt, post-apply receipt, and no prompt-injection eligibility change.');
  return `${lines.join('\n')}\n`;
}

function summarizeReceipts(receipts = []) {
  const counters = {
    total: receipts.length,
    autoAccept: 0,
    notAutoAccept: 0,
    applyEligible: 0,
    notApplyEligible: 0,
    synthesis: 0,
    sensitive: 0,
    rejectedOrArchived: 0,
    promptEligibilityChanges: 0,
    mutationAttempts: 0
  };

  for (const receipt of receipts) {
    if (receipt.policyDecision === 'auto_accept') counters.autoAccept += 1;
    else counters.notAutoAccept += 1;

    if (receipt.eligibleForApply === true) counters.applyEligible += 1;
    else counters.notApplyEligible += 1;

    if (receipt.hypothesisSynthesisDetected === true || receipt.synthesis || receipt.lane === 'hypothesis_synthesis') counters.synthesis += 1;
    if (receipt.lane === 'sensitive_escalation' || receipt.lane === 'operator_review' || ['chris_review', 'ellis_review'].includes(receipt.policyDecision)) counters.sensitive += 1;
    if (['reject', 'archive_open_question'].includes(receipt.policyDecision)) counters.rejectedOrArchived += 1;
    if (receipt.promptInjectionEligibilityChanged === true) counters.promptEligibilityChanges += 1;
    if (receipt.mutationAttempted === true) counters.mutationAttempts += 1;
  }

  return counters;
}

function unique(items = []) {
  return [...new Set(items.filter(Boolean))];
}

module.exports = {
  APPLY_GATE_DECISIONS,
  FUTURE_APPLY_PRECONDITIONS,
  evaluateApplyGate,
  renderApplyGateRefusal,
  summarizeReceipts
};
