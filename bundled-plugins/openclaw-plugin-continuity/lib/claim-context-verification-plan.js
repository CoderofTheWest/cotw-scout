/**
 * Build 3 claim-context verification planner.
 *
 * Diagnostic-only helper. It does not verify, resolve source handles, mutate
 * claims, promote claims, render claim text, or inject prompt context. It only
 * explains what kind of verification would be needed before preview-selected
 * claims could become usable.
 */
function createClaimContextVerificationPlan(input = {}) {
  const packet = input.packet || input.preview?.packet || null;
  const audit = input.audit || packet?.audit || input.preview?.audit || null;
  const selected = Array.isArray(audit?.selected) ? audit.selected : [];
  const selectedById = new Map((packet?.items || []).map((item) => [item.id, item]));
  const items = selected.map((item) => verificationPlanItem(item, selectedById.get(item.id)));
  const required = items.filter((item) => item.requiresVerification);

  return {
    ok: true,
    redacted: true,
    previewOnly: true,
    injectionReady: false,
    verificationAttempted: false,
    sourceResolutionAttempted: false,
    mutationAttempted: false,
    promotionAttempted: false,
    decision: required.length ? 'verification_required' : 'no_verification_needed',
    totalSelected: selected.length,
    requiresVerification: required.length,
    items,
    counts: {
      byStrategy: countBy(items, 'strategy'),
      byKind: countBy(items, 'kind'),
      byPrimarySourceType: countBy(items, 'primarySourceType')
    },
    recommendations: createPlanRecommendations(required),
    boundaries: [
      'verification planning only',
      'does not include claim text',
      'does not include source handles or excerpts',
      'does not resolve source handles',
      'does not verify or promote claims',
      'does not mutate claims',
      'does not render or inject prompt context'
    ]
  };
}

function verificationPlanItem(auditItem = {}, packetItem = {}) {
  const sourceTypes = auditItem.sourceTypes || packetItem.sourceTypes || [];
  const primarySourceType = auditItem.primarySourceType || packetItem.primarySourceType || 'unknown';
  const kind = auditItem.kind || packetItem.kind || 'unknown';
  const requiresVerification = auditItem.requiresVerification === true || packetItem.requiresVerification === true;
  const strategy = requiresVerification ? verificationStrategy({ kind, primarySourceType, sourceTypes }) : 'no_action_required';
  return {
    id: auditItem.id || packetItem.id || null,
    kind,
    status: auditItem.status || packetItem.status || 'unknown',
    action: auditItem.action || packetItem.action || 'unknown',
    requiresVerification,
    primarySourceType,
    sourceTypes,
    sourceHandleCount: auditItem.sourceHandleCount || 0,
    strategy,
    recommendation: recommendationForStrategy(strategy)
  };
}

function verificationStrategy(input = {}) {
  const kind = input.kind || 'unknown';
  const sourceTypes = input.sourceTypes || [];
  const primarySourceType = input.primarySourceType || 'unknown';

  if (kind === 'runtime') return 'current_runtime_check';
  if (kind === 'project_state') return 'current_project_state_check_or_supersede';
  if (kind === 'user_preference' || kind === 'identity' || kind === 'commitment') return 'user_confirmation_or_recent_archive_review';
  if (sourceTypes.includes('tool') || primarySourceType === 'tool') return 'rerun_equivalent_tool_or_current_state_check';
  if (sourceTypes.includes('handoff') || primarySourceType === 'handoff') return 'handoff_source_review_then_supersede';
  if (sourceTypes.includes('digest') || primarySourceType === 'digest') return 'digest_source_review_then_supersede';
  return 'source_review_then_supersede';
}

function recommendationForStrategy(strategy) {
  const map = {
    no_action_required: 'claim_is_already_usable_with_qualification',
    current_runtime_check: 'verify_against_current_runtime_before_asserting',
    current_project_state_check_or_supersede: 'check_current_project_state_and_supersede_if_changed',
    user_confirmation_or_recent_archive_review: 'confirm_with_user_or_recent_source_before_consumption',
    rerun_equivalent_tool_or_current_state_check: 'rerun_equivalent_check_before_consumption',
    handoff_source_review_then_supersede: 'review_handoff_source_and_create_superseding_claim_if_valid',
    digest_source_review_then_supersede: 'review_digest_source_and_create_superseding_claim_if_valid',
    source_review_then_supersede: 'review_source_and_create_superseding_claim_if_valid'
  };
  return map[strategy] || 'manual_review_required';
}

function createPlanRecommendations(required = []) {
  if (!required.length) return ['no_verification_required_before_manual_review'];
  const recommendations = required.map((item) => item.recommendation);
  recommendations.push('do_not_promote_claims_without_separate_verified_evidence');
  return unique(recommendations);
}

function renderClaimContextVerificationPlan(plan = {}) {
  const lines = [];
  lines.push('# Claim Context Verification Plan');
  lines.push('');
  lines.push(`- Redacted: ${plan.redacted === true ? 'yes' : 'no'}`);
  lines.push(`- Preview only: ${plan.previewOnly === true ? 'yes' : 'no'}`);
  lines.push(`- Injection ready: ${plan.injectionReady === true ? 'yes' : 'no'}`);
  lines.push(`- Verification attempted: ${plan.verificationAttempted === true ? 'yes' : 'no'}`);
  lines.push(`- Promotion attempted: ${plan.promotionAttempted === true ? 'yes' : 'no'}`);
  lines.push(`- Decision: ${plan.decision || 'unknown'}`);
  lines.push(`- Selected: ${plan.totalSelected || 0}`);
  lines.push(`- Requires verification: ${plan.requiresVerification || 0}`);
  lines.push('');
  lines.push('## Items');
  if (!(plan.items || []).length) lines.push('- none');
  for (const item of plan.items || []) {
    lines.push(`- ${item.id || '(missing-id)'} [${item.kind || 'unknown'}/${item.status || 'unknown'}]`);
    lines.push(`  requiresVerification: ${item.requiresVerification === true ? 'yes' : 'no'}; strategy: ${item.strategy || 'unknown'}; recommendation: ${item.recommendation || 'unknown'}`);
  }
  lines.push('');
  lines.push('## Recommendations');
  for (const recommendation of plan.recommendations?.length ? plan.recommendations : ['none']) lines.push(`- ${recommendation}`);
  lines.push('');
  lines.push('## Boundaries');
  for (const boundary of plan.boundaries || []) lines.push(`- ${boundary}`);
  return lines.join('\n');
}

function countBy(items = [], key) {
  const counts = {};
  for (const item of items) {
    const value = item[key] || 'unknown';
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function unique(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

module.exports = {
  createClaimContextVerificationPlan,
  renderClaimContextVerificationPlan
};
