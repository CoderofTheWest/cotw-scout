#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const {
  applyActivationFile,
  applyRollbackFile,
  getContinuityConfig,
  previewActivation,
  previewRollback,
  renderOperatorSummary,
  setContinuitySourceAddressableMemory
} = require('../lib/record-mode-operator');

const results = [];

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});

async function main() {
  await run('preview activation preserves unrelated config and enables handoff only', () => {
    const config = baseConfig();
    const preview = previewActivation(config, { source: 'handoff', now: '2026-05-05T18:00:00.000Z' });
    assert.equal(preview.ok, true);
    assert.equal(preview.nextConfig.gateway.mode, 'local');
    assert.equal(preview.nextConfig.plugins.entries.continuity.enabled, true);
    assert.deepEqual(preview.nextConfig.plugins.entries.other.config, { keep: true });
    const sam = getContinuityConfig(preview.nextConfig).sourceAddressableMemory;
    assert.equal(sam.enabled, true);
    assert.equal(sam.mode, 'record');
    assert.equal(sam.injectMode, 'none');
    assert.equal(sam.createClaimsFromHandoffs, true);
    assert.equal(sam.createClaimsFromSummaries, false);
    assert.equal(sam.createClaimsFromDigests, false);
    assert.equal(sam.persistClaimCandidates, true);
  });

  await run('activation helper refuses to write without explicit confirm', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-mode-operator-'));
    const configPath = path.join(dir, 'openclaw.json');
    fs.writeFileSync(configPath, JSON.stringify(baseConfig(), null, 2));
    assert.throws(() => applyActivationFile(configPath, { source: 'handoff' }), /explicit confirm=true/);
    const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(getContinuityConfig(after).sourceAddressableMemory, undefined);
  });

  await run('activation writes backup and rollback restores inert source-addressable config', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-mode-operator-'));
    const configPath = path.join(dir, 'openclaw.json');
    fs.writeFileSync(configPath, JSON.stringify(baseConfig(), null, 2));

    const applied = applyActivationFile(configPath, {
      source: 'handoff',
      now: '2026-05-05T18:01:00.000Z',
      backupDir: dir,
      confirm: true
    });
    assert.equal(applied.ok, true);
    assert.ok(fs.existsSync(applied.backupPath));
    let current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(getContinuityConfig(current).sourceAddressableMemory.mode, 'record');

    const rolledBack = applyRollbackFile(configPath, {
      now: '2026-05-05T18:02:00.000Z',
      backupDir: dir,
      confirm: true
    });
    assert.equal(rolledBack.ok, true);
    assert.ok(fs.existsSync(rolledBack.backupPath));
    current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const sam = getContinuityConfig(current).sourceAddressableMemory;
    assert.equal(sam.enabled, false);
    assert.equal(sam.mode, 'observe');
    assert.equal(sam.persistClaimCandidates, false);
    assert.equal(sam.createClaimsFromHandoffs, false);
  });

  await run('rollback preview is inert and keeps inject mode none', () => {
    const active = setContinuitySourceAddressableMemory(baseConfig(), {
      enabled: true,
      mode: 'record',
      storage: 'sqlite',
      injectMode: 'none',
      createClaimsFromHandoffs: true,
      createClaimsFromSummaries: false,
      createClaimsFromDigests: false,
      persistClaimCandidates: true,
      resolveOnDemand: true
    });
    const preview = previewRollback(active);
    assert.equal(preview.ok, true);
    assert.equal(preview.rollback.enabled, false);
    assert.equal(preview.rollback.injectMode, 'none');
    assert.equal(preview.rollback.createClaimsFromHandoffs, false);
  });

  await run('operator summary omits full next config from json output', () => {
    const preview = previewActivation(baseConfig(), { source: 'handoff' });
    const json = JSON.parse(renderOperatorSummary(preview, { format: 'json' }));
    assert.equal(json.ok, true);
    assert.equal(json.nextConfig, undefined);
    assert.equal(json.desired.mode, 'record');
  });

  await run('operator script plans, applies, and rolls back temp config only with --yes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-mode-operator-'));
    const configPath = path.join(dir, 'openclaw.json');
    fs.writeFileSync(configPath, JSON.stringify(baseConfig(), null, 2));
    const script = path.join(__dirname, '..', 'scripts', 'record-mode-operator.js');

    const plan = spawnSync(process.execPath, [script, 'plan', '--config', configPath, '--format', 'json'], { encoding: 'utf8' });
    assert.equal(plan.status, 0, plan.stderr);
    assert.equal(JSON.parse(plan.stdout).desired.mode, 'record');

    const refused = spawnSync(process.execPath, [script, 'apply', '--config', configPath], { encoding: 'utf8' });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /requires --yes/);

    const applied = spawnSync(process.execPath, [script, 'apply', '--config', configPath, '--backup-dir', dir, '--now', '2026-05-05T18:03:00.000Z', '--yes', '--format', 'json'], { encoding: 'utf8' });
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).action, 'apply');
    assert.equal(getContinuityConfig(JSON.parse(fs.readFileSync(configPath, 'utf8'))).sourceAddressableMemory.mode, 'record');

    const rolled = spawnSync(process.execPath, [script, 'rollback', '--config', configPath, '--backup-dir', dir, '--now', '2026-05-05T18:04:00.000Z', '--yes', '--format', 'json'], { encoding: 'utf8' });
    assert.equal(rolled.status, 0, rolled.stderr);
    assert.equal(JSON.parse(rolled.stdout).action, 'rollback');
    assert.equal(getContinuityConfig(JSON.parse(fs.readFileSync(configPath, 'utf8'))).sourceAddressableMemory.enabled, false);
  });

  await run('operator script refuses broad source activation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-mode-operator-'));
    const configPath = path.join(dir, 'openclaw.json');
    fs.writeFileSync(configPath, JSON.stringify(baseConfig(), null, 2));
    const script = path.join(__dirname, '..', 'scripts', 'record-mode-operator.js');
    const result = spawnSync(process.execPath, [script, 'plan', '--config', configPath, '--source', 'summary'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /limited to --source handoff/);
  });

  writeReportAndExit();
}

function baseConfig() {
  return {
    gateway: { mode: 'local' },
    plugins: {
      entries: {
        continuity: { enabled: true, config: {} },
        other: { enabled: true, config: { keep: true } }
      }
    }
  };
}

async function run(name, fn) {
  try {
    await fn();
    results.push({ name, status: 'PASS', detail: 'ok' });
  } catch (err) {
    results.push({ name, status: 'FAIL', detail: err.message });
  }
}

function writeReportAndExit() {
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.length - pass;
  const lines = [];
  lines.push('# Record Mode Operator Test Report');
  lines.push('');
  lines.push(`- PASS: ${pass}`);
  lines.push(`- FAIL: ${fail}`);
  lines.push(`- Total: ${results.length}`);
  lines.push('');
  lines.push('| Fixture | Status | Detail |');
  lines.push('|---|---:|---|');
  for (const result of results) lines.push(`| ${escapePipes(result.name)} | ${result.status} | ${escapePipes(result.detail || 'ok')} |`);
  lines.push('');

  const reportPath = path.join(__dirname, 'reports', 'record-mode-operator.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

  console.log(`Record mode operator tests: PASS=${pass} FAIL=${fail}`);
  console.log(`Report: ${path.relative(process.cwd(), reportPath)}`);
  if (fail) {
    for (const r of results.filter((r) => r.status === 'FAIL')) console.error(`${r.name}: ${r.detail}`);
    process.exit(1);
  }
}

function escapePipes(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}
