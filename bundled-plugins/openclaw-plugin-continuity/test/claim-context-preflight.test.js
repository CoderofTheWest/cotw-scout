#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { createClaimContextPacket } = require('../lib/claim-context');
const { createClaimContextPreflight, renderClaimContextPreflight } = require('../lib/claim-context-preflight');
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

run('preflight blocks review-required packets and explains next actions', () => {
  const packet = createClaimContextPacket([runtimeClaim], { limit: 8 });
  const preflight = createClaimContextPreflight({ packet });
  assert.equal(preflight.decision, 'blocked');
  assert.equal(preflight.injectionReady, false);
  assert.equal(preflight.consumptionAttempted, false);
  assert.equal(preflight.verificationAttempted, false);
  assert.equal(preflight.promotionAttempted, false);
  assert.match(preflight.blockers.join(','), /quality:all_selected_claims_require_verification/);
  assert.match(preflight.blockers.join(','), /trial:refused_review_required/);
  assert.match(preflight.blockers.join(','), /verification:claims_require_verification/);
  assert.match(preflight.nextActions.join(','), /verify_against_current_runtime_before_asserting/);
  const report = renderClaimContextPreflight(preflight);
  assert.match(report, /Claim Context Preflight/);
  assert.match(report, /Decision: blocked/);
  assert.doesNotMatch(report, /Gateway is currently running under LaunchAgent ownership/);
  assert.doesNotMatch(report, /tool:session_abc#call7/);
  assert.doesNotMatch(report, /gateway status output/);
});

run('preflight allows only manual review consideration for clean packets', () => {
  const packet = createClaimContextPacket([stablePreference], { limit: 8 });
  const preflight = createClaimContextPreflight({ packet });
  assert.equal(preflight.decision, 'ready_for_manual_review');
  assert.deepEqual(preflight.blockers, []);
  assert.equal(preflight.trialDecision, 'eligible_for_manual_review');
  assert.equal(preflight.verificationDecision, 'no_verification_needed');
  assert.equal(preflight.injectionReady, false);
  assert.match(preflight.nextActions.join(','), /manual_review_can_be_considered_without_enabling_injection/);
});

run('preflight refuses missing audit and stays redacted', () => {
  const preflight = createClaimContextPreflight({});
  assert.equal(preflight.decision, 'blocked');
  assert.match(preflight.blockers.join(','), /missing_quality_audit/);
  assert.equal(preflight.trialDecision, 'refused_missing_audit');
  const report = renderClaimContextPreflight(preflight);
  assert.match(report, /missing_quality_audit/);
  assert.doesNotMatch(report, /claim:/);
});

run('preflight ignores rendered context content from preview-shaped input', () => {
  const packet = createClaimContextPacket([stablePreference, runtimeClaim], { includeSourceExcerpts: true });
  const preflight = createClaimContextPreflight({
    preview: {
      packet,
      audit: packet.audit,
      rendered: 'SHOULD NOT APPEAR: CODE SESSION CONTEXT: Help directly.'
    }
  });
  const report = renderClaimContextPreflight(preflight);
  assert.doesNotMatch(report, /SHOULD NOT APPEAR/);
  assert.doesNotMatch(report, /CODE SESSION CONTEXT/);
  assert.doesNotMatch(report, /archive:2026-05-05/);
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
  lines.push('# Claim Context Preflight Test Report');
  lines.push('');
  lines.push(`- PASS: ${pass}`);
  lines.push(`- FAIL: ${fail}`);
  lines.push(`- Total: ${results.length}`);
  lines.push('');
  lines.push('| Fixture | Status | Detail |');
  lines.push('|---|---:|---|');
  for (const result of results) lines.push(`| ${escapePipes(result.name)} | ${result.status} | ${escapePipes(result.detail || 'ok')} |`);
  lines.push('');

  const reportPath = path.join(__dirname, 'reports', 'claim-context-preflight.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

  console.log(`Claim context preflight tests: PASS=${pass} FAIL=${fail}`);
  console.log(`Report: ${path.relative(process.cwd(), reportPath)}`);
  if (fail) {
    for (const r of results.filter((r) => r.status === 'FAIL')) console.error(`${r.name}: ${r.detail}`);
    process.exit(1);
  }
}

function escapePipes(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}
