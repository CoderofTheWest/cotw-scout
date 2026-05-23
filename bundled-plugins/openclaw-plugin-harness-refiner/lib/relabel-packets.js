'use strict';

const { fullHash, safeText, stableHash } = require('./safe');

function buildRelabelCandidatePacket({ window, scoreReceipt, agentId = 'trail-guide', harnessVersion = '', modelOrAdapterHash = '', now = new Date().toISOString() } = {}) {
  const lowAxes = scoreReceipt?.lowScoreAxes || [];
  const id = `relabel-candidate-${stableHash(`${window?.id}:${lowAxes.join(',')}`)}`;
  return {
    id,
    packetId: id,
    type: 'relabel_candidate_packet',
    windowId: window?.id,
    agentId,
    harnessVersion,
    modelOrAdapterHash,
    scorerVersion: scoreReceipt?.scorerVersion || 'unknown',
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

function buildTeacherRelabelReceipt({ candidatePacket, teacherRepair, teacherModel = 'teacher-model-unset', includeInShard = false, now = new Date().toISOString() } = {}) {
  const id = `teacher-relabel-${stableHash(`${candidatePacket?.id}:${teacherModel}:${teacherRepair}`)}`;
  return {
    id,
    type: 'teacher_relabel_receipt',
    windowId: candidatePacket?.windowId,
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
    diffSummary: safeText(diffSummary(candidatePacket, teacherRepair), 600),
    includeInShard: Boolean(includeInShard),
    inclusionDecision: includeInShard ? 'included' : 'excluded',
    exclusionReason: includeInShard ? null : 'teacher_repair_recorded_but_not_marked_for_shard',
    shardId: candidatePacket?.shardId || '',
    shardHash: fullHash({ candidatePacket, teacherRepair, includeInShard }),
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

function diffSummary(candidatePacket, teacherRepair) {
  if (!teacherRepair) return 'Teacher repair not supplied yet.';
  return `Teacher repair supplied for ${candidatePacket?.windowId || 'unknown window'}; full repair is stored behind teacherRepairHandle.`;
}

module.exports = {
  buildRelabelCandidatePacket,
  buildTeacherRelabelReceipt
};
