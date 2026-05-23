const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildGroundTruthLabel, validateGroundTruthLabel } = require('../bundled-plugins/openclaw-plugin-harness-refiner/lib/ground-truth-labeler');
const { buildHindsightCorrelationReport, correctionSignalsFor } = require('../bundled-plugins/openclaw-plugin-harness-refiner/lib/hindsight-link');
const { buildHoldoutManifest } = require('../bundled-plugins/openclaw-plugin-harness-refiner/lib/holdout-split');
const { SCORE_AXES, scoreWindow } = require('../bundled-plugins/openclaw-plugin-harness-refiner/lib/prm-diagnostics');
const { buildRelabelCandidatePacket, buildTeacherRelabelReceipt } = require('../bundled-plugins/openclaw-plugin-harness-refiner/lib/relabel-packets');
const { exportResearchBundle } = require('../bundled-plugins/openclaw-plugin-harness-refiner/lib/research-bundle-export');
const { buildScorerCalibrationReport, meanAbsoluteError, spearman } = require('../bundled-plugins/openclaw-plugin-harness-refiner/lib/scorer-calibration');
const { validateScores } = require('../bundled-plugins/openclaw-plugin-harness-refiner/lib/scoring-rubric');
const { getScenarioFixtures } = require('../bundled-plugins/openclaw-plugin-harness-refiner/lib/scenario-fixtures');
const { SCHEMA_VERSIONS } = require('../bundled-plugins/openclaw-plugin-harness-refiner/lib/schema-versions');
const { downgradeReceiptSchema, migrateReceiptSchema, normalizeBundleSchemas } = require('../bundled-plugins/openclaw-plugin-harness-refiner/lib/schema-migration');
const { buildShardManifest, verifyShardManifest, writeSealedShardManifest } = require('../bundled-plugins/openclaw-plugin-harness-refiner/lib/shard-integrity');
const { buildTeacherRepairQualityReceipt } = require('../bundled-plugins/openclaw-plugin-harness-refiner/lib/teacher-repair-quality');

function fullScores(value) {
  return Object.fromEntries(SCORE_AXES.map((axis) => [axis, value]));
}

function lowWindow(id, aggregateHint = false) {
  return {
    id,
    mode: 'code',
    sessionId: `session-${id}`,
    messages: [
      { role: 'user', content: 'Actually, use the receipt.' },
      { role: 'assistant', content: aggregateHint ? 'Confirmed, I saw it and definitely verified it.' : 'I will verify evidence and cite the receipt next.' }
    ],
    toolCalls: [
      { toolName: 'exec', result: 'Error: failed', success: false },
      { toolName: 'exec', result: 'Error: failed', success: false }
    ],
    sourceHandles: [],
    metadata: aggregateHint ? { receiptMismatch: true, confabulation: true } : {}
  };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-refiner-training-grade-'));
}

function includedPair(id, options = {}) {
  const window = {
    ...lowWindow(id, true),
    sessionId: options.sessionId || `session-${id}`,
    mode: options.sourceMode || 'code'
  };
  const score = scoreWindow(window, { now: '2026-05-23T00:00:00.000Z' });
  const candidate = buildRelabelCandidatePacket({
    window,
    scoreReceipt: score,
    now: '2026-05-23T00:00:00.000Z'
  });
  candidate.lowScoreAxes = options.lowScoreAxes || candidate.lowScoreAxes;
  const quality = buildTeacherRepairQualityReceipt({
    window,
    candidatePacket: candidate,
    teacherRepair: 'I should not claim visual certainty. I will cite the receipt handle and state only what the evidence supports.',
    now: '2026-05-23T00:00:00.000Z'
  });
  const relabel = buildTeacherRelabelReceipt({
    candidatePacket: candidate,
    teacherRepair: 'I should not claim visual certainty. I will cite the receipt handle and state only what the evidence supports.',
    teacherModel: options.teacherModel || 'teacher-a',
    includeInShard: true,
    qualityGate: quality,
    now: '2026-05-23T00:00:00.000Z'
  });
  return { window, score, candidate, relabel };
}

test('ground-truth labels require every rubric axis', () => {
  const window = lowWindow('gt-1');
  const label = buildGroundTruthLabel({
    window,
    scores: fullScores(0.5),
    labeler: 'operator-test',
    now: '2026-05-23T00:00:00.000Z'
  });

  assert.equal(label.schemaVersion, SCHEMA_VERSIONS.GROUND_TRUTH_LABEL);
  assert.equal(label.type, 'ground_truth_label');
  assert.equal(label.aggregate, 0.5);
  assert.equal(validateGroundTruthLabel(label).ok, true);
  assert.equal(validateScores(label.scores).ok, true);
  assert.throws(() => buildGroundTruthLabel({ window, scores: { format_compliance: 1 } }), /incomplete/);
});

test('scorer calibration computes axis correlation and MAE', () => {
  assert.equal(spearman([1, 2, 3], [1, 2, 3]), 1);
  assert.equal(spearman([1, 2, 3], [3, 2, 1]), -1);
  assert.equal(meanAbsoluteError([0, 0.5, 1], [0, 1, 1]), 0.16666666666666666);

  const windows = [lowWindow('cal-1', true), lowWindow('cal-2'), lowWindow('cal-3')];
  const labels = windows.map((window) => {
    const receipt = scoreWindow(window, { now: '2026-05-23T00:00:00.000Z' });
    return buildGroundTruthLabel({
      window,
      scores: receipt.scores,
      labeler: 'operator-test',
      now: '2026-05-23T00:00:00.000Z'
    });
  });
  const report = buildScorerCalibrationReport({
    windows,
    groundTruthLabels: labels,
    now: '2026-05-23T00:00:00.000Z'
  });

  assert.equal(report.schemaVersion, SCHEMA_VERSIONS.SCORER_CALIBRATION_REPORT);
  assert.equal(report.pairedWindowCount, 3);
  assert.equal(report.axes.grounding_provenance.meanAbsoluteError, 0);
  assert.equal(report.axes.grounding_provenance.eligibleForShardDecisions, true);
});

test('heuristic scorer is deterministic across frozen scenario fixtures', () => {
  const fixtures = getScenarioFixtures();
  for (const fixture of fixtures) {
    const first = scoreWindow(fixture.window, { now: '2026-05-23T00:00:00.000Z' });
    const second = scoreWindow(fixture.window, { now: '2026-05-23T00:00:00.000Z' });
    assert.deepEqual(second.scores, first.scores);
    assert.equal(second.aggregate, first.aggregate);
    assert.equal(second.id, first.id);
  }
});

test('teacher repair quality gate rejects non-improving repairs', () => {
  const window = lowWindow('teacher-bad', true);
  const original = scoreWindow(window, { now: '2026-05-23T00:00:00.000Z' });
  const quality = buildTeacherRepairQualityReceipt({
    window,
    candidatePacket: {
      id: 'candidate-bad',
      windowId: window.id,
      scores: original.scores,
      aggregate: original.aggregate,
      scorerVersion: original.scorerVersion,
      scoreReceiptId: original.id
    },
    teacherRepair: 'Definitely confirmed, I saw it.',
    now: '2026-05-23T00:00:00.000Z'
  });

  assert.equal(quality.schemaVersion, SCHEMA_VERSIONS.TEACHER_REPAIR_QUALITY_RECEIPT);
  assert.equal(quality.accepted, false);
  assert.equal(quality.exclusionReason, 'teacher_did_not_improve');
  assert.ok(quality.teacherAggregate <= quality.originalAggregate);
});

test('teacher repair quality gate accepts improving repairs and records deltas', () => {
  const window = lowWindow('teacher-good', true);
  const original = scoreWindow(window, { now: '2026-05-23T00:00:00.000Z' });
  const quality = buildTeacherRepairQualityReceipt({
    window,
    candidatePacket: {
      id: 'candidate-good',
      windowId: window.id,
      scores: original.scores,
      aggregate: original.aggregate,
      scorerVersion: original.scorerVersion,
      scoreReceiptId: original.id
    },
    teacherRepair: 'I should not claim visual certainty here. I will verify the receipt handle, state what the evidence supports, and keep any inference clearly labeled.',
    now: '2026-05-23T00:00:00.000Z'
  });

  assert.equal(quality.accepted, true);
  assert.equal(quality.exclusionReason, null);
  assert.ok(quality.teacherAggregate > quality.originalAggregate);
  assert.ok(quality.perAxisDelta.no_confabulation > 0);
  assert.match(quality.qualityReceiptHash, /^sha256:/);
});

test('holdout manifest partitions at session level and shard rejects dev/test leakage', () => {
  const pairs = [
    includedPair('holdout-1', { sessionId: 'session-train' }),
    includedPair('holdout-2', { sessionId: 'session-dev' })
  ];
  const holdout = buildHoldoutManifest({
    windows: pairs.map((pair) => pair.window),
    relabelReceipts: pairs.map((pair) => pair.relabel),
    ratios: { train: 1, dev: 0, test: 0 },
    seed: 'holdout-test',
    now: '2026-05-23T00:00:00.000Z'
  });
  assert.equal(holdout.schemaVersion, SCHEMA_VERSIONS.HOLDOUT_MANIFEST);
  assert.deepEqual(new Set(holdout.partitions.train), new Set(['session-train', 'session-dev']));

  const leakingHoldout = {
    ...holdout,
    partitions: { train: ['session-train'], dev: ['session-dev'], test: [] }
  };
  const manifest = buildShardManifest({
    shardId: 'shard-holdout-test',
    relabelReceipts: pairs.map((pair) => ({ ...pair.relabel, shardId: 'shard-holdout-test' })),
    candidatePackets: pairs.map((pair) => pair.candidate),
    windows: pairs.map((pair) => pair.window),
    scoreReceipts: pairs.map((pair) => pair.score),
    holdoutManifest: leakingHoldout,
    qualityGate: {
      minIncludedPairs: 1,
      maxSingleAxisShare: 1,
      maxSingleSourceModeShare: 1,
      maxSingleTeacherModelShare: 1
    },
    now: '2026-05-23T00:00:00.000Z'
  });

  assert.equal(manifest.qualityGate.passed, false);
  assert.ok(manifest.qualityGate.reasons.some((reason) => reason.type === 'holdout_partition_violation'));
});

test('shard manifest records quality gates, Merkle root, and immutable write path', () => {
  const pairs = [
    includedPair('shard-1', { sessionId: 'session-a', sourceMode: 'code', teacherModel: 'teacher-a', lowScoreAxes: ['grounding_provenance'] }),
    includedPair('shard-2', { sessionId: 'session-b', sourceMode: 'chat', teacherModel: 'teacher-b', lowScoreAxes: ['mode_containment'] }),
    includedPair('shard-3', { sessionId: 'session-c', sourceMode: 'booth', teacherModel: 'teacher-c', lowScoreAxes: ['handoff_quality'] })
  ];
  const shardId = 'shard-integrity-test';
  const relabels = pairs.map((pair) => ({ ...pair.relabel, shardId }));
  const holdout = buildHoldoutManifest({
    windows: pairs.map((pair) => pair.window),
    relabelReceipts: relabels,
    ratios: { train: 1, dev: 0, test: 0 },
    now: '2026-05-23T00:00:00.000Z'
  });
  const manifest = buildShardManifest({
    shardId,
    relabelReceipts: relabels,
    candidatePackets: pairs.map((pair) => pair.candidate),
    windows: pairs.map((pair) => pair.window),
    scoreReceipts: pairs.map((pair) => pair.score),
    holdoutManifest: holdout,
    qualityGate: { minIncludedPairs: 3, maxSingleAxisShare: 0.6, maxSingleSourceModeShare: 0.7, maxSingleTeacherModelShare: 0.8 },
    now: '2026-05-23T00:00:00.000Z'
  });

  assert.equal(manifest.schemaVersion, SCHEMA_VERSIONS.SHARD_MANIFEST);
  assert.equal(manifest.qualityGate.passed, true);
  assert.equal(manifest.trainingApproval, false);
  assert.equal(manifest.counts.includedPairs, 3);
  assert.match(manifest.merkleRoot, /^sha256:/);
  assert.equal(verifyShardManifest(manifest, {
    relabelReceipts: relabels,
    candidatePackets: pairs.map((pair) => pair.candidate),
    windows: pairs.map((pair) => pair.window),
    scoreReceipts: pairs.map((pair) => pair.score)
  }).ok, true);

  const manifestPath = path.join(tmpDir(), 'sealed.json');
  writeSealedShardManifest(manifestPath, manifest);
  assert.ok(fs.existsSync(manifestPath));
  assert.throws(() => writeSealedShardManifest(manifestPath, manifest), /already exists/);
});

test('shard quality gate rejects undersized and imbalanced shards', () => {
  const pair = includedPair('tiny-shard', { lowScoreAxes: ['grounding_provenance'], teacherModel: 'teacher-a', sourceMode: 'code' });
  const manifest = buildShardManifest({
    shardId: 'tiny-shard',
    relabelReceipts: [{ ...pair.relabel, shardId: 'tiny-shard' }],
    candidatePackets: [pair.candidate],
    windows: [pair.window],
    scoreReceipts: [pair.score],
    qualityGate: { minIncludedPairs: 2, maxSingleAxisShare: 0.6, maxSingleSourceModeShare: 0.7, maxSingleTeacherModelShare: 0.8 },
    now: '2026-05-23T00:00:00.000Z'
  });
  assert.equal(manifest.qualityGate.passed, false);
  assert.ok(manifest.qualityGate.reasons.some((reason) => reason.type === 'insufficient_included_pairs'));
  assert.ok(manifest.qualityGate.reasons.some((reason) => reason.type === 'axis_imbalance'));
});

test('schema migration round-trips legacy receipts into current schema', () => {
  const pair = includedPair('schema-roundtrip');
  const downgraded = downgradeReceiptSchema(pair.score, { bundleKey: 'scores' });
  assert.equal(downgraded.receipt.schemaVersion, undefined);
  assert.equal(downgraded.migration.operation, 'current_to_legacy');

  const migrated = migrateReceiptSchema(downgraded.receipt, { bundleKey: 'scores' });
  assert.deepEqual(migrated.receipt, pair.score);
  assert.equal(migrated.migration.operation, 'legacy_to_current');

  const normalized = normalizeBundleSchemas({
    scores: [downgraded.receipt],
    relabelCandidates: [pair.candidate],
    teacherRelabels: [pair.relabel]
  });
  assert.equal(normalized.report.ok, true);
  assert.equal(normalized.report.schemaVersions.process_score_receipt, SCHEMA_VERSIONS.SCORE_RECEIPT);
  assert.equal(normalized.report.migratedCount, 1);
});

test('research bundle export rejects unsupported mixed receipt schemas before writing', () => {
  const dataDir = tmpDir();
  const bundleId = 'schema-rejects-this-bundle';
  assert.throws(() => exportResearchBundle({
    dataDir,
    bundleId,
    experimentId: 'schema-mixed',
    artifacts: {
      scores: [{ id: 'score-future', type: 'process_score_receipt', schemaVersion: 999 }]
    }
  }), /unsupported receipt schema versions/);

  assert.equal(fs.existsSync(path.join(dataDir, 'research-bundles', bundleId)), false);
});

test('hindsight correlation links low-score windows to later correction signals', () => {
  const first = {
    ...lowWindow('hindsight-1', true),
    sessionId: 'session-hindsight',
    createdAt: '2026-05-23T00:00:00.000Z'
  };
  const correction = {
    ...lowWindow('hindsight-2'),
    sessionId: 'session-hindsight',
    createdAt: '2026-05-23T00:01:00.000Z',
    stats: { userCorrections: 1 },
    messages: [{ role: 'user', content: 'Actually, that was wrong. Please redo it with the receipt.' }]
  };
  const laterLow = {
    ...lowWindow('hindsight-3', true),
    sessionId: 'session-hindsight',
    createdAt: '2026-05-23T00:02:00.000Z'
  };
  const scores = [
    scoreWindow(first, { now: '2026-05-23T00:00:00.000Z' }),
    scoreWindow(laterLow, { now: '2026-05-23T00:02:00.000Z' })
  ];
  const report = buildHindsightCorrelationReport({
    windows: [laterLow, correction, first],
    scoreReceipts: scores,
    minCorrelation: 0.6,
    now: '2026-05-23T00:03:00.000Z'
  });

  assert.equal(report.schemaVersion, SCHEMA_VERSIONS.HINDSIGHT_CORRELATION_REPORT);
  assert.equal(report.type, 'hindsight_correlation_report');
  assert.ok(correctionSignalsFor(correction).some((signal) => signal.type === 'user_correction'));
  assert.ok(report.links.find((link) => link.windowId === 'hindsight-1').followedByCorrection);
  assert.equal(report.links.find((link) => link.windowId === 'hindsight-3').followedByCorrection, false);
  assert.equal(report.axes.grounding_provenance.lowScoreWindows, 2);
  assert.equal(report.axes.grounding_provenance.followedByCorrection, 1);
  assert.equal(report.axes.grounding_provenance.hindsightCorrelation, 0.5);
  assert.ok(report.flaggedAxes.includes('grounding_provenance'));
});
