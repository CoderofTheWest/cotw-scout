const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createAttachmentReceipts,
  buildRecentAttachmentReceiptContext,
  markAttachmentReceiptsObserved,
} = require('../lib/attachment-receipts');

function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotw-attachment-receipts-'));
  const db = new FakeAttachmentDb();
  try {
    return fn({ db, dir });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

class FakeAttachmentDb {
  constructor() {
    this.receipts = new Map();
    this.turns = [];
  }

  exec() {}

  transaction(fn) {
    return (items) => fn(items);
  }

  prepare(sql) {
    if (/INSERT INTO attachment_receipts/i.test(sql)) {
      return { run: (receipt) => {
        const existing = this.receipts.get(receipt.id) || {};
        this.receipts.set(receipt.id, {
          ...existing,
          id: receipt.id,
          kind: receipt.kind,
          name: receipt.name,
          mime_type: receipt.mimeType,
          size_bytes: receipt.sizeBytes,
          sha256: receipt.sha256,
          source_path: receipt.sourcePath,
          source_exists: receipt.sourceExists,
          source_hash_verified: receipt.sourceHashVerified,
          source_mtime_ms: receipt.sourceMtimeMs,
          first_seen_at: existing.first_seen_at || receipt.now,
          last_seen_at: receipt.now,
          last_verified_at: receipt.lastVerifiedAt,
          extracted_text: receipt.extractedText || existing.extracted_text,
          text_excerpt: receipt.textExcerpt || existing.text_excerpt,
          observation_excerpt: existing.observation_excerpt || receipt.observationExcerpt,
          metadata_json: receipt.metadataJson,
        });
      } };
    }
    if (/INSERT OR IGNORE INTO attachment_receipt_turns/i.test(sql)) {
      return { run: (turn) => {
        if (!this.turns.some(existing => existing.id === turn.id)) {
          this.turns.push({
            id: turn.id,
            receipt_id: turn.receiptId,
            thread_id: turn.threadId,
            session_id: turn.sessionId,
            project_id: turn.projectId,
            turn_id: turn.turnId,
            exchange_id: turn.exchangeId,
            created_at: turn.createdAt,
          });
        }
      } };
    }
    if (/SELECT \* FROM attachment_receipts WHERE id = \?/i.test(sql)) {
      return { get: (id) => this.receipts.get(id) };
    }
    if (/SELECT \* FROM attachment_receipt_turns WHERE receipt_id = \?/i.test(sql)) {
      return { get: (id) => this.turns.find(turn => turn.receipt_id === id) };
    }
    if (/SELECT r\.\*/i.test(sql)) {
      return { all: (threadId, limit) => this.turns
        .filter(turn => turn.thread_id === threadId)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, limit)
        .map(turn => this.receipts.get(turn.receipt_id))
        .filter(Boolean) };
    }
    if (/UPDATE attachment_receipts SET observation_excerpt/i.test(sql)) {
      return { run: (observation, lastSeenAt, id) => {
        const receipt = this.receipts.get(id);
        if (receipt) {
          receipt.observation_excerpt = observation;
          receipt.last_seen_at = lastSeenAt;
        }
      } };
    }
    throw new Error(`Unexpected SQL in fake DB: ${sql}`);
  }
}

test('attachment receipts verify source path hash and link to a thread turn', () => withTempDb(({ db, dir }) => {
  const sourcePath = path.join(dir, 'note.md');
  fs.writeFileSync(sourcePath, 'These are durable attachment notes.');

  const receipts = createAttachmentReceipts({
    db,
    attachments: [{
      kind: 'document',
      name: 'note.md',
      mimeType: 'text/markdown',
      size: fs.statSync(sourcePath).size,
      sourcePath,
      text: fs.readFileSync(sourcePath, 'utf8'),
    }],
    threadId: 'thread_a',
    sessionId: 'session_a',
    projectId: 'project_a',
    turnId: 'turn_a',
    exchangeId: 'ex_a',
    now: '2026-05-22T12:00:00.000Z',
  });

  assert.equal(receipts.length, 1);
  assert.match(receipts[0].id, /^att_[a-f0-9]{16}$/);
  assert.equal(receipts[0].sourceExists, 1);
  assert.equal(receipts[0].sourceHashVerified, 1);

  const row = db.prepare('SELECT * FROM attachment_receipts WHERE id = ?').get(receipts[0].id);
  assert.equal(row.source_path, sourcePath);
  assert.match(row.text_excerpt, /durable attachment notes/);

  const turn = db.prepare('SELECT * FROM attachment_receipt_turns WHERE receipt_id = ?').get(receipts[0].id);
  assert.equal(turn.thread_id, 'thread_a');
  assert.equal(turn.session_id, 'session_a');
  assert.equal(turn.exchange_id, 'ex_a');
}));

test('recent receipt context carries prior handles and excludes current turn ids', () => withTempDb(({ db, dir }) => {
  const priorPath = path.join(dir, 'prior.txt');
  const currentPath = path.join(dir, 'current.txt');
  fs.writeFileSync(priorPath, 'Prior document text for later context.');
  fs.writeFileSync(currentPath, 'Current document text.');

  const prior = createAttachmentReceipts({
    db,
    attachments: [{ kind: 'document', name: 'prior.txt', mimeType: 'text/plain', sourcePath: priorPath, text: 'Prior document text for later context.' }],
    threadId: 'thread_a',
    sessionId: 'session_a',
    turnId: 'turn_prior',
    now: '2026-05-22T12:00:00.000Z',
  })[0];
  const current = createAttachmentReceipts({
    db,
    attachments: [{ kind: 'document', name: 'current.txt', mimeType: 'text/plain', sourcePath: currentPath, text: 'Current document text.' }],
    threadId: 'thread_a',
    sessionId: 'session_a',
    turnId: 'turn_current',
    now: '2026-05-22T12:01:00.000Z',
  })[0];

  markAttachmentReceiptsObserved(db, [prior.id], 'Assistant described the prior file.', { now: '2026-05-22T12:02:00.000Z' });

  const context = buildRecentAttachmentReceiptContext(db, {
    threadId: 'thread_a',
    excludeIds: [current.id],
    limit: 6,
  });

  assert.match(context, new RegExp(prior.id));
  assert.doesNotMatch(context, new RegExp(current.id));
  assert.match(context, /last observation: Assistant described the prior file/);
}));
