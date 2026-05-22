const assert = require('node:assert/strict');
const test = require('node:test');

const {
  reviewReceiptsToEvolutionEntries,
  receiptToEvolutionEntry
} = require('../lib/evolution-candidates');

test('receiptToEvolutionEntry exposes Build 7 dry-run candidates without mutation controls', () => {
  const entry = receiptToEvolutionEntry({
    claimId: 'claim-1',
    claimText: 'Gateway restart recovery should use canonical session keys.',
    sourceHandles: ['handoff:2026-05-08:main#L1-L1'],
    lane: 'agent_maturation',
    policyDecision: 'auto_accept',
    reasonCodes: ['source_not_resolved'],
    sensitivityFlags: [],
    scopeFlags: ['agent_or_runtime_scoped_claim'],
    eligibleForApply: false,
    eligibleForMinimalContext: false,
    promptInjectionEligibilityChanged: false,
    mutationAttempted: false
  });

  assert.equal(entry.id, 'candidate-claim-1');
  assert.equal(entry.action, 'autonomy_review_dry_run');
  assert.equal(entry.status, 'candidate');
  assert.equal(entry.class, 'claim_review');
  assert.equal(entry.risk, 'low');
  assert.equal(entry.claimId, 'claim-1');
  assert.equal(entry.rollbackAction, null);
  assert.equal(entry.metadata.policyDecision, 'auto_accept');
  assert.deepEqual(entry.metadata.sourceHandles, ['handoff:2026-05-08:main#L1-L1']);
  assert.equal(entry.metadata.spinePacket.packetType, 'maturation_candidate');
  assert.equal(entry.metadata.spinePacket.lifecycle.status, 'candidate');
  assert.equal(entry.metadata.spinePacket.policy.promptInjectionRisk, 'blocked');
  assert.equal(entry.metadata.spinePacket.policy.mutationPolicy, 'none');
  assert.equal(entry.metadata.spineLabels.packetType, 'maturation_candidate');
  assert.match(entry.metadata.spineLabels.consumers, /ui_review/);
  assert.match(entry.allowedBy, /read-only/);
  assert.match(entry.rollback, /No rollback needed/);
});

test('hypothesis and archive receipts map to useful Evolve classes and risk', () => {
  const entries = reviewReceiptsToEvolutionEntries([
    {
      claimId: 'claim-hypothesis',
      claimText: 'This may be useful to think with.',
      sourceHandles: ['summary:1'],
      lane: 'hypothesis_synthesis',
      policyDecision: 'hold_as_hypothesis',
      reasonCodes: ['hypothesis_not_verified_fact'],
      sensitivityFlags: ['sensitive_user_claim']
    },
    {
      claimId: 'claim-archive',
      claimText: 'A broad unresolved summary.',
      sourceHandles: [],
      lane: 'reject_or_archive',
      policyDecision: 'archive_open_question',
      reasonCodes: ['broad_or_multi_claim']
    }
  ]);

  assert.equal(entries.length, 2);
  assert.equal(entries[0].class, 'hypothesis_held');
  assert.equal(entries[0].risk, 'high');
  assert.equal(entries[0].status, 'held');
  assert.equal(entries[0].metadata.policyDecision, 'hold_as_hypothesis');
  assert.equal(entries[0].metadata.approvalCard.required, true);
  assert.equal(entries[0].metadata.approvalCard.protocol, 'high_risk_candidate');
  assert.match(entries[0].metadata.highRiskProtocol.authorityRequired, /explicit/);
  assert.equal(entries[1].class, 'memory_hygiene');
  assert.equal(entries[1].risk, 'low');
  assert.match(entries[1].verification, /No source handles/);
});

test('high-risk protocol metadata binds candidate target verification and rollback without apply authority', () => {
  const entry = receiptToEvolutionEntry({
    claimId: 'claim-sensitive-1',
    claimText: 'A sensitive relational synthesis should be handled carefully.',
    sourceHandles: ['exchange:abc#turn1'],
    lane: 'hypothesis_synthesis',
    policyDecision: 'hold_as_hypothesis',
    reasonCodes: ['sensitive_user_claim', 'source_not_resolved'],
    sensitivityFlags: ['sensitive_user_claim'],
    eligibleForApply: false,
    eligibleForMinimalContext: false,
    promptInjectionEligibilityChanged: false,
    mutationAttempted: false
  });

  assert.equal(entry.status, 'held');
  assert.equal(entry.risk, 'high');
  assert.equal(entry.metadata.riskClassification.decision, 'approval_required');
  assert.equal(entry.metadata.highRiskProtocol.protocol, 'high_risk_candidate');
  assert.equal(entry.metadata.highRiskProtocol.effectClass, 'claim_maturation');
  assert.equal(entry.metadata.highRiskProtocol.targetRefs.internal, 'claim-sensitive-1');
  assert.ok(entry.metadata.highRiskProtocol.requiredPrechecks.includes('risk_reclassification'));
  assert.ok(entry.metadata.highRiskProtocol.requiredVerification.includes('before_receipt'));
  assert.match(entry.metadata.highRiskProtocol.rollbackPlan, /rollback receipt/);
  assert.equal(entry.metadata.approvalCard.required, true);
  assert.equal(entry.metadata.approvalCard.protocol, 'high_risk_candidate');
  assert.equal(entry.rollbackAction, null);
  assert.equal(entry.metadata.eligibleForApply, false);
});
