/**
 * preload.js — Exposes safe IPC bridge to renderer.
 *
 * The GUI communicates with main process via these channels:
 * - setup:* — GLM-5 verification, onboarding, workspace scaffolding
 * - openclaw:* — start/stop/status of the OpenClaw gateway
 * - update:* — version check and apply
 * - telemetry:* — opt-in status
 * - app:* — window controls, quit
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('cotw', {
  // ---- Setup & Verification ----
  checkOllama: () => ipcRenderer.invoke('setup:check-ollama'),
  checkOllamaSignin: () => ipcRenderer.invoke('setup:check-ollama-signin'),
  checkGLM5: () => ipcRenderer.invoke('setup:check-glm5'),
  checkOpenAICodex: () => ipcRenderer.invoke('setup:check-openai-codex'),
  verifyOpenAICodex: () => ipcRenderer.invoke('setup:verify-openai-codex'),
  connectOpenAICodex: (opts) => ipcRenderer.invoke('setup:connect-openai-codex', opts),
  cancelOpenAICodex: () => ipcRenderer.invoke('setup:cancel-openai-codex'),
  checkProviderReadiness: () => ipcRenderer.invoke('setup:check-provider-readiness'),
  getModelProviderStatus: () => ipcRenderer.invoke('settings:get-provider-status'),
  switchProvider: (providerId) => ipcRenderer.invoke('settings:switch-provider', providerId),
  runOnboarding: (answers) => ipcRenderer.invoke('setup:onboarding', answers),
  previewVoice: () => ipcRenderer.invoke('setup:preview-voice'),
  getSetupState: () => ipcRenderer.invoke('setup:get-state'),

  // ---- OpenClaw Gateway ----
  startGateway: () => ipcRenderer.invoke('openclaw:start'),
  stopGateway: () => ipcRenderer.invoke('openclaw:stop'),
  getGatewayStatus: () => ipcRenderer.invoke('openclaw:status'),
  getContinuityCompactionHealth: () => ipcRenderer.invoke('openclaw:continuity-compaction-health'),
  getRuntimeLoadReport: () => ipcRenderer.invoke('openclaw:runtime-load-report'),

  // ---- Hosted Canvas Embeds ----
  getHostedEmbedDocument: (ref) => ipcRenderer.invoke('canvas:get-embed-document', ref),

  // ---- Sidebar Data ----
  getStanding: () => ipcRenderer.invoke('sidebar:standing'),
  getStandingEvidence: (dimension) => ipcRenderer.invoke('sidebar:standing-evidence', dimension),
  getContemplation: () => ipcRenderer.invoke('sidebar:contemplation'),
  getJournal: () => ipcRenderer.invoke('sidebar:journal'),
  getEvolution: () => ipcRenderer.invoke('sidebar:evolution'),
  getHarnessResearch: () => ipcRenderer.invoke('sidebar:harness-research'),
  getSpineLedger: () => ipcRenderer.invoke('sidebar:spine'),
  getProjectRadar: () => ipcRenderer.invoke('sidebar:project-radar'),
  updateEvolutionEvent: (data) => ipcRenderer.invoke('sidebar:evolution-action', data),

  // ---- Projects ----
  getProjects: () => ipcRenderer.invoke('projects:list'),
  archiveProject: (name) => ipcRenderer.invoke('projects:archive', name),
  createProject: (data) => ipcRenderer.invoke('projects:create', data),
  switchProject: (data) => ipcRenderer.invoke('projects:switch', data),

  // ---- Shell ----
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  copyToClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
  focusWindow: () => ipcRenderer.invoke('app:focus'),

  // ---- Voice & Speech ----
  listSystemVoices: () => ipcRenderer.invoke('voice:list-system-voices'),
  getVoiceSettings: () => ipcRenderer.invoke('voice:get-settings'),
  saveVoiceSettings: (settings) => ipcRenderer.invoke('voice:save-settings', settings),
  previewSystemVoice: (payload) => ipcRenderer.invoke('voice:preview-system-voice', payload),
  enqueueSpeechChunk: (payload) => ipcRenderer.invoke('voice:enqueue-speech-chunk', payload),
  stopSpeaking: () => ipcRenderer.invoke('voice:stop-speaking'),
  getSttStatus: () => ipcRenderer.invoke('voice:stt-status'),
  startPttCapture: () => ipcRenderer.invoke('voice:start-ptt'),
  stopPttCapture: () => ipcRenderer.invoke('voice:stop-ptt'),
  cancelPttCapture: () => ipcRenderer.invoke('voice:cancel-ptt'),
  transcribePttAudio: (payload) => ipcRenderer.invoke('voice:transcribe-ptt-audio', payload),

  // ---- GitHub Backup ----
  githubDeviceFlowStart: () => ipcRenderer.invoke('github:device-flow-start'),
  githubDeviceFlowPoll: (deviceCode) => ipcRenderer.invoke('github:device-flow-poll', deviceCode),
  githubCreateRepo: (repoName) => ipcRenderer.invoke('github:create-repo', repoName),
  githubListRepos: () => ipcRenderer.invoke('github:list-repos'),
  githubCloneRepo: (fullName) => ipcRenderer.invoke('github:clone-repo', fullName),
  githubSync: () => ipcRenderer.invoke('github:sync'),
  githubPull: () => ipcRenderer.invoke('github:pull'),
  githubStatus: () => ipcRenderer.invoke('github:status'),
  githubDisconnect: () => ipcRenderer.invoke('github:disconnect'),

  // ---- Session ----
  getSessionMode: () => ipcRenderer.invoke('session:get-mode'),

  // ---- Chat ----
  getSessionHistory: () => ipcRenderer.invoke('chat:get-history'),
  getLastActivity: () => ipcRenderer.invoke('chat:last-activity'),
  sendMessage: (message) => ipcRenderer.invoke('chat:send', message),
  getPathForFile: (file) => {
    try {
      return webUtils?.getPathForFile?.(file) || file?.path || '';
    } catch {
      return file?.path || '';
    }
  },
  stopGeneration: () => ipcRenderer.invoke('chat:stop'),
  resetSession: () => ipcRenderer.invoke('chat:reset-session'),
  getSkills: () => ipcRenderer.invoke('chat:get-skills'),
  onMessage: (callback) => {
    const sub = (_event, data) => callback(data);
    ipcRenderer.on('chat:message', sub);
    return () => ipcRenderer.removeListener('chat:message', sub);
  },
  onStreamChunk: (callback) => {
    const sub = (_event, data) => callback(data);
    ipcRenderer.on('chat:stream-chunk', sub);
    return () => ipcRenderer.removeListener('chat:stream-chunk', sub);
  },
  onToolCall: (callback) => {
    const sub = (_event, data) => callback(data);
    ipcRenderer.on('chat:tool-call', sub);
    return () => ipcRenderer.removeListener('chat:tool-call', sub);
  },
  onStreamDone: (callback) => {
    const sub = (_event, data) => callback(data);
    ipcRenderer.on('chat:stream-done', sub);
    return () => ipcRenderer.removeListener('chat:stream-done', sub);
  },
  onStreamError: (callback) => {
    const sub = (_event, data) => callback(data);
    ipcRenderer.on('chat:stream-error', sub);
    return () => ipcRenderer.removeListener('chat:stream-error', sub);
  },
  onStreamRetry: (callback) => {
    const sub = (_event, data) => callback(data);
    ipcRenderer.on('chat:stream-retry', sub);
    return () => ipcRenderer.removeListener('chat:stream-retry', sub);
  },
  onAutoContinuationStart: (callback) => {
    const sub = (_event, data) => callback(data);
    ipcRenderer.on('chat:auto-continuation-start', sub);
    return () => ipcRenderer.removeListener('chat:auto-continuation-start', sub);
  },
  onAgentActivity: (callback) => {
    const sub = (_event, data) => callback(data);
    ipcRenderer.on('chat:agent-activity', sub);
    return () => ipcRenderer.removeListener('chat:agent-activity', sub);
  },
  onModeChanged: (callback) => {
    const sub = (_event, data) => callback(data);
    ipcRenderer.on('mode:changed', sub);
    return () => ipcRenderer.removeListener('mode:changed', sub);
  },
  onProactiveStart: (callback) => {
    const sub = (_event, data) => callback(data);
    ipcRenderer.on('chat:proactive-start', sub);
    return () => ipcRenderer.removeListener('chat:proactive-start', sub);
  },
  onConsolidationRestart: (callback) => {
    const sub = (_event, data) => callback(data);
    ipcRenderer.on('chat:consolidation-restart', sub);
    return () => ipcRenderer.removeListener('chat:consolidation-restart', sub);
  },

  // ---- Updates ----
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  applyUpdate: (updateInfo) => ipcRenderer.invoke('update:apply', updateInfo),
  onUpdateAvailable: (callback) => {
    const sub = (_event, data) => callback(data);
    ipcRenderer.on('update:available', sub);
    return () => ipcRenderer.removeListener('update:available', sub);
  },

  // ---- Capability Tiers ----
  getTier: () => ipcRenderer.invoke('tier:get'),
  requestTierUpgrade: (tier) => ipcRenderer.invoke('tier:request-upgrade', tier),
  confirmTier: (tier) => ipcRenderer.invoke('tier:confirm', tier),
  downgradeTier: (tier) => ipcRenderer.invoke('tier:downgrade', tier),
  onTierConfirmRequest: (callback) => {
    const sub = (_event, data) => callback(data);
    ipcRenderer.on('tier:confirm-upgrade', sub);
    return () => ipcRenderer.removeListener('tier:confirm-upgrade', sub);
  },

  // ---- Telemetry ----
  getTelemetryStatus: () => ipcRenderer.invoke('telemetry:status'),
  setTelemetryOptIn: (optedIn) => ipcRenderer.invoke('telemetry:set-opt-in', optedIn),

  // ---- Channels ----
  addChannel: (channel, config) => ipcRenderer.invoke('channels:add', channel, config),
  removeChannel: (channel) => ipcRenderer.invoke('channels:remove', channel),
  getChannels: () => ipcRenderer.invoke('channels:list'),

  // ---- Web Search ----
  saveBraveApiKey: (key) => ipcRenderer.invoke('search:save-brave-key', key),
  testBraveApiKey: () => ipcRenderer.invoke('search:test-brave-key'),
  getBraveApiKeyStatus: () => ipcRenderer.invoke('search:brave-key-status'),

  // ---- Google ----
  saveGoogleApiKey: (key) => ipcRenderer.invoke('google:save-key', key),
  getGoogleApiKeyStatus: () => ipcRenderer.invoke('google:key-status'),

  // ---- Jina ----
  saveJinaApiKey: (key) => ipcRenderer.invoke('search:save-jina-key', key),
  getJinaApiKeyStatus: () => ipcRenderer.invoke('search:jina-key-status'),

  // ---- Scout (Gemini CLI) ----
  checkScoutAvailable: () => ipcRenderer.invoke('search:check-scout'),

  // ---- Search Provider ----
  getSearchProvider: () => ipcRenderer.invoke('search:get-provider'),
  setSearchProvider: (provider) => ipcRenderer.invoke('search:set-provider', provider),

  // ---- Service Guidance ----
  requestServiceGuidance: (service) => ipcRenderer.invoke('service:connect-guided', service),

  // ---- Embodiment ----
  embodiment: {
    status: () => ipcRenderer.invoke('embodiment:status'),
    enter: () => ipcRenderer.invoke('embodiment:enter'),
    exit: () => ipcRenderer.invoke('embodiment:exit'),
    startVision: () => ipcRenderer.invoke('embodiment:start-vision'),
    notebook: () => ipcRenderer.invoke('embodiment:notebook'),
    activate: () => ipcRenderer.invoke('embodiment:activate'),
    setCuriosity: (enabled) => ipcRenderer.invoke('embodiment:curiosity', enabled),
    onStateUpdate: (callback) => {
      const sub = (_event, data) => callback(data);
      ipcRenderer.on('embodiment:state-update', sub);
      return () => ipcRenderer.removeListener('embodiment:state-update', sub);
    },
  },

  // ---- Booth ----
  booth: {
    enter: () => ipcRenderer.invoke('booth:enter'),
    exit: () => ipcRenderer.invoke('booth:exit'),
    reset: () => ipcRenderer.invoke('booth:reset'),
  },

  // ---- Sessions (Trail Map) ----
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    load: (id) => ipcRenderer.invoke('sessions:load', id),
    search: (query) => ipcRenderer.invoke('sessions:search', query),
    archive: (id) => ipcRenderer.invoke('sessions:archive', id),
    onUpdated: (callback) => {
      const sub = () => callback();
      ipcRenderer.on('sessions:updated', sub);
      return () => ipcRenderer.removeListener('sessions:updated', sub);
    },
  },

  // ---- Training Grounds ----
  training: {
    enter: (opts) => ipcRenderer.invoke('training:enter', opts),
    exit: () => ipcRenderer.invoke('training:exit'),
    reset: () => ipcRenderer.invoke('training:reset'),
    progress: () => ipcRenderer.invoke('training:progress'),
    advance: (data) => ipcRenderer.invoke('training:advance', data),
    toggleLessons: () => ipcRenderer.invoke('training:toggle-lessons'),
  },

  // ---- App ----
  getVersion: () => ipcRenderer.invoke('app:version'),
  getPlatform: () => process.platform,
  minimize: () => ipcRenderer.send('app:minimize'),
  maximize: () => ipcRenderer.send('app:maximize'),
  close: () => ipcRenderer.send('app:close'),

  // ---- Status events from main ----
  onStatus: (callback) => {
    const sub = (_event, data) => callback(data);
    ipcRenderer.on('status:update', sub);
    return () => ipcRenderer.removeListener('status:update', sub);
  },
});
