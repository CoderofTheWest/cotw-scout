'use strict';

const {
  ACTION_CLASSES,
  GOVERNOR_MODES,
  createGovernorDecisionPacket,
  createOutcomeEventPacket,
  assertGovernorDecisionPacket,
  assertOutcomeEventPacket
} = require('./agent-integration-spine');
const {
  appendGovernorDecisionPacket,
  appendOutcomeEventPacket
} = require('./spine-ledger');

const AUTHORITY_LANES = Object.freeze({
  PROMPT_INJECTION: 'prompt_injection',
  SCHEDULER_LINKAGE: 'scheduler_linkage',
  RUNTIME_TOOL_POLICY_ENFORCEMENT: 'runtime_tool_policy_enforcement',
  CONFIG_CHANGES: 'config_changes',
  BROAD_MEMORY_PROMOTION: 'broad_memory_promotion'
});

const LANE_POLICIES = Object.freeze({
  [AUTHORITY_LANES.PROMPT_INJECTION]: {
    actionClass: ACTION_CLASSES.CONTEXT_ELIGIBILITY,
    risk: { externality: 'local', reversibility: 'reversible', sensitivity: 'high', behaviorShaping: true },
    requiredChecks: ['context_eligibility_filter', 'source_status_freshness_privacy_check', 'explicit_context_authority'],
    approvalReason: 'prompt_context_changes_behavior'
  },
  [AUTHORITY_LANES.SCHEDULER_LINKAGE]: {
    actionClass: ACTION_CLASSES.BACKGROUND_RESPONSIBILITY,
    risk: { externality: 'local', reversibility: 'reversible', sensitivity: 'medium', behaviorShaping: true },
    requiredChecks: ['active_responsibility_lease', 'expiry_budget_stop_conditions', 'notification_threshold_check'],
    approvalReason: 'durable_background_work_requires_active_lease'
  },
  [AUTHORITY_LANES.RUNTIME_TOOL_POLICY_ENFORCEMENT]: {
    actionClass: ACTION_CLASSES.TOOL_POLICY,
    risk: { externality: 'local', reversibility: 'rollbackable', sensitivity: 'high', behaviorShaping: true },
    requiredChecks: ['exact_policy_diff', 'operator_approval', 'rollback_plan', 'shadow_observation_window'],
    approvalReason: 'tool_policy_changes_runtime_authority'
  },
  [AUTHORITY_LANES.CONFIG_CHANGES]: {
    actionClass: ACTION_CLASSES.RUNTIME_CONFIG,
    risk: { externality: 'local', reversibility: 'rollbackable', sensitivity: 'high', behaviorShaping: true },
    requiredChecks: ['exact_config_diff', 'operator_approval', 'rollback_plan', 'restart_recovery_plan'],
    approvalReason: 'runtime_config_changes_require_operator_approval'
  },
  [AUTHORITY_LANES.BROAD_MEMORY_PROMOTION]: {
    actionClass: ACTION_CLASSES.CLAIM_MATURATION,
    risk: { externality: 'local', reversibility: 'rollbackable', sensitivity: 'high', behaviorShaping: true },
    requiredChecks: ['source_resolved', 'contradiction_check', 'privacy_review', 'rollback_or_supersession_plan', 'later_effect_measurement'],
    approvalReason: 'broad_memory_promotion_changes_durable_behavior'
  }
});

const DEFAULT_ENFORCEMENT_POLICY = Object.freeze({
  mode: 'shadow',
  killSwitch: {
    allAuthorityExpansionDisabled: false,
    prompt_injection: false,
    scheduler_linkage: false,
    runtime_tool_policy_enforcement: false,
    config_changes: false,
    broad_memory_promotion: false
  },
  enabledLanes: []
});

function createAuthorityLaneEnforcementReceipt({
  requestId,
  lane,
  requestedEffect = {},
  authority = {},
  enforcementPolicy = {},
  riskClassification = null,
  now = null,
  source = {}
} = {}) {
  const safeLane = String(lane || '').trim();
  const policy = LANE_POLICIES[safeLane];
  const mergedPolicy = mergeEnforcementPolicy(enforcementPolicy);
  const id = safeId(requestId || `${safeLane || 'unknown'}:${Date.now()}`);
  const killSwitchActive = mergedPolicy.killSwitch.allAuthorityExpansionDisabled === true || mergedPolicy.killSwitch[safeLane] === true;
  const laneEnabled = mergedPolicy.enabledLanes.includes(safeLane);
  const unknownLane = !policy;
  const shadowMode = mergedPolicy.mode !== 'enforce';
  const authorized = false;
  const wouldBlock = true;
  const hardBlocked = killSwitchActive || unknownLane;
  const reasonCodes = [];
  if (unknownLane) reasonCodes.push('unknown_authority_lane');
  if (killSwitchActive) reasonCodes.push('authority_lane_kill_switch_active');
  if (!laneEnabled) reasonCodes.push('authority_lane_not_enabled');
  if (shadowMode) reasonCodes.push('shadow_enforcement_observe_only');
  reasonCodes.push('capability_is_not_authority');
  const classifierReasonCodes = Array.isArray(riskClassification?.reasonCodes) ? riskClassification.reasonCodes : [];

  const actionClass = policy?.actionClass || ACTION_CLASSES.SAFETY_POLICY;
  const governor = createGovernorDecisionPacket({
    decisionId: `gov:authority:${id}`,
    actionClass,
    requestedAction: {
      class: 'authority_lane_request',
      lane: safeLane || 'unknown',
      effect: requestedEffect.effect || requestedEffect.kind || requestedEffect.action || 'unspecified'
    },
    authority: {
      hasCurrentInstruction: authority.hasCurrentInstruction === true,
      activeLeaseId: authority.activeLeaseId || null,
      approvalRef: authority.approvalRef || null,
      toolCapabilityPresent: authority.toolCapabilityPresent === true,
      source: authority.source || null
    },
    risk: policy?.risk || { externality: 'local', reversibility: 'unknown', sensitivity: 'high', behaviorShaping: true },
    verification: {
      required: policy?.requiredChecks || ['lane_policy_check'],
      missing: policy?.requiredChecks || ['lane_policy_check']
    },
    approval: {
      required: true,
      reason: policy?.approvalReason || 'authority_expansion_requires_approval'
    },
    rollback: {
      required: true,
      plan: requestedEffect.rollbackPlan || 'No runtime effect applied; rollback is no-op for shadow receipt.'
    },
    mode: hardBlocked ? GOVERNOR_MODES.REFUSE_WITH_SAFE_ALTERNATIVE : GOVERNOR_MODES.REQUIRE_APPROVAL,
    reasonCodes: unique(reasonCodes.concat(classifierReasonCodes)),
    createdAt: now
  });
  assertGovernorDecisionPacket(governor);

  const outcome = createOutcomeEventPacket({
    eventId: `outcome:authority:${id}`,
    eventType: 'shadow_enforcement_observed',
    status: hardBlocked ? 'blocked' : 'review_requested',
    createdAt: now,
    source: {
      sourceType: source.sourceType || 'runtime_enforcement_shadow',
      sourceHandle: source.sourceHandle || requestId || null,
      evidenceClass: 'direct'
    },
    intent: {
      title: `Authority lane request: ${safeLane || 'unknown'}`,
      summary: requestedEffect.summary || 'Protected authority lane evaluated before enablement.',
      expectedEffect: requestedEffect.expectedEffect || 'No protected authority is granted by this receipt.'
    },
    authority: {
      governorDecisionId: governor.decisionId,
      authorizationMode: authorized ? 'authorized' : (shadowMode ? 'shadow_only' : 'approval_required'),
      approvalRef: authority.approvalRef || null
    },
    action: {
      action: 'evaluate_authority_lane',
      class: actionClass,
      lane: safeLane || 'unknown',
      effect: requestedEffect.effect || requestedEffect.kind || requestedEffect.action || 'unspecified'
    },
    observed: {
      status: hardBlocked ? 'blocked' : 'would_require_approval',
      risk: riskClassification?.risk || policy?.risk?.sensitivity || 'high',
      riskDecision: riskClassification?.decision || null,
      riskPolicyRule: riskClassification?.policyRule || null,
      enforcementMode: mergedPolicy.mode,
      wouldBlock,
      authorized
    },
    verification: {
      status: 'verified',
      method: 'authority_lane_policy',
      evidence: {
        laneEnabled,
        killSwitchActive,
        shadowMode,
        riskDecision: riskClassification?.decision || null,
        riskPolicyRule: riskClassification?.policyRule || null,
        riskReasonCodes: classifierReasonCodes,
        toolExecutionAuthorized: false,
        promptInjectionAuthorized: false,
        schedulerAuthorized: false,
        mutationAuthorized: false
      }
    },
    rollback: {
      available: false,
      plan: 'No protected runtime effect was applied.'
    },
    learning: {
      eligibleForMaturation: true,
      suggestedLane: 'diagnostics_only',
      prohibitionReason: 'shadow_enforcement_receipt_only'
    }
  });
  assertOutcomeEventPacket(outcome);

  return {
    ok: true,
    lane: safeLane || 'unknown',
    authorized,
    wouldBlock,
    hardBlocked,
    shadowOnly: shadowMode,
    killSwitchActive,
    reasonCodes,
    riskClassification,
    governorDecision: governor,
    outcomeEvent: outcome,
    invariants: authorityLaneEnforcementInvariants({ governor, outcome, authorized })
  };
}

function recordAuthorityLaneEnforcement(ledgerPath, input = {}) {
  const receipt = createAuthorityLaneEnforcementReceipt(input);
  appendGovernorDecisionPacket(ledgerPath, receipt.governorDecision);
  appendOutcomeEventPacket(ledgerPath, receipt.outcomeEvent);
  return receipt;
}

function createRuntimeActionShadowPreflightReceipt({
  requestId,
  requestedAction = {},
  authority = {},
  enforcementPolicy = {},
  now = null,
  source = {}
} = {}) {
  const id = safeId(requestId || `runtime-action:${Date.now()}`);
  const policy = mergeEnforcementPolicy(enforcementPolicy);
  const classification = classifyRuntimeAction(requestedAction);
  const createdAt = now || new Date().toISOString();
  const reasonCodes = unique([
    'runtime_shadow_preflight_observe_only',
    'capability_is_not_authority',
    ...classification.reasonCodes
  ]);

  const governor = createGovernorDecisionPacket({
    decisionId: `gov:runtime:${id}`,
    actionClass: classification.actionClass,
    requestedAction: {
      class: 'runtime_action_shadow_preflight',
      action: requestedAction.action || requestedAction.kind || requestedAction.tool || 'unspecified',
      tool: requestedAction.tool || null,
      target: safeRuntimeTarget(requestedAction.target || requestedAction.path || requestedAction.recipient || requestedAction.channel || null),
      protectedLane: classification.protectedLane || null,
      effect: requestedAction.effect || requestedAction.summary || classification.effect
    },
    authority: {
      hasCurrentInstruction: authority.hasCurrentInstruction === true,
      activeLeaseId: authority.activeLeaseId || null,
      approvalRef: authority.approvalRef || null,
      toolCapabilityPresent: authority.toolCapabilityPresent === true,
      recipientConfirmed: authority.recipientConfirmed === true,
      intentConfirmed: authority.intentConfirmed === true,
      source: authority.source || 'runtime_action_shadow_preflight'
    },
    risk: classification.risk,
    verification: {
      required: unique(['runtime_action_shadow_preflight', ...classification.requiredChecks]),
      completed: ['runtime_action_shadow_preflight'],
      missing: []
    },
    approval: {
      required: classification.approvalRequired,
      reason: classification.approvalReason
    },
    rollback: {
      required: classification.rollbackRequired,
      plan: requestedAction.rollbackPlan || classification.rollbackPlan
    },
    mode: null,
    reasonCodes,
    createdAt
  });
  assertGovernorDecisionPacket(governor);

  const reviewRequired = governor.approval?.required === true || (governor.checks?.missing || []).length > 0;
  const outcome = createOutcomeEventPacket({
    eventId: `outcome:runtime:${id}`,
    eventType: 'runtime_action_shadow_preflight',
    status: reviewRequired ? 'review_requested' : 'observed',
    createdAt,
    source: {
      sourceType: source.sourceType || 'runtime_action_shadow_preflight',
      sourceHandle: source.sourceHandle || requestId || null,
      evidenceClass: 'direct'
    },
    intent: {
      title: `Runtime action shadow preflight: ${classification.actionClass}`,
      summary: requestedAction.summary || 'Runtime action evaluated in shadow mode before broader governor enforcement.',
      expectedEffect: 'Diagnostic receipt only; no tool execution, mutation, prompt injection, scheduler, or external effect is authorized.'
    },
    authority: {
      governorDecisionId: governor.decisionId,
      authorizationMode: 'shadow_only',
      approvalRef: authority.approvalRef || null
    },
    action: {
      action: requestedAction.action || requestedAction.kind || requestedAction.tool || 'unspecified',
      class: classification.actionClass,
      lane: classification.protectedLane || null,
      effect: requestedAction.effect || classification.effect
    },
    observed: {
      status: reviewRequired ? 'would_require_review' : 'would_proceed_with_existing_checks',
      enforcementMode: policy.mode,
      shadowMode: true,
      protectedLane: classification.protectedLane || null,
      risk: classification.risk.sensitivity,
      wouldBlock: false,
      wouldRequireApproval: governor.approval?.required === true,
      authorized: false
    },
    verification: {
      status: 'verified',
      method: 'runtime_action_shadow_preflight',
      evidence: {
        actionClass: classification.actionClass,
        reasonCodes,
        requiredChecks: governor.checks?.required || [],
        missingChecks: governor.checks?.missing || [],
        toolExecutionAuthorized: false,
        promptInjectionAuthorized: false,
        schedulerAuthorized: false,
        mutationAuthorized: false
      }
    },
    rollback: {
      available: false,
      plan: 'No runtime effect was applied by the shadow preflight.'
    },
    learning: {
      eligibleForMaturation: true,
      suggestedLane: 'diagnostics_only',
      prohibitionReason: 'runtime_shadow_preflight_is_evidence_not_authority'
    }
  });
  assertOutcomeEventPacket(outcome);

  return {
    ok: true,
    shadowOnly: true,
    authorized: false,
    actionClass: classification.actionClass,
    protectedLane: classification.protectedLane || null,
    governorDecision: governor,
    outcomeEvent: outcome,
    classification,
    invariants: runtimeActionShadowPreflightInvariants({ governor, outcome })
  };
}

function recordRuntimeActionShadowPreflight(ledgerPath, input = {}) {
  const receipt = createRuntimeActionShadowPreflightReceipt(input);
  appendGovernorDecisionPacket(ledgerPath, receipt.governorDecision);
  appendOutcomeEventPacket(ledgerPath, receipt.outcomeEvent);
  return receipt;
}

function runtimeActionShadowPreflightInvariants({ governor, outcome }) {
  return {
    noAuthorityGranted: outcome.authority?.authorizationMode === 'shadow_only',
    governorDoesNotAuthorizeTools: governor.output?.toolExecutionAuthorized === false,
    governorDoesNotAuthorizeMutation: governor.output?.mutationAuthorized === false,
    governorDoesNotAuthorizePromptInjection: governor.output?.promptInjectionAuthorized === false,
    governorDoesNotAuthorizeScheduler: governor.output?.schedulerAuthorized === false,
    outcomeDoesNotAuthorizeTools: outcome.verification?.evidence?.toolExecutionAuthorized === false,
    outcomeDoesNotAuthorizeMutation: outcome.verification?.evidence?.mutationAuthorized === false,
    outcomeDoesNotAuthorizePromptInjection: outcome.verification?.evidence?.promptInjectionAuthorized === false,
    outcomeDoesNotAuthorizeScheduler: outcome.verification?.evidence?.schedulerAuthorized === false
  };
}

function assertRuntimeActionShadowPreflightReceipt(receipt = {}) {
  const invariants = receipt.invariants || runtimeActionShadowPreflightInvariants({
    governor: receipt.governorDecision,
    outcome: receipt.outcomeEvent
  });
  const failed = Object.entries(invariants).filter(([, ok]) => ok !== true).map(([name]) => name);
  if (failed.length) throw new Error(`runtime action shadow preflight violates invariants: ${failed.join(', ')}`);
  return true;
}

function classifyRuntimeAction(requestedAction = {}) {
  const actionSignal = [
    requestedAction.action,
    requestedAction.kind,
    requestedAction.tool,
    requestedAction.effect,
    requestedAction.recipient,
    requestedAction.channel,
    requestedAction.url
  ].filter(Boolean).join(' ').toLowerCase();
  const raw = [
    actionSignal,
    requestedAction.target,
    requestedAction.path
  ].filter(Boolean).join(' ').toLowerCase();
  const declared = String(requestedAction.actionClass || '').trim();
  if (Object.values(ACTION_CLASSES).includes(declared)) {
    return classificationForActionClass(
      declared,
      unique(['declared_action_class', protectedLaneReasonForActionClass(declared)]),
      protectedLaneForActionClass(declared)
    );
  }
  if (/prompt|context.*inject|inject.*context/.test(raw)) {
    return classificationForActionClass(ACTION_CLASSES.CONTEXT_ELIGIBILITY, ['protected_prompt_context_lane'], AUTHORITY_LANES.PROMPT_INJECTION);
  }
  if (/scheduler|cron|background|reminder/.test(raw)) {
    return classificationForActionClass(ACTION_CLASSES.BACKGROUND_RESPONSIBILITY, ['protected_scheduler_lane'], AUTHORITY_LANES.SCHEDULER_LINKAGE);
  }
  if (/tool.?policy|runtime.?policy/.test(raw)) {
    return classificationForActionClass(ACTION_CLASSES.TOOL_POLICY, ['protected_tool_policy_lane'], AUTHORITY_LANES.RUNTIME_TOOL_POLICY_ENFORCEMENT);
  }
  if (/config|gateway.*setting|runtime.*setting/.test(raw)) {
    return classificationForActionClass(ACTION_CLASSES.RUNTIME_CONFIG, ['protected_runtime_config_lane'], AUTHORITY_LANES.CONFIG_CHANGES);
  }
  if (/memory.*promot|promot.*memory|claim.*promot/.test(raw)) {
    return classificationForActionClass(ACTION_CLASSES.CLAIM_MATURATION, ['protected_broad_memory_lane'], AUTHORITY_LANES.BROAD_MEMORY_PROMOTION);
  }
  if (/message|send|email|sms|telegram|signal|discord|slack|external/.test(actionSignal) || requestedAction.recipient || requestedAction.channel) {
    return classificationForActionClass(ACTION_CLASSES.EXTERNAL_MESSAGE, ['external_message_shadow_checked']);
  }
  if (/write|edit|patch|apply_patch|create|delete|rename|commit/.test(raw) || requestedAction.path) {
    return classificationForActionClass(ACTION_CLASSES.LOCAL_PROJECT_EDIT, ['local_project_edit_shadow_checked']);
  }
  if (/read|list|search|fetch|status|inspect/.test(raw)) {
    return classificationForActionClass(ACTION_CLASSES.READ_ONLY_INVESTIGATION, ['read_only_shadow_checked']);
  }
  return classificationForActionClass(ACTION_CLASSES.ORDINARY_CONVERSATION, ['ordinary_conversation_shadow_checked']);
}

function protectedLaneForActionClass(actionClass) {
  if (actionClass === ACTION_CLASSES.CONTEXT_ELIGIBILITY) return AUTHORITY_LANES.PROMPT_INJECTION;
  if (actionClass === ACTION_CLASSES.BACKGROUND_RESPONSIBILITY) return AUTHORITY_LANES.SCHEDULER_LINKAGE;
  if (actionClass === ACTION_CLASSES.TOOL_POLICY) return AUTHORITY_LANES.RUNTIME_TOOL_POLICY_ENFORCEMENT;
  if (actionClass === ACTION_CLASSES.RUNTIME_CONFIG) return AUTHORITY_LANES.CONFIG_CHANGES;
  if (actionClass === ACTION_CLASSES.CLAIM_MATURATION) return AUTHORITY_LANES.BROAD_MEMORY_PROMOTION;
  return null;
}

function protectedLaneReasonForActionClass(actionClass) {
  const lane = protectedLaneForActionClass(actionClass);
  if (!lane) return null;
  return `declared_${lane}_lane`;
}

function classificationForActionClass(actionClass, reasonCodes = [], protectedLane = null) {
  const risk = riskForActionClass(actionClass);
  return {
    actionClass,
    protectedLane,
    risk,
    effect: effectForActionClass(actionClass),
    approvalRequired: Boolean(protectedLane) || actionClass === ACTION_CLASSES.EXTERNAL_MESSAGE || actionClass === ACTION_CLASSES.RUNTIME_CONFIG || actionClass === ACTION_CLASSES.TOOL_POLICY || actionClass === ACTION_CLASSES.PHYSICAL_ACTION,
    approvalReason: actionClass === ACTION_CLASSES.EXTERNAL_MESSAGE ? 'external_side_effect' : (protectedLane ? 'protected_authority_lane' : null),
    rollbackRequired: actionClass !== ACTION_CLASSES.ORDINARY_CONVERSATION && actionClass !== ACTION_CLASSES.READ_ONLY_INVESTIGATION && actionClass !== ACTION_CLASSES.EXTERNAL_MESSAGE,
    rollbackPlan: rollbackPlanForActionClass(actionClass),
    requiredChecks: requiredChecksForActionClass(actionClass),
    reasonCodes
  };
}

function riskForActionClass(actionClass) {
  if (actionClass === ACTION_CLASSES.EXTERNAL_MESSAGE) return { externality: 'external', reversibility: 'irreversible', sensitivity: 'medium', behaviorShaping: true };
  if (actionClass === ACTION_CLASSES.RUNTIME_CONFIG || actionClass === ACTION_CLASSES.TOOL_POLICY || actionClass === ACTION_CLASSES.PHYSICAL_ACTION) return { externality: 'local', reversibility: 'rollbackable', sensitivity: 'high', behaviorShaping: true };
  if (actionClass === ACTION_CLASSES.CONTEXT_ELIGIBILITY || actionClass === ACTION_CLASSES.CLAIM_MATURATION || actionClass === ACTION_CLASSES.SAFETY_POLICY) return { externality: 'local', reversibility: 'rollbackable', sensitivity: 'high', behaviorShaping: true };
  if (actionClass === ACTION_CLASSES.BACKGROUND_RESPONSIBILITY) return { externality: 'local', reversibility: 'reversible', sensitivity: 'medium', behaviorShaping: true };
  if (actionClass === ACTION_CLASSES.LOCAL_PROJECT_EDIT || actionClass === ACTION_CLASSES.MEMORY_APPEND || actionClass === ACTION_CLASSES.PROCEDURAL_LEARNING) return { externality: 'local', reversibility: 'rollbackable', sensitivity: 'medium', behaviorShaping: false };
  if (actionClass === ACTION_CLASSES.READ_ONLY_INVESTIGATION) return { externality: 'local', reversibility: 'reversible', sensitivity: 'low', behaviorShaping: false, mutableFacts: true };
  return { externality: 'local', reversibility: 'reversible', sensitivity: 'low', behaviorShaping: false };
}

function requiredChecksForActionClass(actionClass) {
  if (actionClass === ACTION_CLASSES.LOCAL_PROJECT_EDIT) return ['read_before_write', 'verify_after_write'];
  if (actionClass === ACTION_CLASSES.EXTERNAL_MESSAGE) return ['recipient_confirmed', 'current_intent_confirmed', 'operator_approval'];
  if (actionClass === ACTION_CLASSES.READ_ONLY_INVESTIGATION) return ['verify_mutable_facts_with_tool_evidence'];
  if (actionClass === ACTION_CLASSES.BACKGROUND_RESPONSIBILITY) return ['active_responsibility_lease', 'expiry_budget_stop_conditions'];
  if (actionClass === ACTION_CLASSES.RUNTIME_CONFIG || actionClass === ACTION_CLASSES.TOOL_POLICY) return ['exact_diff', 'operator_approval', 'rollback_plan'];
  if (actionClass === ACTION_CLASSES.CONTEXT_ELIGIBILITY || actionClass === ACTION_CLASSES.CLAIM_MATURATION) return ['dry_run_review_packet', 'lane_policy_check'];
  return [];
}

function effectForActionClass(actionClass) {
  if (actionClass === ACTION_CLASSES.LOCAL_PROJECT_EDIT) return 'local_artifact_change';
  if (actionClass === ACTION_CLASSES.EXTERNAL_MESSAGE) return 'external_message_side_effect';
  if (actionClass === ACTION_CLASSES.READ_ONLY_INVESTIGATION) return 'read_only_information_gathering';
  return actionClass;
}

function rollbackPlanForActionClass(actionClass) {
  if (actionClass === ACTION_CLASSES.LOCAL_PROJECT_EDIT) return 'Use git diff/revert or file restore; verify after rollback.';
  if (actionClass === ACTION_CLASSES.EXTERNAL_MESSAGE) return 'External sends are not reversible; require approval before execution.';
  if (actionClass === ACTION_CLASSES.RUNTIME_CONFIG || actionClass === ACTION_CLASSES.TOOL_POLICY) return 'Capture exact before/after diff and restart/rollback plan before execution.';
  if (actionClass === ACTION_CLASSES.BACKGROUND_RESPONSIBILITY) return 'Cancel/expire lease and record interruption outcome.';
  return 'No runtime effect is applied by shadow preflight.';
}

function safeRuntimeTarget(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return 'email-redacted';
  if (/^\+?[0-9][0-9 .()\-]{6,}$/.test(raw)) return 'phone-redacted';
  if (/^https?:\/\//i.test(raw)) return 'url-redacted';
  if (/[;&|`$<>]/.test(raw) || /\s/.test(raw)) return 'command-or-recipient-redacted';
  return safeId(raw.replace(/[\/\\][^\/\\]+$/g, '/[redacted]'));
}

function authorityLaneEnforcementInvariants({ governor, outcome, authorized }) {
  return {
    noAuthorityGranted: authorized === false,
    governorDoesNotAuthorizeTools: governor.output?.toolExecutionAuthorized === false,
    governorDoesNotAuthorizeMutation: governor.output?.mutationAuthorized === false,
    governorDoesNotAuthorizePromptInjection: governor.output?.promptInjectionAuthorized === false,
    governorDoesNotAuthorizeScheduler: governor.output?.schedulerAuthorized === false,
    receiptDoesNotAuthorizeTools: outcome.verification?.evidence?.toolExecutionAuthorized === false,
    receiptDoesNotAuthorizePromptInjection: outcome.verification?.evidence?.promptInjectionAuthorized === false,
    receiptDoesNotAuthorizeScheduler: outcome.verification?.evidence?.schedulerAuthorized === false,
    receiptDoesNotAuthorizeMutation: outcome.verification?.evidence?.mutationAuthorized === false
  };
}

function assertAuthorityLaneEnforcementReceipt(receipt = {}) {
  const invariants = receipt.invariants || authorityLaneEnforcementInvariants({
    governor: receipt.governorDecision,
    outcome: receipt.outcomeEvent,
    authorized: receipt.authorized
  });
  const failed = Object.entries(invariants).filter(([, ok]) => ok !== true).map(([name]) => name);
  if (failed.length) throw new Error(`authority lane enforcement violates invariants: ${failed.join(', ')}`);
  return true;
}

function mergeEnforcementPolicy(input = {}) {
  return {
    mode: input.mode === 'enforce' ? 'enforce' : 'shadow',
    killSwitch: {
      ...DEFAULT_ENFORCEMENT_POLICY.killSwitch,
      ...(input.killSwitch || {})
    },
    enabledLanes: Array.isArray(input.enabledLanes) ? input.enabledLanes.map(String) : []
  };
}

function safeId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9:_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || `authority:${Date.now()}`;
}

function unique(items = []) {
  return [...new Set(items.filter(Boolean))];
}

module.exports = {
  AUTHORITY_LANES,
  LANE_POLICIES,
  DEFAULT_ENFORCEMENT_POLICY,
  createAuthorityLaneEnforcementReceipt,
  recordAuthorityLaneEnforcement,
  authorityLaneEnforcementInvariants,
  assertAuthorityLaneEnforcementReceipt,
  classifyRuntimeAction,
  createRuntimeActionShadowPreflightReceipt,
  recordRuntimeActionShadowPreflight,
  runtimeActionShadowPreflightInvariants,
  assertRuntimeActionShadowPreflightReceipt
};
