#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const {
  assessDigestFreshness,
  createActiveThreadDigest,
  selectActiveThreadDigest,
  toMinimalInjection,
  validateActiveThreadDigest
} = require('../lib/active-thread-digest');

const root = __dirname;
const fixtures = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'active-thread-digest.json'), 'utf8'));
const results = [];

for (const fixture of fixtures) {
  try {
    let detail;
    if (fixture.select) {
      const digests = fixture.digests.map((input) => createActiveThreadDigest(input, { now: fixture.now }));
      const selected = selectActiveThreadDigest(digests, fixture.query, { now: fixture.now, currentThreadId: fixture.currentThreadId });
      assert.equal(selected.selected?.threadId, fixture.expected.selectedThreadId, `${fixture.name}: selected thread`);
      detail = `selected=${selected.selected?.threadId}`;
    } else {
      const digest = createActiveThreadDigest(fixture.input, { now: fixture.now });
      const validation = validateActiveThreadDigest(digest);
      const freshness = assessDigestFreshness(digest, { now: fixture.now });
      const injection = toMinimalInjection(digest, { now: fixture.now });
      assert.equal(validation.ok, fixture.expected.valid, `${fixture.name}: validation`);
      assert.equal(freshness.status, fixture.expected.freshness, `${fixture.name}: freshness`);
      assert.equal(freshness.requiresVerification, fixture.expected.requiresVerification, `${fixture.name}: requiresVerification`);
      if (fixture.expected.injectionIncludes) {
        assert.ok(injection.text.includes(fixture.expected.injectionIncludes), `${fixture.name}: injection includes ${fixture.expected.injectionIncludes}`);
      }
      detail = `${freshness.status} / verify=${freshness.requiresVerification}`;
    }
    results.push({ name: fixture.name, status: 'PASS', detail });
  } catch (err) {
    results.push({ name: fixture.name, status: 'FAIL', detail: err.message });
  }
}

const pass = results.filter((result) => result.status === 'PASS').length;
const fail = results.length - pass;

const lines = [];
lines.push('# Active Thread Digest Test Report');
lines.push('');
lines.push(`- PASS: ${pass}`);
lines.push(`- FAIL: ${fail}`);
lines.push(`- Total: ${results.length}`);
lines.push('');
lines.push('| Fixture | Status | Detail |');
lines.push('|---|---:|---|');
for (const result of results) lines.push(`| ${escapePipes(result.name)} | ${result.status} | ${escapePipes(result.detail)} |`);
lines.push('');

const reportPath = path.join(root, 'reports', 'active-thread-digest.md');
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

console.log(`Active thread digest tests: PASS=${pass} FAIL=${fail}`);
console.log(`Report: ${path.relative(process.cwd(), reportPath)}`);
if (fail > 0) process.exit(1);

function escapePipes(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}
