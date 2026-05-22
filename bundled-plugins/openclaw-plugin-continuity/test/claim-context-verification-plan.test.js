#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { createClaimContextPacket } = require('../lib/claim-context');
const { createClaimContextVerificationPlan, renderClaimContextVerificationPlan } = require('../lib/claim-context-verification-plan');
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

function handoffClaim(index, overrides = {}) {
  return createClaimRecord({
    id: `claim_handoff_${index}`,
    agentId: 'trail-guide',
    threadId: 'main',
    kind: overrides.kind || CLAIM_KINDS.SUMMARY,
    claim: overrides.claim || `Handoff-derived summary ${index}.`,
    confidence: overrides.confidence ?? 0.62,
    stalenessPolicy: FRESHNESS_POLICIES.VERIFY_BEFORE_ASSERTING,
    sources: [{
      handle: `handoff:2026-05-05:main#L${index}-L${index}`,
      role: 'origin',
      excerpt: `handoff line ${index}`,
      quoteHash: `hash_handoff_${index}`
    }]
  }, { now });
}

run('verification plan explains review-required runtime claims without resolving sources', () => {
  const packet = createClaimContextPacket([runtimeClaim], { limit: 8 });
  const plan = createClaimContextVerificationPlan({ packet });
  assert.equal(plan.decision, 'verification_required');
  assert.equal(plan.verificationAttempted, false);
  assert.equal(plan.sourceResolutionAttempted, false);
  assert.equal(plan.mutationAttempted, false);
  assert.equal(plan.promotionAttempted, false);
  assert.equal(plan.items[0].strategy, 'current_runtime_check');
  assert.match(plan.recommendations.join(','), /verify_against_current_runtime_before_asserting/);
  const report = renderClaimContextVerificationPlan(plan);
  assert.match(report, /Claim Context Verification Plan/);
  assert.match(report, /current_runtime_check/);
  assert.doesNotMatch(report, /Gateway is currently running under LaunchAgent ownership/);
  assert.doesNotMatch(report, /tool:session_abc#call7/);
  assert.doesNotMatch(report, /gateway status output/);
});

run('verification plan handles handoff-only selected claims as source review then supersede', () => {
  const packet = createClaimContextPacket([handoffClaim(1), handoffClaim(2)], { limit: 8 });
  const plan = createClaimContextVerificationPlan({ packet });
  assert.equal(plan.decision, 'verification_required');
  assert.equal(plan.items.every((item) => item.strategy === 'handoff_source_review_then_supersede'), true);
  assert.match(plan.recommendations.join(','), /review_handoff_source_and_create_superseding_claim_if_valid/);
  const report = renderClaimContextVerificationPlan(plan);
  assert.doesNotMatch(report, /handoff line/);
  assert.doesNotMatch(report, /handoff:2026-05-05/);
});

run('verification plan reports no verification needed for already usable packet', () => {
  const packet = createClaimContextPacket([stablePreference], { limit: 8 });
  const plan = createClaimContextVerificationPlan({ packet });
  assert.equal(plan.decision, 'no_verification_needed');
  assert.equal(plan.requiresVerification, 0);
  assert.deepEqual(plan.recommendations, ['no_verification_required_before_manual_review']);
  assert.equal(plan.items[0].strategy, 'no_action_required');
});

run('verification plan stays redacted even when packet was built with excerpts', () => {
  const packet = createClaimContextPacket([stablePreference, runtimeClaim], { limit: 8, includeSourceExcerpts: true });
  const plan = createClaimContextVerificationPlan({ packet });
  const report = renderClaimContextVerificationPlan(plan);
  assert.equal(plan.redacted, true);
  assert.doesNotMatch(report, /CODE SESSION CONTEXT/);
  assert.doesNotMatch(report, /gateway status output/);
  assert.doesNotMatch(report, /archive:2026-05-05/);
  assert.doesNotMatch(report, /tool:session_abc/);
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
  lines.push('# Claim Context Verification Plan Test Report');
  lines.push('');
  lines.push(`- PASS: ${pass}`);
  lines.push(`- FAIL: ${fail}`);
  lines.push(`- Total: ${results.length}`);
  lines.push('');
  lines.push('| Fixture | Status | Detail |');
  lines.push('|---|---:|---|');
  for (const result of results) lines.push(`| ${escapePipes(result.name)} | ${result.status} | ${escapePipes(result.detail || 'ok')} |`);
  lines.push('');

  const reportPath = path.join(__dirname, 'reports', 'claim-context-verification-plan.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

  console.log(`Claim context verification plan tests: PASS=${pass} FAIL=${fail}`);
  console.log(`Report: ${path.relative(process.cwd(), reportPath)}`);
  if (fail) {
    for (const r of results.filter((r) => r.status === 'FAIL')) console.error(`${r.name}: ${r.detail}`);
    process.exit(1);
  }
}

function escapePipes(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}
