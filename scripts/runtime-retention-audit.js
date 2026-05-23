#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  buildRuntimeRetentionReport,
  formatRetentionReport,
} = require('../lib/runtime-retention-audit');

function parseArgs(argv) {
  const options = { repoRoot: path.resolve(__dirname, '..') };
  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    const next = () => argv[++idx];
    if (arg === '--json') options.json = true;
    else if (arg === '--include-paths') options.includePaths = true;
    else if (arg === '--user-data') options.userDataPath = next();
    else if (arg === '--openclaw-home') options.openclawHome = next();
    else if (arg === '--workspace') options.workspacePath = next();
    else if (arg === '--plugins-path') options.pluginsPath = next();
    else if (arg === '--agent') options.agentId = next();
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return `Usage: node scripts/runtime-retention-audit.js [options]

Read-only runtime retention and research-platform artifact audit.

Options:
  --json                 Print JSON instead of markdown
  --include-paths        Include full local paths
  --user-data <dir>      App userData root
  --openclaw-home <dir>  OpenClaw profile root
  --workspace <dir>      Workspace root
  --plugins-path <dir>   Bundled plugins root
  --agent <id>           Agent id for session paths (default: trail-guide)
`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const report = buildRuntimeRetentionReport(options);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatRetentionReport(report));
}

try {
  main();
} catch (err) {
  console.error(err.message || String(err));
  process.exitCode = 1;
}
