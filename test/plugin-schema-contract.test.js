'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const bundledPluginsDir = path.join(repoRoot, 'bundled-plugins');

function walkFiles(dir, predicate) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(fullPath, predicate));
    else if (entry.isFile() && predicate(fullPath)) files.push(fullPath);
  }
  return files;
}

function lineNumber(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
}

function matchingObjectSlice(source, openBraceIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let index = openBraceIndex; index < source.length; index += 1) {
    const char = source[index];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }

    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openBraceIndex, index + 1);
    }
  }

  return source.slice(openBraceIndex);
}

function findJsArraySchemaIssues(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const issues = [];
  const arrayTypePattern = /(?:type|"type")\s*:\s*['"]array['"]/g;
  let match;

  while ((match = arrayTypePattern.exec(source))) {
    const openBraceIndex = source.lastIndexOf('{', match.index);
    if (openBraceIndex === -1) continue;

    const objectSource = matchingObjectSlice(source, openBraceIndex);
    if (!/(?:items|"items")\s*:/.test(objectSource)) {
      issues.push(`${path.relative(repoRoot, filePath)}:${lineNumber(source, match.index)} array schema is missing items`);
    }
  }

  return issues;
}

function findJsonSchemaIssues(schema, location, issues) {
  if (!schema || typeof schema !== 'object') return;

  if (schema.type === 'array' && !Object.prototype.hasOwnProperty.call(schema, 'items')) {
    issues.push(`${location} array schema is missing items`);
  }

  if (schema.properties && typeof schema.properties === 'object') {
    for (const [key, value] of Object.entries(schema.properties)) {
      findJsonSchemaIssues(value, `${location}.properties.${key}`, issues);
    }
  }

  if (schema.items) findJsonSchemaIssues(schema.items, `${location}.items`, issues);

  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    if (Array.isArray(schema[keyword])) {
      schema[keyword].forEach((entry, index) => findJsonSchemaIssues(entry, `${location}.${keyword}[${index}]`, issues));
    }
  }
}

test('bundled plugin JSON schemas declare items for every array schema', () => {
  const manifestPaths = walkFiles(bundledPluginsDir, (filePath) => path.basename(filePath) === 'openclaw.plugin.json');
  const issues = [];

  for (const manifestPath of manifestPaths) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const rel = path.relative(repoRoot, manifestPath);
    findJsonSchemaIssues(manifest.configSchema, `${rel}.configSchema`, issues);
    findJsonSchemaIssues(manifest.configSchema?.jsonSchema, `${rel}.configSchema.jsonSchema`, issues);
  }

  assert.deepEqual(issues, []);
});

test('bundled plugin source schemas declare items for every array schema', () => {
  const sourcePaths = walkFiles(bundledPluginsDir, (filePath) => /\.(?:js|cjs|mjs)$/.test(filePath));
  const issues = sourcePaths.flatMap(findJsArraySchemaIssues);

  assert.deepEqual(issues, []);
});
