'use strict';

const OPENAI_CODEX_ID = 'openai-codex';
const OLLAMA_ID = 'ollama';

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.models)) return value.models;
  if (value && Array.isArray(value.items)) return value.items;
  if (value && Array.isArray(value.providers)) return value.providers;
  return [];
}

function hasProviderAuth(status, providerId = OPENAI_CODEX_ID) {
  const auth = status?.auth || {};
  const missing = Array.isArray(auth.missingProvidersInUse) ? auth.missingProvidersInUse : [];
  if (missing.includes(providerId)) return false;

  const providersWithOAuth = Array.isArray(auth.providersWithOAuth) ? auth.providersWithOAuth : [];
  if (providersWithOAuth.includes(providerId)) return true;

  const oauthProviders = Array.isArray(auth.oauth?.providers) ? auth.oauth.providers : [];
  if (oauthProviders.includes(providerId)) return true;

  const profiles = Array.isArray(auth.oauth?.profiles) ? auth.oauth.profiles : [];
  if (profiles.some(p => p?.provider === providerId || p?.providerId === providerId)) return true;

  const providers = Array.isArray(auth.providers) ? auth.providers : [];
  const provider = providers.find(p => p?.provider === providerId || p?.id === providerId);
  if (!provider) return false;
  const counts = provider.profiles || {};
  return Boolean(
    counts.count > 0 ||
    counts.oauth > 0 ||
    counts.token > 0 ||
    counts.apiKey > 0 ||
    provider.effective?.kind === 'oauth' ||
    provider.effective?.kind === 'token'
  );
}

function modelIdOf(model) {
  if (typeof model === 'string') return model;
  if (!model || typeof model !== 'object') return '';
  return String(model.id || model.name || model.model || model.ref || '');
}

function hasCodexModel(models) {
  return asArray(models).some(model => {
    const id = modelIdOf(model).toLowerCase();
    return id.includes('gpt-') || id.includes('codex') || id.startsWith('openai-codex/');
  });
}

function configuredUsesCodex(status) {
  const candidates = [
    status?.defaultModel,
    status?.resolvedDefault,
    ...(Array.isArray(status?.allowed) ? status.allowed : []),
  ].filter(Boolean).map(String);
  return candidates.some(value => value.startsWith('openai-codex/') || value.startsWith('openai/gpt-'));
}

function normalizeOllamaReadiness({ ollama, signin, glm5 } = {}) {
  if (!ollama?.installed) {
    return {
      id: OLLAMA_ID,
      label: 'Ollama',
      detected: false,
      ready: false,
      recommended: false,
      status: 'needs_install',
      detail: 'Ollama is not installed.',
      nextAction: 'Install Ollama',
    };
  }

  if (!ollama?.running) {
    return {
      id: OLLAMA_ID,
      label: 'Ollama',
      detected: true,
      ready: false,
      recommended: false,
      status: 'needs_start',
      detail: 'Ollama is installed but not running.',
      nextAction: 'Start Ollama',
    };
  }

  if (signin && signin.signedIn === false) {
    return {
      id: OLLAMA_ID,
      label: 'Ollama',
      detected: true,
      ready: false,
      recommended: false,
      status: 'needs_sign_in',
      detail: 'Ollama is running, but cloud access is not signed in.',
      nextAction: 'Sign in to Ollama',
    };
  }

  if (glm5 && glm5.available === false) {
    return {
      id: OLLAMA_ID,
      label: 'Ollama',
      detected: true,
      ready: false,
      recommended: false,
      status: 'needs_model',
      detail: 'Ollama is ready, but GLM-5:cloud is not available.',
      nextAction: 'Pull GLM-5:cloud',
    };
  }

  return {
    id: OLLAMA_ID,
    label: 'Ollama',
    detected: true,
    ready: true,
    recommended: false,
    status: 'ready',
    detail: ollama.version ? `Ollama running (${ollama.version})` : 'Ollama is ready.',
    nextAction: 'Continue with Ollama',
  };
}

function normalizeOpenAICodexReadiness({ status, models, error, runtimeAvailable = true } = {}) {
  if (error) {
    return {
      id: OPENAI_CODEX_ID,
      label: 'ChatGPT / Codex',
      detected: false,
      ready: false,
      recommended: false,
      status: 'unknown',
      detail: 'Could not check ChatGPT / Codex yet.',
      nextAction: 'Check again',
      error: String(error.message || error),
    };
  }

  const hasAuth = hasProviderAuth(status, OPENAI_CODEX_ID);
  const modelVisible = hasCodexModel(models) || configuredUsesCodex(status);
  const detected = hasAuth || modelVisible;

  if (!runtimeAvailable) {
    return {
      id: OPENAI_CODEX_ID,
      label: 'ChatGPT / Codex',
      detected,
      ready: false,
      recommended: false,
      status: 'error',
      detail: 'This OpenClaw build does not expose Codex runtime support.',
      nextAction: 'Update OpenClaw',
    };
  }

  if (!hasAuth) {
    return {
      id: OPENAI_CODEX_ID,
      label: 'ChatGPT / Codex',
      detected,
      ready: false,
      recommended: false,
      status: 'needs_sign_in',
      detail: 'Sign in with an eligible ChatGPT plan to use Codex.',
      nextAction: 'Sign in with ChatGPT',
    };
  }

  if (!modelVisible) {
    return {
      id: OPENAI_CODEX_ID,
      label: 'ChatGPT / Codex',
      detected: true,
      ready: false,
      recommended: false,
      status: 'unknown',
      detail: 'ChatGPT sign-in is present, but no Codex model row was visible.',
      nextAction: 'Verify Codex',
    };
  }

  return {
    id: OPENAI_CODEX_ID,
    label: 'ChatGPT / Codex',
    detected: true,
    ready: true,
    recommended: false,
    status: 'ready',
    detail: 'ChatGPT / Codex account detected.',
    nextAction: 'Continue with ChatGPT / Codex',
  };
}

function applyProviderRecommendation(readinessList = []) {
  const providers = readinessList.map(p => ({ ...p, recommended: false }));
  const codex = providers.find(p => p.id === OPENAI_CODEX_ID);
  const ollama = providers.find(p => p.id === OLLAMA_ID);
  let recommended = null;

  if (codex?.ready && !ollama?.ready) recommended = codex;
  else if (ollama?.ready && !codex?.ready) recommended = ollama;
  else if (codex) recommended = codex;
  else recommended = providers.find(p => p.ready) || providers[0] || null;

  if (recommended) {
    const target = providers.find(p => p.id === recommended.id);
    if (target) target.recommended = true;
  }

  return providers;
}

module.exports = {
  OPENAI_CODEX_ID,
  OLLAMA_ID,
  asArray,
  hasProviderAuth,
  hasCodexModel,
  configuredUsesCodex,
  normalizeOllamaReadiness,
  normalizeOpenAICodexReadiness,
  applyProviderRecommendation,
};
