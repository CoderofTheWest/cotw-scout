const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(repoRoot, 'main.js'), 'utf8');
const runtimeMetrics = fs.readFileSync(path.join(repoRoot, 'bundled-plugins/lib/runtime-metrics.js'), 'utf8');
const runtimeLoadReport = fs.readFileSync(path.join(repoRoot, 'lib/runtime-load-report.js'), 'utf8');
const gui = fs.readFileSync(path.join(repoRoot, 'cotw-scout-gui.html'), 'utf8');

test('gateway stdout and stderr are batched before renderer status IPC', () => {
  assert.match(main, /function createStatusBatcher\(type, options = \{\}\)/);
  assert.match(main, /const gatewayLogBatcher = createStatusBatcher\('gateway-log'/);
  assert.match(main, /const gatewayErrorBatcher = createStatusBatcher\('gateway-error'/);
  assert.match(main, /gatewayLogBatcher\.push\(line\)/);
  assert.match(main, /gatewayErrorBatcher\.push\(line\)/);
  assert.doesNotMatch(main, /sendStatus\('gateway-log', line\)/);
  assert.doesNotMatch(main, /sendStatus\('gateway-error', line\)/);
});

test('gateway log volume and process sampler are recorded into runtime load metrics', () => {
  assert.match(main, /createGatewayLogVolumeRecorder/);
  assert.match(main, /type: 'gateway_log_volume'/);
  assert.match(main, /process\.env\.COTW_RUNTIME_METRICS_PATH/);
  assert.match(runtimeMetrics, /monitorEventLoopDelay/);
  assert.match(runtimeMetrics, /type: 'process_sample'/);
  assert.match(runtimeMetrics, /eventLoopDelayP95Ms/);
  assert.match(runtimeLoadReport, /processSamplesAnalyzed/);
  assert.match(runtimeLoadReport, /gatewayLogSamplesAnalyzed/);
  assert.match(runtimeLoadReport, /gatewayLogVolume/);
  assert.match(gui, /Event loop: p95/);
  assert.match(gui, /Gateway logs:/);
});
