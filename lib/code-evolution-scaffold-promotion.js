'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeJsonAtomic } = require('./write-json-atomic');

const SCAFFOLD_FILES = ['code-mode-rules.md', 'tool-hints.json', 'workflows.json', 'parameters.json', 'thresholds.json'];

function promoteScaffoldProposal(entry = {}, options = {}) {
  assertProposalEntry(entry);
  const dataDir = resolveCodeEvolutionDataDir(options);
  const evolvedDir = ensureEvolvedDir(dataDir);
  const now = options.now || new Date().toISOString();
  const beforeHash = scaffoldHash(evolvedDir);
  const snapshotId = snapshotScaffold(evolvedDir, {
    dataDir,
    label: `pre-promote-${safeId(entry.id)}`,
    now
  });

  const metadata = entry.metadata || {};
  const changeType = metadata.changeType;
  const target = safe(metadata.target || entry.sourceCategory || 'code-mode', 120);
  const proposedChange = safe(metadata.proposedChange || entry.summary, 1000);

  if (changeType === 'tool_hint') {
    promoteToolHint(evolvedDir, { entry, target, proposedChange, now });
  } else if (changeType === 'workflow_sequence') {
    promoteWorkflow(evolvedDir, { entry, target, proposedChange, now });
  } else if (changeType === 'prompt_rule') {
    promotePromptRule(evolvedDir, { entry, target, proposedChange, now });
  } else {
    throw new Error(`unsupported scaffold proposal change type: ${changeType || 'unknown'}`);
  }

  const afterHash = scaffoldHash(evolvedDir);
  return {
    ok: true,
    dataDir,
    snapshotId,
    beforeHash,
    afterHash,
    changeType,
    target,
    proposedChange,
    promotedAt: now
  };
}

function rollbackScaffoldPromotion(receiptEntry = {}, options = {}) {
  const snapshotId = safeId(receiptEntry.metadata?.snapshotId || receiptEntry.rollbackAction?.snapshot_id);
  if (!snapshotId) throw new Error('scaffold promotion rollback requires snapshot id');
  const dataDir = resolveCodeEvolutionDataDir(options);
  const evolvedDir = ensureEvolvedDir(dataDir);
  const snapshotDir = path.join(dataDir, 'evolved', 'history', snapshotId);
  if (!snapshotDir.startsWith(path.join(dataDir, 'evolved', 'history') + path.sep)) {
    throw new Error('invalid scaffold snapshot path');
  }
  if (!fs.existsSync(snapshotDir)) throw new Error(`scaffold snapshot not found: ${snapshotId}`);

  const beforeHash = scaffoldHash(evolvedDir);
  for (const file of SCAFFOLD_FILES) {
    const snapshotFile = path.join(snapshotDir, file);
    const targetFile = path.join(evolvedDir, file);
    if (fs.existsSync(snapshotFile)) {
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      fs.copyFileSync(snapshotFile, targetFile);
    } else if (fs.existsSync(targetFile)) {
      fs.rmSync(targetFile, { force: true });
    }
  }
  const afterHash = scaffoldHash(evolvedDir);
  return {
    ok: true,
    dataDir,
    snapshotId,
    beforeHash,
    afterHash,
    rolledBackAt: options.now || new Date().toISOString()
  };
}

function buildScaffoldPromotionEvent(proposalEntry = {}, result = {}, options = {}) {
  const now = options.now || result.promotedAt || new Date().toISOString();
  const metadata = proposalEntry.metadata || {};
  const promotionId = `scaffold-promotion-${safeId(proposalEntry.id)}`;
  const target = result.target || metadata.target || 'code-mode scaffold';
  const changeType = result.changeType || metadata.changeType || 'scaffold';
  return {
    id: promotionId,
    class: proposalEntry.class || 'operational_lesson',
    title: `Promoted scaffold proposal: ${safe(proposalEntry.title || target, 140)}`,
    summary: `Applied ${changeType.replaceAll('_', ' ')} to ${target}: ${safe(result.proposedChange || metadata.proposedChange || proposalEntry.summary, 420)}`,
    status: 'applied',
    risk: proposalEntry.risk || 'low',
    sourceCategory: 'code-evolution scaffold promotion',
    allowedBy: 'Operator-triggered Evolve promotion for low-risk Code Evolution scaffold proposal.',
    expectedEffect: proposalEntry.expectedEffect || 'Improve Code mode behavior through a bounded scaffold update.',
    verification: `Before hash ${result.beforeHash}; after hash ${result.afterHash}. Proposal evidence and tests remain attached to the source receipt.`,
    rollback: 'Use rollback_scaffold_promotion to restore the before-promotion scaffold snapshot.',
    action: 'apply_scaffold_proposal',
    receiptId: promotionId,
    rollbackAction: {
      action: 'rollback_scaffold_promotion',
      promotion_id: promotionId,
      proposal_id: proposalEntry.id,
      snapshot_id: result.snapshotId
    },
    metadata: {
      originalProposalId: proposalEntry.id,
      proposalKind: metadata.proposalKind || '',
      changeType,
      target,
      proposedChange: result.proposedChange || metadata.proposedChange || '',
      snapshotId: result.snapshotId,
      beforeHash: result.beforeHash,
      afterHash: result.afterHash,
      confidence: metadata.confidence || null,
      mutationAttempted: 'true',
      promptInjectionChanged: 'false',
      codeEvolutionPhase: 'promotion',
      promotedAt: now
    },
    createdAt: now,
    updatedAt: now
  };
}

function buildScaffoldRollbackEvent(promotionEntry = {}, result = {}, options = {}) {
  const now = options.now || result.rolledBackAt || new Date().toISOString();
  const rollbackId = `scaffold-rollback-${safeId(promotionEntry.id)}`;
  return {
    id: rollbackId,
    class: promotionEntry.class || 'operational_lesson',
    title: `Rolled back scaffold promotion: ${safe(promotionEntry.title || promotionEntry.id, 140)}`,
    summary: `Restored scaffold snapshot ${result.snapshotId}. Before rollback hash ${result.beforeHash}; after rollback hash ${result.afterHash}.`,
    status: 'rolled_back',
    risk: promotionEntry.risk || 'low',
    sourceCategory: 'code-evolution scaffold rollback',
    allowedBy: 'Operator-triggered Evolve rollback for a prior scaffold promotion receipt.',
    expectedEffect: 'Restore the scaffold state captured immediately before the promotion.',
    verification: `Snapshot ${result.snapshotId} restored; before hash ${result.beforeHash}; after hash ${result.afterHash}.`,
    rollback: 'Rollback completed. Re-promote the original proposal if the change is desired again.',
    action: 'rollback_scaffold_promotion',
    receiptId: rollbackId,
    metadata: {
      promotionId: promotionEntry.id,
      originalProposalId: promotionEntry.metadata?.originalProposalId || '',
      snapshotId: result.snapshotId,
      beforeHash: result.beforeHash,
      afterHash: result.afterHash,
      mutationAttempted: 'true',
      promptInjectionChanged: 'false',
      codeEvolutionPhase: 'rollback',
      rolledBackAt: now
    },
    createdAt: now,
    updatedAt: now
  };
}

function assertProposalEntry(entry = {}) {
  if (entry.action !== 'scaffold_proposal') throw new Error('only scaffold_proposal receipts can be promoted');
  if (entry.status !== 'preview') throw new Error('only preview scaffold proposals can be promoted');
  if (entry.risk !== 'low') throw new Error('only low-risk scaffold proposals can be promoted');
  const changeType = entry.metadata?.changeType;
  if (!['tool_hint', 'workflow_sequence', 'prompt_rule'].includes(changeType)) {
    throw new Error(`unsupported scaffold proposal change type: ${changeType || 'unknown'}`);
  }
  if (entry.metadata?.mutationAttempted === true || entry.metadata?.mutationAttempted === 'true') {
    throw new Error('proposal already reports mutation; promotion refused');
  }
  if (entry.metadata?.promptInjectionChanged === true || entry.metadata?.promptInjectionChanged === 'true') {
    throw new Error('proposal reports prompt injection change; promotion refused');
  }
}

function promoteToolHint(evolvedDir, { entry, target, proposedChange, now }) {
  const filePath = path.join(evolvedDir, 'tool-hints.json');
  const hints = readJson(filePath, {});
  hints[target] = {
    hint: proposedChange,
    source: 'code-evolution-promotion',
    confidence: entry.metadata?.confidence || null,
    proposalId: entry.id,
    promotedAt: now
  };
  writeJsonAtomic(filePath, hints);
}

function promoteWorkflow(evolvedDir, { entry, target, proposedChange, now }) {
  const filePath = path.join(evolvedDir, 'workflows.json');
  const workflows = readJson(filePath, []);
  const filtered = workflows.filter((workflow) => workflow?.proposalId !== entry.id);
  filtered.push({
    name: target,
    sequence: proposedChange,
    source: 'code-evolution-promotion',
    confidence: entry.metadata?.confidence || null,
    proposalId: entry.id,
    promotedAt: now
  });
  writeJsonAtomic(filePath, filtered);
}

function promotePromptRule(evolvedDir, { entry, target, proposedChange, now }) {
  const filePath = path.join(evolvedDir, 'code-mode-rules.md');
  const marker = `<!-- code-evolution-proposal:${entry.id} -->`;
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  if (current.includes(marker)) return;
  const block = [
    marker,
    `### ${target}`,
    '',
    proposedChange,
    '',
    `_Source: Code Evolution proposal ${entry.id}; promoted ${now}._`
  ].join('\n');
  const next = current.trim() ? `${current.trim()}\n\n${block}\n` : `${block}\n`;
  fs.writeFileSync(filePath, next);
}

function snapshotScaffold(evolvedDir, { dataDir, label, now }) {
  const snapshotId = `${now.replace(/[:.]/g, '-')}_${safeId(label)}`;
  const snapshotDir = path.join(dataDir, 'evolved', 'history', snapshotId);
  fs.mkdirSync(snapshotDir, { recursive: true });
  for (const file of SCAFFOLD_FILES) {
    const src = path.join(evolvedDir, file);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(snapshotDir, file));
  }
  return snapshotId;
}

function scaffoldHash(evolvedDir) {
  const hash = crypto.createHash('sha256');
  for (const file of SCAFFOLD_FILES) {
    const filePath = path.join(evolvedDir, file);
    hash.update(file);
    hash.update('\0');
    if (fs.existsSync(filePath)) hash.update(fs.readFileSync(filePath));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

function resolveCodeEvolutionDataDir(options = {}) {
  const base = options.dataDir || path.join(options.pluginsPath || '', 'openclaw-plugin-code-evolution', 'data');
  if (!base || base.includes('\0')) throw new Error('code evolution data dir is required');
  return path.resolve(base);
}

function ensureEvolvedDir(dataDir) {
  const evolvedDir = path.join(dataDir, 'evolved');
  fs.mkdirSync(evolvedDir, { recursive: true });
  for (const file of SCAFFOLD_FILES) {
    const filePath = path.join(evolvedDir, file);
    if (fs.existsSync(filePath)) continue;
    if (file.endsWith('.json')) writeJsonAtomic(filePath, file === 'workflows.json' ? [] : {});
    else fs.writeFileSync(filePath, '');
  }
  return evolvedDir;
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function safe(value, max = 1000) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeId(value) {
  return safe(value, 160).replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 160);
}

module.exports = {
  promoteScaffoldProposal,
  rollbackScaffoldPromotion,
  buildScaffoldPromotionEvent,
  buildScaffoldRollbackEvent,
  scaffoldHash
};
