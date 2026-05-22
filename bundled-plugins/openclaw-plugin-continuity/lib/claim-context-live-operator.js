const fs = require('fs');
const path = require('path');
const {
  CONTINUITY_CONFIG_PATH,
  getContinuityConfig,
  readConfigFile,
  writeConfigFile
} = require('./record-mode-operator');

const DEFAULT_MAX_CLAIMS = 8;

/**
 * Operator-owned Build 5 verified claim-context live activation helpers.
 *
 * This only enables the minimal prompt-context injection path. It does not
 * enable claim creation, candidate persistence, source excerpts, source
 * resolution, or claim mutation. Runtime injection remains guarded by accepted
 * verified claim metadata and an injection-ready preview packet.
 */
function createLiveActivationPlan(input = {}) {
  const maxClaims = normalizeMaxClaims(input.maxClaims);
  return {
    ok: true,
    desiredClaimContext: {
      enabled: true,
      mode: 'live',
      injectMode: 'minimal',
      acceptedVerifiedOnly: true,
      maxClaims,
      includeSourceExcerpts: false
    },
    rollbackClaimContext: {
      enabled: false,
      mode: 'diagnostic',
      injectMode: 'none',
      acceptedVerifiedOnly: true,
      maxClaims,
      includeSourceExcerpts: false
    },
    warnings: [
      'Build 5 live minimal injection only',
      'only accepted verified claims are eligible',
      'source excerpts remain hidden',
      'recording and claim creation remain disabled',
      'script does not restart Gateway',
      'script does not resolve source handles or mutate claims'
    ]
  };
}

function previewActivation(config, input = {}) {
  const plan = createLiveActivationPlan(input);
  const current = getContinuityConfig(config).sourceAddressableMemory || null;
  const desired = buildDesiredSourceAddressableMemory(current, plan.desiredClaimContext);
  const validation = validateLiveConfig({ sourceAddressableMemory: desired });
  const nextConfig = setContinuitySourceAddressableMemory(config, desired);
  return {
    ok: validation.ok,
    current,
    desired,
    rollback: buildRollbackSourceAddressableMemory(current, plan.rollbackClaimContext),
    validation,
    warnings: plan.warnings,
    nextConfig
  };
}

function previewRollback(config, input = {}) {
  const current = getContinuityConfig(config).sourceAddressableMemory || null;
  const maxClaims = normalizeMaxClaims(input.maxClaims || current?.claimContext?.maxClaims || DEFAULT_MAX_CLAIMS);
  const rollback = buildRollbackSourceAddressableMemory(current, {
    enabled: false,
    mode: 'diagnostic',
    injectMode: 'none',
    acceptedVerifiedOnly: true,
    maxClaims,
    includeSourceExcerpts: false
  });
  const validation = validateLiveConfig({ sourceAddressableMemory: rollback }, { allowDisabledClaimContext: true });
  const nextConfig = setContinuitySourceAddressableMemory(config, rollback);
  return {
    ok: validation.ok,
    current,
    rollback,
    validation,
    nextConfig
  };
}

function applyActivationFile(configPath, input = {}) {
  if (input.confirm !== true) throw new Error('refusing to apply without explicit confirm=true');
  const { parsed } = readConfigFile(configPath);
  const preview = previewActivation(parsed, input);
  if (!preview.ok) throw new Error(`live activation failed validation: ${preview.validation.errors.join('; ')}`);
  const backupPath = writeBackup(configPath, parsed, input);
  writeConfigFile(configPath, preview.nextConfig);
  return { ok: true, action: 'apply', configPath, backupPath, desired: preview.desired, warnings: preview.warnings };
}

function applyRollbackFile(configPath, input = {}) {
  if (input.confirm !== true) throw new Error('refusing to rollback without explicit confirm=true');
  const { parsed } = readConfigFile(configPath);
  const preview = previewRollback(parsed, input);
  if (!preview.ok) throw new Error(`live rollback failed validation: ${preview.validation.errors.join('; ')}`);
  const backupPath = writeBackup(configPath, parsed, input);
  writeConfigFile(configPath, preview.nextConfig);
  return { ok: true, action: 'rollback', configPath, backupPath, rollback: preview.rollback };
}

function buildDesiredSourceAddressableMemory(current, claimContext) {
  const existing = current && typeof current === 'object' ? cloneJson(current) : {};
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
    claimContext: cloneJson(claimContext)
  };
}

function buildRollbackSourceAddressableMemory(current, claimContext) {
  const existing = current && typeof current === 'object' ? cloneJson(current) : {};
  return {
    ...existing,
    injectMode: 'none',
    claimContext: cloneJson(claimContext)
  };
}

function validateLiveConfig(config = {}, options = {}) {
  const errors = [];
  const sam = config.sourceAddressableMemory || {};
  const claimContext = sam.claimContext || {};
  const allowDisabledClaimContext = options.allowDisabledClaimContext === true;

  if (sam.enabled !== true) errors.push('sourceAddressableMemory.enabled must be true for Build 5 live minimal injection');
  if (sam.mode !== 'observe') errors.push('sourceAddressableMemory.mode must be observe');
  if (sam.injectMode !== undefined && sam.injectMode !== 'none') errors.push('sourceAddressableMemory.injectMode must be none');
  if (sam.createClaimsFromHandoffs === true) errors.push('createClaimsFromHandoffs must remain false');
  if (sam.createClaimsFromSummaries === true) errors.push('createClaimsFromSummaries must remain false');
  if (sam.createClaimsFromDigests === true) errors.push('createClaimsFromDigests must remain false');
  if (sam.persistClaimCandidates === true) errors.push('persistClaimCandidates must remain false');
  if (!allowDisabledClaimContext && claimContext.enabled !== true) errors.push('claimContext.enabled must be true for live activation');
  if (allowDisabledClaimContext && claimContext.enabled !== false) errors.push('claimContext.enabled must be false for rollback');
  if (!allowDisabledClaimContext && claimContext.mode !== 'live') errors.push('claimContext.mode must be live');
  if (allowDisabledClaimContext && claimContext.mode !== 'diagnostic') errors.push('claimContext.mode must be diagnostic for rollback');
  if (!allowDisabledClaimContext && claimContext.injectMode !== 'minimal') errors.push('claimContext.injectMode must be minimal');
  if (allowDisabledClaimContext && claimContext.injectMode !== 'none') errors.push('claimContext.injectMode must be none for rollback');
  if (claimContext.acceptedVerifiedOnly !== true) errors.push('claimContext.acceptedVerifiedOnly must be true');
  if (claimContext.includeSourceExcerpts !== false) errors.push('claimContext.includeSourceExcerpts must be false');
  if (!Number.isInteger(claimContext.maxClaims) || claimContext.maxClaims < 1 || claimContext.maxClaims > 25) {
    errors.push('claimContext.maxClaims must be an integer between 1 and 25');
  }

  return { ok: errors.length === 0, errors };
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

function writeBackup(configPath, config, input = {}) {
  const stamp = safeStamp(input.now || new Date().toISOString());
  const backupDir = input.backupDir || path.dirname(configPath);
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `${path.basename(configPath)}.claim-context-live.${stamp}.bak`);
  fs.writeFileSync(backupPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return backupPath;
}

function renderOperatorSummary(summary = {}, options = {}) {
  const format = options.format || 'markdown';
  if (format === 'json') return JSON.stringify(stripConfig(summary), null, 2);
  if (format !== 'markdown') throw new Error(`unsupported operator summary format: ${format}`);
  const desired = summary.desired || summary.rollback || {};
  const claimContext = desired.claimContext || {};
  const lines = [];
  lines.push(`# Build 5 Claim-Context Live Operator ${summary.action || 'Plan'}`);
  lines.push('');
  lines.push(`- OK: ${summary.ok === true ? 'yes' : 'no'}`);
  if (summary.configPath) lines.push(`- Config: ${summary.configPath}`);
  if (summary.backupPath) lines.push(`- Backup: ${summary.backupPath}`);
  if (summary.validation?.errors?.length) lines.push(`- Errors: ${summary.validation.errors.join('; ')}`);
  lines.push('');
  lines.push('## Source-Addressable Memory');
  lines.push(`- enabled: ${desired.enabled}`);
  lines.push(`- mode: ${desired.mode || '(preserved)'}`);
  lines.push(`- injectMode: ${desired.injectMode || 'none'}`);
  lines.push(`- createClaimsFromHandoffs: ${desired.createClaimsFromHandoffs === true}`);
  lines.push(`- createClaimsFromSummaries: ${desired.createClaimsFromSummaries === true}`);
  lines.push(`- createClaimsFromDigests: ${desired.createClaimsFromDigests === true}`);
  lines.push(`- persistClaimCandidates: ${desired.persistClaimCandidates === true}`);
  lines.push('');
  lines.push('## Claim Context Live Gate');
  lines.push('```json');
  lines.push(JSON.stringify(claimContext, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Boundaries');
  lines.push('- Minimal prompt context injection only.');
  lines.push('- Only accepted verified claims are eligible.');
  lines.push('- Source excerpts remain hidden.');
  lines.push('- Recording and candidate persistence remain disabled.');
  lines.push('- Script does not restart Gateway.');
  lines.push('- Script does not resolve source handles or mutate claims.');
  return lines.join('\n');
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
  applyActivationFile,
  applyRollbackFile,
  buildDesiredSourceAddressableMemory,
  buildRollbackSourceAddressableMemory,
  createLiveActivationPlan,
  previewActivation,
  previewRollback,
  renderOperatorSummary,
  setContinuitySourceAddressableMemory,
  validateLiveConfig
};
