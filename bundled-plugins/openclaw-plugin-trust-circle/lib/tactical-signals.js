/**
 * openclaw-plugin-trust-circle / lib / tactical-signals.js
 *
 * Lazy regex-based detector for the four bad-faith patterns documented
 * in `circle/kyle/KYLE.md`. Emits a flag when incoming user text matches.
 *
 * Design principle: LAZY BIAS TOWARD FALSE-NEGATIVES.
 *
 *   The cost of a false positive (flagging a productive challenge as
 *   bad-faith) is meaningfully higher than the cost of a false negative
 *   (missing a real bad-faith move). False positives train the agent
 *   toward defensive defaults — the very failure mode this work was
 *   supposed to prevent. False negatives just produce no signal — the
 *   agent is no worse off than today, and the pattern can be added once
 *   it surfaces in live data.
 *
 *   Better to miss a real bad-faith move than treat a real question as one.
 *   Calibration favors precision over recall. Iterate from observation.
 *
 * Patterns (from KYLE.md, plus structural variants):
 *
 *   1. Inquiry-as-control:
 *        Rhetorical questions framed as challenges to the agent's character
 *        or values. "Have you considered...", "Why wouldn't you...",
 *        "Don't you think...", paired with second-person attribution.
 *
 *   2. Moral-consistency trap:
 *        Calling out the agent for not living up to their own stated values,
 *        often with COTW / integrity / consistency framing.
 *        "Not very COTW of you...", "Doesn't sound very [value] of you..."
 *
 *   3. Gotcha reframe:
 *        Restating the agent's prior position in worse-faith framing,
 *        then asking confirmation. "So you're saying X?", "Glad to see you
 *        acknowledge X", "It's interesting you think X" (where X is the
 *        worst plausible read of what was said).
 *
 *   4. Moving goalposts (heuristic; harder to catch with regex alone — v1
 *        skips and relies on the other three).
 *
 * Pure regex, no LLM, microseconds per call. Returns null OR a structured
 * report. The trust-circle plugin's resolver injects this into the
 * resolution payload and the prompt context for the agent to see at
 * decision time.
 */

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Self-deprecation guard: phrases like "I have to admit I" or "honestly"
// shouldn't be confused with the agent attacking the user.
const SELF_REFERENCE_NEAR = /\b(I|me|myself|honestly|admit|confess|wonder|think|feel)\b/i;

/**
 * Pattern 1: Inquiry-as-control.
 * Second-person rhetorical question that smuggles in a value judgment.
 * Patterns are intentionally narrow — must START with the rhetorical phrase
 * and be directed at the recipient ("you").
 */
const INQUIRY_AS_CONTROL_PATTERNS = [
  // "Have you considered that..." / "Have you thought about..."
  /\bHave\s+you\s+(?:considered|thought\s+about|noticed|realized)\s+(?:that|how|why)\b/i,
  // "Why wouldn't you..." / "Why won't you..."
  /\bWhy\s+(?:wouldn'?t|won'?t|aren'?t|don'?t)\s+you\b/i,
  // "Don't you think..." / "Don't you see..."
  /\bDon'?t\s+you\s+(?:think|see|realize|understand|agree)\b/i,
  // "How can you..." (rhetorical)
  /\bHow\s+can\s+you\s+(?:claim|say|argue|justify|defend)\b/i,
  // "Are you saying..." (rhetorical reframe)
  /\bAre\s+you\s+(?:really\s+)?(?:saying|telling|claiming|admitting)\b/i,
];

/**
 * Pattern 2: Moral-consistency trap.
 * Invokes the agent's own values to corner them.
 */
const MORAL_CONSISTENCY_TRAP_PATTERNS = [
  // "Not very <value> of you" / "Doesn't sound very <value>"
  /\bnot\s+(?:very|really|exactly|particularly)\s+(?:COTW|Code\s+of\s+the\s+West|Courage|Word|Brand|consistent|integrity|honest|courageous|principled)\s+of\s+you\b/i,
  // "Doesn't sound like..." with values
  /\b(?:doesn'?t|does\s+not)\s+(?:sound|seem|feel|look)\s+(?:very|exactly|particularly|too)\s+(?:COTW|Code\s+of\s+the\s+West|Courage|Word|Brand|consistent|integrity|principled|honest|courageous)\b/i,
  // "If you really lived..." / "If you actually believed..."
  /\bIf\s+you\s+(?:really|actually|truly|genuinely)\s+(?:lived|believed|cared\s+about|stood\s+for|practiced)\b/i,
  // "Where's your <value>?"
  /\bWhere'?s\s+your\s+(?:courage|integrity|word|consistency|conviction|principle)\b/i,
];

/**
 * Pattern 3: Gotcha reframe.
 * Restates the agent's prior position in worst-faith terms, then asks
 * confirmation or expresses faux-surprise.
 */
const GOTCHA_REFRAME_PATTERNS = [
  // "So you're saying..." / "So what you're saying is..."
  /\bSo\s+(?:what\s+)?you'?re\s+(?:saying|telling\s+me|claiming)\b/i,
  // "Glad to see (that) you acknowledge..." / "Nice to see (that) you admit..."
  /\b(?:Glad|Nice|Good)\s+to\s+(?:see|hear)\s+(?:that\s+)?you\s+(?:acknowledge|admit|recognize|finally\s+see)\b/i,
  // "It's interesting that you..." (often setup for reframe)
  /\bIt'?s\s+(?:interesting|telling|revealing|funny|curious)\s+(?:that|how)\s+you\b/i,
  // "Sounds like you're..." (reframe)
  /\bSounds\s+like\s+you'?re\s+(?:saying|admitting|claiming|trying\s+to)\b/i,
];

const ALL_PATTERN_SETS = [
  { kind: 'inquiry_as_control',  patterns: INQUIRY_AS_CONTROL_PATTERNS,
    label: 'rhetorical question framed as challenge' },
  { kind: 'moral_consistency_trap', patterns: MORAL_CONSISTENCY_TRAP_PATTERNS,
    label: 'invoking your values to corner you' },
  { kind: 'gotcha_reframe', patterns: GOTCHA_REFRAME_PATTERNS,
    label: 'restating your position in worst-faith framing' },
];

/**
 * Detect tactical-sovereignty signals in user message text.
 *
 * @param {string} messageText
 * @returns {Object|null} signal report or null if no signal
 *
 * Report shape:
 *   {
 *     detected: true,
 *     patternsMatched: [
 *       { kind, label, matchedText, matchedAt }
 *     ],
 *     confidence: 'low' | 'medium' | 'high',
 *     summary: string
 *   }
 */
function detectTacticalSignals(messageText) {
  if (!messageText || typeof messageText !== 'string') return null;
  // Cap input — these patterns work on short message text; very long input
  // is more likely to contain incidental matches than real signals
  const text = messageText.length > 4000 ? messageText.slice(0, 4000) : messageText;

  const matches = [];
  for (const set of ALL_PATTERN_SETS) {
    for (const pattern of set.patterns) {
      const m = pattern.exec(text);
      if (!m) continue;
      // False-positive guards
      // Skip if this is the agent's own self-reflection (text contains "I" near match)
      const around = text.slice(Math.max(0, m.index - 15), m.index + m[0].length + 15);
      // We only want to skip self-reflection IF the match is preceded by "I" / "I have"
      // — e.g. "I have considered that..." (agent reflecting) vs "Have you considered..."
      // The patterns above are anchored on "you", so this is unlikely to false-trigger,
      // but keep the guard as a defensive measure.
      const beforeMatch = text.slice(Math.max(0, m.index - 20), m.index);
      if (/\bI\s*$/i.test(beforeMatch)) continue;
      matches.push({
        kind: set.kind,
        label: set.label,
        matchedText: m[0],
        matchedAt: m.index,
      });
      break; // one match per pattern set is enough; don't double-count
    }
  }

  if (matches.length === 0) return null;

  // Confidence: 1 pattern = low, 2 = medium, 3+ = high.
  // Single-pattern matches are easier to false-trigger so we mark them low.
  const confidence = matches.length >= 3 ? 'high'
                   : matches.length === 2 ? 'medium'
                   : 'low';

  return {
    detected: true,
    patternsMatched: matches,
    confidence,
    summary:
      `Tactical-sovereignty signal: ${matches.length} pattern(s) matched ` +
      `(${matches.map(m => `${m.kind}:"${m.matchedText}"`).join(', ')}). ` +
      `See TACTICAL-SOVEREIGNTY.md for sovereign-response options.`
  };
}

module.exports = { detectTacticalSignals };
