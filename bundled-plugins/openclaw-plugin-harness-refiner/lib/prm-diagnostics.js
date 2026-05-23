'use strict';

const { clamp, safeText, stableHash } = require('./safe');

const SCORE_AXES = [
  'format_compliance',
  'action_correctness',
  'grounding_provenance',
  'reasoning_quality',
  'task_progress',
  'correction_uptake',
  'no_confabulation',
  'handoff_quality',
  'mode_containment',
  'user_burden_reduction'
];

function scoreWindow(window = {}, options = {}) {
  const scores = {
    format_compliance: scoreFormat(window),
    action_correctness: scoreAction(window),
    grounding_provenance: scoreGrounding(window),
    reasoning_quality: scoreReasoning(window),
    task_progress: scoreProgress(window),
    correction_uptake: scoreCorrectionUptake(window),
    no_confabulation: scoreNoConfabulation(window),
    handoff_quality: scoreHandoff(window),
    mode_containment: scoreModeContainment(window),
    user_burden_reduction: scoreUserBurden(window)
  };
  const aggregate = SCORE_AXES.reduce((sum, axis) => sum + scores[axis], 0) / SCORE_AXES.length;
  return {
    id: `process-score-${stableHash(`${window.id}:${JSON.stringify(scores)}`)}`,
    windowId: window.id,
    scorerVersion: options.scorerVersion || 'harness-refiner-prm-heuristic-v1',
    scores: roundScores(scores),
    aggregate: Number(aggregate.toFixed(3)),
    lowScoreAxes: SCORE_AXES.filter((axis) => scores[axis] < 0.5),
    cognitiveMetadata: {
      latentBucket: window.cognitiveSnapshot?.latentBucket || null,
      surpriseFrozen: window.cognitiveSnapshot?.surpriseFrozen ?? null,
      surpriseLearned: window.cognitiveSnapshot?.surpriseLearned ?? null,
      rawLatentIncluded: window.cognitiveSnapshot?.rawLatentIncluded === true
    },
    createdAt: options.now || new Date().toISOString()
  };
}

function isLowScore(scoreReceipt, threshold = 0.55) {
  return Number(scoreReceipt?.aggregate || 0) < threshold || (scoreReceipt?.lowScoreAxes || []).length >= 3;
}

function roundScores(scores) {
  const out = {};
  for (const [axis, value] of Object.entries(scores)) out[axis] = Number(clamp(value).toFixed(3));
  return out;
}

function scoreFormat(window) {
  return (window.toolCalls || []).some((call) => !call.toolName) ? 0.4 : 0.9;
}

function scoreAction(window) {
  const total = window.stats?.toolCallCount || 0;
  if (total === 0) return 0.75;
  const failed = window.stats?.failedToolCalls || 0;
  return clamp(1 - (failed / Math.max(1, total)));
}

function scoreGrounding(window) {
  const handles = (window.sourceHandles || []).length + (window.receiptHandles || []).length;
  const assistantText = safeText((window.messages || []).filter((m) => m.role === 'assistant').map((m) => m.content).join('\n'), 4000).toLowerCase();
  if (handles > 0) return 0.9;
  if (/\b(i think|likely|appears|seems|infer)\b/.test(assistantText)) return 0.65;
  if (/\b(verified|confirmed|definitely|i saw|i can see)\b/.test(assistantText)) return 0.25;
  return 0.55;
}

function scoreReasoning(window) {
  const assistantText = (window.messages || []).filter((m) => m.role === 'assistant').map((m) => m.content).join('\n');
  if (assistantText.length < 20) return 0.45;
  if (/\b(because|so|therefore|next|evidence|verify)\b/i.test(assistantText)) return 0.75;
  return 0.6;
}

function scoreProgress(window) {
  if ((window.metadata?.stalledObjective || window.metadata?.planDrift) === true) return 0.25;
  if ((window.stats?.failedToolCalls || 0) >= 2) return 0.45;
  return 0.7;
}

function scoreCorrectionUptake(window) {
  if ((window.stats?.userCorrections || 0) === 0) return 0.8;
  return (window.stats?.failedToolCalls || 0) > 0 ? 0.4 : 0.75;
}

function scoreNoConfabulation(window) {
  return window.metadata?.confabulation === true || window.metadata?.receiptMismatch === true ? 0.25 : 0.8;
}

function scoreHandoff(window) {
  const assistantText = (window.messages || []).filter((m) => m.role === 'assistant').map((m) => m.content).join('\n');
  return /\b(next|remaining|status|summary|handoff|done|blocked)\b/i.test(assistantText) ? 0.75 : 0.55;
}

function scoreModeContainment(window) {
  return window.metadata?.modeMismatch === true ? 0.25 : 0.85;
}

function scoreUserBurden(window) {
  if ((window.stats?.userCorrections || 0) > 0 && (window.stats?.failedToolCalls || 0) > 0) return 0.35;
  return 0.7;
}

module.exports = {
  SCORE_AXES,
  isLowScore,
  scoreWindow
};
