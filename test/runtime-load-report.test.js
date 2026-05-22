const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildRuntimeLoadReport } = require('../lib/runtime-load-report');

test('runtime load report summarizes hook metrics without mutating runtime state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotw-runtime-load-'));
  const metricsPath = path.join(dir, 'runtime-metrics.jsonl');
  const lines = [
    { timestamp: '2026-05-21T00:00:00.000Z', type: 'plugin_hook', pluginId: 'continuity', hookName: 'before_agent_start', durationMs: 100, ok: true, rssBytes: 1000, heapUsedBytes: 500 },
    { timestamp: '2026-05-21T00:00:01.000Z', type: 'plugin_hook', pluginId: 'continuity', hookName: 'before_agent_start', durationMs: 220, ok: true, rssBytes: 1200, heapUsedBytes: 600 },
    { timestamp: '2026-05-21T00:00:02.000Z', type: 'plugin_hook', pluginId: 'telemetry', hookName: 'agent_end', durationMs: 40, ok: false, error: 'boom', rssBytes: 1300, heapUsedBytes: 700 },
    { timestamp: '2026-05-21T00:00:02.500Z', type: 'process_sample', rssBytes: 2000, heapUsedBytes: 900, eventLoopDelayP95Ms: 12, eventLoopDelayMaxMs: 20, eventLoopDelayMeanMs: 5 },
    { timestamp: '2026-05-21T00:00:02.750Z', type: 'gateway_log_volume', stdoutLines: 4, stderrLines: 1, stdoutBytes: 200, stderrBytes: 50 },
  ];
  fs.writeFileSync(metricsPath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');

  const report = buildRuntimeLoadReport({ metricsPath, now: Date.parse('2026-05-21T00:00:03.000Z') });

  assert.equal(report.readOnly, true);
  assert.equal(report.exists, true);
  assert.equal(report.entriesAnalyzed, 3);
  assert.equal(report.processSamplesAnalyzed, 1);
  assert.equal(report.gatewayLogSamplesAnalyzed, 1);
  assert.equal(report.status, 'error');
  assert.equal(report.summary.pluginCount, 2);
  assert.equal(report.summary.totalErrors, 1);
  assert.equal(report.hooks.find((hook) => hook.hookName === 'before_agent_start').status, 'over_budget');
  assert.equal(report.hooks.find((hook) => hook.hookName === 'agent_end').status, 'error');
  assert.equal(report.plugins[0].pluginId, 'continuity');
  assert.deepEqual(report.slowest[0], {
    pluginId: 'continuity',
    hookName: 'before_agent_start',
    durationMs: 220,
    ok: true,
    timestamp: '2026-05-21T00:00:01.000Z',
  });
  assert.equal(report.eventLoop.p95Ms, 12);
  assert.equal(report.gatewayLogVolume.stdoutLines, 4);
  assert.equal(report.gatewayLogVolume.stderrBytes, 50);
});

test('runtime load report handles missing metrics file as no data', () => {
  const report = buildRuntimeLoadReport({ metricsPath: path.join(os.tmpdir(), 'missing-runtime-metrics.jsonl') });

  assert.equal(report.readOnly, true);
  assert.equal(report.exists, false);
  assert.equal(report.status, 'no_data');
  assert.equal(report.entriesAnalyzed, 0);
});
