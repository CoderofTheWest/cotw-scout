#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

const pluginRoot = path.join(__dirname, '..');
const companionRoot = path.resolve(pluginRoot, '..', '..');
const openclawDist = path.join(companionRoot, 'node_modules', 'openclaw', 'dist');
const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'openclaw.plugin.json'), 'utf8'));
const indexSource = fs.readFileSync(path.join(pluginRoot, 'index.js'), 'utf8');
const claimsToolSource = fs.readFileSync(path.join(pluginRoot, 'tools', 'continuity-claims.js'), 'utf8');
const results = [];

main();

function main() {
  const pluginToolsSource = findDistSource(/function resolvePluginTools\(params\)/, /function resolvePluginToolRuntimePluginIds\(params\)/);
  const codingToolsSource = findDistSource(/const pluginToolAllowlist = sanitizePluginToolAllowlistForResolution\(collectExplicitAllowlist\(/, /options\?\.runtimeToolAllowlist \? \{ allow: options\.runtimeToolAllowlist \}/);
  const attemptToolRunContextSource = findDistSource(/function buildEmbeddedAttemptToolRunContext\(params\)/, /runtimeToolAllowlist: params\.toolsAllow/);
  const runAttemptSource = findDistSource(/function buildFinalToolFilterAllowlist\(params, sessionAgentId\)/, /normalizeAgentRuntimeTools\(/);
  const effectiveInventorySource = findDistSource(/function resolveEffectiveToolInventory\(params\)/, /createOpenClawCodingTools\(/);
  const gatewayToolResolutionSource = findDistSource(/function resolveGatewayScopedTools\(params\)/, /DEFAULT_GATEWAY_HTTP_TOOL_DENY/);

  run('continuity_claims is manifest-declared and runtime-registered by the continuity plugin', () => {
    assert.ok(manifest.contracts.tools.includes('continuity_claims'));
    assert.match(indexSource, /api\.registerTool\(\(toolCtx = \{\}\) => createClaimsTool\(getAgentState, createToolAgentIdResolver\(toolCtx\)\), \{ name: 'continuity_claims' \}\)/);
    assert.match(claimsToolSource, /name: 'continuity_claims'/);
  });

  run('continuity_claims registration is non-optional once plugin tools are admitted', () => {
    assert.doesNotMatch(indexSource, /createClaimsTool[\s\S]{0,120}\{\s*optional:\s*true/);
    assert.match(pluginToolsSource, /function pluginToolNamesMatchAllowlist\(params\) \{\s*if \(params\.allowlist\.size === 0\) return !params\.optional;/);
  });

  run('OpenClaw plugin exposure has a manifest/catalog availability layer', () => {
    assert.match(pluginToolsSource, /function resolvePluginToolRuntimePluginIds\(params\)/);
    assert.match(pluginToolsSource, /manifestToolContractMatchesAllowlist/);
    assert.match(pluginToolsSource, /hasManifestToolAvailability/);
    assert.match(pluginToolsSource, /loadManifestContractSnapshot/);
  });

  run('OpenClaw plugin exposure admits plugin tools only through tool allowlist semantics when narrowed', () => {
    assert.match(pluginToolsSource, /allowlist\.has\("\*"\)[\s\S]{0,80}allowlist\.has\("group:plugins"\)/);
    assert.match(pluginToolsSource, /allowlist\.has\(pluginKey\)/);
    assert.match(pluginToolsSource, /allowlist\.has\(normalizeToolName\(name\)\)/);
    assert.match(pluginToolsSource, /params\.allowlist\.has\("group:plugins"\)/);
  });

  run('per-turn agent runtime applies final toolsAllow filtering after tool assembly', () => {
    assert.match(runAttemptSource, /const finalToolAllowlist = buildFinalToolFilterAllowlist\(params, input\.sessionAgentId\);/);
    assert.match(runAttemptSource, /const filteredTools = finalToolAllowlist \? visionFilteredTools\.filter\(\(tool\) => finalToolAllowlist\.has\(normalizeFinalToolFilterName\(tool\.name\)\)\) : visionFilteredTools;/);
    assert.match(runAttemptSource, /return normalizeAgentRuntimeTools\(\{[\s\S]{0,500}tools: filteredTools/);
  });

  run('per-turn toolsAllow is bridged into plugin tool resolution as runtimeToolAllowlist', () => {
    assert.match(attemptToolRunContextSource, /\.\.\.params\.toolsAllow \? \{ runtimeToolAllowlist: params\.toolsAllow \} : \{\}/);
    assert.match(codingToolsSource, /options\?\.runtimeToolAllowlist \? \{ allow: options\.runtimeToolAllowlist \} : void 0/);
    assert.match(codingToolsSource, /const pluginToolAllowlist = sanitizePluginToolAllowlistForResolution\(collectExplicitAllowlist\(\[/);
  });

  run('agent profile alsoAllow participates in plugin tool descriptor resolution', () => {
    assert.match(codingToolsSource, /profilePolicyWithAlsoAllow/);
    assert.match(codingToolsSource, /providerProfilePolicyWithAlsoAllow/);
    assert.doesNotMatch(codingToolsSource, /const pluginToolAllowlist = sanitizePluginToolAllowlistForResolution\(collectExplicitAllowlist\(\[\s*profilePolicy,\s*providerProfilePolicy,/);
    assert.match(codingToolsSource, /const pluginToolAllowlist = sanitizePluginToolAllowlistForResolution\(collectExplicitAllowlist\(\[\s*profilePolicyWithAlsoAllow,\s*providerProfilePolicyWithAlsoAllow,/);
  });

  run('Gateway tools.invoke resolver admits plugin tools through alsoAllow descriptor resolution', () => {
    assert.match(gatewayToolResolutionSource, /function sanitizeGatewayPluginToolAllowlistForResolution\(allowlist\)/);
    assert.match(gatewayToolResolutionSource, /ensureStandalonePluginToolRegistryLoaded/);
    assert.match(gatewayToolResolutionSource, /toolAllowlist:\s*\["group:plugins"\]/);
    assert.match(gatewayToolResolutionSource, /pluginToolAllowlist: sanitizeGatewayPluginToolAllowlistForResolution\(collectExplicitAllowlist\(\[/);
    assert.doesNotMatch(gatewayToolResolutionSource, /pluginToolAllowlist: sanitizeGatewayPluginToolAllowlistForResolution\(collectExplicitAllowlist\(\[\s*profilePolicy,\s*providerProfilePolicy,/);
    assert.match(gatewayToolResolutionSource, /pluginToolAllowlist: sanitizeGatewayPluginToolAllowlistForResolution\(collectExplicitAllowlist\(\[\s*profilePolicyWithAlsoAllow,\s*providerProfilePolicyWithAlsoAllow,/);
  });

  run('agent tools alsoAllow survives final Codex app-server toolsAllow filtering', () => {
    assert.match(runAttemptSource, /function collectConfiguredAlsoAllowForFinalToolFilter\(params, sessionAgentId\)/);
    assert.match(runAttemptSource, /additions\.push\(\.\.\.collectStringList\(tools\?\.alsoAllow\)\)/);
    assert.match(runAttemptSource, /const names = \[\.\.\.params\.toolsAllow, \.\.\.collectConfiguredAlsoAllowForFinalToolFilter\(params, sessionAgentId\)\];/);
    assert.match(runAttemptSource, /agents\.find\(\(entry\) => typeof entry\?\.id === "string" && entry\.id\.trim\(\) === sessionAgentId\)/);
  });

  run('tools.effective preloads standalone plugin registry before computing effective inventory', () => {
    assert.match(effectiveInventorySource, /ensureStandalonePluginToolRegistryLoaded/);
    assert.match(effectiveInventorySource, /toolAllowlist:\s*\["group:plugins"\]/);
    assert.match(effectiveInventorySource, /allowGatewaySubagentBinding:\s*true/);
    assert.match(effectiveInventorySource, /ensureStandalonePluginToolRegistryLoaded\([\s\S]{0,500}const effectiveTools = createOpenClawCodingTools/);
  });

  run('plugin tool resolution preserves specific allowlist entries when wildcard policy is also present', () => {
    assert.match(codingToolsSource, /function sanitizePluginToolAllowlistForResolution\(allowlist\)/);
    assert.match(codingToolsSource, /if \(!allowlist\.includes\("\*"\)\) return allowlist/);
    assert.match(codingToolsSource, /const specific = allowlist\.filter\(\(entry\) => normalizeToolName\(entry\) !== "\*"\)/);
    assert.match(codingToolsSource, /return specific\.length > 0 \? specific : allowlist/);
  });

  run('continuity_claims can be admitted by an exact per-turn toolsAllow entry without broad plugin group grants', () => {
    assert.ok(manifest.contracts.tools.includes('continuity_claims'));
    assert.match(pluginToolsSource, /allowlist\.has\(normalizeToolName\(name\)\)/);
    assert.match(runAttemptSource, /finalToolAllowlist\.has\(normalizeFinalToolFilterName\(tool\.name\)\)/);
    assert.match(claimsToolSource, /apply_review_decision/);
    assert.match(claimsToolSource, /exact operator approval string/);
    assert.doesNotMatch(claimsToolSource, /action:\s*['"]write|action:\s*['"]mutation|action:\s*['"]delete|action:\s*['"]record/i);
  });


  run('continuity claims diagnostics command is an explicit read-only workflow', () => {
    const commandBlock = indexSource.match(/api\.registerCommand\(\{[\s\S]*?name:\s*'continuity-claims'[\s\S]*?\n        \}\);/)?.[0] || '';
    assert.match(commandBlock, /name:\s*'continuity-claims'/);
    assert.match(commandBlock, /runClaimsDiagnosticsCommand/);
    assert.match(commandBlock, /stats, list, verify/);
    assert.doesNotMatch(commandBlock, /replaceConfigFile|config\.patch|persistClaimCandidateResult|storeClaim/);
  });

  run('continuity claims diagnostics exposes a direct operator proof path', () => {
    const methodBlock = indexSource.match(/api\.registerGatewayMethod\('continuity\.claimsCommand'[\s\S]*?\n        \}\);/)?.[0] || '';
    assert.match(methodBlock, /continuity\.claimsCommand/);
    assert.match(methodBlock, /runClaimsDiagnosticsCommand/);
    assert.match(methodBlock, /getCurrentAgentId:\s*\(\)\s*=>\s*agentId/);
    assert.match(methodBlock, /respond\(true, \{ text \}\)/);
    assert.doesNotMatch(methodBlock, /replaceConfigFile|config\.patch|persistClaimCandidateResult|storeClaim|createClaimRecord/);
  });

  run('continuity claim fixture seed is explicit and dry-run-first', () => {
    const methodBlock = indexSource.match(/api\.registerGatewayMethod\('continuity\.claimsSeedFixture'[\s\S]*?\n        \}\);/)?.[0] || '';
    assert.match(methodBlock, /continuity\.claimsSeedFixture/);
    assert.match(methodBlock, /createClaimFixtureSeed/);
    assert.match(methodBlock, /apply:\s*params\?\.apply === true/);
    assert.match(methodBlock, /renderClaimFixtureSeed/);
  });

  run('continuity claim review decision command is explicit and dry-run-first', () => {
    const commandStart = indexSource.indexOf("name: 'continuity-claims-decision'");
    const commandBlock = commandStart >= 0 ? indexSource.slice(commandStart, indexSource.indexOf('        });', commandStart) + 11) : '';
    assert.match(commandBlock, /continuity-claims-decision/);
    assert.match(commandBlock, /runClaimReviewDecisionCommand/);
    assert.match(commandBlock, /Dry-run by default/);
    assert.doesNotMatch(commandBlock, /runClaimsDiagnosticsCommand/);
    assert.doesNotMatch(commandBlock, /sourceResolver|resolveSource|prependContext|inject/);
  });

  run('continuity claim review gateway method returns bounded operator failures instead of transport errors', () => {
    const methodBlock = indexSource.match(/api\.registerGatewayMethod\('continuity\.claimsReviewDecision'[\s\S]*?api\.registerGatewayMethod\('continuity\.claimsSourceResolution'/)?.[0] || '';
    assert.match(methodBlock, /continuity\.claimsReviewDecision/);
    assert.match(methodBlock, /Claim review decision failed:/);
    assert.match(methodBlock, /respond\(true, \{/);
    assert.match(methodBlock, /no mutation on failed decision/);
    assert.match(methodBlock, /no promotion on failed decision/);
  });

  run('continuity claim source resolution is explicit read-only operator surface', () => {
    const commandStart = indexSource.indexOf("name: 'continuity-claims-source'");
    const commandBlock = commandStart >= 0 ? indexSource.slice(commandStart, indexSource.indexOf('        });', commandStart) + 11) : '';
    const methodBlock = indexSource.match(/api\.registerGatewayMethod\('continuity\.claimsSourceResolution'[\s\S]*?api\.registerGatewayMethod\('continuity\.claimsVerifySource'/)?.[0] || '';
    assert.match(commandBlock, /continuity-claims-source/);
    assert.match(commandBlock, /runClaimSourceResolutionCommand/);
    assert.match(commandBlock, /Does not verify, promote, mutate, consume, or inject prompt context/);
    assert.match(methodBlock, /continuity\.claimsSourceResolution/);
    assert.match(methodBlock, /runClaimSourceResolutionCommand/);
    assert.match(methodBlock, /respond\(true, \{ text \}\)/);
    assert.doesNotMatch(commandBlock, /createClaimReviewDecision|createClaimFixtureSeed|storeClaim|persistClaimCandidateResult|prependContext/);
    assert.doesNotMatch(methodBlock, /createClaimReviewDecision|createClaimFixtureSeed|storeClaim|persistClaimCandidateResult|prependContext/);
  });

  run('continuity claim source verification helper is explicit and read-only', () => {
    const commandStart = indexSource.indexOf("name: 'continuity-claims-verify-source'");
    const commandBlock = commandStart >= 0 ? indexSource.slice(commandStart, indexSource.indexOf('        });', commandStart) + 11) : '';
    const methodBlock = indexSource.match(/api\.registerGatewayMethod\('continuity\.claimsVerifySource'[\s\S]*?api\.registerGatewayMethod\('continuity\.claimsSeedFixture'/)?.[0] || '';
    assert.match(commandBlock, /continuity-claims-verify-source/);
    assert.match(commandBlock, /runClaimSourceVerificationCommand/);
    assert.match(commandBlock, /Produces operator guidance only/);
    assert.match(methodBlock, /continuity\.claimsVerifySource/);
    assert.match(methodBlock, /runClaimSourceVerificationCommand/);
    assert.match(methodBlock, /comparisonAttempted: false/);
    assert.match(methodBlock, /verificationDecisionAttempted: false/);
    assert.doesNotMatch(commandBlock, /createClaimReviewDecision|createClaimFixtureSeed|storeClaim|persistClaimCandidateResult|prependContext/);
    assert.doesNotMatch(methodBlock, /createClaimReviewDecision|createClaimFixtureSeed|storeClaim|persistClaimCandidateResult|prependContext/);
  });

  run('invocation availability failure is policy/exposure, not missing continuity tool registration', () => {
    assert.ok(manifest.contracts.tools.includes('continuity_claims'));
    assert.match(indexSource, /api\.registerTool\(\(toolCtx = \{\}\) => createClaimsTool/);
    assert.match(pluginToolsSource, /resolvePluginTools/);
    assert.match(runAttemptSource, /params\.toolsAllow/);
  });

  writeReportAndExit();
}

function findDistSource(...patterns) {
  const files = fs.readdirSync(openclawDist)
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join(openclawDist, name));
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    if (patterns.every((pattern) => pattern.test(source))) return source;
  }
  throw new Error(`Could not find OpenClaw dist source containing: ${patterns.map(String).join(', ')}`);
}

function run(name, fn) {
  try {
    fn();
    results.push({ name, status: 'PASS', detail: 'ok' });
  } catch (err) {
    results.push({ name, status: 'FAIL', detail: err.message });
  }
}

function writeReportAndExit() {
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.length - pass;
  const lines = [];
  lines.push('# Continuity Claims Invocation Policy Test Report');
  lines.push('');
  lines.push(`- PASS: ${pass}`);
  lines.push(`- FAIL: ${fail}`);
  lines.push(`- Total: ${results.length}`);
  lines.push('');
  lines.push('| Fixture | Status | Detail |');
  lines.push('|---|---:|---|');
  for (const result of results) lines.push(`| ${escapePipes(result.name)} | ${result.status} | ${escapePipes(result.detail)} |`);
  lines.push('');

  const reportPath = path.join(__dirname, 'reports', 'continuity-claims-invocation-policy.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

  console.log(`Continuity claims invocation policy tests: PASS=${pass} FAIL=${fail}`);
  console.log(`Report: ${path.relative(process.cwd(), reportPath)}`);
  if (fail) {
    for (const r of results.filter((r) => r.status === 'FAIL')) console.error(`${r.name}: ${r.detail}`);
    process.exit(1);
  }
}

function escapePipes(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}
