const { createClaimReviewDecision, renderClaimReviewDecision, REVIEW_DECISIONS } = require('./claim-review-decision');
const { FRESHNESS_POLICIES } = require('./claim-records');
const { createSourceResolver } = require('./source-resolver');
const { buildResolverOptions } = require('./claim-source-resolution-command');
const { compareTextToSource } = require('./claim-source-verification-command');

const DECISION_VALUES = new Set(Object.values(REVIEW_DECISIONS));
const STALENESS_POLICY_VALUES = new Set([
  FRESHNESS_POLICIES.EVERGREEN,
  FRESHNESS_POLICIES.USER_CORRECTION_WINS,
  FRESHNESS_POLICIES.EXPIRES_AFTER
]);

async function runClaimReviewDecisionCommand(params = {}) {
  const args = parseClaimReviewDecisionArgs(params.args || '');
  if (args.parseError) return args.parseError;
  const agentId = typeof params.getCurrentAgentId === 'function' ? params.getCurrentAgentId() : 'main';
  const state = params.getAgentState(agentId);

  try {
    if (state?.ensureStorage) await state.ensureStorage();
  } catch (err) {
    return `Claim review decision unavailable: ${err.message}`;
  }

  if (!state?.claimStore) {
    return 'Claim review decision unavailable: ClaimStore is not initialized for this agent. Runtime defaults may still be inert.';
  }

  try {
    if (args.decision === REVIEW_DECISIONS.ACCEPT_VERIFIED) {
      if (!args.sourceHandle) return 'Claim review decision failed: accept_verified decision requires a sourceHandle';
      if (!args.acceptedStalenessPolicy) return 'Claim review decision failed: accept_verified decision requires an acceptedStalenessPolicy';
    }

    const verificationEvidence = await buildAcceptVerifiedEvidence({
      params,
      state,
      config: params.config,
      workspaceDir: params.workspaceDir,
      agentId,
      args
    });
    if (verificationEvidence?.error) return `Claim review decision failed: ${verificationEvidence.error}`;

    const result = createClaimReviewDecision({
      claimStore: state.claimStore,
      agentId,
      claimId: args.claimId,
      decision: args.decision,
      reason: args.reason,
      sourceHandle: args.sourceHandle,
      supersededBy: args.supersededBy,
      acceptedStalenessPolicy: args.acceptedStalenessPolicy,
      verificationEvidence,
      apply: args.apply === true
    });
    return renderClaimReviewDecision(result);
  } catch (err) {
    return `Claim review decision failed: ${err.message}`;
  }
}

async function buildAcceptVerifiedEvidence({ params, state, config, workspaceDir, agentId, args }) {
  if (args.decision !== REVIEW_DECISIONS.ACCEPT_VERIFIED) return null;
  const claim = state.claimStore.getClaim(args.claimId);
  if (!claim) return { error: `claim not found: ${args.claimId}` };
  if (agentId && claim.agentId !== agentId) return { error: `claim ${args.claimId} does not belong to agent ${agentId}` };
  const source = (claim.sources || []).find((item) => item.handle === args.sourceHandle);
  if (!source) return { error: `source handle is not attached to claim: ${args.sourceHandle}` };

  const resolver = typeof params.createResolver === 'function'
    ? params.createResolver({ state, agentId, args })
    : createSourceResolver(buildResolverOptions({ state, config, workspaceDir }));
  const resolution = await resolver(args.sourceHandle);
  if (!resolution?.ok) return { error: `source resolution failed for accept_verified: ${resolution?.error || 'unresolved'}` };

  const comparison = compareTextToSource(claim.claim, resolution.content || '');
  if (!['source_contains_claim_text', 'source_likely_supports_claim'].includes(comparison.assessment)) {
    return { error: `source comparison is not strong enough for accept_verified: ${comparison.assessment}` };
  }
  return {
    sourceResolved: true,
    comparisonAttempted: true,
    assessment: comparison.assessment,
    coverage: comparison.coverage,
    exactPhrase: comparison.exactPhrase,
    sourceHandle: args.sourceHandle,
    checkedAt: new Date().toISOString()
  };
}

function parseClaimReviewDecisionArgs(input) {
  const tokens = tokenizeArgs(input);
  const parsed = { apply: false };
  const freeText = [];
  const setParseError = (message) => {
    if (!parsed.parseError) parsed.parseError = message;
  };

  if (tokens[0] && !tokens[0].startsWith('--')) {
    parsed.decision = tokens.shift().toLowerCase();
  }

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

    if (token === '--apply') {
      parsed.apply = true;
      continue;
    }
    if (token === '--dry-run') {
      parsed.apply = false;
      continue;
    }
    if (token === '--claim-id' || token === '--claim' || token === '--id') {
      const value = readValue(token);
      if (value) parsed.claimId = value;
      continue;
    }
    if (token === '--decision') {
      const value = readValue('--decision');
      if (value) parsed.decision = value.toLowerCase();
      continue;
    }
    if (token === '--reason') {
      const value = readValue('--reason');
      if (value) parsed.reason = value;
      continue;
    }
    if (token === '--source-handle' || token === '--source') {
      const value = readValue(token);
      if (value) parsed.sourceHandle = value;
      continue;
    }
    if (token === '--superseded-by') {
      const value = readValue('--superseded-by');
      if (value) parsed.supersededBy = value;
      continue;
    }
    if (token === '--accepted-staleness-policy' || token === '--staleness-policy') {
      const value = readValue(token);
      if (value) parsed.acceptedStalenessPolicy = value;
      continue;
    }
    if (token === '--sources' || token === '--excerpts' || token === '--metadata' || token === '--resolve') {
      setParseError('Source resolution, excerpts, and metadata display are intentionally unavailable through this decision command. Provide an explicit source handle instead.');
      continue;
    }
    if (token.startsWith('--')) {
      setParseError(`Unsupported option "${token}".`);
      continue;
    }
    freeText.push(token);
  }

  if (!parsed.reason && freeText.length > 0) parsed.reason = freeText.join(' ');
  if (!parsed.decision) setParseError(`Decision is required. Use: ${Array.from(DECISION_VALUES).join(', ')}.`);
  else if (!DECISION_VALUES.has(parsed.decision)) setParseError(`Unsupported decision "${parsed.decision}". Use: ${Array.from(DECISION_VALUES).join(', ')}.`);
  if (!parsed.claimId) setParseError('Option "--claim-id" is required.');
  if (parsed.acceptedStalenessPolicy && !STALENESS_POLICY_VALUES.has(parsed.acceptedStalenessPolicy)) {
    setParseError(`Unsupported accepted staleness policy "${parsed.acceptedStalenessPolicy}". Use: ${Array.from(STALENESS_POLICY_VALUES).join(', ')}.`);
  }

  return parsed;
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
  runClaimReviewDecisionCommand,
  parseClaimReviewDecisionArgs,
  tokenizeArgs
};
