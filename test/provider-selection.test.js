const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CODEX_NATIVE_MODEL,
  OLLAMA_MODEL,
  applyProviderSelectionConfig,
  summarizeSelectedProvider,
} = require('../lib/provider-selection');

test('config switch to Codex writes native OpenAI model and Codex runtime', () => {
  const switched = applyProviderSelectionConfig({ agents: { defaults: {} }, plugins: { entries: {} } }, 'openai-codex');
  assert.equal(switched.agents.defaults.model.primary, CODEX_NATIVE_MODEL);
  assert.deepEqual(switched.agents.defaults.agentRuntime, { id: 'codex', fallback: 'none' });
  assert.equal(switched.plugins.entries.codex.enabled, true);
  assert.doesNotMatch(switched.agents.defaults.model.primary, /^openai-codex\//);
});

test('config switch preserves auth/meta/channels/bindings/tools/custom providers/plugins', () => {
  const existing = {
    auth: { profiles: { secretish: true } },
    meta: { version: 'x' },
    channels: { telegram: { enabled: true } },
    bindings: [{ agentId: 'trail-guide' }],
    tools: { web_search: { enabled: true } },
    models: { providers: { custom: { models: [{ id: 'x' }] } } },
    plugins: { entries: { customPlugin: { enabled: true, config: { keep: true } } } },
    agents: { defaults: { bootstrapMaxChars: 12345 } },
  };
  const switched = applyProviderSelectionConfig(existing, 'openai-codex');
  assert.deepEqual(switched.auth, existing.auth);
  assert.deepEqual(switched.meta, existing.meta);
  assert.deepEqual(switched.channels, existing.channels);
  assert.deepEqual(switched.bindings, existing.bindings);
  assert.deepEqual(switched.tools, existing.tools);
  assert.deepEqual(switched.models, existing.models);
  assert.deepEqual(switched.plugins.entries.customPlugin, existing.plugins.entries.customPlugin);
  assert.equal(switched.agents.defaults.bootstrapMaxChars, 12345);
});

test('config switch to Ollama preserves runtime state and clears Codex runtime selector', () => {
  const existing = applyProviderSelectionConfig({ auth: { ok: true }, agents: { defaults: {} } }, 'openai-codex');
  const switched = applyProviderSelectionConfig(existing, 'ollama');
  assert.equal(switched.agents.defaults.model.primary, OLLAMA_MODEL);
  assert.equal(switched.agents.defaults.agentRuntime, undefined);
  assert.deepEqual(switched.auth, existing.auth);
});

test('provider summary reports Codex and Ollama in human terms', () => {
  assert.equal(summarizeSelectedProvider(applyProviderSelectionConfig({}, 'openai-codex')).label, 'ChatGPT / Codex');
  assert.equal(summarizeSelectedProvider(applyProviderSelectionConfig({}, 'ollama')).label, 'Ollama');
});

test('provider summary recognizes legacy openai-codex model ids', () => {
  const summary = summarizeSelectedProvider({
    agents: { defaults: { model: { primary: 'openai-codex/gpt-5.5' } } },
  });
  assert.equal(summary.providerId, 'openai-codex');
  assert.equal(summary.model, 'openai-codex/gpt-5.5');
});

test('unknown provider ids are rejected', () => {
  assert.throws(() => applyProviderSelectionConfig({}, 'bad-provider'), /Unknown provider/);
});
