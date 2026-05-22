#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { ActiveThreadDigestStore, sanitizeThreadId } = require('../storage/active-thread-digest-store');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-digest-store-'));
const store = new ActiveThreadDigestStore({
  baseDir: path.join(tmpRoot, 'thread-digests'),
  agentId: 'trail-guide',
  clock: () => '2026-05-04T10:00:00-07:00'
});

const results = [];
run('sanitize thread id blocks path traversal', () => {
  assert.equal(sanitizeThreadId('../../SESSION_HANDOFF'), '______SESSION_HANDOFF');
  assert.ok(!sanitizeThreadId('../../x').includes('/'));
});

run('read missing digest returns null and creates no directory', () => {
  assert.equal(store.read('missing'), null);
  assert.equal(fs.existsSync(store.baseDir), false);
});

run('create writes valid digest JSON under safe filename', () => {
  const { filePath, digest } = store.create({
    threadId: '../../continuity-spine',
    goal: 'observe-only continuity diagnostics',
    currentState: 'store test running',
    nextAction: 'keep disabled until approved',
    sourceHandles: ['test:active-thread-digest-store']
  });
  assert.equal(path.dirname(filePath), store.baseDir);
  assert.ok(path.basename(filePath).endsWith('.json'));
  assert.ok(!path.basename(filePath).includes('/'));
  assert.equal(digest.agentId, 'trail-guide');
  assert.equal(store.read('../../continuity-spine').threadId, '../../continuity-spine');
});

run('update increments version and merges commitments', () => {
  const { digest } = store.update('../../continuity-spine', {
    commitments: ['no runtime behavior without approval'],
    sourceHandles: ['test:update']
  });
  assert.equal(digest.version, 2);
  assert.ok(digest.commitments.includes('no runtime behavior without approval'));
  assert.ok(digest.sourceHandles.includes('test:update'));
});

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}

const pass = results.filter((r) => r.status === 'PASS').length;
const fail = results.length - pass;
console.log(`Active thread digest store tests: PASS=${pass} FAIL=${fail}`);
if (fail) {
  for (const r of results.filter((r) => r.status === 'FAIL')) console.error(`${r.name}: ${r.error}`);
  process.exit(1);
}

function run(name, fn) {
  try {
    fn();
    results.push({ name, status: 'PASS' });
  } catch (err) {
    results.push({ name, status: 'FAIL', error: err.message });
  }
}
