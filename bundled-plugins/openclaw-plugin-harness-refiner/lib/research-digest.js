'use strict';

const { clusterIdForSignature } = require('./research-ledger');
const { safeText, stableHash } = require('./safe');

function buildResearchDigest({
  experimentId,
  clusterId = null,
  windows = [],
  signatures = [],
  proposals = [],
  scoreReceipts = [],
  relabelCandidates = [],
  teacherRelabels = [],
  healthReceipts = [],
  replays = [],
  skipped = [],
  now = new Date().toISOString()
} = {}) {
  const primarySignature = signatures[0] || {};
  const resolvedClusterId = clusterId || clusterIdForSignature(primarySignature);
  const id = `research-digest-${stableHash(`${experimentId}:${resolvedClusterId}`)}`;
  const activeWindow = windows[0] || {};
  return {
    id,
    type: 'research_digest',
    experimentId: safeText(experimentId || `harness-refiner-${now.slice(0, 10)}`, 120),
    clusterId: safeText(resolvedClusterId, 180),
    title: titleFor(primarySignature, activeWindow),
    whyItMatters: whyItMatters(primarySignature, scoreReceipts),
    artifactCounts: {
      windows: windows.length,
      proposals: proposals.length,
      replays: replays.length,
      relabelCandidates: relabelCandidates.length,
      teacherRelabels: teacherRelabels.length,
      healthReceipts: healthReceipts.length,
      skipped: skipped.length
    },
    activeHarness: {
      scaffoldHash: safeText(activeWindow.metadata?.scaffoldHash || activeWindow.metadata?.scaffoldVersion || '', 160),
      mode: safeText(activeWindow.mode || '', 80),
      modelOrAdapterHash: safeText(activeWindow.metadata?.modelOrAdapterHash || activeWindow.metadata?.model || '', 160)
    },
    signals: {
      failureSignatures: Array.from(new Set(signatures.map((entry) => entry.signature).filter(Boolean))),
      prmScores: averageScores(scoreReceipts),
      cognitiveSummary: summarizeCognitive(windows)
    },
    decisions: {
      proposalStatus: proposalStatus(proposals),
      trainingDataStatus: trainingStatus(relabelCandidates, teacherRelabels),
      exclusionReason: firstExclusion(relabelCandidates)
    },
    sourceHandles: Array.from(new Set(windows.flatMap((window) => window.sourceHandles || []))).slice(0, 100),
    redactionPolicy: 'default-local-research-redaction',
    nextReviewAction: nextReviewAction(proposals, relabelCandidates, skipped),
    artifactRefs: {
      windowIds: windows.map((window) => window.id),
      proposalIds: proposals.map((proposal) => proposal.id),
      scoreIds: scoreReceipts.map((score) => score.id),
      relabelCandidateIds: relabelCandidates.map((packet) => packet.id),
      teacherRelabelIds: teacherRelabels.map((receipt) => receipt.id),
      healthReceiptIds: healthReceipts.map((receipt) => receipt.id)
    },
    createdAt: now,
    updatedAt: now
  };
}

function groupDigestsByCluster({ experimentId, windows = [], signaturesByWindow = new Map(), proposals = [], scoreReceipts = [], relabelCandidates = [], teacherRelabels = [], healthReceipts = [], skipped = [], now } = {}) {
  const clusters = new Map();
  for (const window of windows) {
    const signatures = signaturesByWindow.get(window.id) || [];
    if (signatures.length === 0) {
      const key = 'no-signature:skipped';
      const cluster = clusters.get(key) || { windows: [], signatures: [] };
      cluster.windows.push(window);
      clusters.set(key, cluster);
      continue;
    }
    for (const sig of signatures) {
      const key = clusterIdForSignature(sig);
      const cluster = clusters.get(key) || { windows: [], signatures: [] };
      cluster.windows.push(window);
      cluster.signatures.push(sig);
      clusters.set(key, cluster);
    }
  }

  return [...clusters.entries()].map(([clusterId, cluster]) => {
    const windowIds = new Set(cluster.windows.map((window) => window.id));
    return buildResearchDigest({
      experimentId,
      clusterId,
      windows: cluster.windows,
      signatures: cluster.signatures,
      proposals: proposals.filter((proposal) => windowIds.has(proposal.metadata?.windowId)),
      scoreReceipts: scoreReceipts.filter((score) => windowIds.has(score.windowId)),
      relabelCandidates: relabelCandidates.filter((packet) => windowIds.has(packet.windowId)),
      teacherRelabels,
      healthReceipts,
      skipped,
      now
    });
  });
}

function titleFor(signature, window) {
  if (signature?.title) return safeText(signature.title, 140);
  return safeText(window?.objective || 'Harness Refiner research cluster', 140);
}

function whyItMatters(signature, scoreReceipts) {
  if (signature?.summary) return safeText(signature.summary, 500);
  const lowAxes = Array.from(new Set(scoreReceipts.flatMap((score) => score.lowScoreAxes || [])));
  if (lowAxes.length > 0) return `This cluster has low process scores for ${lowAxes.join(', ')}.`;
  return 'This cluster preserves runtime behavior evidence for review, replay, and future training-data decisions.';
}

function averageScores(scoreReceipts) {
  const totals = {};
  const counts = {};
  for (const receipt of scoreReceipts) {
    for (const [axis, value] of Object.entries(receipt.scores || {})) {
      totals[axis] = (totals[axis] || 0) + Number(value || 0);
      counts[axis] = (counts[axis] || 0) + 1;
    }
  }
  const out = {};
  for (const [axis, total] of Object.entries(totals)) out[axis] = Number((total / counts[axis]).toFixed(3));
  return out;
}

function summarizeCognitive(windows) {
  const first = windows.find((window) => window.cognitiveSnapshot?.available)?.cognitiveSnapshot;
  return {
    latentBucket: first?.latentBucket || null,
    surpriseFrozen: first?.surpriseFrozen ?? null,
    surpriseLearned: first?.surpriseLearned ?? null,
    rawLatentIncluded: first?.rawLatentIncluded === true
  };
}

function proposalStatus(proposals) {
  if (proposals.length === 0) return 'none';
  const statuses = new Set(proposals.map((proposal) => proposal.status));
  if (statuses.has('accepted') || statuses.has('applied')) return 'accepted';
  if (statuses.has('denied')) return 'denied';
  if (statuses.has('preview')) return 'preview';
  return [...statuses][0] || 'unknown';
}

function trainingStatus(candidates, relabels) {
  if (relabels.some((receipt) => receipt.includeInShard)) return 'included';
  if (candidates.length > 0) return 'candidate';
  return 'none';
}

function firstExclusion(candidates) {
  return candidates.find((packet) => packet.exclusionReason)?.exclusionReason || null;
}

function nextReviewAction(proposals, candidates, skipped) {
  if (proposals.length > 0) return 'Review harness proposal and replay/verification plan.';
  if (candidates.length > 0) return 'Review relabel candidate packet before teacher repair.';
  if (skipped.length > 0) return 'Inspect skip reason and decide whether more evidence is needed.';
  return 'No immediate review action.';
}

module.exports = {
  buildResearchDigest,
  groupDigestsByCluster
};
