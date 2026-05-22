const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const source = fs.readFileSync(
  path.join(repoRoot, 'bundled-plugins', 'openclaw-plugin-continuity', 'index.js'),
  'utf8'
);

test('continuity caches stable workspace context files by mtime', () => {
  assert.match(source, /function _readCachedTextByMtime\(state, filePath\)/);
  assert.match(source, /state\.fileTextCache = new Map\(\)/);
  assert.match(source, /_readCachedTextByMtime\(state, praxisPath\)/);
  assert.match(source, /_readCachedTextByMtime\(state, trailheadPath\)/);
  assert.doesNotMatch(source, /const praxis = fs\.readFileSync\(praxisPath/);
  assert.doesNotMatch(source, /const trailhead = fs\.readFileSync\(trailheadPath/);
});

test('continuity handoff writes are debounced but lifecycle boundaries force a write', () => {
  assert.match(source, /minWriteIntervalMs/);
  assert.match(source, /maxExchangeInterval/);
  assert.match(source, /state\.handoffWritten = true/);
  assert.match(source, /lastHandoffWriteExchange/);
  assert.match(source, /reason: 'thread_switch'/);
  assert.match(source, /reason: 'before_reset'/);
  assert.match(source, /reason: 'session_end'/);
  assert.match(source, /reason: 'thread_consolidation'/);
});
