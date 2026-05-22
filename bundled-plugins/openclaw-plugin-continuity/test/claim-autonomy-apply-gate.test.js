#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const {
  evaluateApplyGate,
  renderApplyGateRefusal,
  summarizeReceipts
} = require('../lib/claim-autonomy-apply-gate');

const results = [];

function main() {
  run('apply gate refuses empty apply requests without mutation', () => {
    const gate = evaluateApplyGate({ requested: true });
    assert.equal(gate.decision, 'refuse_not_implemented');
    assert.equal(gate.executionAllowed, false);
    assert.equal(gate.dryRun, true);
    assert.equal(gate.mutationAttempted, false);
    assert.equal(gate.promptInjectionEligibilityChanged, false);
    assert.equal(gate.rollbackRequiredBeforeMutation, true);
    assert.ok(gate.blockers.includes('apply_not_implemented_in_build_7_slice'));
    assert.ok(gate.blockers.includes('no_current_dry_run_receipts_supplied'));
  });

  run('auto-accept receipts are necessary but still not mutation permission', () => {
    const gate = evaluateApplyGate({
      requested: true,
      receipts: [{
        claimId: 'agent_maturation_auto_accept_restart_key',
        lane: 'agent_maturation',
        policyDecision: 'auto_accept',
        eligibleForApply: true,
        mutationAttempted: false,
        promptInjectionEligibilityChanged: false
      }]
    });

    assert.equal(gate.executionAllowed, false);
    assert.equal(gate.counters.autoAccept, 1);
    assert.equal(gate.counters.applyEligible, 1);
    assert.ok(gate.blockers.includes('apply_not_implemented_in_build_7_slice'));
    assert.ok(gate.warnings.includes('auto_accept_is_a_review_classification_not_mutation_permission'));
    assert.ok(gate.futureApplyPreconditions.includes('rollback_receipt_is_written_before_any_mutation'));
  });

  run('synthesis and sensitive receipts are permanent apply blockers', () => {
    const gate = evaluateApplyGate({
      requested: true,
      receipts: [
        {
          claimId: 'synthesis_frame_not_fact_memory',
          lane: 'hypothesis_synthesis',
          policyDecision: 'hold_for_iteration',
          eligibleForApply: false,
          hypothesisSynthesisDetected: true,
          synthesis: { kind: 'synthesis_card' },
          mutationAttempted: false,
          promptInjectionEligibilityChanged: false
        },
        {
          claimId: 'sensitive_escalation_chris_values',
          lane: 'sensitive_escalation',
          policyDecision: 'chris_review',
          eligibleForApply: false,
          mutationAttempted: false,
          promptInjectionEligibilityChanged: false
        }
      ]
    });

    assert.equal(gate.executionAllowed, false);
    assert.equal(gate.counters.synthesis, 1);
    assert.equal(gate.counters.sensitive, 1);
    assert.ok(gate.blockers.includes('synthesis_cards_are_never_apply_targets'));
    assert.ok(gate.blockers.includes('sensitive_or_operator_review_receipts_require_human_review'));
  });

  run('receipt counters catch prompt eligibility changes and mutation attempts', () => {
    const counters = summarizeReceipts([
      { policyDecision: 'auto_accept', eligibleForApply: true, mutationAttempted: true, promptInjectionEligibilityChanged: true }
    ]);
    assert.equal(counters.mutationAttempts, 1);
    assert.equal(counters.promptEligibilityChanges, 1);

    const gate = evaluateApplyGate({ receipts: [{ policyDecision: 'auto_accept', eligibleForApply: true, mutationAttempted: true, promptInjectionEligibilityChanged: true }] });
    assert.ok(gate.blockers.includes('receipt_already_records_mutation_attempt'));
    assert.ok(gate.blockers.includes('prompt_injection_eligibility_change_requested'));
  });

  run('rendered refusal preserves CLI no-mutation promise', () => {
    const text = renderApplyGateRefusal(evaluateApplyGate({ requested: true }));
    assert.match(text, /apply mode is not implemented/);
    assert.match(text, /no mutations attempted/);
    assert.match(text, /Apply gate: refused/);
    assert.match(text, /rollback receipt/);
  });

  writeReport();
}

function run(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error && error.stack ? error.stack : String(error) });
  }
}

function writeReport() {
  const report = renderReport(results);
  const reportPath = path.join(__dirname, 'reports', 'claim-autonomy-apply-gate.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, report);
  const failed = results.filter((result) => !result.ok);
  if (failed.length) {
    console.error(report);
    process.exitCode = 1;
  } else {
    console.log(report);
  }
}

function renderReport(items) {
  const passed = items.filter((item) => item.ok).length;
  const lines = ['# claim-autonomy-apply-gate test report', '', `Passed: ${passed}/${items.length}`, ''];
  for (const item of items) {
    lines.push(`- ${item.ok ? 'PASS' : 'FAIL'} ${item.name}`);
    if (!item.ok) lines.push(`  - ${String(item.error).split('\n').join('\n    ')}`);
  }
  return lines.join('\n');
}

main();
