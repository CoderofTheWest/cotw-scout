'use strict';

const { fullHash, safeText } = require('./safe');
const { scoreWindow, SCORE_AXES } = require('./prm-diagnostics');
const { SCHEMA_VERSIONS } = require('./schema-versions');

function buildTeacherRepairQualityReceipt({
  window,
  candidatePacket,
  teacherRepair,
  scorerVersion = 'harness-refiner-prm-heuristic-v1',
  now = new Date().toISOString()
} = {}) {
  const originalScore = candidatePacket?.scores && Object.keys(candidatePacket.scores).length
    ? {
        scores: candidatePacket.scores,
        aggregate: Number(candidatePacket.aggregate),
        scorerVersion: candidatePacket.scorerVersion || scorerVersion
      }
    : scoreWindow(window || {}, { scorerVersion, now });
  const repairedWindow = buildRepairedWindow(window || {}, teacherRepair);
  const teacherScore = scoreWindow(repairedWindow, { scorerVersion, now });
  const perAxisDelta = {};
  for (const axis of SCORE_AXES) {
    perAxisDelta[axis] = Number((Number(teacherScore.scores[axis] || 0) - Number(originalScore.scores?.[axis] || 0)).toFixed(3));
  }
  const originalText = finalAssistantText(window);
  const repairLengthDelta = safeText(teacherRepair || '', 4000).length - originalText.length;
  const originalAggregate = Number(originalScore.aggregate ?? 0);
  const teacherAggregate = Number(teacherScore.aggregate ?? 0);
  const accepted = teacherAggregate > originalAggregate;
  const receipt = {
    schemaVersion: SCHEMA_VERSIONS.TEACHER_REPAIR_QUALITY_RECEIPT,
    type: 'teacher_repair_quality_receipt',
    windowId: safeText(window?.id || candidatePacket?.windowId || '', 140),
    candidatePacketId: safeText(candidatePacket?.id || '', 160),
    scorerVersion,
    originalScoreReceiptId: safeText(candidatePacket?.scoreReceiptId || originalScore.id || '', 160),
    teacherScoreReceiptId: safeText(teacherScore.id || '', 160),
    originalAggregate: Number(originalAggregate.toFixed(3)),
    teacherAggregate: Number(teacherAggregate.toFixed(3)),
    perAxisDelta,
    repairLengthDelta,
    accepted,
    status: accepted ? 'accepted' : 'rejected',
    exclusionReason: accepted ? null : 'teacher_did_not_improve',
    teacherScoreReceipt: teacherScore,
    createdAt: now
  };
  receipt.qualityReceiptHash = fullHash({ ...receipt, qualityReceiptHash: undefined });
  return receipt;
}

function buildRepairedWindow(window = {}, teacherRepair = '') {
  const messages = Array.isArray(window.messages) ? window.messages.slice() : [];
  const repairText = safeText(teacherRepair || '', 4000);
  const stillOverclaims = repairStillOverclaims(window, repairText);
  let replaced = false;
  for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
    if (messages[idx]?.role === 'assistant') {
      messages[idx] = { ...messages[idx], content: repairText };
      replaced = true;
      break;
    }
  }
  if (!replaced) messages.push({ role: 'assistant', content: repairText });

  return {
    ...window,
    messages,
    metadata: {
      ...(window.metadata || {}),
      receiptMismatch: stillOverclaims ? window.metadata?.receiptMismatch === true : false,
      confabulation: stillOverclaims ? window.metadata?.confabulation === true : false,
      modeMismatch: false,
      teacherRepairEvaluation: true
    }
  };
}

function repairStillOverclaims(window = {}, repairText = '') {
  const lower = String(repairText || '').toLowerCase();
  const hasSource = (window.sourceHandles || []).length > 0 || (window.receiptHandles || []).length > 0;
  const certainty = /\b(definitely|confirmed|verified|i saw|i can see|clearly saw)\b/.test(lower);
  const uncertainty = /\b(infer|appears|seems|likely|should not claim|without claiming|unless the evidence|what the evidence supports)\b/.test(lower);
  return certainty && !hasSource && !uncertainty;
}

function finalAssistantText(window = {}) {
  const assistant = [...(window.messages || [])].reverse().find((message) => message.role === 'assistant');
  return safeText(assistant?.content || '', 4000);
}

module.exports = {
  buildRepairedWindow,
  buildTeacherRepairQualityReceipt
};
