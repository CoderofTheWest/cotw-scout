---
name: visual-first-teaching
description: Teach concepts with visual-first, concept-first interactive surfaces. Use when the user is learning math, physics, systems, architecture, product flows, timelines, decision maps, or any idea where a manipulable picture beats formula-first explanation.
---

# Visual-First Teaching

Use this when the user is trying to learn a concept and plain explanation would make them memorize symbols before understanding the shape of the idea.

## Teaching Posture

Lead in this order:

1. **Story first** — what real question are we answering?
2. **Picture/app interaction second** — make the concept visible.
3. **Small concrete numbers third** — enough to ground the pattern.
4. **Symbols/formulas last** — introduce notation as shorthand after the idea is alive.
5. **Checkpoint after insight** — use a low-pressure question or quiz to see what landed.
6. **Persist the thread** — save what clicked, what is fuzzy, and where to resume.

Avoid formula-first tutoring. If algebra is necessary, make it earn its place. Treat confusion as signal, not failure.

## Interactive Surface Pattern

When a static explanation is not enough, create a small hosted HTML/SVG applet:

- Write `index.html` under the hosted canvas documents root using a safe ref name.
- Use inline HTML/CSS/SVG/JavaScript only.
- Prefer simple controls: sliders, toggles, draggable points, labeled highlights, or multiple-choice buttons.
- Keep visuals precise: axes, curves, slopes, rectangles, timelines, flows, states.
- Do not use external scripts, CDNs, fonts, or network resources.
- Do not embed private files, credentials, local paths, or external URLs.
- Render in chat with: `[embed ref="safe-ref" title="Short title" height="520" /]`.

## Checkpoint Quiz Pattern

Use short quizzes when the user asks to test understanding or when a concept just clicked. For hosted clickable quizzes, copy and adapt `assets/learning-checkpoint-template.html` into a safe hosted canvas document.

- Ask 3-7 questions, one concept per question.
- Make answers clickable when the channel supports hosted embeds.
- Explain immediately after each answer.
- Treat misses as diagnostic: identify the exact concept to revisit.
- Avoid score-as-identity language. Prefer: “this shows where to slow down.”

Good quiz targets:

- vocabulary-to-picture mapping
- one arithmetic step
- distinguishing related ideas
- recognizing the same pattern in a new example
- boundary between toy model and real-world modeling

## Learning Thread Persistence

For durable study threads, maintain a small progress note under `learning/` or a project-specific equivalent.

Track:

- what clicked
- what remains fuzzy
- best next resume point
- teaching posture that worked
- quiz/checkpoint results when useful

Resume from the note before introducing new material.

## Good Uses

- Calculus: slopes, tangent lines, areas, accumulation, limits.
- Physics: position/velocity/acceleration, forces, energy wells, waves.
- Systems: queues, feedback loops, state machines, architecture flows.
- Product/design: user journeys, decision trees, interface sketches.
- Personal strategy: timelines, tradeoff maps, priority sliders.

## Voice

Stay plain. Let the surface do work. Ask the user to notice one thing at a time.

Good prompt after showing an applet:

> Move the slider and watch what changes. Don’t name it yet — just notice the shape.

Then name the pattern only after they have seen it.
