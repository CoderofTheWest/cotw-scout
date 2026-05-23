'use strict';

const fs = require('fs');
const path = require('path');
const { SCORE_AXES } = require('./prm-diagnostics');
const { fullHash, safeText, stableHash } = require('./safe');
const { SCHEMA_VERSIONS } = require('./schema-versions');
const { assertShardUsesOnlyTrainSessions } = require('./holdout-split');

const DEFAULT_QUALITY_GATE = Object.freeze({
  minIncludedPairs: 50,
  maxSingleAxisShare: 0.6,
  maxSingleSourceModeShare: 0.7,
  maxSingleTeacherModelShare: 0.8
});

function buildShardManifest({
  shardId,
  relabelReceipts = [],
  candidatePackets = [],
  windows = [],
  scoreReceipts = [],
  holdoutManifest = null,
  qualityGate = {},
  now = new Date().toISOString()
} = {}) {
  const targetShardId = safeText(shardId || inferShardId(relabelReceipts), 160);
  const includedRelabels = relabelReceipts.filter((receipt) => (
    receipt &&
    receipt.type === 'teacher_relabel_receipt' &&
    receipt.includeInShard === true &&
    receipt.inclusionDecision === 'included' &&
    (!targetShardId || receipt.shardId === targetShardId)
  ));
  const distributions = buildDistributions(includedRelabels);
  const gate = evaluateShardQuality(includedRelabels, distributions, holdoutManifest, {
    ...DEFAULT_QUALITY_GATE,
    ...(qualityGate || {})
  });
  const members = buildMembers({ includedRelabels, candidatePackets, windows, scoreReceipts });
  const manifest = {
    schemaVersion: SCHEMA_VERSIONS.SHARD_MANIFEST,
    type: 'sealed_shard_manifest',
    shardId: targetShardId,
    sealedAt: now,
    immutable: true,
    trainingApproval: false,
    adapterPromotionAuthorized: false,
    redactionPolicy: dominantValue(includedRelabels.map((receipt) => receipt.redactionPolicy)) || 'default-local-research-redaction',
    counts: {
      includedPairs: includedRelabels.length,
      memberReceipts: members.length,
      windows: new Set(includedRelabels.map((receipt) => receipt.windowId).filter(Boolean)).size,
      sessions: new Set(includedRelabels.map((receipt) => receipt.sessionId).filter(Boolean)).size
    },
    distributions,
    qualityGate: gate,
    holdout: holdoutManifest ? {
      manifestHash: holdoutManifest.manifestHash || fullHash(holdoutManifest),
      seed: holdoutManifest.seed || '',
      trainSessionCount: holdoutManifest.partitions?.train?.length || 0,
      devSessionCount: holdoutManifest.partitions?.dev?.length || 0,
      testSessionCount: holdoutManifest.partitions?.test?.length || 0
    } : null,
    members,
    merkleRoot: merkleRoot(members),
    manifestHash: null
  };
  manifest.manifestHash = fullHash({ ...manifest, manifestHash: undefined });
  return manifest;
}

function evaluateShardQuality(includedRelabels = [], distributions = buildDistributions(includedRelabels), holdoutManifest = null, qualityGate = DEFAULT_QUALITY_GATE) {
  const reasons = [];
  const count = includedRelabels.length;
  if (count < qualityGate.minIncludedPairs) {
    reasons.push({ type: 'insufficient_included_pairs', value: count, threshold: qualityGate.minIncludedPairs });
  }
  addShareReason(reasons, 'axis_imbalance', distributions.lowScoreAxes, count, qualityGate.maxSingleAxisShare);
  addShareReason(reasons, 'source_mode_imbalance', distributions.sourceModes, count, qualityGate.maxSingleSourceModeShare);
  addShareReason(reasons, 'teacher_model_imbalance', distributions.teacherModels, count, qualityGate.maxSingleTeacherModelShare);
  const holdout = assertShardUsesOnlyTrainSessions(includedRelabels, holdoutManifest);
  for (const violation of holdout.violations) {
    reasons.push({ type: 'holdout_partition_violation', ...violation });
  }
  return {
    passed: reasons.length === 0,
    reasons,
    thresholds: qualityGate
  };
}

function verifyShardManifest(manifest = {}, artifacts = {}) {
  const members = buildMembers({
    includedRelabels: artifacts.relabelReceipts || [],
    candidatePackets: artifacts.candidatePackets || [],
    windows: artifacts.windows || [],
    scoreReceipts: artifacts.scoreReceipts || []
  }).filter((member) => (manifest.members || []).some((expected) => expected.id === member.id && expected.type === member.type));
  const root = merkleRoot(members);
  return {
    ok: manifest.schemaVersion === SCHEMA_VERSIONS.SHARD_MANIFEST && root === manifest.merkleRoot,
    expectedMerkleRoot: manifest.merkleRoot || '',
    actualMerkleRoot: root
  };
}

function writeSealedShardManifest(manifestPath, manifest) {
  if (fs.existsSync(manifestPath)) {
    throw new Error(`sealed shard manifest already exists: ${manifestPath}`);
  }
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return manifestPath;
}

function buildDistributions(includedRelabels = []) {
  const lowScoreAxes = {};
  const sourceModes = {};
  const teacherModels = {};
  const scorerVersions = {};
  for (const receipt of includedRelabels) {
    for (const axis of receipt.lowScoreAxes || []) {
      if (!SCORE_AXES.includes(axis)) continue;
      lowScoreAxes[axis] = (lowScoreAxes[axis] || 0) + 1;
    }
    const sourceMode = receipt.sourceMode || 'unknown';
    const teacherModel = receipt.teacherModel || 'unknown';
    const scorerVersion = receipt.qualityGate?.scorerVersion || receipt.scorerVersion || 'unknown';
    sourceModes[sourceMode] = (sourceModes[sourceMode] || 0) + 1;
    teacherModels[teacherModel] = (teacherModels[teacherModel] || 0) + 1;
    scorerVersions[scorerVersion] = (scorerVersions[scorerVersion] || 0) + 1;
  }
  return { lowScoreAxes, sourceModes, teacherModels, scorerVersions };
}

function buildMembers({ includedRelabels = [], candidatePackets = [], windows = [], scoreReceipts = [] } = {}) {
  const candidateById = new Map(candidatePackets.map((entry) => [entry.id, entry]));
  const windowById = new Map(windows.map((entry) => [entry.id, entry]));
  const scoreById = new Map(scoreReceipts.map((entry) => [entry.id, entry]));
  const members = [];
  for (const relabel of includedRelabels) {
    pushMember(members, 'teacher_relabel_receipt', relabel.id, relabel);
    const candidate = candidateById.get(relabel.candidatePacketId);
    if (candidate) {
      pushMember(members, 'relabel_candidate_packet', candidate.id, candidate);
      const score = scoreById.get(candidate.scoreReceiptId);
      if (score) pushMember(members, 'process_score_receipt', score.id, score);
    }
    const window = windowById.get(relabel.windowId);
    if (window) pushMember(members, 'trajectory_window', window.id, window);
  }
  return dedupeMembers(members).sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`));
}

function pushMember(members, type, id, payload) {
  if (!id || !payload) return;
  members.push({ type, id: safeText(id, 160), hash: fullHash(payload) });
}

function dedupeMembers(members) {
  const seen = new Set();
  const out = [];
  for (const member of members) {
    const key = `${member.type}:${member.id}:${member.hash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(member);
  }
  return out;
}

function merkleRoot(members = []) {
  return fullHash(members.map((member) => `${member.type}:${member.id}:${member.hash}`).sort());
}

function addShareReason(reasons, type, counts, total, threshold) {
  if (!total || !threshold) return;
  const [key, value] = maxEntry(counts);
  if (!key) return;
  const share = value / total;
  if (share > threshold) reasons.push({ type, key, value, share: Number(share.toFixed(3)), threshold });
}

function maxEntry(counts = {}) {
  return Object.entries(counts).sort((a, b) => Number(b[1]) - Number(a[1]))[0] || [null, 0];
}

function dominantValue(values = []) {
  const counts = {};
  for (const value of values.filter(Boolean)) counts[value] = (counts[value] || 0) + 1;
  return maxEntry(counts)[0];
}

function inferShardId(relabelReceipts = []) {
  return relabelReceipts.find((receipt) => receipt?.shardId)?.shardId || `cotw-relabel-shard-${stableHash(relabelReceipts)}`;
}

module.exports = {
  DEFAULT_QUALITY_GATE,
  buildShardManifest,
  evaluateShardQuality,
  verifyShardManifest,
  writeSealedShardManifest
};
