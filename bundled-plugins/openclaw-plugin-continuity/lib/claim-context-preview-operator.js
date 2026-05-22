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
 * Operator-owned Build 3 claim-context preview activation helpers.
 *
 * This is deliberately diagnostic-only. It may enable source-addressable memory
 * in observe mode when it was previously disabled so ClaimStore can initialize,
 * but it must never enable prompt injection, source excerpts, source resolution,
 * persistence, or candidate generation by itself.
 */
function createPreviewActivationPlan(input = {}) {
  const maxClaims = normalizeMaxClaims(input.maxClaims);
  return {
    ok: true,
    desiredClaimContext: {
      enabled: true,
      mode: 'diagnostic',
      injectMode: 'none',
      maxClaims,
      includeSourceExcerpts: false
    },
    rollbackClaimContext: {
      enabled: false,
      mode: 'diagnostic',
      injectMode: 'none',
      maxClaims,
      includeSourceExcerpts: false
    },
    warnings: [
      'diagnostic preview only; do not treat as prompt injection',
      'injectMode must remain none',
      'source excerpts must remain hidden',
      'watch logs for counts/safety flags only',
      'restart or hot-reload may be required outside this script'
    ]
  };
}

function previewActivation(config, input = {}) {
  const plan = createPreviewActivationPlan(input);
  const current = getContinuityConfig(config).sourceAddressableMemory || null;
  const desired = buildDesiredSourceAddressableMemory(current, plan.desiredClaimContext);
  const validation = validatePreviewConfig({ sourceAddressableMemory: desired });
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
    maxClaims,
    includeSourceExcerpts: false
  });
  const validation = validatePreviewConfig({ sourceAddressableMemory: rollback }, { allowDisabledClaimContext: true });
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
  if (!preview.ok) throw new Error(`preview activation failed validation: ${preview.validation.errors.join('; ')}`);
  const backupPath = writeBackup(configPath, parsed, input);
  writeConfigFile(configPath, preview.nextConfig);
  return { ok: true, action: 'apply', configPath, backupPath, desired: preview.desired };
}

function applyRollbackFile(configPath, input = {}) {
  if (input.confirm !== true) throw new Error('refusing to rollback without explicit confirm=true');
  const { parsed } = readConfigFile(configPath);
  const preview = previewRollback(parsed, input);
  if (!preview.ok) throw new Error(`preview rollback failed validation: ${preview.validation.errors.join('; ')}`);
  const backupPath = writeBackup(configPath, parsed, input);
  writeConfigFile(configPath, preview.nextConfig);
  return { ok: true, action: 'rollback', configPath, backupPath, rollback: preview.rollback };
}

function buildDesiredSourceAddressableMemory(current, claimContext) {
  const existing = current && typeof current === 'object' ? cloneJson(current) : {};
  const mode = existing.mode === 'record' ? 'record' : 'observe';
  return {
    ...existing,
    enabled: true,
    mode,
    storage: existing.storage || 'sqlite',
    injectMode: 'none',
    createClaimsFromHandoffs: existing.createClaimsFromHandoffs === true && mode === 'record',
    createClaimsFromSummaries: existing.createClaimsFromSummaries === true && mode === 'record',
    createClaimsFromDigests: existing.createClaimsFromDigests === true && mode === 'record',
    persistClaimCandidates: existing.persistClaimCandidates === true && mode === 'record',
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

function validatePreviewConfig(config = {}, options = {}) {
  const errors = [];
  const sam = config.sourceAddressableMemory || {};
  const claimContext = sam.claimContext || {};
  const allowDisabledClaimContext = options.allowDisabledClaimContext === true;

  if (sam.injectMode !== undefined && sam.injectMode !== 'none') errors.push('sourceAddressableMemory.injectMode must be none');
  if (!allowDisabledClaimContext && sam.enabled !== true) errors.push('sourceAddressableMemory.enabled must be true for live preview diagnostics');
  if (!['observe', 'record'].includes(sam.mode || 'observe')) errors.push('sourceAddressableMemory.mode must be observe or record');
  if (!allowDisabledClaimContext && claimContext.enabled !== true) errors.push('claimContext.enabled must be true for preview activation');
  if (allowDisabledClaimContext && claimContext.enabled !== false) errors.push('claimContext.enabled must be false for rollback');
  if (claimContext.mode !== 'diagnostic') errors.push('claimContext.mode must be diagnostic');
  if (claimContext.injectMode !== 'none') errors.push('claimContext.injectMode must be none');
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
  const backupPath = path.join(backupDir, `${path.basename(configPath)}.claim-context-preview.${stamp}.bak`);
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
  lines.push(`# Build 3 Claim-Context Preview Operator ${summary.action || 'Plan'}`);
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
  lines.push('');
  lines.push('## Claim Context Preview');
  lines.push('```json');
  lines.push(JSON.stringify(claimContext, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Boundaries');
  lines.push('- Diagnostic preview only.');
  lines.push('- Prompt injection remains disabled via injectMode=none.');
  lines.push('- Source excerpts remain hidden.');
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
  createPreviewActivationPlan,
  previewActivation,
  previewRollback,
  renderOperatorSummary,
  setContinuitySourceAddressableMemory,
  validatePreviewConfig
};
