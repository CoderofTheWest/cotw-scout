const { CLAIM_KINDS, FRESHNESS_POLICIES, assessClaimFreshness } = require('./claim-records');
const { normalizeSourceRefs, sourceAuthorityRank } = require('./source-handles');

const REPORT_VERSION = 1;
const REPORT_MODES = new Set(['map', 'verification', 'creative', 'stale-risk', 'calibration']);
const DEFAULT_OPTIONS = Object.freeze({
  maxCandidates: 50,
  maxClusters: 12,
  maxTensions: 12,
  lexicalSimilarityThreshold: 0.72,
  noMutate: true
});

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'before', 'by', 'can', 'for', 'from', 'has', 'have',
  'in', 'into', 'is', 'it', 'its', 'not', 'now', 'of', 'on', 'or', 'rather', 'should', 'still', 'than',
  'that', 'the', 'their', 'then', 'there', 'this', 'to', 'was', 'were', 'with', 'without'
]);

const CREATIVE_LABELS = Object.freeze({
  interpretation: 'design hypothesis',
  summary: 'exploratory synthesis',
  project_state: 'possible product direction'
});

function createCandidateResearchReport(input = {}) {
  const mode = REPORT_MODES.has(input.mode) ? input.mode : 'map';
  const options = { ...DEFAULT_OPTIONS, ...(input.options || {}) };
  const now = input.now || new Date().toISOString();
  const allClaims = normalizeClaims(input.claims || [], { agentId: input.agentId, threadId: input.threadId });
  const candidates = allClaims
    .filter((claim) => isResearchCandidate(claim))
    .slice(0, options.maxCandidates);

  const profiles = candidates.map((claim) => createSignalProfile(claim, {
    allClaims: candidates,
    edges: input.edges || [],
    now,
    mode,
    options
  }));

  const relationships = deriveRelationships(profiles, input.edges || [], options);
  const tensions = deriveTensions(profiles, relationships, options);
  applyTensionInterest(profiles, tensions);
  const clusters = deriveClusters(profiles, relationships, options);
  const verificationReady = deriveVerificationReady(profiles, tensions, mode);
  const decayRecommendations = deriveDecayRecommendations(profiles);
  const creativeOpportunities = mode === 'creative' ? deriveCreativeOpportunities(profiles, clusters) : [];
  const openQuestions = deriveOpenQuestions(profiles, tensions);
  const calibrationPrompts = mode === 'calibration' ? deriveCalibrationPrompts(profiles, clusters, tensions) : [];

  return {
    reportVersion: REPORT_VERSION,
    mode,
    generatedAt: now,
    scope: {
      agentId: input.agentId || null,
      threadId: input.threadId || null,
      claimCount: allClaims.length,
      candidateCount: candidates.length
    },
    safetyCounters: {
      claimsRead: allClaims.length,
      candidateOnlyRead: candidates.filter((claim) => claim.metadata?.candidateOnly === true).length,
      claimsMutated: 0,
      claimsPromoted: 0,
      promptInjectionWrites: 0,
      synthesisRecordsWritten: 0,
      trustedContextCandidates: 0,
      mutationAttempted: false,
      sourceResolutionAttempted: false
    },
    signalProfiles: orderProfiles(profiles, mode),
    relationships,
    clusters,
    tensions,
    verificationReady,
    decayRecommendations,
    openQuestions,
    creativeOpportunities,
    calibrationPrompts
  };
}

function normalizeClaims(claims, defaults = {}) {
  return (Array.isArray(claims) ? claims : []).map((claim) => {
    const sources = normalizeSourceRefs(claim.sources || claim.sourceHandles || [], { defaultRole: 'evidence' });
    return {
      ...claim,
      id: claim.id || claim.claimId,
      agentId: claim.agentId || defaults.agentId || 'trail-guide',
      threadId: claim.threadId || defaults.threadId || null,
      status: claim.status || 'verify_required',
      confidence: Number.isFinite(claim.confidence) ? claim.confidence : 0.5,
      authorityRank: Number.isFinite(claim.authorityRank)
        ? claim.authorityRank
        : Math.max(0, ...sources.map(sourceAuthorityRank)),
      createdAt: claim.createdAt || claim.created_at || new Date(0).toISOString(),
      updatedAt: claim.updatedAt || claim.updated_at || claim.createdAt || claim.created_at || new Date(0).toISOString(),
      freshness: {
        lastVerifiedAt: claim.lastVerifiedAt || claim.freshness?.lastVerifiedAt || claim.freshness?.last_verified_at || null,
        expiresAfter: claim.expiresAfter || claim.freshness?.expiresAfter || claim.freshness?.expires_after || null,
        stalenessPolicy: claim.stalenessPolicy || claim.freshness?.stalenessPolicy || claim.freshness?.staleness_policy || defaultPolicyFor(claim.kind)
      },
      sources,
      metadata: claim.metadata || {},
      edges: Array.isArray(claim.edges) ? claim.edges : []
    };
  }).filter((claim) => claim.id && claim.claim);
}

function isResearchCandidate(claim) {
  return claim?.metadata?.candidateOnly === true || claim?.status === 'verify_required' || claim?.status === 'stale';
}

function createSignalProfile(claim, context) {
  const sourceHandles = getSourceHandles(claim);
  const sourceDiversity = calculateSourceDiversity(claim, context.allClaims);
  const tokens = tokenize(claim.claim);
  const specificity = scoreSpecificity(claim.claim, tokens);
  const staleRisk = scoreStaleRisk(claim, context.now);
  const authority = clamp((claim.authorityRank || 0) / 5);
  const recency = scoreRecency(claim.updatedAt, context.now);
  const recurrence = scoreRecurrence(claim, context.allClaims);
  const projectSalience = scoreProjectSalience(claim, tokens);
  const usefulness = clamp((specificity * 0.35) + (sourceDiversity * 0.2) + (projectSalience * 0.2) + (authority * 0.15) + (recurrence * 0.1));
  const freshness = safeFreshness(claim, context.now);
  const warnings = profileWarnings(claim, { sourceDiversity, staleRisk, specificity });
  const beliefReadiness = getBeliefReadiness(claim, { specificity, staleRisk, sourceHandles, warnings });
  const assertionUse = getAssertionUse(claim, { beliefReadiness, staleRisk, freshness });
  const researchUse = getResearchUse(claim, warnings);

  return {
    candidateId: claim.id,
    claim: claim.claim,
    kind: claim.kind,
    status: claim.status,
    candidateOnly: claim.metadata?.candidateOnly === true,
    sourceHandles,
    signalVector: {
      recurrence,
      sourceDiversity,
      recency,
      authority,
      specificity,
      projectSalience,
      usefulness,
      tensionInterest: 0,
      staleRisk
    },
    surfacedBecause: surfacedBecause({ recurrence, sourceDiversity, staleRisk, specificity, projectSalience, warnings }),
    beliefReadiness,
    researchUse,
    assertionUse,
    warnings,
    creativeLabel: creativeLabelFor(claim),
    _claim: claim,
    _tokens: tokens,
    _sourceRootKeys: sourceRootKeys(claim)
  };
}

function deriveRelationships(profiles, edges, options) {
  const relationships = [];
  const byId = new Map(profiles.map((profile) => [profile.candidateId, profile]));

  for (const edge of Array.isArray(edges) ? edges : []) {
    const from = byId.get(edge.fromClaimId || edge.fromCandidateId);
    const to = byId.get(edge.toClaimId || edge.toCandidateId);
    if (!from || !to) continue;
    relationships.push({
      fromCandidateId: from.candidateId,
      toCandidateId: to.candidateId,
      relation: normalizeRelation(edge.relation),
      strength: 1,
      reasons: ['explicit_claim_edge'],
      sourceHandles: compactHandles([edge.sourceHandle, ...from.sourceHandles, ...to.sourceHandles])
    });
  }

  for (let i = 0; i < profiles.length; i += 1) {
    for (let j = i + 1; j < profiles.length; j += 1) {
      const a = profiles[i];
      const b = profiles[j];
      if (hasRelationship(relationships, a.candidateId, b.candidateId)) continue;
      const relation = inferRelationship(a, b, options);
      if (!relation) continue;
      relationships.push({
        fromCandidateId: a.candidateId,
        toCandidateId: b.candidateId,
        relation: relation.relation,
        strength: relation.strength,
        reasons: relation.reasons,
        sourceHandles: compactHandles([...a.sourceHandles, ...b.sourceHandles])
      });
    }
  }

  return relationships;
}

function inferRelationship(a, b, options) {
  const jaccard = tokenJaccard(a._tokens, b._tokens);
  const cosine = tokenCosine(a._tokens, b._tokens);
  const similarity = Math.max(jaccard, cosine);
  const sameKind = a.kind === b.kind;

  if (contradictionLikely(a.claim, b.claim)) {
    return { relation: 'contradicts', strength: round(Math.max(0.72, similarity)), reasons: ['mutually_exclusive_language'] };
  }
  if (sameKind && (similarity >= options.lexicalSimilarityThreshold || similarity >= 0.45)) {
    return { relation: 'duplicates', strength: round(similarity), reasons: ['high_lexical_overlap', 'same_kind'] };
  }
  if (similarity >= 0.30 && sameKind) {
    const specificityDelta = a.signalVector.specificity - b.signalVector.specificity;
    if (Math.abs(specificityDelta) >= 0.18) {
      return {
        relation: specificityDelta > 0 ? 'narrows' : 'broadens',
        strength: round(similarity),
        reasons: ['related_terms', 'specificity_delta']
      };
    }
    return { relation: 'reinforces', strength: round(similarity), reasons: ['moderate_lexical_overlap', 'same_kind'] };
  }
  if (sharesAny(a._sourceRootKeys, b._sourceRootKeys) && (similarity >= 0.12 || sameKind)) {
    return { relation: 'reinforces', strength: round(similarity), reasons: ['shared_source_root', 'related_terms'] };
  }
  if (isQuestionLike(a.claim) || isQuestionLike(b.claim)) {
    if (similarity >= 0.25) return { relation: 'asks', strength: round(similarity), reasons: ['open_question_shape'] };
  }
  return null;
}

function deriveTensions(profiles, relationships, options) {
  const byId = new Map(profiles.map((profile) => [profile.candidateId, profile]));
  return relationships
    .filter((relationship) => relationship.relation === 'contradicts')
    .slice(0, options.maxTensions)
    .map((relationship, index) => {
      const candidates = [byId.get(relationship.fromCandidateId), byId.get(relationship.toCandidateId)].filter(Boolean);
      return {
        tensionId: `tension_${index + 1}`,
        candidateIds: candidates.map((candidate) => candidate.candidateId),
        type: 'contradiction',
        whyItMatters: 'These candidates cannot both be asserted without resolving current evidence.',
        whatWouldResolveIt: resolutionActionFor(candidates),
        assertionRisk: candidates.some((candidate) => candidate.assertionUse !== 'forbidden') ? 'high' : 'contained',
        sourceHandles: compactHandles([...relationship.sourceHandles, ...candidates.flatMap((candidate) => candidate.sourceHandles)])
      };
    });
}

function applyTensionInterest(profiles, tensions) {
  const tensionIds = new Set(tensions.flatMap((tension) => tension.candidateIds));
  for (const profile of profiles) {
    profile.signalVector.tensionInterest = tensionIds.has(profile.candidateId) ? 1 : 0;
    if (tensionIds.has(profile.candidateId) && !profile.surfacedBecause.includes('tension')) {
      profile.surfacedBecause.push('tension');
    }
  }
}

function deriveClusters(profiles, relationships, options) {
  const parent = new Map(profiles.map((profile) => [profile.candidateId, profile.candidateId]));
  const find = (id) => {
    let current = id;
    while (parent.get(current) !== current) current = parent.get(current);
    return current;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };

  for (const relationship of relationships) {
    if (relationship.relation === 'contradicts') continue;
    union(relationship.fromCandidateId, relationship.toCandidateId);
  }

  const groups = new Map();
  for (const profile of profiles) {
    const root = find(profile.candidateId);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(profile);
  }

  return [...groups.values()]
    .filter((members) => members.length > 1)
    .sort((a, b) => b.length - a.length)
    .slice(0, options.maxClusters)
    .map((members, index) => createCluster(members, index));
}

function createCluster(members, index) {
  const sourceHandles = compactHandles(members.flatMap((member) => member.sourceHandles));
  const common = commonTokens(members.map((member) => member._tokens));
  const topTerms = common.length ? common.slice(0, 5) : topTokens(members.flatMap((member) => member._tokens), 5);
  const label = topTerms.length ? `${topTerms.join(' ')} candidates` : 'related candidate records';
  const alternateLabels = alternateLabelsFor(topTerms, members);
  const warnings = compact([
    sourceDiversityForProfiles(members) <= 0.34 && 'source_collapse',
    members.some((member) => member.warnings.includes('broad_claim')) && 'broad_claim',
    members.some((member) => member.signalVector.staleRisk >= 0.75) && 'stale_risk'
  ]);

  return {
    clusterId: `cluster_${index + 1}`,
    provisionalLabel: label,
    alternateLabels,
    memberCandidateIds: members.map((member) => member.candidateId),
    evidenceFirstSummary: `${members.length} candidate(s), ${sourceHandles.length} visible source handle(s): ${members.map((member) => member.candidateId).join(', ')}`,
    dominantKinds: topValues(members.map((member) => member.kind), 3),
    uncertaintySummary: warnings.length ? `Warnings: ${warnings.join(', ')}` : 'No deterministic contradiction detected; still candidate-only.',
    maturityStage: clusterMaturityStage(members, warnings),
    sourceDiversity: sourceDiversityForProfiles(members),
    warnings
  };
}

function deriveVerificationReady(profiles, tensions, mode) {
  const tensionIds = new Set(tensions.flatMap((tension) => tension.candidateIds));
  return profiles
    .filter((profile) => {
      if (profile.beliefReadiness !== 'verification_possible') return false;
      if (profile.sourceHandles.length < 1) return false;
      if (profile.signalVector.specificity < 0.6) return false;
      if (profile.signalVector.staleRisk >= 0.75) return false;
      if (tensionIds.has(profile.candidateId)) return false;
      if (profile.kind === CLAIM_KINDS.IDENTITY) return false;
      if (profile._claim.metadata?.creativeOnly === true) return false;
      return true;
    })
    .sort((a, b) => b.signalVector.specificity - a.signalVector.specificity)
    .map((profile) => ({
      candidateId: profile.candidateId,
      recommendedClaimText: profile.claim,
      readinessReasons: compact([
        'has_source_handle',
        'specific_claim_text',
        profile.signalVector.staleRisk < 0.4 && 'low_stale_risk',
        mode === 'verification' && 'verification_mode'
      ]),
      unresolvedRisks: [],
      sourceHandles: profile.sourceHandles
    }));
}

function deriveDecayRecommendations(profiles) {
  return profiles
    .filter((profile) => profile.signalVector.staleRisk >= 0.75 || profile.warnings.includes('source_collapse'))
    .map((profile) => ({
      candidateId: profile.candidateId,
      decayReason: profile.signalVector.staleRisk >= 0.75 ? 'stale_runtime_or_project_state' : 'source_collapse',
      recommendedAction: profile.signalVector.staleRisk >= 0.75 ? 'live_verify_or_archive_open' : 'review_source_diversity_before_weighting',
      sourceHandles: profile.sourceHandles
    }));
}

function deriveCreativeOpportunities(profiles, clusters) {
  const fromProfiles = profiles
    .filter((profile) => profile.kind === CLAIM_KINDS.INTERPRETATION || profile._claim.metadata?.creativeOnly === true)
    .map((profile) => ({
      candidateId: profile.candidateId,
      label: profile.creativeLabel || 'exploratory synthesis',
      prompt: profile.claim,
      assertionUse: 'forbidden',
      sourceHandles: profile.sourceHandles
    }));
  const fromClusters = clusters.map((cluster) => ({
    clusterId: cluster.clusterId,
    label: 'exploratory synthesis',
    prompt: cluster.provisionalLabel,
    assertionUse: 'forbidden',
    sourceHandles: compactHandles(cluster.memberCandidateIds)
  }));
  return [...fromProfiles, ...fromClusters];
}

function deriveOpenQuestions(profiles, tensions) {
  const questions = [];
  for (const profile of profiles) {
    if (isQuestionLike(profile.claim) || profile.warnings.includes('broad_claim')) {
      questions.push({
        candidateId: profile.candidateId,
        question: profile.warnings.includes('broad_claim') ? 'What narrower, source-backed claim could be checked here?' : profile.claim,
        sourceHandles: profile.sourceHandles
      });
    }
  }
  for (const tension of tensions) {
    questions.push({
      tensionId: tension.tensionId,
      question: tension.whatWouldResolveIt,
      sourceHandles: tension.sourceHandles
    });
  }
  return questions;
}

function deriveCalibrationPrompts(profiles, clusters, tensions) {
  return [{
    prompt: 'Which surfaced candidates were actually useful, and which were merely well phrased?',
    candidateIds: profiles.map((profile) => profile.candidateId),
    clusterIds: clusters.map((cluster) => cluster.clusterId),
    tensionIds: tensions.map((tension) => tension.tensionId)
  }];
}

function orderProfiles(profiles, mode) {
  const sorted = [...profiles];
  if (mode === 'verification') sorted.sort((a, b) => verificationSort(b) - verificationSort(a));
  else if (mode === 'stale-risk') sorted.sort((a, b) => b.signalVector.staleRisk - a.signalVector.staleRisk);
  else if (mode === 'creative') sorted.sort((a, b) => creativeSort(b) - creativeSort(a));
  else sorted.sort((a, b) => b.signalVector.usefulness - a.signalVector.usefulness);
  return sorted.map((profile) => stripPrivate(profile));
}

function stripPrivate(profile) {
  const { _claim, _tokens, _sourceRootKeys, ...publicProfile } = profile;
  return publicProfile;
}

function verificationSort(profile) {
  return (profile.beliefReadiness === 'verification_possible' ? 2 : 0) + profile.signalVector.specificity - profile.signalVector.staleRisk;
}

function creativeSort(profile) {
  return (profile.kind === CLAIM_KINDS.INTERPRETATION ? 2 : 0) + (profile._claim.metadata?.creativeOnly ? 2 : 0) + profile.signalVector.tensionInterest;
}

function safeFreshness(claim, now) {
  try {
    return assessClaimFreshness(claim, { now });
  } catch {
    return { requiresVerification: true, reasons: ['freshness_assessment_failed'], status: claim.status || 'verify_required' };
  }
}

function getBeliefReadiness(claim, facts) {
  if (claim.metadata?.creativeOnly === true) return 'not_eligible';
  if (claim.kind === CLAIM_KINDS.IDENTITY) return 'not_eligible';
  if (facts.warnings.includes('broad_claim')) return 'not_eligible';
  if (facts.sourceHandles.length >= 1 && facts.specificity >= 0.6 && facts.staleRisk < 0.75) return 'verification_possible';
  return 'not_eligible';
}

function getAssertionUse(claim, facts) {
  if (claim.metadata?.candidateOnly === true) {
    if (claim.kind === CLAIM_KINDS.RUNTIME || claim.kind === CLAIM_KINDS.PROJECT_STATE || facts.staleRisk >= 0.75) {
      return 'requires_live_verification';
    }
    return 'forbidden';
  }
  if (facts.freshness.requiresVerification) return 'requires_live_verification';
  return 'verified_only';
}

function getResearchUse(claim, warnings) {
  if (claim.status === 'retracted') return 'exclude';
  if (warnings.includes('source_collapse') || warnings.includes('broad_claim')) return 'limited';
  return 'eligible';
}

function surfacedBecause(facts) {
  return compact([
    facts.recurrence >= 0.45 && 'recurrence',
    facts.sourceDiversity >= 0.4 && 'source_diversity',
    facts.staleRisk >= 0.75 && 'stale_risk',
    facts.specificity >= 0.6 && 'specificity',
    facts.projectSalience >= 0.6 && 'project_salience',
    ...facts.warnings.map((warning) => `warning:${warning}`)
  ]);
}

function profileWarnings(claim, facts) {
  return compact([
    facts.sourceDiversity <= 0.2 && getSourceHandles(claim).length > 1 && 'source_collapse',
    facts.staleRisk >= 0.75 && 'stale_risk',
    claim.kind === CLAIM_KINDS.IDENTITY && 'identity_review_required',
    isBroadClaim(claim.claim) && 'broad_claim',
    claim.metadata?.creativeOnly === true && 'creative_only'
  ]);
}

function scoreRecurrence(claim, allClaims) {
  const explicit = Number(claim.metadata?.recurrenceCount);
  if (Number.isFinite(explicit) && explicit > 1) return clamp(Math.min(1, explicit / 5));
  const tokens = tokenize(claim.claim);
  const similar = allClaims.filter((other) => other.id !== claim.id && tokenJaccard(tokens, tokenize(other.claim)) >= 0.42).length;
  return clamp(similar / 4);
}

function calculateSourceDiversity(claim, allClaims = []) {
  const handles = getSourceHandles(claim);
  if (!handles.length) return 0;
  const roots = sourceRootKeys(claim);
  if (claim.metadata?.rootSourceHandle) {
    const sameRootCount = allClaims.filter((other) => sourceRootKeys(other).includes(claim.metadata.rootSourceHandle)).length;
    if (sameRootCount > 1) return clamp(roots.length / sameRootCount);
  }
  return clamp(roots.length / handles.length);
}

function sourceDiversityForProfiles(profiles) {
  const handles = compactHandles(profiles.flatMap((profile) => profile.sourceHandles));
  if (!handles.length) return 0;
  const roots = new Set(profiles.flatMap((profile) => profile._sourceRootKeys));
  return clamp(roots.size / Math.max(1, profiles.length));
}

function sourceRootKeys(claim) {
  const root = claim.metadata?.rootSourceHandle;
  if (root) return [root];
  return [...new Set(getSourceHandles(claim).map((handle) => {
    if (handle.startsWith('digest:')) return handle;
    if (handle.startsWith('handoff:')) return handle.replace(/#L\d+-L\d+$/, '');
    if (handle.startsWith('archive:')) return handle.replace(/#e[^#]+$/, '');
    if (handle.startsWith('file:')) return handle.replace(/#L\d+-L\d+$/, '');
    return handle;
  }))];
}

function getSourceHandles(claim) {
  return compactHandles((claim.sources || []).map((source) => source.handle));
}

function scoreRecency(updatedAt, now) {
  const ageDays = daysBetween(updatedAt, now);
  if (!Number.isFinite(ageDays)) return 0;
  if (ageDays <= 1) return 1;
  if (ageDays <= 7) return 0.75;
  if (ageDays <= 30) return 0.45;
  return 0.15;
}

function scoreStaleRisk(claim, now) {
  const ageDays = daysBetween(claim.updatedAt, now);
  let risk = 0;
  if (claim.kind === CLAIM_KINDS.RUNTIME) risk += 0.55;
  if (claim.kind === CLAIM_KINDS.PROJECT_STATE) risk += 0.35;
  if (claim.freshness?.stalenessPolicy === FRESHNESS_POLICIES.RUNTIME_CHECK_REQUIRED) risk += 0.3;
  if (claim.freshness?.stalenessPolicy === FRESHNESS_POLICIES.VERIFY_BEFORE_ASSERTING) risk += 0.12;
  if (Number.isFinite(ageDays)) {
    if (ageDays > 14) risk += 0.35;
    else if (ageDays > 7) risk += 0.25;
    else if (ageDays > 1) risk += 0.12;
  }
  return clamp(risk);
}

function scoreSpecificity(text, tokens) {
  let score = 0.1;
  if (tokens.length >= 5) score += 0.15;
  if (/\b\d{4}[-/]\d{2}[-/]\d{2}\b|\b\d+\b/.test(text)) score += 0.15;
  if (/[\w.-]+\/[\w./-]+/.test(text) || /\.(js|json|md|ts|cjs)\b/.test(text)) score += 0.32;
  if (/\b(commit|gateway|module|script|fixture|source handle|claim|runtime|file|repo|repository)\b/i.test(text)) score += 0.15;
  if (isBroadClaim(text)) score -= 0.3;
  return clamp(score);
}

function scoreProjectSalience(claim, tokens) {
  let score = 0;
  if (claim.kind === CLAIM_KINDS.PROJECT_STATE) score += 0.35;
  if (claim.kind === CLAIM_KINDS.RUNTIME) score += 0.25;
  if (tokens.some((token) => ['build', 'prd', 'repo', 'repository', 'module', 'diagnostics', 'gateway', 'claim'].includes(token))) score += 0.35;
  if (claim.threadId) score += 0.1;
  return clamp(score);
}

function tokenJaccard(a, b) {
  const left = new Set(a);
  const right = new Set(b);
  if (!left.size || !right.size) return 0;
  const intersection = [...left].filter((item) => right.has(item)).length;
  const union = new Set([...left, ...right]).size;
  return intersection / union;
}

function sharedTokenCount(a, b) {
  const right = new Set(b);
  return [...new Set(a)].filter((token) => right.has(token)).length;
}

function tokenCosine(a, b) {
  const left = termFreq(a);
  const right = termFreq(b);
  const terms = new Set([...Object.keys(left), ...Object.keys(right)]);
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (const term of terms) {
    dot += (left[term] || 0) * (right[term] || 0);
  }
  for (const value of Object.values(left)) magA += value * value;
  for (const value of Object.values(right)) magB += value * value;
  if (!magA || !magB) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function termFreq(tokens) {
  return tokens.reduce((acc, token) => {
    acc[token] = (acc[token] || 0) + 1;
    return acc;
  }, {});
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[`'"“”‘’]/g, '')
    .replace(/[^a-z0-9_./-]+/g, ' ')
    .split(/\s+/)
    .map(tinyStem)
    .filter((token) => token && !STOP_WORDS.has(token) && token.length > 1);
}

function tinyStem(token) {
  if (token.length > 6 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 5 && token.endsWith('ed')) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith('s')) return token.slice(0, -1);
  return token;
}

function contradictionLikely(a, b) {
  const left = String(a || '').toLowerCase();
  const right = String(b || '').toLowerCase();
  if (left.includes('already') && /still needs|not yet|needs to be/.test(right)) return true;
  if (right.includes('already') && /still needs|not yet|needs to be/.test(left)) return true;
  if (/ enabled\b/.test(left) && / disabled\b/.test(right)) return true;
  if (/ disabled\b/.test(left) && / enabled\b/.test(right)) return true;
  if (/ owns? /.test(left) && /not .*owns? /.test(right)) return true;
  if (/ owns? /.test(right) && /not .*owns? /.test(left)) return true;
  return false;
}

function normalizeRelation(relation) {
  if (relation === 'contradicts') return 'contradicts';
  if (relation === 'supports') return 'reinforces';
  if (relation === 'depends_on') return 'depends_on';
  if (relation === 'supersedes') return 'contradicts';
  return relation || 'related';
}

function hasRelationship(relationships, a, b) {
  return relationships.some((relationship) => {
    const ids = [relationship.fromCandidateId, relationship.toCandidateId];
    return ids.includes(a) && ids.includes(b);
  });
}

function resolutionActionFor(candidates) {
  if (candidates.some((candidate) => candidate.kind === CLAIM_KINDS.RUNTIME)) return 'verify_current_runtime_state';
  if (candidates.some((candidate) => candidate.kind === CLAIM_KINDS.PROJECT_STATE)) return 'verify_current_git_and_remote_state';
  return 'compare_source_handles_before_asserting';
}

function clusterMaturityStage(members, warnings) {
  if (warnings.includes('source_collapse')) return 'source_collapsed';
  if (members.some((member) => member.signalVector.tensionInterest > 0)) return 'tension_visible';
  if (sourceDiversityForProfiles(members) >= 0.7 && members.length >= 2) return 'research_weighted';
  return 'candidate_only';
}

function alternateLabelsFor(topTerms, members) {
  const labels = [];
  if (topTerms.length) labels.push(`${topTerms.slice(0, 3).join(' ')} evidence`);
  if (members.some((member) => member.kind === CLAIM_KINDS.INTERPRETATION)) labels.push('evidence before meaning');
  if (members.some((member) => member.kind === CLAIM_KINDS.PROJECT_STATE)) labels.push('project state candidates');
  labels.push('diagnostic reports');
  return [...new Set(labels)].slice(0, 3);
}

function commonTokens(groups) {
  if (!groups.length) return [];
  const [first, ...rest] = groups.map((group) => new Set(group));
  return [...first]
    .filter((token) => rest.every((group) => group.has(token)))
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function topTokens(tokens, limit) {
  const counts = termFreq(tokens);
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([token]) => token);
}

function topValues(values, limit) {
  const counts = values.reduce((acc, value) => {
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([value]) => value);
}

function sharesAny(a, b) {
  const left = new Set(a);
  return b.some((item) => left.has(item));
}

function isQuestionLike(text) {
  return /\?$|\bwhat\b|\bhow\b/i.test(String(text || ''));
}

function isBroadClaim(text) {
  return /\bself-aware\b|\bbecoming\b|\balways\b|\bnever\b|\beverything\b|\bnothing\b/i.test(String(text || ''));
}

function creativeLabelFor(claim) {
  if (claim.metadata?.creativeOnly === true) return CREATIVE_LABELS[claim.kind] || 'exploratory synthesis';
  return null;
}

function compactHandles(handles) {
  return [...new Set((handles || []).filter(Boolean))];
}

function compact(items) {
  return items.filter(Boolean);
}

function daysBetween(then, now) {
  const a = Date.parse(then);
  const b = Date.parse(now);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  return Math.max(0, (b - a) / 86400000);
}

function defaultPolicyFor(kind) {
  if (kind === CLAIM_KINDS.RUNTIME) return FRESHNESS_POLICIES.RUNTIME_CHECK_REQUIRED;
  if (kind === CLAIM_KINDS.IDENTITY) return FRESHNESS_POLICIES.EVERGREEN;
  return FRESHNESS_POLICIES.VERIFY_BEFORE_ASSERTING;
}

function clamp(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function round(value) {
  return Math.round(value * 100) / 100;
}

module.exports = {
  REPORT_VERSION,
  createCandidateResearchReport
};
