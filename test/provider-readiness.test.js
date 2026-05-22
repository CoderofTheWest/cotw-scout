const assert = require('node:assert/strict');
const test = require('node:test');
const {
  hasProviderAuth,
  normalizeOllamaReadiness,
  normalizeOpenAICodexReadiness,
  applyProviderRecommendation,
} = require('../lib/provider-readiness');

test('OpenAI/Codex readiness is not ready when profile is missing even if configured model references it', () => {
  const status = {
    defaultModel: 'openai-codex/gpt-5.5',
    resolvedDefault: 'openai-codex/gpt-5.5',
    allowed: ['openai-codex/gpt-5.5'],
    auth: {
      missingProvidersInUse: ['openai-codex'],
      providers: [{ provider: 'ollama', profiles: { count: 0 } }],
    },
  };

  const readiness = normalizeOpenAICodexReadiness({ status, models: [] });
  assert.equal(readiness.id, 'openai-codex');
  assert.equal(readiness.detected, true, 'configured Codex route should be surfaced as detected');
  assert.equal(readiness.ready, false, 'missing auth must not become ready');
  assert.equal(readiness.status, 'needs_sign_in');
});

test('OpenAI/Codex readiness is ready with auth profile and visible Codex model', () => {
  const status = {
    auth: {
      providers: [{ provider: 'openai-codex', profiles: { count: 1, oauth: 1 } }],
    },
  };
  const models = [{ id: 'gpt-5.5', provider: 'openai-codex' }];

  const readiness = normalizeOpenAICodexReadiness({ status, models });
  assert.equal(readiness.ready, true);
  assert.equal(readiness.status, 'ready');
  assert.equal(readiness.nextAction, 'Continue with ChatGPT / Codex');
});

test('OpenAI/Codex readiness returns sanitized unknown on CLI errors', () => {
  const readiness = normalizeOpenAICodexReadiness({ error: new Error('boom') });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.status, 'unknown');
  assert.equal(readiness.detail, 'Could not check ChatGPT / Codex yet.');
  assert.match(readiness.error, /boom/);
});

test('hasProviderAuth respects OAuth provider arrays and missing-provider override', () => {
  assert.equal(hasProviderAuth({ auth: { providersWithOAuth: ['openai-codex'] } }), true);
  assert.equal(hasProviderAuth({ auth: { oauth: { providers: ['openai-codex'] } } }), true);
  assert.equal(hasProviderAuth({ auth: { missingProvidersInUse: ['openai-codex'], providersWithOAuth: ['openai-codex'] } }), false);
});

test('Ollama readiness normalizes install, sign-in, model, and ready states', () => {
  assert.equal(normalizeOllamaReadiness({ ollama: { installed: false } }).status, 'needs_install');
  assert.equal(normalizeOllamaReadiness({ ollama: { installed: true, running: false } }).status, 'needs_start');
  assert.equal(normalizeOllamaReadiness({ ollama: { installed: true, running: true }, signin: { signedIn: false } }).status, 'needs_sign_in');
  assert.equal(normalizeOllamaReadiness({ ollama: { installed: true, running: true }, signin: { signedIn: true }, glm5: { available: false } }).status, 'needs_model');
  assert.equal(normalizeOllamaReadiness({ ollama: { installed: true, running: true }, signin: { signedIn: true }, glm5: { available: true } }).ready, true);
});

test('recommendation rules prefer exactly-ready provider and Codex when tied or neither ready', () => {
  const codexNotReady = { id: 'openai-codex', ready: false };
  const codexReady = { id: 'openai-codex', ready: true };
  const ollamaNotReady = { id: 'ollama', ready: false };
  const ollamaReady = { id: 'ollama', ready: true };

  assert.equal(applyProviderRecommendation([codexReady, ollamaNotReady]).find(p => p.recommended).id, 'openai-codex');
  assert.equal(applyProviderRecommendation([codexNotReady, ollamaReady]).find(p => p.recommended).id, 'ollama');
  assert.equal(applyProviderRecommendation([codexReady, ollamaReady]).find(p => p.recommended).id, 'openai-codex');
  assert.equal(applyProviderRecommendation([codexNotReady, ollamaNotReady]).find(p => p.recommended).id, 'openai-codex');
});
