#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const {
  createClaimContextPacket,
  renderClaimContextPacket,
  renderClaimContextAudit,
  classifyDiagnosticForContext,
  assessClaimContextQuality
} = require('../lib/claim-context');
const { CLAIM_KINDS, CLAIM_STATUSES, FRESHNESS_POLICIES, createClaimRecord } = require('../lib/claim-records');

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
  sources: [{
    handle: 'tool:session_abc#call7',
    role: 'verification',
    excerpt: 'gateway status output',
    quoteHash: 'hash_runtime'
  }]
}, { now });

const backfilledSummary = createClaimRecord({
  id: 'claim_summary_build2',
  agentId: 'trail-guide',
  threadId: 'main',
  kind: CLAIM_KINDS.SUMMARY,
  claim: 'Archived summary says Build 2 added source-addressable claims.',
  stalenessPolicy: FRESHNESS_POLICIES.VERIFY_BEFORE_ASSERTING,
  sources: [{
    handle: 'digest:main#v1:summary_123',
    role: 'origin',
    excerpt: 'Build 2 added source-addressable claims.',
    quoteHash: 'hash_summary'
  }]
}, { now });

const retracted = createClaimRecord({
  id: 'claim_retracted_old',
  agentId: 'trail-guide',
  threadId: 'main',
  kind: CLAIM_KINDS.PROJECT_STATE,
  claim: 'Old invalid project state.',
  status: CLAIM_STATUSES.RETRACTED,
  sources: ['archive:2026-05-04:trail-guide:main#e0001']
}, { now });

const stale = createClaimRecord({
  id: 'claim_stale_old_state',
  agentId: 'trail-guide',
  threadId: 'main',
  kind: CLAIM_KINDS.PROJECT_STATE,
  claim: 'Stale project state should not be preview context.',
  status: CLAIM_STATUSES.STALE,
  sources: ['archive:2026-05-03:trail-guide:main#e0002']
}, { now });

function handoffClaim(index, overrides = {}) {
  return createClaimRecord({
    id: `claim_handoff_noise_${index}`,
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
    }],
    metadata: overrides.metadata || {}
  }, { now });
}

run('context packet is read-only and not injection-ready by default', () => {
  const packet = createClaimContextPacket([stablePreference, runtimeClaim], { limit: 10 });
  assert.equal(packet.ok, true);
  assert.equal(packet.mode, 'read_only_context_packet');
  assert.equal(packet.injectionReady, false);
  assert.equal(packet.sourceResolutionAttempted, false);
  assert.equal(packet.mutationAttempted, false);
});

run('packet preserves verification requirements instead of upgrading claims to truth', () => {
  const packet = createClaimContextPacket([stablePreference, runtimeClaim, backfilledSummary], { limit: 10 });
  const runtime = packet.items.find((item) => item.id === 'claim_runtime_gateway_mode');
  const summary = packet.items.find((item) => item.id === 'claim_summary_build2');
  const preference = packet.items.find((item) => item.id === 'claim_user_pref_direct');

  assert.equal(preference.requiresVerification, false);
  assert.equal(preference.action, 'usable_with_qualification');
  assert.equal(runtime.requiresVerification, true);
  assert.equal(runtime.action, 'verify_before_asserting');
  assert.equal(summary.requiresVerification, true);
  assert.equal(summary.action, 'verify_before_asserting');
});

run('retracted, stale, and do-not-use claims are excluded from usable context', () => {
  const packet = createClaimContextPacket([stablePreference, retracted, stale], { limit: 10 });
  assert.equal(packet.totalInput, 3);
  assert.equal(packet.included, 1);
  assert.equal(packet.excluded, 2);
  assert.equal(packet.items.some((item) => item.id === 'claim_retracted_old'), false);
  assert.equal(packet.items.some((item) => item.id === 'claim_stale_old_state'), false);
});

run('candidate-only handoff claims are excluded from usable context', () => {
  const candidate = createClaimRecord({
    id: 'claim_candidate_handoff_fragment',
    agentId: 'trail-guide',
    threadId: 'main',
    kind: CLAIM_KINDS.SUMMARY,
    claim: 'Handoff note: queued working-memory fragment.',
    stalenessPolicy: FRESHNESS_POLICIES.VERIFY_BEFORE_ASSERTING,
    sources: [{
      handle: 'handoff:2026-05-05:main#L35-L35',
      role: 'origin',
      excerpt: 'queued working-memory fragment',
      quoteHash: 'hash_candidate_fragment'
    }],
    metadata: { candidateOnly: true, candidateSource: 'handoff' }
  }, { now });
  const packet = createClaimContextPacket([stablePreference, candidate], { limit: 10 });

  assert.equal(packet.totalInput, 2);
  assert.equal(packet.included, 1);
  assert.equal(packet.excluded, 1);
  assert.equal(packet.items.some((item) => item.id === 'claim_candidate_handoff_fragment'), false);
  assert.equal(packet.audit.counts.excludedByAction.exclude_do_not_use, 1);
});

run('fixture-only claims are excluded unless explicitly requested', () => {
  const fixture = createClaimRecord({
    id: 'claim_fixture_clean_packet_probe',
    agentId: 'trail-guide',
    threadId: 'main',
    kind: CLAIM_KINDS.SUMMARY,
    claim: 'Fixture proves manual review can prepare a clean packet.',
    stalenessPolicy: FRESHNESS_POLICIES.EVERGREEN,
    sources: [{
      handle: 'commit:7a905b3#bundled-plugins/openclaw-plugin-continuity/lib/claim-fixture-seed.js',
      role: 'evidence',
      excerpt: 'fixture seed path',
      quoteHash: 'hash_fixture'
    }],
    metadata: { fixtureOnly: true, candidateOnly: false }
  }, { now });

  const defaultPacket = createClaimContextPacket([fixture], { limit: 10 });
  assert.equal(defaultPacket.included, 0);
  assert.equal(defaultPacket.excluded, 1);
  assert.equal(defaultPacket.audit.counts.excludedByAction.exclude_do_not_use, 1);

  const explicitPacket = createClaimContextPacket([fixture], { limit: 10, includeFixtures: true });
  assert.equal(explicitPacket.included, 1);
  assert.equal(explicitPacket.items[0].id, 'claim_fixture_clean_packet_probe');
  assert.equal(explicitPacket.items[0].action, 'usable_with_qualification');
});

run('source handles are preserved but excerpts stay hidden by default', () => {
  const packet = createClaimContextPacket([stablePreference], { limit: 10 });
  assert.equal(packet.items[0].sources[0].handle, 'archive:2026-05-05:trail-guide:main#e0100');
  assert.equal(packet.items[0].sources[0].hasExcerpt, true);
  assert.equal(packet.items[0].sources[0].excerpt, undefined);

  const rendered = renderClaimContextPacket(packet);
  assert.match(rendered, /archive:2026-05-05:trail-guide:main#e0100/);
  assert.doesNotMatch(rendered, /CODE SESSION CONTEXT/);
});

run('source excerpts are opt-in at packet and render layers', () => {
  const packet = createClaimContextPacket([stablePreference], { includeSourceExcerpts: true });
  assert.match(packet.items[0].sources[0].excerpt, /CODE SESSION CONTEXT/);
  const rendered = renderClaimContextPacket(packet, { includeSourceExcerpts: true });
  assert.match(rendered, /CODE SESSION CONTEXT: Help directly/);
});

run('packet limit is bounded and reports omitted included claims', () => {
  const claims = [stablePreference, runtimeClaim, backfilledSummary];
  const packet = createClaimContextPacket(claims, { limit: 1 });
  assert.equal(packet.included, 1);
  assert.equal(packet.omitted, 2);
});

run('ranking prefers usable active high-confidence claims before verify-required pointers', () => {
  const packet = createClaimContextPacket([runtimeClaim, backfilledSummary, stablePreference], { limit: 2 });
  assert.equal(packet.items[0].id, 'claim_user_pref_direct');
  assert.equal(packet.items[0].action, 'usable_with_qualification');
  assert.equal(packet.items.every((item) => item.status !== CLAIM_STATUSES.STALE), true);
});

run('diversity caps prevent non-candidate handoff-derived cluster from filling preview packet', () => {
  const claims = [
    handoffClaim(1, { metadata: { candidateOnly: false } }),
    handoffClaim(2, { metadata: { candidateOnly: false } }),
    handoffClaim(3, { metadata: { candidateOnly: false } }),
    handoffClaim(4, { metadata: { candidateOnly: false } }),
    handoffClaim(5, { metadata: { candidateOnly: false } }),
    stablePreference,
    runtimeClaim,
    backfilledSummary
  ];
  const packet = createClaimContextPacket(claims, { limit: 8, maxHandoffClaims: 3, maxPerSourceType: 4, maxPerKind: 4 });
  const handoffItems = packet.items.filter((item) => item.sourceTypes.includes('handoff'));
  assert.equal(handoffItems.length, 3);
  assert.equal(packet.omittedByDiversity >= 2, true);
  assert.equal(packet.items.some((item) => item.id === 'claim_user_pref_direct'), true);
  const rendered = renderClaimContextPacket(packet);
  assert.match(rendered, /Omitted by diversity caps:/);
});


run('packet includes redacted operator audit without claim text or source handles', () => {
  const packet = createClaimContextPacket([stablePreference, runtimeClaim, retracted, stale], { limit: 10 });
  assert.equal(packet.audit.redacted, true);
  assert.equal(packet.audit.selected.length, 2);
  assert.equal(packet.audit.excluded.length, 2);
  assert.equal(packet.audit.counts.selectedByKind.user_preference, 1);
  assert.equal(packet.audit.counts.selectedByAction.verify_before_asserting, 1);
  assert.equal(packet.audit.counts.excludedByAction.exclude_do_not_use, 1);
  assert.equal(packet.audit.counts.excludedByAction.exclude_stale, 1);
  assert.equal(packet.audit.quality.verdict, 'clean');
  assert.equal(packet.audit.quality.readyForConsumptionTrial, true);
  assert.deepEqual(packet.audit.quality.issues, []);
  const report = renderClaimContextAudit(packet.audit);
  assert.match(report, /Claim Context Preview Audit/);
  assert.match(report, /Quality verdict: clean/);
  assert.match(report, /claim_user_pref_direct/);
  assert.doesNotMatch(report, /Chris prefers direct code-mode help/);
  assert.doesNotMatch(report, /archive:2026-05-05:trail-guide:main#e0100/);
  assert.doesNotMatch(report, /CODE SESSION CONTEXT/);
  assert.doesNotMatch(report, /gateway status output/);
});

run('quality assessment marks all-verification previews as review-required', () => {
  const packet = createClaimContextPacket([runtimeClaim, backfilledSummary], { limit: 10 });
  assert.equal(packet.audit.quality.verdict, 'review_required');
  assert.equal(packet.audit.quality.readyForConsumptionTrial, false);
  assert.match(packet.audit.quality.issues.join(','), /all_selected_claims_require_verification/);
  assert.match(packet.audit.quality.issues.join(','), /no_usable_qualified_claims_selected/);
  assert.match(packet.audit.quality.readinessRecommendations.join(','), /verify_or_supersede_selected_claims_before_consumption_trial/);
  assert.match(packet.audit.quality.readinessRecommendations.join(','), /include_at_least_one_usable_qualified_claim/);
  const report = renderClaimContextAudit(packet.audit);
  assert.match(report, /Ready for consumption trial: no/);
  assert.match(report, /Readiness guidance/);
  assert.match(report, /verify_or_supersede_selected_claims_before_consumption_trial/);
  assert.doesNotMatch(report, /Gateway is currently running under LaunchAgent ownership/);
  assert.doesNotMatch(report, /tool:session_abc#call7/);
});

run('quality assessment remains redacted and diagnostic only', () => {
  const quality = assessClaimContextQuality({
    selected: [createClaimContextPacket([stablePreference], { limit: 1 }).items[0]],
    excluded: [],
    omittedByDiversity: [],
    counts: { selectedByKind: { user_preference: 1 }, selectedByPrimarySourceType: { archive: 1 } }
  });
  assert.equal(quality.redacted, true);
  assert.equal(quality.readyForConsumptionTrial, true);
  assert.deepEqual(quality.readinessRecommendations, ['eligible_for_manual_consumption_trial_review_without_enabling_injection']);
  assert.match(quality.note, /does not authorize prompt injection/);
});

run('readiness guidance explains empty previews without claim details', () => {
  const packet = createClaimContextPacket([], { limit: 10 });
  assert.equal(packet.audit.quality.verdict, 'empty_preview');
  assert.deepEqual(packet.audit.quality.readinessRecommendations, ['add_source_addressable_claims_before_previewing_consumption']);
  const report = renderClaimContextAudit(packet.audit);
  assert.match(report, /add_source_addressable_claims_before_previewing_consumption/);
});

run('classifier treats missing diagnostics and do-not-use as excluded', () => {
  assert.deepEqual(classifyDiagnosticForContext({ ok: false }), { include: false, action: 'exclude_missing' });
  assert.deepEqual(classifyDiagnosticForContext({ ok: true, action: 'do_not_use' }), { include: false, action: 'exclude_do_not_use' });
  assert.deepEqual(classifyDiagnosticForContext({ ok: true, status: 'stale' }), { include: false, action: 'exclude_stale' });
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
  lines.push('# Claim Context Test Report');
  lines.push('');
  lines.push(`- PASS: ${pass}`);
  lines.push(`- FAIL: ${fail}`);
  lines.push(`- Total: ${results.length}`);
  lines.push('');
  lines.push('| Fixture | Status | Detail |');
  lines.push('|---|---:|---|');
  for (const result of results) lines.push(`| ${escapePipes(result.name)} | ${result.status} | ${escapePipes(result.detail || 'ok')} |`);
  lines.push('');

  const reportPath = path.join(__dirname, 'reports', 'claim-context.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

  console.log(`Claim context tests: PASS=${pass} FAIL=${fail}`);
  console.log(`Report: ${path.relative(process.cwd(), reportPath)}`);
  if (fail) {
    for (const r of results.filter((r) => r.status === 'FAIL')) console.error(`${r.name}: ${r.detail}`);
    process.exit(1);
  }
}

function escapePipes(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}
