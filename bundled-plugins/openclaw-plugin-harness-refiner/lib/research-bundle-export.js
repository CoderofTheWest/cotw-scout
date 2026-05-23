'use strict';

const fs = require('fs');
const path = require('path');
const { fullHash, safeText, stableHash } = require('./safe');

const FILES = {
  windows: 'windows.jsonl',
  proposals: 'proposals.jsonl',
  scores: 'scores.jsonl',
  replays: 'replays.jsonl',
  relabelCandidates: 'relabel-candidates.jsonl',
  teacherRelabels: 'teacher-relabels.jsonl',
  healthReceipts: 'health-receipts.jsonl',
  digests: 'digests.jsonl'
};

function exportResearchBundle({ dataDir, bundleId = null, experimentId, artifacts = {}, reviewerNotes = '', now = new Date().toISOString() } = {}) {
  if (!dataDir) throw new Error('dataDir is required');
  const id = safeText(bundleId || `research-bundle-${stableHash(`${experimentId}:${now}`)}`, 160);
  const bundleDir = path.join(dataDir, 'research-bundles', id);
  fs.mkdirSync(bundleDir, { recursive: true });

  const files = {};
  for (const [key, filename] of Object.entries(FILES)) {
    const entries = redactEntries(artifacts[key] || []);
    const filePath = path.join(bundleDir, filename);
    writeJsonl(filePath, entries);
    files[key] = {
      file: filename,
      count: entries.length,
      hash: fullHash(entries)
    };
  }

  const manifest = {
    bundleId: id,
    experimentId: safeText(experimentId || '', 120),
    schemaVersion: 1,
    generator: 'openclaw-plugin-harness-refiner',
    generatorVersion: '0.1.0',
    redactionPolicy: 'default-local-research-redaction',
    excludedFields: ['rawLatent', 'attachments.rawContent', 'secrets', 'unredactedPrivateText'],
    sourceDigestIds: (artifacts.digests || []).map((digest) => digest.id),
    files,
    reviewerNotes: safeText(reviewerNotes, 1000),
    trainingApproval: false,
    createdAt: now
  };
  manifest.manifestHash = fullHash({ ...manifest, manifestHash: undefined });
  fs.writeFileSync(path.join(bundleDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { bundleId: id, bundleDir, manifest };
}

function writeJsonl(filePath, entries) {
  fs.writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length > 0 ? '\n' : ''));
}

function redactEntries(entries) {
  return entries.map((entry) => redactObject(entry));
}

function redactObject(value, key = '', depth = 0) {
  if (depth > 6) return '[redacted-depth]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => redactObject(item, key, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      if (shouldRedactKey(childKey)) {
        out[childKey] = '[redacted]';
      } else {
        out[childKey] = redactObject(childValue, childKey, depth + 1);
      }
    }
    return out;
  }
  if (key.toLowerCase().includes('content') || key.toLowerCase().includes('summary') || key.toLowerCase().includes('note')) {
    return safeText(value, 1000);
  }
  return value;
}

function shouldRedactKey(key) {
  const lower = String(key || '').toLowerCase();
  return lower === 'rawlatent' ||
    lower === 'latent' ||
    lower.includes('secret') ||
    lower.includes('token') ||
    lower === 'rawcontent' ||
    lower === 'unredactedprivatetext';
}

module.exports = {
  exportResearchBundle
};
