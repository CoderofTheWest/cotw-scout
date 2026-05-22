#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { FIXTURE_SEEDS, createClaimFixtureSeed, renderClaimFixtureSeed } = require('../lib/claim-fixture-seed');

const now = '2026-05-05T20:45:00.000Z';
const validInput = {
  fixture: FIXTURE_SEEDS.MANUAL_REVIEW_CLEAN_CLAIM,
  agentId: 'trail-guide',
  claim: 'Commit abc1234 added a safe manual review fixture.',
  sourceHandle: 'commit:abc1234#bundled-plugins/openclaw-plugin-continuity/lib/claim-fixture-seed.js',
  excerpt: 'safe manual review fixture',
  reason: 'prove manual review clean packet path'
};

const results = [];
let pass = 0;
let fail = 0;

run('dry-run fixture seed validates claim without mutating store', () => {
  const store = mockStore();
  const result = createClaimFixtureSeed({ ...validInput, claimStore: store }, { now });
  assert.equal(result.dryRun, true);
  assert.equal(result.mutationAttempted, false);
  assert.equal(result.promotionAttempted, false);
  assert.equal(result.status, 'active');
  assert.equal(result.stalenessPolicy, 'evergreen');
  assert.equal(store.stored.length, 0);
  assert.match(renderClaimFixtureSeed(result), /Dry run: yes/);
});

run('apply fixture seed writes exactly one source-backed claim', () => {
  const store = mockStore();
  const result = createClaimFixtureSeed({ ...validInput, claimStore: store, apply: true }, { now });
  assert.equal(result.dryRun, false);
  assert.equal(result.mutationAttempted, true);
  assert.equal(result.promotionAttempted, false);
  assert.equal(store.stored.length, 1);
  const claim = store.stored[0];
  assert.equal(claim.status, 'active');
  assert.equal(claim.metadata.fixtureOnly, true);
  assert.equal(claim.metadata.candidateOnly, false);
  assert.equal(claim.sources.length, 1);
  assert.equal(claim.sources[0].valid, true);
});

run('apply fixture seed requires explicit reason', () => {
  const store = mockStore();
  assert.throws(() => createClaimFixtureSeed({ ...validInput, claimStore: store, apply: true, reason: '' }, { now }), /requires a reason/);
  assert.equal(store.stored.length, 0);
});

run('fixture seed rejects non-commit source handles', () => {
  const store = mockStore();
  assert.throws(() => createClaimFixtureSeed({ ...validInput, claimStore: store, sourceHandle: 'handoff:2026-05-05:main#L1-L2' }, { now }), /requires a commit sourceHandle/);
  assert.equal(store.stored.length, 0);
});

run('fixture seed rejects unsupported fixture names', () => {
  const store = mockStore();
  assert.throws(() => createClaimFixtureSeed({ ...validInput, claimStore: store, fixture: 'arbitrary_claim' }, { now }), /unsupported fixture/);
  assert.equal(store.stored.length, 0);
});

writeReportAndExit();

function mockStore() {
  return {
    stored: [],
    storeClaim(claim) {
      this.stored.push(claim);
      return claim;
    }
  };
}

function run(name, fn) {
  try {
    fn();
    pass += 1;
    results.push({ name, status: 'PASS', detail: 'ok' });
  } catch (err) {
    fail += 1;
    results.push({ name, status: 'FAIL', detail: err.stack || err.message });
  }
}

function writeReportAndExit() {
  const lines = [];
  lines.push('# Claim Fixture Seed Test Report');
  lines.push('');
  lines.push(`- PASS: ${pass}`);
  lines.push(`- FAIL: ${fail}`);
  lines.push(`- Total: ${results.length}`);
  lines.push('');
  lines.push('| Fixture | Status | Detail |');
  lines.push('|---|---:|---|');
  for (const result of results) lines.push(`| ${escapePipes(result.name)} | ${result.status} | ${escapePipes(result.detail)} |`);
  lines.push('');

  const reportPath = path.join(__dirname, 'reports', 'claim-fixture-seed.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

  console.log(`Claim fixture seed tests: PASS=${pass} FAIL=${fail}`);
  console.log(`Report: ${path.relative(process.cwd(), reportPath)}`);
  if (fail) process.exit(1);
}

function escapePipes(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}
