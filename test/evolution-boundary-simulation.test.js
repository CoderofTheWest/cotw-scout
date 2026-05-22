'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const createClaimsTool = require('../bundled-plugins/openclaw-plugin-continuity/tools/continuity-claims');
const {
  createEvolutionActionGateReceipt,
  recordEvolutionActionGateReceipt
} = require('../lib/evolution-action-gate');
const {
  readEvolutionLedger,
  updateEvolutionEvent
} = require('../lib/evolution-ledger');
const {
  getSpineLedgerSnapshot,
  readSpineLedger,
  resolveSpineLedgerPath
} = require('../lib/spine-ledger');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-boundary-sim-'));
}

function createToolHarness(initialClaim) {
  const workspacePath = tmpDir();
  let claim = initialClaim;
  const claimStore = {
    getClaim(id) { return id === claim.id ? claim : null; },
    storeClaim(next) { claim = next; }
  };
  const state = {
    claimStore,
    dataDir: path.join(workspacePath, '.plugin-data'),
    knowledgeIndexer: { workspacePath },
    ensureStorage: async () => {}
  };
  return {
    workspacePath,
    evolutionLedgerPath: path.join(workspacePath, 'evolution', 'ledger.json'),
    spineLedgerPath: resolveSpineLedgerPath({ workspacePath }),
    get claim() { return claim; },
    tool: createClaimsTool(() => state, () => 'trail-guide')
  };
}

function makeClaim(overrides = {}) {
  return {
    id: 'claim-boundary-1',
    agentId: 'trail-guide',
    kind: 'summary',
    text: 'An unresolved open question that should stay out of active truth.',
    status: 'verify_required',
    confidence: 0.34,
    metadata: {},
    sources: [],
    freshness: {},
    edges: [],
    ...overrides
  };
}

function lowRiskCandidate(claimId) {
  return {
    id: `candidate-${claimId}`,
    action: 'autonomy_review_dry_run',
    class: 'claim_review',
    title: `Archive unresolved claim ${claimId}`,
    summary: 'Dry-run candidate for a single low-risk open question.',
    status: 'candidate',
    risk: 'low',
    sourceCategory: 'reject_or_archive',
    claimId,
    metadata: {
      policyDecision: 'archive_open_question',
      lane: 'reject_or_archive',
      mutationAttempted: false,
      promptInjectionEligibilityChanged: false,
      reasonCodes: ['open_question_not_active_truth']
    }
  };
}

test('live boundary simulation closes low-risk apply and rollback without granting broader authority', async () => {
  const harness = createToolHarness(makeClaim());
  const candidate = lowRiskCandidate('claim-boundary-1');

  const dryRun = await harness.tool.execute('call_apply_review_decision', {
    action: 'apply_review_decision',
    claim_id: 'claim-boundary-1',
    decision: 'archive_open_question',
    expected_status: 'verify_required',
    reason: 'boundary simulation dry run',
    apply: false
  });
  assert.match(dryRun.content[0].text, /Mutation attempted: no/);
  assert.equal(readEvolutionLedger(harness.evolutionLedgerPath).events.length, 0);
  assert.equal(harness.claim.status, 'verify_required');

  const applyGate = createEvolutionActionGateReceipt({
    id: candidate.id,
    action: 'apply_low_risk_candidate',
    entry: candidate,
    now: '2026-05-09T19:00:00.000Z'
  });
  assert.equal(applyGate.allowed, true);
  assert.equal(applyGate.riskClassification.decision, 'audit_only_autonomous');
  assert.equal(applyGate.outcomeEvent.authority.authorizationMode, 'preflight_passed_existing_domain_gate_required');
  assert.equal(applyGate.outcomeEvent.verification.evidence.mutationAuthorized, false);
  assert.equal(applyGate.outcomeEvent.verification.evidence.promptInjectionAuthorized, false);
  recordEvolutionActionGateReceipt(harness.spineLedgerPath, applyGate);

  const applyResult = await harness.tool.execute('call_apply_review_decision', {
    action: 'apply_review_decision',
    claim_id: 'claim-boundary-1',
    decision: 'archive_open_question',
    expected_status: 'verify_required',
    reason: 'boundary simulation single low-risk apply',
    apply: true
  });
  assert.match(applyResult.content[0].text, /Authorization mode: autonomous_low_risk/);
  assert.match(applyResult.content[0].text, /Mutation attempted: yes/);
  assert.equal(harness.claim.status, 'retracted');

  const afterApplyLedger = readEvolutionLedger(harness.evolutionLedgerPath);
  const appliedEvent = afterApplyLedger.events.find((event) => event.action === 'apply_review_decision');
  assert.ok(appliedEvent, 'expected applied evolution receipt');
  assert.equal(appliedEvent.status, 'applied');
  assert.equal(appliedEvent.rollbackAction.action, 'rollback_review_decision');
  assert.equal(appliedEvent.rollbackAction.claim_id, 'claim-boundary-1');

  const rollbackGate = createEvolutionActionGateReceipt({
    id: appliedEvent.id,
    action: 'rollback_claim_review',
    entry: appliedEvent,
    now: '2026-05-09T19:01:00.000Z'
  });
  assert.equal(rollbackGate.allowed, true);
  assert.equal(rollbackGate.outcomeEvent.verification.evidence.mutationAuthorized, false);
  assert.match(rollbackGate.outcomeEvent.intent.expectedEffect, /claim-review rollback path/);
  recordEvolutionActionGateReceipt(harness.spineLedgerPath, rollbackGate);

  const beforeReceipt = harness.claim.metadata.autonomyApplyReceipts.find((receipt) => receipt.phase === 'before');
  const rollbackResult = await harness.tool.execute('call_rollback_review_decision', {
    action: 'rollback_review_decision',
    claim_id: 'claim-boundary-1',
    receipt_id: beforeReceipt.id,
    reason: 'boundary simulation rollback proof',
    apply: true
  });
  assert.match(rollbackResult.content[0].text, /Mutation attempted: yes/);
  assert.equal(harness.claim.status, 'verify_required');

  const finalEvolutionLedger = readEvolutionLedger(harness.evolutionLedgerPath);
  assert.equal(finalEvolutionLedger.events.length, 2);
  assert.ok(finalEvolutionLedger.events.some((event) => event.action === 'rollback_review_decision' && event.status === 'rolled_back'));

  const disabled = updateEvolutionEvent(harness.evolutionLedgerPath, appliedEvent.id, 'disable', {
    note: 'operator disabled applied receipt after rollback proof',
    now: '2026-05-09T19:02:00.000Z'
  });
  const stripped = updateEvolutionEvent(harness.evolutionLedgerPath, appliedEvent.id, 'strip', {
    note: 'operator stripped applied receipt after rollback proof',
    now: '2026-05-09T19:03:00.000Z'
  });
  assert.equal(disabled.status, 'disabled');
  assert.equal(stripped.status, 'stripped');
  assert.deepEqual(stripped.metadata.beforeStatus, 'verify_required');

  const spineLedger = readSpineLedger(harness.spineLedgerPath);
  assert.equal(spineLedger.governorDecisions.length, 2);
  assert.equal(spineLedger.outcomeEvents.length, 2);
  assert.ok(spineLedger.outcomeEvents.every((event) => event.verification.evidence.promptInjectionAuthorized === false));
  assert.ok(spineLedger.outcomeEvents.every((event) => event.verification.evidence.schedulerAuthorized === false));
  assert.ok(spineLedger.outcomeEvents.every((event) => event.verification.evidence.mutationAuthorized === false));

  const snapshot = getSpineLedgerSnapshot(harness.spineLedgerPath, { limit: 10 });
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.policy.toolExecutionAuthorized, false);
  assert.equal(snapshot.policy.mutationAuthorized, false);
  assert.equal(snapshot.policy.promptInjectionAuthorized, false);
  assert.equal(snapshot.counts.outcomeEvents, 2);
});

test('protected authority requests persist blocked receipts that remain inspectable in the spine snapshot', () => {
  const workspacePath = tmpDir();
  const spineLedgerPath = resolveSpineLedgerPath({ workspacePath });
  const protectedActions = [
    'enable_prompt_injection',
    'enable_scheduler_linkage',
    'change_runtime_config',
    'broad_memory_promotion'
  ];

  for (const [index, action] of protectedActions.entries()) {
    const receipt = createEvolutionActionGateReceipt({
      id: `protected-${index}`,
      action,
      now: `2026-05-09T19:1${index}:00.000Z`
    });
    assert.equal(receipt.allowed, false, action);
    assert.equal(receipt.blocked, true, action);
    assert.ok(receipt.blockers.includes('protected_authority_lane_not_enabled'), action);
    assert.equal(receipt.riskClassification.decision, 'blocked', action);
    assert.equal(receipt.outcomeEvent.verification.evidence.mutationAuthorized, false, action);
    recordEvolutionActionGateReceipt(spineLedgerPath, receipt);
  }

  const snapshot = getSpineLedgerSnapshot(spineLedgerPath, { limit: 10 });
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.counts.governorDecisions, protectedActions.length);
  assert.equal(snapshot.counts.outcomeEvents, protectedActions.length);
  assert.equal(snapshot.counts.shadowEnforcementReceipts, protectedActions.length);
  assert.equal(snapshot.policy.mutationAuthorized, false);
  assert.equal(snapshot.policy.promptInjectionAuthorized, false);
  assert.equal(snapshot.policy.schedulerAuthorized, false);
  assert.ok(snapshot.latest.outcomeEvents.every((event) => event.status === 'review_requested'));
  assert.ok(snapshot.latest.outcomeEvents.every((event) => event.eventType === 'shadow_enforcement_observed'));
  assert.ok(snapshot.latest.outcomeEvents.every((event) => /No protected authority is granted/.test(event.intent.expectedEffect)));
});
