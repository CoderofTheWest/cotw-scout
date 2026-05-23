const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(repoRoot, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(repoRoot, 'preload.js'), 'utf8');
const guiPath = fs.existsSync(path.join(repoRoot, 'cotw-trail-guide-gui.html'))
  ? path.join(repoRoot, 'cotw-trail-guide-gui.html')
  : path.join(repoRoot, 'cotw-scout-gui.html');
const gui = fs.readFileSync(guiPath, 'utf8');

const { createExchangeContext, createRunId, normalizeTraceEvent } = require('../lib/exchange-spine');
const { appendExchangeTrace, readExchangeTrace } = require('../lib/exchange-trace-store');
const { runDiagnosticTriage } = require('../lib/diagnostic-triage');
const { buildRecentSymptomsReport } = require('../lib/diagnostic-recurrence');
const { exportDiagnosticBundle } = require('../lib/diagnostic-bundle');

test('exchange spine creates shared exchange, turn, and run ids', () => {
  const runId = createRunId({ now: 1770000000000, pid: 1234 });
  const context = createExchangeContext({
    sessionId: 'session_1',
    threadId: 'thread_1',
    mode: 'chat',
    runId,
    now: 1770000000000
  });

  assert.match(runId, /^run_/);
  assert.match(context.exchangeId, /^ex_/);
  assert.match(context.turnId, new RegExp(`^${context.exchangeId}:user:`));
  assert.equal(context.runId, runId);
  assert.equal(context.sessionId, 'session_1');
});

test('exchange trace events redact sensitive values and avoid raw content fields', () => {
  const entry = normalizeTraceEvent({
    exchangeId: 'ex_test',
    turnId: 'turn_test',
    runId: 'run_test',
    sessionId: 'session_test',
    subsystem: 'gateway',
    eventType: 'stream_error',
    status: 'error',
    requestId: 'request_test',
    note: `operator@example.com ${os.homedir()}/secret sk-proj-abcdefghijklmnopqrstuvwxyz1234567890`,
    details: {
      messageBody: 'this should be compact metadata only',
      token: 'ghp_abcdefghijklmnopqrstuvwxyz123456'
    }
  });

  const serialized = JSON.stringify(entry);
  assert.doesNotMatch(serialized, /operator@example\.com/);
  assert.doesNotMatch(serialized, new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(serialized, /sk-proj-|ghp_/);
  assert.match(serialized, /\[redacted-email\]/);
  assert.match(serialized, /\[redacted-home-path\]/);
  assert.match(serialized, /\[redacted-openai-key\]/);
  assert.equal(Object.hasOwn(entry, 'content'), false);
});

test('trace store appends and queries by exchange id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exchange-trace-'));
  const tracePath = path.join(dir, 'exchange-trace.jsonl');
  appendExchangeTrace(tracePath, {
    exchangeId: 'ex_a',
    turnId: 'turn_a',
    runId: 'run_a',
    subsystem: 'gateway',
    eventType: 'request_start'
  });
  appendExchangeTrace(tracePath, {
    exchangeId: 'ex_b',
    turnId: 'turn_b',
    runId: 'run_a',
    subsystem: 'gateway',
    eventType: 'request_start'
  });

  const entries = readExchangeTrace(tracePath, { exchangeId: 'ex_b' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].exchangeId, 'ex_b');
});

test('diagnostic triage identifies renderer stop-button clear delay', () => {
  const entries = [
    { at: 1000, iso: 't1', exchangeId: 'ex_1', requestId: 'req_1', subsystem: 'gateway', eventType: 'request_start' },
    { at: 1500, iso: 't2', exchangeId: 'ex_1', requestId: 'req_1', subsystem: 'gateway', eventType: 'first_token' },
    { at: 3000, iso: 't3', exchangeId: 'ex_1', requestId: 'req_1', subsystem: 'gateway', eventType: 'stream_done' },
    { at: 76000, iso: 't4', exchangeId: 'ex_1', requestId: 'req_1', subsystem: 'renderer', eventType: 'stop_button_cleared' }
  ];

  const report = runDiagnosticTriage({ entries, symptoms: ['stop_button_stuck'] });
  assert.equal(report.likelyIssue, 'renderer_stop_button_clear_delay');
  assert.equal(report.severity, 'high');
  assert.equal(report.timings.doneToStopClearedMs, 73000);
  assert.ok(report.excludedExplanations.includes('provider_still_streaming'));
});

test('diagnostic triage prefers provider/gateway stream errors over renderer cleanup', () => {
  const entries = [
    { at: 1000, iso: 't1', exchangeId: 'ex_2', requestId: 'req_2', subsystem: 'gateway', eventType: 'request_start' },
    { at: 1200, iso: 't2', exchangeId: 'ex_2', requestId: 'req_2', subsystem: 'gateway', eventType: 'stream_error', status: 'error', note: 'connection reset' }
  ];

  const report = runDiagnosticTriage({ entries, symptoms: ['internal_error'] });
  assert.equal(report.likelyIssue, 'gateway_or_provider_stream_error');
  assert.equal(report.severity, 'high');
});

test('recent symptom report groups recurring actionable exchange issues', () => {
  const entries = [
    { at: 1000, iso: 't1', exchangeId: 'ex_1', requestId: 'req_1', subsystem: 'gateway', eventType: 'request_start' },
    { at: 3000, iso: 't2', exchangeId: 'ex_1', requestId: 'req_1', subsystem: 'gateway', eventType: 'stream_done' },
    { at: 76000, iso: 't3', exchangeId: 'ex_1', requestId: 'req_1', subsystem: 'renderer', eventType: 'stop_button_cleared' },
    { at: 2000, iso: 't4', exchangeId: 'ex_2', requestId: 'req_2', subsystem: 'gateway', eventType: 'request_start' },
    { at: 5000, iso: 't5', exchangeId: 'ex_2', requestId: 'req_2', subsystem: 'gateway', eventType: 'stream_done' },
    { at: 42000, iso: 't6', exchangeId: 'ex_2', requestId: 'req_2', subsystem: 'renderer', eventType: 'stop_button_cleared' },
    { at: 3000, iso: 't7', exchangeId: 'ex_3', requestId: 'req_3', subsystem: 'gateway', eventType: 'request_start' },
    { at: 3500, iso: 't8', exchangeId: 'ex_3', requestId: 'req_3', subsystem: 'gateway', eventType: 'stream_done' },
    { at: 3600, iso: 't9', exchangeId: 'ex_3', requestId: 'req_3', subsystem: 'renderer', eventType: 'stop_button_cleared' }
  ];

  const report = buildRecentSymptomsReport({ entries, sinceMs: 0, now: 100000 });
  const stop = report.symptoms.find((symptom) => symptom.symptom === 'renderer_stop_button_clear_delay');

  assert.equal(report.ok, true);
  assert.equal(report.exchangeCount, 3);
  assert.equal(stop.count, 2);
  assert.equal(stop.recurring, true);
  assert.deepEqual(new Set(stop.exchangeIds), new Set(['ex_1', 'ex_2']));
  assert.equal(report.symptoms.some((symptom) => symptom.symptom === 'stream_completed_normally'), false);
});

test('diagnostic bundle export writes sealed manifest and merkle root changes with trace evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-bundle-'));
  const tracePath = path.join(dir, 'exchange-trace.jsonl');
  const receiptsPath = path.join(dir, 'diagnostic-receipts.jsonl');
  const outputRoot = path.join(dir, 'bundles');
  appendExchangeTrace(tracePath, {
    at: 1000,
    exchangeId: 'ex_bundle',
    turnId: 'turn_bundle',
    runId: 'run_bundle',
    sessionId: 'session_bundle',
    subsystem: 'gateway',
    eventType: 'request_start',
    requestId: 'req_bundle'
  });
  fs.writeFileSync(receiptsPath, JSON.stringify({
    schemaVersion: 1,
    type: 'diagnostic_triage_receipt',
    id: 'receipt-1',
    createdAt: '2026-05-22T12:00:00.000Z',
    exchangeIds: ['ex_bundle'],
    likelyIssue: 'renderer_stop_button_clear_delay',
    readOnly: true
  }) + '\n');

  const first = exportDiagnosticBundle({
    tracePath,
    receiptsPath,
    outputRoot,
    exchangeId: 'ex_bundle',
    bundleId: 'bundle-one',
    now: '2026-05-22T12:00:00.000Z'
  });
  appendExchangeTrace(tracePath, {
    at: 2000,
    exchangeId: 'ex_bundle',
    turnId: 'turn_bundle',
    runId: 'run_bundle',
    sessionId: 'session_bundle',
    subsystem: 'gateway',
    eventType: 'stream_done',
    requestId: 'req_bundle'
  });
  const second = exportDiagnosticBundle({
    tracePath,
    receiptsPath,
    outputRoot,
    exchangeId: 'ex_bundle',
    bundleId: 'bundle-two',
    now: '2026-05-22T12:01:00.000Z'
  });

  assert.equal(first.manifest.trainingApproval, false);
  assert.equal(first.manifest.adapterPromotionAuthorized, false);
  assert.match(first.manifest.merkleRoot, /^sha256:/);
  assert.notEqual(first.manifest.merkleRoot, second.manifest.merkleRoot);
  assert.ok(fs.existsSync(path.join(first.bundleDir, 'manifest.json')));
  assert.ok(fs.existsSync(path.join(first.bundleDir, 'exchange-trace.jsonl')));
});

test('diagnostic bundle export fails closed before writing when validation rejects payload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-bundle-reject-'));
  const tracePath = path.join(dir, 'exchange-trace.jsonl');
  const outputRoot = path.join(dir, 'bundles');
  appendExchangeTrace(tracePath, {
    exchangeId: 'ex_reject',
    subsystem: 'gateway',
    eventType: 'request_start'
  });

  assert.throws(() => exportDiagnosticBundle({
    tracePath,
    outputRoot,
    exchangeId: 'ex_reject',
    bundleId: 'bundle-reject',
    redactionValidator: () => ({
      ok: false,
      validatorVersion: 'test-validator',
      checkedPatterns: ['email'],
      leakCounts: { email: 1 },
      leakCount: 1
    })
  }), /redaction validation failed/);
  assert.equal(fs.existsSync(path.join(outputRoot, 'bundle-reject')), false);
});

test('main/preload/gui expose first-slice diagnostic spine wiring', () => {
  assert.match(main, /const currentRunId = createRunId\(\)/);
  assert.match(main, /diagnostics:get-exchange-trace/);
  assert.match(main, /diagnostics:run-triage/);
  assert.match(main, /diagnostics:get-recent-symptoms/);
  assert.match(main, /diagnostics:export-bundle/);
  assert.match(main, /diagnostics:renderer-event/);
  assert.match(main, /eventType: 'request_start'/);
  assert.match(main, /eventType: 'stream_done'/);
  assert.match(main, /eventType: 'first_token'/);
  assert.match(preload, /runDiagnosticsTriage: \(input\) => ipcRenderer\.invoke\('diagnostics:run-triage', input\)/);
  assert.match(preload, /getRecentDiagnosticSymptoms: \(input\) => ipcRenderer\.invoke\('diagnostics:get-recent-symptoms', input\)/);
  assert.match(preload, /exportDiagnosticBundle: \(input\) => ipcRenderer\.invoke\('diagnostics:export-bundle', input\)/);
  assert.match(preload, /recordDiagnosticRendererEvent: \(input\) => ipcRenderer\.invoke\('diagnostics:renderer-event', input\)/);
  assert.match(gui, /Diagnose last response/);
  assert.match(gui, /Review recent symptoms/);
  assert.match(gui, /Export diagnostic bundle/);
  assert.match(gui, /eventType: 'stop_button_cleared'/);
});
