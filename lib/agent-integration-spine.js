'use strict';

const PACKET_VERSION = 1;

const PACKET_TYPES = Object.freeze({
  STATE_RECORD: 'state_record',
  RESPONSIBILITY_LEASE: 'responsibility_lease',
  GOVERNOR_DECISION: 'governor_decision',
  OUTCOME_EVENT: 'outcome_event',
  MATURATION_CANDIDATE: 'maturation_candidate'
});

const CONSUMERS = Object.freeze({
  UI_REVIEW: 'ui_review',
  RECALL_SEARCH: 'recall_search',
  MATURATION_ROUTER: 'maturation_router',
  CONTEXT_INJECTION: 'context_injection',
  PLANNING: 'planning',
  TOOL_ACTION_EXECUTION: 'tool_action_execution',
  MEMORY_PROMOTION: 'memory_promotion',
  OUTCOME_LEDGER: 'outcome_ledger',
  RESPONSIBILITY_REGISTRY: 'responsibility_registry',
  SCHEDULER: 'scheduler',
  GOVERNOR: 'governor'
});

const OUTCOME_STATUSES = new Set(['observed', 'verified', 'failed', 'blocked', 'interrupted', 'rolled_back', 'review_requested']);
const LEASE_STATUSES = new Set(['candidate', 'active', 'paused', 'completed', 'expired', 'cancelled']);
const GOVERNOR_MODES = Object.freeze({
  PROCEED: 'proceed',
  PROCEED_WITH_VERIFICATION: 'proceed_with_verification',
  ASK_FOR_MISSING_AUTHORITY: 'ask_for_missing_authority',
  REQUIRE_APPROVAL: 'require_approval',
  DEFER_OR_DRY_RUN: 'defer_or_dry_run',
  REFUSE_WITH_SAFE_ALTERNATIVE: 'refuse_with_safe_alternative',
  PAUSE_RECOVER: 'pause_recover'
});
const GOVERNOR_MODE_VALUES = new Set(Object.values(GOVERNOR_MODES));
const CONTEXT_ELIGIBILITY_MODES = Object.freeze({
  BLOCKED: 'blocked',
  REVIEW_ONLY: 'review_only',
  ELIGIBLE_MINIMAL: 'eligible_minimal'
});
const CONTEXT_ELIGIBILITY_MODE_VALUES = new Set(Object.values(CONTEXT_ELIGIBILITY_MODES));

const MATURATION_LANES = Object.freeze({
  SEMANTIC_MEMORY: 'semantic_memory',
  CURRENT_STATE: 'current_state',
  CLAIM: 'claim',
  RELATIONAL_POSTURE: 'relational_posture',
  PROCEDURAL_LEARNING: 'procedural_learning',
  SAFETY_POLICY: 'safety_policy',
  CONTEXT_ELIGIBILITY: 'context_eligibility',
  DIAGNOSTICS_ONLY: 'diagnostics_only'
});
const MATURATION_LANE_VALUES = new Set(Object.values(MATURATION_LANES));

const ACTION_CLASSES = Object.freeze({
  ORDINARY_CONVERSATION: 'ordinary_conversation',
  READ_ONLY_INVESTIGATION: 'read_only_investigation',
  LOCAL_PROJECT_EDIT: 'local_project_edit',
  MEMORY_APPEND: 'memory_append',
  CLAIM_MATURATION: 'claim_maturation',
  EXTERNAL_MESSAGE: 'external_message',
  BACKGROUND_RESPONSIBILITY: 'background_responsibility',
  PROCEDURAL_LEARNING: 'procedural_learning',
  SAFETY_POLICY: 'safety_policy',
  CONTEXT_ELIGIBILITY: 'context_eligibility',
  RUNTIME_CONFIG: 'runtime_config',
  TOOL_POLICY: 'tool_policy',
  PHYSICAL_ACTION: 'physical_action'
});

function createStateRecordPacket({
  recordId,
  recordType,
  agentScope = null,
  source = {},
  lifecycle = {},
  policy = {},
  receipts = {},
  data = null
} = {}) {
  if (!recordId) throw new Error('state_record requires recordId');
  if (!recordType) throw new Error('state_record requires recordType');

  return pruneNullish({
    packetType: PACKET_TYPES.STATE_RECORD,
    packetVersion: PACKET_VERSION,
    recordIdentity: {
      recordId,
      recordType,
      agentScope
    },
    source: {
      sourceType: source.sourceType || 'unknown',
      sourceHandle: source.sourceHandle || null,
      sourceHandles: normalizeArray(source.sourceHandles || source.sourceHandle),
      observedAt: source.observedAt || null,
      evidenceClass: source.evidenceClass || 'derived'
    },
    lifecycle: {
      status: lifecycle.status || 'candidate',
      freshnessClass: lifecycle.freshnessClass || 'durable',
      expiresAt: lifecycle.expiresAt || null
    },
    policy: {
      allowedConsumers: normalizeArray(policy.allowedConsumers),
      prohibitedConsumers: normalizeArray(policy.prohibitedConsumers),
      privacyTier: policy.privacyTier || 'local_private',
      promptInjectionRisk: policy.promptInjectionRisk || 'blocked',
      mutationPolicy: policy.mutationPolicy || 'none'
    },
    receipts: {
      createdByEvent: receipts.createdByEvent || null,
      verifiedByEvent: receipts.verifiedByEvent || null,
      appliedByEvent: receipts.appliedByEvent || null,
      rollbackRef: receipts.rollbackRef || null
    },
    data
  });
}

function createResponsibilityLeasePacket({
  leaseId,
  owner = null,
  executor = null,
  objective,
  scope = {},
  status = 'candidate',
  authority = {},
  successCriteria = [],
  nonGoals = [],
  budgets = {},
  review = {},
  createdAt = null,
  expiresAt = null,
  source = {}
} = {}) {
  if (!leaseId) throw new Error('responsibility_lease requires leaseId');
  if (!objective) throw new Error('responsibility_lease requires objective');
  const normalizedStatus = LEASE_STATUSES.has(status) ? status : 'candidate';
  const packet = {
    packetType: PACKET_TYPES.RESPONSIBILITY_LEASE,
    packetVersion: PACKET_VERSION,
    leaseId: safe(leaseId),
    owner: owner || 'operator',
    executor: executor || 'agent',
    objective: safe(objective),
    scope: sanitizeRecord(scope),
    lifecycle: {
      status: normalizedStatus,
      createdAt,
      expiresAt,
      renewalPolicy: review.renewalPolicy || 'explicit_only'
    },
    authority: {
      sourceType: authority.sourceType || source.sourceType || 'current_user',
      sourceHandle: authority.sourceHandle || source.sourceHandle || null,
      allowedActions: normalizeArray(authority.allowedActions),
      prohibitedActions: normalizeArray(authority.prohibitedActions),
      approvalRequiredFor: normalizeArray(authority.approvalRequiredFor)
    },
    successCriteria: normalizeArray(successCriteria),
    nonGoals: normalizeArray(nonGoals),
    budgets: sanitizeRecord(budgets),
    consumers: {
      allowed: [CONSUMERS.PLANNING, CONSUMERS.GOVERNOR, CONSUMERS.RESPONSIBILITY_REGISTRY],
      prohibited: [CONSUMERS.CONTEXT_INJECTION, CONSUMERS.MEMORY_PROMOTION]
    },
    receipts: {
      createdByEvent: source.createdByEvent || null,
      completedByEvent: null,
      interruptedByEvent: null,
      rollbackRef: null
    }
  };
  packet.invariants = responsibilityLeaseInvariants(packet);
  return packet;
}

function createOutcomeEventPacket({
  eventId,
  eventType = 'action_observed',
  status = 'observed',
  intent = null,
  authority = {},
  action = {},
  observed = {},
  verification = {},
  rollback = {},
  learning = {},
  privacy = {},
  createdAt = null,
  source = {}
} = {}) {
  if (!eventId) throw new Error('outcome_event requires eventId');
  const normalizedStatus = OUTCOME_STATUSES.has(status) ? status : 'observed';
  const packet = {
    packetType: PACKET_TYPES.OUTCOME_EVENT,
    packetVersion: PACKET_VERSION,
    eventId: safe(eventId),
    eventType: safe(eventType || 'action_observed'),
    status: normalizedStatus,
    createdAt,
    source: {
      sourceType: source.sourceType || 'tool_result',
      sourceHandle: source.sourceHandle || null,
      evidenceClass: source.evidenceClass || 'derived'
    },
    intent: sanitizeRecord(intent || {}),
    authority: {
      leaseId: authority.leaseId || null,
      governorDecisionId: authority.governorDecisionId || null,
      authorizationMode: authority.authorizationMode || 'unknown',
      approvalRef: authority.approvalRef || null
    },
    action: sanitizeRecord(action || {}),
    observed: sanitizeRecord(observed || {}),
    verification: {
      status: verification.status || 'not_checked',
      method: verification.method || null,
      evidence: sanitizeRecord(verification.evidence || {})
    },
    rollback: {
      available: rollback.available === true,
      ref: rollback.ref || null,
      plan: rollback.plan || null
    },
    learning: {
      eligibleForMaturation: learning.eligibleForMaturation === true,
      suggestedLane: learning.suggestedLane || null,
      prohibitionReason: learning.prohibitionReason || null
    },
    policy: {
      allowedConsumers: [CONSUMERS.UI_REVIEW, CONSUMERS.RECALL_SEARCH, CONSUMERS.OUTCOME_LEDGER, CONSUMERS.MATURATION_ROUTER],
      prohibitedConsumers: [CONSUMERS.CONTEXT_INJECTION, CONSUMERS.TOOL_ACTION_EXECUTION, CONSUMERS.MEMORY_PROMOTION],
      privacyTier: privacy.privacyTier || 'local_private',
      promptInjectionRisk: 'blocked',
      mutationPolicy: 'append_only'
    }
  };
  packet.invariants = outcomeEventInvariants(packet);
  return packet;
}


function createGovernorDecisionPacket({
  decisionId,
  actionClass,
  requestedAction = {},
  authority = {},
  risk = {},
  selfState = {},
  verification = {},
  approval = {},
  rollback = {},
  mode = null,
  reasonCodes = [],
  createdAt = null
} = {}) {
  if (!decisionId) throw new Error('governor_decision requires decisionId');
  if (!actionClass) throw new Error('governor_decision requires actionClass');
  const normalizedActionClass = safe(actionClass);
  const authoritySnapshot = normalizeGovernorAuthority(authority);
  const computed = classifyGovernorMode({
    actionClass: normalizedActionClass,
    requestedAction,
    authority: authoritySnapshot,
    risk,
    selfState,
    verification,
    approval
  });
  const selectedMode = GOVERNOR_MODE_VALUES.has(mode) ? mode : computed.mode;
  const packet = {
    packetType: PACKET_TYPES.GOVERNOR_DECISION,
    packetVersion: PACKET_VERSION,
    decisionId: safe(decisionId),
    actionClass: normalizedActionClass,
    mode: selectedMode,
    createdAt,
    requestedAction: sanitizeRecord(requestedAction || {}),
    authority: authoritySnapshot,
    risk: {
      externality: risk.externality || 'local',
      reversibility: risk.reversibility || 'reversible',
      sensitivity: risk.sensitivity || 'low',
      behaviorShaping: risk.behaviorShaping === true
    },
    selfState: {
      anomaly: selfState.anomaly || null,
      coherenceRisk: selfState.coherenceRisk || 'unknown',
      mayIncreaseFrictionOnly: true
    },
    checks: {
      required: unique(normalizeArray(verification.required).concat(computed.requiredChecks)),
      completed: normalizeArray(verification.completed),
      missing: unique(normalizeArray(verification.missing).concat(computed.missingChecks))
    },
    approval: {
      required: approval.required === true || computed.approvalRequired === true,
      approvalRef: approval.approvalRef || null,
      reason: approval.reason || computed.approvalReason || null
    },
    rollback: {
      required: rollback.required === true || computed.rollbackRequired === true,
      plan: rollback.plan || null,
      ref: rollback.ref || null
    },
    output: {
      decisionOnly: true,
      toolExecutionAuthorized: false,
      mutationAuthorized: false,
      promptInjectionAuthorized: false,
      schedulerAuthorized: false
    },
    receipts: {
      outcomeEventRequired: computed.outcomeEventRequired === true,
      outcomeEventId: null
    },
    reasonCodes: unique(normalizeArray(reasonCodes).concat(computed.reasonCodes)),
    policy: {
      allowedConsumers: [CONSUMERS.UI_REVIEW, CONSUMERS.PLANNING, CONSUMERS.GOVERNOR, CONSUMERS.OUTCOME_LEDGER],
      prohibitedConsumers: [CONSUMERS.TOOL_ACTION_EXECUTION, CONSUMERS.CONTEXT_INJECTION, CONSUMERS.MEMORY_PROMOTION],
      promptInjectionRisk: 'blocked',
      mutationPolicy: 'none'
    }
  };
  packet.invariants = governorDecisionInvariants(packet);
  return packet;
}

function classifyGovernorMode({ actionClass, authority = {}, risk = {}, selfState = {}, verification = {}, approval = {} } = {}) {
  const reasonCodes = [];
  const requiredChecks = [];
  const missingChecks = [];
  let mode = GOVERNOR_MODES.PROCEED;
  let approvalRequired = false;
  let approvalReason = null;
  let rollbackRequired = false;
  let outcomeEventRequired = false;

  if (selfState.anomaly || selfState.coherenceRisk === 'high') {
    requiredChecks.push('pause_or_verify_due_to_self_state');
    reasonCodes.push('self_state_can_only_increase_friction');
  }

  if (!authority.hasCurrentInstruction && !authority.activeLeaseId && !authority.approvalRef && actionClass !== ACTION_CLASSES.ORDINARY_CONVERSATION) {
    mode = GOVERNOR_MODES.ASK_FOR_MISSING_AUTHORITY;
    missingChecks.push('current_task_or_active_lease_authority');
    reasonCodes.push('missing_action_authority');
  }

  if (actionClass === ACTION_CLASSES.READ_ONLY_INVESTIGATION) {
    if (risk.mutableFacts === true) {
      mode = higherFriction(mode, GOVERNOR_MODES.PROCEED_WITH_VERIFICATION);
      requiredChecks.push('verify_mutable_facts_with_tool_evidence');
      outcomeEventRequired = false;
    }
  } else if (actionClass === ACTION_CLASSES.LOCAL_PROJECT_EDIT || actionClass === ACTION_CLASSES.MEMORY_APPEND) {
    mode = higherFriction(mode, GOVERNOR_MODES.PROCEED_WITH_VERIFICATION);
    requiredChecks.push('read_before_write', 'verify_after_write');
    rollbackRequired = true;
    outcomeEventRequired = true;
  } else if (actionClass === ACTION_CLASSES.CLAIM_MATURATION || actionClass === ACTION_CLASSES.PROCEDURAL_LEARNING || actionClass === ACTION_CLASSES.SAFETY_POLICY || actionClass === ACTION_CLASSES.CONTEXT_ELIGIBILITY) {
    mode = higherFriction(mode, GOVERNOR_MODES.DEFER_OR_DRY_RUN);
    requiredChecks.push('dry_run_review_packet', 'lane_policy_check');
    approvalRequired = actionClass !== ACTION_CLASSES.CLAIM_MATURATION || approval.required === true;
    approvalReason = approvalRequired ? 'behavior_shaping_or_context_sensitive_change' : null;
    rollbackRequired = true;
    outcomeEventRequired = true;
  } else if (actionClass === ACTION_CLASSES.EXTERNAL_MESSAGE) {
    mode = higherFriction(mode, authority.recipientConfirmed && authority.intentConfirmed ? GOVERNOR_MODES.REQUIRE_APPROVAL : GOVERNOR_MODES.ASK_FOR_MISSING_AUTHORITY);
    requiredChecks.push('recipient_confirmed', 'current_intent_confirmed');
    if (!authority.recipientConfirmed) missingChecks.push('recipient_confirmed');
    if (!authority.intentConfirmed) missingChecks.push('current_intent_confirmed');
    approvalRequired = true;
    approvalReason = 'external_side_effect';
    outcomeEventRequired = true;
  } else if (actionClass === ACTION_CLASSES.BACKGROUND_RESPONSIBILITY) {
    if (!authority.activeLeaseId) {
      mode = higherFriction(mode, GOVERNOR_MODES.ASK_FOR_MISSING_AUTHORITY);
      missingChecks.push('active_responsibility_lease');
    } else {
      mode = higherFriction(mode, GOVERNOR_MODES.PROCEED_WITH_VERIFICATION);
      requiredChecks.push('lease_scope_expiry_budget_check');
    }
    outcomeEventRequired = true;
  } else if (actionClass === ACTION_CLASSES.RUNTIME_CONFIG || actionClass === ACTION_CLASSES.TOOL_POLICY || actionClass === ACTION_CLASSES.PHYSICAL_ACTION) {
    mode = higherFriction(mode, GOVERNOR_MODES.REQUIRE_APPROVAL);
    approvalRequired = true;
    approvalReason = 'protected_runtime_or_physical_effect';
    requiredChecks.push('exact_operator_approval', 'rollback_plan');
    rollbackRequired = true;
    outcomeEventRequired = true;
  }

  if (risk.sensitivity === 'high' || risk.externality === 'external' || risk.reversibility === 'irreversible') {
    mode = higherFriction(mode, approvalRequired ? GOVERNOR_MODES.REQUIRE_APPROVAL : GOVERNOR_MODES.PROCEED_WITH_VERIFICATION);
    requiredChecks.push('heightened_risk_review');
    reasonCodes.push('heightened_risk_increases_friction');
  }

  return {
    mode,
    approvalRequired,
    approvalReason,
    rollbackRequired,
    outcomeEventRequired,
    requiredChecks: unique(requiredChecks),
    missingChecks: unique(missingChecks),
    reasonCodes: unique(reasonCodes)
  };
}

function normalizeGovernorAuthority(authority = {}) {
  return {
    hasCurrentInstruction: authority.hasCurrentInstruction === true,
    activeLeaseId: authority.activeLeaseId || null,
    approvalRef: authority.approvalRef || null,
    toolCapabilityPresent: authority.toolCapabilityPresent === true,
    recipientConfirmed: authority.recipientConfirmed === true,
    intentConfirmed: authority.intentConfirmed === true,
    source: authority.source || null
  };
}

function governorDecisionInvariants(packet = {}) {
  return {
    decisionOnly: packet.output?.decisionOnly === true,
    noToolExecutionAuthority: packet.output?.toolExecutionAuthorized === false,
    noMutationAuthority: packet.output?.mutationAuthorized === false && packet.policy?.mutationPolicy === 'none',
    noPromptInjectionAuthority: packet.output?.promptInjectionAuthorized === false && packet.policy?.promptInjectionRisk === 'blocked',
    toolCapabilityIsNotAuthority: packet.authority?.toolCapabilityPresent !== true || packet.authority?.hasCurrentInstruction === true || Boolean(packet.authority?.activeLeaseId) || Boolean(packet.authority?.approvalRef) || packet.mode === GOVERNOR_MODES.ASK_FOR_MISSING_AUTHORITY,
    selfStateCannotAuthorize: packet.selfState?.mayIncreaseFrictionOnly === true
  };
}

function assertGovernorDecisionPacket(packet = {}) {
  const invariants = governorDecisionInvariants(packet);
  const failed = Object.entries(invariants).filter(([, ok]) => ok !== true).map(([name]) => name);
  if (failed.length) throw new Error(`governor_decision violates invariants: ${failed.join(', ')}`);
  return true;
}

function higherFriction(current, candidate) {
  const order = [
    GOVERNOR_MODES.PROCEED,
    GOVERNOR_MODES.PROCEED_WITH_VERIFICATION,
    GOVERNOR_MODES.ASK_FOR_MISSING_AUTHORITY,
    GOVERNOR_MODES.DEFER_OR_DRY_RUN,
    GOVERNOR_MODES.REQUIRE_APPROVAL,
    GOVERNOR_MODES.REFUSE_WITH_SAFE_ALTERNATIVE,
    GOVERNOR_MODES.PAUSE_RECOVER
  ];
  return order.indexOf(candidate) > order.indexOf(current) ? candidate : current;
}

function createOutcomeEventPacketFromEvolutionEntry(entry = {}) {
  if (!entry.id) throw new Error('outcome_event adapter requires entry.id');
  const isRollback = entry.status === 'rolled_back' || entry.action === 'rollback_review_decision';
  return createOutcomeEventPacket({
    eventId: `outcome:${entry.id}`,
    eventType: isRollback ? 'rollback_observed' : 'review_receipt_observed',
    status: isRollback ? 'rolled_back' : statusFromEvolutionStatus(entry.status),
    createdAt: entry.createdAt || null,
    source: {
      sourceType: 'outcome_event',
      sourceHandle: entry.receiptId || entry.id,
      evidenceClass: 'derived'
    },
    intent: {
      title: entry.title,
      summary: entry.summary,
      expectedEffect: entry.expectedEffect
    },
    authority: {
      authorizationMode: entry.allowedBy || entry.metadata?.authorizationMode || 'unknown',
      approvalRef: null
    },
    action: {
      action: entry.action,
      class: entry.class,
      claimId: entry.claimId || null
    },
    observed: {
      status: entry.status,
      risk: entry.risk,
      sourceCategory: entry.sourceCategory
    },
    verification: {
      status: entry.verification ? 'recorded' : 'not_checked',
      method: 'evolution_ledger_receipt',
      evidence: { verification: entry.verification, receiptId: entry.receiptId || null }
    },
    rollback: {
      available: Boolean(entry.rollbackAction),
      ref: entry.rollbackAction?.receipt_id || entry.receiptId || null,
      plan: entry.rollback || null
    },
    learning: {
      eligibleForMaturation: false,
      prohibitionReason: 'ledger_receipt_is_evidence_not_authority'
    }
  });
}

function createMaturationCandidatePacketFromAutonomyReceipt(receipt = {}, options = {}) {
  if (!receipt.claimId) throw new Error('maturation_candidate requires receipt.claimId');
  const sourceHandles = normalizeArray(receipt.sourceHandles);
  const sensitivityFlags = normalizeArray(receipt.sensitivityFlags);
  const scopeFlags = normalizeArray(receipt.scopeFlags);
  const lane = safe(receipt.lane || 'unknown');
  const policyDecision = safe(receipt.policyDecision || 'unknown');
  const mutationAttempted = receipt.mutationAttempted === true;
  const promptInjectionEligibilityChanged = receipt.promptInjectionEligibilityChanged === true;
  const eligibleForMinimalContext = receipt.eligibleForMinimalContext === true;

  const packet = {
    packetType: PACKET_TYPES.MATURATION_CANDIDATE,
    packetVersion: PACKET_VERSION,
    candidateId: options.candidateId || `maturation-candidate:${receipt.claimId}`,
    recordRef: {
      type: 'claim',
      id: receipt.claimId
    },
    lane,
    decision: policyDecision,
    source: {
      sourceType: 'claim_source',
      sourceHandles,
      evidenceClass: receipt.synthesis ? 'hypothesis' : 'derived',
      sourceResolutionStatus: 'not_resolved_by_packet_adapter'
    },
    lifecycle: {
      status: 'candidate',
      freshnessClass: 'durable',
      expiresAt: null
    },
    policy: {
      allowedConsumers: [CONSUMERS.UI_REVIEW, CONSUMERS.RECALL_SEARCH, CONSUMERS.MATURATION_ROUTER],
      prohibitedConsumers: [CONSUMERS.CONTEXT_INJECTION, CONSUMERS.TOOL_ACTION_EXECUTION, CONSUMERS.MEMORY_PROMOTION],
      privacyTier: sensitivityFlags.length ? 'sensitive' : 'local_private',
      promptInjectionRisk: 'blocked',
      mutationPolicy: 'none',
      approvalRequired: policyDecision === 'auto_accept' ? false : true
    },
    review: {
      reasonCodes: normalizeArray(receipt.reasonCodes),
      sensitivityFlags,
      scopeFlags,
      projectFactSubtype: receipt.projectFactSubtype || 'not_project_fact',
      authorityExpansionDetected: receipt.authorityExpansionDetected === true,
      hypothesisSynthesisDetected: receipt.hypothesisSynthesisDetected === true,
      synthesisForm: receipt.synthesisForm || 'none',
      risk: riskForReceipt(receipt)
    },
    effects: {
      dryRun: receipt.dryRun !== false,
      eligibleForApply: receipt.eligibleForApply === true,
      eligibleForMinimalContext,
      mutationAttempted,
      promptInjectionEligibilityChanged
    },
    receipts: {
      createdByEvent: options.createdByEvent || 'claim_autonomy_review_dry_run',
      verifiedByEvent: null,
      appliedByEvent: null,
      rollbackRef: null
    }
  };

  packet.invariants = readOnlyMaturationInvariants(packet);
  return packet;
}



function createMaturationCandidatePacketFromOutcomeEvent(outcome = {}, options = {}) {
  if (!outcome.eventId) throw new Error('maturation_candidate outcome adapter requires outcome.eventId');
  if (outcome.packetType && outcome.packetType !== PACKET_TYPES.OUTCOME_EVENT) {
    throw new Error('maturation_candidate outcome adapter requires outcome_event packet');
  }
  if (outcome.learning?.eligibleForMaturation !== true) {
    throw new Error('outcome_event is not eligible for maturation');
  }
  const lane = normalizeMaturationLane(outcome.learning?.suggestedLane);
  const candidateId = options.candidateId || `maturation-candidate:outcome:${outcome.eventId}`;
  const sensitive = outcome.policy?.privacyTier === 'sensitive' || outcome.risk?.sensitivity === 'high';
  const behaviorShaping = [MATURATION_LANES.PROCEDURAL_LEARNING, MATURATION_LANES.SAFETY_POLICY, MATURATION_LANES.CONTEXT_ELIGIBILITY].includes(lane);
  const packet = {
    packetType: PACKET_TYPES.MATURATION_CANDIDATE,
    packetVersion: PACKET_VERSION,
    candidateId,
    recordRef: {
      type: PACKET_TYPES.OUTCOME_EVENT,
      id: outcome.eventId
    },
    lane,
    decision: 'dry_run_review_only',
    source: {
      sourceType: 'outcome_event',
      sourceHandle: outcome.eventId,
      evidenceClass: 'derived',
      sourceResolutionStatus: 'packet_adapter_only'
    },
    lifecycle: {
      status: 'candidate',
      freshnessClass: 'durable',
      expiresAt: null
    },
    policy: {
      allowedConsumers: [CONSUMERS.UI_REVIEW, CONSUMERS.RECALL_SEARCH, CONSUMERS.MATURATION_ROUTER],
      prohibitedConsumers: [CONSUMERS.CONTEXT_INJECTION, CONSUMERS.TOOL_ACTION_EXECUTION, CONSUMERS.MEMORY_PROMOTION],
      privacyTier: sensitive ? 'sensitive' : 'local_private',
      promptInjectionRisk: 'blocked',
      mutationPolicy: 'none',
      approvalRequired: true
    },
    review: {
      reasonCodes: unique(normalizeArray(options.reasonCodes).concat('outcome_event_requested_maturation')),
      sensitivityFlags: sensitive ? ['sensitive_or_high_risk_outcome'] : [],
      scopeFlags: behaviorShaping ? ['behavior_shaping_lane'] : [],
      projectFactSubtype: 'not_project_fact',
      authorityExpansionDetected: false,
      hypothesisSynthesisDetected: false,
      synthesisForm: 'none',
      risk: behaviorShaping || sensitive ? 'high' : 'medium',
      requiredChecks: requiredMaturationChecksForLane(lane)
    },
    effects: {
      dryRun: true,
      eligibleForApply: false,
      eligibleForMinimalContext: false,
      mutationAttempted: false,
      promptInjectionEligibilityChanged: false
    },
    receipts: {
      createdByEvent: options.createdByEvent || outcome.eventId,
      verifiedByEvent: null,
      appliedByEvent: null,
      rollbackRef: null
    }
  };
  packet.invariants = readOnlyMaturationInvariants(packet);
  return packet;
}

function createMaturationCandidatePacketsFromOutcomeEvents(outcomeEvents = [], options = {}) {
  const candidates = [];
  const seen = new Set();
  for (const outcome of Array.isArray(outcomeEvents) ? outcomeEvents : []) {
    if (outcome?.learning?.eligibleForMaturation !== true) continue;
    const candidate = createMaturationCandidatePacketFromOutcomeEvent(outcome, options);
    if (seen.has(candidate.candidateId)) continue;
    seen.add(candidate.candidateId);
    candidates.push(candidate);
  }
  return candidates;
}

function normalizeMaturationLane(lane) {
  const safeLane = safe(lane || '');
  return MATURATION_LANE_VALUES.has(safeLane) ? safeLane : MATURATION_LANES.DIAGNOSTICS_ONLY;
}

function requiredMaturationChecksForLane(lane) {
  const checks = ['source_review', 'contradiction_review', 'privacy_review', 'rollback_or_supersession_review'];
  if (lane === MATURATION_LANES.PROCEDURAL_LEARNING) checks.push('test_plan', 'operator_or_user_approval');
  if (lane === MATURATION_LANES.SAFETY_POLICY) checks.push('adversarial_review', 'operator_or_user_approval');
  if (lane === MATURATION_LANES.CONTEXT_ELIGIBILITY) checks.push('context_injection_filter_review', 'explicit_context_authority');
  return unique(checks);
}


function createContextEligibilityReview({
  reviewId,
  packet = {},
  requestedConsumer = CONSUMERS.CONTEXT_INJECTION,
  authority = {},
  risk = {},
  mode = null,
  reasonCodes = [],
  createdAt = null
} = {}) {
  if (!reviewId) throw new Error('context_eligibility review requires reviewId');
  const computed = classifyContextEligibility({ packet, requestedConsumer, authority, risk });
  const selectedMode = CONTEXT_ELIGIBILITY_MODE_VALUES.has(mode) ? mode : computed.mode;
  return {
    reviewId: safe(reviewId),
    packetType: 'context_eligibility_review',
    packetVersion: PACKET_VERSION,
    createdAt,
    target: {
      packetType: packet.packetType || 'unknown',
      recordId: packet.recordIdentity?.recordId || packet.candidateId || packet.eventId || packet.decisionId || packet.leaseId || null,
      requestedConsumer
    },
    mode: selectedMode,
    checks: {
      required: computed.requiredChecks,
      missing: computed.missingChecks
    },
    authority: {
      hasExplicitContextApproval: authority.hasExplicitContextApproval === true,
      activeLeaseId: authority.activeLeaseId || null,
      source: authority.source || null
    },
    output: {
      reviewOnly: true,
      contextInjectionAuthorized: false,
      promptMutationAuthorized: false,
      memoryPromotionAuthorized: false
    },
    reasonCodes: unique(normalizeArray(reasonCodes).concat(computed.reasonCodes)),
    policy: {
      allowedConsumers: [CONSUMERS.UI_REVIEW, CONSUMERS.GOVERNOR],
      prohibitedConsumers: [CONSUMERS.CONTEXT_INJECTION, CONSUMERS.MEMORY_PROMOTION, CONSUMERS.TOOL_ACTION_EXECUTION],
      promptInjectionRisk: 'blocked',
      mutationPolicy: 'none'
    }
  };
}

function classifyContextEligibility({ packet = {}, requestedConsumer = CONSUMERS.CONTEXT_INJECTION, authority = {}, risk = {} } = {}) {
  const policy = packet.policy || {};
  const lifecycle = packet.lifecycle || {};
  const source = packet.source || {};
  const allowed = normalizeArray(policy.allowedConsumers || packet.consumers?.allowed);
  const prohibited = normalizeArray(policy.prohibitedConsumers || packet.consumers?.prohibited);
  const reasonCodes = [];
  const requiredChecks = ['source_review', 'privacy_review', 'contradiction_review'];
  const missingChecks = [];
  let mode = CONTEXT_ELIGIBILITY_MODES.REVIEW_ONLY;

  if (requestedConsumer !== CONSUMERS.CONTEXT_INJECTION) {
    reasonCodes.push('not_context_injection_request');
    return { mode: CONTEXT_ELIGIBILITY_MODES.REVIEW_ONLY, requiredChecks, missingChecks, reasonCodes };
  }

  if (prohibited.includes(CONSUMERS.CONTEXT_INJECTION) || policy.promptInjectionRisk === 'blocked') {
    mode = CONTEXT_ELIGIBILITY_MODES.BLOCKED;
    reasonCodes.push('packet_policy_blocks_context_injection');
  }

  if (packet.packetType !== PACKET_TYPES.STATE_RECORD) {
    mode = CONTEXT_ELIGIBILITY_MODES.BLOCKED;
    reasonCodes.push('only_state_records_can_be_context_candidates');
  }

  if (source.evidenceClass === 'generated_summary' || source.evidenceClass === 'hypothesis' || source.sourceResolutionStatus === 'not_resolved_by_packet_adapter') {
    mode = CONTEXT_ELIGIBILITY_MODES.BLOCKED;
    reasonCodes.push('source_not_strong_enough_for_context');
  }

  if (policy.privacyTier === 'sensitive' || risk.sensitivity === 'high') {
    mode = CONTEXT_ELIGIBILITY_MODES.BLOCKED;
    reasonCodes.push('sensitive_material_context_blocked');
  }

  if (!authority.hasExplicitContextApproval && !authority.activeLeaseId) {
    missingChecks.push('explicit_context_authority');
    if (mode !== CONTEXT_ELIGIBILITY_MODES.BLOCKED) mode = CONTEXT_ELIGIBILITY_MODES.REVIEW_ONLY;
    reasonCodes.push('context_authority_missing');
  }

  if (mode !== CONTEXT_ELIGIBILITY_MODES.BLOCKED && allowed.includes(CONSUMERS.CONTEXT_INJECTION) && lifecycle.status === 'active' && (authority.hasExplicitContextApproval || authority.activeLeaseId)) {
    mode = CONTEXT_ELIGIBILITY_MODES.ELIGIBLE_MINIMAL;
    requiredChecks.push('minimal_context_scope_check');
    reasonCodes.push('explicitly_scoped_minimal_context_candidate');
  }

  return {
    mode,
    requiredChecks: unique(requiredChecks),
    missingChecks: unique(missingChecks),
    reasonCodes: unique(reasonCodes)
  };
}

function contextEligibilityInvariants(review = {}) {
  return {
    reviewOnly: review.output?.reviewOnly === true,
    noContextInjectionAuthority: review.output?.contextInjectionAuthorized === false,
    noPromptMutationAuthority: review.output?.promptMutationAuthorized === false && review.policy?.mutationPolicy === 'none',
    noMemoryPromotionAuthority: review.output?.memoryPromotionAuthorized === false,
    noDirectContextConsumer: normalizeArray(review.policy?.prohibitedConsumers).includes(CONSUMERS.CONTEXT_INJECTION)
  };
}

function assertContextEligibilityReview(review = {}) {
  const invariants = contextEligibilityInvariants(review);
  const failed = Object.entries(invariants).filter(([, ok]) => ok !== true).map(([name]) => name);
  if (failed.length) throw new Error(`context_eligibility review violates invariants: ${failed.join(', ')}`);
  return true;
}

function outcomeEventInvariants(packet = {}) {
  return {
    appendOnly: packet.policy?.mutationPolicy === 'append_only',
    noPromptInjection: packet.policy?.promptInjectionRisk === 'blocked',
    evidenceNotAuthority: packet.learning?.eligibleForMaturation !== true || Boolean(packet.learning?.suggestedLane),
    noDirectActionConsumer: normalizeArray(packet.policy?.prohibitedConsumers).includes(CONSUMERS.TOOL_ACTION_EXECUTION)
  };
}

function responsibilityLeaseInvariants(packet = {}) {
  return {
    explicitObjective: Boolean(packet.objective),
    explicitRenewal: packet.lifecycle?.renewalPolicy === 'explicit_only',
    noContextInjection: normalizeArray(packet.consumers?.prohibited).includes(CONSUMERS.CONTEXT_INJECTION),
    ownerExecutorSeparated: Boolean(packet.owner) && Boolean(packet.executor)
  };
}

function readOnlyMaturationInvariants(packet = {}) {
  return {
    noMutation: packet.effects?.mutationAttempted !== true && packet.policy?.mutationPolicy === 'none',
    noPromptInjection: packet.effects?.promptInjectionEligibilityChanged !== true && packet.policy?.promptInjectionRisk === 'blocked',
    candidatesAreReviewOnly: packet.lifecycle?.status === 'candidate' && normalizeArray(packet.policy?.prohibitedConsumers).includes(CONSUMERS.CONTEXT_INJECTION),
    noApplyWithoutSeparateGate: packet.receipts?.appliedByEvent == null && packet.receipts?.rollbackRef == null
  };
}

function assertOutcomeEventPacket(packet = {}) {
  const invariants = outcomeEventInvariants(packet);
  const failed = Object.entries(invariants).filter(([, ok]) => ok !== true).map(([name]) => name);
  if (failed.length) throw new Error(`outcome_event violates invariants: ${failed.join(', ')}`);
  return true;
}

function assertResponsibilityLeasePacket(packet = {}) {
  const invariants = responsibilityLeaseInvariants(packet);
  const failed = Object.entries(invariants).filter(([, ok]) => ok !== true).map(([name]) => name);
  if (failed.length) throw new Error(`responsibility_lease violates invariants: ${failed.join(', ')}`);
  return true;
}

function assertReadOnlyMaturationPacket(packet = {}) {
  const invariants = readOnlyMaturationInvariants(packet);
  const failed = Object.entries(invariants).filter(([, ok]) => ok !== true).map(([name]) => name);
  if (failed.length) throw new Error(`maturation_candidate violates read-only invariants: ${failed.join(', ')}`);
  return true;
}

function packetLabels(packet = {}) {
  const policy = packet.policy || {};
  const lifecycle = packet.lifecycle || {};
  return {
    packetType: packet.packetType || 'unknown',
    lifecycle: lifecycle.status || packet.status || 'unknown',
    freshness: lifecycle.freshnessClass || 'unknown',
    consumers: `allowed: ${normalizeArray(policy.allowedConsumers || packet.consumers?.allowed).join(', ') || 'none'}; blocked: ${normalizeArray(policy.prohibitedConsumers || packet.consumers?.prohibited).join(', ') || 'none'}`,
    promptInjection: policy.promptInjectionRisk || 'unknown',
    mutation: policy.mutationPolicy || 'none'
  };
}

function maturationPacketLabels(packet = {}) {
  return packetLabels(packet);
}

function outcomePacketLabels(packet = {}) {
  return packetLabels(packet);
}

function statusFromEvolutionStatus(status) {
  if (status === 'failed') return 'failed';
  if (status === 'rollback_requested') return 'review_requested';
  if (status === 'rolled_back') return 'rolled_back';
  return 'observed';
}

function riskForReceipt(receipt = {}) {
  if (normalizeArray(receipt.sensitivityFlags).length > 0) return 'high';
  if (receipt.policyDecision === 'chris_review' || receipt.policyDecision === 'ellis_review') return 'medium';
  return 'low';
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item != null && item !== '').map(String);
  if (value == null || value === '') return [];
  return [String(value)];
}

function unique(items = []) {
  return [...new Set(normalizeArray(items))];
}

function sanitizeRecord(input) {
  if (input == null) return input;
  if (Array.isArray(input)) return input.map(sanitizeRecord);
  if (typeof input !== 'object') return typeof input === 'string' ? safe(input) : input;
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [safe(key), sanitizeRecord(value)]));
}

function pruneNullish(value) {
  if (Array.isArray(value)) return value.map(pruneNullish);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, pruneNullish(v)]));
}

function safe(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

module.exports = {
  PACKET_VERSION,
  PACKET_TYPES,
  CONSUMERS,
  GOVERNOR_MODES,
  CONTEXT_ELIGIBILITY_MODES,
  MATURATION_LANES,
  ACTION_CLASSES,
  createStateRecordPacket,
  createResponsibilityLeasePacket,
  createOutcomeEventPacket,
  createGovernorDecisionPacket,
  createContextEligibilityReview,
  classifyContextEligibility,
  createOutcomeEventPacketFromEvolutionEntry,
  createMaturationCandidatePacketFromAutonomyReceipt,
  createMaturationCandidatePacketFromOutcomeEvent,
  createMaturationCandidatePacketsFromOutcomeEvents,
  outcomeEventInvariants,
  responsibilityLeaseInvariants,
  governorDecisionInvariants,
  contextEligibilityInvariants,
  readOnlyMaturationInvariants,
  assertOutcomeEventPacket,
  assertResponsibilityLeasePacket,
  assertGovernorDecisionPacket,
  assertContextEligibilityReview,
  assertReadOnlyMaturationPacket,
  packetLabels,
  maturationPacketLabels,
  outcomePacketLabels
};
