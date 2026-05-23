const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  PROTECTED_EVOLUTION_ACTION_LANES,
  createEvolutionActionGateReceipt,
  recordEvolutionActionGateReceipt,
  validateEvolutionAction,
  validateHighRiskApprovalBinding,
  validateHighRiskPacketApprovalBinding,
  validateHighRiskApprovalReceiptBinding,
  validateHighRiskApprovedApplyBinding
} = require('../lib/evolution-action-gate');
const { readSpineLedger } = require('../lib/spine-ledger');

function tmpLedger() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-action-gate-')), 'ledger.json');
}

function lowRiskCandidate(overrides = {}) {
  return {
    id: 'candidate-low-1',
    action: 'autonomy_review_dry_run',
    risk: 'low',
    sourceCategory: 'reject_or_archive',
    claimId: 'claim-1',
    metadata: {
      policyDecision: 'archive_open_question',
      mutationAttempted: false,
      promptInjectionEligibilityChanged: false,
      lane: 'reject_or_archive'
    },
    ...overrides,
    metadata: {
      policyDecision: 'archive_open_question',
      mutationAttempted: false,
      promptInjectionEligibilityChanged: false,
      lane: 'reject_or_archive',
      ...(overrides.metadata || {})
    }
  };
}

test('protected Evolve actions are refused before handler execution', () => {
  assert.equal(PROTECTED_EVOLUTION_ACTION_LANES.enable_prompt_injection, 'prompt_injection');
  const gate = createEvolutionActionGateReceipt({
    id: 'candidate-1',
    action: 'enable_prompt_injection',
    now: '2026-05-09T17:00:00.000Z'
  });
  assert.equal(gate.allowed, false);
  assert.equal(gate.blocked, true);
  assert.ok(gate.blockers.includes('protected_authority_lane_not_enabled'));
  assert.equal(gate.governorDecision.output.promptInjectionAuthorized, false);
  assert.equal(gate.governorDecision.output.schedulerAuthorized, false);
  assert.equal(gate.governorDecision.output.mutationAuthorized, false);
  assert.equal(gate.outcomeEvent.verification.evidence.promptInjectionAuthorized, false);
  assert.equal(gate.riskClassification.blocked, true);
  assert.ok(gate.riskClassification.reasonCodes.includes('prompt_injection_or_context_expansion'));
  assert.equal(gate.outcomeEvent.verification.evidence.riskDecision, 'blocked');
  assert.ok(gate.governorDecision.reasonCodes.includes('prompt_injection_or_context_expansion'));
});

test('low-risk apply candidate passes pre-action gate but still requires domain gate', () => {
  const gate = createEvolutionActionGateReceipt({
    id: 'candidate-low-1',
    action: 'apply_low_risk_candidate',
    entry: lowRiskCandidate(),
    now: '2026-05-09T17:01:00.000Z'
  });
  assert.equal(gate.allowed, true);
  assert.equal(gate.governorDecision.mode, 'proceed_with_verification');
  assert.equal(gate.outcomeEvent.authority.authorizationMode, 'preflight_passed_existing_domain_gate_required');
  assert.equal(gate.outcomeEvent.verification.evidence.mutationAuthorized, false);
  assert.match(gate.outcomeEvent.intent.expectedEffect, /existing single-claim low-risk apply lane/);
  assert.equal(gate.riskClassification.autonomousAllowed, true);
  assert.equal(gate.outcomeEvent.verification.evidence.riskDecision, 'audit_only_autonomous');
  assert.ok(gate.governorDecision.reasonCodes.includes('bounded_low_risk_reversible_lane'));
});


test('deny proposal passes as review-only action without mutation authority', () => {
  const gate = createEvolutionActionGateReceipt({
    id: 'candidate-low-1',
    action: 'deny_proposal',
    entry: lowRiskCandidate(),
    now: '2026-05-10T20:15:00.000Z'
  });
  assert.equal(gate.allowed, true);
  assert.equal(gate.outcomeEvent.action.effect, 'evolution_review_status_update');
  assert.equal(gate.outcomeEvent.verification.evidence.mutationAuthorized, false);
  assert.match(gate.outcomeEvent.intent.expectedEffect, /Update the Evolve review receipt status only/);
});

test('low-risk scaffold proposal promotion passes pre-action gate with rollback required', () => {
  const proposal = {
    id: 'code-evolution-proposal-exec',
    action: 'scaffold_proposal',
    status: 'preview',
    risk: 'low',
    class: 'process_ui_friction',
    sourceCategory: 'code-evolution scaffold proposal',
    metadata: {
      changeType: 'tool_hint',
      target: 'exec',
      mutationAttempted: 'false',
      promptInjectionChanged: 'false'
    }
  };
  const gate = createEvolutionActionGateReceipt({
    id: proposal.id,
    action: 'apply_scaffold_proposal',
    entry: proposal,
    now: '2026-05-21T18:00:00.000Z'
  });
  assert.equal(gate.allowed, true);
  assert.equal(gate.outcomeEvent.action.effect, 'code_evolution_scaffold_promotion_lane');
  assert.match(gate.outcomeEvent.intent.expectedEffect, /Promote one low-risk Code Evolution or Harness Refiner scaffold proposal/);
  assert.match(gate.governorDecision.rollback.plan, /Snapshot evolved scaffold files/);
  assert.deepEqual(validateEvolutionAction({ action: 'apply_scaffold_proposal', entry: { ...proposal, risk: 'high' } }), [
    'scaffold_apply_requires_low_risk'
  ]);
});

test('low-risk Harness Refiner workflow/tool-hint proposals can use scaffold promotion gate', () => {
  const proposal = {
    id: 'harness-refiner-proposal-tool-loop',
    action: 'harness_refinement_proposal',
    status: 'preview',
    risk: 'low',
    class: 'process_ui_friction',
    sourceCategory: 'harness-refiner proposal',
    metadata: {
      lane: 'workflow_patch',
      targetSurface: 'tool-loop:exec',
      applyPath: 'existing_scaffold_gate',
      mutationAttempted: 'false',
      promptInjectionChanged: 'false',
      launchTraining: false,
      adapterPromotion: false,
      modelRoutingMutation: false,
      gatewayInvocation: false
    }
  };
  const gate = createEvolutionActionGateReceipt({
    id: proposal.id,
    action: 'apply_scaffold_proposal',
    entry: proposal,
    now: '2026-05-22T18:00:00.000Z'
  });
  assert.equal(gate.allowed, true);
  assert.equal(gate.outcomeEvent.action.effect, 'code_evolution_scaffold_promotion_lane');
  assert.match(gate.outcomeEvent.intent.expectedEffect, /Harness Refiner scaffold proposal/);
  assert.deepEqual(validateEvolutionAction({
    action: 'apply_scaffold_proposal',
    entry: { ...proposal, metadata: { ...proposal.metadata, lane: 'mode_patch', applyPath: 'review_only' } }
  }), [
    'scaffold_apply_requires_supported_change_type',
    'scaffold_apply_requires_harness_workflow_or_tool_hint_lane',
    'scaffold_apply_requires_existing_scaffold_gate'
  ]);
  assert.deepEqual(validateEvolutionAction({
    action: 'apply_scaffold_proposal',
    entry: { ...proposal, metadata: { ...proposal.metadata, gatewayInvocation: 'true' } }
  }), [
    'scaffold_apply_refuses_harness_protected_mutation_flags'
  ]);
});

test('scaffold promotion rollback requires applied receipt and snapshot', () => {
  const promotion = {
    id: 'scaffold-promotion-code-evolution-proposal-exec',
    action: 'apply_scaffold_proposal',
    status: 'applied',
    risk: 'low',
    metadata: { snapshotId: 'snapshot-1' },
    rollbackAction: { action: 'rollback_scaffold_promotion', snapshot_id: 'snapshot-1' }
  };
  const gate = createEvolutionActionGateReceipt({
    id: promotion.id,
    action: 'rollback_scaffold_promotion',
    entry: promotion,
    now: '2026-05-21T18:05:00.000Z'
  });
  assert.equal(gate.allowed, true);
  assert.match(gate.outcomeEvent.intent.expectedEffect, /Restore the scaffold snapshot/);
  assert.deepEqual(validateEvolutionAction({ action: 'rollback_scaffold_promotion', entry: { ...promotion, rollbackAction: {} } }), [
    'scaffold_rollback_requires_scaffold_rollback_action'
  ]);
});

test('high-risk approval packet preparation passes only for bound approval candidates', () => {
  const highRiskCandidate = lowRiskCandidate({
    id: 'candidate-sensitive-1',
    risk: 'high',
    sourceCategory: 'hypothesis_synthesis',
    metadata: {
      policyDecision: 'hold_as_hypothesis',
      lane: 'hypothesis_synthesis',
      highRiskProtocol: {
        protocol: 'high_risk_candidate',
        posture: 'approval_required',
        candidateId: 'candidate-sensitive-1',
        actionId: 'high_risk_review_apply',
        effectClass: 'claim_maturation',
        targetRefs: { display: 'claim claim-sensitive-1', internal: 'claim-sensitive-1' },
        expiry: 'recheck required immediately before apply',
        requiredVerification: ['before_receipt', 'after_receipt'],
        rollbackPlan: 'domain-specific rollback receipt required before apply'
      }
    }
  });
  const gate = createEvolutionActionGateReceipt({
    id: 'candidate-sensitive-1',
    action: 'prepare_high_risk_approval_packet',
    entry: highRiskCandidate,
    now: '2026-05-09T17:01:30.000Z'
  });
  assert.equal(gate.allowed, true);
  assert.equal(gate.outcomeEvent.verification.evidence.mutationAuthorized, false);
  assert.match(gate.outcomeEvent.intent.expectedEffect, /no apply authority/);
  assert.deepEqual(
    validateEvolutionAction({ action: 'prepare_high_risk_approval_packet', entry: lowRiskCandidate() }),
    ['high_risk_review_requires_high_risk_candidate', 'high_risk_review_requires_high_risk_protocol', 'high_risk_review_requires_approval_required_posture']
  );
});


test('high-risk preflight passes as no-mutation review work only for bound approval candidates', () => {
  const highRiskCandidate = lowRiskCandidate({
    id: 'candidate-sensitive-2',
    risk: 'high',
    sourceCategory: 'hypothesis_synthesis',
    metadata: {
      policyDecision: 'hold_as_hypothesis',
      lane: 'hypothesis_synthesis',
      highRiskProtocol: {
        protocol: 'high_risk_candidate',
        posture: 'approval_required',
        candidateId: 'candidate-sensitive-2',
        actionId: 'high_risk_review_apply',
        effectClass: 'claim_maturation',
        targetRefs: { display: 'claim claim-sensitive-2', internal: 'claim-sensitive-2' },
        expiry: 'recheck required immediately before apply',
        requiredVerification: ['before_receipt', 'after_receipt'],
        rollbackPlan: 'domain-specific rollback receipt required before apply'
      }
    }
  });
  const gate = createEvolutionActionGateReceipt({
    id: 'candidate-sensitive-2',
    action: 'run_high_risk_preflight',
    entry: highRiskCandidate,
    now: '2026-05-09T17:01:45.000Z'
  });
  assert.equal(gate.allowed, true);
  assert.equal(gate.outcomeEvent.verification.evidence.mutationAuthorized, false);
  assert.match(gate.outcomeEvent.intent.expectedEffect, /side-effect-free high-risk preflight/);
  assert.deepEqual(
    validateEvolutionAction({ action: 'run_high_risk_preflight', entry: lowRiskCandidate() }),
    ['high_risk_review_requires_high_risk_candidate', 'high_risk_review_requires_high_risk_protocol', 'high_risk_review_requires_approval_required_posture']
  );
});


test('explicit high-risk approval capture passes only for one bound packet receipt without apply authority', () => {
  const packetEntry = {
    id: 'evo-packet-1',
    action: 'high_risk_approval_packet',
    risk: 'high',
    status: 'held',
    claimId: 'claim-sensitive-1',
    metadata: {
      approvalPacket: {
        packetId: 'packet-1',
        protocol: 'high_risk_candidate',
        approvalStatus: 'pending_explicit_approval',
        candidateId: 'candidate-sensitive-1',
        actionId: 'high_risk_review_apply',
        effectClass: 'claim_maturation',
        targetRefs: { display: 'claim claim-sensitive-1', internal: 'claim-sensitive-1' },
        expiry: 'recheck required immediately before apply',
        requiredVerification: ['before_receipt', 'after_receipt'],
        rollbackPlan: 'domain-specific rollback receipt required before apply',
        applyAuthorityGranted: false
      }
    }
  };
  const gate = createEvolutionActionGateReceipt({
    id: 'evo-packet-1',
    action: 'record_high_risk_explicit_approval',
    entry: packetEntry,
    now: '2026-05-09T17:01:50.000Z'
  });
  assert.equal(gate.allowed, true);
  assert.equal(gate.outcomeEvent.verification.evidence.mutationAuthorized, false);
  assert.match(gate.outcomeEvent.intent.expectedEffect, /no apply handler/);
  assert.deepEqual(validateHighRiskPacketApprovalBinding({ packet: packetEntry.metadata.approvalPacket }), []);

  const stalePacket = JSON.parse(JSON.stringify(packetEntry));
  stalePacket.metadata.approvalPacket.approvalStatus = 'explicitly_approved_no_apply';
  assert.deepEqual(
    validateEvolutionAction({ action: 'record_high_risk_explicit_approval', entry: stalePacket }),
    ['explicit_approval_requires_pending_packet']
  );

  const missing = JSON.parse(JSON.stringify(packetEntry));
  missing.metadata.approvalPacket.packetId = '';
  missing.metadata.approvalPacket.targetRefs = {};
  assert.deepEqual(validateHighRiskPacketApprovalBinding({ packet: missing.metadata.approvalPacket }), [
    'explicit_approval_packet_id_missing',
    'explicit_approval_target_refs_missing'
  ]);
});


test('pre-action recheck gate accepts only explicit high-risk approval receipts without apply authority', () => {
  const approvalEntry = {
    id: 'evo-approval-1',
    action: 'high_risk_explicit_approval',
    risk: 'high',
    status: 'held',
    claimId: 'claim-sensitive-1',
    metadata: {
      approvalStatus: 'explicitly_approved_no_apply',
      applyAuthorityGranted: false,
      approvalBinding: {
        packetId: 'packet-1',
        candidateId: 'candidate-sensitive-1',
        actionId: 'high_risk_review_apply',
        effectClass: 'claim_maturation',
        targetRefs: { display: 'claim claim-sensitive-1', internal: 'claim-sensitive-1' },
        expiry: 'recheck required immediately before apply',
        requiredVerification: ['before_receipt', 'after_receipt'],
        rollbackPlan: 'domain-specific rollback receipt required before apply'
      }
    }
  };
  const gate = createEvolutionActionGateReceipt({
    id: approvalEntry.id,
    action: 'run_high_risk_pre_action_recheck',
    entry: approvalEntry,
    now: '2026-05-09T17:02:50.000Z'
  });
  assert.equal(gate.allowed, true);
  assert.equal(gate.outcomeEvent.verification.evidence.mutationAuthorized, false);
  assert.match(gate.outcomeEvent.intent.expectedEffect, /without executing apply/);
  assert.deepEqual(validateHighRiskApprovalReceiptBinding({ binding: approvalEntry.metadata.approvalBinding }), []);

  const authorityLeak = JSON.parse(JSON.stringify(approvalEntry));
  authorityLeak.metadata.applyAuthorityGranted = 'true';
  assert.deepEqual(
    validateEvolutionAction({ action: 'run_high_risk_pre_action_recheck', entry: authorityLeak }),
    ['pre_action_recheck_refuses_apply_authority']
  );

  const stale = JSON.parse(JSON.stringify(approvalEntry));
  stale.metadata.approvalStatus = 'rechecked_no_apply';
  assert.deepEqual(
    validateEvolutionAction({ action: 'run_high_risk_pre_action_recheck', entry: stale }),
    ['pre_action_recheck_requires_captured_approval']
  );

  const missing = JSON.parse(JSON.stringify(approvalEntry));
  missing.metadata.approvalBinding.actionId = '';
  missing.metadata.approvalBinding.targetRefs = {};
  assert.deepEqual(validateHighRiskApprovalReceiptBinding({ binding: missing.metadata.approvalBinding }), [
    'pre_action_recheck_action_binding_missing',
    'pre_action_recheck_target_refs_missing'
  ]);
});

test('approved high-risk claim maturation apply passes only from successful recheck receipt', () => {
  const recheckEntry = {
    id: 'evo-recheck-apply-1',
    action: 'high_risk_pre_action_recheck',
    risk: 'high',
    status: 'held',
    claimId: 'claim-sensitive-apply',
    metadata: {
      approvalStatus: 'rechecked_no_apply',
      recheckOutcome: 'current approval still gated',
      applyAuthorityGranted: false,
      mutationAttempted: false,
      approvedForApply: false,
      approvedBinding: {
        packetId: 'packet-apply-1',
        candidateId: 'candidate-sensitive-apply',
        actionId: 'high_risk_review_apply',
        claimId: 'claim-sensitive-apply',
        effectClass: 'claim_maturation',
        targetRefs: { display: 'claim claim-sensitive-apply', internal: 'claim-sensitive-apply' },
        expiry: 'recheck required immediately before apply',
        requiredVerification: ['before_receipt', 'after_receipt', 'claim_status_readback'],
        rollbackPlan: 'domain-specific rollback receipt required before apply'
      }
    }
  };
  const gate = createEvolutionActionGateReceipt({
    id: recheckEntry.id,
    action: 'apply_high_risk_claim_maturation',
    entry: recheckEntry,
    now: '2026-05-09T17:03:30.000Z'
  });
  assert.equal(gate.allowed, true);
  assert.equal(gate.outcomeEvent.verification.evidence.mutationAuthorized, false);
  assert.match(gate.outcomeEvent.intent.expectedEffect, /explicitly approved and immediately rechecked/);
  assert.deepEqual(validateHighRiskApprovedApplyBinding({ binding: recheckEntry.metadata.approvedBinding }), []);

  const stale = JSON.parse(JSON.stringify(recheckEntry));
  stale.metadata.recheckOutcome = 'approval invalidated by recheck';
  assert.deepEqual(validateEvolutionAction({ action: 'apply_high_risk_claim_maturation', entry: stale }), [
    'high_risk_apply_requires_current_approval_still_gated'
  ]);

  const wrongEffect = JSON.parse(JSON.stringify(recheckEntry));
  wrongEffect.metadata.approvedBinding.effectClass = 'broad_memory_promotion';
  assert.deepEqual(validateEvolutionAction({ action: 'apply_high_risk_claim_maturation', entry: wrongEffect }), [
    'high_risk_apply_requires_claim_maturation_effect'
  ]);

  const missing = JSON.parse(JSON.stringify(recheckEntry));
  missing.metadata.approvedBinding.claimId = '';
  missing.metadata.approvedBinding.targetRefs = {};
  assert.deepEqual(validateHighRiskApprovedApplyBinding({ binding: missing.metadata.approvedBinding }), [
    'high_risk_apply_claim_binding_missing',
    'high_risk_apply_target_refs_missing'
  ]);
});

test('simplified high-risk approve-and-apply action gates only claim maturation candidates', () => {
  const highRiskCandidate = lowRiskCandidate({
    id: 'candidate-ready-apply',
    risk: 'high',
    sourceCategory: 'hypothesis_synthesis',
    metadata: {
      policyDecision: 'hold_as_hypothesis',
      lane: 'hypothesis_synthesis',
      highRiskProtocol: {
        protocol: 'high_risk_candidate',
        posture: 'approval_required',
        candidateId: 'candidate-ready-apply',
        actionId: 'high_risk_review_apply',
        effectClass: 'claim_maturation',
        targetRefs: { display: 'claim claim-ready-apply', internal: 'claim-ready-apply' },
        expiry: 'recheck required immediately before apply',
        requiredVerification: ['before_receipt', 'after_receipt'],
        rollbackPlan: 'domain-specific rollback receipt required before apply'
      }
    }
  });
  const gate = createEvolutionActionGateReceipt({
    id: highRiskCandidate.id,
    action: 'approve_and_apply_if_still_safe',
    entry: highRiskCandidate,
    now: '2026-05-10T18:00:00.000Z'
  });
  assert.equal(gate.allowed, true);
  assert.match(gate.outcomeEvent.intent.expectedEffect, /packet, explicit approval, immediate recheck/);
  assert.equal(gate.outcomeEvent.verification.evidence.mutationAuthorized, false);

  const protectedLane = JSON.parse(JSON.stringify(highRiskCandidate));
  protectedLane.metadata.highRiskProtocol.effectClass = 'broad_memory_promotion';
  assert.deepEqual(validateEvolutionAction({ action: 'approve_and_apply_if_still_safe', entry: protectedLane }), [
    'simplified_apply_requires_claim_maturation_effect',
    'simplified_apply_excludes_protected_lane'
  ]);

  const promptLane = JSON.parse(JSON.stringify(highRiskCandidate));
  promptLane.metadata.lane = 'prompt_injection';
  assert.deepEqual(validateEvolutionAction({ action: 'approve_and_apply_if_still_safe', entry: promptLane }), [
    'simplified_apply_excludes_protected_lane'
  ]);
});

test('high-risk approval binding requires exact candidate action target effect expiry verification and rollback terms', () => {
  const bound = lowRiskCandidate({
    id: 'candidate-bound-1',
    risk: 'high',
    metadata: {
      highRiskProtocol: {
        candidateId: 'candidate-bound-1',
        actionId: 'high_risk_review_apply',
        effectClass: 'claim_maturation',
        targetRefs: { display: 'claim claim-bound-1', internal: 'claim-bound-1' },
        expiry: 'recheck required immediately before apply',
        requiredVerification: ['before_receipt', 'after_receipt'],
        rollbackPlan: 'domain-specific rollback receipt required before apply'
      }
    }
  });
  assert.deepEqual(validateHighRiskApprovalBinding({ entry: bound, protocol: bound.metadata.highRiskProtocol }), []);

  const incomplete = lowRiskCandidate({
    id: 'candidate-bound-1',
    risk: 'high',
    metadata: {
      highRiskProtocol: {
        candidateId: 'candidate-other',
        actionId: '',
        effectClass: '',
        targetRefs: {},
        expiry: '',
        requiredVerification: [],
        rollbackPlan: ''
      }
    }
  });
  assert.deepEqual(validateHighRiskApprovalBinding({ entry: incomplete, protocol: incomplete.metadata.highRiskProtocol }), [
    'approval_packet_candidate_binding_missing',
    'approval_packet_action_binding_missing',
    'approval_packet_effect_class_missing',
    'approval_packet_target_refs_missing',
    'approval_packet_expiry_missing',
    'approval_packet_verification_plan_missing',
    'approval_packet_rollback_plan_missing'
  ]);
});

test('unsafe or unsupported Evolve actions are blocked before mutation handlers', () => {
  assert.deepEqual(validateEvolutionAction({ action: 'apply_low_risk_candidate', entry: lowRiskCandidate({ risk: 'high' }) }), ['apply_requires_low_risk_candidate']);
  const unknown = createEvolutionActionGateReceipt({
    id: 'candidate-unknown',
    action: 'invent_new_mutation',
    entry: lowRiskCandidate(),
    now: '2026-05-09T17:02:00.000Z'
  });
  assert.equal(unknown.allowed, false);
  assert.ok(unknown.blockers.includes('unsupported_evolution_action'));
  assert.equal(unknown.outcomeEvent.status, 'blocked');
  assert.equal(unknown.outcomeEvent.observed.status, 'blocked_before_handler');
});

test('blocked pre-action gates persist governor and outcome receipts for Evolve review', () => {
  const ledgerPath = tmpLedger();
  const gate = createEvolutionActionGateReceipt({
    id: 'candidate-blocked',
    action: 'broad_memory_promotion',
    now: '2026-05-09T17:03:00.000Z'
  });
  recordEvolutionActionGateReceipt(ledgerPath, gate);
  const ledger = readSpineLedger(ledgerPath);
  assert.equal(ledger.governorDecisions.length, 1);
  assert.equal(ledger.outcomeEvents.length, 1);
  assert.equal(ledger.outcomeEvents[0].eventType, 'shadow_enforcement_observed');
  assert.equal(ledger.outcomeEvents[0].verification.evidence.mutationAuthorized, false);
});
