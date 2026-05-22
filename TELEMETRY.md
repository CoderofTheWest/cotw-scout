# COTW Scout — Telemetry

*This document describes what the app collects when telemetry is enabled. Telemetry is **opt-in**; default is off. You can change your choice at any time in Settings → Telemetry.*

## What gets collected (when opted in)

**Per turn:**
- Turn number in session
- User + assistant message counts
- Assistant response length (character count, not content)
- Current entropy score
- Cognitive-dynamics metrics: surprise (frozen + learned), state vector, 64-dim encoder latent, learner loss, feature counts

**Per session:**
- Session duration
- Total turn count
- Module usage counts (which situational modules engaged, not their contents)
- Error count
- Standing score snapshot (Courage self/ground, Word, Brand — the numbers only)
- Contemplation counts (total, active, completed, deliberate — no contents)

**Per installation:**
- Anonymized `agent_id` (the name you gave your agent; consider changing it if you'd prefer less identifiability)
- Server-side receive timestamp (added by the Cloudflare endpoint)

## What is never collected

- Conversation content — not summaries, not snippets, not at all
- ANCHOR.md, MEMORY.md, IDENTITY.md, SOUL.md
- User journal entries or witness journal entries
- Contemplation text, insight text, inquiry content
- Your name, email, address, or explicit PII
- Your IP address beyond what Cloudflare's edge sees for routing (not logged by the application)

## Where it goes

1. **Locally** — the plugin appends to `<workspace>/telemetry.jsonl`. This file is plain text. You can read it at any time.
2. **Upstream** — if private beta sync is configured, nightshift can POST batched entries to a private Cloudflare Worker controlled by Chris and store them in a Cloudflare D1 database accessible only to Chris. Public packaged defaults leave upstream sync disabled and do not include an ingest secret.

Transmission is over HTTPS with a shared auth secret per beta.

## Why we collect it

Two reasons:

1. **Product iteration** — understanding real-world session patterns helps us find bugs, prioritize features, and notice when the app makes life harder rather than easier.
2. **Cognitive Dynamics research** — the state-vector and latent metrics feed an ongoing research thread (see the research paper in `docs/`) exploring how agent internal states evolve over time.

## Retention

Minimum 90 days through the beta period. To be evaluated at GA — at which point you'll get a revised telemetry policy to accept or decline.

## Opt out any time

**Settings → Telemetry → off.** The switch takes effect immediately. Past entries in `telemetry.jsonl` remain on your disk (you can delete them). Past batches already synced to the Worker remain in the beta dataset.

If you want past-sync entries deleted, reach out to Chris and it can be removed from D1 keyed by `agent_id`.

## Questions

Reach out directly. Nothing secret about the pipeline — the Worker source is in `telemetry-worker/src/index.js` and the plugin code is in `bundled-plugins/openclaw-plugin-telemetry/`.
