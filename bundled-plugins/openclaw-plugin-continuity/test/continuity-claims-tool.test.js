#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const createClaimsTool = require('../tools/continuity-claims');
const { CLAIM_KINDS, CLAIM_STATUSES, createClaimRecord } = require('../lib/claim-records');

const now = '2026-05-04T23:55:00.000Z';
const results = [];

const activeClaim = createClaimRecord({
  id: 'claim_pref_direct',
  agentId: 'trail-guide',
  threadId: 'main',
  kind: CLAIM_KINDS.USER_PREFERENCE,
  claim: 'Chris prefers direct code-mode help during build sessions.',
  sources: [{
    handle: 'archive:2026-05-04:trail-guide:main#e0010',
    role: 'evidence',
    excerpt: 'CODE SESSION CONTEXT: Help directly.',
    quoteHash: 'hash_pref'
  }]
}, { now });

const runtimeClaim = createClaimRecord({
  id: 'claim_runtime_gateway',
  agentId: 'trail-guide',
  threadId: 'ops',
  kind: CLAIM_KINDS.RUNTIME,
  claim: 'Gateway is currently running under service mode.',
  sources: [{
    handle: 'tool:session_abc#call9',
    role: 'verification',
    excerpt: 'gateway status output',
    quoteHash: 'hash_runtime'
  }]
}, { now });

const retractedClaim = createClaimRecord({
  id: 'claim_old_bad',
  agentId: 'trail-guide',
  threadId: 'ops',
  kind: CLAIM_KINDS.PROJECT_STATE,
  claim: 'Old invalid claim.',
  status: CLAIM_STATUSES.RETRACTED,
  sources: ['archive:2026-05-04:trail-guide:ops#e0001']
}, { now });


const activeCandidateClaim = createClaimRecord({
  id: 'claim_tool_candidate_active',
  agentId: 'trail-guide',
  threadId: 'main',
  kind: CLAIM_KINDS.INTERPRETATION,
  claim: 'Candidate-only tool reports can help map creative research without becoming belief.',
  sources: [{
    handle: 'archive:2026-05-04:trail-guide:main#e0042',
    role: 'origin',
    excerpt: 'candidate excerpt should not appear by default',
    quoteHash: 'hash_tool_candidate'
  }],
  metadata: { candidateOnly: true }
}, { now });

const verifyRequiredCandidateClaim = createClaimRecord({
  id: 'claim_tool_candidate_verify',
  agentId: 'trail-guide',
  threadId: 'main',
  kind: CLAIM_KINDS.PROJECT_STATE,
  claim: 'The continuity claims tool exposes a read-only candidate research report action.',
  status: CLAIM_STATUSES.VERIFY_REQUIRED,
  confidence: 0.76,
  sources: [{
    handle: 'commit:local#bundled-plugins/openclaw-plugin-continuity/tools/continuity-claims.js',
    role: 'evidence',
    excerpt: 'tool implementation excerpt should stay hidden',
    quoteHash: 'hash_tool_verify'
  }]
}, { now });

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});

async function main() {
  await run('tool reports unavailable when ClaimStore is not initialized', async () => {
    const tool = createClaimsTool(() => ({ ensureStorage: async () => {} }), () => 'trail-guide');
    const result = await tool.execute('call_1', { action: 'list' });
    assert.match(result.content[0].text, /ClaimStore is not initialized/);
  });

  await run('tool rejects invalid status and kind filters before storage lookup', async () => {
    const tool = createClaimsTool(() => { throw new Error('storage should not be touched'); }, () => 'trail-guide');

    const invalidStatus = await tool.execute('call_invalid_status', { action: 'list', status: 'imaginary' });
    assert.match(invalidStatus.content[0].text, /Unsupported status "imaginary"/);
    assert.doesNotMatch(invalidStatus.content[0].text, /storage should not be touched/);

    const invalidKind = await tool.execute('call_invalid_kind', { action: 'list', kind: 'folklore' });
    assert.match(invalidKind.content[0].text, /Unsupported kind "folklore"/);
    assert.doesNotMatch(invalidKind.content[0].text, /storage should not be touched/);

    const invalidMode = await tool.execute('call_invalid_research_mode', { action: 'research', research_mode: 'unsafe' });
    assert.match(invalidMode.content[0].text, /Unsupported research_mode "unsafe"/);
    assert.doesNotMatch(invalidMode.content[0].text, /storage should not be touched/);
  });

  await run('tool rejects invalid numeric filters before storage lookup', async () => {
    const tool = createClaimsTool(() => { throw new Error('storage should not be touched'); }, () => 'trail-guide');

    const confidence = await tool.execute('call_invalid_confidence', { action: 'list', min_confidence: 2 });
    assert.match(confidence.content[0].text, /min_confidence must be a number between 0 and 1/);
    assert.doesNotMatch(confidence.content[0].text, /storage should not be touched/);

    const limit = await tool.execute('call_invalid_limit', { action: 'list', limit: 'many' });
    assert.match(limit.content[0].text, /limit must be an integer/);
    assert.doesNotMatch(limit.content[0].text, /storage should not be touched/);
  });

  await run('tool rejects unsupported actions before storage lookup', async () => {
    const tool = createClaimsTool(() => { throw new Error('storage should not be touched'); }, () => 'trail-guide');
    const result = await tool.execute('call_bad_action', { action: 'record' });
    assert.match(result.content[0].text, /Unsupported action "record"/);
    assert.doesNotMatch(result.content[0].text, /storage should not be touched/);
  });

  await run('get action returns claim diagnostics without source excerpts by default', async () => {
    const tool = createToolWithStore(new FakeClaimStore([activeClaim, runtimeClaim]));
    const result = await tool.execute('call_2', { action: 'get', claim_id: 'claim_pref_direct' });
    const text = result.content[0].text;
    assert.match(text, /claim_pref_direct/);
    assert.match(text, /Chris prefers direct code-mode help/);
    assert.match(text, /archive:2026-05-04:trail-guide:main#e0010/);
    assert.doesNotMatch(text, /CODE SESSION CONTEXT/);
  });

  await run('source excerpts are opt-in and no resolver is called', async () => {
    const tool = createToolWithStore(new FakeClaimStore([activeClaim]));
    const result = await tool.execute('call_3', {
      action: 'get',
      claim_id: 'claim_pref_direct',
      include_source_excerpts: true
    });
    const text = result.content[0].text;
    assert.match(text, /CODE SESSION CONTEXT: Help directly/);
    assert.doesNotMatch(text, /resolved source text/);
  });

  await run('verify action returns only claims requiring verification', async () => {
    const tool = createToolWithStore(new FakeClaimStore([activeClaim, runtimeClaim, retractedClaim]));
    const result = await tool.execute('call_4', { action: 'verify', limit: 10 });
    const text = result.content[0].text;
    assert.match(text, /claim_runtime_gateway/);
    assert.match(text, /claim_old_bad/);
    assert.doesNotMatch(text, /claim_pref_direct/);
  });

  await run('source action requires source_handle and filters by source handle', async () => {
    const tool = createToolWithStore(new FakeClaimStore([activeClaim, runtimeClaim]));
    const missing = await tool.execute('call_5', { action: 'source' });
    assert.match(missing.content[0].text, /source_handle is required/);

    const result = await tool.execute('call_6', { action: 'source', source_handle: 'tool:session_abc#call9' });
    const text = result.content[0].text;
    assert.match(text, /claim_runtime_gateway/);
    assert.doesNotMatch(text, /claim_pref_direct/);
  });

  await run('stats action is read-only and compact', async () => {
    const tool = createToolWithStore(new FakeClaimStore([activeClaim, runtimeClaim, retractedClaim]));
    const result = await tool.execute('call_7', { action: 'stats' });
    assert.match(result.content[0].text, /total: 3/);
    assert.match(result.content[0].text, /byStatus/);
  });

  await run('context action renders safe read-only packet with source handles and no excerpts by default', async () => {
    const tool = createToolWithStore(new FakeClaimStore([activeClaim, runtimeClaim, retractedClaim]));
    const result = await tool.execute('call_context', { action: 'context', limit: 10 });
    const text = result.content[0].text;
    assert.match(text, /SOURCE-ADDRESSABLE CLAIM CONTEXT — READ ONLY/);
    assert.match(text, /claim_pref_direct/);
    assert.match(text, /claim_runtime_gateway/);
    assert.doesNotMatch(text, /claim_old_bad/);
    assert.match(text, /archive:2026-05-04:trail-guide:main#e0010/);
    assert.match(text, /tool:session_abc#call9/);
    assert.match(text, /requiresVerification: true/);
    assert.doesNotMatch(text, /CODE SESSION CONTEXT/);
    assert.doesNotMatch(text, /gateway status output/);
  });


  await run('context_audit action renders redacted operator audit without claim text or source handles', async () => {
    const tool = createToolWithStore(new FakeClaimStore([activeClaim, runtimeClaim, retractedClaim]));
    const result = await tool.execute('call_context_audit', { action: 'context_audit', limit: 10, include_source_excerpts: true });
    const text = result.content[0].text;
    assert.match(text, /Claim Context Preview Audit/);
    assert.match(text, /claim_pref_direct/);
    assert.match(text, /claim_runtime_gateway/);
    assert.match(text, /claim_old_bad/);
    assert.match(text, /Redacted: yes/);
    assert.match(text, /does not include claim text/);
    assert.doesNotMatch(text, /Chris prefers direct code-mode help/);
    assert.doesNotMatch(text, /Gateway is currently running under service mode/);
    assert.doesNotMatch(text, /archive:2026-05-04:trail-guide:main#e0010/);
    assert.doesNotMatch(text, /tool:session_abc#call9/);
    assert.doesNotMatch(text, /CODE SESSION CONTEXT/);
    assert.doesNotMatch(text, /gateway status output/);
  });

  await run('trial_plan action renders redacted manual trial decision without consuming context', async () => {
    const tool = createToolWithStore(new FakeClaimStore([runtimeClaim, retractedClaim]));
    const result = await tool.execute('call_trial_plan', { action: 'trial_plan', limit: 10, include_source_excerpts: true });
    const text = result.content[0].text;
    assert.match(text, /Claim Context Manual Trial Plan/);
    assert.match(text, /Decision: refused_review_required/);
    assert.match(text, /Injection ready: no/);
    assert.match(text, /Consumption attempted: no/);
    assert.match(text, /verify_or_supersede_selected_claims_before_consumption_trial/);
    assert.doesNotMatch(text, /Gateway is currently running under service mode/);
    assert.doesNotMatch(text, /tool:session_abc#call9/);
    assert.doesNotMatch(text, /gateway status output/);
  });

  await run('verification_plan action renders redacted verification steps without promoting claims', async () => {
    const tool = createToolWithStore(new FakeClaimStore([runtimeClaim, retractedClaim]));
    const result = await tool.execute('call_verification_plan', { action: 'verification_plan', limit: 10, include_source_excerpts: true });
    const text = result.content[0].text;
    assert.match(text, /Claim Context Verification Plan/);
    assert.match(text, /Verification attempted: no/);
    assert.match(text, /Promotion attempted: no/);
    assert.match(text, /current_runtime_check/);
    assert.doesNotMatch(text, /Gateway is currently running under service mode/);
    assert.doesNotMatch(text, /tool:session_abc#call9/);
    assert.doesNotMatch(text, /gateway status output/);
  });

  await run('preflight action renders redacted bundled operator receipt', async () => {
    const tool = createToolWithStore(new FakeClaimStore([runtimeClaim, retractedClaim]));
    const result = await tool.execute('call_preflight', { action: 'preflight', limit: 10, include_source_excerpts: true });
    const text = result.content[0].text;
    assert.match(text, /Claim Context Preflight/);
    assert.match(text, /Decision: blocked/);
    assert.match(text, /Injection ready: no/);
    assert.match(text, /Verification attempted: no/);
    assert.match(text, /Promotion attempted: no/);
    assert.doesNotMatch(text, /Gateway is currently running under service mode/);
    assert.doesNotMatch(text, /tool:session_abc#call9/);
    assert.doesNotMatch(text, /gateway status output/);
  });

  await run('manual_review action blocks unsafe packets without leaking review content', async () => {
    const tool = createToolWithStore(new FakeClaimStore([runtimeClaim, retractedClaim]));
    const result = await tool.execute('call_manual_review_blocked', { action: 'manual_review', limit: 10, include_source_excerpts: true });
    const text = result.content[0].text;
    assert.match(text, /Claim Context Manual Review Packet/);
    assert.match(text, /Decision: blocked_by_preflight/);
    assert.match(text, /Manual review prepared: no/);
    assert.match(text, /Injection ready: no/);
    assert.match(text, /Consumption attempted: no/);
    assert.doesNotMatch(text, /Gateway is currently running under service mode/);
    assert.doesNotMatch(text, /tool:session_abc#call9/);
    assert.doesNotMatch(text, /gateway status output/);
  });

  await run('manual_review action prepares clean review packet without injection', async () => {
    const tool = createToolWithStore(new FakeClaimStore([activeClaim]));
    const result = await tool.execute('call_manual_review_clean', { action: 'manual_review', limit: 10 });
    const text = result.content[0].text;
    assert.match(text, /Claim Context Manual Review Packet/);
    assert.match(text, /Decision: ready_for_operator_review/);
    assert.match(text, /Manual review prepared: yes/);
    assert.match(text, /Injection ready: no/);
    assert.match(text, /Consumption attempted: no/);
    assert.match(text, /Chris prefers direct code-mode help during build sessions/);
    assert.match(text, /archive:2026-05-04:trail-guide:main#e0010/);
    assert.doesNotMatch(text, /CODE SESSION CONTEXT/);
  });


  await run('research action renders ClaimStore-backed candidate report without active claim noise', async () => {
    const tool = createToolWithStore(new FakeClaimStore([activeClaim, activeCandidateClaim, verifyRequiredCandidateClaim, retractedClaim]));
    const result = await tool.execute('call_research', { action: 'research', limit: 10 });
    const text = result.content[0].text;
    assert.match(text, /Candidate Research Diagnostics — READ ONLY/);
    assert.match(text, /claimsRead: 2/);
    assert.match(text, /candidateOnlyRead: 1/);
    assert.match(text, /claim_tool_candidate_active/);
    assert.match(text, /claim_tool_candidate_verify/);
    assert.doesNotMatch(text, /claim_pref_direct/);
    assert.doesNotMatch(text, /claim_old_bad/);
  });

  await run('research action is read-only and keeps source resolution off by default', async () => {
    const store = new FakeClaimStore([activeCandidateClaim, verifyRequiredCandidateClaim]);
    const tool = createToolWithStore(store);
    const result = await tool.execute('call_research_readonly', { action: 'research', research_mode: 'verification', limit: 10, include_source_excerpts: true });
    const text = result.content[0].text;
    assert.match(text, /mode: verification/);
    assert.match(text, /claimsMutated: 0/);
    assert.match(text, /claimsPromoted: 0/);
    assert.match(text, /promptInjectionWrites: 0/);
    assert.match(text, /sourceResolutionAttempted: false/);
    assert.match(text, /archive:2026-05-04:trail-guide:main#e0042/);
    assert.match(text, /commit:local#bundled-plugins/);
    assert.doesNotMatch(text, /candidate excerpt should not appear/);
    assert.doesNotMatch(text, /tool implementation excerpt should stay hidden/);
    assert.equal(store.mutationAttempts, 0);
  });

  await run('research action handles empty stores cleanly', async () => {
    const tool = createToolWithStore(new FakeClaimStore([]));
    const result = await tool.execute('call_research_empty', { action: 'research', limit: 10 });
    const text = result.content[0].text;
    assert.match(text, /Candidate Research Diagnostics — READ ONLY/);
    assert.match(text, /claimsRead: 0/);
    assert.match(text, /candidateOnlyRead: 0/);
    assert.match(text, /Verification ready: 0/);
    assert.match(text, /Signal profiles: 0/);
  });

  await run('autonomy_review action renders dry-run policy receipts without mutation', async () => {
    const store = new FakeClaimStore([activeClaim, runtimeClaim, activeCandidateClaim, verifyRequiredCandidateClaim, retractedClaim]);
    const tool = createToolWithStore(store);
    const result = await tool.execute('call_autonomy_review', { action: 'autonomy_review', limit: 10, scan_limit: 20 });
    const text = result.content[0].text;
    assert.match(text, /Claim Autonomy Review — READ ONLY DRY RUN/);
    assert.match(text, /dryRun: true/);
    assert.match(text, /writesAttempted: false/);
    assert.match(text, /promptInjectionEligibilityChanged: false/);
    assert.match(text, /writeAttempts: 0/);
    assert.match(text, /promptEligibilityChanges: 0/);
    assert.match(text, /claim_runtime_gateway/);
    assert.match(text, /claim_tool_candidate_verify/);
    assert.doesNotMatch(text, /claim_pref_direct/);
    assert.equal(store.mutationAttempts, 0);
  });

  await run('apply_review_decision dry-run renders exact gated payload without mutation', async () => {
    const store = new FakeClaimStore([verifyRequiredCandidateClaim]);
    const tool = createToolWithStore(store);
    const result = await tool.execute('call_apply_review_decision_dry_run', {
      action: 'apply_review_decision',
      claim_id: 'claim_tool_candidate_verify',
      decision: 'archive_open_question',
      expected_status: 'verify_required',
      reason: 'first low-risk write-through experiment candidate'
    });
    const text = result.content[0].text;
    assert.match(text, /Claim Autonomy Review Decision/);
    assert.match(text, /Dry run: yes/);
    assert.match(text, /Mutation attempted: no/);
    assert.match(text, /approve:claim_tool_candidate_verify:archive_open_question:verify_required/);
    assert.match(text, /Status: verify_required -> retracted/);
    assert.equal(store.mutationAttempts, 0);
  });

  await run('apply_review_decision autonomously applies low-risk action without exact operator approval', async () => {
    const store = new FakeClaimStore([verifyRequiredCandidateClaim]);
    const tool = createToolWithStore(store);
    const result = await tool.execute('call_apply_review_decision_autonomous_apply', {
      action: 'apply_review_decision',
      claim_id: 'claim_tool_candidate_verify',
      decision: 'archive_open_question',
      expected_status: 'verify_required',
      reason: 'autonomous low-risk archive of an open question',
      apply: true
    });
    const text = result.content[0].text;
    assert.match(text, /Dry run: no/);
    assert.match(text, /Mutation attempted: yes/);
    assert.match(text, /Required for low-risk apply: no/);
    assert.match(text, /Authorization mode: autonomous_low_risk/);
    assert.equal(store.mutationAttempts, 2);
    assert.equal(store.getClaim('claim_tool_candidate_verify').status, CLAIM_STATUSES.RETRACTED);
  });

  await run('apply_review_decision applies exactly one archived-open-question mutation with receipts', async () => {
    const store = new FakeClaimStore([verifyRequiredCandidateClaim]);
    const tool = createToolWithStore(store);
    const result = await tool.execute('call_apply_review_decision_apply', {
      action: 'apply_review_decision',
      claim_id: 'claim_tool_candidate_verify',
      decision: 'archive_open_question',
      expected_status: 'verify_required',
      reason: 'operator approved this single low-risk claim mutation',
      apply: true,
      operator_approval: 'approve:claim_tool_candidate_verify:archive_open_question:verify_required'
    });
    const text = result.content[0].text;
    assert.match(text, /Dry run: no/);
    assert.match(text, /Mutation attempted: yes/);
    assert.match(text, /Prompt injection eligibility changed: no/);
    assert.match(text, /before: claim_apply_/);
    assert.match(text, /after: claim_apply_/);
    assert.equal(store.mutationAttempts, 2);
    const updated = store.getClaim('claim_tool_candidate_verify');
    assert.equal(updated.status, CLAIM_STATUSES.RETRACTED);
    assert.equal(updated.metadata.archivedOpenQuestion, true);
    assert.equal(updated.metadata.autonomyApplyReceipts.length, 2);
    assert.equal(updated.sources.length, 1);
  });

  await run('rollback_review_decision restores one prior autonomous apply receipt', async () => {
    const store = new FakeClaimStore([verifyRequiredCandidateClaim]);
    const tool = createToolWithStore(store);
    await tool.execute('call_apply_review_decision_before_rollback', {
      action: 'apply_review_decision',
      claim_id: 'claim_tool_candidate_verify',
      decision: 'archive_open_question',
      expected_status: 'verify_required',
      reason: 'autonomous low-risk archive before rollback test',
      apply: true
    });

    const result = await tool.execute('call_rollback_review_decision_apply', {
      action: 'rollback_review_decision',
      claim_id: 'claim_tool_candidate_verify',
      reason: 'operator requested rollback of autonomous archive',
      apply: true
    });
    const text = result.content[0].text;
    assert.match(text, /Claim Autonomy Review Rollback/);
    assert.match(text, /Dry run: no/);
    assert.match(text, /Mutation attempted: yes/);
    assert.match(text, /Status: retracted -> verify_required/);
    assert.equal(store.mutationAttempts, 3);
    const updated = store.getClaim('claim_tool_candidate_verify');
    assert.equal(updated.status, CLAIM_STATUSES.VERIFY_REQUIRED);
    assert.equal(updated.metadata.autonomyApplyReceipts.length, 3);
    assert.equal(updated.metadata.autonomyApplyReceipts[2].phase, 'rollback');
  });

  await run('context action includes source excerpts only by explicit opt-in', async () => {
    const tool = createToolWithStore(new FakeClaimStore([activeClaim]));
    const result = await tool.execute('call_context_excerpts', {
      action: 'context',
      include_source_excerpts: true
    });
    const text = result.content[0].text;
    assert.match(text, /CODE SESSION CONTEXT: Help directly/);
    assert.doesNotMatch(text, /resolved source text/);
  });

  writeReportAndExit();
}

function createToolWithStore(store) {
  return createClaimsTool(() => ({ ensureStorage: async () => {}, claimStore: store }), () => 'trail-guide');
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
  lines.push('# Continuity Claims Tool Test Report');
  lines.push('');
  lines.push(`- PASS: ${pass}`);
  lines.push(`- FAIL: ${fail}`);
  lines.push(`- Total: ${results.length}`);
  lines.push('');
  lines.push('| Fixture | Status | Detail |');
  lines.push('|---|---:|---|');
  for (const result of results) lines.push(`| ${escapePipes(result.name)} | ${result.status} | ${escapePipes(result.detail || 'ok')} |`);
  lines.push('');

  const reportPath = path.join(__dirname, 'reports', 'continuity-claims-tool.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

  console.log(`Continuity claims tool tests: PASS=${pass} FAIL=${fail}`);
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
  constructor(claims) {
    this.claims = claims;
    this.mutationAttempts = 0;
  }

  getClaim(id) {
    return this.claims.find((claim) => claim.id === id) || null;
  }

  queryClaims(filter = {}) {
    return filterClaims(this.claims, filter).slice(0, filter.limit || 10).map((claim) => {
      if (filter.includeSources) return claim;
      return { ...claim, sources: [], edges: [] };
    });
  }

  listClaims(filter = {}) {
    return this.queryClaims(filter);
  }

  getClaimsBySourceHandle(handle, filter = {}) {
    if (!handle) throw new Error('source handle is required');
    return this.queryClaims({ ...filter, sourceHandle: handle, includeSources: true });
  }

  getClaimsNeedingVerification(filter = {}) {
    return this.queryClaims({ ...filter, requiresVerification: true });
  }

  getStats(agentId) {
    const claims = this.claims.filter((claim) => !agentId || claim.agentId === agentId);
    return {
      total: claims.length,
      byStatus: countBy(claims, 'status'),
      byKind: countBy(claims, 'kind'),
      sourceCount: claims.reduce((count, claim) => count + (claim.sources?.length || 0), 0),
      edgeCount: claims.reduce((count, claim) => count + (claim.edges?.length || 0), 0)
    };
  }


  storeClaim(claim) {
    this.mutationAttempts += 1;
    const index = this.claims.findIndex((item) => item.id === claim.id);
    if (index >= 0) this.claims[index] = claim;
    else this.claims.push(claim);
    return claim;
  }

  createClaim() {
    this.mutationAttempts += 1;
    throw new Error('mutation should not be called');
  }

  updateClaim() {
    this.mutationAttempts += 1;
    throw new Error('mutation should not be called');
  }

  promoteClaim() {
    this.mutationAttempts += 1;
    throw new Error('mutation should not be called');
  }
}

function filterClaims(claims, filter = {}) {
  return claims.filter((claim) => {
    if (filter.agentId && claim.agentId !== filter.agentId) return false;
    if (filter.threadId && claim.threadId !== filter.threadId) return false;
    if (filter.kind && claim.kind !== filter.kind) return false;
    if (Array.isArray(filter.kinds) && filter.kinds.length && !filter.kinds.includes(claim.kind)) return false;
    if (filter.status && claim.status !== filter.status) return false;
    if (Array.isArray(filter.statuses) && filter.statuses.length && !filter.statuses.includes(claim.status)) return false;
    if (filter.text && !claim.claim.includes(filter.text)) return false;
    if (Number.isFinite(filter.minConfidence) && claim.confidence < filter.minConfidence) return false;
    if (filter.sourceHandle && !claim.sources.some((source) => source.handle === filter.sourceHandle)) return false;
    if (filter.requiresVerification) {
      const requires = claim.status === CLAIM_STATUSES.VERIFY_REQUIRED ||
        claim.status === CLAIM_STATUSES.STALE ||
        claim.status === CLAIM_STATUSES.RETRACTED ||
        claim.status === CLAIM_STATUSES.SUPERSEDED ||
        claim.freshness?.stalenessPolicy === 'verify_before_asserting' ||
        claim.freshness?.stalenessPolicy === 'runtime_check_required';
      if (!requires) return false;
    }
    return true;
  });
}

function countBy(items, key) {
  return items.reduce((acc, item) => {
    acc[item[key]] = (acc[item[key]] || 0) + 1;
    return acc;
  }, {});
}
