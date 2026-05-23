'use strict';

const { classifyProtectedLane } = require('./protected-lanes');
const { clamp, safeText, stableHash } = require('./safe');

const LANE_CHANGE_TYPE = {
  workflow_patch: 'workflow_sequence',
  tool_hint_patch: 'tool_hint',
  mode_patch: 'mode_rule',
  skill_patch: 'skill_guidance',
  memory_patch: 'claim_review_hint',
  prompt_patch: 'prompt_rule',
  session_note_patch: 'session_note',
  subagent_brief_patch: 'subagent_brief'
};

function buildProposal({ signature, window, agentId = 'trail-guide', scaffoldVersion = '', now = new Date().toISOString() } = {}) {
  const lane = signature.lane || 'workflow_patch';
  const lanePolicy = classifyProtectedLane(lane);
  const confidence = clamp(signature.confidence || 0.5, 0, 0.95);
  const id = `harness-refiner-proposal-${stableHash(`${signature.signature}:${lane}:${signature.targetSurface}`)}`;
  const proposedChange = proposedChangeFor(signature);
  const verification = verificationFor(signature);
  return {
    id,
    class: classFor(signature.signature, lane),
    title: `Harness proposal: ${safeText(signature.title, 120)}`,
    summary: safeText(signature.summary, 700),
    status: 'preview',
    risk: riskFor(lane, signature.signature),
    sourceCategory: 'harness-refiner proposal',
    allowedBy: 'Harness Refiner proposal-only loop; no protected state mutation, prompt injection, scheduler linkage, training launch, adapter promotion, or Gateway sub-agent spawn.',
    expectedEffect: expectedEffectFor(signature),
    verification,
    rollback: 'Dismiss or deny this proposal in Evolve. No runtime, scaffold, memory, model, Gateway, or prompt mutation has been applied.',
    action: 'harness_refinement_proposal',
    receiptId: id,
    metadata: {
      signature: signature.signature,
      lane,
      changeType: LANE_CHANGE_TYPE[lane] || 'workflow_sequence',
      targetSurface: signature.targetSurface,
      windowId: window?.id || null,
      windowScope: window?.scope || null,
      triggerEvent: window?.triggerEvent || null,
      proposedChange,
      evidence: signature.evidence || {},
      sourceHandles: window?.sourceHandles || [],
      cognitiveSnapshot: window?.cognitiveSnapshot || { available: false, rawLatentIncluded: false },
      confidence: Number(confidence.toFixed(3)),
      agentId,
      scaffoldVersion,
      mutationAttempted: lanePolicy.mutationAttempted,
      promptInjectionChanged: lanePolicy.promptInjectionChanged,
      protectedLane: lanePolicy.protectedLane,
      applyPath: lanePolicy.applyPath,
      directApplyAllowed: lanePolicy.directApplyAllowed,
      launchTraining: false,
      adapterPromotion: false,
      modelRoutingMutation: false,
      gatewayInvocation: false,
      testPlan: verification,
      rollbackPlan: 'No-op rollback: dismiss the proposal. Promotion is a separate operator-gated lane.'
    },
    createdAt: now,
    updatedAt: now
  };
}

function dedupeProposals(proposals = []) {
  const seen = new Set();
  const out = [];
  for (const proposal of proposals) {
    const key = `${proposal.metadata?.signature}:${proposal.metadata?.lane}:${proposal.metadata?.targetSurface}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(proposal);
  }
  return out;
}

function proposedChangeFor(signature) {
  switch (signature.signature) {
    case 'repeated_tool_failure':
      return `Before retrying ${signature.evidence?.toolName || 'the tool'}, verify inputs, summarize the prior failure, and choose the smallest observable recovery step.`;
    case 'tool_loop':
      return 'When a tool repeats with the same input shape, pause to name what new evidence is needed before another attempt.';
    case 'correction_not_integrated':
      return 'After user correction, create a temporary session note that restates the corrected constraint and updates the active plan.';
    case 'mode_bleed':
      return 'Add a review-only mode boundary rule that clears stale mode posture after mode exit or fresh-session markers.';
    case 'receipt_mismatch':
      return 'Require explicit distinction between current observation, source receipt, and inference before certainty claims.';
    case 'ungrounded_recommendation':
      return 'Require a source handle, receipt, or uncertainty marker before recommendation-like claims.';
    case 'low_surprise_drift':
      return 'Add a low-surprise drift checkpoint that asks whether repeated familiar work is still producing task progress.';
    case 'cognitive_state_anomaly':
      return 'Treat cognitive anomaly as triage metadata and request grounding/replay rather than applying a durable change.';
    default:
      return 'Record a bounded workflow patch proposal with evidence, verification, and rollback.';
  }
}

function expectedEffectFor(signature) {
  if (signature.signature === 'low_surprise_drift') return 'Reduce quiet non-progress loops while preserving normal focused task work.';
  if (signature.signature === 'cognitive_state_anomaly') return 'Improve diagnosis of surprising state transitions without treating surprise as truth.';
  return 'Reduce recurrence of the observed failure class without changing protected runtime state.';
}

function verificationFor(signature) {
  return `Run a fixture containing ${signature.signature} and confirm Harness Refiner emits one preview proposal with source handles, no mutation metadata, and a visible rollback path.`;
}

function classFor(signature, lane) {
  if (lane === 'memory_patch') return 'memory_hygiene';
  if (lane === 'mode_patch' || lane === 'prompt_patch') return 'posture_tuning';
  if (signature === 'receipt_mismatch' || signature === 'ungrounded_recommendation') return 'operational_lesson';
  return 'process_ui_friction';
}

function riskFor(lane, signature) {
  if (lane === 'memory_patch' || lane === 'prompt_patch' || lane === 'skill_patch' || lane === 'mode_patch') return 'medium';
  if (signature === 'cognitive_state_anomaly') return 'low';
  return 'low';
}

module.exports = {
  buildProposal,
  dedupeProposals
};
