#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const {
  hashExcerpt,
  makeSourceHandle,
  normalizeSourceRefs,
  parseSourceHandle,
  sourceAuthorityRank,
  validateSourceHandle
} = require('../lib/source-handles');

const root = __dirname;
const results = [];

const cases = [
  {
    name: 'archive handle parses',
    handle: 'archive:2026-05-03:trail-guide:main#e0142',
    ok: true,
    type: 'archive',
    field: ['exchangeId', '0142']
  },
  {
    name: 'digest handle parses',
    handle: 'digest:main#v12:last_verified_state',
    ok: true,
    type: 'digest',
    field: ['version', 12]
  },
  {
    name: 'file handle line range parses',
    handle: 'file:reports/cotw-continuity-integration-plan-2026-05-03.md#L81-L110',
    ok: true,
    type: 'file',
    field: ['startLine', 81]
  },
  {
    name: 'tool handle parses',
    handle: 'tool:session_1777865649635#call7',
    ok: true,
    type: 'tool',
    field: ['callIndex', 7]
  },
  {
    name: 'bad line range fails',
    handle: 'handoff:2026-05-03:main#L20-L10',
    ok: false
  },
  {
    name: 'unknown type fails',
    handle: 'memory:thing#1',
    ok: false
  }
];

for (const fixture of cases) {
  try {
    const parsed = parseSourceHandle(fixture.handle);
    assert.equal(parsed.ok, fixture.ok, `${fixture.name}: ok`);
    if (fixture.ok) {
      assert.equal(parsed.type, fixture.type, `${fixture.name}: type`);
      if (fixture.field) assert.equal(parsed[fixture.field[0]], fixture.field[1], `${fixture.name}: ${fixture.field[0]}`);
    }
    results.push({ name: fixture.name, status: 'PASS', detail: fixture.ok ? parsed.type : parsed.errors.join('; ') });
  } catch (err) {
    results.push({ name: fixture.name, status: 'FAIL', detail: err.message });
  }
}

try {
  const handle = makeSourceHandle('commit', { sha: '8907f7a', path: 'bundled-plugins/openclaw-plugin-continuity/lib/build1-primitives.cjs' });
  assert.equal(handle, 'commit:8907f7a#bundled-plugins/openclaw-plugin-continuity/lib/build1-primitives.cjs');
  assert.equal(validateSourceHandle(handle).ok, true);
  results.push({ name: 'makeSourceHandle creates valid commit handle', status: 'PASS', detail: handle });
} catch (err) {
  results.push({ name: 'makeSourceHandle creates valid commit handle', status: 'FAIL', detail: err.message });
}

try {
  const refs = normalizeSourceRefs([{ handle: 'tool:session#call3', role: 'verification', excerpt: 'Gateway reachable' }]);
  assert.equal(refs[0].valid, true);
  assert.equal(refs[0].role, 'verification');
  assert.equal(refs[0].quoteHash, hashExcerpt('Gateway reachable'));
  assert.equal(sourceAuthorityRank(refs[0]), 5);
  results.push({ name: 'source refs normalize role/hash/rank', status: 'PASS', detail: refs[0].quoteHash });
} catch (err) {
  results.push({ name: 'source refs normalize role/hash/rank', status: 'FAIL', detail: err.message });
}

const pass = results.filter((result) => result.status === 'PASS').length;
const fail = results.length - pass;
const lines = [];
lines.push('# Source Handles Test Report');
lines.push('');
lines.push(`- PASS: ${pass}`);
lines.push(`- FAIL: ${fail}`);
lines.push(`- Total: ${results.length}`);
lines.push('');
lines.push('| Fixture | Status | Detail |');
lines.push('|---|---:|---|');
for (const result of results) lines.push(`| ${escapePipes(result.name)} | ${result.status} | ${escapePipes(result.detail)} |`);
lines.push('');

const reportPath = path.join(root, 'reports', 'source-handles.md');
fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

console.log(`Source handle tests: PASS=${pass} FAIL=${fail}`);
console.log(`Report: ${path.relative(process.cwd(), reportPath)}`);
if (fail > 0) process.exit(1);

function escapePipes(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}
