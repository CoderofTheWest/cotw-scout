'use strict';

const fs = require('fs');

const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_MAX_ENTRIES = 1000;

const HOOK_BUDGETS_MS = {
  before_agent_start: 150,
  agent_end: 250,
};

function readTailLines(filePath, options = {}) {
  const maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;

  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) {
      return { exists: stat.isFile(), bytes: stat.size, lines: [] };
    }

    const bytesToRead = Math.min(stat.size, maxBytes);
    const start = stat.size - bytesToRead;
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, buffer, 0, bytesToRead, start);
    } finally {
      fs.closeSync(fd);
    }

    const text = buffer.toString('utf8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (start > 0 && lines.length > 0) lines.shift();
    return { exists: true, bytes: stat.size, lines };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { exists: false, bytes: 0, lines: [] };
    }
    return { exists: false, bytes: 0, lines: [], error: String(err.message || err) };
  }
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return 0;
  const index = Math.ceil((p / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(sortedValues.length - 1, index))];
}

function roundMs(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function summarizeGroup(entries) {
  const durations = entries
    .map((entry) => Number(entry.durationMs))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  const latest = entries[entries.length - 1] || {};
  return {
    count: entries.length,
    errorCount: entries.filter((entry) => entry.ok === false).length,
    avgMs: durations.length
      ? roundMs(durations.reduce((sum, value) => sum + value, 0) / durations.length)
      : 0,
    p95Ms: roundMs(percentile(durations, 95)),
    maxMs: roundMs(durations[durations.length - 1] || 0),
    latestAt: latest.timestamp || null,
    latestRssBytes: latest.rssBytes || null,
    latestHeapUsedBytes: latest.heapUsedBytes || null,
  };
}

function statusForHook(hookName, summary) {
  if (summary.errorCount > 0) return 'error';
  const budget = HOOK_BUDGETS_MS[hookName];
  if (budget && summary.p95Ms > budget) return 'over_budget';
  if (budget && summary.p95Ms > budget * 0.8) return 'near_budget';
  return 'healthy';
}

function buildRuntimeLoadReport(options = {}) {
  const metricsPath = options.metricsPath;
  const maxEntries = options.maxEntries || DEFAULT_MAX_ENTRIES;
  const tail = readTailLines(metricsPath, options);
  const parseErrors = [];
  const entries = [];
  const processSamples = [];
  const gatewayLogSamples = [];

  for (const line of tail.lines.slice(-maxEntries)) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.type === 'plugin_hook') entries.push(parsed);
      else if (parsed && parsed.type === 'process_sample') processSamples.push(parsed);
      else if (parsed && parsed.type === 'gateway_log_volume') gatewayLogSamples.push(parsed);
    } catch (err) {
      parseErrors.push(String(err.message || err));
    }
  }

  const byPlugin = new Map();
  const byHook = new Map();
  for (const entry of entries) {
    const pluginId = entry.pluginId || 'unknown';
    const hookName = entry.hookName || 'unknown';
    if (!byPlugin.has(pluginId)) byPlugin.set(pluginId, []);
    if (!byHook.has(hookName)) byHook.set(hookName, []);
    byPlugin.get(pluginId).push(entry);
    byHook.get(hookName).push(entry);
  }

  const plugins = [...byPlugin.entries()].map(([pluginId, pluginEntries]) => {
    const summary = summarizeGroup(pluginEntries);
    const slowestHook = pluginEntries.reduce((slowest, entry) => (
      Number(entry.durationMs || 0) > Number(slowest.durationMs || 0) ? entry : slowest
    ), {});
    return {
      pluginId,
      ...summary,
      slowestHook: slowestHook.hookName || null,
      slowestMs: roundMs(slowestHook.durationMs || 0),
    };
  }).sort((a, b) => b.p95Ms - a.p95Ms || b.errorCount - a.errorCount || a.pluginId.localeCompare(b.pluginId));

  const hooks = [...byHook.entries()].map(([hookName, hookEntries]) => {
    const summary = summarizeGroup(hookEntries);
    return {
      hookName,
      budgetMs: HOOK_BUDGETS_MS[hookName] || null,
      status: statusForHook(hookName, summary),
      ...summary,
    };
  }).sort((a, b) => {
    const statusRank = { error: 0, over_budget: 1, near_budget: 2, healthy: 3 };
    return (statusRank[a.status] ?? 4) - (statusRank[b.status] ?? 4)
      || b.p95Ms - a.p95Ms
      || a.hookName.localeCompare(b.hookName);
  });

  const slowest = entries
    .slice()
    .sort((a, b) => Number(b.durationMs || 0) - Number(a.durationMs || 0))
    .slice(0, 5)
    .map((entry) => ({
      pluginId: entry.pluginId || 'unknown',
      hookName: entry.hookName || 'unknown',
      durationMs: roundMs(entry.durationMs || 0),
      ok: entry.ok !== false,
      timestamp: entry.timestamp || null,
    }));

  const latestProcess = processSamples[processSamples.length - 1] || null;
  const gatewayLogVolume = gatewayLogSamples.reduce((acc, sample) => {
    acc.stdoutLines += Number(sample.stdoutLines || 0);
    acc.stderrLines += Number(sample.stderrLines || 0);
    acc.stdoutBytes += Number(sample.stdoutBytes || 0);
    acc.stderrBytes += Number(sample.stderrBytes || 0);
    return acc;
  }, { stdoutLines: 0, stderrLines: 0, stdoutBytes: 0, stderrBytes: 0 });

  const totalErrors = entries.filter((entry) => entry.ok === false).length;
  const overBudgetHooks = hooks.filter((hook) => hook.status === 'over_budget').length;
  const nearBudgetHooks = hooks.filter((hook) => hook.status === 'near_budget').length;
  const eventLoopP95Ms = Number(latestProcess?.eventLoopDelayP95Ms || 0);
  const eventLoopStatus = eventLoopP95Ms > 100 ? 'over_budget' : eventLoopP95Ms > 50 ? 'near_budget' : 'healthy';
  const hasRuntimeData = entries.length > 0 || processSamples.length > 0 || gatewayLogSamples.length > 0;
  const status = !tail.exists || !hasRuntimeData
    ? 'no_data'
    : totalErrors > 0
      ? 'error'
      : overBudgetHooks > 0 || eventLoopStatus === 'over_budget'
        ? 'over_budget'
        : nearBudgetHooks > 0 || eventLoopStatus === 'near_budget'
          ? 'near_budget'
          : 'healthy';

  return {
    status,
    readOnly: true,
    metricsPath,
    exists: tail.exists,
    bytes: tail.bytes,
    entriesAnalyzed: entries.length,
    processSamplesAnalyzed: processSamples.length,
    gatewayLogSamplesAnalyzed: gatewayLogSamples.length,
    linesRead: tail.lines.length,
    parseErrorCount: parseErrors.length,
    error: tail.error || null,
    generatedAt: new Date(options.now || Date.now()).toISOString(),
    summary: {
      pluginCount: plugins.length,
      hookCount: hooks.length,
      totalErrors,
      overBudgetHooks,
      nearBudgetHooks,
    },
    latestProcess,
    eventLoop: latestProcess ? {
      status: eventLoopStatus,
      p95Ms: latestProcess.eventLoopDelayP95Ms || 0,
      maxMs: latestProcess.eventLoopDelayMaxMs || 0,
      meanMs: latestProcess.eventLoopDelayMeanMs || 0,
      rssBytes: latestProcess.rssBytes || null,
      heapUsedBytes: latestProcess.heapUsedBytes || null,
      latestAt: latestProcess.timestamp || null,
    } : null,
    gatewayLogVolume,
    hooks,
    plugins: plugins.slice(0, 10),
    slowest,
  };
}

module.exports = {
  buildRuntimeLoadReport,
  readTailLines,
};
