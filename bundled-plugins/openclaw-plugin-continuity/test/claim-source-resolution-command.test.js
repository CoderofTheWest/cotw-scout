#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { runClaimSourceResolutionCommand, parseClaimSourceResolutionArgs } = require('../lib/claim-source-resolution-command');
const { CLAIM_KINDS, CLAIM_STATUSES, createClaimRecord } = require('../lib/claim-records');

const now = '2026-05-06T19:00:00.000Z';
const results = [];

const claim = createClaimRecord({
  id: 'claim_build5_candidate',
  agentId: 'trail-guide',
  threadId: 'main',
  kind: CLAIM_KINDS.PROJECT_STATE,
  status: CLAIM_STATUSES.VERIFY_REQUIRED,
  claim: 'Build 5 can resolve source content through an explicit read-only path.',
  sources: [{
    handle: 'file:projects/build-5/README.md#L1-L4',
    role: 'evidence',
    excerpt: 'Build 5 source resolution',
    quoteHash: 'hash_build5'
  }]
}, { now });

const digestClaim = createClaimRecord({
  id: 'claim_digest_summary_candidate',
  agentId: 'trail-guide',
  threadId: 'main',
  kind: CLAIM_KINDS.SUMMARY,
  status: CLAIM_STATUSES.VERIFY_REQUIRED,
  claim: 'Archived summary says Patch 8 added read-only diagnostics.',
  sources: [{
    handle: 'digest:main#v1:summary_summary_trail-guide_2026-05-05_1777991491599_0',
    role: 'origin',
    excerpt: 'Patch 8 added read-only diagnostics.',
    quoteHash: 'hash_digest_summary'
  }]
}, { now });

async function main() {
  await run('claim action resolves exact claim sources and keeps operator boundaries', async () => {
    const text = await runClaimSourceResolutionCommand(commandContext({
      args: 'claim --claim-id claim_build5_candidate --max-content-chars 120',
      resolverMap: {
        'file:projects/build-5/README.md#L1-L4': { ok: true, sourceType: 'file', content: '# Build 5\n\nlive source resolution', metadata: { path: 'projects/build-5/README.md' } }
      }
    }));
    assert.match(text, /Claim Source Resolution — READ ONLY/);
    assert.match(text, /claim_build5_candidate \[project_state\/verify_required\]/);
    assert.match(text, /Sources resolved this run: 1\/1/);
    assert.match(text, /content: # Build 5/);
    assert.match(text, /sourceResolutionAttempted: yes/);
    assert.match(text, /verificationAttempted: no/);
    assert.match(text, /mutationAttempted: no/);
    assert.match(text, /promotionAttempted: no/);
    assert.match(text, /promptInjectionAttempted: no/);
  });

  await run('claim action returns bounded output for missing claim without resolving', async () => {
    let resolverCalled = false;
    const text = await runClaimSourceResolutionCommand(commandContext({
      args: 'claim --claim-id missing_claim',
      createResolver: () => async () => {
        resolverCalled = true;
        return { ok: true, content: 'should not run' };
      }
    }));
    assert.equal(resolverCalled, false);
    assert.match(text, /claim not found/);
    assert.match(text, /sourceResolutionAttempted: no/);
    assert.match(text, /mutationAttempted: no/);
  });

  await run('handle action resolves one handle and lists linked claims', async () => {
    const text = await runClaimSourceResolutionCommand(commandContext({
      args: 'handle --source-handle file:projects/build-5/README.md#L1-L4',
      resolverMap: {
        'file:projects/build-5/README.md#L1-L4': { ok: true, sourceType: 'file', content: 'source text' }
      }
    }));
    assert.match(text, /Source handle: file:projects\/build-5\/README.md#L1-L4/);
    assert.match(text, /Claims using source: 1/);
    assert.match(text, /Claim ids: claim_build5_candidate/);
    assert.match(text, /content: source text/);
    assert.match(text, /verificationAttempted: no/);
  });

  await run('default resolver wires SummaryStore for digest-backed source handles', async () => {
    const text = await runClaimSourceResolutionCommand(commandContext({
      args: 'claim --claim-id claim_digest_summary_candidate --max-content-chars 140',
      claims: [claim, digestClaim],
      createResolver: null,
      summaryStore: {
        getSummary(id) {
          if (id !== 'summary_trail-guide_2026-05-05_1777991491599_0') return null;
          return {
            id,
            level: 0,
            agentId: 'trail-guide',
            threadId: 'main',
            summaryText: 'Topics: false, gateway. Key points: Patch 8 added read-only diagnostics.',
            createdAt: now
          };
        }
      }
    }));
    assert.match(text, /claim_digest_summary_candidate \[summary\/verify_required\]/);
    assert.match(text, /Sources resolved this run: 1\/1/);
    assert.match(text, /content: Topics: false, gateway/);
    assert.doesNotMatch(text, /activeThreadDigestStore is required/);
    assert.match(text, /promptInjectionAttempted: no/);
  });

  await run('unresolved source handles stay bounded and do not throw transport errors', async () => {
    const text = await runClaimSourceResolutionCommand(commandContext({
      args: 'handle --source-handle archive:2026-05-06:trail-guide:main#e9999',
      resolverMap: {
        'archive:2026-05-06:trail-guide:main#e9999': { ok: false, error: 'archive exchange does not exist' }
      }
    }));
    assert.match(text, /Resolution: unresolved/);
    assert.match(text, /archive exchange does not exist/);
    assert.match(text, /Summary: 0\/1 source handles resolved; verify before asserting/);
    assert.match(text, /promotionAttempted: no/);
  });

  await run('command rejects mutation, promotion, consumption, and injection flags', async () => {
    const text = await runClaimSourceResolutionCommand(commandContext({ args: 'claim --claim-id claim_build5_candidate --apply' }));
    assert.match(text, /--apply is not supported here/);
    assert.match(text, /Source resolution is read-only/);
    assert.doesNotMatch(text, /Claim Source Resolution — READ ONLY/);
  });

  await run('parser requires exact claim id or source handle', () => {
    assert.match(parseClaimSourceResolutionArgs('claim').parseError, /requires --claim-id/);
    assert.match(parseClaimSourceResolutionArgs('handle').parseError, /requires --source-handle/);
    assert.equal(parseClaimSourceResolutionArgs('claim --claim-id abc').claimId, 'abc');
    assert.equal(parseClaimSourceResolutionArgs('handle --handle file:a.md#L1-L1').sourceHandle, 'file:a.md#L1-L1');
  });

  await run('content is bounded by max-content-chars', async () => {
    const text = await runClaimSourceResolutionCommand(commandContext({
      args: 'handle --source-handle file:projects/build-5/README.md#L1-L4 --max-content-chars 80',
      resolverMap: {
        'file:projects/build-5/README.md#L1-L4': { ok: true, sourceType: 'file', content: 'x'.repeat(200) }
      }
    }));
    assert.match(text, /content: x{79}…/);
  });

  await run('command reports inert default when ClaimStore is unavailable', async () => {
    const text = await runClaimSourceResolutionCommand({
      args: 'claim --claim-id claim_build5_candidate',
      getCurrentAgentId: () => 'trail-guide',
      getAgentState: () => ({ ensureStorage: async () => {} })
    });
    assert.match(text, /ClaimStore is not initialized/);
    assert.match(text, /Runtime defaults may still be inert/);
  });

  const pass = results.filter((result) => result.status === 'PASS').length;
  const fail = results.length - pass;
  const lines = [];
  lines.push('# Claim Source Resolution Command Test Report');
  lines.push('');
  lines.push(`- PASS: ${pass}`);
  lines.push(`- FAIL: ${fail}`);
  lines.push(`- Total: ${results.length}`);
  lines.push('');
  lines.push('| Fixture | Status | Detail |');
  lines.push('|---|---:|---|');
  for (const result of results) lines.push(`| ${escapePipes(result.name)} | ${result.status} | ${escapePipes(result.detail)} |`);
  lines.push('');

  const reportPath = path.join(__dirname, 'reports', 'claim-source-resolution-command.md');
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

  console.log(`Claim source resolution command tests: PASS=${pass} FAIL=${fail}`);
  console.log(`Report: ${path.relative(process.cwd(), reportPath)}`);
  if (fail > 0) process.exit(1);
}

function commandContext({ args, resolverMap = {}, createResolver, claims = [claim], summaryStore } = {}) {
  const context = {
    args,
    getCurrentAgentId: () => 'trail-guide',
    getAgentState: () => ({
      ensureStorage: async () => {},
      claimStore: new FakeClaimStore(claims),
      summaryStore
    })
  };
  if (createResolver !== null) {
    context.createResolver = createResolver || (() => async (sourceOrHandle) => {
      const handle = typeof sourceOrHandle === 'string' ? sourceOrHandle : sourceOrHandle.handle;
      return resolverMap[handle] || { ok: false, error: 'resolver fixture missing' };
    });
  }
  return context;
}

class FakeClaimStore {
  constructor(claims = []) {
    this.claims = claims;
  }
  getClaim(id) {
    return this.claims.find((item) => item.id === id) || null;
  }
  getClaimsBySourceHandle(handle, filter = {}) {
    return this.claims
      .filter((item) => !filter.agentId || item.agentId === filter.agentId)
      .filter((item) => (item.sources || []).some((source) => source.handle === handle))
      .slice(0, filter.limit || 10)
      .map((item) => ({ ...item, sources: filter.includeSources === false ? [] : item.sources }));
  }
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
