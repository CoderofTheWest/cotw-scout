const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  appendEvolutionEvent,
  applyEvolutionEventTransition,
  buildClaimReviewEvent,
  candidateEvolutionLedgerPaths,
  listEvolutionEvents,
  readEvolutionLedger,
  recordClaimReviewEvolution,
  recordCandidateReviewEvolution,
  recordHighRiskApprovalPacket,
  recordHighRiskPreflight,
  recordHighRiskExplicitApproval,
  recordHighRiskPreActionRecheck,
  recordHighRiskClaimMaturationApply,
  assessHighRiskPreActionRecheck,
  resolveEvolutionLedgerPath,
  updateEvolutionEvent,
  assertAutonomousWriteSafety
} = require('../lib/evolution-ledger');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-ledger-'));
}

test('resolves workspace and plugin ledger paths', () => {
  const root = tmpDir();
  assert.equal(resolveEvolutionLedgerPath({ workspacePath: root }), path.join(root, 'evolution', 'ledger.json'));
  assert.equal(
    resolveEvolutionLedgerPath({ pluginDataDir: path.join(root, 'data'), agentId: 'trail-guide' }),
    path.join(root, 'data', 'agents', 'trail-guide', 'evolution-ledger.json')
  );
  const paths = candidateEvolutionLedgerPaths({ workspacePath: root, pluginsPath: path.join(root, 'bundled-plugins') });
  assert.ok(paths.some((candidate) => candidate.endsWith(path.join('evolution', 'ledger.json'))));
  assert.ok(paths.some((candidate) => candidate.endsWith(path.join('agents', 'trail-guide', 'evolution-ledger.json'))));
});

test('append/list sanitizes and groups safe GUI entry fields', () => {
  const ledgerPath = path.join(tmpDir(), 'ledger.json');
  appendEvolutionEvent(ledgerPath, {
    id: 'unsafe-token',
    class: 'claim_review',
    title: 'Claim review /Users/chris/secret/file',
    summary: 'Changed token abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
    risk: 'low',
    status: 'applied',
    sourceCategory: 'unit test',
    allowedBy: 'policy',
    expectedEffect: 'safer memory',
    verification: 'receipt',
    rollback: 'rollback_review_decision',
    createdAt: '2026-05-07T10:00:00.000Z'
  });
  const entries = listEvolutionEvents(ledgerPath);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].class, 'claim_review');
  assert.equal(entries[0].metadata.spineOutcomePacket.packetType, 'outcome_event');
  assert.equal(entries[0].metadata.spineOutcomePacket.policy.promptInjectionRisk, 'blocked');
  assert.equal(entries[0].metadata.spineOutcomePacket.policy.mutationPolicy, 'append_only');
  assert.equal(entries[0].metadata.spineOutcomeLabels.packetType, 'outcome_event');
  assert.match(entries[0].title, /\[redacted-path\]/);
  assert.match(entries[0].summary, /\[redacted-token\]/);
  assert.doesNotMatch(JSON.stringify(entries[0]), /Users\/chris/);
});

test('records autonomous claim review apply and exposes rollback action', () => {
  const ledgerPath = path.join(tmpDir(), 'ledger.json');
  const event = recordClaimReviewEvolution({
    ok: true,
    mutationAttempted: true,
    action: 'apply_review_decision',
    claimId: 'claim-123',
    decision: 'archive_open_question',
    beforeStatus: 'verify_required',
    afterStatus: 'retracted',
    authorizationMode: 'autonomous_low_risk',
    beforeReceipt: { id: 'before-receipt-1' },
    afterReceipt: { id: 'after-receipt-1' },
    boundaries: ['single claim only', 'does not promote claims to active truth']
  }, { ledgerPath, now: '2026-05-07T11:00:00.000Z' });

  assert.equal(event.class, 'claim_review');
  assert.equal(event.status, 'applied');
  assert.equal(event.rollbackAction.action, 'rollback_review_decision');
  assert.equal(event.rollbackAction.claim_id, 'claim-123');
  assert.equal(event.rollbackAction.receipt_id, 'before-receipt-1');

  const ledger = readEvolutionLedger(ledgerPath);
  assert.equal(ledger.events.length, 1);
});

test('records dry-run candidate review without mutating claim lane', () => {
  const ledgerPath = path.join(tmpDir(), 'ledger.json');
  const event = recordCandidateReviewEvolution({
    id: 'candidate-1',
    action: 'autonomy_review_dry_run',
    class: 'claim_review',
    title: 'Archive stale open question',
    summary: 'Dry-run only.',
    status: 'preview',
    risk: 'low',
    sourceCategory: 'source-addressable memory claim review',
    claimId: 'claim-xyz',
    metadata: {
      policyDecision: 'archive_open_question',
      lane: 'low_risk_review_decision',
      mutationAttempted: false,
      promptEligibilityChanged: false,
      reasonCodes: ['dry_run_only']
    }
  }, 'mark_reviewed', { ledgerPath, note: 'handled', now: '2026-05-07T11:30:00.000Z' });

  assert.equal(event.status, 'reviewed');
  assert.equal(event.action, 'candidate_review_receipt');
  assert.equal(event.claimId, 'claim-xyz');
  assert.equal(event.metadata.originalCandidateId, 'candidate-1');
  assert.equal(event.metadata.mutationAttempted, 'false');
  assert.equal(event.metadata.promptInjectionChanged, 'false');
  assert.equal(event.operatorActions[0].action, 'mark_reviewed');
  assert.match(event.summary, /no claim mutation/);

  const entry = listEvolutionEvents(ledgerPath)[0];
  assert.equal(entry.metadata.spineOutcomePacket.policy.promptInjectionRisk, 'blocked');
  assert.equal(entry.metadata.spineOutcomePacket.policy.mutationPolicy, 'append_only');
});


test('records proposal denial without mutating claim lane', () => {
  const ledgerPath = path.join(tmpDir(), 'ledger.json');
  const event = recordCandidateReviewEvolution({
    id: 'candidate-deny-1',
    action: 'autonomy_review_dry_run',
    class: 'claim_review',
    title: 'Hold uncertain synthesis',
    summary: 'Dry-run only.',
    status: 'preview',
    risk: 'high',
    sourceCategory: 'source-addressable memory claim review',
    claimId: 'claim-deny',
    metadata: {
      policyDecision: 'hold_as_hypothesis',
      lane: 'hypothesis_synthesis',
      mutationAttempted: false,
      promptEligibilityChanged: false,
      reasonCodes: ['explicit_approval_required']
    }
  }, 'deny_proposal', { ledgerPath, note: 'do not apply', now: '2026-05-10T20:10:00.000Z' });

  assert.equal(event.status, 'denied');
  assert.equal(event.action, 'candidate_review_receipt');
  assert.match(event.title, /Denied proposal/);
  assert.match(event.summary, /denied this proposal/);
  assert.match(event.summary, /no claim mutation/);
  assert.equal(event.expectedEffect, 'Records operator rejection of the proposal without changing the underlying claim.');
  assert.equal(event.operatorActions[0].action, 'deny_proposal');
  assert.equal(event.operatorActions[0].status, 'denied');

  const entry = listEvolutionEvents(ledgerPath)[0];
  assert.equal(entry.status, 'denied');
  assert.equal(entry.metadata.spineOutcomePacket.action.action, 'candidate_review_receipt');
});


test('prepares high-risk approval packet without granting apply authority', () => {
  const ledgerPath = path.join(tmpDir(), 'ledger.json');
  const event = recordHighRiskApprovalPacket({
    id: 'candidate-sensitive-1',
    action: 'autonomy_review_dry_run',
    class: 'hypothesis_held',
    title: 'Review candidate: sensitive synthesis',
    status: 'held',
    risk: 'high',
    sourceCategory: 'hypothesis_synthesis',
    claimId: 'claim-sensitive-1',
    metadata: {
      policyDecision: 'hold_as_hypothesis',
      lane: 'hypothesis_synthesis',
      highRiskProtocol: {
        protocol: 'high_risk_candidate',
        posture: 'approval_required',
        candidateId: 'candidate-sensitive-1',
        actionId: 'high_risk_review_apply',
        effectClass: 'claim_maturation',
        authorityRequired: 'explicit_action_specific_user_or_operator_approval',
        targetRefs: { display: 'claim claim-sensitive-1 · hypothesis synthesis', internal: 'claim-sensitive-1' },
        sourceRefs: ['exchange:abc#turn1'],
        expiry: 'recheck required immediately before apply',
        requiredPrechecks: ['source_handle_review', 'risk_reclassification'],
        requiredVerification: ['before_receipt', 'after_receipt'],
        rollbackPlan: 'domain-specific claim review rollback receipt required before any apply',
        reasonCodes: ['sensitive_user_claim']
      }
    }
  }, { ledgerPath, note: 'prepare only', now: '2026-05-09T12:15:00.000Z' });

  assert.equal(event.action, 'high_risk_approval_packet');
  assert.equal(event.status, 'held');
  assert.equal(event.risk, 'high');
  assert.equal(event.metadata.approvalStatus, 'pending_explicit_approval');
  assert.equal(event.metadata.approvalPacket.candidateId, 'candidate-sensitive-1');
  assert.equal(event.metadata.approvalPacket.actionId, 'high_risk_review_apply');
  assert.equal(event.metadata.approvalPacket.applyAuthorityGranted, 'false');
  assert.match(event.metadata.approvalPacket.applyGate, /closed_explicit/);
  assert.match(event.summary, /no claim mutation/);

  const entry = listEvolutionEvents(ledgerPath)[0];
  assert.equal(entry.action, 'high_risk_approval_packet');
  assert.equal(entry.metadata.spineOutcomePacket.policy.promptInjectionRisk, 'blocked');
  assert.equal(entry.metadata.spineOutcomePacket.policy.mutationPolicy, 'append_only');
});



test('records explicit high-risk approval without granting apply authority', () => {
  const ledgerPath = path.join(tmpDir(), 'ledger.json');
  const packet = recordHighRiskApprovalPacket({
    id: 'candidate-sensitive-approval',
    action: 'autonomy_review_dry_run',
    class: 'hypothesis_held',
    title: 'Review candidate: sensitive synthesis approval',
    status: 'held',
    risk: 'high',
    sourceCategory: 'hypothesis_synthesis',
    claimId: 'claim-sensitive-approval',
    metadata: {
      policyDecision: 'hold_as_hypothesis',
      lane: 'hypothesis_synthesis',
      highRiskProtocol: {
        protocol: 'high_risk_candidate',
        posture: 'approval_required',
        candidateId: 'candidate-sensitive-approval',
        actionId: 'high_risk_review_apply',
        effectClass: 'claim_maturation',
        authorityRequired: 'explicit_action_specific_user_or_operator_approval',
        targetRefs: { display: 'claim claim-sensitive-approval · hypothesis synthesis', internal: 'claim-sensitive-approval' },
        sourceRefs: ['exchange:ghi#turn1'],
        expiry: 'recheck required immediately before apply',
        requiredPrechecks: ['source_handle_review', 'risk_reclassification'],
        requiredVerification: ['before_receipt', 'after_receipt'],
        rollbackPlan: 'domain-specific claim review rollback receipt required before any apply',
        reasonCodes: ['sensitive_user_claim']
      }
    }
  }, { ledgerPath, note: 'prepare only', now: '2026-05-09T12:25:00.000Z' });
  const approval = recordHighRiskExplicitApproval(packet, { ledgerPath, note: 'Chris approved exact packet terms only', now: '2026-05-09T12:26:00.000Z' });

  assert.equal(approval.action, 'high_risk_explicit_approval');
  assert.equal(approval.status, 'held');
  assert.equal(approval.metadata.approvalStatus, 'explicitly_approved_no_apply');
  assert.equal(approval.metadata.approvedPacketRef, packet.id);
  assert.equal(approval.metadata.approvalBinding.candidateId, 'candidate-sensitive-approval');
  assert.equal(approval.metadata.approvalBinding.actionId, 'high_risk_review_apply');
  assert.equal(approval.metadata.applyAuthorityGranted, 'false');
  assert.equal(approval.metadata.approvedForPreActionRecheckOnly, 'true');
  assert.match(approval.summary, /no claim mutation/);
  assert.match(approval.verification, /re-run risk classification/);

  const entries = listEvolutionEvents(ledgerPath);
  assert.equal(entries.some((entry) => entry.action === 'high_risk_approval_packet'), true);
  assert.equal(entries.some((entry) => entry.action === 'high_risk_explicit_approval'), true);
});


test('preserves high-risk binding ids that look like opaque tokens so approval recheck can match', () => {
  const ledgerPath = path.join(tmpDir(), 'ledger.json');
  const claimId = 'backfill_summary_d647a226d8af0eb3';
  const candidateId = `candidate-${claimId}`;
  const packet = recordHighRiskApprovalPacket({
    id: candidateId,
    action: 'autonomy_review_dry_run',
    class: 'hypothesis_held',
    title: 'Review candidate: archived continuity summary',
    status: 'held',
    risk: 'high',
    sourceCategory: 'hypothesis_synthesis',
    claimId,
    metadata: {
      policyDecision: 'hold_as_hypothesis',
      lane: 'hypothesis_synthesis',
      highRiskProtocol: {
        protocol: 'high_risk_candidate',
        posture: 'approval_required',
        candidateId,
        actionId: 'high_risk_review_apply',
        effectClass: 'claim_maturation',
        authorityRequired: 'explicit_action_specific_user_or_operator_approval',
        targetRefs: { display: `claim ${claimId} · hypothesis synthesis`, internal: claimId },
        sourceRefs: ['digest:main#v1:summary_summary_trail-guide_2026-05-05_1778007073735_0'],
        expiry: 'recheck required immediately before apply',
        requiredPrechecks: ['source_handle_review', 'risk_reclassification'],
        requiredVerification: ['before_receipt', 'after_receipt', 'claim_status_readback', 'rollback_path_visible'],
        rollbackPlan: 'domain-specific claim review rollback receipt required before any apply',
        reasonCodes: ['sensitive_user_claim']
      }
    }
  }, { ledgerPath, note: 'prepare only', now: '2026-05-10T20:40:00.000Z' });
  const approval = recordHighRiskExplicitApproval(packet, { ledgerPath, note: 'approve exact packet terms only', now: '2026-05-10T20:41:00.000Z' });
  const currentCandidate = {
    id: candidateId,
    risk: 'high',
    metadata: {
      riskClassification: { decision: 'approval_required', blocked: false },
      highRiskProtocol: {
        protocol: 'high_risk_candidate',
        posture: 'approval_required',
        actionId: 'high_risk_review_apply',
        effectClass: 'claim_maturation',
        targetRefs: { display: `claim ${claimId} · hypothesis synthesis`, internal: claimId },
        expiry: 'recheck required immediately before apply',
        requiredVerification: ['before_receipt', 'after_receipt', 'claim_status_readback', 'rollback_path_visible'],
        rollbackPlan: 'domain-specific claim review rollback receipt required before any apply'
      }
    }
  };

  assert.equal(packet.metadata.approvalPacket.candidateId, candidateId);
  assert.equal(packet.metadata.approvalPacket.claimId, claimId);
  assert.equal(approval.metadata.approvalBinding.candidateId, candidateId);
  assert.equal(approval.metadata.approvalBinding.targetRefs.internal, claimId);
  assert.doesNotMatch(JSON.stringify(approval.metadata.approvalBinding), /\[redacted-token\]/);

  const assessment = assessHighRiskPreActionRecheck({ approvalEntry: approval, currentCandidate });
  assert.equal(assessment.outcome, 'current approval still gated');
  assert.deepEqual(assessment.mismatches, []);
});

test('records high-risk pre-action recheck without applying approval', () => {
  const ledgerPath = path.join(tmpDir(), 'ledger.json');
  const packet = recordHighRiskApprovalPacket({
    id: 'candidate-sensitive-recheck',
    action: 'autonomy_review_dry_run',
    class: 'hypothesis_held',
    title: 'Review candidate: sensitive synthesis recheck',
    status: 'held',
    risk: 'high',
    sourceCategory: 'hypothesis_synthesis',
    claimId: 'claim-sensitive-recheck',
    metadata: {
      policyDecision: 'hold_as_hypothesis',
      lane: 'hypothesis_synthesis',
      highRiskProtocol: {
        protocol: 'high_risk_candidate',
        posture: 'approval_required',
        candidateId: 'candidate-sensitive-recheck',
        actionId: 'high_risk_review_apply',
        effectClass: 'claim_maturation',
        authorityRequired: 'explicit_action_specific_user_or_operator_approval',
        targetRefs: { display: 'claim claim-sensitive-recheck · hypothesis synthesis', internal: 'claim-sensitive-recheck' },
        sourceRefs: ['exchange:jkl#turn1'],
        expiry: 'recheck required immediately before apply',
        requiredPrechecks: ['source_handle_review', 'risk_reclassification'],
        requiredVerification: ['before_receipt', 'after_receipt'],
        rollbackPlan: 'domain-specific claim review rollback receipt required before any apply',
        reasonCodes: ['sensitive_user_claim']
      }
    }
  }, { ledgerPath, note: 'prepare only', now: '2026-05-09T12:35:00.000Z' });
  const approval = recordHighRiskExplicitApproval(packet, { ledgerPath, note: 'approve terms only', now: '2026-05-09T12:36:00.000Z' });
  const currentCandidate = {
    id: 'candidate-sensitive-recheck',
    risk: 'high',
    metadata: {
      riskClassification: { decision: 'approval_required', blocked: false },
      highRiskProtocol: {
        protocol: 'high_risk_candidate',
        posture: 'approval_required',
        actionId: 'high_risk_review_apply',
        effectClass: 'claim_maturation',
        targetRefs: { display: 'claim claim-sensitive-recheck · hypothesis synthesis', internal: 'claim-sensitive-recheck' },
        expiry: 'recheck required immediately before apply',
        requiredVerification: ['before_receipt', 'after_receipt'],
        rollbackPlan: 'domain-specific claim review rollback receipt required before any apply'
      }
    }
  };
  const recheck = recordHighRiskPreActionRecheck(approval, { ledgerPath, currentCandidate, note: 'recheck only', now: '2026-05-09T12:37:00.000Z' });
  assert.equal(recheck.action, 'high_risk_pre_action_recheck');
  assert.equal(recheck.status, 'held');
  assert.equal(recheck.metadata.recheckOutcome, 'current approval still gated');
  assert.equal(recheck.metadata.applyAuthorityGranted, 'false');
  assert.equal(recheck.metadata.approvedForApply, 'false');
  assert.equal(recheck.metadata.mutationAttempted, 'false');
  assert.match(recheck.expectedEffect, /does not authorize or execute apply/);

  const changedCandidate = JSON.parse(JSON.stringify(currentCandidate));
  changedCandidate.metadata.highRiskProtocol.effectClass = 'broad_memory_promotion';
  const assessment = assessHighRiskPreActionRecheck({ approvalEntry: approval, currentCandidate: changedCandidate });
  assert.equal(assessment.outcome, 'approval invalidated by recheck');
  assert.deepEqual(assessment.reasonCodes, ['approval binding mismatch']);
  assert.equal(assessment.mismatches[0].field, 'effectClass');

  const missingAssessment = assessHighRiskPreActionRecheck({ approvalEntry: approval, currentCandidate: null });
  assert.equal(missingAssessment.outcome, 'approval expired candidate missing');
  assert.deepEqual(missingAssessment.reasonCodes, ['current candidate missing']);
});

test('records approved high-risk claim maturation apply with rollback and protected-lane boundaries', () => {
  const ledgerPath = path.join(tmpDir(), 'ledger.json');
  const recheckEntry = {
    id: 'evo-recheck-apply-1',
    action: 'high_risk_pre_action_recheck',
    class: 'claim_review',
    title: 'Pre-action recheck: sensitive synthesis',
    status: 'held',
    risk: 'high',
    sourceCategory: 'hypothesis_synthesis',
    claimId: 'claim-sensitive-apply',
    metadata: {
      approvalRef: 'evo-approval-apply-1',
      approvalStatus: 'rechecked_no_apply',
      recheckOutcome: 'current approval still gated',
      applyAuthorityGranted: false,
      mutationAttempted: false,
      approvedBinding: {
        packetId: 'packet-apply-1',
        candidateId: 'candidate-sensitive-apply',
        actionId: 'high_risk_review_apply',
        claimId: 'claim-sensitive-apply',
        effectClass: 'claim_maturation',
        targetRefs: { display: 'claim claim-sensitive-apply', internal: 'claim-sensitive-apply' },
        expiry: 'recheck required immediately before apply',
        requiredVerification: ['before_receipt', 'after_receipt'],
        rollbackPlan: 'domain-specific rollback receipt required before apply'
      }
    }
  };
  const result = {
    ok: true,
    mutationAttempted: true,
    promptInjectionEligibilityChanged: false,
    action: 'apply_review_decision',
    claimId: 'claim-sensitive-apply',
    decision: 'hold_as_hypothesis',
    beforeStatus: 'verify_required',
    afterStatus: 'verify_required',
    authorizationMode: 'operator_approved',
    beforeReceipt: { id: 'before-high-risk-1' },
    afterReceipt: { id: 'after-high-risk-1' },
    boundaries: ['single claim only']
  };
  const event = recordHighRiskClaimMaturationApply(result, {
    ledgerPath,
    recheckEntry,
    currentCandidate: { id: 'candidate-sensitive-apply', risk: 'high' },
    finalRecheck: { outcome: 'current approval still gated', reasonCodes: ['still high risk approval required'] },
    now: '2026-05-09T12:38:00.000Z'
  });
  assert.equal(event.action, 'high_risk_claim_apply');
  assert.equal(event.status, 'applied');
  assert.equal(event.risk, 'high');
  assert.equal(event.rollbackAction.action, 'rollback_review_decision');
  assert.equal(event.rollbackAction.receipt_id, 'before-high-risk-1');
  assert.equal(event.metadata.applyAuthorityGranted, 'true');
  assert.equal(event.metadata.authorityScope, 'single approved claim maturation receipt only');
  assert.equal(event.metadata.promptEligibilityChanged, 'false');
  assert.match(event.summary, /without prompt injection/);
  assert.match(event.rollback, /rollback_review_decision/);
});

test('records high-risk preflight as no-mutation evidence only', () => {
  const ledgerPath = path.join(tmpDir(), 'ledger.json');
  const event = recordHighRiskPreflight({
    id: 'candidate-sensitive-2',
    action: 'autonomy_review_dry_run',
    class: 'hypothesis_held',
    title: 'Review candidate: sensitive synthesis preflight',
    status: 'held',
    risk: 'high',
    sourceCategory: 'hypothesis_synthesis',
    claimId: 'claim-sensitive-2',
    metadata: {
      policyDecision: 'hold_as_hypothesis',
      lane: 'hypothesis_synthesis',
      highRiskProtocol: {
        protocol: 'high_risk_candidate',
        posture: 'approval_required',
        candidateId: 'candidate-sensitive-2',
        actionId: 'high_risk_review_apply',
        effectClass: 'claim_maturation',
        authorityRequired: 'explicit_action_specific_user_or_operator_approval',
        targetRefs: { display: 'claim claim-sensitive-2 · hypothesis synthesis', internal: 'claim-sensitive-2' },
        sourceRefs: ['exchange:def#turn1'],
        expiry: 'recheck required immediately before apply',
        requiredPrechecks: ['source_handle_review', 'risk_reclassification'],
        requiredVerification: ['before_receipt', 'after_receipt'],
        rollbackPlan: 'domain-specific claim review rollback receipt required before any apply',
        reasonCodes: ['sensitive_user_claim']
      }
    }
  }, { ledgerPath, note: 'preflight only', now: '2026-05-09T12:20:00.000Z' });

  assert.equal(event.action, 'high_risk_preflight');
  assert.equal(event.status, 'held');
  assert.equal(event.metadata.preflightStatus, 'complete_no_mutation');
  assert.equal(event.metadata.applyAuthorityGranted, 'false');
  assert.equal(event.metadata.noMutationProof.writesAttempted, 'false');
  assert.equal(event.metadata.noMutationProof.promptEligibilityChanged, 'false');
  assert.equal(event.metadata.noMutationProof.schedulerAuthorityGranted, 'false');
  assert.equal(event.metadata.noMutationProof.runtimeConfigMutationAttempted, 'false');
  assert.equal(event.metadata.noMutationProof.toolPolicyMutationAttempted, 'false');
  assert.equal(event.metadata.noMutationProof.broadMemoryPromotionAttempted, 'false');
  assert.match(event.summary, /No claim mutation/);

  const entry = listEvolutionEvents(ledgerPath)[0];
  assert.equal(entry.action, 'high_risk_preflight');
  assert.equal(entry.metadata.spineOutcomePacket.policy.promptInjectionRisk, 'blocked');
  assert.equal(entry.metadata.spineOutcomePacket.policy.mutationPolicy, 'append_only');
});


test('active autonomous writes require policy verification and reversal path', () => {
  const ledgerPath = path.join(tmpDir(), 'ledger.json');
  assert.throws(() => appendEvolutionEvent(ledgerPath, {
    id: 'unsafe-active-write',
    class: 'operational_lesson',
    title: 'Unsafe active lesson',
    summary: 'Would change behavior without a receipt.',
    risk: 'low',
    status: 'active',
    sourceCategory: 'unit test'
  }), /requires policy rule, expected effect, verification, rollback\/disable\/strip path/);

  appendEvolutionEvent(ledgerPath, {
    id: 'safe-active-write',
    class: 'operational_lesson',
    title: 'Safe active lesson',
    summary: 'A bounded lesson with an explicit reversal path.',
    risk: 'low',
    status: 'active',
    sourceCategory: 'unit test',
    allowedBy: 'low-risk local reversible',
    expectedEffect: 'Changes only this local operating habit.',
    verification: 'Unit fixture confirmed policy and rollback metadata before activation.',
    rollback: 'Disable or strip this ledger receipt to stop using the lesson.',
    createdAt: '2026-05-07T11:45:00.000Z'
  });

  const entries = listEvolutionEvents(ledgerPath);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'active');
  assert.equal(entries[0].allowedBy, 'low-risk local reversible');
});

test('blocked autonomous write receipts are allowed without reversal metadata', () => {
  assert.doesNotThrow(() => assertAutonomousWriteSafety({
    id: 'blocked-write',
    class: 'posture_tuning',
    title: 'Blocked posture tuning',
    summary: 'Blocked before behavior changed.',
    risk: 'medium',
    status: 'blocked',
    sourceCategory: 'unit test'
  }));
});

test('updates ledger event status for inspection controls', () => {
  const ledgerPath = path.join(tmpDir(), 'ledger.json');
  appendEvolutionEvent(ledgerPath, buildClaimReviewEvent({
    ok: true,
    mutationAttempted: true,
    action: 'apply_review_decision',
    claimId: 'claim-abc',
    decision: 'archive_open_question',
    beforeStatus: 'stale',
    afterStatus: 'retracted',
    authorizationMode: 'autonomous_low_risk',
    beforeReceipt: { id: 'before-receipt-abc' },
    afterReceipt: { id: 'after-receipt-abc' }
  }, { now: '2026-05-07T12:00:00.000Z', receiptId: 'after-receipt-abc', isRollback: false }));

  const before = listEvolutionEvents(ledgerPath)[0];
  const reviewed = updateEvolutionEvent(ledgerPath, before.id, 'mark_reviewed', { note: 'receipt inspected', now: '2026-05-07T12:00:30.000Z' });
  assert.equal(reviewed.status, 'reviewed');
  const updated = updateEvolutionEvent(ledgerPath, before.id, 'mark_harmful', { note: 'bad classification', now: '2026-05-07T12:01:00.000Z' });
  assert.equal(updated.status, 'harmful');
  assert.equal(updated.metadata.beforeStatus, 'stale');
  assert.equal(updated.metadata.spineOutcomePacket.packetType, 'outcome_event');
  assert.equal(updated.metadata.spineOutcomePacket.status, 'observed');
  const ledger = readEvolutionLedger(ledgerPath);
  assert.equal(ledger.events[0].operatorActions[0].action, 'mark_reviewed');
  assert.equal(ledger.events[0].operatorActions[1].action, 'mark_harmful');
});


test('pure event transition reducer covers inspect disable rollback strip and harmful states', () => {
  const base = buildClaimReviewEvent({
    ok: true,
    mutationAttempted: true,
    action: 'apply_review_decision',
    claimId: 'claim-reducer',
    decision: 'archive_open_question',
    beforeStatus: 'stale',
    afterStatus: 'retracted',
    authorizationMode: 'autonomous_low_risk',
    beforeReceipt: { id: 'before-reducer' },
    afterReceipt: { id: 'after-reducer' }
  }, { now: '2026-05-07T13:00:00.000Z', receiptId: 'after-reducer', isRollback: false });

  const cases = [
    ['inspect', 'reviewed'],
    ['disable', 'disabled'],
    ['rollback_requested', 'rollback_requested'],
    ['strip', 'stripped'],
    ['mark_harmful', 'harmful']
  ];

  for (const [action, status] of cases) {
    const updated = applyEvolutionEventTransition(base, action, { note: `${action} note`, now: '2026-05-07T13:01:00.000Z' });
    assert.equal(updated.status, status);
    assert.equal(updated.updatedAt, '2026-05-07T13:01:00.000Z');
    assert.equal(updated.metadata.beforeStatus, 'stale');
    assert.equal(updated.operatorActions.length, 1);
    assert.equal(updated.operatorActions[0].action, action);
    assert.equal(updated.operatorActions[0].fromStatus, 'applied');
    assert.equal(updated.operatorActions[0].status, status);
  }
});

test('event transition reducer appends deterministic action history across multiple controls', () => {
  const base = buildClaimReviewEvent({
    ok: true,
    mutationAttempted: true,
    action: 'apply_review_decision',
    claimId: 'claim-history',
    decision: 'hold_as_hypothesis',
    beforeStatus: 'verify_required',
    afterStatus: 'hypothesis',
    authorizationMode: 'autonomous_low_risk',
    beforeReceipt: { id: 'before-history' },
    afterReceipt: { id: 'after-history' }
  }, { now: '2026-05-07T14:00:00.000Z', receiptId: 'after-history', isRollback: false });

  const disabled = applyEvolutionEventTransition(base, 'disable', { now: '2026-05-07T14:01:00.000Z' });
  const stripped = applyEvolutionEventTransition(disabled, 'strip', { now: '2026-05-07T14:02:00.000Z' });

  assert.equal(stripped.status, 'stripped');
  assert.deepEqual(stripped.operatorActions.map((item) => item.action), ['disable', 'strip']);
  assert.deepEqual(stripped.operatorActions.map((item) => item.fromStatus), ['applied', 'disabled']);
  assert.equal(stripped.metadata.afterStatus, 'hypothesis');
});
