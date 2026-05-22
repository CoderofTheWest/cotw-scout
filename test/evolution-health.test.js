const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { appendEvolutionEvent } = require('../lib/evolution-ledger');
const { buildEvolutionLedgerHealth } = require('../lib/evolution-health');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-health-'));
}

function safeEvent(id, createdAt) {
  return {
    id,
    class: 'claim_review',
    title: `Applied claim review decision ${id}`,
    summary: 'Autonomously applied a bounded low-risk claim decision.',
    risk: 'low',
    status: 'applied',
    sourceCategory: 'source-addressable memory claim review',
    allowedBy: 'autonomous low-risk claim review policy',
    expectedEffect: 'Keeps unsupported material out of active truth.',
    verification: 'Claim mutation receipt recorded.',
    rollback: 'rollback_review_decision is available through the before receipt.',
    action: 'apply_review_decision',
    createdAt
  };
}

test('evolution health flags legacy cwd fallback ledger outside live sidebar paths', () => {
  const root = tmpDir();
  const workspacePath = path.join(root, 'workspace');
  const pluginsPath = path.join(root, 'plugins');
  appendEvolutionEvent(path.join(workspacePath, 'evolution', 'ledger.json'), safeEvent('live-1', '2026-05-10T10:00:00.000Z'));
  appendEvolutionEvent(path.join(root, 'evolution-ledger.json'), safeEvent('orphan-1', '2026-05-14T10:00:00.000Z'));

  const health = buildEvolutionLedgerHealth({ workspacePath, pluginsPath, repoRoot: root });

  assert.equal(health.status, 'warning');
  assert.equal(health.canonicalEventCount, 1);
  assert.equal(health.orphanEventCount, 1);
  assert.ok(health.warnings.some((warning) => warning.code === 'orphan_cwd_evolution_ledger'));
  assert.ok(health.warnings.some((warning) => warning.code === 'orphan_ledger_newer_than_live'));
  assert.ok(health.canonical.some((item) => item.label === 'workspace evolution ledger'));
  assert.ok(health.orphanLedgers.some((item) => item.label === 'legacy cwd fallback'));
});

test('evolution health is ok when only canonical ledgers have receipts', () => {
  const root = tmpDir();
  const workspacePath = path.join(root, 'workspace');
  const pluginsPath = path.join(root, 'plugins');
  appendEvolutionEvent(path.join(workspacePath, 'evolution', 'ledger.json'), safeEvent('live-1', '2026-05-10T10:00:00.000Z'));

  const health = buildEvolutionLedgerHealth({ workspacePath, pluginsPath, repoRoot: root });

  assert.equal(health.status, 'ok');
  assert.equal(health.canonicalEventCount, 1);
  assert.equal(health.orphanEventCount, 0);
  assert.equal(health.warnings.length, 0);
});
