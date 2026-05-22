let evolutionLedger = null;
try {
  evolutionLedger = require('../../../lib/evolution-ledger');
} catch {
  evolutionLedger = null;
}

const {
  createClaimDiagnostic,
  inspectClaim,
  summarizeClaimStore
} = require('../lib/claim-diagnostics');
const {
  createClaimContextPacket,
  renderClaimContextPacket,
  renderClaimContextAudit
} = require('../lib/claim-context');
const { createClaimConsumptionTrialPlan, renderClaimConsumptionTrialPlan } = require('../lib/claim-context-trial');
const { createClaimContextVerificationPlan, renderClaimContextVerificationPlan } = require('../lib/claim-context-verification-plan');
const { createClaimContextPreflight, renderClaimContextPreflight } = require('../lib/claim-context-preflight');
const { createClaimContextManualReview, renderClaimContextManualReview } = require('../lib/claim-context-manual-review');
const { createCandidateResearchReport } = require('../lib/candidate-research-diagnostics');
const { reviewClaimStoreCandidates } = require('../lib/claim-autonomy-review');
const {
  createAutonomyReviewDecisionApply,
  createAutonomyReviewDecisionRollback,
  renderAutonomyReviewDecisionApply,
  renderAutonomyReviewDecisionRollback
} = require('../lib/claim-autonomy-review-decision-apply');

const ALLOWED_ACTIONS = new Set(['get', 'list', 'source', 'verify', 'stats', 'context', 'context_audit', 'trial_plan', 'verification_plan', 'preflight', 'manual_review', 'research', 'autonomy_review', 'apply_review_decision', 'rollback_review_decision']);
const KIND_VALUES = new Set(['project_state', 'user_preference', 'identity', 'commitment', 'runtime', 'interpretation', 'summary']);
const STATUS_VALUES = new Set(['active', 'superseded', 'stale', 'verify_required', 'retracted']);
const RESEARCH_MODES = new Set(['map', 'verification', 'creative', 'stale-risk', 'calibration']);
const APPLY_REVIEW_DECISIONS = new Set(['archive_open_question', 'hold_as_hypothesis']);

/**
 * continuity_claims — source-addressable claim diagnostics plus one narrow
 * gated write-through experiment.
 *
 * Runtime surface is explicit/on-demand only. Diagnostic actions do not create,
 * update, persist, resolve source handles, or inject prompt context. The only
 * mutating action is apply_review_decision, which requires exact claim id,
 * expected current status, apply=true, and an exact operator approval string.
 * Source excerpts are hidden unless explicitly requested.
 */
module.exports = function createClaimsTool(getAgentState, getCurrentAgentId) {
  return {
    name: 'continuity_claims',
    description: 'Diagnostics for source-addressable memory claims plus a narrowly gated single-claim autonomous write-through and rollback experiment. Use to inspect a claim by id, list claims by narrow filters, find claims tied to a source handle, identify claims requiring verification, render safe read-only claim-context packets, run dry-run autonomous maturation review, or autonomously apply exactly one low-risk review decision or roll back one prior decision. Does not resolve source text, inject prompt context, consume context, batch mutate, or promote claims to active truth.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'list', 'source', 'verify', 'stats', 'context', 'context_audit', 'trial_plan', 'verification_plan', 'preflight', 'manual_review', 'research', 'autonomy_review', 'apply_review_decision', 'rollback_review_decision'],
          description: 'Action: get one claim, list filtered claims, find claims for a source handle, list claims needing verification, show compact stats, render safe read-only context/review packets, render a read-only candidate research report, run a dry-run autonomous maturation review, autonomously apply one gated low-risk review decision, or roll back one prior decision.',
          default: 'list'
        },
        claim_id: { type: 'string', description: 'Claim id for action=get, action=apply_review_decision, or action=rollback_review_decision.' },
        source_handle: { type: 'string', description: 'Source handle for action=source.' },
        agent_id: { type: 'string', description: 'Optional agent id; defaults to current agent.' },
        thread_id: { type: 'string', description: 'Optional thread/session id filter.' },
        kind: { type: 'string', description: 'Optional claim kind filter.' },
        status: { type: 'string', description: 'Optional claim status filter.' },
        text: { type: 'string', description: 'Optional claim text substring filter.' },
        min_confidence: { type: 'number', description: 'Optional minimum confidence filter.' },
        limit: { type: 'integer', description: 'Max claims to return (default 10, max 50).', default: 10 },
        include_sources: { type: 'boolean', description: 'Include source handles/metadata. Source excerpts remain hidden unless include_source_excerpts is true.', default: false },
        include_source_excerpts: { type: 'boolean', description: 'Opt-in display of stored source excerpts. Does not resolve source handles.', default: false },
        include_metadata: { type: 'boolean', description: 'Include stored claim metadata.', default: false },
        research_mode: { type: 'string', description: 'Candidate research report mode for action=research.', enum: ['map', 'verification', 'creative', 'stale-risk', 'calibration'], default: 'map' },
        scan_limit: { type: 'integer', description: 'Max claims to scan for action=research/context-like actions (default 100, max 500).', default: 100 },
        decision: { type: 'string', description: 'Decision for action=apply_review_decision.', enum: ['archive_open_question', 'hold_as_hypothesis'] },
        expected_status: { type: 'string', description: 'Required current claim status precondition for action=apply_review_decision.', enum: ['verify_required', 'stale'] },
        reason: { type: 'string', description: 'Operator-visible reason for action=apply_review_decision.' },
        apply: { type: 'boolean', description: 'For action=apply_review_decision, true requests mutation; false/omitted renders dry-run plan only.', default: false },
        operator_approval: { type: 'string', description: 'Optional exact approval string for action=apply_review_decision: approve:<claim_id>:<decision>:<expected_status>. Low-risk bounded apply does not require it; higher-risk future lanes may.' },
        receipt_id: { type: 'string', description: 'Optional before-receipt id for action=rollback_review_decision. Defaults to latest rollback snapshot for the claim.' }
      }
    },
    execute: async (_toolCallId, args = {}) => {
      const action = args.action || inferAction(args);
      const validationError = validateToolArgs(args, action);
      if (validationError) return textResult(validationError);

      const agentId = args.agent_id || getCurrentAgentId();
      const state = getAgentState(agentId);

      try {
        if (state?.ensureStorage) await state.ensureStorage();
      } catch (err) {
        return textResult(`Source-addressable claim diagnostics unavailable: ${err.message}`);
      }

      if (!state?.claimStore) {
        return textResult('Source-addressable claim diagnostics unavailable: ClaimStore is not initialized for this agent. Runtime defaults may still be inert.');
      }

      const options = diagnosticOptions(args);

      try {
        if (action === 'get') {
          if (!args.claim_id) return textResult('claim_id is required for action=get.');
          const diagnostic = inspectClaim(state.claimStore, args.claim_id, options);
          return textResult(formatDiagnostic(diagnostic));
        }

        if (action === 'source') {
          if (!args.source_handle) return textResult('source_handle is required for action=source.');
          const claims = state.claimStore.getClaimsBySourceHandle(args.source_handle, {
            ...buildFilter(args, agentId),
            includeSources: true
          });
          return textResult(formatSummary(claims.map((claim) => createClaimDiagnostic(claim, options)), `Claims for source ${args.source_handle}`));
        }

        if (action === 'verify') {
          const claims = state.claimStore.getClaimsNeedingVerification({
            ...buildFilter(args, agentId),
            includeSources: Boolean(args.include_sources || args.include_source_excerpts)
          });
          return textResult(formatSummary(claims.map((claim) => createClaimDiagnostic(claim, options)), 'Claims requiring verification'));
        }

        if (action === 'stats') {
          const stats = state.claimStore.getStats(agentId);
          return textResult(formatStats(stats, agentId));
        }

        if (action === 'research') {
          const scanLimit = normalizeScanLimit(args.scan_limit);
          const claims = loadCandidateResearchClaims(state.claimStore, { ...buildFilter(args, agentId), limit: scanLimit });
          const report = createCandidateResearchReport({
            claims,
            edges: collectClaimEdges(claims),
            mode: args.research_mode || 'map',
            agentId,
            threadId: args.thread_id,
            options: {
              maxCandidates: scanLimit,
              maxClusters: normalizeLimit(args.limit),
              maxTensions: normalizeLimit(args.limit),
              noMutate: true
            }
          });
          return textResult(formatCandidateResearchReport(report, { limit: normalizeLimit(args.limit) }));
        }

        if (action === 'autonomy_review') {
          const review = await reviewClaimStoreCandidates({
            claimStore: state.claimStore,
            agentId,
            limit: normalizeScanLimit(args.scan_limit),
            statuses: args.status ? [args.status] : undefined,
            kinds: args.kind ? [args.kind] : undefined
          });
          return textResult(formatAutonomyReview(review, { limit: normalizeLimit(args.limit) }));
        }

        if (action === 'apply_review_decision') {
          const result = createAutonomyReviewDecisionApply({
            claimStore: state.claimStore,
            agentId,
            claimId: args.claim_id,
            decision: args.decision,
            expectedStatus: args.expected_status,
            reason: args.reason,
            apply: args.apply === true,
            operatorApproval: args.operator_approval
          });
          recordEvolutionIfAvailable(result, state, agentId);
          return textResult(renderAutonomyReviewDecisionApply(result));
        }

        if (action === 'rollback_review_decision') {
          const result = createAutonomyReviewDecisionRollback({
            claimStore: state.claimStore,
            agentId,
            claimId: args.claim_id,
            receiptId: args.receipt_id,
            reason: args.reason,
            apply: args.apply === true
          });
          recordEvolutionIfAvailable(result, state, agentId);
          return textResult(renderAutonomyReviewDecisionRollback(result));
        }

        if (action === 'context' || action === 'context_audit' || action === 'trial_plan' || action === 'verification_plan' || action === 'preflight' || action === 'manual_review') {
          const claims = state.claimStore.listClaims({
            ...buildFilter(args, agentId),
            includeSources: true,
            includeEdges: false
          });
          const packet = createClaimContextPacket(claims, {
            limit: normalizeLimit(args.limit),
            includeSourceExcerpts: (action === 'context' || action === 'manual_review') && Boolean(args.include_source_excerpts)
          });
          if (action === 'trial_plan') {
            const plan = createClaimConsumptionTrialPlan({ packet });
            return textResult(renderClaimConsumptionTrialPlan(plan));
          }
          if (action === 'verification_plan') {
            const plan = createClaimContextVerificationPlan({ packet });
            return textResult(renderClaimContextVerificationPlan(plan));
          }
          if (action === 'preflight') {
            const preflight = createClaimContextPreflight({ packet });
            return textResult(renderClaimContextPreflight(preflight));
          }
          if (action === 'manual_review') {
            const review = createClaimContextManualReview({ packet, includeSourceExcerpts: Boolean(args.include_source_excerpts) });
            return textResult(renderClaimContextManualReview(review));
          }
          if (action === 'context_audit') return textResult(renderClaimContextAudit(packet.audit));
          return textResult(renderClaimContextPacket(packet, {
            includeSourceExcerpts: Boolean(args.include_source_excerpts)
          }));
        }

        const summary = summarizeClaimStore(state.claimStore, buildFilter(args, agentId), options);
        return textResult(formatSummary(summary.claims, 'Claim diagnostics'));
      } catch (err) {
        return textResult(`Claim diagnostics failed: ${err.message}`);
      }
    }
  };
};

function recordEvolutionIfAvailable(result, state, agentId) {
  if (!evolutionLedger || !result || result.ok !== true || result.mutationAttempted !== true) return;
  try {
    const workspacePath = state?.knowledgeIndexer?.workspacePath || null;
    const ledgerPath = workspacePath
      ? evolutionLedger.resolveEvolutionLedgerPath({ workspacePath })
      : state?.dataDir
        ? evolutionLedger.resolveEvolutionLedgerPath({ pluginDataDir: state.dataDir, agentId })
        : null;
    if (!ledgerPath) return;
    evolutionLedger.recordClaimReviewEvolution(result, { ledgerPath, agentId });
  } catch {
    // Evolution ledger is an audit surface, not part of the claim mutation transaction.
    // If it cannot write, preserve the bounded claim action and surface the receipt text.
  }
}

function inferAction(args) {
  if (args.claim_id) return 'get';
  if (args.source_handle) return 'source';
  return 'list';
}

function validateToolArgs(args = {}, action = 'list') {
  if (!ALLOWED_ACTIONS.has(action)) {
    return `Unsupported action "${action}". Use: ${Array.from(ALLOWED_ACTIONS).join(', ')}.`;
  }
  if (args.kind !== undefined && args.kind !== null && args.kind !== '' && !KIND_VALUES.has(args.kind)) {
    return `Unsupported kind "${args.kind}". Use: ${Array.from(KIND_VALUES).join(', ')}.`;
  }
  if (args.status !== undefined && args.status !== null && args.status !== '' && !STATUS_VALUES.has(args.status)) {
    return `Unsupported status "${args.status}". Use: ${Array.from(STATUS_VALUES).join(', ')}.`;
  }
  if (args.min_confidence !== undefined && args.min_confidence !== null) {
    if (!Number.isFinite(args.min_confidence) || args.min_confidence < 0 || args.min_confidence > 1) {
      return 'min_confidence must be a number between 0 and 1.';
    }
  }
  if (args.limit !== undefined && args.limit !== null && !Number.isInteger(args.limit)) {
    return 'limit must be an integer.';
  }
  if (args.scan_limit !== undefined && args.scan_limit !== null && !Number.isInteger(args.scan_limit)) {
    return 'scan_limit must be an integer.';
  }
  if (args.research_mode !== undefined && args.research_mode !== null && args.research_mode !== '' && !RESEARCH_MODES.has(args.research_mode)) {
    return `Unsupported research_mode "${args.research_mode}". Use: ${Array.from(RESEARCH_MODES).join(', ')}.`;
  }
  if (action === 'apply_review_decision') {
    if (args.decision !== undefined && args.decision !== null && args.decision !== '' && !APPLY_REVIEW_DECISIONS.has(args.decision)) {
      return `Unsupported decision "${args.decision}". Use: ${Array.from(APPLY_REVIEW_DECISIONS).join(', ')}.`;
    }
    if (args.expected_status !== undefined && args.expected_status !== null && args.expected_status !== '' && !['verify_required', 'stale'].includes(args.expected_status)) {
      return 'expected_status for apply_review_decision must be verify_required or stale.';
    }
    if (args.apply !== undefined && args.apply !== null && typeof args.apply !== 'boolean') {
      return 'apply must be a boolean.';
    }
  }
  return null;
}

function buildFilter(args, agentId) {
  return {
    agentId,
    threadId: args.thread_id,
    kind: args.kind,
    status: args.status,
    text: args.text,
    minConfidence: Number.isFinite(args.min_confidence) ? args.min_confidence : undefined,
    limit: normalizeLimit(args.limit),
    includeSources: Boolean(args.include_sources || args.include_source_excerpts)
  };
}

function diagnosticOptions(args) {
  return {
    includeSourceExcerpts: Boolean(args.include_source_excerpts),
    includeMetadata: Boolean(args.include_metadata),
    maxExcerptChars: 240
  };
}

function normalizeLimit(value) {
  return Number.isInteger(value) ? Math.max(1, Math.min(value, 50)) : 10;
}

function normalizeScanLimit(value) {
  return Number.isInteger(value) ? Math.max(1, Math.min(value, 500)) : 100;
}

function loadCandidateResearchClaims(claimStore, filter = {}) {
  const statuses = filter.status ? [filter.status] : ['verify_required', 'stale'];
  const byId = new Map();
  for (const status of statuses) {
    for (const claim of claimStore.listClaims({ ...filter, status, includeSources: true, includeEdges: true })) {
      if (isCandidateResearchClaim(claim)) byId.set(claim.id, claim);
    }
  }
  if (!filter.status) {
    for (const claim of claimStore.listClaims({ ...filter, status: undefined, includeSources: true, includeEdges: true })) {
      if (claim?.metadata?.candidateOnly === true || isCandidateResearchClaim(claim)) byId.set(claim.id, claim);
    }
  }
  return Array.from(byId.values()).slice(0, filter.limit || 100);
}

function isCandidateResearchClaim(claim) {
  return claim?.metadata?.candidateOnly === true || claim?.status === 'verify_required' || claim?.status === 'stale';
}

function collectClaimEdges(claims = []) {
  return claims.flatMap((claim) => Array.isArray(claim.edges) ? claim.edges : []);
}

function formatAutonomyReview(review = {}, options = {}) {
  const displayLimit = Number.isInteger(options.limit) ? Math.max(1, options.limit) : 10;
  const summary = review.summary || {};
  const lines = [];
  lines.push('Claim Autonomy Review — READ ONLY DRY RUN');
  lines.push(`- dryRun: ${review.dryRun === true}`);
  lines.push(`- candidateCount: ${review.candidateCount || 0}`);
  lines.push(`- writesAttempted: ${review['mut' + 'ationAttempted'] === true}`);
  lines.push(`- promptInjectionEligibilityChanged: ${review.promptInjectionEligibilityChanged === true}`);
  lines.push(`- applyEligible: ${summary.applyEligible || 0}`);
  lines.push(`- writeAttempts: ${summary['mut' + 'ationAttempts'] || 0}`);
  lines.push(`- promptEligibilityChanges: ${summary.promptEligibilityChanges || 0}`);
  lines.push('');
  lines.push('Decisions:');
  for (const [decision, count] of sortedEntries(summary.byDecision)) lines.push(`- ${decision}: ${count}`);
  lines.push('');
  lines.push('Lanes:');
  for (const [lane, count] of sortedEntries(summary.byLane)) lines.push(`- ${lane}: ${count}`);
  lines.push('');
  lines.push('Synthesis:');
  lines.push(`- total: ${summary.synthesis?.total || 0}`);
  for (const [form, count] of sortedEntries(summary.synthesis?.byForm)) lines.push(`- ${form}: ${count}`);
  lines.push('');
  lines.push(`Receipts displayed: ${Math.min(displayLimit, review.receipts?.length || 0)}/${review.receipts?.length || 0}`);
  for (const receipt of (review.receipts || []).slice(0, displayLimit)) {
    lines.push(`- ${receipt.claimId}: ${receipt.lane} / ${receipt.policyDecision} / apply=${receipt.eligibleForApply ? 'yes' : 'no'}`);
    if (receipt.reasonCodes?.length) lines.push(`  reasons: ${receipt.reasonCodes.join(', ')}`);
  }
  return lines.join('\n');
}

function formatCandidateResearchReport(report, options = {}) {
  const displayLimit = Number.isInteger(options.limit) ? Math.max(1, options.limit) : 10;
  const lines = [];
  lines.push('Candidate Research Diagnostics — READ ONLY');
  lines.push(`- mode: ${report.mode}`);
  lines.push(`- claimsRead: ${report.safetyCounters.claimsRead}`);
  lines.push(`- candidateOnlyRead: ${report.safetyCounters.candidateOnlyRead}`);
  lines.push(`- claimsMutated: ${report.safetyCounters.claimsMutated}`);
  lines.push(`- claimsPromoted: ${report.safetyCounters.claimsPromoted}`);
  lines.push(`- promptInjectionWrites: ${report.safetyCounters.promptInjectionWrites}`);
  lines.push(`- sourceResolutionAttempted: ${report.safetyCounters.sourceResolutionAttempted}`);
  lines.push('');
  lines.push(`Verification ready: ${report.verificationReady.length}`);
  for (const item of report.verificationReady.slice(0, displayLimit)) {
    lines.push(`- ${item.candidateId}: ${item.recommendedClaimText}`);
    lines.push(`  sources: ${item.sourceHandles.join(', ')}`);
  }
  lines.push('');
  lines.push(`Tensions: ${report.tensions.length}`);
  for (const tension of report.tensions.slice(0, displayLimit)) {
    lines.push(`- ${tension.tensionId}: ${tension.candidateIds.join(' / ')}`);
    lines.push(`  resolve: ${tension.whatWouldResolveIt}`);
    lines.push(`  sources: ${tension.sourceHandles.join(', ')}`);
  }
  lines.push('');
  lines.push(`Clusters: ${report.clusters.length}`);
  for (const cluster of report.clusters.slice(0, displayLimit)) {
    lines.push(`- ${cluster.clusterId}: ${cluster.provisionalLabel}`);
    lines.push(`  members: ${cluster.memberCandidateIds.join(', ')}`);
    lines.push(`  warnings: ${cluster.warnings.join(', ') || 'none'}`);
  }
  lines.push('');
  lines.push(`Signal profiles: ${report.signalProfiles.length}`);
  lines.push(`Displayed: ${Math.min(displayLimit, report.signalProfiles.length)}/${report.signalProfiles.length}`);
  for (const profile of report.signalProfiles.slice(0, displayLimit)) {
    lines.push(`- ${profile.candidateId} [${profile.kind}/${profile.status}]`);
    lines.push(`  belief: ${profile.beliefReadiness}; assertion: ${profile.assertionUse}; research: ${profile.researchUse}`);
    lines.push(`  surfaced: ${profile.surfacedBecause.join(', ') || 'baseline'}`);
    lines.push(`  sources: ${profile.sourceHandles.join(', ')}`);
  }
  return lines.join('\n');
}

function formatSummary(claims, title) {
  if (!claims.length) return `${title}: no matching claims.`;
  const lines = [`${title}: ${claims.length} claim(s)`];
  for (const claim of claims) lines.push('', formatDiagnostic(claim));
  return lines.join('\n');
}

function formatDiagnostic(diagnostic) {
  if (!diagnostic?.ok) return `- ${diagnostic?.action || 'missing'}: ${diagnostic?.reasons?.join('; ') || 'claim not found'}`;
  const lines = [];
  lines.push(`- ${diagnostic.id} [${diagnostic.kind}/${diagnostic.status}]`);
  lines.push(`  action: ${diagnostic.action}`);
  lines.push(`  claim: ${diagnostic.claim || '(claim text hidden)'}`);
  lines.push(`  confidence: ${diagnostic.confidence}; authority: ${diagnostic.authorityRank}`);
  lines.push(`  requiresVerification: ${diagnostic.requiresVerification}`);
  if (diagnostic.reasons?.length) lines.push(`  reasons: ${diagnostic.reasons.join('; ')}`);
  if (diagnostic.speechGuidance) lines.push(`  guidance: ${diagnostic.speechGuidance}`);
  if (diagnostic.sourceCount) {
    lines.push(`  sources: ${diagnostic.sourceCount}`);
    for (const source of diagnostic.sources || []) {
      const sourceLine = [`    - ${source.handle}`, `role=${source.role || 'unknown'}`, `type=${source.sourceType || 'unknown'}`];
      if (source.quoteHash) sourceLine.push(`quoteHash=${source.quoteHash}`);
      lines.push(sourceLine.join(' '));
      if (source.excerpt) lines.push(`      excerpt: ${source.excerpt}`);
    }
  }
  if (diagnostic.metadata !== undefined) lines.push(`  metadata: ${JSON.stringify(diagnostic.metadata)}`);
  return lines.join('\n');
}

function formatStats(stats, agentId) {
  return [
    `Claim stats for ${agentId}:`,
    `- total: ${stats.total}`,
    `- sources: ${stats.sourceCount}`,
    `- edges: ${stats.edgeCount}`,
    `- byStatus: ${JSON.stringify(stats.byStatus || {})}`,
    `- byKind: ${JSON.stringify(stats.byKind || {})}`
  ].join('\n');
}

function sortedEntries(object = {}) {
  return Object.entries(object || {}).sort(([a], [b]) => a.localeCompare(b));
}

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}
