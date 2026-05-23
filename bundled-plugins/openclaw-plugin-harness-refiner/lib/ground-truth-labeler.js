'use strict';

const { fullHash, safeText, stableHash } = require('./safe');
const { SCHEMA_VERSIONS } = require('./schema-versions');
const { validateScores } = require('./scoring-rubric');

function buildGroundTruthLabel({
  window,
  scores,
  labeler = 'operator',
  notes = '',
  sourceMode = '',
  now = new Date().toISOString()
} = {}) {
  const validation = validateScores(scores || {});
  if (!validation.ok) {
    const missing = validation.missingAxes.length ? ` missing axes: ${validation.missingAxes.join(', ')}` : '';
    const invalid = validation.invalidAxes.length ? ` invalid axes: ${validation.invalidAxes.join(', ')}` : '';
    throw new Error(`ground truth label scores are incomplete.${missing}${invalid}`);
  }

  const windowId = safeText(window?.id || '', 140);
  const roundedScores = {};
  for (const [axis, value] of Object.entries(scores)) {
    roundedScores[axis] = Number(Number(value).toFixed(3));
  }
  const aggregate = Object.values(roundedScores).reduce((sum, value) => sum + value, 0) / Object.keys(roundedScores).length;
  const label = {
    id: `ground-truth-label-${stableHash({ windowId, roundedScores, labeler })}`,
    schemaVersion: SCHEMA_VERSIONS.GROUND_TRUTH_LABEL,
    type: 'ground_truth_label',
    windowId,
    sessionId: safeText(window?.sessionId || window?.metadata?.sessionId || '', 120),
    sourceMode: safeText(sourceMode || window?.mode || window?.metadata?.mode || '', 80),
    labeler: safeText(labeler, 120),
    scores: roundedScores,
    aggregate: Number(aggregate.toFixed(3)),
    notes: safeText(notes, 1000),
    windowHash: fullHash(window || {}),
    createdAt: now
  };
  label.labelHash = fullHash({ ...label, labelHash: undefined });
  return label;
}

function validateGroundTruthLabel(label = {}) {
  const scoreValidation = validateScores(label.scores || {});
  const errors = [];
  if (label.schemaVersion !== SCHEMA_VERSIONS.GROUND_TRUTH_LABEL) errors.push('schemaVersion');
  if (label.type !== 'ground_truth_label') errors.push('type');
  if (!label.windowId) errors.push('windowId');
  if (!scoreValidation.ok) errors.push('scores');
  return {
    ok: errors.length === 0,
    errors,
    scoreValidation
  };
}

module.exports = {
  buildGroundTruthLabel,
  validateGroundTruthLabel
};
