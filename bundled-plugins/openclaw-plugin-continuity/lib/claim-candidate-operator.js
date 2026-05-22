const fs = require('fs');
const path = require('path');
const {
  CONTINUITY_CONFIG_PATH,
  getContinuityConfig,
  readConfigFile,
  writeConfigFile
} = require('./record-mode-operator');

const DEFAULT_MAX_CLAIMS = 8;
const SOURCE_FLAGS = Object.freeze({
  handoff: 'createClaimsFromHandoffs',
  summary: 'createClaimsFromSummaries',
  digest: 'createClaimsFromDigests'
});
const SOURCE_VALUES = Object.freeze(Object.keys(SOURCE_FLAGS));

/**
 * Operator-owned Build 6 staged candidate creation helpers.
 *
 * This opens automatic claim candidate persistence without opening automatic
 * belief. Persisted claims remain candidateOnly and are excluded from live
 * prompt injection until a separate accept_verified review resolves and
 * compares their source evidence.
 */
function createCandidateActivationPlan(input = {}) {
  const source = normalizeSource(input.source || 'handoff');
  const maxClaims = normalizeMaxClaims(input.maxClaims);
  return {
    ok: true,
    source,
    maxClaims,
    warnings: [
      'automatic candidate creation only',
      'candidateOnly claims are not injectable',
      'acceptedVerifiedOnly live gate stays enabled',
      'source excerpts remain hidden from prompt context',
      'script does not restart Gateway',
      'script does not verify, accept, promote, or inject claims'
    ]
  };
}

function previewActivation(config, input = {}) {
  const plan = createCandidateActivationPlan(input);
  const current = getContinuityConfig(config).sourceAddressableMemory || null;
  const desired = buildDesiredSourceAddressableMemory(current, plan);
  const validation = validateCandidateConfig({ sourceAddressableMemory: desired }, { source: plan.source });
  const nextConfig = setContinuitySourceAddressableMemory(config, desired);
  return {
    ok: validation.ok,
    source: plan.source,
    current,
    desired,
    rollback: buildRollbackSourceAddressableMemory(current, plan),
    validation,
    warnings: plan.warnings,
    nextConfig
  };
}

function previewRollback(config, input = {}) {
  const current = getContinuityConfig(config).sourceAddressableMemory || null;
  const plan = createCandidateActivationPlan({
    source: input.source || detectEnabledSource(current) || 'handoff',
    maxClaims: input.maxClaims || current?.claimContext?.maxClaims || DEFAULT_MAX_CLAIMS
  });
  const rollback = buildRollbackSourceAddressableMemory(current, plan);
  const validation = validateCandidateRollbackConfig({ sourceAddressableMemory: rollback });
  const nextConfig = setContinuitySourceAddressableMemory(config, rollback);
  return { ok: validation.ok, source: plan.source, current, rollback, validation, nextConfig };
}

function applyActivationFile(configPath, input = {}) {
  if (input.confirm !== true) throw new Error('refusing to apply without explicit confirm=true');
  const { parsed } = readConfigFile(configPath);
  const preview = previewActivation(parsed, input);
  if (!preview.ok) throw new Error(`candidate activation failed validation: ${preview.validation.errors.join('; ')}`);
  const backupPath = writeBackup(configPath, parsed, input);
  writeConfigFile(configPath, preview.nextConfig);
  return { ok: true, action: 'apply', source: preview.source, configPath, backupPath, desired: preview.desired, warnings: preview.warnings };
}

function applyRollbackFile(configPath, input = {}) {
  if (input.confirm !== true) throw new Error('refusing to rollback without explicit confirm=true');
  const { parsed } = readConfigFile(configPath);
  const preview = previewRollback(parsed, input);
  if (!preview.ok) throw new Error(`candidate rollback failed validation: ${preview.validation.errors.join('; ')}`);
  const backupPath = writeBackup(configPath, parsed, input);
  writeConfigFile(configPath, preview.nextConfig);
  return { ok: true, action: 'rollback', source: preview.source, configPath, backupPath, rollback: preview.rollback };
}

function buildDesiredSourceAddressableMemory(current, plan = {}) {
  const existing = current && typeof current === 'object' ? cloneJson(current) : {};
  const source = normalizeSource(plan.source || 'handoff');
  const maxClaims = normalizeMaxClaims(plan.maxClaims || existing.claimContext?.maxClaims || DEFAULT_MAX_CLAIMS);
  const desired = {
    ...existing,
    enabled: true,
    mode: 'record',
    storage: existing.storage || 'sqlite',
    injectMode: 'none',
    createClaimsFromHandoffs: false,
    createClaimsFromSummaries: false,
    createClaimsFromDigests: false,
    persistClaimCandidates: true,
    resolveOnDemand: existing.resolveOnDemand !== false,
    claimContext: {
      ...(existing.claimContext && typeof existing.claimContext === 'object' ? cloneJson(existing.claimContext) : {}),
      enabled: true,
      mode: 'live',
      injectMode: 'minimal',
      acceptedVerifiedOnly: true,
      maxClaims,
      includeSourceExcerpts: false
    }
  };
  desired[SOURCE_FLAGS[source]] = true;
  return desired;
}

function buildRollbackSourceAddressableMemory(current, plan = {}) {
  const existing = current && typeof current === 'object' ? cloneJson(current) : {};
  const maxClaims = normalizeMaxClaims(plan.maxClaims || existing.claimContext?.maxClaims || DEFAULT_MAX_CLAIMS);
  return {
    ...existing,
    enabled: true,
    mode: 'observe',
    storage: existing.storage || 'sqlite',
    injectMode: 'none',
    createClaimsFromHandoffs: false,
    createClaimsFromSummaries: false,
    createClaimsFromDigests: false,
    persistClaimCandidates: false,
    resolveOnDemand: existing.resolveOnDemand !== false,
    claimContext: {
      ...(existing.claimContext && typeof existing.claimContext === 'object' ? cloneJson(existing.claimContext) : {}),
      enabled: true,
      mode: 'live',
      injectMode: 'minimal',
      acceptedVerifiedOnly: true,
      maxClaims,
      includeSourceExcerpts: false
    }
  };
}

function validateCandidateConfig(config = {}, options = {}) {
  const source = normalizeSource(options.source || detectEnabledSource(config.sourceAddressableMemory) || 'handoff');
  const errors = [];
  const sam = config.sourceAddressableMemory || {};
  const claimContext = sam.claimContext || {};

  if (sam.enabled !== true) errors.push('sourceAddressableMemory.enabled must be true');
  if (sam.mode !== 'record') errors.push('sourceAddressableMemory.mode must be record for candidate creation');
  if (sam.storage !== undefined && sam.storage !== 'sqlite') errors.push('sourceAddressableMemory.storage must be sqlite when specified');
  if (sam.injectMode !== undefined && sam.injectMode !== 'none') errors.push('sourceAddressableMemory.injectMode must remain none');
  if (sam.persistClaimCandidates !== true) errors.push('persistClaimCandidates must be true for candidate creation');

  const enabledSources = SOURCE_VALUES.filter((name) => sam[SOURCE_FLAGS[name]] === true);
  if (enabledSources.length !== 1 || enabledSources[0] !== source) {
    errors.push(`exactly one candidate source must be enabled: ${SOURCE_FLAGS[source]}`);
  }

  validateLiveGate(claimContext, errors);
  return { ok: errors.length === 0, errors, source };
}

function validateCandidateRollbackConfig(config = {}) {
  const errors = [];
  const sam = config.sourceAddressableMemory || {};
  const claimContext = sam.claimContext || {};
  if (sam.enabled !== true) errors.push('rollback keeps sourceAddressableMemory.enabled=true for claim context');
  if (sam.mode !== 'observe') errors.push('rollback must restore observe mode');
  if (sam.injectMode !== undefined && sam.injectMode !== 'none') errors.push('rollback must keep injectMode=none');
  if (sam.persistClaimCandidates !== false) errors.push('rollback must disable candidate persistence');
  for (const flag of Object.values(SOURCE_FLAGS)) {
    if (sam[flag] !== false) errors.push(`rollback must disable ${flag}`);
  }
  validateLiveGate(claimContext, errors);
  return { ok: errors.length === 0, errors };
}

function validateLiveGate(claimContext, errors) {
  if (claimContext.enabled !== true) errors.push('claimContext.enabled must remain true');
  if (claimContext.mode !== 'live') errors.push('claimContext.mode must remain live');
  if (claimContext.injectMode !== 'minimal') errors.push('claimContext.injectMode must remain minimal');
  if (claimContext.acceptedVerifiedOnly !== true) errors.push('claimContext.acceptedVerifiedOnly must remain true');
  if (claimContext.includeSourceExcerpts !== false) errors.push('claimContext.includeSourceExcerpts must remain false');
  if (!Number.isInteger(claimContext.maxClaims) || claimContext.maxClaims < 1 || claimContext.maxClaims > 25) {
    errors.push('claimContext.maxClaims must be an integer between 1 and 25');
  }
}

function setContinuitySourceAddressableMemory(config, sourceAddressableMemory) {
  const clone = cloneJson(config || {});
  let cursor = clone;
  for (const key of CONTINUITY_CONFIG_PATH) {
    if (!cursor[key] || typeof cursor[key] !== 'object' || Array.isArray(cursor[key])) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor.sourceAddressableMemory = cloneJson(sourceAddressableMemory);
  return clone;
}

function renderOperatorSummary(summary = {}, options = {}) {
  const format = options.format || 'markdown';
  if (format === 'json') return JSON.stringify(stripConfig(summary), null, 2);
  if (format !== 'markdown') throw new Error(`unsupported operator summary format: ${format}`);
  const desired = summary.desired || summary.rollback || {};
  const claimContext = desired.claimContext || {};
  const lines = [];
  lines.push(`# Build 6 Claim-Candidate Operator ${summary.action || 'Plan'}`);
  lines.push('');
  lines.push(`- OK: ${summary.ok === true ? 'yes' : 'no'}`);
  if (summary.source) lines.push(`- Source: ${summary.source}`);
  if (summary.configPath) lines.push(`- Config: ${summary.configPath}`);
  if (summary.backupPath) lines.push(`- Backup: ${summary.backupPath}`);
  if (summary.validation?.errors?.length) lines.push(`- Errors: ${summary.validation.errors.join('; ')}`);
  lines.push('');
  lines.push('## Candidate Creation');
  lines.push(`- mode: ${desired.mode || '(unknown)'}`);
  lines.push(`- persistClaimCandidates: ${desired.persistClaimCandidates === true}`);
  for (const source of SOURCE_VALUES) lines.push(`- ${SOURCE_FLAGS[source]}: ${desired[SOURCE_FLAGS[source]] === true}`);
  lines.push('');
  lines.push('## Live Injection Gate Preserved');
  lines.push('```json');
  lines.push(JSON.stringify(claimContext, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Boundaries');
  lines.push('- Creates candidates only; does not accept or promote beliefs.');
  lines.push('- Candidate-only claims remain excluded from live injection.');
  lines.push('- Only accepted verified claims are eligible for prompt context.');
  lines.push('- Source excerpts remain hidden.');
  lines.push('- Script does not restart Gateway.');
  return lines.join('\n');
}

function writeBackup(configPath, config, input = {}) {
  const stamp = safeStamp(input.now || new Date().toISOString());
  const backupDir = input.backupDir || path.dirname(configPath);
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `${path.basename(configPath)}.claim-candidates.${stamp}.bak`);
  fs.writeFileSync(backupPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return backupPath;
}

function normalizeSource(source) {
  const value = String(source || '').trim();
  if (!SOURCE_FLAGS[value]) throw new Error(`unsupported source "${value || '(empty)'}"; use: ${SOURCE_VALUES.join(', ')}`);
  return value;
}

function detectEnabledSource(sourceAddressableMemory = {}) {
  const enabled = SOURCE_VALUES.filter((name) => sourceAddressableMemory?.[SOURCE_FLAGS[name]] === true);
  return enabled.length === 1 ? enabled[0] : null;
}

function normalizeMaxClaims(value) {
  const n = Number(value || DEFAULT_MAX_CLAIMS);
  if (!Number.isInteger(n) || n < 1 || n > 25) throw new Error('maxClaims must be an integer between 1 and 25');
  return n;
}

function stripConfig(summary = {}) {
  const { nextConfig, ...rest } = summary;
  return rest;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeStamp(value) {
  return String(value).replace(/[^0-9A-Za-z._-]/g, '-');
}

module.exports = {
  SOURCE_FLAGS,
  SOURCE_VALUES,
  applyActivationFile,
  applyRollbackFile,
  buildDesiredSourceAddressableMemory,
  buildRollbackSourceAddressableMemory,
  createCandidateActivationPlan,
  previewActivation,
  previewRollback,
  renderOperatorSummary,
  setContinuitySourceAddressableMemory,
  validateCandidateConfig,
  validateCandidateRollbackConfig
};
