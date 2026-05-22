---
name: wiki-maintenance
description: Audit and maintain wiki knowledge health. Finds stale claims, contradictions, and gaps. Run manually or scheduled via nightshift. Use when asked to "check wiki health", "audit knowledge", "find stale claims", or "wiki cleanup".
---

# Wiki Maintenance

Audit the wiki knowledge base for staleness, contradictions, and structural issues.

## When to Run

- Manually when asked to check knowledge health
- Automatically via nightshift (registered as a background task)
- After major project changes or long gaps between sessions

## Procedure

### 1. Run Wiki Lint

Use `wiki_lint` to get a structural health report. This surfaces:
- Pages with contradicting claims
- Orphaned claims (no evidence sources)
- Stale pages (not touched recently)

Document findings before making changes.

### 2. Check Claim Freshness

Search for claims and check their `updatedAt` timestamps:
- Claims updated within 14 days: **fresh** — no action needed
- Claims updated 14-30 days ago: **aging** — verify if still accurate
- Claims updated 30+ days ago: **stale** — mark with `status: "review-needed"` via `wiki_apply`

### 3. Surface Contradictions

When two claims conflict:
- Lower confidence on the weaker claim (less evidence, older)
- Do NOT delete either claim — contradictions are informative
- If the user is present, ask which is current
- If running overnight (nightshift), flag for morning review

### 4. Report

Produce a brief summary:
- Total claims checked
- Stale claims found and marked
- Contradictions surfaced
- Any claims expired or updated

Write the report to `memory/wiki-maintenance-YYYY-MM-DD.md` for the daily record.

## Important

- Never delete claims — expire them (`status: "superseded"` or `status: "expired:YYYY-MM-DD"`)
- Preserve the evidence chain — when updating a claim, reference the old one
- When in doubt about accuracy, mark for review rather than changing
- This is knowledge hygiene, not knowledge creation — don't invent new claims during maintenance
