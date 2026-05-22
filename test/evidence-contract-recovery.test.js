const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildEvidenceContract,
  buildRecoveryAttempt,
  classifyFailure,
  createRecoveryPacket,
  evaluateEvidenceContract,
  executeRecoveryAction,
  extractPathTargets,
  nextEvidenceAction,
  observationFromToolEvent,
  renderRecoveryFallbackDetails,
  runRecoveryStep,
} = require('../lib/evidence-contract-recovery');

test('buildEvidenceContract extracts explicit path targets and fresh verification pressure', () => {
  const contract = buildEvidenceContract('Please inspect `src/cli.js` and verify whether it is live/current.');
  assert.equal(contract.kind, 'openclaw_evidence_contract');
  assert.ok(contract.targets.some((target) => target.kind === 'path' && target.path === 'src/cli.js'));
  assert.ok(contract.targets.some((target) => target.kind === 'fresh_observation'));
});

test('extractPathTargets catches file-like and slash paths without prose', () => {
  assert.deepEqual(
    extractPathTargets('Focus on src/evidence-contract.js, README.md, and not ordinary words.'),
    ['src/evidence-contract.js', 'README.md']
  );
});

test('evaluateEvidenceContract distinguishes missing and partial observations', () => {
  const contract = buildEvidenceContract('Inspect src/cli.js');
  const missing = evaluateEvidenceContract(contract, []);
  assert.equal(missing.ok, false);
  assert.equal(missing.missing[0].path, 'src/cli.js');

  const partial = evaluateEvidenceContract(contract, [{
    action: { tool: 'read', path: 'src/cli.js', offset: 0 },
    result: { ok: true, path: 'src/cli.js', partial: true, truncated: true, nextOffset: 12000, totalChars: 48000, receipt: 'sha256:first' },
  }]);
  assert.equal(partial.ok, false);
  assert.equal(partial.partial[0].nextOffset, 12000);
  assert.deepEqual(partial.partial[0].receipts, ['sha256:first']);
});

test('partial targets require the exact next offset action', () => {
  const contract = buildEvidenceContract('Inspect src/cli.js');
  const coverage = evaluateEvidenceContract(contract, [{
    action: { tool: 'read', path: 'src/cli.js', offset: 0 },
    result: { ok: true, path: 'src/cli.js', truncated: true, nextOffset: 8000, totalChars: 20000 },
  }]);
  assert.deepEqual(nextEvidenceAction(coverage), {
    tool: 'read',
    path: 'src/cli.js',
    reason: 'inspect required path evidence before finalizing',
    offset: 8000,
  });
});

test('evaluateEvidenceContract recognizes complete chunked read coverage', () => {
  const contract = buildEvidenceContract('Inspect src/cli.js');
  const coverage = evaluateEvidenceContract(contract, [{
    action: { tool: 'read', path: 'src/cli.js', offset: 0 },
    result: { ok: true, path: 'src/cli.js', truncated: true, nextOffset: 8000, totalChars: 12000, receipt: 'sha256:a' },
  }, {
    action: { tool: 'read', path: 'src/cli.js', offset: 8000 },
    result: { ok: true, path: 'src/cli.js', partial: false, truncated: false, nextOffset: null, totalChars: 12000, receipt: 'sha256:b' },
  }]);
  assert.equal(coverage.ok, true);
  assert.equal(coverage.observed[0].status, 'observed');
});

test('createRecoveryPacket pins original task, failure class, and next smallest action', () => {
  const contract = buildEvidenceContract('Using tools only, inspect src/cli.js');
  const coverage = evaluateEvidenceContract(contract, [{
    action: { tool: 'read', path: 'src/cli.js', offset: 0 },
    result: { ok: true, path: 'src/cli.js', truncated: true, nextOffset: 8000, totalChars: 20000, receipt: 'sha256:read1' },
  }]);
  const packet = createRecoveryPacket({
    prompt: 'Using tools only, inspect src/cli.js and verify tests without restart',
    requestId: 'req1',
    sessionId: 'session1',
    evidenceContract: contract,
    coverage,
    observations: [],
    recoveryIndex: 1,
    workScope: {
      workingDirectory: '/repo',
      touchedFiles: ['src/cli.js'],
      boundaries: ['do not restart'],
      allowedRecoveryTools: ['read'],
    },
  });
  assert.equal(packet.kind, 'openclaw_evidence_recovery_packet');
  assert.equal(packet.failure.failureClass, 'partial_evidence');
  assert.equal(packet.failure.blockedClaim, 'all required evidence has been fully observed');
  assert.deepEqual(packet.workScope.touchedFiles, ['src/cli.js']);
  assert.equal(packet.currentState.lastResultStatus, 'none');
  assert.ok(packet.originalTask.requiredOutputs.includes('verification receipts'));
  assert.ok(packet.originalTask.nonGoals.includes('do not restart as part of recovery'));
  assert.equal(packet.nextSmallestAction.offset, 8000);
  assert.match(packet.packetHash, /^sha256:/);
});

test('buildRecoveryAttempt turns incomplete foreground evidence into a resumable recovery packet', () => {
  const attempt = buildRecoveryAttempt({
    prompt: 'Check whether this is live now',
    requestId: 'req2',
    forceToolEvidence: false,
    observations: [],
  });
  assert.equal(attempt.attempted, true);
  assert.equal(attempt.failureClass, 'missing_evidence');
  assert.equal(attempt.resumable, true);
  assert.equal(attempt.nextAction.tool, 'session_status');
});

test('tool events can be normalized into observations for fallback recovery metadata', () => {
  const observation = observationFromToolEvent({
    name: 'read',
    phase: 'done',
    args: { path: 'src/cli.js' },
    result: { path: 'src/cli.js', partial: true, nextOffset: 42, totalChars: 100 },
    receipt: 'sha256:event',
  });
  assert.equal(observation.action.path, 'src/cli.js');
  assert.equal(observation.result.nextOffset, 42);
  const contract = buildEvidenceContract('Inspect src/cli.js');
  const coverage = evaluateEvidenceContract(contract, [observation]);
  assert.equal(classifyFailure(coverage, [observation]), 'partial_evidence');
  assert.match(renderRecoveryFallbackDetails(buildRecoveryAttempt({ prompt: 'Inspect src/cli.js', observations: [observation] })), /nextOffset=42/);
});

test('executeRecoveryAction performs a bounded read-only receipt action inside allowed roots', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-recovery-'));
  fs.writeFileSync(path.join(dir, 'sample.txt'), '0123456789abcdef', 'utf8');
  const result = executeRecoveryAction(
    { tool: 'read', path: 'sample.txt', offset: 4 },
    { cwd: dir, maxOutput: 6, now: '2026-05-14T00:00:00.000Z' }
  );
  assert.equal(result.ok, true);
  assert.equal(result.output, '456789');
  assert.equal(result.offset, 4);
  assert.equal(result.nextOffset, 10);
  assert.equal(result.truncated, true);
  assert.match(result.receipt.event_hash, /^sha256:/);
});

test('executeRecoveryAction blocks reads outside the recovery allowlist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-recovery-'));
  const result = executeRecoveryAction(
    { tool: 'read', path: '/etc/passwd' },
    { cwd: dir, now: '2026-05-14T00:00:00.000Z' }
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'blocked_path');
});

test('runRecoveryStep executes the next partial-read action and updates coverage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-recovery-'));
  fs.writeFileSync(path.join(dir, 'big.txt'), 'abcdefghij', 'utf8');
  const firstObservation = {
    action: { tool: 'read', path: 'big.txt', offset: 0 },
    result: { ok: true, path: 'big.txt', offset: 0, partial: true, truncated: true, nextOffset: 5, totalChars: 10, receipt: 'sha256:first' },
  };
  const attempt = runRecoveryStep({
    prompt: 'Inspect big.txt',
    observations: [firstObservation],
    executorOptions: { cwd: dir, maxOutput: 10, now: '2026-05-14T00:00:00.000Z' },
  });
  assert.equal(attempt.attempted, true);
  assert.equal(attempt.nextAction.tool, 'read');
  assert.equal(attempt.nextAction.offset, 5);
  assert.equal(attempt.recoveryResult.ok, true);
  assert.equal(attempt.recoveryResult.output, 'fghij');
  assert.equal(attempt.recovered, true);
  assert.equal(attempt.coverageAfterRecovery.ok, true);
});
