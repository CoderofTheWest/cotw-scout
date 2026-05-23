'use strict';

const { fullHash, safeText, stableHash } = require('./safe');
const { SCHEMA_VERSIONS } = require('./schema-versions');

function buildRelabelCandidatePacket({ window, scoreReceipt, agentId = 'trail-guide', harnessVersion = '', modelOrAdapterHash = '', now = new Date().toISOString() } = {}) {
  const lowAxes = scoreReceipt?.lowScoreAxes || [];
  const id = `relabel-candidate-${stableHash(`${window?.id}:${lowAxes.join(',')}`)}`;
  return {
    id,
    schemaVersion: SCHEMA_VERSIONS.RELABEL_CANDIDATE_PACKET,
    packetId: id,
    type: 'relabel_candidate_packet',
    windowId: window?.id,
    sessionId: safeText(window?.sessionId || window?.metadata?.sessionId || '', 120),
    sourceMode: safeText(window?.mode || window?.metadata?.mode || '', 80),
    agentId,
    harnessVersion,
    modelOrAdapterHash,
    scorerVersion: scoreReceipt?.scorerVersion || 'unknown',
    scoreReceiptId: scoreReceipt?.id || '',
    scoreReceiptHash: fullHash(scoreReceipt || {}),
    scores: scoreReceipt?.scores || {},
    aggregate: scoreReceipt?.aggregate ?? null,
    lowScoreAxes: lowAxes,
    sourceHandles: window?.sourceHandles || [],
    originalResponseHandle: responseHandle(window),
    inclusionDecision: 'candidate',
    exclusionReason: null,
    shardId: `cotw-relabel-shard-${new Date(now).toISOString().slice(0, 10)}`,
    shardHash: fullHash({ windowId: window?.id, scoreReceipt }),
    redactionPolicy: 'default-local-research-redaction',
    createdAt: now
  };
}

function buildTeacherRelabelReceipt({ candidatePacket, teacherRepair, teacherModel = 'teacher-model-unset', includeInShard = false, qualityGate = null, now = new Date().toISOString() } = {}) {
  const id = `teacher-relabel-${stableHash(`${candidatePacket?.id}:${teacherModel}:${teacherRepair}`)}`;
  const gate = normalizeQualityGate(qualityGate);
  const requestedInclusion = includeInShard === true;
  const shardEligible = requestedInclusion && gate.accepted === true;
  return {
    id,
    schemaVersion: SCHEMA_VERSIONS.TEACHER_RELABEL_RECEIPT,
    type: 'teacher_relabel_receipt',
    windowId: candidatePacket?.windowId,
    sessionId: safeText(candidatePacket?.sessionId || '', 120),
    sourceMode: safeText(candidatePacket?.sourceMode || '', 80),
    candidatePacketId: candidatePacket?.id,
    studentModel: candidatePacket?.modelOrAdapterHash || '',
    harnessVersion: candidatePacket?.harnessVersion || '',
    scores: candidatePacket?.scores || {},
    aggregate: candidatePacket?.aggregate ?? null,
    lowScoreAxes: candidatePacket?.lowScoreAxes || [],
    originalResponseHandle: candidatePacket?.originalResponseHandle || '',
    teacherModel: safeText(teacherModel, 120),
    teacherRepairHandle: `teacher-repair:${stableHash(teacherRepair || '')}`,
    teacherRepairSummary: safeText(teacherRepair || '', 1000),
    diffSummary: safeText(diffSummary(candidatePacket, teacherRepair, gate), 600),
    qualityGate: gate,
    originalAggregate: gate.originalAggregate ?? candidatePacket?.aggregate ?? null,
    teacherAggregate: gate.teacherAggregate ?? null,
    perAxisDelta: gate.perAxisDelta || {},
    repairLengthDelta: gate.repairLengthDelta ?? null,
    includeInShard: Boolean(shardEligible),
    inclusionDecision: shardEligible ? 'included' : 'excluded',
    exclusionReason: shardEligible ? null : exclusionReason({ requestedInclusion, gate }),
    shardId: candidatePacket?.shardId || '',
    shardHash: fullHash({ candidatePacket, teacherRepair, includeInShard: shardEligible, qualityGate: gate }),
    redactionPolicy: candidatePacket?.redactionPolicy || 'default-local-research-redaction',
    trainingLaunchAuthorized: false,
    adapterPromotionAuthorized: false,
    createdAt: now
  };
}

function responseHandle(window) {
  const assistant = [...(window?.messages || [])].reverse().find((message) => message.role === 'assistant');
  return assistant ? `window:${window.id}:assistant:${stableHash(assistant.content)}` : `window:${window?.id || 'unknown'}:assistant:none`;
}

function diffSummary(candidatePacket, teacherRepair, gate = {}) {
  if (!teacherRepair) return 'Teacher repair not supplied yet.';
  const delta = Number.isFinite(Number(gate.teacherAggregate)) && Number.isFinite(Number(gate.originalAggregate))
    ? ` aggregate ${Number(gate.originalAggregate).toFixed(3)} -> ${Number(gate.teacherAggregate).toFixed(3)}`
    : ' aggregate not scored';
  const changedAxes = Object.entries(gate.perAxisDelta || {})
    .filter(([, value]) => Number(value) !== 0)
    .sort((a, b) => Math.abs(Number(b[1])) - Math.abs(Number(a[1])))
    .slice(0, 3)
    .map(([axis, value]) => `${axis} ${Number(value) > 0 ? '+' : ''}${Number(value).toFixed(3)}`);
  const axisText = changedAxes.length ? `; top axis deltas: ${changedAxes.join(', ')}` : '; no axis deltas recorded';
  return `Teacher repair supplied for ${candidatePacket?.windowId || 'unknown window'};${delta}${axisText}; length delta ${gate.repairLengthDelta ?? 'unknown'}.`;
}

function normalizeQualityGate(gate) {
  if (!gate || typeof gate !== 'object') {
    return {
      schemaVersion: SCHEMA_VERSIONS.TEACHER_REPAIR_QUALITY_RECEIPT,
      accepted: null,
      status: 'unscored',
      exclusionReason: 'teacher_repair_not_scored'
    };
  }
  return {
    schemaVersion: gate.schemaVersion || SCHEMA_VERSIONS.TEACHER_REPAIR_QUALITY_RECEIPT,
    accepted: gate.accepted === true,
    status: safeText(gate.status || (gate.accepted ? 'accepted' : 'rejected'), 80),
    exclusionReason: gate.exclusionReason || null,
    scorerVersion: gate.scorerVersion || '',
    originalAggregate: gate.originalAggregate ?? null,
    teacherAggregate: gate.teacherAggregate ?? null,
    perAxisDelta: gate.perAxisDelta || {},
    repairLengthDelta: gate.repairLengthDelta ?? null,
    qualityReceiptHash: gate.qualityReceiptHash || gate.receiptHash || ''
  };
}

function exclusionReason({ requestedInclusion, gate }) {
  if (requestedInclusion && gate.accepted === false) return gate.exclusionReason || 'teacher_repair_quality_gate_failed';
  if (requestedInclusion && gate.accepted === null) return 'teacher_repair_not_scored';
  return 'teacher_repair_recorded_but_not_marked_for_shard';
}

module.exports = {
  buildRelabelCandidatePacket,
  buildTeacherRelabelReceipt
};
