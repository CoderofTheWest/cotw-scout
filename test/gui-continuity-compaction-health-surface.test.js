const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(repoRoot, 'cotw-scout-gui.html'), 'utf8');
const preload = fs.readFileSync(path.join(repoRoot, 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(repoRoot, 'main.js'), 'utf8');

test('main exposes read-only continuity compaction health IPC', () => {
  assert.match(main, /buildContinuityHealthReport/);
  assert.match(main, /ipcMain\.handle\('openclaw:continuity-compaction-health'/);
  assert.match(main, /readOnly: true/);
  assert.match(main, /openclawHome: openclawProfileDir/);
  assert.match(main, /sessionKey: gatewaySessionKeyFor\(currentSessionId\)/);
  assert.doesNotMatch(main, /ipcMain\.handle\('openclaw:continuity-compaction-apply'/);
});

test('preload exposes continuity compaction health method', () => {
  assert.match(preload, /getContinuityCompactionHealth: \(\) => ipcRenderer\.invoke\('openclaw:continuity-compaction-health'\)/);
});

test('settings renders read-only continuity health card', () => {
  assert.match(html, /Continuity Health/);
  assert.match(html, /id="continuityCompactionSummary"/);
  assert.match(html, /id="continuityCompactionHealth"/);
  assert.match(html, /function loadContinuityCompactionHealth\(/);
  assert.match(html, /window\.cotw\.getContinuityCompactionHealth\(\)/);
  assert.match(html, /Read-only\. This does not change compaction settings or rotate transcripts\./);
  assert.match(html, /loadContinuityCompactionHealth\(\);/);
});

test('settings renders read-only runtime load card', () => {
  assert.match(main, /buildRuntimeLoadReport/);
  assert.match(main, /ipcMain\.handle\('openclaw:runtime-load-report'/);
  assert.match(main, /runtime-metrics\.jsonl/);
  assert.match(preload, /getRuntimeLoadReport: \(\) => ipcRenderer\.invoke\('openclaw:runtime-load-report'\)/);
  assert.match(html, /Runtime Load/);
  assert.match(html, /id="runtimeLoadSummary"/);
  assert.match(html, /id="runtimeLoadHealth"/);
  assert.match(html, /function loadRuntimeLoadReport\(/);
  assert.match(html, /window\.cotw\.getRuntimeLoadReport\(\)/);
  assert.match(html, /Read-only\. Uses local hook metrics from this app profile\./);
  assert.match(html, /loadRuntimeLoadReport\(\);/);
});

test('settings renders read-only runtime retention card', () => {
  assert.match(main, /buildRuntimeRetentionReport/);
  assert.match(main, /ipcMain\.handle\('openclaw:runtime-retention-report'/);
  assert.match(main, /openclawHome: openclawProfileDir/);
  assert.match(main, /pluginsPath/);
  assert.match(preload, /getRuntimeRetentionReport: \(\) => ipcRenderer\.invoke\('openclaw:runtime-retention-report'\)/);
  assert.match(html, /Retention Health/);
  assert.match(html, /id="runtimeRetentionSummary"/);
  assert.match(html, /id="runtimeRetentionHealth"/);
  assert.match(html, /function loadRuntimeRetentionReport\(/);
  assert.match(html, /window\.cotw\.getRuntimeRetentionReport\(\)/);
  assert.match(html, /Read-only\. This audits lifecycle pressure and research data; it does not rotate, archive, delete, train, or inject context\./);
  assert.match(html, /loadRuntimeRetentionReport\(\);/);
  assert.doesNotMatch(main, /ipcMain\.handle\('openclaw:runtime-retention-apply'/);
});
