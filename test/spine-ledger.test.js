const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  PACKET_TYPES,
  ACTION_CLASSES,
  GOVERNOR_MODES,
  MATURATION_LANES,
  CONTEXT_ELIGIBILITY_MODES,
  createOutcomeEventPacket,
  createResponsibilityLeasePacket,
  createGovernorDecisionPacket,
  createContextEligibilityReview
} = require('../lib/agent-integration-spine');
const {
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
  listOutcomeEventPackets,
  listGovernorDecisionPackets,
  listContextEligibilityReviews,
  listMaturationCandidatePackets,
  listResponsibilityLeasePackets,
  listActiveResponsibilityLeases,
  compactSpineLedgerFile
} = require('../lib/spine-ledger');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spine-ledger-'));
}

function tmpLedgerPath() {
  return path.join(tmpDir(), 'spine-ledger.json');
}

test('resolveSpineLedgerPath supports workspace and plugin data locations', () => {
  const root = tmpDir();
  assert.equal(resolveSpineLedgerPath({ workspacePath: root }), path.join(root, 'spine', 'ledger.json'));
  assert.equal(
    resolveSpineLedgerPath({ pluginDataDir: path.join(root, 'data'), agentId: 'trail-guide' }),
    path.join(root, 'data', 'agents', 'trail-guide', 'spine-ledger.json')
  );
});

test('appendOutcomeEventPacket persists append-only outcome events', () => {
  const ledgerPath = tmpLedgerPath();
  const packet = appendOutcomeEventPacket(ledgerPath, createOutcomeEventPacket({
    eventId: 'outcome-test-1',
    eventType: 'test_run',
    status: 'verified',
    action: { command: 'node --test' },
    observed: { result: 'pass' },
    verification: { status: 'verified', method: 'node:test' },
    learning: { eligibleForMaturation: false, prohibitionReason: 'single run' },
    createdAt: '2026-05-09T14:00:00.000Z'
  }));

  assert.equal(packet.packetType, PACKET_TYPES.OUTCOME_EVENT);
  const events = listOutcomeEventPackets(ledgerPath);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventId, 'outcome-test-1');
  assert.equal(events[0].policy.promptInjectionRisk, 'blocked');
  assert.throws(() => appendOutcomeEventPacket(ledgerPath, packet), /already exists/);
});

test('appendGovernorDecisionPacket persists preflight receipts without authorizing execution', () => {
  const ledgerPath = tmpLedgerPath();
  const packet = appendGovernorDecisionPacket(ledgerPath, createGovernorDecisionPacket({
    decisionId: 'gov-local-edit-ledger-1',
    actionClass: ACTION_CLASSES.LOCAL_PROJECT_EDIT,
    requestedAction: { tool: 'edit', path: 'project/file.md' },
    authority: { hasCurrentInstruction: true, toolCapabilityPresent: true },
    createdAt: '2026-05-09T14:05:00.000Z'
  }));

  assert.equal(packet.packetType, PACKET_TYPES.GOVERNOR_DECISION);
  assert.equal(packet.mode, GOVERNOR_MODES.PROCEED_WITH_VERIFICATION);
  assert.equal(packet.output.toolExecutionAuthorized, false);
  assert.equal(packet.output.mutationAuthorized, false);
  assert.equal(packet.output.promptInjectionAuthorized, false);
  const decisions = listGovernorDecisionPackets(ledgerPath);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].decisionId, 'gov-local-edit-ledger-1');
  assert.equal(decisions[0].policy.promptInjectionRisk, 'blocked');
  assert.throws(() => appendGovernorDecisionPacket(ledgerPath, packet), /already exists/);
});

test('stored governor decisions can be filtered but still do not create leases or outcomes', () => {
  const ledgerPath = tmpLedgerPath();
  appendGovernorDecisionPacket(ledgerPath, {
    decisionId: 'gov-message-ledger-1',
    actionClass: ACTION_CLASSES.EXTERNAL_MESSAGE,
    authority: { hasCurrentInstruction: true, toolCapabilityPresent: true }
  });
  appendGovernorDecisionPacket(ledgerPath, {
    decisionId: 'gov-claim-ledger-1',
    actionClass: ACTION_CLASSES.CLAIM_MATURATION,
    authority: { hasCurrentInstruction: true }
  });

  assert.equal(listGovernorDecisionPackets(ledgerPath, { actionClass: ACTION_CLASSES.EXTERNAL_MESSAGE }).length, 1);
  assert.equal(listGovernorDecisionPackets(ledgerPath, { mode: GOVERNOR_MODES.DEFER_OR_DRY_RUN }).length, 1);
  const ledger = readSpineLedger(ledgerPath);
  assert.equal(ledger.governorDecisions.length, 2);
  assert.equal(ledger.outcomeEvents.length, 0);
  assert.equal(ledger.responsibilityLeases.length, 0);
});

test('appendContextEligibilityReview persists review-only context decisions', () => {
  const ledgerPath = tmpLedgerPath();
  const review = appendContextEligibilityReview(ledgerPath, createContextEligibilityReview({
    reviewId: 'ctx-ledger-1',
    packet: createOutcomeEventPacket({
      eventId: 'outcome-context-blocked',
      status: 'verified',
      observed: { result: 'pass' },
      verification: { status: 'verified', method: 'unit test' }
    }),
    authority: { hasExplicitContextApproval: true },
    createdAt: '2026-05-09T14:15:00.000Z'
  }));

  assert.equal(review.packetType, 'context_eligibility_review');
  assert.equal(review.mode, 'blocked');
  assert.equal(review.output.contextInjectionAuthorized, false);
  assert.equal(review.output.promptMutationAuthorized, false);
  const reviews = listContextEligibilityReviews(ledgerPath);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].reviewId, 'ctx-ledger-1');
  assert.throws(() => appendContextEligibilityReview(ledgerPath, review), /already exists/);
});

test('stored context eligibility reviews are filterable but do not create outcomes or leases', () => {
  const ledgerPath = tmpLedgerPath();
  appendContextEligibilityReview(ledgerPath, {
    reviewId: 'ctx-ledger-blocked-1',
    packet: createGovernorDecisionPacket({
      decisionId: 'gov-for-context-review',
      actionClass: ACTION_CLASSES.LOCAL_PROJECT_EDIT,
      authority: { hasCurrentInstruction: true }
    })
  });
  appendContextEligibilityReview(ledgerPath, {
    reviewId: 'ctx-ledger-review-1',
    requestedConsumer: 'recall_search'
  });

  assert.equal(listContextEligibilityReviews(ledgerPath, { mode: 'blocked' }).length, 1);
  assert.equal(listContextEligibilityReviews(ledgerPath, { targetPacketType: PACKET_TYPES.GOVERNOR_DECISION }).length, 1);
  const ledger = readSpineLedger(ledgerPath);
  assert.equal(ledger.contextEligibilityReviews.length, 2);
  assert.equal(ledger.outcomeEvents.length, 0);
  assert.equal(ledger.responsibilityLeases.length, 0);
});

test('outcome success does not create or authorize a responsibility lease', () => {
  const ledgerPath = tmpLedgerPath();
  appendOutcomeEventPacket(ledgerPath, {
    eventId: 'outcome-success-only',
    status: 'verified',
    observed: { result: 'pass' },
    verification: { status: 'verified', method: 'unit test' },
    learning: { eligibleForMaturation: true, suggestedLane: 'diagnostics_only' }
  });

  assert.equal(listOutcomeEventPackets(ledgerPath).length, 1);
  assert.deepEqual(listActiveResponsibilityLeases(ledgerPath), []);
  const ledger = readSpineLedger(ledgerPath);
  assert.equal(ledger.responsibilityLeases.length, 0);
});

test('candidateSpineLedgerPaths supports workspace and plugin data locations', () => {
  const root = tmpDir();
  const paths = candidateSpineLedgerPaths({ workspacePath: root, pluginsPath: path.join(root, 'plugins'), agentId: 'trail-guide' });
  assert.ok(paths.some((candidate) => candidate.endsWith(path.join('spine', 'ledger.json'))));
  assert.ok(paths.some((candidate) => candidate.endsWith(path.join('agents', 'trail-guide', 'spine-ledger.json'))));
  assert.ok(paths.some((candidate) => candidate.endsWith(path.join('data', 'spine-ledger.json'))));
});

test('getSpineLedgerSnapshot returns read-only aggregate review surface', () => {
  const ledgerPath = tmpLedgerPath();
  appendOutcomeEventPacket(ledgerPath, {
    eventId: 'outcome-snapshot-1',
    status: 'verified',
    verification: { status: 'verified', method: 'unit test' },
    createdAt: '2026-05-09T14:30:00.000Z'
  });
  appendGovernorDecisionPacket(ledgerPath, {
    decisionId: 'gov-snapshot-1',
    actionClass: ACTION_CLASSES.LOCAL_PROJECT_EDIT,
    authority: { hasCurrentInstruction: true },
    createdAt: '2026-05-09T14:31:00.000Z'
  });
  appendContextEligibilityReview(ledgerPath, {
    reviewId: 'ctx-snapshot-1',
    mode: CONTEXT_ELIGIBILITY_MODES.BLOCKED,
    packet: createOutcomeEventPacket({ eventId: 'outcome-snapshot-context-source' }),
    createdAt: '2026-05-09T14:32:00.000Z'
  });
  appendResponsibilityLeasePacket(ledgerPath, {
    leaseId: 'lease-snapshot-active',
    objective: 'Visible active lease.',
    status: 'active',
    expiresAt: '2026-05-09T15:00:00.000Z',
    createdAt: '2026-05-09T14:33:00.000Z'
  });
  appendOutcomeEventPacket(ledgerPath, {
    eventId: 'outcome-snapshot-learning-preview',
    status: 'verified',
    verification: { status: 'verified', method: 'unit test' },
    learning: { eligibleForMaturation: true, suggestedLane: MATURATION_LANES.PROCEDURAL_LEARNING },
    createdAt: '2026-05-09T14:34:00.000Z'
  });

  const snapshot = getSpineLedgerSnapshot(ledgerPath, { now: '2026-05-09T14:40:00.000Z' });
  assert.equal(snapshot.live, true);
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.counts.outcomeEvents, 2);
  assert.equal(snapshot.counts.governorDecisions, 1);
  assert.equal(snapshot.counts.contextEligibilityReviews, 1);
  assert.equal(snapshot.counts.maturationCandidates, 0);
  assert.equal(snapshot.counts.dryRunMaturationPreviews, 1);
  assert.equal(snapshot.counts.responsibilityLeases, 1);
  assert.equal(snapshot.counts.activeResponsibilityLeases, 1);
  assert.equal(snapshot.latest.governorDecisions[0].decisionId, 'gov-snapshot-1');
  assert.equal(snapshot.latest.dryRunMaturationPreviews[0].recordRef.id, 'outcome-snapshot-learning-preview');
  assert.equal(snapshot.latest.dryRunMaturationPreviews[0].effects.eligibleForApply, false);
  assert.deepEqual(snapshot.policy, {
    reviewOnly: true,
    toolExecutionAuthorized: false,
    mutationAuthorized: false,
    promptInjectionAuthorized: false,
    schedulerAuthorized: false,
    dryRunOnly: true
  });
});

test('getSpineLedgerSnapshot sanitizes packets for the UI/API boundary', () => {
  const ledgerPath = tmpLedgerPath();
  const outcome = createOutcomeEventPacket({
    eventId: 'outcome-sanitize-1',
    eventType: 'test_run',
    status: 'verified',
    source: { sourceType: 'tool_result', sourceHandle: 'safe-handle', evidenceClass: 'derived' },
    action: { action: 'test', class: 'local_project_edit', command: 'SECRET_COMMAND_SHOULD_NOT_LEAK' },
    observed: { status: 'pass', result: 'SECRET_RAW_SOURCE' },
    verification: { status: 'verified', method: 'unit test', evidence: { rawText: 'SECRET_EVIDENCE_TEXT' } },
    rollback: { available: true, ref: 'rollback-safe-ref', plan: 'SECRET_ROLLBACK_PLAN' }
  });
  outcome.source.rawSourceText = 'SECRET_RAW_SOURCE_TEXT';
  outcome.internal = { prompt: 'SECRET_SYSTEM_PROMPT' };
  appendOutcomeEventPacket(ledgerPath, outcome);

  const decision = createGovernorDecisionPacket({
    decisionId: 'gov-sanitize-1',
    actionClass: ACTION_CLASSES.LOCAL_PROJECT_EDIT,
    requestedAction: {
      tool: 'edit',
      path: '/private/path/SHOULD_NOT_LEAK',
      prompt: 'SECRET_PROMPT_SHOULD_NOT_LEAK',
      args: { raw: 'SECRET_ARGS' }
    },
    authority: { hasCurrentInstruction: true, source: 'SECRET_AUTHORITY_SOURCE' },
    verification: { completed: ['read_before_write'] },
    rollback: { required: true, plan: 'SECRET_ROLLBACK_PLAN' }
  });
  decision.selfState.internalVector = 'SECRET_SELF_STATE_VECTOR';
  appendGovernorDecisionPacket(ledgerPath, decision);

  const snapshot = getSpineLedgerSnapshot(ledgerPath);
  assert.equal(snapshot.sanitized, true);
  assert.equal(snapshot.latest.outcomeEvents[0].eventId, 'outcome-sanitize-1');
  assert.equal(snapshot.latest.outcomeEvents[0].source.sourceHandle, 'safe-handle');
  assert.equal(snapshot.latest.governorDecisions[0].requestedAction.tool, 'edit');
  assert.equal(snapshot.latest.governorDecisions[0].requestedAction.path, undefined);
  assert.equal(snapshot.latest.governorDecisions[0].selfState, undefined);

  const rendered = JSON.stringify(snapshot);
  assert.doesNotMatch(rendered, /SECRET_/);
  assert.doesNotMatch(rendered, /rawSourceText|SECRET_EVIDENCE_TEXT|SECRET_COMMAND_SHOULD_NOT_LEAK|SECRET_PROMPT_SHOULD_NOT_LEAK|SECRET_ARGS|internalVector|private\/path/);
});


test('appendMaturationCandidatePacket stores read-only candidates from outcomes', () => {
  const ledgerPath = tmpLedgerPath();
  const outcome = appendOutcomeEventPacket(ledgerPath, createOutcomeEventPacket({
    eventId: 'outcome-maturation-source-1',
    status: 'verified',
    verification: { status: 'verified', method: 'unit test' },
    learning: { eligibleForMaturation: true, suggestedLane: MATURATION_LANES.SEMANTIC_MEMORY },
    createdAt: '2026-05-09T14:35:00.000Z'
  }));

  const candidate = appendMaturationCandidatePacket(ledgerPath, outcome);

  assert.equal(candidate.packetType, PACKET_TYPES.MATURATION_CANDIDATE);
  assert.equal(candidate.recordRef.id, 'outcome-maturation-source-1');
  assert.equal(candidate.lane, MATURATION_LANES.SEMANTIC_MEMORY);
  assert.equal(candidate.effects.eligibleForApply, false);
  assert.equal(candidate.policy.promptInjectionRisk, 'blocked');
  assert.equal(candidate.policy.mutationPolicy, 'none');
  assert.equal(listMaturationCandidatePackets(ledgerPath).length, 1);
  assert.throws(() => appendMaturationCandidatePacket(ledgerPath, candidate), /already exists/);
});

test('stored maturation candidates are filterable and do not authorize effects', () => {
  const ledgerPath = tmpLedgerPath();
  appendMaturationCandidatePacket(ledgerPath, createOutcomeEventPacket({
    eventId: 'outcome-procedural-candidate',
    status: 'verified',
    learning: { eligibleForMaturation: true, suggestedLane: MATURATION_LANES.PROCEDURAL_LEARNING }
  }));
  appendMaturationCandidatePacket(ledgerPath, createOutcomeEventPacket({
    eventId: 'outcome-context-candidate',
    status: 'verified',
    learning: { eligibleForMaturation: true, suggestedLane: MATURATION_LANES.CONTEXT_ELIGIBILITY }
  }));

  assert.equal(listMaturationCandidatePackets(ledgerPath, { lane: MATURATION_LANES.PROCEDURAL_LEARNING }).length, 1);
  const ledger = readSpineLedger(ledgerPath);
  assert.equal(ledger.maturationCandidates.length, 2);
  assert.equal(ledger.outcomeEvents.length, 0);
  assert.equal(ledger.responsibilityLeases.length, 0);
  assert.ok(ledger.maturationCandidates.every((candidate) => candidate.effects.eligibleForApply === false));
  assert.ok(ledger.maturationCandidates.every((candidate) => candidate.policy.promptInjectionRisk === 'blocked'));
});



test('snapshot can include live read-only adapter packets without persisting them', () => {
  const ledgerPath = tmpLedgerPath();
  const outcome = createOutcomeEventPacket({
    eventId: 'outcome-live-adapter-1',
    status: 'verified',
    verification: { status: 'verified', method: 'adapter test' },
    learning: { eligibleForMaturation: true, suggestedLane: MATURATION_LANES.SEMANTIC_MEMORY }
  });
  const candidate = appendMaturationCandidatePacket(tmpLedgerPath(), outcome);
  const governorDecision = createGovernorDecisionPacket({
    decisionId: 'gov-live-adapter-1',
    actionClass: ACTION_CLASSES.CONTEXT_ELIGIBILITY,
    authority: { hasCurrentInstruction: true },
    createdAt: '2026-05-09T14:40:00.000Z'
  });

  const snapshot = getSpineLedgerSnapshot(ledgerPath, {
    outcomeEvents: [outcome],
    governorDecisions: [governorDecision],
    maturationCandidates: [candidate]
  });

  assert.equal(snapshot.counts.outcomeEvents, 1);
  assert.equal(snapshot.counts.governorDecisions, 1);
  assert.equal(snapshot.counts.maturationCandidates, 1);
  assert.equal(snapshot.counts.dryRunMaturationPreviews, 0);
  assert.equal(snapshot.latest.outcomeEvents[0].eventId, 'outcome-live-adapter-1');
  assert.equal(snapshot.latest.governorDecisions[0].decisionId, 'gov-live-adapter-1');
  assert.equal(snapshot.latest.maturationCandidates[0].recordRef.id, 'outcome-live-adapter-1');
  assert.equal(readSpineLedger(ledgerPath).outcomeEvents.length, 0);
  assert.equal(readSpineLedger(ledgerPath).governorDecisions.length, 0);
  assert.equal(readSpineLedger(ledgerPath).maturationCandidates.length, 0);
  assert.equal(snapshot.policy.reviewOnly, true);
  assert.equal(snapshot.policy.mutationAuthorized, false);
});

test('snapshot dry-run maturation previews disappear once candidate is persisted', () => {
  const ledgerPath = tmpLedgerPath();
  const outcome = appendOutcomeEventPacket(ledgerPath, createOutcomeEventPacket({
    eventId: 'outcome-preview-suppressed-after-persist',
    status: 'verified',
    learning: { eligibleForMaturation: true, suggestedLane: MATURATION_LANES.SEMANTIC_MEMORY }
  }));

  assert.equal(getSpineLedgerSnapshot(ledgerPath).counts.dryRunMaturationPreviews, 1);
  appendMaturationCandidatePacket(ledgerPath, outcome);
  const snapshot = getSpineLedgerSnapshot(ledgerPath);
  assert.equal(snapshot.counts.maturationCandidates, 1);
  assert.equal(snapshot.counts.dryRunMaturationPreviews, 0);
  assert.equal(snapshot.policy.mutationAuthorized, false);
  assert.equal(snapshot.policy.promptInjectionAuthorized, false);
});

test('spine ledger hot path compacts oversized review packets into an archive', () => {
  const ledgerPath = tmpLedgerPath();
  const events = Array.from({ length: 5 }, (_, index) => createOutcomeEventPacket({
    eventId: `outcome-hot-path-${index}`,
    status: 'observed',
    createdAt: `2026-05-09T14:3${index}:00.000Z`
  }));
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, JSON.stringify({
    version: 1,
    outcomeEvents: events,
    governorDecisions: [],
    contextEligibilityReviews: [],
    maturationCandidates: [],
    responsibilityLeases: []
  }), 'utf8');

  const result = compactSpineLedgerFile(ledgerPath, {
    limits: { outcomeEvents: 2 },
    now: '2026-05-09T15:00:00.000Z'
  });
  assert.equal(result.compacted, true);
  assert.equal(result.archivedCount, 3);
  assert.equal(result.counts.outcomeEvents, 2);
  const compacted = readSpineLedger(ledgerPath);
  assert.deepEqual(compacted.outcomeEvents.map((event) => event.eventId), ['outcome-hot-path-4', 'outcome-hot-path-3']);
  const archived = fs.readFileSync(result.archivePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(archived.length, 3);
  assert.deepEqual(archived.map((entry) => entry.packet.eventId), ['outcome-hot-path-2', 'outcome-hot-path-1', 'outcome-hot-path-0']);
});

test('appendResponsibilityLeasePacket stores candidates without activating them', () => {
  const ledgerPath = tmpLedgerPath();
  appendResponsibilityLeasePacket(ledgerPath, createResponsibilityLeasePacket({
    leaseId: 'lease-candidate-1',
    objective: 'Review next implementation slice.',
    status: 'candidate',
    authority: { allowedActions: ['read files'], prohibitedActions: ['write config'] },
    nonGoals: ['scheduler linkage']
  }));

  const leases = listResponsibilityLeasePackets(ledgerPath);
  assert.equal(leases.length, 1);
  assert.equal(leases[0].lifecycle.status, 'candidate');
  assert.deepEqual(listActiveResponsibilityLeases(ledgerPath), []);
});

test('completeResponsibilityLeaseWithOutcome closes active lease with outcome receipt', () => {
  const ledgerPath = tmpLedgerPath();
  appendResponsibilityLeasePacket(ledgerPath, {
    leaseId: 'lease-complete-with-outcome',
    objective: 'Complete with receipt.',
    status: 'active'
  });

  const result = completeResponsibilityLeaseWithOutcome(ledgerPath, 'lease-complete-with-outcome', {
    eventId: 'outcome-complete-lease-1',
    eventType: 'lease_completed',
    observed: { result: 'done' },
    verification: { status: 'verified', method: 'unit test' }
  }, { now: '2026-05-09T14:20:00.000Z' });

  assert.equal(result.outcome.eventId, 'outcome-complete-lease-1');
  assert.equal(result.outcome.authority.leaseId, 'lease-complete-with-outcome');
  assert.equal(result.lease.lifecycle.status, 'completed');
  assert.equal(result.lease.receipts.completedByEvent, 'outcome-complete-lease-1');
  assert.equal(listOutcomeEventPackets(ledgerPath).length, 1);
  assert.deepEqual(listActiveResponsibilityLeases(ledgerPath), []);
});

test('interruptResponsibilityLeaseWithOutcome pauses active lease with outcome receipt', () => {
  const ledgerPath = tmpLedgerPath();
  appendResponsibilityLeasePacket(ledgerPath, {
    leaseId: 'lease-interrupt-with-outcome',
    objective: 'Pause with receipt.',
    status: 'active'
  });

  const result = interruptResponsibilityLeaseWithOutcome(ledgerPath, 'lease-interrupt-with-outcome', {
    eventId: 'outcome-interrupt-lease-1',
    eventType: 'lease_interrupted',
    observed: { reason: 'operator pause' },
    verification: { status: 'recorded', method: 'unit test' }
  }, { now: '2026-05-09T14:25:00.000Z' });

  assert.equal(result.outcome.status, 'interrupted');
  assert.equal(result.outcome.authority.leaseId, 'lease-interrupt-with-outcome');
  assert.equal(result.lease.lifecycle.status, 'paused');
  assert.equal(result.lease.receipts.interruptedByEvent, 'outcome-interrupt-lease-1');
  assert.deepEqual(listActiveResponsibilityLeases(ledgerPath), []);
});

test('duplicate outcome receipt does not change lease status', () => {
  const ledgerPath = tmpLedgerPath();
  appendResponsibilityLeasePacket(ledgerPath, {
    leaseId: 'lease-duplicate-outcome-guard',
    objective: 'Stay active if receipt append fails.',
    status: 'active'
  });
  appendOutcomeEventPacket(ledgerPath, {
    eventId: 'outcome-duplicate-guard',
    status: 'verified',
    verification: { status: 'verified', method: 'unit test' }
  });

  assert.throws(
    () => completeResponsibilityLeaseWithOutcome(ledgerPath, 'lease-duplicate-outcome-guard', {
      eventId: 'outcome-duplicate-guard',
      verification: { status: 'verified', method: 'unit test' }
    }),
    /already exists/
  );
  const lease = listResponsibilityLeasePackets(ledgerPath)[0];
  assert.equal(lease.lifecycle.status, 'active');
  assert.equal(lease.receipts.completedByEvent, null);
});

test('completion receipt refuses candidate leases by default', () => {
  const ledgerPath = tmpLedgerPath();
  appendResponsibilityLeasePacket(ledgerPath, {
    leaseId: 'lease-candidate-completion-refusal',
    objective: 'Candidate should not complete silently.',
    status: 'candidate'
  });

  assert.throws(
    () => completeResponsibilityLeaseWithOutcome(ledgerPath, 'lease-candidate-completion-refusal', {
      eventId: 'outcome-candidate-refusal',
      verification: { status: 'verified', method: 'unit test' }
    }),
    /status mismatch/
  );
  assert.equal(listOutcomeEventPackets(ledgerPath).length, 0);
});

test('active leases list excludes expired leases', () => {
  const ledgerPath = tmpLedgerPath();
  appendResponsibilityLeasePacket(ledgerPath, {
    leaseId: 'lease-active-fresh',
    objective: 'Fresh active work.',
    status: 'active',
    expiresAt: '2026-05-09T15:00:00.000Z'
  });
  appendResponsibilityLeasePacket(ledgerPath, {
    leaseId: 'lease-active-expired',
    objective: 'Expired active work.',
    status: 'active',
    expiresAt: '2026-05-09T13:00:00.000Z'
  });

  const active = listActiveResponsibilityLeases(ledgerPath, { now: '2026-05-09T14:00:00.000Z' });
  assert.equal(active.length, 1);
  assert.equal(active[0].leaseId, 'lease-active-fresh');
});

test('completed or expired leases cannot silently reactivate', () => {
  const ledgerPath = tmpLedgerPath();
  appendResponsibilityLeasePacket(ledgerPath, {
    leaseId: 'lease-terminal',
    objective: 'One completed workstream.',
    status: 'active'
  });

  const completed = updateResponsibilityLeaseStatus(ledgerPath, 'lease-terminal', 'completed', {
    expectedStatus: 'active',
    eventId: 'outcome-close-1',
    now: '2026-05-09T14:10:00.000Z'
  });
  assert.equal(completed.lifecycle.status, 'completed');
  assert.equal(completed.receipts.completedByEvent, 'outcome-close-1');
  assert.throws(
    () => updateResponsibilityLeaseStatus(ledgerPath, 'lease-terminal', 'active', { expectedStatus: 'completed' }),
    /cannot silently reactivate/
  );
});

test('status updates require expected status when supplied', () => {
  const ledgerPath = tmpLedgerPath();
  appendResponsibilityLeasePacket(ledgerPath, {
    leaseId: 'lease-status-check',
    objective: 'Guard status transition.',
    status: 'candidate'
  });
  assert.throws(
    () => updateResponsibilityLeaseStatus(ledgerPath, 'lease-status-check', 'active', { expectedStatus: 'paused' }),
    /status mismatch/
  );
  const active = updateResponsibilityLeaseStatus(ledgerPath, 'lease-status-check', 'active', { expectedStatus: 'candidate' });
  assert.equal(active.lifecycle.status, 'active');
});
