'use strict';

const PROTECTED_LANES = new Set([
  'memory_patch',
  'mode_patch',
  'prompt_patch',
  'skill_patch',
  'subagent_brief_patch'
]);

const AUTO_SESSION_NOTE_ONLY = new Set(['session_note_patch']);

function classifyProtectedLane(lane) {
  const safeLane = String(lane || '');
  return {
    lane: safeLane,
    protectedLane: PROTECTED_LANES.has(safeLane) ? safeLane : null,
    applyPath: safeLane === 'memory_patch'
      ? 'claim_review_lane'
      : PROTECTED_LANES.has(safeLane)
        ? 'review_only'
        : safeLane === 'workflow_patch' || safeLane === 'tool_hint_patch'
          ? 'existing_scaffold_gate'
          : AUTO_SESSION_NOTE_ONLY.has(safeLane)
            ? 'session_ttl_only'
            : 'review_only',
    mutationAttempted: 'false',
    promptInjectionChanged: 'false',
    directApplyAllowed: AUTO_SESSION_NOTE_ONLY.has(safeLane)
  };
}

function assertNoProtectedMutation(action = {}) {
  if (action.launchTraining || action.trainingLaunch || action.adapterPromotion || action.modelRoutingMutation) {
    throw new Error('Harness Refiner v1 cannot launch training, promote adapters, or mutate model routing');
  }
  if (action.mutationAttempted === true || action.mutationAttempted === 'true') {
    throw new Error('Harness Refiner proposals must be proposal-only');
  }
  if (action.gatewayInvocation || action.sessionKey || action.threadIdCreated || action.isolatedRunRequest) {
    throw new Error('Harness Refiner plugins must not construct Gateway sub-agent/session semantics');
  }
  return true;
}

module.exports = {
  assertNoProtectedMutation,
  classifyProtectedLane
};
