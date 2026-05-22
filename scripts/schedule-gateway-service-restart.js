#!/usr/bin/env node
const path = require('node:path');
const {
  DEFAULT_PROFILE,
  DEFAULT_RESTART_DELAY_MS,
  resolveDefaultStateDir,
  scheduleGatewayServiceRestart,
} = require('../lib/gateway-service-restart-continuation');

function usage() {
  return `Usage: ${path.basename(process.argv[1])} --session-key <key> [options]\n\nOptions:\n  --session-key <key>              Canonical session key to resume after restart\n  --continuation-message <text>    Agent turn to run after restart\n  --continuation-delivery <mode>   agent-cli (default) or sentinel\n  --continuation-timeout <seconds> Timeout for agent-cli continuation (default: 900)\n  --note <text>                    User-visible restart note\n  --reason <text>                  Short restart reason\n  --openclaw-bin <path>            OpenClaw CLI path (default: node_modules/.bin/openclaw)\n  --profile <name>                 OpenClaw profile (default: ${DEFAULT_PROFILE})\n  --state-dir <path>               OpenClaw state dir (default: ${resolveDefaultStateDir()})\n  --delay-ms <ms>                  Delay before detached restart (default: ${DEFAULT_RESTART_DELAY_MS})\n  --wait <duration>                Pass through to openclaw gateway restart --wait\n  --force                          Pass through to openclaw gateway restart --force\n  --dry-run                        Print plan without writing sentinel or restarting\n`;
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
    else if (arg === '--continuation-message') opts.continuationMessage = next();
    else if (arg === '--continuation-delivery') opts.continuationDelivery = next();
    else if (arg === '--continuation-timeout') opts.continuationTimeoutSeconds = Number(next());
    else if (arg === '--note') opts.note = next();
    else if (arg === '--reason') opts.reason = next();
    else if (arg === '--openclaw-bin') opts.openclawBin = next();
    else if (arg === '--profile') opts.profile = next();
    else if (arg === '--state-dir') opts.stateDir = next();
    else if (arg === '--delay-ms') opts.delayMs = Number(next());
    else if (arg === '--wait') opts.wait = next();
    else if (arg === '--force') opts.force = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

try {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(usage());
    process.exit(0);
  }
  if (!opts.sessionKey) throw new Error('--session-key is required');
  if (!opts.openclawBin) {
    opts.openclawBin = path.join(__dirname, '..', 'node_modules', '.bin', 'openclaw');
  }
  const result = scheduleGatewayServiceRestart(opts);
  process.stdout.write(`${JSON.stringify({
    ok: result.ok,
    dryRun: result.dryRun,
    pid: result.pid,
    plan: result.plan,
    sentinel: result.sentinel,
  }, null, 2)}\n`);
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${usage()}`);
  process.exit(2);
}
