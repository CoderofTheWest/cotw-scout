---
name: scout
description: Delegate web research to Gemini CLI for recent data, current events, and deep investigations
metadata:
  {
    "openclaw":
      {
        "emoji": "🔭",
        "requires": { "bins": ["gemini"] },
        "user-invocable": true
      }
  }
---

# Scout - Web Research via Gemini CLI

Delegate research to Gemini's live web access for information beyond your knowledge cutoff.

## Prompt Templates

Use templates to get tailored research results:

| Template | Use For | Example |
|----------|---------|---------|
| `default` | General research | Current Bitcoin price |
| `topical` | Code of the West scanning | "integrity gap news this week" |
| `news` | Breaking news (48h) | CEO resignations, policy changes |
| `competitive` | Content/competitor research | "best performing mens content Feb 2026" |
| `deep` | Multi-source investigation | Background on a specific story |

## When to Use

- Current events, news, recent developments
- Real-time data (prices, trends, statistics)
- Code of the West topical scanning
- Competitor/content research
- Deep research requiring multiple sources

## How It Works

1. **Quick lookup (one-shot):**
   ```
   scout: "What's the current Bitcoin price?"
   ```

2. **Topical scan (COTW-optimized):**
   ```
   scout: "mainstream media discussing masculinity February 2026" [template: "topical"]
   ```

3. **Breaking news:**
   ```
   scout: "CEOs fired or resigned this week" [template: "news"]
   ```

4. **Persistent session (for follow-ups):**
   ```
   scout: "Research Western fashion trends 2026" [persist: true]
   → Returns sessionId for follow-ups
   ```

5. **Continue session:**
   ```
   scout: "Tell me more about fringe jackets" [continue: "scout-123456"]
   ```

6. **End session:**
   ```
   scout: [end: "scout-123456"]
   ```

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| query | string | yes* | Research question or search query |
| template | string | no | Prompt template: default, topical, news, competitive, deep |
| persist | boolean | no | Keep session for follow-ups (default: false) |
| continue | string | no | Session ID to continue researching |
| end | string | no | Session ID to close |
| judgment | string | no | Why you persisted/continued/ended (logged for learning) |

*Required for new queries and continue. Not needed for end.

## Topical Template (Code of the West)

When using `template: "topical"`, Scout is instructed to:

1. Find recent stories (last 7 days preferred)
2. Look for specific examples with names, quotes, events
3. Identify themes: integrity gaps, courage moments, generational wisdom
4. Provide content angle suggestions
5. Avoid generic trends, partisan politics, celebrity gossip

**CRITICAL:** Every finding MUST include an actual Source URL (https://...). If Gemini returns only a source hint (e.g., "Vatican.va"), do a follow-up search to find the actual clickable URL before logging to topical-opportunities.md.

## Guidance

Scout returns guidance with each response:

- **hint**: Whether response seems substantive or thin
- **suggestedFollowUps**: Optional deeper angles
- **selfCheck**: Questions to evaluate if you have enough
- **stopConditions**: When to stop researching

**You decide** if the response is sufficient. Scout suggests, doesn't command.

## Sessions

- Sessions auto-expire after 1 hour
- Stored in `~/.openclaw/scout_sessions/`
- Use `persist: true` only when you expect follow-ups

## Under the Hood

- Calls Gemini CLI (`gemini -p "query"`)
- 50KB truncation prevents context bloat
- 120 second timeout
- Logs judgment decisions for learning

---

*Skill adapted from Clint's Scout tool with Code of the West enhancements.*
