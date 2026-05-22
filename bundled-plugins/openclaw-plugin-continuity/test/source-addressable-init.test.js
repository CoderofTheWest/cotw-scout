#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

const pluginRoot = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'config.default.json'), 'utf8'));
const indexSource = fs.readFileSync(path.join(pluginRoot, 'index.js'), 'utf8');
const plugin = require('..');
const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'openclaw.plugin.json'), 'utf8'));
const results = [];

run('default source-addressable memory config remains runtime-disabled', () => {
  assert.equal(config.sourceAddressableMemory.enabled, false);
  assert.equal(config.sourceAddressableMemory.mode, 'observe');
  assert.equal(config.sourceAddressableMemory.injectMode, 'none');
  assert.equal(config.sourceAddressableMemory.createClaimsFromHandoffs, false);
  assert.equal(config.sourceAddressableMemory.createClaimsFromSummaries, false);
  assert.equal(config.sourceAddressableMemory.createClaimsFromDigests, false);
  assert.equal(config.sourceAddressableMemory.persistClaimCandidates, false);
  assert.deepEqual(config.sourceAddressableMemory.claimContext, {
    enabled: false,
    mode: 'diagnostic',
    injectMode: 'none',
    maxClaims: 8,
    includeSourceExcerpts: false,
    acceptedVerifiedOnly: true
  });
});

run('plugin schema exposes sourceAddressableMemory without enabling it', () => {
  assert.ok(plugin.configSchema.jsonSchema.properties.sourceAddressableMemory);
});

run('plugin manifest exposes source-addressable memory and Build 1 runtime config keys', () => {
  const manifestProps = manifest.configSchema.properties;
  for (const key of ['sessionHandoff', 'authorityLadder', 'activeThreadDigest', 'sourceAddressableMemory']) {
    assert.ok(manifestProps[key], `manifest missing ${key}`);
    assert.ok(plugin.configSchema.jsonSchema.properties[key], `index schema missing ${key}`);
    assert.ok(config[key], `default config missing ${key}`);
  }
  const sourceSchema = manifestProps.sourceAddressableMemory.properties;
  assert.equal(sourceSchema.enabled.default, false);
  assert.equal(sourceSchema.mode.default, 'observe');
  assert.equal(sourceSchema.injectMode.default, 'none');
  assert.equal(sourceSchema.createClaimsFromHandoffs.default, false);
  assert.equal(sourceSchema.createClaimsFromSummaries.default, false);
  assert.equal(sourceSchema.createClaimsFromDigests.default, false);
  assert.equal(sourceSchema.persistClaimCandidates.default, false);
  assert.equal(sourceSchema.claimContext.properties.enabled.default, false);
  assert.equal(sourceSchema.claimContext.properties.mode.default, 'diagnostic');
  assert.equal(sourceSchema.claimContext.properties.injectMode.default, 'none');
  assert.deepEqual(sourceSchema.claimContext.properties.mode.enum, ['diagnostic', 'preview', 'live', 'off']);
  assert.deepEqual(sourceSchema.claimContext.properties.injectMode.enum, ['none', 'minimal']);
  assert.equal(sourceSchema.claimContext.properties.maxClaims.default, 8);
  assert.equal(sourceSchema.claimContext.properties.includeSourceExcerpts.default, false);
  assert.equal(sourceSchema.claimContext.properties.acceptedVerifiedOnly.default, true);
});

run('manifest contracts expose registered continuity tools including read-only claim diagnostics', () => {
  const manifestTools = new Set(manifest.contracts.tools);
  for (const tool of ['continuity_recall', 'continuity_timeline', 'continuity_claims', 'knowledge_note', 'continuity_search']) {
    assert.ok(manifestTools.has(tool), `manifest missing tool ${tool}`);
  }
  assert.match(indexSource, /api\.registerTool\(createClaimsTool/);
  assert.match(fs.readFileSync(path.join(pluginRoot, 'tools', 'continuity-claims.js'), 'utf8'), /name: 'continuity_claims'/);
});

run('ClaimStore is gated behind explicit enablement and non-off mode', () => {
  assert.match(indexSource, /sourceMemoryConfig\.enabled !== false && sourceMemoryMode !== 'off'/);
  assert.match(indexSource, /new ClaimStore\(this\.indexer\.db, config\)/);
  assert.match(indexSource, /this\.claimStore\.createTables\(\)/);
});

run('observe init logs stats only and does not create claims or inject prompts', () => {
  assert.match(indexSource, /Build2 observe \$\{type\}/);
  assert.match(indexSource, /stats: this\.claimStore\.getStats\(this\.agentId\)/);
  assert.doesNotMatch(indexSource, /createClaimsFromHandoffs[\s\S]{0,500}storeClaim/);
  assert.doesNotMatch(indexSource, /sourceAddressableMemory[\s\S]{0,1000}prependContext/);
});

run('candidate observe wiring is explicitly enabled and logs counts plus persistence outcomes', () => {
  assert.match(indexSource, /createClaimCandidates/);
  assert.match(indexSource, /function _observeClaimCandidates/);
  assert.match(indexSource, /sourceMemoryConfig\.enabled !== true/);
  assert.match(indexSource, /Build2 observe claim_candidates/);
  assert.match(indexSource, /candidateCount: result\.candidateCount/);
  assert.match(indexSource, /types: typeCounts/);
  assert.match(indexSource, /sourceHandles/);
  assert.match(indexSource, /persistAttempted: persistence\.attempted/);
  assert.match(indexSource, /persisted: persistence\.persisted/);
  assert.match(indexSource, /persistedCount: persistence\.persistedCount/);
  assert.match(indexSource, /action: persistence\.persisted \? 'record_mode_persisted_candidates' : result\.action/);
});

run('Build 3 claim context defaults remain diagnostic-only and non-injecting', () => {
  const contextConfig = config.sourceAddressableMemory.claimContext;
  assert.equal(contextConfig.enabled, false);
  assert.equal(contextConfig.mode, 'diagnostic');
  assert.equal(contextConfig.injectMode, 'none');
  assert.equal(contextConfig.includeSourceExcerpts, false);
  assert.doesNotMatch(indexSource, /claimContext[\s\S]{0,1000}prependContext/);
  assert.match(indexSource, /function _appendClaimContextInjection/);
  assert.match(indexSource, /contextConfig\.mode !== 'live'/);
  assert.match(indexSource, /contextConfig\.injectMode !== 'minimal'/);
  assert.match(indexSource, /preview\.injectionReady !== true/);
});

run('Build 3 runtime preview wiring is observe-only and non-injecting', () => {
  assert.match(indexSource, /createClaimContextPreview/);
  assert.match(indexSource, /function _observeClaimContextPreview/);
  assert.match(indexSource, /Build3 observe claim_context_preview/);
  assert.match(indexSource, /_observeClaimContextPreview\(\{ state, config, api, kind: 'before_agent_start' \}\)/);
  const helperStart = indexSource.indexOf('function _observeClaimContextPreview');
  const helperEnd = indexSource.indexOf('function _appendClaimContextInjection');
  assert.ok(helperStart > 0);
  assert.ok(helperEnd > helperStart);
  const helperSource = indexSource.slice(helperStart, helperEnd);
  assert.match(helperSource, /contextConfig\.enabled !== true/);
  assert.match(helperSource, /createClaimContextPreview/);
  assert.match(helperSource, /omittedByDiversity/);
  assert.match(helperSource, /byKind/);
  assert.match(helperSource, /byPrimarySourceType/);
  assert.doesNotMatch(helperSource, /prependContext|lines\.push|storeClaim|persistClaimCandidateResult|resolveSource|sourceResolver/);
});

run('Build 5 claim context injection is gated behind explicit live minimal config and injection-ready preview', () => {
  const helperStart = indexSource.indexOf('function _appendClaimContextInjection');
  const helperEnd = indexSource.indexOf('function _consumeSessionHandoffFromWorkspace');
  assert.ok(helperStart > 0);
  assert.ok(helperEnd > helperStart);
  const helperSource = indexSource.slice(helperStart, helperEnd);
  assert.match(helperSource, /contextConfig\.mode !== 'live'/);
  assert.match(helperSource, /contextConfig\.injectMode !== 'minimal'/);
  assert.match(helperSource, /preview\.injectionReady !== true/);
  assert.match(helperSource, /promptInjectionAttempted: true/);
  assert.doesNotMatch(helperSource, /storeClaim|persistClaimCandidateResult|resolveSource|sourceResolver/);
});

run('candidate persistence path is helper-gated and does not inject prompt context', () => {
  const helperStart = indexSource.indexOf('function _observeClaimCandidates');
  const helperEnd = indexSource.indexOf('function _observeClaimContextPreview');
  assert.ok(helperStart > 0);
  assert.ok(helperEnd > helperStart);
  const helperSource = indexSource.slice(helperStart, helperEnd);
  assert.match(helperSource, /persistClaimCandidateResult/);
  assert.doesNotMatch(helperSource, /storeClaim|claimStore\.store|sourceResolver|resolveSource|prependContext|lines\.push/);
});

const pass = results.filter((r) => r.status === 'PASS').length;
const fail = results.length - pass;
const lines = [];
lines.push('# Source Addressable Init Test Report');
lines.push('');
lines.push(`- PASS: ${pass}`);
lines.push(`- FAIL: ${fail}`);
lines.push(`- Total: ${results.length}`);
lines.push('');
lines.push('| Fixture | Status | Detail |');
lines.push('|---|---:|---|');
for (const result of results) lines.push(`| ${escapePipes(result.name)} | ${result.status} | ${escapePipes(result.detail)} |`);
lines.push('');

const reportPath = path.join(__dirname, 'reports', 'source-addressable-init.md');
fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

console.log(`Source addressable init tests: PASS=${pass} FAIL=${fail}`);
console.log(`Report: ${path.relative(process.cwd(), reportPath)}`);
if (fail) {
  for (const r of results.filter((r) => r.status === 'FAIL')) console.error(`${r.name}: ${r.detail}`);
  process.exit(1);
}

function run(name, fn) {
  try {
    fn();
    results.push({ name, status: 'PASS', detail: 'ok' });
  } catch (err) {
    results.push({ name, status: 'FAIL', detail: err.message });
  }
}

function escapePipes(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}
