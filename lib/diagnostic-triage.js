'use strict';

const { safeId } = require('./exchange-spine');

const DEFAULT_STOP_CLEAR_WARN_MS = 10000;
const DEFAULT_STOP_CLEAR_SEVERE_MS = 30000;

function runDiagnosticTriage({ entries = [], scope = 'exchange', symptoms = [], now = Date.now() } = {}) {
  const sorted = [...entries].sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
  const symptomSet = new Set((Array.isArray(symptoms) ? symptoms : [symptoms]).map((item) => String(item || '').trim()).filter(Boolean));
  const timeline = sorted.map(compactTimelineEvent);
  const exchangeIds = Array.from(new Set(sorted.map((entry) => entry.exchangeId).filter(Boolean)));
  const requestIds = Array.from(new Set(sorted.map((entry) => entry.requestId).filter(Boolean)));
  const streamDiagnosis = diagnoseStreamTiming(sorted);
  const errorDiagnosis = diagnoseErrors(sorted);
  const likely = chooseLikelyIssue([streamDiagnosis, errorDiagnosis], symptomSet);

  return {
    ok: true,
    readOnly: true,
    scope: safeId(scope, 80),
    symptoms: Array.from(symptomSet),
    exchangeIds,
    requestIds,
    likelyIssue: likely.issue,
    severity: likely.severity,
    confidence: likely.confidence,
    suggestedNextAction: likely.nextAction,
    excludedExplanations: likely.excludedExplanations || [],
    evidenceRefs: likely.evidenceRefs || [],
    timings: streamDiagnosis.timings,
    timeline,
    generatedAt: new Date(now).toISOString()
  };
}

function diagnoseStreamTiming(entries) {
  const requestStart = first(entries, 'gateway', 'request_start');
  const firstToken = first(entries, 'gateway', 'first_token');
  const streamDone = first(entries, 'gateway', 'stream_done');
  const streamError = first(entries, 'gateway', 'stream_error');
  const rendererStopCleared = first(entries, 'renderer', 'stop_button_cleared');
  const rendererFinalized = first(entries, 'renderer', 'stream_finalized');

  const timings = {
    requestToFirstTokenMs: delta(requestStart, firstToken),
    firstTokenToDoneMs: delta(firstToken, streamDone),
    requestToDoneMs: delta(requestStart, streamDone),
    doneToRendererFinalizedMs: delta(streamDone, rendererFinalized),
    doneToStopClearedMs: delta(streamDone, rendererStopCleared)
  };

  if (streamError) {
    return {
      issue: 'gateway_or_provider_stream_error',
      severity: 'high',
      confidence: 0.82,
      nextAction: 'Inspect gateway/provider stream error refs for this exchange before changing renderer cleanup.',
      evidenceRefs: refs([streamError, requestStart]),
      excludedExplanations: streamDone ? [] : ['normal_stream_completion'],
      timings
    };
  }

  if (Number.isFinite(timings.doneToStopClearedMs) && timings.doneToStopClearedMs >= DEFAULT_STOP_CLEAR_SEVERE_MS) {
    return {
      issue: 'renderer_stop_button_clear_delay',
      severity: 'high',
      confidence: 0.86,
      nextAction: 'Inspect renderer finalize/resetChatButtons path; gateway stream was done before the UI cleared.',
      evidenceRefs: refs([streamDone, rendererStopCleared]),
      excludedExplanations: ['provider_still_streaming'],
      timings
    };
  }

  if (Number.isFinite(timings.doneToStopClearedMs) && timings.doneToStopClearedMs >= DEFAULT_STOP_CLEAR_WARN_MS) {
    return {
      issue: 'renderer_stop_button_clear_delay',
      severity: 'medium',
      confidence: 0.74,
      nextAction: 'Watch renderer cleanup timing; delay crossed warning threshold after stream completion.',
      evidenceRefs: refs([streamDone, rendererStopCleared]),
      excludedExplanations: ['provider_still_streaming'],
      timings
    };
  }

  if (streamDone) {
    return {
      issue: 'stream_completed_normally',
      severity: 'low',
      confidence: 0.7,
      nextAction: 'No immediate action. Use recurrence diagnostics if this exchange is part of a repeated symptom.',
      evidenceRefs: refs([requestStart, firstToken, streamDone, rendererStopCleared]),
      excludedExplanations: ['gateway_stream_error'],
      timings
    };
  }

  return {
    issue: 'insufficient_trace_evidence',
    severity: 'unknown',
    confidence: 0.2,
    nextAction: 'Collect another traced exchange or inspect gateway logs for missing lifecycle receipts.',
    evidenceRefs: refs([requestStart, firstToken, rendererStopCleared]),
    excludedExplanations: [],
    timings
  };
}

function diagnoseErrors(entries) {
  const error = entries.find((entry) => String(entry.status || '').toLowerCase() === 'error' || /error/.test(String(entry.eventType || '')));
  if (!error) return null;
  return {
    issue: error.eventType === 'stream_error' ? 'gateway_or_provider_stream_error' : 'runtime_error_observed',
    severity: 'high',
    confidence: 0.75,
    nextAction: 'Inspect the referenced subsystem event and adjacent gateway logs for the same exchange.',
    evidenceRefs: refs([error]),
    excludedExplanations: [],
    timings: {}
  };
}

function chooseLikelyIssue(candidates, symptomSet) {
  const usable = candidates.filter(Boolean);
  if (!usable.length) return {
    issue: 'insufficient_trace_evidence',
    severity: 'unknown',
    confidence: 0.2,
    nextAction: 'Run diagnostics again after a traced exchange.',
    evidenceRefs: [],
    excludedExplanations: []
  };
  if (symptomSet.has('stop_button_stuck') || symptomSet.has('hang')) {
    const stop = usable.find((candidate) => candidate.issue === 'renderer_stop_button_clear_delay');
    if (stop) return stop;
  }
  const error = usable.find((candidate) => /error/.test(candidate.issue));
  return error || usable[0];
}

function first(entries, subsystem, eventType) {
  return entries.find((entry) => entry.subsystem === subsystem && entry.eventType === eventType) || null;
}

function delta(left, right) {
  if (!left || !right) return null;
  const value = Number(right.at || 0) - Number(left.at || 0);
  return Number.isFinite(value) ? Math.max(0, value) : null;
}

function refs(entries) {
  return entries.filter(Boolean).map((entry) => ({
    exchangeId: entry.exchangeId || '',
    requestId: entry.requestId || '',
    subsystem: entry.subsystem || '',
    eventType: entry.eventType || '',
    at: entry.iso || ''
  }));
}

function compactTimelineEvent(entry) {
  return {
    at: entry.iso || new Date(Number(entry.at || 0)).toISOString(),
    subsystem: entry.subsystem || '',
    eventType: entry.eventType || '',
    status: entry.status || '',
    requestId: entry.requestId || '',
    durationMs: entry.durationMs ?? null,
    note: entry.note || ''
  };
}

module.exports = {
  DEFAULT_STOP_CLEAR_SEVERE_MS,
  DEFAULT_STOP_CLEAR_WARN_MS,
  runDiagnosticTriage
};
