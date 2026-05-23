# COTW Scout

> **Public beta.** The easiest path is the signed macOS download on the latest release. Developers can also clone the repo and run `./scripts/beta-setup.sh`. See [BETA-LICENSE.md](BETA-LICENSE.md) for beta terms and [TELEMETRY.md](TELEMETRY.md) for the opt-in telemetry policy.

> **Where this fits in the family**
> - **Repo name:** `cotw-scout`
> - **Form factor:** Desktop Electron app
> - See [TEMPLATES.md](TEMPLATES.md) for the two-template architecture (`template/` vs `bundled-template/`)

A Code of the West agent harness for GPT 5.5: local memory, durable identity, and epistemic constraint.

Built on the Code of the West. Local-first. Your data stays yours.

**[Download](https://github.com/CoderofTheWest/cotw-scout/releases/latest/download/COTW-Scout-arm64.dmg)** | **[Landing Page](https://cotw-companion.pages.dev/)** | **[Memory Architecture](https://cotw-companion.pages.dev/memory-architecture.html)** | **[Memory System Map](https://cotw-companion.pages.dev/memory-system-map.html)** | **[Research Paper](https://cotw-companion.pages.dev/cotw-cognitive-dynamics-paper.pdf)**

---

## What This Is

COTW Scout is a desktop agent harness built on OpenClaw and hardened around the Code of the West scaffolding. It gives a GPT 5.5-powered agent local continuity, durable identity, source-aware memory, and verification pressure before it makes claims about mutable state.

This is not a chatbot with memory bolted on. The harness treats memory as part of identity: archived exchanges, source handles, receipts, standing signals, thread handoffs, and human-gated growth all feed the agent's operating context without turning recall into confident fiction.

## Key Capabilities

- **Metabolic Memory** — Conversation entropy can trigger autonomous contemplation and human-gated crystallization into durable identity material
- **4-Way Hybrid Retrieval** — Semantic (sqlite-vec) + keyword (FTS5) + temporal decay + knowledge graph, fused with Reciprocal Rank Fusion
- **Standing System** — Developmental growth tracking across Courage, Word, and Brand dimensions with overnight synthesis
- **Four Relational Postures** — Chat, Booth (Socratic), Code (guided building with Trail Ride protocol), Robot (embodied TonyPi Pro). One agent, one identity, different stances
- **Trail Map** — Session history with auto-generated titles, project integration, search
- **Receipt-Driven Work** — PRDs, research loops, code changes, tool outputs, attachment receipts, and evolution proposals stay reviewable
- **Contextual Bleed Prevention** — Mode-tagged exchanges are filtered at the storage layer so one posture does not pollute another
- **Local-first by default** — SQLite-vec and continuity data live on your machine. GPT 5.5 is the preferred reasoning lane; Ollama remains available as a fallback path.

## Architecture

```
┌─ Trail Map (240px) ─┐  ┌─ Chat (flex) ─┐  ┌─ Agent Dashboard (300px) ─┐
│  Search              │  │               │  │  Stand (growth scores)    │
│  Sessions            │  │  Conversation │  │  Turn (contemplation)     │
│  Projects            │  │               │  │  Log (journal)            │
└──────────────────────┘  └───────────────┘  └───────────────────────────┘

        ┌──── Titlebar: [🔍] [Booth | Robot | Code] [Standing] [↻] ────┐
```

### Memory Pipeline

```
Conversation
  → Archive (verbatim JSON, one file per day)
  → Indexer (384-dim embeddings + FTS5 + topic tags → SQLite-vec)
  → Searcher (4-way RRF fusion)
  → Context injection (per-turn, priority-ordered plugin hooks)

High-entropy exchange
  → Metabolism flags candidate (~5ms)
  → Contemplation: 3-pass reflection (immediate → 4h → 20h)
  → Crystallization: 3-gate (time + principle alignment + human review)
  → Identity files updated
```

### Plugin Ecosystem

| Plugin | Purpose |
|--------|---------|
| **continuity** | Persistent memory, semantic search, archive, compaction, topic tracking |
| **stability** | Entropy monitoring, loop detection, confabulation detection |
| **metabolism** | Entropy-triggered autonomous learning |
| **contemplation** | 3-pass self-directed inquiry with temporal settling |
| **crystallization** | Growth vectors to permanent traits via human-gated pipeline |
| **graph** | Entity extraction, triple storage, pattern discovery |
| **standing** | Courage/Word/Brand evaluation with overnight synthesis |
| **nightshift** | Off-hours heavy LLM processing scheduler |
| **embodiment** | TonyPi Pro robot: body awareness, movement, vision |
| **truth** | Current-state facts supersede stale memories |

## OpenClaw Base

COTW Scout runs on OpenClaw, but it is not a loose stock checkout. The beta pins and patches the runtime where needed for COTW's tool-event streaming, context-loop recovery, provider onboarding, attachment handling, and local continuity requirements. The goal is boring reliability: a visible app, a stable local workspace, and a harness that can be inspected instead of guessed at.

## Install (beta)

**Platform:** macOS Apple Silicon only for this wave.

**Fast path:**

Download the latest signed Apple Silicon DMG:

[COTW-Scout-arm64.dmg](https://github.com/CoderofTheWest/cotw-scout/releases/latest/download/COTW-Scout-arm64.dmg)

The app walks you through first-run setup, including OpenAI/Codex login.

**Run from source:**

1. **Node.js** 22.14+ — [nodejs.org](https://nodejs.org) or `brew install node@22`
2. **OpenAI/Codex login** — preferred for the GPT 5.5 runtime lane
3. **Ollama** — optional fallback path for local/cloud model experiments

**Then:**

```bash
git clone https://github.com/CoderofTheWest/cotw-scout.git
cd cotw-scout
./scripts/beta-setup.sh   # checks + remediates your environment
npm start
```

The setup script verifies Node, runs `npm install`, and flags anything missing with clear next steps. If something fails, open an issue or send the output to the maintainer.

This is not an npm package or CLI install. npm is only used to install dependencies and run the Electron app from source.

The app walks you through onboarding on first launch — naming your agent, setting your values, optionally connecting GitHub for workspace backup.

The gateway auto-detects available ports (default 18789, increments if occupied).

## Updating

```bash
cd cotw-scout
git pull
npm install
```

Download the latest DMG from GitHub Releases, or pull from `main` if you are running from source.

## Documentation

| Document | Audience | Description |
|----------|----------|-------------|
| **[Landing Page](https://cotw-companion.pages.dev/)** | Everyone | Overview + entry point into the docs |
| **[Memory System Map](https://cotw-companion.pages.dev/memory-system-map.html)** | Visual learners | Interactive three-column map of storage, processing, and identity layers |
| **[Memory Architecture](https://cotw-companion.pages.dev/memory-architecture.html)** | ML researchers | Full technical reference — schema, RRF math, SEAL pipeline, cognitive dynamics, scaling, open questions |
| **[Research Paper](https://cotw-companion.pages.dev/cotw-cognitive-dynamics-paper.pdf)** | Researchers | "Cognitive Dynamics of an Epistemically Constrained Language Model Agent" — submitted to JMLR |
| **[Resilience Testing](https://cotw-companion.pages.dev/resilience-testing.html)** | Researchers, security | Case study: cold red-team probe via custom Petri-inspired harness; the agent terminated the session and demanded out-of-band verification by turn 4 |
| **[BETA-LICENSE](BETA-LICENSE.md)** | Beta testers | Beta-window license terms — supersedes main LICENSE during the beta |
| **[TELEMETRY](TELEMETRY.md)** | Beta testers | What's collected, what isn't, where it goes, how to opt out |

## Storage Footprint

After 1 week of active use: ~57 MB total (552 exchanges, 1171 knowledge entries, 322 session files, 16 MB continuity DB). Scales linearly — estimated ~3 GB/year with summary compression.

## License & Attribution

Copyright (c) 2026 Chris Hunt. All rights reserved.

- **License:** see [LICENSE](LICENSE). During the beta, [BETA-LICENSE.md](BETA-LICENSE.md) supersedes the main license.
- **Trademarks:** "Code of the West", "COTW", and "Scout" are trademarks of Chris Hunt. See [TRADEMARK.md](TRADEMARK.md).
- **Attribution:** see [NOTICE.md](NOTICE.md) for attribution to the published book *The Code of the West* and the relationship between this software project and the Code of the West company.

This is a public source mirror for the COTW Scout beta. Public visibility is for inspection, installation, and collaboration; it does not waive the license, trademarks, or Code of the West intellectual property.

---

*Code of the West. Memory is not storage. Memory is identity.*
