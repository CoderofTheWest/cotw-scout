const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  assertSafeDetachedRestartScript,
  buildContinuationMessage,
  buildRestartProofHarnessPlan,
  requireCanonicalSessionKey,
} = require('../lib/restart-proof-harness');

test('requireCanonicalSessionKey accepts only canonical agent session keys', () => {
  assert.equal(
    requireCanonicalSessionKey('agent:trail-guide:openai:session_123'),
    'agent:trail-guide:openai:session_123',
  );
  assert.throws(() => requireCanonicalSessionKey('session_123'), /canonical agent session key/);
  assert.throws(() => requireCanonicalSessionKey(''), /sessionKey is required/);
});

test('continuation message is bounded and checks the requested proof surfaces', () => {
  const message = buildContinuationMessage({
    probeId: 'restart-proof-test',
    sessionKey: 'agent:trail-guide:openai:session_123',
    resultPath: '/tmp/restart-continuation-result.json',
    previousResultMtimeMs: 100,
    electronPids: [111, 222],
  });

  assert.match(message, /RESTART_PROOF_HARNESS restart-proof-test/);
  assert.match(message, /Use at most 4 tool calls/);
  assert.match(message, /canonical session key is exactly: agent:trail-guide:openai:session_123/);
  assert.match(message, /mtime greater than 100/);
  assert.match(message, /111, 222/);
  assert.match(message, /GUI reattached \/ this continuation visible/);
});

test('safe script guard rejects opportunistic process killing', () => {
  assert.equal(assertSafeDetachedRestartScript('openclaw gateway restart --json'), true);
  assert.throws(() => assertSafeDetachedRestartScript('lsof -ti :18789 | xargs kill -9'), /unsafe script token/);
  assert.throws(() => assertSafeDetachedRestartScript('killPid(pid, \'SIGKILL\')'), /unsafe script token/);
});

test('dry-run restart proof harness builds safe detached restart plan without writing state', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-proof-harness-'));
  try {
    const result = await buildRestartProofHarnessPlan({
      probeId: 'restart-proof-test',
      stateDir,
      openclawBin: '/tmp/openclaw',
      sessionKey: 'agent:trail-guide:openai:session_123',
      electronPids: [1234],
      port: 9,
    });

    assert.equal(result.ok, true);
    assert.equal(result.mode, 'dry-run');
    assert.equal(result.safety.safeScript, true);
    assert.equal(result.safety.noInlineKill, true);
    assert.deepEqual(result.safety.electronPids, [1234]);
    assert.equal(result.preflight.sessionKey, 'agent:trail-guide:openai:session_123');
    assert.match(result.restart.script, /gateway restart --wait '30s' --json/);
    assert.match(result.restart.script, /gateway call agent/);
    assert.doesNotMatch(result.restart.script, /lsof -ti|SIGKILL|SIGTERM|\bkill\b|pkill|killall/);
    assert.equal(fs.existsSync(path.join(stateDir, 'restart-sentinel.json')), false);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
