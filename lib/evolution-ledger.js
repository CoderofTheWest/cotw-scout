'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeJsonAtomic } = require('./write-json-atomic');
const {
  createOutcomeEventPacketFromEvolutionEntry,
  assertOutcomeEventPacket,
  outcomePacketLabels
} = require('./agent-integration-spine');

const LEDGER_VERSION = 1;

const EVOLUTION_CLASSES = Object.freeze({
  OPERATIONAL_LESSON: 'operational_lesson',
  MEMORY_HYGIENE: 'memory_hygiene',
  HYPOTHESIS_HELD: 'hypothesis_held',
  POSTURE_TUNING: 'posture_tuning',
  PROCESS_UI_FRICTION: 'process_ui_friction',
  CLAIM_REVIEW: 'claim_review',
  EMERGENCE_ARTIFACT: 'emergence_artifact'
});

const ALLOWED_CLASSES = new Set(Object.values(EVOLUTION_CLASSES));
const ALLOWED_RISKS = new Set(['low', 'medium', 'high']);
const ALLOWED_STATUSES = new Set([
  'active',
  'applied',
  'planned',
  'preview',
  'held',
  'blocked',
  'reviewed',
  'dismissed',
  'denied',
  'reopened',
  'rolled_back',
  'rollback_requested',
  'disabled',
  'stripped',
  'harmful',
  'failed'
]);
const ACTION_STATUS = Object.freeze({
  inspect: 'reviewed',
  mark_reviewed: 'reviewed',
  keep_acknowledge: 'reviewed',
  dismiss: 'dismissed',
  deny_proposal: 'denied',
  reopen: 'reopened',
  rollback_requested: 'rollback_requested',
  rollback: 'rollback_requested',
  mark_harmful: 'harmful',
  disable: 'disabled',
  strip: 'stripped'
});

function resolveEvolutionLedgerPath({ workspacePath, pluginDataDir, agentId = 'trail-guide' } = {}) {
  if (workspacePath) return path.join(workspacePath, 'evolution', 'ledger.json');
  if (pluginDataDir) return path.join(pluginDataDir, 'agents', agentId, 'evolution-ledger.json');
  throw new Error('workspacePath or pluginDataDir is required');
}

function candidateEvolutionLedgerPaths({ workspacePath, pluginsPath, agentId = 'trail-guide' } = {}) {
  const paths = [];
  if (workspacePath) paths.push(resolveEvolutionLedgerPath({ workspacePath }));
  if (pluginsPath) {
    const continuityData = path.join(pluginsPath, 'openclaw-plugin-continuity', 'data');
    paths.push(resolveEvolutionLedgerPath({ pluginDataDir: continuityData, agentId }));
    paths.push(path.join(continuityData, 'evolution-ledger.json'));
  }
  return Array.from(new Set(paths));
}

function readEvolutionLedger(ledgerPath) {
  if (!ledgerPath || !fs.existsSync(ledgerPath)) return emptyLedger();
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    const events = Array.isArray(parsed.events) ? parsed.events.map(normalizeEvolutionEvent).filter(Boolean) : [];
    return { version: parsed.version || LEDGER_VERSION, events };
  } catch {
    return emptyLedger();
  }
}

function listEvolutionEvents(pathsOrPath, options = {}) {
  const paths = Array.isArray(pathsOrPath) ? pathsOrPath : [pathsOrPath];
  const seen = new Set();
  const entries = [];
  for (const ledgerPath of paths.filter(Boolean)) {
    const ledger = readEvolutionLedger(ledgerPath);
    for (const event of ledger.events) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      entries.push(toGuiEntry(event));
    }
  }
  entries.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const limit = Number.isInteger(options.limit) ? options.limit : 50;
  return entries.slice(0, limit);
}

function appendEvolutionEvent(ledgerPath, eventInput, options = {}) {
  const event = normalizeEvolutionEvent({ ...eventInput, createdAt: eventInput.createdAt || options.now || new Date().toISOString() });
  if (!event) throw new Error('invalid evolution event');
  assertAutonomousWriteSafety(event);
  const ledger = readEvolutionLedger(ledgerPath);
  const idx = ledger.events.findIndex((candidate) => candidate.id === event.id);
  if (idx >= 0) ledger.events[idx] = { ...ledger.events[idx], ...event, updatedAt: event.updatedAt || options.now || event.createdAt };
  else ledger.events.push(event);
  ledger.events.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  persistLedger(ledgerPath, ledger);
  return event;
}

function updateEvolutionEvent(ledgerPath, id, action, options = {}) {
  const safeId = String(id || '').trim();
  if (!safeId) throw new Error('id is required');
  if (!Object.prototype.hasOwnProperty.call(ACTION_STATUS, action)) throw new Error(`unsupported evolution action: ${action}`);
  const ledger = readEvolutionLedger(ledgerPath);
  const idx = ledger.events.findIndex((event) => event.id === safeId);
  if (idx < 0) throw new Error(`evolution event not found: ${safeId}`);
  ledger.events[idx] = applyEvolutionEventTransition(ledger.events[idx], action, options);
  persistLedger(ledgerPath, ledger);
  return toGuiEntry(ledger.events[idx]);
}


function applyEvolutionEventTransition(event, action, options = {}) {
  if (!event) throw new Error('evolution event is required');
  if (!Object.prototype.hasOwnProperty.call(ACTION_STATUS, action)) throw new Error(`unsupported evolution action: ${action}`);
  const now = options.now || new Date().toISOString();
  const before = normalizeEvolutionEvent(event);
  const status = ACTION_STATUS[action];
  const operatorAction = {
    action,
    fromStatus: before.status,
    status,
    note: sanitize(options.note, 500),
    createdAt: now
  };
  return normalizeEvolutionEvent({
    ...before,
    status,
    updatedAt: now,
    operatorActions: [...(Array.isArray(before.operatorActions) ? before.operatorActions : []), operatorAction]
  });
}


function assertAutonomousWriteSafety(event = {}) {
  const safe = normalizeEvolutionEvent(event);
  if (!isBehaviorChangingStatus(safe.status)) return safe;
  if (!isBehaviorChangingClass(safe.class)) return safe;

  const missing = [];
  if (!safe.allowedBy) missing.push('policy rule');
  if (!safe.expectedEffect) missing.push('expected effect');
  if (!safe.verification) missing.push('verification');
  if (!hasReversalPath(safe)) missing.push('rollback/disable/strip path');

  if (missing.length > 0) {
    throw new Error(`active autonomous evolution write requires ${missing.join(', ')}`);
  }
  return safe;
}

function isBehaviorChangingStatus(status) {
  return ['active', 'applied'].includes(status);
}

function isBehaviorChangingClass(klass) {
  return [
    EVOLUTION_CLASSES.OPERATIONAL_LESSON,
    EVOLUTION_CLASSES.MEMORY_HYGIENE,
    EVOLUTION_CLASSES.HYPOTHESIS_HELD,
    EVOLUTION_CLASSES.POSTURE_TUNING,
    EVOLUTION_CLASSES.PROCESS_UI_FRICTION,
    EVOLUTION_CLASSES.CLAIM_REVIEW,
    EVOLUTION_CLASSES.EMERGENCE_ARTIFACT
  ].includes(klass);
}

function hasReversalPath(event = {}) {
  if (event.rollbackAction && typeof event.rollbackAction === 'object' && event.rollbackAction.action) return true;
  const text = `${event.rollback || ''} ${event.verification || ''}`.toLowerCase();
  return ['rollback', 'disable', 'strip', 'reopen', 'before-receipt'].some((token) => text.includes(token));
}

function recordClaimReviewEvolution(result = {}, options = {}) {
  if (!result || result.ok !== true || result.mutationAttempted !== true) return null;
  const ledgerPath = options.ledgerPath || resolveEvolutionLedgerPath(options);
  const now = options.now || new Date().toISOString();
  const action = result.action || 'apply_review_decision';
  const isRollback = action === 'rollback_review_decision';
  const receiptId = isRollback ? result.rollbackReceipt?.id : result.afterReceipt?.id;
  const event = buildClaimReviewEvent(result, { now, receiptId, isRollback });
  return appendEvolutionEvent(ledgerPath, event, { now });
}

function recordCandidateReviewEvolution(candidate = {}, action = 'mark_reviewed', options = {}) {
  if (!candidate || candidate.action !== 'autonomy_review_dry_run') throw new Error('candidate review receipt requires dry-run candidate');
  if (!['mark_reviewed', 'dismiss', 'deny_proposal'].includes(action)) throw new Error(`unsupported candidate review action: ${action}`);
  const ledgerPath = options.ledgerPath || resolveEvolutionLedgerPath(options);
  const now = options.now || new Date().toISOString();
  const event = buildCandidateReviewEvent(candidate, action, { now, note: options.note });
  return appendEvolutionEvent(ledgerPath, event, { now });
}

function recordHighRiskApprovalPacket(candidate = {}, options = {}) {
  assertHighRiskReviewCandidate(candidate, 'approval packet');
  const ledgerPath = options.ledgerPath || resolveEvolutionLedgerPath(options);
  const now = options.now || new Date().toISOString();
  const event = buildHighRiskApprovalPacketEvent(candidate, { now, note: options.note });
  return appendEvolutionEvent(ledgerPath, event, { now });
}

function recordHighRiskPreflight(candidate = {}, options = {}) {
  assertHighRiskReviewCandidate(candidate, 'preflight');
  const ledgerPath = options.ledgerPath || resolveEvolutionLedgerPath(options);
  const now = options.now || new Date().toISOString();
  const event = buildHighRiskPreflightEvent(candidate, { now, note: options.note });
  return appendEvolutionEvent(ledgerPath, event, { now });
}


function recordHighRiskExplicitApproval(packetEntry = {}, options = {}) {
  assertHighRiskApprovalPacketEntry(packetEntry);
  const ledgerPath = options.ledgerPath || resolveEvolutionLedgerPath(options);
  const now = options.now || new Date().toISOString();
  const event = buildHighRiskExplicitApprovalEvent(packetEntry, { now, note: options.note, approver: options.approver });
  return appendEvolutionEvent(ledgerPath, event, { now });
}


function recordHighRiskPreActionRecheck(approvalEntry = {}, options = {}) {
  assertHighRiskExplicitApprovalEntry(approvalEntry);
  const ledgerPath = options.ledgerPath || resolveEvolutionLedgerPath(options);
  const now = options.now || new Date().toISOString();
  const event = buildHighRiskPreActionRecheckEvent(approvalEntry, { now, note: options.note, currentCandidate: options.currentCandidate });
  return appendEvolutionEvent(ledgerPath, event, { now });
}

function recordHighRiskClaimMaturationApply(result = {}, options = {}) {
  if (!result || result.ok !== true || result.mutationAttempted !== true) return null;
  assertHighRiskPreActionRecheckEntry(options.recheckEntry || {});
  const ledgerPath = options.ledgerPath || resolveEvolutionLedgerPath(options);
  const now = options.now || new Date().toISOString();
  const event = buildHighRiskClaimMaturationApplyEvent(result, {
    now,
    recheckEntry: options.recheckEntry,
    currentCandidate: options.currentCandidate,
    finalRecheck: options.finalRecheck
  });
  return appendEvolutionEvent(ledgerPath, event, { now });
}

function assertHighRiskPreActionRecheckEntry(recheckEntry = {}) {
  if (!recheckEntry || recheckEntry.action !== 'high_risk_pre_action_recheck') throw new Error('high-risk apply requires pre-action recheck receipt');
  if (recheckEntry.risk !== 'high') throw new Error('high-risk apply requires high-risk recheck receipt');
  if (recheckEntry.status !== 'held') throw new Error('high-risk apply requires held recheck receipt');
  if (recheckEntry.metadata?.approvalStatus !== 'rechecked_no_apply') throw new Error('high-risk apply requires successful recheck receipt');
  if (recheckEntry.metadata?.recheckOutcome !== 'current approval still gated') throw new Error('high-risk apply requires current approval still gated');
  if (recheckEntry.metadata?.applyAuthorityGranted === true || recheckEntry.metadata?.applyAuthorityGranted === 'true') throw new Error('high-risk apply refuses pre-granted apply authority');
  if (recheckEntry.metadata?.mutationAttempted === true || recheckEntry.metadata?.mutationAttempted === 'true') throw new Error('high-risk apply refuses prior mutation attempt');
}

function assertHighRiskExplicitApprovalEntry(approvalEntry = {}) {
  if (!approvalEntry || approvalEntry.action !== 'high_risk_explicit_approval') throw new Error('pre-action recheck requires explicit approval receipt');
  if (approvalEntry.risk !== 'high') throw new Error('pre-action recheck requires high-risk approval receipt');
  if (approvalEntry.metadata?.approvalStatus !== 'explicitly_approved_no_apply') throw new Error('pre-action recheck requires captured approval receipt');
  if (approvalEntry.metadata?.applyAuthorityGranted === true || approvalEntry.metadata?.applyAuthorityGranted === 'true') throw new Error('pre-action recheck refuses approval receipts that grant apply authority');
}

function assertHighRiskApprovalPacketEntry(packetEntry = {}) {
  if (!packetEntry || packetEntry.action !== 'high_risk_approval_packet') throw new Error('explicit approval requires high-risk approval packet receipt');
  if (packetEntry.risk !== 'high') throw new Error('explicit approval requires high-risk packet');
  const packet = packetEntry.metadata?.approvalPacket;
  if (!packet || packet.protocol !== 'high_risk_candidate') throw new Error('explicit approval requires high-risk packet metadata');
  if (packet.approvalStatus !== 'pending_explicit_approval') throw new Error('explicit approval requires pending approval packet');
  if (packet.applyAuthorityGranted === true || packet.applyAuthorityGranted === 'true') throw new Error('explicit approval refuses packets that already grant apply authority');
}

function assertHighRiskReviewCandidate(candidate = {}, label = 'high-risk review') {
  if (!candidate || candidate.action !== 'autonomy_review_dry_run') throw new Error(`${label} requires dry-run candidate`);
  if (candidate.risk !== 'high') throw new Error(`${label} requires high-risk candidate`);
  const protocol = candidate.metadata?.highRiskProtocol;
  if (!protocol || protocol.protocol !== 'high_risk_candidate' || protocol.posture !== 'approval_required') {
    throw new Error(`${label} requires high-risk approval protocol metadata`);
  }
}

function buildClaimReviewEvent(result, { now, receiptId, isRollback }) {
  const claimId = sanitize(result.claimId, 160);
  const title = isRollback
    ? `Rolled back claim review decision for ${claimId}`
    : `Applied claim review decision for ${claimId}`;
  const decisionLabel = sanitize(result.decision || 'review decision', 120).replace(/_/g, ' ');
  const status = isRollback ? 'rolled_back' : 'applied';
  return normalizeEvolutionEvent({
    id: stableEventId({ action: result.action, claimId, receiptId, afterStatus: result.afterStatus }),
    class: EVOLUTION_CLASSES.CLAIM_REVIEW,
    title,
    summary: isRollback
      ? `Restored a single claim from a stored before-receipt snapshot. Status moved ${safeStatus(result.beforeStatus)} → ${safeStatus(result.afterStatus)}.`
      : `Autonomously applied low-risk ${decisionLabel}. Status moved ${safeStatus(result.beforeStatus)} → ${safeStatus(result.afterStatus)} without promoting the claim to active truth.`,
    status,
    risk: 'low',
    sourceCategory: 'source-addressable memory claim review',
    allowedBy: sanitize(result.authorizationMode || 'autonomous low-risk policy', 180),
    expectedEffect: 'Keeps uncertain or stale claim material from being asserted as fact.',
    verification: receiptId ? `Receipt ${sanitize(receiptId, 180)} recorded; prompt injection and source resolution remained unchanged.` : 'Receipt recorded; prompt injection and source resolution remained unchanged.',
    rollback: isRollback
      ? 'Already rolled back from before-receipt snapshot.'
      : 'Use rollback_review_decision with the stored before receipt for this claim.',
    action: result.action,
    claimId,
    receiptId: sanitize(receiptId, 180),
    rollbackAction: isRollback ? null : {
      tool: 'continuity_claims',
      action: 'rollback_review_decision',
      claim_id: claimId,
      receipt_id: sanitize(result.beforeReceipt?.id, 180),
      apply: true
    },
    createdAt: now,
    updatedAt: now,
    metadata: {
      beforeStatus: safeStatus(result.beforeStatus),
      afterStatus: safeStatus(result.afterStatus),
      decision: sanitize(result.decision, 80),
      authorizationMode: sanitize(result.authorizationMode, 80),
      boundaries: Array.isArray(result.boundaries) ? result.boundaries.map((item) => sanitize(item, 200)).slice(0, 12) : []
    }
  });
}

function buildCandidateReviewEvent(candidate = {}, action = 'mark_reviewed', { now, note } = {}) {
  const claimId = sanitize(candidate.claimId, 160);
  const candidateId = sanitize(candidate.id, 180);
  const policyDecision = sanitize(candidate.metadata?.policyDecision || 'review', 120).replace(/_/g, ' ');
  const status = ACTION_STATUS[action] || 'reviewed';
  const titlePrefix = status === 'denied'
    ? 'Denied proposal'
    : status === 'dismissed'
      ? 'Dismissed dry-run candidate'
      : 'Reviewed dry-run candidate';
  const summaryPrefix = status === 'denied'
    ? 'User/operator denied this proposal'
    : `${titlePrefix}`;
  return normalizeEvolutionEvent({
    id: stableEventId({ action: `candidate_${action}`, claimId, receiptId: candidateId, title: candidate.title }),
    class: candidate.class || EVOLUTION_CLASSES.CLAIM_REVIEW,
    title: `${titlePrefix}: ${sanitize(candidate.title || claimId || candidateId, 120)}`,
    summary: `${summaryPrefix}. Original dry-run recommendation was ${policyDecision}; no claim mutation, prompt injection, scheduler linkage, config change, or broad memory promotion occurred.`,
    status,
    risk: candidate.risk || 'low',
    sourceCategory: candidate.sourceCategory || 'dry-run candidate review',
    allowedBy: 'operator_review_only_no_claim_mutation',
    expectedEffect: status === 'denied'
      ? 'Records operator rejection of the proposal without changing the underlying claim.'
      : 'Records that the dry-run candidate was handled in Evolve without changing the underlying claim.',
    verification: 'Evolution receipt recorded; original candidate remains dry-run evidence and does not authorize prompt context or memory promotion.',
    rollback: 'Use reopen on this Evolve receipt if the candidate should return to review; no claim rollback is needed because no claim mutation occurred.',
    action: 'candidate_review_receipt',
    claimId,
    receiptId: candidateId,
    rollbackAction: null,
    createdAt: now,
    updatedAt: now,
    operatorActions: [{ action, status, note: sanitize(note, 500), createdAt: now }],
    metadata: {
      originalCandidateId: candidateId,
      originalAction: candidate.action,
      originalStatus: candidate.status,
      policyDecision: sanitize(candidate.metadata?.policyDecision, 80),
      lane: sanitize(candidate.metadata?.lane, 80),
      reasonCodes: Array.isArray(candidate.metadata?.reasonCodes) ? candidate.metadata.reasonCodes.map((item) => sanitize(item, 160)).slice(0, 12) : [],
      promptInjectionChanged: candidate.metadata?.promptEligibilityChanged === true,
      mutationAttempted: candidate.metadata?.mutationAttempted === true,
      boundaries: ['evolution ledger only', 'no claim mutation', 'no prompt injection', 'no scheduler linkage', 'no config or tool-policy mutation']
    }
  });
}

function buildHighRiskApprovalPacketEvent(candidate = {}, { now, note } = {}) {
  const protocol = candidate.metadata?.highRiskProtocol || {};
  const approvalPacket = buildHighRiskApprovalPacket(candidate, { protocol, now, note });
  const claimId = sanitize(candidate.claimId, 160);
  const candidateId = sanitize(candidate.id, 180);
  return normalizeEvolutionEvent({
    id: stableEventId({ action: 'high_risk_approval_packet', claimId, receiptId: candidateId, title: approvalPacket.packetId }),
    class: candidate.class || EVOLUTION_CLASSES.CLAIM_REVIEW,
    title: `Prepared high-risk approval packet: ${sanitize(candidate.title || claimId || candidateId, 120)}`,
    summary: 'Prepared an explicit approval packet for a high-risk candidate. This is review evidence only; no claim mutation, source resolution, prompt injection, scheduler linkage, config change, or broad memory promotion occurred.',
    status: 'held',
    risk: 'high',
    sourceCategory: candidate.sourceCategory || 'high-risk candidate approval',
    allowedBy: 'operator_packet_preparation_only_no_apply_authority',
    expectedEffect: 'Binds the exact high-risk candidate/action/target/effect/expiry/verification/rollback terms for later human review without granting apply authority.',
    verification: 'Approval packet persisted; behavior-changing apply still requires explicit action-specific approval and immediate pre-action reclassification.',
    rollback: 'Dismiss or mark reviewed to retire this approval packet. No claim rollback is needed because no claim mutation occurred.',
    action: 'high_risk_approval_packet',
    claimId,
    receiptId: approvalPacket.packetId,
    rollbackAction: null,
    createdAt: now,
    updatedAt: now,
    operatorActions: [{ action: 'prepare_high_risk_approval_packet', status: 'held', note: sanitize(note, 500), createdAt: now }],
    metadata: {
      originalCandidateId: candidateId,
      originalAction: candidate.action,
      originalStatus: candidate.status,
      policyDecision: sanitize(candidate.metadata?.policyDecision, 80),
      lane: sanitize(candidate.metadata?.lane, 80),
      approvalStatus: 'pending_explicit_approval',
      approvalPacket,
      highRiskProtocol: sanitizeBindingObject(protocol),
      boundaries: [
        'approval packet only',
        'no claim mutation',
        'no prompt injection',
        'no scheduler linkage',
        'no runtime config mutation',
        'no runtime tool-policy mutation',
        'no broad memory promotion',
        'approval expires before any later apply attempt unless rechecked'
      ]
    }
  });
}


function buildHighRiskPreflightEvent(candidate = {}, { now, note } = {}) {
  const protocol = candidate.metadata?.highRiskProtocol || {};
  const claimId = sanitize(candidate.claimId, 160);
  const candidateId = sanitize(candidate.id, 180);
  const preflightId = stableEventId({ action: 'high_risk_preflight', claimId, receiptId: candidateId, title: protocol.actionId || 'high_risk_review_apply' });
  return normalizeEvolutionEvent({
    id: preflightId,
    class: candidate.class || EVOLUTION_CLASSES.CLAIM_REVIEW,
    title: `High-risk preflight complete: ${sanitize(candidate.title || claimId || candidateId, 120)}`,
    summary: 'Recorded a side-effect-free high-risk preflight. No claim mutation, source resolution, prompt injection, scheduler linkage, runtime config/tool-policy mutation, or broad memory promotion occurred.',
    status: 'held',
    risk: 'high',
    sourceCategory: candidate.sourceCategory || 'high-risk candidate preflight',
    allowedBy: 'operator_preflight_only_no_apply_authority',
    expectedEffect: 'Confirms the high-risk candidate can be reviewed without live mutation; apply remains closed pending explicit approval and immediate reclassification.',
    verification: 'Preflight receipt persisted with no behavior-changing effect; before/after mutation receipts were not written because no mutation was attempted.',
    rollback: 'No rollback required because this preflight produced no domain mutation. Dismiss or mark reviewed to retire the receipt.',
    action: 'high_risk_preflight',
    claimId,
    receiptId: preflightId,
    rollbackAction: null,
    createdAt: now,
    updatedAt: now,
    operatorActions: [{ action: 'run_high_risk_preflight', status: 'held', note: sanitize(note, 500), createdAt: now }],
    metadata: {
      originalCandidateId: candidateId,
      originalAction: candidate.action,
      originalStatus: candidate.status,
      policyDecision: sanitize(candidate.metadata?.policyDecision, 80),
      lane: sanitize(candidate.metadata?.lane, 80),
      preflightStatus: 'complete_no_mutation',
      applyAuthorityGranted: false,
      highRiskProtocol: sanitizeBindingObject(protocol),
      noMutationProof: {
        writesAttempted: false,
        claimMutationAttempted: false,
        sourceResolutionAttempted: false,
        promptEligibilityChanged: false,
        schedulerAuthorityGranted: false,
        runtimeConfigMutationAttempted: false,
        toolPolicyMutationAttempted: false,
        broadMemoryPromotionAttempted: false
      },
      requiredNextStep: 'explicit_action_specific_approval_then_immediate_reclassification_before_apply',
      boundaries: [
        'preflight only',
        'no claim mutation',
        'no source resolution',
        'no prompt injection',
        'no scheduler linkage',
        'no runtime config mutation',
        'no runtime tool-policy mutation',
        'no broad memory promotion'
      ]
    }
  });
}



function buildHighRiskPreActionRecheckEvent(approvalEntry = {}, { now, note, currentCandidate } = {}) {
  const binding = approvalEntry.metadata?.approvalBinding || {};
  const assessment = assessHighRiskPreActionRecheck({ approvalEntry, currentCandidate });
  const claimId = sanitize(binding.claimId || approvalEntry.claimId, 160);
  const recheckId = stableEventId({ action: 'high_risk_pre_action_recheck', claimId, receiptId: approvalEntry.id || approvalEntry.receiptId, title: assessment.outcome });
  const valid = assessment.outcome === 'current approval still gated';
  return normalizeEvolutionEvent({
    id: recheckId,
    class: approvalEntry.class || EVOLUTION_CLASSES.CLAIM_REVIEW,
    title: `Pre-action recheck: ${sanitize(approvalEntry.title || claimId || binding.candidateId, 120)}`,
    summary: valid
      ? 'Re-ran the high-risk approval binding check against the current candidate. The approval still points at the same approval-required packet terms, but no apply handler executed and no apply authority was granted.'
      : `Re-ran the high-risk approval binding check and invalidated the approval for apply: ${assessment.reasonCodes.join(', ') || 'recheck failed'}. No mutation occurred.`,
    status: valid ? 'held' : 'blocked',
    risk: 'high',
    sourceCategory: approvalEntry.sourceCategory || 'high-risk pre-action recheck',
    allowedBy: 'pre_action_reclassification_receipt_only_no_apply_authority',
    expectedEffect: 'Records whether one explicit high-risk approval still matches the current candidate immediately before any future apply path; does not authorize or execute apply.',
    verification: valid
      ? 'Current candidate was found, remained high-risk approval-required, and matched the approved candidate/action/effect/target/expiry/verification/rollback binding. Apply authority remains false.'
      : 'Approval must return to review or be regenerated before any future apply path. Apply authority remains false.',
    rollback: 'No domain rollback is needed because no mutation occurred; if blocked, prepare a new packet/approval after review.',
    action: 'high_risk_pre_action_recheck',
    claimId,
    receiptId: recheckId,
    rollbackAction: null,
    createdAt: now,
    updatedAt: now,
    operatorActions: [{ action: 'run_high_risk_pre_action_recheck', status: valid ? 'held' : 'blocked', note: sanitize(note, 500), createdAt: now }],
    metadata: {
      approvalRef: sanitize(approvalEntry.id, 180),
      approvalStatus: valid ? 'rechecked_no_apply' : 'recheck_blocked_no_apply',
      recheckOutcome: assessment.outcome,
      reasonCodes: assessment.reasonCodes,
      approvedBinding: binding,
      currentCandidateId: currentCandidate ? sanitize(currentCandidate.id, 180) : '',
      currentRisk: currentCandidate ? sanitize(currentCandidate.risk, 80) : '',
      currentRiskDecision: currentCandidate ? sanitize(currentCandidate.metadata?.riskClassification?.decision, 120) : '',
      currentProtocolPosture: currentCandidate ? sanitize(currentCandidate.metadata?.highRiskProtocol?.posture, 120) : '',
      bindingMismatches: assessment.mismatches,
      applyAuthorityGranted: false,
      mutationAttempted: false,
      approvedForApply: false,
      requiresApplyHandler: true,
      requiredNextStep: valid ? 'future apply handler still required and must gate again' : 'new packet or operator review required',
      boundaries: [
        'pre-action recheck only',
        'no apply handler executed',
        'no claim mutation',
        'no prompt injection',
        'no scheduler linkage',
        'no runtime config mutation',
        'no runtime tool-policy mutation',
        'no broad memory promotion'
      ]
    }
  });
}

function assessHighRiskPreActionRecheck({ approvalEntry = {}, currentCandidate } = {}) {
  const binding = approvalEntry.metadata?.approvalBinding || {};
  const reasonCodes = [];
  const mismatches = [];
  if (!currentCandidate) {
    reasonCodes.push('current candidate missing');
    return { outcome: 'approval expired candidate missing', reasonCodes, mismatches };
  }
  const protocol = currentCandidate.metadata?.highRiskProtocol || {};
  const classification = currentCandidate.metadata?.riskClassification || {};
  compareBinding('candidateId', binding.candidateId, currentCandidate.id, mismatches);
  compareBinding('actionId', binding.actionId, protocol.actionId, mismatches);
  compareBinding('effectClass', binding.effectClass, protocol.effectClass, mismatches);
  compareTargetRefs(binding.targetRefs, protocol.targetRefs, mismatches);
  compareBinding('expiry', binding.expiry, protocol.expiry, mismatches);
  compareArrayBinding('requiredVerification', binding.requiredVerification, protocol.requiredVerification, mismatches);
  compareBinding('rollbackPlan', binding.rollbackPlan, protocol.rollbackPlan, mismatches);
  if (currentCandidate.risk !== 'high') reasonCodes.push('risk no longer high');
  if (classification.decision !== 'approval_required') reasonCodes.push(classification.blocked ? 'current classification blocked' : 'current classification not approval required');
  if (protocol.protocol !== 'high_risk_candidate' || protocol.posture !== 'approval_required') reasonCodes.push('current protocol not approval required');
  if (mismatches.length) reasonCodes.push('approval binding mismatch');
  if (reasonCodes.length) return { outcome: 'approval invalidated by recheck', reasonCodes: unique(reasonCodes), mismatches };
  return { outcome: 'current approval still gated', reasonCodes: ['still high risk approval required'], mismatches: [] };
}

function compareBinding(field, approved, current, mismatches) {
  if (String(approved || '') !== String(current || '')) mismatches.push({ field, approved: sanitize(approved, 240), current: sanitize(current, 240) });
}

function compareArrayBinding(field, approved = [], current = [], mismatches) {
  const a = Array.isArray(approved) ? approved.map(String) : [];
  const b = Array.isArray(current) ? current.map(String) : [];
  if (JSON.stringify(a) !== JSON.stringify(b)) mismatches.push({ field, approved: a.map((item) => sanitize(item, 160)).slice(0, 20), current: b.map((item) => sanitize(item, 160)).slice(0, 20) });
}

function compareTargetRefs(approved = {}, current = {}, mismatches) {
  compareBinding('targetRefs.display', approved.display, current.display, mismatches);
  compareBinding('targetRefs.internal', approved.internal, current.internal, mismatches);
}

function buildHighRiskExplicitApprovalEvent(packetEntry = {}, { now, note, approver } = {}) {
  const packet = packetEntry.metadata?.approvalPacket || {};
  const claimId = sanitize(packet.claimId || packetEntry.claimId, 160);
  const packetId = sanitize(packet.packetId || packetEntry.receiptId || packetEntry.id, 180);
  const approvalId = stableEventId({ action: 'high_risk_explicit_approval', claimId, receiptId: packetId, title: packet.actionId || 'high_risk_review_apply' });
  return normalizeEvolutionEvent({
    id: approvalId,
    class: packetEntry.class || EVOLUTION_CLASSES.CLAIM_REVIEW,
    title: `Explicit approval captured: ${sanitize(packetEntry.title || claimId || packetId, 120)}`,
    summary: 'Captured explicit approval for one bound high-risk packet. This records approval intent only; no claim mutation, prompt injection, scheduler linkage, runtime config/tool-policy mutation, broad memory promotion, or apply handler execution occurred.',
    status: 'held',
    risk: 'high',
    sourceCategory: packetEntry.sourceCategory || 'high-risk explicit approval',
    allowedBy: 'explicit_packet_approval_capture_only_no_apply_authority',
    expectedEffect: 'Binds human/operator approval to one packet id, candidate id, action id, effect class, target refs, expiry, verification plan, and rollback plan without granting apply authority.',
    verification: 'Approval receipt persisted; any future apply must reference this approval, re-run risk classification immediately, pass the Evolve pre-action gate, write before/after receipts, and expose rollback/recovery.',
    rollback: 'Revoke or supersede this approval receipt before any future apply path. No domain rollback is needed because no mutation occurred.',
    action: 'high_risk_explicit_approval',
    claimId,
    receiptId: approvalId,
    rollbackAction: null,
    createdAt: now,
    updatedAt: now,
    operatorActions: [{ action: 'record_high_risk_explicit_approval', status: 'held', note: sanitize(note, 500), createdAt: now }],
    metadata: {
      approvedPacketRef: sanitize(packetEntry.id, 180),
      approvedPacketId: packetId,
      approvalStatus: 'explicitly_approved_no_apply',
      approver: sanitize(approver || 'operator', 120),
      approvalCapturedAt: now,
      approvalText: buildApprovalText(packet),
      approvalBinding: sanitizeBindingObject({
        packetId,
        candidateId: packet.candidateId,
        actionId: packet.actionId,
        claimId: packet.claimId || packetEntry.claimId,
        effectClass: packet.effectClass,
        targetRefs: packet.targetRefs,
        expiry: packet.expiry,
        requiredVerification: packet.requiredVerification,
        rollbackPlan: packet.rollbackPlan
      }),
      applyAuthorityGranted: false,
      approvedForPreActionRecheckOnly: true,
      requiredNextStep: 'immediate_risk_reclassification_before_any_apply_handler',
      boundaries: [
        'approval capture only',
        'no apply handler executed',
        'no claim mutation',
        'no prompt injection',
        'no scheduler linkage',
        'no runtime config mutation',
        'no runtime tool-policy mutation',
        'no broad memory promotion'
      ]
    }
  });
}

function buildApprovalText(packet = {}) {
  const target = packet.targetRefs?.display || packet.targetRefs?.internal || packet.claimId || 'unknown target';
  return sanitize(`Approve packet ${packet.packetId || 'unknown packet'} for candidate ${packet.candidateId || 'unknown candidate'} action ${packet.actionId || 'unknown action'} on ${target}; effect ${packet.effectClass || 'unknown effect'}; expires/rechecks: ${packet.expiry || 'missing expiry'}; rollback: ${packet.rollbackPlan || 'missing rollback plan'}.`, 1000);
}

function buildHighRiskClaimMaturationApplyEvent(result = {}, { now, recheckEntry = {}, currentCandidate = {}, finalRecheck = {} } = {}) {
  const claimId = sanitize(result.claimId || recheckEntry.claimId, 160);
  const receiptId = sanitize(result.afterReceipt?.id, 180);
  const binding = recheckEntry.metadata?.approvedBinding || {};
  const title = `Applied approved high-risk claim maturation for ${claimId}`;
  const decisionLabel = sanitize(result.decision || 'review decision', 120).replace(/_/g, ' ');
  return normalizeEvolutionEvent({
    id: stableEventId({ action: 'high_risk_claim_apply', claimId, receiptId, title }),
    class: EVOLUTION_CLASSES.CLAIM_REVIEW,
    title,
    summary: `Applied one explicitly approved high-risk ${decisionLabel} after packet approval and immediate pre-action recheck. Status moved ${safeStatus(result.beforeStatus)} → ${safeStatus(result.afterStatus)} without prompt injection, scheduler linkage, runtime config/tool-policy mutation, or broad memory promotion.`,
    status: 'applied',
    risk: 'high',
    sourceCategory: 'approved high-risk claim maturation',
    allowedBy: 'explicit_packet_approval_plus_immediate_pre_action_recheck',
    expectedEffect: 'Matures one bounded claim-review candidate according to the approved packet while keeping the claim out of prompt injection and preserving rollback.',
    verification: receiptId ? `Before and after claim receipts recorded; final recheck outcome ${sanitize(finalRecheck.outcome || 'not recorded', 160)}; receipt ${receiptId} recorded.` : 'Before and after claim receipts recorded; rollback path required.',
    rollback: 'Use rollback_review_decision with the stored before receipt for this claim.',
    action: 'high_risk_claim_apply',
    claimId,
    receiptId,
    rollbackAction: {
      tool: 'continuity_claims',
      action: 'rollback_review_decision',
      claim_id: claimId,
      receipt_id: sanitize(result.beforeReceipt?.id, 180),
      apply: true
    },
    createdAt: now,
    updatedAt: now,
    operatorActions: [{ action: 'apply_high_risk_claim_maturation', status: 'applied', note: sanitize(result.reason || '', 500), createdAt: now }],
    metadata: {
      approvalRef: sanitize(recheckEntry.metadata?.approvalRef, 180),
      recheckRef: sanitize(recheckEntry.id, 180),
      approvedBinding: sanitizeObject(binding),
      currentCandidateId: currentCandidate ? sanitize(currentCandidate.id, 180) : '',
      currentRisk: currentCandidate ? sanitize(currentCandidate.risk, 80) : '',
      finalRecheckOutcome: sanitize(finalRecheck.outcome, 160),
      finalRecheckReasonCodes: Array.isArray(finalRecheck.reasonCodes) ? finalRecheck.reasonCodes.map((item) => sanitize(item, 160)).slice(0, 20) : [],
      beforeStatus: safeStatus(result.beforeStatus),
      afterStatus: safeStatus(result.afterStatus),
      decision: sanitize(result.decision, 80),
      authorizationMode: sanitize(result.authorizationMode, 80),
      beforeReceiptId: sanitize(result.beforeReceipt?.id, 180),
      afterReceiptId: receiptId,
      promptEligibilityChanged: result.promptInjectionEligibilityChanged === true,
      mutationAttempted: true,
      applyAuthorityGranted: true,
      authorityScope: 'single approved claim maturation receipt only',
      boundaries: [
        'single claim only',
        'explicit packet approval required',
        'immediate pre-action recheck required',
        'before and after receipts required',
        'rollback receipt available',
        'no prompt injection',
        'no scheduler linkage',
        'no runtime config mutation',
        'no runtime tool-policy mutation',
        'no broad memory promotion'
      ]
    }
  });
}

function buildHighRiskApprovalPacket(candidate = {}, { protocol = {}, now, note } = {}) {
  const candidateId = sanitizeBinding(protocol.candidateId || candidate.id, 180);
  const actionId = sanitizeBinding(protocol.actionId || 'high_risk_review_apply', 180);
  return sanitizeBindingObject({
    packetId: stableEventId({ action: 'high_risk_approval_packet_ref', claimId: candidate.claimId, receiptId: candidateId, title: actionId }),
    protocol: 'high_risk_candidate',
    approvalStatus: 'pending_explicit_approval',
    candidateId,
    actionId,
    claimId: candidate.claimId,
    effectClass: protocol.effectClass || 'claim_maturation',
    authorityRequired: protocol.authorityRequired || 'explicit_action_specific_user_or_operator_approval',
    targetRefs: protocol.targetRefs || { display: candidate.sourceCategory, internal: candidate.claimId },
    sourceRefs: Array.isArray(protocol.sourceRefs) ? protocol.sourceRefs.slice(0, 10) : [],
    expiry: protocol.expiry || 'recheck required immediately before apply',
    requiredPrechecks: protocol.requiredPrechecks || ['source_handle_review', 'risk_reclassification', 'rollback_plan_check', 'evolve_pre_action_gate'],
    requiredVerification: protocol.requiredVerification || ['before_receipt', 'after_receipt', 'claim_status_readback', 'rollback_path_visible'],
    rollbackPlan: protocol.rollbackPlan || 'domain-specific rollback receipt required before any apply',
    reasonCodes: Array.isArray(protocol.reasonCodes) ? protocol.reasonCodes.slice(0, 12) : [],
    preparedAt: now,
    note,
    applyAuthorityGranted: false,
    applyGate: 'closed_explicit_recheck'
  });
}

function toGuiEntry(event) {
  const safe = normalizeEvolutionEvent(event);
  const outcomePacket = createOutcomeEventPacketFromEvolutionEntry(safe);
  assertOutcomeEventPacket(outcomePacket);
  const outcomeLabels = outcomePacketLabels(outcomePacket);
  return {
    id: safe.id,
    class: safe.class,
    title: safe.title,
    summary: safe.summary,
    status: safe.status,
    risk: safe.risk,
    sourceCategory: safe.sourceCategory,
    allowedBy: safe.allowedBy,
    expectedEffect: safe.expectedEffect,
    verification: safe.verification,
    rollback: safe.rollback,
    createdAt: safe.createdAt,
    updatedAt: safe.updatedAt,
    action: safe.action,
    claimId: safe.claimId,
    receiptId: safe.receiptId,
    rollbackAction: safe.rollbackAction,
    metadata: {
      ...(safe.metadata || {}),
      spineOutcomePacket: outcomePacket,
      spineOutcomeLabels: outcomeLabels
    }
  };
}

function normalizeEvolutionEvent(input = {}) {
  const id = sanitize(input.id, 180) || stableEventId(input);
  const klass = ALLOWED_CLASSES.has(input.class) ? input.class : EVOLUTION_CLASSES.EMERGENCE_ARTIFACT;
  const risk = ALLOWED_RISKS.has(input.risk) ? input.risk : 'low';
  const status = ALLOWED_STATUSES.has(input.status) ? input.status : 'active';
  const now = new Date().toISOString();
  return {
    id,
    class: klass,
    title: sanitize(input.title, 180) || 'Autonomous evolution receipt',
    summary: sanitize(input.summary, 800),
    status,
    risk,
    sourceCategory: sanitize(input.sourceCategory, 240),
    allowedBy: sanitize(input.allowedBy, 400),
    expectedEffect: sanitize(input.expectedEffect, 500),
    verification: sanitize(input.verification, 500),
    rollback: sanitize(input.rollback, 500),
    action: sanitize(input.action, 120),
    claimId: sanitize(input.claimId, 180),
    receiptId: sanitize(input.receiptId, 180),
    rollbackAction: sanitizeObject(input.rollbackAction),
    operatorActions: Array.isArray(input.operatorActions) ? input.operatorActions.map(sanitizeObject).slice(0, 20) : [],
    metadata: sanitizeMetadata(input.metadata || {}),
    createdAt: sanitize(input.createdAt, 80) || now,
    updatedAt: sanitize(input.updatedAt, 80) || sanitize(input.createdAt, 80) || now
  };
}

function persistLedger(ledgerPath, ledger) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  writeJsonAtomic(ledgerPath, { version: LEDGER_VERSION, events: ledger.events.map(normalizeEvolutionEvent).filter(Boolean) });
}

function emptyLedger() {
  return { version: LEDGER_VERSION, events: [] };
}

function stableEventId(input = {}) {
  const basis = JSON.stringify({
    action: input.action || '',
    claimId: input.claimId || input.claim_id || '',
    receiptId: input.receiptId || input.receipt_id || '',
    title: input.title || '',
    createdAt: input.createdAt || ''
  });
  return `evo_${crypto.createHash('sha256').update(basis).digest('hex').slice(0, 16)}`;
}

function safeStatus(value) {
  return sanitize(value || 'unknown', 80);
}

function unique(items = []) {
  return [...new Set(items.filter(Boolean))];
}

function sanitizeObject(input, depth = 0) {
  if (depth > 3) return '[redacted-depth]';
  if (input === null || input === undefined) return input;
  if (Array.isArray(input)) return input.map((item) => sanitizeObject(item, depth + 1)).slice(0, 50);
  if (typeof input === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(input)) {
      const safeKey = sanitize(key, 80);
      if (!safeKey) continue;
      out[safeKey] = sanitizeObject(value, depth + 1);
    }
    return out;
  }
  return sanitize(input, 1000);
}

function sanitizeMetadata(input, depth = 0) {
  if (depth > 3) return '[redacted-depth]';
  if (input === null || input === undefined) return input;
  if (Array.isArray(input)) return input.map((item) => sanitizeMetadata(item, depth + 1)).slice(0, 50);
  if (typeof input === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(input)) {
      const safeKey = sanitize(key, 80);
      if (!safeKey) continue;
      out[safeKey] = isHighRiskBindingMetadataKey(safeKey)
        ? sanitizeBindingObject(value)
        : sanitizeMetadata(value, depth + 1);
    }
    return out;
  }
  return sanitize(input, 1000);
}

function isHighRiskBindingMetadataKey(key) {
  return ['approvalPacket', 'highRiskProtocol', 'approvalBinding', 'approvedBinding'].includes(key);
}

function sanitizeBindingObject(input, depth = 0, key = '') {
  if (depth > 3) return '[redacted-depth]';
  if (input === null || input === undefined) return input;
  if (Array.isArray(input)) return input.map((item) => sanitizeBindingObject(item, depth + 1, key)).slice(0, 50);
  if (typeof input === 'object') {
    const out = {};
    for (const [childKey, value] of Object.entries(input)) {
      const safeKey = sanitize(childKey, 80);
      if (!safeKey) continue;
      out[safeKey] = sanitizeBindingObject(value, depth + 1, safeKey);
    }
    return out;
  }
  if (key === 'note') return sanitize(input, 1000);
  return sanitizeBinding(input, 1000);
}

function sanitize(value, max = 1000) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  text = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  text = redactSensitive(text);
  if (text.length > max) text = `${text.slice(0, max - 1)}…`;
  return text;
}

function sanitizeBinding(value, max = 1000) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  text = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  text = redactSensitiveExceptOpaqueToken(text);
  if (text.length > max) text = `${text.slice(0, max - 1)}…`;
  return text;
}

function redactSensitive(text) {
  return text
    .replace(/\b[A-Za-z0-9_=-]{32,}\b/g, '[redacted-token]')
    .replace(/\/Users\/[^\s)]+/g, '[redacted-path]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-host]')
    .replace(/\bport\s+\d{2,5}\b/gi, 'port [redacted]');
}

function redactSensitiveExceptOpaqueToken(text) {
  return text
    .replace(/\/Users\/[^\s)]+/g, '[redacted-path]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-host]')
    .replace(/\bport\s+\d{2,5}\b/gi, 'port [redacted]');
}

module.exports = {
  LEDGER_VERSION,
  EVOLUTION_CLASSES,
  resolveEvolutionLedgerPath,
  candidateEvolutionLedgerPaths,
  readEvolutionLedger,
  listEvolutionEvents,
  appendEvolutionEvent,
  updateEvolutionEvent,
  applyEvolutionEventTransition,
  assertAutonomousWriteSafety,
  recordClaimReviewEvolution,
  recordCandidateReviewEvolution,
  recordHighRiskApprovalPacket,
  recordHighRiskPreflight,
  recordHighRiskExplicitApproval,
  recordHighRiskPreActionRecheck,
  recordHighRiskClaimMaturationApply,
  buildClaimReviewEvent,
  buildCandidateReviewEvent,
  buildHighRiskApprovalPacketEvent,
  buildHighRiskPreflightEvent,
  buildHighRiskExplicitApprovalEvent,
  buildHighRiskPreActionRecheckEvent,
  buildHighRiskClaimMaturationApplyEvent,
  assessHighRiskPreActionRecheck
};
