#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { CLAIM_KINDS, CLAIM_STATUSES, createClaimRecord } = require('../lib/claim-records');
const {
  approvalString,
  createAutonomyReviewDecisionApply,
  createAutonomyReviewDecisionRollback,
  renderAutonomyReviewDecisionApply,
  renderAutonomyReviewDecisionRollback
} = require('../lib/claim-autonomy-review-decision-apply');

const now = '2026-05-07T19:30:00.000Z';
const results = [];

const summaryClaim = createClaimRecord({
  id: 'backfill_summary_test_archive',
  agentId: 'trail-guide',
  threadId: 'main',
  kind: CLAIM_KINDS.SUMMARY,
  claim: 'Archived continuity summary points at a procedural open question.',
  status: CLAIM_STATUSES.VERIFY_REQUIRED,
  confidence: 0.62,
  sources: [{ handle: 'digest:main#v1:summary_test', role: 'origin', quoteHash: 'hash_summary' }],
  metadata: { backfill: true, candidateOnly: false }
}, { now });

const interpretationClaim = createClaimRecord({
  id: 'hypothesis_candidate_test_hold',
  agentId: 'trail-guide',
  threadId: 'main',
  kind: CLAIM_KINDS.INTERPRETATION,
  claim: 'This may become a useful hypothesis, but it is not verified fact.',
  status: CLAIM_STATUSES.VERIFY_REQUIRED,
  confidence: 0.55,
  sources: [{ handle: 'archive:2026-05-07:trail-guide:main#e0010', role: 'origin', quoteHash: 'hash_hypothesis' }]
}, { now });

const activeClaim = createClaimRecord({
  id: 'active_claim_refuse_test',
  agentId: 'trail-guide',
  threadId: 'main',
  kind: CLAIM_KINDS.PROJECT_STATE,
  claim: 'A stable active project fact should not be touched by this experiment.',
  status: CLAIM_STATUSES.ACTIVE,
  sources: [{ handle: 'commit:local#abc123', role: 'evidence', quoteHash: 'hash_active' }]
}, { now });

function main() {
  run('dry-run renders exact approval string and does not mutate', () => {
    const store = new FakeClaimStore([summaryClaim]);
    const result = createAutonomyReviewDecisionApply({
      claimStore: store,
      agentId: 'trail-guide',
      claimId: 'backfill_summary_test_archive',
      decision: 'archive_open_question',
      expectedStatus: CLAIM_STATUSES.VERIFY_REQUIRED,
      reason: 'first low-risk write-through experiment candidate'
    }, { now });

    assert.equal(result.dryRun, true);
    assert.equal(result.mutationAttempted, false);
    assert.equal(result.promptInjectionEligibilityChanged, false);
    assert.equal(result.authorizationMode, 'dry_run');
    assert.equal(result.requiredApproval, 'approve:backfill_summary_test_archive:archive_open_question:verify_required');
    assert.equal(result.afterPreview.afterStatus, CLAIM_STATUSES.RETRACTED);
    assert.equal(store.storeCalls.length, 0);

    const rendered = renderAutonomyReviewDecisionApply(result);
    assert.match(rendered, /Dry run: yes/);
    assert.match(rendered, /approve:backfill_summary_test_archive:archive_open_question:verify_required/);
    assert.match(rendered, /does not promote claims to active truth/);
  });

  run('low-risk apply proceeds autonomously without operator approval', () => {
    const persistedSummaryClaim = clone(summaryClaim);
    persistedSummaryClaim.sources = persistedSummaryClaim.sources.map(({ valid, ...source }) => source);
    const store = new FakeClaimStore([persistedSummaryClaim]);
    const result = createAutonomyReviewDecisionApply({
      claimStore: store,
      agentId: 'trail-guide',
      claimId: 'backfill_summary_test_archive',
      decision: 'archive_open_question',
      expectedStatus: CLAIM_STATUSES.VERIFY_REQUIRED,
      reason: 'autonomous low-risk archive of an open question',
      apply: true
    }, { now });

    assert.equal(result.dryRun, false);
    assert.equal(result.mutationAttempted, true);
    assert.equal(result.authorizationMode, 'autonomous_low_risk');
    assert.equal(result.operatorApprovalRequired, false);
    assert.equal(store.storeCalls.length, 2);
    assert.equal(store.getClaim('backfill_summary_test_archive').status, CLAIM_STATUSES.RETRACTED);
  });

  run('apply archive_open_question writes before and after receipts only for exact payload', () => {
    const persistedSummaryClaim = clone(summaryClaim);
    persistedSummaryClaim.sources = persistedSummaryClaim.sources.map(({ valid, ...source }) => source);
    const store = new FakeClaimStore([persistedSummaryClaim]);
    const result = createAutonomyReviewDecisionApply({
      claimStore: store,
      agentId: 'trail-guide',
      claimId: 'backfill_summary_test_archive',
      decision: 'archive_open_question',
      expectedStatus: CLAIM_STATUSES.VERIFY_REQUIRED,
      reason: 'operator approved archiving this open question',
      apply: true,
      operatorApproval: approvalString({ claimId: 'backfill_summary_test_archive', decision: 'archive_open_question', expectedStatus: CLAIM_STATUSES.VERIFY_REQUIRED })
    }, { now });

    assert.equal(result.dryRun, false);
    assert.equal(result.mutationAttempted, true);
    assert.equal(result.promptInjectionEligibilityChanged, false);
    assert.equal(result.authorizationMode, 'operator_approved');
    assert.equal(result.beforeStatus, CLAIM_STATUSES.VERIFY_REQUIRED);
    assert.equal(result.afterStatus, CLAIM_STATUSES.RETRACTED);
    assert.equal(store.storeCalls.length, 2);

    const updated = store.getClaim('backfill_summary_test_archive');
    assert.equal(updated.status, CLAIM_STATUSES.RETRACTED);
    assert.equal(updated.metadata.archivedOpenQuestion, true);
    assert.equal(updated.metadata.autonomyApplyReceipts.length, 2);
    assert.equal(updated.metadata.autonomyApplyReceipts[0].phase, 'before');
    assert.equal(updated.metadata.autonomyApplyReceipts[0].mutationAttempted, false);
    assert.equal(updated.metadata.autonomyApplyReceipts[0].rollback.status, CLAIM_STATUSES.VERIFY_REQUIRED);
    assert.equal(updated.metadata.autonomyApplyReceipts[1].phase, 'after');
    assert.equal(updated.metadata.autonomyApplyReceipts[1].mutationAttempted, true);
    assert.equal(updated.sources[0].handle, summaryClaim.sources[0].handle);
    assert.equal(updated.sources[0].valid, true);
  });

  run('rollback_review_decision restores from before receipt and appends rollback receipt', () => {
    const store = new FakeClaimStore([summaryClaim]);
    const applied = createAutonomyReviewDecisionApply({
      claimStore: store,
      agentId: 'trail-guide',
      claimId: 'backfill_summary_test_archive',
      decision: 'archive_open_question',
      expectedStatus: CLAIM_STATUSES.VERIFY_REQUIRED,
      reason: 'autonomous low-risk archive before rollback test',
      apply: true
    }, { now });

    assert.equal(applied.afterStatus, CLAIM_STATUSES.RETRACTED);
    const rolled = createAutonomyReviewDecisionRollback({
      claimStore: store,
      agentId: 'trail-guide',
      claimId: 'backfill_summary_test_archive',
      reason: 'operator requested rollback of autonomous archive',
      apply: true
    }, { now: '2026-05-07T19:35:00.000Z' });

    assert.equal(rolled.dryRun, false);
    assert.equal(rolled.mutationAttempted, true);
    assert.equal(rolled.beforeStatus, CLAIM_STATUSES.RETRACTED);
    assert.equal(rolled.afterStatus, CLAIM_STATUSES.VERIFY_REQUIRED);
    const updated = store.getClaim('backfill_summary_test_archive');
    assert.equal(updated.status, CLAIM_STATUSES.VERIFY_REQUIRED);
    assert.equal(updated.metadata.backfill, true);
    assert.equal(updated.metadata.archivedOpenQuestion, undefined);
    assert.equal(updated.metadata.autonomyApplyReceipts.length, 3);
    assert.equal(updated.metadata.autonomyApplyReceipts[2].phase, 'rollback');

    const rendered = renderAutonomyReviewDecisionRollback(rolled);
    assert.match(rendered, /Claim Autonomy Review Rollback/);
    assert.match(rendered, /Mutation attempted: yes/);
  });

  run('hold_as_hypothesis keeps claim non-active and candidate-only', () => {
    const store = new FakeClaimStore([interpretationClaim]);
    const result = createAutonomyReviewDecisionApply({
      claimStore: store,
      agentId: 'trail-guide',
      claimId: 'hypothesis_candidate_test_hold',
      decision: 'hold_as_hypothesis',
      expectedStatus: CLAIM_STATUSES.VERIFY_REQUIRED,
      reason: 'keep as hypothesis only',
      apply: true,
      operatorApproval: approvalString({ claimId: 'hypothesis_candidate_test_hold', decision: 'hold_as_hypothesis', expectedStatus: CLAIM_STATUSES.VERIFY_REQUIRED })
    }, { now });

    assert.equal(result.mutationAttempted, true);
    assert.equal(result.afterStatus, CLAIM_STATUSES.VERIFY_REQUIRED);
    const updated = store.getClaim('hypothesis_candidate_test_hold');
    assert.equal(updated.status, CLAIM_STATUSES.VERIFY_REQUIRED);
    assert.equal(updated.metadata.candidateOnly, true);
    assert.equal(updated.metadata.hypothesisOnly, true);
    assert.notEqual(updated.status, CLAIM_STATUSES.ACTIVE);
  });

  run('active claims are refused even with exact approval', () => {
    const store = new FakeClaimStore([activeClaim]);
    const result = createAutonomyReviewDecisionApply({
      claimStore: store,
      agentId: 'trail-guide',
      claimId: 'active_claim_refuse_test',
      decision: 'archive_open_question',
      expectedStatus: CLAIM_STATUSES.ACTIVE,
      reason: 'should refuse active claim mutation',
      apply: true,
      operatorApproval: approvalString({ claimId: 'active_claim_refuse_test', decision: 'archive_open_question', expectedStatus: CLAIM_STATUSES.ACTIVE })
    }, { now });

    assert.equal(result.mutationAttempted, false);
    assert.ok(result.blockers.includes('current_status_not_apply_target'));
    assert.ok(result.blockers.includes('active_claim_promotion_or_mutation_refused'));
    assert.equal(store.storeCalls.length, 0);
  });

  writeReport();
}

function run(name, fn) {
  try {
    fn();
    results.push({ name, status: 'PASS', detail: 'ok' });
  } catch (err) {
    results.push({ name, status: 'FAIL', detail: err.stack || err.message });
  }
}

function writeReport() {
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.length - pass;
  const lines = [];
  lines.push('# Claim Autonomy Review Decision Apply Test Report');
  lines.push('');
  lines.push(`- PASS: ${pass}`);
  lines.push(`- FAIL: ${fail}`);
  lines.push(`- Total: ${results.length}`);
  lines.push('');
  lines.push('| Fixture | Status | Detail |');
  lines.push('|---|---:|---|');
  for (const result of results) lines.push(`| ${escapePipes(result.name)} | ${result.status} | ${escapePipes(result.detail || 'ok')} |`);
  lines.push('');

  const reportPath = path.join(__dirname, 'reports', 'claim-autonomy-review-decision-apply.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

  console.log(`Claim autonomy review decision apply tests: PASS=${pass} FAIL=${fail}`);
  console.log(`Report: ${path.relative(process.cwd(), reportPath)}`);
  if (fail) process.exit(1);
}

function escapePipes(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

class FakeClaimStore {
  constructor(claims = []) {
    this.claims = new Map(claims.map((claim) => [claim.id, clone(claim)]));
    this.storeCalls = [];
  }

  getClaim(id) {
    return this.claims.has(id) ? clone(this.claims.get(id)) : null;
  }

  storeClaim(claim) {
    this.storeCalls.push(clone(claim));
    this.claims.set(claim.id, clone(claim));
    return claim;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

main();
