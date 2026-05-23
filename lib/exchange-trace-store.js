'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeTraceEvent, safeId } = require('./exchange-spine');

function appendExchangeTrace(tracePath, event) {
  const entry = normalizeTraceEvent(event);
  if (!entry.exchangeId && !entry.requestId) return { ok: false, skipped: true, reason: 'missing_exchange_or_request' };
  try {
    fs.mkdirSync(path.dirname(tracePath), { recursive: true });
    fs.appendFileSync(tracePath, JSON.stringify(entry) + '\n');
    return { ok: true, entry };
  } catch (err) {
    return { ok: false, error: String(err.message || err), entry };
  }
}

function readExchangeTrace(tracePath, { exchangeId = '', requestId = '', sinceMs = 0, limit = 500 } = {}) {
  const targetExchange = safeId(exchangeId, 120);
  const targetRequest = safeId(requestId, 120);
  const since = Number(sinceMs) || 0;
  const max = Math.max(1, Math.min(2000, Number(limit) || 500));
  if (!fs.existsSync(tracePath)) return [];
  const lines = tailLines(tracePath, 5000);
  const entries = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (targetExchange && entry.exchangeId !== targetExchange) continue;
      if (targetRequest && entry.requestId !== targetRequest) continue;
      if (since && Number(entry.at || 0) < since) continue;
      entries.push(entry);
    } catch { /* skip malformed lines */ }
  }
  return entries.slice(-max);
}

function getLatestExchangeId(tracePath) {
  const entries = readExchangeTrace(tracePath, { limit: 500 });
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].exchangeId) return entries[index].exchangeId;
  }
  return '';
}

function tailLines(filePath, maxLines = 5000) {
  const stat = fs.statSync(filePath);
  const length = Math.min(stat.size, 4 * 1024 * 1024);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, Math.max(0, stat.size - length));
    return buffer.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-maxLines);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  appendExchangeTrace,
  getLatestExchangeId,
  readExchangeTrace
};
