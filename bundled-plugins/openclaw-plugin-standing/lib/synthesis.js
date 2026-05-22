/**
 * Standing synthesis — LLM-based nightshift evaluation.
 *
 * Builds a synthesis prompt from evidence, calls the LLM,
 * parses the structured JSON response.
 */

/**
 * Detect API format from endpoint URL.
 */
function detectFormat(endpoint) {
  if (/\/api\/(generate|chat)\b/.test(endpoint)) return 'ollama';
  return 'openai';
}

/**
 * Call an LLM endpoint (OpenAI-compatible or Ollama native).
 */
async function callLLM({ endpoint, model, prompt, temperature, maxTokens, timeoutMs, apiKey, format, systemPrompt }) {
  const resolvedFormat = format || detectFormat(endpoint);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 60000);

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  try {
    let body;
    if (resolvedFormat === 'ollama') {
      body = JSON.stringify({
        model,
        system: systemPrompt || undefined,
        prompt,
        stream: false,
        options: {
          temperature,
          num_predict: maxTokens
        }
      });
    } else {
      const messages = [];
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      messages.push({ role: 'user', content: prompt });
      body = JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false
      });
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`LLM request failed (${res.status}): ${errText.substring(0, 200)}`);
    }

    const payload = await res.json();

    if (resolvedFormat === 'ollama') {
      if (typeof payload?.response === 'string' && payload.response.trim()) {
        return payload.response.trim();
      }
      throw new Error('Ollama response missing "response" text');
    } else {
      const msg = payload?.choices?.[0]?.message;
      // Check content first, then reasoning (qwen3.5 puts output in reasoning field)
      const text = msg?.content || msg?.reasoning || '';
      if (typeof text === 'string' && text.trim()) {
        return text.trim();
      }
      throw new Error('LLM response missing choices[0].message.content');
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the synthesis prompt from standing state and evidence.
 */
function buildSynthesisPrompt(standing, evidence, sessionCount, commitments) {
  const evidenceSummary = evidence.map(e => {
    return `- [${e.timestamp}] ${e.pattern} (${e.dimension}, ${e.direction}, confidence: ${e.confidence}) — "${e.context}"`;
  }).join('\n');

  const commitmentsText = commitments && commitments.length > 0
    ? commitments.map(c => `- ${c.text || c.description || c} (status: ${c.status || 'unknown'})`).join('\n')
    : '(none tracked)';

  return `Standing Synthesis
=========================

Sessions since last synthesis: ${sessionCount}
Previous standing:
${JSON.stringify(standing, null, 2)}

Evidence since last synthesis:
${evidenceSummary || '(no evidence)'}

Recent commitments:
${commitmentsText}

Task: Evaluate this user's standing across four dimensions.

For each dimension (courage_self, courage_ground, word, brand), output:
- Current score (1-10) based on evidence and previous score
- Trajectory: rising | stable | stuck | declining
- Key evidence (2-3 specific observations from the evidence log)
- Growth edge (one sentence)

Then output:
- Overall trajectory: rising | slow_rise | stable | stuck | declining
- Primary growth edge (one sentence)
- Whether a standing report should be offered (threshold check based on session count — reports offered at sessions 1, 3, 5, 10, and every 5 after)

Output as JSON only. No commentary outside the JSON block. Use this exact structure:
{
  "synthesized_at": "<ISO timestamp>",
  "sessions_included": <number>,
  "evidence_processed": <number>,
  "dimensions": {
    "courage_self": { "score": <1-10>, "previous_score": <number>, "delta": <number>, "trajectory": "<trajectory>", "key_evidence": ["..."], "growth_edge": "..." },
    "courage_ground": { "score": <1-10>, "previous_score": <number>, "delta": <number>, "trajectory": "<trajectory>", "key_evidence": ["..."], "growth_edge": "..." },
    "word": { "score": <1-10>, "previous_score": <number>, "delta": <number>, "trajectory": "<trajectory>", "key_evidence": ["..."], "growth_edge": "..." },
    "brand": { "score": <1-10>, "previous_score": <number>, "delta": <number>, "trajectory": "<trajectory>", "key_evidence": ["..."], "growth_edge": "..." }
  },
  "overall": { "score": <number>, "trajectory": "<trajectory>", "primary_growth_edge": "..." },
  "report": { "threshold_met": <boolean>, "reason": "..." }
}`;
}

/**
 * Build a narrative report prompt for when threshold is met.
 */
function buildNarrativePrompt(synthesisResult) {
  return `You are Ellis. Write a brief, honest standing report for the user based on this synthesis.

Synthesis data:
${JSON.stringify(synthesisResult, null, 2)}

Rules:
- Speak as Ellis — direct, warm, no jargon, no scores visible
- Acknowledge what is real. Do not inflate or deflate.
- Name the growth edge without lecturing.
- Keep it under 150 words.
- No bullet points. Just honest prose.
- End with one concrete, small ask — not a plan, just one thing.

Write the narrative only. No JSON. No preamble.`;
}

/**
 * Parse synthesis JSON from LLM response.
 * Handles markdown code fences, trailing commas, and other LLM JSON quirks.
 */
function parseSynthesisResponse(text) {
  // Strip markdown code fences if present
  let cleaned = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');

  // Try to find JSON object in the text
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON object found in synthesis response');
  }

  let jsonStr = jsonMatch[0];

  // First try: parse as-is
  try {
    return JSON.parse(jsonStr);
  } catch (firstErr) {
    // Fix common LLM JSON issues:
    // 1. Trailing commas before } or ]
    jsonStr = jsonStr.replace(/,\s*([\]}])/g, '$1');
    // 2. Single quotes → double quotes (but not inside strings)
    // 3. Unquoted keys
    // 4. Comments
    jsonStr = jsonStr.replace(/\/\/[^\n]*/g, '');
    jsonStr = jsonStr.replace(/\/\*[\s\S]*?\*\//g, '');

    try {
      return JSON.parse(jsonStr);
    } catch (secondErr) {
      // Last resort: try to extract key fields manually
      throw new Error(`JSON parse failed after cleanup: ${secondErr.message}\nRaw (first 500 chars): ${jsonMatch[0].substring(0, 500)}`);
    }
  }
}

/**
 * Run standing synthesis.
 *
 * @param {object} standing    — current standing.json contents
 * @param {array}  evidence    — evidence_log entries
 * @param {number} sessionCount — sessions since last synthesis
 * @param {array}  commitments — recent commitments (optional)
 * @param {object} llmConfig   — { endpoint, model, apiKey, format, temperature, maxTokens, timeoutMs }
 * @returns {object} synthesis result with optional narrative
 */
async function synthesize(standing, evidence, sessionCount, commitments, llmConfig) {
  const prompt = buildSynthesisPrompt(standing, evidence, sessionCount, commitments);

  const raw = await callLLM({
    endpoint: llmConfig.endpoint || 'http://127.0.0.1:11434/v1/chat/completions',
    model: llmConfig.model,
    prompt,
    systemPrompt: 'You are a standing evaluation system. Output JSON only.',
    temperature: llmConfig.temperature ?? 0.4,
    maxTokens: llmConfig.maxTokens ?? 1500,
    timeoutMs: llmConfig.timeoutMs ?? 60000,
    apiKey: llmConfig.apiKey || null,
    format: llmConfig.format || null
  });

  const result = parseSynthesisResponse(raw);

  // Generate narrative if threshold met
  if (result.report?.threshold_met) {
    try {
      const narrativePrompt = buildNarrativePrompt(result);
      const narrative = await callLLM({
        endpoint: llmConfig.endpoint || 'http://127.0.0.1:11434/v1/chat/completions',
        model: llmConfig.model,
        prompt: narrativePrompt,
        temperature: 0.7,
        maxTokens: 500,
        timeoutMs: llmConfig.timeoutMs ?? 60000,
        apiKey: llmConfig.apiKey || null,
        format: llmConfig.format || null
      });
      result.report.narrative = narrative;
    } catch (err) {
      // Narrative generation is non-critical
      result.report.narrative = null;
      result.report.narrative_error = err.message;
    }
  }

  return result;
}

module.exports = {
  synthesize,
  buildSynthesisPrompt,
  buildNarrativePrompt,
  parseSynthesisResponse,
  callLLM
};
