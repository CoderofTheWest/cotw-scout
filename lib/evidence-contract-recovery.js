'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_RECOVERY_BUDGET = Object.freeze({
  maxRecoveryActions: 3,
  maxRecoveryWallClockMs: 45_000,
});

function buildEvidenceContract(prompt, options = {}) {
  const text = String(prompt || '');
  const targets = [];
  const paths = extractPathTargets(text);
  for (const filePath of paths) {
    targets.push({
      id: `path:${normalizePath(filePath)}`,
      kind: 'path',
      label: normalizePath(filePath),
      path: normalizePath(filePath),
      required: true,
      reason: 'The user request names this path as evidence to inspect.',
    });
  }

  if (requiresVerificationTarget(text)) {
    targets.push({
      id: 'verification:tests',
      kind: 'verification',
      label: 'requested test/build verification',
      required: true,
      toolHints: ['exec', 'process'],
      reason: 'The user request asks for test/build/lint verification.',
    });
  }

  if (requiresFreshObservation(text)) {
    targets.push({
      id: 'fresh:observation',
      kind: 'fresh_observation',
      label: 'fresh receipt-backed observation',
      required: true,
      reason: 'The request asks for current/live/verified state; memory alone is not sufficient.',
    });
  }

  if (options.forceToolEvidence && targets.length === 0) {
    targets.push({
      id: 'tool:observation',
      kind: 'tool_observation',
      label: 'receipt-backed tool observation',
      required: true,
      reason: 'Foreground tool use created a completion obligation.',
    });
  }

  return {
    kind: 'openclaw_evidence_contract',
    version: 1,
    targets: dedupeTargets(targets),
  };
}

function evaluateEvidenceContract(contract, observations = []) {
  const observed = Array.isArray(observations) ? observations : [];
  const targets = (contract?.targets || []).map((target) => evaluateTarget(target, observed));
  return {
    kind: 'openclaw_evidence_coverage',
    version: 1,
    targets,
    missing: targets.filter((target) => target.status === 'missing'),
    partial: targets.filter((target) => target.status === 'partial'),
    failed: targets.filter((target) => target.status === 'failed'),
    observed: targets.filter((target) => target.status === 'observed'),
    ok: targets.every((target) => target.status === 'observed'),
  };
}

function nextEvidenceAction(coverage) {
  const target = coverage?.missing?.[0] || coverage?.partial?.[0] || coverage?.failed?.[0];
  if (!target) return null;

  if (target.status === 'failed') {
    return null;
  }

  if (target.kind === 'fresh_observation' || target.kind === 'tool_observation') {
    return {
      tool: 'session_status',
      reason: 'collect a fresh receipt-backed observation before finalizing',
    };
  }

  if (target.kind === 'verification') {
    return {
      tool: 'exec',
      command: 'npm test',
      reason: 'run requested verification before finalizing',
    };
  }

  if (target.kind === 'path' && target.path) {
    const action = {
      tool: 'read',
      path: target.path,
      reason: 'inspect required path evidence before finalizing',
    };
    if (target.status === 'partial') {
      if (hasFiniteValue(target.nextOffset)) action.offset = Number(target.nextOffset);
      if (hasFiniteValue(target.nextLine)) action.startLine = Number(target.nextLine);
      if (target.resultId) action.resultId = target.resultId;
    }
    return action;
  }

  return null;
}

function createRecoveryPacket(options = {}) {
  const {
    prompt = '',
    requestId = null,
    sessionId = null,
    evidenceContract = buildEvidenceContract(prompt),
    coverage = evaluateEvidenceContract(evidenceContract, []),
    observations = [],
    recoveryIndex = 1,
    budget = DEFAULT_RECOVERY_BUDGET,
    workScope = {},
    now = new Date().toISOString(),
  } = options;
  const failureClass = classifyFailure(coverage, observations);
  const nextAction = nextEvidenceAction(coverage);
  const currentState = summarizeCurrentState(observations, coverage);
  const packet = {
    kind: 'openclaw_evidence_recovery_packet',
    version: 1,
    recoveryIndex,
    createdAt: now,
    originalTask: {
      promptHash: hashText(prompt),
      promptPreview: preview(prompt, 600),
      requestId,
      sessionId,
      successContract: summarizeContract(evidenceContract),
      requiredOutputs: inferRequiredOutputs(prompt),
      nonGoals: inferNonGoals(prompt),
    },
    workScope: summarizeWorkScope(workScope),
    evidenceContract: summarizeContract(evidenceContract),
    failure: {
      failureClass,
      blockedClaim: blockedClaimFor(failureClass),
      reason: failureReasonFor(failureClass, coverage),
    },
    currentState,
    coverage,
    observationReceipts: observations.map(extractReceipt).filter(Boolean),
    nextSmallestAction: nextAction,
    stopCondition: nextAction ? stopConditionFor(nextAction, coverage) : 'no safe next evidence action is available',
    budgetRemaining: budget,
    principleBinding: {
      courage: 'name the interruption directly and keep moving from receipts',
      word: 'resume only inside the prior scoped task and do not overclaim evidence',
      brand: 'finish the handoff the user asked for using the next smallest safe action',
    },
  };
  return {
    ...packet,
    packetHash: hashText(stableJson(packet)),
  };
}

function buildRecoveryAttempt(options = {}) {
  const {
    prompt = '',
    observations = [],
    requestId = null,
    sessionId = null,
    forceToolEvidence = false,
    budget = DEFAULT_RECOVERY_BUDGET,
  } = options;
  const evidenceContract = options.evidenceContract || buildEvidenceContract(prompt, { forceToolEvidence });
  const coverage = evaluateEvidenceContract(evidenceContract, observations);
  if (coverage.ok || evidenceContract.targets.length === 0) {
    return {
      attempted: false,
      resumable: false,
      failureClass: 'complete',
      evidenceContract,
      coverage,
      packet: null,
      nextAction: null,
      recoveryObservation: null,
      recoveryResult: null,
      coverageAfterRecovery: coverage,
    };
  }
  const packet = createRecoveryPacket({
    prompt,
    requestId,
    sessionId,
    evidenceContract,
    coverage,
    observations,
    recoveryIndex: 1,
    budget,
    workScope: options.workScope,
  });
  return {
    attempted: true,
    resumable: Boolean(packet.nextSmallestAction),
    failureClass: packet.failure.failureClass,
    evidenceContract,
    coverage,
    packet,
    nextAction: packet.nextSmallestAction,
    recoveryObservation: null,
    recoveryResult: null,
    coverageAfterRecovery: coverage,
  };
}

function runRecoveryStep(options = {}) {
  const {
    prompt = '',
    observations = [],
    requestId = null,
    sessionId = null,
    forceToolEvidence = false,
    budget = DEFAULT_RECOVERY_BUDGET,
    executorOptions = {},
  } = options;
  const attempt = buildRecoveryAttempt({
    prompt,
    observations,
    requestId,
    sessionId,
    forceToolEvidence,
    budget,
    evidenceContract: options.evidenceContract,
    workScope: options.workScope,
  });
  if (!attempt.attempted || !attempt.nextAction) return attempt;
  const recoveryResult = executeRecoveryAction(attempt.nextAction, executorOptions);
  const recoveryObservation = {
    action: attempt.nextAction,
    result: recoveryResult,
    recovery: true,
    recoveryPacket: {
      packetHash: attempt.packet?.packetHash,
      failureClass: attempt.failureClass,
    },
  };
  const nextObservations = [...observations, recoveryObservation];
  const coverageAfterRecovery = evaluateEvidenceContract(attempt.evidenceContract, nextObservations);
  return {
    ...attempt,
    recoveryObservation,
    recoveryResult,
    coverageAfterRecovery,
    recovered: coverageAfterRecovery.ok,
  };
}

function executeRecoveryAction(action, options = {}) {
  const now = options.now || new Date().toISOString();
  if (!action?.tool) return failedRecoveryResult(action, 'missing recovery action', now);
  if (action.tool === 'read') return executeReadRecoveryAction(action, options, now);
  if (action.tool === 'session_status') {
    const output = stableJson({
      ok: true,
      observedAt: now,
      source: 'main_process_evidence_recovery',
      note: 'Fresh runtime-side observation recorded; no external state was mutated.',
    });
    return receiptResult({ ok: true, output, now, tool: action.tool });
  }
  return failedRecoveryResult(action, `recovery action ${action.tool} is not supported by the in-process evidence gate`, now, 'unsupported_recovery_action');
}

function executeReadRecoveryAction(action, options, now) {
  const maxOutput = Number.isFinite(Number(options.maxOutput)) ? Math.max(1, Number(options.maxOutput)) : 12000;
  const roots = allowedRecoveryRoots(options);
  const resolved = resolveAllowedReadPath(action.path, roots);
  if (!resolved.ok) return failedRecoveryResult(action, resolved.error, now, 'blocked_path');
  try {
    const text = fs.readFileSync(resolved.path, 'utf8');
    const offset = hasFiniteValue(action.offset) ? Number(action.offset) : 0;
    const output = text.slice(offset, offset + maxOutput);
    const nextOffset = offset + output.length < text.length ? offset + output.length : null;
    return receiptResult({
      ok: true,
      now,
      tool: action.tool,
      path: action.path,
      resolvedPath: resolved.path,
      output,
      offset,
      partial: offset > 0 || nextOffset !== null,
      truncated: nextOffset !== null,
      nextOffset,
      totalChars: text.length,
    });
  } catch (err) {
    return failedRecoveryResult(action, err.message, now, 'read_failed');
  }
}

function allowedRecoveryRoots(options = {}) {
  const roots = [];
  for (const candidate of [options.cwd, options.workspacePath, ...(Array.isArray(options.allowedRoots) ? options.allowedRoots : [])]) {
    if (!candidate) continue;
    try { roots.push(fs.realpathSync(candidate)); } catch { /* skip unavailable root */ }
  }
  return [...new Set(roots)];
}

function resolveAllowedReadPath(targetPath, roots) {
  if (!targetPath) return { ok: false, error: 'read recovery requires a path' };
  if (!roots.length) return { ok: false, error: 'read recovery has no allowed roots' };
  const candidates = path.isAbsolute(targetPath)
    ? [targetPath]
    : roots.map((root) => path.join(root, targetPath));
  for (const candidate of candidates) {
    try {
      const real = fs.realpathSync(candidate);
      if (roots.some((root) => real === root || real.startsWith(`${root}${path.sep}`))) return { ok: true, path: real };
    } catch { /* try next candidate */ }
  }
  return { ok: false, error: 'read recovery path is missing or outside allowed roots' };
}

function receiptResult(fields) {
  const safe = { ...fields };
  const receiptPayload = {
    ok: safe.ok,
    tool: safe.tool,
    path: safe.path,
    offset: safe.offset,
    nextOffset: safe.nextOffset,
    totalChars: safe.totalChars,
    observedAt: safe.now,
    outputHash: safe.output ? hashText(safe.output) : null,
  };
  safe.receipt = { event_hash: hashText(stableJson(receiptPayload)), createdAt: safe.now };
  return safe;
}

function failedRecoveryResult(action, error, now, code = 'recovery_failed') {
  return receiptResult({
    ok: false,
    now,
    tool: action?.tool || null,
    path: action?.path || null,
    error,
    code,
  });
}

function classifyFailure(coverage, observations = []) {
  if (coverage?.ok) return 'complete';
  if (coverage?.missing?.length) return 'missing_evidence';
  if (coverage?.partial?.length) return 'partial_evidence';
  if (coverage?.failed?.length) return 'tool_error_recoverable';
  if (observations.some((observation) => observation?.actionError)) return 'malformed_tool_action';
  if (observations.some((observation) => observation?.result?.ok === false)) return 'tool_error_recoverable';
  return 'unsupported_final_claim';
}

function summarizeCurrentState(observations = [], coverage = null) {
  const list = Array.isArray(observations) ? observations : [];
  const last = list.at(-1) || null;
  return {
    coverage,
    observationCount: list.length,
    toolReceipts: list.map(extractReceipt).filter(Boolean),
    lastAction: summarizeAction(last?.action),
    lastResultStatus: last?.result?.ok === false ? 'error' : list.length ? 'ok' : 'none',
  };
}

function summarizeWorkScope(workScope = {}) {
  return {
    scopeKind: workScope.scopeKind || 'foreground_tool_turn',
    workingDirectory: workScope.workingDirectory || workScope.cwd || null,
    workspacePath: workScope.workspacePath || null,
    touchedFiles: Array.isArray(workScope.touchedFiles) ? workScope.touchedFiles.slice(0, 20) : [],
    currentPlan: Array.isArray(workScope.currentPlan) ? workScope.currentPlan.slice(0, 10) : [],
    boundaries: Array.isArray(workScope.boundaries) ? workScope.boundaries.slice(0, 12) : [],
    allowedRecoveryTools: Array.isArray(workScope.allowedRecoveryTools) ? workScope.allowedRecoveryTools.slice(0, 12) : [],
  };
}

function inferRequiredOutputs(prompt) {
  const text = String(prompt || '');
  const outputs = [];
  if (/\b(PRD|spec|implementation)\b/i.test(text)) outputs.push('implementation/spec result');
  if (/\b(test|tests|verify|verification|lint|build)\b/i.test(text)) outputs.push('verification receipts');
  if (/\b(explain|recommend|identify|distinguish)\b/i.test(text)) outputs.push('plain-language answer grounded in observed evidence');
  return outputs.length ? outputs : ['user-visible handoff grounded in observed evidence'];
}

function inferNonGoals(prompt) {
  const nonGoals = [
    'do not fabricate unobserved results',
    'do not promote partial evidence as complete',
    'do not restart, mutate config, or expand authority unless explicitly authorized',
  ];
  if (/\b(no restart|do not restart|without restart)\b/i.test(String(prompt || ''))) nonGoals.push('do not restart as part of recovery');
  return nonGoals;
}

function blockedClaimFor(failureClass) {
  if (failureClass === 'missing_evidence') return 'all required evidence has been observed';
  if (failureClass === 'partial_evidence') return 'all required evidence has been fully observed';
  if (failureClass === 'malformed_tool_action') return 'the next tool action is valid';
  if (failureClass === 'tool_error_recoverable') return 'tool execution succeeded';
  return 'the final answer is fully supported';
}

function summarizeAction(action) {
  if (!action) return null;
  return {
    tool: action.tool || null,
    path: action.path || null,
    command: action.command || null,
    offset: action.offset ?? null,
    startLine: action.startLine ?? null,
  };
}

function renderRecoveryFallbackDetails(attempt) {
  if (!attempt?.attempted) return '';
  const remaining = [
    ...(attempt.coverage?.missing || []),
    ...(attempt.coverage?.partial || []),
    ...(attempt.coverage?.failed || []),
  ];
  const targetText = remaining.slice(0, 4).map((target) => {
    const suffix = target.nextOffset !== null && target.nextOffset !== undefined
      ? ` nextOffset=${target.nextOffset}`
      : target.nextLine !== null && target.nextLine !== undefined
        ? ` nextLine=${target.nextLine}`
        : '';
    return `${target.label || target.id}: ${target.status}${suffix}`;
  }).join('; ');
  const actionText = attempt.nextAction
    ? ` Next receipt-producing action: ${describeAction(attempt.nextAction)}.`
    : ' No safe next receipt-producing action was available.';
  return `\n\nRecovery gate: ${attempt.failureClass}.${targetText ? ` Remaining evidence: ${targetText}.` : ''}${actionText}`;
}

function observationFromToolEvent(event) {
  const phase = String(event?.phase || '').toLowerCase();
  const status = ['failed', 'error'].includes(phase) ? 'failed' : 'ok';
  const name = String(event?.name || '').trim();
  return {
    action: {
      tool: name,
      path: event?.path || event?.args?.path || event?.args?.file || undefined,
    },
    result: {
      ok: status === 'ok',
      path: event?.path || event?.result?.path || event?.args?.path || undefined,
      partial: event?.partial ?? event?.result?.partial,
      truncated: event?.truncated ?? event?.result?.truncated,
      nextOffset: event?.nextOffset ?? event?.result?.nextOffset,
      nextLine: event?.nextLine ?? event?.result?.nextLine,
      totalChars: event?.totalChars ?? event?.result?.totalChars,
      totalLines: event?.totalLines ?? event?.result?.totalLines,
      receipt: event?.receipt || event?.result?.receipt,
      toolResultId: event?.toolResultId || event?.resultId || event?.result?.toolResultId,
    },
    event,
  };
}

function evaluateTarget(target, observations) {
  const matches = observations.filter((observation) => observationMatchesTarget(observation, target));
  const successful = matches.filter((observation) => observation?.result?.ok !== false);
  const failed = matches.filter((observation) => observation?.result?.ok === false);
  const completeRead = hasCompleteReadCoverage(successful);
  const partial = successful.length > 0 && !completeRead && successful.some(isPartialObservation);
  const lastPartial = [...successful].reverse().find(isPartialObservation);
  const status = successful.length === 0
    ? (failed.length ? 'failed' : 'missing')
    : partial ? 'partial' : 'observed';
  return {
    ...target,
    status,
    observed: status === 'observed',
    partial: status === 'partial',
    nextOffset: status === 'partial' ? lastPartial?.result?.nextOffset ?? null : null,
    nextLine: status === 'partial' ? lastPartial?.result?.nextLine ?? null : null,
    totalChars: lastPartial?.result?.totalChars ?? successful.at(-1)?.result?.totalChars ?? null,
    totalLines: lastPartial?.result?.totalLines ?? successful.at(-1)?.result?.totalLines ?? null,
    resultId: lastPartial?.result?.toolResultId ?? successful.at(-1)?.result?.toolResultId ?? null,
    receipts: successful.map(extractReceipt).filter(Boolean),
  };
}

function observationMatchesTarget(observation, target) {
  if (!observation) return false;
  if (target.kind === 'fresh_observation') return Boolean(observation.result?.ok !== false && (extractReceipt(observation) || observation.action?.tool));
  if (target.kind === 'tool_observation') return Boolean(observation.result?.ok !== false && observation.action?.tool);
  if (target.kind === 'verification') {
    const tool = String(observation.action?.tool || '').toLowerCase();
    const command = String(observation.action?.command || observation.result?.command || '').toLowerCase();
    return ['exec', 'process'].includes(tool) || /\b(test|lint|build|check)\b/.test(command);
  }
  if (target.kind === 'path') {
    const expected = normalizePath(target.path);
    const candidates = [
      observation.action?.path,
      observation.result?.path,
      observation.action?.file,
      observation.result?.file,
    ].filter(Boolean).map(normalizePath);
    return candidates.some((candidate) => candidate === expected || candidate.endsWith(`/${expected}`));
  }
  return false;
}

function hasCompleteReadCoverage(observations) {
  if (!observations.length) return false;
  if (observations.some((observation) => observation.result?.partial !== true && observation.result?.truncated !== true && !Number.isFinite(Number(observation.result?.totalChars)))) return true;
  const reads = observations
    .filter((observation) => Number.isFinite(Number(observation.result?.totalChars)))
    .map((observation) => {
      const offset = Number(observation.action?.offset ?? observation.result?.offset ?? 0);
      const total = Number(observation.result.totalChars);
      const nextOffset = observation.result.nextOffset === null || observation.result.nextOffset === undefined
        ? total
        : Number(observation.result.nextOffset);
      return { offset, end: nextOffset, total };
    })
    .sort((a, b) => a.offset - b.offset);
  if (!reads.length) return observations.some((observation) => !isPartialObservation(observation));
  const total = reads[0].total;
  let cursor = 0;
  for (const read of reads) {
    if (read.offset > cursor) return false;
    cursor = Math.max(cursor, read.end);
    if (cursor >= total) return true;
  }
  return false;
}

function isPartialObservation(observation) {
  return observation?.result?.partial === true
    || observation?.result?.truncated === true
    || hasFiniteValue(observation?.result?.nextOffset)
    || hasFiniteValue(observation?.result?.nextLine);
}

function hasFiniteValue(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function extractPathTargets(text) {
  const found = new Set();
  const source = String(text || '');
  const codeMatches = source.matchAll(/`([^`]+)`/g);
  for (const match of codeMatches) {
    const candidate = match[1].trim();
    if (looksLikePath(candidate)) found.add(normalizePath(candidate));
  }
  const pathMatches = source.matchAll(/(?:^|[\s(:])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+\.(?:js|ts|tsx|jsx|json|md|mjs|cjs|yaml|yml|txt|html|css))(?:$|[\s),.:])/g);
  for (const match of pathMatches) {
    const candidate = match[1].trim();
    if (looksLikePath(candidate)) found.add(normalizePath(candidate));
  }
  return [...found];
}

function looksLikePath(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 240) return false;
  if (/\s/.test(text)) return false;
  if (/^(https?:|file:)/i.test(text)) return false;
  return text.includes('/') || /\.(js|ts|tsx|jsx|json|md|mjs|cjs|yaml|yml|txt|html|css)$/i.test(text);
}

function requiresFreshObservation(text) {
  return /\b(current|currently|live|running|registered|loaded|right now|now|verified|verify|check|inspect|read|status|healthy|working|done|tests? (?:pass|passed|green))\b/i.test(String(text || ''));
}

function requiresVerificationTarget(text) {
  return /\b(test|tests|lint|build|typecheck|verification|verify)\b/i.test(String(text || ''));
}

function dedupeTargets(targets) {
  const seen = new Set();
  const out = [];
  for (const target of targets) {
    if (seen.has(target.id)) continue;
    seen.add(target.id);
    out.push(target);
  }
  return out;
}

function normalizePath(value) {
  return String(value || '').trim().replaceAll(path.sep, '/').replace(/^\.\//, '');
}

function summarizeContract(contract) {
  return {
    kind: contract?.kind || 'openclaw_evidence_contract',
    version: contract?.version || 1,
    targetCount: contract?.targets?.length || 0,
    targets: (contract?.targets || []).map((target) => ({
      id: target.id,
      kind: target.kind,
      label: target.label,
      required: target.required === true,
    })),
  };
}

function failureReasonFor(failureClass, coverage) {
  if (failureClass === 'missing_evidence') return `missing targets: ${coverage.missing.map((target) => target.label).join(', ')}`;
  if (failureClass === 'partial_evidence') return `partial targets: ${coverage.partial.map((target) => `${target.label}${target.nextOffset !== null && target.nextOffset !== undefined ? ` nextOffset=${target.nextOffset}` : ''}`).join(', ')}`;
  if (failureClass === 'tool_error_recoverable') return `failed targets: ${coverage.failed.map((target) => target.label).join(', ')}`;
  return 'current observations do not support finalization';
}

function stopConditionFor(action) {
  if (!action) return 'no safe next action';
  if (action.offset !== undefined) return `${action.path || action.resultId || 'target'} observed through next offset ${action.offset}`;
  if (action.startLine !== undefined) return `${action.path || action.resultId || 'target'} observed from line ${action.startLine}`;
  return `${describeAction(action)} succeeds with a receipt`;
}

function describeAction(action) {
  if (!action) return 'none';
  if (action.tool === 'read') return `read ${action.path}${action.offset !== undefined ? ` at offset ${action.offset}` : ''}${action.startLine !== undefined ? ` from line ${action.startLine}` : ''}`;
  if (action.tool === 'exec') return `run ${action.command || 'verification command'}`;
  return action.tool || 'unknown action';
}

function extractReceipt(observation) {
  return observation?.result?.receipt?.event_hash
    || observation?.result?.receipt
    || observation?.receipt?.event_hash
    || observation?.receipt
    || null;
}

function preview(text, max) {
  const value = String(text || '');
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function hashText(text) {
  return `sha256:${crypto.createHash('sha256').update(String(text || '')).digest('hex')}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

module.exports = {
  DEFAULT_RECOVERY_BUDGET,
  buildEvidenceContract,
  buildRecoveryAttempt,
  classifyFailure,
  createRecoveryPacket,
  evaluateEvidenceContract,
  executeRecoveryAction,
  extractPathTargets,
  nextEvidenceAction,
  observationFromToolEvent,
  renderRecoveryFallbackDetails,
  requiresFreshObservation,
  requiresVerificationTarget,
  runRecoveryStep,
};
