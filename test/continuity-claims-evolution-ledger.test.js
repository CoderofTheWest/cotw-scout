const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const createClaimsTool = require('../bundled-plugins/openclaw-plugin-continuity/tools/continuity-claims');
const { readEvolutionLedger } = require('../lib/evolution-ledger');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-evolution-'));
}

function createToolHarness(initialClaim) {
  const workspacePath = tmpDir();
  let claim = initialClaim;
  const claimStore = {
    getClaim(id) { return id === claim.id ? claim : null; },
    storeClaim(next) { claim = next; }
  };
  const state = {
    claimStore,
    dataDir: path.join(workspacePath, '.plugin-data'),
    knowledgeIndexer: { workspacePath },
    ensureStorage: async () => {}
  };
  return {
    workspacePath,
    ledgerPath: path.join(workspacePath, 'evolution', 'ledger.json'),
    get claim() { return claim; },
    tool: createClaimsTool(() => state, () => 'trail-guide')
  };
}

function createToolHarnessWithoutWorkspace(initialClaim) {
  const dataDir = path.join(tmpDir(), 'plugin-data');
  let claim = initialClaim;
  const claimStore = {
    getClaim(id) { return id === claim.id ? claim : null; },
    storeClaim(next) { claim = next; }
  };
  const state = {
    claimStore,
    dataDir,
    ensureStorage: async () => {}
  };
  return {
    dataDir,
    ledgerPath: path.join(dataDir, 'agents', 'trail-guide', 'evolution-ledger.json'),
    legacyCwdLedgerPath: path.join(process.cwd(), 'evolution-ledger.json'),
    get claim() { return claim; },
    tool: createClaimsTool(() => state, () => 'trail-guide')
  };
}

function makeClaim(overrides = {}) {
  return {
    id: 'claim-evo-1',
    agentId: 'trail-guide',
    kind: 'summary',
    text: 'An unresolved open question that should not be asserted.',
    status: 'verify_required',
    confidence: 0.35,
    metadata: {},
    sources: [],
    freshness: {},
    edges: [],
    ...overrides
  };
}

test('continuity apply_review_decision emits live evolution ledger receipt', async () => {
  const harness = createToolHarness(makeClaim());

  const result = await harness.tool.execute('call_apply_review_decision', {
    action: 'apply_review_decision',
    claim_id: 'claim-evo-1',
    decision: 'archive_open_question',
    expected_status: 'verify_required',
    reason: 'autonomous low-risk archive of an open question',
    apply: true
  });

  assert.match(result.content[0].text, /Authorization mode: autonomous_low_risk/);
  const ledger = readEvolutionLedger(harness.ledgerPath);
  assert.equal(ledger.events.length, 1);
  assert.equal(ledger.events[0].class, 'claim_review');
  assert.equal(ledger.events[0].claimId, 'claim-evo-1');
  assert.equal(ledger.events[0].rollbackAction.action, 'rollback_review_decision');
});

test('continuity dry-run review decisions do not emit evolution receipts', async () => {
  const harness = createToolHarness(makeClaim({ id: 'claim-evo-dry' }));

  const result = await harness.tool.execute('call_apply_review_decision', {
    action: 'apply_review_decision',
    claim_id: 'claim-evo-dry',
    decision: 'archive_open_question',
    expected_status: 'verify_required',
    reason: 'preview only',
    apply: false
  });

  assert.match(result.content[0].text, /Mutation attempted: no/);
  const ledger = readEvolutionLedger(harness.ledgerPath);
  assert.equal(ledger.events.length, 0);
});

test('continuity apply_review_decision without workspace writes plugin-data ledger, not cwd', async () => {
  const harness = createToolHarnessWithoutWorkspace(makeClaim({ id: 'claim-evo-plugin-data' }));
  const legacyExistedBefore = fs.existsSync(harness.legacyCwdLedgerPath);
  const legacyMtimeBefore = legacyExistedBefore ? fs.statSync(harness.legacyCwdLedgerPath).mtimeMs : null;

  const result = await harness.tool.execute('call_apply_review_decision_plugin_data_fallback', {
    action: 'apply_review_decision',
    claim_id: 'claim-evo-plugin-data',
    decision: 'archive_open_question',
    expected_status: 'verify_required',
    reason: 'autonomous low-risk archive without workspace path',
    apply: true
  });

  assert.match(result.content[0].text, /Mutation attempted: yes/);
  const ledger = readEvolutionLedger(harness.ledgerPath);
  assert.equal(ledger.events.length, 1);
  assert.equal(ledger.events[0].claimId, 'claim-evo-plugin-data');
  assert.equal(ledger.events[0].action, 'apply_review_decision');
  if (legacyExistedBefore) {
    assert.equal(fs.statSync(harness.legacyCwdLedgerPath).mtimeMs, legacyMtimeBefore);
  } else {
    assert.equal(fs.existsSync(harness.legacyCwdLedgerPath), false);
  }
});

test('continuity rollback_review_decision emits live evolution ledger receipt', async () => {
  const harness = createToolHarness(makeClaim({ id: 'claim-evo-rollback' }));

  await harness.tool.execute('call_apply_review_decision', {
    action: 'apply_review_decision',
    claim_id: 'claim-evo-rollback',
    decision: 'archive_open_question',
    expected_status: 'verify_required',
    reason: 'autonomous low-risk archive of an open question',
    apply: true
  });
  const beforeReceipt = harness.claim.metadata.autonomyApplyReceipts.find((receipt) => receipt.phase === 'before');

  const result = await harness.tool.execute('call_rollback_review_decision', {
    action: 'rollback_review_decision',
    claim_id: 'claim-evo-rollback',
    receipt_id: beforeReceipt.id,
    reason: 'operator requested rollback from Evolve inspection',
    apply: true
  });

  assert.match(result.content[0].text, /Mutation attempted: yes/);
  const ledger = readEvolutionLedger(harness.ledgerPath);
  assert.equal(ledger.events.length, 2);
  assert.equal(ledger.events[0].action, 'rollback_review_decision');
  assert.equal(ledger.events[0].status, 'rolled_back');
  assert.equal(ledger.events[0].claimId, 'claim-evo-rollback');
});
