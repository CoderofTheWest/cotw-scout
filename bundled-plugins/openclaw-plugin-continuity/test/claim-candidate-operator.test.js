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
  validateCandidateConfig,
  validateCandidateRollbackConfig
} = require('../lib/claim-candidate-operator');
const { getContinuityConfig } = require('../lib/record-mode-operator');

const results = [];

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});

async function main() {
  await run('activation enables one candidate source and preserves live verified gate', () => {
    const preview = previewActivation(liveConfig(), { source: 'handoff', maxClaims: 6 });
    assert.equal(preview.ok, true);
    const sam = getContinuityConfig(preview.nextConfig).sourceAddressableMemory;
    assert.equal(sam.enabled, true);
    assert.equal(sam.mode, 'record');
    assert.equal(sam.injectMode, 'none');
    assert.equal(sam.persistClaimCandidates, true);
    assert.equal(sam.createClaimsFromHandoffs, true);
    assert.equal(sam.createClaimsFromSummaries, false);
    assert.equal(sam.createClaimsFromDigests, false);
    assert.equal(sam.claimContext.enabled, true);
    assert.equal(sam.claimContext.mode, 'live');
    assert.equal(sam.claimContext.injectMode, 'minimal');
    assert.equal(sam.claimContext.acceptedVerifiedOnly, true);
    assert.equal(sam.claimContext.includeSourceExcerpts, false);
    assert.equal(sam.claimContext.maxClaims, 6);
  });

  await run('activation supports summary or digest but still exactly one source', () => {
    const summary = previewActivation(liveConfig(), { source: 'summary' });
    let sam = getContinuityConfig(summary.nextConfig).sourceAddressableMemory;
    assert.equal(sam.createClaimsFromHandoffs, false);
    assert.equal(sam.createClaimsFromSummaries, true);
    assert.equal(sam.createClaimsFromDigests, false);

    const digest = previewActivation(liveConfig(), { source: 'digest' });
    sam = getContinuityConfig(digest.nextConfig).sourceAddressableMemory;
    assert.equal(sam.createClaimsFromHandoffs, false);
    assert.equal(sam.createClaimsFromSummaries, false);
    assert.equal(sam.createClaimsFromDigests, true);
  });

  await run('validation rejects automatic belief promotion shapes', () => {
    const bad = validateCandidateConfig({
      sourceAddressableMemory: {
        enabled: true,
        mode: 'record',
        injectMode: 'minimal',
        persistClaimCandidates: true,
        createClaimsFromHandoffs: true,
        createClaimsFromSummaries: true,
        createClaimsFromDigests: false,
        claimContext: {
          enabled: true,
          mode: 'live',
          injectMode: 'minimal',
          acceptedVerifiedOnly: false,
          maxClaims: 8,
          includeSourceExcerpts: true
        }
      }
    }, { source: 'handoff' });
    assert.equal(bad.ok, false);
    assert.match(bad.errors.join('; '), /injectMode must remain none/);
    assert.match(bad.errors.join('; '), /exactly one candidate source/);
    assert.match(bad.errors.join('; '), /acceptedVerifiedOnly must remain true/);
    assert.match(bad.errors.join('; '), /includeSourceExcerpts must remain false/);
  });

  await run('activation helper refuses writes without explicit confirm', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-candidate-operator-'));
    const configPath = path.join(dir, 'openclaw.json');
    fs.writeFileSync(configPath, JSON.stringify(liveConfig(), null, 2));
    assert.throws(() => applyActivationFile(configPath, { source: 'handoff' }), /explicit confirm=true/);
    const sam = getContinuityConfig(JSON.parse(fs.readFileSync(configPath, 'utf8'))).sourceAddressableMemory;
    assert.equal(sam.mode, 'observe');
    assert.equal(sam.persistClaimCandidates, false);
  });

  await run('activation writes backup and rollback closes candidate lane while preserving live gate', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-candidate-operator-'));
    const configPath = path.join(dir, 'openclaw.json');
    fs.writeFileSync(configPath, JSON.stringify(liveConfig(), null, 2));

    const applied = applyActivationFile(configPath, {
      source: 'handoff',
      maxClaims: 7,
      now: '2026-05-06T23:00:00.000Z',
      backupDir: dir,
      confirm: true
    });
    assert.equal(applied.ok, true);
    assert.ok(fs.existsSync(applied.backupPath));
    let sam = getContinuityConfig(JSON.parse(fs.readFileSync(configPath, 'utf8'))).sourceAddressableMemory;
    assert.equal(sam.mode, 'record');
    assert.equal(sam.persistClaimCandidates, true);
    assert.equal(sam.claimContext.mode, 'live');

    const rolled = applyRollbackFile(configPath, {
      now: '2026-05-06T23:01:00.000Z',
      backupDir: dir,
      confirm: true
    });
    assert.equal(rolled.ok, true);
    assert.ok(fs.existsSync(rolled.backupPath));
    sam = getContinuityConfig(JSON.parse(fs.readFileSync(configPath, 'utf8'))).sourceAddressableMemory;
    assert.equal(sam.mode, 'observe');
    assert.equal(sam.persistClaimCandidates, false);
    assert.equal(sam.createClaimsFromHandoffs, false);
    assert.equal(sam.claimContext.enabled, true);
    assert.equal(sam.claimContext.mode, 'live');
    assert.equal(sam.claimContext.injectMode, 'minimal');
    assert.equal(sam.claimContext.acceptedVerifiedOnly, true);
  });

  await run('rollback validation requires candidate lane closed but live gate preserved', () => {
    const preview = previewRollback(candidateConfig());
    assert.equal(preview.ok, true);
    assert.equal(preview.rollback.mode, 'observe');
    assert.equal(preview.rollback.persistClaimCandidates, false);
    assert.equal(preview.rollback.claimContext.mode, 'live');

    const bad = validateCandidateRollbackConfig({ sourceAddressableMemory: { ...preview.rollback, persistClaimCandidates: true } });
    assert.equal(bad.ok, false);
    assert.match(bad.errors.join('; '), /disable candidate persistence/);
  });

  await run('operator summary omits full next config from json output', () => {
    const preview = previewActivation(liveConfig(), { source: 'handoff', maxClaims: 8 });
    const json = JSON.parse(renderOperatorSummary(preview, { format: 'json' }));
    assert.equal(json.ok, true);
    assert.equal(json.nextConfig, undefined);
    assert.equal(json.desired.mode, 'record');
    assert.equal(json.desired.claimContext.acceptedVerifiedOnly, true);
  });

  await run('operator script plans, applies, and rolls back temp config only with --yes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-candidate-operator-'));
    const configPath = path.join(dir, 'openclaw.json');
    fs.writeFileSync(configPath, JSON.stringify(liveConfig(), null, 2));
    const script = path.join(__dirname, '..', 'scripts', 'claim-candidate-operator.js');

    const plan = spawnSync(process.execPath, [script, 'plan', '--config', configPath, '--source', 'handoff', '--max-claims', '5', '--format', 'json'], { encoding: 'utf8' });
    assert.equal(plan.status, 0, plan.stderr);
    assert.equal(JSON.parse(plan.stdout).desired.claimContext.maxClaims, 5);

    const refused = spawnSync(process.execPath, [script, 'apply', '--config', configPath], { encoding: 'utf8' });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /requires --yes/);

    const applied = spawnSync(process.execPath, [script, 'apply', '--config', configPath, '--source', 'handoff', '--backup-dir', dir, '--now', '2026-05-06T23:02:00.000Z', '--yes', '--format', 'json'], { encoding: 'utf8' });
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).action, 'apply');
    assert.equal(getContinuityConfig(JSON.parse(fs.readFileSync(configPath, 'utf8'))).sourceAddressableMemory.mode, 'record');

    const rolled = spawnSync(process.execPath, [script, 'rollback', '--config', configPath, '--backup-dir', dir, '--now', '2026-05-06T23:03:00.000Z', '--yes', '--format', 'json'], { encoding: 'utf8' });
    assert.equal(rolled.status, 0, rolled.stderr);
    assert.equal(JSON.parse(rolled.stdout).action, 'rollback');
    assert.equal(getContinuityConfig(JSON.parse(fs.readFileSync(configPath, 'utf8'))).sourceAddressableMemory.mode, 'observe');
  });

  await run('operator script rejects promotion and excerpt flags', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-candidate-operator-'));
    const configPath = path.join(dir, 'openclaw.json');
    fs.writeFileSync(configPath, JSON.stringify(liveConfig(), null, 2));
    const script = path.join(__dirname, '..', 'scripts', 'claim-candidate-operator.js');
    const promote = spawnSync(process.execPath, [script, 'plan', '--config', configPath, '--promote'], { encoding: 'utf8' });
    assert.notEqual(promote.status, 0);
    assert.match(promote.stderr, /does not verify, accept, or promote/);
    const excerpts = spawnSync(process.execPath, [script, 'plan', '--config', configPath, '--include-source-excerpts'], { encoding: 'utf8' });
    assert.notEqual(excerpts.status, 0);
    assert.match(excerpts.stderr, /source excerpts must remain hidden/);
  });

  writeReportAndExit();
}

function liveConfig() {
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
                enabled: true,
                mode: 'live',
                injectMode: 'minimal',
                acceptedVerifiedOnly: true,
                maxClaims: 8,
                includeSourceExcerpts: false
              }
            }
          }
        }
      }
    }
  };
}

function candidateConfig() {
  const preview = previewActivation(liveConfig(), { source: 'handoff' });
  return preview.nextConfig;
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
  const pass = results.filter((result) => result.status === 'PASS').length;
  const fail = results.length - pass;
  const reportPath = path.join(__dirname, 'reports', 'claim-candidate-operator.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, [
    '# Claim Candidate Operator Test Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '| Test | Status | Detail |',
    '| --- | --- | --- |',
    ...results.map((result) => `| ${escapeMd(result.name)} | ${result.status} | ${escapeMd(result.detail)} |`),
    ''
  ].join('\n'));
  console.log(`Claim candidate operator tests: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) process.exit(1);
}

function escapeMd(value) {
  return String(value || '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}
