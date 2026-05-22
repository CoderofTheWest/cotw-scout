const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  DEFAULT_PROFILE,
  DEFAULT_RESTART_DELAY_MS,
  resolveDefaultStateDir,
  resolveRestartContinuationResultPath,
  scheduleGatewayServiceRestart,
} = require('./gateway-service-restart-continuation');

const DEFAULT_GATEWAY_PORT = 18789;
const DEFAULT_WAIT = '30s';
const DEFAULT_PROOF_TIMEOUT_SECONDS = 180;

function normalizeNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function requireCanonicalSessionKey(sessionKey) {
  const normalized = normalizeNonEmptyString(sessionKey);
  if (!normalized) throw new Error('sessionKey is required');
  if (!/^agent:[^:]+:.*session_[A-Za-z0-9_-]+/.test(normalized)) {
    throw new Error('sessionKey must be a canonical agent session key');
  }
  return normalized;
}

function makeProbeId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `restart-proof-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

function getFileMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function httpGetOk(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

function listElectronPids(execFile = execFileSync) {
  let output = '';
  try {
    output = execFile('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 5000 });
  } catch {
    return [];
  }

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /COTW Scout|Electron\.app|electron \.(\s|$)|cotw-scout/.test(line))
    .filter((line) => !/openclaw\/dist\/index\.js gateway|restart-proof-harness|grep|node --test/.test(line))
    .map((line) => Number(line.split(/\s+/, 1)[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
    .sort((a, b) => a - b);
}

function assertSafeDetachedRestartScript(script) {
  const forbidden = [
    /\bkill\b/,
    /killPid/,
    /killall/,
    /pkill/,
    /lsof\s+-ti/,
    /SIGKILL/,
    /SIGTERM/,
  ];
  const hit = forbidden.find((pattern) => pattern.test(script));
  if (hit) throw new Error(`restart harness refused unsafe script token: ${hit}`);
  return true;
}

function buildContinuationMessage(opts = {}) {
  const sessionKey = requireCanonicalSessionKey(opts.sessionKey);
  const probeId = normalizeNonEmptyString(opts.probeId);
  if (!probeId) throw new Error('probeId is required');

  const repoDir = normalizeNonEmptyString(opts.repoDir) || process.cwd();
  const resultPath = normalizeNonEmptyString(opts.resultPath);
  const previousResultMtimeMs = Number.isFinite(opts.previousResultMtimeMs) ? opts.previousResultMtimeMs : 0;
  const electronPids = Array.isArray(opts.electronPids) ? opts.electronPids : [];

  return [
    `RESTART_PROOF_HARNESS ${probeId}`,
    '',
    'You are the bounded post-restart continuation for a restart proof harness.',
    'Use at most 4 tool calls, then stop and report only the checklist.',
    '',
    'Required checks:',
    `1. Run session_status for the current session and verify the canonical session key is exactly: ${sessionKey}`,
    `2. In the repo, verify HEAD/status with: git rev-parse HEAD && git status --short`,
    resultPath
      ? `3. Verify the continuation result file exists and has mtime greater than ${previousResultMtimeMs}: ${resultPath}`
      : '3. Verify the continuation result file if a result path is available.',
    electronPids.length > 0
      ? `4. Verify these pre-restart GUI process ids are still alive if possible: ${electronPids.join(', ')}`
      : '4. If GUI process ids are not available, state that GUI process survival could not be mechanically checked.',
    '',
    'Report format:',
    `Restart harness ${probeId}:`,
    '- Gateway reachable: pass/fail/unknown',
    '- Session key stable: pass/fail/unknown',
    '- GUI reattached / this continuation visible: pass/fail/unknown',
    '- Continuation result file updated: pass/fail/unknown',
    '- No unowned GUI process killed: pass/fail/unknown',
    '- Repo state: <HEAD short + clean/dirty>',
    '',
    'If the session key mismatches, stop immediately and say so.',
  ].join('\n');
}

async function buildRestartProofHarnessPlan(opts = {}) {
  const sessionKey = requireCanonicalSessionKey(opts.sessionKey);
  const stateDir = normalizeNonEmptyString(opts.stateDir) || resolveDefaultStateDir(opts.env);
  const profile = normalizeNonEmptyString(opts.profile) || DEFAULT_PROFILE;
  const port = Number.isFinite(opts.port) ? Math.floor(opts.port) : DEFAULT_GATEWAY_PORT;
  const openclawBin = normalizeNonEmptyString(opts.openclawBin);
  if (!openclawBin) throw new Error('openclawBin is required');

  const probeId = normalizeNonEmptyString(opts.probeId) || makeProbeId();
  const resultPath = resolveRestartContinuationResultPath(stateDir);
  const previousResultMtimeMs = getFileMtimeMs(resultPath);
  const electronPids = opts.electronPids || listElectronPids(opts.execFileSync);
  const gatewayHealthyBefore = await httpGetOk(`http://127.0.0.1:${port}/health`, 1500);
  const repoDir = normalizeNonEmptyString(opts.repoDir) || path.resolve(__dirname, '..');
  const continuationMessage = buildContinuationMessage({
    sessionKey,
    probeId,
    repoDir,
    resultPath,
    previousResultMtimeMs,
    electronPids,
  });

  const restart = scheduleGatewayServiceRestart({
    dryRun: true,
    stateDir,
    profile,
    openclawBin,
    sessionKey,
    continuationMessage,
    continuationTimeoutSeconds: Number.isFinite(opts.continuationTimeoutSeconds)
      ? opts.continuationTimeoutSeconds
      : DEFAULT_PROOF_TIMEOUT_SECONDS,
    delayMs: Number.isFinite(opts.delayMs) ? opts.delayMs : DEFAULT_RESTART_DELAY_MS,
    wait: normalizeNonEmptyString(opts.wait) || DEFAULT_WAIT,
    reason: `restart proof harness ${probeId}`,
    note: `Restart proof harness ${probeId} scheduled.`,
  });
  assertSafeDetachedRestartScript(restart.script);

  return {
    ok: true,
    probeId,
    mode: opts.live ? 'live' : 'dry-run',
    safety: {
      safeScript: true,
      noInlineKill: true,
      electronPids,
    },
    preflight: {
      gatewayHealthyBefore,
      resultPath,
      previousResultMtimeMs,
      sessionKey,
    },
    restart,
    continuationMessage,
  };
}

async function runRestartProofHarness(opts = {}) {
  const plan = await buildRestartProofHarnessPlan(opts);
  if (!opts.live) return plan;

  const scheduled = scheduleGatewayServiceRestart({
    dryRun: false,
    stateDir: plan.restart.plan.stateDir,
    profile: plan.restart.plan.profile,
    openclawBin: opts.openclawBin,
    sessionKey: plan.preflight.sessionKey,
    continuationMessage: plan.continuationMessage,
    continuationTimeoutSeconds: Number.isFinite(opts.continuationTimeoutSeconds)
      ? opts.continuationTimeoutSeconds
      : DEFAULT_PROOF_TIMEOUT_SECONDS,
    delayMs: plan.restart.plan.delayMs,
    wait: normalizeNonEmptyString(opts.wait) || DEFAULT_WAIT,
    reason: `restart proof harness ${plan.probeId}`,
    note: `Restart proof harness ${plan.probeId} scheduled.`,
  });
  assertSafeDetachedRestartScript(scheduled.script);

  return {
    ...plan,
    mode: 'live',
    restart: scheduled,
  };
}

module.exports = {
  DEFAULT_GATEWAY_PORT,
  DEFAULT_PROOF_TIMEOUT_SECONDS,
  DEFAULT_WAIT,
  assertSafeDetachedRestartScript,
  buildContinuationMessage,
  buildRestartProofHarnessPlan,
  listElectronPids,
  makeProbeId,
  requireCanonicalSessionKey,
  runRestartProofHarness,
};
