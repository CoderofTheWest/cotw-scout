#!/usr/bin/env node
const path = require('node:path');
const {
  DEFAULT_GATEWAY_PORT,
  DEFAULT_PROOF_TIMEOUT_SECONDS,
  DEFAULT_WAIT,
  runRestartProofHarness,
} = require('../lib/restart-proof-harness');
const { resolveDefaultStateDir } = require('../lib/gateway-service-restart-continuation');

function usage() {
  return `Usage: ${path.basename(process.argv[1])} --session-key <canonical-key> [--live] [options]\n\nOptions:\n  --session-key <key>              Canonical session key expected to survive restart\n  --live                           Schedule the detached restart. Omit for dry-run only\n  --openclaw-bin <path>            OpenClaw CLI path (default: node_modules/.bin/openclaw)\n  --profile <name>                 OpenClaw profile (default: cotw)\n  --state-dir <path>               OpenClaw state dir (default: ${resolveDefaultStateDir()})\n  --port <number>                  Gateway health probe port (default: ${DEFAULT_GATEWAY_PORT})\n  --wait <duration>                Passed to openclaw gateway restart --wait (default: ${DEFAULT_WAIT})\n  --delay-ms <ms>                  Delay before detached restart\n  --continuation-timeout <seconds> Continuation timeout (default: ${DEFAULT_PROOF_TIMEOUT_SECONDS})\n  --probe-id <id>                  Stable proof marker for tests/manual runs\n  --help                           Show this help\n`;
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      i += 1;
      return argv[i];
    };
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--session-key') opts.sessionKey = next();
    else if (arg === '--live') opts.live = true;
    else if (arg === '--openclaw-bin') opts.openclawBin = next();
    else if (arg === '--profile') opts.profile = next();
    else if (arg === '--state-dir') opts.stateDir = next();
    else if (arg === '--port') opts.port = Number(next());
    else if (arg === '--wait') opts.wait = next();
    else if (arg === '--delay-ms') opts.delayMs = Number(next());
    else if (arg === '--continuation-timeout') opts.continuationTimeoutSeconds = Number(next());
    else if (arg === '--probe-id') opts.probeId = next();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

(async () => {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      process.stdout.write(usage());
      return;
    }
    if (!opts.sessionKey) throw new Error('--session-key is required');
    if (!opts.openclawBin) {
      opts.openclawBin = path.join(__dirname, '..', 'node_modules', '.bin', 'openclaw');
    }

    const result = await runRestartProofHarness(opts);
    process.stdout.write(`${JSON.stringify({
      ok: result.ok,
      mode: result.mode,
      probeId: result.probeId,
      pid: result.restart.pid,
      safety: result.safety,
      preflight: result.preflight,
      plan: result.restart.plan,
      sentinel: result.restart.sentinel,
    }, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${usage()}`);
    process.exit(2);
  }
})();
