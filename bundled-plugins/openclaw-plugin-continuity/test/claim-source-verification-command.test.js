#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const {
  runClaimSourceVerificationCommand,
  parseClaimSourceVerificationArgs,
  compareTextToSource
} = require('../lib/claim-source-verification-command');
const { CLAIM_KINDS, CLAIM_STATUSES, createClaimRecord } = require('../lib/claim-records');

const now = '2026-05-06T19:20:00.000Z';
const results = [];

const claim = createClaimRecord({
  id: 'claim_build5_verify_helper',
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

async function main() {
  await run('compare action resolves attached source and emits read-only guidance', async () => {
    const text = await runClaimSourceVerificationCommand(commandContext({
      args: 'compare --claim-id claim_build5_verify_helper --source-handle file:projects/build-5/README.md#L1-L4 --max-content-chars 120',
      resolverMap: {
        'file:projects/build-5/README.md#L1-L4': { ok: true, sourceType: 'file', content: 'Build 5 can resolve source content through an explicit read-only path for operators.' }
      }
    }));
    assert.match(text, /Claim Source Verification Helper — READ ONLY/);
    assert.match(text, /claim_build5_verify_helper \[project_state\/verify_required\]/);
    assert.match(text, /Resolution: resolved/);
    assert.match(text, /Assessment: source_contains_claim_text/);
    assert.match(text, /comparisonAttempted: yes/);
    assert.match(text, /verificationDecisionAttempted: no/);
    assert.match(text, /mutationAttempted: no/);
    assert.match(text, /promotionAttempted: no/);
    assert.match(text, /promptInjectionAttempted: no/);
  });

  await run('helper requires exact claim id and exact attached source handle', async () => {
    const missingId = parseClaimSourceVerificationArgs('compare --source-handle file:a.md#L1-L1');
    const missingHandle = parseClaimSourceVerificationArgs('compare --claim-id claim_a');
    assert.match(missingId.parseError, /requires --claim-id/);
    assert.match(missingHandle.parseError, /requires --source-handle/);

    let resolverCalled = false;
    const text = await runClaimSourceVerificationCommand(commandContext({
      args: 'compare --claim-id claim_build5_verify_helper --source-handle file:other.md#L1-L1',
      createResolver: () => async () => {
        resolverCalled = true;
        return { ok: true, content: 'should not resolve' };
      }
    }));
    assert.equal(resolverCalled, false);
    assert.match(text, /source handle is not attached to this claim/);
    assert.match(text, /sourceResolutionAttempted: no/);
    assert.match(text, /comparisonAttempted: no/);
  });

  await run('unresolved source returns bounded guidance without comparison', async () => {
    const text = await runClaimSourceVerificationCommand(commandContext({
      args: 'compare --claim-id claim_build5_verify_helper --source-handle file:projects/build-5/README.md#L1-L4',
      resolverMap: {
        'file:projects/build-5/README.md#L1-L4': { ok: false, error: 'file does not exist' }
      }
    }));
    assert.match(text, /Resolution: unresolved/);
    assert.match(text, /file does not exist/);
    assert.match(text, /sourceResolutionAttempted: yes/);
    assert.match(text, /comparisonAttempted: no/);
    assert.match(text, /do not treat the claim as verified/);
  });

  await run('low-overlap source blocks promotion guidance', () => {
    const comparison = compareTextToSource('Gateway is currently managed by LaunchAgent.', 'A recipe for sourdough starter uses flour and water.');
    assert.equal(comparison.assessment, 'source_does_not_show_enough_overlap');
    assert.equal(comparison.recommendation, 'do_not_promote_claim_from_this_source');
  });

  await run('command rejects mutation, promotion, consumption, and injection flags', async () => {
    const text = await runClaimSourceVerificationCommand(commandContext({
      args: 'compare --claim-id claim_build5_verify_helper --source-handle file:projects/build-5/README.md#L1-L4 --apply'
    }));
    assert.match(text, /--apply is not supported here/);
    assert.match(text, /read-only guidance/);
    assert.doesNotMatch(text, /Claim Source Verification Helper — READ ONLY/);
  });

  await run('command reports inert default when ClaimStore is unavailable', async () => {
    const text = await runClaimSourceVerificationCommand({
      args: 'compare --claim-id claim_build5_verify_helper --source-handle file:projects/build-5/README.md#L1-L4',
      getCurrentAgentId: () => 'trail-guide',
      getAgentState: () => ({ ensureStorage: async () => {} })
    });
    assert.match(text, /ClaimStore is not initialized/);
    assert.match(text, /Runtime defaults may still be inert/);
  });

  writeReportAndExit();
}

function commandContext({ args, resolverMap = {}, createResolver } = {}) {
  return {
    args,
    getCurrentAgentId: () => 'trail-guide',
    getAgentState: () => ({
      ensureStorage: async () => {},
      claimStore: new FakeClaimStore([claim])
    }),
    createResolver: createResolver || (() => async (sourceOrHandle) => {
      const handle = typeof sourceOrHandle === 'string' ? sourceOrHandle : sourceOrHandle.handle;
      return resolverMap[handle] || { ok: false, error: 'resolver fixture missing' };
    })
  };
}

class FakeClaimStore {
  constructor(claims = []) {
    this.claims = claims;
  }
  getClaim(id) {
    return this.claims.find((item) => item.id === id) || null;
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

function writeReportAndExit() {
  const pass = results.filter((result) => result.status === 'PASS').length;
  const fail = results.length - pass;
  const lines = [];
  lines.push('# Claim Source Verification Command Test Report');
  lines.push('');
  lines.push(`- PASS: ${pass}`);
  lines.push(`- FAIL: ${fail}`);
  lines.push(`- Total: ${results.length}`);
  lines.push('');
  lines.push('| Fixture | Status | Detail |');
  lines.push('|---|---:|---|');
  for (const result of results) lines.push(`| ${escapePipes(result.name)} | ${result.status} | ${escapePipes(result.detail)} |`);
  lines.push('');

  const reportPath = path.join(__dirname, 'reports', 'claim-source-verification-command.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

  console.log(`Claim source verification command tests: PASS=${pass} FAIL=${fail}`);
  console.log(`Report: ${path.relative(process.cwd(), reportPath)}`);
  if (fail > 0) process.exit(1);
}

function escapePipes(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
