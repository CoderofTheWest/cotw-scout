#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const createClaimsTool = require('../tools/continuity-claims');
const { createClaimContextPacket, renderClaimContextAudit } = require('../lib/claim-context');
const { createClaimConsumptionTrialPlan, renderClaimConsumptionTrialPlan } = require('../lib/claim-context-trial');
const { createClaimContextVerificationPlan, renderClaimContextVerificationPlan } = require('../lib/claim-context-verification-plan');
const { createClaimContextPreflight, renderClaimContextPreflight } = require('../lib/claim-context-preflight');
const { CLAIM_KINDS, FRESHNESS_POLICIES, createClaimRecord } = require('../lib/claim-records');

const now = '2026-05-05T22:40:00.000Z';
const results = [];

const stablePreference = createClaimRecord({
  id: 'claim_acceptance_preference',
  agentId: 'trail-guide',
  threadId: 'main',
  kind: CLAIM_KINDS.USER_PREFERENCE,
  claim: 'Chris prefers direct code-mode help during build sessions.',
  sources: [{
    handle: 'archive:2026-05-05:trail-guide:main#e0101',
    role: 'evidence',
    excerpt: 'CODE SESSION CONTEXT: Help directly.',
    quoteHash: 'hash_acceptance_preference'
  }]
}, { now });

const runtimeClaim = createClaimRecord({
  id: 'claim_acceptance_runtime',
  agentId: 'trail-guide',
  threadId: 'ops',
  kind: CLAIM_KINDS.RUNTIME,
  claim: 'Gateway is currently running with a specific verified runtime state.',
  stalenessPolicy: FRESHNESS_POLICIES.VERIFY_BEFORE_ASSERTING,
  sources: [{
    handle: 'tool:session_acceptance#call1',
    role: 'verification',
    excerpt: 'gateway status output with live state',
    quoteHash: 'hash_acceptance_runtime'
  }]
}, { now });

main();

async function main() {
  await run('end-to-end Build 3 scaffold refuses runtime-dependent packets without consuming context', () => {
  const packet = createClaimContextPacket([stablePreference, runtimeClaim], { limit: 10, includeSourceExcerpts: true });
  const auditReport = renderClaimContextAudit(packet.audit);
  const trial = createClaimConsumptionTrialPlan({ packet });
  const trialReport = renderClaimConsumptionTrialPlan(trial);
  const verification = createClaimContextVerificationPlan({ packet });
  const verificationReport = renderClaimContextVerificationPlan(verification);
  const preflight = createClaimContextPreflight({ packet, trial, verification });
  const preflightReport = renderClaimContextPreflight(preflight);
  const combined = [auditReport, trialReport, verificationReport, preflightReport].join('\n---\n');

  assert.equal(packet.audit.previewOnly, true);
  assert.equal(packet.injectionReady, false);
  assert.equal(trial.injectionReady, false);
  assert.equal(trial.consumptionAttempted, false);
  assert.equal(verification.verificationAttempted, false);
  assert.equal(verification.promotionAttempted, false);
  assert.equal(preflight.previewOnly, true);
  assert.equal(preflight.injectionReady, false);
  assert.equal(preflight.consumptionAttempted, false);
  assert.equal(preflight.verificationAttempted, false);
  assert.equal(preflight.sourceResolutionAttempted, false);
  assert.equal(preflight.mutationAttempted, false);
  assert.equal(preflight.promotionAttempted, false);
  assert.equal(preflight.decision, 'blocked');
  assert.match(preflight.blockers.join(','), /verification:claims_require_verification/);
  assert.match(preflight.nextActions.join(','), /verify_against_current_runtime_before_asserting/);

  assert.doesNotMatch(combined, /Chris prefers direct code-mode help/);
  assert.doesNotMatch(combined, /Gateway is currently running with a specific verified runtime state/);
  assert.doesNotMatch(combined, /archive:2026-05-05:trail-guide:main#e0101/);
  assert.doesNotMatch(combined, /tool:session_acceptance#call1/);
  assert.doesNotMatch(combined, /CODE SESSION CONTEXT/);
  assert.doesNotMatch(combined, /gateway status output with live state/);
  });

  await run('explicit diagnostic tool surfaces include preflight but remain read-only and redacted', async () => {
  const tool = createClaimsTool(() => ({ claimStore: new FakeClaimStore([stablePreference, runtimeClaim]) }), () => 'trail-guide');
  const preflightResult = await tool.execute('acceptance_preflight', { action: 'preflight', limit: 10, include_source_excerpts: true });
  const verificationResult = await tool.execute('acceptance_verification', { action: 'verification_plan', limit: 10, include_source_excerpts: true });
  const trialResult = await tool.execute('acceptance_trial', { action: 'trial_plan', limit: 10, include_source_excerpts: true });
  const combined = [preflightResult.content[0].text, verificationResult.content[0].text, trialResult.content[0].text].join('\n---\n');

  assert.match(combined, /Claim Context Preflight/);
  assert.match(combined, /Claim Context Verification Plan/);
  assert.match(combined, /Claim Context Manual Trial Plan/);
  assert.match(combined, /Injection ready: no/);
  assert.match(combined, /Consumption attempted: no/);
  assert.match(combined, /Verification attempted: no/);
  assert.match(combined, /Promotion attempted: no/);
  assert.doesNotMatch(combined, /Chris prefers direct code-mode help/);
  assert.doesNotMatch(combined, /Gateway is currently running with a specific verified runtime state/);
  assert.doesNotMatch(combined, /archive:2026-05-05:trail-guide:main#e0101/);
  assert.doesNotMatch(combined, /tool:session_acceptance#call1/);
  assert.doesNotMatch(combined, /CODE SESSION CONTEXT/);
  assert.doesNotMatch(combined, /gateway status output with live state/);
  });

  await run('clean packets can only reach manual-review consideration and still cannot inject', () => {
  const packet = createClaimContextPacket([stablePreference], { limit: 10 });
  const preflight = createClaimContextPreflight({ packet });
  const report = renderClaimContextPreflight(preflight);

  assert.equal(preflight.decision, 'ready_for_manual_review');
  assert.equal(preflight.trialDecision, 'eligible_for_manual_review');
  assert.equal(preflight.verificationDecision, 'no_verification_needed');
  assert.equal(preflight.injectionReady, false);
  assert.equal(preflight.consumptionAttempted, false);
  assert.match(preflight.nextActions.join(','), /manual_review_can_be_considered_without_enabling_injection/);
  assert.doesNotMatch(report, /Chris prefers direct code-mode help/);
  assert.doesNotMatch(report, /archive:2026-05-05/);
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
  lines.push('# Claim Context Build 3 Acceptance Test Report');
  lines.push('');
  lines.push(`- PASS: ${pass}`);
  lines.push(`- FAIL: ${fail}`);
  lines.push(`- Total: ${results.length}`);
  lines.push('');
  lines.push('| Fixture | Status | Detail |');
  lines.push('|---|---:|---|');
  for (const result of results) lines.push(`| ${escapePipes(result.name)} | ${result.status} | ${escapePipes(result.detail || 'ok')} |`);
  lines.push('');
  const reportPath = path.join(__dirname, 'reports', 'claim-context-build3-acceptance.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  console.log(`Claim context Build 3 acceptance tests: PASS=${pass} FAIL=${fail}`);
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
    this.claims = claims;
  }
  listClaims(filter = {}) {
    let claims = this.claims.slice();
    if (filter.agentId) claims = claims.filter((claim) => claim.agentId === filter.agentId);
    if (filter.status) claims = claims.filter((claim) => claim.status === filter.status);
    if (filter.kind) claims = claims.filter((claim) => claim.kind === filter.kind);
    if (filter.threadId) claims = claims.filter((claim) => claim.threadId === filter.threadId);
    return claims.slice(0, filter.limit || claims.length);
  }
  getClaimsNeedingVerification(filter = {}) {
    return this.listClaims(filter).filter((claim) => claim.requiresVerification);
  }
  getStats(agentId = null) {
    const claims = agentId ? this.claims.filter((claim) => claim.agentId === agentId) : this.claims;
    return { total: claims.length, byStatus: {}, byKind: {}, sourceCount: claims.reduce((sum, claim) => sum + (claim.sources || []).length, 0), edgeCount: 0 };
  }
}
