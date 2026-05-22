#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const {
  createClaimDiagnostic,
  inspectClaim,
  inspectClaimWithResolvedSources,
  summarizeClaimStore
} = require('../lib/claim-diagnostics');
const { CLAIM_KINDS, CLAIM_STATUSES, createClaimRecord } = require('../lib/claim-records');

const now = '2026-05-04T23:30:00.000Z';
const results = [];

const activeClaim = createClaimRecord({
  id: 'claim_active_project',
  agentId: 'trail-guide',
  threadId: 'main',
  kind: CLAIM_KINDS.USER_PREFERENCE,
  claim: 'Chris prefers direct code-mode help during build sessions.',
  sources: [{
    handle: 'archive:2026-05-04:trail-guide:main#e0007',
    role: 'evidence',
    excerpt: 'CODE SESSION CONTEXT: Help directly.',
    quoteHash: 'hash_pref'
  }]
}, { now });

const runtimeClaim = createClaimRecord({
  id: 'claim_runtime_gateway',
  agentId: 'trail-guide',
  threadId: 'ops',
  kind: CLAIM_KINDS.RUNTIME,
  claim: 'Gateway is currently running under service mode.',
  sources: [{
    handle: 'tool:session_abc#call9',
    role: 'verification',
    excerpt: 'gateway status output',
    quoteHash: 'hash_runtime'
  }]
}, { now });

const supersededClaim = createClaimRecord({
  id: 'claim_superseded',
  agentId: 'trail-guide',
  threadId: 'ops',
  kind: CLAIM_KINDS.PROJECT_STATE,
  claim: 'Old project state.',
  status: CLAIM_STATUSES.SUPERSEDED,
  sources: ['archive:2026-05-04:trail-guide:ops#e0001']
}, { now });

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});

async function main() {
  await run('createClaimDiagnostic omits source excerpts and source content by default', () => {
    const diagnostic = createClaimDiagnostic(activeClaim, { now });
    assert.equal(diagnostic.ok, true);
    assert.equal(diagnostic.sourceCount, 1);
    assert.equal(diagnostic.sources[0].handle, 'archive:2026-05-04:trail-guide:main#e0007');
    assert.equal(diagnostic.sources[0].hasExcerpt, true);
    assert.equal(Object.hasOwn(diagnostic.sources[0], 'excerpt'), false);
    assert.equal(Object.hasOwn(diagnostic.sources[0], 'content'), false);
  });

  await run('diagnostic marks runtime claims verify-before-asserting', () => {
    const diagnostic = createClaimDiagnostic(runtimeClaim, { now });
    assert.equal(diagnostic.requiresVerification, true);
    assert.equal(diagnostic.action, 'verify_before_asserting');
    assert.ok(diagnostic.reasons.includes('runtime check required'));
  });

  await run('diagnostic marks superseded/retracted claims as do-not-use', () => {
    const diagnostic = createClaimDiagnostic(supersededClaim, { now });
    assert.equal(diagnostic.action, 'do_not_use');
    assert.equal(diagnostic.requiresVerification, true);
  });

  await run('source excerpts are opt-in and truncated', () => {
    const diagnostic = createClaimDiagnostic(activeClaim, { includeSourceExcerpts: true, maxExcerptChars: 12, now });
    assert.equal(diagnostic.sources[0].excerpt, 'CODE SESSIO…');
  });

  await run('inspectClaim reads a single claim from an explicit store only', () => {
    const store = new FakeClaimStore([activeClaim, runtimeClaim]);
    const diagnostic = inspectClaim(store, 'claim_active_project', { now });
    assert.equal(diagnostic.id, 'claim_active_project');
    assert.equal(diagnostic.agentId, 'trail-guide');
  });

  await run('inspectClaimWithResolvedSources does not resolve unless explicitly requested', async () => {
    const store = new FakeClaimStore([activeClaim]);
    let called = false;
    const diagnostic = await inspectClaimWithResolvedSources(store, 'claim_active_project', {
      now,
      resolver: () => { called = true; return { ok: true, content: 'source text' }; }
    });
    assert.equal(called, false);
    assert.equal(Object.hasOwn(diagnostic, 'resolvedSources'), false);
  });

  await run('resolved source content remains hidden unless explicitly requested', async () => {
    const store = new FakeClaimStore([activeClaim]);
    const diagnostic = await inspectClaimWithResolvedSources(store, 'claim_active_project', {
      now,
      resolveSources: true,
      resolver: () => ({ ok: true, sourceType: 'archive', content: 'full resolved source text', timestamp: now })
    });
    assert.equal(diagnostic.resolutionAttempted, true);
    assert.equal(diagnostic.resolvedSources[0].contentAvailable, true);
    assert.equal(Object.hasOwn(diagnostic.resolvedSources[0], 'content'), false);
  });

  await run('summarizeClaimStore returns compact diagnostic counts', () => {
    const store = new FakeClaimStore([activeClaim, runtimeClaim, supersededClaim]);
    const summary = summarizeClaimStore(store, { agentId: 'trail-guide' }, { now });
    assert.equal(summary.total, 3);
    assert.equal(summary.requiresVerification, 2);
    assert.equal(summary.byAction.verify_before_asserting, 1);
    assert.equal(summary.byAction.do_not_use, 1);
    assert.equal(summary.byAction.usable_with_qualification, 1);
  });

  writeReportAndExit();
}

async function run(name, fn) {
  try {
    await fn();
    results.push({ name, status: 'PASS', detail: 'ok' });
  } catch (err) {
    results.push({ name, status: 'FAIL', detail: err.message });
  }
}

function writeReportAndExit() {
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.length - pass;
  const lines = [];
  lines.push('# Claim Diagnostics Test Report');
  lines.push('');
  lines.push(`- PASS: ${pass}`);
  lines.push(`- FAIL: ${fail}`);
  lines.push(`- Total: ${results.length}`);
  lines.push('');
  lines.push('| Fixture | Status | Detail |');
  lines.push('|---|---:|---|');
  for (const result of results) lines.push(`| ${escapePipes(result.name)} | ${result.status} | ${escapePipes(result.detail || 'ok')} |`);
  lines.push('');

  const reportPath = path.join(__dirname, 'reports', 'claim-diagnostics.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

  console.log(`Claim diagnostics tests: PASS=${pass} FAIL=${fail}`);
  console.log(`Report: ${path.relative(process.cwd(), reportPath)}`);
  if (fail) {
    for (const r of results.filter((r) => r.status === 'FAIL')) console.error(`${r.name}: ${r.detail}`);
    process.exit(1);
  }
}

function escapePipes(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

class FakeClaimStore {
  constructor(claims) {
    this.claims = new Map(claims.map((claim) => [claim.id, claim]));
  }

  getClaim(id) {
    return this.claims.get(id) || null;
  }

  listClaims(filter = {}) {
    return [...this.claims.values()].filter((claim) => {
      if (filter.agentId && claim.agentId !== filter.agentId) return false;
      if (filter.kind && claim.kind !== filter.kind) return false;
      if (filter.status && claim.status !== filter.status) return false;
      return true;
    });
  }
}
