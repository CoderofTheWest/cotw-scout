'use strict';

const { normalizeCognitiveSnapshot } = require('./cognitive-snapshot');
const { ensureArray, fullHash, safeText, stableHash } = require('./safe');

const CORRECTION_PATTERNS = [
  'actually',
  'that is not right',
  "that's not right",
  'no i mean',
  'i meant',
  'try again',
  'you missed',
  'not what i asked'
];

function normalizeTrajectoryWindow(input = {}, options = {}) {
  const now = options.now || input.createdAt || new Date().toISOString();
  const messages = normalizeMessages(input.messages || input.turns || []);
  const toolCalls = normalizeToolCalls(input.toolCalls || input.tools || []);
  const cognitiveSnapshot = normalizeCognitiveSnapshot(
    input.cognitiveSnapshot || input.cognitive || {},
    { includeRawLatent: options.includeRawLatent === true }
  );
  const sourceHandles = uniqueStrings([
    ...ensureArray(input.sourceHandles),
    ...ensureArray(input.receipts),
    ...ensureArray(input.receiptHandles)
  ]);
  const triggerEvent = safeText(input.triggerEvent || inferTriggerEvent({ messages, toolCalls, cognitiveSnapshot }), 80);
  const scope = safeText(input.scope || input.windowScope || 'current_task', 80);
  const id = safeText(input.id || `window-${stableHash({
    scope,
    triggerEvent,
    messages: messages.map((message) => `${message.role}:${message.content}`),
    toolCalls: toolCalls.map((call) => `${call.toolName}:${call.success}:${call.paramsHash}`),
    sourceHandles
  })}`, 140);

  return {
    id,
    createdAt: now,
    scope,
    triggerEvent,
    agentId: safeText(input.agentId || options.agentId || 'trail-guide', 80),
    mode: safeText(input.mode || input.activeMode || input.metadata?.mode || '', 80),
    sessionId: safeText(input.sessionId || input.metadata?.sessionId || '', 120),
    threadId: safeText(input.threadId || input.metadata?.threadId || '', 120),
    objective: safeText(input.objective || input.task || '', 240),
    messages,
    toolCalls,
    attachments: normalizeHandles(input.attachments),
    receiptHandles: normalizeHandles(sourceHandles),
    planState: sanitizeObject(input.planState || input.plan || {}),
    outcomeSignals: normalizeOutcomeSignals(input.outcomeSignals || input.satisfactionSignals || []),
    cognitiveSnapshot,
    sourceHandles,
    metadata: sanitizeObject(input.metadata || {}),
    stats: buildStats(messages, toolCalls, cognitiveSnapshot)
  };
}

function normalizeTrajectoryWindows(windows = [], options = {}) {
  return ensureArray(windows).map((window) => normalizeTrajectoryWindow(window, options));
}

function normalizeMessages(messages) {
  return ensureArray(messages).slice(-50).map((message, index) => ({
    role: safeText(message.role || 'unknown', 40),
    content: safeText(extractContent(message.content), 1500),
    timestamp: safeText(message.timestamp || message.createdAt || '', 80),
    turnIndex: Number.isInteger(message.turnIndex) ? message.turnIndex : index
  }));
}

function normalizeToolCalls(toolCalls) {
  return ensureArray(toolCalls).slice(-200).map((call, index) => {
    const params = call.params || call.toolParams || call.arguments || {};
    const result = call.result || call.toolResult || call.resultSummary || '';
    const success = typeof call.success === 'boolean' ? call.success : !looksLikeError(result);
    return {
      toolName: safeText(call.toolName || call.name || 'unknown_tool', 120),
      paramsSummary: safeText(typeof params === 'string' ? params : JSON.stringify(params), 500),
      paramsHash: fullHash(params),
      resultSummary: safeText(typeof result === 'string' ? result : JSON.stringify(result), 500),
      success,
      durationMs: Number.isFinite(Number(call.durationMs)) ? Number(call.durationMs) : null,
      timestamp: safeText(call.timestamp || call.createdAt || '', 80),
      turnIndex: Number.isInteger(call.turnIndex) ? call.turnIndex : index
    };
  });
}

function normalizeOutcomeSignals(signals) {
  return ensureArray(signals).map((signal) => ({
    type: safeText(signal.type || signal.kind || '', 80),
    context: safeText(signal.context || signal.text || '', 240),
    turnIndex: Number.isInteger(signal.turnIndex) ? signal.turnIndex : null
  }));
}

function normalizeHandles(values) {
  return uniqueStrings(ensureArray(values).map((value) => {
    if (typeof value === 'string') return value;
    return value?.handle || value?.id || value?.path || JSON.stringify(value);
  }));
}

function buildStats(messages, toolCalls, cognitiveSnapshot) {
  const userCorrections = messages.filter((message) => {
    if (message.role !== 'user') return false;
    const lower = message.content.toLowerCase();
    return CORRECTION_PATTERNS.some((pattern) => lower.includes(pattern));
  }).length;
  const failedToolCalls = toolCalls.filter((call) => call.success === false).length;
  return {
    messageCount: messages.length,
    toolCallCount: toolCalls.length,
    failedToolCalls,
    userCorrections,
    hasCognitiveSnapshot: cognitiveSnapshot.available === true
  };
}

function inferTriggerEvent({ messages, toolCalls, cognitiveSnapshot }) {
  if (messages.some((message) => message.role === 'user' && CORRECTION_PATTERNS.some((pattern) => message.content.toLowerCase().includes(pattern)))) {
    return 'correction';
  }
  if (toolCalls.filter((call) => call.success === false).length >= 2) return 'repeated_tool_failure';
  if ((cognitiveSnapshot.surpriseFrozen ?? cognitiveSnapshot.surpriseLearned ?? 0) >= 0.7) return 'cognitive_surprise_spike';
  if ((cognitiveSnapshot.surpriseFrozen ?? cognitiveSnapshot.surpriseLearned ?? 1) <= 0.25 && toolCalls.length >= 3) return 'low_surprise_drift';
  return 'operator';
}

function extractContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === 'string' ? part : part.text || part.content || '').join('\n');
  }
  if (content === null || content === undefined) return '';
  return JSON.stringify(content);
}

function looksLikeError(result) {
  const lower = String(typeof result === 'string' ? result : JSON.stringify(result || '')).toLowerCase();
  return !lower || lower.includes('error') || lower.includes('failed') || lower.includes('enoent') || lower.includes('permission denied') || lower.includes('syntaxerror') || lower.includes('typeerror');
}

function sanitizeObject(input, depth = 0) {
  if (depth > 3) return '[redacted-depth]';
  if (input === null || input === undefined) return input;
  if (Array.isArray(input)) return input.slice(0, 50).map((value) => sanitizeObject(value, depth + 1));
  if (typeof input === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(input)) {
      out[safeText(key, 80)] = sanitizeObject(value, depth + 1);
    }
    return out;
  }
  return safeText(input, 500);
}

function uniqueStrings(values) {
  return Array.from(new Set(ensureArray(values).map((value) => safeText(value, 240)).filter(Boolean))).slice(0, 100);
}

module.exports = {
  normalizeTrajectoryWindow,
  normalizeTrajectoryWindows
};
