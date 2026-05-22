function buildPrompt({ inquiry, passNumber, passPrompt }) {
  const prior = (inquiry.passes || [])
    .filter(p => p.number < passNumber && p.completed && p.output)
    .map(p => `Pass ${p.number} output:\n${p.output}`)
    .join('\n\n');

  return [
    'You are running a contemplative pass over a single inquiry.',
    `Pass: ${passNumber}`,
    `Instruction: ${passPrompt}`,
    `Inquiry: ${inquiry.question}`,
    `Source: ${inquiry.source}`,
    `Context:\n${inquiry.context || '(none)'}`,
    prior ? `Prior passes:\n${prior}` : 'Prior passes: (none)',
    'Return concise but specific reflection text only.'
  ].join('\n\n');
}

/**
 * Call the gateway's configured LLM (propagates through openclaw.json primary model).
 * Same surface the continuity plugin uses for warm-start generation.
 */
async function callGateway({ api, prompt, temperature, maxTokens, timeoutMs }) {
  // Graceful no-op when the gateway LLM client isn't injected into this plugin's api.
  // Matches the defensive pattern in openclaw-plugin-continuity's warm-start code.
  // Without this, pass-runs throw and the GUI shows empty inquiry cards.
  if (!api?.llm?.generate) {
    return null;
  }

  const result = await api.llm.generate(prompt, {
    temperature,
    maxTokens,
    timeout: timeoutMs
  });

  const text = result?.text || result?.response || result?.content || '';
  if (!text || typeof text !== 'string' || !text.trim()) {
    return null;
  }
  return text.trim();
}

async function runPass({ inquiry, passNumber, config, api }) {
  const passPrompt = config.passes?.[String(passNumber)]?.prompt || `Pass ${passNumber}`;
  const prompt = buildPrompt({ inquiry, passNumber, passPrompt });

  return callGateway({
    api,
    prompt,
    temperature: config.llm?.temperature ?? 0.6,
    maxTokens: config.llm?.maxTokens ?? 700,
    timeoutMs: config.llm?.timeoutMs ?? 45000
  });
}

module.exports = {
  runPass,
  buildPrompt,
  callGateway
};
