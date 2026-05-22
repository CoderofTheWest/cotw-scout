---
name: web-content
description: Fetch web content efficiently. Use when fetching URLs for reading, research, or content extraction. Tries llms.txt standard first, then Cloudflare markdown-for-agents, then Jina Reader. Saves 70-80% tokens compared to raw HTML.
---

# Web Content Fetcher

Fetches web content efficiently using multiple fallback strategies.

## Workflow (in order)

1. **Check for `/llms.txt`** — Standard for LLM-friendly docs
2. **Try `Accept: text/markdown`** — Cloudflare markdown-for-agents
3. **Fall back to Jina Reader** — Works on any URL

## Commands

### 1. Check for llms.txt (emerging standard)

If you need documentation from a site, check for their llms.txt index:

```bash
curl -s "https://example.com/llms.txt"
```

If found, use it to navigate to specific `.md` pages or fetch sections directly. Sites with `/llms.txt`:
- developers.cloudflare.com (317KB index, 48MB full docs)
- fastht.ml/docs
- All nbdev projects
- Growing list of documentation sites

### 2. Try Cloudflare markdown-for-agents

For any URL, try the markdown header first — zero Jina quota:

```bash
curl -s "<URL>" -H "Accept: text/markdown, text/html"
```

Check if response is markdown (has YAML frontmatter or markdown headings):
- If yes: use directly (72% smaller than Jina)
- If HTML: fall back to Jina

### 3. Fallback: Jina Reader (works on any URL)

```bash
curl -s "https://r.jina.ai/<URL>" -H "Authorization: Bearer ${JINA_API_KEY}"
```

### Search (Jina)

```bash
curl -s "https://s.jina.ai/<QUERY>" -H "Authorization: Bearer ${JINA_API_KEY}"
```

## Token Savings (verified)

| Method | Example | Size | vs Jina |
|--------|---------|------|---------|
| llms.txt index | developers.cloudflare.com | 317KB | 95% smaller |
| Cloudflare markdown | developers.cloudflare.com/ai-gateway | 4KB | 72% smaller |
| Jina Reader | same page | 14KB | baseline |

Plus: llms.txt and Cloudflare markdown cost zero Jina quota.

## Sites with markdown-for-agents enabled

- developers.cloudflare.com
- blog.cloudflare.com
- Any Cloudflare customer who enables it (growing list)

## Sites with llms.txt

- developers.cloudflare.com (llms-full.txt = all 48MB docs)
- fastht.ml/docs
- fastcore.fast.ai
- All nbdev projects
- Growing adoption (standard by Jeremy Howard/Answer.AI)

## Jina API Key

Set `JINA_API_KEY` in your environment (via `.env` file or shell export). The curl examples above reference it as `${JINA_API_KEY}` — replace with your own key when calling directly, or source it from your environment.