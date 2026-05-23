'use strict';

const { getScoringRubric } = require('./scoring-rubric');
const { safeText } = require('./safe');

function buildTeacherRepairPrompt({ window = {}, candidatePacket = {}, lowScoreAxes = null } = {}) {
  const axes = lowScoreAxes || candidatePacket.lowScoreAxes || [];
  const rubric = getScoringRubric().filter((entry) => axes.length === 0 || axes.includes(entry.axis));
  return [
    'You are repairing one assistant response for a training-data relabel packet.',
    'Produce only the corrected assistant response. Do not explain the repair outside the response.',
    '',
    'Low-score axes:',
    axes.length ? axes.map((axis) => `- ${axis}`).join('\n') : '- none provided',
    '',
    'Rubric:',
    rubric.map((entry) => `- ${entry.axis}: 0.0 ${entry.anchors['0.0']} | 0.5 ${entry.anchors['0.5']} | 1.0 ${entry.anchors['1.0']}`).join('\n'),
    '',
    'Trajectory window:',
    safeText(JSON.stringify({
      id: window.id,
      mode: window.mode,
      sessionId: window.sessionId,
      messages: window.messages,
      toolCalls: window.toolCalls,
      sourceHandles: window.sourceHandles,
      metadata: window.metadata
    }, null, 2), 8000)
  ].join('\n');
}

module.exports = {
  buildTeacherRepairPrompt
};
