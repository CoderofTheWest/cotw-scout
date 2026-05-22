#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { runClaimReviewDecisionCommand, parseClaimReviewDecisionArgs } = require('../lib/claim-review-decision-command');
const { CLAIM_KINDS, CLAIM_STATUSES, FRESHNESS_POLICIES, createClaimRecord } = require('../lib/claim-records');

const now = '2026-05-06T17:00:00.000Z';
const results = [];

const reviewClaim = createClaimRecord({
  id: 'claim_review_command_candidate',
  agentId: 'trail-guide',
  threadId: 'main',
  kind: CLAIM_KINDS.SUMMARY,
  claim: 'Build 4 review decisions require explicit operator evidence.',
  status: CLAIM_STATUSES.VERIFY_REQUIRED,
  stalenessPolicy: FRESHNESS_POLICIES.VERIFY_BEFORE_ASSERTING,
  sources: [{
    handle: 'archive:2026-05-06:trail-guide:main#e0501',
    role: 'origin',
    excerpt: 'review decision summary',
    quoteHash: 'hash_review_command_candidate'
  }]
}, { now });

const runtimeClaim = createClaimRecord({
  id: 'claim_review_command_runtime',
  agentId: 'trail-guide',
  threadId: 'ops',
  kind: CLAIM_KINDS.RUNTIME,
  claim: 'Gateway status came from an old handoff and must be rechecked.',
  status: CLAIM_STATUSES.VERIFY_REQUIRED,
  stalenessPolicy: FRESHNESS_POLICIES.RUNTIME_CHECK_REQUIRED,
  sources: [{
    handle: 'handoff:2026-05-06:main#L4-L4',
    role: 'origin',
    excerpt: 'Gateway was live.',
    quoteHash: 'hash_review_command_runtime'
  }]
}, { now });

async function main() {
  await run('parser requires explicit decision and claim id', () => {
    assert.match(parseClaimReviewDecisionArgs('').parseError, /Decision is required/);
    assert.match(parseClaimReviewDecisionArgs('verify').parseError, /--claim-id/);
    assert.equal(parseClaimReviewDecisionArgs('verify --claim-id claim_a --reason checked --source-handle tool:status#call1').decision, 'verify');
    assert.equal(parseClaimReviewDecisionArgs('--decision retract --claim claim_a --reason bad').decision, 'retract');
    assert.equal(parseClaimReviewDecisionArgs('verify --claim-id claim_a --apply').apply, true);
    assert.equal(parseClaimReviewDecisionArgs('verify --claim-id claim_a --apply --dry-run').apply, false);
  });

  await run('dry-run accept_verified plans promotion without mutating store', async () => {
    const store = new FakeClaimStore([reviewClaim]);
    const text = await runClaimReviewDecisionCommand(commandContext({
      store,
      args: 'accept_verified --claim-id claim_review_command_candidate --reason "operator checked archived evidence" --source-handle archive:2026-05-06:trail-guide:main#e0501 --accepted-staleness-policy evergreen'
    }));
    const unchanged = store.getClaim('claim_review_command_candidate');

    assert.match(text, /Claim Review Decision/);
    assert.match(text, /Dry run: yes/);
    assert.match(text, /Mutation attempted: no/);
    assert.match(text, /Promotion attempted: no/);
    assert.match(text, /Status: verify_required -> active/);
    assert.match(text, /Accepted staleness policy: evergreen/);
    assert.equal(unchanged.status, CLAIM_STATUSES.VERIFY_REQUIRED);
    assert.equal(store.stored.length, 0);
  });

  await run('apply accept_verified is explicit and records mutation through operator command', async () => {
    const store = new FakeClaimStore([reviewClaim]);
    const text = await runClaimReviewDecisionCommand(commandContext({
      store,
      args: 'accept_verified --claim-id claim_review_command_candidate --reason "operator checked archived evidence" --source-handle archive:2026-05-06:trail-guide:main#e0501 --accepted-staleness-policy evergreen --apply'
    }));
    const updated = store.getClaim('claim_review_command_candidate');

    assert.match(text, /Dry run: no/);
    assert.match(text, /Mutation attempted: yes/);
    assert.match(text, /Promotion attempted: yes/);
    assert.match(text, /Status: verify_required -> active/);
    assert.equal(updated.status, CLAIM_STATUSES.ACTIVE);
    assert.equal(updated.freshness.stalenessPolicy, FRESHNESS_POLICIES.EVERGREEN);
    assert.equal(updated.metadata.reviewDecisions[0].decision, 'accept_verified');
    assert.equal(updated.metadata.reviewDecisions[0].verificationEvidence.assessment, 'source_contains_claim_text');
    assert.equal(store.stored.length, 1);
  });

  await run('verify command updates verification timestamp but does not promote', async () => {
    const store = new FakeClaimStore([runtimeClaim]);
    const text = await runClaimReviewDecisionCommand(commandContext({
      store,
      args: 'verify --claim-id claim_review_command_runtime --reason "fresh status command checked" --source-handle tool:gateway_status#call1 --apply'
    }));
    const updated = store.getClaim('claim_review_command_runtime');

    assert.match(text, /Decision: verify/);
    assert.match(text, /Promotion attempted: no/);
    assert.match(text, /Status: verify_required -> verify_required/);
    assert.equal(updated.status, CLAIM_STATUSES.VERIFY_REQUIRED);
    assert.equal(updated.freshness.stalenessPolicy, FRESHNESS_POLICIES.RUNTIME_CHECK_REQUIRED);
    assert.ok(updated.freshness.lastVerifiedAt);
  });

  await run('command refuses source resolution and metadata display flags', async () => {
    const text = await runClaimReviewDecisionCommand(commandContext({
      args: 'verify --claim-id claim_review_command_runtime --resolve --metadata'
    }));
    assert.match(text, /Source resolution, excerpts, and metadata display are intentionally unavailable/);
  });

  await run('command reports inert default when ClaimStore is unavailable', async () => {
    const text = await runClaimReviewDecisionCommand({
      args: 'verify --claim-id claim_review_command_runtime --reason checked --source-handle tool:gateway_status#call1',
      getCurrentAgentId: () => 'trail-guide',
      getAgentState: () => ({ ensureStorage: async () => {} })
    });
    assert.match(text, /ClaimStore is not initialized/);
    assert.match(text, /Runtime defaults may still be inert/);
  });

  await run('command reports missing claim as a bounded operator failure without mutation', async () => {
    const store = new FakeClaimStore([reviewClaim]);
    const text = await runClaimReviewDecisionCommand(commandContext({
      store,
      args: 'verify --claim-id claim_missing_for_operator --reason "checked missing id" --source-handle tool:gateway_status#call1 --apply'
    }));
    assert.match(text, /Claim review decision failed: claim not found: claim_missing_for_operator/);
    assert.equal(store.stored.length, 0);
  });

  await run('command returns decision validation errors instead of mutating', async () => {
    const store = new FakeClaimStore([reviewClaim]);
    const text = await runClaimReviewDecisionCommand(commandContext({
      store,
      args: 'accept_verified --claim-id claim_review_command_candidate --reason "reviewed" --source-handle archive:2026-05-06:trail-guide:main#e0501 --apply'
    }));
    assert.match(text, /requires an acceptedStalenessPolicy/);
    assert.equal(store.stored.length, 0);
  });

  writeReportAndExit();
}

function commandContext({ args, store }) {
  const claimStore = store || new FakeClaimStore([reviewClaim, runtimeClaim]);
  return {
    args,
    getCurrentAgentId: () => 'trail-guide',
    getAgentState: () => ({
      ensureStorage: async () => {},
      claimStore
    }),
    createResolver: () => async (handle) => ({
      ok: true,
      sourceType: 'archive',
      content: handle === 'archive:2026-05-06:trail-guide:main#e0501'
        ? 'Build 4 review decisions require explicit operator evidence.'
        : 'unrelated source content',
      timestamp: now
    })
  };
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
  lines.push('# Claim Review Decision Command Test Report');
  lines.push('');
  lines.push(`- PASS: ${pass}`);
  lines.push(`- FAIL: ${fail}`);
  lines.push(`- Total: ${results.length}`);
  lines.push('');
  lines.push('| Fixture | Status | Detail |');
  lines.push('|---|---:|---|');
  for (const result of results) lines.push(`| ${escapePipes(result.name)} | ${result.status} | ${escapePipes(result.detail || 'ok')} |`);
  lines.push('');
  const reportPath = path.join(__dirname, 'reports', 'claim-review-decision-command.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  console.log(`Claim review decision command tests: PASS=${pass} FAIL=${fail}`);
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
  constructor(claims = []) {
    this.claims = new Map(claims.map((claim) => [claim.id, structuredClone(claim)]));
    this.stored = [];
    this.edges = [];
  }
  getClaim(id) {
    const claim = this.claims.get(id);
    return claim ? structuredClone(claim) : null;
  }
  storeClaim(claim) {
    this.claims.set(claim.id, structuredClone(claim));
    this.stored.push(structuredClone(claim));
  }
  storeEdge(edge) {
    this.edges.push(structuredClone(edge));
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
