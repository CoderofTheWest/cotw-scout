'use strict';

const { fullHash, safeText, stableHash } = require('./safe');
const { SCHEMA_VERSIONS } = require('./schema-versions');

const DEFAULT_RATIOS = Object.freeze({ train: 0.8, dev: 0.1, test: 0.1 });

function buildHoldoutManifest({ windows = [], relabelReceipts = [], candidatePackets = [], seed = 'cotw-holdout-v1', ratios = DEFAULT_RATIOS, now = new Date().toISOString() } = {}) {
  const sessionMap = new Map();
  for (const item of [...windows, ...candidatePackets, ...relabelReceipts]) {
    const sessionId = safeText(item.sessionId || item.metadata?.sessionId || '', 120);
    if (!sessionId) continue;
    const sourceMode = safeText(item.sourceMode || item.mode || item.metadata?.mode || '', 80) || 'unknown';
    if (!sessionMap.has(sessionId)) {
      sessionMap.set(sessionId, {
        sessionId,
        sourceModes: new Set(),
        windowCount: 0,
        relabelCount: 0
      });
    }
    const entry = sessionMap.get(sessionId);
    entry.sourceModes.add(sourceMode);
    if (item.type === 'teacher_relabel_receipt') entry.relabelCount += 1;
    else entry.windowCount += 1;
  }

  const normalizedRatios = normalizeRatios(ratios);
  const partitions = { train: [], dev: [], test: [] };
  const sessions = [...sessionMap.values()]
    .sort((a, b) => stableHash(`${seed}:${a.sessionId}`).localeCompare(stableHash(`${seed}:${b.sessionId}`)));
  for (const session of sessions) {
    partitions[partitionForSession(session.sessionId, seed, normalizedRatios)].push(session.sessionId);
  }

  const manifest = {
    schemaVersion: SCHEMA_VERSIONS.HOLDOUT_MANIFEST,
    type: 'holdout_manifest',
    seed: safeText(seed, 160),
    ratios: normalizedRatios,
    sessionCount: sessions.length,
    partitions,
    distributions: {
      train: distributionFor(partitions.train, sessionMap),
      dev: distributionFor(partitions.dev, sessionMap),
      test: distributionFor(partitions.test, sessionMap)
    },
    createdAt: now
  };
  manifest.manifestHash = fullHash({ ...manifest, manifestHash: undefined });
  return manifest;
}

function assertShardUsesOnlyTrainSessions(includedRelabels = [], holdoutManifest = null) {
  if (!holdoutManifest) return { ok: true, violations: [] };
  const dev = new Set(holdoutManifest.partitions?.dev || []);
  const test = new Set(holdoutManifest.partitions?.test || []);
  const violations = [];
  for (const relabel of includedRelabels) {
    const sessionId = relabel.sessionId || '';
    if (dev.has(sessionId)) violations.push({ sessionId, partition: 'dev', relabelId: relabel.id });
    if (test.has(sessionId)) violations.push({ sessionId, partition: 'test', relabelId: relabel.id });
  }
  return { ok: violations.length === 0, violations };
}

function partitionForSession(sessionId, seed, ratios) {
  const bucket = parseInt(stableHash(`${seed}:${sessionId}`, 8), 16) / 0xffffffff;
  if (bucket < ratios.train) return 'train';
  if (bucket < ratios.train + ratios.dev) return 'dev';
  return 'test';
}

function normalizeRatios(input = {}) {
  const train = finiteRatio(input.train, DEFAULT_RATIOS.train);
  const dev = finiteRatio(input.dev, DEFAULT_RATIOS.dev);
  const test = finiteRatio(input.test, DEFAULT_RATIOS.test);
  const total = train + dev + test;
  if (total <= 0) return { ...DEFAULT_RATIOS };
  return {
    train: Number((train / total).toFixed(4)),
    dev: Number((dev / total).toFixed(4)),
    test: Number((test / total).toFixed(4))
  };
}

function finiteRatio(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : fallback;
}

function distributionFor(sessionIds, sessionMap) {
  const sourceModes = {};
  let relabelCount = 0;
  let windowCount = 0;
  for (const id of sessionIds) {
    const entry = sessionMap.get(id);
    if (!entry) continue;
    relabelCount += entry.relabelCount;
    windowCount += entry.windowCount;
    for (const mode of entry.sourceModes) sourceModes[mode] = (sourceModes[mode] || 0) + 1;
  }
  return {
    sessionCount: sessionIds.length,
    windowCount,
    relabelCount,
    sourceModes
  };
}

module.exports = {
  assertShardUsesOnlyTrainSessions,
  buildHoldoutManifest,
  partitionForSession
};
