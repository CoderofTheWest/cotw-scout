'use strict';

const { normalizeTrajectoryWindows } = require('./trajectory-window');
const { detectFailureSignatures } = require('./failure-detectors');
const { buildProposal, dedupeProposals } = require('./proposal-builder');
const { scoreWindow, isLowScore } = require('./prm-diagnostics');
const { buildRelabelCandidatePacket } = require('./relabel-packets');
const { groupDigestsByCluster } = require('./research-digest');
const { clusterIdForSignature } = require('./research-ledger');

function analyzeTrajectoryWindows({
  windows = [],
  config = {},
  agentId = 'trail-guide',
  scaffoldVersion = '',
  experimentId = null,
  modelOrAdapterHash = '',
  now = new Date().toISOString()
} = {}) {
  const normalizedWindows = normalizeTrajectoryWindows(windows, {
    agentId,
    includeRawLatent: config.cognitive?.includeRawLatents === true,
    now
  });
  const signaturesByWindow = new Map();
  const signatures = [];
  const scoreReceipts = [];
  const relabelCandidates = [];
  const skipped = [];

  for (const window of normalizedWindows) {
    const windowSignatures = detectFailureSignatures(window, config);
    signaturesByWindow.set(window.id, windowSignatures);
    signatures.push(...windowSignatures.map((sig) => ({ ...sig, windowId: window.id, clusterId: clusterIdForSignature(sig) })));

    const scoreReceipt = scoreWindow(window, { now, scorerVersion: config.training?.scorerVersion });
    scoreReceipts.push(scoreReceipt);
    if (isLowScore(scoreReceipt, config.training?.lowScoreThreshold ?? 0.55)) {
      relabelCandidates.push(buildRelabelCandidatePacket({
        window,
        scoreReceipt,
        agentId,
        harnessVersion: scaffoldVersion,
        modelOrAdapterHash,
        now
      }));
    }

    if (windowSignatures.length === 0) {
      skipped.push({
        windowId: window.id,
        reason: 'no_failure_signature',
        triggerEvent: window.triggerEvent
      });
    }
  }

  const rawProposals = [];
  for (const window of normalizedWindows) {
    for (const signature of signaturesByWindow.get(window.id) || []) {
      if ((signature.confidence || 0) < (config.analysis?.patternConfidenceThreshold ?? 0.55)) continue;
      rawProposals.push(buildProposal({ signature, window, agentId, scaffoldVersion, now }));
    }
  }
  const proposals = dedupeProposals(rawProposals).slice(0, config.analysis?.maxProposalsPerRun || 10);
  const digests = groupDigestsByCluster({
    experimentId: experimentId || `harness-refiner-${now.slice(0, 10)}`,
    windows: normalizedWindows,
    signaturesByWindow,
    proposals,
    scoreReceipts,
    relabelCandidates,
    skipped,
    now
  });

  return {
    skipped: normalizedWindows.length === 0,
    reason: normalizedWindows.length === 0 ? 'no_windows' : null,
    windowCount: normalizedWindows.length,
    windows: normalizedWindows,
    signatures,
    proposals,
    scoreReceipts,
    relabelCandidates,
    digests,
    skippedWindows: skipped
  };
}

module.exports = {
  analyzeTrajectoryWindows
};
