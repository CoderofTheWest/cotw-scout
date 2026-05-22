#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { createClaimCandidates } = require('../lib/claim-candidates');
const { persistClaimCandidateResult } = require('../lib/claim-candidate-persistence');

const root = __dirname;
const now = '2026-05-04T23:12:00.000Z';
const recordConfig = {
  sourceAddressableMemory: {
    enabled: true,
    mode: 'record',
    createClaimsFromHandoffs: true,
    persistClaimCandidates: true
  }
};
const observeConfig = {
  sourceAddressableMemory: {
    enabled: true,
    mode: 'observe',
    createClaimsFromHandoffs: true,
    persistClaimCandidates: true
  }
};
const results = [];

run('default/observe mode does not persist candidates even with a store present', () => {
  const result = createClaimCandidates({
    handoff: {
      content: '## Key Points\n- Observe mode sees but does not write.',
      date: '2026-05-04',
      threadId: 'main',
      agentId: 'trail-guide'
    }
  }, { config: observeConfig, now });
  const store = fakeStore();
  const persisted = persistClaimCandidateResult(result, store, { config: observeConfig, kind: 'session_handoff', now });
  assert.equal(result.candidateCount, 1);
  assert.equal(persisted.allowed, false);
  assert.equal(persisted.persistedCount, 0);
  assert.equal(store.claims.length, 0);
});

run('record mode plus persist flag stores candidates through ClaimStore only', () => {
  const result = createClaimCandidates({
    handoff: {
      content: '## Key Points\n- Record mode may persist this candidate.',
      date: '2026-05-04',
      threadId: 'main',
      agentId: 'trail-guide'
    }
  }, { config: recordConfig, now });
  const store = fakeStore();
  const persisted = persistClaimCandidateResult(result, store, { config: recordConfig, kind: 'session_handoff', now });
  assert.equal(result.persist, true);
  assert.equal(persisted.allowed, true);
  assert.equal(persisted.attempted, true);
  assert.equal(persisted.persisted, true);
  assert.equal(persisted.persistedCount, 1);
  assert.equal(store.claims.length, 1);
  assert.equal(store.claims[0].metadata.candidatePersisted, true);
  assert.equal(store.claims[0].metadata.observationKind, 'session_handoff');
});

run('record mode still does nothing without an initialized ClaimStore', () => {
  const result = createClaimCandidates({
    handoff: {
      content: '## Key Points\n- Missing store blocks persistence.',
      date: '2026-05-04',
      threadId: 'main',
      agentId: 'trail-guide'
    }
  }, { config: recordConfig, now });
  const persisted = persistClaimCandidateResult(result, null, { config: recordConfig, kind: 'session_handoff', now });
  assert.equal(persisted.allowed, true);
  assert.equal(persisted.attempted, false);
  assert.equal(persisted.persistedCount, 0);
});

run('persistence helper does not resolve sources or return prompt context', () => {
  const source = fs.readFileSync(path.join(root, '..', 'lib', 'claim-candidate-persistence.js'), 'utf8');
  assert.doesNotMatch(source, /resolveSource|sourceResolver|prependContext|lines\.push|summaryText|transcript/i);
});

const pass = results.filter((r) => r.status === 'PASS').length;
const fail = results.length - pass;
const lines = [];
lines.push('# Claim Candidate Persistence Test Report');
lines.push('');
lines.push(`- PASS: ${pass}`);
lines.push(`- FAIL: ${fail}`);
lines.push(`- Total: ${results.length}`);
lines.push('');
lines.push('| Fixture | Status | Detail |');
lines.push('|---|---:|---|');
for (const result of results) lines.push(`| ${escapePipes(result.name)} | ${result.status} | ${escapePipes(result.detail)} |`);
lines.push('');

const reportPath = path.join(root, 'reports', 'claim-candidate-persistence.md');
fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

console.log(`Claim candidate persistence tests: PASS=${pass} FAIL=${fail}`);
console.log(`Report: ${path.relative(process.cwd(), reportPath)}`);
if (fail) {
  for (const r of results.filter((r) => r.status === 'FAIL')) console.error(`${r.name}: ${r.detail}`);
  process.exit(1);
}

function fakeStore() {
  return {
    claims: [],
    storeClaim(claim) {
      this.claims.push(claim);
      return claim;
    }
  };
}

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
