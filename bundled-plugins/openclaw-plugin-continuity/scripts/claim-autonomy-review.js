#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  evaluateAutonomyPolicy,
  buildDryRunReceipt,
  summarizeAutonomyReview
} = require('../lib/claim-autonomy-policy');
const { reviewClaimStoreCandidates } = require('../lib/claim-autonomy-review');
const { evaluateApplyGate, renderApplyGateRefusal } = require('../lib/claim-autonomy-apply-gate');

async function main(argv = process.argv.slice(2), io = process, dependencies = {}) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.apply) {
      const gate = evaluateApplyGate({ requested: true });
      io.stderr.write(renderApplyGateRefusal(gate));
      return 2;
    }

    let result;
    if (options.claimStoreDb) {
      result = await reviewReadonlyDb(options, dependencies);
    } else {
      result = reviewFixture(options);
    }

    const output = options.json
      ? JSON.stringify(result, null, 2)
      : renderTextReport(result);
    io.stdout.write(`${output}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`ERROR: ${error.message || error}\n`);
    return 1;
  }
}

function reviewFixture(options) {
  const fixturePath = options.fixture || path.join(__dirname, '..', 'test', 'fixtures', 'autonomous-maturation-claims.json');
  const candidates = loadFixture(fixturePath).slice(0, options.limit || undefined);
  const receipts = candidates.map((candidate) => buildDryRunReceipt(candidate, evaluateAutonomyPolicy(candidate, candidate.evidence || {})));
  return {
    dryRun: true,
    mode: 'fixture',
    source: fixturePath,
    summary: summarizeAutonomyReview(receipts),
    receipts: options.includeReceipts ? receipts : undefined
  };
}

async function reviewReadonlyDb(options, dependencies = {}) {
  const BetterSqlite3 = dependencies.BetterSqlite3 || require('better-sqlite3');
  const { ClaimStore } = dependencies.ClaimStore ? { ClaimStore: dependencies.ClaimStore } : require('../storage/claim-store');
  const db = new BetterSqlite3(options.claimStoreDb, { readonly: true, fileMustExist: true });
  try {
    const claimStore = new ClaimStore(db, {}, {});
    const review = await reviewClaimStoreCandidates({
      claimStore,
      agentId: options.agentId,
      limit: options.limit || 25,
      statuses: options.statuses,
      kinds: options.kinds
    });
    return {
      dryRun: true,
      mode: 'claim-store-db',
      source: options.claimStoreDb,
      summary: review.summary,
      receipts: options.includeReceipts ? review.receipts : undefined
    };
  } finally {
    if (typeof db.close === 'function') db.close();
  }
}

function parseArgs(argv = []) {
  const options = {
    fixture: null,
    claimStoreDb: null,
    agentId: null,
    statuses: ['verify_required', 'stale'],
    kinds: null,
    limit: null,
    json: false,
    includeReceipts: false,
    apply: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--fixture') options.fixture = requiredValue(argv, ++index, '--fixture');
    else if (arg === '--claim-store-db') options.claimStoreDb = requiredValue(argv, ++index, '--claim-store-db');
    else if (arg === '--agent-id') options.agentId = requiredValue(argv, ++index, '--agent-id');
    else if (arg === '--status') options.statuses = splitValues(requiredValue(argv, ++index, '--status'));
    else if (arg === '--kind') options.kinds = splitValues(requiredValue(argv, ++index, '--kind'));
    else if (arg === '--limit') options.limit = parseLimit(requiredValue(argv, ++index, '--limit'));
    else if (arg === '--json') options.json = true;
    else if (arg === '--include-receipts') options.includeReceipts = true;
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (options.help) {
    throw new Error('usage: claim-autonomy-review [--fixture path | --claim-store-db path] [--agent-id id] [--status a,b] [--kind a,b] [--limit n] [--json] [--include-receipts] [--apply]');
  }
  if (options.fixture && options.claimStoreDb) throw new Error('use either --fixture or --claim-store-db, not both');
  return options;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseLimit(value) {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');
  return limit;
}

function splitValues(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function loadFixture(fixturePath) {
  const resolved = path.resolve(fixturePath);
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('fixture must be a JSON array');
  return parsed;
}

function renderTextReport({ mode = 'fixture', source, summary, receipts, includeReceipts }) {
  const lines = [];
  lines.push('# Claim Autonomy Review — dry run');
  lines.push('');
  lines.push(`Mode: ${mode}`);
  lines.push(`Source: ${source}`);
  lines.push(`Total: ${summary.total}`);
  lines.push(`Apply eligible: ${summary.applyEligible}`);
  lines.push(`Mutation attempts: ${summary.mutationAttempts}`);
  lines.push(`Prompt eligibility changes: ${summary.promptEligibilityChanges}`);
  lines.push('');
  lines.push('## Decisions');
  for (const [decision, count] of sortedEntries(summary.byDecision)) lines.push(`- ${decision}: ${count}`);
  lines.push('');
  lines.push('## Lanes');
  for (const [lane, count] of sortedEntries(summary.byLane)) lines.push(`- ${lane}: ${count}`);
  lines.push('');
  lines.push('## Synthesis');
  lines.push(`- total: ${summary.synthesis.total}`);
  for (const [form, count] of sortedEntries(summary.synthesis.byForm)) lines.push(`- ${form}: ${count}`);

  if (receipts) {
    lines.push('');
    lines.push('## Receipts');
    for (const receipt of receipts) {
      lines.push(`- ${receipt.claimId}: ${receipt.lane} / ${receipt.policyDecision} / apply=${receipt.eligibleForApply ? 'yes' : 'no'}`);
      if (receipt.reasonCodes?.length) lines.push(`  - reasons: ${receipt.reasonCodes.join(', ')}`);
    }
  }

  return lines.join('\n');
}

function sortedEntries(object = {}) {
  return Object.entries(object).sort(([a], [b]) => a.localeCompare(b));
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = {
  main,
  parseArgs,
  renderTextReport,
  reviewFixture,
  reviewReadonlyDb
};
