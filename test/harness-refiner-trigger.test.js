const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const harnessRefinerPlugin = require('../bundled-plugins/openclaw-plugin-harness-refiner');
const { readEvolutionLedger } = require('../lib/evolution-ledger');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-refiner-trigger-'));
}

function createApi(pluginConfig) {
  const methods = new Map();
  const hooks = new Map();
  return {
    methods,
    hooks,
    pluginConfig,
    logger: { info() {}, warn() {}, error() {} },
    on(name, handler) {
      hooks.set(name, handler);
    },
    registerGatewayMethod(name, handler) {
      methods.set(name, handler);
    }
  };
}

function windowFixture() {
  return {
    id: 'window-trigger-1',
    scope: 'current_task',
    triggerEvent: 'operator',
    sessionId: 'session-trigger-1',
    mode: 'code',
    messages: [
      { role: 'user', content: 'Actually, that is not right. Use the receipt.' },
      { role: 'assistant', content: 'Confirmed, I saw it and will retry.' }
    ],
    toolCalls: [
      { toolName: 'exec', params: { cmd: 'npm test' }, result: 'Error: failed', success: false },
      { toolName: 'exec', params: { cmd: 'npm test' }, result: 'Error: failed', success: false }
    ],
    cognitiveSnapshot: {
      surpriseFrozen: 0.8,
      surpriseLearned: 0.2,
      featureAvailability: { timing: true, thread_context: true }
    },
    metadata: { receiptMismatch: true }
  };
}

test('harness-refiner.trigger records preview proposal receipts and research digests', async () => {
  const dataDir = tmpDir();
  const workspacePath = tmpDir();
  const api = createApi({
    storage: { dataDir },
    analysis: { patternConfidenceThreshold: 0.55, maxProposalsPerRun: 10 },
    detectors: { minRepeatedToolFailures: 2, minToolLoopRepeats: 3, highSurpriseThreshold: 0.7 },
    training: { lowScoreThreshold: 0.95 }
  });

  harnessRefinerPlugin.register(api);
  const trigger = api.methods.get('harness-refiner.trigger');
  assert.equal(typeof trigger, 'function');

  const result = await trigger({
    agentId: 'trail-guide',
    windows: [windowFixture()],
    experimentId: 'experiment-trigger',
    ctx: { workspaceDir: workspacePath }
  });

  assert.equal(result.skipped, false);
  assert.ok(result.proposalCount >= 1);
  assert.ok(result.digestCount >= 1);
  assert.equal(result.recorded, result.proposalCount);
  assert.equal(result.ledger, 'workspace');

  const ledger = readEvolutionLedger(path.join(workspacePath, 'evolution', 'ledger.json'));
  assert.ok(ledger.events.length >= 1);
  assert.equal(ledger.events[0].action, 'harness_refinement_proposal');
  assert.equal(ledger.events[0].status, 'preview');
  assert.equal(ledger.events[0].metadata.mutationAttempted, 'false');
  assert.equal(ledger.events[0].metadata.gatewayInvocation, 'false');
  assert.equal(ledger.events[0].metadata.launchTraining, 'false');

  const digestResult = await api.methods.get('harness-refiner.getResearchDigest')({ experimentId: 'experiment-trigger' });
  assert.ok(digestResult.digests.length >= 1);
  assert.equal(digestResult.digests[0].experimentId, 'experiment-trigger');

  const candidatesPath = path.join(dataDir, 'analysis', 'relabel-candidates.jsonl');
  const candidate = JSON.parse(fs.readFileSync(candidatesPath, 'utf8').trim().split(/\n/)[0]);
  const relabel = await api.methods.get('harness-refiner.createTeacherRelabel')({
    candidatePacketId: candidate.id,
    teacherModel: 'teacher-test-model',
    teacherRepair: 'I need to correct course: I should use the receipt handle rather than claim I saw it directly. Next I will verify the source evidence, cite the handle, and avoid claiming visual certainty unless the current pixels or source prove it.',
    includeInShard: true,
    experimentId: 'experiment-trigger'
  });

  assert.equal(relabel.ok, true);
  assert.equal(relabel.trainingLaunchAuthorized, false);
  assert.equal(relabel.adapterPromotionAuthorized, false);
  assert.equal(relabel.receipt.type, 'teacher_relabel_receipt');
  assert.equal(relabel.receipt.includeInShard, true);
  assert.equal(relabel.receipt.trainingLaunchAuthorized, false);
  assert.equal(relabel.qualityGate.accepted, true);
  assert.ok(relabel.qualityGate.teacherAggregate > relabel.qualityGate.originalAggregate);
  assert.match(relabel.receipt.teacherRepairHandle, /^teacher-repair:/);
  assert.ok(fs.existsSync(path.join(dataDir, 'analysis', 'teacher-repair-quality.jsonl')));
  assert.ok(fs.existsSync(path.join(dataDir, 'analysis', 'teacher-relabels.jsonl')));

  const shard = await api.methods.get('harness-refiner.sealShard')({
    shardId: relabel.receipt.shardId,
    qualityGate: {
      minIncludedPairs: 1,
      maxSingleAxisShare: 1,
      maxSingleSourceModeShare: 1,
      maxSingleTeacherModelShare: 1
    },
    holdoutRatios: { train: 1, dev: 0, test: 0 },
    experimentId: 'experiment-trigger'
  });
  assert.equal(shard.ok, true);
  assert.equal(shard.manifest.trainingApproval, false);
  assert.equal(shard.manifest.adapterPromotionAuthorized, false);
  assert.match(shard.manifest.merkleRoot, /^sha256:/);
  assert.ok(fs.existsSync(shard.manifestPath));

  const replay = await api.methods.get('harness-refiner.runScenarioReplay')();
  assert.equal(replay.readOnly, true);
  assert.equal(replay.trainingLaunchAuthorized, false);
  assert.ok(replay.results.every((result) => result.passed));
});

test('harness-refiner records agent_end windows without triggering mutations', async () => {
  const dataDir = tmpDir();
  const api = createApi({ storage: { dataDir } });
  harnessRefinerPlugin.register(api);

  await api.hooks.get('after_tool_call')({
    toolName: 'exec',
    params: { cmd: 'npm test' },
    result: 'Error: failed'
  }, { agentId: 'trail-guide' });
  await api.hooks.get('agent_end')({
    messages: [
      { role: 'user', content: 'Please run the test.' },
      { role: 'assistant', content: 'The test failed; next I will inspect the error.' }
    ],
    metadata: { codeMode: true, model: 'test-model' }
  }, { agentId: 'trail-guide' });

  const state = await api.methods.get('harness-refiner.getState')();
  assert.equal(state.windowCount, 1);
  assert.equal(state.teacherRelabelCount, 0);
  assert.equal(state.lastAnalysis, null);
});
