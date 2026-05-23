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
  AUTHORITY_LANES,
  createAuthorityLaneEnforcementReceipt
} = require('./spine-enforcement');
const {
  appendGovernorDecisionPacket,
  appendOutcomeEventPacket
} = require('./spine-ledger');
const { classifyAutonomyRisk } = require('./evolution-risk-classifier');

const LOW_RISK_APPLY_DECISIONS = new Set(['archive_open_question', 'hold_as_hypothesis']);
const REVIEW_LEDGER_ACTIONS = new Set(['inspect', 'mark_reviewed', 'keep_acknowledge', 'dismiss', 'deny_proposal', 'reopen', 'rollback_requested', 'rollback', 'mark_harmful', 'disable', 'strip']);
const HIGH_RISK_REVIEW_ACTIONS = new Set(['prepare_high_risk_approval_packet', 'run_high_risk_preflight']);
const HIGH_RISK_PACKET_APPROVAL_ACTIONS = new Set(['record_high_risk_explicit_approval']);
const HIGH_RISK_PRE_ACTION_RECHECK_ACTIONS = new Set(['run_high_risk_pre_action_recheck']);
const HIGH_RISK_CLAIM_APPLY_ACTIONS = new Set(['apply_high_risk_claim_maturation']);
const HIGH_RISK_SIMPLIFIED_APPLY_ACTIONS = new Set(['approve_and_apply_if_still_safe']);
const SCAFFOLD_PROMOTION_ACTIONS = new Set(['apply_scaffold_proposal', 'rollback_scaffold_promotion']);
const MUTATING_CLAIM_ACTIONS = new Set(['apply_low_risk_candidate', 'apply_high_risk_claim_maturation', 'approve_and_apply_if_still_safe', 'rollback_claim_review']);
const SIMPLIFIED_APPLY_PROTECTED_LANES = new Set([
  'prompt_injection',
  'context_injection',
  'scheduler',
  'scheduler_linkage',
  'runtime_config',
  'config_changes',
  'runtime_tool_policy',
  'tool_policy',
  'account_access',
  'external_send',
  'device_control',
  'hardware_control',
  'broad_memory_promotion'
]);

const PROTECTED_EVOLUTION_ACTION_LANES = Object.freeze({
  enable_prompt_injection: AUTHORITY_LANES.PROMPT_INJECTION,
  expand_context_injection: AUTHORITY_LANES.PROMPT_INJECTION,
  inject_into_prompt_context: AUTHORITY_LANES.PROMPT_INJECTION,
  enable_scheduler_linkage: AUTHORITY_LANES.SCHEDULER_LINKAGE,
  link_scheduler: AUTHORITY_LANES.SCHEDULER_LINKAGE,
  enable_runtime_tool_policy_enforcement: AUTHORITY_LANES.RUNTIME_TOOL_POLICY_ENFORCEMENT,
  mutate_runtime_tool_policy: AUTHORITY_LANES.RUNTIME_TOOL_POLICY_ENFORCEMENT,
  change_runtime_config: AUTHORITY_LANES.CONFIG_CHANGES,
  mutate_runtime_config: AUTHORITY_LANES.CONFIG_CHANGES,
  broad_memory_promotion: AUTHORITY_LANES.BROAD_MEMORY_PROMOTION,
  promote_memory_broadly: AUTHORITY_LANES.BROAD_MEMORY_PROMOTION
});

function createEvolutionActionGateReceipt({ id, action, entry = null, note = '', now = null } = {}) {
  const safeAction = safe(action || 'unknown', 120);
  const safeTargetId = safe(id || entry?.id || 'unknown', 160);
  const createdAt = now || new Date().toISOString();
  const protectedLane = PROTECTED_EVOLUTION_ACTION_LANES[safeAction];
  const riskClassification = classifyAutonomyRisk(evolutionRiskInput({ action: safeAction, entry, protectedLane }));

  if (protectedLane) {
    const authorityReceipt = createAuthorityLaneEnforcementReceipt({
      requestId: `evolve-${safeAction}-${safeTargetId}-${Date.now()}`,
      lane: protectedLane,
      requestedEffect: {
        effect: safeAction,
        summary: `Evolve action requested protected authority lane: ${safeAction}`,
        expectedEffect: 'No protected authority is granted from Evolve actions.'
      },
      authority: {
        hasCurrentInstruction: true,
        source: 'sidebar:evolution-action'
      },
      enforcementPolicy: {
        mode: 'enforce',
        enabledLanes: []
      },
      riskClassification,
      now: createdAt,
      source: {
        sourceType: 'evolve_action_gate',
        sourceHandle: safeTargetId
      }
    });
    return {
      allowed: false,
      blocked: true,
      action: safeAction,
      id: safeTargetId,
      blockers: ['protected_authority_lane_not_enabled'],
      reason: `Evolve action ${safeAction} touches protected authority lane ${protectedLane}; action refused before handler execution.`,
      governorDecision: authorityReceipt.governorDecision,
      outcomeEvent: authorityReceipt.outcomeEvent,
      authorityReceipt,
      riskClassification
    };
  }

  const blockers = validateEvolutionAction({ action: safeAction, entry });
  const allowed = blockers.length === 0;
  const actionClass = MUTATING_CLAIM_ACTIONS.has(safeAction)
    ? ACTION_CLASSES.CLAIM_MATURATION
    : ACTION_CLASSES.LOCAL_PROJECT_EDIT;
  const mode = allowed ? GOVERNOR_MODES.PROCEED_WITH_VERIFICATION : GOVERNOR_MODES.REFUSE_WITH_SAFE_ALTERNATIVE;
  const risk = MUTATING_CLAIM_ACTIONS.has(safeAction) || SCAFFOLD_PROMOTION_ACTIONS.has(safeAction)
    ? { externality: 'local', reversibility: 'rollbackable', sensitivity: riskClassification.risk || 'low', behaviorShaping: true }
    : { externality: 'local', reversibility: 'reversible', sensitivity: riskClassification.risk || 'low', behaviorShaping: false };
  const requestId = `evolve-${safeAction}-${safeTargetId}-${Date.now()}`;

  const governorDecision = createGovernorDecisionPacket({
    decisionId: `gov:${requestId}`,
    actionClass,
    requestedAction: {
      class: 'evolve_sidebar_action',
      action: safeAction,
      targetId: safeTargetId
    },
    authority: {
      hasCurrentInstruction: true,
      source: 'sidebar:evolution-action'
    },
    risk,
    verification: {
      required: MUTATING_CLAIM_ACTIONS.has(safeAction) || SCAFFOLD_PROMOTION_ACTIONS.has(safeAction)
        ? ['evolve_pre_action_gate', 'domain_specific_low_risk_gate', 'rollback_path_check']
        : ['evolve_pre_action_gate', 'receipt_exists_check'],
      completed: allowed ? ['evolve_pre_action_gate'] : [],
      missing: allowed ? [] : ['valid_evolution_action_target']
    },
    approval: {
      required: false,
      reason: null
    },
    rollback: {
      required: MUTATING_CLAIM_ACTIONS.has(safeAction) || SCAFFOLD_PROMOTION_ACTIONS.has(safeAction),
      plan: rollbackPlanForAction(safeAction, entry)
    },
    mode,
    reasonCodes: allowed ? ['evolve_action_preflight_passed', ...riskClassification.reasonCodes] : [...blockers, ...riskClassification.reasonCodes],
    createdAt
  });
  assertGovernorDecisionPacket(governorDecision);

  const outcomeEvent = createOutcomeEventPacket({
    eventId: `outcome:${requestId}`,
    eventType: 'evolve_action_preflight',
    status: allowed ? 'verified' : 'blocked',
    createdAt,
    source: {
      sourceType: 'evolve_action_gate',
      sourceHandle: safeTargetId,
      evidenceClass: 'direct'
    },
    intent: {
      title: `Evolve action preflight: ${safeAction}`,
      summary: allowed
        ? `Pre-action gate passed for ${safeAction}; protected authority lanes remain closed.`
        : `Pre-action gate refused ${safeAction}: ${blockers.join(', ')}`,
      expectedEffect: allowed ? expectedEffectForAction(safeAction) : 'No handler execution or mutation.'
    },
    authority: {
      governorDecisionId: governorDecision.decisionId,
      authorizationMode: allowed ? 'preflight_passed_existing_domain_gate_required' : 'refused',
      approvalRef: null
    },
    action: {
      action: safeAction,
      class: actionClass,
      claimId: entry?.claimId || null,
      lane: entry?.metadata?.lane || null,
      effect: MUTATING_CLAIM_ACTIONS.has(safeAction)
        ? 'claim_review_mutation_lane'
        : SCAFFOLD_PROMOTION_ACTIONS.has(safeAction)
          ? 'code_evolution_scaffold_promotion_lane'
          : 'evolution_review_status_update'
    },
    observed: {
      status: allowed ? 'preflight_passed' : 'blocked_before_handler',
      risk: riskClassification.risk || entry?.risk || risk.sensitivity,
      riskDecision: riskClassification.decision,
      riskPolicyRule: riskClassification.policyRule,
      sourceCategory: entry?.sourceCategory || 'evolve_action',
      authorized: allowed,
      wouldBlock: !allowed
    },
    verification: {
      status: allowed ? 'verified' : 'failed',
      method: 'evolve_pre_action_gate',
      evidence: {
        action: safeAction,
        targetId: safeTargetId,
        blockers,
        riskDecision: riskClassification.decision,
        riskPolicyRule: riskClassification.policyRule,
        riskReasonCodes: riskClassification.reasonCodes,
        promptInjectionAuthorized: false,
        schedulerAuthorized: false,
        mutationAuthorized: false
      }
    },
    rollback: {
      available: Boolean(entry?.rollbackAction),
      ref: entry?.rollbackAction?.receipt_id || entry?.receiptId || null,
      plan: rollbackPlanForAction(safeAction, entry)
    },
    learning: {
      eligibleForMaturation: false,
      prohibitionReason: 'pre_action_gate_receipt_is_evidence_not_authority'
    }
  });
  assertOutcomeEventPacket(outcomeEvent);

  return {
    allowed,
    blocked: !allowed,
    action: safeAction,
    id: safeTargetId,
    blockers,
    reason: allowed
      ? `Evolve action ${safeAction} passed pre-action gate.`
      : `Evolve action ${safeAction} refused before handler execution: ${blockers.join(', ')}`,
    governorDecision,
    outcomeEvent,
    riskClassification
  };
}

function recordEvolutionActionGateReceipt(ledgerPath, receipt = {}) {
  if (!receipt?.governorDecision || !receipt?.outcomeEvent) throw new Error('evolution action gate receipt requires governor and outcome packets');
  appendGovernorDecisionPacket(ledgerPath, receipt.governorDecision);
  appendOutcomeEventPacket(ledgerPath, receipt.outcomeEvent);
  return receipt;
}


function evolutionRiskInput({ action, entry = null, protectedLane = null } = {}) {
  return {
    action,
    lane: protectedLane || entry?.metadata?.policyDecision || actionLaneForReviewAction(action) || entry?.metadata?.lane || entry?.class || 'maintenance_suggestion',
    category: entry?.metadata?.lane || entry?.sourceCategory || protectedLane || entry?.class || 'evolve_action',
    externality: 'local',
    reversibility: MUTATING_CLAIM_ACTIONS.has(action) || SCAFFOLD_PROMOTION_ACTIONS.has(action) || action === 'rollback_claim_review' ? 'rollbackable' : 'reversible',
    scope: 'single',
    sensitivity: entry?.risk || (protectedLane ? 'high' : 'low'),
    ...protectedLaneFlags(protectedLane)
  };
}

function actionLaneForReviewAction(action) {
  if (action === 'rollback_claim_review') return 'stale_claim_cleanup';
  if (REVIEW_LEDGER_ACTIONS.has(action)) return 'ui_process_friction';
  return null;
}

function protectedLaneFlags(lane) {
  if (lane === AUTHORITY_LANES.PROMPT_INJECTION) return { promptInjection: true };
  if (lane === AUTHORITY_LANES.SCHEDULER_LINKAGE) return { schedulerLinkage: true };
  if (lane === AUTHORITY_LANES.RUNTIME_TOOL_POLICY_ENFORCEMENT) return { toolPolicyMutation: true };
  if (lane === AUTHORITY_LANES.CONFIG_CHANGES) return { runtimeConfig: true };
  if (lane === AUTHORITY_LANES.BROAD_MEMORY_PROMOTION) return { broadMemoryPromotion: true };
  return {};
}

function validateEvolutionAction({ action, entry }) {
  const blockers = [];
  if (!action) blockers.push('missing_evolution_action');
  if (MUTATING_CLAIM_ACTIONS.has(action) || REVIEW_LEDGER_ACTIONS.has(action) || HIGH_RISK_REVIEW_ACTIONS.has(action) || HIGH_RISK_PACKET_APPROVAL_ACTIONS.has(action) || HIGH_RISK_PRE_ACTION_RECHECK_ACTIONS.has(action) || HIGH_RISK_CLAIM_APPLY_ACTIONS.has(action) || HIGH_RISK_SIMPLIFIED_APPLY_ACTIONS.has(action) || SCAFFOLD_PROMOTION_ACTIONS.has(action)) {
    if (!entry) blockers.push('evolution_action_target_not_found');
  } else {
    blockers.push('unsupported_evolution_action');
  }

  if (HIGH_RISK_REVIEW_ACTIONS.has(action) && entry) {
    const protocol = entry.metadata?.highRiskProtocol || {};
    if (entry.action !== 'autonomy_review_dry_run') blockers.push('high_risk_review_requires_dry_run_candidate');
    if (entry.risk !== 'high') blockers.push('high_risk_review_requires_high_risk_candidate');
    if (protocol.protocol !== 'high_risk_candidate') blockers.push('high_risk_review_requires_high_risk_protocol');
    if (protocol.posture !== 'approval_required') blockers.push('high_risk_review_requires_approval_required_posture');
    if (protocol.protocol === 'high_risk_candidate' && protocol.posture === 'approval_required') {
      for (const blocker of validateHighRiskApprovalBinding({ entry, protocol })) blockers.push(blocker);
    }
    if (entry.metadata?.mutationAttempted === true) blockers.push('candidate_already_reports_mutation_attempt');
    if (entry.metadata?.promptInjectionEligibilityChanged === true) blockers.push('prompt_injection_eligibility_change_refused');
  }

  if (HIGH_RISK_SIMPLIFIED_APPLY_ACTIONS.has(action) && entry) {
    const protocol = entry.metadata?.highRiskProtocol || {};
    const decision = entry.metadata?.policyDecision;
    if (entry.action !== 'autonomy_review_dry_run') blockers.push('simplified_apply_requires_dry_run_candidate');
    if (entry.risk !== 'high') blockers.push('simplified_apply_requires_high_risk_candidate');
    if (protocol.protocol !== 'high_risk_candidate') blockers.push('simplified_apply_requires_high_risk_protocol');
    if (protocol.posture !== 'approval_required') blockers.push('simplified_apply_requires_approval_required_posture');
    if (protocol.effectClass !== 'claim_maturation') blockers.push('simplified_apply_requires_claim_maturation_effect');
    if (!LOW_RISK_APPLY_DECISIONS.has(decision)) blockers.push('simplified_apply_requires_supported_claim_decision');
    if (entry.metadata?.mutationAttempted === true) blockers.push('candidate_already_reports_mutation_attempt');
    if (entry.metadata?.promptInjectionEligibilityChanged === true) blockers.push('prompt_injection_eligibility_change_refused');
    if (entryMatchesSimplifiedProtectedLane(entry)) blockers.push('simplified_apply_excludes_protected_lane');
    if (protocol.protocol === 'high_risk_candidate' && protocol.posture === 'approval_required') {
      for (const blocker of validateHighRiskApprovalBinding({ entry, protocol })) blockers.push(blocker);
    }
  }


  if (HIGH_RISK_PACKET_APPROVAL_ACTIONS.has(action) && entry) {
    const packet = entry.metadata?.approvalPacket || {};
    if (entry.action !== 'high_risk_approval_packet') blockers.push('explicit_approval_requires_approval_packet_receipt');
    if (entry.risk !== 'high') blockers.push('explicit_approval_requires_high_risk_packet');
    if (packet.protocol !== 'high_risk_candidate') blockers.push('explicit_approval_requires_high_risk_protocol');
    if (packet.approvalStatus !== 'pending_explicit_approval') blockers.push('explicit_approval_requires_pending_packet');
    if (packet.applyAuthorityGranted === true || packet.applyAuthorityGranted === 'true') blockers.push('explicit_approval_refuses_existing_apply_authority');
    for (const blocker of validateHighRiskPacketApprovalBinding({ packet })) blockers.push(blocker);
  }


  if (HIGH_RISK_PRE_ACTION_RECHECK_ACTIONS.has(action) && entry) {
    const binding = entry.metadata?.approvalBinding || {};
    if (entry.action !== 'high_risk_explicit_approval') blockers.push('pre_action_recheck_requires_explicit_approval_receipt');
    if (entry.risk !== 'high') blockers.push('pre_action_recheck_requires_high_risk_approval');
    if (entry.metadata?.approvalStatus !== 'explicitly_approved_no_apply') blockers.push('pre_action_recheck_requires_captured_approval');
    if (entry.metadata?.applyAuthorityGranted === true || entry.metadata?.applyAuthorityGranted === 'true') blockers.push('pre_action_recheck_refuses_apply_authority');
    for (const blocker of validateHighRiskApprovalReceiptBinding({ binding })) blockers.push(blocker);
  }

  if (action === 'apply_low_risk_candidate' && entry) {
    const decision = entry.metadata?.policyDecision;
    if (entry.action !== 'autonomy_review_dry_run') blockers.push('apply_requires_dry_run_candidate');
    if (entry.risk !== 'low') blockers.push('apply_requires_low_risk_candidate');
    if (!LOW_RISK_APPLY_DECISIONS.has(decision)) blockers.push('apply_requires_supported_low_risk_decision');
    if (entry.metadata?.mutationAttempted === true) blockers.push('candidate_already_reports_mutation_attempt');
    if (entry.metadata?.promptInjectionEligibilityChanged === true) blockers.push('prompt_injection_eligibility_change_refused');
  }

  if (HIGH_RISK_CLAIM_APPLY_ACTIONS.has(action) && entry) {
    const binding = entry.metadata?.approvedBinding || {};
    if (entry.action !== 'high_risk_pre_action_recheck') blockers.push('high_risk_apply_requires_pre_action_recheck_receipt');
    if (entry.risk !== 'high') blockers.push('high_risk_apply_requires_high_risk_recheck');
    if (entry.status !== 'held') blockers.push('high_risk_apply_requires_held_recheck');
    if (entry.metadata?.approvalStatus !== 'rechecked_no_apply') blockers.push('high_risk_apply_requires_successful_recheck');
    if (entry.metadata?.recheckOutcome !== 'current approval still gated') blockers.push('high_risk_apply_requires_current_approval_still_gated');
    if (entry.metadata?.applyAuthorityGranted === true || entry.metadata?.applyAuthorityGranted === 'true') blockers.push('high_risk_apply_refuses_prior_apply_authority');
    if (entry.metadata?.mutationAttempted === true || entry.metadata?.mutationAttempted === 'true') blockers.push('high_risk_apply_refuses_prior_mutation_attempt');
    if (entry.metadata?.approvedForApply === true || entry.metadata?.approvedForApply === 'true') blockers.push('high_risk_apply_refuses_preapproved_apply_flag');
    if (binding.actionId !== 'high_risk_review_apply') blockers.push('high_risk_apply_requires_review_apply_action');
    if (binding.effectClass !== 'claim_maturation') blockers.push('high_risk_apply_requires_claim_maturation_effect');
    for (const blocker of validateHighRiskApprovedApplyBinding({ binding })) blockers.push(blocker);
  }

  if (action === 'rollback_claim_review' && entry) {
    if (entry.status !== 'applied') blockers.push('rollback_requires_applied_receipt');
    if (entry.rollbackAction?.action !== 'rollback_review_decision') blockers.push('rollback_requires_claim_review_rollback_action');
  }

  if (action === 'apply_scaffold_proposal' && entry) {
    const isHarnessRefinerProposal = entry.action === 'harness_refinement_proposal';
    const changeType = isHarnessRefinerProposal
      ? harnessRefinerScaffoldChangeType(entry.metadata?.lane)
      : entry.metadata?.changeType;
    if (entry.action !== 'scaffold_proposal' && !isHarnessRefinerProposal) blockers.push('scaffold_apply_requires_scaffold_proposal');
    if (entry.status !== 'preview') blockers.push('scaffold_apply_requires_preview_proposal');
    if (entry.risk !== 'low') blockers.push('scaffold_apply_requires_low_risk');
    if (!['tool_hint', 'workflow_sequence', 'prompt_rule'].includes(changeType)) blockers.push('scaffold_apply_requires_supported_change_type');
    if (isHarnessRefinerProposal && !['tool_hint', 'workflow_sequence'].includes(changeType)) blockers.push('scaffold_apply_requires_harness_workflow_or_tool_hint_lane');
    if (isHarnessRefinerProposal && entry.metadata?.applyPath !== 'existing_scaffold_gate') blockers.push('scaffold_apply_requires_existing_scaffold_gate');
    if (entry.metadata?.mutationAttempted === true || entry.metadata?.mutationAttempted === 'true') blockers.push('scaffold_apply_refuses_prior_mutation');
    if (entry.metadata?.promptInjectionChanged === true || entry.metadata?.promptInjectionChanged === 'true') blockers.push('scaffold_apply_refuses_prompt_injection');
    if (isHarnessRefinerProposal && (isTrueFlag(entry.metadata?.launchTraining) || isTrueFlag(entry.metadata?.adapterPromotion) || isTrueFlag(entry.metadata?.modelRoutingMutation) || isTrueFlag(entry.metadata?.gatewayInvocation))) {
      blockers.push('scaffold_apply_refuses_harness_protected_mutation_flags');
    }
  }

  if (action === 'rollback_scaffold_promotion' && entry) {
    if (entry.action !== 'apply_scaffold_proposal') blockers.push('scaffold_rollback_requires_promotion_receipt');
    if (entry.status !== 'applied') blockers.push('scaffold_rollback_requires_applied_receipt');
    if (entry.rollbackAction?.action !== 'rollback_scaffold_promotion') blockers.push('scaffold_rollback_requires_scaffold_rollback_action');
    if (!entry.rollbackAction?.snapshot_id && !entry.metadata?.snapshotId) blockers.push('scaffold_rollback_requires_snapshot_id');
  }

  return unique(blockers);
}

function validateHighRiskApprovalBinding({ entry = {}, protocol = {} } = {}) {
  const blockers = [];
  if (!protocol.candidateId || protocol.candidateId !== entry.id) blockers.push('approval_packet_candidate_binding_missing');
  if (!protocol.actionId) blockers.push('approval_packet_action_binding_missing');
  if (!protocol.effectClass) blockers.push('approval_packet_effect_class_missing');
  if (!hasBoundTargetRefs(protocol.targetRefs)) blockers.push('approval_packet_target_refs_missing');
  if (!protocol.expiry) blockers.push('approval_packet_expiry_missing');
  if (!Array.isArray(protocol.requiredVerification) || protocol.requiredVerification.length === 0) blockers.push('approval_packet_verification_plan_missing');
  if (!protocol.rollbackPlan) blockers.push('approval_packet_rollback_plan_missing');
  return blockers;
}


function validateHighRiskPacketApprovalBinding({ packet = {} } = {}) {
  const blockers = [];
  if (!packet.packetId) blockers.push('explicit_approval_packet_id_missing');
  if (!packet.candidateId) blockers.push('explicit_approval_candidate_binding_missing');
  if (!packet.actionId) blockers.push('explicit_approval_action_binding_missing');
  if (!packet.effectClass) blockers.push('explicit_approval_effect_class_missing');
  if (!hasBoundTargetRefs(packet.targetRefs)) blockers.push('explicit_approval_target_refs_missing');
  if (!packet.expiry) blockers.push('explicit_approval_expiry_missing');
  if (!Array.isArray(packet.requiredVerification) || packet.requiredVerification.length === 0) blockers.push('explicit_approval_verification_plan_missing');
  if (!packet.rollbackPlan) blockers.push('explicit_approval_rollback_plan_missing');
  return blockers;
}


function validateHighRiskApprovalReceiptBinding({ binding = {} } = {}) {
  const blockers = [];
  if (!binding.packetId) blockers.push('pre_action_recheck_packet_id_missing');
  if (!binding.candidateId) blockers.push('pre_action_recheck_candidate_binding_missing');
  if (!binding.actionId) blockers.push('pre_action_recheck_action_binding_missing');
  if (!binding.effectClass) blockers.push('pre_action_recheck_effect_class_missing');
  if (!hasBoundTargetRefs(binding.targetRefs)) blockers.push('pre_action_recheck_target_refs_missing');
  if (!binding.expiry) blockers.push('pre_action_recheck_expiry_missing');
  if (!Array.isArray(binding.requiredVerification) || binding.requiredVerification.length === 0) blockers.push('pre_action_recheck_verification_plan_missing');
  if (!binding.rollbackPlan) blockers.push('pre_action_recheck_rollback_plan_missing');
  return blockers;
}

function validateHighRiskApprovedApplyBinding({ binding = {} } = {}) {
  const blockers = [];
  if (!binding.packetId) blockers.push('high_risk_apply_packet_id_missing');
  if (!binding.candidateId) blockers.push('high_risk_apply_candidate_binding_missing');
  if (!binding.actionId) blockers.push('high_risk_apply_action_binding_missing');
  if (!binding.claimId) blockers.push('high_risk_apply_claim_binding_missing');
  if (!binding.effectClass) blockers.push('high_risk_apply_effect_class_missing');
  if (!hasBoundTargetRefs(binding.targetRefs)) blockers.push('high_risk_apply_target_refs_missing');
  if (!binding.expiry) blockers.push('high_risk_apply_expiry_missing');
  if (!Array.isArray(binding.requiredVerification) || binding.requiredVerification.length === 0) blockers.push('high_risk_apply_verification_plan_missing');
  if (!binding.rollbackPlan) blockers.push('high_risk_apply_rollback_plan_missing');
  return blockers;
}

function hasBoundTargetRefs(targetRefs) {
  if (!targetRefs || typeof targetRefs !== 'object' || Array.isArray(targetRefs)) return false;
  return Object.values(targetRefs).some((value) => String(value || '').trim());
}

function entryMatchesSimplifiedProtectedLane(entry = {}) {
  const protocol = entry.metadata?.highRiskProtocol || {};
  const values = [
    entry.sourceCategory,
    entry.class,
    entry.metadata?.lane,
    entry.metadata?.policyDecision,
    protocol.actionId,
    protocol.effectClass,
    protocol.authorityRequired
  ].map((value) => String(value || '').toLowerCase());
  return values.some((value) => [...SIMPLIFIED_APPLY_PROTECTED_LANES].some((lane) => value.includes(lane)));
}

function expectedEffectForAction(action) {
  if (action === 'apply_low_risk_candidate') return 'Enter the existing single-claim low-risk apply lane; no prompt injection, scheduler, config, or broad memory promotion.';
  if (action === 'rollback_claim_review') return 'Enter the existing claim-review rollback path using a stored before-receipt.';
  if (action === 'prepare_high_risk_approval_packet') return 'Persist a bound high-risk approval packet for later human review; no apply authority or behavior-changing effect is granted.';
  if (action === 'run_high_risk_preflight') return 'Persist a side-effect-free high-risk preflight receipt; no apply authority or behavior-changing effect is granted.';
  if (action === 'record_high_risk_explicit_approval') return 'Persist explicit approval of one bound high-risk packet; no apply handler, apply authority, or behavior-changing effect is granted.';
  if (action === 'run_high_risk_pre_action_recheck') return 'Reclassify one explicitly approved high-risk packet immediately before any future apply path; record the result without executing apply or granting authority.';
  if (action === 'apply_high_risk_claim_maturation') return 'Apply one explicitly approved and immediately rechecked high-risk claim maturation change; no prompt injection, scheduler, runtime config/tool-policy mutation, or broad memory promotion.';
  if (action === 'approve_and_apply_if_still_safe') return 'Run the existing high-risk packet, explicit approval, immediate recheck, and claim maturation apply gates as one user-facing action; apply only if every gate remains safe.';
  if (action === 'apply_scaffold_proposal') return 'Promote one low-risk Code Evolution or Harness Refiner scaffold proposal into evolved scaffold files with before/after hashes and rollback snapshot.';
  if (action === 'rollback_scaffold_promotion') return 'Restore the scaffold snapshot captured before a prior Code Evolution scaffold promotion.';
  return 'Update the Evolve review receipt status only; no protected authority expansion.';
}

function rollbackPlanForAction(action, entry) {
  if (action === 'apply_low_risk_candidate') return 'Claim-review apply must write before/after receipts and expose rollback_review_decision.';
  if (action === 'rollback_claim_review') return 'Rollback action uses stored before-receipt; resulting rollback receipt is append-only.';
  if (action === 'prepare_high_risk_approval_packet') return 'Dismiss or mark reviewed to retire the approval packet; no claim rollback is required because no mutation occurred.';
  if (action === 'run_high_risk_preflight') return 'Dismiss or mark reviewed to retire the preflight receipt; no claim rollback is required because no mutation occurred.';
  if (action === 'record_high_risk_explicit_approval') return 'Revoke by dismissing or superseding the approval receipt before any future apply path; no domain rollback is needed because no mutation occurred.';
  if (action === 'run_high_risk_pre_action_recheck') return 'If recheck fails, return to review and require a new packet/approval; no rollback is needed because no mutation occurred.';
  if (action === 'apply_high_risk_claim_maturation') return 'Claim maturation apply must write before/after receipts and expose rollback_review_decision from the stored before receipt.';
  if (action === 'approve_and_apply_if_still_safe') return 'If all internal gates pass, claim maturation apply must write before/after receipts and expose rollback_review_decision; if any gate fails, no mutation occurs.';
  if (action === 'apply_scaffold_proposal') return 'Snapshot evolved scaffold files before applying; expose rollback_scaffold_promotion with the snapshot id.';
  if (action === 'rollback_scaffold_promotion') return 'Rollback restores the captured snapshot; re-promote the original proposal if needed.';
  return entry?.rollback || 'Evolve review-status updates remain visible in operatorActions; reopen can supersede review status.';
}

function harnessRefinerScaffoldChangeType(lane) {
  if (lane === 'tool_hint_patch') return 'tool_hint';
  if (lane === 'workflow_patch') return 'workflow_sequence';
  return null;
}

function isTrueFlag(value) {
  return value === true || value === 'true';
}

function safe(value, max = 500) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function unique(items = []) {
  return [...new Set(items.filter(Boolean))];
}

module.exports = {
  PROTECTED_EVOLUTION_ACTION_LANES,
  createEvolutionActionGateReceipt,
  recordEvolutionActionGateReceipt,
  validateEvolutionAction,
  validateHighRiskApprovalBinding,
  validateHighRiskPacketApprovalBinding,
  validateHighRiskApprovalReceiptBinding,
  validateHighRiskApprovedApplyBinding,
  entryMatchesSimplifiedProtectedLane
};
