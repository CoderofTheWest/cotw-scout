'use strict';

const { SCORE_AXES, scoreWindow } = require('./prm-diagnostics');
const { fullHash } = require('./safe');
const { SCHEMA_VERSIONS } = require('./schema-versions');

function buildScorerCalibrationReport({
  windows = [],
  groundTruthLabels = [],
  scorerVersion = 'harness-refiner-prm-heuristic-v1',
  now = new Date().toISOString()
} = {}) {
  const labelsByWindow = new Map(groundTruthLabels.map((label) => [label.windowId, label]));
  const paired = [];
  for (const window of windows) {
    const label = labelsByWindow.get(window.id);
    if (!label) continue;
    const scoreReceipt = scoreWindow(window, { scorerVersion, now });
    paired.push({ window, label, scoreReceipt });
  }

  const axes = {};
  for (const axis of SCORE_AXES) {
    const heuristic = paired.map((entry) => Number(entry.scoreReceipt.scores[axis]));
    const truth = paired.map((entry) => Number(entry.label.scores[axis]));
    axes[axis] = {
      sampleCount: paired.length,
      spearman: Number(spearman(heuristic, truth).toFixed(3)),
      meanAbsoluteError: Number(meanAbsoluteError(heuristic, truth).toFixed(3)),
      eligibleForShardDecisions: paired.length > 0 && spearman(heuristic, truth) >= 0.5,
      reason: paired.length === 0
        ? 'no_ground_truth_pairs'
        : spearman(heuristic, truth) < 0.5
          ? 'correlation_below_threshold'
          : null
    };
  }

  const report = {
    schemaVersion: SCHEMA_VERSIONS.SCORER_CALIBRATION_REPORT,
    type: 'scorer_calibration_report',
    scorerVersion,
    groundTruthLabelCount: groundTruthLabels.length,
    pairedWindowCount: paired.length,
    axes,
    excludedAxes: Object.entries(axes).filter(([, value]) => !value.eligibleForShardDecisions).map(([axis]) => axis),
    createdAt: now
  };
  report.reportHash = fullHash({ ...report, reportHash: undefined });
  return report;
}

function meanAbsoluteError(a, b) {
  if (!a.length || a.length !== b.length) return 0;
  return a.reduce((sum, value, index) => sum + Math.abs(Number(value) - Number(b[index])), 0) / a.length;
}

function spearman(a, b) {
  if (!a.length || a.length !== b.length) return 0;
  if (a.length < 2) return 1;
  return pearson(rank(a), rank(b));
}

function rank(values) {
  const sorted = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value);
  const ranks = Array(values.length).fill(0);
  let idx = 0;
  while (idx < sorted.length) {
    let end = idx;
    while (end + 1 < sorted.length && sorted[end + 1].value === sorted[idx].value) end += 1;
    const avg = (idx + end + 2) / 2;
    for (let pos = idx; pos <= end; pos += 1) ranks[sorted[pos].index] = avg;
    idx = end + 1;
  }
  return ranks;
}

function pearson(a, b) {
  const meanA = a.reduce((sum, value) => sum + value, 0) / a.length;
  const meanB = b.reduce((sum, value) => sum + value, 0) / b.length;
  let numerator = 0;
  let denomA = 0;
  let denomB = 0;
  for (let idx = 0; idx < a.length; idx += 1) {
    const da = a[idx] - meanA;
    const db = b[idx] - meanB;
    numerator += da * db;
    denomA += da * da;
    denomB += db * db;
  }
  if (denomA === 0 || denomB === 0) return 0;
  return numerator / Math.sqrt(denomA * denomB);
}

module.exports = {
  buildScorerCalibrationReport,
  meanAbsoluteError,
  spearman
};
