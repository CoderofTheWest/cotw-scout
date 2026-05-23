'use strict';

const crypto = require('crypto');
const os = require('os');

const TRACE_SCHEMA_VERSION = 1;

function randomSuffix(bytes = 6) {
  return crypto.randomBytes(bytes).toString('hex');
}

function compactTimestamp(value = Date.now()) {
  const ms = typeof value === 'number' && Number.isFinite(value) ? value : new Date(value).getTime();
  return Number.isFinite(ms) ? ms.toString(36) : Date.now().toString(36);
}

function createRunId({ now = Date.now(), pid = process.pid } = {}) {
  return `run_${compactTimestamp(now)}_${pid || 'p'}_${randomSuffix(4)}`;
}

function createExchangeContext({
  sessionId = '',
  threadId = '',
  mode = 'chat',
  runId,
  now = Date.now()
} = {}) {
  const exchangeId = `ex_${compactTimestamp(now)}_${randomSuffix(6)}`;
  return {
    exchangeId,
    turnId: createTurnId({ exchangeId, role: 'user', now }),
    runId: runId || createRunId({ now }),
    sessionId: safeId(sessionId, 160),
    threadId: safeId(threadId, 160),
    mode: safeId(mode || 'chat', 40),
    startedAt: now
  };
}

function createTurnId({ exchangeId = '', role = 'turn', now = Date.now() } = {}) {
  const rolePart = safeId(role, 24) || 'turn';
  const base = safeId(exchangeId, 80) || `ex_${compactTimestamp(now)}`;
  return `${base}:${rolePart}:${compactTimestamp(now)}:${randomSuffix(3)}`;
}

function safeId(value, max = 160) {
  return String(value || '')
    .replace(/[^A-Za-z0-9:_./-]/g, '_')
    .slice(0, max);
}

function redactTraceValue(value, max = 240) {
  let text = String(value ?? '');
  const home = os.homedir();
  if (home) text = text.replace(new RegExp(escapeRegExp(home) + '[^\\s)\'"`]*', 'g'), '[redacted-home-path]');
  text = text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
    .replace(/(?<![A-Za-z0-9])(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g, '[redacted-phone]')
    .replace(/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, '[redacted-anthropic-key]')
    .replace(/\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, '[redacted-openai-key]')
    .replace(/\b(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[redacted-github-token]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted-aws-key]')
    .replace(/\b(?:ya29\.[A-Za-z0-9_-]{10,}|xox[abprs]-[A-Za-z0-9-]{10,})\b/g, '[redacted-oauth-token]')
    .replace(/\b[A-Za-z0-9_=-]{40,}\b/g, '[redacted-token]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function normalizeTraceEvent(input = {}) {
  const now = Number.isFinite(Number(input.at)) ? Number(input.at) : Date.now();
  const event = {
    schemaVersion: TRACE_SCHEMA_VERSION,
    at: now,
    iso: new Date(now).toISOString(),
    exchangeId: safeId(input.exchangeId, 120),
    turnId: safeId(input.turnId, 180),
    runId: safeId(input.runId, 120),
    sessionId: safeId(input.sessionId, 160),
    threadId: safeId(input.threadId, 160),
    subsystem: safeId(input.subsystem || 'unknown', 80),
    eventType: safeId(input.eventType || 'event', 80),
    status: safeId(input.status || '', 80),
    requestId: safeId(input.requestId || '', 120),
    localId: safeId(input.localId || '', 160)
  };
  if (input.durationMs !== undefined) event.durationMs = boundedNumber(input.durationMs, null);
  if (input.count !== undefined) event.count = boundedNumber(input.count, null);
  if (input.errorCode) event.errorCode = redactTraceValue(input.errorCode, 120);
  if (input.note) event.note = redactTraceValue(input.note, 240);
  if (input.details && typeof input.details === 'object') {
    event.details = sanitizeTraceDetails(input.details);
  }
  return event;
}

function sanitizeTraceDetails(details = {}) {
  const out = {};
  for (const [key, value] of Object.entries(details).slice(0, 20)) {
    const safeKey = safeId(key, 80);
    if (!safeKey) continue;
    if (value === null || value === undefined) {
      out[safeKey] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out[safeKey] = value;
    } else {
      out[safeKey] = redactTraceValue(value, 240);
    }
  }
  return out;
}

function boundedNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  TRACE_SCHEMA_VERSION,
  createExchangeContext,
  createRunId,
  createTurnId,
  normalizeTraceEvent,
  redactTraceValue,
  safeId
};
