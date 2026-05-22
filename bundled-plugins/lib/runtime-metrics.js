'use strict';

const fs = require('fs');
const path = require('path');
const { monitorEventLoopDelay } = require('perf_hooks');

function runtimeMetricsPath() {
    const configured = process.env.OPENCLAW_RUNTIME_METRICS_PATH || process.env.COTW_RUNTIME_METRICS_PATH;
    if (configured) return configured;
    return null;
}

function appendMetric(entry) {
    const filePath = runtimeMetricsPath();
    if (!filePath) return;

    const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        ...entry,
    }) + '\n';

    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.appendFile(filePath, line, () => {});
    } catch {
        // Metrics must never affect runtime behavior.
    }
}

function roundMetric(value) {
    return Math.round(Number(value || 0) * 1000) / 1000;
}

function startRuntimeMetricsSampler(options = {}) {
    const filePath = runtimeMetricsPath();
    if (!filePath) return { started: false, reason: 'metrics_path_unset' };

    const globalKey = '__cotwRuntimeMetricsSampler';
    if (!options.force && global[globalKey]?.running) return global[globalKey];
    if (options.force && global[globalKey]?.running) global[globalKey].stop();

    const intervalMs = Math.max(1000, Number(options.intervalMs || process.env.OPENCLAW_RUNTIME_METRICS_INTERVAL_MS || 10000));
    const histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();

    const sampler = {
        running: true,
        intervalMs,
        stop() {
            if (!sampler.running) return;
            sampler.running = false;
            clearInterval(timer);
            histogram.disable();
            if (global[globalKey] === sampler) delete global[globalKey];
        },
    };

    const timer = setInterval(() => {
        const memory = process.memoryUsage();
        appendMetric({
            type: 'process_sample',
            rssBytes: memory.rss,
            heapUsedBytes: memory.heapUsed,
            heapTotalBytes: memory.heapTotal,
            externalBytes: memory.external,
            eventLoopDelayMeanMs: roundMetric(histogram.mean / 1e6),
            eventLoopDelayMaxMs: roundMetric(histogram.max / 1e6),
            eventLoopDelayP95Ms: roundMetric(histogram.percentile(95) / 1e6),
        });
        histogram.reset();
    }, intervalMs);

    if (typeof timer.unref === 'function') timer.unref();
    global[globalKey] = sampler;
    return sampler;
}

function recordHookMetric({ pluginId, hookName, startedAtNs, ok, error, ctx }) {
    const durationMs = Number(process.hrtime.bigint() - startedAtNs) / 1e6;
    const memory = process.memoryUsage();
    appendMetric({
        type: 'plugin_hook',
        pluginId,
        hookName,
        durationMs: Math.round(durationMs * 1000) / 1000,
        ok: ok === true,
        error: error ? String(error.message || error).slice(0, 500) : null,
        agentId: ctx?.agentId || null,
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
    });
}

function instrumentApiHooks(api, pluginId) {
    if (!api || typeof api.on !== 'function' || api.__cotwHookMetricsWrapped) return api;
    startRuntimeMetricsSampler();

    const originalOn = api.on.bind(api);
    api.on = (hookName, handler, options) => {
        if (typeof handler !== 'function') {
            return originalOn(hookName, handler, options);
        }

        const wrapped = function instrumentedHook(event, ctx) {
            const startedAtNs = process.hrtime.bigint();
            try {
                const result = handler(event, ctx);
                if (result && typeof result.then === 'function') {
                    return result.then((value) => {
                        recordHookMetric({ pluginId, hookName, startedAtNs, ok: true, ctx });
                        return value;
                    }, (err) => {
                        recordHookMetric({ pluginId, hookName, startedAtNs, ok: false, error: err, ctx });
                        throw err;
                    });
                }
                recordHookMetric({ pluginId, hookName, startedAtNs, ok: true, ctx });
                return result;
            } catch (err) {
                recordHookMetric({ pluginId, hookName, startedAtNs, ok: false, error: err, ctx });
                throw err;
            }
        };

        return originalOn(hookName, wrapped, options);
    };
    api.__cotwHookMetricsWrapped = true;
    return api;
}

module.exports = {
    appendMetric,
    instrumentApiHooks,
    startRuntimeMetricsSampler,
};
