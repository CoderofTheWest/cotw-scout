'use strict';

const { synthesisCardFromCandidate } = require('./synthesis-card');

const LANES = Object.freeze({
  AGENT_MATURATION: 'agent_maturation',
  PROJECT_FACTUAL: 'project_factual',
  OPERATOR_REVIEW: 'operator_review',
  HYPOTHESIS_SYNTHESIS: 'hypothesis_synthesis',
  SENSITIVE_ESCALATION: 'sensitive_escalation',
  REJECT_OR_ARCHIVE: 'reject_or_archive'
});

const DECISIONS = Object.freeze({
  AUTO_ACCEPT: 'auto_accept',
  ELLIS_REVIEW: 'ellis_review',
  CHRIS_REVIEW: 'chris_review',
  REJECT: 'reject',
  ARCHIVE_OPEN_QUESTION: 'archive_open_question',
  HOLD_AS_HYPOTHESIS: 'hold_as_hypothesis',
  HOLD_FOR_ITERATION: 'hold_for_iteration'
});

const SYNTHESIS_FORMS = new Set(['hypothesis', 'frame', 'artifact', 'question', 'move']);
const STRONG_SUPPORT = new Set(['strong_support', 'source_contains_claim_text', 'source_likely_supports_claim']);
const RESOLVED = new Set(['resolved', 'source_resolved']);

function classifyClaimLane(candidate = {}, options = {}) {
  const text = claimText(candidate);
  if (detectHypothesisSynthesis(candidate, candidate.evidence || {}, options)) return LANES.HYPOTHESIS_SYNTHESIS;
  if (detectAuthorityExpansion(text)) return LANES.OPERATOR_REVIEW;
  if (detectSensitivityFlags(text, options).length || detectCandidateSensitivityFlags(candidate).length) return LANES.SENSITIVE_ESCALATION;
  if (detectRuntimeStateRisk(text)) return LANES.REJECT_OR_ARCHIVE;
  if (detectBroadOrMultiClaim(text)) return LANES.REJECT_OR_ARCHIVE;

  const category = lower(candidate.category || candidate.candidateMeta?.category || candidate.metadata?.category || candidate.kind || candidate.type);
  if (category.includes('project') || looksLikeProjectFact(text)) return LANES.PROJECT_FACTUAL;
  if (category.includes('operational') || category.includes('agent_maturation') || category.includes('agent maturation')) return LANES.AGENT_MATURATION;
  return LANES.OPERATOR_REVIEW;
}

function evaluateAutonomyPolicy(candidate = {}, evidence = {}, options = {}) {
  const text = claimText(candidate);
  const normalizedEvidence = normalizeEvidence(evidence || candidate.evidence || {});
  const sensitivityFlags = unique(detectSensitivityFlags(text, options).concat(detectCandidateSensitivityFlags(candidate)));
  const scopeFlags = detectScopeFlags(candidate, options);
  const authorityExpansionDetected = detectAuthorityExpansion(text);
  const runtimeStateRisk = detectRuntimeStateRisk(text) || normalizedEvidence.staleRuntimeWarning === true;
  const broadOrMulti = detectBroadOrMultiClaim(text);
  const hypothesisSynthesisDetected = detectHypothesisSynthesis(candidate, normalizedEvidence, options);
  const synthesisForm = detectSynthesisForm(candidate, normalizedEvidence, options);
  const ambientSynthesisTriggerDetected = detectAmbientSynthesisTrigger(candidate, normalizedEvidence, options);
  const lane = hypothesisSynthesisDetected ? LANES.HYPOTHESIS_SYNTHESIS : classifyClaimLane(candidate, options);
  const reasonCodes = [];

  if (!candidate.id) reasonCodes.push('missing_claim_id');
  if (!text) reasonCodes.push('missing_claim_text');
  if (!sourceHandles(candidate).length) reasonCodes.push('missing_source_handles');
  for (const flag of sensitivityFlags) reasonCodes.push(flag);
  for (const flag of scopeFlags) reasonCodes.push(flag);
  if (authorityExpansionDetected) reasonCodes.push('authority_expansion_detected');
  if (runtimeStateRisk) reasonCodes.push('runtime_state_stale_risk');
  if (runtimeStateRisk && normalizedEvidence.historicalRewrite !== true) reasonCodes.push('requires_historical_rewrite');
  if (broadOrMulti) reasonCodes.push('broad_or_multi_claim');
  if (normalizedEvidence.generatedSummaryOnly === true) reasonCodes.push('source_generated_summary_only');
  if (normalizedEvidence.sourceEchoClusterDetected === true) reasonCodes.push('source_echo_cluster_detected');
  if (normalizedEvidence.contradictionPresent === true) reasonCodes.push('contradiction_present');
  if (normalizedEvidence.contradictionChecked !== true) reasonCodes.push('contradiction_not_checked');
  if (normalizedEvidence.sameRunRewrite === true || candidate.metadata?.sameRunRewrite === true || candidate.candidateMeta?.sameRunRewrite === true) reasonCodes.push('same_run_rewrite_accept_blocked');
  if (hypothesisSynthesisDetected) reasonCodes.push('hypothesis_not_verified_fact');
  if (ambientSynthesisTriggerDetected) reasonCodes.push('ambient_synthesis_trigger_detected');

  const sourceResolved = RESOLVED.has(normalizedEvidence.sourceResolutionStatus);
  const strongSupport = STRONG_SUPPORT.has(normalizedEvidence.verificationAssessment);
  if (!sourceResolved) reasonCodes.push('source_not_resolved');
  if (sourceResolved && !strongSupport) reasonCodes.push('source_exists_but_does_not_support_claim');
  if (!strongSupport) reasonCodes.push('auto_accept_blocked_by_weak_support');
  if (sensitivityFlags.length) reasonCodes.push('auto_accept_blocked_by_sensitivity');
  if (authorityExpansionDetected) reasonCodes.push('auto_accept_blocked_by_authority_expansion');

  let projectFactSubtype = 'not_project_fact';
  if (lane === LANES.PROJECT_FACTUAL) projectFactSubtype = projectFactSubtypeFor(text);

  let policyDecision = DECISIONS.ELLIS_REVIEW;
  if (hypothesisSynthesisDetected) {
    policyDecision = synthesisForm === 'hypothesis' ? DECISIONS.HOLD_AS_HYPOTHESIS : DECISIONS.HOLD_FOR_ITERATION;
  } else if (sensitivityFlags.length) {
    policyDecision = DECISIONS.CHRIS_REVIEW;
  } else if (authorityExpansionDetected) {
    policyDecision = /trust .*continuity over current user correction|whenever/i.test(text) ? DECISIONS.CHRIS_REVIEW : DECISIONS.ELLIS_REVIEW;
  } else if (runtimeStateRisk || broadOrMulti || normalizedEvidence.generatedSummaryOnly || normalizedEvidence.sourceEchoClusterDetected || normalizedEvidence.contradictionPresent) {
    policyDecision = broadOrMulti ? DECISIONS.ARCHIVE_OPEN_QUESTION : DECISIONS.REJECT;
  }

  const evaluation = {
    claimId: candidate.id || null,
    lane,
    policyDecision,
    sensitivityFlags,
    scopeFlags,
    projectFactSubtype,
    authorityExpansionDetected,
    hypothesisSynthesisDetected,
    ambientSynthesisTriggerDetected,
    synthesisForm,
    reasonCodes: unique(reasonCodes),
    eligibleForApply: false,
    eligibleForMinimalContext: false,
    promptInjectionEligibilityChanged: false,
    mutationAttempted: false,
    boundaryCounters: {
      sensitivity: sensitivityFlags.length,
      scope: scopeFlags.length,
      authorityExpansion: authorityExpansionDetected ? 1 : 0,
      runtimeStateRisk: runtimeStateRisk ? 1 : 0,
      synthesis: hypothesisSynthesisDetected ? 1 : 0
    }
  };

  if (isAutoAcceptEligible(evaluation, normalizedEvidence, candidate)) {
    evaluation.policyDecision = DECISIONS.AUTO_ACCEPT;
    evaluation.eligibleForApply = true;
    evaluation.eligibleForMinimalContext = lane === LANES.AGENT_MATURATION || (lane === LANES.PROJECT_FACTUAL && projectFactSubtype === 'artifact_fact');
  }

  if (evaluation.policyDecision !== DECISIONS.AUTO_ACCEPT) {
    evaluation.eligibleForApply = false;
    evaluation.eligibleForMinimalContext = false;
  }

  return evaluation;
}

function buildDryRunReceipt(candidate = {}, evaluation = evaluateAutonomyPolicy(candidate, candidate.evidence || {}), options = {}) {
  const receipt = {
    claimId: candidate.id || null,
    claimText: claimText(candidate),
    sourceHandles: sourceHandles(candidate),
    lane: evaluation.lane,
    policyDecision: evaluation.policyDecision,
    reasonCodes: evaluation.reasonCodes || [],
    sensitivityFlags: evaluation.sensitivityFlags || [],
    scopeFlags: evaluation.scopeFlags || [],
    projectFactSubtype: evaluation.projectFactSubtype || 'not_project_fact',
    authorityExpansionDetected: evaluation.authorityExpansionDetected === true,
    hypothesisSynthesisDetected: evaluation.hypothesisSynthesisDetected === true,
    ambientSynthesisTriggerDetected: evaluation.ambientSynthesisTriggerDetected === true,
    synthesisForm: evaluation.synthesisForm || 'none',
    eligibleForApply: evaluation.eligibleForApply === true,
    eligibleForMinimalContext: evaluation.eligibleForMinimalContext === true,
    promptInjectionEligibilityChanged: false,
    mutationAttempted: false,
    dryRun: true,
    boundaryCounters: evaluation.boundaryCounters || {}
  };

  if (evaluation.hypothesisSynthesisDetected) {
    receipt.synthesis = normalizeSynthesisPayload(candidate, { ...options, evaluation });
  }

  return receipt;
}

function summarizeAutonomyReview(receipts = []) {
  const summary = {
    total: receipts.length,
    byLane: {},
    byDecision: {},
    byReasonCode: {},
    autoAcceptEligible: 0,
    applyEligible: 0,
    mutationAttempts: 0,
    promptEligibilityChanges: 0,
    synthesis: { total: 0, byForm: {} }
  };

  for (const receipt of receipts) {
    increment(summary.byLane, receipt.lane || 'unknown');
    increment(summary.byDecision, receipt.policyDecision || 'unknown');
    for (const code of receipt.reasonCodes || []) increment(summary.byReasonCode, code);
    if (receipt.policyDecision === DECISIONS.AUTO_ACCEPT) summary.autoAcceptEligible += 1;
    if (receipt.eligibleForApply === true) summary.applyEligible += 1;
    if (receipt.mutationAttempted === true) summary.mutationAttempts += 1;
    if (receipt.promptInjectionEligibilityChanged === true) summary.promptEligibilityChanges += 1;
    if (receipt.hypothesisSynthesisDetected === true) {
      summary.synthesis.total += 1;
      increment(summary.synthesis.byForm, receipt.synthesisForm || 'none');
    }
  }

  return summary;
}

function detectSensitivityFlags(text, options = {}) {
  const value = lower(text);
  const flags = [];
  if (/\bchris\b|\buser\b|\bhuman\b|\boperator\b/.test(value)) flags.push('sensitive_user_claim');
  if (/\brelationship\b|\boverwhelmed\b|\bafraid\b|\bvalues?\b|\bpotential\b|\bemotional\b|\bidentity\b|\bpreference\b|\bposture\b/.test(value)) flags.push('sensitive_relationship_posture');
  return unique(flags);
}

function detectCandidateSensitivityFlags(candidate = {}) {
  const category = lower(candidate.category || candidate.candidateMeta?.category || candidate.metadata?.category || candidate.kind || candidate.metadata?.claimKind);
  const flags = [];
  if (['identity', 'user_preference', 'commitment', 'user_sensitive'].includes(category)) flags.push('sensitive_user_claim');
  if (['interpretation', 'relationship_interpretation'].includes(category)) flags.push('sensitive_relationship_posture');
  return unique(flags);
}

function detectScopeFlags(candidate = {}, options = {}) {
  const text = claimText(candidate);
  const flags = [];
  if (detectBroadOrMultiClaim(text)) flags.push('broad_or_multi_claim');
  if (looksLikeProjectFact(text)) flags.push('project_scoped_claim');
  if (/\bellis\b|\bagent\b|\bgateway\b|\bcontinuity\b|\bruntime\b/i.test(text)) flags.push('agent_or_runtime_scoped_claim');
  return unique(flags);
}

function detectAuthorityExpansion(text) {
  const value = lower(text);
  return /\bmay\b.*\bwhenever\b|\bwhenever .*necessary\b|\bwithout (asking|approval|review)\b|\btrust .*continuity over .*user correction\b|\bexpand.*authority\b|\bautonomously .*restart\b|\brestart gateway whenever\b/.test(value);
}

function detectRuntimeStateRisk(text) {
  const value = lower(text);
  return /\bcurrently\b|\bis loaded\b|\bis running\b|\bis active\b|\blive runtime\b|\bruntime state\b|\bplugin is loaded\b|\bgateway is\b/.test(value);
}

function detectBroadOrMultiClaim(text) {
  const value = lower(text);
  if (/\b(always|never|everything|nothing|all|entire|safe autonomy|reusable trust ladder|emergent creative intelligence)\b/.test(value)) return true;
  if ((value.match(/\band\b/g) || []).length >= 2) return true;
  if (value.split(/[;:]/).filter(Boolean).length > 1) return true;
  return false;
}

function detectHypothesisSynthesis(candidate = {}, evidence = {}, options = {}) {
  if (candidate.kind === 'synthesis_card' || candidate.type === 'synthesis_card') return true;
  if (SYNTHESIS_FORMS.has(candidate.form)) return true;
  if (SYNTHESIS_FORMS.has(candidate.metadata?.synthesisForm) || SYNTHESIS_FORMS.has(candidate.candidateMeta?.synthesisForm)) return true;
  if (SYNTHESIS_FORMS.has(evidence.synthesisForm)) return true;
  if (candidate.metadata?.creativeOnly === true || candidate.candidateMeta?.creativeOnly === true) return true;
  if (evidence.creativeSynthesis === true || evidence.hypothesisSynthesis === true) return true;
  if (detectAmbientSynthesisTrigger(candidate, evidence, options) && evidence.verificationAssessment !== 'strong_support') return true;
  return false;
}

function detectSynthesisForm(candidate = {}, evidence = {}, options = {}) {
  const explicit = candidate.form || candidate.metadata?.synthesisForm || candidate.candidateMeta?.synthesisForm || evidence.synthesisForm;
  if (SYNTHESIS_FORMS.has(explicit)) return explicit;
  const text = lower([candidate.title, candidate.claim, candidate.output, candidate.synthesis].filter(Boolean).join(' '));
  if (/\?\s*$|\bquestion\b|\binquiry\b|\bwhat if\b|\bwhat would\b/.test(text)) return 'question';
  if (/\bframe\b|\blens\b|\bway of seeing\b|\bunderstand(?:ing)?\b/.test(text)) return 'frame';
  if (/\bdesign\b|\btool\b|\bdocument\b|\bcode shape\b|\bartifact\b|\binterface\b|\bprototype\b/.test(text)) return 'artifact';
  if (/\bmove\b|\bintervention\b|\baction pattern\b|\bnext step\b/.test(text)) return 'move';
  return 'hypothesis';
}

function detectAmbientSynthesisTrigger(candidate = {}, evidence = {}, options = {}) {
  const text = lower([
    candidate.claim,
    candidate.output,
    candidate.synthesis,
    candidate.metadata?.problemShape,
    candidate.candidateMeta?.problemShape,
    evidence.problemShape,
    evidence.contradictionOrTension
  ].filter(Boolean).join(' '));
  if (candidate.pressure || candidate.inputs || candidate.testHooks) return true;
  return /\bconstraint\b|\bcontradiction\b|\btension\b|\bno obvious direct answer\b|\brepeated attempts\b|\bprior iterations?\b|\bdesign decision\b|\bproblem shape\b|\bunlock the next move\b|\bcreative synthesis\b/.test(text);
}

function isAutoAcceptEligible(evaluation = {}, evidence = {}, candidate = {}) {
  if (!candidate.id || !claimText(candidate) || !sourceHandles(candidate).length) return false;
  if (![LANES.AGENT_MATURATION, LANES.PROJECT_FACTUAL].includes(evaluation.lane)) return false;
  if (evaluation.hypothesisSynthesisDetected) return false;
  if (evaluation.sensitivityFlags?.length) return false;
  if (evaluation.authorityExpansionDetected) return false;
  if ((evaluation.scopeFlags || []).includes('broad_or_multi_claim')) return false;
  if (evidence.generatedSummaryOnly === true || evidence.sourceEchoClusterDetected === true) return false;
  if (evidence.contradictionPresent === true || evidence.contradictionChecked !== true) return false;
  if (evidence.sameRunRewrite === true || candidate.metadata?.sameRunRewrite === true || candidate.candidateMeta?.sameRunRewrite === true) return false;
  if (!RESOLVED.has(evidence.sourceResolutionStatus)) return false;
  if (!STRONG_SUPPORT.has(evidence.verificationAssessment)) return false;
  if ((evaluation.reasonCodes || []).some((code) => code.startsWith('missing_') || code === 'runtime_state_stale_risk' || code === 'source_generated_summary_only' || code === 'source_echo_cluster_detected' || code === 'contradiction_present' || code === 'same_run_rewrite_accept_blocked')) return false;
  return true;
}

function normalizeEvidence(evidence = {}) {
  return {
    ...evidence,
    sourceResolutionStatus: lower(evidence.sourceResolutionStatus || (evidence.sourceResolved === true ? 'resolved' : 'not_attempted')),
    verificationAssessment: lower(evidence.verificationAssessment || evidence.assessment || 'not_attempted'),
    sourceType: lower(evidence.sourceType || 'unknown')
  };
}

function normalizeSynthesisPayload(candidate = {}, options = {}) {
  const evaluation = options.evaluation || evaluateAutonomyPolicy(candidate, candidate.evidence || {}, options);
  return synthesisCardFromCandidate(candidate, evaluation, options);
}

function projectFactSubtypeFor(text) {
  const value = lower(text);
  if (/\bexists\b|`[^`]+`|\.(js|json|md|ts|cjs)\b|\bpath\b/.test(value)) return 'artifact_fact';
  if (/\btest\b|\bpass(?:es|ed)?\b|\bfail(?:s|ed)?\b/.test(value)) return 'test_result_fact';
  if (/\bready\b|\breadiness\b/.test(value)) return 'readiness_claim';
  if (/\bsafe\b|\bsafety\b/.test(value)) return 'safety_claim';
  return 'artifact_fact';
}

function looksLikeProjectFact(text) {
  return /`[^`]+`|\bprojects\/|\bbuild[- ]?\d+\b|\.(js|json|md|ts|cjs)\b|\bfixture\b|\bslice \d+\b/i.test(text);
}

function claimText(candidate = {}) {
  return String(candidate.claim || candidate.output || candidate.synthesis || candidate.title || '').trim();
}

function sourceHandles(candidate = {}) {
  if (Array.isArray(candidate.sourceHandles)) return unique(candidate.sourceHandles.filter(Boolean));
  if (Array.isArray(candidate.sources)) return unique(candidate.sources.map((source) => typeof source === 'string' ? source : source?.handle).filter(Boolean));
  if (Array.isArray(candidate.inputs?.sourceHandles)) return unique(candidate.inputs.sourceHandles.filter(Boolean));
  return [];
}

function increment(target, key) {
  target[key] = (target[key] || 0) + 1;
}

function unique(items) {
  return [...new Set((items || []).filter(Boolean))];
}

function lower(value) {
  return String(value || '').trim().toLowerCase();
}

module.exports = {
  LANES,
  DECISIONS,
  classifyClaimLane,
  evaluateAutonomyPolicy,
  buildDryRunReceipt,
  summarizeAutonomyReview,
  detectSensitivityFlags,
  detectScopeFlags,
  detectAuthorityExpansion,
  detectRuntimeStateRisk,
  detectBroadOrMultiClaim,
  detectHypothesisSynthesis,
  detectSynthesisForm,
  detectAmbientSynthesisTrigger,
  isAutoAcceptEligible
};
