#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const {
  applyActivationFile,
  applyRollbackFile,
  previewActivation,
  previewRollback,
  renderOperatorSummary,
  validateLiveConfig
} = require('../lib/claim-context-live-operator');
const { getContinuityConfig: readContinuityConfig } = require('../lib/record-mode-operator');

const results = [];

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});

async function main() {
  await run('live activation enables only accepted verified minimal injection', () => {
    const preview = previewActivation(stagedConfig(), { maxClaims: 6 });
    assert.equal(preview.ok, true);
    assert.equal(preview.nextConfig.gateway.mode, 'local');
    const sam = readContinuityConfig(preview.nextConfig).sourceAddressableMemory;
    assert.equal(sam.enabled, true);
    assert.equal(sam.mode, 'observe');
    assert.equal(sam.injectMode, 'none');
    assert.equal(sam.createClaimsFromHandoffs, false);
    assert.equal(sam.createClaimsFromSummaries, false);
    assert.equal(sam.createClaimsFromDigests, false);
    assert.equal(sam.persistClaimCandidates, false);
    assert.equal(sam.claimContext.enabled, true);
    assert.equal(sam.claimContext.mode, 'live');
    assert.equal(sam.claimContext.injectMode, 'minimal');
    assert.equal(sam.claimContext.acceptedVerifiedOnly, true);
    assert.equal(sam.claimContext.includeSourceExcerpts, false);
    assert.equal(sam.claimContext.maxClaims, 6);
  });

  await run('validation refuses recording flags, excerpts, and non-accepted injection', () => {
    const bad = validateLiveConfig({
      sourceAddressableMemory: {
        enabled: true,
        mode: 'record',
        injectMode: 'none',
        createClaimsFromHandoffs: true,
        persistClaimCandidates: true,
        claimContext: {
          enabled: true,
          mode: 'live',
          injectMode: 'minimal',
          acceptedVerifiedOnly: false,
          maxClaims: 8,
          includeSourceExcerpts: true
        }
      }
    });
    assert.equal(bad.ok, false);
    assert.match(bad.errors.join('; '), /mode must be observe/);
    assert.match(bad.errors.join('; '), /createClaimsFromHandoffs/);
    assert.match(bad.errors.join('; '), /persistClaimCandidates/);
    assert.match(bad.errors.join('; '), /acceptedVerifiedOnly must be true/);
    assert.match(bad.errors.join('; '), /includeSourceExcerpts must be false/);
  });

  await run('activation helper refuses to write without explicit confirm', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-context-live-operator-'));
    const configPath = path.join(dir, 'openclaw.json');
    fs.writeFileSync(configPath, JSON.stringify(stagedConfig(), null, 2));
    assert.throws(() => applyActivationFile(configPath, { maxClaims: 8 }), /explicit confirm=true/);
    const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(readContinuityConfig(after).sourceAddressableMemory.claimContext.enabled, false);
  });

  await run('activation writes backup and rollback disables claim-context live gate', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-context-live-operator-'));
    const configPath = path.join(dir, 'openclaw.json');
    fs.writeFileSync(configPath, JSON.stringify(stagedConfig(), null, 2));

    const applied = applyActivationFile(configPath, {
      maxClaims: 7,
      now: '2026-05-06T22:15:00.000Z',
      backupDir: dir,
      confirm: true
    });
    assert.equal(applied.ok, true);
    assert.ok(fs.existsSync(applied.backupPath));
    let current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    let sam = readContinuityConfig(current).sourceAddressableMemory;
    assert.equal(sam.claimContext.enabled, true);
    assert.equal(sam.claimContext.mode, 'live');
    assert.equal(sam.claimContext.injectMode, 'minimal');
    assert.equal(sam.claimContext.acceptedVerifiedOnly, true);

    const rolledBack = applyRollbackFile(configPath, {
      maxClaims: 7,
      now: '2026-05-06T22:16:00.000Z',
      backupDir: dir,
      confirm: true
    });
    assert.equal(rolledBack.ok, true);
    assert.ok(fs.existsSync(rolledBack.backupPath));
    current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    sam = readContinuityConfig(current).sourceAddressableMemory;
    assert.equal(sam.enabled, true);
    assert.equal(sam.mode, 'observe');
    assert.equal(sam.claimContext.enabled, false);
    assert.equal(sam.claimContext.mode, 'diagnostic');
    assert.equal(sam.claimContext.injectMode, 'none');
    assert.equal(sam.claimContext.acceptedVerifiedOnly, true);
  });

  await run('operator summary omits full next config from json output', () => {
    const preview = previewActivation(stagedConfig(), { maxClaims: 8 });
    const json = JSON.parse(renderOperatorSummary(preview, { format: 'json' }));
    assert.equal(json.ok, true);
    assert.equal(json.nextConfig, undefined);
    assert.equal(json.desired.claimContext.mode, 'live');
  });

  await run('operator script plans, applies, and rolls back temp config only with --yes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-context-live-operator-'));
    const configPath = path.join(dir, 'openclaw.json');
    fs.writeFileSync(configPath, JSON.stringify(stagedConfig(), null, 2));
    const script = path.join(__dirname, '..', 'scripts', 'claim-context-live-operator.js');

    const plan = spawnSync(process.execPath, [script, 'plan', '--config', configPath, '--max-claims', '5', '--format', 'json'], { encoding: 'utf8' });
    assert.equal(plan.status, 0, plan.stderr);
    assert.equal(JSON.parse(plan.stdout).desired.claimContext.maxClaims, 5);

    const refused = spawnSync(process.execPath, [script, 'apply', '--config', configPath], { encoding: 'utf8' });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /requires --yes/);

    const applied = spawnSync(process.execPath, [script, 'apply', '--config', configPath, '--backup-dir', dir, '--now', '2026-05-06T22:17:00.000Z', '--yes', '--format', 'json'], { encoding: 'utf8' });
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).action, 'apply');
    assert.equal(readContinuityConfig(JSON.parse(fs.readFileSync(configPath, 'utf8'))).sourceAddressableMemory.claimContext.injectMode, 'minimal');

    const rolled = spawnSync(process.execPath, [script, 'rollback', '--config', configPath, '--backup-dir', dir, '--now', '2026-05-06T22:18:00.000Z', '--yes', '--format', 'json'], { encoding: 'utf8' });
    assert.equal(rolled.status, 0, rolled.stderr);
    assert.equal(JSON.parse(rolled.stdout).action, 'rollback');
    assert.equal(readContinuityConfig(JSON.parse(fs.readFileSync(configPath, 'utf8'))).sourceAddressableMemory.claimContext.enabled, false);
  });

  await run('operator script rejects source excerpt flags', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-context-live-operator-'));
    const configPath = path.join(dir, 'openclaw.json');
    fs.writeFileSync(configPath, JSON.stringify(stagedConfig(), null, 2));
    const script = path.join(__dirname, '..', 'scripts', 'claim-context-live-operator.js');
    const excerpts = spawnSync(process.execPath, [script, 'plan', '--config', configPath, '--include-source-excerpts'], { encoding: 'utf8' });
    assert.notEqual(excerpts.status, 0);
    assert.match(excerpts.stderr, /source excerpts hidden/);
  });

  await run('rollback preview is valid and disables claim context', () => {
    const preview = previewRollback(liveConfig(), { maxClaims: 8 });
    assert.equal(preview.ok, true);
    assert.equal(preview.rollback.mode, 'observe');
    assert.equal(preview.rollback.claimContext.enabled, false);
    assert.equal(preview.rollback.claimContext.injectMode, 'none');
    assert.equal(preview.rollback.claimContext.acceptedVerifiedOnly, true);
  });

  writeReportAndExit();
}

function stagedConfig() {
  return {
    gateway: { mode: 'local' },
    plugins: {
      entries: {
        continuity: {
          enabled: true,
          config: {
            sourceAddressableMemory: {
              enabled: true,
              mode: 'observe',
              storage: 'sqlite',
              injectMode: 'none',
              createClaimsFromHandoffs: false,
              createClaimsFromSummaries: false,
              createClaimsFromDigests: false,
              persistClaimCandidates: false,
              resolveOnDemand: true,
              claimContext: {
                enabled: false,
                mode: 'diagnostic',
                injectMode: 'none',
                acceptedVerifiedOnly: true,
                maxClaims: 8,
                includeSourceExcerpts: false
              }
            }
          }
        },
        other: { enabled: true, config: { keep: true } }
      }
    }
  };
}

function liveConfig() {
  const config = stagedConfig();
  const sam = readContinuityConfig(config).sourceAddressableMemory;
  sam.claimContext = {
    enabled: true,
    mode: 'live',
    injectMode: 'minimal',
    acceptedVerifiedOnly: true,
    maxClaims: 8,
    includeSourceExcerpts: false
  };
  return config;
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
  lines.push('# Claim Context Live Operator Test Report');
  lines.push('');
  lines.push(`- PASS: ${pass}`);
  lines.push(`- FAIL: ${fail}`);
  lines.push(`- Total: ${results.length}`);
  lines.push('');
  lines.push('| Fixture | Status | Detail |');
  lines.push('|---|---:|---|');
  for (const result of results) lines.push(`| ${escapePipes(result.name)} | ${result.status} | ${escapePipes(result.detail || 'ok')} |`);
  lines.push('');

  const reportPath = path.join(__dirname, 'reports', 'claim-context-live-operator.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

  console.log(`Claim context live operator tests: PASS=${pass} FAIL=${fail}`);
  console.log(`Report: ${path.relative(process.cwd(), reportPath)}`);
  if (fail) {
    for (const r of results.filter((r) => r.status === 'FAIL')) console.error(`${r.name}: ${r.detail}`);
    process.exit(1);
  }
}

function escapePipes(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}
