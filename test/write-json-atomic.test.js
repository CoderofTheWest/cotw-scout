const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeFileAtomic } = require('../lib/write-json-atomic');

test('writeFileAtomic preserves an existing file mode across temp+rename', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-json-atomic-'));
  try {
    const target = path.join(dir, 'openclaw.json');
    fs.writeFileSync(target, '{"old":true}', { mode: 0o600 });
    fs.chmodSync(target, 0o600);

    writeFileAtomic(target, '{"new":true}');

    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(target, 'utf8'), '{"new":true}');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeFileAtomic honors explicit mode for new sensitive files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-json-atomic-'));
  try {
    const target = path.join(dir, 'openclaw.json');

    writeFileAtomic(target, '{"new":true}', { mode: 0o600 });

    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
