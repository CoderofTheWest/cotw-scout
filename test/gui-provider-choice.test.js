const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const guiPath = path.join(repoRoot, 'cotw-scout-gui.html');
const preloadPath = path.join(repoRoot, 'preload.js');
const html = fs.readFileSync(guiPath, 'utf8');
const preload = fs.readFileSync(preloadPath, 'utf8');
const mainPath = path.join(repoRoot, 'main.js');
const main = fs.readFileSync(mainPath, 'utf8');

test('first-boot provider choice shell is present before persona onboarding', () => {
  for (const id of ['providerChoice', 'providerChoiceStatus', 'providerCards', 'providerChoiceError', 'providerChoiceNav', 'ollamaVerificationDetails', 'restoreLink', 'restoreFlow']) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }

  assert.match(html, /Choose how your Scout should run/);
  assert.match(html, /ChatGPT \/ Codex/);
  assert.match(html, /Ollama/);
  assert.match(html, /function runProviderPreflight\(/);
  assert.match(html, /function renderProviderChoice\(/);
  assert.match(html, /function selectProviderForOnboarding\(/);
});

test('restore from GitHub is available before provider selection', () => {
  assert.match(html, /Already have an agent on another machine\?/);
  assert.match(html, /Restore from GitHub/);
  assert.match(html, /document\.getElementById\('restoreLink'\)\.style\.display = 'block';/);
  assert.match(html, /function startRestoreFlow\(/);
  assert.match(html, /document\.getElementById\('providerChoice'\)\.style\.display = 'none';/);
  assert.match(html, /document\.getElementById\('ollamaVerificationDetails'\)\.style\.display = 'none';/);
  assert.doesNotMatch(html, /getElementById\('verificationSteps'\)/, 'restore flow must not reference a missing legacy element');
});

test('first run uses provider preflight while existing Ollama verification remains callable', () => {
  assert.match(html, /First run — detect provider paths, then onboard\s+runProviderPreflight\(\);/);
  assert.match(html, /async function runVerification\(\)/);
  assert.match(html, /window\.cotw\.checkProviderReadiness\(\)/);
  assert.match(html, /if \(providerId === 'ollama'\) \{\s+userData\.providerId = 'ollama';\s+runVerification\(\);/);
});

test('preload exposes provider readiness and Codex auth IPC methods', () => {
  assert.match(preload, /checkOpenAICodex: \(\) => ipcRenderer\.invoke\('setup:check-openai-codex'\)/);
  assert.match(preload, /verifyOpenAICodex: \(\) => ipcRenderer\.invoke\('setup:verify-openai-codex'\)/);
  assert.match(preload, /connectOpenAICodex: \(opts\) => ipcRenderer\.invoke\('setup:connect-openai-codex', opts\)/);
  assert.match(preload, /cancelOpenAICodex: \(\) => ipcRenderer\.invoke\('setup:cancel-openai-codex'\)/);
  assert.match(preload, /checkProviderReadiness: \(\) => ipcRenderer\.invoke\('setup:check-provider-readiness'\)/);
});

test('Slice 2 UI wires Codex connect, verify, retry, and cancel states', () => {
  assert.match(html, /function verifyOpenAICodexFromOnboarding\(/);
  assert.match(html, /function connectOpenAICodexFromOnboarding\(/);
  assert.match(html, /function cancelOpenAICodexConnect\(/);
  assert.match(html, /window\.cotw\.verifyOpenAICodex\(\)/);
  assert.match(html, /window\.cotw\.connectOpenAICodex\(\)/);
  assert.match(html, /window\.cotw\.cancelOpenAICodex/);
  assert.match(html, /Try again/);
  assert.match(html, /userData\.providerId = 'openai-codex'/);
  assert.match(html, /showStep\(1\)/);
});

test('Settings exposes model provider management actions', () => {
  assert.match(html, /Model Provider/);
  assert.match(html, /Current provider/);
  assert.match(html, /Connect ChatGPT \/ Codex/);
  assert.match(html, /Switch to Codex/);
  assert.match(html, /Switch to Ollama/);
  assert.match(html, /function loadModelProviderStatus\(/);
  assert.match(html, /window\.cotw\.getModelProviderStatus\(\)/);
  assert.match(html, /window\.cotw\.switchProvider\(providerId\)/);
});

test('status bar model label is runtime-driven, not hardcoded to Ollama', () => {
  assert.match(html, /id="statusModelProvider">Model: checking\.\.\./);
  assert.match(html, /function updateStatusBarModelProvider\(current\)/);
  assert.match(html, /updateStatusBarModelProvider\(current\)/);
  assert.match(html, /Load model\/provider status for the bottom status bar\s+loadModelProviderStatus\(\);/);
});

test('Slice 2 main IPC invokes OpenClaw auth without provider switching or default writes', () => {
  assert.match(main, /ipcMain\.handle\('setup:connect-openai-codex'/);
  assert.match(main, /ipcMain\.handle\('setup:cancel-openai-codex'/);
  assert.match(main, /ipcMain\.handle\('setup:verify-openai-codex'/);
  assert.match(main, /'models', 'auth', 'login'/);
  assert.match(main, /'--provider', 'openai-codex'/);

  const connectStart = main.indexOf('function connectOpenAICodex(');
  const connectEnd = main.indexOf('function cancelOpenAICodex()', connectStart);
  assert.ok(connectStart > 0 && connectEnd > connectStart, 'connectOpenAICodex block should exist');
  const connectBlock = main.slice(connectStart, connectEnd);
  assert.doesNotMatch(connectBlock, /--set-default/, 'Slice 2 must not write default model/provider config');
  assert.doesNotMatch(connectBlock, /writeOpenClawConfig\(/, 'connect auth must not rewrite runtime config');
});

test('settings/provider IPC exposes provider status and validated switching', () => {
  assert.match(preload, /getModelProviderStatus: \(\) => ipcRenderer\.invoke\('settings:get-provider-status'\)/);
  assert.match(preload, /switchProvider: \(providerId\) => ipcRenderer\.invoke\('settings:switch-provider', providerId\)/);
  assert.match(main, /ipcMain\.handle\('settings:get-provider-status'/);
  assert.match(main, /ipcMain\.handle\('settings:switch-provider'/);
  assert.match(main, /switchModelProvider\(providerId/);
  assert.match(main, /invalid_provider/);
  assert.match(main, /requireReady/);
});
