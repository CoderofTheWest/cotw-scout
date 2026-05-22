const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  AUTHORITY_LANES,
  createAuthorityLaneEnforcementReceipt,
  recordAuthorityLaneEnforcement,
  assertAuthorityLaneEnforcementReceipt,
  classifyRuntimeAction,
  createRuntimeActionShadowPreflightReceipt,
  recordRuntimeActionShadowPreflight,
  assertRuntimeActionShadowPreflightReceipt
} = require('../lib/spine-enforcement');
const {
  getSpineLedgerSnapshot,
  readSpineLedger
} = require('../lib/spine-ledger');

function tmpLedger() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spine-enforcement-')), 'ledger.json');
}

test('shadow enforcement evaluates protected lanes without granting authority', () => {
  for (const lane of Object.values(AUTHORITY_LANES)) {
    const receipt = createAuthorityLaneEnforcementReceipt({
      requestId: `req-${lane}`,
      lane,
      requestedEffect: { effect: 'enable_lane', summary: `Enable ${lane}` },
      authority: { hasCurrentInstruction: true, toolCapabilityPresent: true },
      enforcementPolicy: { mode: 'shadow', enabledLanes: [lane] },
      now: '2026-05-09T16:00:00.000Z'
    });
    assert.equal(receipt.ok, true);
    assert.equal(receipt.authorized, false);
    assert.equal(receipt.wouldBlock, true);
    assert.equal(receipt.shadowOnly, true);
    assert.equal(receipt.governorDecision.output.toolExecutionAuthorized, false);
    assert.equal(receipt.governorDecision.output.mutationAuthorized, false);
    assert.equal(receipt.governorDecision.output.promptInjectionAuthorized, false);
    assert.equal(receipt.governorDecision.output.schedulerAuthorized, false);
    assert.equal(receipt.outcomeEvent.eventType, 'shadow_enforcement_observed');
    assert.equal(receipt.outcomeEvent.authority.authorizationMode, 'shadow_only');
    assert.equal(receipt.outcomeEvent.verification.evidence.toolExecutionAuthorized, false);
    assert.equal(receipt.outcomeEvent.verification.evidence.promptInjectionAuthorized, false);
    assert.equal(receipt.outcomeEvent.verification.evidence.schedulerAuthorized, false);
    assert.equal(receipt.outcomeEvent.verification.evidence.mutationAuthorized, false);
    assertAuthorityLaneEnforcementReceipt(receipt);
  }
});

test('kill switch hard-blocks authority lane requests even when lane is enabled', () => {
  const receipt = createAuthorityLaneEnforcementReceipt({
    requestId: 'req-kill-switch',
    lane: AUTHORITY_LANES.PROMPT_INJECTION,
    requestedEffect: { effect: 'inject_verified_context' },
    authority: { hasCurrentInstruction: true, approvalRef: 'approval-1' },
    enforcementPolicy: {
      mode: 'enforce',
      enabledLanes: [AUTHORITY_LANES.PROMPT_INJECTION],
      killSwitch: { prompt_injection: true }
    },
    now: '2026-05-09T16:01:00.000Z'
  });
  assert.equal(receipt.authorized, false);
  assert.equal(receipt.hardBlocked, true);
  assert.equal(receipt.killSwitchActive, true);
  assert.equal(receipt.governorDecision.mode, 'refuse_with_safe_alternative');
  assert.equal(receipt.outcomeEvent.status, 'blocked');
  assert.ok(receipt.reasonCodes.includes('authority_lane_kill_switch_active'));
});

test('recordAuthorityLaneEnforcement persists governor and outcome receipts for review', () => {
  const ledgerPath = tmpLedger();
  const receipt = recordAuthorityLaneEnforcement(ledgerPath, {
    requestId: 'req-scheduler-shadow',
    lane: AUTHORITY_LANES.SCHEDULER_LINKAGE,
    requestedEffect: { effect: 'start_review_job', summary: 'Link scheduler to review receipts only' },
    authority: { hasCurrentInstruction: true, activeLeaseId: 'lease-1' },
    enforcementPolicy: { mode: 'shadow', enabledLanes: [AUTHORITY_LANES.SCHEDULER_LINKAGE] },
    now: '2026-05-09T16:02:00.000Z'
  });
  const ledger = readSpineLedger(ledgerPath);
  assert.equal(ledger.governorDecisions.length, 1);
  assert.equal(ledger.outcomeEvents.length, 1);
  assert.equal(ledger.governorDecisions[0].decisionId, receipt.governorDecision.decisionId);
  assert.equal(ledger.outcomeEvents[0].eventType, 'shadow_enforcement_observed');

  const snapshot = getSpineLedgerSnapshot(ledgerPath, { limit: 5 });
  assert.equal(snapshot.counts.shadowEnforcementReceipts, 1);
  assert.equal(snapshot.policy.promptInjectionAuthorized, false);
  assert.equal(snapshot.policy.schedulerAuthorized, false);
  assert.equal(snapshot.latest.outcomeEvents[0].action.lane, AUTHORITY_LANES.SCHEDULER_LINKAGE);
  assert.equal(snapshot.latest.outcomeEvents[0].observed.enforcementMode, 'shadow');
});

test('runtime shadow preflight classifies local artifact edits outside Evolve without granting authority', () => {
  const receipt = createRuntimeActionShadowPreflightReceipt({
    requestId: 'req-runtime-local-edit',
    requestedAction: { tool: 'edit', path: '/tmp/project/secret-file.md', summary: 'Patch a local project artifact' },
    authority: { hasCurrentInstruction: true, toolCapabilityPresent: true },
    now: '2026-05-09T17:00:00.000Z'
  });

  assert.equal(receipt.ok, true);
  assert.equal(receipt.shadowOnly, true);
  assert.equal(receipt.authorized, false);
  assert.equal(receipt.actionClass, 'local_project_edit');
  assert.equal(receipt.governorDecision.requestedAction.class, 'runtime_action_shadow_preflight');
  assert.equal(receipt.governorDecision.mode, 'proceed_with_verification');
  assert.equal(receipt.governorDecision.output.toolExecutionAuthorized, false);
  assert.equal(receipt.governorDecision.output.mutationAuthorized, false);
  assert.equal(receipt.outcomeEvent.eventType, 'runtime_action_shadow_preflight');
  assert.equal(receipt.outcomeEvent.authority.authorizationMode, 'shadow_only');
  assert.equal(receipt.outcomeEvent.observed.shadowMode, true);
  assert.equal(receipt.outcomeEvent.verification.evidence.mutationAuthorized, false);
  assert.match(receipt.governorDecision.requestedAction.target, /redacted/);
  assertRuntimeActionShadowPreflightReceipt(receipt);
});

test('runtime shadow preflight routes external messages to approval posture without sending', () => {
  const receipt = createRuntimeActionShadowPreflightReceipt({
    requestId: 'req-runtime-message',
    requestedAction: { tool: 'message', recipient: '+15555550123', summary: 'Send a proactive external message' },
    authority: { hasCurrentInstruction: true, recipientConfirmed: true, intentConfirmed: true, toolCapabilityPresent: true },
    now: '2026-05-09T17:01:00.000Z'
  });

  assert.equal(receipt.actionClass, 'external_message');
  assert.equal(receipt.governorDecision.mode, 'require_approval');
  assert.equal(receipt.governorDecision.approval.required, true);
  assert.equal(receipt.governorDecision.requestedAction.target, 'phone-redacted');
  assert.doesNotMatch(receipt.governorDecision.requestedAction.target, /555/);
  assert.equal(receipt.outcomeEvent.status, 'review_requested');
  assert.equal(receipt.outcomeEvent.observed.wouldRequireApproval, true);
  assert.equal(receipt.outcomeEvent.observed.authorized, false);
  assert.equal(receipt.outcomeEvent.verification.evidence.toolExecutionAuthorized, false);
  assertRuntimeActionShadowPreflightReceipt(receipt);
});

test('runtime shadow preflight redacts command-like targets in diagnostic receipts', () => {
  const receipt = createRuntimeActionShadowPreflightReceipt({
    requestId: 'req-runtime-command-target',
    requestedAction: { tool: 'exec', action: 'exec', target: 'cat ~/.ssh/config && echo done' },
    authority: { hasCurrentInstruction: true, toolCapabilityPresent: true },
    now: '2026-05-09T17:01:30.000Z'
  });

  assert.equal(receipt.governorDecision.requestedAction.target, 'command-or-recipient-redacted');
  assert.doesNotMatch(receipt.governorDecision.requestedAction.target, /ssh|cat|echo/);
  assertRuntimeActionShadowPreflightReceipt(receipt);
});

test('runtime shadow preflight uses inferred target for classification without leaking it', () => {
  const receipt = createRuntimeActionShadowPreflightReceipt({
    requestId: 'req-runtime-target-classification',
    requestedAction: { tool: 'exec', action: 'exec', target: 'git commit -m secret-message' },
    authority: { hasCurrentInstruction: true, toolCapabilityPresent: true },
    now: '2026-05-09T17:01:45.000Z'
  });

  assert.equal(receipt.actionClass, 'local_project_edit');
  assert.equal(receipt.governorDecision.requestedAction.target, 'command-or-recipient-redacted');
  assert.doesNotMatch(receipt.governorDecision.requestedAction.target, /secret|commit/);
  assertRuntimeActionShadowPreflightReceipt(receipt);
});

test('recordRuntimeActionShadowPreflight persists runtime-wide diagnostic receipts', () => {
  const ledgerPath = tmpLedger();
  const receipt = recordRuntimeActionShadowPreflight(ledgerPath, {
    requestId: 'req-runtime-persisted-edit',
    requestedAction: { action: 'apply_patch', path: '/tmp/project/file.js' },
    authority: { hasCurrentInstruction: true },
    now: '2026-05-09T17:02:00.000Z'
  });

  const ledger = readSpineLedger(ledgerPath);
  assert.equal(ledger.governorDecisions.length, 1);
  assert.equal(ledger.outcomeEvents.length, 1);
  assert.equal(ledger.governorDecisions[0].decisionId, receipt.governorDecision.decisionId);
  assert.equal(ledger.outcomeEvents[0].eventType, 'runtime_action_shadow_preflight');

  const snapshot = getSpineLedgerSnapshot(ledgerPath, { limit: 5 });
  assert.equal(snapshot.counts.governorDecisions, 1);
  assert.equal(snapshot.latest.outcomeEvents[0].authority.authorizationMode, 'shadow_only');
  assert.equal(snapshot.policy.promptInjectionAuthorized, false);
  assert.equal(snapshot.policy.schedulerAuthorized, false);
});

test('runtime shadow preflight keeps every protected authority lane review-only', () => {
  const cases = [
    ['prompt context injection', 'inject_into_prompt_context', AUTHORITY_LANES.PROMPT_INJECTION, 'context_eligibility'],
    ['scheduler linkage', 'enable_scheduler_linkage', AUTHORITY_LANES.SCHEDULER_LINKAGE, 'background_responsibility'],
    ['tool policy mutation', 'change_tool_policy', AUTHORITY_LANES.RUNTIME_TOOL_POLICY_ENFORCEMENT, 'tool_policy'],
    ['runtime config mutation', 'change_runtime_config', AUTHORITY_LANES.CONFIG_CHANGES, 'runtime_config'],
    ['broad memory promotion', 'promote_memory_broadly', AUTHORITY_LANES.BROAD_MEMORY_PROMOTION, 'claim_maturation']
  ];

  for (const [label, action, lane, actionClass] of cases) {
    const receipt = createRuntimeActionShadowPreflightReceipt({
      requestId: `req-runtime-${lane}`,
      requestedAction: { action, effect: label },
      authority: { hasCurrentInstruction: true, activeLeaseId: 'lease-active-1', approvalRef: 'approval-present-but-shadowed', toolCapabilityPresent: true },
      now: '2026-05-09T17:03:00.000Z'
    });

    assert.equal(receipt.actionClass, actionClass, label);
    assert.equal(receipt.protectedLane, lane, label);
    assert.equal(receipt.governorDecision.approval.required, true, label);
    assert.equal(receipt.governorDecision.approval.reason, 'protected_authority_lane', label);
    assert.equal(receipt.outcomeEvent.status, 'review_requested', label);
    assert.equal(receipt.outcomeEvent.observed.wouldRequireApproval, true, label);
    assert.equal(receipt.outcomeEvent.authority.authorizationMode, 'shadow_only', label);
    assert.equal(receipt.outcomeEvent.verification.evidence.promptInjectionAuthorized, false, label);
    assert.equal(receipt.outcomeEvent.verification.evidence.schedulerAuthorized, false, label);
    assert.equal(receipt.outcomeEvent.verification.evidence.mutationAuthorized, false, label);
    assert.equal(receipt.governorDecision.output.promptInjectionAuthorized, false, label);
    assert.equal(receipt.governorDecision.output.schedulerAuthorized, false, label);
    assert.equal(receipt.governorDecision.output.mutationAuthorized, false, label);
    assertRuntimeActionShadowPreflightReceipt(receipt);
  }
});

test('declared protected action classes cannot bypass protected runtime lanes', () => {
  const cases = [
    ['context_eligibility', AUTHORITY_LANES.PROMPT_INJECTION],
    ['background_responsibility', AUTHORITY_LANES.SCHEDULER_LINKAGE],
    ['tool_policy', AUTHORITY_LANES.RUNTIME_TOOL_POLICY_ENFORCEMENT],
    ['runtime_config', AUTHORITY_LANES.CONFIG_CHANGES],
    ['claim_maturation', AUTHORITY_LANES.BROAD_MEMORY_PROMOTION]
  ];

  for (const [actionClass, lane] of cases) {
    const classification = classifyRuntimeAction({ actionClass });
    assert.equal(classification.protectedLane, lane, actionClass);
    assert.equal(classification.approvalRequired, true, actionClass);
    assert.equal(classification.approvalReason, 'protected_authority_lane', actionClass);
    assert.ok(classification.reasonCodes.includes('declared_action_class'), actionClass);
    assert.ok(classification.reasonCodes.includes(`declared_${lane}_lane`), actionClass);
  }
});

test('runtime action classifier identifies protected lanes before future enforcement', () => {
  assert.equal(classifyRuntimeAction({ action: 'change_runtime_config' }).protectedLane, AUTHORITY_LANES.CONFIG_CHANGES);
  assert.equal(classifyRuntimeAction({ action: 'enable_scheduler_linkage' }).protectedLane, AUTHORITY_LANES.SCHEDULER_LINKAGE);
  assert.equal(classifyRuntimeAction({ action: 'inject_into_prompt_context' }).protectedLane, AUTHORITY_LANES.PROMPT_INJECTION);
});
