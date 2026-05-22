#!/usr/bin/env node
const path = require('path');
const {
  createRecordModeProofPlan,
  renderRecordModeProofPlan
} = require('../lib/record-mode-proof-plan');

/**
 * Dry-run record-mode proof plan renderer.
 *
 * This script only prints a source-modeled proof plan. It does not read or
 * write OpenClaw config, restart Gateway, persist claims, resolve sources, or
 * touch runtime state.
 */
function main(argv = process.argv.slice(2), io = process) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    io.stderr.write(`${parsed.error}\n`);
    io.exitCode = 1;
    return;
  }
  if (parsed.help) {
    io.stdout.write(`${usage()}\n`);
    return;
  }

  try {
    const plan = createRecordModeProofPlan({
      agentId: parsed.agentId,
      source: parsed.source,
      now: parsed.now
    });
    const text = renderRecordModeProofPlan(plan, { format: parsed.format });
    io.stdout.write(`${text}\n`);
  } catch (err) {
    io.stderr.write(`${err.message}\n`);
    io.exitCode = 1;
  }
}

function parseArgs(argv = []) {
  const parsed = {
    source: 'handoff',
    agentId: 'trail-guide',
    format: 'markdown'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') return { ...parsed, help: true };
    if (token === '--source') {
      const value = readValue(argv, ++i, token);
      if (value.error) return value;
      parsed.source = value.value;
      continue;
    }
    if (token === '--agent' || token === '--agent-id') {
      const value = readValue(argv, ++i, token);
      if (value.error) return value;
      parsed.agentId = value.value;
      continue;
    }
    if (token === '--format') {
      const value = readValue(argv, ++i, token);
      if (value.error) return value;
      parsed.format = value.value;
      continue;
    }
    if (token === '--now') {
      const value = readValue(argv, ++i, token);
      if (value.error) return value;
      parsed.now = value.value;
      continue;
    }
    return { ...parsed, error: `Unsupported option "${token}".\n${usage()}` };
  }

  if (!['handoff', 'summary', 'digest'].includes(parsed.source)) {
    return { ...parsed, error: `Unsupported source "${parsed.source}". Use: handoff, summary, digest.` };
  }
  if (!['markdown', 'json'].includes(parsed.format)) {
    return { ...parsed, error: `Unsupported format "${parsed.format}". Use: markdown or json.` };
  }
  return parsed;
}

function readValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith('--')) return { error: `Option "${option}" requires a value.` };
  return { value };
}

function usage() {
  return [
    'Usage: node scripts/record-mode-proof-plan.js [--source handoff|summary|digest] [--format markdown|json] [--agent AGENT_ID] [--now ISO_TIME]',
    '',
    'Dry-run only. Prints desired config, rollback config, checks, and safety boundaries.',
    'Does not apply config, restart Gateway, persist claims, resolve sources, or read runtime state.'
  ].join('\n');
}

if (require.main === module) main();

module.exports = {
  main,
  parseArgs,
  usage
};
