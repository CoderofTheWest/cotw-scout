#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { createClaimContextPacket } = require('../lib/claim-context');
const { createClaimConsumptionTrialPlan, renderClaimConsumptionTrialPlan } = require('../lib/claim-context-trial');
const { CLAIM_KINDS, FRESHNESS_POLICIES, createClaimRecord } = require('../lib/claim-records');

const now = '2026-05-05T20:00:00.000Z';
const results = [];

const stablePreference = createClaimRecord({
  id: 'claim_user_pref_direct',
  agentId: 'trail-guide',
  threadId: 'main',
  kind: CLAIM_KINDS.USER_PREFERENCE,
  claim: 'Chris prefers direct code-mode help during build sessions.',
  sources: [{
    handle: 'archive:2026-05-05:trail-guide:main#e0100',
    role: 'evidence',
    excerpt: 'CODE SESSION CONTEXT: Help directly.',
    quoteHash: 'hash_pref'
  }]
}, { now });

const runtimeClaim = createClaimRecord({
  id: 'claim_runtime_gateway_mode',
  agentId: 'trail-guide',
  threadId: 'ops',
  kind: CLAIM_KINDS.RUNTIME,
  claim: 'Gateway is currently running under LaunchAgent ownership.',
  stalenessPolicy: FRESHNESS_POLICIES.VERIFY_BEFORE_ASSERTING,
  sources: [{
    handle: 'tool:session_abc#call7',
    role: 'verification',
    excerpt: 'gateway status output',
    quoteHash: 'hash_runtime'
  }]
}, { now });

run('trial planner refuses missing audit instead of inferring readiness', () => {
  const plan = createClaimConsumptionTrialPlan({});
  assert.equal(plan.decision, 'refused_missing_audit');
  assert.equal(plan.injectionReady, false);
  assert.equal(plan.consumptionAttempted, false);
  assert.match(plan.recommendations.join(','), /run_claim_context_preview_audit_before_consumption_trial_review/);
});

run('trial planner refuses review-required packet with redacted recommendations', () => {
  const packet = createClaimContextPacket([runtimeClaim], { limit: 8 });
  const plan = createClaimConsumptionTrialPlan({ packet });
  assert.equal(plan.decision, 'refused_review_required');
  assert.equal(plan.verdict, 'review_required');
  assert.equal(plan.injectionReady, false);
  assert.equal(plan.sourceResolutionAttempted, false);
  assert.equal(plan.mutationAttempted, false);
  assert.match(plan.issues.join(','), /all_selected_claims_require_verification/);
  assert.match(plan.recommendations.join(','), /verify_or_supersede_selected_claims_before_consumption_trial/);
  const report = renderClaimConsumptionTrialPlan(plan);
  assert.match(report, /Decision: refused_review_required/);
  assert.doesNotMatch(report, /Gateway is currently running under LaunchAgent ownership/);
  assert.doesNotMatch(report, /tool:session_abc#call7/);
  assert.doesNotMatch(report, /gateway status output/);
});

run('trial planner marks clean packet only eligible for manual review, not injection', () => {
  const packet = createClaimContextPacket([stablePreference], { limit: 8 });
  const plan = createClaimConsumptionTrialPlan({ packet });
  assert.equal(plan.decision, 'eligible_for_manual_review');
  assert.equal(plan.verdict, 'clean');
  assert.equal(plan.injectionReady, false);
  assert.equal(plan.consumptionAttempted, false);
  assert.equal(plan.sourceResolutionAttempted, false);
  assert.equal(plan.mutationAttempted, false);
  assert.match(plan.recommendations.join(','), /eligible_for_manual_consumption_trial_review_without_enabling_injection/);
  const report = renderClaimConsumptionTrialPlan(plan);
  assert.match(report, /Injection ready: no/);
  assert.match(report, /Consumption attempted: no/);
  assert.doesNotMatch(report, /Chris prefers direct code-mode help/);
  assert.doesNotMatch(report, /archive:2026-05-05:trail-guide:main#e0100/);
});

run('trial planner accepts preview-shaped input without using rendered context', () => {
  const packet = createClaimContextPacket([stablePreference], { includeSourceExcerpts: true });
  const preview = {
    audit: packet.audit,
    rendered: 'SHOULD NOT APPEAR: CODE SESSION CONTEXT: Help directly.'
  };
  const plan = createClaimConsumptionTrialPlan({ preview });
  const report = renderClaimConsumptionTrialPlan(plan);
  assert.equal(plan.decision, 'eligible_for_manual_review');
  assert.doesNotMatch(report, /SHOULD NOT APPEAR/);
  assert.doesNotMatch(report, /CODE SESSION CONTEXT/);
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
  lines.push('# Claim Context Trial Test Report');
  lines.push('');
  lines.push(`- PASS: ${pass}`);
  lines.push(`- FAIL: ${fail}`);
  lines.push(`- Total: ${results.length}`);
  lines.push('');
  lines.push('| Fixture | Status | Detail |');
  lines.push('|---|---:|---|');
  for (const result of results) lines.push(`| ${escapePipes(result.name)} | ${result.status} | ${escapePipes(result.detail || 'ok')} |`);
  lines.push('');

  const reportPath = path.join(__dirname, 'reports', 'claim-context-trial.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

  console.log(`Claim context trial tests: PASS=${pass} FAIL=${fail}`);
  console.log(`Report: ${path.relative(process.cwd(), reportPath)}`);
  if (fail) {
    for (const r of results.filter((r) => r.status === 'FAIL')) console.error(`${r.name}: ${r.detail}`);
    process.exit(1);
  }
}

function escapePipes(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}
