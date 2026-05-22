#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const {
  createRecordModeProofPlan,
  renderRecordModeProofPlan,
  validateRecordModeProofConfig,
  validateRollbackConfig
} = require('../lib/record-mode-proof-plan');

const results = [];

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});

async function main() {
  await run('proof plan creates narrow handoff record-mode config and rollback', () => {
    const plan = createRecordModeProofPlan({ agentId: 'trail-guide', source: 'handoff', now: '2026-05-05T17:05:00.000Z' });
    assert.equal(plan.ok, true);
    assert.equal(plan.agentId, 'trail-guide');
    assert.equal(plan.source, 'handoff');
    assert.deepEqual(plan.desiredConfig.sourceAddressableMemory, {
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
    assert.equal(validateRollbackConfig(plan.rollbackConfig).ok, true);
    assert.ok(plan.safetyProperties.some((item) => item.includes('no prompt injection')));
  });

  await run('proof plan supports exactly one selected candidate source', () => {
    const summary = createRecordModeProofPlan({ source: 'summary' });
    assert.equal(summary.desiredConfig.sourceAddressableMemory.createClaimsFromHandoffs, false);
    assert.equal(summary.desiredConfig.sourceAddressableMemory.createClaimsFromSummaries, true);
    assert.equal(summary.desiredConfig.sourceAddressableMemory.createClaimsFromDigests, false);

    const digest = createRecordModeProofPlan({ source: 'digest' });
    assert.equal(digest.desiredConfig.sourceAddressableMemory.createClaimsFromHandoffs, false);
    assert.equal(digest.desiredConfig.sourceAddressableMemory.createClaimsFromSummaries, false);
    assert.equal(digest.desiredConfig.sourceAddressableMemory.createClaimsFromDigests, true);
  });

  await run('proof validator rejects prompt injection and disabled persistence', () => {
    const bad = validateRecordModeProofConfig({
      sourceAddressableMemory: {
        enabled: true,
        mode: 'record',
        storage: 'sqlite',
        injectMode: 'minimal',
        createClaimsFromHandoffs: true,
        createClaimsFromSummaries: false,
        createClaimsFromDigests: false,
        persistClaimCandidates: false,
        resolveOnDemand: true
      }
    }, { source: 'handoff' });
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.includes('sourceAddressableMemory.injectMode must remain none'));
    assert.ok(bad.errors.includes('sourceAddressableMemory.persistClaimCandidates must be true for proof config'));
  });

  await run('proof validator rejects broad candidate-source enablement', () => {
    const bad = validateRecordModeProofConfig({
      sourceAddressableMemory: {
        enabled: true,
        mode: 'record',
        storage: 'sqlite',
        injectMode: 'none',
        createClaimsFromHandoffs: true,
        createClaimsFromSummaries: true,
        createClaimsFromDigests: false,
        persistClaimCandidates: true,
        resolveOnDemand: true
      }
    }, { source: 'handoff' });
    assert.equal(bad.ok, false);
    assert.match(bad.errors.join('\n'), /exactly one candidate source/);
  });

  await run('rollback validator rejects any persistence or source generation left enabled', () => {
    const bad = validateRollbackConfig({
      sourceAddressableMemory: {
        enabled: false,
        mode: 'observe',
        storage: 'sqlite',
        injectMode: 'none',
        createClaimsFromHandoffs: true,
        createClaimsFromSummaries: false,
        createClaimsFromDigests: false,
        persistClaimCandidates: true,
        resolveOnDemand: true
      }
    });
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.includes('rollback must disable candidate persistence'));
    assert.ok(bad.errors.includes('rollback must disable createClaimsFromHandoffs'));
  });

  await run('markdown renderer emits dry-run checklist without applying anything', () => {
    const plan = createRecordModeProofPlan({ agentId: 'trail-guide', source: 'handoff', now: '2026-05-05T17:05:00.000Z' });
    const text = renderRecordModeProofPlan(plan);
    assert.match(text, /# Record Mode Proof Plan — handoff/);
    assert.match(text, /"mode": "record"/);
    assert.match(text, /"injectMode": "none"/);
    assert.match(text, /## Rollback Config/);
    assert.match(text, /- \[ \] snapshot current continuity config/);
    assert.match(text, /This renderer does not apply config/);
    assert.doesNotMatch(text, /gateway restart command/i);
  });

  await run('json renderer emits machine-readable dry-run boundaries', () => {
    const plan = createRecordModeProofPlan({ source: 'summary', now: '2026-05-05T17:05:00.000Z' });
    const rendered = renderRecordModeProofPlan(plan, { format: 'json' });
    const json = JSON.parse(rendered);
    assert.equal(json.ok, true);
    assert.equal(json.source, 'summary');
    assert.equal(json.desiredConfig.sourceAddressableMemory.createClaimsFromSummaries, true);
    assert.ok(json.boundaries.includes('no config apply'));
    assert.ok(json.boundaries.includes('no gateway restart'));
  });

  await run('unsupported proof source fails before plan creation', () => {
    assert.throws(() => createRecordModeProofPlan({ source: 'everything' }), /unsupported proof source/);
  });

  await run('renderer rejects unsupported output formats', () => {
    const plan = createRecordModeProofPlan({ source: 'handoff' });
    assert.throws(() => renderRecordModeProofPlan(plan, { format: 'html' }), /unsupported proof plan render format/);
  });

  await run('dry-run script renders markdown without runtime actions', () => {
    const script = path.join(__dirname, '..', 'scripts', 'record-mode-proof-plan.js');
    const result = spawnSync(process.execPath, [script, '--source', 'digest', '--agent', 'trail-guide', '--now', '2026-05-05T17:20:00.000Z'], {
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /# Record Mode Proof Plan — digest/);
    assert.match(result.stdout, /"createClaimsFromDigests": true/);
    assert.match(result.stdout, /This renderer does not apply config/);
    assert.doesNotMatch(result.stdout, /openclaw gateway restart/i);
  });

  await run('dry-run script renders json and rejects unsupported options', () => {
    const script = path.join(__dirname, '..', 'scripts', 'record-mode-proof-plan.js');
    const jsonResult = spawnSync(process.execPath, [script, '--source', 'summary', '--format', 'json', '--now', '2026-05-05T17:20:00.000Z'], {
      encoding: 'utf8'
    });
    assert.equal(jsonResult.status, 0, jsonResult.stderr);
    const json = JSON.parse(jsonResult.stdout);
    assert.equal(json.source, 'summary');
    assert.equal(json.desiredConfig.sourceAddressableMemory.createClaimsFromSummaries, true);
    assert.ok(json.boundaries.includes('no config apply'));

    const badResult = spawnSync(process.execPath, [script, '--source', 'everything'], { encoding: 'utf8' });
    assert.notEqual(badResult.status, 0);
    assert.match(badResult.stderr, /Unsupported source "everything"/);
  });

  await run('dry-run script is included in packaged plugin files', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.ok(packageJson.files.includes('scripts/'));
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'scripts', 'record-mode-proof-plan.js')));
  });

  await run('npm package dry-run includes executable proof-plan script', () => {
    const packageRoot = path.join(__dirname, '..');
    const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: packageRoot,
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const [pack] = JSON.parse(result.stdout);
    const files = new Map(pack.files.map((file) => [file.path, file]));
    const script = files.get('scripts/record-mode-proof-plan.js');
    assert.ok(script, 'record-mode proof-plan script missing from package dry-run');
    assert.ok(script.mode & 0o111, 'record-mode proof-plan script is not executable in package dry-run');
    assert.ok(files.has('lib/record-mode-proof-plan.js'), 'record-mode proof-plan library missing from package dry-run');
  });

  writeReportAndExit();
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
  lines.push('# Record Mode Proof Plan Test Report');
  lines.push('');
  lines.push(`- PASS: ${pass}`);
  lines.push(`- FAIL: ${fail}`);
  lines.push(`- Total: ${results.length}`);
  lines.push('');
  lines.push('| Fixture | Status | Detail |');
  lines.push('|---|---:|---|');
  for (const result of results) lines.push(`| ${escapePipes(result.name)} | ${result.status} | ${escapePipes(result.detail || 'ok')} |`);
  lines.push('');

  const reportPath = path.join(__dirname, 'reports', 'record-mode-proof-plan.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

  console.log(`Record mode proof plan tests: PASS=${pass} FAIL=${fail}`);
  console.log(`Report: ${path.relative(process.cwd(), reportPath)}`);
  if (fail) {
    for (const r of results.filter((r) => r.status === 'FAIL')) console.error(`${r.name}: ${r.detail}`);
    process.exit(1);
  }
}

function escapePipes(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}
