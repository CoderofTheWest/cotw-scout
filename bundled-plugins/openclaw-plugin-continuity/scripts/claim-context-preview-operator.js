#!/usr/bin/env node
const {
  applyActivationFile,
  applyRollbackFile,
  previewActivation,
  previewRollback,
  renderOperatorSummary
} = require('../lib/claim-context-preview-operator');
const { readConfigFile } = require('../lib/record-mode-operator');

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
    if (parsed.action === 'plan') {
      const { parsed: config } = readConfigFile(parsed.config);
      const summary = previewActivation(config, { maxClaims: parsed.maxClaims });
      io.stdout.write(`${renderOperatorSummary(summary, { format: parsed.format })}\n`);
      return;
    }

    if (parsed.action === 'apply') {
      const summary = applyActivationFile(parsed.config, {
        maxClaims: parsed.maxClaims,
        now: parsed.now,
        backupDir: parsed.backupDir,
        confirm: parsed.yes === true
      });
      io.stdout.write(`${renderOperatorSummary(summary, { format: parsed.format })}\n`);
      return;
    }

    if (parsed.action === 'rollback') {
      if (parsed.dryRun) {
        const { parsed: config } = readConfigFile(parsed.config);
        const summary = previewRollback(config, { maxClaims: parsed.maxClaims });
        io.stdout.write(`${renderOperatorSummary(summary, { format: parsed.format })}\n`);
        return;
      }
      const summary = applyRollbackFile(parsed.config, {
        maxClaims: parsed.maxClaims,
        now: parsed.now,
        backupDir: parsed.backupDir,
        confirm: parsed.yes === true
      });
      io.stdout.write(`${renderOperatorSummary(summary, { format: parsed.format })}\n`);
      return;
    }

    throw new Error(`unsupported action: ${parsed.action}`);
  } catch (err) {
    io.stderr.write(`${err.message}\n`);
    io.exitCode = 1;
  }
}

function parseArgs(argv = []) {
  const parsed = {
    action: 'plan',
    format: 'markdown',
    dryRun: false,
    yes: false,
    maxClaims: 8
  };

  if (argv[0] && !argv[0].startsWith('--')) parsed.action = argv.shift();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') return { ...parsed, help: true };
    if (token === '--config') {
      const value = readValue(argv, ++i, token);
      if (value.error) return value;
      parsed.config = value.value;
      continue;
    }
    if (token === '--format') {
      const value = readValue(argv, ++i, token);
      if (value.error) return value;
      parsed.format = value.value;
      continue;
    }
    if (token === '--backup-dir') {
      const value = readValue(argv, ++i, token);
      if (value.error) return value;
      parsed.backupDir = value.value;
      continue;
    }
    if (token === '--now') {
      const value = readValue(argv, ++i, token);
      if (value.error) return value;
      parsed.now = value.value;
      continue;
    }
    if (token === '--max-claims') {
      const value = readValue(argv, ++i, token);
      if (value.error) return value;
      const n = Number(value.value);
      if (!Number.isInteger(n) || n < 1 || n > 25) return { ...parsed, error: '--max-claims must be an integer between 1 and 25' };
      parsed.maxClaims = n;
      continue;
    }
    if (token === '--yes') {
      parsed.yes = true;
      continue;
    }
    if (token === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (token === '--inject-mode' || token === '--excerpts' || token === '--include-source-excerpts') {
      return { ...parsed, error: `${token} is not supported; preview activation is locked to injectMode=none and source excerpts hidden` };
    }
    return { ...parsed, error: `Unsupported option "${token}".\n${usage()}` };
  }

  if (!['plan', 'apply', 'rollback'].includes(parsed.action)) {
    return { ...parsed, error: `Unsupported action "${parsed.action}". Use: plan, apply, rollback.` };
  }
  if (!parsed.config) return { ...parsed, error: '--config is required' };
  if (!['markdown', 'json'].includes(parsed.format)) {
    return { ...parsed, error: `Unsupported format "${parsed.format}". Use: markdown or json.` };
  }
  if ((parsed.action === 'apply' || (parsed.action === 'rollback' && !parsed.dryRun)) && parsed.yes !== true) {
    return { ...parsed, error: `${parsed.action} requires --yes` };
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
    'Usage:',
    '  node scripts/claim-context-preview-operator.js plan --config CONFIG.json [--format markdown|json]',
    '  node scripts/claim-context-preview-operator.js apply --config CONFIG.json --yes [--backup-dir DIR]',
    '  node scripts/claim-context-preview-operator.js rollback --config CONFIG.json --yes [--backup-dir DIR]',
    '',
    'Build 3 operator workflow for observe-only claim-context preview diagnostics.',
    'Locked to claimContext.injectMode=none and includeSourceExcerpts=false.',
    'Writes a backup before apply/rollback. Does not restart Gateway.'
  ].join('\n');
}

if (require.main === module) main();

module.exports = {
  main,
  parseArgs,
  usage
};
