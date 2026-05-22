#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const {
  assessClaimFreshness,
  claimRecordSqlSchema,
  claimRequiresVerification,
  CLAIM_KINDS,
  CLAIM_STATUSES,
  createClaimRecord,
  createDigestClaims,
  FRESHNESS_POLICIES,
  validateClaimRecord
} = require('../lib/claim-records');
const { createActiveThreadDigest } = require('../lib/active-thread-digest');

const root = __dirname;
const now = '2026-05-04T21:20:00.000Z';
const results = [];

run('project state defaults to verify-before-asserting', () => {
  const claim = createClaimRecord({
    agentId: 'trail-guide',
    threadId: 'main',
    kind: CLAIM_KINDS.PROJECT_STATE,
    claim: 'Build 1 observe wiring landed in the live continuity plugin.',
    sources: [{ handle: 'commit:4e22ec0#bundled-plugins/openclaw-plugin-continuity/index.js', role: 'evidence' }]
  }, { now });
  const validation = validateClaimRecord(claim);
  const freshness = assessClaimFreshness(claim, { now });
  assert.equal(validation.ok, true, validation.errors.join('; '));
  assert.equal(claim.status, CLAIM_STATUSES.ACTIVE);
  assert.equal(claim.freshness.stalenessPolicy, FRESHNESS_POLICIES.VERIFY_BEFORE_ASSERTING);
  assert.equal(freshness.requiresVerification, true);
  assert.ok(freshness.reasons.includes('verify before asserting'));
});

run('runtime claim is verify_required even with tool evidence', () => {
  const claim = createClaimRecord({
    kind: CLAIM_KINDS.RUNTIME,
    claim: 'Gateway is reachable.',
    sources: [{ handle: 'tool:session_abc#call7', role: 'verification', excerpt: 'Gateway reachable' }]
  }, { now });
  assert.equal(claim.status, CLAIM_STATUSES.VERIFY_REQUIRED);
  assert.equal(claimRequiresVerification(claim, { now }), true);
});

run('handle-less summary claim validates as weaker and verify_required', () => {
  const claim = createClaimRecord({
    kind: CLAIM_KINDS.SUMMARY,
    claim: 'We discussed source-addressable memory.'
  }, { now });
  const validation = validateClaimRecord(claim);
  assert.equal(claim.status, CLAIM_STATUSES.VERIFY_REQUIRED);
  assert.equal(claim.confidence < 0.5, true);
  assert.equal(validation.ok, true, validation.errors.join('; '));
});

run('user preference uses user-correction-wins policy', () => {
  const claim = createClaimRecord({
    kind: CLAIM_KINDS.USER_PREFERENCE,
    claim: 'Chris prefers direct code-mode execution.',
    sources: ['archive:2026-05-04:trail-guide:main#e0601']
  }, { now });
  const freshness = assessClaimFreshness(claim, { now });
  assert.equal(claim.freshness.stalenessPolicy, FRESHNESS_POLICIES.USER_CORRECTION_WINS);
  assert.equal(freshness.requiresVerification, false);
});

run('digest claims include digest field handles and verify policy', () => {
  const digest = createActiveThreadDigest({
    threadId: 'main',
    agentId: 'trail-guide',
    goal: 'Continue COTW Continuity Spine Build 2.',
    currentState: 'Build 1 observe receipt exists after service-mode restart.',
    commitments: ['Come back to GUI anchor/project drawer design issue.'],
    sourceHandles: ['tool:session_abc#call9'],
    lastUpdated: now,
    version: 3
  }, { now });
  const claims = createDigestClaims(digest, { now });
  assert.equal(claims.length, 3);
  assert.ok(claims[0].sources.some((source) => source.handle === 'digest:main#v3:goal'));
  assert.ok(claims[1].sources.some((source) => source.handle === 'digest:main#v3:currentState'));
  assert.equal(claims.every((claim) => claim.freshness.stalenessPolicy === FRESHNESS_POLICIES.VERIFY_BEFORE_ASSERTING), true);
});

run('claim SQL schema contains the three provenance tables', () => {
  const schema = claimRecordSqlSchema();
  assert.ok(schema.includes('CREATE TABLE IF NOT EXISTS claims'));
  assert.ok(schema.includes('CREATE TABLE IF NOT EXISTS claim_sources'));
  assert.ok(schema.includes('CREATE TABLE IF NOT EXISTS claim_edges'));
});

const pass = results.filter((result) => result.status === 'PASS').length;
const fail = results.length - pass;
const lines = [];
lines.push('# Claim Records Test Report');
lines.push('');
lines.push(`- PASS: ${pass}`);
lines.push(`- FAIL: ${fail}`);
lines.push(`- Total: ${results.length}`);
lines.push('');
lines.push('| Fixture | Status | Detail |');
lines.push('|---|---:|---|');
for (const result of results) lines.push(`| ${escapePipes(result.name)} | ${result.status} | ${escapePipes(result.detail)} |`);
lines.push('');

const reportPath = path.join(root, 'reports', 'claim-records.md');
fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

console.log(`Claim record tests: PASS=${pass} FAIL=${fail}`);
console.log(`Report: ${path.relative(process.cwd(), reportPath)}`);
if (fail > 0) process.exit(1);

function run(name, fn) {
  try {
    fn();
    results.push({ name, status: 'PASS', detail: 'ok' });
  } catch (err) {
    results.push({ name, status: 'FAIL', detail: err.message });
  }
}

function escapePipes(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}
