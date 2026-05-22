// Provider selection helpers for OpenClaw runtime config.
// Pure logic lives here so GUI/provider switching can be tested without
// touching a real ~/.openclaw-* profile.

const CODEX_AUTH_PROVIDER_ID = 'openai-codex';
const CODEX_NATIVE_MODEL = 'openai/gpt-5.5';
const OLLAMA_PROVIDER_ID = 'ollama';
const OLLAMA_MODEL = 'ollama/glm-5:cloud';

function cloneConfig(config = {}) {
  return JSON.parse(JSON.stringify(config || {}));
}

function ensureDefaults(config) {
  if (!config.agents) config.agents = {};
  if (!config.agents.defaults) config.agents.defaults = {};
  if (!config.agents.defaults.model) config.agents.defaults.model = {};
  if (!config.plugins) config.plugins = {};
  if (!config.plugins.entries) config.plugins.entries = {};
  return config;
}

function selectCodexRuntime(config = {}) {
  const next = ensureDefaults(cloneConfig(config));
  next.agents.defaults.model.primary = CODEX_NATIVE_MODEL;
  next.agents.defaults.agentRuntime = { id: 'codex', fallback: 'none' };
  next.plugins.entries.codex = {
    ...(next.plugins.entries.codex || {}),
    enabled: true,
  };
  return next;
}

function selectOllamaRuntime(config = {}) {
  const next = ensureDefaults(cloneConfig(config));
  next.agents.defaults.model.primary = OLLAMA_MODEL;
  if (next.agents.defaults.agentRuntime?.id === 'codex') {
    delete next.agents.defaults.agentRuntime;
  }
  return next;
}

function applyProviderSelectionConfig(config = {}, providerId) {
  if (providerId === CODEX_AUTH_PROVIDER_ID) return selectCodexRuntime(config);
  if (providerId === OLLAMA_PROVIDER_ID) return selectOllamaRuntime(config);
  throw new Error(`Unknown provider: ${providerId}`);
}

function summarizeSelectedProvider(config = {}) {
  const primary = config?.agents?.defaults?.model?.primary || '';
  const runtime = config?.agents?.defaults?.agentRuntime?.id || null;
  if (runtime === 'codex' || primary.startsWith('openai/') || primary.startsWith('openai-codex/')) {
    return {
      providerId: CODEX_AUTH_PROVIDER_ID,
      label: 'ChatGPT / Codex',
      model: primary || CODEX_NATIVE_MODEL,
      runtime: 'Native Codex runtime',
    };
  }
  if (primary.startsWith('ollama/')) {
    return {
      providerId: OLLAMA_PROVIDER_ID,
      label: 'Ollama',
      model: primary,
      runtime: 'Runs through Ollama on this Mac',
    };
  }
  return {
    providerId: null,
    label: 'Unknown',
    model: primary || 'Not configured',
    runtime: runtime || 'Default OpenClaw runtime',
  };
}

module.exports = {
  CODEX_AUTH_PROVIDER_ID,
  CODEX_NATIVE_MODEL,
  OLLAMA_PROVIDER_ID,
  OLLAMA_MODEL,
  applyProviderSelectionConfig,
  summarizeSelectedProvider,
};
