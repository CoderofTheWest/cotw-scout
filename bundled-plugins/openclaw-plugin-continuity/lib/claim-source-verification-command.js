const { createSourceResolver } = require('./source-resolver');
const { buildResolverOptions } = require('./claim-source-resolution-command');

const MUTATING_FLAGS = new Set(['--apply', '--promote', '--verify', '--consume', '--inject', '--mutate', '--accept', '--accept-verified']);
const DEFAULT_MAX_CONTENT_CHARS = 800;
const MAX_CONTENT_CHARS = 4000;
const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'into', 'onto', 'can', 'could', 'would', 'should',
  'has', 'have', 'had', 'was', 'were', 'are', 'is', 'be', 'been', 'being', 'not', 'but', 'or', 'as',
  'of', 'to', 'in', 'on', 'by', 'an', 'a', 'it', 'its', 'at'
]);

async function runClaimSourceVerificationCommand(params = {}) {
  const args = parseClaimSourceVerificationArgs(params.args || '');
  if (args.parseError) return args.parseError;

  const agentId = typeof params.getCurrentAgentId === 'function' ? params.getCurrentAgentId() : 'main';
  const state = params.getAgentState(agentId);

  try {
    if (state?.ensureStorage) await state.ensureStorage();
  } catch (err) {
    return `Claim source verification helper unavailable: ${err.message}`;
  }

  if (!state?.claimStore) {
    return 'Claim source verification helper unavailable: ClaimStore is not initialized for this agent. Runtime defaults may still be inert.';
  }

  const resolver = typeof params.createResolver === 'function'
    ? params.createResolver({ state, agentId, args })
    : createSourceResolver(buildResolverOptions({ state, config: params.config, workspaceDir: params.workspaceDir }));

  try {
    return await compareClaimToSource({ state, resolver, args });
  } catch (err) {
    return `Claim source verification helper failed: ${err.message}`;
  }
}

function parseClaimSourceVerificationArgs(input) {
  const tokens = tokenizeArgs(input);
  if (tokens[0] && !tokens[0].startsWith('--')) {
    const action = tokens.shift().toLowerCase();
    if (action !== 'compare') return { parseError: `Unsupported action "${action}". Use: compare.` };
  }

  const parsed = {
    maxContentChars: DEFAULT_MAX_CONTENT_CHARS,
    includeClaimText: false,
    includeMetadata: false
  };
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

    if (MUTATING_FLAGS.has(token)) {
      setParseError(`${token} is not supported here. Verification helpers are read-only guidance: no verification decision, promotion, mutation, consumption, or prompt injection.`);
      continue;
    }
    if (token === '--claim-id' || token === '--id') {
      const value = readValue(token);
      if (value) parsed.claimId = value;
      continue;
    }
    if (token === '--source-handle' || token === '--handle') {
      const value = readValue(token);
      if (value) parsed.sourceHandle = value;
      continue;
    }
    if (token === '--max-content-chars') {
      const value = readValue('--max-content-chars');
      const number = Number(value);
      if (value && Number.isInteger(number)) parsed.maxContentChars = normalizeMaxContentChars(number);
      else if (value) setParseError('Option "--max-content-chars" requires an integer value.');
      continue;
    }
    if (token === '--claim-text') {
      parsed.includeClaimText = true;
      continue;
    }
    if (token === '--metadata') {
      parsed.includeMetadata = true;
      continue;
    }
    if (token.startsWith('--')) {
      setParseError(`Unsupported option "${token}".`);
      continue;
    }
    setParseError(`Unexpected argument "${token}". Use --claim-id and --source-handle.`);
  }

  if (!parsed.claimId) parsed.parseError = 'compare action requires --claim-id.';
  if (!parsed.sourceHandle) parsed.parseError = 'compare action requires --source-handle.';
  return parsed;
}

async function compareClaimToSource({ state, resolver, args }) {
  const claim = state.claimStore.getClaim(args.claimId);
  if (!claim) {
    return renderBoundaryReceipt({
      lines: [`- Claim: ${args.claimId}`, '- Result: claim not found.'],
      summary: 'No source resolution or comparison attempted because the claim id was not found.',
      sourceResolutionAttempted: false,
      comparisonAttempted: false
    });
  }

  const source = (claim.sources || []).find((item) => item.handle === args.sourceHandle);
  if (!source) {
    return renderBoundaryReceipt({
      lines: [
        `- Claim: ${claim.id} [${claim.kind}/${claim.status}]`,
        `- Source handle: ${args.sourceHandle}`,
        '- Result: source handle is not attached to this claim.'
      ],
      summary: 'No source resolution or comparison attempted because the exact source handle is not attached to the claim.',
      sourceResolutionAttempted: false,
      comparisonAttempted: false
    });
  }

  const resolution = await resolver(args.sourceHandle);
  if (!resolution?.ok) {
    return renderBoundaryReceipt({
      lines: [
        `- Claim: ${claim.id} [${claim.kind}/${claim.status}]`,
        `- Source handle: ${args.sourceHandle}`,
        '- Resolution: unresolved',
        `- Error: ${resolution?.error || 'unresolved'}`
      ],
      summary: 'Source could not be resolved; do not treat the claim as verified.',
      sourceResolutionAttempted: true,
      comparisonAttempted: false
    });
  }

  const comparison = compareTextToSource(claim.claim, resolution.content || '');
  const lines = [
    `- Claim: ${claim.id} [${claim.kind}/${claim.status}]`,
    `- Source handle: ${args.sourceHandle}`,
    '- Resolution: resolved',
    `- Assessment: ${comparison.assessment}`,
    `- Claim token coverage: ${comparison.coverage.toFixed(2)}`,
    `- Exact normalized phrase: ${comparison.exactPhrase ? 'yes' : 'no'}`,
    `- Recommendation: ${comparison.recommendation}`,
    `- Missing claim tokens: ${comparison.missingTokens.length ? comparison.missingTokens.join(', ') : 'none'}`,
    '',
    `sourceType: ${resolution.sourceType || 'unknown'}`,
    `content: ${truncateContent(resolution.content || '', args.maxContentChars)}`
  ];
  if (args.includeClaimText) lines.splice(3, 0, `- Claim text: ${truncateContent(claim.claim, args.maxContentChars)}`);
  if (resolution.timestamp) lines.push(`timestamp: ${resolution.timestamp}`);
  if (args.includeMetadata && resolution.metadata) lines.push(`metadata: ${JSON.stringify(resolution.metadata)}`);

  return renderBoundaryReceipt({
    lines,
    summary: comparison.summary,
    sourceResolutionAttempted: true,
    comparisonAttempted: true
  });
}

function compareTextToSource(claimText, sourceText) {
  const normalizedClaim = normalizeText(claimText);
  const normalizedSource = normalizeText(sourceText);
  const claimTokens = significantTokens(claimText);
  const sourceTokens = new Set(significantTokens(sourceText));
  const matchedTokens = claimTokens.filter((token) => sourceTokens.has(token));
  const missingTokens = claimTokens.filter((token) => !sourceTokens.has(token));
  const coverage = claimTokens.length ? matchedTokens.length / claimTokens.length : 0;
  const exactPhrase = normalizedClaim.length > 0 && normalizedSource.includes(normalizedClaim);

  if (exactPhrase) {
    return {
      assessment: 'source_contains_claim_text',
      coverage: 1,
      exactPhrase,
      missingTokens: [],
      recommendation: 'operator_may_use_separate_accept_verified_decision_if_current_state_policy_is_satisfied',
      summary: 'Source contains the normalized claim text; this helper still made no verification decision.'
    };
  }
  if (coverage >= 0.75) {
    return {
      assessment: 'source_likely_supports_claim',
      coverage,
      exactPhrase,
      missingTokens: missingTokens.slice(0, 12),
      recommendation: 'operator_should_review_source_then_use_separate_decision_if_satisfied',
      summary: 'Source has high lexical overlap with the claim; operator review is still required before any verification decision.'
    };
  }
  if (coverage >= 0.45) {
    return {
      assessment: 'source_partially_overlaps_claim',
      coverage,
      exactPhrase,
      missingTokens: missingTokens.slice(0, 12),
      recommendation: 'do_not_promote_without_additional_evidence_or_a_narrower_claim',
      summary: 'Source partially overlaps the claim; additional evidence or a narrower superseding claim is needed.'
    };
  }
  return {
    assessment: 'source_does_not_show_enough_overlap',
    coverage,
    exactPhrase,
    missingTokens: missingTokens.slice(0, 12),
    recommendation: 'do_not_promote_claim_from_this_source',
    summary: 'Source does not show enough overlap with the claim; do not verify or promote from this source alone.'
  };
}

function renderBoundaryReceipt({ lines = [], summary, sourceResolutionAttempted, comparisonAttempted }) {
  return [
    'Claim Source Verification Helper — READ ONLY',
    '',
    ...lines,
    '',
    'Boundaries:',
    `- sourceResolutionAttempted: ${sourceResolutionAttempted ? 'yes' : 'no'}`,
    `- comparisonAttempted: ${comparisonAttempted ? 'yes' : 'no'}`,
    '- verificationDecisionAttempted: no',
    '- mutationAttempted: no',
    '- promotionAttempted: no',
    '- consumptionAttempted: no',
    '- promptInjectionAttempted: no',
    '',
    `Summary: ${summary}`
  ].join('\n');
}

function significantTokens(value) {
  return unique(String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token)));
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateContent(value, maxChars) {
  const text = String(value || '');
  if (text.length <= maxChars) return text || '(empty)';
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function normalizeMaxContentChars(value) {
  return Math.max(80, Math.min(Number(value), MAX_CONTENT_CHARS));
}

function unique(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
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
  runClaimSourceVerificationCommand,
  parseClaimSourceVerificationArgs,
  compareTextToSource
};
