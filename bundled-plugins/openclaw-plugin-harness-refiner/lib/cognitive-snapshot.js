'use strict';

const fs = require('fs');
const path = require('path');
const { boundedNumber, fullHash } = require('./safe');

function normalizeCognitiveSnapshot(input = {}, options = {}) {
  const includeRawLatent = options.includeRawLatent === true;
  const available = input && (input.available !== false);
  const surpriseFrozen = pickNumber(input.surpriseFrozen, input.surprise_frozen, input.frozen, input.surprise);
  const surpriseLearned = pickNumber(input.surpriseLearned, input.surprise_learned, input.learned);
  const entropy = pickNumber(input.entropy, input.entropy_score);
  const learnerLoss = pickNumber(input.learnerLoss, input.learner_loss);
  const learnerUpdates = pickNumber(input.learnerUpdates, input.learner_updates);
  const latent = Array.isArray(input.latent) ? input.latent : null;
  const featureAvailability = normalizeFeatureAvailability(input.featureAvailability || input.features_available);
  const surpriseDelta = pickNumber(
    input.surpriseDelta,
    input.surprise_delta,
    surpriseFrozen !== null && surpriseLearned !== null ? surpriseFrozen - surpriseLearned : null
  );

  return {
    available: Boolean(available && hasAnySignal({
      surpriseFrozen,
      surpriseLearned,
      entropy,
      learnerLoss,
      learnerUpdates,
      latent,
      featureAvailability
    })),
    entropy,
    surpriseFrozen,
    surpriseLearned,
    surpriseDelta,
    learnerLoss,
    learnerUpdates,
    featureAvailability,
    latentHash: input.latentHash || (latent ? fullHash(latent) : null),
    latentBucket: input.latentBucket || bucketCognitiveState({
      surpriseFrozen,
      surpriseLearned,
      surpriseDelta,
      learnerLoss,
      featureAvailability
    }),
    rawLatentIncluded: includeRawLatent && Boolean(latent),
    ...(includeRawLatent && latent ? { rawLatent: latent.map((value) => boundedNumber(value, 0)) } : {})
  };
}

function buildCognitiveSnapshot({ api, agentId = 'main', record = null, dataDir = null, includeRawLatent = false } = {}) {
  let source = record;
  if (!source && api?.cognitiveDynamics?.getSurprise) {
    const surprise = api.cognitiveDynamics.getSurprise(agentId) || {};
    const latent = api.cognitiveDynamics.getLatent?.(agentId) || null;
    source = {
      available: true,
      surpriseFrozen: surprise.frozen,
      surpriseLearned: surprise.learned,
      latent
    };
  }

  if (!source && dataDir) {
    source = readLatestCognitiveRecord(dataDir, agentId);
  }

  if (!source) return normalizeCognitiveSnapshot({ available: false }, { includeRawLatent });
  return normalizeCognitiveSnapshot(source, { includeRawLatent });
}

function readLatestCognitiveRecord(dataDir, agentId = 'main') {
  const candidates = [
    path.join(dataDir, 'agents', agentId, 'cognitive-dynamics.jsonl'),
    path.join(dataDir, 'agents', 'main', 'cognitive-dynamics.jsonl'),
    path.join(dataDir, 'cognitive-dynamics.jsonl')
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const entry = readLastJsonl(candidate);
    if (entry) return entry;
  }
  return null;
}

function readLastJsonl(filePath) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').trim().split(/\n/).filter(Boolean);
    if (lines.length === 0) return null;
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

function normalizeFeatureAvailability(input) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    out[String(key).replace(/[^\w.-]/g, '_').slice(0, 80)] = Boolean(value);
  }
  return out;
}

function bucketCognitiveState({ surpriseFrozen, surpriseLearned, surpriseDelta, learnerLoss, featureAvailability }) {
  const availableFeatures = Object.values(featureAvailability || {}).filter(Boolean).length;
  const totalFeatures = Object.keys(featureAvailability || {}).length;
  if (totalFeatures > 0 && availableFeatures / totalFeatures < 0.5) return 'feature_gap';
  const surprise = surpriseFrozen ?? surpriseLearned;
  if (surprise !== null && surprise >= 0.7) return 'prediction_error';
  if (Math.abs(surpriseDelta || 0) >= 0.4 || (learnerLoss !== null && learnerLoss >= 0.5)) return 'novel_transition';
  if (surprise !== null && surprise <= 0.25) return 'stable_task_work';
  return surprise === null ? null : 'ordinary_transition';
}

function hasAnySignal(values) {
  return Object.values(values).some((value) => {
    if (value === null || value === undefined) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
  });
}

function pickNumber(...values) {
  for (const value of values) {
    const num = boundedNumber(value, null);
    if (num !== null) return num;
  }
  return null;
}

module.exports = {
  buildCognitiveSnapshot,
  bucketCognitiveState,
  normalizeCognitiveSnapshot,
  readLatestCognitiveRecord
};
