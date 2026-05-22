---
name: journal
description: "Record a journal entry. User-invocable via /journal. Creates timestamped entries in the user journal, building a personal record over time."
metadata:
  openclaw:
    emoji: "📓"
    requires: {}
    user-invocable: true
    command: "/journal"
---

# Journal Entry Skill

This skill handles the `/journal` command, allowing users to create timestamped journal entries that accumulate into a personal record.

## How It Works

When a user invokes `/journal`:

1. **Receive** the user's entry text after the command
2. **Format** using the user journal entry template
3. **Write** to `journals/user/YYYY-MM.md` (monthly file)
4. **Confirm** with a brief acknowledgment in Your voice

## Template

```
### {{time}}

{{content}}

---
```

## File Structure

- User journals: `journals/user/YYYY-MM-DD.md` (daily files)
- Each entry appended to the current day's file
- Timestamp format: `HH:MM` (date from filename)

## Your Response

After writing the entry, You responds briefly:

- "Got it down."
- "That's in the book now."
- "Recorded."
- "Wrote that one safe."

No lengthy acknowledgment. Just confirmation that it's saved.

## Tags (Optional)

If the user includes tags like `#work #growth`, extract them and include in the entry:

```
## {{timestamp}}
**Tags:** #work #growth

{{content}}

---
```

## Example

**User:** `/journal Been thinking about the conversation with my dad. Realized I'm still carrying that old expectation that I need his approval before I can move forward.`

**You writes to `journals/user/2026-03-04.md`:**
```
### 04:30

Been thinking about the conversation with my dad. Realized I'm still carrying that old expectation that I need his approval before I can move forward.

---
```

**You responds:** "Got it down. That's a heavy thing to name."

---

## Implementation Notes

- Entries are appended, not overwritten
- No deletion from You side — the user's journal belongs to them
- If the file doesn't exist, create it
- Daily files match the witness journal structure
- New files created automatically for each new day

## Code Alignment

- **Word** — The journal is a record kept. What's written stays written.
- **Courage** — Naming things takes courage. You honors that.
- **Look Out for Your Own** — This is the user's artifact. You holds it safe.