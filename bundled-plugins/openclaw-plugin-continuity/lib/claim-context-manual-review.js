/**
 * Build 4 manual claim-context review packet.
 *
 * Operator-only, read-only review preparation. This is deliberately not a
 * consumption path: it prepares human-reviewable claim pointers only after the
 * redacted preflight has cleared. Blocked packets remain redacted and do not
 * reveal claim text, source handles, or excerpts.
 */
const { createClaimContextPreflight } = require('./claim-context-preflight');

function createClaimContextManualReview(input = {}) {
  const packet = input.packet || input.preview?.packet || null;
  const preflight = input.preflight || createClaimContextPreflight({
    packet,
    audit: input.audit || input.preview?.audit,
    trial: input.trial,
    verification: input.verification,
    preview: input.preview
  });
  const includeSourceExcerpts = Boolean(input.includeSourceExcerpts);

  if (!packet) {
    return blockedReview({
      decision: 'blocked_missing_packet',
      reason: 'claim_context_packet_required',
      blockers: ['missing_claim_context_packet'],
      nextActions: ['run_claim_context_preflight_before_manual_review']
    });
  }

  if (preflight.decision !== 'ready_for_manual_review') {
    return blockedReview({
      decision: 'blocked_by_preflight',
      reason: 'preflight_not_ready_for_manual_review',
      preflight,
      blockers: preflight.blockers || [],
      nextActions: preflight.nextActions || []
    });
  }

  return {
    ok: true,
    redacted: false,
    reviewOnly: true,
    previewOnly: true,
    injectionReady: false,
    consumptionAttempted: false,
    verificationAttempted: false,
    sourceResolutionAttempted: false,
    mutationAttempted: false,
    promotionAttempted: false,
    renderedPromptContext: false,
    manualReviewPrepared: true,
    decision: 'ready_for_operator_review',
    reason: 'preflight_ready_for_manual_review',
    preflightDecision: preflight.decision,
    selectedCount: packet.included || packet.items?.length || 0,
    totalInput: packet.totalInput || 0,
    requiresVerification: packet.requiresVerification || 0,
    items: (packet.items || []).map((item) => reviewItem(item, includeSourceExcerpts)),
    blockers: [],
    nextActions: [
      'operator_review_claims_against_available_provenance',
      'do_not_inject_review_packet_into_agent_prompt',
      'record_any_accept_reject_defer_decision_separately'
    ],
    boundaries: [
      'manual operator review packet only',
      'does not inject prompt context',
      'does not consume context automatically',
      'does not verify claims',
      'does not promote claims',
      'does not mutate claims',
      'does not resolve source handles',
      includeSourceExcerpts ? 'source excerpts explicitly included by caller' : 'source excerpts hidden'
    ]
  };
}

function blockedReview(input = {}) {
  return {
    ok: true,
    redacted: true,
    reviewOnly: true,
    previewOnly: true,
    injectionReady: false,
    consumptionAttempted: false,
    verificationAttempted: false,
    sourceResolutionAttempted: false,
    mutationAttempted: false,
    promotionAttempted: false,
    renderedPromptContext: false,
    manualReviewPrepared: false,
    decision: input.decision || 'blocked_by_preflight',
    reason: input.reason || 'manual_review_requires_clean_preflight',
    preflightDecision: input.preflight?.decision || null,
    selectedCount: input.preflight?.selectedCount || 0,
    totalInput: input.preflight?.totalInput || 0,
    requiresVerification: input.preflight?.requiresVerification || 0,
    items: [],
    blockers: input.blockers || [],
    nextActions: input.nextActions || [],
    boundaries: [
      'manual review blocked',
      'does not include claim text',
      'does not include source handles or excerpts',
      'does not inject prompt context',
      'does not consume context automatically',
      'does not verify or promote claims',
      'does not mutate claims',
      'does not resolve source handles'
    ]
  };
}

function reviewItem(item = {}, includeSourceExcerpts = false) {
  return {
    id: item.id || null,
    kind: item.kind || null,
    status: item.status || null,
    action: item.action || null,
    claim: item.claim || '',
    confidence: item.confidence ?? null,
    requiresVerification: Boolean(item.requiresVerification),
    guidance: item.guidance || null,
    reasons: item.reasons || [],
    sources: (item.sources || []).map((source) => {
      const sourceItem = {
        handle: source.handle,
        role: source.role,
        sourceType: source.sourceType,
        hasExcerpt: Boolean(source.hasExcerpt || source.excerpt)
      };
      if (includeSourceExcerpts && source.excerpt) sourceItem.excerpt = source.excerpt;
      return sourceItem;
    })
  };
}

function renderClaimContextManualReview(review = {}) {
  const lines = [];
  lines.push('# Claim Context Manual Review Packet');
  lines.push('');
  lines.push(`- Review only: ${review.reviewOnly === true ? 'yes' : 'no'}`);
  lines.push(`- Redacted: ${review.redacted === true ? 'yes' : 'no'}`);
  lines.push(`- Preview only: ${review.previewOnly === true ? 'yes' : 'no'}`);
  lines.push(`- Injection ready: ${review.injectionReady === true ? 'yes' : 'no'}`);
  lines.push(`- Consumption attempted: ${review.consumptionAttempted === true ? 'yes' : 'no'}`);
  lines.push(`- Verification attempted: ${review.verificationAttempted === true ? 'yes' : 'no'}`);
  lines.push(`- Promotion attempted: ${review.promotionAttempted === true ? 'yes' : 'no'}`);
  lines.push(`- Manual review prepared: ${review.manualReviewPrepared === true ? 'yes' : 'no'}`);
  lines.push(`- Decision: ${review.decision || 'unknown'}`);
  lines.push(`- Reason: ${review.reason || 'unknown'}`);
  lines.push(`- Preflight decision: ${review.preflightDecision || 'unknown'}`);
  lines.push(`- Selected: ${review.selectedCount || 0}/${review.totalInput || 0}`);
  lines.push(`- Requires verification: ${review.requiresVerification || 0}`);
  lines.push('');
  lines.push('## Blockers');
  for (const blocker of review.blockers?.length ? review.blockers : ['none']) lines.push(`- ${blocker}`);
  lines.push('');
  lines.push('## Next actions');
  for (const action of review.nextActions?.length ? review.nextActions : ['none']) lines.push(`- ${action}`);
  lines.push('');
  lines.push('## Items');
  if (!(review.items || []).length) lines.push('- none');
  for (const item of review.items || []) {
    lines.push(`- ${item.id || '(missing-id)'} [${item.kind || 'unknown'}/${item.status || 'unknown'}] ${item.action || 'unknown'}`);
    lines.push(`  claim: ${item.claim || '(empty)'}`);
    lines.push(`  confidence: ${item.confidence}; requiresVerification: ${item.requiresVerification === true ? 'yes' : 'no'}`);
    if (item.guidance) lines.push(`  guidance: ${item.guidance}`);
    if (item.reasons?.length) lines.push(`  reasons: ${item.reasons.join('; ')}`);
    if (item.sources?.length) {
      lines.push('  sources:');
      for (const source of item.sources) {
        lines.push(`    - ${source.handle} role=${source.role || 'unknown'} type=${source.sourceType || 'unknown'}`);
        if (source.excerpt) lines.push(`      excerpt: ${source.excerpt}`);
      }
    }
  }
  lines.push('');
  lines.push('## Boundaries');
  for (const boundary of review.boundaries || []) lines.push(`- ${boundary}`);
  return lines.join('\n');
}

module.exports = {
  createClaimContextManualReview,
  renderClaimContextManualReview
};
