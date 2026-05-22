#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { runClaimsDiagnosticsCommand, parseClaimsDiagnosticsArgs } = require('../lib/claim-diagnostics-command');
const { CLAIM_KINDS, CLAIM_STATUSES, FRESHNESS_POLICIES, createClaimRecord } = require('../lib/claim-records');

const now = '2026-05-05T14:30:00.000Z';
const results = [];

const activeClaim = createClaimRecord({
  id: 'claim_active_preference',
  agentId: 'trail-guide',
  threadId: 'main',
  kind: CLAIM_KINDS.USER_PREFERENCE,
  claim: 'Chris prefers patient, direct build work.',
  sources: [{
    handle: 'archive:2026-05-05:trail-guide:main#e0015',
    role: 'evidence',
    excerpt: 'I am not in a hurry.',
    quoteHash: 'hash_active'
  }]
}, { now });


const candidateOnlyClaims = Array.from({ length: 12 }, (_, index) => createClaimRecord({
  id: `claim_command_candidate_${index}`,
  agentId: 'trail-guide',
  threadId: 'main',
  kind: CLAIM_KINDS.SUMMARY,
  claim: `Candidate-only command note ${index}`,
  sources: [{
    handle: `handoff:2026-05-05:main#L${index + 1}-L${index + 1}`,
    role: 'origin'
  }],
  metadata: { candidateOnly: true }
}, { now }));

const runtimeClaim = createClaimRecord({
  id: 'claim_runtime_mode',
  agentId: 'trail-guide',
  threadId: 'ops',
  kind: CLAIM_KINDS.RUNTIME,
  claim: 'Gateway is in a specific runtime mode.',
  sources: [{
    handle: 'tool:session_abc#call9',
    role: 'verification',
    excerpt: 'gateway status output',
    quoteHash: 'hash_runtime'
  }]
}, { now });

const supersededClaim = createClaimRecord({
  id: 'claim_old_state',
  agentId: 'trail-guide',
  threadId: 'ops',
  kind: CLAIM_KINDS.PROJECT_STATE,
  claim: 'Old state should not be used.',
  status: CLAIM_STATUSES.SUPERSEDED,
  sources: ['archive:2026-05-04:trail-guide:ops#e0001']
}, { now });

const fixtureClaim = createClaimRecord({
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


const activeCandidateClaim = createClaimRecord({
  id: 'claim_candidate_active_design_signal',
  agentId: 'trail-guide',
  threadId: 'main',
  kind: CLAIM_KINDS.INTERPRETATION,
  claim: 'Build 6 may use candidate-only diagnostics as a creative research map.',
  sources: [{
    handle: 'archive:2026-05-05:trail-guide:main#e0021',
    role: 'origin',
    excerpt: 'raw candidate note that must not be resolved by the report',
    quoteHash: 'hash_candidate_active'
  }],
  metadata: { candidateOnly: true }
}, { now });

const verifyRequiredCandidateClaim = createClaimRecord({
  id: 'claim_candidate_verify_specific',
  agentId: 'trail-guide',
  threadId: 'main',
  kind: CLAIM_KINDS.PROJECT_STATE,
  claim: 'Candidate research diagnostics currently expose a read-only operator report path.',
  status: CLAIM_STATUSES.VERIFY_REQUIRED,
  confidence: 0.74,
  sources: [{
    handle: 'commit:ccb3ea9#bundled-plugins/openclaw-plugin-continuity/lib/candidate-research-diagnostics.js',
    role: 'evidence',
    excerpt: 'source excerpt should stay hidden unless a future action explicitly opts in',
    quoteHash: 'hash_candidate_verify'
  }]
}, { now });

const staleCandidateClaim = createClaimRecord({
  id: 'claim_candidate_stale_runtime',
  agentId: 'trail-guide',
  threadId: 'ops',
  kind: CLAIM_KINDS.RUNTIME,
  claim: 'Gateway runtime diagnostics were last checked during a previous build slice.',
  status: CLAIM_STATUSES.STALE,
  stalenessPolicy: FRESHNESS_POLICIES.RUNTIME_CHECK_REQUIRED,
  sources: [{
    handle: 'tool:session_previous#call13',
    role: 'verification',
    excerpt: 'runtime excerpt should not be shown',
    quoteHash: 'hash_candidate_stale'
  }]
}, { now });

async function main() {
  await run('default command action is stats', async () => {
    const text = await runClaimsDiagnosticsCommand(commandContext({ args: '' }));
    assert.match(text, /Claim stats for trail-guide:/);
    assert.match(text, /- total: 3/);
    assert.match(text, /- sources: 3/);
  });

  await run('list action returns compact claim diagnostics without source handles or excerpts', async () => {
    const text = await runClaimsDiagnosticsCommand(commandContext({ args: 'list --limit 2' }));
    assert.match(text, /Claim diagnostics: 2 claim\(s\)/);
    assert.match(text, /claim:/);
    assert.match(text, /sources: 1 source\(s\), hidden by default/);
    assert.doesNotMatch(text, /archive:2026-05-05/);
    assert.doesNotMatch(text, /gateway status output/);
    assert.doesNotMatch(text, /I am not in a hurry/);
  });

  await run('verify action is read-only and returns only verification-required claims', async () => {
    const text = await runClaimsDiagnosticsCommand(commandContext({ args: 'verify --limit 10' }));
    assert.match(text, /Claims requiring verification: 2 claim\(s\)/);
    assert.match(text, /claim_runtime_mode/);
    assert.match(text, /claim_old_state/);
    assert.doesNotMatch(text, /claim_active_preference/);
  });

  await run('command refuses source excerpt and metadata flags', async () => {
    const text = await runClaimsDiagnosticsCommand(commandContext({ args: 'list --sources' }));
    assert.match(text, /Source flags, source excerpts, and metadata are intentionally unavailable/);
  });

  await run('context action renders safe source-handle packet without source excerpts', async () => {
    const text = await runClaimsDiagnosticsCommand(commandContext({ args: 'context --limit 10' }));
    assert.match(text, /SOURCE-ADDRESSABLE CLAIM CONTEXT — READ ONLY/);
    assert.match(text, /claim_active_preference/);
    assert.match(text, /claim_runtime_mode/);
    assert.doesNotMatch(text, /claim_old_state/);
    assert.match(text, /archive:2026-05-05:trail-guide:main#e0015/);
    assert.match(text, /tool:session_abc#call9/);
    assert.match(text, /requiresVerification: true/);
    assert.doesNotMatch(text, /I am not in a hurry/);
    assert.doesNotMatch(text, /gateway status output/);
  });



  await run('context action scans beyond output limit so excluded candidates do not starve useful claims', async () => {
    const text = await runClaimsDiagnosticsCommand(commandContext({
      args: 'context --limit 2',
      claims: [...candidateOnlyClaims, activeClaim]
    }));
    assert.match(text, /Included: 1\/13/);
    assert.match(text, /claim_active_preference/);
    assert.doesNotMatch(text, /Candidate-only command note/);
  });

  await run('audit action renders redacted operator audit without claim text or source handles', async () => {
    const text = await runClaimsDiagnosticsCommand(commandContext({ args: 'audit --limit 10' }));
    assert.match(text, /Claim Context Preview Audit/);
    assert.match(text, /claim_active_preference/);
    assert.match(text, /claim_runtime_mode/);
    assert.match(text, /claim_old_state/);
    assert.match(text, /Redacted: yes/);
    assert.doesNotMatch(text, /Chris prefers patient, direct build work/);
    assert.doesNotMatch(text, /Gateway is in a specific runtime mode/);
    assert.doesNotMatch(text, /archive:2026-05-05:trail-guide:main#e0015/);
    assert.doesNotMatch(text, /tool:session_abc#call9/);
    assert.doesNotMatch(text, /I am not in a hurry/);
    assert.doesNotMatch(text, /gateway status output/);
  });

  await run('trial action renders redacted manual trial plan without source handles', async () => {
    const text = await runClaimsDiagnosticsCommand(commandContext({ args: 'trial --limit 10' }));
    assert.match(text, /Claim Context Manual Trial Plan/);
    assert.match(text, /Decision:/);
    assert.match(text, /Injection ready: no/);
    assert.match(text, /Consumption attempted: no/);
    assert.doesNotMatch(text, /Chris prefers patient, direct build work/);
    assert.doesNotMatch(text, /Gateway is in a specific runtime mode/);
    assert.doesNotMatch(text, /archive:2026-05-05:trail-guide:main#e0015/);
    assert.doesNotMatch(text, /tool:session_abc#call9/);
  });

  await run('verification action renders redacted verification plan without source handles', async () => {
    const text = await runClaimsDiagnosticsCommand(commandContext({ args: 'verification --limit 10' }));
    assert.match(text, /Claim Context Verification Plan/);
    assert.match(text, /Verification attempted: no/);
    assert.match(text, /Promotion attempted: no/);
    assert.doesNotMatch(text, /Chris prefers patient, direct build work/);
    assert.doesNotMatch(text, /Gateway is in a specific runtime mode/);
    assert.doesNotMatch(text, /archive:2026-05-05:trail-guide:main#e0015/);
    assert.doesNotMatch(text, /tool:session_abc#call9/);
  });

  await run('preflight action renders redacted bundled operator receipt', async () => {
    const text = await runClaimsDiagnosticsCommand(commandContext({ args: 'preflight --limit 10' }));
    assert.match(text, /Claim Context Preflight/);
    assert.match(text, /Decision:/);
    assert.match(text, /Injection ready: no/);
    assert.match(text, /Consumption attempted: no/);
    assert.doesNotMatch(text, /Chris prefers patient, direct build work/);
    assert.doesNotMatch(text, /Gateway is in a specific runtime mode/);
    assert.doesNotMatch(text, /archive:2026-05-05:trail-guide:main#e0015/);
    assert.doesNotMatch(text, /tool:session_abc#call9/);
  });

  await run('review action blocks mixed packets and stays redacted', async () => {
    const text = await runClaimsDiagnosticsCommand(commandContext({ args: 'review --limit 10' }));
    assert.match(text, /Claim Context Manual Review Packet/);
    assert.match(text, /Decision: blocked_by_preflight/);
    assert.match(text, /Manual review prepared: no/);
    assert.match(text, /Injection ready: no/);
    assert.match(text, /Consumption attempted: no/);
    assert.doesNotMatch(text, /Chris prefers patient, direct build work/);
    assert.doesNotMatch(text, /Gateway is in a specific runtime mode/);
    assert.doesNotMatch(text, /archive:2026-05-05:trail-guide:main#e0015/);
    assert.doesNotMatch(text, /tool:session_abc#call9/);
  });

  await run('review action can prepare a clean narrow packet without source excerpts', async () => {
    const text = await runClaimsDiagnosticsCommand(commandContext({ args: 'review --kind user_preference --limit 10' }));
    assert.match(text, /Claim Context Manual Review Packet/);
    assert.match(text, /Decision: ready_for_operator_review/);
    assert.match(text, /Manual review prepared: yes/);
    assert.match(text, /Injection ready: no/);
    assert.match(text, /Consumption attempted: no/);
    assert.match(text, /Chris prefers patient, direct build work/);
    assert.match(text, /archive:2026-05-05:trail-guide:main#e0015/);
    assert.doesNotMatch(text, /I am not in a hurry/);
  });

  await run('review action excludes fixture-only claims unless explicitly included', async () => {
    const withoutFlag = await runClaimsDiagnosticsCommand(commandContext({
      args: 'review --kind summary --limit 10',
      claims: [fixtureClaim]
    }));
    assert.match(withoutFlag, /Manual review prepared: no/);
    assert.doesNotMatch(withoutFlag, /Fixture proves manual review/);

    const withFlag = await runClaimsDiagnosticsCommand(commandContext({
      args: 'review --kind summary --include-fixtures --limit 10',
      claims: [fixtureClaim]
    }));
    assert.match(withFlag, /Manual review prepared: yes/);
    assert.match(withFlag, /Fixture proves manual review/);
  });


  await run('research action loads candidate-only verify-required and stale claims without active claim noise', async () => {
    const text = await runClaimsDiagnosticsCommand(commandContext({
      args: 'research --limit 10',
      claims: [activeClaim, activeCandidateClaim, verifyRequiredCandidateClaim, staleCandidateClaim, supersededClaim]
    }));
    assert.match(text, /Candidate Research Diagnostics — READ ONLY/);
    assert.match(text, /claimsRead: 3/);
    assert.match(text, /candidateOnlyRead: 1/);
    assert.match(text, /claim_candidate_active_design_signal/);
    assert.match(text, /claim_candidate_verify_specific/);
    assert.match(text, /claim_candidate_stale_runtime/);
    assert.doesNotMatch(text, /claim_active_preference/);
    assert.doesNotMatch(text, /claim_old_state/);
  });

  await run('research action stays read-only and does not resolve source excerpts', async () => {
    const store = new FakeClaimStore([activeCandidateClaim, verifyRequiredCandidateClaim]);
    const text = await runClaimsDiagnosticsCommand({
      args: 'research --mode verification --limit 10',
      getCurrentAgentId: () => 'trail-guide',
      getAgentState: () => ({ ensureStorage: async () => {}, claimStore: store })
    });
    assert.match(text, /mode: verification/);
    assert.match(text, /claimsMutated: 0/);
    assert.match(text, /claimsPromoted: 0/);
    assert.match(text, /promptInjectionWrites: 0/);
    assert.match(text, /sourceResolutionAttempted: false/);
    assert.match(text, /archive:2026-05-05:trail-guide:main#e0021/);
    assert.match(text, /commit:ccb3ea9#bundled-plugins/);
    assert.doesNotMatch(text, /raw candidate note that must not be resolved/);
    assert.doesNotMatch(text, /source excerpt should stay hidden/);
    assert.equal(store.mutationAttempts, 0);
  });

  await run('research action handles empty stores cleanly', async () => {
    const text = await runClaimsDiagnosticsCommand(commandContext({ args: 'research --limit 10', claims: [] }));
    assert.match(text, /Candidate Research Diagnostics — READ ONLY/);
    assert.match(text, /claimsRead: 0/);
    assert.match(text, /candidateOnlyRead: 0/);
    assert.match(text, /Verification ready: 0/);
    assert.match(text, /Signal profiles: 0/);
  });

  await run('command rejects invalid status and kind filters before querying', async () => {
    const invalidStatus = await runClaimsDiagnosticsCommand(commandContext({ args: 'list --status imaginary' }));
    assert.match(invalidStatus, /Unsupported status "imaginary"/);
    assert.doesNotMatch(invalidStatus, /Claim diagnostics:/);

    const invalidKind = await runClaimsDiagnosticsCommand(commandContext({ args: 'list --kind folklore' }));
    assert.match(invalidKind, /Unsupported kind "folklore"/);
    assert.doesNotMatch(invalidKind, /Claim diagnostics:/);
  });

  await run('command rejects dangling value flags instead of treating them as empty filters', async () => {
    const text = await runClaimsDiagnosticsCommand(commandContext({ args: 'list --text --limit 2' }));
    assert.match(text, /Option "--text" requires a value/);
    assert.doesNotMatch(text, /Claim diagnostics:/);
  });

  await run('command rejects invalid numeric filters before querying', async () => {
    const limit = await runClaimsDiagnosticsCommand(commandContext({ args: 'list --limit many' }));
    assert.match(limit, /Option "--limit" requires an integer value/);

    const confidence = await runClaimsDiagnosticsCommand(commandContext({ args: 'list --min-confidence 2' }));
    assert.match(confidence, /Option "--min-confidence" requires a number between 0 and 1/);
  });

  await run('command reports inert default when ClaimStore is unavailable', async () => {
    const text = await runClaimsDiagnosticsCommand({
      args: 'stats',
      getCurrentAgentId: () => 'trail-guide',
      getAgentState: () => ({ ensureStorage: async () => {} })
    });
    assert.match(text, /ClaimStore is not initialized/);
    assert.match(text, /Runtime defaults may still be inert/);
  });

  await run('argument parser keeps the exposed workflow to stats list verify context audit trial verification preflight review research', () => {
    assert.equal(parseClaimsDiagnosticsArgs('stats').action, 'stats');
    assert.equal(parseClaimsDiagnosticsArgs('context').action, 'context');
    assert.equal(parseClaimsDiagnosticsArgs('audit').action, 'audit');
    assert.equal(parseClaimsDiagnosticsArgs('trial').action, 'trial');
    assert.equal(parseClaimsDiagnosticsArgs('verification').action, 'verification');
    assert.equal(parseClaimsDiagnosticsArgs('preflight').action, 'preflight');
    assert.equal(parseClaimsDiagnosticsArgs('review').action, 'review');
    assert.equal(parseClaimsDiagnosticsArgs('research').action, 'research');
    assert.equal(parseClaimsDiagnosticsArgs('research --mode verification').mode, 'verification');
    assert.equal(parseClaimsDiagnosticsArgs('list --text "gateway mode"').text, 'gateway mode');
    assert.equal(parseClaimsDiagnosticsArgs('list --status active').status, 'active');
    assert.equal(parseClaimsDiagnosticsArgs('list --kind runtime').kind, 'runtime');
    assert.equal(parseClaimsDiagnosticsArgs('verify --limit 100').limit, 25);
    assert.equal(parseClaimsDiagnosticsArgs('audit --limit 2 --scan-limit 200').scanLimit, 200);
    assert.equal(parseClaimsDiagnosticsArgs('audit --scan-limit 1000').scanLimit, 500);
    assert.match(parseClaimsDiagnosticsArgs('research --mode unsafe').parseError, /Unsupported research mode/);
    assert.match(parseClaimsDiagnosticsArgs('record').parseError, /Unsupported action/);
  });

  writeReportAndExit();
}

function commandContext({ args, claims }) {
  const store = new FakeClaimStore(claims || [activeClaim, runtimeClaim, supersededClaim]);
  return {
    args,
    getCurrentAgentId: () => 'trail-guide',
    getAgentState: () => ({
      ensureStorage: async () => {},
      claimStore: store
    })
  };
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
  lines.push('# Claim Diagnostics Command Test Report');
  lines.push('');
  lines.push(`- PASS: ${pass}`);
  lines.push(`- FAIL: ${fail}`);
  lines.push(`- Total: ${results.length}`);
  lines.push('');
  lines.push('| Fixture | Status | Detail |');
  lines.push('|---|---:|---|');
  for (const result of results) lines.push(`| ${escapePipes(result.name)} | ${result.status} | ${escapePipes(result.detail || 'ok')} |`);
  lines.push('');

  const reportPath = path.join(__dirname, 'reports', 'claim-diagnostics-command.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

  console.log(`Claim diagnostics command tests: PASS=${pass} FAIL=${fail}`);
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

  getStats(agentId = null) {
    const claims = this.listClaims({ agentId });
    return {
      total: claims.length,
      sourceCount: claims.reduce((count, claim) => count + (claim.sources?.length || 0), 0),
      edgeCount: claims.reduce((count, claim) => count + (claim.edges?.length || 0), 0),
      byStatus: countBy(claims, 'status'),
      byKind: countBy(claims, 'kind')
    };
  }

  listClaims(filter = {}) {
    return this.claims.filter((claim) => {
      if (filter.agentId && claim.agentId !== filter.agentId) return false;
      if (filter.threadId && claim.threadId !== filter.threadId) return false;
      if (filter.kind && claim.kind !== filter.kind) return false;
      if (filter.status && claim.status !== filter.status) return false;
      if (Number.isFinite(filter.minConfidence) && claim.confidence < filter.minConfidence) return false;
      if (filter.text && !claim.claim.toLowerCase().includes(String(filter.text).toLowerCase())) return false;
      return true;
    }).slice(0, filter.limit || 10);
  }

  getClaimsNeedingVerification(filter = {}) {
    return this.listClaims(filter).filter((claim) => {
      return claim.status === CLAIM_STATUSES.SUPERSEDED ||
        claim.status === CLAIM_STATUSES.RETRACTED ||
        claim.status === CLAIM_STATUSES.STALE ||
        claim.status === CLAIM_STATUSES.VERIFY_REQUIRED ||
        claim.freshness?.stalenessPolicy === 'runtime_check_required' ||
        claim.freshness?.stalenessPolicy === 'verify_before_asserting';
    });
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

function countBy(items, key) {
  return items.reduce((acc, item) => {
    acc[item[key]] = (acc[item[key]] || 0) + 1;
    return acc;
  }, {});
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
