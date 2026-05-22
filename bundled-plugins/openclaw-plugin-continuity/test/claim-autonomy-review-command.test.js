#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const { main, parseArgs } = require('../scripts/claim-autonomy-review');

const script = path.join(__dirname, '..', 'scripts', 'claim-autonomy-review.js');
const fixture = path.join(__dirname, 'fixtures', 'autonomous-maturation-claims.json');
const results = [];

async function mainTest() {
  await run('parseArgs accepts dry-run fixture flags', () => {
    const parsed = parseArgs(['--fixture', fixture, '--limit', '2', '--json', '--include-receipts']);
    assert.equal(parsed.fixture, fixture);
    assert.equal(parsed.limit, 2);
    assert.equal(parsed.json, true);
    assert.equal(parsed.includeReceipts, true);
    assert.equal(parsed.apply, false);
    assert.equal(parsed.claimStoreDb, null);
  });

  await run('parseArgs accepts read-only claim-store flags', () => {
    const parsed = parseArgs(['--claim-store-db', '/tmp/continuity.db', '--agent-id', 'trail-guide', '--status', 'verify_required,stale', '--kind', 'project_state,runtime']);
    assert.equal(parsed.claimStoreDb, '/tmp/continuity.db');
    assert.equal(parsed.agentId, 'trail-guide');
    assert.deepEqual(parsed.statuses, ['verify_required', 'stale']);
    assert.deepEqual(parsed.kinds, ['project_state', 'runtime']);
  });

  await run('fixture-mode JSON report includes dry-run summary and receipts', () => {
    const result = spawnSync(process.execPath, [script, '--fixture', fixture, '--limit', '4', '--json', '--include-receipts'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.mode, 'fixture');
    assert.equal(parsed.summary.total, 4);
    assert.equal(parsed.summary.applyEligible, 4);
    assert.equal(parsed.summary.mutationAttempts, 0);
    assert.equal(parsed.summary.promptEligibilityChanges, 0);
    assert.equal(parsed.receipts.length, 4);
    for (const receipt of parsed.receipts) {
      assert.equal(receipt.dryRun, true);
      assert.equal(receipt.mutationAttempted, false);
      assert.equal(receipt.promptInjectionEligibilityChanged, false);
    }
  });

  await run('text report prints lanes decisions and receipt summaries', () => {
    const result = spawnSync(process.execPath, [script, '--fixture', fixture, '--limit', '6', '--include-receipts'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Claim Autonomy Review — dry run/);
    assert.match(result.stdout, /Mode: fixture/);
    assert.match(result.stdout, /Mutation attempts: 0/);
    assert.match(result.stdout, /Prompt eligibility changes: 0/);
    assert.match(result.stdout, /## Receipts/);
    assert.match(result.stdout, /agent_maturation_auto_accept_restart_key/);
  });

  await run('--apply refuses before candidate processing and performs no mutation', async () => {
    const output = await captureMain(['--fixture', fixture, '--apply', '--include-receipts']);
    assert.equal(output.code, 2);
    assert.equal(output.stdout, '');
    assert.match(output.stderr, /apply mode is not implemented in Build 7 Slice 1; no mutations attempted/);
    assert.match(output.stderr, /Apply gate: refused/);
    assert.match(output.stderr, /no_current_dry_run_receipts_supplied/);
  });

  await run('runner errors exit nonzero but review refusals do not', () => {
    const bad = spawnSync(process.execPath, [script, '--fixture', path.join(__dirname, 'missing.json')], { encoding: 'utf8' });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /ERROR:/);

    const refusals = spawnSync(process.execPath, [script, '--fixture', fixture, '--json'], { encoding: 'utf8' });
    assert.equal(refusals.status, 0, refusals.stderr);
    const parsed = JSON.parse(refusals.stdout);
    assert.ok(parsed.summary.byDecision.chris_review >= 1);
    assert.ok(parsed.summary.byDecision.reject >= 1 || parsed.summary.byDecision.archive_open_question >= 1);
  });

  writeReport();
}

async function captureMain(argv) {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } }
  });
  return { code, stdout, stderr };
}

async function run(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error && error.stack ? error.stack : String(error) });
  }
}

function writeReport() {
  const report = renderReport(results);
  const reportPath = path.join(__dirname, 'reports', 'claim-autonomy-review-command.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, report);
  const failed = results.filter((result) => !result.ok);
  if (failed.length) {
    console.error(report);
    process.exitCode = 1;
  } else {
    console.log(report);
  }
}

function renderReport(items) {
  const passed = items.filter((item) => item.ok).length;
  const lines = ['# claim-autonomy-review-command test report', '', `Passed: ${passed}/${items.length}`, ''];
  for (const item of items) {
    lines.push(`- ${item.ok ? 'PASS' : 'FAIL'} ${item.name}`);
    if (!item.ok) lines.push(`  - ${String(item.error).split('\n').join('\n    ')}`);
  }
  return lines.join('\n');
}

mainTest();
