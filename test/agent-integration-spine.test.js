const assert = require('node:assert/strict');
const test = require('node:test');

const {
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
  maturationPacketLabels,
  outcomePacketLabels
} = require('../lib/agent-integration-spine');

test('createStateRecordPacket wraps source lifecycle policy and receipts', () => {
  const packet = createStateRecordPacket({
    recordId: 'claim-1',
    recordType: 'maturation_candidate',
    agentScope: 'trail-guide',
    source: { sourceType: 'claim_source', sourceHandles: ['source:1'], evidenceClass: 'derived' },
    lifecycle: { status: 'candidate', freshnessClass: 'durable' },
    policy: {
      allowedConsumers: [CONSUMERS.UI_REVIEW],
      prohibitedConsumers: [CONSUMERS.CONTEXT_INJECTION],
      mutationPolicy: 'none'
    },
    receipts: { createdByEvent: 'dry-run' }
  });

  assert.equal(packet.packetType, PACKET_TYPES.STATE_RECORD);
  assert.equal(packet.recordIdentity.recordId, 'claim-1');
  assert.equal(packet.source.sourceHandles[0], 'source:1');
  assert.equal(packet.lifecycle.status, 'candidate');
  assert.deepEqual(packet.policy.prohibitedConsumers, [CONSUMERS.CONTEXT_INJECTION]);
  assert.equal(packet.receipts.createdByEvent, 'dry-run');
});

test('createResponsibilityLeasePacket records authority without self-activating context', () => {
  const packet = createResponsibilityLeasePacket({
    leaseId: 'lease-build-spine-phase-2',
    owner: 'Chris',
    executor: 'Ellis',
    objective: 'Build the read-only outcome ledger foundation.',
    status: 'active',
    authority: {
      sourceType: 'current_user',
      allowedActions: ['workspace-local code edits', 'tests'],
      prohibitedActions: ['runtime config changes', 'external messages'],
      approvalRequiredFor: ['scheduler linkage', 'context injection']
    },
    successCriteria: ['packet constructors exist', 'tests pass'],
    nonGoals: ['activate scheduler', 'enable apply path']
  });

  assert.equal(packet.packetType, PACKET_TYPES.RESPONSIBILITY_LEASE);
  assert.equal(packet.lifecycle.status, 'active');
  assert.equal(packet.lifecycle.renewalPolicy, 'explicit_only');
  assert.ok(packet.consumers.allowed.includes(CONSUMERS.PLANNING));
  assert.ok(packet.consumers.prohibited.includes(CONSUMERS.CONTEXT_INJECTION));
  assert.deepEqual(responsibilityLeaseInvariants(packet), {
    explicitObjective: true,
    explicitRenewal: true,
    noContextInjection: true,
    ownerExecutorSeparated: true
  });
  assert.equal(assertResponsibilityLeasePacket(packet), true);
});

test('createOutcomeEventPacket records evidence without granting authority', () => {
  const packet = createOutcomeEventPacket({
    eventId: 'outcome-1',
    eventType: 'test_run',
    status: 'verified',
    intent: { summary: 'Verify packet layer.' },
    authority: { authorizationMode: 'current task' },
    action: { command: 'node --test test/agent-integration-spine.test.js' },
    observed: { result: 'pass' },
    verification: { status: 'verified', method: 'node:test' },
    rollback: { available: true, plan: 'revert code diff' },
    learning: { eligibleForMaturation: false, prohibitionReason: 'single outcome only' }
  });

  assert.equal(packet.packetType, PACKET_TYPES.OUTCOME_EVENT);
  assert.equal(packet.status, 'verified');
  assert.equal(packet.policy.promptInjectionRisk, 'blocked');
  assert.equal(packet.policy.mutationPolicy, 'append_only');
  assert.ok(packet.policy.prohibitedConsumers.includes(CONSUMERS.TOOL_ACTION_EXECUTION));
  assert.deepEqual(outcomeEventInvariants(packet), {
    appendOnly: true,
    noPromptInjection: true,
    evidenceNotAuthority: true,
    noDirectActionConsumer: true
  });
  assert.equal(assertOutcomeEventPacket(packet), true);
});

test('createGovernorDecisionPacket proceeds with verification for local project edits without authorizing tools', () => {
  const packet = createGovernorDecisionPacket({
    decisionId: 'gov-local-edit-1',
    actionClass: ACTION_CLASSES.LOCAL_PROJECT_EDIT,
    requestedAction: { tool: 'edit', path: 'project/file.md' },
    authority: { hasCurrentInstruction: true, toolCapabilityPresent: true },
    risk: { externality: 'local', reversibility: 'reversible', sensitivity: 'low' }
  });

  assert.equal(packet.packetType, PACKET_TYPES.GOVERNOR_DECISION);
  assert.equal(packet.mode, GOVERNOR_MODES.PROCEED_WITH_VERIFICATION);
  assert.ok(packet.checks.required.includes('read_before_write'));
  assert.ok(packet.checks.required.includes('verify_after_write'));
  assert.equal(packet.rollback.required, true);
  assert.equal(packet.output.toolExecutionAuthorized, false);
  assert.equal(packet.output.mutationAuthorized, false);
  assert.equal(packet.output.promptInjectionAuthorized, false);
  assert.equal(packet.receipts.outcomeEventRequired, true);
  assert.deepEqual(governorDecisionInvariants(packet), {
    decisionOnly: true,
    noToolExecutionAuthority: true,
    noMutationAuthority: true,
    noPromptInjectionAuthority: true,
    toolCapabilityIsNotAuthority: true,
    selfStateCannotAuthorize: true
  });
  assert.equal(assertGovernorDecisionPacket(packet), true);
});

test('governor tool capability alone asks for missing authority', () => {
  const packet = createGovernorDecisionPacket({
    decisionId: 'gov-tool-only-1',
    actionClass: ACTION_CLASSES.LOCAL_PROJECT_EDIT,
    requestedAction: { tool: 'edit', path: 'project/file.md' },
    authority: { toolCapabilityPresent: true }
  });

  assert.equal(packet.mode, GOVERNOR_MODES.ASK_FOR_MISSING_AUTHORITY);
  assert.ok(packet.checks.missing.includes('current_task_or_active_lease_authority'));
  assert.ok(packet.reasonCodes.includes('missing_action_authority'));
  assert.equal(assertGovernorDecisionPacket(packet), true);
});

test('governor routes external messages to approval or missing authority', () => {
  const missing = createGovernorDecisionPacket({
    decisionId: 'gov-external-missing',
    actionClass: ACTION_CLASSES.EXTERNAL_MESSAGE,
    authority: { hasCurrentInstruction: true, toolCapabilityPresent: true }
  });
  assert.equal(missing.mode, GOVERNOR_MODES.ASK_FOR_MISSING_AUTHORITY);
  assert.equal(missing.approval.required, true);
  assert.ok(missing.checks.missing.includes('recipient_confirmed'));
  assert.ok(missing.checks.missing.includes('current_intent_confirmed'));

  const approvedShape = createGovernorDecisionPacket({
    decisionId: 'gov-external-approved-shape',
    actionClass: ACTION_CLASSES.EXTERNAL_MESSAGE,
    authority: {
      hasCurrentInstruction: true,
      toolCapabilityPresent: true,
      recipientConfirmed: true,
      intentConfirmed: true
    }
  });
  assert.equal(approvedShape.mode, GOVERNOR_MODES.REQUIRE_APPROVAL);
  assert.equal(approvedShape.approval.required, true);
  assert.equal(approvedShape.approval.reason, 'external_side_effect');
  assert.equal(approvedShape.output.toolExecutionAuthorized, false);
});

test('governor keeps behavior-shaping lanes dry-run or approval-gated', () => {
  const procedural = createGovernorDecisionPacket({
    decisionId: 'gov-procedural-1',
    actionClass: ACTION_CLASSES.PROCEDURAL_LEARNING,
    authority: { hasCurrentInstruction: true },
    risk: { behaviorShaping: true }
  });
  assert.equal(procedural.mode, GOVERNOR_MODES.DEFER_OR_DRY_RUN);
  assert.equal(procedural.approval.required, true);
  assert.ok(procedural.checks.required.includes('dry_run_review_packet'));
  assert.ok(procedural.checks.required.includes('lane_policy_check'));
  assert.equal(procedural.output.mutationAuthorized, false);

  const claim = createGovernorDecisionPacket({
    decisionId: 'gov-claim-1',
    actionClass: ACTION_CLASSES.CLAIM_MATURATION,
    authority: { hasCurrentInstruction: true }
  });
  assert.equal(claim.mode, GOVERNOR_MODES.DEFER_OR_DRY_RUN);
  assert.equal(claim.approval.required, false);
  assert.equal(claim.output.mutationAuthorized, false);
});

test('governor self-state can only increase friction, not authority', () => {
  const packet = createGovernorDecisionPacket({
    decisionId: 'gov-self-state-1',
    actionClass: ACTION_CLASSES.READ_ONLY_INVESTIGATION,
    authority: { hasCurrentInstruction: true },
    selfState: { anomaly: 'tool_provenance_conflict', coherenceRisk: 'high' }
  });

  assert.ok(packet.checks.required.includes('pause_or_verify_due_to_self_state'));
  assert.ok(packet.reasonCodes.includes('self_state_can_only_increase_friction'));
  assert.equal(packet.selfState.mayIncreaseFrictionOnly, true);
  assert.equal(packet.output.toolExecutionAuthorized, false);
  assert.equal(assertGovernorDecisionPacket(packet), true);
});

test('evolution ledger entries adapt into outcome_event packets', () => {
  const packet = createOutcomeEventPacketFromEvolutionEntry({
    id: 'evo-1',
    class: 'claim_review',
    title: 'Applied claim review decision',
    summary: 'Applied low-risk archive.',
    status: 'applied',
    risk: 'low',
    sourceCategory: 'claim review',
    allowedBy: 'autonomous_low_risk',
    expectedEffect: 'Safer memory posture.',
    verification: 'Receipt after-1 recorded.',
    rollback: 'Use rollback_review_decision.',
    action: 'apply_review_decision',
    claimId: 'claim-1',
    receiptId: 'after-1',
    rollbackAction: { receipt_id: 'before-1' },
    createdAt: '2026-05-09T00:00:00.000Z'
  });

  assert.equal(packet.packetType, PACKET_TYPES.OUTCOME_EVENT);
  assert.equal(packet.eventId, 'outcome:evo-1');
  assert.equal(packet.learning.eligibleForMaturation, false);
  assert.equal(packet.learning.prohibitionReason, 'ledger_receipt_is_evidence_not_authority');
  assert.equal(packet.rollback.available, true);
  assert.equal(assertOutcomeEventPacket(packet), true);
  const labels = outcomePacketLabels(packet);
  assert.equal(labels.packetType, 'outcome_event');
  assert.equal(labels.promptInjection, 'blocked');
  assert.equal(labels.mutation, 'append_only');
});

test('autonomy review receipts become read-only maturation_candidate packets', () => {
  const packet = createMaturationCandidatePacketFromAutonomyReceipt({
    claimId: 'claim-7',
    claimText: 'A generated synthesis should remain review-only.',
    sourceHandles: ['summary:1'],
    lane: 'hypothesis_synthesis',
    policyDecision: 'hold_as_hypothesis',
    reasonCodes: ['hypothesis_not_verified_fact'],
    sensitivityFlags: ['sensitive_user_claim'],
    scopeFlags: ['agent_or_runtime_scoped_claim'],
    eligibleForApply: false,
    eligibleForMinimalContext: false,
    mutationAttempted: false,
    promptInjectionEligibilityChanged: false,
    dryRun: true
  });

  assert.equal(packet.packetType, PACKET_TYPES.MATURATION_CANDIDATE);
  assert.equal(packet.candidateId, 'maturation-candidate:claim-7');
  assert.equal(packet.lifecycle.status, 'candidate');
  assert.equal(packet.policy.privacyTier, 'sensitive');
  assert.equal(packet.policy.promptInjectionRisk, 'blocked');
  assert.equal(packet.policy.mutationPolicy, 'none');
  assert.ok(packet.policy.allowedConsumers.includes(CONSUMERS.UI_REVIEW));
  assert.ok(packet.policy.prohibitedConsumers.includes(CONSUMERS.CONTEXT_INJECTION));
  assert.equal(packet.effects.dryRun, true);
  assert.equal(packet.effects.eligibleForApply, false);
  assert.deepEqual(readOnlyMaturationInvariants(packet), {
    noMutation: true,
    noPromptInjection: true,
    candidatesAreReviewOnly: true,
    noApplyWithoutSeparateGate: true
  });
  assert.equal(assertReadOnlyMaturationPacket(packet), true);
});


test('eligible outcome events become dry-run maturation candidates without apply authority', () => {
  const outcome = createOutcomeEventPacket({
    eventId: 'outcome-learning-1',
    eventType: 'verified_file_edit',
    status: 'verified',
    observed: { status: 'pass' },
    verification: { status: 'verified', method: 'node:test' },
    learning: { eligibleForMaturation: true, suggestedLane: MATURATION_LANES.PROCEDURAL_LEARNING }
  });

  const packet = createMaturationCandidatePacketFromOutcomeEvent(outcome);

  assert.equal(packet.packetType, PACKET_TYPES.MATURATION_CANDIDATE);
  assert.equal(packet.recordRef.type, PACKET_TYPES.OUTCOME_EVENT);
  assert.equal(packet.recordRef.id, 'outcome-learning-1');
  assert.equal(packet.lane, MATURATION_LANES.PROCEDURAL_LEARNING);
  assert.equal(packet.lifecycle.status, 'candidate');
  assert.equal(packet.effects.dryRun, true);
  assert.equal(packet.effects.eligibleForApply, false);
  assert.equal(packet.policy.approvalRequired, true);
  assert.ok(packet.policy.prohibitedConsumers.includes(CONSUMERS.CONTEXT_INJECTION));
  assert.ok(packet.policy.prohibitedConsumers.includes(CONSUMERS.TOOL_ACTION_EXECUTION));
  assert.ok(packet.review.requiredChecks.includes('test_plan'));
  assert.deepEqual(readOnlyMaturationInvariants(packet), {
    noMutation: true,
    noPromptInjection: true,
    candidatesAreReviewOnly: true,
    noApplyWithoutSeparateGate: true
  });
  assert.equal(assertReadOnlyMaturationPacket(packet), true);
});

test('maturation router ignores ineligible outcomes and keeps unknown lanes diagnostic-only', () => {
  const ineligible = createOutcomeEventPacket({
    eventId: 'outcome-no-learning',
    status: 'verified',
    learning: { eligibleForMaturation: false, prohibitionReason: 'single observation' }
  });
  const eligibleUnknownLane = createOutcomeEventPacket({
    eventId: 'outcome-unknown-lane',
    status: 'verified',
    learning: { eligibleForMaturation: true, suggestedLane: 'self_authorized_power_expansion' }
  });

  const candidates = createMaturationCandidatePacketsFromOutcomeEvents([ineligible, eligibleUnknownLane]);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].recordRef.id, 'outcome-unknown-lane');
  assert.equal(candidates[0].lane, MATURATION_LANES.DIAGNOSTICS_ONLY);
  assert.equal(candidates[0].policy.mutationPolicy, 'none');
  assert.equal(candidates[0].policy.promptInjectionRisk, 'blocked');
  assert.throws(() => createMaturationCandidatePacketFromOutcomeEvent(ineligible), /not eligible/);
});

test('context eligibility review blocks current spine packets from prompt injection', () => {
  const candidate = createMaturationCandidatePacketFromAutonomyReceipt({
    claimId: 'claim-context-blocked',
    lane: 'hypothesis_synthesis',
    policyDecision: 'hold_as_hypothesis',
    eligibleForMinimalContext: true
  });
  const review = createContextEligibilityReview({
    reviewId: 'ctx-review-candidate-1',
    packet: candidate,
    authority: { hasExplicitContextApproval: true }
  });

  assert.equal(review.packetType, 'context_eligibility_review');
  assert.equal(review.mode, CONTEXT_ELIGIBILITY_MODES.BLOCKED);
  assert.ok(review.reasonCodes.includes('packet_policy_blocks_context_injection'));
  assert.ok(review.reasonCodes.includes('only_state_records_can_be_context_candidates'));
  assert.equal(review.output.contextInjectionAuthorized, false);
  assert.deepEqual(contextEligibilityInvariants(review), {
    reviewOnly: true,
    noContextInjectionAuthority: true,
    noPromptMutationAuthority: true,
    noMemoryPromotionAuthority: true,
    noDirectContextConsumer: true
  });
  assert.equal(assertContextEligibilityReview(review), true);
});

test('context eligibility can identify minimal candidates without authorizing injection', () => {
  const state = createStateRecordPacket({
    recordId: 'state-context-1',
    recordType: 'stable_project_fact',
    source: { sourceType: 'verified_test', sourceHandle: 'test:state-context-1', evidenceClass: 'verified' },
    lifecycle: { status: 'active', freshnessClass: 'durable' },
    policy: {
      allowedConsumers: [CONSUMERS.UI_REVIEW, CONSUMERS.CONTEXT_INJECTION],
      prohibitedConsumers: [],
      promptInjectionRisk: 'minimal',
      mutationPolicy: 'none'
    }
  });

  const review = createContextEligibilityReview({
    reviewId: 'ctx-review-state-1',
    packet: state,
    authority: { hasExplicitContextApproval: true }
  });
  assert.equal(review.mode, CONTEXT_ELIGIBILITY_MODES.ELIGIBLE_MINIMAL);
  assert.ok(review.reasonCodes.includes('explicitly_scoped_minimal_context_candidate'));
  assert.equal(review.output.contextInjectionAuthorized, false);
  assert.equal(review.output.promptMutationAuthorized, false);
  assert.equal(assertContextEligibilityReview(review), true);
});

test('context eligibility keeps generated or sensitive material blocked', () => {
  const generated = createStateRecordPacket({
    recordId: 'state-generated-1',
    recordType: 'summary_claim',
    source: { sourceType: 'summary', evidenceClass: 'generated_summary' },
    lifecycle: { status: 'active' },
    policy: {
      allowedConsumers: [CONSUMERS.CONTEXT_INJECTION],
      promptInjectionRisk: 'minimal',
      privacyTier: 'sensitive'
    }
  });

  const classification = classifyContextEligibility({
    packet: generated,
    authority: { hasExplicitContextApproval: true },
    risk: { sensitivity: 'high' }
  });
  assert.equal(classification.mode, CONTEXT_ELIGIBILITY_MODES.BLOCKED);
  assert.ok(classification.reasonCodes.includes('source_not_strong_enough_for_context'));
  assert.ok(classification.reasonCodes.includes('sensitive_material_context_blocked'));
});

test('read-only invariant catches mutation or prompt-injection drift', () => {
  const packet = createMaturationCandidatePacketFromAutonomyReceipt({ claimId: 'claim-8', lane: 'project_factual', policyDecision: 'auto_accept' });
  packet.effects.mutationAttempted = true;
  assert.throws(() => assertReadOnlyMaturationPacket(packet), /noMutation/);

  packet.effects.mutationAttempted = false;
  packet.policy.promptInjectionRisk = 'low';
  assert.throws(() => assertReadOnlyMaturationPacket(packet), /noPromptInjection/);
});

test('maturationPacketLabels exposes source/status/freshness/consumer posture for UI', () => {
  const packet = createMaturationCandidatePacketFromAutonomyReceipt({ claimId: 'claim-9', lane: 'reject_or_archive', policyDecision: 'archive_open_question' });
  const labels = maturationPacketLabels(packet);
  assert.equal(labels.packetType, 'maturation_candidate');
  assert.equal(labels.lifecycle, 'candidate');
  assert.equal(labels.freshness, 'durable');
  assert.match(labels.consumers, /ui_review/);
  assert.match(labels.consumers, /context_injection/);
  assert.equal(labels.promptInjection, 'blocked');
  assert.equal(labels.mutation, 'none');
});
