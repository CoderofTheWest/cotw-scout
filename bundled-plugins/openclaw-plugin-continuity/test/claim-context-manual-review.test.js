#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { createClaimContextPacket } = require('../lib/claim-context');
const { createClaimContextManualReview, renderClaimContextManualReview } = require('../lib/claim-context-manual-review');
const { CLAIM_KINDS, FRESHNESS_POLICIES, createClaimRecord } = require('../lib/claim-records');

const now = '2026-05-05T23:00:00.000Z';
const results = [];

const stablePreference = createClaimRecord({
  id: 'claim_review_preference',
  agentId: 'trail-guide',
  threadId: 'main',
  kind: CLAIM_KINDS.USER_PREFERENCE,
  claim: 'Chris prefers direct code-mode help during build sessions.',
  sources: [{
    handle: 'archive:2026-05-05:trail-guide:main#e0200',
    role: 'evidence',
    excerpt: 'CODE SESSION CONTEXT: Help directly.',
    quoteHash: 'hash_review_preference'
  }]
}, { now });

const runtimeClaim = createClaimRecord({
  id: 'claim_review_runtime',
  agentId: 'trail-guide',
  threadId: 'ops',
  kind: CLAIM_KINDS.RUNTIME,
  claim: 'Gateway is currently running with a particular live state.',
  stalenessPolicy: FRESHNESS_POLICIES.VERIFY_BEFORE_ASSERTING,
  sources: [{
    handle: 'tool:session_review#call1',
    role: 'verification',
    excerpt: 'gateway status output',
    quoteHash: 'hash_review_runtime'
  }]
}, { now });

run('manual review refuses missing packet without leaking content', () => {
  const review = createClaimContextManualReview({});
  const report = renderClaimContextManualReview(review);
  assert.equal(review.decision, 'blocked_missing_packet');
  assert.equal(review.redacted, true);
  assert.equal(review.manualReviewPrepared, false);
  assert.equal(review.injectionReady, false);
  assert.equal(review.consumptionAttempted, false);
  assert.match(report, /Manual review prepared: no/);
  assert.doesNotMatch(report, /claim:/);
});

run('manual review refuses blocked preflight and stays redacted', () => {
  const packet = createClaimContextPacket([runtimeClaim], { limit: 10, includeSourceExcerpts: true });
  const review = createClaimContextManualReview({ packet, includeSourceExcerpts: true });
  const report = renderClaimContextManualReview(review);
  assert.equal(review.decision, 'blocked_by_preflight');
  assert.equal(review.redacted, true);
  assert.equal(review.manualReviewPrepared, false);
  assert.equal(review.injectionReady, false);
  assert.equal(review.consumptionAttempted, false);
  assert.match(review.blockers.join(','), /verification:claims_require_verification/);
  assert.doesNotMatch(report, /Gateway is currently running with a particular live state/);
  assert.doesNotMatch(report, /tool:session_review#call1/);
  assert.doesNotMatch(report, /gateway status output/);
});

run('manual review prepares clean packet for operator review without injection', () => {
  const packet = createClaimContextPacket([stablePreference], { limit: 10 });
  const review = createClaimContextManualReview({ packet });
  const report = renderClaimContextManualReview(review);
  assert.equal(review.decision, 'ready_for_operator_review');
  assert.equal(review.redacted, false);
  assert.equal(review.manualReviewPrepared, true);
  assert.equal(review.injectionReady, false);
  assert.equal(review.consumptionAttempted, false);
  assert.equal(review.verificationAttempted, false);
  assert.equal(review.mutationAttempted, false);
  assert.equal(review.promotionAttempted, false);
  assert.equal(review.renderedPromptContext, false);
  assert.match(report, /Chris prefers direct code-mode help during build sessions/);
  assert.match(report, /archive:2026-05-05:trail-guide:main#e0200/);
  assert.doesNotMatch(report, /CODE SESSION CONTEXT: Help directly/);
  assert.match(report, /do_not_inject_review_packet_into_agent_prompt/);
});

run('manual review includes source excerpts only by explicit opt-in', () => {
  const packet = createClaimContextPacket([stablePreference], { limit: 10, includeSourceExcerpts: true });
  const hidden = renderClaimContextManualReview(createClaimContextManualReview({ packet }));
  const included = renderClaimContextManualReview(createClaimContextManualReview({ packet, includeSourceExcerpts: true }));
  assert.doesNotMatch(hidden, /CODE SESSION CONTEXT: Help directly/);
  assert.match(included, /CODE SESSION CONTEXT: Help directly/);
});

writeReportAndExit();

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
  lines.push('# Claim Context Manual Review Test Report');
  lines.push('');
  lines.push(`- PASS: ${pass}`);
  lines.push(`- FAIL: ${fail}`);
  lines.push(`- Total: ${results.length}`);
  lines.push('');
  lines.push('| Fixture | Status | Detail |');
  lines.push('|---|---:|---|');
  for (const result of results) lines.push(`| ${escapePipes(result.name)} | ${result.status} | ${escapePipes(result.detail || 'ok')} |`);
  lines.push('');
  const reportPath = path.join(__dirname, 'reports', 'claim-context-manual-review.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  console.log(`Claim context manual review tests: PASS=${pass} FAIL=${fail}`);
  console.log(`Report: ${path.relative(process.cwd(), reportPath)}`);
  if (fail) {
    for (const r of results.filter((r) => r.status === 'FAIL')) console.error(`${r.name}: ${r.detail}`);
    process.exit(1);
  }
}

function escapePipes(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}
