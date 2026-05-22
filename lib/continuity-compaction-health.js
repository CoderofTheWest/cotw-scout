'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_AGENT_ID = 'trail-guide';
const DEFAULT_TRANSCRIPT_WARN_BYTES = 20 * 1024 * 1024;

function expandHome(value) {
  if (typeof value !== 'string') return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function statFile(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function resolveOpenClawHome(options = {}) {
  return path.resolve(expandHome(options.openclawHome || process.env.OPENCLAW_HOME || '~/.openclaw-cotw'));
}

function resolveConfigPath(options = {}) {
  if (options.configPath) return path.resolve(expandHome(options.configPath));
  return path.join(resolveOpenClawHome(options), 'openclaw.json');
}

function resolveSessionsDir(options = {}) {
  if (options.sessionsDir) return path.resolve(expandHome(options.sessionsDir));
  const agentId = options.agentId || DEFAULT_AGENT_ID;
  return path.join(resolveOpenClawHome(options), 'agents', agentId, 'sessions');
}

function resolveSessionStorePath(options = {}) {
  if (options.sessionStorePath) return path.resolve(expandHome(options.sessionStorePath));
  return path.join(resolveSessionsDir(options), 'sessions.json');
}

function readSessionStore(options = {}) {
  const sessionStorePath = resolveSessionStorePath(options);
  const store = readJsonFile(sessionStorePath, {});
  return store && typeof store === 'object' && !Array.isArray(store) ? store : {};
}

function getAgentConfig(config, agentId = DEFAULT_AGENT_ID) {
  const defaults = config?.agents?.defaults || {};
  const list = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  const agent = list.find((entry) => entry && entry.id === agentId) || {};
  return { defaults, agent };
}

function getEffectiveAgentValue(config, agentId, key) {
  const { defaults, agent } = getAgentConfig(config, agentId);
  if (Object.prototype.hasOwnProperty.call(agent, key)) return { value: agent[key], source: `agents.list[${agentId}].${key}` };
  if (Object.prototype.hasOwnProperty.call(defaults, key)) return { value: defaults[key], source: `agents.defaults.${key}` };
  return { value: undefined, source: 'runtime/model inherited' };
}

function getEffectiveCompactionConfig(config, agentId = DEFAULT_AGENT_ID) {
  const { defaults, agent } = getAgentConfig(config, agentId);
  const defaultCompaction = defaults.compaction && typeof defaults.compaction === 'object' ? defaults.compaction : {};
  const agentCompaction = agent.compaction && typeof agent.compaction === 'object' ? agent.compaction : {};
  const value = { ...defaultCompaction, ...agentCompaction };
  const source = Object.keys(agentCompaction).length > 0
    ? `agents.list[${agentId}].compaction over agents.defaults.compaction`
    : Object.keys(defaultCompaction).length > 0
      ? 'agents.defaults.compaction'
      : 'runtime defaults';
  return { value, source };
}

function resolveTranscriptPath({ sessionEntry, sessionId, sessionsDir }) {
  if (sessionEntry?.sessionFile) return path.resolve(expandHome(sessionEntry.sessionFile));
  const id = sessionId || sessionEntry?.sessionId;
  if (!id) return null;
  return path.join(sessionsDir, `${id}.jsonl`);
}

function readCompactionCheckpoints(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];
  const checkpoints = [];
  const lines = fs.readFileSync(transcriptPath, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== 'compaction') continue;
    checkpoints.push(normalizeCompactionCheckpoint(entry, i + 1));
  }
  return checkpoints;
}

function normalizeCompactionCheckpoint(entry, lineNumber) {
  const details = entry.details && typeof entry.details === 'object' ? entry.details : {};
  return {
    lineNumber,
    id: entry.id || null,
    parentId: entry.parentId || null,
    timestamp: entry.timestamp || null,
    firstKeptEntryId: entry.firstKeptEntryId || null,
    tokensBefore: Number.isFinite(entry.tokensBefore) ? entry.tokensBefore : null,
    summaryChars: typeof entry.summary === 'string' ? entry.summary.length : 0,
    hasSummary: typeof entry.summary === 'string' && entry.summary.length > 0,
    hasDetails: Object.keys(details).length > 0,
    readFilesCount: Array.isArray(details.readFiles) ? details.readFiles.length : 0,
    modifiedFilesCount: Array.isArray(details.modifiedFiles) ? details.modifiedFiles.length : 0,
    sourceHandle: `transcript:${path.basename(entry.sessionId || '') || 'active'}#L${lineNumber}`
  };
}

function parseBytes(value) {
  if (value == null || value === false || value === 0) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib)?$/);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2] || 'b';
  const multiplier = unit === 'gb' || unit === 'gib'
    ? 1024 ** 3
    : unit === 'mb' || unit === 'mib'
      ? 1024 ** 2
      : unit === 'kb' || unit === 'kib'
        ? 1024
        : 1;
  return Math.round(amount * multiplier);
}

function summarizeContextWindow({ config, sessionEntry, agentId }) {
  const configured = getEffectiveAgentValue(config, agentId, 'contextTokens');
  const sessionStoreValue = Number.isFinite(sessionEntry?.contextTokens) ? sessionEntry.contextTokens : null;
  return {
    configuredContextTokens: Number.isFinite(configured.value) ? configured.value : null,
    configuredSource: configured.source,
    effectiveContextTokens: sessionStoreValue || (Number.isFinite(configured.value) ? configured.value : null),
    effectiveSource: sessionStoreValue ? 'session store runtime estimate' : configured.source,
    inherited: !Number.isFinite(configured.value)
  };
}

function buildContinuityHealthReport(options = {}) {
  const agentId = options.agentId || DEFAULT_AGENT_ID;
  const configPath = resolveConfigPath(options);
  const config = options.config || readJsonFile(configPath, {});
  const sessionStorePath = resolveSessionStorePath({ ...options, agentId });
  const sessionStore = options.sessionStore || readSessionStore({ ...options, agentId });
  const sessionKey = options.sessionKey || findMostRecentSessionKey(sessionStore);
  const sessionEntry = sessionStore[sessionKey] || null;
  const sessionsDir = resolveSessionsDir({ ...options, agentId });
  const transcriptPath = options.transcriptPath
    ? path.resolve(expandHome(options.transcriptPath))
    : resolveTranscriptPath({ sessionEntry, sessionsDir });
  const transcriptStat = statFile(transcriptPath);
  const checkpoints = readCompactionCheckpoints(transcriptPath);
  const compaction = getEffectiveCompactionConfig(config, agentId);
  const contextWindow = summarizeContextWindow({ config, sessionEntry, agentId });
  const analysis = analyzeContinuityCompactionHealth({
    config,
    agentId,
    sessionEntry,
    checkpoints,
    transcriptBytes: transcriptStat?.size || 0,
    compactionConfig: compaction.value,
    contextWindow,
    transcriptWarnBytes: options.transcriptWarnBytes || DEFAULT_TRANSCRIPT_WARN_BYTES
  });

  return {
    version: 1,
    generatedAt: options.now || new Date().toISOString(),
    agentId,
    sessionKey: sessionKey || null,
    paths: redactPaths({
      configPath,
      sessionStorePath,
      transcriptPath
    }, options),
    session: sessionEntry ? {
      sessionId: sessionEntry.sessionId || null,
      updatedAt: sessionEntry.updatedAt || null,
      totalTokens: Number.isFinite(sessionEntry.totalTokens) ? sessionEntry.totalTokens : null,
      inputTokens: Number.isFinite(sessionEntry.inputTokens) ? sessionEntry.inputTokens : null,
      outputTokens: Number.isFinite(sessionEntry.outputTokens) ? sessionEntry.outputTokens : null,
      compactionCount: Number.isFinite(sessionEntry.compactionCount) ? sessionEntry.compactionCount : checkpoints.length,
      memoryFlushAt: sessionEntry.memoryFlushAt || null,
      memoryFlushCompactionCount: Number.isFinite(sessionEntry.memoryFlushCompactionCount) ? sessionEntry.memoryFlushCompactionCount : null
    } : null,
    contextWindow,
    transcript: {
      exists: Boolean(transcriptStat),
      bytes: transcriptStat?.size || 0,
      mtimeMs: transcriptStat?.mtimeMs || null,
      checkpointCount: checkpoints.length
    },
    compaction: {
      configSource: compaction.source,
      mode: compaction.value.mode || 'default',
      reserveTokensFloor: Number.isFinite(compaction.value.reserveTokensFloor) ? compaction.value.reserveTokensFloor : null,
      maxHistoryShare: Number.isFinite(compaction.value.maxHistoryShare) ? compaction.value.maxHistoryShare : null,
      recentTurnsPreserve: Number.isFinite(compaction.value.recentTurnsPreserve) ? compaction.value.recentTurnsPreserve : null,
      truncateAfterCompaction: compaction.value.truncateAfterCompaction === true,
      maxActiveTranscriptBytes: compaction.value.maxActiveTranscriptBytes ?? null,
      maxActiveTranscriptBytesParsed: parseBytes(compaction.value.maxActiveTranscriptBytes),
      memoryFlushEnabled: compaction.value.memoryFlush?.enabled !== false,
      notifyUser: compaction.value.notifyUser === true
    },
    checkpoints,
    analysis,
    recommendedConfigReceipt: buildRecommendedConfigReceipt({ compactionConfig: compaction.value, contextWindow })
  };
}

function findMostRecentSessionKey(sessionStore) {
  let best = null;
  for (const [key, entry] of Object.entries(sessionStore || {})) {
    if (!entry || typeof entry !== 'object') continue;
    if (!best || Number(entry.updatedAt || 0) > Number(best.entry.updatedAt || 0)) best = { key, entry };
  }
  return best?.key || null;
}

function redactPaths(paths, options = {}) {
  if (options.includePaths) return paths;
  return Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, value ? path.basename(value) : null]));
}

function analyzeContinuityCompactionHealth(params) {
  const warnings = [];
  const observations = [];
  const compactionCount = Number.isFinite(params.sessionEntry?.compactionCount)
    ? params.sessionEntry.compactionCount
    : params.checkpoints.length;
  const maxActiveBytes = parseBytes(params.compactionConfig.maxActiveTranscriptBytes);
  const truncateEnabled = params.compactionConfig.truncateAfterCompaction === true;

  if (params.contextWindow.inherited) {
    warnings.push({
      code: 'context_window_inherited',
      severity: 'watch',
      message: 'Effective context window is inherited from model/runtime rather than pinned in agent config.'
    });
  }

  if (!truncateEnabled && compactionCount > 0) {
    warnings.push({
      code: 'active_transcript_growth_after_compaction',
      severity: 'warn',
      message: 'Compaction has occurred, but successor transcript rotation is not enabled in visible config.'
    });
  }

  if (params.compactionConfig.maxActiveTranscriptBytes != null && !truncateEnabled) {
    warnings.push({
      code: 'inactive_active_transcript_byte_guard',
      severity: 'warn',
      message: 'maxActiveTranscriptBytes is configured but requires truncateAfterCompaction to be active.'
    });
  }

  if (params.compactionConfig.maxActiveTranscriptBytes == null) {
    warnings.push({
      code: 'active_transcript_byte_guard_absent',
      severity: 'watch',
      message: 'No active transcript byte guard is configured.'
    });
  }

  if (params.transcriptBytes >= params.transcriptWarnBytes && !truncateEnabled) {
    warnings.push({
      code: 'active_transcript_large_without_rotation',
      severity: 'warn',
      message: 'Active transcript is over the warning threshold and successor transcript rotation is not enabled.'
    });
  }

  if (params.checkpoints.length >= 2) {
    warnings.push({
      code: 'repeated_compaction_summary_drift_risk',
      severity: 'watch',
      message: 'Multiple compaction checkpoints exist; summaries should remain source-grounded to avoid semantic drift.'
    });
  }

  if (compactionCount > 0 && params.compactionConfig.memoryFlush?.enabled !== false && !params.sessionEntry?.memoryFlushAt) {
    warnings.push({
      code: 'memory_flush_not_observed',
      severity: 'watch',
      message: 'Compaction happened but this session entry does not show a recorded memory flush timestamp.'
    });
  }

  if (truncateEnabled) {
    observations.push({ code: 'successor_transcript_rotation_enabled', message: 'Successor transcript rotation is enabled.' });
  }
  if (maxActiveBytes) {
    observations.push({ code: 'active_transcript_byte_guard_configured', message: `Active transcript byte guard is configured at ${maxActiveBytes} bytes.` });
  }
  if (params.checkpoints.length > 0) {
    observations.push({ code: 'compaction_checkpoints_found', message: `${params.checkpoints.length} compaction checkpoint(s) found in transcript.` });
  }

  return {
    status: warnings.some((warning) => warning.severity === 'warn') ? 'brittle' : warnings.length ? 'watch' : 'healthy',
    warnings,
    observations
  };
}

function buildRecommendedConfigReceipt({ compactionConfig, contextWindow }) {
  const proposedCompaction = {
    ...compactionConfig,
    truncateAfterCompaction: compactionConfig.truncateAfterCompaction === true ? compactionConfig.truncateAfterCompaction : true,
    maxActiveTranscriptBytes: compactionConfig.maxActiveTranscriptBytes || '20mb'
  };
  const changes = [];
  if (compactionConfig.truncateAfterCompaction !== true) changes.push('Enable successor transcript rotation after compaction.');
  if (compactionConfig.maxActiveTranscriptBytes == null) changes.push('Add an active transcript byte guard.');
  if (contextWindow.inherited && contextWindow.effectiveContextTokens) changes.push('Optionally pin contextTokens for predictable model-window behavior.');
  return {
    mutationApplied: false,
    changes,
    proposed: {
      agents: {
        defaults: {
          ...(contextWindow.inherited && contextWindow.effectiveContextTokens ? { contextTokens: contextWindow.effectiveContextTokens } : {}),
          compaction: proposedCompaction
        }
      }
    },
    rollback: {
      agents: {
        defaults: {
          ...(contextWindow.inherited ? { contextTokens: null } : {}),
          compaction: compactionConfig
        }
      }
    }
  };
}

function formatHealthReportMarkdown(report) {
  const lines = [];
  lines.push('# Continuity Compaction Health');
  lines.push('');
  lines.push(`- Status: **${report.analysis.status}**`);
  lines.push(`- Agent: \`${report.agentId}\``);
  lines.push(`- Session: \`${report.sessionKey || 'unknown'}\``);
  lines.push(`- Effective context window: ${report.contextWindow.effectiveContextTokens || 'unknown'} (${report.contextWindow.effectiveSource})`);
  lines.push(`- Configured context window: ${report.contextWindow.configuredContextTokens || 'inherited'} (${report.contextWindow.configuredSource})`);
  lines.push(`- Transcript bytes: ${report.transcript.bytes}`);
  lines.push(`- Compaction checkpoints: ${report.transcript.checkpointCount}`);
  lines.push(`- Successor transcript rotation: ${report.compaction.truncateAfterCompaction ? 'enabled' : 'not enabled'}`);
  lines.push(`- Active transcript byte guard: ${report.compaction.maxActiveTranscriptBytes || 'not configured'}`);
  lines.push('');
  if (report.checkpoints.length) {
    lines.push('## Checkpoints');
    for (const checkpoint of report.checkpoints) {
      lines.push(`- L${checkpoint.lineNumber}: \`${checkpoint.id || 'unknown'}\` tokensBefore=${checkpoint.tokensBefore || 'unknown'} firstKept=${checkpoint.firstKeptEntryId || 'unknown'} at ${checkpoint.timestamp || 'unknown'}`);
    }
    lines.push('');
  }
  if (report.analysis.warnings.length) {
    lines.push('## Warnings');
    for (const warning of report.analysis.warnings) {
      lines.push(`- **${warning.severity}** \`${warning.code}\`: ${warning.message}`);
    }
    lines.push('');
  }
  if (report.recommendedConfigReceipt.changes.length) {
    lines.push('## Recommended next hardening');
    for (const change of report.recommendedConfigReceipt.changes) lines.push(`- ${change}`);
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = {
  DEFAULT_AGENT_ID,
  DEFAULT_TRANSCRIPT_WARN_BYTES,
  expandHome,
  parseBytes,
  resolveOpenClawHome,
  resolveConfigPath,
  resolveSessionsDir,
  resolveSessionStorePath,
  readSessionStore,
  readCompactionCheckpoints,
  buildContinuityHealthReport,
  analyzeContinuityCompactionHealth,
  buildRecommendedConfigReceipt,
  formatHealthReportMarkdown
};
