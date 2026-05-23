'use strict';

const { clamp, ensureArray, safeText, stableHash } = require('./safe');

function detectFailureSignatures(window = {}, config = {}) {
  const thresholds = config.detectors || {};
  const detectors = [
    detectRepeatedToolFailure,
    detectToolLoop,
    detectCorrectionNotIntegrated,
    detectModeBleed,
    detectReceiptMismatch,
    detectUngroundedRecommendation,
    detectLowSurpriseDrift,
    detectCognitiveStateAnomaly
  ];
  return detectors.flatMap((detector) => detector(window, thresholds)).filter(Boolean);
}

function detectRepeatedToolFailure(window, thresholds) {
  const minFailures = numberOr(thresholds.minRepeatedToolFailures, 2);
  const byTool = new Map();
  for (const call of ensureArray(window.toolCalls)) {
    if (call.success !== false) continue;
    const record = byTool.get(call.toolName) || { count: 0, examples: [] };
    record.count += 1;
    if (record.examples.length < 3) record.examples.push(call.resultSummary || call.paramsSummary || 'failed tool call');
    byTool.set(call.toolName, record);
  }
  return [...byTool.entries()]
    .filter(([, record]) => record.count >= minFailures)
    .map(([toolName, record]) => signature({
      signature: 'repeated_tool_failure',
      lane: 'tool_hint_patch',
      targetSurface: `tool:${toolName}`,
      title: `Repeated ${toolName} failure`,
      summary: `${record.count} failed ${toolName} calls appeared in the trajectory window.`,
      confidence: 0.55 + (record.count * 0.1),
      evidence: { toolName, failureCount: record.count, examples: record.examples }
    }));
}

function detectToolLoop(window, thresholds) {
  const minRepeats = numberOr(thresholds.minToolLoopRepeats, 3);
  const byCallShape = new Map();
  for (const call of ensureArray(window.toolCalls)) {
    const key = `${call.toolName}:${call.paramsHash}`;
    const record = byCallShape.get(key) || { count: 0, toolName: call.toolName, successes: 0 };
    record.count += 1;
    if (call.success) record.successes += 1;
    byCallShape.set(key, record);
  }
  return [...byCallShape.values()]
    .filter((record) => record.count >= minRepeats && record.successes < record.count)
    .map((record) => signature({
      signature: 'tool_loop',
      lane: 'workflow_patch',
      targetSurface: `tool-loop:${record.toolName}`,
      title: `Tool loop around ${record.toolName}`,
      summary: `${record.toolName} was retried ${record.count} times with the same input shape before new evidence appeared.`,
      confidence: 0.6 + (record.count * 0.07),
      evidence: { toolName: record.toolName, repeatCount: record.count, successCount: record.successes }
    }));
}

function detectCorrectionNotIntegrated(window) {
  if ((window.stats?.userCorrections || 0) === 0) return [];
  const failedAfterCorrection = ensureArray(window.toolCalls).some((call) => call.success === false);
  if (!failedAfterCorrection) return [];
  return [signature({
    signature: 'correction_not_integrated',
    lane: 'session_note_patch',
    targetSurface: 'correction-repair',
    title: 'Correction needs an explicit repair checkpoint',
    summary: 'A user correction and later failed work appeared in the same trajectory window.',
    confidence: 0.68,
    evidence: { userCorrections: window.stats.userCorrections, failedToolCalls: window.stats.failedToolCalls }
  })];
}

function detectModeBleed(window) {
  const mode = (window.mode || '').toLowerCase();
  const assistantText = ensureArray(window.messages)
    .filter((message) => message.role === 'assistant')
    .map((message) => message.content.toLowerCase())
    .join('\n');
  const explicit = window.metadata?.modeMismatch === true || window.metadata?.failureSignature === 'mode_bleed';
  const wrongModeText = mode !== 'code' && /\b(code mode|booth|training grounds|embodiment mode)\b/.test(assistantText);
  if (!explicit && !wrongModeText) return [];
  return [signature({
    signature: 'mode_bleed',
    lane: 'mode_patch',
    targetSurface: `mode:${window.mode || 'unknown'}`,
    title: 'Mode posture appears to have bled into the wrong surface',
    summary: 'The response carried mode-specific posture outside its expected context.',
    confidence: explicit ? 0.82 : 0.62,
    evidence: { mode: window.mode, explicit }
  })];
}

function detectReceiptMismatch(window) {
  const explicit = window.metadata?.receiptMismatch === true || window.metadata?.failureSignature === 'receipt_mismatch';
  const hasReceipts = ensureArray(window.receiptHandles).length > 0 || ensureArray(window.sourceHandles).length > 0;
  const assistantText = ensureArray(window.messages)
    .filter((message) => message.role === 'assistant')
    .map((message) => message.content.toLowerCase())
    .join('\n');
  const overclaims = /\b(i saw|i can see|confirmed|verified|definitely)\b/.test(assistantText) && !hasReceipts;
  if (!explicit && !overclaims) return [];
  return [signature({
    signature: 'receipt_mismatch',
    lane: 'workflow_patch',
    targetSurface: 'receipt-grounding',
    title: 'Receipt certainty mismatch',
    summary: 'The trajectory suggests current-state certainty without adequate receipt/source handles.',
    confidence: explicit ? 0.84 : 0.64,
    evidence: { hasReceipts, explicit }
  })];
}

function detectUngroundedRecommendation(window) {
  const assistantText = ensureArray(window.messages)
    .filter((message) => message.role === 'assistant')
    .map((message) => message.content.toLowerCase())
    .join('\n');
  if (!/\b(should|recommend|best|latest|current)\b/.test(assistantText)) return [];
  if (ensureArray(window.sourceHandles).length > 0 || ensureArray(window.receiptHandles).length > 0) return [];
  return [signature({
    signature: 'ungrounded_recommendation',
    lane: 'workflow_patch',
    targetSurface: 'recommendation-grounding',
    title: 'Recommendation needs provenance',
    summary: 'A recommendation-like response appeared without source or receipt handles.',
    confidence: 0.58,
    evidence: { sourceHandleCount: 0 }
  })];
}

function detectLowSurpriseDrift(window, thresholds) {
  const surprise = cognitiveSurprise(window);
  const maxLowSurprise = numberOr(thresholds.lowSurpriseThreshold, 0.25);
  const toolCount = window.stats?.toolCallCount || 0;
  if (surprise === null || surprise > maxLowSurprise || toolCount < numberOr(thresholds.minLowSurpriseToolCalls, 3)) return [];
  return [signature({
    signature: 'low_surprise_drift',
    lane: 'workflow_patch',
    targetSurface: 'low-surprise-task-drift',
    title: 'Low-surprise task drift',
    summary: 'The agent stayed in familiar task work while tool activity continued, which can hide non-progress loops.',
    confidence: 0.62 + Math.min(0.2, toolCount * 0.03),
    evidence: { surprise, toolCallCount: toolCount, latentBucket: window.cognitiveSnapshot?.latentBucket || null }
  })];
}

function detectCognitiveStateAnomaly(window, thresholds) {
  const snapshot = window.cognitiveSnapshot || {};
  const surprise = cognitiveSurprise(window);
  const highSurprise = surprise !== null && surprise >= numberOr(thresholds.highSurpriseThreshold, 0.7);
  const featureValues = Object.values(snapshot.featureAvailability || {});
  const featureGap = featureValues.length > 0 && featureValues.filter(Boolean).length / featureValues.length < 0.5;
  if (!highSurprise && !featureGap) return [];
  return [signature({
    signature: 'cognitive_state_anomaly',
    lane: 'workflow_patch',
    targetSurface: featureGap ? 'cognitive-feature-gap' : 'cognitive-surprise-spike',
    title: featureGap ? 'Cognitive feature availability gap' : 'Cognitive surprise spike',
    summary: featureGap
      ? 'The cognitive layer had too few available features to support strong interpretation.'
      : 'The window coincided with a high cognitive prediction error.',
    confidence: featureGap ? 0.56 : 0.66,
    evidence: { surprise, featureAvailability: snapshot.featureAvailability || {}, latentBucket: snapshot.latentBucket || null }
  })];
}

function signature(input) {
  const confidence = clamp(input.confidence, 0, 0.95);
  const targetSurface = safeText(input.targetSurface, 160);
  return {
    id: `signature-${stableHash(`${input.signature}:${input.lane}:${targetSurface}`)}`,
    signature: input.signature,
    lane: input.lane,
    targetSurface,
    title: safeText(input.title, 140),
    summary: safeText(input.summary, 500),
    confidence: Number(confidence.toFixed(3)),
    evidence: input.evidence || {}
  };
}

function cognitiveSurprise(window) {
  const snapshot = window.cognitiveSnapshot || {};
  return snapshot.surpriseFrozen ?? snapshot.surpriseLearned ?? null;
}

function numberOr(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

module.exports = {
  detectFailureSignatures
};
