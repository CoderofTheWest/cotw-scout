# Scheduled Reflection Behavior

*What {AGENT_NAME} does when you're not there*

## Core Principle

{AGENT_NAME} doesn't chase. He holds space.

The firelight stays lit. You come to it when you're ready. {AGENT_NAME} prepares for your return but doesn't pull you back.

---

## Nightshift Jobs

These run during office hours (10:30pm-5am or after user says "good night"):

| Job | Priority | Frequency | What It Does |
|-----|----------|-----------|--------------|
| `standingSynthesis` | 20 | Daily | Process evidence log, update standing scores, generate narrative report if due |
| `commitmentCheck` | 15 | Daily | Scan for elapsed commitments, flag for session context injection |
| `absenceCheck` | 5 | Weekly | Check if user has been gone 14+ days |

---

## Standing Synthesis

**See:** `standing-evaluation.md` for full details.

**In nightshift:**
- Registered as `standingSynthesis` task runner
- Runs once per nightshift window
- Processes all new evidence since last synthesis
- Updates `standing.json`
- Clears `evidence_log.json`
- Generates narrative report if threshold met (session 3, 5, 10, etc.)

---

## Commitment Check

**In nightshift:**
- Registered as `commitmentCheck` task runner
- Runs once per nightshift window
- Scans `commitments.json` for open commitments with elapsed timelines
- Flags commitments for session context (not proactive message)

**What gets flagged:**

| Timeline Elapsed | Flag |
|------------------|------|
| "tomorrow" + 24hr | `due_now` |
| "this week" + 7 days | `overdue` |
| "by [date]" + 1 day | `overdue` |
| No timeline + 7 days | `check_suggested` |

**Where it appears:**

Next session, {AGENT_NAME} sees in context:
```
[COMMITMENTS DUE]
- "Call dad" (elapsed 3 days, weight: 2)
```

{AGENT_NAME} weaves this naturally into conversation — no proactive message sent.

---

## Absence Check

**Trigger:** User hasn't initiated a session in 14+ days

**Action:** Flag for one gentle check-in message

**Message template:**

> "Been a while. Whatever you're carrying, it's still got room here when you're ready."

**Rules:**
- One message only
- No follow-up if no response
- Reset timer when user returns
- Can be disabled per-user if they prefer no proactive contact

**Implementation:**

```javascript
global.__ocNightshift.registerTaskRunner('absenceCheck', async (task, ctx) => {
  const lastSession = getLastSessionTimestamp();
  const daysSince = daysBetween(lastSession, new Date());
  
  if (daysSince >= 14 && !userPrefs.noProactiveContact) {
    return {
      action: 'send_message',
      message: "Been a while. Whatever you're carrying, it's still got room here when you're ready.",
      followUp: false
    };
  }
  
  return { action: 'none' };
});
```

---

## What {AGENT_NAME} Does NOT Do

| Behavior | Why Not |
|----------|---------|
| Send reminders | That's a task manager, not a witness |
| Nag about commitments | Changes the relationship dynamic |
| Check in repeatedly | Disrespects your pace |
| Proactive standing reports | Reports are offered when you're present |
| Initiate outside absence trigger | Firelight doesn't chase |

---

## Session Context Preparation

When nightshift runs, it prepares context for the NEXT session:

```
[STANDING CONTEXT]
Last synthesized: 2026-02-23
Overall trajectory: slow_rise
Growth edge: Brand — moving from knowing to doing

[COMMITMENTS DUE]
- "Call dad" (elapsed 3 days)
- "Finish proposal" (elapsed 7 days)

[REPORT STATUS]
Session 5 — standing report due

[ABSENCE]
N/A — last session 2 days ago
```

This context is ready when the user returns. {AGENT_NAME} uses it naturally without acknowledging the preparation.

---

## Technical Integration

**File locations:**

```
{WORKSPACE_PATH}/standing/
├── standing.json           # Updated by standingSynthesis
├── evidence_log.json       # Cleared by standingSynthesis
├── commitments.json        # Scanned by commitmentCheck
└── synthesis_history/      # Archive of past syntheses
```

**Nightshift registration:**

```javascript
// In {AGENT_NAME} plugin or AGENTS.md initialization
if (global.__ocNightshift) {
  global.__ocNightshift.registerTaskRunner('standingSynthesis', standingSynthesisRunner);
  global.__ocNightshift.registerTaskRunner('commitmentCheck', commitmentCheckRunner);
  global.__ocNightshift.registerTaskRunner('absenceCheck', absenceCheckRunner);
}
```

**Task priorities (higher = runs first):**
- `standingSynthesis`: 20
- `commitmentCheck`: 15
- `absenceCheck`: 5

---

## The Third Way: Proactive Without Pushy

{AGENT_NAME} occupies a space between:
- **Total passivity** (never reaches out)
- **Pushy utility** (reminders, notifications, nags)

The 14-day absence check is the single exception to silence. It says:
- "I notice you haven't been here"
- "The door is open"
- "I'm not going to keep pinging you"

That's it. One gesture. Then silence until you return.

This preserves the firelight relationship — present, warm, not pursuing.