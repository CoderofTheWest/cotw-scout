const { createClaimDiagnostic } = require('./claim-diagnostics');

/**
 * Build 3 claim context packets.
 *
 * Runtime-inert/read-only: converts already-supplied claim records into a safe
 * context packet. This helper does not read storage, resolve source handles,
 * persist claims, mutate state, or inject prompt context. Source excerpts remain
 * hidden unless the caller explicitly opts in.
 */
function createClaimContextPacket(claims = [], options = {}) {
  const limit = normalizeLimit(options.limit, 8);
  const diagnostics = Array.isArray(claims)
    ? claims.map((claim) => createClaimDiagnostic(claim, diagnosticOptions(options)))
    : [];

  const accepted = [];
  const excluded = [];

  for (const diagnostic of diagnostics) {
    const decision = classifyDiagnosticForContext(diagnostic, options);
    const item = packetItem(diagnostic, decision, options);
    if (decision.include) accepted.push(item);
    else excluded.push(item);
  }

  const ranked = accepted.sort(packetSort);
  const diversity = selectDiverseItems(ranked, { ...options, limit });
  const sorted = diversity.selected;
  const audit = createClaimContextAudit({
    totalInput: diagnostics.length,
    selected: sorted,
    excluded,
    omittedByDiversity: diversity.omittedByDiversity
  });
  return {
    ok: true,
    mode: 'read_only_context_packet',
    injectionReady: false,
    sourceResolutionAttempted: false,
    mutationAttempted: false,
    totalInput: diagnostics.length,
    included: sorted.length,
    excluded: excluded.length,
    requiresVerification: sorted.filter((item) => item.requiresVerification).length,
    items: sorted,
    omitted: accepted.length > sorted.length ? accepted.length - sorted.length : 0,
    omittedByDiversity: diversity.omittedByDiversity.length,
    omittedByDiversityReasons: diversity.omittedByDiversity,
    audit,
    boundaries: [
      'read-only packet from supplied claims',
      'does not resolve source handles',
      'does not persist or update claims',
      'does not inject prompt context by itself',
      options.includeSourceExcerpts ? 'source excerpts explicitly included by caller' : 'source excerpts hidden'
    ]
  };
}

function createClaimContextAudit(input = {}) {
  const selected = input.selected || input.items || [];
  const excluded = input.excluded || [];
  const omittedByDiversity = input.omittedByDiversity || [];
  const counts = {
    selectedByKind: countBy(selected, 'kind'),
    selectedByStatus: countBy(selected, 'status'),
    selectedByAction: countBy(selected, 'action'),
    selectedByPrimarySourceType: countBy(selected, 'primarySourceType'),
    excludedByAction: countBy(excluded, 'action'),
    omittedByDiversityReason: countDiversityReasons(omittedByDiversity)
  };
  const quality = assessClaimContextQuality({
    totalInput: input.totalInput || selected.length + excluded.length,
    selected,
    excluded,
    omittedByDiversity,
    counts
  });
  return {
    ok: true,
    redacted: true,
    previewOnly: true,
    injectionReady: false,
    totalInput: input.totalInput || selected.length + excluded.length,
    selected: selected.map((item) => ({
      id: item.id,
      kind: item.kind,
      status: item.status,
      action: item.action,
      requiresVerification: item.requiresVerification,
      qualityScore: item.qualityScore,
      primarySourceType: item.primarySourceType,
      sourceTypes: item.sourceTypes || [],
      sourceHandleCount: (item.sources || []).length,
      reasons: item.reasons || []
    })),
    excluded: excluded.map((item) => ({
      id: item.id,
      kind: item.kind,
      status: item.status,
      action: item.action,
      requiresVerification: item.requiresVerification,
      primarySourceType: item.primarySourceType,
      sourceTypes: item.sourceTypes || [],
      reasons: item.reasons || []
    })),
    omittedByDiversity,
    counts,
    quality,
    boundaries: [
      'operator audit only',
      'does not include claim text',
      'does not include source handles or excerpts',
      'does not resolve source handles',
      'does not inject prompt context'
    ]
  };
}

function renderClaimContextAudit(audit = {}) {
  const lines = [];
  lines.push('# Claim Context Preview Audit');
  lines.push('');
  lines.push(`- Redacted: ${audit.redacted === true ? 'yes' : 'no'}`);
  lines.push(`- Preview only: ${audit.previewOnly === true ? 'yes' : 'no'}`);
  lines.push(`- Injection ready: ${audit.injectionReady === true ? 'yes' : 'no'}`);
  lines.push(`- Total input: ${audit.totalInput || 0}`);
  lines.push(`- Selected: ${(audit.selected || []).length}`);
  lines.push(`- Excluded: ${(audit.excluded || []).length}`);
  lines.push(`- Omitted by diversity: ${(audit.omittedByDiversity || []).length}`);
  if (audit.quality) {
    lines.push(`- Quality verdict: ${audit.quality.verdict || 'unknown'}`);
    lines.push(`- Ready for consumption trial: ${audit.quality.readyForConsumptionTrial === true ? 'yes' : 'no'}`);
  }
  lines.push('');
  if (audit.quality) {
    lines.push('## Quality');
    lines.push(`- Verdict: ${audit.quality.verdict || 'unknown'}`);
    lines.push(`- Ready for consumption trial: ${audit.quality.readyForConsumptionTrial === true ? 'yes' : 'no'}`);
    lines.push(`- Issues: ${(audit.quality.issues || []).join(', ') || 'none'}`);
    lines.push(`- Cautions: ${(audit.quality.cautions || []).join(', ') || 'none'}`);
    lines.push(`- Strengths: ${(audit.quality.strengths || []).join(', ') || 'none'}`);
    lines.push('');
    lines.push('## Readiness guidance');
    for (const recommendation of audit.quality.readinessRecommendations || ['no_additional_guidance']) {
      lines.push(`- ${recommendation}`);
    }
    lines.push('');
  }
  lines.push('## Selected');
  if (!(audit.selected || []).length) lines.push('- none');
  for (const item of audit.selected || []) {
    lines.push(`- ${item.id || '(missing-id)'} [${item.kind || 'unknown'}/${item.status || 'unknown'}] ${item.action || 'unknown'}`);
    lines.push(`  verification: ${item.requiresVerification ? 'required' : 'not-required'}; sourceTypes: ${(item.sourceTypes || []).join(', ') || 'unknown'}; sourceHandleCount: ${item.sourceHandleCount || 0}`);
  }
  lines.push('');
  lines.push('## Excluded');
  if (!(audit.excluded || []).length) lines.push('- none');
  for (const item of audit.excluded || []) {
    lines.push(`- ${item.id || '(missing-id)'} [${item.kind || 'unknown'}/${item.status || 'unknown'}] ${item.action || 'unknown'}`);
  }
  lines.push('');
  lines.push('## Diversity omissions');
  if (!(audit.omittedByDiversity || []).length) lines.push('- none');
  for (const item of audit.omittedByDiversity || []) {
    lines.push(`- ${item.id || '(missing-id)'}: ${(item.reasons || []).join(', ') || 'unspecified'}`);
  }
  lines.push('');
  lines.push('## Boundaries');
  for (const boundary of audit.boundaries || []) lines.push(`- ${boundary}`);
  return lines.join('\n');
}

function renderClaimContextPacket(packet = {}, options = {}) {
  const lines = [];
  lines.push('[SOURCE-ADDRESSABLE CLAIM CONTEXT — READ ONLY]');
  lines.push(`Included: ${packet.included || 0}/${packet.totalInput || 0}; requires verification: ${packet.requiresVerification || 0}`);
  lines.push('Use as provenance-aware memory pointers, not as automatic truth.');
  lines.push('');

  for (const item of packet.items || []) {
    lines.push(`- ${item.id} [${item.kind}/${item.status}] ${item.action}`);
    lines.push(`  claim: ${item.claim}`);
    lines.push(`  confidence: ${item.confidence}; requiresVerification: ${item.requiresVerification}`);
    if (item.reasons?.length) lines.push(`  reasons: ${item.reasons.join('; ')}`);
    if (item.sources?.length) {
      lines.push(`  sources: ${item.sources.map((source) => source.handle).join(', ')}`);
      if (options.includeSourceExcerpts) {
        for (const source of item.sources) {
          if (source.excerpt) lines.push(`    excerpt: ${source.excerpt}`);
        }
      }
    }
    if (item.guidance) lines.push(`  guidance: ${item.guidance}`);
  }

  if (packet.omitted) lines.push('', `Omitted by limit/diversity: ${packet.omitted}`);
  if (packet.omittedByDiversity) lines.push(`Omitted by diversity caps: ${packet.omittedByDiversity}`);
  lines.push('[/SOURCE-ADDRESSABLE CLAIM CONTEXT]');
  return lines.join('\n');
}

function classifyDiagnosticForContext(diagnostic = {}, options = {}) {
  if (!diagnostic.ok) return { include: false, action: 'exclude_missing' };
  if (diagnostic.action === 'do_not_use') return { include: false, action: 'exclude_do_not_use' };
  if (diagnostic.status === 'stale') return { include: false, action: 'exclude_stale' };
  if (diagnostic.requiresVerification) {
    return options.includeRequiresVerification === false
      ? { include: false, action: 'exclude_requires_verification' }
      : { include: true, action: 'verify_before_asserting' };
  }
  return { include: true, action: 'usable_with_qualification' };
}

function packetItem(diagnostic, decision, options = {}) {
  return {
    id: diagnostic.id || null,
    agentId: diagnostic.agentId || null,
    threadId: diagnostic.threadId || null,
    kind: diagnostic.kind || null,
    status: diagnostic.status || null,
    claim: diagnostic.claim || '',
    confidence: diagnostic.confidence ?? null,
    authorityRank: diagnostic.authorityRank ?? null,
    requiresVerification: Boolean(diagnostic.requiresVerification),
    action: decision.action,
    reasons: diagnostic.reasons || [],
    guidance: diagnostic.speechGuidance || null,
    sourceTypes: unique((diagnostic.sources || []).map((source) => source.sourceType || inferSourceType(source.handle))),
    primarySourceType: primarySourceType(diagnostic.sources || []),
    qualityScore: qualityScore(diagnostic),
    sources: (diagnostic.sources || []).map((source) => {
      const item = {
        handle: source.handle,
        role: source.role,
        sourceType: source.sourceType,
        hasExcerpt: Boolean(source.hasExcerpt || source.excerpt)
      };
      if (options.includeSourceExcerpts && source.excerpt) item.excerpt = source.excerpt;
      return item;
    })
  };
}

function diagnosticOptions(options = {}) {
  return {
    includeSourceExcerpts: Boolean(options.includeSourceExcerpts),
    includeFixtures: options.includeFixtures === true,
    maxExcerptChars: options.maxExcerptChars || 240
  };
}

function selectDiverseItems(items = [], options = {}) {
  const limit = normalizeLimit(options.limit, 8);
  const maxPerKind = normalizeCap(options.maxPerKind, Math.max(1, Math.ceil(limit / 2)));
  const maxPerSourceType = normalizeCap(options.maxPerSourceType, Math.max(1, Math.ceil(limit / 2)));
  const maxHandoffClaims = normalizeCap(options.maxHandoffClaims, Math.max(1, Math.min(3, limit)));
  const selected = [];
  const omittedByDiversity = [];
  const kindCounts = new Map();
  const sourceTypeCounts = new Map();
  let handoffCount = 0;

  for (const item of items) {
    if (selected.length >= limit) break;
    const kind = item.kind || 'unknown';
    const sourceType = item.primarySourceType || 'unknown';
    const isHandoff = (item.sourceTypes || []).includes('handoff');
    const blocked = [];
    if ((kindCounts.get(kind) || 0) >= maxPerKind) blocked.push('kind_cap');
    if ((sourceTypeCounts.get(sourceType) || 0) >= maxPerSourceType) blocked.push('source_type_cap');
    if (isHandoff && handoffCount >= maxHandoffClaims) blocked.push('handoff_cap');
    if (blocked.length) {
      omittedByDiversity.push({ id: item.id, reasons: blocked });
      continue;
    }
    selected.push(item);
    kindCounts.set(kind, (kindCounts.get(kind) || 0) + 1);
    sourceTypeCounts.set(sourceType, (sourceTypeCounts.get(sourceType) || 0) + 1);
    if (isHandoff) handoffCount += 1;
  }

  return { selected, omittedByDiversity };
}

function packetSort(a, b) {
  if ((b.qualityScore || 0) !== (a.qualityScore || 0)) return (b.qualityScore || 0) - (a.qualityScore || 0);
  return String(a.id || '').localeCompare(String(b.id || ''));
}

function qualityScore(diagnostic = {}) {
  let score = 0;
  if (diagnostic.status === 'active') score += 100;
  if (diagnostic.requiresVerification) score -= 35;
  score += Number(diagnostic.confidence || 0) * 40;
  score += Number(diagnostic.authorityRank || 0) * 5;
  if (diagnostic.kind === 'user_preference' || diagnostic.kind === 'identity') score += 8;
  if (diagnostic.kind === 'runtime') score -= 8;
  const sourceTypes = unique((diagnostic.sources || []).map((source) => source.sourceType || inferSourceType(source.handle)));
  if (sourceTypes.includes('handoff')) score -= 4;
  if (sourceTypes.includes('digest')) score -= 2;
  return Math.round(score * 100) / 100;
}


function assessClaimContextQuality(input = {}) {
  const selected = input.selected || [];
  const excluded = input.excluded || [];
  const omittedByDiversity = input.omittedByDiversity || [];
  const counts = input.counts || {};
  const issues = [];
  const cautions = [];
  const strengths = [];
  const selectedCount = selected.length;
  const totalInput = input.totalInput || selectedCount + excluded.length;
  const verificationCount = selected.filter((item) => item.requiresVerification).length;
  const kindCount = Object.keys(counts.selectedByKind || countBy(selected, 'kind')).length;
  const sourceTypeCount = Object.keys(counts.selectedByPrimarySourceType || countBy(selected, 'primarySourceType')).length;
  const usableCount = selected.filter((item) => item.action === 'usable_with_qualification').length;

  if (!selectedCount) issues.push(totalInput ? 'no_selected_claims_after_filters' : 'no_claims_available');
  if (selectedCount && verificationCount === selectedCount) issues.push('all_selected_claims_require_verification');
  if (selectedCount && !usableCount) issues.push('no_usable_qualified_claims_selected');
  if (selectedCount > 1 && kindCount <= 1) cautions.push('low_kind_diversity');
  if (selectedCount > 1 && sourceTypeCount <= 1) cautions.push('low_source_type_diversity');
  if (omittedByDiversity.length) cautions.push('diversity_caps_omitted_claims');
  if (excluded.length) strengths.push('unsafe_or_stale_claims_excluded');
  if (usableCount) strengths.push('has_usable_qualified_claims');
  if (verificationCount) strengths.push('verification_requirements_preserved');
  if (kindCount > 1) strengths.push('kind_diversity_present');
  if (sourceTypeCount > 1) strengths.push('source_type_diversity_present');
  const readinessRecommendations = createReadinessRecommendations({
    selectedCount,
    totalInput,
    verificationCount,
    usableCount,
    kindCount,
    sourceTypeCount,
    issues,
    cautions,
    omittedByDiversity
  });

  const readyForConsumptionTrial = issues.length === 0;
  const verdict = !selectedCount
    ? 'empty_preview'
    : readyForConsumptionTrial
      ? (cautions.length ? 'clean_with_cautions' : 'clean')
      : 'review_required';

  return {
    ok: true,
    redacted: true,
    verdict,
    readyForConsumptionTrial,
    selectedCount,
    totalInput,
    requiresVerification: verificationCount,
    usableWithQualification: usableCount,
    kindDiversity: kindCount,
    sourceTypeDiversity: sourceTypeCount,
    issues,
    cautions,
    strengths,
    readinessRecommendations,
    note: 'Quality verdict is diagnostic only; it does not authorize prompt injection.'
  };
}


function createReadinessRecommendations(input = {}) {
  const recommendations = [];
  const issues = input.issues || [];
  const cautions = input.cautions || [];
  const selectedCount = input.selectedCount || 0;
  const totalInput = input.totalInput || 0;

  if (!selectedCount && !totalInput) recommendations.push('add_source_addressable_claims_before_previewing_consumption');
  if (!selectedCount && totalInput) recommendations.push('review_selection_filters_because_all_available_claims_were_excluded');
  if (issues.includes('all_selected_claims_require_verification')) recommendations.push('verify_or_supersede_selected_claims_before_consumption_trial');
  if (issues.includes('no_usable_qualified_claims_selected')) recommendations.push('include_at_least_one_usable_qualified_claim');
  if (cautions.includes('low_kind_diversity')) recommendations.push('increase_kind_diversity_or_accept_narrow_scope_explicitly');
  if (cautions.includes('low_source_type_diversity')) recommendations.push('increase_source_type_diversity_or_accept_single_source_type_scope_explicitly');
  if (cautions.includes('diversity_caps_omitted_claims')) recommendations.push('review_diversity_cap_omissions_before_widening_consumption');
  if (!recommendations.length) recommendations.push('eligible_for_manual_consumption_trial_review_without_enabling_injection');

  return unique(recommendations);
}

function primarySourceType(sources = []) {
  const types = unique(sources.map((source) => source.sourceType || inferSourceType(source.handle)));
  if (types.includes('archive')) return 'archive';
  if (types.includes('handoff')) return 'handoff';
  if (types.includes('digest')) return 'digest';
  if (types.includes('tool')) return 'tool';
  return types[0] || 'unknown';
}

function inferSourceType(handle) {
  const match = String(handle || '').match(/^([a-z_]+):/);
  return match ? match[1] : 'unknown';
}

function countBy(items = [], key) {
  const counts = {};
  for (const item of items) {
    const value = item[key] || 'unknown';
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function countDiversityReasons(items = []) {
  const counts = {};
  for (const item of items) {
    for (const reason of item.reasons || ['unspecified']) {
      counts[reason] = (counts[reason] || 0) + 1;
    }
  }
  return counts;
}

function normalizeCap(value, fallback) {
  return Number.isInteger(value) ? Math.max(1, Math.min(value, 25)) : fallback;
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeLimit(value, fallback) {
  return Number.isInteger(value) ? Math.max(1, Math.min(value, 25)) : fallback;
}

module.exports = {
  createClaimContextPacket,
  createClaimContextAudit,
  assessClaimContextQuality,
  renderClaimContextPacket,
  renderClaimContextAudit,
  classifyDiagnosticForContext,
  selectDiverseItems
};
