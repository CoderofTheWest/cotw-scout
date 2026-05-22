const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  RESTART_SENTINEL_FILENAME,
  RESTART_CONTINUATION_RESULT_FILENAME,
  buildAgentContinuationShellSnippet,
  buildRestartSentinelPayload,
  buildRestartShellScript,
  resolveAgentCliAgentId,
  resolveAgentCliSessionId,
  resolveAgentContinuationParams,
  resolveRestartSentinelPath,
  resolveRestartContinuationResultPath,
  scheduleGatewayServiceRestart,
} = require('../lib/gateway-service-restart-continuation');

test('resolveRestartSentinelPath resolves inside the OpenClaw state dir', () => {
  const stateDir = path.join(os.tmpdir(), 'openclaw-state');
  assert.equal(resolveRestartSentinelPath(stateDir), path.join(stateDir, RESTART_SENTINEL_FILENAME));
});

test('resolveRestartContinuationResultPath resolves inside the OpenClaw state dir', () => {
  const stateDir = path.join(os.tmpdir(), 'openclaw-state');
  assert.equal(resolveRestartContinuationResultPath(stateDir), path.join(stateDir, RESTART_CONTINUATION_RESULT_FILENAME));
});

test('buildRestartSentinelPayload requires a session key for continuation', () => {
  assert.throws(() => buildRestartSentinelPayload({ continuationMessage: 'continue' }), /sessionKey is required/);
});

test('buildRestartSentinelPayload defaults to agent-cli continuation delivery', () => {
  const payload = buildRestartSentinelPayload({
    sessionKey: 'agent:trail-guide:openai:session_123',
    continuationMessage: 'verify after boot',
    note: 'Restarting for plugin reload.',
    reason: 'plugin reload',
    nowMs: 12345,
  });

  assert.equal(payload.version, 1);
  assert.equal(payload.payload.kind, 'restart');
  assert.equal(payload.payload.status, 'ok');
  assert.equal(payload.payload.ts, 12345);
  assert.equal(payload.payload.sessionKey, 'agent:trail-guide:openai:session_123');
  assert.equal(payload.payload.continuation, null);
  assert.equal(payload.payload.message, 'Restarting for plugin reload.');
  assert.equal(payload.payload.stats.mode, 'gateway.service.restart.detached');
  assert.equal(payload.payload.stats.continuationDelivery, 'agent-cli');
});

test('buildRestartSentinelPayload can still create a sentinel agent-turn continuation', () => {
  const payload = buildRestartSentinelPayload({
    sessionKey: 'agent:trail-guide:session_123',
    continuationMessage: 'verify after boot',
    continuationDelivery: 'sentinel',
    nowMs: 12345,
  });

  assert.deepEqual(payload.payload.continuation, {
    kind: 'agentTurn',
    message: 'verify after boot',
  });
  assert.equal(payload.payload.stats.continuationDelivery, 'sentinel');
});

test('agent-cli continuation targeting extracts agent id and concrete session id from a canonical key', () => {
  assert.equal(resolveAgentCliSessionId('agent:trail-guide:openai:session_123'), 'session_123');
  assert.equal(resolveAgentCliAgentId('agent:trail-guide:openai:session_123'), 'trail-guide');
  assert.equal(resolveAgentCliSessionId('session_456'), 'session_456');
  assert.equal(resolveAgentCliAgentId('session_456'), null);
});


test('resolveAgentContinuationParams preserves the canonical session key for Gateway RPC', () => {
  assert.deepEqual(resolveAgentContinuationParams({
    sessionKey: 'agent:trail-guide:openai:session_123',
    continuationMessage: 'verify after boot',
    continuationTimeoutSeconds: 12,
  }), {
    message: 'verify after boot',
    agentId: 'trail-guide',
    sessionKey: 'agent:trail-guide:openai:session_123',
    timeout: 12,
  });
});

test('buildAgentContinuationShellSnippet runs an agent turn against the canonical session key', () => {
  const snippet = buildAgentContinuationShellSnippet({
    openclawBin: '/tmp/Open Claw/bin/openclaw',
    profile: 'cotw',
    stateDir: '/tmp/openclaw-state',
    sessionKey: 'agent:trail-guide:openai:session_123',
    continuationMessage: "resume Chris's build",
    continuationTimeoutSeconds: 45,
  }).join('\n');

  assert.match(snippet, /scheduled Gateway restart continuation starting session-key=%s/);
  assert.match(snippet, /continuation_result_path='\/tmp\/openclaw-state\/restart-continuation-result\.json'/);
  assert.match(snippet, /gateway call agent --params '\{"message":"resume Chris'\\''s build","agentId":"trail-guide","sessionKey":"agent:trail-guide:openai:session_123","timeout":45\}' --timeout '75000' --expect-final --json > "\$continuation_result_tmp"/);
  assert.match(snippet, /mv "\$continuation_result_tmp" "\$continuation_result_path"/);
  assert.match(snippet, /continuation_status=\$\?/);
});

test('buildRestartShellScript schedules openclaw gateway restart and direct continuation without inline kill', () => {
  const script = buildRestartShellScript({
    openclawBin: '/tmp/Open Claw/bin/openclaw',
    profile: 'cotw',
    delayMs: 250,
    logPath: '/tmp/openclaw restart.log',
    wait: '10s',
    sessionKey: 'agent:trail-guide:openai:session_123',
    continuationMessage: 'resume after restart',
  });

  assert.match(script, /sleep 0\.250/);
  assert.match(script, /'\/tmp\/Open Claw\/bin\/openclaw' --profile 'cotw' gateway restart --wait '10s' --json/);
  assert.match(script, /restart_status=\$\?/);
  assert.match(script, /gateway call agent --params '\{"message":"resume after restart","agentId":"trail-guide","sessionKey":"agent:trail-guide:openai:session_123","timeout":900\}' --timeout '930000' --expect-final --json/);
  assert.match(script, />> '\/tmp\/openclaw restart\.log' 2>&1/);
});

test('scheduleGatewayServiceRestart dry-run does not write or spawn', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-dry-run-'));
  let spawned = false;
  try {
    const result = scheduleGatewayServiceRestart({
      dryRun: true,
      stateDir,
      openclawBin: '/bin/openclaw',
      sessionKey: 'agent:trail-guide:session_123',
      spawnFn: () => { spawned = true; },
    });

    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(spawned, false);
    assert.equal(fs.existsSync(path.join(stateDir, RESTART_SENTINEL_FILENAME)), false);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('scheduleGatewayServiceRestart writes sentinel and launches detached restart', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-apply-'));
  const calls = [];
  try {
    const result = scheduleGatewayServiceRestart({
      stateDir,
      openclawBin: '/bin/openclaw',
      sessionKey: 'agent:trail-guide:session_123',
      continuationMessage: 'resume me',
      spawnFn: (...args) => {
        calls.push(args);
        return { pid: 4242, unref() { this.unrefCalled = true; } };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.dryRun, false);
    assert.equal(result.pid, 4242);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '/bin/sh');
    assert.equal(calls[0][2].detached, true);
    assert.equal(calls[0][2].stdio, 'ignore');

    const sentinel = JSON.parse(fs.readFileSync(path.join(stateDir, RESTART_SENTINEL_FILENAME), 'utf8'));
    assert.equal(sentinel.payload.sessionKey, 'agent:trail-guide:session_123');
    assert.equal(sentinel.payload.continuation, null);
    assert.equal(sentinel.payload.stats.continuationDelivery, 'agent-cli');
    assert.match(result.script, /gateway call agent --params '\{"message":"resume me","agentId":"trail-guide","sessionKey":"agent:trail-guide:session_123","timeout":900\}' --timeout '930000' --expect-final --json/);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
