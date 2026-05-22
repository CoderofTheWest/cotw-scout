'use strict';

const crypto = require('crypto');

const SYNTHESIS_FORMS = new Set(['hypothesis', 'frame', 'artifact', 'question', 'move']);

function buildSynthesisCard(input = {}, options = {}) {
  const form = normalizeForm(input.form || options.form);
  const sourceHandles = unique(input.sourceHandles || input.inputs?.sourceHandles || []);
  const synthesis = String(input.synthesis || input.claim || input.output || input.title || '').trim();
  const title = String(input.title || titleFromSynthesis(synthesis, form)).trim();
  const card = {
    id: input.id || stableSynthesisCardId({ form, title, synthesis, sourceHandles }),
    kind: 'synthesis_card',
    form,
    title,
    synthesis,
    pressure: normalizePressure(input.pressure),
    inputs: normalizeInputs(input.inputs, sourceHandles),
    claimBoundary: normalizeClaimBoundary(input.claimBoundary),
    testHooks: normalizeTestHooks(input.testHooks),
    reuse: normalizeReuse(input.reuse),
    policy: {
      lane: 'synthesis_card',
      decision: 'hold_for_iteration',
      eligibleForFactAutoAccept: false,
      eligibleForPromptFactInjection: false,
      mutationApplied: false,
      ...(input.policy || {})
    },
    provenance: {
      createdFrom: input.createdFrom || 'claim_autonomy_review',
      sourceCandidateId: input.sourceCandidateId || null,
      ambientTriggerDetected: input.ambientTriggerDetected === true
    }
  };

  // Compatibility fields for older dry-run receipt assertions while callers move
  // toward the structured policy object.
  card.eligibleForFactAutoAccept = false;
  card.eligibleForPromptFactInjection = false;
  card.mutationApplied = false;
  return card;
}

function validateSynthesisCard(card = {}) {
  const errors = [];
  if (!card || typeof card !== 'object') return { ok: false, errors: ['card must be an object'] };
  if (!card.id) errors.push('missing id');
  if (card.kind !== 'synthesis_card') errors.push('kind must be synthesis_card');
  if (!SYNTHESIS_FORMS.has(card.form)) errors.push(`unsupported form: ${card.form}`);
  if (!card.title) errors.push('missing title');
  if (!card.synthesis) errors.push('missing synthesis');
  if (!Array.isArray(card.pressure?.constraints)) errors.push('pressure.constraints must be an array');
  if (!Array.isArray(card.inputs?.sourceHandles)) errors.push('inputs.sourceHandles must be an array');
  for (const field of ['verifiedFacts', 'interpretations', 'assumptions', 'unknowns']) {
    if (!Array.isArray(card.claimBoundary?.[field])) errors.push(`claimBoundary.${field} must be an array`);
  }
  for (const field of ['wouldStrengthen', 'wouldWeaken', 'falsificationSignals']) {
    if (!Array.isArray(card.testHooks?.[field])) errors.push(`testHooks.${field} must be an array`);
  }
  if (!Array.isArray(card.reuse?.usefulFor)) errors.push('reuse.usefulFor must be an array');
  if (!Array.isArray(card.reuse?.notFor)) errors.push('reuse.notFor must be an array');
  if (card.policy?.lane !== 'synthesis_card') errors.push('policy.lane must be synthesis_card');
  if (card.policy?.eligibleForFactAutoAccept !== false) errors.push('policy.eligibleForFactAutoAccept must be false');
  if (card.policy?.eligibleForPromptFactInjection !== false) errors.push('policy.eligibleForPromptFactInjection must be false');
  if (card.policy?.mutationApplied !== false) errors.push('policy.mutationApplied must be false');
  return { ok: errors.length === 0, errors };
}

function synthesisCardFromCandidate(candidate = {}, evaluation = {}, options = {}) {
  return buildSynthesisCard({
    id: options.id,
    form: evaluation.synthesisForm || candidate.form || candidate.metadata?.synthesisForm || candidate.candidateMeta?.synthesisForm,
    title: candidate.title,
    synthesis: candidate.synthesis || candidate.output || candidate.claim,
    sourceHandles: sourceHandles(candidate),
    pressure: candidate.pressure || candidate.metadata?.pressure || pressureFromCandidate(candidate, evaluation),
    inputs: candidate.inputs || candidate.metadata?.inputs,
    claimBoundary: candidate.claimBoundary || candidate.metadata?.claimBoundary || claimBoundaryFromCandidate(candidate),
    testHooks: candidate.testHooks || candidate.metadata?.testHooks,
    reuse: candidate.reuse || candidate.metadata?.reuse,
    sourceCandidateId: candidate.id || null,
    ambientTriggerDetected: evaluation.ambientSynthesisTriggerDetected === true,
    createdFrom: options.createdFrom || 'claim_autonomy_review',
    policy: {
      lane: 'synthesis_card',
      decision: evaluation.policyDecision || 'hold_for_iteration',
      eligibleForFactAutoAccept: false,
      eligibleForPromptFactInjection: false,
      mutationApplied: false
    }
  }, options);
}

function normalizeForm(value) {
  const form = String(value || 'hypothesis').trim();
  return SYNTHESIS_FORMS.has(form) ? form : 'hypothesis';
}

function normalizePressure(value = {}) {
  return {
    problem: String(value.problem || '').trim(),
    constraints: array(value.constraints),
    contradictionOrTension: value.contradictionOrTension || value.tension || null,
    stakes: value.stakes || null
  };
}

function normalizeInputs(value = {}, sourceHandles = []) {
  return {
    sourceHandles: unique(array(value.sourceHandles).concat(sourceHandles)),
    absorbedData: array(value.absorbedData),
    subjectiveSalience: array(value.subjectiveSalience),
    priorIterations: array(value.priorIterations)
  };
}

function normalizeClaimBoundary(value = {}) {
  return {
    verifiedFacts: array(value.verifiedFacts),
    interpretations: array(value.interpretations),
    assumptions: array(value.assumptions),
    unknowns: array(value.unknowns)
  };
}

function normalizeTestHooks(value = {}) {
  return {
    wouldStrengthen: array(value.wouldStrengthen),
    wouldWeaken: array(value.wouldWeaken),
    falsificationSignals: array(value.falsificationSignals),
    nextExperiment: value.nextExperiment || null
  };
}

function normalizeReuse(value = {}) {
  return {
    usefulFor: array(value.usefulFor),
    notFor: array(value.notFor),
    expiresOrReviewAfter: value.expiresOrReviewAfter || null
  };
}

function pressureFromCandidate(candidate = {}, evaluation = {}) {
  return {
    problem: candidate.claim || candidate.synthesis || candidate.output || '',
    constraints: evaluation.reasonCodes || [],
    contradictionOrTension: candidate.evidence?.contradictionOrTension || candidate.candidateMeta?.problemShape || candidate.metadata?.problemShape || null,
    stakes: 'preserve creative synthesis without promoting it as verified belief'
  };
}

function claimBoundaryFromCandidate(candidate = {}) {
  return {
    verifiedFacts: [],
    interpretations: [candidate.claim || candidate.synthesis || candidate.output || ''].filter(Boolean),
    assumptions: array(candidate.metadata?.assumptions || candidate.candidateMeta?.assumptions),
    unknowns: array(candidate.metadata?.unknowns || candidate.candidateMeta?.unknowns)
  };
}

function sourceHandles(candidate = {}) {
  if (Array.isArray(candidate.sourceHandles)) return unique(candidate.sourceHandles.filter(Boolean));
  if (Array.isArray(candidate.sources)) return unique(candidate.sources.map((source) => typeof source === 'string' ? source : source?.handle).filter(Boolean));
  if (Array.isArray(candidate.inputs?.sourceHandles)) return unique(candidate.inputs.sourceHandles.filter(Boolean));
  return [];
}

function titleFromSynthesis(synthesis, form) {
  const text = String(synthesis || '').trim();
  if (!text) return `${form} synthesis`;
  return text.length <= 80 ? text : `${text.slice(0, 77)}…`;
}

function stableSynthesisCardId({ form, title, synthesis, sourceHandles }) {
  const basis = JSON.stringify({ form, title, synthesis, sourceHandles: [...sourceHandles].sort() });
  return `synthesis_${crypto.createHash('sha256').update(basis).digest('hex').slice(0, 16)}`;
}

function array(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== undefined && item !== null && item !== '');
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function unique(items = []) {
  return [...new Set(items.filter(Boolean))];
}

module.exports = {
  SYNTHESIS_FORMS,
  buildSynthesisCard,
  validateSynthesisCard,
  synthesisCardFromCandidate
};
