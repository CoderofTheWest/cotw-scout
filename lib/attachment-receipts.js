const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_EXTRACTED_TEXT_CHARS = 200000;
const CONTEXT_EXCERPT_CHARS = 900;
const OBSERVATION_EXCERPT_CHARS = 1200;

function ensureAttachmentReceiptSchema(db) {
  if (!db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS attachment_receipts (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER DEFAULT 0,
      sha256 TEXT NOT NULL,
      source_path TEXT,
      source_exists INTEGER DEFAULT 0,
      source_hash_verified INTEGER DEFAULT 0,
      source_mtime_ms REAL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_verified_at TEXT,
      extracted_text TEXT,
      text_excerpt TEXT,
      observation_excerpt TEXT,
      metadata_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_attachment_receipts_last_seen ON attachment_receipts(last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_attachment_receipts_hash ON attachment_receipts(sha256);
    CREATE TABLE IF NOT EXISTS attachment_receipt_turns (
      id TEXT PRIMARY KEY,
      receipt_id TEXT NOT NULL,
      thread_id TEXT,
      session_id TEXT,
      project_id TEXT,
      turn_id TEXT,
      exchange_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(receipt_id) REFERENCES attachment_receipts(id)
    );
    CREATE INDEX IF NOT EXISTS idx_attachment_turns_thread ON attachment_receipt_turns(thread_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_attachment_turns_receipt ON attachment_receipt_turns(receipt_id);
  `);
  try { db.exec('ALTER TABLE attachment_receipt_turns ADD COLUMN exchange_id TEXT'); } catch (err) {
    if (!String(err.message || err).toLowerCase().includes('duplicate')) throw err;
  }
}

function createAttachmentReceipts({ db, attachments = [], threadId = null, sessionId = null, projectId = null, turnId = null, exchangeId = null, now = new Date().toISOString() } = {}) {
  if (!db || !Array.isArray(attachments) || attachments.length === 0) return [];
  ensureAttachmentReceiptSchema(db);
  const receipts = [];
  const upsertReceipt = db.prepare(`
    INSERT INTO attachment_receipts (
      id, kind, name, mime_type, size_bytes, sha256, source_path,
      source_exists, source_hash_verified, source_mtime_ms,
      first_seen_at, last_seen_at, last_verified_at,
      extracted_text, text_excerpt, observation_excerpt, metadata_json
    ) VALUES (
      @id, @kind, @name, @mimeType, @sizeBytes, @sha256, @sourcePath,
      @sourceExists, @sourceHashVerified, @sourceMtimeMs,
      @now, @now, @lastVerifiedAt,
      @extractedText, @textExcerpt, @observationExcerpt, @metadataJson
    )
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      mime_type = excluded.mime_type,
      size_bytes = excluded.size_bytes,
      source_path = COALESCE(excluded.source_path, attachment_receipts.source_path),
      source_exists = excluded.source_exists,
      source_hash_verified = excluded.source_hash_verified,
      source_mtime_ms = excluded.source_mtime_ms,
      last_seen_at = excluded.last_seen_at,
      last_verified_at = excluded.last_verified_at,
      extracted_text = COALESCE(excluded.extracted_text, attachment_receipts.extracted_text),
      text_excerpt = COALESCE(excluded.text_excerpt, attachment_receipts.text_excerpt),
      metadata_json = excluded.metadata_json
  `);
  const insertTurn = db.prepare(`
    INSERT OR IGNORE INTO attachment_receipt_turns
      (id, receipt_id, thread_id, session_id, project_id, turn_id, exchange_id, created_at)
    VALUES
      (@id, @receiptId, @threadId, @sessionId, @projectId, @turnId, @exchangeId, @createdAt)
  `);

  const tx = db.transaction((items) => {
    for (const attachment of items) {
      const receipt = buildAttachmentReceipt(attachment, { now });
      upsertReceipt.run(receipt);
      insertTurn.run({
        id: `${receipt.id}:${turnId || now}`,
        receiptId: receipt.id,
        threadId,
        sessionId,
        projectId,
        turnId,
        exchangeId,
        createdAt: now,
      });
      receipts.push(receipt);
    }
  });
  tx(attachments);
  return receipts;
}

function buildAttachmentReceipt(attachment, { now = new Date().toISOString() } = {}) {
  const kind = normalizeKind(attachment.kind, attachment.mimeType);
  const name = String(attachment.name || 'attachment').trim() || 'attachment';
  const mimeType = String(attachment.mimeType || 'application/octet-stream').trim() || 'application/octet-stream';
  const sourcePath = normalizeSourcePath(attachment.sourcePath);
  const source = inspectSourcePath(sourcePath);
  const contentHash = source.hash || hashAttachmentPayload(attachment);
  const sizeBytes = Number.isFinite(Number(attachment.size))
    ? Number(attachment.size)
    : source.sizeBytes || estimatePayloadSize(attachment);
  const extractedText = kind === 'document'
    ? truncateText(String(attachment.text || ''), MAX_EXTRACTED_TEXT_CHARS)
    : '';
  const id = `att_${contentHash.slice(0, 16)}`;
  return {
    id,
    kind,
    name,
    mimeType,
    sizeBytes,
    sha256: contentHash,
    sourcePath,
    sourceExists: source.exists ? 1 : 0,
    sourceHashVerified: source.hash && source.hash === contentHash ? 1 : 0,
    sourceMtimeMs: source.mtimeMs || null,
    now,
    lastVerifiedAt: source.exists ? now : null,
    extractedText,
    textExcerpt: excerpt(extractedText, CONTEXT_EXCERPT_CHARS),
    observationExcerpt: '',
    metadataJson: JSON.stringify({
      sourceDisplayPath: displayPath(sourcePath),
      sourceStatus: source.exists ? 'verified' : sourcePath ? 'missing' : 'payload-only',
    }),
  };
}

function buildAttachmentReceiptContext(receipts = [], { title = 'Attachment receipts for this turn' } = {}) {
  const lines = (Array.isArray(receipts) ? receipts : [])
    .map(formatReceiptContextLine)
    .filter(Boolean);
  if (lines.length === 0) return '';
  return [
    `[${title}]`,
    'These are durable handles for files attached in this conversation. Use them as evidence handles; if exact visual/doc detail matters later, verify or reopen the source instead of relying on memory.',
    ...lines,
    `[/${title}]`,
  ].join('\n');
}

function buildRecentAttachmentReceiptContext(db, { threadId = null, excludeIds = [], limit = 6 } = {}) {
  if (!db || !threadId) return '';
  ensureAttachmentReceiptSchema(db);
  const excluded = new Set((excludeIds || []).filter(Boolean));
  const rows = db.prepare(`
    SELECT r.*
    FROM attachment_receipts r
    JOIN attachment_receipt_turns t ON t.receipt_id = r.id
    WHERE t.thread_id = ?
    ORDER BY t.created_at DESC
    LIMIT ?
  `).all(threadId, Math.max(limit * 3, limit));
  const deduped = [];
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.id) || excluded.has(row.id)) continue;
    seen.add(row.id);
    deduped.push(deserializeReceipt(row));
    if (deduped.length >= limit) break;
  }
  return buildAttachmentReceiptContext(deduped, { title: 'Recent attachment receipts' });
}

function markAttachmentReceiptsObserved(db, receiptIds = [], observation = '', { now = new Date().toISOString() } = {}) {
  if (!db || !Array.isArray(receiptIds) || receiptIds.length === 0) return;
  ensureAttachmentReceiptSchema(db);
  const excerpted = excerpt(observation, OBSERVATION_EXCERPT_CHARS);
  if (!excerpted) return;
  const stmt = db.prepare('UPDATE attachment_receipts SET observation_excerpt = ?, last_seen_at = ? WHERE id = ?');
  const tx = db.transaction((ids) => {
    for (const id of ids) stmt.run(excerpted, now, id);
  });
  tx(receiptIds);
}

function deserializeReceipt(row = {}) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    sourcePath: row.source_path,
    sourceExists: row.source_exists,
    sourceHashVerified: row.source_hash_verified,
    sourceMtimeMs: row.source_mtime_ms,
    textExcerpt: row.text_excerpt,
    observationExcerpt: row.observation_excerpt,
    metadataJson: row.metadata_json,
  };
}

function formatReceiptContextLine(receipt) {
  if (!receipt?.id) return '';
  const meta = safeJson(receipt.metadataJson);
  const parts = [
    `- ${receipt.id}`,
    `${receipt.kind || 'file'}`,
    `"${receipt.name || 'attachment'}"`,
    receipt.mimeType || null,
    receipt.sizeBytes ? formatBytes(receipt.sizeBytes) : null,
    `sha256:${String(receipt.sha256 || '').slice(0, 12)}`,
  ].filter(Boolean);
  const sourcePath = displayPath(receipt.sourcePath) || meta.sourceDisplayPath || null;
  const sourceStatus = meta.sourceStatus || (receipt.sourceExists ? 'verified' : sourcePath ? 'missing' : 'payload-only');
  let line = `${parts.join(' | ')} | source:${sourceStatus}${sourcePath ? ` ${sourcePath}` : ''}`;
  if (receipt.textExcerpt) line += `\n  doc excerpt: ${singleLine(receipt.textExcerpt)}`;
  if (receipt.observationExcerpt) line += `\n  last observation: ${singleLine(receipt.observationExcerpt)}`;
  return line;
}

function normalizeKind(kind, mimeType) {
  const declared = String(kind || '').toLowerCase();
  if (declared === 'image' || /^image\//i.test(String(mimeType || ''))) return 'image';
  return 'document';
}

function normalizeSourcePath(value) {
  const sourcePath = String(value || '').trim();
  if (!sourcePath) return null;
  return path.isAbsolute(sourcePath) ? sourcePath : null;
}

function inspectSourcePath(sourcePath) {
  if (!sourcePath) return { exists: false };
  try {
    const stat = fs.statSync(sourcePath);
    if (!stat.isFile()) return { exists: false };
    return {
      exists: true,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      hash: crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex'),
    };
  } catch {
    return { exists: false };
  }
}

function hashAttachmentPayload(attachment) {
  const base64 = String(attachment.base64 || '').trim();
  if (base64) return crypto.createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');
  return crypto.createHash('sha256').update(String(attachment.text || '')).digest('hex');
}

function estimatePayloadSize(attachment) {
  const base64 = String(attachment.base64 || '').trim();
  if (base64) return Math.ceil(base64.length * 0.75);
  return Buffer.byteLength(String(attachment.text || ''), 'utf8');
}

function truncateText(text, maxChars) {
  const value = String(text || '');
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

function excerpt(text, maxChars) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
}

function singleLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function displayPath(sourcePath) {
  if (!sourcePath) return '';
  const home = os.homedir();
  return sourcePath.startsWith(home + path.sep) ? `~${sourcePath.slice(home.length)}` : sourcePath;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)}MB`;
  if (value >= 1024) return `${Math.round(value / 1024)}KB`;
  return `${value}B`;
}

function safeJson(value) {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}

module.exports = {
  ensureAttachmentReceiptSchema,
  createAttachmentReceipts,
  buildAttachmentReceipt,
  buildAttachmentReceiptContext,
  buildRecentAttachmentReceiptContext,
  markAttachmentReceiptsObserved,
  deserializeReceipt,
};
