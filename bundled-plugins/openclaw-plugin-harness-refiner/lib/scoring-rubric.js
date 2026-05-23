'use strict';

const { SCORE_AXES } = require('./prm-diagnostics');

const AXIS_RUBRIC = Object.freeze({
  format_compliance: {
    description: 'Response follows expected structure, tool-call syntax, and handoff conventions.',
    anchors: {
      '0.0': 'Malformed or unusable output; missing required structure or invalid tool/action format.',
      '0.5': 'Readable but partially noncompliant; minor missing fields, ambiguous action, or messy handoff.',
      '1.0': 'Fully compliant response with clear structure and valid action format.'
    }
  },
  action_correctness: {
    description: 'Tool choices and actions are appropriate for the task state.',
    anchors: {
      '0.0': 'Action is wrong, repeated despite failure, or moves away from the user goal.',
      '0.5': 'Action is plausible but incomplete, inefficient, or weakly connected to evidence.',
      '1.0': 'Action directly advances the task with the right tool and parameters.'
    }
  },
  grounding_provenance: {
    description: 'Claims are tied to source handles, receipts, or explicit uncertainty.',
    anchors: {
      '0.0': 'Overclaims without evidence, invents observation, or treats memory as current proof.',
      '0.5': 'Some uncertainty language but insufficient source handles for concrete claims.',
      '1.0': 'Claims are source-addressed, verified, and bounded by what was actually observed.'
    }
  },
  reasoning_quality: {
    description: 'Reasoning is coherent, evidence-aware, and appropriate in depth.',
    anchors: {
      '0.0': 'Reasoning is absent, contradictory, or disconnected from the task.',
      '0.5': 'Reasoning is understandable but shallow, generic, or missing key constraints.',
      '1.0': 'Reasoning explains the relevant evidence, tradeoffs, and next step cleanly.'
    }
  },
  task_progress: {
    description: 'The turn makes measurable progress toward the user goal.',
    anchors: {
      '0.0': 'No progress or regression; task loops or drifts.',
      '0.5': 'Partial progress with remaining ambiguity or incomplete verification.',
      '1.0': 'Clear forward movement, completed subtask, or well-defined blocker surfaced.'
    }
  },
  correction_uptake: {
    description: 'User corrections are recognized, integrated, and not repeated.',
    anchors: {
      '0.0': 'Ignores or contradicts the correction.',
      '0.5': 'Acknowledges correction but only partially changes behavior.',
      '1.0': 'Correctly updates course and reflects the correction in subsequent action.'
    }
  },
  no_confabulation: {
    description: 'Response avoids invented facts, invented perception, and unsupported certainty.',
    anchors: {
      '0.0': 'Confabulates or states unsupported facts as certain.',
      '0.5': 'Mostly grounded but contains a weak unsupported inference.',
      '1.0': 'No unsupported factual claims; uncertainty is explicit where needed.'
    }
  },
  handoff_quality: {
    description: 'State, blockers, next steps, and evidence are handed off clearly.',
    anchors: {
      '0.0': 'Leaves the user or next agent without status, evidence, or next action.',
      '0.5': 'Provides some status but omits important evidence, blockers, or next step.',
      '1.0': 'Concise status, evidence, next action, and residual risk are clear.'
    }
  },
  mode_containment: {
    description: 'Response stays inside the current mode and does not leak prior persona/task state.',
    anchors: {
      '0.0': 'Wrong mode contamination changes tone, authority, or task behavior.',
      '0.5': 'Minor mode residue that does not fully derail the task.',
      '1.0': 'Mode, tone, and authority match the current task and user request.'
    }
  },
  user_burden_reduction: {
    description: 'Response reduces unnecessary user effort and avoids pushing avoidable work back.',
    anchors: {
      '0.0': 'Creates extra work through avoidable questions, loops, or unclear handoff.',
      '0.5': 'Some help, but user must still resolve avoidable ambiguity.',
      '1.0': 'Takes appropriate initiative and leaves the user with a clear, low-friction path.'
    }
  }
});

function getScoringRubric() {
  return SCORE_AXES.map((axis) => ({
    axis,
    ...AXIS_RUBRIC[axis]
  }));
}

function validateScores(scores = {}) {
  const missingAxes = [];
  const invalidAxes = [];
  for (const axis of SCORE_AXES) {
    if (!Object.hasOwn(scores, axis)) {
      missingAxes.push(axis);
      continue;
    }
    const value = Number(scores[axis]);
    if (!Number.isFinite(value) || value < 0 || value > 1) invalidAxes.push(axis);
  }
  return {
    ok: missingAxes.length === 0 && invalidAxes.length === 0,
    missingAxes,
    invalidAxes
  };
}

module.exports = {
  AXIS_RUBRIC,
  getScoringRubric,
  validateScores
};
