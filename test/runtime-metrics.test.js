const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { instrumentApiHooks, startRuntimeMetricsSampler } = require('../bundled-plugins/lib/runtime-metrics');

test('instrumentApiHooks records sync and async hook timings without changing return values', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotw-runtime-metrics-'));
  const metricsPath = path.join(dir, 'runtime-metrics.jsonl');
  const previousPath = process.env.OPENCLAW_RUNTIME_METRICS_PATH;
  process.env.OPENCLAW_RUNTIME_METRICS_PATH = metricsPath;

  const registrations = [];
  const api = {
    on: (hookName, handler, options) => {
      registrations.push({ hookName, handler, options });
      return 'registered';
    }
  };

  try {
    const wrapped = instrumentApiHooks(api, 'test-plugin');
    assert.equal(wrapped.on('agent_end', () => ({ ok: true }), { priority: 1 }), 'registered');
    assert.deepEqual(registrations[0].handler({}, { agentId: 'ellis' }), { ok: true });

    wrapped.on('before_agent_start', async () => 'async-ok');
    assert.equal(await registrations[1].handler({}, { agentId: 'ellis' }), 'async-ok');

    await new Promise((resolve) => setTimeout(resolve, 25));
    const lines = fs.readFileSync(metricsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((line) => line.pluginId), ['test-plugin', 'test-plugin']);
    assert.deepEqual(lines.map((line) => line.hookName).sort(), ['agent_end', 'before_agent_start']);
    assert.equal(lines.every((line) => line.ok === true), true);
    assert.equal(lines.every((line) => Number.isFinite(line.durationMs)), true);
    assert.equal(lines.every((line) => line.agentId === 'ellis'), true);
  } finally {
    if (previousPath === undefined) delete process.env.OPENCLAW_RUNTIME_METRICS_PATH;
    else process.env.OPENCLAW_RUNTIME_METRICS_PATH = previousPath;
  }
});

test('runtime metrics sampler records process memory and event-loop delay samples once per process', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotw-runtime-sampler-'));
  const metricsPath = path.join(dir, 'runtime-metrics.jsonl');
  const previousPath = process.env.OPENCLAW_RUNTIME_METRICS_PATH;
  process.env.OPENCLAW_RUNTIME_METRICS_PATH = metricsPath;

  const sampler = startRuntimeMetricsSampler({ intervalMs: 1000, force: true });
  try {
    assert.equal(sampler.running, true);
    await new Promise((resolve) => setTimeout(resolve, 1250));
    sampler.stop();

    const lines = fs.readFileSync(metricsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const sample = lines.find((line) => line.type === 'process_sample');
    assert.ok(sample);
    assert.equal(Number.isFinite(sample.rssBytes), true);
    assert.equal(Number.isFinite(sample.heapUsedBytes), true);
    assert.equal(Number.isFinite(sample.eventLoopDelayP95Ms), true);
    assert.equal(Number.isFinite(sample.eventLoopDelayMaxMs), true);
  } finally {
    sampler.stop?.();
    if (previousPath === undefined) delete process.env.OPENCLAW_RUNTIME_METRICS_PATH;
    else process.env.OPENCLAW_RUNTIME_METRICS_PATH = previousPath;
  }
});
