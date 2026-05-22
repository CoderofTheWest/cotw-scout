# Template Architecture

This repo ships with **two parallel template directories**. They must stay in sync, but historically they've drifted. This doc explains what each is for and how to keep them mirrored.

## The two templates

| Directory | Used when | How it's resolved |
|---|---|---|
| `template/` | Electron **dev mode** (running from source) | `main.js:139-141` picks this when `isDev` is true |
| `bundled-template/` | Packaged **.app** distribution | `main.js:139-141` picks this when running inside the packaged build — reads from `resourcesPath` |

Both contain identical structure: `BOOTSTRAP.md`, `AGENTS.md`, `SOUL.md`, `standing/`, `skills/`, etc. — the files that seed a fresh agent's identity and behavior at first run.

## Why two

Electron packaging needs template files co-located with the built app under `Contents/Resources/`. `bundled-template/` is the directory the packager picks up. `template/` is what dev mode reads from the source tree. Shipping both in the repo means the same content flows to both paths.

## The cost: drift

They can (and do) drift. Fixes land in `template/` without being mirrored to `bundled-template/` — which means the packaged .app can silently lag behind dev mode. Confirmed examples:

- `aff3d62` — declared-vs-exchanged provenance rules (Ellis-backprop fix)
- `b0985a0` — `OPERATING-PRINCIPLES.md` addition
- `dc20014` — skill-based contemplation pass runner

All three originally hit `template/` only. This is the class of bug that shows up as "we fixed that — why is it still happening?"

## How to sync (current workflow)

Treat **`template/` as the source of truth.** After any edit:

```bash
cd cotw-scout
rsync -a template/ bundled-template/
git add template/ bundled-template/
git commit -m "..."
```

Don't edit `bundled-template/` directly unless you intend to sync back to `template/`.

## Drift guard

Run `npm run check:templates` to verify the two directories are in sync. The script (`lib/check-templates.js`) walks both trees, hashes each file, and reports any missing files or content differences. Exits 0 if synced, 1 if drift is detected. No external dependencies.

This is the recommended check before committing any template change. Wire it into CI when CI is set up.

## Future improvement

The right long-term shape is one template directory plus a build-time copy step (either a postinstall script or electron-builder's `extraResources` config). Deferred — tracked as a future PRD.

## What lives *outside* these templates

- **Live agent workspaces** — `~/Library/Application Support/cotw-scout/workspace/` (packaged) or equivalent userData dir for dev mode. Each agent instance's actual conversation history, standing files, journals, memory. The templates **never touch live workspaces** — they only seed new ones on first install.
- **Bundled plugins** — `bundled-plugins/openclaw-plugin-*/`. Behavioral plugins (continuity, standing, contemplation). Different concern from templates; don't get copied via the template sync.

## What's in the templates that's *intentionally* retained

- `knowledge/manual-atlas.md` contains references to **Chris Hunt** — these are author attribution for the published Code of the West book, not operator contamination. Do not sanitize.
- `skills/scout/SKILL.md` contains a credit line for **Clint's Scout tool** — historical attribution, not contamination. Do not sanitize.

## Sanitization contract

The templates must never contain:

- Real agent names (e.g., `Ellis`, `Wren`) — use `{AGENT_NAME}` placeholder
- Real operator names — use `{USER_NAME}` placeholder (except the manual-atlas exception above)
- Hardcoded workspace paths (`/Users/clint/.openclaw/...`) — use `{WORKSPACE_PATH}` placeholder
- Live credentials (API keys, tokens) — reference env vars (e.g., `${JINA_API_KEY}`)
- Operator-specific file paths (e.g., `/Users/clint/robot/.env`) — generic guidance ("set in your environment")

A new install of the Companion should boot a **blank-slate agent**, not a snapshot of someone else's workspace.
