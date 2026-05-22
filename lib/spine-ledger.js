'use strict';

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./write-json-atomic');
const {
  PACKET_TYPES,
  createOutcomeEventPacket,
  createResponsibilityLeasePacket,
  createGovernorDecisionPacket,
  createContextEligibilityReview,
  createMaturationCandidatePacketFromOutcomeEvent,
  createMaturationCandidatePacketsFromOutcomeEvents,
  assertOutcomeEventPacket,
  assertResponsibilityLeasePacket,
  assertGovernorDecisionPacket,
  assertContextEligibilityReview,
  assertReadOnlyMaturationPacket
} = require('./agent-integration-spine');

const SPINE_LEDGER_VERSION = 1;
const TERMINAL_LEASE_STATUSES = new Set(['completed', 'expired', 'cancelled']);
const LEASE_STATUSES = new Set(['candidate', 'active', 'paused', 'completed', 'expired', 'cancelled']);

function resolveSpineLedgerPath({ workspacePath, pluginDataDir, agentId = 'trail-guide' } = {}) {
  if (workspacePath) return path.join(workspacePath, 'spine', 'ledger.json');
  if (pluginDataDir) return path.join(pluginDataDir, 'agents', agentId, 'spine-ledger.json');
  throw new Error('workspacePath or pluginDataDir is required');
}

function candidateSpineLedgerPaths({ workspacePath, pluginsPath, agentId = 'trail-guide' } = {}) {
  const paths = [];
  if (workspacePath) paths.push(resolveSpineLedgerPath({ workspacePath }));
  if (pluginsPath) {
    const continuityData = path.join(pluginsPath, 'openclaw-plugin-continuity', 'data');
    paths.push(resolveSpineLedgerPath({ pluginDataDir: continuityData, agentId }));
    paths.push(path.join(continuityData, 'spine-ledger.json'));
  }
  return Array.from(new Set(paths));
}

function readSpineLedger(ledgerPath) {
  if (!ledgerPath || !fs.existsSync(ledgerPath)) return emptyLedger();
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    return normalizeLedger(parsed);
  } catch {
    return emptyLedger();
  }
}

function appendOutcomeEventPacket(ledgerPath, packetOrInput, options = {}) {
  const packet = normalizeOutcomePacket(packetOrInput, options);
  assertOutcomeEventPacket(packet);
  const ledger = readSpineLedger(ledgerPath);
  if (ledger.outcomeEvents.some((event) => event.eventId === packet.eventId)) {
    throw new Error(`outcome_event already exists: ${packet.eventId}`);
  }
  ledger.outcomeEvents.push(packet);
  ledger.outcomeEvents.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  persistSpineLedger(ledgerPath, ledger);
  return packet;
}

function appendGovernorDecisionPacket(ledgerPath, packetOrInput, options = {}) {
  const packet = normalizeGovernorDecisionPacket(packetOrInput, options);
  assertGovernorDecisionPacket(packet);
  const ledger = readSpineLedger(ledgerPath);
  if (ledger.governorDecisions.some((decision) => decision.decisionId === packet.decisionId)) {
    throw new Error(`governor_decision already exists: ${packet.decisionId}`);
  }
  ledger.governorDecisions.push(packet);
  ledger.governorDecisions.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  persistSpineLedger(ledgerPath, ledger);
  return packet;
}

function appendContextEligibilityReview(ledgerPath, packetOrInput, options = {}) {
  const packet = normalizeContextEligibilityReview(packetOrInput, options);
  assertContextEligibilityReview(packet);
  const ledger = readSpineLedger(ledgerPath);
  if (ledger.contextEligibilityReviews.some((review) => review.reviewId === packet.reviewId)) {
    throw new Error(`context_eligibility_review already exists: ${packet.reviewId}`);
  }
  ledger.contextEligibilityReviews.push(packet);
  ledger.contextEligibilityReviews.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  persistSpineLedger(ledgerPath, ledger);
  return packet;
}


function appendMaturationCandidatePacket(ledgerPath, packetOrInput, options = {}) {
  const packet = normalizeMaturationCandidatePacket(packetOrInput, options);
  assertReadOnlyMaturationPacket(packet);
  const ledger = readSpineLedger(ledgerPath);
  if (ledger.maturationCandidates.some((candidate) => candidate.candidateId === packet.candidateId)) {
    throw new Error(`maturation_candidate already exists: ${packet.candidateId}`);
  }
  ledger.maturationCandidates.push(packet);
  ledger.maturationCandidates.sort((a, b) => String(b.createdAt || b.receipts?.createdByEvent || '').localeCompare(String(a.createdAt || a.receipts?.createdByEvent || '')));
  persistSpineLedger(ledgerPath, ledger);
  return packet;
}

function appendResponsibilityLeasePacket(ledgerPath, packetOrInput, options = {}) {
  const packet = normalizeResponsibilityLeasePacket(packetOrInput, options);
  assertResponsibilityLeasePacket(packet);
  const ledger = readSpineLedger(ledgerPath);
  if (ledger.responsibilityLeases.some((lease) => lease.leaseId === packet.leaseId)) {
    throw new Error(`responsibility_lease already exists: ${packet.leaseId}`);
  }
  ledger.responsibilityLeases.push(packet);
  ledger.responsibilityLeases.sort((a, b) => String(b.lifecycle?.createdAt || '').localeCompare(String(a.lifecycle?.createdAt || '')));
  persistSpineLedger(ledgerPath, ledger);
  return packet;
}

function updateResponsibilityLeaseStatus(ledgerPath, leaseId, nextStatus, options = {}) {
  const safeLeaseId = String(leaseId || '').trim();
  if (!safeLeaseId) throw new Error('leaseId is required');
  if (!LEASE_STATUSES.has(nextStatus)) throw new Error(`unsupported lease status: ${nextStatus}`);
  const ledger = readSpineLedger(ledgerPath);
  const idx = ledger.responsibilityLeases.findIndex((lease) => lease.leaseId === safeLeaseId);
  if (idx < 0) throw new Error(`responsibility_lease not found: ${safeLeaseId}`);
  const current = ledger.responsibilityLeases[idx];
  const currentStatus = current.lifecycle?.status || 'candidate';
  if (options.expectedStatus && currentStatus !== options.expectedStatus) {
    throw new Error(`responsibility_lease status mismatch: expected ${options.expectedStatus}, found ${currentStatus}`);
  }
  if (TERMINAL_LEASE_STATUSES.has(currentStatus) && nextStatus === 'active') {
    throw new Error(`responsibility_lease cannot silently reactivate from terminal status: ${currentStatus}`);
  }
  const updated = normalizeResponsibilityLeasePacket({
    ...current,
    lifecycle: {
      ...(current.lifecycle || {}),
      status: nextStatus,
      updatedAt: options.now || new Date().toISOString()
    },
    receipts: {
      ...(current.receipts || {}),
      completedByEvent: nextStatus === 'completed' ? (options.eventId || current.receipts?.completedByEvent || null) : current.receipts?.completedByEvent || null,
      interruptedByEvent: ['paused', 'expired', 'cancelled'].includes(nextStatus) ? (options.eventId || current.receipts?.interruptedByEvent || null) : current.receipts?.interruptedByEvent || null
    }
  });
  assertResponsibilityLeasePacket(updated);
  ledger.responsibilityLeases[idx] = updated;
  persistSpineLedger(ledgerPath, ledger);
  return updated;
}


function completeResponsibilityLeaseWithOutcome(ledgerPath, leaseId, packetOrInput, options = {}) {
  return recordResponsibilityLeaseOutcome(ledgerPath, leaseId, packetOrInput, 'completed', {
    ...options,
    expectedStatus: options.expectedStatus || 'active',
    defaultOutcomeStatus: options.defaultOutcomeStatus || 'verified'
  });
}

function interruptResponsibilityLeaseWithOutcome(ledgerPath, leaseId, packetOrInput, options = {}) {
  const nextStatus = options.nextStatus || 'paused';
  if (!['paused', 'expired', 'cancelled'].includes(nextStatus)) {
    throw new Error(`unsupported interruption lease status: ${nextStatus}`);
  }
  return recordResponsibilityLeaseOutcome(ledgerPath, leaseId, packetOrInput, nextStatus, {
    ...options,
    expectedStatus: options.expectedStatus || 'active',
    defaultOutcomeStatus: options.defaultOutcomeStatus || 'interrupted'
  });
}

function recordResponsibilityLeaseOutcome(ledgerPath, leaseId, packetOrInput, nextStatus, options = {}) {
  const safeLeaseId = String(leaseId || '').trim();
  if (!safeLeaseId) throw new Error('leaseId is required');
  if (!LEASE_STATUSES.has(nextStatus)) throw new Error(`unsupported lease status: ${nextStatus}`);
  const ledger = readSpineLedger(ledgerPath);
  const idx = ledger.responsibilityLeases.findIndex((lease) => lease.leaseId === safeLeaseId);
  if (idx < 0) throw new Error(`responsibility_lease not found: ${safeLeaseId}`);
  const current = ledger.responsibilityLeases[idx];
  const currentStatus = current.lifecycle?.status || 'candidate';
  if (options.expectedStatus && currentStatus !== options.expectedStatus) {
    throw new Error(`responsibility_lease status mismatch: expected ${options.expectedStatus}, found ${currentStatus}`);
  }
  if (TERMINAL_LEASE_STATUSES.has(currentStatus)) {
    throw new Error(`responsibility_lease already terminal: ${currentStatus}`);
  }

  const outcome = normalizeLeaseOutcomePacket(packetOrInput, safeLeaseId, options.defaultOutcomeStatus || 'observed', options);
  assertOutcomeEventPacket(outcome);
  if (ledger.outcomeEvents.some((event) => event.eventId === outcome.eventId)) {
    throw new Error(`outcome_event already exists: ${outcome.eventId}`);
  }

  const updated = normalizeResponsibilityLeasePacket({
    ...current,
    lifecycle: {
      ...(current.lifecycle || {}),
      status: nextStatus,
      updatedAt: options.now || new Date().toISOString()
    },
    receipts: {
      ...(current.receipts || {}),
      completedByEvent: nextStatus === 'completed' ? outcome.eventId : current.receipts?.completedByEvent || null,
      interruptedByEvent: ['paused', 'expired', 'cancelled'].includes(nextStatus) ? outcome.eventId : current.receipts?.interruptedByEvent || null
    }
  });
  assertResponsibilityLeasePacket(updated);

  ledger.outcomeEvents.push(outcome);
  ledger.outcomeEvents.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  ledger.responsibilityLeases[idx] = updated;
  persistSpineLedger(ledgerPath, ledger);
  return { outcome, lease: updated };
}


function getSpineLedgerSnapshot(pathsOrPath, options = {}) {
  const paths = Array.isArray(pathsOrPath) ? pathsOrPath : [pathsOrPath];
  const limit = Number.isInteger(options.limit) ? options.limit : 20;
  const aggregate = emptyLedger();
  const seen = {
    outcomeEvents: new Set(),
    governorDecisions: new Set(),
    contextEligibilityReviews: new Set(),
    maturationCandidates: new Set(),
    responsibilityLeases: new Set()
  };

  for (const ledgerPath of paths.filter(Boolean)) {
    const ledger = readSpineLedger(ledgerPath);
    for (const event of ledger.outcomeEvents) pushUnique(aggregate.outcomeEvents, event, seen.outcomeEvents, event.eventId);
    for (const decision of ledger.governorDecisions) pushUnique(aggregate.governorDecisions, decision, seen.governorDecisions, decision.decisionId);
    for (const review of ledger.contextEligibilityReviews) pushUnique(aggregate.contextEligibilityReviews, review, seen.contextEligibilityReviews, review.reviewId);
    for (const candidate of ledger.maturationCandidates) pushUnique(aggregate.maturationCandidates, candidate, seen.maturationCandidates, candidate.candidateId);
    for (const lease of ledger.responsibilityLeases) pushUnique(aggregate.responsibilityLeases, lease, seen.responsibilityLeases, lease.leaseId);
  }
  for (const eventInput of Array.isArray(options.outcomeEvents) ? options.outcomeEvents : []) {
    const event = normalizeOutcomePacket(eventInput);
    assertOutcomeEventPacket(event);
    pushUnique(aggregate.outcomeEvents, event, seen.outcomeEvents, event.eventId);
  }
  for (const decisionInput of Array.isArray(options.governorDecisions) ? options.governorDecisions : []) {
    const decision = normalizeGovernorDecisionPacket(decisionInput);
    assertGovernorDecisionPacket(decision);
    pushUnique(aggregate.governorDecisions, decision, seen.governorDecisions, decision.decisionId);
  }
  for (const candidateInput of Array.isArray(options.maturationCandidates) ? options.maturationCandidates : []) {
    const candidate = normalizeMaturationCandidatePacket(candidateInput);
    assertReadOnlyMaturationPacket(candidate);
    pushUnique(aggregate.maturationCandidates, candidate, seen.maturationCandidates, candidate.candidateId);
  }

  aggregate.outcomeEvents.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  aggregate.governorDecisions.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  aggregate.contextEligibilityReviews.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  aggregate.maturationCandidates.sort((a, b) => String(b.receipts?.createdByEvent || '').localeCompare(String(a.receipts?.createdByEvent || '')));
  aggregate.responsibilityLeases.sort((a, b) => String(b.lifecycle?.createdAt || '').localeCompare(String(a.lifecycle?.createdAt || '')));
  const activeResponsibilityLeases = aggregate.responsibilityLeases.filter((lease) => lease.lifecycle?.status === 'active' && leaseNotExpired(lease, options.now));
  const persistedCandidateRefs = new Set(aggregate.maturationCandidates.map((candidate) => `${candidate.recordRef?.type || ''}:${candidate.recordRef?.id || ''}`));
  const dryRunMaturationPreviews = createMaturationCandidatePacketsFromOutcomeEvents(aggregate.outcomeEvents)
    .filter((candidate) => !persistedCandidateRefs.has(`${candidate.recordRef?.type || ''}:${candidate.recordRef?.id || ''}`));

  return {
    live: true,
    readOnly: true,
    sanitized: true,
    counts: {
      outcomeEvents: aggregate.outcomeEvents.length,
      governorDecisions: aggregate.governorDecisions.length,
      contextEligibilityReviews: aggregate.contextEligibilityReviews.length,
      maturationCandidates: aggregate.maturationCandidates.length,
      dryRunMaturationPreviews: dryRunMaturationPreviews.length,
      shadowEnforcementReceipts: aggregate.outcomeEvents.filter((event) => event.eventType === 'shadow_enforcement_observed').length,
      responsibilityLeases: aggregate.responsibilityLeases.length,
      activeResponsibilityLeases: activeResponsibilityLeases.length
    },
    latest: {
      outcomeEvents: aggregate.outcomeEvents.slice(0, Math.max(0, limit)).map(sanitizeSpinePacketForReview),
      governorDecisions: aggregate.governorDecisions.slice(0, Math.max(0, limit)).map(sanitizeSpinePacketForReview),
      contextEligibilityReviews: aggregate.contextEligibilityReviews.slice(0, Math.max(0, limit)).map(sanitizeSpinePacketForReview),
      maturationCandidates: aggregate.maturationCandidates.slice(0, Math.max(0, limit)).map(sanitizeSpinePacketForReview),
      dryRunMaturationPreviews: dryRunMaturationPreviews.slice(0, Math.max(0, limit)).map(sanitizeSpinePacketForReview),
      responsibilityLeases: aggregate.responsibilityLeases.slice(0, Math.max(0, limit)).map(sanitizeSpinePacketForReview),
      activeResponsibilityLeases: activeResponsibilityLeases.slice(0, Math.max(0, limit)).map(sanitizeSpinePacketForReview)
    },
    policy: {
      reviewOnly: true,
      toolExecutionAuthorized: false,
      mutationAuthorized: false,
      promptInjectionAuthorized: false,
      schedulerAuthorized: false,
      dryRunOnly: true
    }
  };
}


function sanitizeSpinePacketForReview(packet = {}) {
  if (!packet || typeof packet !== 'object') return null;
  if (packet.packetType === PACKET_TYPES.OUTCOME_EVENT) return sanitizeOutcomeEventForReview(packet);
  if (packet.packetType === PACKET_TYPES.GOVERNOR_DECISION) return sanitizeGovernorDecisionForReview(packet);
  if (packet.packetType === 'context_eligibility_review') return sanitizeContextEligibilityReviewForReview(packet);
  if (packet.packetType === PACKET_TYPES.MATURATION_CANDIDATE) return sanitizeMaturationCandidateForReview(packet);
  if (packet.packetType === PACKET_TYPES.RESPONSIBILITY_LEASE) return sanitizeResponsibilityLeaseForReview(packet);
  return prunePacket({
    packetType: safeReviewString(packet.packetType || 'unknown'),
    packetVersion: packet.packetVersion || null,
    policy: sanitizePolicyForReview(packet.policy),
    invariants: sanitizeBooleanMap(packet.invariants)
  });
}

function sanitizeOutcomeEventForReview(packet) {
  return prunePacket({
    packetType: packet.packetType,
    packetVersion: packet.packetVersion,
    eventId: safeReviewString(packet.eventId),
    eventType: safeReviewString(packet.eventType),
    status: safeReviewString(packet.status),
    createdAt: safeReviewString(packet.createdAt),
    source: sanitizeSourceForReview(packet.source),
    intent: sanitizeSummaryRecord(packet.intent, ['title', 'summary', 'expectedEffect']),
    authority: sanitizeSummaryRecord(packet.authority, ['leaseId', 'governorDecisionId', 'authorizationMode', 'approvalRef']),
    action: sanitizeSummaryRecord(packet.action, ['action', 'class', 'claimId', 'lane', 'effect']),
    observed: sanitizeSummaryRecord(packet.observed, ['status', 'risk', 'sourceCategory', 'enforcementMode', 'wouldBlock', 'authorized']),
    verification: sanitizeVerificationForReview(packet.verification),
    rollback: sanitizeRollbackForReview(packet.rollback),
    learning: sanitizeSummaryRecord(packet.learning, ['eligibleForMaturation', 'suggestedLane', 'prohibitionReason']),
    policy: sanitizePolicyForReview(packet.policy),
    invariants: sanitizeBooleanMap(packet.invariants)
  });
}

function sanitizeGovernorDecisionForReview(packet) {
  return prunePacket({
    packetType: packet.packetType,
    packetVersion: packet.packetVersion,
    decisionId: safeReviewString(packet.decisionId),
    actionClass: safeReviewString(packet.actionClass),
    mode: safeReviewString(packet.mode),
    createdAt: safeReviewString(packet.createdAt),
    requestedAction: sanitizeSummaryRecord(packet.requestedAction, ['tool', 'action', 'class', 'kind', 'lane', 'effect']),
    authority: sanitizeSummaryRecord(packet.authority, ['hasCurrentInstruction', 'activeLeaseId', 'approvalRef', 'toolCapabilityPresent', 'recipientConfirmed', 'intentConfirmed']),
    risk: sanitizeSummaryRecord(packet.risk, ['externality', 'reversibility', 'sensitivity', 'behaviorShaping', 'mutableFacts']),
    checks: sanitizeChecksForReview(packet.checks),
    approval: sanitizeSummaryRecord(packet.approval, ['required', 'reason']),
    rollback: sanitizeRollbackForReview(packet.rollback),
    output: sanitizeSummaryRecord(packet.output, ['decisionOnly', 'toolExecutionAuthorized', 'mutationAuthorized', 'promptInjectionAuthorized', 'schedulerAuthorized']),
    receipts: sanitizeSummaryRecord(packet.receipts, ['outcomeEventRequired', 'outcomeEventId']),
    reasonCodes: sanitizeStringArray(packet.reasonCodes),
    policy: sanitizePolicyForReview(packet.policy),
    invariants: sanitizeBooleanMap(packet.invariants)
  });
}

function sanitizeContextEligibilityReviewForReview(packet) {
  return prunePacket({
    packetType: packet.packetType,
    packetVersion: packet.packetVersion,
    reviewId: safeReviewString(packet.reviewId),
    createdAt: safeReviewString(packet.createdAt),
    target: sanitizeSummaryRecord(packet.target, ['packetType', 'recordId', 'requestedConsumer']),
    mode: safeReviewString(packet.mode),
    checks: sanitizeChecksForReview(packet.checks),
    authority: sanitizeSummaryRecord(packet.authority, ['hasExplicitContextApproval', 'activeLeaseId']),
    output: sanitizeSummaryRecord(packet.output, ['reviewOnly', 'contextInjectionAuthorized', 'promptMutationAuthorized', 'memoryPromotionAuthorized']),
    reasonCodes: sanitizeStringArray(packet.reasonCodes),
    policy: sanitizePolicyForReview(packet.policy)
  });
}


function sanitizeMaturationCandidateForReview(packet) {
  return prunePacket({
    packetType: packet.packetType,
    packetVersion: packet.packetVersion,
    candidateId: safeReviewString(packet.candidateId),
    recordRef: sanitizeSummaryRecord(packet.recordRef, ['type', 'id']),
    lane: safeReviewString(packet.lane),
    decision: safeReviewString(packet.decision),
    source: sanitizeSourceForReview(packet.source),
    lifecycle: sanitizeSummaryRecord(packet.lifecycle, ['status', 'freshnessClass', 'expiresAt']),
    policy: sanitizePolicyForReview(packet.policy),
    review: sanitizeSummaryRecord(packet.review, ['risk', 'reasonCodes', 'sensitivityFlags', 'scopeFlags', 'requiredChecks']),
    effects: sanitizeSummaryRecord(packet.effects, ['dryRun', 'eligibleForApply', 'eligibleForMinimalContext', 'mutationAttempted', 'promptInjectionEligibilityChanged']),
    receipts: sanitizeSummaryRecord(packet.receipts, ['createdByEvent', 'verifiedByEvent', 'appliedByEvent', 'rollbackRef']),
    invariants: sanitizeBooleanMap(packet.invariants)
  });
}

function sanitizeResponsibilityLeaseForReview(packet) {
  return prunePacket({
    packetType: packet.packetType,
    packetVersion: packet.packetVersion,
    leaseId: safeReviewString(packet.leaseId),
    owner: safeReviewString(packet.owner),
    executor: safeReviewString(packet.executor),
    objective: safeReviewString(packet.objective),
    lifecycle: sanitizeSummaryRecord(packet.lifecycle, ['status', 'createdAt', 'expiresAt', 'renewalPolicy', 'updatedAt']),
    authority: sanitizeSummaryRecord(packet.authority, ['sourceType', 'allowedActions', 'prohibitedActions', 'approvalRequiredFor']),
    successCriteria: sanitizeStringArray(packet.successCriteria),
    nonGoals: sanitizeStringArray(packet.nonGoals),
    consumers: sanitizeConsumersForReview(packet.consumers),
    receipts: sanitizeSummaryRecord(packet.receipts, ['createdByEvent', 'completedByEvent', 'interruptedByEvent', 'rollbackRef']),
    invariants: sanitizeBooleanMap(packet.invariants)
  });
}

function sanitizeSourceForReview(source = {}) {
  return sanitizeSummaryRecord(source, ['sourceType', 'sourceHandle', 'evidenceClass', 'sourceResolutionStatus']);
}

function sanitizeVerificationForReview(verification = {}) {
  return sanitizeSummaryRecord(verification, ['status', 'method']);
}

function sanitizeRollbackForReview(rollback = {}) {
  return sanitizeSummaryRecord(rollback, ['required', 'available', 'ref']);
}

function sanitizeChecksForReview(checks = {}) {
  return sanitizeSummaryRecord(checks, ['required', 'completed', 'missing']);
}

function sanitizePolicyForReview(policy = {}) {
  return sanitizeSummaryRecord(policy, ['allowedConsumers', 'prohibitedConsumers', 'privacyTier', 'promptInjectionRisk', 'mutationPolicy', 'approvalRequired']);
}

function sanitizeConsumersForReview(consumers = {}) {
  return sanitizeSummaryRecord(consumers, ['allowed', 'prohibited']);
}

function sanitizeSummaryRecord(input = {}, allowedKeys = []) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  for (const key of allowedKeys) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    out[key] = sanitizeReviewValue(input[key]);
  }
  return prunePacket(out);
}

function sanitizeReviewValue(value) {
  if (Array.isArray(value)) return sanitizeStringArray(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return safeReviewString(value);
  if (value == null) return null;
  return null;
}

function sanitizeStringArray(value) {
  const items = Array.isArray(value) ? value : (value == null ? [] : [value]);
  return items.map(safeReviewString).filter(Boolean).slice(0, 50);
}

function sanitizeBooleanMap(input = {}) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'boolean') out[safeReviewString(key)] = value;
  }
  return out;
}

function safeReviewString(value) {
  if (value == null) return null;
  return String(value).replace(/[\r\n\t]+/g, ' ').slice(0, 500);
}

function prunePacket(input = {}) {
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      out[key] = value;
    } else if (typeof value === 'object') {
      const nested = prunePacket(value);
      if (Object.keys(nested).length) out[key] = nested;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function pushUnique(target, packet, seen, id) {
  if (!id || seen.has(id)) return;
  seen.add(id);
  target.push(packet);
}

function leaseNotExpired(lease, nowValue) {
  const expiresAt = lease.lifecycle?.expiresAt;
  if (!expiresAt) return true;
  const now = nowValue ? new Date(nowValue) : new Date();
  const expiry = new Date(expiresAt);
  if (Number.isNaN(expiry.getTime())) return false;
  return expiry > now;
}

function listGovernorDecisionPackets(ledgerPath, options = {}) {
  const ledger = readSpineLedger(ledgerPath);
  let decisions = ledger.governorDecisions;
  if (options.mode) decisions = decisions.filter((decision) => decision.mode === options.mode);
  if (options.actionClass) decisions = decisions.filter((decision) => decision.actionClass === options.actionClass);
  const limit = Number.isInteger(options.limit) ? options.limit : decisions.length;
  return decisions.slice(0, Math.max(0, limit));
}

function listContextEligibilityReviews(ledgerPath, options = {}) {
  const ledger = readSpineLedger(ledgerPath);
  let reviews = ledger.contextEligibilityReviews;
  if (options.mode) reviews = reviews.filter((review) => review.mode === options.mode);
  if (options.targetPacketType) reviews = reviews.filter((review) => review.target?.packetType === options.targetPacketType);
  const limit = Number.isInteger(options.limit) ? options.limit : reviews.length;
  return reviews.slice(0, Math.max(0, limit));
}

function listOutcomeEventPackets(ledgerPath, options = {}) {
  const ledger = readSpineLedger(ledgerPath);
  const limit = Number.isInteger(options.limit) ? options.limit : ledger.outcomeEvents.length;
  return ledger.outcomeEvents.slice(0, Math.max(0, limit));
}


function listMaturationCandidatePackets(ledgerPath, options = {}) {
  const ledger = readSpineLedger(ledgerPath);
  let candidates = ledger.maturationCandidates;
  if (options.lane) candidates = candidates.filter((candidate) => candidate.lane === options.lane);
  const limit = Number.isInteger(options.limit) ? options.limit : candidates.length;
  return candidates.slice(0, Math.max(0, limit));
}

function listResponsibilityLeasePackets(ledgerPath, options = {}) {
  const ledger = readSpineLedger(ledgerPath);
  let leases = ledger.responsibilityLeases;
  if (options.status) leases = leases.filter((lease) => lease.lifecycle?.status === options.status);
  const limit = Number.isInteger(options.limit) ? options.limit : leases.length;
  return leases.slice(0, Math.max(0, limit));
}

function listActiveResponsibilityLeases(ledgerPath, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  return listResponsibilityLeasePackets(ledgerPath, { status: 'active' }).filter((lease) => leaseNotExpired(lease, now));
}

function normalizeLedger(input = {}) {
  const outcomeEvents = Array.isArray(input.outcomeEvents)
    ? input.outcomeEvents.map((event) => normalizeOutcomePacket(event)).filter(Boolean)
    : [];
  const governorDecisions = Array.isArray(input.governorDecisions)
    ? input.governorDecisions.map((decision) => normalizeGovernorDecisionPacket(decision)).filter(Boolean)
    : [];
  const contextEligibilityReviews = Array.isArray(input.contextEligibilityReviews)
    ? input.contextEligibilityReviews.map((review) => normalizeContextEligibilityReview(review)).filter(Boolean)
    : [];
  const maturationCandidates = Array.isArray(input.maturationCandidates)
    ? input.maturationCandidates.map((candidate) => normalizeMaturationCandidatePacket(candidate)).filter(Boolean)
    : [];
  const responsibilityLeases = Array.isArray(input.responsibilityLeases)
    ? input.responsibilityLeases.map((lease) => normalizeResponsibilityLeasePacket(lease)).filter(Boolean)
    : [];
  return {
    version: input.version || SPINE_LEDGER_VERSION,
    outcomeEvents,
    governorDecisions,
    contextEligibilityReviews,
    maturationCandidates,
    responsibilityLeases
  };
}

function persistSpineLedger(ledgerPath, ledger) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  writeJsonAtomic(ledgerPath, normalizeLedger(ledger));
  return ledgerPath;
}


function normalizeLeaseOutcomePacket(input = {}, leaseId, defaultStatus, options = {}) {
  const authority = { ...(input.authority || {}), leaseId: input.authority?.leaseId || leaseId };
  const merged = {
    ...input,
    status: input.status || defaultStatus,
    authority,
    createdAt: input.createdAt || options.now || null
  };
  if (input.packetType === PACKET_TYPES.OUTCOME_EVENT) {
    return {
      ...input,
      status: input.status || defaultStatus,
      authority,
      createdAt: input.createdAt || options.now || null
    };
  }
  return normalizeOutcomePacket(merged, options);
}

function normalizeOutcomePacket(input = {}, options = {}) {
  if (input.packetType === PACKET_TYPES.OUTCOME_EVENT) return input;
  return createOutcomeEventPacket({ ...input, createdAt: input.createdAt || options.now || null });
}

function normalizeGovernorDecisionPacket(input = {}, options = {}) {
  if (input.packetType === PACKET_TYPES.GOVERNOR_DECISION) return input;
  return createGovernorDecisionPacket({ ...input, createdAt: input.createdAt || options.now || null });
}

function normalizeContextEligibilityReview(input = {}, options = {}) {
  if (input.packetType === 'context_eligibility_review') return input;
  return createContextEligibilityReview({ ...input, createdAt: input.createdAt || options.now || null });
}


function normalizeMaturationCandidatePacket(input = {}, options = {}) {
  if (input.packetType === PACKET_TYPES.MATURATION_CANDIDATE) return input;
  return createMaturationCandidatePacketFromOutcomeEvent(input, options);
}

function normalizeResponsibilityLeasePacket(input = {}, options = {}) {
  if (input.packetType === PACKET_TYPES.RESPONSIBILITY_LEASE) return input;
  return createResponsibilityLeasePacket({ ...input, createdAt: input.createdAt || options.now || null });
}

function emptyLedger() {
  return { version: SPINE_LEDGER_VERSION, outcomeEvents: [], governorDecisions: [], contextEligibilityReviews: [], maturationCandidates: [], responsibilityLeases: [] };
}

module.exports = {
  SPINE_LEDGER_VERSION,
  resolveSpineLedgerPath,
  candidateSpineLedgerPaths,
  readSpineLedger,
  appendOutcomeEventPacket,
  appendGovernorDecisionPacket,
  appendContextEligibilityReview,
  appendMaturationCandidatePacket,
  appendResponsibilityLeasePacket,
  completeResponsibilityLeaseWithOutcome,
  interruptResponsibilityLeaseWithOutcome,
  updateResponsibilityLeaseStatus,
  getSpineLedgerSnapshot,
  sanitizeSpinePacketForReview,
  listOutcomeEventPackets,
  listGovernorDecisionPackets,
  listContextEligibilityReviews,
  listMaturationCandidatePackets,
  listResponsibilityLeasePackets,
  listActiveResponsibilityLeases
};
