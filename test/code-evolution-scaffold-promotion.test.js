const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  promoteScaffoldProposal,
  rollbackScaffoldPromotion,
  buildScaffoldPromotionEvent,
  buildScaffoldRollbackEvent
} = require('../lib/code-evolution-scaffold-promotion');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-promotion-'));
}

function proposal(overrides = {}) {
  return {
    id: 'code-evolution-proposal-exec',
    class: 'process_ui_friction',
    title: 'Scaffold proposal: add guardrails for exec',
    summary: 'Repeated exec failures.',
    status: 'preview',
    risk: 'low',
    sourceCategory: 'code-evolution scaffold proposal',
    allowedBy: 'proposal-only',
    expectedEffect: 'Reduce repeated exec failure loops.',
    verification: 'Fixture test.',
    rollback: 'Dismiss proposal.',
    action: 'scaffold_proposal',
    metadata: {
      proposalKind: 'repeated_tool_failure',
      changeType: 'tool_hint',
      target: 'exec',
      proposedChange: 'Before using exec, verify required inputs and use the smallest observable step.',
      confidence: 0.75,
      mutationAttempted: 'false',
      promptInjectionChanged: 'false',
      testPlan: 'Run fixture.',
      rollbackPlan: 'Dismiss proposal.'
    },
    ...overrides
  };
}

test('scaffold promotion applies a tool hint with snapshot-backed rollback', () => {
  const dataDir = tmpDir();
  const evolvedDir = path.join(dataDir, 'evolved');
  fs.mkdirSync(evolvedDir, { recursive: true });
  fs.writeFileSync(path.join(evolvedDir, 'tool-hints.json'), JSON.stringify({ existing: { hint: 'keep me' } }, null, 2));
  fs.writeFileSync(path.join(evolvedDir, 'workflows.json'), '[]');
  fs.writeFileSync(path.join(evolvedDir, 'code-mode-rules.md'), '');

  const entry = proposal();
  const result = promoteScaffoldProposal(entry, { dataDir, now: '2026-05-21T12:00:00.000Z' });
  const promotionEvent = buildScaffoldPromotionEvent(entry, result, { now: '2026-05-21T12:00:00.000Z' });
  const hints = JSON.parse(fs.readFileSync(path.join(evolvedDir, 'tool-hints.json'), 'utf8'));

  assert.equal(hints.existing.hint, 'keep me');
  assert.equal(hints.exec.proposalId, entry.id);
  assert.match(hints.exec.hint, /Before using exec/);
  assert.equal(promotionEvent.action, 'apply_scaffold_proposal');
  assert.equal(promotionEvent.status, 'applied');
  assert.equal(promotionEvent.rollbackAction.action, 'rollback_scaffold_promotion');
  assert.ok(result.beforeHash);
  assert.ok(result.afterHash);
  assert.notEqual(result.beforeHash, result.afterHash);

  const rollbackResult = rollbackScaffoldPromotion(promotionEvent, { dataDir, now: '2026-05-21T12:05:00.000Z' });
  const rollbackEvent = buildScaffoldRollbackEvent(promotionEvent, rollbackResult, { now: '2026-05-21T12:05:00.000Z' });
  const restoredHints = JSON.parse(fs.readFileSync(path.join(evolvedDir, 'tool-hints.json'), 'utf8'));

  assert.equal(restoredHints.exec, undefined);
  assert.equal(restoredHints.existing.hint, 'keep me');
  assert.equal(rollbackEvent.action, 'rollback_scaffold_promotion');
  assert.equal(rollbackEvent.status, 'rolled_back');
});

test('scaffold promotion refuses non-preview or non-low-risk proposals', () => {
  assert.throws(() => promoteScaffoldProposal(proposal({ status: 'applied' }), { dataDir: tmpDir() }), /preview/);
  assert.throws(() => promoteScaffoldProposal(proposal({ risk: 'high' }), { dataDir: tmpDir() }), /low-risk/);
});
