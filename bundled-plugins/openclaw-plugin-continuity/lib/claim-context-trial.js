/**
 * Build 3 manual consumption trial planner.
 *
 * This is not a consumption path and not an injection path. It reads only the
 * redacted audit/quality shape from a claim-context preview and returns a
 * redacted operator decision about whether a future human-reviewed trial should
 * even be considered.
 */
function createClaimConsumptionTrialPlan(input = {}) {
  const audit = input.audit || input.packet?.audit || input.preview?.audit || null;
  const quality = audit?.quality || null;

  if (!audit || !quality) {
    return trialPlan({
      decision: 'refused_missing_audit',
      reason: 'claim_context_audit_with_quality_required',
      issues: ['missing_redacted_quality_audit'],
      recommendations: ['run_claim_context_preview_audit_before_consumption_trial_review']
    });
  }

  const ready = quality.readyForConsumptionTrial === true;
  return trialPlan({
    decision: ready ? 'eligible_for_manual_review' : 'refused_review_required',
    reason: ready
      ? 'redacted_quality_audit_has_no_blocking_issues'
      : 'redacted_quality_audit_reports_blocking_issues',
    selectedCount: quality.selectedCount,
    totalInput: quality.totalInput,
    verdict: quality.verdict,
    requiresVerification: quality.requiresVerification,
    usableWithQualification: quality.usableWithQualification,
    kindDiversity: quality.kindDiversity,
    sourceTypeDiversity: quality.sourceTypeDiversity,
    issues: quality.issues || [],
    cautions: quality.cautions || [],
    strengths: quality.strengths || [],
    recommendations: quality.readinessRecommendations || []
  });
}

function trialPlan(input = {}) {
  return {
    ok: true,
    redacted: true,
    previewOnly: true,
    injectionReady: false,
    consumptionAttempted: false,
    sourceResolutionAttempted: false,
    mutationAttempted: false,
    decision: input.decision,
    reason: input.reason,
    verdict: input.verdict || null,
    selectedCount: input.selectedCount || 0,
    totalInput: input.totalInput || 0,
    requiresVerification: input.requiresVerification || 0,
    usableWithQualification: input.usableWithQualification || 0,
    kindDiversity: input.kindDiversity || 0,
    sourceTypeDiversity: input.sourceTypeDiversity || 0,
    issues: input.issues || [],
    cautions: input.cautions || [],
    strengths: input.strengths || [],
    recommendations: input.recommendations || [],
    boundaries: [
      'manual trial planning only',
      'does not include claim text',
      'does not include source handles or excerpts',
      'does not resolve source handles',
      'does not mutate claims',
      'does not render or inject prompt context'
    ]
  };
}

function renderClaimConsumptionTrialPlan(plan = {}) {
  const lines = [];
  lines.push('# Claim Context Manual Trial Plan');
  lines.push('');
  lines.push(`- Redacted: ${plan.redacted === true ? 'yes' : 'no'}`);
  lines.push(`- Preview only: ${plan.previewOnly === true ? 'yes' : 'no'}`);
  lines.push(`- Injection ready: ${plan.injectionReady === true ? 'yes' : 'no'}`);
  lines.push(`- Consumption attempted: ${plan.consumptionAttempted === true ? 'yes' : 'no'}`);
  lines.push(`- Decision: ${plan.decision || 'unknown'}`);
  lines.push(`- Reason: ${plan.reason || 'unknown'}`);
  lines.push(`- Verdict: ${plan.verdict || 'unknown'}`);
  lines.push(`- Selected: ${plan.selectedCount || 0}/${plan.totalInput || 0}`);
  lines.push(`- Requires verification: ${plan.requiresVerification || 0}`);
  lines.push(`- Usable with qualification: ${plan.usableWithQualification || 0}`);
  lines.push('');
  lines.push('## Issues');
  for (const issue of plan.issues?.length ? plan.issues : ['none']) lines.push(`- ${issue}`);
  lines.push('');
  lines.push('## Cautions');
  for (const caution of plan.cautions?.length ? plan.cautions : ['none']) lines.push(`- ${caution}`);
  lines.push('');
  lines.push('## Recommendations');
  for (const recommendation of plan.recommendations?.length ? plan.recommendations : ['none']) lines.push(`- ${recommendation}`);
  lines.push('');
  lines.push('## Boundaries');
  for (const boundary of plan.boundaries || []) lines.push(`- ${boundary}`);
  return lines.join('\n');
}

module.exports = {
  createClaimConsumptionTrialPlan,
  renderClaimConsumptionTrialPlan
};
