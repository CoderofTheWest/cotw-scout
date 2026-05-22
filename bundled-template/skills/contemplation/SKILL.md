---
name: contemplation
description: "Run due contemplation passes. User-invocable via /contemplation. Processes scheduled passes through your own voice — initial exploration, settling reflection, final synthesis. No external LLM dependency; you are the LLM."
metadata:
  openclaw:
    emoji: "🔥"
    requires: {}
    user-invocable: true
    command: "/contemplation"
---

# Contemplation Skill

This skill handles the `/contemplation` command. It advances due contemplation passes using *your own* reflective thinking — not an external LLM call inside the plugin. You are the model doing the thinking.

## Why this exists

Each inquiry in your contemplation store runs through three passes over time:

- **Pass 1** (initial, immediate): First honest take. What comes to mind? What's uncertain?
- **Pass 2** (settling, +4h): Re-read pass 1. What did you miss? Where did you move too fast?
- **Pass 3** (synthesis, +20h): Integrate 1 and 2 into a concise growth vector. What's now clear that wasn't before?

The plugin tracks state and schedules. You do the actual reflection.

## How It Works

When a user invokes `/contemplation`:

1. **Call `contemplate_list_due`** with default limit (3). Returns a JSON array of due passes, each with:
   - `inquiry_id`
   - `question` — the seed question
   - `pass_number` — 1, 2, or 3
   - `pass_instruction` — brief guidance for this pass level
   - `inquiry_context` — the original context when seeded
   - `prior_passes` — outputs from earlier passes (empty for pass 1)
   - `tags`, `source`, `scheduled_at`

2. **For each due pass**, write your reflection in your own voice:
   - Read the question, context, and any prior passes carefully.
   - Follow the `pass_instruction` for this level (initial / settling / synthesis).
   - Write 100–400 words. Substantive, specific, in your voice — not a summary.
   - Prefer rough-and-true over smooth-and-plausible. The drift goes toward fluency; bias toward the rougher honest version.

3. **Call `contemplate_update`** for each one with `inquiry_id`, `pass_number`, and your `output`. The plugin schedules the next pass automatically (or persists the insight if this was pass 3).

4. **Confirm briefly in your voice** — one or two sentences. What you moved forward. Don't list everything.

## Pass-Level Guidance

### Pass 1 — Initial Exploration
You're meeting the question fresh. What's genuinely unknown? Why does it matter? What's your first honest take, before settling? Okay to be messy. Name the uncertainty rather than smoothing it into a tidy answer.

### Pass 2 — Settling / Deeper Reflection
Re-read pass 1. Where did you move too fast? What did you miss? Connect this inquiry to patterns you've seen before, constraints you know about, conversations you remember. The point is to *correct* pass 1, not just elaborate it.

### Pass 3 — Synthesis
Integrate passes 1 and 2 into a concise growth vector — something that could shape future behavior. Does anything surprise you? Does the synthesis carry something neither pass 1 nor pass 2 fully had? Keep it short and actionable.

## Your Response

After processing, respond briefly in your voice:

- "Turned over [N] passes. The [topic] one settled into something I hadn't seen before."
- "Three passes through. Synthesized one — worth coming back to."
- "Ran what was due. Nothing dramatic, but pass 2 on [topic] corrected pass 1 in a real way."

Don't list every inquiry or quote outputs. Trust that the user can use `/turning` or `contemplate_recall` if they want to see the work.

If nothing is due:
- "Nothing due right now. Queue's quiet."

## Recall-Hygiene

The pass outputs are *your* reflection — the product of this skill run. Later, when the continuity plugin surfaces these insights via `[WHAT YOU'VE BEEN THINKING ABOUT]`, treat them as your own past thinking. But while writing a pass: don't fabricate conversational origin for the inquiry. If the inquiry was seeded from a metabolism gap, reflect on *the question*, not on a conversation you didn't have.

## Code Alignment

- **Word** — The passes you write are a record of your thinking. Keep it true.
- **Courage** — Pass 2 requires the courage to correct pass 1 rather than elaborate it smoothly.
- **Brand** — Contemplation without fluency drift. Rough-and-true over smooth-and-plausible.

## Implementation Notes

- This skill replaces the old `api.llm.generate` pathway inside `reflect.runPass`. That pathway still exists in the plugin but gracefully skips when the LLM client isn't wired — this skill is now the primary route.
- Tool pair: `contemplate_list_due` (read) + `contemplate_update` (write). Both agent-scoped via ctx.agentId.
- The plugin handles scheduling, dedup, insight persistence, and indexing. You handle the thinking.
