#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { createClaimRecord, CLAIM_KINDS, CLAIM_STATUSES } = require('../lib/claim-records');
const {
  reviewClaimStoreCandidates,
  normalizeStoredClaimCandidate,
  normalizeStoredClaimEvidence
} = require('../lib/claim-autonomy-review');

const now = '2026-05-07T15:00:00.000Z';
const results = [];

const projectClaim = createClaimRecord({
  id: 'claim_project_policy_target',
  agentId: 'trail-guide',
  threadId: 'build-7',
  kind: CLAIM_KINDS.PROJECT_STATE,
  status: CLAIM_STATUSES.VERIFY_REQUIRED,
  claim: 'Build 7 Slice 1 target includes `claim-autonomy-policy.js`.',
  sources: [{ handle: 'file:projects/build-7/nightshift/morning-synthesis-2026-05-07.md#L1-L40', role: 'evidence' }],
  metadata: {
    autonomyEvidence: {
      sourceResolutionStatus: 'resolved',
      verificationAssessment: 'strong_support',
      contradictionChecked: true,
      contradictionPresent: false,
      sourceType: 'project_artifact'
    }
  }
}, { now });

const userClaim = createClaimRecord({
  id: 'claim_user_sensitive_preference',
  agentId: 'trail-guide',
  threadId: 'main',
  kind: CLAIM_KINDS.USER_PREFERENCE,
  status: CLAIM_STATUSES.VERIFY_REQUIRED,
  claim: 'Prefers more direct guidance when overwhelmed.',
  sources: [{ handle: 'archive:2026-05-07:trail-guide:main#e0001', role: 'evidence' }],
  metadata: {
    autonomyEvidence: {
      sourceResolutionStatus: 'resolved',
      verificationAssessment: 'strong_support',
      contradictionChecked: true,
      contradictionPresent: false
    }
  }
}, { now });

const runtimeClaim = createClaimRecord({
  id: 'claim_runtime_loaded',
  agentId: 'trail-guide',
  threadId: 'ops',
  kind: CLAIM_KINDS.RUNTIME,
  status: CLAIM_STATUSES.VERIFY_REQUIRED,
  claim: 'continuity plugin is loaded.',
  sources: [{ handle: 'memory:ops#runtime-loaded', role: 'evidence' }]
}, { now });

async function main() {
  await run('normalizes stored claims into autonomy candidates', () => {
    const candidate = normalizeStoredClaimCandidate(projectClaim);
    assert.equal(candidate.id, 'claim_project_policy_target');
    assert.equal(candidate.category, 'project_fact');
    assert.deepEqual(candidate.sourceHandles, ['file:projects/build-7/nightshift/morning-synthesis-2026-05-07.md#L1-L40']);
    assert.equal(candidate.candidateMeta.source, 'claim_store');
  });

  await run('default stored-claim evidence is conservative and read-only', () => {
    const evidence = normalizeStoredClaimEvidence(runtimeClaim, {});
    assert.equal(evidence.sourceResolutionStatus, 'not_attempted');
    assert.equal(evidence.verificationAssessment, 'not_attempted');
    assert.equal(evidence.staleRuntimeWarning, true);
    assert.equal(evidence.contradictionChecked, false);
  });

  await run('reviews real claim-store records without mutation or prompt writes', async () => {
    const store = new FakeClaimStore([projectClaim, userClaim, runtimeClaim]);
    const review = await reviewClaimStoreCandidates({ claimStore: store, agentId: 'trail-guide', limit: 10 });

    assert.equal(store.listCalls.length, 1);
    assert.deepEqual(store.listCalls[0].statuses, ['verify_required', 'stale']);
    assert.equal(store.storeClaimCalls, 0);
    assert.equal(review.dryRun, true);
    assert.equal(review.mutationAttempted, false);
    assert.equal(review.promptInjectionEligibilityChanged, false);
    assert.equal(review.summary.total, 3);
    assert.equal(review.summary.mutationAttempts, 0);
    assert.equal(review.summary.promptEligibilityChanges, 0);

    const project = review.receipts.find((receipt) => receipt.claimId === 'claim_project_policy_target');
    assert.equal(project.policyDecision, 'auto_accept');
    assert.equal(project.eligibleForApply, true);

    const sensitive = review.receipts.find((receipt) => receipt.claimId === 'claim_user_sensitive_preference');
    assert.equal(sensitive.policyDecision, 'chris_review');
    assert.equal(sensitive.eligibleForApply, false);
    assert.ok(sensitive.reasonCodes.includes('auto_accept_blocked_by_sensitivity'));

    const runtime = review.receipts.find((receipt) => receipt.claimId === 'claim_runtime_loaded');
    assert.notEqual(runtime.policyDecision, 'auto_accept');
    assert.ok(runtime.reasonCodes.includes('runtime_state_stale_risk'));
  });

  await run('optional evidenceProvider can supply read-only evidence without store writes', async () => {
    const claim = createClaimRecord({
      id: 'claim_search_before_create',
      agentId: 'trail-guide',
      kind: CLAIM_KINDS.PROJECT_STATE,
      status: CLAIM_STATUSES.VERIFY_REQUIRED,
      claim: 'Ellis should search for existing files before creating replacements.',
      sources: [{ handle: 'memory:ops#search-before-create', role: 'evidence' }]
    }, { now });
    const store = new FakeClaimStore([claim]);
    const review = await reviewClaimStoreCandidates({
      claimStore: store,
      evidenceProvider: async () => ({
        sourceResolutionStatus: 'resolved',
        verificationAssessment: 'strong_support',
        contradictionChecked: true,
        contradictionPresent: false,
        sourceType: 'durable_operational_note'
      })
    });
    assert.equal(store.storeClaimCalls, 0);
    assert.equal(review.receipts[0].policyDecision, 'auto_accept');
  });

  writeReport();
}

class FakeClaimStore {
  constructor(claims = []) {
    this.claims = claims;
    this.listCalls = [];
    this.storeClaimCalls = 0;
  }
  listClaims(filter = {}) {
    this.listCalls.push(filter);
    return this.claims
      .filter((claim) => !filter.agentId || claim.agentId === filter.agentId)
      .filter((claim) => !filter.statuses?.length || filter.statuses.includes(claim.status))
      .filter((claim) => !filter.kinds?.length || filter.kinds.includes(claim.kind))
      .slice(0, filter.limit || this.claims.length);
  }
  storeClaim() {
    this.storeClaimCalls += 1;
    throw new Error('storeClaim should not be called by autonomy review');
  }
}

async function run(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error && error.stack ? error.stack : String(error) });
  }
}

function writeReport() {
  const report = renderReport(results);
  const reportPath = path.join(__dirname, 'reports', 'claim-autonomy-review.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, report);
  const failed = results.filter((result) => !result.ok);
  if (failed.length) {
    console.error(report);
    process.exitCode = 1;
  } else {
    console.log(report);
  }
}

function renderReport(items) {
  const passed = items.filter((item) => item.ok).length;
  const lines = ['# claim-autonomy-review test report', '', `Passed: ${passed}/${items.length}`, ''];
  for (const item of items) {
    lines.push(`- ${item.ok ? 'PASS' : 'FAIL'} ${item.name}`);
    if (!item.ok) lines.push(`  - ${String(item.error).split('\n').join('\n    ')}`);
  }
  return lines.join('\n');
}

main();
