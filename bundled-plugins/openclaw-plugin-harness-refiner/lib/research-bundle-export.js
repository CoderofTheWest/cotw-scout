'use strict';

const fs = require('fs');
const path = require('path');
const { fullHash, safeText, stableHash } = require('./safe');
const { VALIDATOR_VERSION, redactText, validateNoLeaks } = require('./redaction-validator');
const { normalizeBundleSchemas } = require('./schema-migration');

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

function exportResearchBundle({
  dataDir,
  bundleId = null,
  experimentId,
  artifacts = {},
  reviewerNotes = '',
  now = new Date().toISOString(),
  redactionValidator = validateNoLeaks
} = {}) {
  if (!dataDir) throw new Error('dataDir is required');
  const id = safeText(redactText(bundleId || `research-bundle-${stableHash(`${experimentId}:${now}`)}`), 160);
  const bundleDir = path.join(dataDir, 'research-bundles', id);

  const files = {};
  const redactedArtifacts = {};
  for (const [key, filename] of Object.entries(FILES)) {
    const entries = redactEntries(artifacts[key] || []);
    redactedArtifacts[key] = entries;
  }
  const schemaCompatibility = normalizeBundleSchemas(redactedArtifacts);
  const normalizedArtifacts = schemaCompatibility.artifacts;
  for (const [key, filename] of Object.entries(FILES)) {
    const entries = normalizedArtifacts[key] || [];
    files[key] = {
      file: filename,
      count: entries.length,
      hash: fullHash(entries)
    };
  }

  const redactionValidation = redactionValidator({
    artifacts: normalizedArtifacts,
    reviewerNotes: safeText(redactText(reviewerNotes), 1000)
  });
  if (!redactionValidation?.ok) {
    const error = new Error('research bundle redaction validation failed');
    error.leakReport = {
      validatorVersion: redactionValidation?.validatorVersion || VALIDATOR_VERSION,
      checkedPatterns: redactionValidation?.checkedPatterns || [],
      leakCounts: redactionValidation?.leakCounts || {},
      leakCount: redactionValidation?.leakCount || 0
    };
    throw error;
  }

  const manifest = {
    bundleId: id,
    experimentId: safeText(redactText(experimentId || ''), 120),
    schemaVersion: 1,
    generator: 'openclaw-plugin-harness-refiner',
    generatorVersion: '0.1.0',
    redactionPolicy: 'default-local-research-redaction',
    redactionValidatorVersion: redactionValidation.validatorVersion || VALIDATOR_VERSION,
    redactionPatternsChecked: redactionValidation.checkedPatterns || [],
    redactionValidation: {
      ok: true,
      leakCount: 0,
      checkedPatterns: redactionValidation.checkedPatterns || []
    },
    receiptSchemaCompatibility: schemaCompatibility.report,
    excludedFields: ['rawLatent', 'attachments.rawContent', 'secrets', 'unredactedPrivateText'],
    sourceDigestIds: (artifacts.digests || []).map((digest) => safeText(redactText(digest.id || ''), 160)),
    files,
    reviewerNotes: safeText(redactText(reviewerNotes), 1000),
    trainingApproval: false,
    adapterPromotionAuthorized: false,
    createdAt: now
  };
  manifest.manifestHash = fullHash({ ...manifest, manifestHash: undefined });

  const finalValidation = redactionValidator({ artifacts: normalizedArtifacts, manifest });
  if (!finalValidation?.ok) {
    const error = new Error('research bundle manifest redaction validation failed');
    error.leakReport = {
      validatorVersion: finalValidation?.validatorVersion || VALIDATOR_VERSION,
      checkedPatterns: finalValidation?.checkedPatterns || [],
      leakCounts: finalValidation?.leakCounts || {},
      leakCount: finalValidation?.leakCount || 0
    };
    throw error;
  }

  fs.mkdirSync(bundleDir, { recursive: true });
  for (const [key, filename] of Object.entries(FILES)) {
    writeJsonl(path.join(bundleDir, filename), normalizedArtifacts[key] || []);
  }
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
  if (typeof value === 'string') {
    const redacted = redactText(value);
    if (key.toLowerCase().includes('content') || key.toLowerCase().includes('summary') || key.toLowerCase().includes('note')) {
      return safeText(redacted, 1000);
    }
    return redacted;
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
