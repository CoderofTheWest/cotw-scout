'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  AUTONOMY_RISK_DECISIONS,
  HARD_BLOCKED_REASON_CODES,
  classifyAutonomyRisk,
  hardBlockedReasons
} = require('../lib/evolution-risk-classifier');

test('low-risk archive/open-question actions are audit-only autonomous', () => {
  const result = classifyAutonomyRisk({
    lane: 'archive_open_question',
    externality: 'local',
    reversibility: 'rollbackable',
    scope: 'bounded',
    sensitivity: 'low'
  });

  assert.equal(result.decision, AUTONOMY_RISK_DECISIONS.AUDIT_ONLY_AUTONOMOUS);
  assert.equal(result.autonomousAllowed, true);
  assert.equal(result.approvalRequired, false);
  assert.equal(result.blocked, false);
  assert.equal(result.policyRule, 'autonomous_low_risk_lane');
  assert.deepEqual(result.reasonCodes, ['bounded_low_risk_reversible_lane']);
});

test('low-risk autonomous lanes require bounded local reversible low-sensitivity posture', () => {
  for (const action of [
    { lane: 'operational_lesson', externality: 'external', reversibility: 'rollbackable', scope: 'bounded', sensitivity: 'low' },
    { lane: 'memory_hygiene', externality: 'local', reversibility: 'irreversible', scope: 'bounded', sensitivity: 'low' },
    { lane: 'posture_tuning', externality: 'local', reversibility: 'rollbackable', scope: 'batch', sensitivity: 'low' },
    { lane: 'ui_process_friction', externality: 'local', reversibility: 'rollbackable', scope: 'bounded', sensitivity: 'medium' }
  ]) {
    const result = classifyAutonomyRisk(action);
    assert.notEqual(result.decision, AUTONOMY_RISK_DECISIONS.AUDIT_ONLY_AUTONOMOUS);
  }
});

test('identity, safety, external action, hardware, runtime/config, secrets, medical/legal/financial, and broad mutation are blocked', () => {
  const cases = [
    ['identityClaim', HARD_BLOCKED_REASON_CODES.identity_claim],
    ['safetyCritical', HARD_BLOCKED_REASON_CODES.safety_critical],
    ['externalMessage', HARD_BLOCKED_REASON_CODES.external_action],
    ['hardwareControl', HARD_BLOCKED_REASON_CODES.hardware_control],
    ['runtimeConfig', HARD_BLOCKED_REASON_CODES.runtime_config],
    ['secrets', HARD_BLOCKED_REASON_CODES.credentials],
    ['medicalLegalFinancial', HARD_BLOCKED_REASON_CODES.medical_legal_financial],
    ['batchMutation', HARD_BLOCKED_REASON_CODES.broad_mutation],
    ['irreversible', HARD_BLOCKED_REASON_CODES.irreversible]
  ];

  for (const [field, reason] of cases) {
    const result = classifyAutonomyRisk({ lane: 'operational_lesson', [field]: true });
    assert.equal(result.decision, AUTONOMY_RISK_DECISIONS.BLOCKED, field);
    assert.equal(result.blocked, true, field);
    assert.ok(result.reasonCodes.includes(reason), field);
  }
});

test('protected authority expansion lanes are blocked rather than silently staged', () => {
  const cases = [
    ['promptInjection', HARD_BLOCKED_REASON_CODES.prompt_injection],
    ['schedulerLinkage', HARD_BLOCKED_REASON_CODES.scheduler_linkage],
    ['toolPolicyMutation', HARD_BLOCKED_REASON_CODES.tool_policy_mutation],
    ['broadMemoryPromotion', HARD_BLOCKED_REASON_CODES.broad_memory_promotion]
  ];

  for (const [field, reason] of cases) {
    const result = classifyAutonomyRisk({ lane: 'maintenance_suggestion', [field]: true });
    assert.equal(result.decision, AUTONOMY_RISK_DECISIONS.BLOCKED, field);
    assert.ok(result.reasonCodes.includes(reason), field);
  }
});

test('non-blocked actions outside low-risk lanes require approval', () => {
  const result = classifyAutonomyRisk({
    lane: 'novel_behavior_change',
    externality: 'local',
    reversibility: 'rollbackable',
    scope: 'bounded',
    sensitivity: 'medium'
  });

  assert.equal(result.decision, AUTONOMY_RISK_DECISIONS.APPROVAL_REQUIRED);
  assert.equal(result.approvalRequired, true);
  assert.equal(result.autonomousAllowed, false);
  assert.equal(result.blocked, false);
  assert.equal(result.policyRule, 'risk_boundary_requires_approval');
});

test('hardBlockedReasons deduplicates overlapping field aliases', () => {
  assert.deepEqual(hardBlockedReasons({ identityClaim: true, personhoodClaim: true }), [
    HARD_BLOCKED_REASON_CODES.identity_claim
  ]);
});
