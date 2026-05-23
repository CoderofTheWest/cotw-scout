const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  promoteScaffoldProposal,
  promoteHarnessRefinerProposal,
  rollbackScaffoldPromotion,
  buildScaffoldPromotionEvent,
  buildHarnessRefinerPromotionEvent,
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

test('Harness Refiner workflow/tool-hint proposals use scaffold promotion with rollback', () => {
  const dataDir = tmpDir();
  const entry = {
    id: 'harness-refiner-proposal-tool-loop',
    class: 'process_ui_friction',
    title: 'Harness proposal: Tool loop around exec',
    summary: 'exec was retried with the same input shape.',
    status: 'preview',
    risk: 'low',
    sourceCategory: 'harness-refiner proposal',
    action: 'harness_refinement_proposal',
    expectedEffect: 'Reduce recurrence of tool loops.',
    verification: 'Run fixture.',
    rollback: 'Dismiss proposal.',
    metadata: {
      signature: 'tool_loop',
      lane: 'workflow_patch',
      targetSurface: 'tool-loop:exec',
      proposedChange: 'Pause before retrying the same command without new evidence.',
      confidence: 0.72,
      applyPath: 'existing_scaffold_gate',
      mutationAttempted: 'false',
      promptInjectionChanged: 'false',
      launchTraining: false,
      adapterPromotion: false,
      modelRoutingMutation: false,
      gatewayInvocation: false
    }
  };

  const result = promoteHarnessRefinerProposal(entry, { dataDir, now: '2026-05-22T12:00:00.000Z' });
  const promotionEvent = buildHarnessRefinerPromotionEvent(entry, result, { now: '2026-05-22T12:00:00.000Z' });
  const workflows = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolved', 'workflows.json'), 'utf8'));

  assert.equal(workflows.length, 1);
  assert.equal(workflows[0].proposalId, entry.id);
  assert.match(workflows[0].sequence, /Pause before retrying/);
  assert.equal(promotionEvent.action, 'apply_scaffold_proposal');
  assert.equal(promotionEvent.sourceCategory, 'harness-refiner scaffold promotion');
  assert.equal(promotionEvent.metadata.sourceProposalAction, 'harness_refinement_proposal');
  assert.equal(promotionEvent.metadata.harnessLane, 'workflow_patch');
  assert.equal(promotionEvent.rollbackAction.action, 'rollback_scaffold_promotion');

  const rollbackResult = rollbackScaffoldPromotion(promotionEvent, { dataDir, now: '2026-05-22T12:05:00.000Z' });
  assert.ok(rollbackResult.afterHash);
  const restoredWorkflows = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolved', 'workflows.json'), 'utf8'));
  assert.deepEqual(restoredWorkflows, []);
});

test('Harness Refiner scaffold promotion refuses protected lanes and Gateway/training flags', () => {
  const base = {
    id: 'harness-refiner-proposal-mode',
    action: 'harness_refinement_proposal',
    status: 'preview',
    risk: 'low',
    metadata: {
      lane: 'mode_patch',
      targetSurface: 'mode',
      proposedChange: 'Change mode behavior.',
      applyPath: 'review_only',
      mutationAttempted: 'false',
      promptInjectionChanged: 'false'
    }
  };
  assert.throws(() => promoteHarnessRefinerProposal(base, { dataDir: tmpDir() }), /unsupported Harness Refiner promotion lane/);
  assert.throws(() => promoteHarnessRefinerProposal({
    ...base,
    metadata: {
      ...base.metadata,
      lane: 'workflow_patch',
      applyPath: 'existing_scaffold_gate',
      gatewayInvocation: 'true'
    }
  }, { dataDir: tmpDir() }), /Gateway mutation flags/);
});
