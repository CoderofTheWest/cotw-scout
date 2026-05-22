const { createClaimConsumptionTrialPlan, renderClaimConsumptionTrialPlan } = require('./claim-context-trial');
const { createClaimContextVerificationPlan, renderClaimContextVerificationPlan } = require('./claim-context-verification-plan');

/**
 * Build 3 claim-context preflight bundle.
 *
 * Diagnostic-only operator receipt. Combines redacted audit quality, manual
 * trial decision, and verification plan into one status object/report. It does
 * not consume context, inject prompt text, verify claims, promote claims,
 * resolve sources, or mutate memory.
 */
function createClaimContextPreflight(input = {}) {
  const packet = input.packet || input.preview?.packet || null;
  const audit = input.audit || packet?.audit || input.preview?.audit || null;
  const quality = audit?.quality || null;
  const trial = input.trial || createClaimConsumptionTrialPlan({ packet, audit, preview: input.preview });
  const verification = input.verification || createClaimContextVerificationPlan({ packet, audit, preview: input.preview });
  const blockers = createBlockers({ quality, trial, verification });

  return {
    ok: true,
    redacted: true,
    previewOnly: true,
    injectionReady: false,
    consumptionAttempted: false,
    verificationAttempted: false,
    sourceResolutionAttempted: false,
    mutationAttempted: false,
    promotionAttempted: false,
    decision: blockers.length ? 'blocked' : 'ready_for_manual_review',
    auditVerdict: quality?.verdict || null,
    trialDecision: trial.decision || null,
    verificationDecision: verification.decision || null,
    totalInput: quality?.totalInput || audit?.totalInput || packet?.totalInput || 0,
    selectedCount: quality?.selectedCount || audit?.selected?.length || packet?.included || 0,
    requiresVerification: quality?.requiresVerification || verification.requiresVerification || 0,
    usableWithQualification: quality?.usableWithQualification || trial.usableWithQualification || 0,
    blockers,
    nextActions: createNextActions({ quality, trial, verification, blockers }),
    qualitySummary: {
      issues: quality?.issues || [],
      cautions: quality?.cautions || [],
      strengths: quality?.strengths || [],
      recommendations: quality?.readinessRecommendations || []
    },
    trialSummary: {
      decision: trial.decision || null,
      reason: trial.reason || null,
      recommendations: trial.recommendations || []
    },
    verificationSummary: {
      decision: verification.decision || null,
      recommendations: verification.recommendations || [],
      counts: verification.counts || {}
    },
    boundaries: [
      'preflight diagnostics only',
      'does not include claim text',
      'does not include source handles or excerpts',
      'does not resolve source handles',
      'does not verify or promote claims',
      'does not mutate claims',
      'does not consume, render, or inject prompt context'
    ]
  };
}

function createBlockers(input = {}) {
  const blockers = [];
  const quality = input.quality || {};
  const trial = input.trial || {};
  const verification = input.verification || {};
  if (!quality.verdict) blockers.push('missing_quality_audit');
  for (const issue of quality.issues || []) blockers.push(`quality:${issue}`);
  if (trial.decision && trial.decision !== 'eligible_for_manual_review') blockers.push(`trial:${trial.decision}`);
  if (verification.requiresVerification > 0) blockers.push('verification:claims_require_verification');
  return unique(blockers);
}

function createNextActions(input = {}) {
  const actions = [];
  const quality = input.quality || {};
  const trial = input.trial || {};
  const verification = input.verification || {};
  actions.push(...(quality.readinessRecommendations || []));
  actions.push(...(trial.recommendations || []));
  actions.push(...(verification.recommendations || []));
  if (!input.blockers?.length) actions.push('manual_review_can_be_considered_without_enabling_injection');
  return unique(actions);
}

function renderClaimContextPreflight(preflight = {}) {
  const lines = [];
  lines.push('# Claim Context Preflight');
  lines.push('');
  lines.push(`- Redacted: ${preflight.redacted === true ? 'yes' : 'no'}`);
  lines.push(`- Preview only: ${preflight.previewOnly === true ? 'yes' : 'no'}`);
  lines.push(`- Injection ready: ${preflight.injectionReady === true ? 'yes' : 'no'}`);
  lines.push(`- Consumption attempted: ${preflight.consumptionAttempted === true ? 'yes' : 'no'}`);
  lines.push(`- Verification attempted: ${preflight.verificationAttempted === true ? 'yes' : 'no'}`);
  lines.push(`- Promotion attempted: ${preflight.promotionAttempted === true ? 'yes' : 'no'}`);
  lines.push(`- Decision: ${preflight.decision || 'unknown'}`);
  lines.push(`- Audit verdict: ${preflight.auditVerdict || 'unknown'}`);
  lines.push(`- Trial decision: ${preflight.trialDecision || 'unknown'}`);
  lines.push(`- Verification decision: ${preflight.verificationDecision || 'unknown'}`);
  lines.push(`- Selected: ${preflight.selectedCount || 0}/${preflight.totalInput || 0}`);
  lines.push(`- Requires verification: ${preflight.requiresVerification || 0}`);
  lines.push('');
  lines.push('## Blockers');
  for (const blocker of preflight.blockers?.length ? preflight.blockers : ['none']) lines.push(`- ${blocker}`);
  lines.push('');
  lines.push('## Next actions');
  for (const action of preflight.nextActions?.length ? preflight.nextActions : ['none']) lines.push(`- ${action}`);
  lines.push('');
  lines.push('## Trial summary');
  lines.push(`- Decision: ${preflight.trialSummary?.decision || 'unknown'}`);
  lines.push(`- Reason: ${preflight.trialSummary?.reason || 'unknown'}`);
  lines.push('');
  lines.push('## Verification summary');
  lines.push(`- Decision: ${preflight.verificationSummary?.decision || 'unknown'}`);
  lines.push(`- Strategies: ${JSON.stringify(preflight.verificationSummary?.counts?.byStrategy || {})}`);
  lines.push('');
  lines.push('## Boundaries');
  for (const boundary of preflight.boundaries || []) lines.push(`- ${boundary}`);
  return lines.join('\n');
}

function unique(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

module.exports = {
  createClaimContextPreflight,
  renderClaimContextPreflight,
  renderClaimConsumptionTrialPlan,
  renderClaimContextVerificationPlan
};
