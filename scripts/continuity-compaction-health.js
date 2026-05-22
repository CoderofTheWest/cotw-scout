#!/usr/bin/env node
'use strict';

const {
  buildContinuityHealthReport,
  formatHealthReportMarkdown
} = require('../lib/continuity-compaction-health');

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--include-paths') options.includePaths = true;
    else if (arg === '--agent') options.agentId = argv[++i];
    else if (arg === '--session-key') options.sessionKey = argv[++i];
    else if (arg === '--openclaw-home') options.openclawHome = argv[++i];
    else if (arg === '--config') options.configPath = argv[++i];
    else if (arg === '--session-store') options.sessionStorePath = argv[++i];
    else if (arg === '--transcript') options.transcriptPath = argv[++i];
    else if (arg === '--warn-bytes') options.transcriptWarnBytes = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/continuity-compaction-health.js [options]\n\nRead-only continuity/compaction health diagnostics.\n\nOptions:\n  --json                 Print JSON instead of markdown\n  --include-paths        Include full local paths in output\n  --agent <id>           Agent id (default: trail-guide)\n  --session-key <key>    Session key to inspect (default: most recently updated)\n  --openclaw-home <dir>  OpenClaw home (default: ~/.openclaw-cotw)\n  --config <path>        Config path override\n  --session-store <path> Session store override\n  --transcript <path>    Transcript JSONL override\n  --warn-bytes <n>       Transcript warning threshold in bytes\n`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const report = buildContinuityHealthReport(options);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatHealthReportMarkdown(report));
}

try {
  main();
} catch (err) {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
}
