/**
 * openclaw-plugin-evidence-quality / lib / evaluator.js
 *
 * The substrate-density evaluator. Given a scope (entity, person, topic,
 * exchange-window, or speaker), returns a structured quality assessment that
 * downstream synthesis stages use as a refuse-and-log gate.
 *
 * Core principle: confidence in synthesis output should be coupled to
 * evidence density of input. Every synthesis stage (contemplation pass,
 * standing nightshift, crystallization, reconstruction) calls this BEFORE
 * issuing an LLM call. If sufficient=false, the stage refuses with a
 * structured "insufficient evidence" response — never a confident output
 * with a `provisional: true` label.
 *
 * Read-only against:
 *   - graph.db (entities, triples, cooccurrences)
 *   - continuity.db (exchanges, with Phase-3 speakerId metadata)
 *
 * Returns a uniform shape regardless of scope kind. Callers can either
 * use the rollup (sufficient/confidence) or inspect the dimensions
 * directly for finer-grained gating.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

let Database;
try { Database = require('better-sqlite3'); } catch (_) { Database = null; }

// ---------------------------------------------------------------------------
// DB path resolution — same shape as trust-circle's resolveDB pattern.
//
// G1 fallback chain (first-existing wins):
//   1. Bundled-sibling layout — when this plugin lives in a bundled-plugins/
//      directory next to openclaw-plugin-{continuity,graph}, those plugins
//      write their DBs under their own data/agents/<id>/ subdir. We resolve
//      relative to __dirname so the path works regardless of install root.
//   2. Workspace-env layout — OPENCLAW_WORKSPACE/agents/<id>/<db>.db.
//      Used when the deployment routes plugin data into the workspace.
//   3. Home-relative — ~/.openclaw/agents/<id>/<db>.db. Last-resort generic.
//   4. Clint legacy — kept so Clint's running gateway keeps resolving its
//      own DBs at the historical /Users/clint/robot/... locations.
// ---------------------------------------------------------------------------

function _bundledSiblingDB(siblingPlugin, agentId, dbFile) {
  // __dirname here is openclaw-plugin-evidence-quality/lib/
  // siblings live at ../../<siblingPlugin>/
  return path.join(__dirname, '..', '..', siblingPlugin, 'data', 'agents', agentId, dbFile);
}

function _workspaceDB(agentId, dbFile) {
  const ws = process.env.OPENCLAW_WORKSPACE;
  if (!ws) return null;
  return path.join(ws, 'agents', agentId, dbFile);
}

function _firstExisting(candidates) {
  for (const p of candidates) {
    if (!p) continue;
    try { if (fs.statSync(p).size > 0) return p; } catch (_) {}
  }
  return null;
}

function resolveContinuityDB(agentId) {
  return _firstExisting([
    _bundledSiblingDB('openclaw-plugin-continuity', agentId, 'continuity.db'),
    _workspaceDB(agentId, 'continuity.db'),
    path.join(os.homedir(), '.openclaw', 'agents', agentId, 'continuity.db'),
    `/Users/clint/robot/openclaw-plugin-continuity/data/agents/${agentId}/continuity.db`,
  ]);
}

function resolveGraphDB(agentId) {
  return _firstExisting([
    _bundledSiblingDB('openclaw-plugin-graph', agentId, 'graph.db'),
    _workspaceDB(agentId, 'graph.db'),
    path.join(os.homedir(), '.openclaw', 'agents', agentId, 'graph.db'),
    `/Users/clint/robot/openclaw-plugin-graph/data/agents/${agentId}/graph.db`,
  ]);
}

function openReadOnly(dbPath) {
  if (!Database) return null;
  if (!dbPath) return null;
  try { return new Database(dbPath, { readonly: true, fileMustExist: true }); }
  catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// Realness signals — cheap heuristics on the entity name itself
// ---------------------------------------------------------------------------

// Code keywords / common English words the extractor frequently mislabels as
// PERSON/ORGANIZATION. Initial set was hand-curated from offenders observed
// during plugin development; the list applies universally — these are STRUCTURAL
// patterns that no agent should ever contemplate, regardless of corpus.
const COMMON_NOISE_TOKENS = new Set([
  'phase', 'bridge', 'param', 'returns', 'complex', 'mention', 'returns',
  'response', 'request', 'context', 'value', 'function', 'method', 'class',
  'type', 'object', 'array', 'string', 'number', 'boolean', 'null',
  'true', 'false', 'undefined', 'error', 'event', 'callback', 'promise',
  'async', 'await', 'config', 'options', 'result', 'output', 'input',
  'when', 'where', 'what', 'which', 'who', 'how', 'why',
  'this', 'that', 'these', 'those', 'them', 'they',
  'really', 'maybe', 'often', 'never', 'always', 'sometimes',
  'because', 'although', 'however', 'therefore'
]);

function _structuralArtifactReason(name) {
  // Returns a string reason if the name is a structural artifact, null if clean.
  if (!name) return 'empty';
  // Internal whitespace = sentence fragment, not an entity
  if (/\s/.test(name.trim())) return `has_internal_whitespace: "${name}"`;
  // Starts with non-letter (markdown bullets, parens, dashes)
  if (!/^[A-Za-z]/.test(name)) return `non_letter_prefix: "${name}"`;
  // Ends with non-word char other than period/closing-paren (catches `ing"`, `Chris's`-style with stray quotes)
  if (/[^A-Za-z0-9_)\.]$/.test(name)) return `non_word_suffix: "${name}"`;
  // Contains quotes, brackets, parens (parsing residue)
  if (/["'`\[\]{}]/.test(name) && !/^\w[\w'-]*$/.test(name)) return `has_punctuation_artifact: "${name}"`;
  // Looks like a date (YYYY-MM-DD or similar)
  if (/^\d{4}-\d{2}-\d{2}$/.test(name)) return `looks_like_date: "${name}"`;
  // Is purely numeric
  if (/^[\d.,]+$/.test(name)) return `purely_numeric: "${name}"`;
  // Possessive form ('s suffix) — derivative of another entity, not an entity itself
  if (/['’]s$/i.test(name)) return `possessive_form: "${name}"`;
  // Common English / code keyword
  if (COMMON_NOISE_TOKENS.has(name.toLowerCase())) return `common_noise_token: "${name}"`;
  return null;
}

function classifyRealness(canonicalName, entityType, aliases, mentionCount, blacklist) {
  const name = String(canonicalName || '');
  const lower = name.toLowerCase();
  const isBlacklisted = blacklist.some(b => b.toLowerCase() === lower);
  const aliasArr = Array.isArray(aliases) ? aliases : (() => {
    try { return JSON.parse(aliases || '[]'); } catch { return []; }
  })();
  const structuralReason = _structuralArtifactReason(name);
  return {
    nameLength: name.length,
    isCommonWord: isBlacklisted,
    isSubstringArtifact: name.length < 4 && !/^[A-Z]{2,}$/.test(name) && mentionCount < 100,
    isStructuralArtifact: !!structuralReason,
    structuralReason,
    hasAliases: aliasArr.length > 0,
    entityType: entityType || 'CONCEPT'
  };
}

// ---------------------------------------------------------------------------
// Scope evaluators
// ---------------------------------------------------------------------------

function evaluateEntity({ entityId, agentId }, config) {
  const graphPath = resolveGraphDB(agentId);
  const db = openReadOnly(graphPath);
  if (!db) {
    return _insufficient({ kind: 'entity', entityId, agentId },
      ['no-graph-db'], 'graph DB unavailable');
  }
  try {
    const entity = db.prepare(
      `SELECT id, canonical_name, entity_type, mention_count, aliases, last_seen
       FROM entities WHERE id = ? OR lower(canonical_name) = lower(?)`
    ).get(entityId, entityId);
    if (!entity) {
      return _insufficient({ kind: 'entity', entityId, agentId },
        ['entity-not-in-graph'], `no row for entityId=${entityId}`);
    }
    const triples = db.prepare(
      `SELECT predicate, COUNT(*) AS n FROM triples
       WHERE (subject = ? OR object = ?) AND agent_id = ?
       GROUP BY predicate`
    ).all(entity.id, entity.id, agentId);
    const totalTriples = triples.reduce((a, t) => a + t.n, 0);
    const trivialPreds = new Set(config.thresholds.entity.trivialPredicates);
    const wellFormed = triples.filter(t => !trivialPreds.has(t.predicate))
      .reduce((a, t) => a + t.n, 0);
    const hasOnlyTrivial = totalTriples > 0 && wellFormed === 0;

    const realness = classifyRealness(
      entity.canonical_name, entity.entity_type, entity.aliases,
      entity.mention_count, config.noiseBlacklist
    );

    const lastSeenDate = entity.last_seen ? new Date(entity.last_seen) : null;
    const daysSinceLastSeen = lastSeenDate
      ? Math.floor((Date.now() - lastSeenDate.getTime()) / 86400000)
      : null;
    const isStale = daysSinceLastSeen !== null
      && daysSinceLastSeen > config.thresholds.recency.staleAfterDays;

    const reasonsBelow = [];
    const reasonsForConfidence = [];
    let sufficient = true;
    let confidence = 'high';

    if (realness.nameLength < config.thresholds.entity.minNameLength) {
      reasonsBelow.push(`name_length<${config.thresholds.entity.minNameLength}: "${entity.canonical_name}"`);
      sufficient = false;
    }
    if (realness.isCommonWord) {
      reasonsBelow.push(`name_in_noise_blacklist: "${entity.canonical_name}"`);
      sufficient = false;
    }
    if (realness.isStructuralArtifact) {
      reasonsBelow.push(realness.structuralReason);
      sufficient = false;
    }
    if (hasOnlyTrivial && entity.mention_count < config.thresholds.entity.minMentionCountIfTrivialOnly) {
      reasonsBelow.push(
        `only_trivial_predicates_with_low_mentions: ${triples.map(t => t.predicate).join(',')} (${entity.mention_count} mentions)`
      );
      sufficient = false;
    }
    if (totalTriples < config.thresholds.entity.minTriplesForSparseToBeReal && entity.mention_count < 100) {
      reasonsBelow.push(`triples<${config.thresholds.entity.minTriplesForSparseToBeReal}_and_mentions<100`);
      // Don't set sufficient=false here — connectivity alone shouldn't be the whole story
      confidence = 'low';
    }

    if (sufficient && totalTriples >= 10) {
      reasonsForConfidence.push(`${totalTriples}_triples_well_above_threshold`);
    }
    if (sufficient && realness.hasAliases) {
      reasonsForConfidence.push('has_aliases');
    }
    if (sufficient && wellFormed > totalTriples * 0.5) {
      reasonsForConfidence.push('predicate_diversity_strong');
    }

    if (!sufficient) confidence = 'insufficient';
    else if (totalTriples < 5 || hasOnlyTrivial) confidence = 'low';
    else if (totalTriples < 15) confidence = 'medium';

    return {
      scope: { kind: 'entity', entityId: entity.id, canonicalName: entity.canonical_name, agentId },
      density: {
        distinctExchanges: null,  // not applicable for entity scope
        distinctDates: null,
        distinctSessions: null,
        totalMentions: entity.mention_count
      },
      connectivity: {
        wellFormedTriples: wellFormed,
        predicateDiversity: triples.length,
        hasOnlyTrivialPredicates: hasOnlyTrivial,
        totalTriples
      },
      sourceDiversity: null,
      realnessSignals: realness,
      recency: {
        lastSeen: entity.last_seen,
        daysSinceLastSeen,
        isStale
      },
      sufficient,
      confidence,
      reasonsBelow,
      reasonsForConfidence
    };
  } finally { try { db.close(); } catch (_) {} }
}

function evaluatePerson({ name, agentId }, config) {
  const contPath = resolveContinuityDB(agentId);
  const db = openReadOnly(contPath);
  if (!db) {
    return _insufficient({ kind: 'person', name, agentId },
      ['no-continuity-db'], 'continuity DB unavailable');
  }
  try {
    // Match by user_text fragment OR by Phase-3 speakerId metadata.
    // Also pull attributionConflict so we can downgrade confidence on
    // exchanges where channel resolution disagreed with content reading.
    const lowerName = name.toLowerCase();
    const rows = db.prepare(
      `SELECT id, date,
        json_extract(metadata, '$.speakerId')             AS speakerId,
        json_extract(metadata, '$.profileRank')           AS profileRank,
        json_extract(metadata, '$.channel')               AS channel,
        json_extract(metadata, '$.attributionConflict')   AS conflictJson,
        json_extract(metadata, '$.chatId')      AS chatId,
        substr(user_text, 1, 200)               AS user_preview
       FROM exchanges
       WHERE lower(user_text) LIKE ?
          OR lower(agent_text) LIKE ?
          OR lower(json_extract(metadata, '$.speakerId')) = ?
          OR lower(json_extract(metadata, '$.senderLabel')) LIKE ?`
    ).all(`%${lowerName}%`, `%${lowerName}%`, lowerName, `%${lowerName}%`);

    const distinctDates = new Set(rows.map(r => r.date));
    const distinctSpeakers = new Set(rows.map(r => r.speakerId).filter(Boolean));
    const speakerCounts = { anchor: 0, guest: 0, visitor: 0, untagged: 0 };
    let conflictCount = 0;
    for (const r of rows) {
      if (r.profileRank === 'anchor') speakerCounts.anchor++;
      else if (r.profileRank === 'guest') speakerCounts.guest++;
      else if (r.profileRank === 'visitor') speakerCounts.visitor++;
      else speakerCounts.untagged++;
      if (r.conflictJson) conflictCount++;
    }

    const reasonsBelow = [];
    const reasonsForConfidence = [];
    const t = config.thresholds.person;
    let sufficient = true;
    let confidence = 'high';

    if (rows.length < t.minDistinctExchangesForSufficient) {
      reasonsBelow.push(`distinct_exchanges<${t.minDistinctExchangesForSufficient}: ${rows.length}`);
      sufficient = false;
    }
    if (distinctDates.size < t.minDistinctDatesForSufficient) {
      reasonsBelow.push(`distinct_dates<${t.minDistinctDatesForSufficient}: ${distinctDates.size}`);
      sufficient = false;
    }

    if (sufficient) {
      if (rows.length < t.minExchangesForMedium) confidence = 'low';
      else confidence = 'medium';
      if (rows.length >= t.minExchangesForMedium && distinctDates.size >= t.minDistinctSessionsForMedium) {
        confidence = 'high';
        reasonsForConfidence.push(`${rows.length}_exchanges_across_${distinctDates.size}_dates`);
      }
    }

    // Downgrade confidence when a meaningful fraction of source exchanges
    // have attribution conflicts. The data is structurally suspect even if
    // dense — synthesis built on mis-attributed speakers is still hallucination.
    if (sufficient && conflictCount > 0) {
      const conflictRate = conflictCount / rows.length;
      if (conflictRate >= 0.20) {
        // ≥20% of source exchanges flagged → downgrade two notches and warn
        confidence = 'insufficient';
        sufficient = false;
        reasonsBelow.push(`attribution_conflict_rate=${(conflictRate*100).toFixed(0)}% (${conflictCount}/${rows.length})`);
      } else if (conflictRate >= 0.05) {
        // 5-20% → downgrade one notch
        if (confidence === 'high') confidence = 'medium';
        else if (confidence === 'medium') confidence = 'low';
        reasonsBelow.push(`attribution_conflicts_present: ${conflictCount} of ${rows.length} flagged`);
      } else {
        reasonsBelow.push(`minor_attribution_conflicts: ${conflictCount} of ${rows.length}`);
      }
    }

    if (!sufficient) confidence = 'insufficient';

    return {
      scope: { kind: 'person', name, agentId },
      density: {
        distinctExchanges: rows.length,
        distinctDates: distinctDates.size,
        distinctSessions: distinctDates.size, // approximation; sessionId lives elsewhere
        totalMentions: rows.length
      },
      connectivity: null,
      sourceDiversity: {
        distinctSpeakers: distinctSpeakers.size,
        anchorCount:   speakerCounts.anchor,
        guestCount:    speakerCounts.guest,
        visitorCount:  speakerCounts.visitor,
        untaggedCount: speakerCounts.untagged
      },
      realnessSignals: null,
      recency: null,
      sufficient,
      confidence,
      reasonsBelow,
      reasonsForConfidence
    };
  } finally { try { db.close(); } catch (_) {} }
}

function evaluateExchangeWindow({ dateStart, dateEnd, agentId }, config) {
  const contPath = resolveContinuityDB(agentId);
  const db = openReadOnly(contPath);
  if (!db) {
    return _insufficient({ kind: 'exchange-window', dateStart, dateEnd, agentId },
      ['no-continuity-db'], 'continuity DB unavailable');
  }
  try {
    const rows = db.prepare(
      `SELECT json_extract(metadata, '$.speakerId')   AS speakerId,
              json_extract(metadata, '$.profileRank') AS profileRank
       FROM exchanges WHERE date >= ? AND date <= ?`
    ).all(dateStart, dateEnd);

    const speakerCounts = { anchor: 0, guest: 0, visitor: 0, untagged: 0 };
    for (const r of rows) {
      if (r.profileRank === 'anchor')  speakerCounts.anchor++;
      else if (r.profileRank === 'guest')   speakerCounts.guest++;
      else if (r.profileRank === 'visitor') speakerCounts.visitor++;
      else speakerCounts.untagged++;
    }
    const tagged = rows.length - speakerCounts.untagged;
    const attributionRate = rows.length > 0 ? tagged / rows.length : 0;

    const reasonsBelow = [];
    const reasonsForConfidence = [];
    const t = config.thresholds.exchangeWindow;
    let sufficient = rows.length >= t.minExchangesForSufficient;
    let confidence = 'high';
    if (!sufficient) {
      reasonsBelow.push(`exchanges<${t.minExchangesForSufficient}: ${rows.length}`);
      confidence = 'insufficient';
    } else if (attributionRate < t.minSpeakerAttributionRateForMedium) {
      confidence = 'low';
      reasonsBelow.push(`attribution_rate<${t.minSpeakerAttributionRateForMedium}: ${attributionRate.toFixed(2)}`);
    }
    if (sufficient && attributionRate >= t.minSpeakerAttributionRateForMedium) {
      reasonsForConfidence.push(`attribution_rate=${attributionRate.toFixed(2)}`);
    }

    return {
      scope: { kind: 'exchange-window', dateStart, dateEnd, agentId },
      density: {
        distinctExchanges: rows.length,
        distinctDates: null, // could compute, but date-range is the bound
        distinctSessions: null,
        totalMentions: rows.length
      },
      connectivity: null,
      sourceDiversity: {
        distinctSpeakers: null,
        anchorCount:   speakerCounts.anchor,
        guestCount:    speakerCounts.guest,
        visitorCount:  speakerCounts.visitor,
        untaggedCount: speakerCounts.untagged
      },
      realnessSignals: null,
      recency: null,
      sufficient,
      confidence,
      reasonsBelow,
      reasonsForConfidence
    };
  } finally { try { db.close(); } catch (_) {} }
}

function evaluateSpeaker({ speakerId, agentId }, config) {
  // Speaker scope: requires a registered profile (anchor/guest/visitor).
  // Volume comes from continuity DB matching speakerId.
  const contPath = resolveContinuityDB(agentId);
  const db = openReadOnly(contPath);
  if (!db) {
    return _insufficient({ kind: 'speaker', speakerId, agentId },
      ['no-continuity-db'], 'continuity DB unavailable');
  }
  try {
    const rows = db.prepare(
      `SELECT date,
              json_extract(metadata, '$.profileRank') AS profileRank,
              json_extract(metadata, '$.channel')     AS channel
       FROM exchanges
       WHERE json_extract(metadata, '$.speakerId') = ?`
    ).all(speakerId);

    const distinctDates = new Set(rows.map(r => r.date));
    const ranks = new Set(rows.map(r => r.profileRank).filter(Boolean));
    const channels = new Set(rows.map(r => r.channel).filter(Boolean));

    const reasonsBelow = [];
    const reasonsForConfidence = [];
    let sufficient = rows.length > 0;
    let confidence = 'high';
    let resolvedRank = ranks.size === 1 ? [...ranks][0] : null;

    if (!sufficient) {
      reasonsBelow.push(`no_exchanges_with_speakerId=${speakerId}`);
      confidence = 'insufficient';
    } else {
      // Anchor rank is the trust authority — confidence is high regardless of
      // volume in continuity (pre-Phase-3 exchanges are mostly untagged anyway,
      // so anchor rows in the DB undercount the actual relationship).
      if (resolvedRank === 'anchor') {
        confidence = 'high';
        reasonsForConfidence.push('rank=anchor');
        if (distinctDates.size >= 3) reasonsForConfidence.push(`${distinctDates.size}_dates`);
      } else if (resolvedRank === 'visitor') {
        confidence = 'low';
        reasonsBelow.push('rank=visitor (inherently low)');
      } else if (rows.length < 10) {
        confidence = 'low';
        if (resolvedRank) reasonsForConfidence.push(`rank=${resolvedRank}`);
      } else if (rows.length < 50 || distinctDates.size < 3) {
        confidence = 'medium';
        if (resolvedRank) reasonsForConfidence.push(`rank=${resolvedRank}`);
        if (distinctDates.size >= 3) reasonsForConfidence.push(`${distinctDates.size}_dates`);
      } else {
        if (resolvedRank) reasonsForConfidence.push(`rank=${resolvedRank}`);
        if (distinctDates.size >= 3) reasonsForConfidence.push(`${distinctDates.size}_dates`);
      }
    }

    return {
      scope: { kind: 'speaker', speakerId, agentId },
      density: {
        distinctExchanges: rows.length,
        distinctDates: distinctDates.size,
        distinctSessions: null,
        totalMentions: rows.length
      },
      connectivity: null,
      sourceDiversity: {
        distinctSpeakers: 1,
        anchorCount:  resolvedRank === 'anchor'  ? rows.length : 0,
        guestCount:   resolvedRank === 'guest'   ? rows.length : 0,
        visitorCount: resolvedRank === 'visitor' ? rows.length : 0,
        untaggedCount: 0
      },
      realnessSignals: { resolvedRank, channels: [...channels] },
      recency: null,
      sufficient,
      confidence,
      reasonsBelow,
      reasonsForConfidence
    };
  } finally { try { db.close(); } catch (_) {} }
}

function evaluateTopic({ tags, agentId }, config) {
  // Topic scope: density via topic_tags column on exchanges
  const contPath = resolveContinuityDB(agentId);
  const db = openReadOnly(contPath);
  if (!db) {
    return _insufficient({ kind: 'topic', tags, agentId },
      ['no-continuity-db'], 'continuity DB unavailable');
  }
  try {
    if (!Array.isArray(tags) || tags.length === 0) {
      return _insufficient({ kind: 'topic', tags, agentId },
        ['no-tags'], 'tags array empty');
    }
    const conditions = tags.map(() => `topic_tags LIKE ?`).join(' OR ');
    const params = tags.map(t => `%${t}%`);
    const rows = db.prepare(
      `SELECT date FROM exchanges WHERE ${conditions}`
    ).all(...params);
    const distinctDates = new Set(rows.map(r => r.date));
    const sufficient = rows.length >= config.thresholds.exchangeWindow.minExchangesForSufficient;
    return {
      scope: { kind: 'topic', tags, agentId },
      density: {
        distinctExchanges: rows.length,
        distinctDates: distinctDates.size,
        distinctSessions: null,
        totalMentions: rows.length
      },
      connectivity: null,
      sourceDiversity: null,
      realnessSignals: null,
      recency: null,
      sufficient,
      confidence: sufficient
        ? (rows.length < 10 ? 'low' : (rows.length < 30 ? 'medium' : 'high'))
        : 'insufficient',
      reasonsBelow: sufficient ? [] : [`exchanges<${config.thresholds.exchangeWindow.minExchangesForSufficient}: ${rows.length}`],
      reasonsForConfidence: sufficient ? [`${rows.length}_exchanges_${distinctDates.size}_dates`] : []
    };
  } finally { try { db.close(); } catch (_) {} }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _insufficient(scope, reasonsBelow, summary) {
  return {
    scope,
    density: null,
    connectivity: null,
    sourceDiversity: null,
    realnessSignals: null,
    recency: null,
    sufficient: false,
    confidence: 'insufficient',
    reasonsBelow,
    reasonsForConfidence: [],
    summary
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function evaluate(scope, config) {
  if (!config || typeof config !== 'object') {
    throw new Error('[evidence-quality/evaluator] evaluate() requires a config object — load via plugin or pass defaults explicitly');
  }
  if (!scope || typeof scope !== 'object' || !scope.kind) {
    throw new Error('[evidence-quality/evaluator] evaluate() requires scope.kind to be one of: entity, person, topic, exchange-window, speaker');
  }
  const agentId = scope.agentId || 'main';
  switch (scope.kind) {
    case 'entity':          return evaluateEntity({ entityId: scope.entityId, agentId }, config);
    case 'person':          return evaluatePerson({ name: scope.name, agentId }, config);
    case 'topic':           return evaluateTopic({ tags: scope.tags, agentId }, config);
    case 'exchange-window': return evaluateExchangeWindow({ dateStart: scope.dateStart, dateEnd: scope.dateEnd, agentId }, config);
    case 'speaker':         return evaluateSpeaker({ speakerId: scope.speakerId, agentId }, config);
    default:
      throw new Error(`[evidence-quality/evaluator] unknown scope.kind: "${scope.kind}"`);
  }
}

module.exports = {
  evaluate,
  evaluateEntity,
  evaluatePerson,
  evaluateTopic,
  evaluateExchangeWindow,
  evaluateSpeaker
};
