# COTW Scout — Context Injection Map

What the agent receives on each exchange, in execution order. Read this to understand what the agent "sees" and where each piece lives on disk.

## 1. Identity Prompt (Gateway)

Loaded by OpenClaw on agent init from the workspace directory. Every `.md` file here becomes part of the base prompt.

**Directory:** `bundled-template/`

| File | Purpose |
|------|---------|
| `IDENTITY.md` | Core identity declaration |
| `BOOTSTRAP.md` | First-run onboarding (self-destructs after use) |
| `SOUL.md` | Principles, posture, epistemic grounding |
| `OPERATING-PRINCIPLES.md` | How identity + constraints + memory interact as a system |
| `AGENTS.md` | Session protocol, memory rules, source-anchoring discipline |
| `TRAILHEAD.md` | User's current tier and progression state |
| `USER.md` | User context template |
| `ANCHOR.md` | Who the user is (relational anchor profile) |
| `MEMORY.md` | Agent's curated long-term memory |
| `TOOLS.md` | Available tools and usage guidance |
| `JOURNAL-SYSTEM.md` | Journaling protocol |
| `LENSES.md` | Four lenses framework |
| `HEARTBEAT.md` | Background task config |
| `SESSION_HANDOFF.md` | Template for session handoff format |
| `EMBODIMENT_NOTEBOOK.md` | Embodiment session notebook |

**Subdirectories:**

| Path | Purpose |
|------|---------|
| `booth/SOUL-BOOTH.md` | Booth mode identity overlay |
| `booth/AGENTS-BOOTH.md` | Booth mode behavioral rules |
| `standing/standing-schema.md` | Standing system schema |
| `standing/standing-evaluation.md` | How standing evaluation works |
| `standing/commitment-schema.md` | Commitment tracking format |
| `standing/commitment-loop.md` | Commitment lifecycle |
| `standing/scheduled-reflection.md` | Reflection scheduling |
| `training-grounds/TRAINING-GROUNDS.md` | Code mode / Training Grounds protocol |
| `training-grounds/SPINE-WEEK-1.md` | Week 1 lesson plan (9 lessons) |
| `skills/*/SKILL.md` | 20 skills (each in own directory) |

## 2. Plugin Injections (`before_agent_start` hooks)

Plugins prepend context blocks before each exchange. Ordered by priority (lower = earlier).

### Stability (priority 5)

**Plugin:** `bundled-plugins/openclaw-plugin-stability/index.js`
**Config:** `bundled-plugins/openclaw-plugin-stability/config.default.json`

Injects `[STABILITY CONTEXT]`:
- Entropy score + label (nominal/active/elevated/CRITICAL)
- Growth vectors (if entropy elevated)
- Posture drift nudge (if agent stuck in task mode)
- Embodiment session debrief (one-shot, if queued)

### Contemplation (priority 6-7)

**Plugin:** `bundled-plugins/openclaw-plugin-contemplation/index.js`
**Config:** `bundled-plugins/openclaw-plugin-contemplation/config.default.json`
**Reflection engine:** `bundled-plugins/openclaw-plugin-contemplation/lib/reflect.js`
**Inquiry store:** `bundled-plugins/openclaw-plugin-contemplation/lib/inquiry.js`
**Data:** `bundled-plugins/openclaw-plugin-contemplation/data/agents/trail-guide/inquiries.json`

Two injections:
1. Anticipatory insight — max 1 relevant insight surfaced per turn
2. `[CONTEMPLATION STATE]` — active inquiries (up to 3 with pass progress) + recent completed insights (last 7 days)

### Continuity (priority 10)

**Plugin:** `bundled-plugins/openclaw-plugin-continuity/index.js`
**Config:** `bundled-plugins/openclaw-plugin-continuity/config.default.json`
**Archive:** `bundled-plugins/openclaw-plugin-continuity/data/agents/trail-guide/archive/`
**Database:** `bundled-plugins/openclaw-plugin-continuity/data/agents/trail-guide/continuity.db`
**Storage modules:**
- `bundled-plugins/openclaw-plugin-continuity/storage/archiver.js` — daily JSON archives
- `bundled-plugins/openclaw-plugin-continuity/storage/indexer.js` — SQLite-vec semantic index
- `bundled-plugins/openclaw-plugin-continuity/storage/searcher.js` — retrieval + temporal re-ranking
- `bundled-plugins/openclaw-plugin-continuity/storage/summary-store.js` — hierarchical summary DAG
- `bundled-plugins/openclaw-plugin-continuity/storage/knowledge-store.js` — workspace knowledge index
- `bundled-plugins/openclaw-plugin-continuity/lib/topic-tracker.js` — topic extraction + fixation
- `bundled-plugins/openclaw-plugin-continuity/lib/continuity-anchors.js` — identity/contradiction/tension moments
- `bundled-plugins/openclaw-plugin-continuity/lib/compactor.js` — context compaction strategies

Injects `[CONTINUITY CONTEXT]` containing (conditionally):
- Session info (exchange count, duration)
- Wellbeing awareness (sustained work, mealtime, late night)
- `[SESSION HANDOFF]` — previous session summary *(first exchange only, one-shot, deleted after read)*
- `[NIGHTSHIFT REPORT]` — overnight processing results *(first exchange only, one-shot)*
- `[THREAD CONTEXT]` — warm start + thread handoff *(first exchange in non-main thread, persistent)*
- `[CONSOLIDATION NOTICE]` *(if compaction threshold hit)*
- Continuity anchors *(if entropy > 0.4)*
- Archive retrieval — semantically matched past exchanges with anti-hallucination framing
- Knowledge injection — workspace-derived operational knowledge

### Standing

**Plugin:** `bundled-plugins/openclaw-plugin-standing/index.js`
**Config:** `bundled-plugins/openclaw-plugin-standing/config.default.json`
**Synthesis:** `bundled-plugins/openclaw-plugin-standing/lib/synthesis.js`
**Patterns:** `bundled-plugins/openclaw-plugin-standing/lib/patterns.js`
**Data (workspace):** `standing/standing.json`, `standing/evidence_log.json`, `standing/synthesis_history/`, `standing/reports/`

Injects standing context: current scores (courage_self, courage_ground, word, brand), growth edges, trajectories, evidence summaries.

### Code-Evolution (code mode only)

**Plugin:** `bundled-plugins/openclaw-plugin-code-evolution/index.js`
**Scaffold manager:** `bundled-plugins/openclaw-plugin-code-evolution/lib/scaffoldManager.js`
**Executable rules:** `bundled-plugins/openclaw-plugin-code-evolution/lib/executableLoader.js`
**Session recorder:** `bundled-plugins/openclaw-plugin-code-evolution/lib/sessionRecorder.js`

Injects `[WHAT YOU'VE LEARNED IN CODE MODE]` — proprioceptive header for the agent's evolved code-session knowledge (tool hints, learned rules, workflow patterns, active executable rules). First-person framing matches continuity / stability injection style so the content lands as self, not as external briefing.

## 3. Main Process Injection (chat:send)

**File:** `main.js` (chat:send handler, ~line 1186+)

Prepended to the user message before it reaches the gateway:

| Block | Condition | One-shot? |
|-------|-----------|-----------|
| `[SESSION START — FRESH CONTEXT]` | First message after app restart, normal mode | Yes |
| `[MODE EXIT: ...]` | Just left a mode, now in normal chat | Yes |
| Interrupted tool calls note | Previous tools stopped mid-execution | Yes |
| `[EMBODIMENT SESSION START]` | Embodiment mode entry | Flag-cleared |
| `[BOOTH SESSION]` | Booth mode (full context on entry, lite every 5 msgs) | Flag-based |
| `[CODE SESSION]` or `[TRAINING GROUNDS SESSION]` | Code mode (full on entry, lite every 5 msgs) | Flag-based |

## 4. Nightshift (Overnight Processing)

**Plugin:** `bundled-plugins/openclaw-plugin-nightshift/index.js`
**Config:** `bundled-plugins/openclaw-plugin-nightshift/config.default.json`

Not injected directly — runs tasks overnight that produce artifacts other plugins inject:
- Standing synthesis → updates `standing/standing.json`
- Contemplation passes → updates `inquiries.json`
- Crystallization → updates growth vectors
- Metabolism batch → extracts gaps for contemplation

Results surface via `NIGHTSHIFT_REPORT.md` (injected by continuity on next session start).

## 5. Other Plugins (not injecting context)

| Plugin | Directory | Role |
|--------|-----------|------|
| Metabolism | `bundled-plugins/openclaw-plugin-metabolism/` | Extracts cognitive gaps from conversation → feeds contemplation |
| Crystallization | `bundled-plugins/openclaw-plugin-crystallization/` | Crystallizes recurring patterns into growth vectors |
| Cognitive Dynamics | `bundled-plugins/openclaw-plugin-cognitive-dynamics/` | JEPA-modulated surprise/entropy tracking |
| Graph | `bundled-plugins/openclaw-plugin-graph/` | Knowledge graph construction |
| Threads | `bundled-plugins/openclaw-plugin-threads/` | Thread lifecycle management |
| Planmode | `bundled-plugins/openclaw-plugin-planmode/` | Plan creation + tracking |
| Embodiment | `bundled-plugins/openclaw-plugin-embodiment/` | TonyPi robot body integration |
| Truth | `bundled-plugins/openclaw-plugin-truth/` | Fact verification against knowledge.db |
| Tool Provenance | `bundled-plugins/openclaw-plugin-tool-provenance/` | Tracks tool call history |
| Telemetry | `bundled-plugins/openclaw-plugin-telemetry/` | Usage metrics (opt-in) |

## 6. Gateway Config

**File:** `openclaw.json` — agent definition, plugin paths, heartbeat config, model settings.
