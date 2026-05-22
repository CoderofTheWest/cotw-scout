'use strict';

const fs = require('fs');
const path = require('path');
const {
  candidateEvolutionLedgerPaths,
  readEvolutionLedger
} = require('./evolution-ledger');

function buildEvolutionLedgerHealth({ workspacePath, pluginsPath, repoRoot, agentId = 'trail-guide' } = {}) {
  const canonicalPaths = candidateEvolutionLedgerPaths({ workspacePath, pluginsPath, agentId });
  const canonical = canonicalPaths.map((ledgerPath) => summarizeLedgerPath(ledgerPath, labelLedgerPath(ledgerPath, { workspacePath, pluginsPath })));
  const canonicalSet = new Set(canonicalPaths.map((ledgerPath) => path.resolve(ledgerPath)));
  const orphanLedgers = [];

  if (repoRoot) {
    const legacyCwdPath = path.join(repoRoot, 'evolution-ledger.json');
    if (!canonicalSet.has(path.resolve(legacyCwdPath))) {
      const summary = summarizeLedgerPath(legacyCwdPath, 'legacy cwd fallback');
      if (summary.exists && summary.eventCount > 0) orphanLedgers.push(summary);
    }
  }

  const warnings = [];
  const canonicalEventCount = canonical.reduce((sum, item) => sum + item.eventCount, 0);
  const orphanEventCount = orphanLedgers.reduce((sum, item) => sum + item.eventCount, 0);
  const latestCanonical = latestTimestamp(canonical);
  const latestOrphan = latestTimestamp(orphanLedgers);

  if (orphanEventCount > 0) {
    warnings.push({
      code: 'orphan_cwd_evolution_ledger',
      message: `${orphanEventCount} evolution receipt${orphanEventCount === 1 ? '' : 's'} exist in a legacy cwd fallback ledger that the live sidebar does not read.`
    });
  }
  if (latestOrphan && (!latestCanonical || latestOrphan > latestCanonical)) {
    warnings.push({
      code: 'orphan_ledger_newer_than_live',
      message: 'The legacy fallback ledger is newer than the canonical live evolution ledger.'
    });
  }
  if (canonicalEventCount === 0 && orphanEventCount === 0) {
    warnings.push({
      code: 'no_evolution_receipts',
      message: 'No persisted evolution receipts were found in the configured ledger paths.'
    });
  }

  return {
    status: warnings.length ? 'warning' : 'ok',
    canonicalEventCount,
    orphanEventCount,
    latestCanonical: latestCanonical ? new Date(latestCanonical).toISOString() : null,
    latestOrphan: latestOrphan ? new Date(latestOrphan).toISOString() : null,
    canonical,
    orphanLedgers,
    warnings
  };
}

function summarizeLedgerPath(ledgerPath, label) {
  const exists = Boolean(ledgerPath && fs.existsSync(ledgerPath));
  const stat = exists ? fs.statSync(ledgerPath) : null;
  const ledger = exists ? readEvolutionLedger(ledgerPath) : { events: [] };
  const events = Array.isArray(ledger.events) ? ledger.events : [];
  const latest = events
    .map((event) => Date.parse(event.createdAt || event.updatedAt || ''))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0] || null;
  return {
    label,
    exists,
    eventCount: events.length,
    latestEventAt: latest ? new Date(latest).toISOString() : null,
    mtime: stat ? stat.mtime.toISOString() : null
  };
}

function labelLedgerPath(ledgerPath, { workspacePath, pluginsPath } = {}) {
  if (workspacePath && path.resolve(ledgerPath) === path.resolve(path.join(workspacePath, 'evolution', 'ledger.json'))) {
    return 'workspace evolution ledger';
  }
  if (pluginsPath && ledgerPath.includes(path.join('openclaw-plugin-continuity', 'data', 'agents'))) {
    return 'continuity agent data ledger';
  }
  if (pluginsPath && ledgerPath.endsWith(path.join('openclaw-plugin-continuity', 'data', 'evolution-ledger.json'))) {
    return 'continuity shared data ledger';
  }
  return 'evolution ledger';
}

function latestTimestamp(items = []) {
  const latest = items
    .map((item) => Date.parse(item.latestEventAt || item.mtime || ''))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0] || null;
  return latest;
}

module.exports = {
  buildEvolutionLedgerHealth,
  summarizeLedgerPath
};
