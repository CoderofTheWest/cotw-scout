'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readExchangeTrace } = require('./exchange-trace-store');
const { safeId } = require('./exchange-spine');
const { writeFileAtomic, writeJsonAtomic } = require('./write-json-atomic');
const {
  redactText,
  validateNoLeaks
} = require('../bundled-plugins/openclaw-plugin-harness-refiner/lib/redaction-validator');

const DIAGNOSTIC_BUNDLE_SCHEMA_VERSION = 1;

function exportDiagnosticBundle({
  tracePath,
  receiptsPath,
  outputRoot,
  exchangeId = '',
  sinceMs = 0,
  limit = 1000,
  bundleId = '',
  now = new Date().toISOString(),
  redactionValidator = validateNoLeaks
} = {}) {
  if (!tracePath) throw new Error('tracePath is required');
  if (!outputRoot) throw new Error('outputRoot is required');
  const entries = readExchangeTrace(tracePath, {
    exchangeId,
    sinceMs,
    limit
  });
  const exchangeIds = unique(entries.map((entry) => entry.exchangeId).filter(Boolean));
  const receipts = readDiagnosticReceipts(receiptsPath, {
    exchangeIds,
    sinceMs,
    limit
  });
  const id = safeBundleId(bundleId || `diagnostic-bundle-${Date.now().toString(36)}-${hashValue({ exchangeIds, sinceMs, limit }).slice(7, 15)}`);
  const bundleDir = path.join(outputRoot, id);
  if (fs.existsSync(bundleDir)) throw new Error(`diagnostic bundle already exists: ${id}`);

  const traceJsonl = redactText(entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : ''));
  const receiptsJsonl = redactText(receipts.map((receipt) => JSON.stringify(receipt)).join('\n') + (receipts.length ? '\n' : ''));
  const files = [
    { name: 'exchange-trace.jsonl', content: traceJsonl, count: entries.length },
    { name: 'diagnostic-receipts.jsonl', content: receiptsJsonl, count: receipts.length }
  ];
  const members = files.map((file) => ({
    type: 'diagnostic_file',
    id: file.name,
    count: file.count,
    hash: hashValue(file.content)
  }));
  const manifest = {
    schemaVersion: DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
    type: 'diagnostic_bundle_manifest',
    bundleId: id,
    generatedAt: now,
    readOnly: true,
    trainingApproval: false,
    adapterPromotionAuthorized: false,
    redactionPolicy: 'default-local-diagnostic-redaction',
    source: {
      tracePath: safePathRef(tracePath),
      receiptsPath: receiptsPath ? safePathRef(receiptsPath) : ''
    },
    scope: {
      requestedExchangeId: safeId(exchangeId, 120),
      sinceMs: Number(sinceMs) || 0,
      limit: Math.max(1, Math.min(5000, Number(limit) || 1000))
    },
    coverage: {
      exchangeIds,
      requestIds: unique(entries.map((entry) => entry.requestId).filter(Boolean)),
      runIds: unique(entries.map((entry) => entry.runId).filter(Boolean)),
      sessionIds: unique(entries.map((entry) => entry.sessionId).filter(Boolean)),
      eventCount: entries.length,
      receiptCount: receipts.length,
      timeRange: buildTimeRange(entries)
    },
    schemaCompatibility: {
      ok: entries.every((entry) => Number(entry.schemaVersion) === 1),
      traceSchemaVersions: unique(entries.map((entry) => String(entry.schemaVersion || 'unknown')))
    },
    members,
    merkleRoot: merkleRoot(members),
    redactionValidation: null,
    manifestHash: null
  };
  const validation = redactionValidator({
    manifest,
    files: files.map((file) => ({ name: file.name, content: file.content }))
  });
  manifest.redactionValidation = validation;
  if (!validation.ok) {
    const err = new Error('diagnostic bundle redaction validation failed');
    err.leakReport = {
      validatorVersion: validation.validatorVersion,
      checkedPatterns: validation.checkedPatterns,
      leakCounts: validation.leakCounts,
      leakCount: validation.leakCount
    };
    throw err;
  }
  manifest.manifestHash = hashValue({ ...manifest, manifestHash: undefined });

  fs.mkdirSync(bundleDir, { recursive: true });
  for (const file of files) {
    writeFileAtomic(path.join(bundleDir, file.name), file.content, { mode: 0o600 });
  }
  writeJsonAtomic(path.join(bundleDir, 'manifest.json'), manifest, 2, { mode: 0o600 });
  return {
    ok: true,
    readOnly: true,
    bundleId: id,
    bundleDir,
    manifest,
    trainingApproval: false,
    adapterPromotionAuthorized: false
  };
}

function readDiagnosticReceipts(receiptsPath, { exchangeIds = [], sinceMs = 0, limit = 1000 } = {}) {
  if (!receiptsPath || !fs.existsSync(receiptsPath)) return [];
  const exchangeSet = new Set(exchangeIds.filter(Boolean));
  const since = Number(sinceMs) || 0;
  const max = Math.max(1, Math.min(5000, Number(limit) || 1000));
  const lines = fs.readFileSync(receiptsPath, 'utf8').split(/\r?\n/).filter(Boolean).slice(-max * 2);
  const receipts = [];
  for (const line of lines) {
    try {
      const receipt = JSON.parse(line);
      const createdMs = receipt.createdAt ? new Date(receipt.createdAt).getTime() : 0;
      if (since && Number.isFinite(createdMs) && createdMs < since) continue;
      const receiptExchanges = Array.isArray(receipt.exchangeIds) ? receipt.exchangeIds : [];
      if (exchangeSet.size && !receiptExchanges.some((id) => exchangeSet.has(id))) continue;
      receipts.push(sanitizeReceipt(receipt));
    } catch { /* skip malformed receipts */ }
  }
  return receipts.slice(-max);
}

function sanitizeReceipt(receipt = {}) {
  return {
    schemaVersion: Number(receipt.schemaVersion) || 1,
    type: safeText(receipt.type, 120),
    id: safeText(receipt.id, 180),
    createdAt: safeText(receipt.createdAt, 80),
    exchangeIds: unique(Array.isArray(receipt.exchangeIds) ? receipt.exchangeIds.map((id) => safeId(id, 120)) : []),
    scope: safeText(receipt.scope, 80),
    symptoms: Array.isArray(receipt.symptoms) ? receipt.symptoms.map((value) => safeText(value, 80)).slice(0, 50) : [],
    likelyIssue: safeText(receipt.likelyIssue, 120),
    severity: safeText(receipt.severity, 40),
    confidence: Number.isFinite(Number(receipt.confidence)) ? Number(receipt.confidence) : null,
    readOnly: true,
    trainingApproval: false,
    adapterPromotionAuthorized: false
  };
}

function buildTimeRange(entries = []) {
  const times = entries.map((entry) => Number(entry.at)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!times.length) return { start: null, end: null };
  return {
    start: new Date(times[0]).toISOString(),
    end: new Date(times[times.length - 1]).toISOString()
  };
}

function merkleRoot(members = []) {
  return hashValue(members.map((member) => `${member.type}:${member.id}:${member.hash}`).sort());
}

function hashValue(value) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value || {});
  return `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`;
}

function safeBundleId(value) {
  return safeId(value, 180).replace(/[:/]+/g, '-').replace(/^-+|-+$/g, '') || `diagnostic-bundle-${Date.now().toString(36)}`;
}

function safePathRef(value) {
  const text = String(value || '');
  return text ? `[local-path:${path.basename(text)}]` : '';
}

function safeText(value, max = 240) {
  return redactText(String(value || '')).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function unique(values = []) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean))).slice(0, 100);
}

module.exports = {
  DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
  exportDiagnosticBundle,
  hashValue,
  merkleRoot
};
