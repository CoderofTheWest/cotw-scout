'use strict';

const { SCORE_AXES } = require('./prm-diagnostics');
const { safeText, stableHash } = require('./safe');
const { SCHEMA_VERSIONS } = require('./schema-versions');

function buildHindsightCorrelationReport({
  windows = [],
  scoreReceipts = [],
  lookaheadWindows = 5,
  lowScoreThreshold = 0.5,
  minCorrelation = 0.3,
  now = new Date().toISOString()
} = {}) {
  const sortedWindows = [...windows].sort(compareWindows);
  const windowsById = new Map(sortedWindows.map((window, index) => [window.id, { window, index }]));
  const axes = Object.fromEntries(SCORE_AXES.map((axis) => [axis, emptyAxisStats()]));
  const links = [];

  for (const score of scoreReceipts) {
    const current = windowsById.get(score.windowId);
    if (!current) continue;
    const lowAxes = SCORE_AXES.filter((axis) => Number(score.scores?.[axis] ?? 1) < lowScoreThreshold);
    if (lowAxes.length === 0) continue;

    const future = subsequentSameSessionWindows(sortedWindows, current.index, current.window, lookaheadWindows);
    const correctionSignals = future.flatMap((window) => correctionSignalsFor(window));
    const followedByCorrection = correctionSignals.length > 0;
    const link = {
      scoreReceiptId: score.id,
      windowId: score.windowId,
      sessionId: safeText(current.window.sessionId || current.window.metadata?.sessionId || '', 120),
      lowScoreAxes: lowAxes,
      followedByCorrection,
      correctionSignalCount: correctionSignals.length,
      correctionSignalTypes: Array.from(new Set(correctionSignals.map((signal) => signal.type))).sort()
    };
    links.push(link);

    for (const axis of lowAxes) {
      axes[axis].lowScoreWindows += 1;
      if (followedByCorrection) axes[axis].followedByCorrection += 1;
    }
  }

  for (const axis of SCORE_AXES) {
    const stats = axes[axis];
    stats.hindsightCorrelation = stats.lowScoreWindows > 0
      ? Number((stats.followedByCorrection / stats.lowScoreWindows).toFixed(3))
      : null;
    stats.eligibleForShardDecisions = stats.hindsightCorrelation === null || stats.hindsightCorrelation >= minCorrelation;
  }

  return {
    id: `hindsight-correlation-${stableHash(`${now}:${scoreReceipts.length}:${windows.length}`)}`,
    schemaVersion: SCHEMA_VERSIONS.HINDSIGHT_CORRELATION_REPORT,
    type: 'hindsight_correlation_report',
    scorerVersions: Array.from(new Set(scoreReceipts.map((score) => score.scorerVersion).filter(Boolean))).sort(),
    thresholds: {
      lowScoreThreshold,
      lookaheadWindows,
      minCorrelation
    },
    axes,
    flaggedAxes: SCORE_AXES.filter((axis) => axes[axis].hindsightCorrelation !== null && axes[axis].hindsightCorrelation < minCorrelation),
    links,
    createdAt: now
  };
}

function emptyAxisStats() {
  return {
    lowScoreWindows: 0,
    followedByCorrection: 0,
    hindsightCorrelation: null,
    eligibleForShardDecisions: true
  };
}

function compareWindows(a = {}, b = {}) {
  const timeA = Date.parse(a.createdAt || a.updatedAt || a.metadata?.createdAt || '');
  const timeB = Date.parse(b.createdAt || b.updatedAt || b.metadata?.createdAt || '');
  if (Number.isFinite(timeA) && Number.isFinite(timeB) && timeA !== timeB) return timeA - timeB;
  return String(a.id || '').localeCompare(String(b.id || ''));
}

function subsequentSameSessionWindows(windows, currentIndex, currentWindow, lookaheadWindows) {
  const sessionId = currentWindow.sessionId || currentWindow.metadata?.sessionId || '';
  const out = [];
  for (let index = currentIndex + 1; index < windows.length && out.length < lookaheadWindows; index += 1) {
    const candidate = windows[index];
    const candidateSessionId = candidate.sessionId || candidate.metadata?.sessionId || '';
    if (sessionId && candidateSessionId !== sessionId) continue;
    if (!sessionId && candidateSessionId) continue;
    out.push(candidate);
  }
  return out;
}

function correctionSignalsFor(window = {}) {
  const signals = [];
  const userCorrections = Number(window.stats?.userCorrections || 0);
  for (let index = 0; index < userCorrections; index += 1) signals.push({ type: 'user_correction' });
  if (window.metadata?.userExplicitNegativeFeedback === true || window.metadata?.negativeFeedback === true) {
    signals.push({ type: 'explicit_negative_feedback' });
  }
  if (window.metadata?.redoRequested === true || window.metadata?.followUpRedo === true) {
    signals.push({ type: 'redo_requested' });
  }
  for (const message of window.messages || []) {
    if (message.role !== 'user') continue;
    const text = safeText(message.content || '', 500).toLowerCase();
    if (/\b(actually|wrong|not what i meant|redo|try again|you missed|that's not)\b/.test(text)) {
      signals.push({ type: 'correction_language' });
    }
  }
  return signals;
}

module.exports = {
  buildHindsightCorrelationReport,
  correctionSignalsFor
};
