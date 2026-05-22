const path = require('path');
const { createSourceResolver } = require('./source-resolver');
const { regroundClaimSources, summarizeProvenance } = require('./provenance');

const ALLOWED_ACTIONS = new Set(['claim', 'handle']);
const MUTATING_FLAGS = new Set(['--apply', '--promote', '--verify', '--consume', '--inject', '--mutate']);
const MAX_SOURCE_LIMIT = 10;
const DEFAULT_MAX_CONTENT_CHARS = 800;
const MAX_CONTENT_CHARS = 4000;

async function runClaimSourceResolutionCommand(params = {}) {
  const args = parseClaimSourceResolutionArgs(params.args || '');
  if (args.parseError) return args.parseError;

  const agentId = typeof params.getCurrentAgentId === 'function' ? params.getCurrentAgentId() : 'main';
  const state = params.getAgentState(agentId);

  try {
    if (state?.ensureStorage) await state.ensureStorage();
  } catch (err) {
    return `Claim source resolution unavailable: ${err.message}`;
  }

  if (!state?.claimStore) {
    return 'Claim source resolution unavailable: ClaimStore is not initialized for this agent. Runtime defaults may still be inert.';
  }

  const resolver = typeof params.createResolver === 'function'
    ? params.createResolver({ state, agentId, args })
    : createSourceResolver(buildResolverOptions({ state, config: params.config, workspaceDir: params.workspaceDir }));

  try {
    if (args.action === 'handle') {
      return await resolveHandle({ state, resolver, agentId, args });
    }
    return await resolveClaim({ state, resolver, args });
  } catch (err) {
    return `Claim source resolution failed: ${err.message}`;
  }
}

function parseClaimSourceResolutionArgs(input) {
  const tokens = tokenizeArgs(input);
  let action = 'claim';
  if (tokens[0] && !tokens[0].startsWith('--')) {
    action = tokens.shift().toLowerCase();
  }
  if (!ALLOWED_ACTIONS.has(action)) {
    return { action: 'claim', parseError: `Unsupported action "${action}". Use: claim or handle.` };
  }

  const parsed = {
    action,
    limit: MAX_SOURCE_LIMIT,
    maxContentChars: DEFAULT_MAX_CONTENT_CHARS,
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
      setParseError(`${token} is not supported here. Source resolution is read-only: no verification, promotion, mutation, consumption, or prompt injection.`);
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
    if (token === '--limit') {
      const value = readValue('--limit');
      const number = Number(value);
      if (value && Number.isInteger(number)) parsed.limit = normalizeLimit(number);
      else if (value) setParseError('Option "--limit" requires an integer value.');
      continue;
    }
    if (token === '--max-content-chars') {
      const value = readValue('--max-content-chars');
      const number = Number(value);
      if (value && Number.isInteger(number)) parsed.maxContentChars = normalizeMaxContentChars(number);
      else if (value) setParseError('Option "--max-content-chars" requires an integer value.');
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
    setParseError(`Unexpected argument "${token}". Use --claim-id or --source-handle.`);
  }

  if (parsed.action === 'claim' && !parsed.claimId) {
    parsed.parseError = 'claim action requires --claim-id.';
  }
  if (parsed.action === 'handle' && !parsed.sourceHandle) {
    parsed.parseError = 'handle action requires --source-handle.';
  }
  return parsed;
}

async function resolveClaim({ state, resolver, args }) {
  const claim = state.claimStore.getClaim(args.claimId);
  if (!claim) {
    return renderBoundaryReceipt({
      title: 'Claim Source Resolution',
      lines: [`- Claim: ${args.claimId}`, '- Result: claim not found.'],
      summary: 'No source resolution attempted because the claim id was not found.',
      sourceResolutionAttempted: false
    });
  }

  const limitedClaim = { ...claim, sources: (claim.sources || []).slice(0, args.limit) };
  const regrounding = await regroundClaimSources(limitedClaim, resolver, { now: new Date().toISOString() });
  const lines = [
    `- Claim: ${claim.id} [${claim.kind}/${claim.status}]`,
    `- Source count: ${claim.sources?.length || 0}`,
    `- Sources resolved this run: ${regrounding.resolvedCount}/${regrounding.sourceCount}`,
    `- Provenance summary: ${summarizeProvenance(regrounding)}`,
    '',
    ...formatResolvedSources([...regrounding.resolvedSources, ...regrounding.unresolvedSources], args)
  ];

  return renderBoundaryReceipt({
    title: 'Claim Source Resolution',
    lines,
    summary: summarizeProvenance(regrounding),
    sourceResolutionAttempted: true
  });
}

async function resolveHandle({ state, resolver, agentId, args }) {
  const resolution = await resolver(args.sourceHandle);
  const claims = typeof state.claimStore.getClaimsBySourceHandle === 'function'
    ? state.claimStore.getClaimsBySourceHandle(args.sourceHandle, { agentId, includeSources: false, limit: args.limit })
    : [];

  const lines = [
    `- Source handle: ${args.sourceHandle}`,
    `- Resolution: ${resolution.ok ? 'resolved' : 'unresolved'}`,
    `- Claims using source: ${claims.length}`
  ];
  if (claims.length) lines.push(`- Claim ids: ${claims.map((claim) => claim.id).join(', ')}`);
  lines.push('', ...formatDirectResolution(resolution, args));

  return renderBoundaryReceipt({
    title: 'Claim Source Resolution',
    lines,
    summary: resolution.ok ? '1/1 source handles resolved; current-state verification still required.' : '0/1 source handles resolved; verify before asserting.',
    sourceResolutionAttempted: true
  });
}

function formatResolvedSources(records, args) {
  if (!records.length) return ['Sources: none.'];
  return records.flatMap((record, index) => {
    const resolution = record.resolution || {};
    return [
      `Source ${index + 1}:`,
      `  handle: ${record.handle}`,
      `  role: ${record.role || 'unknown'}`,
      `  rank: ${record.sourceRank ?? 0}`,
      `  resolution: ${resolution.ok ? 'resolved' : 'unresolved'}`,
      ...(resolution.ok ? formatDirectResolution(resolution, args).map((line) => `  ${line}`) : [`  error: ${resolution.error || 'unresolved'}`])
    ];
  });
}

function formatDirectResolution(resolution, args) {
  if (!resolution?.ok) return [`error: ${resolution?.error || 'unresolved'}`];
  const lines = [
    `sourceType: ${resolution.sourceType || 'unknown'}`,
    `content: ${truncateContent(resolution.content || '', args.maxContentChars)}`
  ];
  if (resolution.timestamp) lines.push(`timestamp: ${resolution.timestamp}`);
  if (args.includeMetadata && resolution.metadata) lines.push(`metadata: ${JSON.stringify(resolution.metadata)}`);
  return lines;
}

function renderBoundaryReceipt({ title, lines = [], summary, sourceResolutionAttempted }) {
  return [
    `${title} — READ ONLY`,
    '',
    ...lines,
    '',
    'Boundaries:',
    `- sourceResolutionAttempted: ${sourceResolutionAttempted ? 'yes' : 'no'}`,
    '- verificationAttempted: no',
    '- mutationAttempted: no',
    '- promotionAttempted: no',
    '- consumptionAttempted: no',
    '- promptInjectionAttempted: no',
    '',
    `Summary: ${summary}`
  ].join('\n');
}

function buildResolverOptions({ state, config = {}, workspaceDir } = {}) {
  const resolvedWorkspaceDir = workspaceDir
    || config.sessionHandoff?.workspacePath
    || state?.knowledgeIndexer?.workspacePath
    || process.env.OPENCLAW_WORKSPACE
    || path.join(require('os').homedir(), '.openclaw', 'workspace');
  return {
    workspaceDir: resolvedWorkspaceDir,
    handoffDirs: [
      path.join(resolvedWorkspaceDir, 'memory', 'handoffs'),
      resolvedWorkspaceDir
    ],
    archiver: state?.archiver,
    activeThreadDigestStore: state?.activeThreadDigestStore || null,
    summaryStore: state?.summaryStore || null
  };
}

function truncateContent(value, maxChars) {
  const text = String(value || '');
  if (text.length <= maxChars) return text || '(empty)';
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function normalizeLimit(value) {
  return Math.max(1, Math.min(Number(value), MAX_SOURCE_LIMIT));
}

function normalizeMaxContentChars(value) {
  return Math.max(80, Math.min(Number(value), MAX_CONTENT_CHARS));
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
  runClaimSourceResolutionCommand,
  parseClaimSourceResolutionArgs,
  buildResolverOptions
};
