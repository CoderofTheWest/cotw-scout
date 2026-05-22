const { CLAIM_KINDS, FRESHNESS_POLICIES, createClaimRecord, validateClaimRecord } = require('./claim-records');
const { parseSourceHandle } = require('./source-handles');

const FIXTURE_SEEDS = Object.freeze({
  MANUAL_REVIEW_CLEAN_CLAIM: 'manual_review_clean_claim'
});

const FIXTURE_VALUES = new Set(Object.values(FIXTURE_SEEDS));

function createClaimFixtureSeed(input = {}, options = {}) {
  const claimStore = input.claimStore;
  if (!claimStore) throw new Error('claimStore is required');
  const fixture = normalizeFixture(input.fixture || input.name);
  const agentId = input.agentId || 'trail-guide';
  const claimText = requiredString(input.claim, 'claim');
  const sourceHandle = requiredString(input.sourceHandle, 'sourceHandle');
  const reason = String(input.reason || '').trim();
  const apply = input.apply === true;
  const now = options.now || input.now || new Date().toISOString();

  if (apply && !reason) throw new Error('apply=true requires a reason');
  validateFixtureSourceHandle(sourceHandle);

  const claim = createClaimRecord({
    agentId,
    threadId: input.threadId || 'main',
    kind: CLAIM_KINDS.SUMMARY,
    claim: claimText,
    stalenessPolicy: FRESHNESS_POLICIES.EVERGREEN,
    sources: [{
      handle: sourceHandle,
      role: 'evidence',
      excerpt: input.excerpt || ''
    }],
    metadata: {
      operatorSeeded: true,
      fixtureOnly: true,
      seedFixture: fixture,
      candidateOnly: false,
      reason: reason || null
    }
  }, { now });

  const validation = validateClaimRecord(claim);
  if (!validation.ok) throw new Error(`Invalid fixture claim: ${validation.errors.join('; ')}`);

  if (apply) claimStore.storeClaim(claim);

  return {
    ok: true,
    dryRun: !apply,
    mutationAttempted: apply,
    promotionAttempted: false,
    fixture,
    claimId: claim.id,
    agentId: claim.agentId,
    threadId: claim.threadId,
    kind: claim.kind,
    status: claim.status,
    stalenessPolicy: claim.freshness?.stalenessPolicy || null,
    sourceHandle,
    sourceType: parseSourceHandle(sourceHandle).type,
    boundaries: [
      'operator fixture seed only',
      'dry-run by default; apply=true required to write',
      'requires explicit source handle',
      'commit source handles only',
      'does not inject prompt context',
      'does not consume context automatically',
      'does not resolve source handles',
      'does not verify existing claims',
      'does not promote existing claims'
    ]
  };
}

function renderClaimFixtureSeed(result = {}) {
  const lines = [];
  lines.push('# Claim Fixture Seed');
  lines.push('');
  lines.push(`- Dry run: ${result.dryRun === true ? 'yes' : 'no'}`);
  lines.push(`- Mutation attempted: ${result.mutationAttempted === true ? 'yes' : 'no'}`);
  lines.push(`- Promotion attempted: ${result.promotionAttempted === true ? 'yes' : 'no'}`);
  lines.push(`- Fixture: ${result.fixture || 'unknown'}`);
  lines.push(`- Claim: ${result.claimId || 'unknown'} [${result.kind || 'unknown'}/${result.status || 'unknown'}]`);
  lines.push(`- Staleness policy: ${result.stalenessPolicy || 'unknown'}`);
  lines.push(`- Source handle: ${result.sourceHandle || 'none'}`);
  lines.push('');
  lines.push('## Boundaries');
  for (const boundary of result.boundaries || []) lines.push(`- ${boundary}`);
  return lines.join('\n');
}

function normalizeFixture(value) {
  const fixture = String(value || '').trim();
  if (!FIXTURE_VALUES.has(fixture)) {
    throw new Error(`unsupported fixture "${fixture || '(empty)'}"; use: ${Array.from(FIXTURE_VALUES).join(', ')}`);
  }
  return fixture;
}

function validateFixtureSourceHandle(handle) {
  const parsed = parseSourceHandle(handle);
  if (!parsed.ok) throw new Error(`invalid sourceHandle: ${(parsed.errors || []).join('; ')}`);
  if (parsed.type !== 'commit') throw new Error('fixture seed requires a commit sourceHandle');
}

function requiredString(value, name) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

module.exports = {
  FIXTURE_SEEDS,
  createClaimFixtureSeed,
  renderClaimFixtureSeed
};
