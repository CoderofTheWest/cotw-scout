#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const {
  createClaimCandidates,
  createHandoffClaimCandidates,
  createSummaryClaimCandidates,
  createDigestClaimCandidates,
  candidateGenerationAllowed,
  shouldPersistClaimCandidates,
  parseMarkdownSections
} = require('../lib/claim-candidates');
const { validateClaimRecord } = require('../lib/claim-records');

const root = __dirname;
const now = '2026-05-04T22:43:00.000Z';
const enabledObserve = {
  sourceAddressableMemory: {
    enabled: true,
    mode: 'observe',
    createClaimsFromHandoffs: true,
    createClaimsFromSummaries: true,
    createClaimsFromDigests: true
  }
};
const results = [];

run('default config does not generate or persist candidates', () => {
  const result = createClaimCandidates({
    digest: { threadId: 'main', agentId: 'trail-guide', goal: 'build safely', currentState: 'testing' }
  }, { config: { sourceAddressableMemory: { enabled: false } }, now });
  assert.equal(result.candidateCount, 0);
  assert.equal(result.persist, false);
  assert.equal(result.action, 'observe_only_no_persistence');
  assert.equal(candidateGenerationAllowed({ sourceAddressableMemory: { enabled: false } }, 'digest'), false);
});

run('candidate generation requires explicit per-source flags', () => {
  const config = { sourceAddressableMemory: { enabled: true, mode: 'observe', createClaimsFromDigests: false } };
  assert.equal(candidateGenerationAllowed(config, 'digest'), false);
  assert.equal(shouldPersistClaimCandidates(config), false);
});

run('record persistence remains separately gated', () => {
  assert.equal(shouldPersistClaimCandidates({ sourceAddressableMemory: { enabled: true, mode: 'record' } }), false);
  assert.equal(shouldPersistClaimCandidates({ sourceAddressableMemory: { enabled: true, mode: 'record', persistClaimCandidates: true } }), true);
});

run('handoff candidate generation creates sourced summary and open-thread claims', () => {
  const handoff = [
    '# Session Handoff',
    'Generated: 2026-05-04',
    '## Key Points',
    '- Patch 4 landed behind explicit enablement.',
    '- Defaults remain disabled.',
    '## Open Threads',
    '- Verify Patch 4 with an observe receipt later.'
  ].join('\n');
  const claims = createHandoffClaimCandidates({
    content: handoff,
    date: '2026-05-04',
    threadId: 'main',
    agentId: 'trail-guide'
  }, { now });
  assert.equal(claims.length, 3);
  assert.ok(claims.every((claim) => validateClaimRecord(claim).ok));
  assert.equal(claims[0].sources[0].handle, 'handoff:2026-05-04:main#L4-L4');
  assert.equal(claims[2].kind, 'commitment');
  assert.equal(claims[2].metadata.candidateOnly, true);
});

run('handoff candidate generation skips queued-message and working-memory wrapper noise', () => {
  const handoff = [
    '# Session Handoff',
    'Generated: 2026-05-05',
    '## Key Points',
    '- [identity · foundational] "[Queued user message that arrived while the previous turn was still active]"',
    '- [contradiction · foundational] "[YOUR WORKING MEMORY] Current time: Tuesday..."',
    '- Build 2 record-mode proof remains pending.',
    '## Open Threads',
    '- [tension] [Queued user message that arrived while the previous turn was still active]',
    '- Verify one clean record-mode claim write.'
  ].join('\n');
  const claims = createHandoffClaimCandidates({
    content: handoff,
    date: '2026-05-05',
    threadId: 'main',
    agentId: 'trail-guide'
  }, { now });
  assert.equal(claims.length, 2);
  assert.equal(claims[0].claim, 'Handoff note: Build 2 record-mode proof remains pending.');
  assert.equal(claims[0].sources[0].handle, 'handoff:2026-05-05:main#L6-L6');
  assert.equal(claims[1].claim, 'Open thread: Verify one clean record-mode claim write.');
  assert.equal(claims[1].sources[0].handle, 'handoff:2026-05-05:main#L9-L9');
});

run('summary candidates remain verify-required when source handles are absent', () => {
  const [claim] = createSummaryClaimCandidates({
    id: 'sum_1',
    agentId: 'trail-guide',
    threadId: 'main',
    level: 0,
    summaryText: 'A summary without preserved source handles should not become grounded certainty.'
  }, { now });
  assert.equal(validateClaimRecord(claim).ok, true);
  assert.equal(claim.sources.length, 0);
  assert.equal(claim.status, 'verify_required');
  assert.equal(claim.metadata.summaryId, 'sum_1');
});

run('summary candidates preserve supplied source handles', () => {
  const [claim] = createSummaryClaimCandidates({
    id: 'sum_2',
    agentId: 'trail-guide',
    threadId: 'main',
    summaryText: 'A sourced summary can remain re-groundable.',
    sourceHandles: ['archive:2026-05-04:trail-guide:main#e0002']
  }, { now });
  assert.equal(validateClaimRecord(claim).ok, true);
  assert.equal(claim.sources[0].handle, 'archive:2026-05-04:trail-guide:main#e0002');
  assert.equal(claim.status, 'active');
});

run('digest candidates reuse Build 2 digest claim primitive', () => {
  const claims = createDigestClaimCandidates({
    threadId: 'main',
    agentId: 'trail-guide',
    version: 3,
    goal: 'preserve provenance',
    currentState: 'candidate module under test',
    commitments: ['no persistence by default'],
    sourceHandles: ['archive:2026-05-04:trail-guide:main#e0003'],
    lastUpdated: now
  }, { now });
  assert.equal(claims.length, 3);
  assert.ok(claims.every((claim) => validateClaimRecord(claim).ok));
  assert.ok(claims.every((claim) => claim.metadata.candidateSource === 'digest'));
});

run('createClaimCandidates aggregates enabled sources but still observe-only', () => {
  const result = createClaimCandidates({
    handoff: {
      content: '## Key Points\n- Candidate aggregation works.',
      date: '2026-05-04',
      threadId: 'main',
      agentId: 'trail-guide'
    },
    summary: {
      id: 'sum_3',
      agentId: 'trail-guide',
      summaryText: 'summary candidate'
    },
    digest: {
      threadId: 'main',
      agentId: 'trail-guide',
      goal: 'aggregate candidates',
      lastUpdated: now,
      sourceHandles: ['archive:2026-05-04:trail-guide:main#e0004']
    }
  }, { config: enabledObserve, now });
  assert.equal(result.candidateCount, 3);
  assert.equal(result.invalidCount, 0);
  assert.equal(result.persist, false);
});

run('markdown section parser preserves line numbers for source handles', () => {
  const sections = parseMarkdownSections('# H\nintro\n## Key Points\n- one\n- two');
  const keyPoints = sections.find((section) => section.title === 'Key Points');
  assert.equal(keyPoints.lines[0].line, 4);
  assert.equal(keyPoints.lines[1].line, 5);
});

const pass = results.filter((r) => r.status === 'PASS').length;
const fail = results.length - pass;
const lines = [];
lines.push('# Claim Candidates Test Report');
lines.push('');
lines.push(`- PASS: ${pass}`);
lines.push(`- FAIL: ${fail}`);
lines.push(`- Total: ${results.length}`);
lines.push('');
lines.push('| Fixture | Status | Detail |');
lines.push('|---|---:|---|');
for (const result of results) lines.push(`| ${escapePipes(result.name)} | ${result.status} | ${escapePipes(result.detail)} |`);
lines.push('');

const reportPath = path.join(root, 'reports', 'claim-candidates.md');
fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

console.log(`Claim candidate tests: PASS=${pass} FAIL=${fail}`);
console.log(`Report: ${path.relative(process.cwd(), reportPath)}`);
if (fail) {
  for (const r of results.filter((r) => r.status === 'FAIL')) console.error(`${r.name}: ${r.detail}`);
  process.exit(1);
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
