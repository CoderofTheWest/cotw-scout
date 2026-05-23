'use strict';

const { runDiagnosticTriage } = require('./diagnostic-triage');

function buildRecentSymptomsReport({ entries = [], sinceMs = Date.now() - 60 * 60 * 1000, now = Date.now() } = {}) {
  const recent = entries.filter((entry) => Number(entry.at || 0) >= sinceMs);
  const byExchange = new Map();
  for (const entry of recent) {
    const exchangeId = entry.exchangeId || 'unknown';
    if (!byExchange.has(exchangeId)) byExchange.set(exchangeId, []);
    byExchange.get(exchangeId).push(entry);
  }

  const diagnoses = [];
  for (const [exchangeId, group] of byExchange.entries()) {
    const diagnosis = runDiagnosticTriage({ entries: group, scope: 'exchange', now });
    diagnoses.push({
      exchangeId,
      likelyIssue: diagnosis.likelyIssue,
      severity: diagnosis.severity,
      confidence: diagnosis.confidence,
      requestIds: diagnosis.requestIds || [],
      generatedAt: diagnosis.generatedAt
    });
  }

  const groups = new Map();
  for (const diagnosis of diagnoses) {
    const key = diagnosis.likelyIssue || 'unknown';
    if (!isActionableSymptom(key)) continue;
    const group = groups.get(key) || {
      symptom: key,
      count: 0,
      severity: 'low',
      maxConfidence: 0,
      exchangeIds: [],
      requestIds: []
    };
    group.count += 1;
    group.severity = maxSeverity(group.severity, diagnosis.severity);
    group.maxConfidence = Math.max(group.maxConfidence, Number(diagnosis.confidence || 0));
    if (diagnosis.exchangeId && diagnosis.exchangeId !== 'unknown') group.exchangeIds.push(diagnosis.exchangeId);
    group.requestIds.push(...(diagnosis.requestIds || []));
    groups.set(key, group);
  }

  const symptoms = [...groups.values()]
    .map((group) => ({
      ...group,
      exchangeIds: unique(group.exchangeIds).slice(-25),
      requestIds: unique(group.requestIds).slice(-25),
      recurring: group.count >= 2,
      maxConfidence: Number(group.maxConfidence.toFixed(2))
    }))
    .sort((a, b) => b.count - a.count || severityRank(b.severity) - severityRank(a.severity));

  return {
    ok: true,
    readOnly: true,
    sinceMs,
    generatedAt: new Date(now).toISOString(),
    exchangeCount: byExchange.size,
    eventCount: recent.length,
    symptoms,
    recurringSymptoms: symptoms.filter((symptom) => symptom.recurring)
  };
}

function isActionableSymptom(value) {
  return !new Set([
    'stream_completed_normally',
    'insufficient_trace_evidence'
  ]).has(value);
}

function severityRank(value) {
  if (value === 'high') return 3;
  if (value === 'medium') return 2;
  if (value === 'low') return 1;
  return 0;
}

function maxSeverity(left, right) {
  return severityRank(right) > severityRank(left) ? right : left;
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

module.exports = {
  buildRecentSymptomsReport
};
