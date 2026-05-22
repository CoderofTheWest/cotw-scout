#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { classifyHandoffHealth } = require('../lib/handoff-health');

const root = __dirname;
const fixtures = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'handoff-health.json'), 'utf8'));
const results = [];

for (const fixture of fixtures) {
  const actual = classifyHandoffHealth(fixture.input, { now: fixture.now });
  try {
    for (const [key, expectedValue] of Object.entries(fixture.expected)) {
      assert.equal(actual[key], expectedValue, `${fixture.name}: expected ${key}=${expectedValue}, got ${actual[key]}`);
    }
    results.push({ name: fixture.name, status: 'PASS', actual });
  } catch (err) {
    results.push({ name: fixture.name, status: 'FAIL', error: err.message, actual });
  }
}

const pass = results.filter((r) => r.status === 'PASS').length;
const fail = results.length - pass;

const lines = [];
lines.push('# Handoff Health Test Report');
lines.push('');
lines.push(`- PASS: ${pass}`);
lines.push(`- FAIL: ${fail}`);
lines.push(`- Total: ${results.length}`);
lines.push('');
lines.push('| Fixture | Status | Classification |');
lines.push('|---|---:|---|');
for (const result of results) {
  const detail = result.status === 'PASS'
    ? `${result.actual.status} / ${result.actual.authority} / inject=${result.actual.inject}`
    : result.error;
  lines.push(`| ${escapePipes(result.name)} | ${result.status} | ${escapePipes(detail)} |`);
}
lines.push('');

const reportPath = path.join(root, 'reports', 'handoff-health.md');
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

console.log(`Handoff health tests: PASS=${pass} FAIL=${fail}`);
console.log(`Report: ${path.relative(process.cwd(), reportPath)}`);
if (fail > 0) process.exit(1);

function escapePipes(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}
