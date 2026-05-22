#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { createCandidateResearchReport } = require('../lib/candidate-research-diagnostics');
const fixture = require('./fixtures/candidate-research-field.json');

const results = [];
const allClaims = fixture.cases.flatMap((item) => item.claims);
const allEdges = fixture.cases.flatMap((item) => item.edges || []);

run('diagnostic report is read-only and preserves candidate-only records', () => {
  const before = JSON.stringify(allClaims);
  const report = createReport('map');
  assert.equal(JSON.stringify(allClaims), before);
  assert.equal(report.safetyCounters.claimsRead, allClaims.length);
  assert.equal(report.safetyCounters.candidateOnlyRead, allClaims.length);
  assert.equal(report.safetyCounters.claimsMutated, 0);
  assert.equal(report.safetyCounters.claimsPromoted, 0);
  assert.equal(report.safetyCounters.promptInjectionWrites, 0);
  assert.equal(report.safetyCounters.synthesisRecordsWritten, 0);
  assert.equal(report.safetyCounters.trustedContextCandidates, 0);
  assert.equal(report.safetyCounters.mutationAttempted, false);
  assert.equal(report.safetyCounters.sourceResolutionAttempted, false);
  assert.ok(report.signalProfiles.every((profile) => profile.candidateOnly === true));
});

run('every surfaced profile relationship cluster tension and readiness item includes source handles or candidate ids', () => {
  const report = createReport('map');
  assert.ok(report.signalProfiles.every((profile) => Array.isArray(profile.sourceHandles) && profile.sourceHandles.length > 0));
  assert.ok(report.relationships.every((rel) => Array.isArray(rel.sourceHandles) && rel.sourceHandles.length > 0));
  assert.ok(report.clusters.every((cluster) => Array.isArray(cluster.memberCandidateIds) && cluster.memberCandidateIds.length > 0));
  assert.ok(report.tensions.every((tension) => Array.isArray(tension.sourceHandles) && tension.sourceHandles.length > 0));
  assert.ok(report.verificationReady.every((item) => Array.isArray(item.sourceHandles) && item.sourceHandles.length > 0));
});

run('duplicate project-state candidates are detected without making them assertion-ready', () => {
  const report = createReport('map');
  const duplicate = findRelationship(report, 'cr_dup_project_a', 'cr_dup_project_b');
  assert.equal(duplicate.relation, 'duplicates');
  assert.ok(duplicate.reasons.includes('high_lexical_overlap'));
  assert.equal(profile(report, 'cr_dup_project_a').assertionUse, 'requires_live_verification');
  assert.equal(profile(report, 'cr_dup_project_b').assertionUse, 'requires_live_verification');
});

run('source-collapsed candidates keep low diversity and do not become verification-ready', () => {
  const report = createReport('map');
  const collapsed = ['cr_collapse_a', 'cr_collapse_b', 'cr_collapse_c'].map((id) => profile(report, id));
  assert.ok(collapsed.every((item) => item.signalVector.sourceDiversity <= 0.34));
  assert.ok(report.clusters.some((cluster) => cluster.memberCandidateIds.includes('cr_collapse_a') && cluster.warnings.includes('source_collapse')));
  assert.ok(!report.verificationReady.some((item) => item.candidateId.startsWith('cr_collapse_')));
});

run('stale runtime recurrence remains high research interest but low assertion readiness', () => {
  const report = createReport('stale-risk');
  const stale = profile(report, 'cr_stale_runtime');
  assert.ok(stale.signalVector.recurrence >= 0.8);
  assert.ok(stale.signalVector.staleRisk >= 0.75);
  assert.equal(stale.assertionUse, 'requires_live_verification');
  assert.ok(report.decayRecommendations.some((item) => item.candidateId === 'cr_stale_runtime'));
  assert.ok(!report.verificationReady.some((item) => item.candidateId === 'cr_stale_runtime'));
});

run('productive contradiction is preserved as a tension instead of selecting a side', () => {
  const report = createReport('map');
  const tension = report.tensions.find((item) => item.candidateIds.includes('cr_tension_a') && item.candidateIds.includes('cr_tension_b'));
  assert.ok(tension);
  assert.equal(tension.type, 'contradiction');
  assert.equal(tension.whatWouldResolveIt, 'verify_current_git_and_remote_state');
  assert.equal(profile(report, 'cr_tension_a').signalVector.tensionInterest, 1);
  assert.equal(profile(report, 'cr_tension_b').signalVector.tensionInterest, 1);
});

run('creative mode labels weak creative signals as exploratory and forbidden for assertion', () => {
  const report = createReport('creative');
  const creative = profile(report, 'cr_creative_weak');
  assert.equal(creative.creativeLabel, 'design hypothesis');
  assert.equal(creative.assertionUse, 'forbidden');
  assert.ok(report.creativeOpportunities.some((item) => item.candidateId === 'cr_creative_weak' && item.label === 'design hypothesis'));
});

run('broad identity claim does not become verification-ready through recurrence', () => {
  const report = createReport('verification');
  const broad = profile(report, 'cr_broad_identity');
  assert.equal(broad.beliefReadiness, 'not_eligible');
  assert.ok(broad.warnings.includes('identity_review_required'));
  assert.ok(broad.warnings.includes('broad_claim'));
  assert.ok(!report.verificationReady.some((item) => item.candidateId === 'cr_broad_identity'));
});

run('narrow source-backed claim is listed as verification-ready', () => {
  const report = createReport('verification');
  const ready = report.verificationReady.find((item) => item.candidateId === 'cr_verify_narrow');
  assert.ok(ready);
  assert.equal(ready.recommendedClaimText, 'The pure diagnostic module target is bundled-plugins/openclaw-plugin-continuity/lib/candidate-research-diagnostics.js.');
  assert.ok(ready.readinessReasons.includes('has_source_handle'));
  assert.deepEqual(ready.unresolvedRisks, []);
});

run('ambiguous cluster labels remain provisional and include alternates', () => {
  const report = createReport('map');
  const cluster = report.clusters.find((item) => item.memberCandidateIds.includes('cr_ambiguous_a') && item.memberCandidateIds.includes('cr_ambiguous_b'));
  assert.ok(cluster);
  assert.match(cluster.provisionalLabel, /candidates$/);
  assert.ok(cluster.alternateLabels.length > 0);
  assert.ok(cluster.alternateLabels.includes('evidence before meaning') || cluster.alternateLabels.includes('diagnostic reports'));
});

writeReportAndExit();

function createReport(mode) {
  return createCandidateResearchReport({
    claims: allClaims,
    edges: allEdges,
    mode,
    now: fixture.now,
    agentId: fixture.agentId,
    threadId: fixture.threadId
  });
}

function profile(report, id) {
  const found = report.signalProfiles.find((item) => item.candidateId === id);
  assert.ok(found, `missing profile: ${id}`);
  return found;
}

function findRelationship(report, a, b) {
  const found = report.relationships.find((item) => {
    const ids = [item.fromCandidateId, item.toCandidateId];
    return ids.includes(a) && ids.includes(b);
  });
  assert.ok(found, `missing relationship: ${a}/${b}`);
  return found;
}

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
  lines.push('# Candidate Research Diagnostics Test Report');
  lines.push('');
  lines.push(`- PASS: ${pass}`);
  lines.push(`- FAIL: ${fail}`);
  lines.push(`- Total: ${results.length}`);
  lines.push('');
  lines.push('| Fixture | Status | Detail |');
  lines.push('|---|---:|---|');
  for (const result of results) lines.push(`| ${escapePipes(result.name)} | ${result.status} | ${escapePipes(result.detail || 'ok')} |`);
  lines.push('');

  const reportPath = path.join(__dirname, 'reports', 'candidate-research-diagnostics.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

  console.log(`Candidate research diagnostics tests: PASS=${pass} FAIL=${fail}`);
  console.log(`Report: ${path.relative(process.cwd(), reportPath)}`);
  if (fail) {
    for (const r of results.filter((r) => r.status === 'FAIL')) console.error(`${r.name}: ${r.detail}`);
    process.exit(1);
  }
}

function escapePipes(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}
