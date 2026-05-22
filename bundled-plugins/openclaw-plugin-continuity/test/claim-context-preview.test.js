#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { createClaimContextPreview } = require('../lib/claim-context-preview');
const { CLAIM_KINDS, CLAIM_STATUSES, createClaimRecord } = require('../lib/claim-records');

const now = '2026-05-05T21:00:00.000Z';
const results = [];

const activeClaim = createClaimRecord({
  id: 'claim_preview_pref',
  agentId: 'trail-guide',
  threadId: 'main',
  kind: CLAIM_KINDS.USER_PREFERENCE,
  claim: 'Chris prefers direct code-mode help.',
  sources: [{
    handle: 'archive:2026-05-05:trail-guide:main#e0200',
    role: 'evidence',
    excerpt: 'CODE SESSION CONTEXT: Help directly.'
  }]
}, { now });

const runtimeClaim = createClaimRecord({
  id: 'claim_preview_runtime',
  agentId: 'trail-guide',
  threadId: 'main',
  kind: CLAIM_KINDS.RUNTIME,
  claim: 'Gateway is currently in a runtime mode.',
  sources: [{
    handle: 'tool:session_preview#call1',
    role: 'verification',
    excerpt: 'runtime output'
  }]
}, { now });


const candidateOnlyClaims = Array.from({ length: 12 }, (_, index) => createClaimRecord({
  id: `claim_preview_candidate_${index}`,
  agentId: 'trail-guide',
  threadId: 'main',
  kind: CLAIM_KINDS.SUMMARY,
  claim: `Candidate-only handoff note ${index}`,
  sources: [{
    handle: `handoff:2026-05-05:main#L${index + 1}-L${index + 1}`,
    role: 'origin'
  }],
  metadata: { candidateOnly: true }
}, { now }));

const retractedClaim = createClaimRecord({
  id: 'claim_preview_retracted',
  agentId: 'trail-guide',
  threadId: 'main',
  kind: CLAIM_KINDS.PROJECT_STATE,
  claim: 'Do not use this old state.',
  status: CLAIM_STATUSES.RETRACTED,
  sources: ['archive:2026-05-04:trail-guide:main#e0001']
}, { now });

run('preview is disabled by default and does not query store', () => {
  const result = createClaimContextPreview({
    config: { sourceAddressableMemory: { claimContext: { enabled: false } } },
    claimStore: { listClaims: () => { throw new Error('should not query disabled preview'); } }
  });
  assert.equal(result.enabled, false);
  assert.equal(result.injectionReady, false);
  assert.equal(result.reason, 'claimContext disabled');
  assert.equal(result.rendered, '');
});

run('preview refuses mode off and invalid live injection combinations', () => {
  const off = createClaimContextPreview({
    config: { sourceAddressableMemory: { claimContext: { enabled: true, mode: 'off', injectMode: 'none' } } },
    claimStore: new FakeClaimStore([activeClaim])
  });
  assert.equal(off.enabled, false);
  assert.equal(off.reason, 'claimContext mode is off');

  const previewMinimal = createClaimContextPreview({
    config: { sourceAddressableMemory: { claimContext: { enabled: true, mode: 'preview', injectMode: 'minimal' } } },
    claimStore: new FakeClaimStore([activeClaim])
  });
  assert.equal(previewMinimal.enabled, false);
  assert.equal(previewMinimal.reason, 'claimContext live injection requires mode=live');

  const invalid = createClaimContextPreview({
    config: { sourceAddressableMemory: { claimContext: { enabled: true, mode: 'live', injectMode: 'full' } } },
    claimStore: new FakeClaimStore([activeClaim])
  });
  assert.equal(invalid.enabled, false);
  assert.equal(invalid.reason, 'claimContext injectMode must be none or minimal');
});

run('enabled preview renders packet without making it injection-ready', () => {
  const result = createClaimContextPreview({
    config: { sourceAddressableMemory: { claimContext: { enabled: true, mode: 'preview', injectMode: 'none', maxClaims: 5 } } },
    agentId: 'trail-guide',
    threadId: 'main',
    claimStore: new FakeClaimStore([activeClaim, runtimeClaim, retractedClaim])
  });
  assert.equal(result.enabled, true);
  assert.equal(result.previewOnly, true);
  assert.equal(result.injectionReady, false);
  assert.equal(result.sourceResolutionAttempted, false);
  assert.equal(result.mutationAttempted, false);
  assert.equal(result.packet.included, 2);
  assert.equal(result.packet.excluded, 1);
  assert.match(result.rendered, /SOURCE-ADDRESSABLE CLAIM CONTEXT — READ ONLY/);
  assert.match(result.rendered, /claim_preview_pref/);
  assert.match(result.rendered, /claim_preview_runtime/);
  assert.doesNotMatch(result.rendered, /claim_preview_retracted/);
  assert.doesNotMatch(result.rendered, /CODE SESSION CONTEXT/);
  assert.doesNotMatch(result.rendered, /runtime output/);
});

run('live minimal mode only selects applied accept_verified claims and becomes injection-ready', () => {
  const acceptedClaim = {
    ...activeClaim,
    metadata: {
      ...(activeClaim.metadata || {}),
      candidateOnly: false,
      acceptedVerifiedAt: '2026-05-05T23:00:00.000Z',
      reviewDecisions: [{
        decision: 'accept_verified',
        applied: true,
        sourceHandle: 'archive:2026-05-05:trail-guide:main#e0200',
        verificationEvidence: {
          sourceResolved: true,
          comparisonAttempted: true,
          assessment: 'source_contains_claim_text',
          coverage: 1,
          exactPhrase: true
        }
      }]
    }
  };
  const result = createClaimContextPreview({
    config: { sourceAddressableMemory: { claimContext: { enabled: true, mode: 'live', injectMode: 'minimal', maxClaims: 5 } } },
    agentId: 'trail-guide',
    threadId: 'main',
    claimStore: new FakeClaimStore([activeClaim, acceptedClaim, runtimeClaim])
  });
  assert.equal(result.enabled, true);
  assert.equal(result.previewOnly, false);
  assert.equal(result.injectionReady, true);
  assert.equal(result.acceptedVerifiedOnly, true);
  assert.equal(result.packet.included, 1);
  assert.equal(result.packet.requiresVerification, 0);
  assert.match(result.rendered, /claim_preview_pref/);
  assert.doesNotMatch(result.rendered, /claim_preview_runtime/);
});

run('live minimal mode stays preview-only when no accepted verified claim is available', () => {
  const result = createClaimContextPreview({
    config: { sourceAddressableMemory: { claimContext: { enabled: true, mode: 'live', injectMode: 'minimal', maxClaims: 5 } } },
    agentId: 'trail-guide',
    threadId: 'main',
    claimStore: new FakeClaimStore([activeClaim, runtimeClaim])
  });
  assert.equal(result.enabled, true);
  assert.equal(result.previewOnly, true);
  assert.equal(result.injectionReady, false);
  assert.equal(result.packet.included, 0);
});



run('enabled preview scans beyond output limit so excluded candidates do not starve usable claims', () => {
  const result = createClaimContextPreview({
    config: { sourceAddressableMemory: { claimContext: { enabled: true, mode: 'diagnostic', injectMode: 'none', maxClaims: 2 } } },
    agentId: 'trail-guide',
    threadId: 'main',
    claimStore: new FakeClaimStore([...candidateOnlyClaims, activeClaim])
  });
  assert.equal(result.enabled, true);
  assert.equal(result.scanLimit, 100);
  assert.equal(result.packet.included, 1);
  assert.equal(result.packet.excluded, candidateOnlyClaims.length);
  assert.match(result.rendered, /claim_preview_pref/);
  assert.doesNotMatch(result.rendered, /Candidate-only handoff note/);
});

run('enabled preview returns a redacted audit report for operator review', () => {
  const result = createClaimContextPreview({
    config: { sourceAddressableMemory: { claimContext: { enabled: true, mode: 'preview', injectMode: 'none', maxClaims: 5 } } },
    agentId: 'trail-guide',
    threadId: 'main',
    claimStore: new FakeClaimStore([activeClaim, runtimeClaim, retractedClaim])
  });
  assert.equal(result.audit.redacted, true);
  assert.match(result.auditReport, /Claim Context Preview Audit/);
  assert.match(result.auditReport, /claim_preview_pref/);
  assert.doesNotMatch(result.auditReport, /Chris prefers direct code-mode help/);
  assert.doesNotMatch(result.auditReport, /archive:2026-05-05:trail-guide:main#e0200/);
  assert.doesNotMatch(result.auditReport, /CODE SESSION CONTEXT/);
  assert.doesNotMatch(result.auditReport, /runtime output/);
});

run('preview preserves source excerpts only by explicit config opt-in', () => {
  const result = createClaimContextPreview({
    config: { sourceAddressableMemory: { claimContext: { enabled: true, mode: 'preview', injectMode: 'none', includeSourceExcerpts: true } } },
    claimStore: new FakeClaimStore([activeClaim])
  });
  assert.match(result.rendered, /CODE SESSION CONTEXT: Help directly/);
});

run('preview returns disabled result when store is unavailable', () => {
  const result = createClaimContextPreview({
    config: { sourceAddressableMemory: { claimContext: { enabled: true, mode: 'preview', injectMode: 'none' } } }
  });
  assert.equal(result.enabled, false);
  assert.equal(result.reason, 'ClaimStore listClaims(filter) required');
});

function run(name, fn) {
  try {
    fn();
    results.push({ name, status: 'PASS', detail: 'ok' });
  } catch (err) {
    results.push({ name, status: 'FAIL', detail: err.message });
  }
}

function FakeClaimStore(claims) {
  this.claims = claims;
  this.listClaims = (filter = {}) => this.claims.filter((claim) => {
    if (filter.agentId && claim.agentId !== filter.agentId) return false;
    if (filter.threadId && claim.threadId !== filter.threadId) return false;
    return true;
  }).slice(0, filter.limit || 10).map((claim) => ({ ...claim, edges: [] }));
}

function writeReportAndExit() {
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.length - pass;
  const lines = [];
  lines.push('# Claim Context Preview Test Report');
  lines.push('');
  lines.push(`- PASS: ${pass}`);
  lines.push(`- FAIL: ${fail}`);
  lines.push(`- Total: ${results.length}`);
  lines.push('');
  lines.push('| Fixture | Status | Detail |');
  lines.push('|---|---:|---|');
  for (const result of results) lines.push(`| ${escapePipes(result.name)} | ${result.status} | ${escapePipes(result.detail || 'ok')} |`);
  lines.push('');

  const reportPath = path.join(__dirname, 'reports', 'claim-context-preview.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

  console.log(`Claim context preview tests: PASS=${pass} FAIL=${fail}`);
  console.log(`Report: ${path.relative(process.cwd(), reportPath)}`);
  if (fail) {
    for (const r of results.filter((r) => r.status === 'FAIL')) console.error(`${r.name}: ${r.detail}`);
    process.exit(1);
  }
}

function escapePipes(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

writeReportAndExit();
