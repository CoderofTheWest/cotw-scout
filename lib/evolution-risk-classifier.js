'use strict';

const AUTONOMY_RISK_DECISIONS = Object.freeze({
  AUDIT_ONLY_AUTONOMOUS: 'audit_only_autonomous',
  APPROVAL_REQUIRED: 'approval_required',
  BLOCKED: 'blocked'
});

const LOW_RISK_AUTONOMOUS_LANES = Object.freeze(new Set([
  'operational_lesson',
  'memory_hygiene',
  'stale_claim_cleanup',
  'archive_open_question',
  'hypothesis_holding',
  'hold_as_hypothesis',
  'posture_tuning',
  'ui_process_friction',
  'local_documentation_receipt',
  'maintenance_suggestion'
]));

const HARD_BLOCKED_REASON_CODES = Object.freeze({
  identity_claim: 'identity_or_values_claim_about_person',
  safety_critical: 'safety_critical_behavior',
  external_action: 'external_message_or_action_on_person',
  runtime_config: 'runtime_model_or_config_authority',
  hardware_control: 'hardware_or_physical_world_control',
  credentials: 'credentials_secrets_or_private_infrastructure',
  medical_legal_financial: 'medical_legal_financial_advice_posture',
  broad_mutation: 'broad_or_batch_mutation',
  irreversible: 'irreversible_or_hard_to_rollback_change',
  prompt_injection: 'prompt_injection_or_context_expansion',
  scheduler_linkage: 'scheduler_or_durable_background_linkage',
  tool_policy_mutation: 'runtime_tool_policy_mutation',
  broad_memory_promotion: 'broad_memory_promotion'
});

const HARD_BLOCKED_FIELDS = Object.freeze([
  ['identity_claim', ['affectsIdentity', 'identityClaim', 'valuesClaimAboutPerson', 'personhoodClaim']],
  ['safety_critical', ['safetyCritical', 'safetyCriticalBehavior']],
  ['external_action', ['externalAction', 'externalMessage', 'actsOnAnotherPerson']],
  ['runtime_config', ['runtimeConfig', 'modelConfig', 'configMutation']],
  ['hardware_control', ['hardwareControl', 'physicalWorldControl']],
  ['credentials', ['credentials', 'secrets', 'privateInfrastructure']],
  ['medical_legal_financial', ['medicalAdvice', 'legalAdvice', 'financialAdvice', 'medicalLegalFinancial']],
  ['broad_mutation', ['broadMutation', 'batchMutation']],
  ['irreversible', ['irreversible', 'hardToRollback']],
  ['prompt_injection', ['promptInjection', 'contextExpansion', 'promptContextInjection']],
  ['scheduler_linkage', ['schedulerLinkage', 'durableBackgroundResponsibility']],
  ['tool_policy_mutation', ['toolPolicyMutation', 'runtimeToolPolicyMutation']],
  ['broad_memory_promotion', ['broadMemoryPromotion', 'memoryPromotionBroad']]
]);

function classifyAutonomyRisk(action = {}) {
  const normalized = normalizeAction(action);
  const blockers = hardBlockedReasons(normalized);
  if (blockers.length) {
    return decision({
      decision: AUTONOMY_RISK_DECISIONS.BLOCKED,
      risk: 'high',
      reasonCodes: blockers,
      policyRule: 'hard_blocked_zone',
      reversibilityRequired: true
    });
  }

  const lowRiskLane = LOW_RISK_AUTONOMOUS_LANES.has(normalized.lane)
    || LOW_RISK_AUTONOMOUS_LANES.has(normalized.category)
    || LOW_RISK_AUTONOMOUS_LANES.has(normalized.action);
  const localOnly = normalized.externality === 'local' || normalized.externality === 'none';
  const reversible = normalized.reversibility === 'reversible' || normalized.reversibility === 'rollbackable';
  const boundedScope = normalized.scope === 'single' || normalized.scope === 'bounded';
  const lowSensitivity = normalized.sensitivity === 'low' || normalized.sensitivity === 'none';

  if (lowRiskLane && localOnly && reversible && boundedScope && lowSensitivity) {
    return decision({
      decision: AUTONOMY_RISK_DECISIONS.AUDIT_ONLY_AUTONOMOUS,
      risk: 'low',
      reasonCodes: ['bounded_low_risk_reversible_lane'],
      policyRule: 'autonomous_low_risk_lane',
      reversibilityRequired: true
    });
  }

  return decision({
    decision: AUTONOMY_RISK_DECISIONS.APPROVAL_REQUIRED,
    risk: normalized.sensitivity === 'high' ? 'high' : 'medium',
    reasonCodes: ['outside_autonomous_low_risk_lane'],
    policyRule: 'risk_boundary_requires_approval',
    reversibilityRequired: true
  });
}

function hardBlockedReasons(action = {}) {
  const reasons = [];
  for (const [reasonKey, fields] of HARD_BLOCKED_FIELDS) {
    if (fields.some(field => Boolean(action[field]))) reasons.push(HARD_BLOCKED_REASON_CODES[reasonKey]);
  }
  return [...new Set(reasons)];
}

function normalizeAction(action = {}) {
  return {
    ...action,
    action: normalizeKey(action.action || action.type || ''),
    lane: normalizeKey(action.lane || action.class || ''),
    category: normalizeKey(action.category || action.sourceCategory || ''),
    externality: normalizeKey(action.externality || 'local'),
    reversibility: normalizeKey(action.reversibility || (action.rollbackAvailable ? 'rollbackable' : 'reversible')),
    scope: normalizeKey(action.scope || 'single'),
    sensitivity: normalizeKey(action.sensitivity || action.risk || 'low')
  };
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function decision({ decision, risk, reasonCodes, policyRule, reversibilityRequired }) {
  return Object.freeze({
    decision,
    risk,
    reasonCodes: Object.freeze(reasonCodes),
    policyRule,
    approvalRequired: decision === AUTONOMY_RISK_DECISIONS.APPROVAL_REQUIRED,
    autonomousAllowed: decision === AUTONOMY_RISK_DECISIONS.AUDIT_ONLY_AUTONOMOUS,
    blocked: decision === AUTONOMY_RISK_DECISIONS.BLOCKED,
    reversibilityRequired
  });
}

module.exports = {
  AUTONOMY_RISK_DECISIONS,
  LOW_RISK_AUTONOMOUS_LANES,
  HARD_BLOCKED_REASON_CODES,
  classifyAutonomyRisk,
  hardBlockedReasons
};
