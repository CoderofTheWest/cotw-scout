const { summarizeClaimStore } = require('./claim-diagnostics');
const { createClaimContextPacket, renderClaimContextPacket, renderClaimContextAudit } = require('./claim-context');
const { createClaimConsumptionTrialPlan, renderClaimConsumptionTrialPlan } = require('./claim-context-trial');
const { createClaimContextVerificationPlan, renderClaimContextVerificationPlan } = require('./claim-context-verification-plan');
const { createClaimContextPreflight, renderClaimContextPreflight } = require('./claim-context-preflight');
const { createClaimContextManualReview, renderClaimContextManualReview } = require('./claim-context-manual-review');
const { createCandidateResearchReport } = require('./candidate-research-diagnostics');
const { CLAIM_KINDS, CLAIM_STATUSES } = require('./claim-records');

const ALLOWED_ACTIONS = new Set(['stats', 'list', 'verify', 'context', 'audit', 'trial', 'verification', 'preflight', 'review', 'research']);
const RESEARCH_MODES = new Set(['map', 'verification', 'creative', 'stale-risk', 'calibration']);
const MAX_COMMAND_LIMIT = 25;
const MAX_SCAN_LIMIT = 500;
const DEFAULT_CONTEXT_SCAN_LIMIT = 100;
const DEFAULT_RESEARCH_SCAN_LIMIT = 100;
const KIND_VALUES = new Set(Object.values(CLAIM_KINDS));
const STATUS_VALUES = new Set(Object.values(CLAIM_STATUSES));

async function runClaimsDiagnosticsCommand(params = {}) {
  const args = parseClaimsDiagnosticsArgs(params.args || '');
  if (args.parseError) return args.parseError;
  const agentId = typeof params.getCurrentAgentId === 'function' ? params.getCurrentAgentId() : 'main';
  const state = params.getAgentState(agentId);

  try {
    if (state?.ensureStorage) await state.ensureStorage();
  } catch (err) {
    return `Source-addressable claim diagnostics unavailable: ${err.message}`;
  }

  if (!state?.claimStore) {
    return 'Source-addressable claim diagnostics unavailable: ClaimStore is not initialized for this agent. Runtime defaults may still be inert.';
  }

  if (args.action === 'stats') {
    const stats = state.claimStore.getStats(agentId);
    return formatStats(stats, agentId);
  }

  const filter = {
    agentId,
    threadId: args.threadId,
    kind: args.kind,
    status: args.status,
    text: args.text,
    minConfidence: args.minConfidence,
    limit: args.limit,
    includeSources: false
  };

  if (args.action === 'verify') {
    const claims = state.claimStore.getClaimsNeedingVerification(filter);
    return formatCommandSummary(claims.map((claim) => createSafeCommandDiagnostic(claim)), 'Claims requiring verification');
  }

  if (args.action === 'research') {
    const scanLimit = args.scanLimit || Math.max(args.limit, DEFAULT_RESEARCH_SCAN_LIMIT);
    const claims = loadCandidateResearchClaims(state.claimStore, { ...filter, limit: scanLimit });
    const report = createCandidateResearchReport({
      claims,
      edges: collectClaimEdges(claims),
      mode: args.mode || 'map',
      now: args.now,
      agentId,
      threadId: args.threadId,
      options: {
        maxCandidates: scanLimit,
        maxClusters: args.limit,
        maxTensions: args.limit,
        noMutate: true
      }
    });
    return renderCandidateResearchCommandReport(report, { limit: args.limit });
  }

  if (isContextLikeAction(args.action)) {
    const scanLimit = args.scanLimit || Math.max(args.limit, DEFAULT_CONTEXT_SCAN_LIMIT);
    const claims = state.claimStore.listClaims({ ...filter, limit: scanLimit, includeSources: true, includeEdges: false });
    const packet = createClaimContextPacket(claims, { limit: args.limit, includeSourceExcerpts: false, includeFixtures: args.includeFixtures });
    if (args.action === 'trial') {
      const plan = createClaimConsumptionTrialPlan({ packet });
      return renderClaimConsumptionTrialPlan(plan);
    }
    if (args.action === 'verification') {
      const plan = createClaimContextVerificationPlan({ packet });
      return renderClaimContextVerificationPlan(plan);
    }
    if (args.action === 'preflight') {
      const preflight = createClaimContextPreflight({ packet });
      return renderClaimContextPreflight(preflight);
    }
    if (args.action === 'review') {
      const review = createClaimContextManualReview({ packet });
      return renderClaimContextManualReview(review);
    }
    if (args.action === 'audit') return renderClaimContextAudit(packet.audit);
    return renderClaimContextPacket(packet, { includeSourceExcerpts: false });
  }

  const summary = summarizeClaimStore(state.claimStore, filter, commandDiagnosticOptions());
  return formatCommandSummary(summary.claims, 'Claim diagnostics');
}

function parseClaimsDiagnosticsArgs(input) {
  const tokens = tokenizeArgs(input);
  let action = 'stats';
  if (tokens[0] && !tokens[0].startsWith('--')) {
    action = tokens.shift().toLowerCase();
  }
  if (!ALLOWED_ACTIONS.has(action)) {
    return {
      action: 'stats',
      parseError: `Unsupported action "${action}". Use: stats, list, verify, context, audit, trial, verification, preflight, review, or research.`
    };
  }

  const parsed = {
    action,
    limit: 10,
    scanLimit: null
  };
  const freeText = [];
  const setParseError = (message) => {
    if (!parsed.parseError) parsed.parseError = message;
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const readValue = (option) => {
      const value = tokens[++i];
      if (!value || value.startsWith('--')) {
        if (value?.startsWith('--')) i -= 1;
        setParseError(`Option "${option}" requires a value.`);
        return undefined;
      }
      return value;
    };

    if (token === '--sources' || token === '--source' || token === '--excerpts' || token === '--metadata') {
      setParseError('Source flags, source excerpts, and metadata are intentionally unavailable through this narrow command. Use action=context for safe source-handle context, or the exact read-only tool path for deeper diagnostics.');
      continue;
    }
    if (token === '--include-fixtures') {
      parsed.includeFixtures = true;
      continue;
    }
    if (token === '--mode') {
      const value = readValue('--mode');
      if (value && RESEARCH_MODES.has(value)) parsed.mode = value;
      else if (value) setParseError(`Unsupported research mode "${value}". Use: ${Array.from(RESEARCH_MODES).join(', ')}.`);
      continue;
    }
    if (token === '--now') {
      const value = readValue('--now');
      if (value && Date.parse(value)) parsed.now = value;
      else if (value) setParseError('Option "--now" requires an ISO-8601 timestamp.');
      continue;
    }
    if (token === '--limit') {
      const value = readValue('--limit');
      const number = Number(value);
      if (value && Number.isInteger(number)) parsed.limit = normalizeLimit(value);
      else if (value) setParseError('Option "--limit" requires an integer value.');
      continue;
    }
    if (token === '--scan-limit') {
      const value = readValue('--scan-limit');
      const number = Number(value);
      if (value && Number.isInteger(number)) parsed.scanLimit = normalizeScanLimit(value);
      else if (value) setParseError('Option "--scan-limit" requires an integer value.');
      continue;
    }
    if (token === '--status') {
      const value = readValue('--status');
      if (value && STATUS_VALUES.has(value)) parsed.status = value;
      else if (value) setParseError(`Unsupported status "${value}". Use: ${Array.from(STATUS_VALUES).join(', ')}.`);
      continue;
    }
    if (token === '--kind') {
      const value = readValue('--kind');
      if (value && KIND_VALUES.has(value)) parsed.kind = value;
      else if (value) setParseError(`Unsupported kind "${value}". Use: ${Array.from(KIND_VALUES).join(', ')}.`);
      continue;
    }
    if (token === '--thread') {
      const value = readValue('--thread');
      if (value) parsed.threadId = value;
      continue;
    }
    if (token === '--text') {
      const value = readValue('--text');
      if (value) parsed.text = value;
      continue;
    }
    if (token === '--min-confidence') {
      const value = readValue('--min-confidence');
      const number = Number(value);
      if (value && Number.isFinite(number) && number >= 0 && number <= 1) parsed.minConfidence = number;
      else if (value) setParseError('Option "--min-confidence" requires a number between 0 and 1.');
      continue;
    }
    if (token.startsWith('--')) {
      setParseError(`Unsupported option "${token}".`);
      continue;
    }
    freeText.push(token);
  }

  if (!parsed.text && freeText.length > 0) parsed.text = freeText.join(' ');
  return parsed;
}

function isContextLikeAction(action) {
  return action === 'context' || action === 'audit' || action === 'trial' || action === 'verification' || action === 'preflight' || action === 'review';
}

function commandDiagnosticOptions() {
  return {
    includeSources: false,
    includeSourceExcerpts: false,
    includeMetadata: false
  };
}

function createSafeCommandDiagnostic(claim) {
  return summarizeClaimStore({ listClaims: () => [claim] }, {}, commandDiagnosticOptions()).claims[0];
}

function loadCandidateResearchClaims(claimStore, filter = {}) {
  const statuses = filter.status ? [filter.status] : [CLAIM_STATUSES.VERIFY_REQUIRED, CLAIM_STATUSES.STALE];
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
  return Array.from(byId.values()).slice(0, filter.limit || DEFAULT_RESEARCH_SCAN_LIMIT);
}

function isCandidateResearchClaim(claim) {
  return claim?.metadata?.candidateOnly === true || claim?.status === CLAIM_STATUSES.VERIFY_REQUIRED || claim?.status === CLAIM_STATUSES.STALE;
}

function collectClaimEdges(claims = []) {
  return claims.flatMap((claim) => Array.isArray(claim.edges) ? claim.edges : []);
}

function renderCandidateResearchCommandReport(report, options = {}) {
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

function formatCommandSummary(claims, title) {
  if (!claims.length) return `${title}: no matching claims.`;
  const lines = [`${title}: ${claims.length} claim(s)`];
  for (const claim of claims) {
    lines.push('');
    lines.push(`- ${claim.id} [${claim.kind}/${claim.status}]`);
    lines.push(`  action: ${claim.action}`);
    lines.push(`  claim: ${claim.claim || '(claim text hidden)'}`);
    lines.push(`  confidence: ${claim.confidence}; authority: ${claim.authorityRank}`);
    lines.push(`  requiresVerification: ${claim.requiresVerification}`);
    if (claim.reasons?.length) lines.push(`  reasons: ${claim.reasons.join('; ')}`);
    if (claim.speechGuidance) lines.push(`  guidance: ${claim.speechGuidance}`);
    if (claim.sourceCount) lines.push(`  sources: ${claim.sourceCount} source(s), hidden by default`);
  }
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

function normalizeLimit(value) {
  const number = Number(value);
  if (!Number.isInteger(number)) return 10;
  return Math.max(1, Math.min(number, MAX_COMMAND_LIMIT));
}

function normalizeScanLimit(value) {
  const number = Number(value);
  if (!Number.isInteger(number)) return DEFAULT_CONTEXT_SCAN_LIMIT;
  return Math.max(1, Math.min(number, MAX_SCAN_LIMIT));
}

function tokenizeArgs(input) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(String(input || '')))) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

module.exports = {
  runClaimsDiagnosticsCommand,
  parseClaimsDiagnosticsArgs,
  tokenizeArgs
};
