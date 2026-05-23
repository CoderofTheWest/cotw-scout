'use strict';

const crypto = require('crypto');

function safeText(value, max = 1000) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  text = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  text = redactSensitive(text);
  if (text.length > max) text = `${text.slice(0, max - 1)}…`;
  return text;
}

function redactSensitive(text) {
  return String(text || '')
    .replace(/\b(?:sk|pk|ghp|github_pat|xoxb|xoxp|AKIA)[A-Za-z0-9_\-]{16,}\b/g, '[redacted-secret]')
    .replace(/\b[A-Za-z0-9_=-]{40,}\b/g, '[redacted-token]')
    .replace(/\/Users\/[^\s)'"`]+/g, '[redacted-path]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-host]')
    .replace(/\bport\s+\d{2,5}\b/gi, 'port [redacted]');
}

function stableHash(value, length = 16) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value || {});
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, length);
}

function fullHash(value) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value || {});
  return `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`;
}

function boundedNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clamp(value, min = 0, max = 1) {
  const num = boundedNumber(value, min);
  return Math.max(min, Math.min(max, num));
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function nowIso() {
  return new Date().toISOString();
}

module.exports = {
  boundedNumber,
  clamp,
  ensureArray,
  fullHash,
  nowIso,
  redactSensitive,
  safeText,
  stableHash
};
