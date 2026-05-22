const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { writeJsonAtomic } = require('./write-json-atomic');

const RESTART_SENTINEL_FILENAME = 'restart-sentinel.json';
const RESTART_CONTINUATION_RESULT_FILENAME = 'restart-continuation-result.json';
const DEFAULT_PROFILE = 'cotw';
const DEFAULT_STATE_DIRNAME = '.openclaw-cotw';
const DEFAULT_RESTART_DELAY_MS = 1500;
const DEFAULT_CONTINUATION_TIMEOUT_SECONDS = 900;
const DEFAULT_CONTINUATION_DELIVERY = 'agent-cli';
const DEFAULT_CONTINUATION_MESSAGE = 'The Gateway service restart completed. Verify the Gateway is reachable, check the task queue, then continue the interrupted work.';

function normalizeNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveDefaultStateDir(env = process.env) {
  return path.join(env.HOME || os.homedir(), DEFAULT_STATE_DIRNAME);
}

function resolveRestartSentinelPath(stateDir) {
  const resolvedStateDir = normalizeNonEmptyString(stateDir);
  if (!resolvedStateDir) throw new TypeError('stateDir is required');
  return path.join(resolvedStateDir, RESTART_SENTINEL_FILENAME);
}

function resolveRestartContinuationResultPath(stateDir) {
  const resolvedStateDir = normalizeNonEmptyString(stateDir);
  if (!resolvedStateDir) throw new TypeError('stateDir is required');
  return path.join(resolvedStateDir, RESTART_CONTINUATION_RESULT_FILENAME);
}

function resolveContinuationDelivery(value) {
  const normalized = normalizeNonEmptyString(value) || DEFAULT_CONTINUATION_DELIVERY;
  if (normalized !== 'agent-cli' && normalized !== 'sentinel') {
    throw new Error('continuationDelivery must be "agent-cli" or "sentinel"');
  }
  return normalized;
}

function resolveContinuationMessage(opts = {}) {
  if (opts.continuationMessage === false) return null;
  return normalizeNonEmptyString(opts.continuationMessage) || DEFAULT_CONTINUATION_MESSAGE;
}

function parseCanonicalSessionKey(sessionKey) {
  const normalized = normalizeNonEmptyString(sessionKey);
  if (!normalized) return { sessionId: null, agentId: null };
  const base = normalized.split('#')[0].split('?')[0];
  const parts = base.split(':').map((part) => part.trim()).filter(Boolean);
  const sessionId = normalizeNonEmptyString(parts[parts.length - 1] || base);
  const agentId = parts[0] === 'agent' ? normalizeNonEmptyString(parts[1]) : null;
  return { sessionId, agentId };
}

function resolveAgentCliSessionId(sessionKey) {
  return parseCanonicalSessionKey(sessionKey).sessionId;
}

function resolveAgentCliAgentId(sessionKey) {
  return parseCanonicalSessionKey(sessionKey).agentId;
}

function resolveAgentContinuationParams(opts = {}) {
  const sessionKey = normalizeNonEmptyString(opts.sessionKey);
  if (!sessionKey) throw new Error('sessionKey is required for agent-cli restart continuation');
  const { agentId } = parseCanonicalSessionKey(sessionKey);
  return {
    message: resolveContinuationMessage(opts),
    agentId: agentId || undefined,
    sessionKey,
    timeout: Number.isFinite(opts.continuationTimeoutSeconds)
      ? Math.max(0, Math.floor(opts.continuationTimeoutSeconds))
      : DEFAULT_CONTINUATION_TIMEOUT_SECONDS,
  };
}

function buildRestartSentinelPayload(opts = {}) {
  const sessionKey = normalizeNonEmptyString(opts.sessionKey);
  const continuationMessage = resolveContinuationMessage(opts);
  const continuationDelivery = resolveContinuationDelivery(opts.continuationDelivery);
  if (!sessionKey && continuationMessage) {
    throw new Error('sessionKey is required for restart continuation');
  }

  const reason = normalizeNonEmptyString(opts.reason);
  const note = normalizeNonEmptyString(opts.note);
  const sentinelContinuation = continuationDelivery === 'sentinel' && continuationMessage && sessionKey
    ? { kind: 'agentTurn', message: continuationMessage }
    : null;

  return {
    version: 1,
    payload: {
      kind: 'restart',
      status: 'ok',
      ts: Number.isFinite(opts.nowMs) ? Math.floor(opts.nowMs) : Date.now(),
      sessionKey,
      message: note || reason || 'Gateway service restart scheduled.',
      continuation: sentinelContinuation,
      doctorHint: 'Run: openclaw doctor --non-interactive',
      stats: {
        mode: 'gateway.service.restart.detached',
        reason: reason || null,
        continuationDelivery: continuationMessage ? continuationDelivery : null,
      },
    },
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildAgentContinuationShellSnippet(opts = {}) {
  const continuationDelivery = resolveContinuationDelivery(opts.continuationDelivery);
  const continuationMessage = resolveContinuationMessage(opts);
  if (continuationDelivery !== 'agent-cli' || !continuationMessage) return [];

  const params = resolveAgentContinuationParams(opts);
  const profile = normalizeNonEmptyString(opts.profile) || DEFAULT_PROFILE;
  const openclawBin = normalizeNonEmptyString(opts.openclawBin);
  if (!openclawBin) throw new TypeError('openclawBin is required');
  const stateDir = normalizeNonEmptyString(opts.stateDir) || resolveDefaultStateDir(opts.env);
  const resultPath = resolveRestartContinuationResultPath(stateDir);

  const gatewayTimeoutMs = params.timeout === 0 ? 0 : Math.max(10000, (params.timeout + 30) * 1000);
  const args = [
    shellQuote(openclawBin),
    '--profile', shellQuote(profile),
    'gateway',
    'call',
    'agent',
    '--params', shellQuote(JSON.stringify(params)),
    '--timeout', shellQuote(String(gatewayTimeoutMs)),
    '--expect-final',
    '--json',
  ];

  return [
    `  continuation_result_path=${shellQuote(resultPath)}`,
    '  continuation_result_tmp="${continuation_result_path}.$$"',
    `  printf '[%s] scheduled Gateway restart continuation starting session-key=%s\n' "$(date -u +%FT%TZ)" ${shellQuote(params.sessionKey)}`,
    '  set +e',
    `  ${args.join(' ')} > "$continuation_result_tmp"`,
    '  continuation_status=$?',
    '  set -e',
    '  if [ -s "$continuation_result_tmp" ]; then cat "$continuation_result_tmp"; fi',
    '  if [ "$continuation_status" -eq 0 ]; then mv "$continuation_result_tmp" "$continuation_result_path"; else rm -f "$continuation_result_tmp"; fi',
    `  printf '[%s] scheduled Gateway restart continuation finished status=%s\n' "$(date -u +%FT%TZ)" "$continuation_status"`,
    '  if [ "$continuation_status" -ne 0 ]; then exit "$continuation_status"; fi',
  ];
}

function buildRestartShellScript(opts = {}) {
  const openclawBin = normalizeNonEmptyString(opts.openclawBin);
  if (!openclawBin) throw new TypeError('openclawBin is required');

  const profile = normalizeNonEmptyString(opts.profile) || DEFAULT_PROFILE;
  const delayMs = Number.isFinite(opts.delayMs) ? Math.max(0, Math.floor(opts.delayMs)) : DEFAULT_RESTART_DELAY_MS;
  const delaySeconds = (delayMs / 1000).toFixed(3);
  const logPath = normalizeNonEmptyString(opts.logPath);

  const args = [shellQuote(openclawBin), '--profile', shellQuote(profile), 'gateway', 'restart'];
  if (opts.force) args.push('--force');
  const wait = normalizeNonEmptyString(opts.wait);
  if (wait) args.push('--wait', shellQuote(wait));
  args.push('--json');

  const restartCommand = args.join(' ');
  const continuationLines = buildAgentContinuationShellSnippet({ ...opts, openclawBin, profile });
  const lines = ['set -eu'];
  if (delayMs > 0) lines.push(`sleep ${delaySeconds}`);
  if (logPath) {
    const quotedLog = shellQuote(logPath);
    lines.push(`{`);
    lines.push(`  printf '[%s] scheduled Gateway service restart starting\\n' "$(date -u +%FT%TZ)"`);
    lines.push('  set +e');
    lines.push(`  ${restartCommand}`);
    lines.push(`  restart_status=$?`);
    lines.push('  set -e');
    lines.push(`  printf '[%s] scheduled Gateway service restart finished status=%s\\n' "$(date -u +%FT%TZ)" "$restart_status"`);
    lines.push(`  if [ "$restart_status" -ne 0 ]; then exit "$restart_status"; fi`);
    lines.push(...continuationLines);
    lines.push(`} >> ${quotedLog} 2>&1`);
  } else {
    lines.push(`${restartCommand}`);
    lines.push(...continuationLines.map((line) => line.replace(/^  /, '')));
  }
  return `${lines.join('\n')}\n`;
}

function writeRestartSentinel(opts = {}) {
  const stateDir = normalizeNonEmptyString(opts.stateDir) || resolveDefaultStateDir(opts.env);
  const sentinelPath = resolveRestartSentinelPath(stateDir);
  const payload = buildRestartSentinelPayload(opts);
  writeJsonAtomic(sentinelPath, payload, { mode: 0o600 });
  return { sentinelPath, payload };
}

function scheduleDetachedRestart(opts = {}) {
  const script = buildRestartShellScript(opts);
  const spawnFn = opts.spawnFn || spawn;
  const child = spawnFn('/bin/sh', ['-c', script], {
    detached: true,
    stdio: 'ignore',
    env: opts.env || process.env,
  });
  if (child && typeof child.unref === 'function') child.unref();
  return { pid: child?.pid, script };
}

function scheduleGatewayServiceRestart(opts = {}) {
  const stateDir = normalizeNonEmptyString(opts.stateDir) || resolveDefaultStateDir(opts.env);
  const logPath = normalizeNonEmptyString(opts.logPath) || path.join(stateDir, 'logs', 'gateway-service-restart-continuation.log');
  const plan = {
    stateDir,
    sentinelPath: resolveRestartSentinelPath(stateDir),
    logPath,
    profile: normalizeNonEmptyString(opts.profile) || DEFAULT_PROFILE,
    delayMs: Number.isFinite(opts.delayMs) ? Math.max(0, Math.floor(opts.delayMs)) : DEFAULT_RESTART_DELAY_MS,
  };

  const sentinel = buildRestartSentinelPayload(opts);
  const script = buildRestartShellScript({ ...opts, logPath, delayMs: plan.delayMs, profile: plan.profile });

  if (opts.dryRun) {
    return { ok: true, dryRun: true, plan, sentinel, script };
  }

  fs.mkdirSync(path.dirname(plan.sentinelPath), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  writeJsonAtomic(plan.sentinelPath, sentinel, { mode: 0o600 });
  const restart = scheduleDetachedRestart({ ...opts, logPath, delayMs: plan.delayMs, profile: plan.profile });
  return { ok: true, dryRun: false, plan, sentinel, script: restart.script, pid: restart.pid };
}

module.exports = {
  DEFAULT_CONTINUATION_DELIVERY,
  DEFAULT_CONTINUATION_MESSAGE,
  DEFAULT_CONTINUATION_TIMEOUT_SECONDS,
  DEFAULT_PROFILE,
  DEFAULT_RESTART_DELAY_MS,
  DEFAULT_STATE_DIRNAME,
  RESTART_SENTINEL_FILENAME,
  RESTART_CONTINUATION_RESULT_FILENAME,
  buildAgentContinuationShellSnippet,
  buildRestartSentinelPayload,
  buildRestartShellScript,
  parseCanonicalSessionKey,
  resolveAgentCliAgentId,
  resolveAgentCliSessionId,
  resolveAgentContinuationParams,
  resolveContinuationDelivery,
  resolveDefaultStateDir,
  resolveRestartSentinelPath,
  resolveRestartContinuationResultPath,
  scheduleDetachedRestart,
  scheduleGatewayServiceRestart,
  writeRestartSentinel,
};
