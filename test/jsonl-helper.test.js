const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  readJsonlBatchFromOffset,
  readLastJsonlEntry,
} = require('../bundled-plugins/lib/jsonl');

test('readLastJsonlEntry reads the final entry without requiring a whole-file split', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotw-jsonl-'));
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ id: 1, value: 'first' }),
    JSON.stringify({ id: 2, value: 'second' }),
    ''
  ].join('\n'));

  assert.deepEqual(readLastJsonlEntry(file), { id: 2, value: 'second' });
});

test('readJsonlBatchFromOffset returns complete entries and next byte offset', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotw-jsonl-'));
  const file = path.join(dir, 'events.jsonl');
  const first = `${JSON.stringify({ id: 1 })}\n`;
  const second = `${JSON.stringify({ id: 2 })}\n`;
  const third = `${JSON.stringify({ id: 3 })}\n`;
  fs.writeFileSync(file, first + second + third);

  const batch = readJsonlBatchFromOffset(file, 0, 2);
  assert.deepEqual(batch.entries, [{ id: 1 }, { id: 2 }]);
  assert.equal(batch.nextOffset, Buffer.byteLength(first + second));

  const next = readJsonlBatchFromOffset(file, batch.nextOffset, 2);
  assert.deepEqual(next.entries, [{ id: 3 }]);
  assert.equal(next.nextOffset, Buffer.byteLength(first + second + third));
});
