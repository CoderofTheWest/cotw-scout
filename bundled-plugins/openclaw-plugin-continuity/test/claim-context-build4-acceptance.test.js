#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { createClaimContextPacket } = require('../lib/claim-context');
const { createClaimContextPreflight } = require('../lib/claim-context-preflight');
const { createClaimContextManualReview, renderClaimContextManualReview } = require('../lib/claim-context-manual-review');
const { createClaimFixtureSeed } = require('../lib/claim-fixture-seed');
const { createClaimReviewDecision } = require('../lib/claim-review-decision');
const { CLAIM_KINDS, CLAIM_STATUSES, FRESHNESS_POLICIES, createClaimRecord } = require('../lib/claim-records');

const now = '2026-05-06T16:00:00.000Z';
const results = [];

const reviewClaim = createClaimRecord({
  id: 'claim_build4_review_candidate',
  agentId: 'trail-guide',
  threadId: 'main',
  kind: CLAIM_KINDS.SUMMARY,
  claim: 'Build 4 added a manual review path before any continuity claim can be accepted.',
  status: CLAIM_STATUSES.VERIFY_REQUIRED,
  stalenessPolicy: FRESHNESS_POLICIES.VERIFY_BEFORE_ASSERTING,
  sources: [{
    handle: 'archive:2026-05-06:trail-guide:main#e0401',
    role: 'origin',
    excerpt: 'Build 4 review path summary.',
    quoteHash: 'hash_build4_review_candidate'
  }]
}, { now });

async function main() {
  await run('Build 4 fixture claims stay gated out of normal preview packets', () => {
    const store = new FakeClaimStore();
    const seed = createClaimFixtureSeed({
      claimStore: store,
      agentId: 'trail-guide',
      fixture: 'manual_review_clean_claim',
      claim: 'Fixture-backed review candidate for a clean manual packet.',
      sourceHandle: 'commit:fa5ba33#bundled-plugins/openclaw-plugin-continuity/lib/claim-context-manual-review.js',
      excerpt: 'manual review packets landed',
      reason: 'build4 acceptance fixture',
      apply: true
    }, { now });

    const seededClaim = store.getClaim(seed.claimId);
    const normalPacket = createClaimContextPacket([seededClaim], { limit: 10 });
    const explicitPacket = createClaimContextPacket([seededClaim], { limit: 10, includeFixtures: true });
    const explicitPreflight = createClaimContextPreflight({ packet: explicitPacket });
    const explicitReview = createClaimContextManualReview({ packet: explicitPacket });

    assert.equal(normalPacket.included, 0);
    assert.equal(normalPacket.excluded, 1);
    assert.equal(normalPacket.audit.excluded[0].action, 'exclude_do_not_use');
    assert.equal(explicitPacket.included, 1);
    assert.equal(explicitPreflight.decision, 'ready_for_manual_review');
    assert.equal(explicitReview.manualReviewPrepared, true);
    assert.equal(explicitReview.injectionReady, false);
    assert.equal(explicitReview.consumptionAttempted, false);
    assert.equal(explicitReview.verificationAttempted, false);
    assert.equal(explicitReview.mutationAttempted, false);
    assert.equal(explicitReview.promotionAttempted, false);
  });

  await run('manual review packets reveal claim text only after clean preflight and still do not authorize mutation', () => {
    const acceptedClaim = createClaimRecord({
      ...reviewClaim,
      id: 'claim_build4_clean_manual_review',
      status: CLAIM_STATUSES.ACTIVE,
      stalenessPolicy: FRESHNESS_POLICIES.EVERGREEN
    }, { now });
    const packet = createClaimContextPacket([acceptedClaim], { limit: 10, includeSourceExcerpts: false });
    const preflight = createClaimContextPreflight({ packet });
    const review = createClaimContextManualReview({ packet, preflight });
    const report = renderClaimContextManualReview(review);

    assert.equal(preflight.decision, 'ready_for_manual_review');
    assert.equal(review.manualReviewPrepared, true);
    assert.equal(review.redacted, false);
    assert.equal(review.items.length, 1);
    assert.match(report, /Build 4 added a manual review path/);
    assert.match(report, /archive:2026-05-06:trail-guide:main#e0401/);
    assert.doesNotMatch(report, /Build 4 review path summary/);
    assert.equal(review.injectionReady, false);
    assert.equal(review.consumptionAttempted, false);
    assert.equal(review.verificationAttempted, false);
    assert.equal(review.mutationAttempted, false);
    assert.equal(review.promotionAttempted, false);
  });

  await run('accept_verified is the only Build 4 path that promotes, and it requires apply plus evidence policy', () => {
    const store = new FakeClaimStore([reviewClaim]);
    const dryRun = createClaimReviewDecision({
      claimStore: store,
      agentId: 'trail-guide',
      claimId: 'claim_build4_review_candidate',
      decision: 'accept_verified',
      reason: 'operator reviewed archived evidence as stable build history',
      sourceHandle: 'archive:2026-05-06:trail-guide:main#e0401',
      acceptedStalenessPolicy: FRESHNESS_POLICIES.EVERGREEN,
      apply: false
    }, { now });
    const unchanged = store.getClaim('claim_build4_review_candidate');

    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.mutationAttempted, false);
    assert.equal(dryRun.promotionAttempted, false);
    assert.equal(dryRun.beforeStatus, CLAIM_STATUSES.VERIFY_REQUIRED);
    assert.equal(dryRun.afterStatus, CLAIM_STATUSES.ACTIVE);
    assert.equal(unchanged.status, CLAIM_STATUSES.VERIFY_REQUIRED);
    assert.equal(unchanged.freshness.stalenessPolicy, FRESHNESS_POLICIES.VERIFY_BEFORE_ASSERTING);

    const applied = createClaimReviewDecision({
      claimStore: store,
      agentId: 'trail-guide',
      claimId: 'claim_build4_review_candidate',
      decision: 'accept_verified',
      reason: 'operator reviewed archived evidence as stable build history',
      sourceHandle: 'archive:2026-05-06:trail-guide:main#e0401',
      acceptedStalenessPolicy: FRESHNESS_POLICIES.EVERGREEN,
      verificationEvidence: {
        sourceResolved: true,
        comparisonAttempted: true,
        assessment: 'source_contains_claim_text',
        coverage: 1,
        exactPhrase: true,
        sourceHandle: 'archive:2026-05-06:trail-guide:main#e0401',
        checkedAt: now
      },
      apply: true
    }, { now });
    const updated = store.getClaim('claim_build4_review_candidate');
    const packet = createClaimContextPacket([updated], { limit: 10 });
    const preflight = createClaimContextPreflight({ packet });

    assert.equal(applied.mutationAttempted, true);
    assert.equal(applied.promotionAttempted, true);
    assert.equal(updated.status, CLAIM_STATUSES.ACTIVE);
    assert.equal(updated.freshness.stalenessPolicy, FRESHNESS_POLICIES.EVERGREEN);
    assert.equal(updated.freshness.lastVerifiedAt, now);
    assert.equal(packet.included, 1);
    assert.equal(packet.requiresVerification, 0);
    assert.equal(preflight.decision, 'ready_for_manual_review');
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
  lines.push('# Claim Context Build 4 Acceptance Test Report');
  lines.push('');
  lines.push(`- PASS: ${pass}`);
  lines.push(`- FAIL: ${fail}`);
  lines.push(`- Total: ${results.length}`);
  lines.push('');
  lines.push('| Fixture | Status | Detail |');
  lines.push('|---|---:|---|');
  for (const result of results) lines.push(`| ${escapePipes(result.name)} | ${result.status} | ${escapePipes(result.detail || 'ok')} |`);
  lines.push('');
  const reportPath = path.join(__dirname, 'reports', 'claim-context-build4-acceptance.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  console.log(`Claim context Build 4 acceptance tests: PASS=${pass} FAIL=${fail}`);
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
  listClaims(filter = {}) {
    let claims = Array.from(this.claims.values()).map((claim) => structuredClone(claim));
    if (filter.agentId) claims = claims.filter((claim) => claim.agentId === filter.agentId);
    if (filter.status) claims = claims.filter((claim) => claim.status === filter.status);
    if (filter.kind) claims = claims.filter((claim) => claim.kind === filter.kind);
    if (filter.threadId) claims = claims.filter((claim) => claim.threadId === filter.threadId);
    return claims.slice(0, filter.limit || claims.length);
  }
}

main();
