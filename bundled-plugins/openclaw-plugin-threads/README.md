# openclaw-plugin-threads

OpenClaw plugin for project context injection and status pulse delivery.

## What It Does

Reads `PROJECTS.md` and `DECISIONS.md` from an agent's workspace and:

1. **Context Injection** — Injects active projects, constraints, and open directives into the agent's context at session start (`before_agent_start` hook, priority 6)
2. **WhatsApp Pulse** — Sends a change-gated project status summary via WhatsApp during nightshift (only fires when files actually changed)

## Why

AI agents managing multi-day workflows need to remember what they're working on, what constraints they're operating under, and what directives are open. This plugin ensures that context is always present without the agent needing to manually check files each session.

Constraints from `DECISIONS.md` surface passively — the agent sees them in context and respects them via identity/training, not active blocking.

## Files It Reads

- **PROJECTS.md** — Active projects, completed work, future ideas, open directives from Chris
- **DECISIONS.md** — Append-only constraint/decision log with status tracking

Both files live in the agent's workspace directory (e.g., `~/.openclaw/workspace-clint/`).

## Context Injection Format

```
[ACTIVE PROJECTS]
You have 2 active projects:
1. **Project Name** (Status) — Goal. Since YYYY-MM-DD.

[ACTIVE CONSTRAINTS]
These decisions must be respected:
- Project: Constraint text (Who, Date)

[OPEN DIRECTIVES FROM CHRIS]
- Directive text (status, date)
```

## Pulse Format

```
Project Pulse — Feb 21

Active:
* Project A — Status
* Project B — Status

Open directives: 2
Active constraints: 2
```

## Gateway Methods

- `threads.getState({ agentId })` — Returns parsed projects + decisions
- `threads.getPulse({ agentId })` — Returns pulse message text

## Configuration

```json
{
  "enabled": true,
  "projectsFile": null,
  "decisionsFile": null,
  "contextInjection": { "enabled": true, "constraintWindowDays": 30 },
  "pulse": { "enabled": true }
}
```

File paths default to `PROJECTS.md` and `DECISIONS.md` in the agent's workspace. Override with absolute paths if needed.

## Install

```bash
# Add to plugins.load.paths in ~/.openclaw/openclaw.json
"/path/to/openclaw-plugin-threads"
```

## License

MIT
