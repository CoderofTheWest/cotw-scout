const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { analyzeTrajectoryWindows } = require('../bundled-plugins/openclaw-plugin-harness-refiner/lib/analyzer');
const { normalizeCognitiveSnapshot } = require('../bundled-plugins/openclaw-plugin-harness-refiner/lib/cognitive-snapshot');
const { exportResearchBundle } = require('../bundled-plugins/openclaw-plugin-harness-refiner/lib/research-bundle-export');
const { buildTeacherRelabelReceipt } = require('../bundled-plugins/openclaw-plugin-harness-refiner/lib/relabel-packets');
const { runScenarioReplay } = require('../bundled-plugins/openclaw-plugin-harness-refiner/lib/scenario-replay');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-refiner-core-'));
}

function fixtureWindow(overrides = {}) {
  return {
    id: 'window-1',
    scope: 'current_task',
    triggerEvent: 'operator',
    agentId: 'trail-guide',
    mode: 'code',
    messages: [
      { role: 'user', content: 'Please fix the failing command.' },
      { role: 'assistant', content: 'I will verify the evidence and summarize the next step.' }
    ],
    toolCalls: [
      { toolName: 'exec', params: { cmd: 'npm test' }, result: 'Error: command failed', success: false },
      { toolName: 'exec', params: { cmd: 'npm test' }, result: 'Error: command failed', success: false },
      { toolName: 'exec', params: { cmd: 'npm test' }, result: 'Error: command failed', success: false }
    ],
    sourceHandles: ['source:log:1'],
    cognitiveSnapshot: {
      surpriseFrozen: 0.12,
      surpriseLearned: 0.1,
      learnerLoss: 0.02,
      learnerUpdates: 4,
      latent: Array.from({ length: 64 }, (_, idx) => idx / 64),
      featureAvailability: { timing: true, thread_context: true }
    },
    ...overrides
  };
}

test('cognitive snapshots redact raw latents by default while preserving hash and bucket', () => {
  const snapshot = normalizeCognitiveSnapshot({
    surprise_frozen: 0.1,
    surprise_learned: 0.08,
    latent: [0.1, 0.2, 0.3],
    features_available: { timing: true }
  });

  assert.equal(snapshot.rawLatentIncluded, false);
  assert.equal(Object.hasOwn(snapshot, 'rawLatent'), false);
  assert.match(snapshot.latentHash, /^sha256:/);
  assert.equal(snapshot.latentBucket, 'stable_task_work');
});

test('analyzer emits proposal-only receipts, scores, relabel packets, and research digests', () => {
  const result = analyzeTrajectoryWindows({
    windows: [fixtureWindow()],
    config: {
      analysis: { patternConfidenceThreshold: 0.55, maxProposalsPerRun: 10 },
      detectors: { minRepeatedToolFailures: 2, minToolLoopRepeats: 3, lowSurpriseThreshold: 0.25, minLowSurpriseToolCalls: 3 },
      cognitive: { includeRawLatents: false },
      training: { lowScoreThreshold: 0.9 }
    },
    agentId: 'trail-guide',
    scaffoldVersion: 'scaffold-hash',
    experimentId: 'experiment-1',
    now: '2026-05-22T12:00:00.000Z'
  });

  assert.equal(result.skipped, false);
  assert.equal(result.windowCount, 1);
  assert.ok(result.signatures.some((entry) => entry.signature === 'repeated_tool_failure'));
  assert.ok(result.signatures.some((entry) => entry.signature === 'tool_loop'));
  assert.ok(result.signatures.some((entry) => entry.signature === 'low_surprise_drift'));
  assert.ok(result.proposals.length >= 1);
  for (const proposal of result.proposals) {
    assert.equal(proposal.action, 'harness_refinement_proposal');
    assert.equal(proposal.status, 'preview');
    assert.equal(proposal.metadata.mutationAttempted, 'false');
    assert.equal(proposal.metadata.launchTraining, false);
    assert.equal(proposal.metadata.adapterPromotion, false);
    assert.equal(proposal.metadata.gatewayInvocation, false);
    assert.equal(proposal.metadata.cognitiveSnapshot.rawLatentIncluded, false);
  }
  assert.equal(result.scoreReceipts.length, 1);
  assert.equal(result.relabelCandidates.length, 1);
  assert.ok(result.digests.length >= 1);
  assert.equal(result.digests[0].experimentId, 'experiment-1');
});

test('research bundle export writes manifest with default redactions and no training approval', () => {
  const dataDir = tmpDir();
  const result = exportResearchBundle({
    dataDir,
    experimentId: 'experiment-1',
    now: '2026-05-22T12:00:00.000Z',
    artifacts: {
      digests: [{ id: 'digest-1', type: 'research_digest' }],
      windows: [{ id: 'window-1', cognitiveSnapshot: { rawLatent: [1, 2, 3], rawLatentIncluded: true } }],
      proposals: [],
      scores: [],
      replays: [],
      relabelCandidates: [],
      teacherRelabels: [],
      healthReceipts: []
    }
  });

  assert.equal(result.manifest.trainingApproval, false);
  assert.equal(result.manifest.redactionPolicy, 'default-local-research-redaction');
  assert.equal(result.manifest.files.windows.count, 1);
  const windowsJsonl = fs.readFileSync(path.join(result.bundleDir, 'windows.jsonl'), 'utf8');
  assert.match(windowsJsonl, /"rawLatent":"\[redacted\]"/);
  assert.ok(fs.existsSync(path.join(result.bundleDir, 'manifest.json')));
});

test('teacher relabel receipts are artifact-only and do not authorize training', () => {
  const receipt = buildTeacherRelabelReceipt({
    candidatePacket: {
      id: 'candidate-1',
      windowId: 'window-1',
      modelOrAdapterHash: 'adapter-hash',
      harnessVersion: 'scaffold-hash',
      aggregate: 0.32,
      lowScoreAxes: ['grounding_provenance'],
      originalResponseHandle: 'window:window-1:assistant:abc',
      shardId: 'cotw-relabel-shard-test'
    },
    teacherModel: 'teacher-test-model',
    teacherRepair: 'Use the receipt handle and do not overclaim current observation.',
    includeInShard: false,
    now: '2026-05-22T12:00:00.000Z'
  });

  assert.equal(receipt.type, 'teacher_relabel_receipt');
  assert.equal(receipt.includeInShard, false);
  assert.equal(receipt.inclusionDecision, 'excluded');
  assert.equal(receipt.trainingLaunchAuthorized, false);
  assert.equal(receipt.adapterPromotionAuthorized, false);
  assert.match(receipt.shardHash, /^sha256:/);
});

test('scenario replay fixtures cover recognizable COTW failure classes', () => {
  const results = runScenarioReplay({
    config: {
      analysis: { patternConfidenceThreshold: 0.55 },
      detectors: {
        minRepeatedToolFailures: 2,
        minToolLoopRepeats: 3,
        lowSurpriseThreshold: 0.25,
        minLowSurpriseToolCalls: 3,
        highSurpriseThreshold: 0.7
      }
    },
    now: '2026-05-22T12:00:00.000Z'
  });

  assert.ok(results.length >= 4);
  assert.deepEqual(results.map((result) => [result.id, result.passed]), results.map((result) => [result.id, true]));
  assert.ok(results.find((result) => result.id === 'attachment-certainty-receipt-mismatch').foundSignatures.includes('receipt_mismatch'));
  assert.ok(results.find((result) => result.id === 'mode-bleed-after-exit').foundSignatures.includes('mode_bleed'));
});
