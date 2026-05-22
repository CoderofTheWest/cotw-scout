#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const {
  CLAIM_KINDS,
  createClaimRecord,
  FRESHNESS_POLICIES
} = require('../lib/claim-records');
const {
  createClaimEdge,
  PROVENANCE_EDGE_TYPES,
  regroundClaimSources,
  summarizeProvenance,
  validateClaimEdge
} = require('../lib/provenance');

const root = __dirname;
const now = '2026-05-04T21:35:00.000Z';
const results = [];

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

async function main() {
await run('project state sources resolve but still require current verification', async () => {
  const claim = createClaimRecord({
    kind: CLAIM_KINDS.PROJECT_STATE,
    claim: 'Build 1 observe receipt exists after service-mode restart.',
    sources: [
      { handle: 'tool:session_1777929031099#call1', role: 'verification', excerpt: 'Build1 observe handoff_health present' },
      { handle: 'file:memory/2026-05-04.md#L217-L224', role: 'evidence' }
    ],
    stalenessPolicy: FRESHNESS_POLICIES.VERIFY_BEFORE_ASSERTING
  }, { now });
  const resolver = new Map([
    ['tool:session_1777929031099#call1', { ok: true, content: 'Build1 observe handoff_health present', timestamp: now }],
    ['file:memory/2026-05-04.md#L217-L224', { ok: true, sourceType: 'file', content: 'Runtime stabilization receipt', timestamp: now }]
  ]);
  const result = await regroundClaimSources(claim, resolver, { now });
  assert.equal(result.ok, true);
  assert.equal(result.resolvedCount, 2);
  assert.equal(result.unresolvedCount, 0);
  assert.equal(result.requiresVerification, true);
  assert.equal(summarizeProvenance(result), '2/2 source handles resolved; current-state verification still required.');
});

await run('missing resolver result marks provenance unresolved', async () => {
  const claim = createClaimRecord({
    kind: CLAIM_KINDS.SUMMARY,
    claim: 'We decided to preserve source handles through compaction.',
    sources: ['archive:2026-05-03:trail-guide:main#e0142']
  }, { now });
  const result = await regroundClaimSources(claim, new Map(), { now });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'verify_required');
  assert.equal(result.unresolvedCount, 1);
  assert.ok(result.reasons.includes('one or more source handles could not be resolved'));
});

await run('claim edge records supersession relationship', async () => {
  const edge = createClaimEdge({
    fromClaimId: 'claim_new',
    toClaimId: 'claim_old',
    relation: PROVENANCE_EDGE_TYPES.SUPERSEDES,
    sourceHandle: 'archive:2026-05-04:trail-guide:main#e0601',
    createdAt: now
  });
  const validation = validateClaimEdge(edge);
  assert.equal(validation.ok, true, validation.errors.join('; '));
  assert.equal(edge.relation, 'supersedes');
});

await run('resolver failure is captured without throwing', async () => {
  const claim = createClaimRecord({
    kind: CLAIM_KINDS.RUNTIME,
    claim: 'Gateway is reachable.',
    sources: ['tool:session_1777929031099#call7']
  }, { now });
  const result = await regroundClaimSources(claim, () => { throw new Error('tool log unavailable'); }, { now });
  assert.equal(result.ok, false);
  assert.equal(result.unresolvedSources[0].resolution.error, 'tool log unavailable');
  assert.equal(summarizeProvenance(result), '0/1 source handles resolved; verify before asserting.');
});

await run('handle-less claim summary refuses grounded-memory posture', async () => {
  const claim = createClaimRecord({
    kind: CLAIM_KINDS.INTERPRETATION,
    claim: 'This is an inference without attached evidence.'
  }, { now });
  const result = await regroundClaimSources(claim, null, { now });
  assert.equal(result.sourceCount, 0);
  assert.equal(result.requiresVerification, true);
  assert.equal(summarizeProvenance(result), 'No source handles are attached; do not treat this claim as grounded memory.');
});

const pass = results.filter((result) => result.status === 'PASS').length;
const fail = results.length - pass;
const lines = [];
lines.push('# Provenance Test Report');
lines.push('');
lines.push(`- PASS: ${pass}`);
lines.push(`- FAIL: ${fail}`);
lines.push(`- Total: ${results.length}`);
lines.push('');
lines.push('| Fixture | Status | Detail |');
lines.push('|---|---:|---|');
for (const result of results) lines.push(`| ${escapePipes(result.name)} | ${result.status} | ${escapePipes(result.detail)} |`);
lines.push('');

const reportPath = path.join(root, 'reports', 'provenance.md');
fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

console.log(`Provenance tests: PASS=${pass} FAIL=${fail}`);
console.log(`Report: ${path.relative(process.cwd(), reportPath)}`);
if (fail > 0) process.exit(1);
}

async function run(name, fn) {
  try {
    await fn();
    results.push({ name, status: 'PASS', detail: 'ok' });
  } catch (err) {
    results.push({ name, status: 'FAIL', detail: err.message });
  }
}

function escapePipes(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}
