const CLAIM_SOURCE_FLAGS = Object.freeze({
  handoff: 'createClaimsFromHandoffs',
  summary: 'createClaimsFromSummaries',
  digest: 'createClaimsFromDigests'
});

const SOURCE_NAMES = Object.freeze(Object.keys(CLAIM_SOURCE_FLAGS));

/**
 * Build 2 record-mode proof planning helpers.
 *
 * Source-only and runtime-inert: this module does not read or write OpenClaw
 * config, restart Gateway, persist claims, resolve sources, or inject prompt
 * context. It only creates/validates a narrow operator-owned config shape for a
 * later controlled proof.
 */
function createRecordModeProofPlan(input = {}) {
  const source = normalizeSource(input.source || 'handoff');
  const sourceFlag = CLAIM_SOURCE_FLAGS[source];
  const agentId = input.agentId || 'trail-guide';
  const now = input.now || new Date().toISOString();
  const desiredConfig = createDesiredConfig(source);
  const rollbackConfig = createRollbackConfig();
  const validation = validateRecordModeProofConfig({ sourceAddressableMemory: desiredConfig }, { source });

  return {
    ok: validation.ok,
    agentId,
    createdAt: now,
    source,
    desiredConfig: { sourceAddressableMemory: desiredConfig },
    rollbackConfig: { sourceAddressableMemory: rollbackConfig },
    checks: [
      'snapshot current continuity config before applying operator-owned patch',
      'apply only the desired sourceAddressableMemory override',
      'perform one controlled candidate-producing event for the selected source',
      'verify ClaimStore stats and persisted candidate ids',
      'rollback to disabled/default-inert sourceAddressableMemory config',
      'verify live config is inert and no unexpected claim residue remains'
    ],
    safetyProperties: [
      'operator-owned config mutation only',
      'record mode bounded to one candidate source',
      'persistClaimCandidates is the only persistence switch enabled',
      'injectMode remains none',
      'no prompt injection',
      'no source hydration or source text display',
      'rollback config disables source-addressable memory and persistence'
    ],
    validation
  };
}

function validateRecordModeProofConfig(config = {}, options = {}) {
  const source = normalizeSource(options.source || 'handoff');
  const sourceFlag = CLAIM_SOURCE_FLAGS[source];
  const sourceConfig = config.sourceAddressableMemory || {};
  const errors = [];

  if (sourceConfig.enabled !== true) errors.push('sourceAddressableMemory.enabled must be true for proof config');
  if (sourceConfig.mode !== 'record') errors.push('sourceAddressableMemory.mode must be record');
  if (sourceConfig.storage !== undefined && sourceConfig.storage !== 'sqlite') errors.push('sourceAddressableMemory.storage must be sqlite when specified');
  if (sourceConfig.injectMode !== 'none') errors.push('sourceAddressableMemory.injectMode must remain none');
  if (sourceConfig.persistClaimCandidates !== true) errors.push('sourceAddressableMemory.persistClaimCandidates must be true for proof config');

  const enabledSources = SOURCE_NAMES.filter((name) => sourceConfig[CLAIM_SOURCE_FLAGS[name]] === true);
  if (enabledSources.length !== 1 || enabledSources[0] !== source) {
    errors.push(`exactly one candidate source must be enabled: ${sourceFlag}`);
  }

  if (sourceConfig.resolveOnDemand !== undefined && sourceConfig.resolveOnDemand !== true) {
    errors.push('sourceAddressableMemory.resolveOnDemand must not be disabled for diagnostics');
  }

  if (sourceConfig.injectMode && sourceConfig.injectMode !== 'none') {
    errors.push('sourceAddressableMemory inject modes other than none are outside this proof');
  }

  return { ok: errors.length === 0, errors, source };
}

function validateRollbackConfig(config = {}) {
  const sourceConfig = config.sourceAddressableMemory || {};
  const errors = [];
  if (sourceConfig.enabled !== false) errors.push('rollback must set sourceAddressableMemory.enabled=false');
  if (sourceConfig.mode !== 'observe') errors.push('rollback must restore observe mode');
  if (sourceConfig.injectMode !== 'none') errors.push('rollback must keep injectMode=none');
  if (sourceConfig.persistClaimCandidates !== false) errors.push('rollback must disable candidate persistence');
  for (const flag of Object.values(CLAIM_SOURCE_FLAGS)) {
    if (sourceConfig[flag] !== false) errors.push(`rollback must disable ${flag}`);
  }
  return { ok: errors.length === 0, errors };
}

function createDesiredConfig(source) {
  const config = {
    enabled: true,
    mode: 'record',
    storage: 'sqlite',
    injectMode: 'none',
    createClaimsFromHandoffs: false,
    createClaimsFromSummaries: false,
    createClaimsFromDigests: false,
    persistClaimCandidates: true,
    resolveOnDemand: true
  };
  config[CLAIM_SOURCE_FLAGS[source]] = true;
  return config;
}

function createRollbackConfig() {
  return {
    enabled: false,
    mode: 'observe',
    storage: 'sqlite',
    injectMode: 'none',
    createClaimsFromHandoffs: false,
    createClaimsFromSummaries: false,
    createClaimsFromDigests: false,
    persistClaimCandidates: false,
    resolveOnDemand: true
  };
}

function renderRecordModeProofPlan(plan = {}, options = {}) {
  if (!plan || typeof plan !== 'object') throw new Error('record-mode proof plan is required');
  const format = options.format || 'markdown';
  if (format === 'json') return JSON.stringify(toDryRunObject(plan), null, 2);
  if (format !== 'markdown') throw new Error(`unsupported proof plan render format: ${format}`);

  const lines = [];
  lines.push(`# Record Mode Proof Plan — ${plan.source || 'unknown'}`);
  lines.push('');
  lines.push(`- Agent: ${plan.agentId || 'unknown'}`);
  lines.push(`- Created: ${plan.createdAt || 'unknown'}`);
  lines.push(`- Valid: ${plan.ok === true ? 'yes' : 'no'}`);
  if (plan.validation?.errors?.length) {
    lines.push(`- Validation errors: ${plan.validation.errors.join('; ')}`);
  }
  lines.push('');
  lines.push('## Desired Config');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(plan.desiredConfig || {}, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Rollback Config');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(plan.rollbackConfig || {}, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Checks');
  for (const check of plan.checks || []) lines.push(`- [ ] ${check}`);
  lines.push('');
  lines.push('## Safety Properties');
  for (const item of plan.safetyProperties || []) lines.push(`- ${item}`);
  lines.push('');
  lines.push('## Boundaries');
  lines.push('- This renderer does not apply config.');
  lines.push('- This renderer does not restart Gateway.');
  lines.push('- This renderer does not persist claims.');
  lines.push('- This renderer does not resolve source handles or expose source text.');
  return lines.join('\n');
}

function toDryRunObject(plan = {}) {
  return {
    ok: plan.ok === true,
    agentId: plan.agentId || null,
    createdAt: plan.createdAt || null,
    source: plan.source || null,
    desiredConfig: plan.desiredConfig || {},
    rollbackConfig: plan.rollbackConfig || {},
    checks: plan.checks || [],
    safetyProperties: plan.safetyProperties || [],
    validation: plan.validation || { ok: false, errors: ['missing validation'] },
    boundaries: [
      'no config apply',
      'no gateway restart',
      'no claim persistence',
      'no source resolution',
      'no source text display'
    ]
  };
}

function normalizeSource(source) {
  if (!CLAIM_SOURCE_FLAGS[source]) {
    throw new Error(`unsupported proof source: ${source}. Use: ${SOURCE_NAMES.join(', ')}`);
  }
  return source;
}

module.exports = {
  CLAIM_SOURCE_FLAGS,
  createRecordModeProofPlan,
  renderRecordModeProofPlan,
  validateRecordModeProofConfig,
  validateRollbackConfig
};
