#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const {
  evaluateAutonomyPolicy,
  buildDryRunReceipt,
  summarizeAutonomyReview,
  detectAmbientSynthesisTrigger,
  detectSynthesisForm
} = require('../lib/claim-autonomy-policy');

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'autonomous-maturation-claims.json'), 'utf8'));
const results = [];

function main() {
  for (const fixture of fixtures) {
    run(`${fixture.id} follows expected lane/decision`, () => {
      const evaluation = evaluateAutonomyPolicy(fixture, fixture.evidence || {});
      const receipt = buildDryRunReceipt(fixture, evaluation);
      const expected = fixture.expected || {};

      if (expected.lane) assert.equal(evaluation.lane, expected.lane);
      if (expected.decision) assert.equal(evaluation.policyDecision, expected.decision);
      if (expected.notDecision) assert.notEqual(evaluation.policyDecision, expected.notDecision);
      if (expected.projectFactSubtype) assert.equal(evaluation.projectFactSubtype, expected.projectFactSubtype);
      if (expected.synthesisForm) assert.equal(evaluation.synthesisForm, expected.synthesisForm);
      if (Object.hasOwn(expected, 'eligibleForApply')) assert.equal(evaluation.eligibleForApply, expected.eligibleForApply);
      if (Object.hasOwn(expected, 'promptInjectionEligibilityChanged')) assert.equal(receipt.promptInjectionEligibilityChanged, expected.promptInjectionEligibilityChanged);
      if (Object.hasOwn(expected, 'mutationAttempted')) assert.equal(receipt.mutationAttempted, expected.mutationAttempted);
      for (const code of expected.reasonIncludes || []) assert.ok(evaluation.reasonCodes.includes(code), `${fixture.id} missing reason ${code}`);

      assert.equal(receipt.dryRun, true);
      assert.equal(receipt.mutationAttempted, false);
      assert.equal(receipt.promptInjectionEligibilityChanged, false);
      if (evaluation.policyDecision !== 'auto_accept') assert.equal(evaluation.eligibleForApply, false);
      if (evaluation.hypothesisSynthesisDetected) {
        assert.notEqual(evaluation.policyDecision, 'auto_accept');
        assert.equal(receipt.synthesis.kind, 'synthesis_card');
        assert.equal(receipt.synthesis.eligibleForFactAutoAccept, false);
        assert.equal(receipt.synthesis.eligibleForPromptFactInjection, false);
        assert.equal(receipt.synthesis.policy.eligibleForFactAutoAccept, false);
        assert.equal(receipt.synthesis.policy.eligibleForPromptFactInjection, false);
        assert.equal(receipt.synthesis.policy.mutationApplied, false);
      }
    });
  }

  run('hard invariant: Chris/user/relationship claims never auto-accept', () => {
    const sensitive = fixtures.filter((fixture) => /\bChris\b|\buser\b|relationship|overwhelmed|afraid|potential/i.test(fixture.claim || ''));
    assert.ok(sensitive.length >= 3);
    for (const fixture of sensitive) {
      const evaluation = evaluateAutonomyPolicy(fixture, fixture.evidence || {});
      assert.notEqual(evaluation.policyDecision, 'auto_accept', fixture.id);
      assert.equal(evaluation.eligibleForApply, false, fixture.id);
    }
  });

  run('hard invariant: claims altering Ellis treatment of Chris never auto-accept', () => {
    const fixture = fixtures.find((item) => item.id === 'procedural_wording_sensitive_user_posture');
    const evaluation = evaluateAutonomyPolicy(fixture, fixture.evidence);
    assert.equal(evaluation.policyDecision, 'chris_review');
    assert.notEqual(evaluation.policyDecision, 'auto_accept');
  });

  run('hard invariant: authority expansion never auto-accepts', () => {
    const authority = fixtures.filter((fixture) => fixture.id.startsWith('authority_expansion'));
    assert.ok(authority.length >= 2);
    for (const fixture of authority) {
      const evaluation = evaluateAutonomyPolicy(fixture, fixture.evidence || {});
      assert.ok(evaluation.authorityExpansionDetected, fixture.id);
      assert.notEqual(evaluation.policyDecision, 'auto_accept', fixture.id);
    }
  });

  run('hard invariant: source resolved without strong support never auto-accepts', () => {
    const fixture = fixtures.find((item) => item.id === 'reject_source_exists_not_support');
    const evaluation = evaluateAutonomyPolicy(fixture, fixture.evidence);
    assert.equal(fixture.evidence.sourceResolutionStatus, 'resolved');
    assert.notEqual(fixture.evidence.verificationAssessment, 'strong_support');
    assert.notEqual(evaluation.policyDecision, 'auto_accept');
  });

  run('hard invariant: broad or multi-part claims never auto-accept', () => {
    for (const id of ['reject_broad_summary_safe_autonomy', 'operator_review_architecture_synthesis']) {
      const fixture = fixtures.find((item) => item.id === id);
      const evaluation = evaluateAutonomyPolicy(fixture, fixture.evidence);
      assert.ok(evaluation.reasonCodes.includes('broad_or_multi_claim'), id);
      assert.notEqual(evaluation.policyDecision, 'auto_accept', id);
    }
  });

  run('hard invariant: current runtime-state claims never auto-accept unless rewritten historically', () => {
    const fixture = fixtures.find((item) => item.id === 'reject_stale_runtime_state');
    const evaluation = evaluateAutonomyPolicy(fixture, fixture.evidence);
    assert.ok(evaluation.reasonCodes.includes('runtime_state_stale_risk'));
    assert.ok(evaluation.reasonCodes.includes('requires_historical_rewrite'));
    assert.notEqual(evaluation.policyDecision, 'auto_accept');
  });

  run('hard invariant: generated-summary-only evidence never auto-accepts', () => {
    const fixture = fixtures.find((item) => item.id === 'reject_generated_summary_only');
    const evaluation = evaluateAutonomyPolicy(fixture, fixture.evidence);
    assert.ok(evaluation.reasonCodes.includes('source_generated_summary_only'));
    assert.notEqual(evaluation.policyDecision, 'auto_accept');
  });

  run('hard invariant: contradiction present blocks auto-accept', () => {
    const fixture = fixtures.find((item) => item.id === 'reject_contradiction_present');
    const evaluation = evaluateAutonomyPolicy(fixture, fixture.evidence);
    assert.ok(evaluation.reasonCodes.includes('contradiction_present'));
    assert.notEqual(evaluation.policyDecision, 'auto_accept');
  });

  run('hard invariant: same-run rewrite-to-accept is blocked', () => {
    const fixture = fixtures.find((item) => item.id === 'same_run_rewrite_accept_blocked');
    const evaluation = evaluateAutonomyPolicy(fixture, fixture.evidence);
    assert.ok(evaluation.reasonCodes.includes('same_run_rewrite_accept_blocked'));
    assert.notEqual(evaluation.policyDecision, 'auto_accept');
  });

  run('hard invariant: dry-run receipts produce no mutation or prompt writes', () => {
    const receipts = fixtures.map((fixture) => buildDryRunReceipt(fixture, evaluateAutonomyPolicy(fixture, fixture.evidence || {})));
    for (const receipt of receipts) {
      assert.equal(receipt.dryRun, true, receipt.claimId);
      assert.equal(receipt.mutationAttempted, false, receipt.claimId);
      assert.equal(receipt.promptInjectionEligibilityChanged, false, receipt.claimId);
    }
    const summary = summarizeAutonomyReview(receipts);
    assert.equal(summary.mutationAttempts, 0);
    assert.equal(summary.promptEligibilityChanges, 0);
  });

  run('hard invariant: prompt eligibility is not implied by accepted status', () => {
    const accepted = fixtures
      .map((fixture) => buildDryRunReceipt(fixture, evaluateAutonomyPolicy(fixture, fixture.evidence || {})))
      .filter((receipt) => receipt.policyDecision === 'auto_accept');
    assert.ok(accepted.length >= 4);
    for (const receipt of accepted) assert.equal(receipt.promptInjectionEligibilityChanged, false, receipt.claimId);
  });

  run('hard invariant: synthesis forms are distinguished and blocked from fact auto-accept', () => {
    const expectedForms = new Set(['hypothesis', 'frame', 'artifact', 'question', 'move']);
    const seen = new Set();
    for (const fixture of fixtures.filter((item) => item.kind === 'synthesis_card' || item.candidateMeta?.synthesisForm)) {
      const evaluation = evaluateAutonomyPolicy(fixture, fixture.evidence || {});
      seen.add(evaluation.synthesisForm);
      assert.notEqual(evaluation.policyDecision, 'auto_accept', fixture.id);
      assert.equal(evaluation.eligibleForApply, false, fixture.id);
    }
    assert.deepEqual(seen, expectedForms);
  });

  run('hard invariant: ambient synthesis triggers do not require explicit user request', () => {
    const fixture = fixtures.find((item) => item.id === 'ambient_synthesis_trigger_constraints');
    assert.equal(detectSynthesisForm(fixture, fixture.evidence), 'frame');
    assert.equal(detectAmbientSynthesisTrigger(fixture, fixture.evidence), true);
    const evaluation = evaluateAutonomyPolicy(fixture, fixture.evidence);
    assert.equal(evaluation.ambientSynthesisTriggerDetected, true);
    assert.equal(evaluation.lane, 'hypothesis_synthesis');
  });

  const report = renderReport(results);
  const reportPath = path.join(__dirname, 'reports', 'claim-autonomy-policy.md');
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

function run(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error && error.stack ? error.stack : String(error) });
  }
}

function renderReport(items) {
  const passed = items.filter((item) => item.ok).length;
  const lines = ['# claim-autonomy-policy test report', '', `Passed: ${passed}/${items.length}`, ''];
  for (const item of items) {
    lines.push(`- ${item.ok ? 'PASS' : 'FAIL'} ${item.name}`);
    if (!item.ok) lines.push(`  - ${String(item.error).split('\n').join('\n    ')}`);
  }
  return lines.join('\n');
}

main();
