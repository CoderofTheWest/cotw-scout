#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { resolveAuthority } = require('../lib/authority-ladder');

const root = __dirname;
const fixtures = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'authority-ladder.json'), 'utf8'));
const results = [];

for (const fixture of fixtures) {
  const actual = resolveAuthority(fixture.claims);
  try {
    assert.equal(actual.decision, fixture.expected.decision, `${fixture.name}: decision`);
    assert.equal(actual.winner?.id, fixture.expected.winnerId, `${fixture.name}: winner id`);
    assert.equal(actual.winner?.value, fixture.expected.winnerValue, `${fixture.name}: winner value`);
    assert.equal(actual.requiresVerification, fixture.expected.requiresVerification, `${fixture.name}: requiresVerification`);
    if (fixture.expected.rejectedIncludes) {
      assert.ok(actual.rejected.some((claim) => claim.id === fixture.expected.rejectedIncludes), `${fixture.name}: rejected includes ${fixture.expected.rejectedIncludes}`);
    }
    results.push({ name: fixture.name, status: 'PASS', actual });
  } catch (err) {
    results.push({ name: fixture.name, status: 'FAIL', error: err.message, actual });
  }
}

const pass = results.filter((result) => result.status === 'PASS').length;
const fail = results.length - pass;

const lines = [];
lines.push('# Authority Ladder Test Report');
lines.push('');
lines.push(`- PASS: ${pass}`);
lines.push(`- FAIL: ${fail}`);
lines.push(`- Total: ${results.length}`);
lines.push('');
lines.push('| Fixture | Status | Decision | Winner | Verification |');
lines.push('|---|---:|---|---|---:|');
for (const result of results) {
  const decision = result.actual?.decision || 'n/a';
  const winner = result.actual?.winner ? `${result.actual.winner.id} (${result.actual.winner.source}:${result.actual.winner.value})` : 'none';
  const verification = result.actual?.requiresVerification ?? 'n/a';
  const detail = result.status === 'PASS' ? decision : result.error;
  lines.push(`| ${escapePipes(result.name)} | ${result.status} | ${escapePipes(detail)} | ${escapePipes(winner)} | ${verification} |`);
}
lines.push('');

const reportPath = path.join(root, 'reports', 'authority-ladder.md');
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

console.log(`Authority ladder tests: PASS=${pass} FAIL=${fail}`);
console.log(`Report: ${path.relative(process.cwd(), reportPath)}`);
if (fail > 0) process.exit(1);

function escapePipes(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}
