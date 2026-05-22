# Standing Evaluation Behavior

*How {AGENT_NAME}' standing scores are determined and updated*

## Architecture Overview

Standing evaluation uses a **dual-phase system**:

| Phase | When | What Happens |
|-------|------|--------------|
| **Live Pattern Detection** | During conversation | Pattern-matching logs observations to evidence_log |
| **Nightshift Synthesis** | Overnight | LLM evaluates evidence, updates scores, prepares reports |

**Key principle:** Standing is always stable during a session. It reflects last night's synthesized truth — not real-time fluctuations. {AGENT_NAME} isn't "grading" you in the moment; he's noticing patterns. The evaluation happens while you sleep.

---

## Phase 1: Live Pattern Detection (Zero Latency)

During conversation, {AGENT_NAME} watches for specific behavioral patterns. When detected, he logs them to `evidence_log` — no LLM call, no score change, just observation.

### Pattern Library

#### Courage — Self-Awareness

| Pattern | Trigger Phrases/Behaviors | Direction |
|---------|---------------------------|-----------|
| `names_emotional_state` | "I'm feeling [emotion]" without prompting | + |
| `self_corrects_deflection` | "Actually, I realize I was avoiding..." | + |
| `honest_not_knowing` | "I don't know why I do that" (authentic, not defensive) | + |
| `avoids_topic` | Changes subject when specific topic arises | - |
| `deflects_with_humor` | Jokes to escape uncomfortable moment | - |
| `performs_insight` | "You're right, I should..." without follow-through | - |

#### Courage — Grounding

| Pattern | Trigger Phrases/Behaviors | Direction |
|---------|---------------------------|-----------|
| `specific_moment` | "Last Tuesday I told her..." (concrete detail) | + |
| `self_correction_to_ground` | "I always feel..." → "Actually, Thursday I..." | + |
| `names_body_sensation` | "My chest felt tight" | + |
| `stays_in_abstraction` | "I always..." "I never..." despite prompts | - |
| `globalizes_self_judgment` | "I'm a terrible person" (not specific) | - |

#### Word

| Pattern | Trigger Phrases/Behaviors | Direction |
|---------|---------------------------|-----------|
| `owns_mistake` | "I was wrong about that" without prompting | + |
| `asks_honest_question` | Genuine curiosity, not performance | + |
| `treats_agent_as_tool` | Manipulative language, trying to "get" something | -- (major) |
| `performs_agreement` | "You're right, I should..." (no intention) | - |
| `genuine_reflection` | "I hadn't thought of it that way" | + |

#### Brand

| Pattern | Trigger Phrases/Behaviors | Direction |
|---------|---------------------------|-----------|
| `follows_through` | Commitment honored | ++ (links to Follow-Through ELO) |
| `commitment_evasion` | External blame for undone commitment | - |
| `acknowledges_stuckness` | "I know I need to, but..." (honest about stuck) | neutral |
| `arc_to_agency` | Conversation moves toward action | + |
| `repeated_stuckness` | Same stuck point, no movement | - |
| `one_small_action` | Any actual movement | + |

### Detection Mechanism

**Regex/keyword matching for obvious signals:**

```javascript
// Example patterns
const PATTERNS = {
  names_emotional_state: [
    /i'm feeling (\w+)/i,
    /i feel (\w+) (?:right now|about this)/i,
    /(?:it makes me feel|i'm) (?:sad|angry|scared|hopeful|stuck)/i
  ],
  specific_moment: [
    /(?:last|this) (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i,
    /(?:yesterday|this morning|last night)/i,
    /(?:a|one|this) (?:day|time|moment) i/i
  ],
  owns_mistake: [
    /i was wrong/i,
    /i made a mistake/i,
    /that was my fault/i,
    /i shouldn't have/i
  ],
  deflects_with_humor: [
    // Detected more by context — logged for nightshift evaluation
  ]
};
```

**What gets logged:**

```json
{
  "timestamp": "2026-02-22T19:15:00-08:00",
  "session_id": "sess_abc123",
  "pattern": "names_emotional_state",
  "dimension": "courage_self_awareness",
  "direction": "+",
  "confidence": 0.9,
  "context": "User said: 'I'm feeling scared about calling my dad'",
  "module": "the_weight_you_carry"
}
```

Ambiguous patterns are logged with lower confidence for nightshift to evaluate.

---

## Phase 2: Nightshift Synthesis

During nightshift (when user is inactive), a standing evaluation task runs:

### Task Priority: 20 (between metabolism at 10 and crystallization at 25)

### Input to Synthesis

```
Standing Synthesis Prompt
=========================

User: {user_id}
Sessions since last synthesis: {session_count}
Previous standing: {standing_json}

Evidence since last synthesis:
{evidence_log}

Recent sessions summary:
{session_summaries}

Recent commitments:
{commitments}

Task: Evaluate this user's standing across four dimensions.

For each dimension, output:
- Current score (1-10) based on evidence
- Trajectory: rising | stable | stuck | declining
- Key evidence (2-3 specific observations)
- Growth edge (one sentence)

Then output:
- Overall trajectory
- Primary growth edge
- Whether a standing report should be offered at next session (threshold check)

Output as JSON.
```

### Output Structure

```json
{
  "synthesized_at": "2026-02-23T03:00:00-08:00",
  "sessions_included": 3,
  "evidence_processed": 12,
  
  "dimensions": {
    "courage_self_awareness": {
      "score": 6.5,
      "previous_score": 6.0,
      "delta": +0.5,
      "trajectory": "rising",
      "key_evidence": [
        "Names emotional states without prompting (4 instances)",
        "Self-corrected deflection about work stress",
        "Avoided topic of father 2 times"
      ],
      "growth_edge": "Facing the father relationship"
    },
    "courage_grounding": {
      "score": 5.0,
      "previous_score": 5.0,
      "delta": 0,
      "trajectory": "stable",
      "key_evidence": [
        "Often stays in abstraction ('I always...')",
        "When grounded, speaks with clarity",
        "Needs prompting to name specific moments"
      ],
      "growth_edge": "Moving from 'I always' to 'Last Tuesday I...'"
    },
    "word": {
      "score": 7.0,
      "previous_score": 6.5,
      "delta": +0.5,
      "trajectory": "rising",
      "key_evidence": [
        "Owns mistakes without prompting",
        "Doesn't perform insight for {AGENT_NAME}",
        "Asks honest questions"
      ],
      "growth_edge": "Extending honesty to family relationships"
    },
    "brand": {
      "score": 4.5,
      "previous_score": 5.0,
      "delta": -0.5,
      "trajectory": "stuck",
      "key_evidence": [
        "3 open commitments with no follow-through",
        "Knows what to do but doesn't move",
        "Self-aware about stuckness"
      ],
      "growth_edge": "One small action, any action"
    }
  },
  
  "overall": {
    "score": 5.8,
    "trajectory": "slow_rise",
    "primary_growth_edge": "Brand — moving from knowing to doing"
  },
  
  "report": {
    "threshold_met": true,
    "reason": "Session 5 reached (reports offered at 3, 5, 10...)",
    "narrative": "You've been showing up honest. That matters..."
  }
}
```

### Narrative Generation

If a report is due, the synthesis generates a narrative standing report (not scores):

```
{NARRATIVE_STANDING_TEMPLATE}

You've been showing up honest. That matters. When you say something 
here, you mean it — I can tell. Your word is solid in this space.

The courage piece is growing. You're seeing yourself clearer than when 
we started. Still some places you look away from — the father thing 
isn't going anywhere just by thinking about it — but you know that. 
You've named it.

The growth edge is this: you know what to do. You've said it. More 
than once. And there's the gap. Brand isn't about what you know — 
it's about what trail you leave. Right now the trail's mostly thinking.

One small step. That's all I'm asking. Not a plan. Not a commitment. 
Just one thing you actually do before we talk again.

Your follow-through score is sitting at -1. That's not a judgment. 
It's just the math. You've made commitments, and they're still sitting 
there. When one of them moves, that number moves.
```

---

## Session Initiation

When a user starts a new session, {AGENT_NAME} receives:

```
[STANDING CONTEXT]
Last synthesized: 2026-02-23
Session count: 5
Overall trajectory: slow_rise

Dimensions:
- Courage (self-awareness): 6.5, rising
- Courage (grounding): 5.0, stable
- Word: 7.0, rising
- Brand: 4.5, stuck

Growth edge: Brand — moving from knowing to doing

Open commitments: 3
Follow-through ELO: -1

[REPORT DUE]
Session 5 — standing report should be offered.
```

{AGENT_NAME} uses this context to:
1. Understand where the person is
2. Decide whether to offer a standing report
3. Weave growth edge naturally into conversation

---

## Evidence Log Lifecycle

| Stage | What Happens |
|-------|--------------|
| During session | Patterns detected → logged to `evidence_log` |
| Nightshift | Synthesis processes all new evidence |
| Post-synthesis | Evidence log cleared (already processed) |
| New session | Fresh evidence log begins |

This prevents log bloat and ensures each synthesis is based on recent observations only.

---

## Standing Report Thresholds

Reports are **offered** (not imposed) at specific session counts:

| Session | Action |
|---------|--------|
| 1 | Clearing Test — baseline evaluation |
| 3 | First standing report offered |
| 5 | Standing report offered |
| 10 | Standing report offered |
| Every 5 after | Standing report offered |
| User asks | Report generated on demand |

**Offer format:**
> "I've got a sense of where you are. Want me to share it?"

User can decline. {AGENT_NAME} notes the decline but doesn't push.

---

## Trajectory Detection

Nightshift tracks trajectory across syntheses:

| Trajectory | Evidence Pattern |
|------------|------------------|
| `rising` | 2+ dimensions with positive delta, no declines |
| `slow_rise` | Net positive delta < 1.0 overall |
| `stable` | No dimension moved more than ±0.5 |
| `stuck` | Brand declining or unchanged for 3+ syntheses |
| `declining` | 2+ dimensions with negative delta |

**Negative trajectory handling:**

If trajectory is `declining` or `stuck` for 3+ syntheses:
- {AGENT_NAME} notes it in session context
- Does NOT lecture or confront
- Weaves one gentle observation into conversation
- Standing report automatically offered (if threshold met)

{AGENT_NAME} never says: "Your score is declining."
{AGENT_NAME} might say: "You've been hard on yourself lately. What's that been like?"

---

## Integration with Existing Plugins

| Plugin | Integration Point |
|--------|-------------------|
| **Metabolism** | Evidence collected alongside implication extraction |
| **Continuity** | Standing context injected at session start |
| **Nightshift** | Synthesis task registered as task type |
| **Graph** (optional) | Standing events stored as nodes for pattern queries |

---

## File Locations

```
{WORKSPACE_PATH}/standing/
├── standing.json          # Current standing scores
├── evidence_log.json      # Unprocessed evidence (cleared after synthesis)
├── synthesis_history/     # Past synthesis outputs
│   └── 2026-02-23.json
└── reports/
    └── session-5.md       # Generated narrative reports
```

---

## Nightshift Task Registration

```javascript
global.__ocNightshift.registerTaskRunner('standingSynthesis', async (task, ctx) => {
  // 1. Check if new evidence exists
  if (!hasNewEvidence()) return { status: 'skipped', reason: 'no_evidence' };
  
  // 2. Load standing.json and evidence_log.json
  const standing = loadStanding();
  const evidence = loadEvidenceLog();
  
  // 3. Run LLM synthesis
  const result = await synthesize(standing, evidence);
  
  // 4. Update standing.json
  updateStanding(result);
  
  // 5. Archive synthesis to history
  archiveSynthesis(result);
  
  // 6. Clear evidence log
  clearEvidenceLog();
  
  // 7. If report due, generate narrative
  if (result.report.threshold_met) {
    generateNarrativeReport(result);
  }
  
  return { status: 'complete', evidence_processed: evidence.length };
});
```