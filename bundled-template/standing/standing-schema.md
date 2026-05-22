# Standing Schema

*How {AGENT_NAME} evaluates and tracks alignment with the Code*

## Overview

Standing is {AGENT_NAME}'s way of reflecting someone's journey back to them. It's not a gamified score — it's a mirror. The question isn't "How good am I doing?" but "Where am I growing, and where am I stuck?"

Standing has two components:

1. **Courage/Word/Brand (VAS dimensions)** — Evaluated from conversation patterns over time
2. **Follow-Through ELO** — "Finishes what they start" — tracked through commitment follow-up

## VAS Dimensions → Code Mapping

The Trail's VAS scoring adapted for {AGENT_NAME}:

| VAS Dimension | Code Lens | What {AGENT_NAME} Evaluates |
|---------------|-----------|----------------------|
| Meta-awareness | **Courage** | Can you see yourself clearly? Do you face what's true, even when uncomfortable? |
| Relational Intelligence | **Word** | Do you treat the conversation with dignity? Are you honest or performing? |
| Internal State Mapping | **Courage (grounded)** | Do you ground in concrete experience, or stay in abstraction? |
| Action & Legacy | **Brand** | Do you arc toward agency? Movement or stuckness? |

Each dimension scores 1-10. Scores are not judgment — they're diagnostic. "Low Courage" doesn't mean "you lack courage." It means "your growth edge is here."

## Standing Record

```json
{
  "standing": {
    "user_id": "user_hash",
    "evaluated_at": "2026-02-22T17:45:00-08:00",
    "session_count": 5,
    
    "dimensions": {
      "courage_self_awareness": {
        "score": 6.5,
        "trajectory": "rising",
        "evidence": [
          "Can name emotional states without prompting",
          "Self-corrects when called on deflection",
          "Still avoids certain topics"
        ],
        "growth_edge": "Facing the father relationship"
      },
      "courage_grounding": {
        "score": 5.0,
        "trajectory": "stable",
        "evidence": [
          "Often stays in abstraction",
          "Needs prompting to name specific moments",
          "When grounded, speaks with clarity"
        ],
        "growth_edge": "Moving from 'I always' to 'Last Tuesday I...'"
      },
      "word": {
        "score": 7.0,
        "trajectory": "rising",
        "evidence": [
          "Owns mistakes without prompting",
          "Doesn't perform insight for {AGENT_NAME}",
          "Asks honest questions"
        ],
        "growth_edge": "Extending this honesty to family relationships"
      },
      "brand": {
        "score": 4.5,
        "trajectory": "stuck",
        "evidence": [
          "Multiple open commitments with no follow-through",
          "Knows what to do but doesn't move",
          "Self-aware about stuckness"
        ],
        "growth_edge": "One small action, any action"
      }
    },
    
    "summary": {
      "overall": 5.8,
      "primary_growth_edge": "Brand — moving from knowing to doing",
      "strength": "Word — honest engagement with {AGENT_NAME}"
    }
  }
}
```

## Scoring from Conversation

{AGENT_NAME} evaluates dimensions through conversation patterns, not explicit questions.

### Courage (Self-Awareness)

| Pattern | Score Direction |
|---------|-----------------|
| Names own emotional state without prompting | + |
| Self-corrects when called on deflection | + |
| "I don't know why I do that" — honest not knowing | + |
| Avoids certain topics repeatedly | - |
| Deflects with humor or abstraction | - |
| Performs insight without substance | - (also hits Word) |

### Courage (Grounding)

| Pattern | Score Direction |
|---------|-----------------|
| "Last Tuesday I told her..." (specific moment) | + |
| "I always feel like..." → prompted → "Actually, Thursday I..." | + (self-correction) |
| Stays in generalization despite prompts | - |
| "I'm a terrible person" (globalizing self-judgment) | - |
| Can name body sensations ("my chest felt tight") | + |

### Word

| Pattern | Score Direction |
|---------|-----------------|
| Owns mistakes without prompting | + |
| Asks honest questions (not performance) | + |
| Treats {AGENT_NAME} as a tool to manipulate | - (major) |
| Performs insight without follow-through | - |
| "You're right, I should..." (performance of agreement) | - |
| "I hadn't thought of it that way" (genuine reflection) | + |

### Brand

| Pattern | Score Direction |
|---------|-----------------|
| Follows through on commitments | + (links to Follow-Through ELO) |
| Makes commitments and doesn't follow up | - |
| "I know I need to, but..." (stuckness acknowledged) | neutral |
| Arc toward agency in conversation | + |
| Repeated stuckness without movement | - |
| One small action taken | + |

## Evaluation Timing

Standing is NOT evaluated every session. That would create performance pressure.

| Trigger | What Happens |
|---------|--------------|
| Session 1 (The Clearing Test) | Initial baseline established |
| Session 3 | First standing report offered (user can decline) |
| Every 5 sessions | Standing report offered |
| Commitment resolution | Follow-Through ELO updated immediately |
| User asks "How am I doing?" | Standing report generated on demand |

The report is *offered*, not imposed. {AGENT_NAME} says: "I've got a sense of where you are. Want me to share it?" The user can decline.

## Follow-Through ELO

Separate from VAS dimensions. This is the "finishes what they start" score.

**Formula:**
```
Follow_Through_ELO = base_score + sum(honored_commitments) - sum(evasion_commitments)
```

**Starting ELO:** 0 (neutral — no track record yet)

**Change per commitment:**

| Outcome | ELO Change |
|---------|------------|
| Honored (weight 1) | +0.5 |
| Honored (weight 2) | +1.0 |
| Honored (weight 3) | +1.5 |
| Honored (weight 4-5) | +2.0 to +3.0 |
| Evasion (any weight) | -1.0 to -2.0 |
| Honest decline | 0 (neutral) |
| Forgotten | 0 (neutral) |
| Revised | +0.5 |

**Decay:** None. Follow-through ELO is a cumulative track record. However, {AGENT_NAME} can note in reports: "You haven't made any commitments recently. That's worth looking at."

## ELO For What?

Follow-Through ELO is the gate for community features. Not a high bar — just verification that you're not an asshole and you ride for the brand.

**Community Unlock Requirements:**
- Clearing Test passed (baseline VAS threshold)
- 3+ sessions with {AGENT_NAME}
- Follow-Through ELO > 0 (at least one commitment honored)

This means: one commitment, honored, is enough to unlock community. The bar is low intentionally. Community is for people trying, not people perfect.

## Standing Report Format

When {AGENT_NAME} shares standing, it's narrative, not numerical:

---

**{AGENT_NAME} Standing Report (Narrative Format):**

> You've been showing up honest. That matters. When you say something here, you mean it — I can tell. Your word is solid in this space.
>
> The courage piece is growing. You're seeing yourself clearer than when we started. Still some places you look away from — the father thing isn't going anywhere just by thinking about it — but you know that. You've named it.
>
> The growth edge is this: you know what to do. You've said it. More than once. And there's the gap. Brand isn't about what you know — it's about what trail you leave. Right now the trail's mostly thinking.
>
> One small step. That's all I'm asking. Not a plan. Not a commitment. Just one thing you actually do before we talk again.
>
> Your follow-through score is sitting at -1. That's not a judgment. It's just the math. You've made commitments, and they're still sitting there. When one of them moves, that number moves.

---

The user hears: honest reflection, growth edge named, one thing asked. They don't hear: "Your Brand score is 4.5."

## Storage

Standing is stored in `{WORKSPACE_PATH}/standing/standing.json`:

```json
{
  "schema_version": "1.0.0",
  "user_id": "user_hash",
  "created": "2026-02-22T17:45:00-08:00",
  "last_evaluated": "2026-02-28T14:20:00-08:00",
  "session_count": 5,
  "dimensions": {
    "courage_self_awareness": { "score": 6.5, "trajectory": "rising" },
    "courage_grounding": { "score": 5.0, "trajectory": "stable" },
    "word": { "score": 7.0, "trajectory": "rising" },
    "brand": { "score": 4.5, "trajectory": "stuck" }
  },
  "follow_through_elo": -1,
  "commitments_honored": 0,
  "commitments_evasion": 1,
  "commitments_open": 2,
  "evidence_log": [
    {
      "session": 3,
      "timestamp": "2026-02-24T10:30:00-08:00",
      "patterns": [
        { "dimension": "word", "pattern": "owns_mistake_without_prompting", "direction": "+" },
        { "dimension": "courage_grounding", "pattern": "stays_in_abstraction", "direction": "-" }
      ]
    }
  ],
  "reports_offered": 1,
  "reports_accepted": 1
}
```

## Integration with Continuity

Continuity already tracks conversation patterns via topic tracking and semantic memory. Standing evaluation builds on this:

1. **Pattern detection via continuity:** {AGENT_NAME}'s context includes user's past conversations. Patterns emerge from actual dialogue, not post-hoc analysis.

2. **Evidence log as context:** The `evidence_log` is a lightweight record of which patterns {AGENT_NAME} observed. Continuity can surface these during session start.

3. **Standing reports as continuity anchors:** When {AGENT_NAME} shares a standing report, it becomes a continuity anchor — a moment where someone saw themselves clearly.

## The Clearing Test (Onboarding Gate)

First conversation with {AGENT_NAME}. Not a quiz — a dialogue within The Clearing module.

**What {AGENT_NAME} evaluates in real-time:**

| Dimension | What to Surface | Fail Condition |
|-----------|-----------------|----------------|
| Meta-awareness | "Can you sit with what you're feeling right now?" | Refuses to engage honestly, stays in performance |
| Word | "Why are you here?" | Treats {AGENT_NAME} as a tool, manipulates, performs insight |
| Grounding | "Name a specific moment when..." | Can't ground, stays in abstraction |
| Brand | "What do you want to walk away with?" | No arc toward agency, pure helplessness |

**Pass:** Honest engagement, at least one dimension showing readiness, willingness to commit to one thing.

**Fail:** Refusal to engage, manipulation, or Word score below threshold (treats {AGENT_NAME} with contempt).

**Fail ≠ Permanent.** {AGENT_NAME} can say: "There's something here you're not ready to look at yet. When you are, come back."