const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { analyzeTrajectoryWindows } = require('../bundled-plugins/openclaw-plugin-harness-refiner/lib/analyzer');
const { normalizeCognitiveSnapshot } = require('../bundled-plugins/openclaw-plugin-harness-refiner/lib/cognitive-snapshot');
const { normalizeTrajectoryWindow } = require('../bundled-plugins/openclaw-plugin-harness-refiner/lib/trajectory-window');
const { redactText, validateNoLeaks } = require('../bundled-plugins/openclaw-plugin-harness-refiner/lib/redaction-validator');
const { exportResearchBundle } = require('../bundled-plugins/openclaw-plugin-harness-refiner/lib/research-bundle-export');
const { buildTeacherRelabelReceipt } = require('../bundled-plugins/openclaw-plugin-harness-refiner/lib/relabel-packets');
const { runScenarioReplay } = require('../bundled-plugins/openclaw-plugin-harness-refiner/lib/scenario-replay');
const { SCHEMA_VERSIONS } = require('../bundled-plugins/openclaw-plugin-harness-refiner/lib/schema-versions');

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

test('trajectory windows preserve exchange coverage and trace refs', () => {
  const window = normalizeTrajectoryWindow({
    exchangeId: 'ex_a',
    traceRefs: ['trace:ex_a'],
    metadata: {
      exchange_id: 'ex_a',
      turn_id: 'turn_a',
      run_id: 'run_a'
    },
    messages: [{ role: 'user', content: 'diagnose the last response' }]
  }, { now: '2026-05-22T12:00:00.000Z' });

  assert.deepEqual(window.exchangeIds, ['ex_a']);
  assert.deepEqual(window.traceRefs, ['trace:ex_a']);
  assert.equal(window.metadata.turn_id, 'turn_a');
  assert.equal(window.metadata.run_id, 'run_a');
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
  assert.equal(result.scoreReceipts[0].schemaVersion, SCHEMA_VERSIONS.SCORE_RECEIPT);
  assert.equal(result.scoreReceipts[0].type, 'process_score_receipt');
  assert.equal(result.relabelCandidates.length, 1);
  assert.equal(result.relabelCandidates[0].schemaVersion, SCHEMA_VERSIONS.RELABEL_CANDIDATE_PACKET);
  assert.equal(result.relabelCandidates[0].scoreReceiptId, result.scoreReceipts[0].id);
  assert.deepEqual(result.relabelCandidates[0].scores, result.scoreReceipts[0].scores);
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
  assert.equal(result.manifest.adapterPromotionAuthorized, false);
  assert.equal(result.manifest.redactionPolicy, 'default-local-research-redaction');
  assert.equal(result.manifest.redactionValidation.ok, true);
  assert.equal(result.manifest.redactionValidation.leakCount, 0);
  assert.ok(result.manifest.redactionPatternsChecked.includes('email'));
  assert.ok(result.manifest.redactionPatternsChecked.includes('home_path'));
  assert.equal(result.manifest.receiptSchemaCompatibility.ok, true);
  assert.equal(result.manifest.files.windows.count, 1);
  const windowsJsonl = fs.readFileSync(path.join(result.bundleDir, 'windows.jsonl'), 'utf8');
  assert.match(windowsJsonl, /"rawLatent":"\[redacted\]"/);
  assert.ok(fs.existsSync(path.join(result.bundleDir, 'manifest.json')));
});

test('redaction validator detects known sensitive categories without echoing values', () => {
  const raw = [
    'operator@example.com',
    '(555) 123-4567',
    `${os.homedir()}/Library/Application Support/COTW Trail Guide/secret.json`,
    'sk-proj-abcdefghijklmnopqrstuvwxyz1234567890',
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456',
    'ghp_abcdefghijklmnopqrstuvwxyz123456',
    'AKIAIOSFODNN7EXAMPLE',
    'ya29.a0AfH6SMBabcdefghijklmnopqrstuvwxyz'
  ].join(' ');

  const report = validateNoLeaks(raw);
  assert.equal(report.ok, false);
  assert.equal(report.leakCounts.email, 1);
  assert.equal(report.leakCounts.phone, 1);
  assert.equal(report.leakCounts.home_path, 1);
  assert.equal(report.leakCounts.openai_api_key, 1);
  assert.equal(report.leakCounts.anthropic_api_key, 1);
  assert.equal(report.leakCounts.github_token, 1);
  assert.equal(report.leakCounts.aws_access_key, 1);
  assert.equal(report.leakCounts.oauth_token, 1);
  assert.doesNotMatch(JSON.stringify(report), /operator@example\.com|sk-proj-|AKIAIOSFODNN7EXAMPLE/);
  assert.equal(validateNoLeaks(redactText(raw)).ok, true);
});

test('research bundle export redacts contaminated payloads and validates before writing', () => {
  const dataDir = tmpDir();
  const leakedValues = [
    'operator@example.com',
    '(555) 123-4567',
    `${os.homedir()}/Library/Application Support/COTW Trail Guide/secret.json`,
    'sk-proj-abcdefghijklmnopqrstuvwxyz1234567890',
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456',
    'ghp_abcdefghijklmnopqrstuvwxyz123456',
    'AKIAIOSFODNN7EXAMPLE',
    'ya29.a0AfH6SMBabcdefghijklmnopqrstuvwxyz'
  ];
  const result = exportResearchBundle({
    dataDir,
    experimentId: 'experiment-with-redaction',
    reviewerNotes: leakedValues.join(' '),
    now: '2026-05-22T12:00:00.000Z',
    artifacts: {
      digests: [{ id: 'digest-1', summary: leakedValues.join(' ') }],
      windows: [{
        id: 'window-redaction',
        content: leakedValues.join(' '),
        note: 'Call (555) 123-4567 and check operator@example.com',
        attachments: { rawContent: leakedValues.join(' ') },
        cognitiveSnapshot: { rawLatent: [1, 2, 3], rawLatentIncluded: true }
      }]
    }
  });

  const bundleText = fs.readdirSync(result.bundleDir)
    .map((filename) => fs.readFileSync(path.join(result.bundleDir, filename), 'utf8'))
    .join('\n');
  for (const leakedValue of leakedValues) {
    assert.doesNotMatch(bundleText, new RegExp(leakedValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(bundleText, /\[redacted-email\]/);
  assert.match(bundleText, /\[redacted-phone\]/);
  assert.match(bundleText, /\[redacted-home-path\]/);
  assert.match(bundleText, /\[redacted-openai-key\]/);
  assert.match(bundleText, /\[redacted-anthropic-key\]/);
  assert.match(bundleText, /\[redacted-github-token\]/);
  assert.match(bundleText, /\[redacted-aws-key\]/);
  assert.match(bundleText, /\[redacted-oauth-token\]/);
  assert.equal(result.manifest.redactionValidation.ok, true);
});

test('research bundle export fails closed when validation reports a leak', () => {
  const dataDir = tmpDir();
  const bundleId = 'validator-rejects-this-bundle';
  assert.throws(() => exportResearchBundle({
    dataDir,
    bundleId,
    experimentId: 'experiment-1',
    artifacts: { windows: [{ id: 'window-1', content: 'safe after structural redaction' }] },
    redactionValidator: () => ({
      ok: false,
      validatorVersion: 'test-validator',
      checkedPatterns: ['email'],
      leakCounts: { email: 1 },
      leakCount: 1
    })
  }), /redaction validation failed/);

  assert.equal(fs.existsSync(path.join(dataDir, 'research-bundles', bundleId)), false);
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
  assert.equal(receipt.schemaVersion, SCHEMA_VERSIONS.TEACHER_RELABEL_RECEIPT);
  assert.equal(receipt.includeInShard, false);
  assert.equal(receipt.inclusionDecision, 'excluded');
  assert.equal(receipt.trainingLaunchAuthorized, false);
  assert.equal(receipt.adapterPromotionAuthorized, false);
  assert.match(receipt.shardHash, /^sha256:/);
  assert.equal(receipt.qualityGate.status, 'unscored');
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
