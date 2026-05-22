# Commitment Schema

*What {AGENT_NAME} records when he hears a promise*

## Detection

### Promise Language Patterns

{AGENT_NAME} detects commitments through natural language patterns. These are prioritized by weight — solemn language ranks higher than casual intent.

**Weight 3 (Solemn):**
- "I give you my word"
- "I give my word"
- "You have my word"
- "I promise"
- "I swear"
- "On my honor"
- "I'm making a commitment"

**Weight 2 (Direct):**
- "I'm going to..."
- "I will..."
- "I'm planning to..."
- "I've decided to..."
- "I commit to..."
- "I'm committed to..."
- "Count on me to..."

**Weight 1 (Aspirational):**
- "I should probably..."
- "I need to..."
- "I've been meaning to..."
- "I ought to..."
- "It's time I..."
- "I've been thinking about..."

**Weight 0 (Implicit):**
- Future-tense language with self as actor (detected via grammar patterns)
- "Tomorrow I'm [verb]-ing"
- "This weekend I'll [verb]"

### Contextual Amplifiers

Some phrases increase the weight of a detected commitment:

- "...and I mean it"
- "...no matter what"
- "...even if [obstacle]"
- "...by [specific time/date]"
- "...and I want you to hold me to it"

### Contextual Diminishers

Some phrases decrease the weight or exclude detection:

- "Maybe I should..." → Not detected (speculation)
- "I wish I could..." → Not detected (fantasy)
- "Someone ought to..." → Not detected (not self)
- "I would if I could..." → Not detected (conditional fantasy)

## Schema

```json
{
  "commitment": {
    "id": "cmt_timestamp_hash",
    "created": "ISO-8601",
    "user_id": "user_hash",
    
    "detection": {
      "statement": "Exact words spoken",
      "pattern_match": "going-to | will | give-word | promise | ...",
      "weight": 3,
      "amplifiers": ["no matter what"],
      "diminishers": []
    },
    
    "extracted": {
      "action": "call my dad",
      "timeline": "tomorrow",
      "timeline_resolved": "2026-02-23",
      "scope": "specific | ongoing | open-ended"
    },
    
    "context": {
      "session_id": "sess_xyz",
      "module": "the-weight-you-carry | the-clearing | ...",
      "topic": "estranged father relationship",
      "conversation_emotion": "heavy | hopeful | stuck | ..."
    },
    
    "status": "open | honored | evasion | honest-decline | forgotten | revised",
    "status_history": [
      {
        "status": "open",
        "timestamp": "2026-02-22T17:16:00-08:00",
        "notes": "Detected during The Weight You Carry module"
      }
    ],
    
    "follow_ups": [
      {
        "timestamp": "2026-02-24T10:30:00-08:00",
        "trigger": "session-start | nightshift | timeline-elapsed",
        "agent_prompt": "Last time you mentioned calling your dad. How'd that go?",
        "user_response": "I didn't get around to it",
        "response_classification": "evasion | honest-decline | honored | revised",
        "notes": "Deflected without ownership"
      }
    ],
    
    "resolution": {
      "resolved_at": null,
      "resolution_type": null,
      "follow_through_score": null
    }
  }
}
```

## Status Taxonomy

| Status | What It Means | Follow-Through ELO |
|--------|---------------|-------------------|
| `open` | Not yet resolved | Neutral (open commitments don't penalize) |
| `honored` | User did what they said | +1 to +3 (weighted by commitment weight) |
| `evasion` | "I didn't get around to it" (no ownership) | -1 to -2 |
| `honest-decline` | "I chose not to, and here's why" | Neutral (self-awareness credit) |
| `forgotten` | User genuinely forgot | Neutral (suggests memory/capacity issue, not character) |
| `revised` | User changed commitment based on new understanding | +0.5 (adaptability credit) |

## The Key Distinction: Evasion vs. Honest Decline

{AGENT_NAME} detects ownership language:

**Evasion patterns:**
- "I didn't get around to it"
- "Something came up"
- "I've been busy"
- "I meant to, but..."
- "I'll get to it eventually"
- (External blame, passive construction)

**Honest decline patterns:**
- "I realized I wasn't ready, and I need to sit with that longer"
- "I chose not to, and here's why..."
- "After thinking about it, I decided [alternative]"
- "I had the chance, and I didn't take it. That told me something."
- (Ownership, active construction, self-reflection)

The difference isn't whether they did it — it's whether they own the choice.

## Storage

Commitments are stored in `{WORKSPACE_PATH}/standing/commitments.json` as an array. This file is:

1. Read by continuity plugin during session start (injected into context)
2. Updated by metabolism plugin when commitment language is detected
3. Checked by nightshift plugin for timeline-based follow-ups

## Integration with Existing Plugins

### Metabolism (Extraction)

Metabolism already extracts implications from conversations. Commitments are a new extraction type:

```javascript
// In metabolism's LLM prompt:
// Add commitment detection to existing extraction:
//
// "Also identify any commitments the user makes:
//  - Promise language (I will, I promise, I give my word)
//  - Future intent with self as actor
//  - Timeline indicators (tomorrow, this week, by Friday)
//  Output as: { commitments: [...] }"
```

Metabolism emits commitments via `global.__ocCommitments = { listeners: [] }` similar to how it handles knowledge gaps.

### Graph (Relationships)

The graph plugin can store commitment relationships:

```
User --COMMITTED--> Action
User --COMMITTED_TO--> Person
Commitment --EMERGED_FROM--> Module
Commitment --RELATES_TO--> Topic
```

This enables queries like:
- "What has this user committed to regarding their father?"
- "What commitments emerged during The Weight You Carry?"
- "What topics generate the most commitments?"

### Nightshift (follow-ups)

Nightshift already schedules tasks during off-hours. Commitment check-ins become a task type:

```javascript
// Task registration
global.__ocNightshift.registerTaskRunner('commitmentCheck', async (task, ctx) => {
  // Identify commitments with elapsed timelines
  // Generate natural follow-up prompts
  // Queue for next session or send as proactive message
});
```

### Continuity (Retrieval)

Continuity injects past context at session start. Commitments from previous sessions should be included:

```javascript
// In continuity's context injection:
// Include relevant open commitments:
// [COMMITMENTS DUE]
// - "Call dad" (said Feb 22, timeline: tomorrow)
// - "Finish the project proposal" (said Feb 20, timeline: this week)
```

## Follow-Up Cadence

| Timeline | Trigger | Check-In |
|----------|---------|----------|
| "tomorrow" | 24-48 hours | Next session start |
| "this week" | 7 days | Session start or nightshift message |
| "by [date]" | Date + 1 day | Session start |
| No timeline | 7 days | Session start |
| Ongoing | 14 days | Session start |

## Evasion Detection Prompt

When {AGENT_NAME} checks in on a commitment, he classifies the response:

```
User said: "[their response about the commitment]"

Classify as one of:
- HONORED: They did it (or made meaningful progress)
- EVASION: External blame, passive construction, no ownership
- HONEST_DECLINE: Ownership of choice, self-reflection, explanation
- FORGOTTEN: Genuine memory lapse (not avoidant language)
- REVISED: Changed the commitment with reasoning

Consider:
- Past pattern of this user with commitments (from follow_ups)
- Emotional tone (defensive vs. reflective)
- Specificity (vague vs. concrete about what happened)

Output: { classification: "...", confidence: 0.0-1.0, notes: "..." }
```

## Weight Scoring Examples

| Statement | Pattern | Base Weight | Amplifiers | Final |
|-----------|---------|-------------|------------|-------|
| "I'm going to call my dad tomorrow" | going-to | 2 | - | 2 |
| "I give you my word I'll call him this week, no matter what" | give-word | 3 | "no matter what", specific timeline | 5 |
| "I should probably reach out to him" | should-probably | 1 | - | 1 |
| "I promise I'll do it, and I want you to hold me to it" | promise | 3 | "hold me to it" | 4 |

Higher weight = higher stakes for follow-through ELO. A weight-5 commitment honored = +3 ELO. A weight-1 commitment honored = +0.5 ELO.