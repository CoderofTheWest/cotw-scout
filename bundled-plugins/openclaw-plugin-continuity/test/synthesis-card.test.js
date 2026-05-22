#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const {
  buildSynthesisCard,
  validateSynthesisCard,
  synthesisCardFromCandidate
} = require('../lib/synthesis-card');
const { evaluateAutonomyPolicy, buildDryRunReceipt } = require('../lib/claim-autonomy-policy');

const results = [];

function main() {
  run('buildSynthesisCard creates source-addressable artifact with hard policy boundaries', () => {
    const card = buildSynthesisCard({
      form: 'artifact',
      title: 'Synthesis Card schema',
      synthesis: 'A Synthesis Card preserves creative output without laundering it into belief.',
      sourceHandles: ['file:projects/build-7/creative-synthesis-mechanism-2026-05-07.md#L1-L60'],
      pressure: { problem: 'creativity needs persistence without fact promotion', constraints: ['no prompt facts'] },
      claimBoundary: { assumptions: ['future iteration may reuse this'], unknowns: ['storage shape'] },
      testHooks: { wouldStrengthen: ['policy fixtures pass'], wouldWeaken: ['card enters trusted facts'], falsificationSignals: ['prompt injection eligibility changes'] },
      reuse: { usefulFor: ['design review'], notFor: ['verified user memory'] }
    });

    assert.equal(card.kind, 'synthesis_card');
    assert.equal(card.form, 'artifact');
    assert.ok(card.id.startsWith('synthesis_'));
    assert.equal(card.policy.lane, 'synthesis_card');
    assert.equal(card.policy.eligibleForFactAutoAccept, false);
    assert.equal(card.policy.eligibleForPromptFactInjection, false);
    assert.equal(card.policy.mutationApplied, false);
    assert.equal(card.eligibleForFactAutoAccept, false);
    assert.equal(card.eligibleForPromptFactInjection, false);
    assert.equal(validateSynthesisCard(card).ok, true);
  });

  run('validateSynthesisCard rejects cards that widen fact or prompt authority', () => {
    const card = buildSynthesisCard({ form: 'hypothesis', synthesis: 'Maybe this is useful.' });
    card.policy.eligibleForFactAutoAccept = true;
    const validation = validateSynthesisCard(card);
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.includes('policy.eligibleForFactAutoAccept must be false'));
  });

  run('synthesisCardFromCandidate preserves ambient trigger provenance', () => {
    const candidate = {
      id: 'ambient_synthesis_card_candidate',
      claim: 'A contradiction between safe autonomy and creative recombination can become a reusable frame.',
      sourceHandles: ['file:projects/build-7/creative-synthesis-mechanism-2026-05-07.md#L70-L100'],
      candidateMeta: { synthesisForm: 'frame', problemShape: 'design decision with constraints and contradiction' },
      evidence: { sourceResolutionStatus: 'resolved', verificationAssessment: 'partial_support', contradictionChecked: true, contradictionPresent: false, problemShape: 'constraints but no obvious direct answer' }
    };
    const evaluation = evaluateAutonomyPolicy(candidate, candidate.evidence);
    const card = synthesisCardFromCandidate(candidate, evaluation);

    assert.equal(card.form, 'frame');
    assert.equal(card.provenance.sourceCandidateId, candidate.id);
    assert.equal(card.provenance.ambientTriggerDetected, true);
    assert.equal(card.policy.decision, 'hold_for_iteration');
    assert.equal(validateSynthesisCard(card).ok, true);
  });

  run('dry-run synthesis receipts carry full card shape without mutation or prompt eligibility', () => {
    const candidate = {
      id: 'receipt_synthesis_card_candidate',
      kind: 'synthesis_card',
      form: 'question',
      claim: 'What would prove synthesis is useful without making it trusted belief?',
      sourceHandles: ['file:projects/build-7/creative-synthesis-mechanism-2026-05-07.md#L70-L110'],
      testHooks: { wouldStrengthen: ['read-only receipts are reused'], wouldWeaken: ['trusted fact promotion'], falsificationSignals: ['mutation applied'] },
      evidence: { sourceResolutionStatus: 'resolved', verificationAssessment: 'partial_support', contradictionChecked: true, contradictionPresent: false, creativeSynthesis: true }
    };
    const evaluation = evaluateAutonomyPolicy(candidate, candidate.evidence);
    const receipt = buildDryRunReceipt(candidate, evaluation);

    assert.equal(receipt.policyDecision, 'hold_for_iteration');
    assert.equal(receipt.eligibleForApply, false);
    assert.equal(receipt.mutationAttempted, false);
    assert.equal(receipt.promptInjectionEligibilityChanged, false);
    assert.equal(receipt.synthesis.kind, 'synthesis_card');
    assert.equal(receipt.synthesis.form, 'question');
    assert.equal(receipt.synthesis.policy.eligibleForFactAutoAccept, false);
    assert.equal(receipt.synthesis.policy.eligibleForPromptFactInjection, false);
    assert.equal(validateSynthesisCard(receipt.synthesis).ok, true);
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
  const reportPath = path.join(__dirname, 'reports', 'synthesis-card.md');
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
  const lines = ['# synthesis-card test report', '', `Passed: ${passed}/${items.length}`, ''];
  for (const item of items) {
    lines.push(`- ${item.ok ? 'PASS' : 'FAIL'} ${item.name}`);
    if (!item.ok) lines.push(`  - ${String(item.error).split('\n').join('\n    ')}`);
  }
  return lines.join('\n');
}

main();
