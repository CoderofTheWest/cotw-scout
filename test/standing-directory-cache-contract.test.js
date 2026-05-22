const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const standing = fs.readFileSync(path.join(repoRoot, 'bundled-plugins/openclaw-plugin-standing/index.js'), 'utf8');

test('standing directory counts use an mtime cache instead of direct hot-path scans', () => {
  assert.match(standing, /const directoryCountCache = new Map\(\)/);
  assert.match(standing, /function countFilesByExtensionCached\(dirPath, extension\)/);
  assert.match(standing, /cached\.mtimeMs === stat\.mtimeMs/);
  assert.match(standing, /countFilesByExtensionCached\(sessionsDir, '\.jsonl'\)/);
  assert.match(standing, /countFilesByExtensionCached\(dir, '\.md'\)/);
  assert.match(standing, /countFilesByExtensionCached\(sessDir, '\.jsonl'\)/);
  assert.doesNotMatch(standing, /fs\.readdirSync\(sessionsDir\)\.filter/);
  assert.doesNotMatch(standing, /fs\.readdirSync\(sessDir\)\.filter/);
});
