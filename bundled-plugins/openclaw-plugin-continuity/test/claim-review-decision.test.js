#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { createClaimRecord, CLAIM_KINDS, FRESHNESS_POLICIES, CLAIM_STATUSES } = require('../lib/claim-records');
const { createClaimReviewDecision, renderClaimReviewDecision } = require('../lib/claim-review-decision');

const now = '2026-05-05T23:45:00.000Z';
const results = [];

const runtimeClaim = createClaimRecord({
  id: 'claim_runtime_needs_review',
  agentId: 'trail-guide',
  threadId: 'ops',
  kind: CLAIM_KINDS.RUNTIME,
  claim: 'Gateway is currently in a live runtime state.',
  stalenessPolicy: FRESHNESS_POLICIES.VERIFY_BEFORE_ASSERTING,
  sources: [{
    handle: 'handoff:2026-05-05:main#L1-L1',
    role: 'evidence',
    excerpt: 'Gateway live.',
    quoteHash: 'hash_runtime_review'
  }]
}, { now: '2026-05-05T23:40:00.000Z' });

const replacementClaim = createClaimRecord({
  id: 'claim_runtime_replacement',
  agentId: 'trail-guide',
  threadId: 'ops',
  kind: CLAIM_KINDS.RUNTIME,
  claim: 'Gateway state should be checked through a live tool call.',
  stalenessPolicy: FRESHNESS_POLICIES.RUNTIME_CHECK_REQUIRED,
  sources: [{
    handle: 'tool:session_review#call2',
    role: 'verification',
    excerpt: 'live status command output',
    quoteHash: 'hash_runtime_replacement'
  }]
}, { now: '2026-05-05T23:41:00.000Z' });

const digestSummaryClaim = createClaimRecord({
  id: 'claim_digest_summary_needs_acceptance',
  agentId: 'trail-guide',
  threadId: 'main',
  kind: CLAIM_KINDS.SUMMARY,
  claim: 'Archived summary says Patch 8 added read-only diagnostics.',
  status: CLAIM_STATUSES.VERIFY_REQUIRED,
  stalenessPolicy: FRESHNESS_POLICIES.VERIFY_BEFORE_ASSERTING,
  sources: [{
    handle: 'digest:main#v1:summary_summary_trail-guide_2026-05-05_1777991491599_0',
    role: 'origin',
    excerpt: 'Patch 8 added read-only diagnostics.',
    quoteHash: 'hash_digest_summary'
  }],
  metadata: { candidateOnly: true }
}, { now: '2026-05-05T23:42:00.000Z' });

function main() {
  run('dry-run verify records no mutation and does not promote unsafe claims', () => {
    const store = new FakeClaimStore([runtimeClaim]);
    const result = createClaimReviewDecision({
      claimStore: store,
      agentId: 'trail-guide',
      claimId: 'claim_runtime_needs_review',
      decision: 'verify',
      reason: 'checked current status separately',
      sourceHandle: 'tool:session_review#call1',
      apply: false
    }, { now });
    const report = renderClaimReviewDecision(result);

    assert.equal(result.dryRun, true);
    assert.equal(result.mutationAttempted, false);
    assert.equal(result.promotionAttempted, false);
    assert.equal(result.beforeStatus, CLAIM_STATUSES.VERIFY_REQUIRED);
    assert.equal(result.afterStatus, CLAIM_STATUSES.VERIFY_REQUIRED);
    assert.equal(result.beforeStalenessPolicy, FRESHNESS_POLICIES.VERIFY_BEFORE_ASSERTING);
    assert.equal(result.afterStalenessPolicy, FRESHNESS_POLICIES.VERIFY_BEFORE_ASSERTING);
    assert.equal(store.stored.length, 0);
    assert.match(report, /Dry run: yes/);
    assert.match(report, /does not promote claims to active/);
  });

  run('apply verify updates lastVerifiedAt but preserves staleness policy', () => {
    const store = new FakeClaimStore([runtimeClaim]);
    const result = createClaimReviewDecision({
      claimStore: store,
      agentId: 'trail-guide',
      claimId: 'claim_runtime_needs_review',
      decision: 'verify',
      reason: 'live status command checked',
      sourceHandle: 'tool:session_review#call1',
      apply: true
    }, { now });
    const updated = store.getClaim('claim_runtime_needs_review');

    assert.equal(result.mutationAttempted, true);
    assert.equal(result.promotionAttempted, false);
    assert.equal(updated.status, CLAIM_STATUSES.VERIFY_REQUIRED);
    assert.equal(updated.freshness.lastVerifiedAt, now);
    assert.equal(updated.freshness.stalenessPolicy, FRESHNESS_POLICIES.VERIFY_BEFORE_ASSERTING);
    assert.equal(updated.metadata.reviewDecisions.length, 1);
    assert.equal(updated.metadata.reviewDecisions[0].decision, 'verify');
  });

  run('dry-run accept_verified plans activation without mutation', () => {
    const store = new FakeClaimStore([digestSummaryClaim]);
    const result = createClaimReviewDecision({
      claimStore: store,
      agentId: 'trail-guide',
      claimId: 'claim_digest_summary_needs_acceptance',
      decision: 'accept_verified',
      reason: 'operator reviewed digest-backed evidence as historical summary',
      sourceHandle: 'digest:main#v1:summary_summary_trail-guide_2026-05-05_1777991491599_0',
      acceptedStalenessPolicy: FRESHNESS_POLICIES.EVERGREEN,
      apply: false
    }, { now });

    assert.equal(result.dryRun, true);
    assert.equal(result.mutationAttempted, false);
    assert.equal(result.promotionAttempted, false);
    assert.equal(result.beforeStatus, CLAIM_STATUSES.VERIFY_REQUIRED);
    assert.equal(result.afterStatus, CLAIM_STATUSES.ACTIVE);
    assert.equal(result.afterStalenessPolicy, FRESHNESS_POLICIES.EVERGREEN);
    assert.equal(store.stored.length, 0);
  });

  run('apply accept_verified activates claim with explicit policy and verification source', () => {
    const store = new FakeClaimStore([digestSummaryClaim]);
    const result = createClaimReviewDecision({
      claimStore: store,
      agentId: 'trail-guide',
      claimId: 'claim_digest_summary_needs_acceptance',
      decision: 'accept_verified',
      reason: 'operator reviewed digest-backed evidence as historical summary',
      sourceHandle: 'archive:2026-05-05:trail-guide:main#e0015',
      acceptedStalenessPolicy: FRESHNESS_POLICIES.EVERGREEN,
      verificationEvidence: {
        sourceResolved: true,
        comparisonAttempted: true,
        assessment: 'source_contains_claim_text',
        coverage: 1,
        exactPhrase: true,
        sourceHandle: 'archive:2026-05-05:trail-guide:main#e0015',
        checkedAt: now
      },
      apply: true
    }, { now });
    const updated = store.getClaim('claim_digest_summary_needs_acceptance');

    assert.equal(result.mutationAttempted, true);
    assert.equal(result.promotionAttempted, true);
    assert.equal(updated.status, CLAIM_STATUSES.ACTIVE);
    assert.equal(updated.freshness.lastVerifiedAt, now);
    assert.equal(updated.freshness.stalenessPolicy, FRESHNESS_POLICIES.EVERGREEN);
    assert.equal(updated.sources.some((source) => source.handle === 'archive:2026-05-05:trail-guide:main#e0015' && source.role === 'verification'), true);
    assert.equal(updated.metadata.reviewDecisions[0].decision, 'accept_verified');
    assert.equal(updated.metadata.candidateOnly, false);
    assert.equal(updated.metadata.acceptedVerifiedAt, now);
    assert.equal(updated.metadata.reviewDecisions[0].verificationEvidence.assessment, 'source_contains_claim_text');
  });

  run('accept_verified requires source evidence and explicit usable staleness policy', () => {
    const store = new FakeClaimStore([digestSummaryClaim]);
    assert.throws(() => createClaimReviewDecision({
      claimStore: store,
      agentId: 'trail-guide',
      claimId: 'claim_digest_summary_needs_acceptance',
      decision: 'accept_verified',
      reason: 'reviewed',
      acceptedStalenessPolicy: FRESHNESS_POLICIES.EVERGREEN,
      apply: true
    }, { now }), /accept_verified decision requires a sourceHandle/);
    assert.throws(() => createClaimReviewDecision({
      claimStore: store,
      agentId: 'trail-guide',
      claimId: 'claim_digest_summary_needs_acceptance',
      decision: 'accept_verified',
      reason: 'reviewed',
      sourceHandle: 'archive:2026-05-05:trail-guide:main#e0015',
      apply: true
    }, { now }), /requires an acceptedStalenessPolicy/);
    assert.throws(() => createClaimReviewDecision({
      claimStore: store,
      agentId: 'trail-guide',
      claimId: 'claim_digest_summary_needs_acceptance',
      decision: 'accept_verified',
      reason: 'reviewed',
      sourceHandle: 'archive:2026-05-05:trail-guide:main#e0015',
      acceptedStalenessPolicy: FRESHNESS_POLICIES.VERIFY_BEFORE_ASSERTING,
      apply: true
    }, { now }), /acceptedStalenessPolicy must be one of/);
  });

  run('apply retract normalizes persisted ClaimStore sources before writing', () => {
    const storedShape = {
      ...runtimeClaim,
      sources: runtimeClaim.sources.map(({ valid, errors, ...source }) => source)
    };
    const store = new FakeClaimStore([storedShape]);
    createClaimReviewDecision({
      claimStore: store,
      agentId: 'trail-guide',
      claimId: 'claim_runtime_needs_review',
      decision: 'retract',
      reason: 'handoff fragment is not usable evidence',
      apply: true
    }, { now });
    const updated = store.getClaim('claim_runtime_needs_review');

    assert.equal(updated.status, CLAIM_STATUSES.RETRACTED);
    assert.equal(updated.sources[0].valid, true);
    assert.deepEqual(updated.sources[0].errors, []);
  });

  run('apply supersede marks old claim superseded and records edge when replacement is named', () => {
    const store = new FakeClaimStore([runtimeClaim, replacementClaim]);
    const result = createClaimReviewDecision({
      claimStore: store,
      agentId: 'trail-guide',
      claimId: 'claim_runtime_needs_review',
      decision: 'supersede',
      reason: 'live verification must replace handoff-derived runtime state',
      sourceHandle: 'tool:session_review#call2',
      supersededBy: 'claim_runtime_replacement',
      apply: true
    }, { now });
    const updated = store.getClaim('claim_runtime_needs_review');

    assert.equal(result.afterStatus, CLAIM_STATUSES.SUPERSEDED);
    assert.equal(updated.status, CLAIM_STATUSES.SUPERSEDED);
    assert.equal(store.edges.length, 1);
    assert.equal(store.edges[0].fromClaimId, 'claim_runtime_replacement');
    assert.equal(store.edges[0].toClaimId, 'claim_runtime_needs_review');
    assert.equal(store.edges[0].relation, 'supersedes');
  });

  run('review decisions require explicit evidence boundaries for verify/supersede', () => {
    const store = new FakeClaimStore([runtimeClaim]);
    assert.throws(() => createClaimReviewDecision({
      claimStore: store,
      agentId: 'trail-guide',
      claimId: 'claim_runtime_needs_review',
      decision: 'verify',
      reason: 'checked',
      apply: true
    }, { now }), /verify decision requires a sourceHandle/);
    assert.throws(() => createClaimReviewDecision({
      claimStore: store,
      agentId: 'trail-guide',
      claimId: 'claim_runtime_needs_review',
      decision: 'supersede',
      sourceHandle: 'tool:session_review#call2',
      apply: true
    }, { now }), /requires a reason/);
  });

  writeReportAndExit();
}

function run(name, fn) {
  try {
    fn();
    results.push({ name, status: 'PASS', detail: 'ok' });
  } catch (err) {
    results.push({ name, status: 'FAIL', detail: err.message });
  }
}

function writeReportAndExit() {
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.length - pass;
  const lines = [];
  lines.push('# Claim Review Decision Test Report');
  lines.push('');
  lines.push(`- PASS: ${pass}`);
  lines.push(`- FAIL: ${fail}`);
  lines.push(`- Total: ${results.length}`);
  lines.push('');
  lines.push('| Fixture | Status | Detail |');
  lines.push('|---|---:|---|');
  for (const result of results) lines.push(`| ${escapePipes(result.name)} | ${result.status} | ${escapePipes(result.detail || 'ok')} |`);
  lines.push('');

  const reportPath = path.join(__dirname, 'reports', 'claim-review-decision.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

  console.log(`Claim review decision tests: PASS=${pass} FAIL=${fail}`);
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
    this.claims = new Map(claims.map((claim) => [claim.id, clone(claim)]));
    this.stored = [];
    this.edges = [];
  }

  getClaim(id) {
    const claim = this.claims.get(id);
    return claim ? clone(claim) : null;
  }

  storeClaim(claim) {
    this.stored.push(clone(claim));
    this.claims.set(claim.id, clone(claim));
    return claim;
  }

  storeEdge(edge) {
    this.edges.push(clone(edge));
    return edge;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

main();
