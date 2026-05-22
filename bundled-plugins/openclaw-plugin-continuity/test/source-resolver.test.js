#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { createSourceResolver, resolveSourceHandle, safeJoin } = require('../lib/source-resolver');
const { CLAIM_KINDS, createClaimRecord } = require('../lib/claim-records');
const { regroundClaimSources, summarizeProvenance } = require('../lib/provenance');

const root = __dirname;
const now = '2026-05-04T22:34:00.000Z';
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-source-resolver-'));
const workspaceDir = path.join(tmpRoot, 'workspace');
const handoffDir = path.join(tmpRoot, 'handoffs');
fs.mkdirSync(path.join(workspaceDir, 'memory'), { recursive: true });
fs.mkdirSync(handoffDir, { recursive: true });
fs.writeFileSync(path.join(workspaceDir, 'memory', '2026-05-04.md'), ['line 1', 'Patch 3 source resolver', 'line 3', 'line 4'].join('\n'), 'utf8');
fs.writeFileSync(path.join(handoffDir, '2026-05-04-main.md'), ['# Handoff', 'goal line', 'state line', 'next line'].join('\n'), 'utf8');

const archiver = {
  getConversation(date) {
    if (date !== '2026-05-04') return null;
    return {
      date,
      messages: [
        { exchangeId: 'alpha', sender: 'user', text: 'first archived message', timestamp: now },
        { sender: 'agent', text: 'second archived message', timestamp: now }
      ]
    };
  }
};
const activeThreadDigestStore = {
  read(threadId) {
    if (threadId !== 'main') return null;
    return { threadId: 'main', version: 2, goal: 'preserve source handles', currentState: 'resolver tests', nested: { field: 'nested value' }, lastUpdated: now };
  }
};
const summaryStore = {
  getSummary(id) {
    if (id !== 'summary_trail-guide_2026-05-05_1777991491599_0') return null;
    return {
      id,
      level: 0,
      agentId: 'trail-guide',
      threadId: 'main',
      dateRangeStart: '2026-05-05',
      dateRangeEnd: '2026-05-05',
      summaryText: 'Topics: false, gateway. Key points: Patch 8 added read-only diagnostics.',
      createdAt: now
    };
  }
};
const transcriptMessages = [
  { role: 'user', content: 'zero message', timestamp: now },
  { role: 'assistant', content: 'one message', timestamp: now }
];

const resolver = createSourceResolver({ workspaceDir, handoffDirs: [handoffDir], archiver, activeThreadDigestStore, summaryStore, transcriptMessages });
const results = [];

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

async function main() {
await run('file resolver extracts workspace-relative line range', async () => {
  const result = await resolver('file:memory/2026-05-04.md#L2-L3');
  assert.equal(result.ok, true);
  assert.equal(result.sourceType, 'file');
  assert.equal(result.content, 'Patch 3 source resolver\nline 3');
  assert.equal(result.metadata.path, 'memory/2026-05-04.md');
});

await run('file resolver blocks absolute paths and traversal', async () => {
  assert.equal(safeJoin(workspaceDir, '../secret.md').ok, false);
  assert.equal((await resolver('file:../secret.md#L1-L1')).ok, false);
  assert.equal((await resolver(`file:${path.resolve(workspaceDir, 'memory/2026-05-04.md')}#L1-L1`)).ok, false);
});

await run('handoff resolver scans configured handoff dirs and extracts lines', async () => {
  const result = await resolver('handoff:2026-05-04:main#L2-L3');
  assert.equal(result.ok, true);
  assert.equal(result.content, 'goal line\nstate line');
  assert.equal(result.metadata.fileName, '2026-05-04-main.md');
});

await run('digest resolver reads explicit thread version and field', async () => {
  const result = await resolver('digest:main#v2:nested.field');
  assert.equal(result.ok, true);
  assert.equal(result.content, 'nested value');
  assert.equal(result.timestamp, now);
});

await run('digest resolver refuses stale version mismatch', async () => {
  const result = await resolver('digest:main#v1:goal');
  assert.equal(result.ok, false);
  assert.match(result.error, /version mismatch/);
});

await run('digest resolver can resolve summary-backed handles from SummaryStore', async () => {
  const result = await resolver('digest:main#v1:summary_summary_trail-guide_2026-05-05_1777991491599_0');
  assert.equal(result.ok, true);
  assert.equal(result.sourceType, 'digest');
  assert.match(result.content, /Patch 8 added read-only diagnostics/);
  assert.equal(result.metadata.summaryId, 'summary_trail-guide_2026-05-05_1777991491599_0');
  assert.equal(result.metadata.summaryThreadId, 'main');
});

await run('digest summary resolver enforces thread mismatch when available', async () => {
  const result = await resolver('digest:other#v1:summary_summary_trail-guide_2026-05-05_1777991491599_0');
  assert.equal(result.ok, false);
  assert.match(result.error, /summary thread mismatch/);
});

await run('non-summary digest handles still require ActiveThreadDigestStore', async () => {
  const noStores = createSourceResolver({});
  const result = await noStores('digest:main#v1:goal');
  assert.equal(result.ok, false);
  assert.match(result.error, /activeThreadDigestStore is required/);
});

await run('summary digest handles require SummaryStore before falling back to legacy digest fields', async () => {
  const noStores = createSourceResolver({});
  const result = await noStores('digest:main#v1:summary_summary_trail-guide_2026-05-05_1777991491599_0');
  assert.equal(result.ok, false);
  assert.match(result.error, /activeThreadDigestStore is required/);
});

await run('transcript resolver supports current-session messages only', async () => {
  const result = await resolver('transcript:session_live#m1');
  assert.equal(result.ok, true);
  assert.equal(result.content, 'one message');
  assert.equal(result.metadata.role, 'assistant');
});

await run('archive resolver supports explicit exchange id and numeric fallback', async () => {
  const explicit = await resolver('archive:2026-05-04:trail-guide:main#ealpha');
  const numeric = await resolver('archive:2026-05-04:trail-guide:main#e0002');
  assert.equal(explicit.ok, true);
  assert.equal(explicit.content, 'first archived message');
  assert.equal(numeric.ok, true);
  assert.equal(numeric.content, 'second archived message');
});

await run('unsupported handle types are unresolved, not thrown', async () => {
  const result = await resolver('commit:17c9698#package.json');
  assert.equal(result.ok, false);
  assert.match(result.error, /no resolver adapter configured/);
});

await run('custom adapter can resolve out-of-scope handle types', async () => {
  const custom = createSourceResolver({
    adapters: {
      commit: (parsed) => ({ ok: true, content: `commit ${parsed.sha} ${parsed.path}`, metadata: { custom: true } })
    }
  });
  const result = await custom('commit:17c9698#package.json');
  assert.equal(result.ok, true);
  assert.equal(result.content, 'commit 17c9698 package.json');
  assert.equal(result.metadata.custom, true);
});

await run('resolver composes with provenance regrounding', async () => {
  const claim = createClaimRecord({
    kind: CLAIM_KINDS.PROJECT_STATE,
    claim: 'Patch 3 resolver tests exist.',
    sources: ['file:memory/2026-05-04.md#L2-L2']
  }, { now });
  const regrounding = await regroundClaimSources(claim, resolver, { now });
  assert.equal(regrounding.ok, true);
  assert.equal(regrounding.resolvedCount, 1);
  assert.equal(summarizeProvenance(regrounding), '1/1 source handles resolved; current-state verification still required.');
});

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}

const pass = results.filter((result) => result.status === 'PASS').length;
const fail = results.length - pass;
const lines = [];
lines.push('# Source Resolver Test Report');
lines.push('');
lines.push(`- PASS: ${pass}`);
lines.push(`- FAIL: ${fail}`);
lines.push(`- Total: ${results.length}`);
lines.push('');
lines.push('| Fixture | Status | Detail |');
lines.push('|---|---:|---|');
for (const result of results) lines.push(`| ${escapePipes(result.name)} | ${result.status} | ${escapePipes(result.detail)} |`);
lines.push('');

const reportPath = path.join(root, 'reports', 'source-resolver.md');
fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

console.log(`Source resolver tests: PASS=${pass} FAIL=${fail}`);
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
