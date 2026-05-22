const fs = require('fs');
const path = require('path');
const {
  createRecordModeProofPlan,
  validateRecordModeProofConfig,
  validateRollbackConfig
} = require('./record-mode-proof-plan');

const CONTINUITY_CONFIG_PATH = Object.freeze(['plugins', 'entries', 'continuity', 'config']);

/**
 * Operator-owned Build 2 record-mode activation helpers.
 *
 * This module is intentionally file-oriented rather than Gateway-tool-oriented:
 * the Gateway config API protects sourceAddressableMemory runtime switches from
 * agent-driven mutation. These helpers make the human/operator path repeatable,
 * auditable, backed up, and rollbackable. Tests use temporary config files only.
 */
function createActivationPlan(input = {}) {
  const source = input.source || 'handoff';
  const proof = createRecordModeProofPlan({
    agentId: input.agentId || 'trail-guide',
    source,
    now: input.now
  });
  const desired = proof.desiredConfig.sourceAddressableMemory;
  const rollback = proof.rollbackConfig.sourceAddressableMemory;
  return {
    ok: proof.ok === true,
    source,
    desired,
    rollback,
    warnings: [
      'operator-owned file mutation; do not run casually',
      'snapshot and backup before apply',
      'restart or hot-reload may be required outside this script',
      'watch claims before enabling downstream consumers'
    ],
    proof
  };
}

function readConfigFile(configPath) {
  if (!configPath) throw new Error('--config is required');
  const raw = fs.readFileSync(configPath, 'utf8');
  return { raw, parsed: JSON.parse(raw) };
}

function writeConfigFile(configPath, config) {
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function getContinuityConfig(config) {
  let cursor = config;
  for (const key of CONTINUITY_CONFIG_PATH) {
    if (!cursor || typeof cursor !== 'object') return {};
    cursor = cursor[key];
  }
  return cursor && typeof cursor === 'object' ? cursor : {};
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

function previewActivation(config, input = {}) {
  const plan = createActivationPlan(input);
  const nextConfig = setContinuitySourceAddressableMemory(config, plan.desired);
  const validation = validateRecordModeProofConfig({ sourceAddressableMemory: getContinuityConfig(nextConfig).sourceAddressableMemory }, { source: plan.source });
  return {
    ok: validation.ok,
    source: plan.source,
    current: getContinuityConfig(config).sourceAddressableMemory || null,
    desired: plan.desired,
    rollback: plan.rollback,
    validation,
    nextConfig
  };
}

function previewRollback(config) {
  const plan = createActivationPlan({ source: 'handoff' });
  const nextConfig = setContinuitySourceAddressableMemory(config, plan.rollback);
  const validation = validateRollbackConfig({ sourceAddressableMemory: getContinuityConfig(nextConfig).sourceAddressableMemory });
  return {
    ok: validation.ok,
    current: getContinuityConfig(config).sourceAddressableMemory || null,
    rollback: plan.rollback,
    validation,
    nextConfig
  };
}

function applyActivationFile(configPath, input = {}) {
  if (input.confirm !== true) throw new Error('refusing to apply without explicit confirm=true');
  const { parsed } = readConfigFile(configPath);
  const preview = previewActivation(parsed, input);
  if (!preview.ok) throw new Error(`activation config failed validation: ${preview.validation.errors.join('; ')}`);
  const backupPath = writeBackup(configPath, parsed, input);
  writeConfigFile(configPath, preview.nextConfig);
  return { ok: true, action: 'apply', source: preview.source, configPath, backupPath, desired: preview.desired };
}

function applyRollbackFile(configPath, input = {}) {
  if (input.confirm !== true) throw new Error('refusing to rollback without explicit confirm=true');
  const { parsed } = readConfigFile(configPath);
  const preview = previewRollback(parsed);
  if (!preview.ok) throw new Error(`rollback config failed validation: ${preview.validation.errors.join('; ')}`);
  const backupPath = writeBackup(configPath, parsed, input);
  writeConfigFile(configPath, preview.nextConfig);
  return { ok: true, action: 'rollback', configPath, backupPath, rollback: preview.rollback };
}

function writeBackup(configPath, config, input = {}) {
  const stamp = safeStamp(input.now || new Date().toISOString());
  const backupDir = input.backupDir || path.dirname(configPath);
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `${path.basename(configPath)}.${stamp}.bak`);
  fs.writeFileSync(backupPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return backupPath;
}

function renderOperatorSummary(summary = {}, options = {}) {
  const format = options.format || 'markdown';
  if (format === 'json') return JSON.stringify(stripConfig(summary), null, 2);
  if (format !== 'markdown') throw new Error(`unsupported operator summary format: ${format}`);
  const lines = [];
  lines.push(`# Build 2 Record-Mode Operator ${summary.action || 'Plan'}`);
  lines.push('');
  lines.push(`- OK: ${summary.ok === true ? 'yes' : 'no'}`);
  if (summary.source) lines.push(`- Source: ${summary.source}`);
  if (summary.configPath) lines.push(`- Config: ${summary.configPath}`);
  if (summary.backupPath) lines.push(`- Backup: ${summary.backupPath}`);
  if (summary.validation?.errors?.length) lines.push(`- Errors: ${summary.validation.errors.join('; ')}`);
  lines.push('');
  lines.push('## Desired Source-Addressable Memory Config');
  lines.push('```json');
  lines.push(JSON.stringify(summary.desired || summary.rollback || {}, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Boundaries');
  lines.push('- Handoff source only for activation.');
  lines.push('- Prompt injection remains disabled via injectMode=none.');
  lines.push('- Summaries and digests remain disabled.');
  lines.push('- Script does not restart Gateway.');
  lines.push('- Rollback writes disabled/observe config.');
  return lines.join('\n');
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
  CONTINUITY_CONFIG_PATH,
  applyActivationFile,
  applyRollbackFile,
  createActivationPlan,
  getContinuityConfig,
  previewActivation,
  previewRollback,
  readConfigFile,
  renderOperatorSummary,
  setContinuitySourceAddressableMemory,
  writeConfigFile
};
