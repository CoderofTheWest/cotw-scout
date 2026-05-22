#!/usr/bin/env node
// Drift guard: ensures template/ and bundled-template/ are kept in sync.
// Runs as `npm run check:templates`. Exits 0 if synced, 1 if any drift.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const TEMPLATE = path.join(ROOT, 'template');
const BUNDLED = path.join(ROOT, 'bundled-template');

function walk(dir, base = dir, out = new Map()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, base, out);
    } else if (entry.isFile()) {
      const rel = path.relative(base, full);
      const buf = fs.readFileSync(full);
      out.set(rel, {
        size: buf.length,
        hash: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12)
      });
    }
  }
  return out;
}

if (!fs.existsSync(TEMPLATE) || !fs.existsSync(BUNDLED)) {
  console.error('check:templates: missing template/ or bundled-template/ — run from repo root');
  process.exit(2);
}

const tmpl = walk(TEMPLATE);
const bndl = walk(BUNDLED);

const missingInBundled = [];
const missingInTemplate = [];
const differing = [];

for (const [rel, info] of tmpl) {
  if (!bndl.has(rel)) {
    missingInBundled.push(rel);
  } else if (bndl.get(rel).hash !== info.hash) {
    differing.push({ rel, tmpl: info, bndl: bndl.get(rel) });
  }
}
for (const rel of bndl.keys()) {
  if (!tmpl.has(rel)) missingInTemplate.push(rel);
}

const drift = missingInBundled.length + missingInTemplate.length + differing.length;
if (drift === 0) {
  console.log(`check:templates: template/ and bundled-template/ are in sync (${tmpl.size} files)`);
  process.exit(0);
}

console.error(`check:templates: DRIFT detected (${drift} issue${drift === 1 ? '' : 's'})`);
if (missingInBundled.length) {
  console.error(`\nIn template/ but missing from bundled-template/:`);
  for (const r of missingInBundled) console.error(`  ${r}`);
}
if (missingInTemplate.length) {
  console.error(`\nIn bundled-template/ but missing from template/:`);
  for (const r of missingInTemplate) console.error(`  ${r}`);
}
if (differing.length) {
  console.error(`\nContent differs:`);
  for (const d of differing) {
    console.error(`  ${d.rel}`);
    console.error(`    template/         ${d.tmpl.size} bytes (${d.tmpl.hash})`);
    console.error(`    bundled-template/ ${d.bndl.size} bytes (${d.bndl.hash})`);
  }
}
console.error('\nFix: edit template/ to be canonical, then run: rsync -a template/ bundled-template/');
process.exit(1);
