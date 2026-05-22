#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const createClaimsTool = require('../tools/continuity-claims');

const pluginRoot = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'openclaw.plugin.json'), 'utf8'));
const indexSource = fs.readFileSync(path.join(pluginRoot, 'index.js'), 'utf8');
const claimsToolSource = fs.readFileSync(path.join(pluginRoot, 'tools', 'continuity-claims.js'), 'utf8');
const results = [];

const expectedTools = [
  'continuity_recall',
  'continuity_timeline',
  'continuity_claims',
  'knowledge_note',
  'continuity_search'
];

main();

function main() {
  run('manifest tool contract is exact and ordered', () => {
    assert.deepEqual(manifest.contracts.tools, expectedTools);
  });

  run('manifest tools have matching registration evidence', () => {
    assert.match(indexSource, /api\.registerTool\(\(toolCtx = \{\}\) => createRecallTool/);
    assert.match(indexSource, /api\.registerTool\(\(toolCtx = \{\}\) => createTimelineTool/);
    assert.match(indexSource, /api\.registerTool\(\(toolCtx = \{\}\) => createClaimsTool/);
    assert.match(indexSource, /api\.registerTool\(\(toolCtx = \{\}\) => createKnowledgeNoteTool/);
    assert.match(indexSource, /api\.registerTool\(\(toolCtx = \{\}\) => \(\{[\s\S]*name: 'continuity_search'/);
  });

  run('direct continuity tools bind to per-agent tool context before falling back to global currentAgentId', () => {
    assert.match(indexSource, /function getToolAgentId\(toolCtx\) \{ return toolCtx\?\.agentId \|\| getCurrentAgentId\(\) \|\| 'main'; \}/);
    assert.match(indexSource, /function createToolAgentIdResolver\(toolCtx\) \{ return \(\) => getToolAgentId\(toolCtx\); \}/);
    assert.match(indexSource, /createClaimsTool\(getAgentState, createToolAgentIdResolver\(toolCtx\)\)/);
    assert.match(indexSource, /const agentId = getToolAgentId\(toolCtx\);/);
  });

  run('continuity_claims schema remains diagnostic plus narrowly gated apply', () => {
    const tool = createClaimsTool(() => ({}), () => 'trail-guide');
    assert.equal(tool.name, 'continuity_claims');
    assert.equal(tool.parameters.type, 'object');
    assert.deepEqual(tool.parameters.properties.action.enum, ['get', 'list', 'source', 'verify', 'stats', 'context', 'context_audit', 'trial_plan', 'verification_plan', 'preflight', 'manual_review', 'research', 'autonomy_review', 'apply_review_decision', 'rollback_review_decision']);
    assert.equal(tool.parameters.properties.limit.default, 10);
    assert.equal(tool.parameters.properties.include_sources.default, false);
    assert.equal(tool.parameters.properties.include_source_excerpts.default, false);
    assert.equal(tool.parameters.properties.include_metadata.default, false);

    const mutatingActions = ['set', 'put', 'add', 'create', 'update', 'delete', 'remove', 'persist', 'resolve', 'inject', 'consume', 'promote'];
    for (const action of mutatingActions) {
      assert.ok(!tool.parameters.properties.action.enum.includes(action), `unexpected broad mutating action: ${action}`);
    }
    assert.equal(tool.parameters.properties.decision.enum.length, 2);
    assert.deepEqual(tool.parameters.properties.expected_status.enum, ['verify_required', 'stale']);
    assert.match(tool.parameters.properties.operator_approval.description, /approve:<claim_id>:<decision>:<expected_status>/);
    assert.match(tool.parameters.properties.operator_approval.description, /Low-risk bounded apply does not require it/);
    assert.match(tool.parameters.properties.receipt_id.description, /rollback_review_decision/);
    assert.match(tool.description, /Diagnostics for source-addressable memory claims/);
    assert.match(tool.description, /single-claim autonomous write-through and rollback experiment/);
    assert.match(tool.description, /autonomously apply/);
    assert.match(tool.description, /Does not resolve source text, inject prompt context, consume context, batch mutate, or promote claims to active truth/);
  });

  run('continuity_claims implementation imports only the gated apply helper and no source-resolution helpers', () => {
    assert.doesNotMatch(claimsToolSource, /source-resolver|claim-candidate-persistence|claim-candidates/);
    assert.doesNotMatch(claimsToolSource, /deleteClaim|updateClaim|persistClaimCandidateResult|createTables|resolveSource|sourceResolver/);
    assert.match(claimsToolSource, /claim-autonomy-review-decision-apply/);
    assert.match(claimsToolSource, /ClaimStore is not initialized/);
  });

  run('source excerpt display remains opt-in and non-resolving', () => {
    const tool = createClaimsTool(() => ({}), () => 'trail-guide');
    assert.match(tool.parameters.properties.include_sources.description, /Source excerpts remain hidden unless include_source_excerpts is true/);
    assert.match(tool.parameters.properties.include_source_excerpts.description, /Does not resolve source handles/);
    assert.match(claimsToolSource, /includeSourceExcerpts: .*Boolean\(args\.include_source_excerpts\)/s);
    assert.doesNotMatch(claimsToolSource, /includeResolvedContent|resolveSources|inspectClaimWithResolvedSources/);
  });

  run('tool unavailable path stays safe when storage is inert', async () => {
    const tool = createClaimsTool(() => ({ ensureStorage: async () => {} }), () => 'trail-guide');
    const result = await tool.execute('contract_call_1', { action: 'list', include_source_excerpts: true });
    const text = result.content[0].text;
    assert.match(text, /ClaimStore is not initialized/);
    assert.doesNotMatch(text, /excerpt:/);
    assert.doesNotMatch(text, /resolved/);
  });

  writeReportAndExit();
}

function run(name, fn) {
  try {
    const value = fn();
    if (value && typeof value.then === 'function') {
      results.push(value.then(
        () => ({ name, status: 'PASS', detail: 'ok' }),
        (err) => ({ name, status: 'FAIL', detail: err.message })
      ));
    } else {
      results.push({ name, status: 'PASS', detail: 'ok' });
    }
  } catch (err) {
    results.push({ name, status: 'FAIL', detail: err.message });
  }
}

async function writeReportAndExit() {
  const settled = await Promise.all(results);
  const pass = settled.filter((r) => r.status === 'PASS').length;
  const fail = settled.length - pass;
  const lines = [];
  lines.push('# Continuity Claims Contract Drift Test Report');
  lines.push('');
  lines.push(`- PASS: ${pass}`);
  lines.push(`- FAIL: ${fail}`);
  lines.push(`- Total: ${settled.length}`);
  lines.push('');
  lines.push('| Fixture | Status | Detail |');
  lines.push('|---|---:|---|');
  for (const result of settled) lines.push(`| ${escapePipes(result.name)} | ${result.status} | ${escapePipes(result.detail || 'ok')} |`);
  lines.push('');

  const reportPath = path.join(__dirname, 'reports', 'continuity-claims-contract.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

  console.log(`Continuity claims contract drift tests: PASS=${pass} FAIL=${fail}`);
  console.log(`Report: ${path.relative(process.cwd(), reportPath)}`);
  if (fail) {
    for (const r of settled.filter((r) => r.status === 'FAIL')) console.error(`${r.name}: ${r.detail}`);
    process.exit(1);
  }
}

function escapePipes(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}
