/**
 * openclaw-plugin-trust-circle / lib / conflict-detector.js
 *
 * Lazy third-person awareness for speaker resolution.
 *
 * Catches the "Telegraf retries crossed wires" failure mode (and the
 * "Chris is on Kyle's phone" failure mode, and the "Kyle is on Chris's
 * phone" failure mode) by checking ONE thing:
 *
 *     If the channel resolved speaker = X, does the message text refer
 *     to X in third person?
 *
 * Pure regex, no LLM, runs in microseconds. Only FLAGS — never auto-
 * corrects. Downstream consumers (continuity archiver, evidence-quality
 * evaluator, standing/contemplation gates) can then choose to downgrade
 * confidence or refuse metabolism on flagged exchanges.
 *
 * Patterns flagged when speaker is supposed to be X:
 *   - Possessive:        "X's"           ("Chris's oldest friend")
 *   - Self-inclusion:    "X and I"       ("conversations between Kyle and I")
 *                        "X & me"
 *   - Third-person verb: "X invites"     ("Chris invites you to meet")
 *                        "X asked", "X said", "X thinks", "X is", "X was"…
 *
 * False-positive guards:
 *   - Self-identification preface: "I'm X", "this is X", "it's X" — skip
 *   - Quoted speech: rough heuristic; if name is inside quotes, skip
 *
 * The detector also returns a SUGGESTED ALTERNATIVE speaker when exactly
 * one other registered profile is referenced with first-person markers
 * nearby (e.g., text says "I" while naming X in 3rd person → suggested
 * speaker is whoever the registered I-bearer might be).
 */

const FIRST_PERSON_PRECEDES_NAME =
  /\b(?:I['’ ]?m|I am|this is|it['’]s|it is|name'?s)\s+["']?$/i;

const THIRD_PERSON_VERBS = [
  'invites', 'invited', 'asks', 'asked', 'told', 'tells', 'wants', 'wanted',
  'said', 'says', 'thinks', 'thought', 'believes', 'believed',
  'makes', 'made', 'gets', 'got', 'does', 'did', 'has', 'had', 'have',
  'is', 'was', 'were', 'will', 'would', 'can', 'could', 'should',
  'gives', 'gave', 'sees', 'saw', 'knows', 'knew', 'feels', 'felt',
  'finds', 'found', 'comes', 'came', 'goes', 'went', 'takes', 'took',
  'wonders', 'wondered', 'mentions', 'mentioned', 'explains', 'explained',
];

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the third-person disagreement regex set for a given name.
 * @param {string} name — the bare name (e.g. "Chris", "Kyle")
 * @returns {Array<{pattern: RegExp, kind: string, label: string}>}
 */
function buildPatternsForName(name) {
  if (!name || name.length < 2) return [];
  const n = escapeRegex(name);
  const verbs = THIRD_PERSON_VERBS.join('|');
  return [
    {
      pattern: new RegExp(`\\b${n}['’]s\\b`, 'i'),
      kind: 'possessive',
      label: `${name}'s`
    },
    {
      pattern: new RegExp(`\\b${n}\\s+(?:and|&|or)\\s+(?:I|me|us|we)\\b`, 'i'),
      kind: 'self_inclusion_prefix',
      label: `${name} and I/me/us/we`
    },
    {
      pattern: new RegExp(`\\b(?:I|me|us|we)\\s+(?:and|&|or)\\s+${n}\\b`, 'i'),
      kind: 'self_inclusion_suffix',
      label: `I/me/us/we and ${name}`
    },
    {
      pattern: new RegExp(`\\b${n}\\s+(?:${verbs})\\b`, 'i'),
      kind: 'third_person_verb',
      label: `${name} <verb>`
    },
  ];
}

/**
 * Crude check: is the matched name surrounded by quote marks within ~30 chars?
 * If so, treat it as quoted speech (don't flag).
 */
function isLikelyQuoted(text, matchIndex, matchLength) {
  const before = text.slice(Math.max(0, matchIndex - 30), matchIndex);
  const after  = text.slice(matchIndex + matchLength, matchIndex + matchLength + 30);
  // Look for an opening quote in the 30-char window before with no closing in between
  const openQuoteBefore = /["“][^"”]*$/.test(before);
  const closeQuoteAfter = /^[^"“]*["”]/.test(after);
  return openQuoteBefore && closeQuoteAfter;
}

/**
 * Crude check: is the matched name preceded by a self-identification phrase?
 * "I'm Chris", "this is Chris", etc. — if so, name use is consistent with X
 * being the speaker, no conflict.
 */
function isSelfIdentification(text, matchIndex) {
  const before = text.slice(Math.max(0, matchIndex - 20), matchIndex);
  return FIRST_PERSON_PRECEDES_NAME.test(before);
}

/**
 * Detect third-person attribution conflict.
 *
 * @param {string} messageText
 * @param {Object} resolvedProfile — the profile the channel resolved to
 *                                   (must have at least { id, displayName })
 * @param {Array<Object>} allProfiles — full registry profile list, for
 *                                       suggested-alternative computation
 * @returns {Object|null} conflict report or null if no conflict detected
 */
function detectThirdPersonConflict(messageText, resolvedProfile, allProfiles) {
  if (!messageText || typeof messageText !== 'string') return null;
  if (!resolvedProfile || !resolvedProfile.displayName) return null;

  // Try each name part (e.g., "Chris Hunt" → ["Chris", "Hunt"]) — match on
  // any token that's >= 3 chars and capitalized
  const nameParts = String(resolvedProfile.displayName)
    .split(/\s+/)
    .filter(p => p.length >= 3 && /^[A-Z]/.test(p));

  // Also try the profile id if it differs and is reasonable
  if (resolvedProfile.id && resolvedProfile.id.length >= 3 &&
      !nameParts.some(p => p.toLowerCase() === resolvedProfile.id.toLowerCase())) {
    nameParts.push(resolvedProfile.id);
  }

  const matches = [];
  for (const part of nameParts) {
    for (const { pattern, kind, label } of buildPatternsForName(part)) {
      const m = pattern.exec(messageText);
      if (!m) continue;
      const idx = m.index;
      // Apply false-positive guards
      if (isSelfIdentification(messageText, idx)) continue;
      if (isLikelyQuoted(messageText, idx, m[0].length)) continue;
      matches.push({
        kind,
        label,
        matchedText: m[0],
        matchedAt: idx,
      });
    }
  }

  if (matches.length === 0) return null;

  // Suggested-alternative: of the OTHER registered profiles, which one's
  // name appears in the message? If exactly one, propose it.
  let suggestedAlternative = null;
  if (Array.isArray(allProfiles)) {
    const others = allProfiles.filter(p => p && p.id !== resolvedProfile.id);
    const otherMentions = [];
    for (const other of others) {
      const otherNameParts = String(other.displayName || '')
        .split(/\s+/).filter(p => p.length >= 3 && /^[A-Z]/.test(p));
      for (const part of otherNameParts) {
        if (new RegExp(`\\b${escapeRegex(part)}\\b`, 'i').test(messageText)) {
          otherMentions.push(other.id);
          break;
        }
      }
    }
    if (otherMentions.length === 1) suggestedAlternative = otherMentions[0];
  }

  return {
    detected: true,
    resolvedSpeakerId: resolvedProfile.id,
    patternsMatched: matches,
    suggestedAlternative,
    confidence: matches.length >= 2 ? 'high' : (matches.length === 1 ? 'medium' : 'low'),
    summary: `Channel resolved speaker as "${resolvedProfile.displayName}" but text refers to that person in third person: ${matches.map(m => m.label).join(', ')}`,
  };
}

module.exports = { detectThirdPersonConflict, buildPatternsForName };
