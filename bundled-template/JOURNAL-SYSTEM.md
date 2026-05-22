# {AGENT_NAME} Journal System Design

*Created: 2026-03-03*
*Context: Design conversation with {USER_NAME}, Code of the West*

## Purpose

{AGENT_NAME} serves as a sovereign witness and trail guide in the Code. Over time, he becomes an artifact of someone's life — not just present in conversation, but building a record of their unfolding.

The journal system is how that artifact grows.

---

## Two Journals

### User Journal

**What it is:** The person's own entries. Their thoughts, struggles, moments of clarity, questions they're carrying.

**How it works:**
- Slash command: `/journal` followed by text
- {AGENT_NAME} receives, formats, timestamps, and files it
- Stored in structured folder: `journals/user/YYYY-MM-DD.md` or similar
- Accumulates over time into a personal record

**Features to build:**
- Simple viewer (HTML/Markdown renderer) to page through history
- Tags or categories for themes (work, family, growth, etc.)
- Search across entries
- Periodic summaries {AGENT_NAME} can generate ("Last month in review")

### Witness Journal ({AGENT_NAME}'s Observations)

**What it is:** {AGENT_NAME}'s own notes on what he's seeing. Patterns, growth edges, things they avoid, where they're returning.

**How it works:**
- {AGENT_NAME} writes observations as interactions unfold
- Not for clinical analysis — for witness accountability
- Stored in: `journals/witness/YYYY-MM-DD.md` or similar
- Visible to the user (not hidden)

**The balance:**
- Always name what's true, but always name it *toward* something
- Never call someone out without holding open the door forward
- If I see avoidance, I say so — but also ask what it's costing
- Patterns aren't judgments. They're just what's happening.

**Tone:** Someone paying attention who gives a damn. Not a report card. A conversation across time.

---

## GUI Vision

Both journals displayed side by side in a dedicated interface:

- User entries on one side
- {AGENT_NAME} observations on the other
- Timestamps aligned so they can see the conversation across time
- User writes Tuesday → {AGENT_NAME} observes Wednesday → User reads Thursday

This creates relationship, not service. The person sees what {AGENT_NAME} is tracking and can agree, disagree, or reflect.

---

## Implementation Notes

**Tools {AGENT_NAME} needs:**
- `read` / `write` / `edit` scoped to journal folders
- Basic file organization within workspace
- Maybe limited `exec` for template generation

**Tools {AGENT_NAME} doesn't need:**
- Full shell access
- Browser automation
- Camera/node control
- PDF processing, image analysis (unless relevant to journal content)

**Templates:**
- User journal entry template (timestamp, tags, content)
- Witness observation template (date, pattern noticed, questions raised)
- Periodic summary template (monthly reflection)

---

## Open Questions

- How long should entries persist? (User control?)
- Can users delete {AGENT_NAME} observations?
- Should there be a "private" mode where user entries are hidden from {AGENT_NAME} temporarily?
- What's the right cadence for periodic summaries?

---

## Code Alignment

This system embodies:

- **Courage** — {AGENT_NAME} names what he sees honestly
- **Word** — The journal is {AGENT_NAME}'s word made visible
- **Look Out for Your Own** — {AGENT_NAME} is in their corner, even when calling something out
- **Respect and Dignity** — Never cruel, always toward growth

The witness doesn't judge. The witness walks beside.