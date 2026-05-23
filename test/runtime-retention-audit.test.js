const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildRuntimeRetentionReport, formatRetentionReport } = require('../lib/runtime-retention-audit');
const { artifactRegistry, buildDefaultRuntimeRoots } = require('../lib/runtime-retention-registry');

function makeFixtureRuntime() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotw-retention-'));
  const userDataPath = path.join(dir, 'userData');
  const openclawHome = path.join(dir, 'openclaw');
  const workspacePath = path.join(userDataPath, 'workspace');
  const pluginsPath = path.join(dir, 'plugins');
  const sessionsDir = path.join(openclawHome, 'agents', 'trail-guide', 'sessions');
  const logsDir = path.join(openclawHome, 'logs');
  const spineDir = path.join(workspacePath, 'spine');
  const importsDir = path.join(workspacePath, 'imports');
  const harnessDir = path.join(pluginsPath, 'openclaw-plugin-harness-refiner', 'data', 'analysis');
  const cognitiveDir = path.join(pluginsPath, 'openclaw-plugin-cognitive-dynamics', 'data');
  const metabolismDir = path.join(pluginsPath, 'openclaw-plugin-metabolism', 'data', 'candidates');

  for (const target of [userDataPath, sessionsDir, logsDir, spineDir, importsDir, harnessDir, cognitiveDir, metabolismDir]) {
    fs.mkdirSync(target, { recursive: true });
  }

  fs.writeFileSync(path.join(logsDir, 'gateway.log'), 'gateway\n'.repeat(4));
  fs.writeFileSync(path.join(logsDir, 'electron-stream-debug.jsonl'), JSON.stringify({ type: 'done' }) + '\n');
  fs.writeFileSync(path.join(userDataPath, 'runtime-metrics.jsonl'), JSON.stringify({ type: 'process_sample', rssBytes: 1 }) + '\n');
  fs.writeFileSync(path.join(sessionsDir, 'sessions.json'), JSON.stringify([{ id: 's1' }]));
  fs.writeFileSync(path.join(sessionsDir, 's1.jsonl'), JSON.stringify({ role: 'user', content: 'hello' }) + '\n');
  fs.writeFileSync(path.join(sessionsDir, 's1.checkpoint.abc.jsonl'), JSON.stringify({ checkpoint: true }) + '\n');
  fs.writeFileSync(path.join(sessionsDir, 's1.trajectory.jsonl'), JSON.stringify({ step: 1 }) + '\n');
  fs.writeFileSync(path.join(spineDir, 'ledger.json'), JSON.stringify({ outcomeEvents: [] }));
  fs.writeFileSync(path.join(spineDir, 'ledger.archive.jsonl'), JSON.stringify({ archived: true }) + '\n');
  fs.writeFileSync(path.join(harnessDir, 'relabel-candidates.jsonl'), JSON.stringify({ id: 'cand-1' }) + '\n');
  fs.writeFileSync(path.join(harnessDir, 'teacher-relabels.jsonl'), JSON.stringify({ id: 'rel-1' }) + '\n');
  fs.writeFileSync(path.join(cognitiveDir, 'observations.jsonl'), JSON.stringify({ surprise: 0.7 }) + '\n');
  fs.writeFileSync(path.join(metabolismDir, 'candidate.json'), JSON.stringify({ entropy: 0.8 }));
  fs.writeFileSync(path.join(importsDir, 'clint-prime.jsonl'), JSON.stringify({ provenance: 'imported' }) + '\n');

  return { dir, userDataPath, openclawHome, workspacePath, pluginsPath };
}

test('runtime retention audit groups runtime artifacts without mutating files', () => {
  const fixture = makeFixtureRuntime();
  const before = fs.statSync(path.join(fixture.openclawHome, 'logs', 'gateway.log')).mtimeMs;

  const report = buildRuntimeRetentionReport({
    ...fixture,
    now: Date.parse('2026-05-23T00:00:00.000Z'),
  });

  const after = fs.statSync(path.join(fixture.openclawHome, 'logs', 'gateway.log')).mtimeMs;
  assert.equal(report.readOnly, true);
  assert.equal(before, after);
  assert.equal(report.status, 'healthy');
  assert.ok(report.summary.fileCount >= 10);
  assert.equal(report.researchDigest.trainingApproval, false);
  assert.ok(report.byLifecycleTier.hot.fileCount >= 2);
  assert.ok(report.byLifecycleTier.research_export.fileCount >= 1);
  assert.ok(report.bySourceType.imported_archive.fileCount >= 1);
  assert.ok(report.artifactClasses.every((entry) => entry.injectionEligible === false));

  const imported = report.artifactClasses.find((entry) => entry.id === 'imported-archives');
  assert.equal(imported.sourceType, 'imported_archive');
  assert.equal(imported.lifecycleTier, 'cold');

  const cognitive = report.artifactClasses.find((entry) => entry.id === 'cognitive-observations');
  assert.equal(cognitive.sourceType, 'cognitive_observation');
  assert.equal(cognitive.injectionEligible, false);
});

test('runtime retention audit reports policy pressure by artifact class', () => {
  const fixture = makeFixtureRuntime();
  fs.writeFileSync(path.join(fixture.openclawHome, 'logs', 'gateway.log'), 'x'.repeat(128));

  const registry = artifactRegistry().map((entry) => (
    entry.id === 'gateway-logs'
      ? { ...entry, budgets: { maxFileBytes: 16, warmMaxBytes: 16 } }
      : entry
  ));
  const report = buildRuntimeRetentionReport({ ...fixture, registry });

  assert.equal(report.status, 'over_budget');
  assert.ok(report.policyViolations.some((violation) => violation.classId === 'gateway-logs'));
  assert.equal(report.artifactClasses.find((entry) => entry.id === 'gateway-logs').status, 'over_budget');
});

test('runtime retention registry includes required lifecycle metadata', () => {
  const registry = artifactRegistry();
  const ids = new Set(registry.map((entry) => entry.id));
  for (const expected of ['gateway-logs', 'runtime-metrics', 'session-index', 'trajectory-windows', 'spine-hot-ledger', 'harness-refiner-analysis', 'teacher-relabels', 'imported-archives']) {
    assert.ok(ids.has(expected), `missing ${expected}`);
  }
  for (const entry of registry) {
    assert.ok(entry.owner, `${entry.id} owner`);
    assert.ok(entry.sourceType, `${entry.id} sourceType`);
    assert.ok(entry.lifecycleTier, `${entry.id} lifecycleTier`);
    assert.ok(entry.compactionStrategy, `${entry.id} compactionStrategy`);
    assert.ok(entry.exportPolicy, `${entry.id} exportPolicy`);
    assert.equal(entry.injectionEligible, false, `${entry.id} must not inject by default`);
  }

  const roots = buildDefaultRuntimeRoots({ homeDir: '/tmp/cotw-home', userDataPath: '/tmp/cotw-user', pluginsPath: '/tmp/cotw-plugins' });
  assert.equal(roots.sessionsDir, '/tmp/cotw-home/.openclaw-cotw/agents/trail-guide/sessions');
  assert.equal(roots.workspacePath, '/tmp/cotw-user/workspace');
});

test('runtime retention markdown is digestible for handoff', () => {
  const fixture = makeFixtureRuntime();
  const report = buildRuntimeRetentionReport(fixture);
  const markdown = formatRetentionReport(report);

  assert.match(markdown, /Runtime Retention Audit/);
  assert.match(markdown, /Largest Classes/);
  assert.match(markdown, /Research Digest/);
  assert.match(markdown, /Training approval: false/);
});
