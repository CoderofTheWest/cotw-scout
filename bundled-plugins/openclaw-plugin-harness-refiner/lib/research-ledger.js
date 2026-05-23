'use strict';

const fs = require('fs');
const path = require('path');
const { fullHash, safeText, stableHash } = require('./safe');

function createResearchLedger({ dataDir, experimentId = null, now = new Date().toISOString() } = {}) {
  const root = path.join(dataDir, 'research');
  fs.mkdirSync(root, { recursive: true });
  const safeExperimentId = safeText(experimentId || `harness-refiner-${now.slice(0, 10)}`, 120);
  return {
    root,
    experimentId: safeExperimentId,
    ledgerPath: path.join(root, 'research-ledger.jsonl')
  };
}

function appendResearchArtifact(ledger, artifact = {}) {
  const record = {
    ...artifact,
    experimentId: artifact.experimentId || ledger.experimentId,
    artifactHash: artifact.artifactHash || fullHash(artifact)
  };
  fs.mkdirSync(path.dirname(ledger.ledgerPath), { recursive: true });
  fs.appendFileSync(ledger.ledgerPath, JSON.stringify(record) + '\n');
  return record;
}

function readResearchArtifacts(ledgerOrPath, filters = {}) {
  const ledgerPath = typeof ledgerOrPath === 'string' ? ledgerOrPath : ledgerOrPath?.ledgerPath;
  if (!ledgerPath || !fs.existsSync(ledgerPath)) return [];
  const artifacts = fs.readFileSync(ledgerPath, 'utf8')
    .split(/\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return artifacts.filter((artifact) => {
    if (filters.experimentId && artifact.experimentId !== filters.experimentId) return false;
    if (filters.clusterId && artifact.clusterId !== filters.clusterId) return false;
    if (filters.type && artifact.type !== filters.type) return false;
    return true;
  });
}

function clusterIdForSignature(signature = {}) {
  const name = safeText(signature.signature || 'unknown', 80);
  const target = safeText(signature.targetSurface || 'general', 120).replace(/[^a-zA-Z0-9:_-]+/g, '-');
  return `${name}:${target}`.slice(0, 180);
}

function artifactId(prefix, value) {
  return `${prefix}-${stableHash(value)}`;
}

module.exports = {
  appendResearchArtifact,
  artifactId,
  clusterIdForSignature,
  createResearchLedger,
  readResearchArtifacts
};
