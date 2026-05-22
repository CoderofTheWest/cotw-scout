/**
 * Provenance primitives for Build 2 of the COTW Continuity Spine.
 *
 * Standalone candidate logic only. This module resolves claim source handles
 * against caller-provided resolvers and creates claim relationship edges; it
 * does not read archives, files, tools, or live OpenClaw runtime directly.
 */

const { assessClaimFreshness, CLAIM_STATUSES } = require('./claim-records');
const {
  normalizeSourceRefs,
  sourceAuthorityRank,
  strongestSourceRank
} = require('./source-handles');

const PROVENANCE_EDGE_TYPES = Object.freeze({
  CONTRADICTS: 'contradicts',
  SUPERSEDES: 'supersedes',
  SUPPORTS: 'supports',
  DEPENDS_ON: 'depends_on'
});

const EDGE_VALUES = new Set(Object.values(PROVENANCE_EDGE_TYPES));

function createClaimEdge(input = {}) {
  const relation = normalizeRelation(input.relation);
  return {
    fromClaimId: required(input.fromClaimId, 'fromClaimId'),
    toClaimId: required(input.toClaimId, 'toClaimId'),
    relation,
    sourceHandle: input.sourceHandle || null,
    createdAt: input.createdAt || new Date().toISOString(),
    metadata: input.metadata || {}
  };
}

function validateClaimEdge(edge) {
  const errors = [];
  if (!edge || typeof edge !== 'object') return { ok: false, errors: ['claim edge must be an object'] };
  if (!edge.fromClaimId) errors.push('missing fromClaimId');
  if (!edge.toClaimId) errors.push('missing toClaimId');
  if (!EDGE_VALUES.has(edge.relation)) errors.push(`unsupported relation: ${edge.relation}`);
  if (!Date.parse(edge.createdAt)) errors.push('createdAt must be parseable');
  return { ok: errors.length === 0, errors };
}

async function regroundClaimSources(claim, resolver, options = {}) {
  const sources = normalizeSourceRefs(claim?.sources || []);
  const freshness = assessClaimFreshness(claim, options);
  const resolvedSources = [];
  const unresolvedSources = [];

  for (const source of sources) {
    const resolution = await resolveSource(source, resolver);
    const record = {
      handle: source.handle,
      role: source.role,
      sourceRank: sourceAuthorityRank(source),
      resolution
    };
    if (resolution.ok) resolvedSources.push(record);
    else unresolvedSources.push(record);
  }

  const requiresVerification = freshness.requiresVerification || unresolvedSources.length > 0;
  const status = unresolvedSources.length > 0 ? CLAIM_STATUSES.VERIFY_REQUIRED : freshness.status;
  const reasons = [...freshness.reasons];
  if (unresolvedSources.length > 0) reasons.push('one or more source handles could not be resolved');
  if (sources.length === 0) reasons.push('no source handles available for re-grounding');

  return {
    ok: unresolvedSources.length === 0,
    claimId: claim?.id || null,
    status,
    requiresVerification,
    sourceCount: sources.length,
    resolvedCount: resolvedSources.length,
    unresolvedCount: unresolvedSources.length,
    strongestSourceRank: strongestSourceRank(sources),
    resolvedSources,
    unresolvedSources,
    reasons
  };
}

function summarizeProvenance(regrounding) {
  if (!regrounding || typeof regrounding !== 'object') {
    return 'No provenance result available; verify before asserting.';
  }
  if (regrounding.sourceCount === 0) {
    return 'No source handles are attached; do not treat this claim as grounded memory.';
  }
  if (regrounding.unresolvedCount > 0) {
    return `${regrounding.resolvedCount}/${regrounding.sourceCount} source handles resolved; verify before asserting.`;
  }
  if (regrounding.requiresVerification) {
    return `${regrounding.resolvedCount}/${regrounding.sourceCount} source handles resolved; current-state verification still required.`;
  }
  return `${regrounding.resolvedCount}/${regrounding.sourceCount} source handles resolved.`;
}

async function resolveSource(source, resolver) {
  if (!source.valid) {
    return { ok: false, handle: source.handle, error: source.errors.join('; ') || 'invalid source handle' };
  }
  if (!resolver) {
    return { ok: false, handle: source.handle, error: 'no resolver provided' };
  }

  try {
    const raw = await callResolver(source, resolver);
    if (!raw) return { ok: false, handle: source.handle, error: 'resolver returned no result' };
    if (raw.ok === false) return { ok: false, handle: source.handle, error: raw.error || 'resolver failed', metadata: raw.metadata || {} };
    return {
      ok: true,
      handle: source.handle,
      sourceType: raw.sourceType || raw.source_type || source.handle.split(':', 1)[0],
      content: raw.content || '',
      timestamp: raw.timestamp || null,
      metadata: raw.metadata || {}
    };
  } catch (err) {
    return { ok: false, handle: source.handle, error: err.message };
  }
}

async function callResolver(source, resolver) {
  if (typeof resolver === 'function') return resolver(source);
  if (resolver instanceof Map) return resolver.get(source.handle);
  if (typeof resolver === 'object') return resolver[source.handle];
  return null;
}

function normalizeRelation(relation) {
  if (!EDGE_VALUES.has(relation)) throw new Error(`Unsupported provenance relation: ${relation}`);
  return relation;
}

function required(value, name) {
  if (value === undefined || value === null || value === '') throw new Error(`Missing required field: ${name}`);
  return value;
}


module.exports = {
  PROVENANCE_EDGE_TYPES,
  createClaimEdge,
  validateClaimEdge,
  regroundClaimSources,
  summarizeProvenance
};
