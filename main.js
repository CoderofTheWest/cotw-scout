/**
 * main.js — Electron main process for COTW Scout.
 *
 * Responsibilities:
 * 1. Window management (frameless, custom titlebar)
 * 2. GLM-5:cloud verification via Ollama API
 * 3. Onboarding flow (generates ANCHOR.md, seeds SOUL.md)
 * 4. Workspace scaffolding (copy template, install plugins)
 * 5. OpenClaw gateway lifecycle (spawn, monitor, stop)
 * 6. Update checks (version manifest)
 * 7. Chat relay (HTTP to OpenClaw gateway)
 */

const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');
const { spawn, execSync, execFileSync } = require('child_process');
const http = require('http');
const https = require('https');
const { TunnelController } = require('./tunnel.js');
const { mergeRuntimeObject, mergeModelProviders } = require('./lib/openclaw-merge');
const { writeFileAtomic, writeJsonAtomic } = require('./lib/write-json-atomic');
const { ensureCircleScaffold } = require('./lib/workspace-scaffold');
const {
  normalizeOllamaReadiness,
  normalizeOpenAICodexReadiness,
  applyProviderRecommendation,
} = require('./lib/provider-readiness');
const {
  applyProviderSelectionConfig,
  summarizeSelectedProvider,
} = require('./lib/provider-selection');
const {
  createAttachmentReceipts,
  buildAttachmentReceiptContext,
  buildRecentAttachmentReceiptContext,
  markAttachmentReceiptsObserved,
} = require('./lib/attachment-receipts');
const {
  candidateEvolutionLedgerPaths,
  listEvolutionEvents,
  readEvolutionLedger,
  appendEvolutionEvent,
  updateEvolutionEvent,
  recordClaimReviewEvolution,
  recordCandidateReviewEvolution,
  recordHighRiskApprovalPacket,
  recordHighRiskPreflight,
  recordHighRiskExplicitApproval,
  recordHighRiskPreActionRecheck,
  recordHighRiskClaimMaturationApply,
  assessHighRiskPreActionRecheck
} = require('./lib/evolution-ledger');
const { listClaimEvolutionCandidates } = require('./lib/evolution-candidates');
const {
  approvalString,
  createAutonomyReviewDecisionApply,
  createAutonomyReviewDecisionRollback
} = require('./bundled-plugins/openclaw-plugin-continuity/lib/claim-autonomy-review-decision-apply');
const {
  AUTHORITY_LANES,
  createAuthorityLaneEnforcementReceipt,
  recordRuntimeActionShadowPreflight
} = require('./lib/spine-enforcement');
const {
  candidateSpineLedgerPaths,
  getSpineLedgerSnapshot,
  resolveSpineLedgerPath,
  appendOutcomeEventPacket,
  appendContextEligibilityReview,
  appendResponsibilityLeasePacket
} = require('./lib/spine-ledger');
const {
  PROTECTED_EVOLUTION_ACTION_LANES,
  createEvolutionActionGateReceipt,
  recordEvolutionActionGateReceipt
} = require('./lib/evolution-action-gate');
const { buildEvolutionLedgerHealth } = require('./lib/evolution-health');
const { ClaimStore } = require('./bundled-plugins/openclaw-plugin-continuity/storage/claim-store');
const { isGatewayHandoffLatched } = require('./lib/gateway-handoff-latch');
const { resolveRestartContinuationResultPath } = require('./lib/gateway-service-restart-continuation');
const { buildContinuityHealthReport } = require('./lib/continuity-compaction-health');
const { buildRuntimeLoadReport } = require('./lib/runtime-load-report');
const {
  promoteScaffoldProposal,
  promoteHarnessRefinerProposal,
  rollbackScaffoldPromotion,
  buildScaffoldPromotionEvent,
  buildHarnessRefinerPromotionEvent,
  buildScaffoldRollbackEvent
} = require('./lib/code-evolution-scaffold-promotion');
const {
  observationFromToolEvent,
  renderRecoveryFallbackDetails,
  runRecoveryStep
} = require('./lib/evidence-contract-recovery');
const { appendMetric } = require('./bundled-plugins/lib/runtime-metrics');
const { autoUpdater } = require('electron-updater');

// ---- App Name (shows in macOS menu bar instead of "Electron") ----
app.name = 'COTW Scout';
if (process.platform === 'darwin') {
  app.setName('COTW Scout');
}

// ---- Single Instance Lock ----
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Focus existing window when a second instance tries to launch
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ---- Paths ----

const isDev = process.argv.includes('--dev');
const resourcesPath = isDev
  ? __dirname
  : path.join(process.resourcesPath);

const userDataPath = app.getPath('userData');
const workspacePath = path.join(userDataPath, 'workspace');
const configPath = path.join(userDataPath, 'cotw-config.json');
process.env.COTW_RUNTIME_METRICS_PATH ||= path.join(userDataPath, 'runtime-metrics.jsonl');

// Early migration: copy user data from old app directories to current userData path.
// Handles two legacy names: cotw-scout (original) and cotw-scout (before app rename).
// This must run before anything reads configPath or workspacePath.
{
  const parentDir = path.dirname(userDataPath);
  const legacyDirs = ['cotw-scout', 'cotw-scout'];
  for (const dirName of legacyDirs) {
    const oldAppDir = path.join(parentDir, dirName);
    if (!fs.existsSync(oldAppDir)) continue;
    const oldCfg = path.join(oldAppDir, 'cotw-config.json');
    if (fs.existsSync(oldCfg) && !fs.existsSync(configPath)) {
      try { fs.copyFileSync(oldCfg, configPath); } catch (e) { /* */ }
    }
    const oldWs = path.join(oldAppDir, 'workspace');
    if (fs.existsSync(oldWs) && !fs.existsSync(workspacePath)) {
      try { fs.cpSync(oldWs, workspacePath, { recursive: true }); } catch (e) { /* */ }
    }
    // Stop after first successful migration (prefer newer dir)
    if (fs.existsSync(configPath)) break;
  }
}

// Circle migration: scaffold trust-circle support files for existing workspaces.
// The registry is generated from runtime/operator data instead of copied from
// static templates, because placeholder JSON is invalid live workspace state.
{
  try {
    const cfg = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
    const circleTemplate = isDev
      ? path.join(__dirname, 'template', 'circle')
      : path.join(resourcesPath, 'bundled-template', 'circle');
    ensureCircleScaffold({
      workspacePath,
      circleTemplatePath: circleTemplate,
      displayName: cfg.userName || 'Operator'
    });
  } catch (e) { console.error('Circle migration error:', e.message); }
}

// TACTICAL-SOVEREIGNTY scaffold: place once if missing, never overwrite.
// Unlike SOUL.md / AGENTS.md / PRAXIS.md (spine, fully overwritable), this
// file has REFINEMENTS_START/REFINEMENTS_END markers where the contemplation
// pipeline writes synthesis. Overwriting on every launch would clobber that
// auto-evolved content. If the operator wants the latest hand-authored canon,
// they delete the workspace copy and restart.
{
  const tacticalDest = path.join(workspacePath, 'TACTICAL-SOVEREIGNTY.md');
  const tacticalSrc = isDev
    ? path.join(__dirname, 'bundled-template', 'TACTICAL-SOVEREIGNTY.md')
    : path.join(resourcesPath, 'bundled-template', 'TACTICAL-SOVEREIGNTY.md');
  if (fs.existsSync(workspacePath) && !fs.existsSync(tacticalDest) && fs.existsSync(tacticalSrc)) {
    try { fs.copyFileSync(tacticalSrc, tacticalDest); }
    catch (e) { console.error('Tactical-sovereignty scaffold error:', e.message); }
  }
}

// Booth migration: scaffold booth/ dir for existing workspaces that don't have it
{
  const boothDir = path.join(workspacePath, 'booth');
  const boothTemplate = isDev
    ? path.join(__dirname, 'template', 'booth')
    : path.join(resourcesPath, 'bundled-template', 'booth');
  if (fs.existsSync(workspacePath) && !fs.existsSync(boothDir) && fs.existsSync(boothTemplate)) {
    try {
      fs.cpSync(boothTemplate, boothDir, { recursive: true });
      // Replace placeholders if config has names
      const cfg = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
      if (cfg.agentName || cfg.userName) {
        const files = fs.readdirSync(boothDir).filter(f => f.endsWith('.md'));
        for (const f of files) {
          const fp = path.join(boothDir, f);
          let content = fs.readFileSync(fp, 'utf8');
          if (cfg.agentName) content = content.replace(/\{AGENT_NAME\}/g, cfg.agentName);
          if (cfg.userName) content = content.replace(/\{USER_NAME\}/g, cfg.userName);
          fs.writeFileSync(fp, content);
        }
      }
    } catch (e) { console.error('Booth migration error:', e.message); }
  }
}

// Training Grounds migration: scaffold or update training-grounds/ dir for existing workspaces
// Always syncs .md files from template to catch renames/content updates (e.g. Mother Box → Trail Ride)
// Preserves progress.json if it already has user data (startedAt set)
{
  const tgDir = path.join(workspacePath, 'training-grounds');
  const tgTemplate = isDev
    ? path.join(__dirname, 'template', 'training-grounds')
    : path.join(resourcesPath, 'bundled-template', 'training-grounds');
  if (fs.existsSync(workspacePath) && fs.existsSync(tgTemplate)) {
    try {
      if (!fs.existsSync(tgDir)) fs.mkdirSync(tgDir, { recursive: true });
      const cfg = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
      const templateFiles = fs.readdirSync(tgTemplate);
      for (const f of templateFiles) {
        const srcPath = path.join(tgTemplate, f);
        const destPath = path.join(tgDir, f);
        // Always overwrite .md files (identity/spine updates)
        if (f.endsWith('.md')) {
          let content = fs.readFileSync(srcPath, 'utf8');
          if (cfg.agentName) content = content.replace(/\{AGENT_NAME\}/g, cfg.agentName);
          if (cfg.userName) content = content.replace(/\{USER_NAME\}/g, cfg.userName);
          fs.writeFileSync(destPath, content);
        } else if (f === 'progress.json') {
          // Only write progress.json if it doesn't exist or has no user data
          if (!fs.existsSync(destPath)) {
            fs.copyFileSync(srcPath, destPath);
          } else {
            try {
              const existing = JSON.parse(fs.readFileSync(destPath, 'utf8'));
              if (!existing.startedAt) fs.copyFileSync(srcPath, destPath);
            } catch { fs.copyFileSync(srcPath, destPath); }
          }
        } else if (!fs.existsSync(destPath)) {
          fs.copyFileSync(srcPath, destPath);
        }
      }
    } catch (e) { console.error('Training Grounds migration error:', e.message); }
  }
}

// Identity spine migration: keep SOUL.md / AGENTS.md / PRAXIS.md
// in sync with bundled template on every launch. These are spine
// files (not user-editable identity) — pattern matches training-grounds
// migration above, which already overwrites .md files this way.
{
  const spineFiles = ['SOUL.md', 'AGENTS.md', 'PRAXIS.md'];
  const spineTemplate = isDev
    ? path.join(__dirname, 'template')
    : path.join(resourcesPath, 'bundled-template');
  if (fs.existsSync(workspacePath) && fs.existsSync(spineTemplate)) {
    try {
      const cfg = fs.existsSync(configPath)
        ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
        : {};
      for (const f of spineFiles) {
        const src = path.join(spineTemplate, f);
        const dest = path.join(workspacePath, f);
        if (!fs.existsSync(src)) continue;
        let content = fs.readFileSync(src, 'utf8');
        if (cfg.agentName) content = content.replace(/\{AGENT_NAME\}/g, cfg.agentName);
        if (cfg.userName) content = content.replace(/\{USER_NAME\}/g, cfg.userName);
        fs.writeFileSync(dest, content);
      }
    } catch (e) { console.error('Spine migration error:', e.message); }
  }
}

const templatePath = isDev
  ? path.join(__dirname, 'template')
  : path.join(resourcesPath, 'bundled-template');
const pluginsPath = isDev
  ? path.join(__dirname, 'bundled-plugins')
  : path.join(resourcesPath, 'bundled-plugins');

// Resolve OpenClaw binary + Node runtime for spawning the gateway
// Always spawn openclaw via Electron's own binary (with ELECTRON_RUN_AS_NODE=1
// set in the gateway env below). This guarantees the gateway's Node runtime
// has the same ABI as the native modules rebuilt by electron-rebuild, regardless
// of what system Node the developer or end-user has installed. Previously dev
// mode used system Node, which silently broke whenever NODE_MODULE_VERSION
// didn't happen to match Electron's bundled Node.
const openclawBinary = process.execPath;

const openclawEntry = isDev
  ? path.join(__dirname, 'node_modules', 'openclaw', 'openclaw.mjs')
  : path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'openclaw', 'openclaw.mjs');

// ---- State ----

let mainWindow = null;
let openclawProcess = null;
let gatewayAttached = false; // true when Electron is using an already-running managed gateway
const DEFAULT_GATEWAY_PORT = 18789;
let gatewayPort = DEFAULT_GATEWAY_PORT;
const openclawProfileDir = path.join(require('os').homedir(), '.openclaw-cotw');
let config = loadConfig();
let tunnelController = null; // Cloudflare Tunnel controller — opt-in via config.tunnel.enabled
let activeCodexAuthProcess = null;
let activeSpeechProcess = null;
let speechQueue = [];
let activeSpeechMessageId = null;
let systemVoiceCache = null;
let systemVoiceCacheAt = 0;
let activeNativeStt = null;

// Cross-platform port detection helpers
function getPidsOnPort(port) {
  const { execSync } = require('child_process');
  try {
    if (process.platform === 'win32') {
      const output = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf8', timeout: 5000 });
      // Parse PIDs from last column of netstat output
      const pids = [...new Set(output.trim().split('\n').map(line => line.trim().split(/\s+/).pop()).filter(p => p && p !== '0'))];
      return pids.join('\n');
    }
    return execSync(`lsof -ti :${port}`, { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return ''; // no process on port
  }
}

function killPid(pid, signal = 'SIGTERM') {
  if (process.platform === 'win32') {
    try { require('child_process').execSync(`taskkill /PID ${pid} /F`, { timeout: 5000 }); } catch { /* already dead */ }
  } else {
    try { process.kill(Number(pid), signal); } catch { /* already dead */ }
  }
}

// Find an available port starting from the default
function findAvailablePort(startPort, maxAttempts = 5) {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    const pids = getPidsOnPort(port);
    if (pids) {
      console.log(`[Port] ${port} in use, trying ${port + 1}`);
    } else {
      return port;
    }
  }
  return startPort; // fallback — let startGateway handle the conflict
}
let conversationHistory = [];
let activeRequest = null; // Track in-flight HTTP request for stop
let pendingToolCalls = []; // Track interrupted tool calls across restarts
let activeStreamContent = ''; // Partial content from in-flight stream (for recovery on stop)
let activeStreamMessage = ''; // The user message that started the in-flight stream
let lastGatewayHealthCheck = 0; // timestamp of last successful health check
// Conversation history checkpoint — survives app crash, restored on startup
const checkpointPath = path.join(require('os').homedir(), '.openclaw-cotw', 'conversation-checkpoint.json');
const streamDebugPath = path.join(require('os').homedir(), '.openclaw-cotw', 'logs', 'electron-stream-debug.jsonl');
let checkpointCounter = 0;
let gatewayRestarted = false; // Set when gateway crashes unexpectedly — signals resume to plugins
let gatewayReconnectTimer = null;
let gatewayReconnectAttempts = 0;
let gatewayReconnectInProgress = false;
let gatewayHealthMonitorTimer = null;
let gatewayHealthCheckInProgress = false;
let gatewayHealthFailureCount = 0;
let restartContinuationWatcherTimer = null;
let lastRestartContinuationResultMtimeMs = 0;
let restartContinuationResultMtimeInitialized = false;
const GATEWAY_RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 15000, 30000];
const GATEWAY_ATTACHED_HEALTH_INTERVAL_MS = 5000;
const GATEWAY_ATTACHED_HEALTH_FAILURES_BEFORE_RECONNECT = 2;
let lastMainStreamFailureAt = 0;
let consecutiveMainStreamFailures = 0;
let sessionRolloverInProgress = null;
const PROACTIVE_ROLLOVER_EXCHANGE_THRESHOLD = Number(process.env.COTW_ROLLOVER_EXCHANGE_THRESHOLD || 24);
const PROACTIVE_ROLLOVER_CHAR_THRESHOLD = Number(process.env.COTW_ROLLOVER_CHAR_THRESHOLD || 80000);
const STREAM_FAILURE_ROLLOVER_THRESHOLD = Number(process.env.COTW_STREAM_FAILURE_ROLLOVER_THRESHOLD || 3);
// Mode flags — restored from config.currentSessionMode on startup so mode survives restart
const _restoredMode = config.currentSessionMode || 'chat';
let embodimentModeActive = _restoredMode === 'robot';
let embodimentNeedInjection = _restoredMode === 'robot'; // re-inject context on first message after restart
let boothModeActive = _restoredMode === 'booth';
let boothNeedInjection = _restoredMode === 'booth';
let boothMessageCount = config.currentSessionMessageCount || 0;
let trainingGroundsActive = _restoredMode === 'code';
let trainingGroundsNeedInjection = _restoredMode === 'code';
let trainingGroundsMessageCount = config.currentSessionMessageCount || 0;
let needModeExitReorientation = null; // set to mode name on exit, cleared after injection
// Only inject startup reorientation if we're in plain chat — mode sessions should continue naturally
let needStartupReorientation = _restoredMode === 'chat';

// Session continuity — restore last session on restart, fallback to new session
let currentSessionId = config.currentSessionId || `session_${Date.now()}`;
let currentThreadId = config.currentThreadId || (config.currentSessionProjectId ? `project_${config.currentSessionProjectId}` : currentSessionId);
if (String(currentSessionId).startsWith('project_')) {
  currentThreadId = currentSessionId;
  currentSessionId = `session_${Date.now()}`;
}
let currentSessionMode = config.currentSessionMode || 'chat';
let currentSessionFirstUserMsg = config.currentSessionFirstUserMsg || null;
let currentSessionMessageCount = config.currentSessionMessageCount || 0;
let currentSessionProjectId = config.currentSessionProjectId || null;
let pendingRolloverBridge = config.pendingRolloverBridge || null;
let pendingNewTaskBoundary = config.pendingNewTaskBoundary || null;

function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch { /* fresh start */ }
  return {
    setupComplete: false,
    agentName: null,
    userName: null,
    telemetryOptIn: false,
    workspaceVersion: '0.1.0',
    pluginsVersion: '0.1.0',
    openclawVersion: '0.1.0',
    appVersion: '0.1.0',
    gatewayToken: null,
    capabilityTier: 1,
    tunnel: {
      enabled: false,   // opt-in — when true, Companion spawns cloudflared alongside the gateway
      mode: 'quick',    // 'quick' = trycloudflare.com (dev); 'named' = stable subdomain (Phase 2)
      hostname: null,   // last-known tunnel hostname (regenerates each start in quick mode)
    },
  };
}

function saveConfig() {
  writeJsonAtomic(configPath, config);
}

// ============================================================
// Window
// ============================================================

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#3D2914',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('cotw-scout-gui.html');

  // Dev tools: only open if explicitly requested via --devtools flag
  if (process.argv.includes('--devtools')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Set dock icon on macOS
  if (process.platform === 'darwin' && app.dock) {
    const { nativeImage } = require('electron');
    const dockIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon-1024.png'));
    if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
  }

  // Custom application menu — first item label becomes the macOS menu bar name
  if (process.platform === 'darwin') {
    const menuTemplate = [
      {
        label: 'COTW Scout',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' }
        ]
      },
      { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'View', submenu: [{ role: 'togglefullscreen' }] },
      { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }] }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
  }

  createWindow();
  startRestartContinuationWatcher();

  // Run DB migrations on startup — ensures new columns (jsonl_file, archived) exist before any queries
  try {
    writeContinuityDB('UPDATE sessions SET id = id WHERE 0', []);
  } catch { /* DB may not exist yet — that's fine */ }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Check for updates on launch (non-blocking)
  checkForUpdates().catch(() => {});

  // Wire up the electron-updater auto-update pipeline. Independent of the
  // manifest-based check above — handles the app binary itself.
  setupAutoUpdater();
});

let shuttingDown = false;

// Exit/crash logging — writes to app support dir for post-mortem
const exitLogPath = path.join(app.getPath('userData'), 'exit.log');
function logExit(reason, detail) {
  try {
    const entry = `[${new Date().toISOString()}] ${reason}${detail ? ': ' + detail : ''}\n`;
    fs.appendFileSync(exitLogPath, entry);
  } catch { /* best effort */ }
}

process.on('uncaughtException', (err) => {
  logExit('UNCAUGHT_EXCEPTION', err.stack || err.message);
  if (!shuttingDown) {
    shuttingDown = true;
    stopGateway().finally(() => process.exit(1));
  }
});

process.on('unhandledRejection', (reason) => {
  logExit('UNHANDLED_REJECTION', String(reason));
});

app.on('window-all-closed', (e) => {
  if (!shuttingDown) {
    shuttingDown = true;
    logExit('QUIT', 'window-all-closed');
    e.preventDefault();
    stopGateway().finally(() => app.quit());
  }
});

app.on('before-quit', (e) => {
  if (!shuttingDown) {
    shuttingDown = true;
    logExit('QUIT', 'before-quit');
    // Write current session record before quitting
    try { writeSessionRecord(); } catch {}
    e.preventDefault();
    // Sync workspace to GitHub before quitting (non-blocking — don't delay exit)
    gitSyncWorkspace('session end').catch(err => {
      console.error('[GitHub] Session-end sync failed:', err.message);
    });
    stopGateway().finally(() => app.quit());
  }
});

// ============================================================
// IPC: Window controls
// ============================================================

ipcMain.on('app:minimize', () => mainWindow?.minimize());
ipcMain.on('app:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('app:close', () => mainWindow?.close());
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('shell:open-external', (_event, url) => {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      console.warn(`[Security] Blocked non-HTTP URL: ${url}`);
      return { blocked: true, reason: 'Only http/https links are allowed' };
    }
    return shell.openExternal(url);
  } catch {
    console.warn(`[Security] Blocked invalid URL: ${url}`);
    return { blocked: true, reason: 'Invalid URL' };
  }
});
ipcMain.handle('clipboard:write', (_event, text) => require('electron').clipboard.writeText(text));
ipcMain.handle('app:focus', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });

// ============================================================
// IPC: Voice & Speech
// ============================================================

function parseSystemVoices(raw) {
  return String(raw || '')
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(Boolean)
    .map(line => {
      const match = line.match(/^(.+?)\s+([a-z]{2}_[A-Z]{2})\s+#\s*(.*)$/);
      if (!match) return null;
      const name = match[1].trim();
      const locale = match[2];
      return {
        id: name,
        name,
        locale,
        sample: match[3] || '',
        installed: true,
        recommended: name === 'Zoe (Enhanced)' || name === 'Evan (Enhanced)',
      };
    })
    .filter(Boolean);
}

function listSystemVoices({ force = false } = {}) {
  if (process.platform !== 'darwin') return [];
  const now = Date.now();
  if (!force && systemVoiceCache && now - systemVoiceCacheAt < 30000) return systemVoiceCache;
  try {
    systemVoiceCache = parseSystemVoices(execFileSync('/usr/bin/say', ['-v', '?'], { encoding: 'utf8', timeout: 10000 }));
    systemVoiceCacheAt = now;
    return systemVoiceCache;
  } catch (err) {
    console.warn('[Voice] Unable to list system voices:', err.message);
    return systemVoiceCache || [];
  }
}

function getDefaultVoiceSettings() {
  const voices = listSystemVoices();
  const preferred = voices.find(v => v.id === 'Zoe (Enhanced)') || voices.find(v => v.id === 'Evan (Enhanced)') || voices[0] || null;
  return {
    ttsEnabled: false,
    ttsMode: 'off',
    systemVoiceId: preferred?.id || '',
    sttMode: 'off',
    pttReleaseBehavior: 'send',
    lastVoiceListCheckedAt: null,
  };
}

function getVoiceSettings() {
  return { ...getDefaultVoiceSettings(), ...(config.voice || {}) };
}

function normalizeVoiceSettings(input) {
  const current = getVoiceSettings();
  const next = { ...current, ...(input || {}) };
  next.ttsMode = next.ttsMode === 'system' ? 'system' : 'off';
  next.ttsEnabled = next.ttsMode === 'system';
  next.sttMode = ['off', 'pushToTalk', 'wake', 'talk'].includes(next.sttMode) ? next.sttMode : 'off';
  next.pttReleaseBehavior = next.pttReleaseBehavior === 'insertOnly' ? 'insertOnly' : 'send';
  next.systemVoiceId = String(next.systemVoiceId || '').trim();
  next.lastVoiceListCheckedAt = new Date().toISOString();
  return next;
}

function validateInstalledVoiceId(voiceId) {
  const voices = listSystemVoices();
  return voices.some(v => v.id === voiceId);
}

function stopSystemSpeech() {
  speechQueue = [];
  activeSpeechMessageId = null;
  if (activeSpeechProcess) {
    try { activeSpeechProcess.kill('SIGTERM'); } catch {}
    activeSpeechProcess = null;
  }
}

function startNextSpeechChunk() {
  if (activeSpeechProcess || speechQueue.length === 0) return;
  const next = speechQueue.shift();
  if (!next?.text?.trim()) return startNextSpeechChunk();
  if (!validateInstalledVoiceId(next.voiceId)) return startNextSpeechChunk();
  activeSpeechMessageId = next.messageId || null;
  activeSpeechProcess = spawn('/usr/bin/say', ['-v', next.voiceId, next.text], { stdio: 'ignore' });
  activeSpeechProcess.on('close', () => {
    activeSpeechProcess = null;
    startNextSpeechChunk();
  });
  activeSpeechProcess.on('error', err => {
    console.warn('[Voice] say failed:', err.message);
    activeSpeechProcess = null;
    startNextSpeechChunk();
  });
}

function enqueueSpeechChunk({ messageId, chunk, voiceId } = {}) {
  const settings = getVoiceSettings();
  if (settings.ttsMode !== 'system') return { queued: false, reason: 'tts-disabled' };
  const text = String(chunk || '').replace(/\s+/g, ' ').trim();
  if (!text) return { queued: false, reason: 'empty' };
  const selectedVoice = String(voiceId || settings.systemVoiceId || '').trim();
  if (!validateInstalledVoiceId(selectedVoice)) return { queued: false, reason: 'voice-not-installed' };
  if (messageId && activeSpeechMessageId && messageId !== activeSpeechMessageId && speechQueue.length > 0) {
    stopSystemSpeech();
  }
  speechQueue.push({ messageId: messageId || null, text, voiceId: selectedVoice });
  startNextSpeechChunk();
  return { queued: true };
}

function resolveCommand(command) {
  try {
    return execFileSync('/usr/bin/which', [command], { encoding: 'utf8', timeout: 2000 }).trim();
  } catch {
    return '';
  }
}

function speechHelperPath() {
  if (process.platform !== 'darwin') return '';
  const candidates = [
    path.join(resourcesPath, 'native/macos/bin/cotw-speech-helper'),
    path.join(__dirname, 'native/macos/bin/cotw-speech-helper'),
  ];
  return candidates.find(p => fs.existsSync(p)) || '';
}

function readJsonLine(text) {
  const lines = String(text || '').trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function getNativeSpeechHelperStatus(helper = speechHelperPath()) {
  if (!helper) return null;
  try {
    const raw = execFileSync(helper, ['status'], { encoding: 'utf8', timeout: 5000 });
    return readJsonLine(raw) || { type: 'status' };
  } catch (err) {
    return { type: 'status', error: err?.message || String(err) };
  }
}

function detectLocalSttBackend() {
  const nativeHelper = speechHelperPath();
  const nativeStatus = getNativeSpeechHelperStatus(nativeHelper);
  const whisperCli = resolveCommand('whisper-cli');
  const whisper = resolveCommand('whisper');
  const sherpa = resolveCommand('sherpa-onnx-offline');
  const candidates = [];
  if (nativeHelper) candidates.push({ id: 'macos-speech-helper', label: 'macOS Speech', command: nativeHelper, ready: true, detail: nativeStatus?.error ? nativeStatus.error : 'Ready; permissions may prompt on first use', status: nativeStatus });
  if (whisperCli) candidates.push({ id: 'whisper-cli', label: 'whisper.cpp CLI', command: whisperCli, ready: Boolean(process.env.WHISPER_CPP_MODEL), detail: process.env.WHISPER_CPP_MODEL ? 'Ready via WHISPER_CPP_MODEL' : 'Set WHISPER_CPP_MODEL to enable' });
  if (whisper) candidates.push({ id: 'whisper', label: 'Python Whisper CLI', command: whisper, ready: true, detail: 'Ready' });
  if (sherpa) candidates.push({ id: 'sherpa-onnx-offline', label: 'sherpa-onnx offline', command: sherpa, ready: Boolean(process.env.SHERPA_ONNX_MODEL_DIR), detail: process.env.SHERPA_ONNX_MODEL_DIR ? 'Ready via SHERPA_ONNX_MODEL_DIR' : 'Set SHERPA_ONNX_MODEL_DIR to enable' });
  const backend = candidates.find(c => c.ready) || null;
  return {
    available: Boolean(backend),
    backend,
    candidates,
    nativeHelperAvailable: Boolean(nativeHelper),
    nativeHelperStatus: nativeStatus,
    note: backend ? `Local transcription ready: ${backend.label}.` : 'No local speech recognizer found yet. Build the native macOS Speech helper or install/configure local Whisper.',
  };
}

function audioExtensionForMime(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('wav')) return '.wav';
  if (mime.includes('mp4') || mime.includes('m4a')) return '.m4a';
  if (mime.includes('ogg')) return '.ogg';
  return '.webm';
}

function readNewestTextFile(dir) {
  const files = fs.readdirSync(dir)
    .filter(name => name.endsWith('.txt'))
    .map(name => ({ name, path: path.join(dir, name), mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files[0]) return '';
  return fs.readFileSync(files[0].path, 'utf8').trim();
}

function runLocalTranscription(filePath, backend, workDir) {
  if (!backend) throw new Error('No local transcription backend is available');
  if (backend.id === 'whisper-cli') {
    const model = process.env.WHISPER_CPP_MODEL;
    const stdout = execFileSync(backend.command, ['-m', model, '-f', filePath, '-nt', '-np'], { encoding: 'utf8', timeout: 120000, maxBuffer: 5 * 1024 * 1024 });
    return stdout.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  if (backend.id === 'whisper') {
    execFileSync(backend.command, [filePath, '--model', process.env.WHISPER_MODEL || 'base', '--output_format', 'txt', '--output_dir', workDir], { encoding: 'utf8', timeout: 120000, maxBuffer: 5 * 1024 * 1024 });
    return readNewestTextFile(workDir);
  }
  throw new Error(`Unsupported local transcription backend: ${backend.id}`);
}

function transcribePttAudio({ audioBase64, mimeType } = {}) {
  const status = detectLocalSttBackend();
  const backend = status.candidates.find(c => ['whisper-cli', 'whisper', 'sherpa-onnx-offline'].includes(c.id) && c.ready) || null;
  if (!backend) return { success: false, error: status.nativeHelperAvailable ? 'Native macOS Speech helper is available; use live push-to-talk capture instead of audio-file transcription.' : status.note, status };
  const raw = String(audioBase64 || '').replace(/^data:[^,]+,/, '');
  if (!raw) return { success: false, error: 'No audio was captured.' };
  const workDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'cotw-ptt-'));
  const audioPath = path.join(workDir, 'input' + audioExtensionForMime(mimeType));
  try {
    fs.writeFileSync(audioPath, Buffer.from(raw, 'base64'));
    const transcript = runLocalTranscription(audioPath, backend, workDir).trim();
    return transcript ? { success: true, transcript, backend } : { success: false, error: "Didn't catch that.", backend };
  } catch (err) {
    return { success: false, error: err?.message || String(err), backend };
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

function cleanupNativeStt() {
  if (activeNativeStt?.process) {
    try { activeNativeStt.process.kill('SIGTERM'); } catch {}
  }
  activeNativeStt = null;
}

function startNativePttCapture() {
  if (activeNativeStt) return { success: false, error: 'Push-to-talk is already recording.' };
  const helper = speechHelperPath();
  if (!helper) return { success: false, error: 'Native macOS Speech helper is not built.' };
  const child = spawn(helper, ['capture'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const state = { process: child, transcript: '', error: '', ready: false, done: false, pendingStop: null, buffer: '' };
  activeNativeStt = state;

  const settleStop = () => {
    if (!state.pendingStop) return;
    const resolve = state.pendingStop;
    state.pendingStop = null;
    const transcript = state.transcript.trim();
    activeNativeStt = null;
    resolve(transcript ? { success: true, transcript, backend: { id: 'macos-speech-helper', label: 'macOS Speech' } } : { success: false, error: state.error || "Didn't catch that." });
  };

  child.stdout.on('data', chunk => {
    state.buffer += chunk.toString('utf8');
    const lines = state.buffer.split(/\r?\n/);
    state.buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'ready') state.ready = true;
      if ((event.type === 'partial' || event.type === 'final' || event.type === 'done') && event.text) state.transcript = String(event.text);
      if (event.type === 'error') state.error = event.message || 'Speech helper failed.';
      if (event.type === 'done' || event.type === 'error') {
        state.done = true;
        settleStop();
      }
    }
  });
  child.stderr.on('data', chunk => { state.error = chunk.toString('utf8').trim() || state.error; });
  child.on('close', () => { state.done = true; settleStop(); if (activeNativeStt === state) activeNativeStt = null; });
  child.on('error', err => { state.error = err?.message || String(err); state.done = true; settleStop(); if (activeNativeStt === state) activeNativeStt = null; });

  return new Promise(resolve => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (!activeNativeStt || activeNativeStt !== state) {
        clearInterval(timer);
        resolve({ success: false, error: state.error || 'Speech helper exited before capture started.' });
      } else if (state.ready) {
        clearInterval(timer);
        resolve({ success: true, backend: { id: 'macos-speech-helper', label: 'macOS Speech' } });
      } else if (state.error || Date.now() - startedAt > 12000) {
        clearInterval(timer);
        cleanupNativeStt();
        resolve({ success: false, error: state.error || 'Timed out waiting for speech helper.' });
      }
    }, 100);
  });
}

function stopNativePttCapture() {
  const state = activeNativeStt;
  if (!state?.process) return { success: false, error: 'Push-to-talk is not recording.' };
  return new Promise(resolve => {
    state.pendingStop = resolve;
    try { state.process.stdin.write('stop\n'); } catch {}
    const timeout = setTimeout(() => {
      if (state.pendingStop) {
        state.pendingStop = null;
        const transcript = state.transcript.trim();
        cleanupNativeStt();
        resolve(transcript ? { success: true, transcript, backend: { id: 'macos-speech-helper', label: 'macOS Speech' } } : { success: false, error: state.error || "Didn't catch that." });
      }
    }, 10000);
    const originalResolve = state.pendingStop;
    state.pendingStop = result => { clearTimeout(timeout); originalResolve(result); };
  });
}

function cancelNativePttCapture() {
  if (activeNativeStt?.process) {
    try { activeNativeStt.process.stdin.write('cancel\n'); } catch {}
    cleanupNativeStt();
  }
  return { success: true };
}

ipcMain.handle('voice:list-system-voices', () => {
  const voices = listSystemVoices({ force: true });
  return { voices, checkedAt: new Date().toISOString() };
});

ipcMain.handle('voice:get-settings', () => getVoiceSettings());

ipcMain.handle('voice:save-settings', (_event, settings) => {
  const next = normalizeVoiceSettings(settings);
  if (next.ttsMode === 'system' && next.systemVoiceId && !validateInstalledVoiceId(next.systemVoiceId)) {
    return { success: false, error: 'Selected voice is not installed' };
  }
  config.voice = next;
  saveConfig();
  if (next.ttsMode !== 'system') stopSystemSpeech();
  return { success: true, settings: next };
});

ipcMain.handle('voice:preview-system-voice', (_event, { voiceId, text } = {}) => {
  const selectedVoice = String(voiceId || '').trim();
  if (!validateInstalledVoiceId(selectedVoice)) return { success: false, error: 'Voice is not installed' };
  stopSystemSpeech();
  speechQueue.push({
    messageId: 'preview-' + Date.now(),
    voiceId: selectedVoice,
    text: String(text || "I'm Ellis. I'll speak only when you ask me to, and I'll keep it plain.").slice(0, 500),
  });
  startNextSpeechChunk();
  return { success: true };
});

ipcMain.handle('voice:enqueue-speech-chunk', (_event, payload) => enqueueSpeechChunk(payload));
ipcMain.handle('voice:stop-speaking', () => { stopSystemSpeech(); return { success: true }; });
ipcMain.handle('voice:stt-status', () => detectLocalSttBackend());
ipcMain.handle('voice:start-ptt', () => startNativePttCapture());
ipcMain.handle('voice:stop-ptt', () => stopNativePttCapture());
ipcMain.handle('voice:cancel-ptt', () => cancelNativePttCapture());
ipcMain.handle('voice:transcribe-ptt-audio', (_event, payload) => transcribePttAudio(payload));

// ============================================================
// IPC: Setup & Verification
// ============================================================

ipcMain.handle('setup:get-state', () => {
  return {
    setupComplete: config.setupComplete,
    agentName: config.agentName,
    userName: config.userName,
    telemetryOptIn: config.telemetryOptIn,
  };
});


async function checkOllamaInstallAndService() {
  try {
    const result = execSync('ollama --version', { encoding: 'utf8', timeout: 5000 });
    const version = result.trim();

    // Also check if the service is actually running
    try {
      await httpGet('http://localhost:11434/api/tags', 30000);
      return { installed: true, running: true, version };
    } catch {
      return { installed: true, running: false, version };
    }
  } catch {
    return { installed: false, running: false, version: null };
  }
}

async function checkOllamaSigninStatus() {
  // Check if the user is signed in to Ollama by trying to access cloud models.
  // If not signed in, the /api/tags list won't include cloud models,
  // or /api/show on a cloud model will fail with auth error.
  try {
    // Check if any cloud models appear in the tags list — their presence means signed in
    const response = await withRetry(() => httpGet('http://localhost:11434/api/tags', 30000));
    const data = JSON.parse(response);
    const models = data.models || [];
    const cloudModels = models.filter(m => m.name && m.name.includes(':cloud'));

    if (cloudModels.length > 0) {
      return { signedIn: true, cloudModels: cloudModels.map(m => m.name) };
    }

    // No cloud models visible — could mean not signed in, or just not pulled any
    // Try to show a known cloud model to detect auth status
    try {
      const showResponse = await httpPost('http://localhost:11434/api/show', {
        name: 'glm-5:cloud'
      });
      const showData = JSON.parse(showResponse);
      // If we get data back, they're signed in (model just wasn't pulled yet)
      if (showData.details || showData.model_info) {
        return { signedIn: true, cloudModels: ['glm-5:cloud'] };
      }
    } catch (err) {
      const errStr = String(err.message || err);
      // Auth errors indicate not signed in
      if (errStr.includes('401') || errStr.includes('auth') || errStr.includes('unauthorized')) {
        return { signedIn: false, reason: 'not_authenticated' };
      }
      // Model not found but no auth error — they're signed in, model just doesn't exist
      if (errStr.includes('404') || errStr.includes('not found')) {
        return { signedIn: true, cloudModels: [] };
      }
    }

    // If we can reach the API but no cloud models are found,
    // assume signed in (they may just not have pulled any cloud models)
    return { signedIn: true, cloudModels: [] };
  } catch {
    return { signedIn: false, reason: 'cannot_connect' };
  }
}

async function checkGLM5Status() {
  // Check if GLM-5:cloud is available via Ollama API
  try {
    const response = await withRetry(() => httpGet('http://localhost:11434/api/tags', 30000));
    const data = JSON.parse(response);
    const models = data.models || [];

    // Look for glm-5:cloud specifically, then any glm-5 variant
    const glm5cloud = models.find(m =>
      m.name && m.name.toLowerCase() === 'glm-5:cloud'
    );
    if (glm5cloud) {
      return { available: true, model: glm5cloud.name, size: glm5cloud.size, cloud: true };
    }

    const glm5any = models.find(m =>
      m.name && m.name.toLowerCase().startsWith('glm-5')
    );
    if (glm5any) {
      return { available: true, model: glm5any.name, size: glm5any.size, cloud: glm5any.name.includes('cloud') };
    }

    // Fallback: try /api/show in case tags list is stale
    try {
      const showResponse = await httpPost('http://localhost:11434/api/show', {
        name: 'glm-5:cloud'
      });
      const showData = JSON.parse(showResponse);
      // Cloud models return details/model_info/capabilities (not modelfile/template)
      if (showData.details || showData.model_info || showData.capabilities) {
        return { available: true, model: 'glm-5:cloud', cloud: true };
      }
    } catch { /* not available */ }

    return { available: false, models: models.map(m => m.name) };
  } catch {
    return { available: false, error: 'Cannot connect to Ollama API at localhost:11434' };
  }
}

function buildOpenClawChildEnv() {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    OPENCLAW_WORKSPACE: workspacePath,
    OPENCLAW_AGENT: config.agentName || 'trail-guide',
    OPENCLAW_RUNTIME_METRICS_PATH: path.join(app.getPath('userData'), 'runtime-metrics.jsonl'),
  };
}

function runOpenClawJson(args, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(openclawEntry)) {
      reject(new Error(`OpenClaw entry point not found at ${openclawEntry}`));
      return;
    }

    const child = spawn(openclawBinary, [openclawEntry, '--profile', 'cotw', ...args], {
      cwd: __dirname,
      env: buildOpenClawChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`openclaw ${args.join(' ')} timed out`));
    }, timeoutMs);

    child.stdout.on('data', data => { stdout += data.toString(); });
    child.stderr.on('data', data => { stderr += data.toString(); });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error((stderr || stdout || `openclaw exited ${code}`).trim()));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(new Error(`openclaw returned non-JSON output: ${err.message}`));
      }
    });
  });
}

async function checkOpenAICodexReadiness() {
  try {
    const [status, models] = await Promise.all([
      runOpenClawJson(['models', 'status', '--json']),
      runOpenClawJson(['models', 'list', '--provider', 'openai-codex', '--json']).catch(() => []),
    ]);
    return normalizeOpenAICodexReadiness({ status, models, runtimeAvailable: true });
  } catch (err) {
    return normalizeOpenAICodexReadiness({ error: err });
  }
}

async function checkOllamaReadiness() {
  const ollama = await checkOllamaInstallAndService();
  if (!ollama.installed || !ollama.running) {
    return normalizeOllamaReadiness({ ollama });
  }
  const signin = await checkOllamaSigninStatus();
  if (!signin.signedIn) {
    return normalizeOllamaReadiness({ ollama, signin });
  }
  const glm5 = await checkGLM5Status();
  return normalizeOllamaReadiness({ ollama, signin, glm5 });
}

async function checkProviderReadiness() {
  const [ollama, codex] = await Promise.all([
    checkOllamaReadiness(),
    checkOpenAICodexReadiness(),
  ]);
  const providers = applyProviderRecommendation([codex, ollama]);
  return {
    providers,
    recommendedProviderId: providers.find(p => p.recommended)?.id || null,
    checkedAt: new Date().toISOString(),
  };
}

function sanitizeAuthOutput(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, '[link hidden]')
    .replace(/\b(sk-[A-Za-z0-9_-]+)\b/g, '[secret redacted]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[secret redacted]')
    .replace(new RegExp(require('os').homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '~')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(-4)
    .join(' ')
    .slice(0, 700);
}

function connectOpenAICodex({ timeoutMs = 300000 } = {}) {
  return new Promise((resolve) => {
    if (activeCodexAuthProcess?.child) {
      resolve({ ok: false, status: 'already_running', message: 'ChatGPT sign-in is already running.' });
      return;
    }

    if (!fs.existsSync(openclawEntry)) {
      resolve({ ok: false, status: 'error', error: 'OpenClaw entry point not found.' });
      return;
    }

    const child = spawn(openclawBinary, [
      openclawEntry,
      '--profile', 'cotw',
      'models', 'auth', 'login',
      '--provider', 'openai-codex',
    ], {
      cwd: __dirname,
      env: buildOpenClawChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const state = { child, cancelled: false };
    activeCodexAuthProcess = state;
    let stdout = '';
    let stderr = '';

    const finish = async (result) => {
      if (activeCodexAuthProcess === state) activeCodexAuthProcess = null;
      resolve(result);
    };

    const timer = setTimeout(() => {
      state.cancelled = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', data => { stdout += data.toString(); });
    child.stderr.on('data', data => { stderr += data.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, status: 'error', error: sanitizeAuthOutput(err.message) || 'Could not start ChatGPT sign-in.' });
    });
    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      if (state.cancelled) {
        finish({ ok: false, status: 'cancelled', message: 'ChatGPT sign-in was cancelled.' });
        return;
      }
      if (code === 0) {
        const readiness = await checkOpenAICodexReadiness();
        finish({ ok: true, status: 'connected', readiness });
        return;
      }
      const detail = sanitizeAuthOutput(stderr || stdout || `auth flow exited with code ${code || signal}`);
      finish({ ok: false, status: 'error', error: detail || 'ChatGPT sign-in did not complete.' });
    });
  });
}

function cancelOpenAICodex() {
  if (!activeCodexAuthProcess?.child) return { ok: false, status: 'idle' };
  activeCodexAuthProcess.cancelled = true;
  activeCodexAuthProcess.child.kill('SIGTERM');
  return { ok: true, status: 'cancelled' };
}

function runtimeOpenClawConfigPath() {
  return path.join(require('os').homedir(), '.openclaw-cotw', 'openclaw.json');
}

async function getModelProviderStatus() {
  const runtimePath = runtimeOpenClawConfigPath();
  let runtimeConfig = {};
  if (fs.existsSync(runtimePath)) {
    try { runtimeConfig = JSON.parse(fs.readFileSync(runtimePath, 'utf8')); }
    catch { runtimeConfig = {}; }
  }
  const readiness = await checkProviderReadiness();
  return {
    current: summarizeSelectedProvider(runtimeConfig),
    readiness,
    checkedAt: readiness.checkedAt,
  };
}

async function switchModelProvider(providerId, { requireReady = true } = {}) {
  if (!['openai-codex', 'ollama'].includes(providerId)) {
    return { ok: false, status: 'invalid_provider', error: 'Unknown provider.' };
  }

  if (requireReady) {
    const readiness = await checkProviderReadiness();
    const provider = readiness.providers.find(p => p.id === providerId);
    if (!provider?.ready) {
      return {
        ok: false,
        status: 'not_ready',
        provider: providerId,
        error: provider?.detail || 'Provider is not ready yet.',
      };
    }
  }

  const runtimePath = runtimeOpenClawConfigPath();
  if (!fs.existsSync(runtimePath)) writeOpenClawConfig();
  const existing = fs.existsSync(runtimePath)
    ? JSON.parse(fs.readFileSync(runtimePath, 'utf8'))
    : {};
  const next = applyProviderSelectionConfig(existing, providerId);
  writeJsonAtomic(runtimePath, next, { mode: 0o600 });
  return {
    ok: true,
    status: 'switched',
    provider: summarizeSelectedProvider(next),
    needsNewSession: true,
    message: 'Future conversations will use the selected provider. Start a fresh session for the runtime change to apply cleanly.',
  };
}

ipcMain.handle('setup:check-ollama', () => checkOllamaInstallAndService());
ipcMain.handle('setup:check-ollama-signin', () => checkOllamaSigninStatus());
ipcMain.handle('setup:check-glm5', () => checkGLM5Status());
ipcMain.handle('setup:check-openai-codex', () => checkOpenAICodexReadiness());
ipcMain.handle('setup:verify-openai-codex', () => checkOpenAICodexReadiness());
ipcMain.handle('setup:connect-openai-codex', (_event, opts) => connectOpenAICodex(opts));
ipcMain.handle('setup:cancel-openai-codex', () => cancelOpenAICodex());
ipcMain.handle('setup:check-provider-readiness', () => checkProviderReadiness());
ipcMain.handle('settings:get-provider-status', () => getModelProviderStatus());
ipcMain.handle('settings:switch-provider', (_event, providerId) => switchModelProvider(providerId));

ipcMain.handle('setup:onboarding', async (_event, answers) => {
  // answers: { userName, agentName, currentFocus, coreValues, unspoken, telemetryOptIn }
  try {
    // Sanitize names — strip characters that could break JSON or template replacement
    answers.userName = sanitizeName(answers.userName);
    answers.agentName = sanitizeName(answers.agentName);

    // 1. Scaffold workspace from template
    await scaffoldWorkspace(answers);

    // 2. Update config
    config.setupComplete = true;
    config.agentName = answers.agentName;
    config.userName = answers.userName;
    config.telemetryOptIn = answers.telemetryOptIn || false;
    saveConfig();

    // 3. Apply explicit provider selection after scaffold writes the runtime config
    if (answers.providerId) {
      await switchModelProvider(answers.providerId, { requireReady: false });
    }

    // 4. Start the gateway
    await startGateway();

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('setup:preview-voice', async () => {
  // Generate a preview greeting from the assembled identity so the user
  // can hear the agent's voice before their first real conversation.
  // Called after scaffoldWorkspace() populates SOUL.md + ANCHOR.md.
  try {
    const soulPath = path.join(workspacePath, 'SOUL.md');
    const anchorPath = path.join(workspacePath, 'ANCHOR.md');

    if (!fs.existsSync(soulPath) || !fs.existsSync(anchorPath)) {
      return { error: 'Workspace not scaffolded yet' };
    }

    const soul = fs.readFileSync(soulPath, 'utf8').substring(0, 4000);
    const anchor = fs.readFileSync(anchorPath, 'utf8').substring(0, 2000);

    const prompt = `${soul}\n\n${anchor}\n\nThe user has just named you and told you what matters to them. This is your very first message to them. Greet them naturally in your voice. Keep it under 3 sentences. No questions yet — just arrive.`;

    const response = await httpPost('http://127.0.0.1:11434/api/generate', {
      model: 'glm-5:cloud',
      prompt,
      stream: false,
      options: { temperature: 0.7, num_predict: 200 }
    }, 30000);

    const parsed = JSON.parse(response);
    return { preview: parsed.response || parsed.text || '' };
  } catch (err) {
    return { error: err.message };
  }
});

// ============================================================
// Workspace Scaffolding
// ============================================================

async function scaffoldWorkspace(answers) {
  // Copy template to workspace
  if (!fs.existsSync(workspacePath)) {
    fs.mkdirSync(workspacePath, { recursive: true });
  }

  copyDirRecursive(templatePath, workspacePath);

  // Inject user/agent names into ALL .md files
  replaceWorkspacePlaceholders(workspacePath, answers.agentName, answers.userName);

  // Generate ANCHOR.md from onboarding answers
  const anchorContent = generateAnchor(answers);
  fs.writeFileSync(path.join(workspacePath, 'ANCHOR.md'), anchorContent);

  // Generate runtime-specific circle registry after static template copy.
  // Do not ship or depend on unresolved placeholder JSON for live workspaces.
  ensureCircleScaffold({
    workspacePath,
    circleTemplatePath: path.join(templatePath, 'circle'),
    displayName: answers.userName
  });

  // Write telemetry config
  const telemetryConfig = {
    opted_in: answers.telemetryOptIn || false,
    created: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(workspacePath, 'telemetry-config.json'),
    JSON.stringify(telemetryConfig, null, 2)
  );

  // Create data directories
  const dataDirs = ['memory', 'data', 'data/journals', 'data/contemplation'];
  for (const dir of dataDirs) {
    const fullPath = path.join(workspacePath, dir);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
    }
  }

  // Write resolved openclaw.json to the profile directory
  writeOpenClawConfig();

  sendStatus('workspace', `Workspace created for ${answers.agentName}`);
}

function generateAnchor(answers) {
  const now = new Date().toISOString().split('T')[0];
  return `# ${answers.userName}

*Created ${now} during onboarding*

## Who You Are

**Name:** ${answers.userName}

## What Matters

${answers.coreValues || '*To be discovered through conversation.*'}

## Current Focus

${answers.currentFocus || '*Still finding the thread.*'}

## The Unsaid

${answers.unspoken || '*Some things take time.*'}

---

*This file is yours. ${answers.agentName} uses it to remember what matters to you. It grows as you share more of yourself.*
`;
}

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      // Don't overwrite user files that already exist
      if (!fs.existsSync(destPath) || !isUserFile(entry.name)) {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}

function replaceWorkspacePlaceholders(dir, agentName, userName) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      replaceWorkspacePlaceholders(fullPath, agentName, userName);
    } else if (entry.name.endsWith('.md')) {
      let content = fs.readFileSync(fullPath, 'utf8');
      if (content.includes('{AGENT_NAME}') || content.includes('{USER_NAME}')) {
        content = content.replace(/\{AGENT_NAME\}/g, agentName);
        content = content.replace(/\{USER_NAME\}/g, userName);
        fs.writeFileSync(fullPath, content);
      }
    }
  }
}

function isUserFile(filename) {
  // Files that belong to the user and shouldn't be overwritten on update
  const userFiles = [
    'ANCHOR.md', 'MEMORY.md', 'telemetry-config.json',
  ];
  return userFiles.includes(filename);
}

function ensureGatewayToken() {
  if (!config.gatewayToken) {
    config.gatewayToken = require('crypto').randomBytes(32).toString('hex');
    saveConfig();
  }
  return config.gatewayToken;
}

function writeOpenClawConfig() {
  // OpenClaw uses --profile to isolate config under ~/.openclaw-<profile>/
  const profileDir = path.join(require('os').homedir(), '.openclaw-cotw');
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }

  // ── Migration: companion → trail-guide ──
  // 1. App data migration (config + workspace) handled in early init block above
  // 2. Rename workspace symlink in OpenClaw profile dir
  const oldSymlink = path.join(profileDir, 'workspace-companion');
  const newSymlink = path.join(profileDir, 'workspace-trail-guide');
  if (fs.existsSync(oldSymlink) && !fs.existsSync(newSymlink)) {
    try {
      // Remove old symlink and create new one pointing to the new workspace
      fs.unlinkSync(oldSymlink);
      fs.symlinkSync(workspacePath, newSymlink);
    } catch (e) { console.warn('[Migration] symlink:', e.message); }
  }
  // 3. Rename old agent sessions dir
  const oldSessions = path.join(profileDir, 'agents', 'companion');
  const newSessions = path.join(profileDir, 'agents', 'trail-guide');
  if (fs.existsSync(oldSessions) && !fs.existsSync(newSessions)) {
    try {
      fs.mkdirSync(path.join(profileDir, 'agents'), { recursive: true });
      fs.renameSync(oldSessions, newSessions);
    } catch (e) { console.warn('[Migration] sessions:', e.message); }
  }
  // 4. Update agentId + workspace paths in existing runtime config
  const runtimeConfigPath = path.join(profileDir, 'openclaw.json');
  if (fs.existsSync(runtimeConfigPath)) {
    try {
      let rc = fs.readFileSync(runtimeConfigPath, 'utf8');
      if (rc.includes('"companion"') || rc.includes('cotw-scout')) {
        rc = rc.replace(/"companion"/g, '"trail-guide"');
        rc = rc.replace(/cotw-scout\/workspace/g, 'cotw-scout/workspace');
        fs.writeFileSync(runtimeConfigPath, rc);
      }
    } catch (e) { console.warn('[Migration] config update:', e.message); }
  }
  // 5. Rename plugin data dirs (agents/companion → agents/trail-guide)
  const pluginDirs = getPluginDirs ? getPluginDirs() : [];
  for (const pd of pluginDirs) {
    const oldAgentDir = path.join(pd, 'data', 'agents', 'companion');
    const newAgentDir = path.join(pd, 'data', 'agents', 'trail-guide');
    if (fs.existsSync(oldAgentDir) && !fs.existsSync(newAgentDir)) {
      try { fs.renameSync(oldAgentDir, newAgentDir); } catch (e) { /* non-fatal */ }
    }
  }
  // ── End migration ──

  const openclawConfigSrc = isDev
    ? path.join(__dirname, 'openclaw.json')
    : path.join(resourcesPath, 'bundled-openclaw', 'openclaw.json');

  if (fs.existsSync(openclawConfigSrc)) {
    let ocConfig = fs.readFileSync(openclawConfigSrc, 'utf8');
    ocConfig = ocConfig.replace(/\{\{WORKSPACE_PATH\}\}/g, workspacePath);
    ocConfig = ocConfig.replace(/\{\{AGENT_NAME\}\}/g, config.agentName || 'Scout');
    ocConfig = ocConfig.replace(/\{\{GATEWAY_TOKEN\}\}/g, ensureGatewayToken());

    // Trust-circle bootstrap: operator identity for the synthetic-default
    // registry. Lowercase id (no spaces) is the slug the plugin uses; the
    // displayName is for human-readable logs. Falls back to "operator" if
    // the user hasn't set their name yet.
    const rawOperatorName = config.userName || 'Operator';
    const operatorId = String(rawOperatorName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'operator';
    ocConfig = ocConfig.replace(/\{\{OPERATOR_ID\}\}/g, operatorId);
    ocConfig = ocConfig.replace(/\{\{OPERATOR_DISPLAY_NAME\}\}/g, rawOperatorName);

    // Build plugin paths array
    const pluginPaths = getPluginDirs();
    ocConfig = ocConfig.replace(/\{\{PLUGIN_PATHS\}\}/g, JSON.stringify(pluginPaths, null, 6));

    // Preserve runtime state (channels, bindings) from existing config
    const runtimePath = path.join(profileDir, 'openclaw.json');
    if (fs.existsSync(runtimePath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
        const fresh = JSON.parse(ocConfig);
        // Channels and bindings are runtime state — don't overwrite
        if (existing.channels && Object.keys(existing.channels).length > 0) {
          fresh.channels = existing.channels;
        }
        if (existing.bindings && existing.bindings.length > 0) {
          fresh.bindings = existing.bindings;
        }
        // Preserve per-machine agent defaults (model choice, bootstrap budget, etc.)
        if (existing.agents?.defaults) {
          if (!fresh.agents) fresh.agents = {};
          fresh.agents.defaults = mergeRuntimeObject(
            fresh.agents.defaults || {},
            existing.agents.defaults
          );
        }
        // Preserve custom model/provider entries while still picking up bundled providers
        if (existing.models?.providers) {
          if (!fresh.models) fresh.models = {};
          fresh.models.providers = mergeModelProviders(
            fresh.models.providers || {},
            existing.models.providers
          );
        }
        // Preserve user plugin config (API keys, enabled state) — deep merge
        if (existing.plugins?.entries) {
          if (!fresh.plugins) fresh.plugins = {};
          if (!fresh.plugins.entries) fresh.plugins.entries = {};
          for (const [id, entry] of Object.entries(existing.plugins.entries)) {
            if (fresh.plugins.entries[id]) {
              // Merge: keep template structure, overlay user values
              const freshConfig = fresh.plugins.entries[id].config || {};
              const existConfig = entry.config || {};
              fresh.plugins.entries[id] = {
                ...fresh.plugins.entries[id],
                ...entry,
                config: { ...freshConfig, ...existConfig },
              };
            } else {
              // User-added plugin entry not in template — preserve entirely
              fresh.plugins.entries[id] = entry;
            }
          }
        }
        // Preserve tools config (e.g., search provider selection)
        if (existing.tools) {
          fresh.tools = existing.tools;
        }
        // Preserve message runtime config (TTS/channel speech settings, etc.)
        if (existing.messages) {
          fresh.messages = existing.messages;
        }
        // Preserve OpenClaw-managed runtime state that lives outside the
        // template's allowlist. Without this, OAuth credentials (auth.profiles)
        // and OpenClaw's version-tracking meta block get stripped on every
        // restart, which (a) loses runtime auth and (b) trips OpenClaw's
        // config-audit "missing-meta-vs-last-good" suspicion, causing a
        // restore-from-backup that reverts other legitimate runtime changes.
        if (existing.auth) fresh.auth = existing.auth;
        if (existing.meta) fresh.meta = existing.meta;
        // Always enforce update lockdown — OpenClaw must not self-update
        fresh.update = { checkOnStart: false, auto: { enabled: false } };
        ocConfig = JSON.stringify(fresh, null, 2);
      } catch { /* parse error — write fresh */ }
    }

    writeFileAtomic(runtimePath, ocConfig, { mode: 0o600 });
  }

  // Also create workspace dir for the trail guide agent
  const agentWorkspaceDir = path.join(profileDir, 'workspace-trail-guide');
  if (!fs.existsSync(agentWorkspaceDir)) {
    // Symlink to our workspace so OpenClaw finds it
    fs.symlinkSync(workspacePath, agentWorkspaceDir);
  }
}

// ============================================================
// OpenClaw Gateway
// ============================================================

const EXPECTED_OPENCLAW_VERSION = require('./package.json').dependencies?.openclaw || null;

function clearGatewayReconnectTimer() {
  if (gatewayReconnectTimer) {
    clearTimeout(gatewayReconnectTimer);
    gatewayReconnectTimer = null;
  }
}

function extractRestartContinuationText(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const payloads = parsed?.result?.payloads || parsed?.payloads || parsed?.result?.outputs || parsed?.outputs || [];
  if (Array.isArray(payloads)) {
    for (const payload of payloads) {
      const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
      if (text) return text;
    }
  }

  for (const candidate of [
    parsed?.result?.text,
    parsed?.result?.message,
    parsed?.text,
    parsed?.message,
    parsed?.content,
  ]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

function startRestartContinuationWatcher() {
  if (restartContinuationWatcherTimer) return;
  const resultPath = resolveRestartContinuationResultPath(openclawProfileDir);
  if (!restartContinuationResultMtimeInitialized) {
    try {
      lastRestartContinuationResultMtimeMs = fs.statSync(resultPath).mtimeMs;
    } catch {
      lastRestartContinuationResultMtimeMs = 0;
    }
    restartContinuationResultMtimeInitialized = true;
  }

  restartContinuationWatcherTimer = setInterval(() => {
    if (!mainWindow) return;
    let stat;
    try {
      stat = fs.statSync(resultPath);
    } catch {
      return;
    }
    if (stat.mtimeMs <= lastRestartContinuationResultMtimeMs) return;
    lastRestartContinuationResultMtimeMs = stat.mtimeMs;

    try {
      const text = extractRestartContinuationText(fs.readFileSync(resultPath, 'utf8'));
      if (!text) return;
      mainWindow.webContents.send('chat:message', {
        content: text,
        source: 'restart-continuation',
        timestamp: Date.now(),
      });
      sendStatus('gateway', 'Restart continuation delivered');
    } catch (err) {
      console.warn('[Gateway] failed to deliver restart continuation result:', err.message);
    }
  }, 2000);
  if (restartContinuationWatcherTimer.unref) restartContinuationWatcherTimer.unref();
}

function stopGatewayHealthMonitor() {
  if (gatewayHealthMonitorTimer) {
    clearInterval(gatewayHealthMonitorTimer);
    gatewayHealthMonitorTimer = null;
  }
  gatewayHealthCheckInProgress = false;
  gatewayHealthFailureCount = 0;
}

function startGatewayHealthMonitor() {
  if (gatewayHealthMonitorTimer) return;
  gatewayHealthMonitorTimer = setInterval(async () => {
    if (shuttingDown || !gatewayAttached || gatewayHealthCheckInProgress) return;
    gatewayHealthCheckInProgress = true;
    try {
      await httpGet(`http://localhost:${gatewayPort}/health`, 1500);
      gatewayHealthFailureCount = 0;
      lastGatewayHealthCheck = Date.now();
    } catch (err) {
      gatewayHealthFailureCount += 1;
      if (gatewayHealthFailureCount >= GATEWAY_ATTACHED_HEALTH_FAILURES_BEFORE_RECONNECT) {
        console.warn(`[Gateway] attached gateway health lost: ${err.code || err.message || err}`);
        gatewayAttached = false;
        stopGatewayHealthMonitor();
        if (!shuttingDown) {
          sendStatus('gateway', 'Gateway connection lost; reconnecting');
          scheduleGatewayReconnect('attached-health-monitor');
        }
      }
    } finally {
      gatewayHealthCheckInProgress = false;
    }
  }, GATEWAY_ATTACHED_HEALTH_INTERVAL_MS);
  if (gatewayHealthMonitorTimer.unref) gatewayHealthMonitorTimer.unref();
}

function markGatewayAttached(message = 'Attached to existing OpenClaw gateway') {
  gatewayAttached = true;
  gatewayReconnectAttempts = 0;
  gatewayHealthFailureCount = 0;
  clearGatewayReconnectTimer();
  lastGatewayHealthCheck = Date.now();
  sendStatus('gateway', message);
  startGatewayHealthMonitor();
  startRestartContinuationWatcher();
  startMorningArrivalWatcher();
  startContemplationWatcher();
  startAutoSync();
}

function scheduleGatewayReconnect(reason = 'gateway-exit') {
  if (shuttingDown || openclawProcess || gatewayAttached || gatewayReconnectTimer || gatewayReconnectInProgress) return;
  const delayMs = GATEWAY_RECONNECT_DELAYS_MS[Math.min(gatewayReconnectAttempts, GATEWAY_RECONNECT_DELAYS_MS.length - 1)];
  sendStatus('gateway', `Gateway unavailable; reconnecting in ${Math.round(delayMs / 1000)}s`);
  gatewayReconnectTimer = setTimeout(() => {
    gatewayReconnectTimer = null;
    attemptGatewayReconnect(reason).catch((err) => {
      console.error('[Gateway] reconnect attempt failed unexpectedly:', err.message);
    });
  }, delayMs);
  if (gatewayReconnectTimer.unref) gatewayReconnectTimer.unref();
}

async function attemptGatewayReconnect(reason = 'gateway-exit') {
  if (shuttingDown || openclawProcess || gatewayAttached || gatewayReconnectInProgress) return;
  gatewayReconnectInProgress = true;
  let retry = false;
  try {
    gatewayReconnectAttempts += 1;
    console.log(`[Gateway] reconnect attempt ${gatewayReconnectAttempts} after ${reason}`);
    await startGateway();
  } catch (err) {
    retry = true;
    const label = err.code || err.message || String(err);
    sendStatus('gateway-error', `Gateway reconnect attempt failed: ${label}`);
    console.warn(`[Gateway] reconnect attempt failed: ${label}`);
  } finally {
    gatewayReconnectInProgress = false;
  }
  if (retry) scheduleGatewayReconnect(reason);
}

async function startGateway() {
  if (openclawProcess || gatewayAttached) {
    sendStatus('gateway', 'Gateway already running');
    return;
  }

  gatewayPort = DEFAULT_GATEWAY_PORT;

  // Single-owner rule: if a managed OpenClaw gateway is already healthy on
  // the expected port (for example a LaunchAgent-owned service), Electron
  // attaches to it instead of spawning or killing another gateway. This keeps
  // service/autorestart mode from fighting the dev GUI for the same listener.
  try {
    await httpGet(`http://localhost:${gatewayPort}/health`, 1500);
    markGatewayAttached('Attached to existing OpenClaw gateway');
    return;
  } catch { /* no healthy managed gateway — Electron may own it unless a handoff is active */ }

  // During a controlled service handoff, Electron must not auto-spawn its own
  // gateway after the app-owned listener is released. The handoff latch lets
  // launchd take ownership without racing the UI reconnect path. Electron may
  // still attach above once the service-owned Gateway is healthy.
  if (isGatewayHandoffLatched(openclawProfileDir)) {
    sendStatus('gateway', 'Service handoff in progress; waiting for managed Gateway');
    const err = new Error('service_handoff_in_progress');
    err.code = 'service_handoff_in_progress';
    throw err;
  }

  // Do not opportunistically kill whatever is listening on the Gateway port.
  // In service/autorestart mode Electron's attachment state can be stale during
  // crash recovery; killing an "unhealthy" listener here can take down the
  // managed Gateway the user is relying on. Recovery should wait/reattach unless
  // the user explicitly asks for a force stop/restart through the service layer.
  let occupiedGatewayPids = '';
  try {
    occupiedGatewayPids = getPidsOnPort(gatewayPort);
  } catch { /* no process on port — clean start */ }
  if (occupiedGatewayPids) {
    const err = new Error('gateway_listener_unhealthy_or_not_ready');
    err.code = 'gateway_listener_unhealthy_or_not_ready';
    sendStatus('gateway', 'Gateway listener present but not healthy; waiting to reattach');
    throw err;
  }

  const binary = openclawBinary;

  // Verify openclaw entry point exists (binary is process.execPath, always valid)
  if (!fs.existsSync(openclawEntry)) {
    throw new Error(`OpenClaw entry point not found at ${openclawEntry}`);
  }

  sendStatus('gateway', 'Starting OpenClaw gateway...');

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',  // make process.execPath behave as plain Node (matches native-module ABI)
    OPENCLAW_WORKSPACE: workspacePath,
    OPENCLAW_PORT: String(gatewayPort),
    OPENCLAW_AGENT: config.agentName || 'trail-guide',
    OPENCLAW_RUNTIME_METRICS_PATH: path.join(app.getPath('userData'), 'runtime-metrics.jsonl'),
  };

  // Add plugin paths
  const pluginDirs = getPluginDirs();
  if (pluginDirs.length > 0) {
    env.OPENCLAW_PLUGINS = pluginDirs.join(process.platform === 'win32' ? ';' : ':');
  }

  // Use dedicated profile to isolate from any existing OpenClaw install
  // --profile is a top-level flag (before subcommand), --port is a gateway flag
  const args = ['--profile', 'cotw', 'gateway', '--port', String(gatewayPort)];

  // Ensure config is written before starting
  writeOpenClawConfig();

  // In production, spawn bundled Node with openclaw.mjs as first arg
  const spawnBin = binary;
  const spawnArgs = openclawEntry ? [openclawEntry, ...args] : args;

  openclawProcess = spawn(spawnBin, spawnArgs, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Persistent gateway log — rotates on startup, keeps last run
  const gatewayLogPath = path.join(app.getPath('userData'), 'gateway.log');
  const gatewayLogPrevPath = path.join(app.getPath('userData'), 'gateway.prev.log');
  try {
    if (fs.existsSync(gatewayLogPath)) {
      fs.renameSync(gatewayLogPath, gatewayLogPrevPath);
    }
  } catch { /* best effort */ }
  const gatewayLogStream = fs.createWriteStream(gatewayLogPath, { flags: 'a' });
  gatewayLogStream.write(`\n=== Gateway started ${new Date().toISOString()} ===\n`);
  const gatewayLogBatcher = createStatusBatcher('gateway-log', { flushMs: 250, maxLines: 30, maxChars: 12000 });
  const gatewayErrorBatcher = createStatusBatcher('gateway-error', { flushMs: 250, maxLines: 20, maxChars: 8000 });
  const gatewayLogVolume = createGatewayLogVolumeRecorder();

  openclawProcess.stdout.on('data', (data) => {
    const line = data.toString().trim();
    if (line) {
      gatewayLogBatcher.push(line);
      gatewayLogVolume.observe('stdout', data);
      gatewayLogStream.write(`[${new Date().toISOString()}] ${line}\n`);
    }
  });

  openclawProcess.stderr.on('data', (data) => {
    const line = data.toString().trim();
    if (line) {
      gatewayErrorBatcher.push(line);
      gatewayLogVolume.observe('stderr', data);
      gatewayLogStream.write(`[${new Date().toISOString()}] ERR: ${line}\n`);
    }
  });

  openclawProcess.on('close', (code) => {
    gatewayLogBatcher.flush();
    gatewayErrorBatcher.flush();
    gatewayLogVolume.stop();
    sendStatus('gateway', `Gateway exited with code ${code}; reconnecting`);
    gatewayLogStream.write(`[${new Date().toISOString()}] Gateway exited with code ${code}\n`);
    gatewayLogStream.end();
    openclawProcess = null;
    gatewayAttached = false;
    stopGatewayHealthMonitor();
    // Unexpected crash/restart (not during app shutdown) — signal resume to plugins on next message
    if (!shuttingDown) {
      if (conversationHistory.length > 0) {
        gatewayRestarted = true;
        console.log('[Gateway] Unexpected exit detected — will signal session resume on next message');
      }
      scheduleGatewayReconnect('process-close');
    }
  });

  // Wait for gateway to be ready
  await waitForGateway(15000);
  gatewayReconnectAttempts = 0;
  clearGatewayReconnectTimer();
  lastGatewayHealthCheck = Date.now();
  sendStatus('gateway', 'Gateway running');
  startRestartContinuationWatcher();

  // Cloudflare Tunnel — opt-in via config.tunnel.enabled. Non-fatal on failure:
  // the gateway runs locally regardless; only the iOS/remote path depends on this.
  if (config.tunnel?.enabled) {
    try {
      if (!tunnelController) {
        tunnelController = new TunnelController({
          userDataPath: app.getPath('userData'),
          isDev,
          resourcesPath,
          onStatus: (s) => sendStatus('tunnel', JSON.stringify(s)),
        });
      }
      const { hostname } = await tunnelController.start({
        port: gatewayPort,
        mode: config.tunnel.mode || 'quick',
      });
      config.tunnel = { ...config.tunnel, hostname };
      saveConfig();
      sendStatus('tunnel', `Tunnel ready: ${hostname}`);
    } catch (err) {
      sendStatus('tunnel-error', `Tunnel failed: ${err.message}`);
      console.error('[Tunnel] start failed:', err.message);
    }
  }

  // Check for updates after gateway restart (non-blocking)
  checkForUpdates().catch(() => {});

  // Start morning arrival watcher (checks for signal file from nightshift)
  startMorningArrivalWatcher();

  // Start contemplation watcher (checks for CONTEMPLATION_DUE.md from the
  // contemplation plugin when passes are due — fires /contemplation skill)
  startContemplationWatcher();

  // Start GitHub auto-sync (pull on startup, periodic sync)
  startAutoSync();
}

async function stopGateway() {
  // Stop the tunnel first. cloudflared will exit cleanly on SIGTERM even
  // without this, but we'd rather own the shutdown than rely on process reaping.
  if (tunnelController?.running) {
    try { await tunnelController.stop(); } catch (err) { console.error('[Tunnel] stop failed:', err.message); }
  }

  // If Electron attached to a managed service gateway, detach without killing
  // the service-owned listener. Service lifecycle is handled by launchd/CLI.
  if (gatewayAttached) {
    gatewayAttached = false;
    stopGatewayHealthMonitor();
    sendStatus('gateway', 'Gateway detached');
    return;
  }

  // Kill the CLI wrapper process if we have a handle. Only in that case do we
  // consider cleaning up a child listener that may have outlived the wrapper.
  // If Electron only has stale state and no process handle, leave the listener
  // alone; it may be a service-owned Gateway keeping the active conversation up.
  let hadOwnedGatewayProcess = false;
  if (openclawProcess) {
    hadOwnedGatewayProcess = true;
    const proc = openclawProcess;
    openclawProcess = null;
    proc.kill('SIGTERM');
    await new Promise(resolve => {
      const timeout = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 8000);
      proc.on('close', () => { clearTimeout(timeout); resolve(); });
    });
  }

  if (hadOwnedGatewayProcess) {
    // Also kill any gateway process on our port — the CLI spawns a child
    // process (openclaw-gateway) that can outlive the parent.
    try {
      const pidsOnPort = getPidsOnPort(gatewayPort);
      if (pidsOnPort) {
        for (const pid of pidsOnPort.split('\n').filter(p => p.trim())) {
          killPid(pid, 'SIGTERM');
        }
        // Brief wait for graceful shutdown
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch { /* no process on port — fine */ }
  } else {
    sendStatus('gateway', 'No app-owned Gateway process; leaving listener untouched');
  }

  sendStatus('gateway', 'Gateway stopped');
}

async function waitForGateway(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await httpGet(`http://localhost:${gatewayPort}/health`);
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error('Gateway failed to start within timeout');
}

// ============================================================
// Morning Arrival Watcher
// Polls for MORNING_ARRIVAL.md signal file written by the standing
// plugin's nightshift task. When found, sends the prompt through
// the gateway as a proactive agent message and displays it in chat.
// ============================================================

let morningArrivalTimer = null;

function startMorningArrivalWatcher() {
  if (morningArrivalTimer) return; // already running

  const POLL_INTERVAL = 60000; // check every 60 seconds

  morningArrivalTimer = setInterval(async () => {
    try {
      const signalPath = path.join(workspacePath, 'MORNING_ARRIVAL.md');
      if (!fs.existsSync(signalPath)) return;

      const prompt = fs.readFileSync(signalPath, 'utf8').trim();
      if (!prompt) return;

      console.log('[MorningArrival] Signal file detected — sending proactive morning message');

      // Delete the signal file before sending to prevent re-triggering
      fs.unlinkSync(signalPath);

      // Record that we sent an arrival today
      const arrivalStatePath = path.join(workspacePath, 'standing', 'morning_arrival_state.json');
      const today = new Date().toISOString().split('T')[0];
      writeJsonAtomic(arrivalStatePath, {
        lastSentDate: today,
        lastSentAt: new Date().toISOString()
      });

      try {
        recordReadOnlyResponsibilityLease({
          leaseId: `responsibility-lease:morning-arrival:${today}`,
          lane: 'morning_arrival',
          trigger: 'MORNING_ARRIVAL.md',
          sourceHandle: 'MORNING_ARRIVAL.md',
          objective: 'Deliver one proactive morning arrival message from an existing nightshift signal',
          successCriteria: ['send at most one arrival for the day', 'record delivery outcome separately'],
          budgets: { reviewOnly: true, maxMessages: 1 }
        });
      } catch (err) {
        console.warn('[Spine] Failed to record morning arrival responsibility lease:', err.message);
      }

      // Notify renderer to show streaming dots (proactive message incoming)
      mainWindow?.webContents.send('chat:proactive-start', { source: 'morning-arrival' });

      // Send through the gateway — the response streams via chat:stream-chunk
      const response = await callGatewayHTTP(prompt, {
        hideUserFromHistory: true,
        metadata: { synthetic_source: 'morning_arrival' },
      });
      console.log('[MorningArrival] Morning message delivered');
    } catch (err) {
      console.error('[MorningArrival] Error:', err.message);
    }
  }, POLL_INTERVAL);

  // Don't let the timer prevent app exit
  if (morningArrivalTimer.unref) morningArrivalTimer.unref();
  console.log('[MorningArrival] Watcher started (polling every 60s)');
}

function stopMorningArrivalWatcher() {
  if (morningArrivalTimer) {
    clearInterval(morningArrivalTimer);
    morningArrivalTimer = null;
  }
}

// ============================================================
// Contemplation Watcher
// Polls for CONTEMPLATION_DUE.md signal file written by the
// contemplation plugin's nightshift task runner when reflection
// passes are due. When found, sends the prompt through the
// gateway as a proactive agent message — Ellis invokes the
// /contemplation skill to process due passes using his own LLM.
// Mirrors the morning-arrival watcher pattern.
//
// Rate-limiting lives in the plugin (30 min cooldown + signal-
// pending guard). This watcher is a pure file → gateway bridge.
// ============================================================

let contemplationTimer = null;

function startContemplationWatcher() {
  if (contemplationTimer) return; // already running

  const POLL_INTERVAL = 60000; // 60s, same cadence as morning arrival

  contemplationTimer = setInterval(async () => {
    try {
      const signalPath = path.join(workspacePath, 'CONTEMPLATION_DUE.md');
      if (!fs.existsSync(signalPath)) return;

      const prompt = fs.readFileSync(signalPath, 'utf8').trim();
      if (!prompt) return;

      console.log('[Contemplation] Signal file detected — dispatching isolated run');

      // Delete the signal before sending so a retry cycle can't double-fire.
      // The plugin's 30-min cooldown prevents immediate re-signaling.
      fs.unlinkSync(signalPath);

      try {
        recordReadOnlyResponsibilityLease({
          leaseId: `responsibility-lease:contemplation:${Date.now()}`,
          lane: 'contemplation',
          trigger: 'CONTEMPLATION_DUE.md',
          sourceHandle: 'CONTEMPLATION_DUE.md',
          objective: 'Run due contemplation passes in an isolated thread from an existing signal',
          successCriteria: ['use isolated thread', 'keep main chat history untouched', 'do not grant scheduler or prompt-context authority'],
          budgets: { reviewOnly: true, isolated: true }
        });
      } catch (err) {
        console.warn('[Spine] Failed to record contemplation responsibility lease:', err.message);
      }

      // Isolated run — Phase C. Contemplation passes execute via Ellis's
      // primary LLM but in a dedicated thread with no main-chat visibility:
      //   - No chat:proactive-start event, so no arrival dots in the UI
      //   - Skips chat:stream-chunk / tool-call / stream-done IPC
      //   - Doesn't push to conversationHistory — main chat unaffected
      //   - Uses its own thread_id ("isolated-contemplation-{ts}") so
      //     continuity plugin archives it separately from main chat
      const response = await callGatewayHTTP(prompt, {
        isolated: true,
        isolationTag: 'contemplation'
      });
      console.log(`[Contemplation] Isolated pass-run complete (${response?.length || 0} chars, silent)`);
    } catch (err) {
      console.error('[Contemplation] Error:', err.message);
    }
  }, POLL_INTERVAL);

  if (contemplationTimer.unref) contemplationTimer.unref();
  console.log('[Contemplation] Watcher started (polling every 60s)');
}

function stopContemplationWatcher() {
  if (contemplationTimer) {
    clearInterval(contemplationTimer);
    contemplationTimer = null;
  }
}

function getPluginDirs() {
  const dirs = [];
  const pluginNames = [
    // evidence-quality is a refuse-and-log gate consumed by graph,
    // contemplation, standing, crystallization. Loading it first means
    // those plugins find it available when they wire up their gates.
    'openclaw-plugin-evidence-quality',
    // trust-circle resolves the inbound speaker before continuity archives
    // the exchange. Load it before continuity for the same reason.
    'openclaw-plugin-trust-circle',
    'openclaw-plugin-continuity',
    'openclaw-plugin-stability',
    'openclaw-plugin-metabolism',
    'openclaw-plugin-contemplation',
    'openclaw-plugin-crystallization',
    'openclaw-plugin-nightshift',
    'openclaw-plugin-standing',
    'openclaw-plugin-graph',
    'openclaw-plugin-research-graph',
    'openclaw-plugin-cognitive-dynamics',
    'openclaw-plugin-embodiment',
    'openclaw-plugin-telemetry',
    'openclaw-plugin-planmode',
    'openclaw-plugin-truth',
    'openclaw-plugin-epistemic-proof-loop',
    'openclaw-plugin-tool-provenance',
    'openclaw-plugin-threads',
    'openclaw-plugin-code-evolution',
    'openclaw-plugin-harness-refiner',
  ];

  for (const name of pluginNames) {
    const dir = path.join(pluginsPath, name);
    if (fs.existsSync(dir)) {
      dirs.push(dir);
    }
  }
  return dirs;
}

ipcMain.handle('openclaw:start', async () => {
  try {
    await startGateway();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.code || err.message };
  }
});

ipcMain.handle('openclaw:stop', async () => {
  await stopGateway();
  return { success: true };
});

ipcMain.handle('openclaw:status', () => {
  return {
    running: openclawProcess !== null || gatewayAttached,
    attached: gatewayAttached,
    handoffLatched: isGatewayHandoffLatched(openclawProfileDir),
    port: gatewayPort,
    agentName: config.agentName,
  };
});

ipcMain.handle('openclaw:continuity-compaction-health', () => {
  try {
    return {
      ok: true,
      readOnly: true,
      report: buildContinuityHealthReport({
        openclawHome: openclawProfileDir,
        agentId: config.agentName || 'trail-guide',
        sessionKey: gatewaySessionKeyFor(currentSessionId),
      })
    };
  } catch (err) {
    return { ok: false, readOnly: true, error: String(err.message || err) };
  }
});

ipcMain.handle('openclaw:runtime-load-report', () => {
  try {
    const metricsPath = path.join(app.getPath('userData'), 'runtime-metrics.jsonl');
    return {
      ok: true,
      readOnly: true,
      report: buildRuntimeLoadReport({ metricsPath })
    };
  } catch (err) {
    return { ok: false, readOnly: true, error: String(err.message || err) };
  }
});

ipcMain.handle('canvas:get-embed-document', async (_event, ref) => {
  try {
    const safeRef = String(ref || '').trim();
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(safeRef)) return { ok: false, error: 'invalid_embed_ref' };
    const canvasRoot = path.join(require('os').homedir(), '.openclaw-cotw', 'canvas', 'documents');
    const documentPath = path.resolve(canvasRoot, safeRef, 'index.html');
    const allowedRoot = path.resolve(canvasRoot) + path.sep;
    if (!documentPath.startsWith(allowedRoot)) return { ok: false, error: 'invalid_embed_path' };
    if (!fs.existsSync(documentPath)) return { ok: false, error: 'embed_not_found' };
    const stat = fs.statSync(documentPath);
    if (stat.size > 1024 * 1024) return { ok: false, error: 'embed_too_large' };
    return { ok: true, ref: safeRef, html: fs.readFileSync(documentPath, 'utf8') };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// ============================================================
// Session Mode
// ============================================================

ipcMain.handle('session:get-mode', () => {
  return {
    mode: currentSessionMode,
    sessionId: currentSessionId,
    threadId: currentThreadId,
    messageCount: currentSessionMessageCount,
    trainingGroundsActive,
    boothModeActive,
    embodimentModeActive,
    projectSlug: currentSessionProjectId || null,
    projectName: config.currentSessionProjectName || null,
  };
});

// Chat Relay
// ============================================================

ipcMain.handle('chat:get-history', async () => {
  try {
    // Priority 0: Restore from conversation checkpoint (survives app crash)
    if (conversationHistory.length === 0) {
      try {
        if (fs.existsSync(checkpointPath)) {
          const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
          const ageMs = Date.now() - checkpoint.timestamp;
          if (ageMs < 3600000 && checkpoint.sessionId === currentSessionId) {
            if (checkpointHistoryHasUnsafeContent(checkpoint.history)) {
              console.warn('[Checkpoint] Refusing to restore unsafe checkpoint history; deleting checkpoint');
              try { fs.unlinkSync(checkpointPath); } catch {}
              return [];
            }
            conversationHistory = sanitizeCheckpointHistory(checkpoint.history);
            console.log(`[Checkpoint] Restored ${conversationHistory.length} messages from checkpoint (${Math.round(ageMs / 1000)}s old)`);
            return conversationHistory;
          }
        }
      } catch (err) {
        console.warn('[Checkpoint] Failed to read:', err.message);
      }
    }

    const profileDir = path.join(require('os').homedir(), '.openclaw-cotw');
    const sessionsDir = path.join(profileDir, 'agents', 'trail-guide', 'sessions');

    // Priority 1: Use the JSONL file from the current session (stored in config).
    // This prevents loading stale history from old sessions after gateway restarts.
    let sessionFile = null;
    if (config.currentSessionJsonlFile) {
      const candidate = path.join(sessionsDir, config.currentSessionJsonlFile);
      if (fs.existsSync(candidate)) {
        const stat = fs.statSync(candidate);
        // Only use it if it has real content (not just a new empty file)
        if (stat.size > 100) sessionFile = candidate;
      }
    }

    // Priority 2: Find the most recently modified .jsonl with real user content
    // Freshly rotated sessions intentionally start empty. If there is no
    // session file recorded yet, do not "helpfully" reload the previous JSONL.
    if (!sessionFile && !config.currentSessionJsonlFile && currentSessionMessageCount === 0) {
      return [];
    }

    // Priority 3: Legacy fallback for older configs that predate JSONL tracking.
    if (!sessionFile) {
      const jsonlFiles = fs.readdirSync(sessionsDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const filePath = path.join(sessionsDir, f);
          return {
            name: f,
            path: filePath,
            mtime: fs.statSync(filePath).mtimeMs,
            size: fs.statSync(filePath).size,
          };
        })
        .sort((a, b) => b.mtime - a.mtime);

      if (jsonlFiles.length === 0) return [];

      // Pick the most recent file that has real content
      sessionFile = jsonlFiles[0].path;
      for (const f of jsonlFiles) {
        const sample = fs.readFileSync(f.path, 'utf8');
        if (!sample.includes('HEARTBEAT_OK') || sample.length > 5000) {
          sessionFile = f.path;
          break;
        }
      }
    }
    const lines = fs.readFileSync(sessionFile, 'utf8').trim().split('\n');
    const messages = [];

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type !== 'message') continue;

        const msg = event.message;
        if (!msg || !msg.role) continue;

        // Only show user and assistant text messages
        if (msg.role !== 'user' && msg.role !== 'assistant') continue;

        // Extract text content from the content array or string
        let text = '';
        if (typeof msg.content === 'string') {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          text = msg.content
            .filter(c => c.type === 'text')
            .map(c => c.text)
            .join('\n');
        }

        if (msg.role === 'user') {
          text = extractVisibleUserText(text);
        } else if (msg.role === 'assistant') {
          text = stripAssistantDirectiveTags(text);
        }

        // Filter out system context blocks and heartbeat responses
        if (text.includes('[CONTINUITY CONTEXT]') || text.includes('[YOUR WORKING MEMORY]')
            || text.includes('[STABILITY CONTEXT]') || text.includes('[YOUR COHERENCE]')
            || text.includes('[Chat messages since') || text.includes('This is your context. Use it directly')
            || text.includes('[SESSION HANDOFF') || text.includes('[WHAT YOU REMEMBER FROM LAST SESSION]')
            || text.includes('[PROJECT CONTEXT') || text.includes('[NIGHTSHIFT REPORT')
            || text.includes('[WHAT YOU THOUGHT ABOUT OVERNIGHT]')
            || isSyntheticHistoryContent(text)
            || text.trim() === 'HEARTBEAT_OK') {
          continue;
        }

        if (text.trim()) {
          const timestamp = typeof msg.timestamp === 'number'
            ? msg.timestamp
            : (event.timestamp ? new Date(event.timestamp).getTime() : null);
          const entry = { role: msg.role, content: text.substring(0, 3000), timestamp };
          // Propagate channel metadata (e.g. 'telegram', 'electron') if present
          const channel = msg.channel || event.channel || event.meta?.channel;
          if (channel) entry.channel = channel;
          messages.push(entry);
        }
      } catch { /* skip malformed lines */ }
    }
    const visibleMessages = dedupeHistoryMessages(messages);

    // Restore in-memory conversation history only if it's empty (startup).
    // During a live session, don't clobber — the gateway manages the active context.
    if (conversationHistory.length === 0) {
      conversationHistory = visibleMessages.slice(-MAX_HISTORY_TURNS);
    }

    return visibleMessages;
  } catch (err) {
    console.error('Failed to load session history:', err.message);
    return [];
  }
});

ipcMain.handle('chat:last-activity', async () => {
  try {
    const profileDir = path.join(require('os').homedir(), '.openclaw-cotw');
    const sessionsDir = path.join(profileDir, 'agents', 'trail-guide', 'sessions');
    const files = fs.readdirSync(sessionsDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ path: path.join(sessionsDir, f), mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return null;
    return files[0].mtime;
  } catch { return null; }
});

ipcMain.handle('chat:send', async (_event, messageOrObj) => {
  try {
    let text, image, attachments;
    if (typeof messageOrObj === 'string') {
      text = messageOrObj;
    } else {
      text = messageOrObj?.text;
      image = messageOrObj?.image; // Legacy single-image payload: { base64, mimeType }
      attachments = messageOrObj?.attachments;
    }
    const rawUserText = text;
    const incomingAttachments = normalizeChatAttachments([
      ...(Array.isArray(attachments) ? attachments : []),
      ...(image ? [{ ...image, kind: 'image' }] : []),
    ]);
    const attachmentTurnId = incomingAttachments.length
      ? `turn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      : null;
    const attachmentReceipts = incomingAttachments.length
      ? createAttachmentReceipts({
          db: getContinuityDB(),
          attachments: incomingAttachments,
          threadId: currentThreadId,
          sessionId: currentSessionId,
          projectId: currentSessionProjectId,
          turnId: attachmentTurnId,
        })
      : [];

    // Pre-flight health check — skip if checked within last 60s (gateway was fine recently)
    if (Date.now() - lastGatewayHealthCheck > 60000) {
      let healthOk = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await httpGet(`http://localhost:${gatewayPort}/health`);
          healthOk = true;
          if (!openclawProcess && !gatewayAttached) {
            markGatewayAttached('Reattached to existing OpenClaw gateway');
          } else {
            lastGatewayHealthCheck = Date.now();
          }
          break;
        } catch {
          if (attempt < 4) await new Promise(r => setTimeout(r, 3000));
        }
      }
      if (!healthOk) {
        gatewayAttached = false;
        scheduleGatewayReconnect('chat-health-check');
        return { error: 'gateway_unavailable' };
      }
    }

    // Startup reorientation — clears any stale mode posture from previous session's gateway history
    if (needStartupReorientation && !embodimentModeActive && !boothModeActive && !trainingGroundsActive) {
      needStartupReorientation = false;
      text = '[SESSION START — FRESH CONTEXT] The app has just launched. Ignore any previous mode context (Training Grounds, Booth, Embodiment) from earlier in this conversation history — those sessions have ended. You are in normal trail conversation. Respond naturally as the trail guide. No [TRAINING_OPTIONS] blocks, no Booth leadership stance, no embodiment narration.\n\n' + text;
    } else if (needStartupReorientation) {
      // User entered a mode before sending a chat message — clear the flag without injecting
      needStartupReorientation = false;
    }

    // Mode exit reorientation — clears previous mode posture on first message back in normal chat
    if (needModeExitReorientation && !embodimentModeActive && !boothModeActive && !trainingGroundsActive) {
      const exitedMode = needModeExitReorientation;
      needModeExitReorientation = null;
      text = `[MODE EXIT: ${exitedMode}] You have left ${exitedMode} mode and returned to normal trail conversation. Drop any previous mode posture, voice rules, or response format requirements (no [TRAINING_OPTIONS] blocks, no Booth leadership stance, no embodiment narration). Respond naturally as the trail guide.\n\n` + text;
    }

    // Interrupted tool call context — inject note about previously interrupted tools
    if (config.interruptedToolCalls && config.interruptedToolCalls.length > 0) {
      const tools = config.interruptedToolCalls;
      const toolNames = tools.map(tc => tc.name).join(', ');
      text = `[Note: Previous tool call(s) were interrupted: ${toolNames}. They may not have completed successfully. Verify state before continuing.]\n\n` + text;
      config.interruptedToolCalls = null;
      try { saveConfig(); } catch {}
    }

    // Track which injections were applied — clear flags only after successful response
    let _injectedEmbodiment = false, _injectedBooth = false, _injectedTraining = false;

    // Embodiment context injection on first message after entering mode
    if (embodimentModeActive && embodimentNeedInjection) {
      _injectedEmbodiment = true;
      let injection = '[EMBODIMENT SESSION START]\nYou are now inhabiting your body. Read your embodiment skill for guidance.\n';
      injection += `Curiosity toggle: ${config.curiosityEnabled ? 'on — use body_pilot_tick for small observe/try/reflect ticks when idle or investigating.' : 'off — wait for user direction before initiating curious pilot ticks.'}\n`;

      // Append handoff if exists
      const handoffPath = path.join(workspacePath, 'EMBODIMENT_HANDOFF.md');
      try {
        if (fs.existsSync(handoffPath)) {
          injection += '\nPrevious session handoff:\n' + fs.readFileSync(handoffPath, 'utf8') + '\n';
        }
      } catch { /* no handoff */ }

      // Append recent notebook
      const notebookPath = path.join(workspacePath, 'EMBODIMENT_NOTEBOOK.md');
      try {
        if (fs.existsSync(notebookPath)) {
          const full = fs.readFileSync(notebookPath, 'utf8');
          const lines = full.split('\n').slice(-20);
          if (lines.some(l => l.trim() && !l.startsWith('#') && !l.startsWith('<!--'))) {
            injection += '\nRecent notebook entries:\n' + lines.join('\n') + '\n';
          }
        }
      } catch { /* no notebook */ }

      injection += '[/EMBODIMENT SESSION START]\n\n';
      text = injection + text;
    }

    // Booth context injection
    if (boothModeActive) {
      if (boothNeedInjection) {
        _injectedBooth = true;
        let injection = '[BOOTH SESSION]\n';

        // Load booth identity docs
        const soulBoothPath = path.join(workspacePath, 'booth', 'SOUL-BOOTH.md');
        const agentsBoothPath = path.join(workspacePath, 'booth', 'AGENTS-BOOTH.md');
        try {
          if (fs.existsSync(soulBoothPath)) {
            injection += fs.readFileSync(soulBoothPath, 'utf8') + '\n\n';
          }
        } catch { /* missing */ }
        try {
          if (fs.existsSync(agentsBoothPath)) {
            injection += fs.readFileSync(agentsBoothPath, 'utf8') + '\n\n';
          }
        } catch { /* missing */ }

        // Inject ANCHOR.md (who this person is)
        const anchorPath = path.join(workspacePath, 'ANCHOR.md');
        try {
          if (fs.existsSync(anchorPath)) {
            const anchor = fs.readFileSync(anchorPath, 'utf8');
            injection += '[WHO THEY ARE]\n' + anchor.slice(0, 1000) + '\n\n';
          }
        } catch { /* missing */ }

        // Inject standing scores
        const standingPath = path.join(workspacePath, 'standing', 'standing.json');
        try {
          if (fs.existsSync(standingPath)) {
            const standing = JSON.parse(fs.readFileSync(standingPath, 'utf8'));
            injection += '[CURRENT STANDING]\n' + JSON.stringify(standing, null, 2) + '\n\n';
          }
        } catch { /* missing or invalid */ }

        // Inject recent journal entries (last 3 days)
        const memoryDir = path.join(workspacePath, 'memory');
        try {
          if (fs.existsSync(memoryDir)) {
            const today = new Date();
            const entries = [];
            for (let i = 0; i < 3; i++) {
              const d = new Date(today);
              d.setDate(d.getDate() - i);
              const dateStr = d.toISOString().split('T')[0];
              const journalPath = path.join(memoryDir, `${dateStr}.md`);
              if (fs.existsSync(journalPath)) {
                const content = fs.readFileSync(journalPath, 'utf8');
                entries.push(content.slice(0, 500));
              }
            }
            if (entries.length > 0) {
              injection += '[RECENT JOURNAL]\n' + entries.join('\n---\n') + '\n\n';
            }
          }
        } catch { /* missing */ }

        // Inject recent contemplation insights
        try {
          const contDir = path.join(path.dirname(workspacePath), 'data', 'trail-guide', 'openclaw-plugin-contemplation');
          if (fs.existsSync(contDir)) {
            const files = fs.readdirSync(contDir)
              .filter(f => f.endsWith('.json'))
              .sort()
              .slice(-3);
            const insights = [];
            for (const f of files) {
              try {
                const data = JSON.parse(fs.readFileSync(path.join(contDir, f), 'utf8'));
                if (data.synthesis) insights.push(data.synthesis.slice(0, 300));
                else if (data.settling) insights.push(data.settling.slice(0, 300));
              } catch { /* skip */ }
            }
            if (insights.length > 0) {
              injection += '[RECENT CONTEMPLATION]\n' + insights.join('\n---\n') + '\n\n';
            }
          }
        } catch { /* missing */ }

        injection += '[/BOOTH SESSION]\n\n';
        text = injection + text;
      } else if (boothMessageCount > 0 && boothMessageCount % 5 === 0) {
        // Periodic posture reinforcement
        text = '[BOOTH CONTEXT: You are in The Booth. Lead. No utility. Socratic posture.]\n\n' + text;
      }
      boothMessageCount++;
    }

    // Training Grounds / Code mode context injection
    if (trainingGroundsActive) {
      // Read progress to check lessonsEnabled
      let lessonsEnabled = true;
      const progressPath = path.join(workspacePath, 'training-grounds', 'progress.json');
      let progressData = null;
      try {
        if (fs.existsSync(progressPath)) {
          progressData = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
          lessonsEnabled = progressData.lessonsEnabled !== false;
        }
      } catch { /* use defaults */ }

      if (trainingGroundsNeedInjection) {
        _injectedTraining = true;

        if (lessonsEnabled) {
          // Full lesson injection — identity + progress + spine + continuity
          let injection = '[TRAINING GROUNDS SESSION — Lessons enabled]\n';

          const tgIdentity = path.join(workspacePath, 'training-grounds', 'TRAINING-GROUNDS.md');
          try { if (fs.existsSync(tgIdentity)) injection += fs.readFileSync(tgIdentity, 'utf8') + '\n\n'; } catch {}

          if (progressData) {
            injection += '[CURRENT PROGRESS]\n' + JSON.stringify(progressData, null, 2) + '\n\n';
          }

          const spinePath = path.join(workspacePath, 'training-grounds', 'SPINE-WEEK-1.md');
          try { if (fs.existsSync(spinePath)) injection += '[LESSON PLAN]\n' + fs.readFileSync(spinePath, 'utf8') + '\n\n'; } catch {}

          const continuityContext = getRecentUserContext(currentSessionMode);
          if (continuityContext) {
            injection += '[WHAT THEY HAVE BEEN WORKING ON — for personalization, do not quote directly]\n' + continuityContext + '\n\n';
          }

          const anchorPath = path.join(workspacePath, 'ANCHOR.md');
          try { if (fs.existsSync(anchorPath)) injection += '[WHO THEY ARE]\n' + fs.readFileSync(anchorPath, 'utf8').slice(0, 800) + '\n\n'; } catch {}

          injection += '[/TRAINING GROUNDS SESSION]\n\n';
          text = injection + text;
        } else {
          // Freeform Code mode — lighter injection, no spine, no TRAINING_OPTIONS requirement
          let injection = '[CODE SESSION — Lessons off]\n';
          injection += 'You are in Code mode. Help the user build things directly. Use the Trail Ride protocol within your normal voice — keep the firelight cadence, just applied to building. No lesson structure. No [TRAINING_OPTIONS] blocks unless the user asks for suggestions.\n\n';

          const continuityContext = getRecentUserContext(currentSessionMode);
          if (continuityContext) {
            injection += '[WHAT THEY HAVE BEEN WORKING ON]\n' + continuityContext + '\n\n';
          }

          const anchorPath = path.join(workspacePath, 'ANCHOR.md');
          try { if (fs.existsSync(anchorPath)) injection += '[WHO THEY ARE]\n' + fs.readFileSync(anchorPath, 'utf8').slice(0, 800) + '\n\n'; } catch {}

          injection += '[/CODE SESSION]\n\n';
          text = injection + text;
        }
      } else if (trainingGroundsMessageCount > 0 && trainingGroundsMessageCount % 5 === 0) {
        if (lessonsEnabled) {
          text = '[TRAINING GROUNDS CONTEXT: You are in the Training Grounds. Trail companion posture. Follow the Trail Ride protocol. Every response MUST end with [TRAINING_OPTIONS] block containing 2-3 next steps.]\n\n' + text;
        } else {
          text = '[CODE SESSION CONTEXT: You are in Code mode. Help directly. No lesson structure needed.]\n\n' + text;
        }
      }
      trainingGroundsMessageCount++;
    }

    const receiptContext = buildAttachmentReceiptContext(attachmentReceipts);
    const recentReceiptContext = buildRecentAttachmentReceiptContext(getContinuityDB(), {
      threadId: currentThreadId,
      excludeIds: attachmentReceipts.map(receipt => receipt.id),
      limit: 6,
    });
    if (receiptContext || recentReceiptContext) {
      const userText = String(text || '').trim();
      text = [receiptContext, recentReceiptContext, userText].filter(Boolean).join('\n\n');
    }

    const documentContext = buildDocumentAttachmentContext(incomingAttachments);
    if (documentContext) {
      const userText = String(text || '').trim();
      text = userText ? `${documentContext}\n\n${userText}` : documentContext;
    }

    const attachedImages = incomingAttachments.filter(attachment => attachment.kind === 'image');
    let gatewayImages = attachedImages;
    if (attachedImages?.length) {
      try {
        const preparedImageInput = await prepareGatewayImageInput(text, attachedImages);
        text = preparedImageInput.message;
        gatewayImages = preparedImageInput.images;
      } catch (visionErr) {
        console.error('[Vision] Error processing image:', visionErr.message);
        text = `[Image attached but vision processing failed: ${visionErr.message}]\n\n${text}`;
        gatewayImages = undefined;
      }
    }

    const proactiveRolloverReason = getProactiveRolloverReason(text);
    if (proactiveRolloverReason) {
      await performSessionRollover({ reason: proactiveRolloverReason, keepThread: true });
    }

    // Call gateway with retry on connection errors (not user aborts or HTTP errors)
    let response;
    let lastError;
    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        response = await callGatewayHTTP(text, {
          images: gatewayImages,
          originalUserText: rawUserText,
          imageCount: attachedImages ? attachedImages.length : 0,
          attachmentCount: incomingAttachments.length,
          attachmentReceiptIds: attachmentReceipts.map(receipt => receipt.id),
        });
        consecutiveMainStreamFailures = 0;
        // Clear injection flags only after successful response
        if (_injectedEmbodiment) embodimentNeedInjection = false;
        if (_injectedBooth) boothNeedInjection = false;
        if (_injectedTraining) trainingGroundsNeedInjection = false;
        break; // success
      } catch (err) {
        lastError = err;
        const rawMsg = String(err.message || err);
        const msg = rawMsg.toLowerCase();
        const isContextOverflow = isContextOverflowSignal(rawMsg) || err.code === 'CONTEXT_OVERFLOW';
        const isRetryable = isContextOverflow
          || msg.includes('econnreset') || msg.includes('econnrefused')
          || msg.includes('timed out') || msg.includes('socket hang up')
          || msg.includes('connection reset by peer')
          || msg.includes('stream ended without a final response')
          || msg.includes('ended before a final response marker')
          || msg.includes('empty final response');
        const isUserAbort = msg.includes('aborted by user');
        if (isRetryable && !isUserAbort) consecutiveMainStreamFailures++;

        if (!isRetryable || isUserAbort) throw err;

        if (isContextOverflow || consecutiveMainStreamFailures >= STREAM_FAILURE_ROLLOVER_THRESHOLD) {
          const reason = isContextOverflow
            ? 'context-overflow'
            : `repeated-stream-failures:${consecutiveMainStreamFailures}`;
          await performSessionRollover({ reason, keepThread: true });
        }

        if (attempt >= MAX_RETRIES) throw err;

        // Notify renderer of retry attempt
        const retryDelay = Math.pow(3, attempt + 1) * 1000; // 3s, 9s
        mainWindow?.webContents.send('chat:stream-retry', { attempt: attempt + 1, maxRetries: MAX_RETRIES, delay: retryDelay });
        console.log(`[chat:send] Retry ${attempt + 1}/${MAX_RETRIES} after ${retryDelay}ms — ${rawMsg}`);

        // Check gateway health before retrying
        await delay(retryDelay);
        try {
          await httpGet(`http://localhost:${gatewayPort}/health`);
        } catch {
          // Gateway still down — throw original error
          throw lastError;
        }
      }
    }

    if (isForegroundCompletionFallbackText(response)) {
      mainWindow?.webContents.send('chat:auto-continuation-start', {
        reason: 'completion_obligation_fallback',
      });
      try {
        const continuationPrompt = buildVisibleToolFallbackContinuationPrompt({
          originalTask: rawUserText,
          fallbackText: response,
        });
        const continued = await callGatewayHTTP(continuationPrompt, {
          hideUserFromHistory: true,
          disableEvidenceRecovery: true,
          originalUserText: rawUserText,
          metadata: {
            synthetic_source: 'visible_tool_fallback_continuation',
          },
        });
        if (continued && !isForegroundCompletionFallbackText(continued)) {
          response = continued;
        }
      } catch (continuationErr) {
        logStreamDebug('visible-tool-fallback-continuation-error', {
          error: continuationErr.message,
        });
        emitChatActivity({
          phase: 'visible-tool-fallback-continuation-error',
          error: continuationErr.message,
        });
      }
    }

    return { response };
  } catch (err) {
    const msg = String(err.message || err);
    if (msg.includes('429')) return { error: 'rate_limited' };
    if (msg.includes('timed out') || msg.includes('timeout')) return { error: 'timeout' };
    if (msg.includes('ECONNREFUSED')) return { error: 'Gateway is not running. Click the refresh button to restart.' };
    return { error: msg };
  }
});

// ============================================================
// Sidebar Data — reads live workspace state
// ============================================================

ipcMain.handle('sidebar:standing', async () => {
  try {
    const standingPath = path.join(workspacePath, 'standing', 'standing.json');
    if (!fs.existsSync(standingPath)) return null;
    const raw = JSON.parse(fs.readFileSync(standingPath, 'utf8'));
    // Normalize: standing plugin stores scores in nested dimensions object,
    // but GUI expects flat keys (courage_self, word, brand, etc.)
    if (raw.dimensions) {
      const flat = {};
      for (const [key, dim] of Object.entries(raw.dimensions)) {
        flat[key] = dim.score ?? dim;
        if (dim.growth_edge) flat[key + '_note'] = dim.growth_edge;
        if (dim.trajectory) flat[key + '_trajectory'] = dim.trajectory;
        if (dim.delta !== undefined) flat[key + '_delta'] = dim.delta;
      }
      flat.synthesized_at = raw.synthesized_at;
      return flat;
    }
    return raw;
  } catch { return null; }
});

ipcMain.handle('sidebar:standing-evidence', async (_event, dimension) => {
  try {
    const results = [];

    // Primary source: synthesis history (rich per-dimension evidence from nightshift)
    const synthDir = path.join(workspacePath, 'standing', 'synthesis_history');
    if (fs.existsSync(synthDir)) {
      const files = fs.readdirSync(synthDir)
        .filter(f => f.endsWith('.json'))
        .sort()
        .reverse()
        .slice(0, 10); // Last 10 synthesis runs
      for (const file of files) {
        try {
          const synth = JSON.parse(fs.readFileSync(path.join(synthDir, file), 'utf8'));
          const dim = synth.dimensions?.[dimension];
          if (dim && dim.key_evidence?.length) {
            const date = file.replace('.json', '');
            for (const ev of dim.key_evidence) {
              // Skip filler entries that say "no evidence" — only show real observations
              const lower = ev.toLowerCase();
              if (lower.includes('no evidence') || lower.includes('no direct evidence') ||
                  lower.includes('no new evidence') || lower.includes('baseline maintained')) continue;
              results.push({
                date,
                dimension,
                direction: dim.delta > 0 ? '+' : dim.delta < 0 ? '-' : '=',
                score: dim.score,
                delta: dim.delta,
                trajectory: dim.trajectory,
                context: ev,
                source: 'synthesis'
              });
            }
            // If we filtered everything out but there's a growth_edge, show that
            if (results.filter(r => r.date === date).length === 0 && dim.growth_edge) {
              results.push({
                date, dimension, direction: '=', score: dim.score, delta: dim.delta,
                trajectory: dim.trajectory, context: dim.growth_edge, source: 'growth_edge'
              });
            }
          }
        } catch { /* skip malformed files */ }
      }
    }

    // Secondary source: raw evidence log (recent, pre-synthesis)
    const evidencePath = path.join(workspacePath, 'standing', 'evidence_log.json');
    if (fs.existsSync(evidencePath)) {
      const log = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
      const filtered = (Array.isArray(log) ? log : [])
        .filter(e => e.dimension === dimension);
      for (const e of filtered) {
        results.push({ ...e, source: 'live' });
      }
    }

    return results.slice(0, 30);
  } catch { return []; }
});

ipcMain.handle('sidebar:contemplation', async () => {
  try {
    // Check multiple possible locations for contemplation data
    const pluginDataPaths = [
      path.join(pluginsPath, 'openclaw-plugin-contemplation', 'data', 'agents', 'trail-guide', 'inquiries.json'),
      path.join(pluginsPath, 'openclaw-plugin-contemplation', 'data', 'inquiries.json'),
    ];

    for (const p of pluginDataPaths) {
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        return data.inquiries || [];
      }
    }
    return [];
  } catch { return []; }
});

ipcMain.handle('sidebar:journal', async () => {
  try {
    // Read recent journal entries from memory/ directory
    const memDir = path.join(workspacePath, 'memory');
    if (!fs.existsSync(memDir)) return [];

    const files = fs.readdirSync(memDir)
      .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))
      .sort()
      .reverse()
      .slice(0, 7); // Last 7 days

    const entries = [];
    for (const file of files) {
      const content = fs.readFileSync(path.join(memDir, file), 'utf8');
      const date = file.replace('.md', '');
      // Parse sections from the daily file
      const sections = content.split(/^## /m).filter(s => s.trim());
      for (const section of sections) {
        const firstLine = section.split('\n')[0].trim();
        const body = section.split('\n').slice(1).join('\n').trim();
        if (body) {
          entries.push({
            date,
            title: firstLine,
            body: body.substring(0, 500),
            fullBody: body,
            type: firstLine.toLowerCase().includes('witness') ? 'witness'
                : firstLine.toLowerCase().includes('observation') ? 'observation'
                : 'observation',  // Daily memory files are agent-written observations, not user entries
          });
        }
      }
    }
    return entries.slice(0, 20);
  } catch { return []; }
});

ipcMain.handle('sidebar:evolution', async () => {
  try {
    const receiptEntries = listEvolutionEvents(candidateEvolutionLedgerPaths({ workspacePath, pluginsPath }), { limit: 80 });
    const candidateResult = await loadEvolutionCandidateEntries({ limit: Math.max(0, 80 - receiptEntries.length) });
    const activeCandidates = filterHandledEvolutionCandidates(candidateResult.entries || [], receiptEntries);
    const entries = receiptEntries.concat(activeCandidates);
    const health = buildEvolutionLedgerHealth({ workspacePath, pluginsPath, repoRoot: __dirname });
    return {
      entries,
      live: true,
      receipts: receiptEntries.length,
      candidates: activeCandidates.length,
      candidateSummary: candidateResult.review?.summary || null,
      health,
      error: candidateResult.error || null
    };
  } catch (err) {
    return { entries: [], live: true, error: String(err.message || err) };
  }
});

ipcMain.handle('sidebar:harness-research', async () => {
  try {
    return loadHarnessResearchDigests({ limit: 12 });
  } catch (err) {
    return { live: true, readOnly: true, digests: [], error: String(err.message || err) };
  }
});

ipcMain.handle('sidebar:spine', async () => {
  try {
    const receiptEntries = listEvolutionEvents(candidateEvolutionLedgerPaths({ workspacePath, pluginsPath }), { limit: 80 });
    const candidateResult = await loadEvolutionCandidateEntries({ limit: 80 });
    const activeCandidates = filterHandledEvolutionCandidates(candidateResult.entries || [], receiptEntries);
    const outcomeEvents = receiptEntries.map((entry) => entry.metadata?.spineOutcomePacket).filter(Boolean);
    const maturationCandidates = activeCandidates.map((entry) => entry.metadata?.spinePacket).filter(Boolean);
    const authorityReceipts = createLiveShadowAuthorityEnforcementReceipts();
    return getSpineLedgerSnapshot(candidateSpineLedgerPaths({ workspacePath, pluginsPath }), {
      limit: 20,
      outcomeEvents: outcomeEvents.concat(authorityReceipts.map((receipt) => receipt.outcomeEvent)),
      governorDecisions: authorityReceipts.map((receipt) => receipt.governorDecision),
      maturationCandidates
    });
  } catch (err) {
    return { live: true, readOnly: true, error: String(err.message || err) };
  }
});

function filterHandledEvolutionCandidates(candidates = [], receiptEntries = []) {
  const handledCandidateIds = new Set();
  for (const entry of receiptEntries) {
    if (entry?.action !== 'candidate_review_receipt') continue;
    if (!['reviewed', 'dismissed', 'denied'].includes(entry.status)) continue;
    const originalCandidateId = entry.metadata?.originalCandidateId || entry.receiptId;
    if (originalCandidateId) handledCandidateIds.add(originalCandidateId);
  }
  return candidates.filter((candidate) => !handledCandidateIds.has(candidate.id));
}

function loadHarnessResearchDigests({ limit = 12 } = {}) {
  const researchPath = path.join(pluginsPath, 'openclaw-plugin-harness-refiner', 'data', 'research', 'research-ledger.jsonl');
  const digests = readJsonlFile(researchPath)
    .filter(entry => entry?.type === 'research_digest')
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, Math.max(1, Number(limit) || 12))
    .map(sanitizeHarnessResearchDigest);
  return {
    live: true,
    readOnly: true,
    digests,
    sourcePath: researchPath,
    error: null
  };
}

function readJsonlFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\n/)
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function sanitizeHarnessResearchDigest(digest = {}) {
  const artifactCounts = digest.artifactCounts && typeof digest.artifactCounts === 'object' ? digest.artifactCounts : {};
  const signals = digest.signals && typeof digest.signals === 'object' ? digest.signals : {};
  const decisions = digest.decisions && typeof digest.decisions === 'object' ? digest.decisions : {};
  return {
    id: sanitizeEvolutionReason(digest.id || ''),
    type: 'research_digest',
    experimentId: sanitizeEvolutionReason(digest.experimentId || ''),
    clusterId: sanitizeEvolutionReason(digest.clusterId || ''),
    title: sanitizeEvolutionReason(digest.title || 'Harness research digest'),
    whyItMatters: sanitizeEvolutionReason(digest.whyItMatters || ''),
    createdAt: sanitizeEvolutionReason(digest.createdAt || ''),
    artifactCounts: {
      windows: Number(artifactCounts.windows || 0),
      proposals: Number(artifactCounts.proposals || 0),
      replays: Number(artifactCounts.replays || 0),
      relabelCandidates: Number(artifactCounts.relabelCandidates || 0),
      teacherRelabels: Number(artifactCounts.teacherRelabels || 0),
      healthReceipts: Number(artifactCounts.healthReceipts || 0),
      skipped: Number(artifactCounts.skipped || 0)
    },
    signals: {
      failureSignatures: Array.isArray(signals.failureSignatures) ? signals.failureSignatures.map(v => sanitizeEvolutionReason(v)).slice(0, 12) : [],
      cognitiveSummary: signals.cognitiveSummary && typeof signals.cognitiveSummary === 'object'
        ? {
            latentBucket: sanitizeEvolutionReason(signals.cognitiveSummary.latentBucket || ''),
            rawLatentIncluded: signals.cognitiveSummary.rawLatentIncluded === true
          }
        : null
    },
    decisions: {
      proposalStatus: sanitizeEvolutionReason(decisions.proposalStatus || ''),
      trainingDataStatus: sanitizeEvolutionReason(decisions.trainingDataStatus || ''),
      exclusionReason: sanitizeEvolutionReason(decisions.exclusionReason || '')
    },
    nextReviewAction: sanitizeEvolutionReason(digest.nextReviewAction || ''),
    redactionPolicy: sanitizeEvolutionReason(digest.redactionPolicy || 'default-local-research-redaction')
  };
}

ipcMain.handle('sidebar:evolution-action', async (_event, { id, action, note } = {}) => {
  try {
    if (PROTECTED_EVOLUTION_ACTION_LANES[String(action || '').trim()]) {
      const gate = createEvolutionActionGateReceipt({ id, action, note });
      return refuseEvolutionActionFromGate(gate);
    }
    if (action === 'apply_low_risk_candidate') {
      return await applyLowRiskEvolutionCandidate({ id, note });
    }
    if (action === 'rollback_claim_review') {
      return await rollbackClaimReviewEvolutionReceipt({ id, note });
    }
    if (action === 'prepare_high_risk_approval_packet') {
      return await prepareHighRiskEvolutionApprovalPacket({ id, note });
    }
    if (action === 'run_high_risk_preflight') {
      return await runHighRiskEvolutionPreflight({ id, note });
    }
    if (action === 'record_high_risk_explicit_approval') {
      return await recordHighRiskEvolutionExplicitApproval({ id, note });
    }
    if (action === 'run_high_risk_pre_action_recheck') {
      return await runHighRiskEvolutionPreActionRecheck({ id, note });
    }
    if (action === 'apply_high_risk_claim_maturation') {
      return await applyHighRiskEvolutionClaimMaturation({ id, note });
    }
    if (action === 'approve_and_apply_if_still_safe') {
      return await approveAndApplyHighRiskEvolutionIfStillSafe({ id, note });
    }
    if (action === 'apply_scaffold_proposal') {
      return await applyScaffoldEvolutionProposal({ id, note });
    }
    if (action === 'rollback_scaffold_promotion') {
      return await rollbackScaffoldEvolutionPromotion({ id, note });
    }
    if (['mark_reviewed', 'dismiss', 'deny_proposal'].includes(action)) {
      const candidateReview = await reviewDryRunEvolutionCandidate({ id, action, note });
      if (candidateReview.found) return candidateReview.result;
    }
    const candidatePaths = candidateEvolutionLedgerPaths({ workspacePath, pluginsPath });
    const ledgerPath = candidatePaths.find((candidatePath) =>
      readEvolutionLedger(candidatePath).events.some((entry) => entry.id === id)
    );
    if (!ledgerPath) return { ok: false, error: 'Evolution receipt not found.' };
    const sourceEntry = listEvolutionEvents(ledgerPath, { limit: 200 }).find((entry) => entry.id === id);
    const gate = createEvolutionActionGateReceipt({ id, action, entry: sourceEntry, note });
    if (!gate.allowed) return refuseEvolutionActionFromGate(gate);
    const entry = updateEvolutionEvent(ledgerPath, id, action, { note });
    const contextPacket = buildEvolutionActionContextPacket(entry, action);
    return { ok: true, entry, contextPacket, gate: summarizeEvolutionActionGate(gate) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

function findEvolutionEntryWithLedger(id, limit = 500) {
  const candidatePaths = candidateEvolutionLedgerPaths({ workspacePath, pluginsPath });
  for (const ledgerPath of candidatePaths) {
    const entry = listEvolutionEvents(ledgerPath, { limit }).find((candidate) => candidate.id === id);
    if (entry) return { ledgerPath, entry };
  }
  return { ledgerPath: null, entry: null };
}

async function applyScaffoldEvolutionProposal({ id, note } = {}) {
  const { ledgerPath, entry: proposalEntry } = findEvolutionEntryWithLedger(id);
  if (!ledgerPath || !proposalEntry) return { ok: false, error: 'Scaffold proposal not found.' };
  const gate = createEvolutionActionGateReceipt({ id, action: 'apply_scaffold_proposal', entry: proposalEntry, note });
  if (!gate.allowed) return refuseEvolutionActionFromGate(gate);
  const isHarnessRefinerProposal = proposalEntry.action === 'harness_refinement_proposal';
  const result = isHarnessRefinerProposal
    ? promoteHarnessRefinerProposal(proposalEntry, { pluginsPath })
    : promoteScaffoldProposal(proposalEntry, { pluginsPath });
  const now = new Date().toISOString();
  const promotionEvent = isHarnessRefinerProposal
    ? buildHarnessRefinerPromotionEvent(proposalEntry, result, { now })
    : buildScaffoldPromotionEvent(proposalEntry, result, { now });
  appendEvolutionEvent(ledgerPath, { ...proposalEntry, status: 'applied', updatedAt: now }, { now });
  appendEvolutionEvent(ledgerPath, promotionEvent, { now });
  const entry = listEvolutionEvents(ledgerPath, { limit: 500 }).find((candidate) => candidate.id === promotionEvent.id) || promotionEvent;
  return {
    ok: true,
    entry,
    contextPacket: buildEvolutionActionContextPacket(entry, 'apply_scaffold_proposal'),
    result,
    gate: summarizeEvolutionActionGate(gate)
  };
}

async function rollbackScaffoldEvolutionPromotion({ id, note } = {}) {
  const { ledgerPath, entry: promotionEntry } = findEvolutionEntryWithLedger(id);
  if (!ledgerPath || !promotionEntry) return { ok: false, error: 'Scaffold promotion receipt not found.' };
  const gate = createEvolutionActionGateReceipt({ id, action: 'rollback_scaffold_promotion', entry: promotionEntry, note });
  if (!gate.allowed) return refuseEvolutionActionFromGate(gate);
  const result = rollbackScaffoldPromotion(promotionEntry, { pluginsPath });
  const now = new Date().toISOString();
  const rollbackEvent = buildScaffoldRollbackEvent(promotionEntry, result, { now });
  appendEvolutionEvent(ledgerPath, { ...promotionEntry, status: 'rolled_back', updatedAt: now }, { now });
  appendEvolutionEvent(ledgerPath, rollbackEvent, { now });
  const entry = listEvolutionEvents(ledgerPath, { limit: 500 }).find((candidate) => candidate.id === rollbackEvent.id) || rollbackEvent;
  return {
    ok: true,
    entry,
    contextPacket: buildEvolutionActionContextPacket(entry, 'rollback_scaffold_promotion'),
    result,
    gate: summarizeEvolutionActionGate(gate)
  };
}

async function reviewDryRunEvolutionCandidate({ id, action, note } = {}) {
  const candidateResult = await loadEvolutionCandidateEntries({ limit: 120 });
  const candidate = (candidateResult.entries || []).find((entry) => entry.id === id);
  if (!candidate) return { found: false };
  const gate = createEvolutionActionGateReceipt({ id, action, entry: candidate, note });
  if (!gate.allowed) return { found: true, result: refuseEvolutionActionFromGate(gate) };
  const event = recordCandidateReviewEvolution(candidate, action, { workspacePath, note });
  const entry = guiEntryForEvolutionEvent(event);
  return { found: true, result: { ok: true, entry, contextPacket: buildEvolutionActionContextPacket(entry, action), gate: summarizeEvolutionActionGate(gate) } };
}

async function prepareHighRiskEvolutionApprovalPacket({ id, note } = {}) {
  const candidateResult = await loadEvolutionCandidateEntries({ limit: 120 });
  const candidate = (candidateResult.entries || []).find((entry) => entry.id === id);
  if (!candidate) return { ok: false, error: 'Evolution candidate not found.' };
  const gate = createEvolutionActionGateReceipt({ id, action: 'prepare_high_risk_approval_packet', entry: candidate, note });
  if (!gate.allowed) return refuseEvolutionActionFromGate(gate);
  const event = recordHighRiskApprovalPacket(candidate, { workspacePath, note });
  const entry = guiEntryForEvolutionEvent(event);
  return { ok: true, entry, contextPacket: buildEvolutionActionContextPacket(entry, 'prepare_high_risk_approval_packet'), gate: summarizeEvolutionActionGate(gate) };
}

async function runHighRiskEvolutionPreflight({ id, note } = {}) {
  const candidateResult = await loadEvolutionCandidateEntries({ limit: 120 });
  const candidate = (candidateResult.entries || []).find((entry) => entry.id === id);
  if (!candidate) return { ok: false, error: 'Evolution candidate not found.' };
  const gate = createEvolutionActionGateReceipt({ id, action: 'run_high_risk_preflight', entry: candidate, note });
  if (!gate.allowed) return refuseEvolutionActionFromGate(gate);
  const event = recordHighRiskPreflight(candidate, { workspacePath, note });
  const entry = guiEntryForEvolutionEvent(event);
  return { ok: true, entry, contextPacket: buildEvolutionActionContextPacket(entry, 'run_high_risk_preflight'), gate: summarizeEvolutionActionGate(gate) };
}

async function recordHighRiskEvolutionExplicitApproval({ id, note } = {}) {
  const candidatePaths = candidateEvolutionLedgerPaths({ workspacePath, pluginsPath });
  const ledgerPath = candidatePaths.find((candidatePath) =>
    readEvolutionLedger(candidatePath).events.some((entry) => entry.id === id)
  );
  if (!ledgerPath) return { ok: false, error: 'High-risk approval packet not found.' };
  const packetEntry = listEvolutionEvents(ledgerPath, { limit: 300 }).find((entry) => entry.id === id);
  const gate = createEvolutionActionGateReceipt({ id, action: 'record_high_risk_explicit_approval', entry: packetEntry, note });
  if (!gate.allowed) return refuseEvolutionActionFromGate(gate);
  const event = recordHighRiskExplicitApproval(packetEntry, { ledgerPath, note });
  const entry = guiEntryForEvolutionEvent(event);
  return { ok: true, entry, contextPacket: buildEvolutionActionContextPacket(entry, 'record_high_risk_explicit_approval'), gate: summarizeEvolutionActionGate(gate) };
}

async function runHighRiskEvolutionPreActionRecheck({ id, note } = {}) {
  const candidatePaths = candidateEvolutionLedgerPaths({ workspacePath, pluginsPath });
  const ledgerPath = candidatePaths.find((candidatePath) =>
    readEvolutionLedger(candidatePath).events.some((entry) => entry.id === id)
  );
  if (!ledgerPath) return { ok: false, error: 'High-risk explicit approval receipt not found.' };
  const approvalEntry = listEvolutionEvents(ledgerPath, { limit: 500 }).find((entry) => entry.id === id);
  const gate = createEvolutionActionGateReceipt({ id, action: 'run_high_risk_pre_action_recheck', entry: approvalEntry, note });
  if (!gate.allowed) return refuseEvolutionActionFromGate(gate);
  const candidateResult = await loadEvolutionCandidateEntries({ limit: 200 });
  const candidateId = approvalEntry.metadata?.approvalBinding?.candidateId;
  const currentCandidate = (candidateResult.entries || []).find((entry) => entry.id === candidateId) || null;
  const event = recordHighRiskPreActionRecheck(approvalEntry, { ledgerPath, note, currentCandidate });
  const entry = guiEntryForEvolutionEvent(event);
  return { ok: true, entry, contextPacket: buildEvolutionActionContextPacket(entry, 'run_high_risk_pre_action_recheck'), gate: summarizeEvolutionActionGate(gate) };
}

async function approveAndApplyHighRiskEvolutionIfStillSafe({ id, note } = {}) {
  const candidateResult = await loadEvolutionCandidateEntries({ limit: 200 });
  const candidate = (candidateResult.entries || []).find((entry) => entry.id === id);
  if (!candidate) return { ok: false, error: 'Evolution candidate not found.' };

  const gate = createEvolutionActionGateReceipt({ id, action: 'approve_and_apply_if_still_safe', entry: candidate, note });
  if (!gate.allowed) return refuseEvolutionActionFromGate(gate);
  const prepareGate = createEvolutionActionGateReceipt({ id, action: 'prepare_high_risk_approval_packet', entry: candidate, note });
  if (!prepareGate.allowed) return refuseEvolutionActionFromGate(prepareGate);

  const packetEvent = recordHighRiskApprovalPacket(candidate, { workspacePath, note });
  const packetEntry = guiEntryForEvolutionEvent(packetEvent);
  const packetGate = createEvolutionActionGateReceipt({ id: packetEntry.id, action: 'record_high_risk_explicit_approval', entry: packetEntry, note });
  if (!packetGate.allowed) return refuseEvolutionActionFromGate(packetGate);

  const approvalEvent = recordHighRiskExplicitApproval(packetEntry, { workspacePath, note, approver: 'operator' });
  const approvalEntry = guiEntryForEvolutionEvent(approvalEvent);
  const recheckGate = createEvolutionActionGateReceipt({ id: approvalEntry.id, action: 'run_high_risk_pre_action_recheck', entry: approvalEntry, note });
  if (!recheckGate.allowed) return refuseEvolutionActionFromGate(recheckGate);

  const freshCandidateResult = await loadEvolutionCandidateEntries({ limit: 200 });
  const currentCandidate = (freshCandidateResult.entries || []).find((entry) => entry.id === id) || null;
  const recheckEvent = recordHighRiskPreActionRecheck(approvalEntry, { workspacePath, note, currentCandidate });
  const recheckEntry = guiEntryForEvolutionEvent(recheckEvent);

  if (!currentCandidate || !evolutionRecheckEntryIsApplyReady(recheckEntry)) {
    return {
      ok: true,
      entry: recheckEntry,
      contextPacket: buildEvolutionActionContextPacket(recheckEntry, 'approve_and_apply_if_still_safe stopped: not applied — no change made'),
      gate: summarizeEvolutionActionGate(gate),
      internalGates: {
        prepare: summarizeEvolutionActionGate(prepareGate),
        packet: summarizeEvolutionActionGate(packetGate),
        recheck: summarizeEvolutionActionGate(recheckGate)
      },
      applied: false
    };
  }

  const applyResult = await applyHighRiskEvolutionClaimMaturation({ id: recheckEntry.id, note });
  if (!applyResult?.ok) {
    return {
      ok: true,
      entry: recheckEntry,
      contextPacket: `${buildEvolutionActionContextPacket(recheckEntry, 'approve_and_apply_if_still_safe stopped: not applied — no change made')}\n\nApply handler refused after recheck: ${applyResult?.error || 'unknown blocker'}`,
      gate: summarizeEvolutionActionGate(gate),
      internalGates: {
        prepare: summarizeEvolutionActionGate(prepareGate),
        packet: summarizeEvolutionActionGate(packetGate),
        recheck: summarizeEvolutionActionGate(recheckGate),
        apply: applyResult?.gate || null
      },
      applied: false,
      applyRefusal: applyResult
    };
  }

  return {
    ...applyResult,
    contextPacket: buildEvolutionActionContextPacket(applyResult.entry, 'approve_and_apply_if_still_safe applied after packet, explicit approval, immediate recheck, and claim apply gates'),
    gate: summarizeEvolutionActionGate(gate),
    internalGates: {
      prepare: summarizeEvolutionActionGate(prepareGate),
      packet: summarizeEvolutionActionGate(packetGate),
      recheck: summarizeEvolutionActionGate(recheckGate),
      apply: applyResult.gate || null
    },
    applied: true
  };
}

function evolutionRecheckEntryIsApplyReady(entry = {}) {
  return entry.action === 'high_risk_pre_action_recheck'
    && entry.status === 'held'
    && entry.risk === 'high'
    && entry.metadata?.approvalStatus === 'rechecked_no_apply'
    && entry.metadata?.recheckOutcome === 'current approval still gated'
    && entry.metadata?.applyAuthorityGranted !== true
    && entry.metadata?.applyAuthorityGranted !== 'true'
    && entry.metadata?.mutationAttempted !== true
    && entry.metadata?.mutationAttempted !== 'true'
    && entry.metadata?.approvedBinding?.actionId === 'high_risk_review_apply'
    && entry.metadata?.approvedBinding?.effectClass === 'claim_maturation';
}

async function applyHighRiskEvolutionClaimMaturation({ id, note } = {}) {
  const candidatePaths = candidateEvolutionLedgerPaths({ workspacePath, pluginsPath });
  const ledgerPath = candidatePaths.find((candidatePath) =>
    readEvolutionLedger(candidatePath).events.some((entry) => entry.id === id)
  );
  if (!ledgerPath) return { ok: false, error: 'High-risk pre-action recheck receipt not found.' };
  const recheckEntry = listEvolutionEvents(ledgerPath, { limit: 500 }).find((entry) => entry.id === id);
  const gate = createEvolutionActionGateReceipt({ id, action: 'apply_high_risk_claim_maturation', entry: recheckEntry, note });
  if (!gate.allowed) return refuseEvolutionActionFromGate(gate);

  const binding = recheckEntry.metadata?.approvedBinding || {};
  const candidateResult = await loadEvolutionCandidateEntries({ limit: 200 });
  const currentCandidate = (candidateResult.entries || []).find((entry) => entry.id === binding.candidateId) || null;
  const finalRecheck = assessHighRiskPreActionRecheck({
    approvalEntry: { metadata: { approvalBinding: binding } },
    currentCandidate
  });
  if (finalRecheck.outcome !== 'current approval still gated') {
    return {
      ok: false,
      error: `High-risk apply refused by final recheck: ${(finalRecheck.reasonCodes || []).join(', ') || 'unknown blocker'}`,
      finalRecheck,
      gate: summarizeEvolutionActionGate(gate),
      contextPacket: buildEvolutionActionContextPacket(recheckEntry, 'apply_high_risk_claim_maturation refused by final recheck')
    };
  }

  const metadata = currentCandidate.metadata || {};
  const decision = metadata.policyDecision;
  if (currentCandidate.action !== 'autonomy_review_dry_run') return { ok: false, error: 'Only dry-run candidates can enter the approved high-risk apply lane.' };
  if (currentCandidate.risk !== 'high') return { ok: false, error: 'Current candidate is no longer high risk; approved high-risk apply refused.' };
  if (!['archive_open_question', 'hold_as_hypothesis'].includes(decision)) return { ok: false, error: `Decision ${decision || 'unknown'} is not applyable in this lane.` };
  if (binding.claimId && currentCandidate.claimId !== binding.claimId) return { ok: false, error: 'Current candidate claim binding does not match approved packet.' };
  if (metadata.mutationAttempted === true || metadata.promptInjectionEligibilityChanged === true) {
    return { ok: false, error: 'Candidate already reports mutation or prompt eligibility changes; high-risk apply refused.' };
  }

  const claimStore = createSidebarClaimStore();
  const claim = claimStore.getClaim(currentCandidate.claimId);
  if (!claim) return { ok: false, error: `Claim not found: ${currentCandidate.claimId}` };
  const reason = sanitizeEvolutionReason(note) || `Evolve explicit high-risk apply for ${currentCandidate.id}: ${currentCandidate.summary}`;
  const operatorApproval = approvalString({ claimId: currentCandidate.claimId, decision, expectedStatus: claim.status });
  const result = createAutonomyReviewDecisionApply({
    claimStore,
    claimId: currentCandidate.claimId,
    decision,
    expectedStatus: claim.status,
    agentId: 'trail-guide',
    apply: true,
    reason,
    operatorApproval
  });
  if (!result.ok || result.mutationAttempted !== true || result.promptInjectionEligibilityChanged === true) {
    return { ok: false, error: `Approved high-risk apply refused: ${(result.blockers || []).join(', ') || 'unknown blocker'}`, result, finalRecheck };
  }
  const event = recordHighRiskClaimMaturationApply(result, { ledgerPath, recheckEntry, currentCandidate, finalRecheck });
  const entry = guiEntryForEvolutionEvent(event);
  return { ok: true, entry, contextPacket: buildEvolutionActionContextPacket(entry, 'apply_high_risk_claim_maturation'), result, finalRecheck, gate: summarizeEvolutionActionGate(gate) };
}

async function applyLowRiskEvolutionCandidate({ id, note } = {}) {
  const candidateResult = await loadEvolutionCandidateEntries({ limit: 120 });
  const candidate = (candidateResult.entries || []).find((entry) => entry.id === id);
  if (!candidate) return { ok: false, error: 'Evolution candidate not found.' };
  const metadata = candidate.metadata || {};
  const decision = metadata.policyDecision;
  if (candidate.action !== 'autonomy_review_dry_run') return { ok: false, error: 'Only dry-run candidates can enter the low-risk apply lane.' };
  if (candidate.risk !== 'low') return { ok: false, error: 'Candidate is not low risk; autonomous apply refused.' };
  if (!['archive_open_question', 'hold_as_hypothesis'].includes(decision)) return { ok: false, error: `Decision ${decision || 'unknown'} is not applyable in this lane.` };
  if (metadata.mutationAttempted === true || metadata.promptInjectionEligibilityChanged === true) {
    return { ok: false, error: 'Candidate already reports mutation or prompt eligibility changes; autonomous apply refused.' };
  }
  const gate = createEvolutionActionGateReceipt({ id, action: 'apply_low_risk_candidate', entry: candidate, note });
  if (!gate.allowed) return refuseEvolutionActionFromGate(gate);

  const claimStore = createSidebarClaimStore();
  const claim = claimStore.getClaim(candidate.claimId);
  if (!claim) return { ok: false, error: `Claim not found: ${candidate.claimId}` };
  const reason = sanitizeEvolutionReason(note) || `Evolve autonomous low-risk apply for ${candidate.id}: ${candidate.summary}`;
  const result = createAutonomyReviewDecisionApply({
    claimStore,
    claimId: candidate.claimId,
    decision,
    expectedStatus: claim.status,
    agentId: 'trail-guide',
    apply: true,
    reason
  });
  if (!result.ok || result.mutationAttempted !== true) {
    return { ok: false, error: `Autonomous apply refused: ${(result.blockers || []).join(', ') || 'unknown blocker'}`, result };
  }
  const event = recordClaimReviewEvolution(result, { workspacePath });
  const entry = guiEntryForEvolutionEvent(event);
  return { ok: true, entry, contextPacket: buildEvolutionActionContextPacket(entry, 'apply_low_risk_candidate'), result };
}

async function rollbackClaimReviewEvolutionReceipt({ id, note } = {}) {
  const candidatePaths = candidateEvolutionLedgerPaths({ workspacePath, pluginsPath });
  let sourceEntry = null;
  for (const candidatePath of candidatePaths) {
    sourceEntry = listEvolutionEvents(candidatePath, { limit: 200 }).find((entry) => entry.id === id);
    if (sourceEntry) break;
  }
  if (!sourceEntry) return { ok: false, error: 'Evolution receipt not found.' };
  if (!sourceEntry.rollbackAction || sourceEntry.rollbackAction.action !== 'rollback_review_decision') {
    return { ok: false, error: 'Receipt has no claim-review rollback action.' };
  }
  const gate = createEvolutionActionGateReceipt({ id, action: 'rollback_claim_review', entry: sourceEntry, note });
  if (!gate.allowed) return refuseEvolutionActionFromGate(gate);

  const claimStore = createSidebarClaimStore();
  const reason = sanitizeEvolutionReason(note) || `Evolve rollback for ${sourceEntry.id}`;
  const result = createAutonomyReviewDecisionRollback({
    claimStore,
    claimId: sourceEntry.rollbackAction.claim_id,
    receiptId: sourceEntry.rollbackAction.receipt_id,
    agentId: 'trail-guide',
    apply: true,
    reason
  });
  if (!result.ok || result.mutationAttempted !== true) {
    return { ok: false, error: `Rollback refused: ${(result.blockers || []).join(', ') || 'unknown blocker'}`, result };
  }
  const event = recordClaimReviewEvolution(result, { workspacePath });
  const entry = guiEntryForEvolutionEvent(event);
  return { ok: true, entry, contextPacket: buildEvolutionActionContextPacket(entry, 'rollback_claim_review'), result };
}

function createSidebarClaimStore() {
  const db = getContinuityDB();
  if (!db) throw new Error('Continuity DB unavailable.');
  return new ClaimStore(db, { sourceAddressableMemory: { enabled: true, mode: 'observe' } });
}

function guiEntryForEvolutionEvent(event) {
  if (!event) return null;
  const ledgerPath = require('./lib/evolution-ledger').resolveEvolutionLedgerPath({ workspacePath });
  return listEvolutionEvents(ledgerPath, { limit: 200 }).find((entry) => entry.id === event.id) || event;
}

function sanitizeEvolutionReason(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function refuseEvolutionActionFromGate(gate) {
  persistEvolutionActionGateReceipt(gate);
  return {
    ok: false,
    error: gate.reason || 'Evolution action refused by pre-action gate.',
    gate: summarizeEvolutionActionGate(gate),
    contextPacket: buildEvolutionGateContextPacket(gate)
  };
}

function persistEvolutionActionGateReceipt(gate) {
  try {
    recordEvolutionActionGateReceipt(resolveSpineLedgerPath({ workspacePath }), gate);
    gate.recorded = true;
  } catch (err) {
    gate.recorded = false;
    gate.recordError = String(err.message || err);
  }
  return gate;
}

function summarizeEvolutionActionGate(gate = {}) {
  return {
    allowed: gate.allowed === true,
    action: gate.action || null,
    id: gate.id || null,
    blockers: Array.isArray(gate.blockers) ? gate.blockers : [],
    governorDecisionId: gate.governorDecision?.decisionId || null,
    outcomeEventId: gate.outcomeEvent?.eventId || null,
    recorded: gate.recorded === true,
    recordError: gate.recordError || null
  };
}

function buildEvolutionGateContextPacket(gate = {}) {
  const lines = [
    `Evolution action refused: ${gate.action || 'unknown'}`,
    '',
    `Target: ${gate.id || 'unknown'}`,
    `Reason: ${gate.reason || 'not recorded'}`,
    `Blockers: ${(gate.blockers || []).join(', ') || 'none recorded'}`,
    `Governor decision: ${gate.governorDecision?.decisionId || 'not recorded'}`,
    `Outcome receipt: ${gate.outcomeEvent?.eventId || 'not recorded'}`,
    '',
    'No handler execution or protected authority mutation occurred.'
  ];
  return lines.join('\n');
}

function createLiveShadowAuthorityEnforcementReceipts() {
  const now = new Date().toISOString();
  return Object.values(AUTHORITY_LANES).map((lane) => createAuthorityLaneEnforcementReceipt({
    requestId: `live-shadow-${lane}`,
    lane,
    requestedEffect: {
      effect: 'authority_lane_enablement_shadow_check',
      summary: `Shadow-enforce ${lane} before granting runtime authority.`,
      expectedEffect: 'Observe and receipt protected authority requests without granting authority.'
    },
    authority: {
      hasCurrentInstruction: true,
      source: 'sidebar:spine'
    },
    enforcementPolicy: {
      mode: 'shadow',
      enabledLanes: []
    },
    now,
    source: {
      sourceType: 'runtime_enforcement_shadow',
      sourceHandle: 'sidebar:spine'
    }
  }));
}

function buildEvolutionActionContextPacket(entry, action) {
  if (!entry) return '';
  const lines = [
    `Evolution action requested: ${action}`,
    '',
    `Artifact: ${entry.id}`,
    `Class: ${entry.class}`,
    `Title: ${entry.title}`,
    `Status: ${entry.status}`,
    `Summary: ${entry.summary}`,
    `Rollback path: ${entry.rollback || 'Not recorded'}`
  ];
  if (entry.rollbackAction?.tool) {
    lines.push('', 'Available rollback tool payload:', JSON.stringify(entry.rollbackAction, null, 2));
  }
  lines.push('', 'Please inspect this change, explain whether it should remain, and perform the requested rollback/disable/strip action only if it stays inside the recorded safety boundary.');
  return lines.join('\n');
}

async function loadEvolutionCandidateEntries({ limit = 80 } = {}) {
  if (limit <= 0) return { entries: [], review: null, error: null };
  try {
    const db = getContinuityDB();
    if (!db) return { entries: [], review: null, error: 'Continuity DB unavailable.' };
    const claimStore = new ClaimStore(db, { sourceAddressableMemory: { enabled: true, mode: 'observe' } });
    return await listClaimEvolutionCandidates({ claimStore, agentId: 'trail-guide', limit });
  } catch (err) {
    return { entries: [], review: null, error: String(err.message || err) };
  }
}

// ============================================================

function normalizeProjectRadarDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (value === null || value === undefined || value === '') return 'none';
  return String(value);
}

function normalizeProjectRadarList(value) {
  return Array.isArray(value) ? value.map(v => String(v)) : [];
}

function normalizeProjectRadarTemplatePhase(phase = {}) {
  return {
    id: String(phase.id || ''),
    title: String(phase.title || 'Untitled phase'),
    category: String(phase.category || ''),
    milestone_kind: String(phase.milestone_kind || ''),
    calendar_policy: String(phase.calendar_policy || 'none'),
    required: Boolean(phase.required),
    mission_critical: Boolean(phase.mission_critical),
    completion_signal: String(phase.completion_signal || '')
  };
}

function normalizeProjectRadarTemplate(template = {}) {
  return {
    id: String(template.id || ''),
    title: String(template.title || 'Untitled template'),
    type: String(template.type || 'unknown'),
    purpose: String(template.purpose || ''),
    validation_case: String(template.validation_case || ''),
    phases: Array.isArray(template.phases) ? template.phases.map(normalizeProjectRadarTemplatePhase) : []
  };
}

function normalizeProjectRadarComplexProjectPhase(phase = {}) {
  return {
    id: String(phase.id || ''),
    status: String(phase.status || 'waiting'),
    owner: String(phase.owner || 'unknown'),
    target_window: normalizeProjectRadarDate(phase.target_window),
    due: normalizeProjectRadarDate(phase.due),
    calendar_policy: String(phase.calendar_policy || 'none'),
    needs_chris: Boolean(phase.needs_chris),
    blocker: String(phase.blocker || ''),
    next_action: String(phase.next_action || ''),
    evidence: normalizeProjectRadarList(phase.evidence),
    notes: String(phase.notes || '')
  };
}

function normalizeProjectRadarComplexProject(project = {}) {
  return {
    id: String(project.id || ''),
    title: String(project.title || 'Untitled complex project'),
    template_id: String(project.template_id || ''),
    status: String(project.status || 'planning'),
    owner: String(project.owner || 'unknown'),
    target_window: normalizeProjectRadarDate(project.target_window),
    launch_window: normalizeProjectRadarDate(project.launch_window),
    source: normalizeProjectRadarList(project.source),
    outcome: String(project.outcome || ''),
    next_action: String(project.next_action || ''),
    blocker: String(project.blocker || ''),
    calendar_policy: String(project.calendar_policy || 'none'),
    updated: normalizeProjectRadarDate(project.updated),
    phases: Array.isArray(project.phases) ? project.phases.map(normalizeProjectRadarComplexProjectPhase) : []
  };
}

function normalizeProjectRadarItem(item = {}) {
  return {
    id: String(item.id || ''),
    title: String(item.title || 'Untitled Project Radar item'),
    type: String(item.type || 'unknown'),
    template_id: String(item.template_id || ''),
    status: String(item.status || 'later'),
    stream: String(item.stream || 'unknown'),
    priority: String(item.priority || 'medium'),
    owner: String(item.owner || 'unknown'),
    needs_chris: Boolean(item.needs_chris),
    source: normalizeProjectRadarList(item.source),
    outcome: String(item.outcome || ''),
    next_action: String(item.next_action || ''),
    blocker: String(item.blocker || ''),
    due: normalizeProjectRadarDate(item.due),
    calendar_policy: String(item.calendar_policy || 'none'),
    evidence: normalizeProjectRadarList(item.evidence),
    updated: normalizeProjectRadarDate(item.updated),
    notes: String(item.notes || '')
  };
}

ipcMain.handle('sidebar:project-radar', async () => {
  try {
    const trackerPath = path.join(workspacePath, 'projects', 'operating-board', 'TRACKER.yaml');
    if (!fs.existsSync(trackerPath)) {
      return { live: true, readOnly: true, exists: false, items: [], lanes: [], streams: [], error: null };
    }
    const raw = yaml.load(fs.readFileSync(trackerPath, 'utf8')) || {};
    const items = Array.isArray(raw.items) ? raw.items.map(normalizeProjectRadarItem) : [];
    const templates = Array.isArray(raw.templates) ? raw.templates.map(normalizeProjectRadarTemplate) : [];
    const complexProjects = Array.isArray(raw.complex_projects) ? raw.complex_projects.map(normalizeProjectRadarComplexProject) : [];
    return {
      live: true,
      readOnly: true,
      exists: true,
      trackerPath: 'projects/operating-board/TRACKER.yaml',
      generatedPath: 'projects/operating-board/PROJECT-RADAR.md',
      version: String(raw.version || ''),
      updated: normalizeProjectRadarDate(raw.updated),
      lanes: normalizeProjectRadarList(raw.lanes),
      streams: normalizeProjectRadarList(raw.streams),
      templates,
      complex_projects: complexProjects,
      items,
      counts: items.reduce((acc, item) => {
        acc.total += 1;
        acc.byStatus[item.status] = (acc.byStatus[item.status] || 0) + 1;
        acc.byStream[item.stream] = (acc.byStream[item.stream] || 0) + 1;
        if (item.needs_chris) acc.needsChris += 1;
        return acc;
      }, { total: 0, needsChris: 0, byStatus: {}, byStream: {}, templates: templates.length, complexProjects: complexProjects.length }),
      authority: 'read-only Project Radar view; no file edits, calendar writes, Evolve actions, or code mutations'
    };
  } catch (err) {
    return { live: true, readOnly: true, exists: true, items: [], lanes: [], streams: [], error: String(err.message || err) };
  }
});

// Projects — reads from workspace projects/ directory
// ============================================================

ipcMain.handle('projects:list', async () => {
  try {
    const projectsDir = path.join(workspacePath, 'projects');
    if (!fs.existsSync(projectsDir)) return [];

    const projects = [];
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const projectPath = path.join(projectsDir, entry.name);
      const projectFiles = fs.readdirSync(projectPath);
      const fileCount = projectFiles.length;

      // Try to read a project manifest or README for metadata
      let name = entry.name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      let goal = '';
      let status = 'active';

      // Check for project.json manifest
      const manifestPath = path.join(projectPath, 'project.json');
      if (fs.existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          if (manifest.name) name = manifest.name;
          if (manifest.goal) goal = manifest.goal;
          if (manifest.status) status = manifest.status;
        } catch { /* use defaults */ }
      } else {
        // Check for README.md — first line as goal
        const readmePath = path.join(projectPath, 'README.md');
        if (fs.existsSync(readmePath)) {
          const readme = fs.readFileSync(readmePath, 'utf8');
          const firstLine = readme.split('\n').find(l => l.trim() && !l.startsWith('#'));
          if (firstLine) goal = firstLine.trim().substring(0, 120);
        }
      }

      // Get last modified time
      const stat = fs.statSync(projectPath);
      const age = Date.now() - stat.mtimeMs;
      let updated = '';
      if (age < 3600000) updated = Math.round(age / 60000) + 'm ago';
      else if (age < 86400000) updated = Math.round(age / 3600000) + 'h ago';
      else updated = Math.round(age / 86400000) + 'd ago';

      projects.push({ name, slug: entry.name, goal, status, fileCount, updated });
    }

    return projects;
  } catch {
    return [];
  }
});

// Archive a project (set status to 'archived' in project.json, don't delete)
ipcMain.handle('projects:archive', async (_event, projectName) => {
  try {
    const projectsDir = path.join(workspacePath, 'projects');
    // Find directory matching the project name (case-insensitive search)
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true }).filter(d => d.isDirectory());
    const match = entries.find(d => {
      const titlecased = d.name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      return titlecased === projectName || d.name === projectName;
    });
    if (!match) return { error: 'Project not found' };

    const projectPath = path.join(projectsDir, match.name);
    const manifestPath = path.join(projectPath, 'project.json');
    let manifest = {};
    try {
      if (fs.existsSync(manifestPath)) manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch { /* fresh manifest */ }
    manifest.status = 'archived';
    manifest.archived_at = new Date().toISOString();
    writeJsonAtomic(manifestPath, manifest);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// Create a new project — creates disk structure AND updates agent's MEMORY.md
ipcMain.handle('projects:create', async (_event, { name, goal }) => {
  try {
    const slug = (name || 'new-project').toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').substring(0, 60);
    const projectsDir = path.join(workspacePath, 'projects');
    if (!fs.existsSync(projectsDir)) fs.mkdirSync(projectsDir, { recursive: true });

    const projectPath = path.join(projectsDir, slug);
    if (fs.existsSync(projectPath)) return { error: 'Project already exists' };

    fs.mkdirSync(projectPath, { recursive: true });

    // Write project manifest
    const manifest = {
      name: name || slug,
      goal: goal || '',
      status: 'active',
      created: new Date().toISOString().split('T')[0]
    };
    writeJsonAtomic(path.join(projectPath, 'project.json'), manifest);

    // Write a README scaffold
    fs.writeFileSync(path.join(projectPath, 'README.md'),
      `# ${name || slug}\n\n${goal || 'Project goal TBD.'}\n\nCreated: ${manifest.created}\n`);

    // Update agent's MEMORY.md so the agent knows about this project
    const memoryPath = path.join(workspacePath, 'MEMORY.md');
    if (fs.existsSync(memoryPath)) {
      const memory = fs.readFileSync(memoryPath, 'utf8');
      if (!memory.includes(`Project: ${name}`)) {
        const entry = `\n- **Project: ${name}** — ${goal || 'New project'} (created ${manifest.created})\n`;
        fs.writeFileSync(memoryPath, memory.trimEnd() + '\n' + entry);
      }
    }

    return { ok: true, slug };
  } catch (err) {
    return { error: err.message };
  }
});

// ============================================================
// Project Thread Switching
// ============================================================

ipcMain.handle('projects:switch', async (_event, { slug, name }) => {
  try {
    const projectThreadId = `project_${slug}`;

    // Already on this project's thread — no-op
    if (currentThreadId === projectThreadId) {
      return { ok: true, alreadyActive: true };
    }

    // Write session record for outgoing thread
    writeSessionRecord();

    // Fire handoff write for outgoing thread (fire-and-forget)
    if (conversationHistory.length > 0) {
      callGatewayHTTP(
        '[SYSTEM: Thread switch. Write a brief handoff for this thread\'s continuity store. ' +
        'One paragraph: key context, decisions, open items specific to this thread. ' +
        'Output goes to your own future context — this is self-to-self, not documentation. ' +
        'Output only the summary text.]',
        { internalOnly: true }
      ).catch(e => console.warn('[ProjectSwitch] Handoff write failed (non-fatal):', e.message));
    }

    // Switch to project thread
    conversationHistory = [];
    try { fs.unlinkSync(checkpointPath); } catch {} // Clear stale checkpoint
    currentSessionId = makeSessionId();
    currentThreadId = projectThreadId;
    currentSessionMode = 'code';
    currentSessionProjectId = slug;
    currentSessionFirstUserMsg = null;
    currentSessionMessageCount = 0;

    // Persist
    config.currentSessionProjectName = name;
    syncSessionConfig({ clearJsonl: true });

    sendStatus('session', `Switched to project: ${name}`);
    return { ok: true, threadId: projectThreadId };
  } catch (err) {
    return { error: err.message };
  }
});

// ============================================================
// Skills Discovery (for slash command autocomplete)
// ============================================================

ipcMain.handle('chat:get-skills', async () => {
  try {
    const skillsDir = path.join(workspacePath, 'skills');
    if (!fs.existsSync(skillsDir)) return [];

    const skills = [];
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;

      const content = fs.readFileSync(skillFile, 'utf8');

      // Parse YAML frontmatter for name, description, user-invocable
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      let name = entry.name;
      let description = '';
      let userInvocable = true;

      if (fmMatch) {
        const fm = fmMatch[1];
        const nameMatch = fm.match(/name:\s*["']?([^"'\n]+)/);
        const descMatch = fm.match(/description:\s*["']?([^"'\n]+)/);
        const invMatch = fm.match(/user-invocable:\s*(true|false)/);
        if (nameMatch) name = nameMatch[1].trim();
        if (descMatch) description = descMatch[1].trim().replace(/["']$/, '');
        if (invMatch) userInvocable = invMatch[1] === 'true';
      } else {
        // No frontmatter — extract from first heading and paragraph
        const headingMatch = content.match(/^#\s+(.+)/m);
        const descLine = content.split('\n').find(l => l.trim() && !l.startsWith('#') && !l.startsWith('---'));
        if (headingMatch) name = headingMatch[1].trim();
        if (descLine) description = descLine.trim().substring(0, 120);
      }

      skills.push({
        command: '/' + entry.name,
        name,
        description,
        userInvocable,
      });
    }

    return skills;
  } catch {
    return [];
  }
});

// ============================================================
// Session Reset (Done button)
// ============================================================

// ── Infinite Threads: Consolidation restart handler ──
// Called when the continuity plugin signals that compaction has degraded
// the live context. Creates a new session while preserving the thread identity.
// New session ID, same thread — the thread is persistent, sessions are ephemeral.
async function handleConsolidationRestart(threadId) {
  try {
    await performSessionRollover({
      reason: 'plugin-consolidation',
      keepThread: true,
      threadId: threadId || currentThreadId,
    });
    console.log(`[InfiniteThreads] Consolidation restart completed for thread ${threadId || currentThreadId}`);
  } catch (err) {
    console.error(`[InfiniteThreads] Consolidation restart failed: ${err.message}`);
  }
}

ipcMain.handle('chat:reset-session', async () => {
  try {
    // Write current session record to DB before resetting
    writeSessionRecord();

    const resetSessionKey = gatewaySessionKeyFor(currentSessionId);
    let gatewayReset = null;
    try {
      gatewayReset = await callGatewayRPC(
        'sessions.reset',
        { key: resetSessionKey, reason: 'new' },
        { timeoutMs: 15000 }
      );
      console.log(`[ResetSession] Gateway sessions.reset completed for ${resetSessionKey}`);
    } catch (e) {
      console.warn(`[ResetSession] Gateway sessions.reset failed for ${resetSessionKey} (continuing local reset):`, e.message);
    }

    pendingNewTaskBoundary = buildNewTaskBoundary(conversationHistory);
    config.pendingNewTaskBoundary = pendingNewTaskBoundary || null;

    // Clear conversation history
    conversationHistory = [];
    try { fs.unlinkSync(checkpointPath); } catch {} // Clear stale checkpoint
    config.currentSessionJsonlFile = null;

    if (trainingGroundsActive && currentSessionProjectId) {
      // In a project thread: keep durable thread_id, rotate gateway session.
      currentSessionId = makeSessionId();
      currentThreadId = `project_${currentSessionProjectId}`;
      currentSessionFirstUserMsg = null;
      currentSessionMessageCount = 0;
      syncSessionConfig({ clearJsonl: true });
      sendStatus('session', gatewayReset?.ok ? 'Project context refreshed' : 'Project context refreshed — gateway reset unavailable');
    } else {
      // Normal reset: new session
      currentSessionId = makeSessionId();
      currentThreadId = currentSessionId;
      currentSessionMode = 'chat';
      currentSessionFirstUserMsg = null;
      currentSessionMessageCount = 0;
      currentSessionProjectId = null;
      config.currentSessionProjectName = null;
      syncSessionConfig({ clearJsonl: true });
      sendStatus('session', gatewayReset?.ok ? 'Session reset' : 'Session reset — gateway reset unavailable');
    }

    return {
      success: true,
      gatewayReset: Boolean(gatewayReset?.ok),
      sessionKey: gatewayReset?.key || resetSessionKey,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('sessions:list', async () => {
  // Try with archived filter first, fall back if column doesn't exist yet
  let rows = queryContinuityDB(
    'SELECT id, title, mode, project_id, started_at, ended_at, message_count, jsonl_file FROM sessions WHERE archived IS NULL OR archived = 0 ORDER BY started_at DESC LIMIT 50'
  );
  if (rows === null) {
    // Column may not exist yet — try without filter
    rows = queryContinuityDB(
      'SELECT id, title, mode, project_id, started_at, ended_at, message_count FROM sessions ORDER BY started_at DESC LIMIT 50'
    );
  }
  return rows || [];
});

ipcMain.handle('sessions:archive', async (_event, sessionId) => {
  writeContinuityDB('UPDATE sessions SET archived = 1 WHERE id = ?', [sessionId]);
  return { ok: true };
});

// Load a specific session's messages for historical viewing
ipcMain.handle('sessions:load', async (_event, sessionId) => {
  try {
    // Look up session metadata
    const rows = queryContinuityDB(
      'SELECT id, title, mode, started_at, jsonl_file FROM sessions WHERE id = ?', [sessionId]
    );
    const session = rows && rows.length > 0 ? rows[0] : null;
    if (!session) return { error: 'Session not found' };

    const sessionsDir = path.join(require('os').homedir(), '.openclaw-cotw', 'agents', 'trail-guide', 'sessions');
    let sessionFile = null;

    // Primary: use stored jsonl_file
    if (session.jsonl_file) {
      const candidate = path.join(sessionsDir, session.jsonl_file);
      if (fs.existsSync(candidate)) sessionFile = candidate;
    }

    // Fallback: find JSONL file by timestamp proximity
    if (!sessionFile && session.started_at) {
      const targetTime = new Date(session.started_at).getTime();
      const files = fs.readdirSync(sessionsDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({
          name: f,
          path: path.join(sessionsDir, f),
          mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs,
        }))
        .sort((a, b) => Math.abs(a.mtime - targetTime) - Math.abs(b.mtime - targetTime));
      if (files.length > 0 && Math.abs(files[0].mtime - targetTime) < 24 * 3600 * 1000) {
        sessionFile = files[0].path;
      }
    }

    if (!sessionFile) return { error: 'Session file not found', title: session.title, mode: session.mode };

    // Parse JSONL — reuse same filtering logic as chat:get-history
    const lines = fs.readFileSync(sessionFile, 'utf8').trim().split('\n');
    const messages = [];

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type !== 'message') continue;
        const msg = event.message;
        if (!msg || !msg.role) continue;
        if (msg.role !== 'user' && msg.role !== 'assistant') continue;

        let text = '';
        if (typeof msg.content === 'string') {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          text = msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
        }

        // Filter out system context blocks and heartbeat responses
        if (text.includes('[CONTINUITY CONTEXT]') || text.includes('[YOUR WORKING MEMORY]')
            || text.includes('[STABILITY CONTEXT]') || text.includes('[YOUR COHERENCE]')
            || text.includes('[Chat messages since') || text.includes('This is your context. Use it directly')
            || text.includes('[SESSION HANDOFF') || text.includes('[WHAT YOU REMEMBER FROM LAST SESSION]')
            || text.includes('[PROJECT CONTEXT') || text.includes('[NIGHTSHIFT REPORT')
            || text.includes('[WHAT YOU THOUGHT ABOUT OVERNIGHT]')
            || text.trim() === 'HEARTBEAT_OK') {
          continue;
        }

        if (text.trim()) {
          messages.push({ role: msg.role, content: text.substring(0, 3000) });
        }
      } catch { /* skip malformed */ }
    }

    return {
      messages,
      title: session.title,
      mode: session.mode,
      started_at: session.started_at,
      isHistorical: true
    };
  } catch (err) {
    console.error('[sessions:load] Error:', err.message);
    return { error: err.message };
  }
});

// Search sessions by message content via continuity.db FTS
ipcMain.handle('sessions:search', async (_event, query) => {
  if (!query || query.trim().length < 2) return [];
  try {
    // Search the FTS index for matching exchanges, then group by date to find related sessions
    const searchTerm = query.trim().replace(/"/g, '').replace(/'/g, '');
    const rows = queryContinuityDB(
      `SELECT e.id, e.date, e.user_text, e.agent_text, e.topic_tags
       FROM exchanges e
       WHERE e.user_text LIKE '%' || ? || '%' OR e.agent_text LIKE '%' || ? || '%'
       ORDER BY e.created_at DESC LIMIT 30`,
      [searchTerm, searchTerm]
    );
    if (!rows || rows.length === 0) return [];

    // Match exchanges to sessions by date proximity
    const sessions = queryContinuityDB(
      'SELECT id, title, mode, started_at, ended_at FROM sessions WHERE archived IS NULL OR archived = 0 ORDER BY started_at DESC LIMIT 100'
    ) || [];

    const results = [];
    const seenSessions = new Set();

    for (const row of rows) {
      // Find the session this exchange belongs to by date overlap
      const exchangeDate = row.date ? new Date(row.date).getTime() : 0;
      let matchedSession = null;
      for (const s of sessions) {
        const start = s.started_at ? new Date(s.started_at).getTime() : 0;
        const end = s.ended_at ? new Date(s.ended_at).getTime() : Date.now();
        if (exchangeDate >= start - 60000 && exchangeDate <= end + 60000) {
          matchedSession = s;
          break;
        }
      }
      const sessionId = matchedSession?.id || null;
      if (sessionId && seenSessions.has(sessionId)) continue;
      if (sessionId) seenSessions.add(sessionId);

      // Build snippet from matching text
      const matchText = row.user_text?.toLowerCase().includes(searchTerm.toLowerCase())
        ? row.user_text : row.agent_text;
      const idx = matchText?.toLowerCase().indexOf(searchTerm.toLowerCase()) || 0;
      const start = Math.max(0, idx - 40);
      const snippet = (start > 0 ? '...' : '') +
        (matchText || '').substring(start, start + 120).trim() +
        (start + 120 < (matchText || '').length ? '...' : '');

      results.push({
        sessionId,
        title: matchedSession?.title || row.date || 'Unknown',
        mode: matchedSession?.mode || 'chat',
        snippet,
        date: row.date
      });
    }
    return results;
  } catch (err) {
    console.error('[sessions:search] Error:', err.message);
    return [];
  }
});

const MAX_HISTORY_TURNS = 40;

function normalizeGatewaySessionKeyPart(value) {
  return String(value || 'session')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'session';
}

function gatewaySessionKeyFor(sessionId = currentSessionId) {
  return `agent:trail-guide:openai:${normalizeGatewaySessionKeyPart(sessionId)}`;
}

function decorateGatewayError(err, requestStartedAt) {
  const error = err instanceof Error ? err : new Error(String(err || 'Gateway request failed'));
  if (isContextOverflowSignal(error.message) || hasOpenClawContextOverflowSince(requestStartedAt)) {
    const overflow = new Error('Context overflow: prompt too large for the model');
    overflow.cause = error;
    overflow.code = 'CONTEXT_OVERFLOW';
    return overflow;
  }
  return error;
}

async function callGatewayRPC(method, params, options = {}) {
  const token = ensureGatewayToken();
  const { GatewayClient } = await import('openclaw/plugin-sdk/gateway-runtime');

  return await new Promise((resolve, reject) => {
    let settled = false;
    let client;
    const timeoutMs = options.timeoutMs || 15000;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { client?.stop(); } catch {}
      reject(new Error(`Gateway RPC timeout for ${method}`));
    }, timeoutMs);

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { client?.stop(); } catch {}
      if (err) reject(err);
      else resolve(value);
    };

    client = new GatewayClient({
      url: `ws://127.0.0.1:${gatewayPort}`,
      token,
      clientName: 'gateway-client',
      clientDisplayName: `cotw-electron:${method}`,
      mode: 'backend',
      role: 'operator',
      scopes: ['operator.admin'],
      minProtocol: 3,
      maxProtocol: 3,
      onHelloOk: async () => {
        try {
          const result = await client.request(method, params, {
            timeoutMs: options.requestTimeoutMs || timeoutMs,
          });
          finish(null, result);
        } catch (err) {
          finish(err);
        }
      },
      onConnectError: (err) => finish(err),
      onClose: (code, reason) => {
        if (!settled) finish(new Error(`Gateway RPC closed (${code}): ${reason || 'no reason'}`));
      },
    });

    try {
      client.start();
    } catch (err) {
      finish(err);
    }
  });
}

const CHAT_ATTACHMENT_MAX_BYTES = 15 * 1024 * 1024;
const CHAT_DOCUMENT_TEXT_LIMIT = 40000;

function normalizeChatAttachments(attachments) {
  return (Array.isArray(attachments) ? attachments : [])
    .map(normalizeChatAttachment)
    .filter(Boolean);
}

function normalizeChatAttachment(attachment) {
  if (!attachment || typeof attachment !== 'object') return null;
  const base64 = String(attachment.base64 || '').trim();
  const text = String(attachment.text || '');
  const name = String(attachment.name || 'attachment').trim() || 'attachment';
  const mimeType = String(attachment.mimeType || 'application/octet-stream').trim() || 'application/octet-stream';
  const sourcePath = String(attachment.sourcePath || '').trim();
  const declaredKind = String(attachment.kind || '').toLowerCase();
  const kind = declaredKind === 'document' || declaredKind === 'file'
    ? 'document'
    : /^image\//i.test(mimeType) || declaredKind === 'image'
      ? 'image'
      : 'document';
  const size = Number.isFinite(Number(attachment.size)) ? Number(attachment.size) : estimateAttachmentSize(base64, text);
  if (size > CHAT_ATTACHMENT_MAX_BYTES) {
    throw new Error(`${name} is larger than 15 MB.`);
  }
  if (kind === 'image') {
    if (!base64 || !/^image\//i.test(mimeType)) return null;
    return { kind: 'image', base64, mimeType, name, size, sourcePath };
  }
  return { kind: 'document', base64, text, mimeType, name, size, sourcePath };
}

function estimateAttachmentSize(base64, text) {
  if (base64) return Math.ceil(base64.length * 0.75);
  return Buffer.byteLength(String(text || ''), 'utf8');
}

function buildDocumentAttachmentContext(attachments) {
  const documents = (Array.isArray(attachments) ? attachments : []).filter(attachment => attachment.kind === 'document');
  if (documents.length === 0) return '';
  const blocks = documents.map((document, index) => {
    const text = String(document.text || '').trim();
    const label = documents.length === 1 ? 'Attached document' : `Attached document ${index + 1}`;
    const header = `[${label}: ${document.name} | ${document.mimeType} | ${formatBytesForPrompt(document.size)}]`;
    if (!text) {
      return `${header}\nNo extracted text was provided for this file. Use the filename/type as attachment context and ask for pasted/exported text if the document contents matter.`;
    }
    const truncated = text.length > CHAT_DOCUMENT_TEXT_LIMIT
      ? `${text.slice(0, CHAT_DOCUMENT_TEXT_LIMIT)}\n\n[Document truncated at ${CHAT_DOCUMENT_TEXT_LIMIT} characters.]`
      : text;
    return `${header}\n${truncated}`;
  });
  return blocks.join('\n\n');
}

function formatBytesForPrompt(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function normalizeGatewayImageAttachment(image) {
  if (!image || typeof image !== 'object') return null;
  const base64 = String(image.base64 || '').trim();
  if (!base64) return null;
  const mimeType = String(image.mimeType || 'image/png').trim() || 'image/png';
  if (!/^image\//i.test(mimeType)) return null;
  return { base64, mimeType };
}

function buildOpenAiUserContent(message, images) {
  const normalizedImages = Array.isArray(images)
    ? images.map(normalizeGatewayImageAttachment).filter(Boolean)
    : [];
  if (normalizedImages.length === 0) return message;
  const parts = [];
  const text = String(message || '').trim();
  if (text) parts.push({ type: 'text', text });
  for (const image of normalizedImages) {
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${image.mimeType};base64,${image.base64}` },
    });
  }
  return parts;
}

function modelSupportsImageInput(model) {
  if (!model || typeof model !== 'object') return false;
  const declared = []
    .concat(model.input || [])
    .concat(model.inputs || [])
    .concat(model.modalities || [])
    .concat(model.capabilities || []);
  return declared.map(v => String(v || '').toLowerCase()).some(v => v === 'image' || v === 'vision');
}

function getModelConfigKey(model) {
  if (typeof model === 'string') return model;
  if (!model || typeof model !== 'object') return null;
  return model.id || model.name || model.model || null;
}

function findConfiguredOllamaVisionModel(runtimeConfig) {
  runtimeConfig = runtimeConfig || {};
  const ollama = runtimeConfig?.models?.providers?.ollama || {};
  const models = Array.isArray(ollama.models) ? ollama.models : [];
  const explicit = String(
    ollama.visionModel
      || ollama.vision?.model
      || runtimeConfig?.cotw?.ollamaVisionModel
      || ''
  ).trim();

  if (explicit) {
    const declared = models.find(model => getModelConfigKey(model) === explicit);
    if (!declared) {
      throw new Error(`Ollama vision model "${explicit}" is not declared in openclaw.json models.providers.ollama.models.`);
    }
    if (!modelSupportsImageInput(declared)) {
      throw new Error(`Ollama vision model "${explicit}" is declared, but its input list does not include "image".`);
    }
    return explicit;
  }

  const imageModel = models.find(model => modelSupportsImageInput(model));
  const modelId = getModelConfigKey(imageModel);
  if (!modelId) {
    throw new Error('No Ollama vision model is configured. Add an Ollama model with input including "image" to openclaw.json models.providers.ollama.models.');
  }
  return modelId;
}

function readRuntimeOpenClawConfig() {
  const runtimePath = runtimeOpenClawConfigPath();
  if (!fs.existsSync(runtimePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
  } catch {
    return {};
  }
}

async function processOllamaVision(imageBase64, options = {}) {
  const runtimeConfig = options.runtimeConfig || readRuntimeOpenClawConfig();
  const model = options.model || findConfiguredOllamaVisionModel(runtimeConfig);
  const raw = await httpPost('http://localhost:11434/api/generate', {
    model,
    prompt: 'Describe what you see in this image. Be specific about objects, people, text, colors, and spatial relationships.',
    images: [imageBase64],
    stream: false,
    options: { temperature: 0.2, num_predict: 500 }
  });
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const response = String(parsed?.response || '').trim();
  if (!response) throw new Error(`Ollama vision model "${model}" returned an empty response.`);
  return response;
}

async function prepareGatewayImageInput(message, images, options = {}) {
  const normalizedImages = Array.isArray(images)
    ? images.map(normalizeGatewayImageAttachment).filter(Boolean)
    : [];
  if (normalizedImages.length === 0) return { message, images: undefined, route: 'none' };

  const runtimeConfig = options.runtimeConfig || readRuntimeOpenClawConfig();
  const providerId = summarizeSelectedProvider(runtimeConfig).providerId;
  if (providerId !== 'ollama') {
    return { message, images: normalizedImages, route: 'native-image-parts' };
  }

  const descriptions = [];
  for (const [index, image] of normalizedImages.entries()) {
    const description = await processOllamaVision(image.base64, { runtimeConfig });
    descriptions.push(normalizedImages.length === 1
      ? `[Image: ${description}]`
      : `[Image ${index + 1}: ${description}]`);
  }

  const text = String(message || '').trim();
  return {
    message: text ? `${descriptions.join('\n')}\n\n${text}` : descriptions.join('\n'),
    images: undefined,
    route: 'ollama-vision-prepass',
  };
}

function stableToolList(toolEvents = []) {
  const seen = new Set();
  const tools = [];
  for (const event of Array.isArray(toolEvents) ? toolEvents : []) {
    const name = String(event?.name || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    tools.push(name);
  }
  return tools;
}

function buildForegroundCompletionFallback(toolEvents = [], recoveryAttempt = null) {
  const tools = stableToolList(toolEvents).slice(0, 6);
  const toolText = tools.length ? ` I saw tool work from: ${tools.join(', ')}.` : '';
  const recoveryText = renderRecoveryFallbackDetails(recoveryAttempt);
  return `I used tools, but the turn ended before I gave you a final answer.${toolText}\n\nI’m not going to pretend that’s complete. The honest state is: tool work happened, and this still needs a real follow-up with the result or blocker.${recoveryText}`;
}

function isForegroundCompletionFallbackText(text) {
  return /^I used tools, but the turn ended before I gave you a final answer\./.test(String(text || '').trim());
}

function buildVisibleToolFallbackContinuationPrompt({ originalTask, fallbackText }) {
  return [
    '[VISIBLE TOOL FALLBACK CONTINUATION]',
    'Your previous visible message told the user that tool work happened but the turn ended before a real final answer.',
    'Continue now in a normal user-visible response. Do not repeat the fallback wording.',
    'Prefer a concise result if the available context is enough. If it is not enough, state the exact blocker and the next safest step.',
    'Do not call more tools unless there is no honest way to answer or name the blocker from the current context.',
    '',
    'Original user task:',
    String(originalTask || '').slice(0, 4000),
    '',
    'Fallback already shown to the user:',
    String(fallbackText || '').slice(0, 4000),
    '[/VISIBLE TOOL FALLBACK CONTINUATION]',
  ].join('\n');
}

function buildEvidenceRecoveryContinuationPrompt({ originalTask, recoveryAttempt }) {
  const result = recoveryAttempt?.recoveryResult || {};
  const packet = recoveryAttempt?.packet || {};
  const action = recoveryAttempt?.nextAction || {};
  const output = typeof result.output === 'string' ? result.output : '';
  return [
    '[EVIDENCE RECOVERY CONTINUATION]',
    'The previous foreground turn used tools but ended before producing a final user-visible handoff.',
    'Do not call more tools unless the provided receipt is insufficient. Use the recovery receipt below to complete the original task concisely.',
    '',
    'Original user task:',
    String(originalTask || '').slice(0, 4000),
    '',
    'Recovery packet:',
    JSON.stringify({
      packetHash: packet.packetHash,
      originalTask: packet.originalTask,
      workScope: packet.workScope,
      failure: packet.failure,
      currentState: packet.currentState,
      nextAction: action,
      stopCondition: packet.stopCondition,
      principleBinding: packet.principleBinding,
      recovered: recoveryAttempt?.recovered === true,
      coverageAfterRecovery: recoveryAttempt?.coverageAfterRecovery,
    }, null, 2),
    '',
    'Recovery receipt:',
    JSON.stringify({
      ok: result.ok === true,
      tool: result.tool,
      path: result.path,
      offset: result.offset,
      partial: result.partial,
      truncated: result.truncated,
      nextOffset: result.nextOffset,
      totalChars: result.totalChars,
      receipt: result.receipt,
      error: result.error,
    }, null, 2),
    output ? `\nRecovered evidence excerpt:\n${output.slice(0, 12000)}` : '',
    '[/EVIDENCE RECOVERY CONTINUATION]',
  ].filter(Boolean).join('\n');
}

async function continueAfterEvidenceRecovery({ originalTask, recoveryAttempt, parentRequestId }) {
  if (!recoveryAttempt?.recoveryResult?.ok) return null;
  const prompt = buildEvidenceRecoveryContinuationPrompt({ originalTask, recoveryAttempt });
  try {
    const continued = await callGatewayHTTP(prompt, {
      internalOnly: true,
      hideUserFromHistory: true,
      disableEvidenceRecovery: true,
      originalUserText: originalTask,
      metadata: {
        synthetic_source: 'evidence_recovery_continuation',
        parent_electron_request_id: parentRequestId,
      },
    });
    if (/^I used tools, but the turn ended before I gave you a final answer\./.test(String(continued || '').trim())) {
      return null;
    }
    return continued;
  } catch (err) {
    logStreamDebug('evidence-recovery-continuation-error', {
      parentRequestId,
      error: err.message,
    });
    return null;
  }
}

function buildCompletionObligationPacket(input) {
  input = input || {};
  const required = input.required === true;
  const reasonCodes = Array.isArray(input.reasonCodes) ? input.reasonCodes : [];
  const resolution = input.resolution || null;
  const fallback = input.fallback === true;
  const toolEvents = Array.isArray(input.toolEvents) ? input.toolEvents : [];
  return {
    required,
    reasonCodes,
    resolution,
    fallback,
    toolCount: stableToolList(toolEvents).length
  };
}

function buildLiveTurnOutcomeInput(input) {
  input = input || {};
  const {
    requestId,
    message,
    response,
    toolEvents = [],
    imageCount = 0,
    mode = 'chat',
    startedAt,
    completedAt,
    seenDataEvents = 0,
    reconciled = false,
    threadId = null,
    sessionId = null,
    intentSource = 'current_user_turn',
    authorizationMode = 'current_user_instruction',
    completionObligation = null
  } = input || {};
  if (!requestId) throw new Error('requestId is required');
  const toolsUsed = stableToolList(toolEvents);
  const obligation = completionObligation || buildCompletionObligationPacket({
    required: toolsUsed.length > 0,
    reasonCodes: toolsUsed.length > 0 ? ['foreground_tool_use'] : [],
    resolution: toolsUsed.length > 0 ? 'visible_final_response' : null,
    toolEvents
  });
  const durationMs = Number.isFinite(completedAt) && Number.isFinite(startedAt)
    ? Math.max(0, completedAt - startedAt)
    : null;
  return {
    eventId: `live_turn:${requestId}`,
    eventType: 'live_turn_outcome',
    status: 'observed',
    source: {
      sourceType: 'runtime_event',
      sourceHandle: requestId,
      evidenceClass: 'direct_observation'
    },
    intent: {
      source: intentSource,
      promptPreview: String(message || '').slice(0, 240),
      promptChars: String(message || '').length,
      imageCount: Math.max(0, Number(imageCount) || 0)
    },
    authority: {
      authorizationMode
    },
    action: {
      actionClass: 'chat_turn',
      mode,
      toolsUsed,
      toolCount: toolsUsed.length,
      toolEvents: (Array.isArray(toolEvents) ? toolEvents : []).slice(0, 20).map((event) => ({
        name: String(event?.name || '').slice(0, 120),
        source: String(event?.source || 'unknown').slice(0, 80),
        phase: String(event?.phase || 'observed').slice(0, 40)
      })),
      threadId,
      sessionId
    },
    observed: {
      completed: true,
      responseChars: String(response || '').length,
      durationMs,
      seenDataEvents,
      streamReconciled: reconciled === true,
      completionObligation: obligation
    },
    verification: {
      status: 'checked',
      method: 'gateway_stream_completed',
      evidence: {
        streamCompleted: true,
        responseReceived: String(response || '').length > 0,
        toolCount: toolsUsed.length
      }
    },
    rollback: {
      available: false,
      plan: 'append-only observation; supersede with a later corrective outcome if needed'
    },
    learning: {
      eligibleForMaturation: false,
      prohibitionReason: 'live turn telemetry is audit evidence, not prompt-context memory'
    },
    privacy: {
      privacyTier: 'local_private'
    }
  };
}

function buildLiveTurnContextEligibilityReviewInput(outcomePacket, input) {
  input = input || {};
  if (!outcomePacket?.eventId) throw new Error('outcome event packet is required');
  return {
    reviewId: `context-eligibility:live_turn:${outcomePacket.eventId}`,
    packet: outcomePacket,
    requestedConsumer: 'context_injection',
    authority: {
      hasExplicitContextApproval: false,
      activeLeaseId: null,
      source: 'runtime_shadow_filter'
    },
    risk: {
      sensitivity: input.sensitivity || 'low'
    },
    reasonCodes: ['live_turn_shadow_filter']
  };
}

function recordLiveTurnOutcome(input) {
  const packetInput = buildLiveTurnOutcomeInput(input || {});
  const ledgerPath = resolveSpineLedgerPath({ workspacePath });
  const now = new Date().toISOString();
  const outcomePacket = appendOutcomeEventPacket(ledgerPath, packetInput, { now });
  const contextReview = appendContextEligibilityReview(
    ledgerPath,
    buildLiveTurnContextEligibilityReviewInput(outcomePacket),
    { now }
  );
  return { outcomePacket, contextReview };
}

function buildReadOnlyResponsibilityLeaseInput(input) {
  input = input || {};
  const leaseId = input.leaseId || `responsibility-lease:${input.lane || 'runtime'}:${Date.now()}`;
  return {
    leaseId,
    owner: input.owner || 'system',
    executor: input.executor || 'agent',
    objective: input.objective || 'Observe bounded background responsibility',
    status: 'candidate',
    scope: {
      lane: input.lane || 'runtime',
      trigger: input.trigger || 'unknown',
      threadId: input.threadId || null,
      mode: input.mode || 'read_only_registry'
    },
    authority: {
      sourceType: input.sourceType || 'system_signal',
      sourceHandle: input.sourceHandle || null,
      allowedActions: [],
      prohibitedActions: ['prompt_context_injection', 'scheduler_linkage', 'runtime_config_mutation', 'tool_policy_mutation', 'external_action_without_approval'],
      approvalRequiredFor: ['mutation', 'external_effect', 'authority_expansion']
    },
    successCriteria: input.successCriteria || ['responsibility is visible in the read-only registry'],
    nonGoals: input.nonGoals || ['grant authority', 'inject prompt context', 'schedule new work', 'mutate runtime configuration'],
    budgets: input.budgets || { reviewOnly: true },
    review: {
      renewalPolicy: 'explicit_only'
    },
    source: {
      sourceType: input.sourceType || 'system_signal',
      sourceHandle: input.sourceHandle || null,
      createdByEvent: input.createdByEvent || null
    }
  };
}

function recordReadOnlyResponsibilityLease(input) {
  return appendResponsibilityLeasePacket(
    resolveSpineLedgerPath({ workspacePath }),
    buildReadOnlyResponsibilityLeaseInput(input),
    { now: new Date().toISOString() }
  );
}

function inferRuntimeToolTarget(args) {
  if (!args) return null;
  let value = args;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return trimmed.slice(0, 160);
    }
  }
  if (!value || typeof value !== 'object') return null;
  for (const key of ['path', 'filePath', 'target', 'to', 'recipient', 'channel', 'url', 'command']) {
    if (value[key]) return String(value[key]).slice(0, 160);
  }
  return null;
}

async function callGatewayHTTP(message, options = {}) {
  const token = ensureGatewayToken();
  const url = `http://localhost:${gatewayPort}/v1/chat/completions`;
  const requestId = `stream_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const requestStartedAt = Date.now();

  // Isolated mode — Phase C of the contemplation port. For autonomous
  // background tasks that should NOT surface in the main chat UI or
  // pollute the agent's main conversation history. Each isolated call
  // gets its own thread_id so the continuity plugin archives it in a
  // separate thread, and renderer IPC + conversationHistory mutations
  // are skipped so the main-chat experience is untouched.
  const isolated = !!options.isolated;
  const internalOnly = !!options.internalOnly;
  const suppressMainChat = isolated || internalOnly;
  const hideUserFromHistory = !!options.hideUserFromHistory;
  const effectiveThreadId = isolated
    ? `isolated-${options.isolationTag || 'task'}-${Date.now()}`
    : currentThreadId;
  const gatewaySessionKey = isolated
    ? gatewaySessionKeyFor(effectiveThreadId)
    : gatewaySessionKeyFor(currentSessionId);

  // Embed thread_id as a marker that the continuity plugin can extract from the prompt.
  // The OpenClaw gateway doesn't pass request metadata to plugin hooks,
  // so we inject it as a system message at the start — the plugin scans event.prompt
  // for [THREAD:...] regardless of where it appears. This keeps the user message clean
  // so the agent never sees or echoes the marker.
  const threadMsg = effectiveThreadId
      ? [{ role: 'system', content: `[THREAD:${effectiveThreadId}]` }]
      : [];
  // Session resume marker — tells plugins the gateway restarted but Electron is still alive,
  // so conversationHistory has the real messages and handoff injection is redundant.
  // Uses both prompt marker (reliable) and metadata (clean) following the [THREAD:...] pattern.
  // Skipped for isolated runs — they start with no prior history by design.
  const resumeMsg = (!suppressMainChat && gatewayRestarted)
      ? [{ role: 'system', content: '[SESSION_RESUME]' }]
      : [];
  const rolloverBridgeMsg = (!suppressMainChat && pendingRolloverBridge)
      ? [{ role: 'system', content: pendingRolloverBridge }]
      : [];
  const newTaskBoundaryMsg = (!suppressMainChat && pendingNewTaskBoundary)
      ? [{ role: 'system', content: pendingNewTaskBoundary }]
      : [];
  const baseHistory = isolated ? [] : conversationHistory;
  const userContent = buildOpenAiUserContent(message, options.images);
  const messages = [...threadMsg, ...resumeMsg, ...rolloverBridgeMsg, ...newTaskBoundaryMsg, ...baseHistory, { role: 'user', content: userContent }];

  const body = {
    model: 'agent:trail-guide',
    messages,
    stream: true,
    metadata: {
      codeMode: !suppressMainChat && (trainingGroundsActive || false),
      thread_id: effectiveThreadId,
      electron_request_id: requestId,
      ...(!suppressMainChat && gatewayRestarted ? { session_resume: true } : {}),
      ...(isolated ? { isolated: true, isolation_tag: options.isolationTag || 'task' } : {}),
      ...(options.metadata || {})
    },
    ...(options.params || {}),
  };

  // Track active stream state for recovery on abort — main-chat runs only.
  // Touching these during an isolated run would corrupt the main chat's
  // retry buffer if the user aborted a prior message mid-background-task.
  if (!suppressMainChat) {
    activeStreamContent = '';
    activeStreamMessage = hideUserFromHistory ? '' : message;
    emitChatActivity({ phase: 'request-start', requestId });
    logStreamDebug('request-start', {
      requestId,
      messageLength: String(message || '').length,
      sessionId: currentSessionId,
      threadId: effectiveThreadId,
      gatewaySessionKey,
    });
  }

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = JSON.stringify(body);

    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization': `Bearer ${token}`,
        'X-OpenClaw-Session-Key': gatewaySessionKey,
        'X-OpenClaw-Message-Channel': 'webchat',
        'X-COTW-Electron-Request-Id': requestId,
      },
      timeout: 300000, // 5 min socket idle timeout — tool calls can take a while
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let errData = '';
        res.on('data', c => errData += c);
        res.on('end', () => reject(decorateGatewayError(new Error(`HTTP ${res.statusCode}: ${errData}`), requestStartedAt)));
        return;
      }

      let fullContent = '';
      let buffer = '';
      let lastDataTime = Date.now();
      let streamCompleted = false;
      let streamError = null;
      let seenDataEvents = 0;
      let sawToolCall = false;
      let streamReconciled = false;
      let completionObligationFallback = false;
      let contentLengthAtLastToolActivity = null;
      const activeGatewayToolCalls = new Map();
      const runtimePreflightToolIds = new Set();
      const observedToolEvents = [];
      const noteObservedTool = (name, source, phase = 'start', details = {}) => {
        const safeName = String(name || '').trim();
        if (!safeName) return;
        observedToolEvents.push({ name: safeName, source, phase, ...(details && typeof details === 'object' ? details : {}) });
        const normalizedPhase = String(phase || '').toLowerCase();
        if (['start', 'observed', 'done', 'failed', 'error'].includes(normalizedPhase)) {
          contentLengthAtLastToolActivity = fullContent.length;
        }
      };
      const recordObservedRuntimeToolPreflight = (name, args, source, toolCallId = '') => {
        if (suppressMainChat) return;
        const safeName = String(name || '').trim();
        if (!safeName) return;
        const key = String(toolCallId || `${source}:${safeName}:${runtimePreflightToolIds.size}`);
        if (runtimePreflightToolIds.has(key)) return;
        runtimePreflightToolIds.add(key);
        try {
          recordRuntimeActionShadowPreflight(resolveSpineLedgerPath({ workspacePath }), {
            requestId: `${requestId}:tool:${key}`,
            requestedAction: {
              tool: safeName,
              action: safeName,
              target: inferRuntimeToolTarget(args),
              summary: `Observed runtime tool activity from ${source}`
            },
            authority: {
              hasCurrentInstruction: options.metadata?.synthetic_source ? false : true,
              toolCapabilityPresent: true,
              source
            },
            source: {
              sourceType: 'gateway_tool_event',
              sourceHandle: requestId
            },
            now: new Date().toISOString()
          });
        } catch (err) {
          console.warn('[Spine] Failed to record runtime tool shadow preflight:', err.message);
        }
      };

      // Reset socket timeout on each data chunk — as long as data is flowing,
      // the connection is alive. Tool calls send heartbeat chunks.
      res.on('data', (chunk) => {
        lastDataTime = Date.now();
        req.setTimeout(300000); // reset idle timer on each chunk

        buffer += chunk.toString();
        // Parse SSE lines
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line in buffer

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            streamCompleted = true;
            continue;
          }

          try {
            const parsed = JSON.parse(data);
            seenDataEvents++;
            if (parsed.error) {
              const errMsg = typeof parsed.error === 'string'
                ? parsed.error
                : (parsed.error.message || JSON.stringify(parsed.error));
              streamError = new Error(errMsg);
              if (!suppressMainChat) lastMainStreamFailureAt = Date.now();
              logStreamDebug('provider-error-event', { requestId, error: errMsg });
              continue;
            }
            const choice = parsed.choices?.[0];
            const delta = choice?.delta?.content || '';
            const thinkingDelta = parsed.thinking || choice?.delta?.thinking || choice?.delta?.reasoning || '';
            if (!suppressMainChat && seenDataEvents === 1) {
              emitChatActivity({
                phase: 'stream-first-event',
                requestId,
                hasDelta: !!delta,
                hasThinking: !!thinkingDelta,
                keys: Object.keys(parsed).slice(0, 8),
              });
            }
            if (delta) {
              // Diagnostic: detect missing space after sentence-ending punctuation
              if (fullContent.length > 0) {
                const lastChar = fullContent[fullContent.length - 1];
                const firstChar = delta[0];
                if (/[.!?]/.test(lastChar) && firstChar && /[A-Z]/.test(firstChar)) {
                  console.error(`[STREAM-SPACE-DEBUG] Missing space detected: "...${fullContent.slice(-20)}" + "${delta.slice(0, 20)}"`);
                }
              }
              fullContent += delta;
              if (!suppressMainChat) {
                activeStreamContent = fullContent; // track for recovery on abort
                mainWindow?.webContents.send('chat:stream-chunk', { delta });
              }
            }
            // Detect tool calls in both raw OpenAI tool-call deltas and OpenClaw's
            // gateway-side agent-event bridge. The OpenAI-compatible endpoint streams
            // assistant text as normal Chat Completions chunks, while OpenClaw tool
            // execution is surfaced in an `openclaw_event` side-channel chunk.
            const openclawEvent = parsed.openclaw_event || parsed.openclawEvent;
            if (openclawEvent) {
              const stream = String(openclawEvent.stream || '');
              const eventData = openclawEvent.data || {};
              const phase = String(eventData.phase || '').toLowerCase();
              const kind = String(eventData.kind || '').toLowerCase();
              const isRecoveryLike = stream === 'recovery' || kind === 'recovery';
              if (isRecoveryLike) {
                const recoveryPhase = phase || 'mid_turn_recovery_event';
                if (!suppressMainChat) {
                  logStreamDebug('mid-turn-recovery-event', {
                    requestId,
                    phase: recoveryPhase,
                    route: eventData.route,
                    estimatedPromptTokens: eventData.estimatedPromptTokens,
                    promptBudget: eventData.promptBudget,
                    overflowTokens: eventData.overflowTokens,
                  });
                  emitChatActivity({
                    phase: recoveryPhase,
                    requestId,
                    route: eventData.route,
                    estimatedPromptTokens: eventData.estimatedPromptTokens,
                    promptBudget: eventData.promptBudget,
                    overflowTokens: eventData.overflowTokens,
                    recovery: true,
                  });
                }
              }
              const isItemStream = stream === 'item' || stream.endsWith('.item');
              const isToolLike = stream === 'tool'
                || stream === 'command_output'
                || stream === 'patch'
                || kind === 'tool'
                || kind === 'command'
                || kind === 'patch'
                || kind === 'search';
              if (isToolLike || isItemStream) {
                const fallbackName = stream === 'command_output'
                  ? 'exec'
                  : stream === 'patch'
                    ? 'apply_patch'
                    : '';
                const name = eventData.name || eventData.title || fallbackName;
                const toolCallId = eventData.toolCallId || eventData.itemId || name;
                const startPhases = new Set(['start', 'started', 'running', 'requested']);
                const donePhases = new Set(['result', 'end', 'completed', 'complete', 'done', 'failed', 'error']);
                if (name && startPhases.has(phase)) {
                  sawToolCall = true;
                  const isDuplicateStart = activeGatewayToolCalls.has(toolCallId);
                  activeGatewayToolCalls.set(toolCallId, name);
                  if (!isDuplicateStart) {
                    const toolArgs = eventData.args || eventData.meta || eventData.command || eventData.query;
                    noteObservedTool(name, `openclaw_event:${stream}`, 'start', { args: toolArgs, result: eventData.result });
                    recordObservedRuntimeToolPreflight(name, toolArgs, `openclaw_event:${stream}`, toolCallId);
                    if (!suppressMainChat) {
                      pendingToolCalls.push({ name, args: toolArgs, startedAt: Date.now() });
                      logStreamDebug('tool-call-start', { requestId, name, source: `openclaw_event:${stream}` });
                      emitChatActivity({ phase: 'tool-call-start', requestId, name });
                      mainWindow?.webContents.send('chat:tool-call', { name, args: toolArgs, status: 'start' });
                    }
                  }
                } else if (donePhases.has(phase)) {
                  const completedName = name || activeGatewayToolCalls.get(toolCallId) || '';
                  activeGatewayToolCalls.delete(toolCallId);
                  noteObservedTool(completedName, `openclaw_event:${stream}`, 'done', { args: eventData.args || eventData.meta, result: eventData.result || eventData });
                  if (!suppressMainChat) {
                    emitChatActivity({ phase: 'tool-call-done', requestId, name: completedName });
                    mainWindow?.webContents.send('chat:tool-call', { name: completedName, status: 'done' });
                  }
                } else if (name && stream === 'command_output' && !activeGatewayToolCalls.has(toolCallId)) {
                  sawToolCall = true;
                  const toolArgs = eventData.command || eventData.output;
                  noteObservedTool(name, `openclaw_event:${stream}`, 'observed', { args: toolArgs, result: eventData.result || eventData });
                  recordObservedRuntimeToolPreflight(name, toolArgs, `openclaw_event:${stream}`, toolCallId);
                  if (!suppressMainChat) {
                    logStreamDebug('tool-call-observed', { requestId, name, source: `openclaw_event:${stream}` });
                    mainWindow?.webContents.send('chat:tool-call', { name, args: toolArgs, status: 'observed' });
                  }
                }
              }
            }
            const toolCalls = choice?.delta?.tool_calls || parsed.choices?.[0]?.message?.tool_calls;
            if (toolCalls) {
              sawToolCall = true;
              for (const tc of toolCalls) {
                const name = tc.function?.name || tc.name;
                if (name) {
                  const toolArgs = tc.function?.arguments;
                  noteObservedTool(name, 'openai_delta', 'start', { args: toolArgs });
                  recordObservedRuntimeToolPreflight(name, toolArgs, 'openai_delta', tc.id || name);
                  if (!suppressMainChat) {
                    pendingToolCalls.push({ name, args: toolArgs, startedAt: Date.now() });
                    logStreamDebug('tool-call-start', { requestId, name, source: 'openai_delta' });
                    emitChatActivity({ phase: 'tool-call-start', requestId, name });
                    mainWindow?.webContents.send('chat:tool-call', { name, args: toolArgs, status: 'start' });
                  }
                }
              }
            }
            // ── Infinite Threads: Check for consolidation restart signal ──
            // Plugin's agent_end hook may include metadata in the response
            const pluginMetadata = parsed.metadata || parsed.choices?.[0]?.metadata;
            if (pluginMetadata?.consolidation_restart) {
              console.log(`[InfiniteThreads] Consolidation restart signaled for thread ${pluginMetadata.thread_id}`);
              // Schedule restart after stream completes (don't interrupt mid-stream)
              process.nextTick(() => handleConsolidationRestart(pluginMetadata.thread_id));
            }

            // Detect finish_reason for tool call completion
            const finishReason = choice?.finish_reason || parsed.choices?.[0]?.finish_reason;
            if (finishReason === 'stop') streamCompleted = true;
            if (finishReason === 'tool_calls' || finishReason === 'stop') {
              // 'stop' with no content but tool calls present = tool round complete
              if (finishReason === 'tool_calls' || (finishReason === 'stop' && !delta && toolCalls)) {
                if (!suppressMainChat) {
                  mainWindow?.webContents.send('chat:tool-call', { status: 'done' });
                }
              }
            }
          } catch { /* skip malformed chunks */ }
        }
      });

      res.on('end', async () => {
        // Process any remaining buffer
        if (buffer.startsWith('data: ') && buffer.slice(6).trim() !== '[DONE]') {
          try {
            const parsed = JSON.parse(buffer.slice(6));
            if (parsed.error) {
              const errMsg = typeof parsed.error === 'string'
                ? parsed.error
                : (parsed.error.message || JSON.stringify(parsed.error));
              streamError = new Error(errMsg);
            }
            const finalFinishReason = parsed.choices?.[0]?.finish_reason;
            if (finalFinishReason === 'stop') streamCompleted = true;
            const delta = parsed.choices?.[0]?.delta?.content || '';
            if (delta) {
              fullContent += delta;
              if (!suppressMainChat) {
                activeStreamContent = fullContent;
                mainWindow?.webContents.send('chat:stream-chunk', { delta });
              }
            }
          } catch { /* skip */ }
        } else if (buffer.trim() === 'data: [DONE]' || buffer.trim() === '[DONE]') {
          streamCompleted = true;
        }

        let preliminaryFailure = null;
        if (streamError) {
          preliminaryFailure = decorateGatewayError(streamError, requestStartedAt);
        } else if (!streamCompleted) {
          preliminaryFailure = decorateGatewayError(new Error('Gateway stream ended before a final response marker'), requestStartedAt);
        } else if (!fullContent.trim() && !sawToolCall) {
          preliminaryFailure = decorateGatewayError(new Error('Gateway stream ended with an empty final response'), requestStartedAt);
        }

        if (preliminaryFailure && !suppressMainChat) {
          const recovered = await maybeRecoverFailedStream({
            requestId,
            requestStartedAt,
            content: fullContent,
            seenDataEvents,
            error: preliminaryFailure,
          });
          if (recovered?.content) {
            fullContent = recovered.content;
            streamError = null;
            streamCompleted = true;
            streamReconciled = true;
            preliminaryFailure = null;
          }
        }

        if (streamError) {
          streamError = decorateGatewayError(streamError, requestStartedAt);
          if (!suppressMainChat) {
            lastMainStreamFailureAt = Date.now();
            logStreamDebug('stream-error', { requestId, error: streamError.message, events: seenDataEvents });
            emitChatActivity({ phase: 'stream-error', requestId, error: streamError.message });
            mainWindow?.webContents.send('chat:stream-error', { error: streamError.message });
          }
          reject(streamError);
          return;
        }

        if (!streamCompleted) {
          const err = decorateGatewayError(new Error('Gateway stream ended before a final response marker'), requestStartedAt);
          if (!suppressMainChat) {
            lastMainStreamFailureAt = Date.now();
            logStreamDebug('stream-error', { requestId, error: err.message, events: seenDataEvents, fullContentLength: fullContent.length });
            emitChatActivity({ phase: 'stream-error', requestId, error: err.message, fullContentLength: fullContent.length });
            mainWindow?.webContents.send('chat:stream-error', { error: err.message });
          }
          reject(err);
          return;
        }

        const postToolContent = contentLengthAtLastToolActivity === null
          ? fullContent
          : fullContent.slice(contentLengthAtLastToolActivity);
        if (sawToolCall && !postToolContent.trim() && options.disableEvidenceRecovery) {
          fullContent = buildForegroundCompletionFallback(observedToolEvents, null);
          completionObligationFallback = true;
          streamReconciled = true;
        } else if (sawToolCall && !postToolContent.trim()) {
          const recoveryAttempt = runRecoveryStep({
            prompt: options.originalUserText || message,
            requestId,
            sessionId: currentSessionId,
            observations: observedToolEvents.map(observationFromToolEvent),
            forceToolEvidence: true,
            workScope: {
              scopeKind: 'foreground_tool_turn',
              workingDirectory: __dirname,
              workspacePath,
              touchedFiles: observedToolEvents
                .map((event) => event?.path || event?.args?.path || event?.result?.path)
                .filter(Boolean),
              boundaries: [
                'resume the original scoped user task',
                'prefer read-only receipt recovery',
                'do not restart or mutate runtime config during recovery',
                'do not run arbitrary shell commands from recovery',
              ],
              allowedRecoveryTools: ['read', 'session_status'],
            },
            executorOptions: {
              cwd: __dirname,
              workspacePath,
              maxOutput: 12000,
            },
          });
          if (recoveryAttempt.recoveryResult) {
            observedToolEvents.push({
              name: recoveryAttempt.nextAction?.tool || 'evidence_recovery',
              source: 'evidence_recovery_gate',
              phase: recoveryAttempt.recoveryResult.ok === true ? 'done' : 'failed',
              args: recoveryAttempt.nextAction,
              result: recoveryAttempt.recoveryResult,
              receipt: recoveryAttempt.recoveryResult.receipt,
            });
          }
          const recoveredContent = await continueAfterEvidenceRecovery({
            originalTask: options.originalUserText || message,
            recoveryAttempt,
            parentRequestId: requestId,
          });
          if (recoveredContent && recoveredContent.trim()) {
            fullContent = recoveredContent;
            completionObligationFallback = false;
            streamReconciled = true;
          } else {
            fullContent = buildForegroundCompletionFallback(observedToolEvents, recoveryAttempt);
            completionObligationFallback = true;
            streamReconciled = true;
          }
          if (!suppressMainChat) {
            if (recoveryAttempt.attempted) {
              logStreamDebug('evidence-recovery-gate-blocked-final', {
                requestId,
                failureClass: recoveryAttempt.failureClass,
                resumable: recoveryAttempt.resumable,
                nextAction: recoveryAttempt.nextAction,
                packetHash: recoveryAttempt.packet?.packetHash,
                recovered: recoveryAttempt.recovered === true,
                recoveryResultOk: recoveryAttempt.recoveryResult?.ok === true,
                continued: Boolean(recoveredContent && recoveredContent.trim()),
              });
              emitChatActivity({
                phase: 'evidence_gate_blocked_final',
                requestId,
                failureClass: recoveryAttempt.failureClass,
                resumable: recoveryAttempt.resumable,
                recovered: recoveryAttempt.recovered === true,
              });
              if (recoveryAttempt.recoveryResult) {
                emitChatActivity({
                  phase: 'evidence_recovery_action',
                  requestId,
                  ok: recoveryAttempt.recoveryResult.ok === true,
                  tool: recoveryAttempt.nextAction?.tool,
                  failureClass: recoveryAttempt.failureClass,
                });
              }
            }
            if (completionObligationFallback) {
              logStreamDebug('completion-obligation-fallback', { requestId, toolCount: stableToolList(observedToolEvents).length });
              emitChatActivity({ phase: 'completion-obligation-fallback', requestId });
            }
          }
        }

        if (!fullContent.trim() && !sawToolCall) {
          const err = decorateGatewayError(new Error('Gateway stream ended with an empty final response'), requestStartedAt);
          if (!suppressMainChat) {
            lastMainStreamFailureAt = Date.now();
            logStreamDebug('stream-error', { requestId, error: err.message, events: seenDataEvents });
            emitChatActivity({ phase: 'stream-error', requestId, error: err.message });
            mainWindow?.webContents.send('chat:stream-error', { error: err.message });
          }
          reject(err);
          return;
        }

        if (!suppressMainChat) {
          const reconciled = await maybeReconcileCompletedStream({
            requestId,
            requestStartedAt,
            content: fullContent,
            seenDataEvents,
          });
          if (reconciled?.content && reconciled.content !== fullContent) {
            fullContent = reconciled.content;
            streamReconciled = true;
          }
          lastMainStreamFailureAt = 0;
        }

        // Ensure any still-running tool indicators are closed before finalizing.
        if (!suppressMainChat && activeGatewayToolCalls.size > 0) {
          for (const name of activeGatewayToolCalls.values()) {
            mainWindow?.webContents.send('chat:tool-call', { name, status: 'done' });
          }
          activeGatewayToolCalls.clear();
        }

        // Clear pending tool calls on successful completion
        pendingToolCalls = [];

        // Clear session resume flag after first successful exchange post-restart.
        // Isolated runs don't clear the flag — they're orthogonal to the main
        // session's resume-after-restart semantics.
        if (!suppressMainChat && gatewayRestarted) {
          gatewayRestarted = false;
          console.log('[Gateway] Resume signal cleared after successful exchange');
        }

        // Main-chat state mutations — skipped entirely for isolated runs so
        // autonomous background tasks (contemplation, etc.) don't appear in
        // the Trail Map, don't bump the session message counter, and don't
        // leak into the agent's next main-chat turn via conversationHistory.
        if (!suppressMainChat) {
          // Add to history on success
          if (!hideUserFromHistory) {
            conversationHistory.push({ role: 'user', content: message });
          }
          if (fullContent) {
            conversationHistory.push({ role: 'assistant', content: fullContent });
          }

          // Session tracking for Trail Map
          currentSessionMessageCount++;
          if (!hideUserFromHistory && !currentSessionFirstUserMsg && message && !MODE_ENTRY_MARKERS.some(m => message.includes(m))) {
            currentSessionFirstUserMsg = message;
          }
          // Track mode
          if (trainingGroundsActive) currentSessionMode = 'code';
          else if (boothModeActive) currentSessionMode = 'booth';
          else if (embodimentModeActive) currentSessionMode = 'robot';
          else currentSessionMode = 'chat';

          // Write/update session record so it appears in Trail Map immediately
          // Write session record on every message — cheap via child process, prevents
          // loss of sessions on crash between messages 2-4
          if (pendingRolloverBridge) {
            pendingRolloverBridge = null;
            config.pendingRolloverBridge = null;
          }
          if (pendingNewTaskBoundary) {
            pendingNewTaskBoundary = null;
            config.pendingNewTaskBoundary = null;
          }
          writeSessionRecord();
          mainWindow?.webContents.send('sessions:updated');
        }
        const completionObligation = buildCompletionObligationPacket({
          required: sawToolCall,
          reasonCodes: sawToolCall ? ['foreground_tool_use'] : [],
          resolution: sawToolCall
            ? (completionObligationFallback ? 'blocked_response' : 'visible_final_response')
            : null,
          fallback: completionObligationFallback,
          toolEvents: observedToolEvents
        });

        if (!suppressMainChat) {
          try {
            markAttachmentReceiptsObserved(
              getContinuityDB(),
              Array.isArray(options.attachmentReceiptIds) ? options.attachmentReceiptIds : [],
              fullContent
            );
          } catch (err) {
            console.warn('[AttachmentReceipts] Failed to record observation excerpt:', err.message);
          }
          try {
            recordLiveTurnOutcome({
              requestId,
              message: options.originalUserText || message,
              response: fullContent,
              toolEvents: observedToolEvents,
              imageCount: Number.isFinite(options.imageCount)
                ? options.imageCount
                : (Array.isArray(options.images) ? options.images.length : 0),
              mode: currentSessionMode,
              startedAt: requestStartedAt,
              completedAt: Date.now(),
              seenDataEvents,
              reconciled: streamReconciled,
              completionObligation,
              threadId: effectiveThreadId,
              sessionId: currentSessionId,
              intentSource: options.metadata?.synthetic_source || 'current_user_turn',
              authorizationMode: options.metadata?.synthetic_source ? 'system_signal' : 'current_user_instruction'
            });
          } catch (err) {
            console.warn('[Spine] Failed to record live turn outcome:', err.message);
          }
        }
        if (!suppressMainChat) {
          if (conversationHistory.length > MAX_HISTORY_TURNS) {
            conversationHistory = conversationHistory.slice(-MAX_HISTORY_TURNS);
          }

          // Checkpoint conversation history every 3 exchanges for crash recovery
          checkpointCounter++;
          if (checkpointCounter % 3 === 0) {
            checkpointConversationHistory();
          }

          // Signal stream complete
          logStreamDebug('stream-done', {
            requestId,
            events: seenDataEvents,
            fullContentLength: fullContent.length,
            reconciled: streamReconciled,
            contentPreview: fullContent.slice(0, 500),
          });
          emitChatActivity({ phase: 'stream-done', requestId, fullContentLength: fullContent.length });
          mainWindow?.webContents.send('chat:stream-done', { content: fullContent, requestId, reconciled: streamReconciled, completionObligation });
        }
        resolve(fullContent);
      });
    });

    req.on('error', err => reject(decorateGatewayError(err, requestStartedAt)));
    req.on('timeout', () => { req.destroy(); reject(decorateGatewayError(new Error('Gateway request timed out'), requestStartedAt)); });
    // Isolated runs don't register activeRequest — the main-chat Stop button
    // controls the main session, not background tasks. If we registered here,
    // a user Stop during a contemplation run would cancel the wrong request.
    if (!suppressMainChat) {
      activeRequest = () => { req.destroy(); reject(new Error('Request aborted by user')); };
    }
    req.write(payload);
    req.end();
  });
}

ipcMain.handle('chat:stop', () => {
  if (activeRequest) {
    // Preserve partial exchange in conversation history so the agent has context
    // on the next message. Without this, the agent has amnesia about interrupted work.
    if (activeStreamMessage) {
      conversationHistory.push({ role: 'user', content: activeStreamMessage });
    }
    if (activeStreamContent.trim()) {
      conversationHistory.push({ role: 'assistant', content: activeStreamContent + '\n\n[INTERRUPTED — user stopped generation]' });
    }
    // Save interrupted tool calls for context injection on next message
    if (pendingToolCalls.length > 0) {
      config.interruptedToolCalls = pendingToolCalls.map(tc => ({ name: tc.name, args: tc.args }));
      try { saveConfig(); } catch {}
    }
    // Checkpoint on stop — captures partial exchange state
    checkpointConversationHistory();
    activeRequest();
    activeRequest = null;
    pendingToolCalls = [];
    activeStreamContent = '';
    activeStreamMessage = '';
    return { stopped: true };
  }
  return { stopped: false };
});

function httpPostWithAuthAbortable(url, body, bearerToken, timeoutMs = 90000) {
  let abortFn;
  const promise = new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization': `Bearer ${bearerToken}`,
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`HTTP ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Gateway request timed out')); });
    abortFn = () => { req.destroy(); reject(new Error('Request aborted by user')); };
    req.write(payload);
    req.end();
  });
  return { promise, abort: abortFn };
}

function httpPostWithAuth(url, body, bearerToken, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization': `Bearer ${bearerToken}`,
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`HTTP ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Gateway request timed out')); });
    req.write(payload);
    req.end();
  });
}

// ============================================================
// Updates
// ============================================================

const UPDATE_MANIFEST_URL = 'https://raw.githubusercontent.com/CoderofTheWest/cotw-scout/main/updates/manifest.json';

async function checkForUpdates() {
  try {
    const response = await httpGet(UPDATE_MANIFEST_URL);
    const manifest = JSON.parse(response);

    const updates = {};
    if (manifest.workspace_version && manifest.workspace_version !== config.workspaceVersion) {
      updates.workspace = {
        current: config.workspaceVersion,
        available: manifest.workspace_version,
        url: manifest.workspace_url,
      };
    }
    if (manifest.plugins_version && manifest.plugins_version !== config.pluginsVersion) {
      updates.plugins = {
        current: config.pluginsVersion,
        available: manifest.plugins_version,
        url: manifest.plugins_url,
      };
    }
    if (manifest.openclaw_version && manifest.openclaw_version !== config.openclawVersion) {
      updates.openclaw = {
        current: config.openclawVersion,
        available: manifest.openclaw_version,
        url: manifest.openclaw_url,
        platform: process.platform,
      };
    }
    if (manifest.app_version && manifest.app_version !== app.getVersion()) {
      updates.app = {
        current: app.getVersion(),
        available: manifest.app_version,
        url: manifest.app_url,
        platform: process.platform,
      };
    }

    if (Object.keys(updates).length > 0) {
      mainWindow?.webContents.send('update:available', updates);
    }

    return updates;
  } catch {
    // Silent fail — updates are best-effort
    return {};
  }
}

ipcMain.handle('update:check', async () => {
  return await checkForUpdates();
});

ipcMain.handle('update:apply', async (_event, updateInfo) => {
  try {
    if (updateInfo.workspace) {
      await applyWorkspaceUpdate(updateInfo.workspace);
    }
    if (updateInfo.plugins) {
      await applyPluginsUpdate(updateInfo.plugins);
    }
    if (updateInfo.openclaw) {
      await applyOpenClawUpdate(updateInfo.openclaw);
    }
    if (updateInfo.app) {
      // App update requires download + restart — return info for the UI to handle
      return { success: true, appUpdateUrl: updateInfo.app.url, requiresRestart: true };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

async function applyWorkspaceUpdate(info) {
  if (!info.url) return;

  sendStatus('update', 'Downloading workspace update...');
  const tarball = await httpGetBuffer(info.url);

  // Extract to temp, then merge (preserving user files)
  const tempDir = path.join(userDataPath, 'update-temp');
  if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });

  // Write tarball and extract
  const tarPath = path.join(tempDir, 'workspace.tar.gz');
  fs.writeFileSync(tarPath, tarball);
  execSync(`tar -xzf "${tarPath}" -C "${tempDir}"`, { timeout: 30000 });

  // Merge: copy everything except user files
  const extractedDir = path.join(tempDir, 'workspace');
  if (fs.existsSync(extractedDir)) {
    copyDirRecursive(extractedDir, workspacePath);
  }

  // Re-inject user/agent names into all .md files
  if (config.agentName && config.userName) {
    replaceWorkspacePlaceholders(workspacePath, config.agentName, config.userName);
  }

  config.workspaceVersion = info.available;
  saveConfig();

  // Cleanup
  fs.rmSync(tempDir, { recursive: true, force: true });
  sendStatus('update', 'Workspace updated');
}

async function applyPluginsUpdate(info) {
  if (!info.url) return;

  sendStatus('update', 'Downloading plugin update...');
  const tarball = await httpGetBuffer(info.url);

  const tempDir = path.join(userDataPath, 'plugin-update-temp');
  if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });

  const tarPath = path.join(tempDir, 'plugins.tar.gz');
  fs.writeFileSync(tarPath, tarball);
  execSync(`tar -xzf "${tarPath}" -C "${tempDir}"`, { timeout: 30000 });

  // Replace plugin dirs (but preserve per-agent data dirs)
  const pluginNames = getPluginDirs().map(d => path.basename(d));
  for (const name of pluginNames) {
    const src = path.join(tempDir, name);
    const dest = isDev
      ? path.join(pluginsPath, name)
      : path.join(pluginsPath, name);
    if (fs.existsSync(src)) {
      // Preserve data/ dir
      const dataBackup = path.join(dest, 'data');
      const hasData = fs.existsSync(dataBackup);
      const tempData = hasData ? path.join(tempDir, `${name}-data-backup`) : null;
      if (hasData) {
        fs.cpSync(dataBackup, tempData, { recursive: true });
      }

      // Replace plugin
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(src, dest, { recursive: true });

      // Restore data
      if (hasData && tempData) {
        fs.cpSync(tempData, path.join(dest, 'data'), { recursive: true });
      }
    }
  }

  config.pluginsVersion = info.available;
  saveConfig();

  fs.rmSync(tempDir, { recursive: true, force: true });
  sendStatus('update', 'Plugins updated');
}

async function applyOpenClawUpdate(info) {
  if (!info.url) return;

  // Stop gateway before replacing binary
  await stopGateway();

  const url = info.url.replace('{{PLATFORM}}', process.platform).replace('{{ARCH}}', process.arch);

  sendStatus('update', 'Downloading OpenClaw update...');
  const binary = await httpGetBuffer(url);

  // Replace the bundled binary
  const binaryPath = isDev
    ? null // In dev mode, don't replace system binary
    : path.join(resourcesPath, 'openclaw', process.platform === 'win32' ? 'openclaw.exe' : 'openclaw');

  if (!binaryPath) {
    sendStatus('update', 'OpenClaw update skipped (dev mode)');
    return;
  }

  // Backup current binary
  const backupPath = binaryPath + '.bak';
  if (fs.existsSync(binaryPath)) {
    fs.copyFileSync(binaryPath, backupPath);
  }

  // Write new binary
  fs.writeFileSync(binaryPath, binary);
  fs.chmodSync(binaryPath, 0o755);

  config.openclawVersion = info.available;
  saveConfig();

  // Validate the new binary
  try {
    execSync(`"${binaryPath}" --version`, { encoding: 'utf8', timeout: 5000 });
  } catch {
    // Rollback
    if (fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, binaryPath);
      fs.chmodSync(binaryPath, 0o755);
    }
    throw new Error('New OpenClaw binary failed validation — rolled back');
  }

  // Restart gateway with new binary
  await startGateway();
  sendStatus('update', `OpenClaw updated to ${info.available}`);
}

// ============================================================
// Telemetry
// ============================================================

ipcMain.handle('telemetry:status', () => {
  return { optedIn: config.telemetryOptIn };
});

ipcMain.handle('telemetry:set-opt-in', (_event, optedIn) => {
  config.telemetryOptIn = optedIn;
  saveConfig();

  // Also update workspace config
  const telConfigPath = path.join(workspacePath, 'telemetry-config.json');
  try {
    const telConfig = fs.existsSync(telConfigPath)
      ? JSON.parse(fs.readFileSync(telConfigPath, 'utf8'))
      : {};
    telConfig.opted_in = optedIn;
    telConfig.updated = new Date().toISOString();
    writeJsonAtomic(telConfigPath, telConfig);
  } catch { /* non-fatal */ }

  return { success: true };
});

// ============================================================
// Capability Tiers
// ============================================================

ipcMain.handle('tier:get', () => {
  let tier = config.capabilityTier || 1;
  // Check TRAILHEAD.md as source of truth — agent may have promoted via file edit
  try {
    const trailheadPath = path.join(workspacePath, 'TRAILHEAD.md');
    if (fs.existsSync(trailheadPath)) {
      const trailhead = fs.readFileSync(trailheadPath, 'utf8');
      const match = trailhead.match(/\*\*Tier (\d)/);
      if (match) {
        const trailheadTier = parseInt(match[1]);
        if (trailheadTier > tier) {
          config.capabilityTier = trailheadTier;
          saveConfig();
          tier = trailheadTier;
        }
      }
    }
  } catch {}
  return { tier };
});

ipcMain.handle('tier:request-upgrade', async (_event, requestedTier) => {
  // This is called when the agent (via chat) or the user (via settings) requests a tier change.
  // The Electron app shows a confirmation dialog — the agent cannot upgrade itself.
  if (requestedTier <= config.capabilityTier) {
    return { success: true, tier: config.capabilityTier, message: 'Already at this tier or higher' };
  }
  if (requestedTier > 3 || requestedTier < 1) {
    return { success: false, error: 'Invalid tier' };
  }

  // Notify the renderer to show a confirmation prompt
  mainWindow?.webContents.send('tier:confirm-upgrade', {
    currentTier: config.capabilityTier,
    requestedTier,
    tierNames: { 1: 'Firelight', 2: 'Trailhand', 3: 'Outrider' },
  });

  return { success: true, pending: true, message: 'Waiting for user confirmation' };
});

ipcMain.handle('tier:confirm', async (_event, tier) => {
  config.capabilityTier = tier;
  saveConfig();

  // Update the TRAILHEAD.md in the workspace
  const trailheadPath = path.join(workspacePath, 'TRAILHEAD.md');
  if (fs.existsSync(trailheadPath)) {
    let content = fs.readFileSync(trailheadPath, 'utf8');
    const tierNames = { 1: 'Tier 1 — Firelight', 2: 'Tier 2 — Trailhand', 3: 'Tier 3 — Outrider' };
    content = content.replace(/\*\*Tier \d — \w+\*\*/, `**${tierNames[tier]}**`);
    fs.writeFileSync(trailheadPath, content);
  }

  // Restart gateway to pick up any config changes for the new tier
  await stopGateway();
  await startGateway();

  sendStatus('tier', `Tier upgraded to ${tier}`);
  return { success: true, tier };
});

ipcMain.handle('tier:downgrade', async (_event, tier) => {
  if (tier >= config.capabilityTier || tier < 1) {
    return { success: false, error: 'Invalid downgrade' };
  }
  config.capabilityTier = tier;
  saveConfig();

  const trailheadPath = path.join(workspacePath, 'TRAILHEAD.md');
  if (fs.existsSync(trailheadPath)) {
    let content = fs.readFileSync(trailheadPath, 'utf8');
    const tierNames = { 1: 'Tier 1 — Firelight', 2: 'Tier 2 — Trailhand', 3: 'Tier 3 — Outrider' };
    content = content.replace(/\*\*Tier \d — \w+\*\*/, `**${tierNames[tier]}**`);
    fs.writeFileSync(trailheadPath, content);
  }

  sendStatus('tier', `Tier set to ${tier}`);
  return { success: true, tier };
});

// ============================================================
// Channels
// ============================================================

ipcMain.handle('channels:add', async (_event, channel, channelConfig) => {
  try {
    const profileDir = path.join(require('os').homedir(), '.openclaw-cotw');
    const configFilePath = path.join(profileDir, 'openclaw.json');
    if (!fs.existsSync(configFilePath)) return { success: false, error: 'Config not found' };

    const ocConfig = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));

    // Add channel config — flat format per OpenClaw docs
    if (!ocConfig.channels) ocConfig.channels = {};
    ocConfig.channels[channel] = {
      enabled: true,
      dmPolicy: 'pairing',
      ...(channel === 'telegram' ? { botToken: channelConfig.botToken } : channelConfig),
    };

    // Add binding if not present
    if (!ocConfig.bindings) ocConfig.bindings = [];
    const existingBinding = ocConfig.bindings.find(b =>
      b.match?.channel === channel
    );
    if (!existingBinding) {
      ocConfig.bindings.push({
        agentId: 'trail-guide',
        match: { channel },
      });
    }

    writeJsonAtomic(configFilePath, ocConfig);

    // Restart gateway to pick up new channel
    await stopGateway();
    await startGateway();

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('channels:remove', async (_event, channel) => {
  try {
    const profileDir = path.join(require('os').homedir(), '.openclaw-cotw');
    const configFilePath = path.join(profileDir, 'openclaw.json');
    if (!fs.existsSync(configFilePath)) return { success: false, error: 'Config not found' };

    const ocConfig = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
    if (ocConfig.channels?.[channel]) {
      delete ocConfig.channels[channel];
    }
    ocConfig.bindings = (ocConfig.bindings || []).filter(b => b.match?.channel !== channel);
    writeJsonAtomic(configFilePath, ocConfig);

    await stopGateway();
    await startGateway();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('channels:list', async () => {
  try {
    const profileDir = path.join(require('os').homedir(), '.openclaw-cotw');
    const configFilePath = path.join(profileDir, 'openclaw.json');
    if (!fs.existsSync(configFilePath)) return [];

    const ocConfig = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
    return Object.entries(ocConfig.channels || {}).map(([name, cfg]) => ({
      name,
      enabled: cfg.enabled !== false,
    }));
  } catch {
    return [];
  }
});

// ============================================================
// Web Search (Brave API)
// ============================================================

ipcMain.handle('search:save-brave-key', async (_event, key) => {
  try {
    const profileDir = path.join(require('os').homedir(), '.openclaw-cotw');
    const configFilePath = path.join(profileDir, 'openclaw.json');
    let ocConfig = {};
    if (fs.existsSync(configFilePath)) {
      ocConfig = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
    }
    // Handle disconnect (empty key)
    if (!key) {
      if (ocConfig.plugins?.entries?.brave) {
        ocConfig.plugins.entries.brave.enabled = false;
        if (ocConfig.plugins.entries.brave.config?.webSearch) {
          delete ocConfig.plugins.entries.brave.config.webSearch.apiKey;
        }
      }
      if (ocConfig.tools?.web?.search?.provider === 'brave') {
        delete ocConfig.tools.web.search.provider;
      }
      writeJsonAtomic(configFilePath, ocConfig);
      return { success: true };
    }
    // Store key in the canonical OpenClaw path for the Brave extension
    if (!ocConfig.plugins) ocConfig.plugins = {};
    if (!ocConfig.plugins.entries) ocConfig.plugins.entries = {};
    if (!ocConfig.plugins.entries.brave) ocConfig.plugins.entries.brave = { enabled: true, config: {} };
    if (!ocConfig.plugins.entries.brave.config) ocConfig.plugins.entries.brave.config = {};
    if (!ocConfig.plugins.entries.brave.config.webSearch) ocConfig.plugins.entries.brave.config.webSearch = {};
    ocConfig.plugins.entries.brave.config.webSearch.apiKey = key;
    // Set Brave as the explicit search provider
    if (!ocConfig.tools) ocConfig.tools = {};
    if (!ocConfig.tools.web) ocConfig.tools.web = {};
    if (!ocConfig.tools.web.search) ocConfig.tools.web.search = {};
    ocConfig.tools.web.search.provider = 'brave';
    // Clean up legacy jina path if present
    if (ocConfig.plugins?.jina?.braveApiKey) {
      delete ocConfig.plugins.jina.braveApiKey;
      delete ocConfig.plugins.jina.webSearchEnabled;
      if (Object.keys(ocConfig.plugins.jina).length === 0) delete ocConfig.plugins.jina;
    }
    writeJsonAtomic(configFilePath, ocConfig);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('search:test-brave-key', async () => {
  try {
    const profileDir = path.join(require('os').homedir(), '.openclaw-cotw');
    const configFilePath = path.join(profileDir, 'openclaw.json');
    if (!fs.existsSync(configFilePath)) return { success: false, error: 'No config' };

    const ocConfig = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
    // Check canonical path first, fall back to legacy
    const key = ocConfig.plugins?.entries?.brave?.config?.webSearch?.apiKey
             || ocConfig.plugins?.jina?.braveApiKey;
    if (!key) return { success: false, error: 'No key configured' };

    const https = require('https');
    return new Promise((resolve) => {
      const url = `https://api.search.brave.com/res/v1/web/search?q=test&count=1`;
      const req = https.get(url, {
        headers: { 'X-Subscription-Token': key, 'Accept': 'application/json' }
      }, (res) => {
        resolve({ success: res.statusCode === 200 });
      });
      req.on('error', () => resolve({ success: false, error: 'Network error' }));
      req.setTimeout(5000, () => { req.destroy(); resolve({ success: false, error: 'Timeout' }); });
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('search:brave-key-status', async () => {
  try {
    const profileDir = path.join(require('os').homedir(), '.openclaw-cotw');
    const configFilePath = path.join(profileDir, 'openclaw.json');
    if (!fs.existsSync(configFilePath)) return { configured: false };

    const ocConfig = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
    // Check canonical path first, fall back to legacy
    const hasKey = !!(ocConfig.plugins?.entries?.brave?.config?.webSearch?.apiKey
                   || ocConfig.plugins?.jina?.braveApiKey);
    return { configured: hasKey };
  } catch {
    return { configured: false };
  }
});

// ============================================================
// Google (Gemini) API
// ============================================================

ipcMain.handle('google:save-key', async (_event, key) => {
  try {
    const profileDir = path.join(require('os').homedir(), '.openclaw-cotw');
    const configFilePath = path.join(profileDir, 'openclaw.json');
    let ocConfig = {};
    if (fs.existsSync(configFilePath)) {
      ocConfig = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
    }
    // Handle disconnect (empty key)
    if (!key) {
      if (ocConfig.plugins?.entries?.google) {
        ocConfig.plugins.entries.google.enabled = false;
        if (ocConfig.plugins.entries.google.config?.webSearch) {
          delete ocConfig.plugins.entries.google.config.webSearch.apiKey;
        }
      }
      writeJsonAtomic(configFilePath, ocConfig);
      return { success: true };
    }
    if (!ocConfig.plugins) ocConfig.plugins = {};
    if (!ocConfig.plugins.entries) ocConfig.plugins.entries = {};
    if (!ocConfig.plugins.entries.google) ocConfig.plugins.entries.google = { enabled: true, config: {} };
    if (!ocConfig.plugins.entries.google.config) ocConfig.plugins.entries.google.config = {};
    if (!ocConfig.plugins.entries.google.config.webSearch) ocConfig.plugins.entries.google.config.webSearch = {};
    ocConfig.plugins.entries.google.config.webSearch.apiKey = key;
    ocConfig.plugins.entries.google.enabled = true;
    writeJsonAtomic(configFilePath, ocConfig);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('google:key-status', async () => {
  try {
    const profileDir = path.join(require('os').homedir(), '.openclaw-cotw');
    const configFilePath = path.join(profileDir, 'openclaw.json');
    if (!fs.existsSync(configFilePath)) return { configured: false };
    const ocConfig = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
    const hasKey = !!ocConfig.plugins?.entries?.google?.config?.webSearch?.apiKey;
    return { configured: hasKey };
  } catch {
    return { configured: false };
  }
});

// ============================================================
// Jina API
// ============================================================

ipcMain.handle('search:save-jina-key', async (_event, key) => {
  try {
    const profileDir = path.join(require('os').homedir(), '.openclaw-cotw');
    const configFilePath = path.join(profileDir, 'openclaw.json');
    let ocConfig = {};
    if (fs.existsSync(configFilePath)) {
      ocConfig = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
    }

    if (!key) {
      // Remove key
      if (ocConfig.plugins?.entries?.jina) {
        ocConfig.plugins.entries.jina.enabled = false;
        if (ocConfig.plugins.entries.jina.config) {
          delete ocConfig.plugins.entries.jina.config.apiKey;
        }
      }
      writeJsonAtomic(configFilePath, ocConfig);
      return { success: true };
    }

    if (!ocConfig.plugins) ocConfig.plugins = {};
    if (!ocConfig.plugins.entries) ocConfig.plugins.entries = {};
    if (!ocConfig.plugins.entries.jina) ocConfig.plugins.entries.jina = { enabled: true, config: {} };
    if (!ocConfig.plugins.entries.jina.config) ocConfig.plugins.entries.jina.config = {};
    ocConfig.plugins.entries.jina.config.apiKey = key;
    ocConfig.plugins.entries.jina.enabled = true;

    writeJsonAtomic(configFilePath, ocConfig);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('search:jina-key-status', async () => {
  try {
    const profileDir = path.join(require('os').homedir(), '.openclaw-cotw');
    const configFilePath = path.join(profileDir, 'openclaw.json');
    if (!fs.existsSync(configFilePath)) return { configured: false };
    const ocConfig = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
    const hasKey = !!ocConfig.plugins?.entries?.jina?.config?.apiKey;
    return { configured: hasKey };
  } catch {
    return { configured: false };
  }
});

// ============================================================
// Scout (Gemini CLI) Check
// ============================================================

ipcMain.handle('search:check-scout', async () => {
  try {
    const { execSync } = require('child_process');
    execSync('which gemini', { stdio: 'ignore' });
    return { available: true };
  } catch {
    return { available: false };
  }
});

// ============================================================
// Search Provider Selection
// ============================================================

ipcMain.handle('search:get-provider', async () => {
  try {
    const profileDir = path.join(require('os').homedir(), '.openclaw-cotw');
    const configFilePath = path.join(profileDir, 'openclaw.json');
    if (!fs.existsSync(configFilePath)) return { provider: null };
    const ocConfig = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
    return { provider: ocConfig.tools?.web?.search?.provider || null };
  } catch {
    return { provider: null };
  }
});

ipcMain.handle('search:set-provider', async (_event, provider) => {
  try {
    const profileDir = path.join(require('os').homedir(), '.openclaw-cotw');
    const configFilePath = path.join(profileDir, 'openclaw.json');
    let ocConfig = {};
    if (fs.existsSync(configFilePath)) {
      ocConfig = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
    }
    if (!ocConfig.tools) ocConfig.tools = {};
    if (!ocConfig.tools.web) ocConfig.tools.web = {};
    if (!ocConfig.tools.web.search) ocConfig.tools.web.search = {};

    if (provider === 'duckduckgo' || !provider) {
      delete ocConfig.tools.web.search.provider;
    } else {
      ocConfig.tools.web.search.provider = provider;
    }

    writeJsonAtomic(configFilePath, ocConfig);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ============================================================
// Service Connection Guidance (Agent-Guided Setup)
// ============================================================

const serviceGuidancePrompts = {
  telegram: `[SERVICE SETUP REQUEST: Telegram]
The user wants to connect their Telegram bot. Guide them through:
1. Opening Telegram and messaging @BotFather
2. Sending /newbot and following the prompts to name their bot
3. Copying the bot token that BotFather gives them
4. Pasting it in Settings > Channels > Telegram and clicking Connect
Be concise and encouraging. If they already have a token, just tell them to paste it in Settings.`,

  discord: `[SERVICE SETUP REQUEST: Discord]
The user wants to connect Discord. Guide them through:
1. Going to discord.com/developers/applications and creating a new application
2. Going to the Bot section and creating a bot
3. Enabling the Message Content intent under Bot > Privileged Gateway Intents
4. Copying the bot token from the Bot section
5. Pasting it in Settings > Channels > Discord and clicking Connect
Also remind them to invite the bot to their server using the OAuth2 URL generator with bot scope and Send Messages permission.`,

  whatsapp: `[SERVICE SETUP REQUEST: WhatsApp]
The user wants to connect WhatsApp via Meta Business API. Guide them through:
1. Setting up a Meta Business account at developers.facebook.com
2. Creating a new app and selecting WhatsApp as the product
3. Getting a permanent access token from the WhatsApp section
4. Pasting it in Settings > Channels > WhatsApp and clicking Connect
Note: This requires a Meta Business account and phone number verification. It's more involved than other channels.`,

  brave: `[SERVICE SETUP REQUEST: Brave Search]
The user wants to set up web search via Brave Search API. Guide them through:
1. Going to brave.com/search/api and creating a free account
2. The free tier gives 2,000 queries per month
3. Generating an API key from the dashboard
4. Pasting it in Settings > Web Search > Brave Search API and clicking Save
They can click Test to verify it works.`,

  google: `[SERVICE SETUP REQUEST: Google / Gemini]
The user wants to connect Google services via Gemini API. Guide them through:
1. Going to aistudio.google.com
2. Signing in with their Google account
3. Generating a Gemini API key
4. Pasting it in Settings > Web Search > Google (Gemini) and clicking Save
This enables Google Search grounding and media tools.`,
};

ipcMain.handle('service:connect-guided', async (_event, service) => {
  const prompt = serviceGuidancePrompts[service];
  if (!prompt) return { success: false, error: 'Unknown service' };

  try {
    await callGatewayHTTP(prompt);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ============================================================
// Embodiment
// ============================================================

const PI_HOST = '192.168.12.179';
const PI_PORT = 8420;
const VISION_PORT = 8421;
const OLLAMA_PORT = 11434;

ipcMain.handle('embodiment:status', async () => {
  const result = {
    piConnected: false,
    battery: null,
    upright: null,
    lastPoll: null,
    nativeVision: false,
    visionPrimaryModel: null,
    ollamaUp: false,
    fallbackVisionModelLoaded: false,
    depthLoaded: false,
    worldModel: null,
    activityLog: [],
  };

  try {
    const runtimeConfig = readRuntimeOpenClawConfig();
    const selected = summarizeSelectedProvider(runtimeConfig);
    result.visionPrimaryModel = selected.model || null;
    result.nativeVision = selected.providerId === 'openai-codex'
      && String(selected.model || '').includes('gpt-5.5');
  } catch { /* runtime config unavailable */ }

  // Check Pi
  try {
    const raw = await httpGet(`http://${PI_HOST}:${PI_PORT}/sensors`, 3000);
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    result.piConnected = true;
    result.battery = data.battery ?? data.voltage ?? null;
    result.upright = data.upright ?? null;
    result.lastPoll = Date.now();

    // Try to get activity from the event log
    if (data.eventLog) result.activityLog = data.eventLog;
  } catch { /* Pi offline */ }

  // Check vision service
  try {
    const raw = await httpGet(`http://localhost:${VISION_PORT}/health`, 3000);
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    result.depthLoaded = !!data.depth_loaded;
    result.ollamaUp = true; // vision service is up, implies Ollama was reachable at startup
  } catch { /* vision offline */ }

  // Check Ollama fallback VLM inventory
  try {
    const raw = await httpGet(`http://localhost:${OLLAMA_PORT}/api/tags`, 3000);
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    result.ollamaUp = true;
    if (data.models) {
      result.fallbackVisionModelLoaded = data.models.some(m => {
        const name = String(m.name || '');
        return name.includes('qwen3-vl') || name.includes('qwen3.5') || name.includes('gemma4') || name.includes('minicpm-v');
      });
    }
  } catch {
    // Ollama not running — ollamaUp stays false unless vision set it
  }

  return result;
});

ipcMain.handle('embodiment:enter', async () => {
  const result = { status: 'ok', handoff: null, notebook: null, curiosityEnabled: false };
  // Don't set embodimentModeActive here — that's only set by embodiment:activate

  // Read curiosity setting
  if (config.curiosityEnabled !== undefined) {
    result.curiosityEnabled = config.curiosityEnabled;
  }

  // Read handoff file if it exists
  const handoffPath = path.join(workspacePath, 'EMBODIMENT_HANDOFF.md');
  try {
    if (fs.existsSync(handoffPath)) {
      result.handoff = fs.readFileSync(handoffPath, 'utf8');
    }
  } catch { /* no handoff */ }

  // Read last 30 lines of notebook for context
  const notebookPath = path.join(workspacePath, 'EMBODIMENT_NOTEBOOK.md');
  try {
    if (fs.existsSync(notebookPath)) {
      const full = fs.readFileSync(notebookPath, 'utf8');
      const lines = full.split('\n');
      result.notebook = lines.slice(-30).join('\n');
    }
  } catch { /* no notebook */ }

  // Ensure notebook exists (copy from template if missing)
  if (!fs.existsSync(notebookPath)) {
    const tmplNotebook = path.join(templatePath, 'EMBODIMENT_NOTEBOOK.md');
    if (fs.existsSync(tmplNotebook)) {
      fs.copyFileSync(tmplNotebook, notebookPath);
    }
  }

  return result;
});

ipcMain.handle('embodiment:exit', async () => {
  embodimentModeActive = false;
  embodimentNeedInjection = false;
  needModeExitReorientation = 'embodiment';
  // Send a message to the agent telling it to write handoff + update notebook.
  // This goes through the normal chat flow so the agent's response streams to the GUI.
  try {
    const exitPrompt = 'You are leaving the body. Write EMBODIMENT_HANDOFF.md with your current state (battery, orientation, what you can see), what happened this embodied session, and any open threads. Then update EMBODIMENT_NOTEBOOK.md with anything you learned — movement calibration, environment observations, best practices. Be specific.';
    await callGatewayHTTP(exitPrompt);
    return { ok: true };
  } catch (e) {
    console.error('[Embodiment] exit prompt failed:', e.message);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('embodiment:start-vision', async () => {
  try {
    const scriptPath = path.join(__dirname, '..', 'start-vision-services.sh');
    // Also check the robot root for the script
    const robotScript = '/Users/clint/robot/start-vision-services.sh';
    const script = fs.existsSync(scriptPath) ? scriptPath : robotScript;

    if (!fs.existsSync(script)) {
      return { ok: false, error: 'start-vision-services.sh not found' };
    }

    const child = spawn('bash', [script], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('embodiment:notebook', async () => {
  const notebookPath = path.join(workspacePath, 'EMBODIMENT_NOTEBOOK.md');
  try {
    if (fs.existsSync(notebookPath)) {
      return { content: fs.readFileSync(notebookPath, 'utf8') };
    }
    return { content: null };
  } catch (e) {
    return { content: null, error: e.message };
  }
});

// Push mode state to renderer — single source of truth
function broadcastModeState() {
  const mode = embodimentModeActive ? 'robot'
    : boothModeActive ? 'booth'
    : trainingGroundsActive ? 'code'
    : 'chat';
  mainWindow?.webContents.send('mode:changed', {
    mode,
    embodiment: embodimentModeActive,
    booth: boothModeActive,
    code: trainingGroundsActive
  });
}

ipcMain.handle('embodiment:activate', async () => {
  // Mutual exclusivity with booth and training grounds
  if (boothModeActive) {
    boothModeActive = false;
  }
  if (trainingGroundsActive) {
    trainingGroundsActive = false;
    // Clean up project thread if switching from Code mode
    if (currentSessionProjectId) {
      writeSessionRecord();
      currentSessionId = makeSessionId();
      currentThreadId = currentSessionId;
      currentSessionProjectId = null;
      config.currentSessionProjectName = null;
      syncSessionConfig({ clearJsonl: true });
    }
  }
  embodimentModeActive = true;
  embodimentNeedInjection = true;
  broadcastModeState();
  return { ok: true };
});

ipcMain.handle('embodiment:curiosity', async (_event, enabled) => {
  config.curiosityEnabled = !!enabled;
  saveConfig();
  return { ok: true, enabled: config.curiosityEnabled };
});

// ============================================================
// The Booth
// ============================================================

ipcMain.handle('booth:enter', async () => {
  // Mutual exclusivity with embodiment and training grounds
  if (embodimentModeActive) {
    embodimentModeActive = false;
    embodimentNeedInjection = false;
  }
  if (trainingGroundsActive) {
    trainingGroundsActive = false;
    // Clean up project thread if switching from Code mode
    if (currentSessionProjectId) {
      writeSessionRecord();
      currentSessionId = makeSessionId();
      currentThreadId = currentSessionId;
      currentSessionProjectId = null;
      config.currentSessionProjectName = null;
      syncSessionConfig({ clearJsonl: true });
    }
  }
  boothModeActive = true;
  boothNeedInjection = true;
  broadcastModeState();
  return { ok: true, fresh: boothMessageCount === 0 };
});

ipcMain.handle('booth:exit', async () => {
  boothModeActive = false;
  needModeExitReorientation = 'booth';
  broadcastModeState();
  return { ok: true };
});

ipcMain.handle('booth:reset', async () => {
  boothMessageCount = 0;
  boothNeedInjection = true;
  return { ok: true };
});

// ============================================================
// Training Grounds
// ============================================================

ipcMain.handle('training:enter', async (_event, opts) => {
  const isRestore = opts?.restore === true; // Restoring mode after restart, not a fresh entry

  // Mutual exclusivity with booth and embodiment
  if (boothModeActive) {
    boothModeActive = false;
  }
  if (embodimentModeActive) {
    embodimentModeActive = false;
    embodimentNeedInjection = false;
  }
  trainingGroundsActive = true;
  trainingGroundsNeedInjection = true;

  // Update progress.json — track session entry (skip increment on restore)
  const progressPath = path.join(workspacePath, 'training-grounds', 'progress.json');
  let progress = { currentWeek: 1, currentDay: 1, lessonsCompleted: [], startedAt: null, lastSessionAt: null, sessionCount: 0, lessonsEnabled: true, userContext: { interests: [], skillLevel: 'beginner' } };
  try {
    if (fs.existsSync(progressPath)) {
      progress = { ...progress, ...JSON.parse(fs.readFileSync(progressPath, 'utf8')) };
    }
  } catch { /* use defaults */ }
  if (!isRestore) {
    if (!progress.startedAt) progress.startedAt = new Date().toISOString();
    progress.lastSessionAt = new Date().toISOString();
    progress.sessionCount = (progress.sessionCount || 0) + 1;
    try { fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2)); } catch {}
  }

  broadcastModeState();
  return { ok: true, fresh: trainingGroundsMessageCount === 0, progress };
});

ipcMain.handle('training:exit', async () => {
  trainingGroundsActive = false;
  needModeExitReorientation = 'training';

  // If in a project thread, switch to general session to prevent cross-mode bleed
  if (currentSessionProjectId) {
    writeSessionRecord();
    currentSessionId = makeSessionId();
    currentThreadId = currentSessionId;
    currentSessionProjectId = null;
    currentSessionFirstUserMsg = null;
    currentSessionMessageCount = 0;
    config.currentSessionProjectName = null;
    syncSessionConfig({ clearJsonl: true });
  }

  broadcastModeState();
  return { ok: true };
});

ipcMain.handle('training:reset', async () => {
  trainingGroundsMessageCount = 0;
  trainingGroundsNeedInjection = true;
  return { ok: true };
});

ipcMain.handle('training:progress', async () => {
  const progressPath = path.join(workspacePath, 'training-grounds', 'progress.json');
  try {
    if (fs.existsSync(progressPath)) {
      return JSON.parse(fs.readFileSync(progressPath, 'utf8'));
    }
  } catch { /* missing or invalid */ }
  return null;
});

ipcMain.handle('training:advance', async (_event, { lesson, day, week } = {}) => {
  const progressPath = path.join(workspacePath, 'training-grounds', 'progress.json');
  let progress = { currentWeek: 1, currentDay: 1, lessonsCompleted: [], startedAt: null, lastSessionAt: null, sessionCount: 0, lessonsEnabled: true, userContext: { interests: [], skillLevel: 'beginner' } };
  try {
    if (fs.existsSync(progressPath)) {
      progress = { ...progress, ...JSON.parse(fs.readFileSync(progressPath, 'utf8')) };
    }
  } catch {}
  if (lesson && !progress.lessonsCompleted.includes(lesson)) {
    progress.lessonsCompleted.push(lesson);
  }
  if (day) progress.currentDay = day;
  if (week) progress.currentWeek = week;
  progress.lastSessionAt = new Date().toISOString();
  try { fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2)); } catch {}
  return progress;
});

ipcMain.handle('training:toggle-lessons', async () => {
  const progressPath = path.join(workspacePath, 'training-grounds', 'progress.json');
  let progress = { currentWeek: 1, currentDay: 1, lessonsCompleted: [], startedAt: null, lastSessionAt: null, sessionCount: 0, lessonsEnabled: true, userContext: { interests: [], skillLevel: 'beginner' } };
  try {
    if (fs.existsSync(progressPath)) {
      progress = { ...progress, ...JSON.parse(fs.readFileSync(progressPath, 'utf8')) };
    }
  } catch {}
  progress.lessonsEnabled = !progress.lessonsEnabled;
  try { fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2)); } catch {}
  return { lessonsEnabled: progress.lessonsEnabled };
});

// ============================================================
// Helpers
// ============================================================

// Session management helpers for the Trail Map
const MODE_ENTRY_MARKERS = ['[TRAINING ENTRY]', '[TRAINING GROUNDS SESSION]', '[CODE SESSION]',
  '[BOOTH ENTRY]', '[BOOTH SESSION]', '[EMBODIMENT SESSION START]', '[MODE EXIT',
  '[SESSION START', '[THREAD_BOUNDARY]', '[SYSTEM:'];

function generateSessionTitle(firstMessage) {
  if (!firstMessage || firstMessage.length < 5) return null;
  // Skip mode/system messages
  if (MODE_ENTRY_MARKERS.some(m => firstMessage.includes(m))) return null;
  // Truncate at word boundary, max 60 chars
  if (firstMessage.length <= 60) return firstMessage.trim();
  const truncated = firstMessage.substring(0, 60);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 30 ? truncated.substring(0, lastSpace) : truncated).trim() + '...';
}

function getCurrentJsonlFile() {
  try {
    const sessionsDir = path.join(require('os').homedir(), '.openclaw-cotw', 'agents', 'trail-guide', 'sessions');
    if (!fs.existsSync(sessionsDir)) return null;
    const files = fs.readdirSync(sessionsDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return files.length > 0 ? files[0].name : null;
  } catch { return null; }
}

function makeSessionId() {
  return `session_${Date.now()}`;
}

function syncSessionConfig({ clearJsonl = false } = {}) {
  config.currentSessionId = currentSessionId;
  config.currentThreadId = currentThreadId;
  config.currentSessionMode = currentSessionMode;
  config.currentSessionFirstUserMsg = currentSessionFirstUserMsg;
  config.currentSessionMessageCount = currentSessionMessageCount;
  config.currentSessionProjectId = currentSessionProjectId;
  config.pendingRolloverBridge = pendingRolloverBridge || null;
  config.pendingNewTaskBoundary = pendingNewTaskBoundary || null;
  if (clearJsonl) config.currentSessionJsonlFile = null;
  try { saveConfig(); } catch {}
}

function truncateForBridge(content, limit = 1200) {
  const text = String(content || '').trim();
  if (text.length <= limit) return text;
  return text.slice(0, limit - 20).trimEnd() + '... [truncated]';
}

function buildRolloverBridge(reason) {
  const entries = sanitizeCheckpointHistory(conversationHistory)
    .slice(-10)
    .map(msg => {
      const role = msg.role === 'assistant' ? 'Assistant' : 'User';
      const content = msg.role === 'user'
        ? extractVisibleUserText(msg.content)
        : String(msg.content || '').trim();
      return content ? `${role}: ${truncateForBridge(content)}` : null;
    })
    .filter(Boolean);

  if (activeStreamMessage && !entries.some(line => line.includes(truncateForBridge(activeStreamMessage, 200)))) {
    entries.push(`Current user turn that was interrupted or retried: ${truncateForBridge(extractVisibleUserText(activeStreamMessage) || activeStreamMessage)}`);
  }

  if (entries.length === 0) return null;
  return [
    '[ROLLOVER CONTEXT - system note, not user speech]',
    `Electron refreshed the gateway session after: ${reason}.`,
    'The durable thread id stayed the same, but the new provider session may not have the immediate backscroll.',
    'Use this compact bridge only to preserve conversational continuity for the next reply. Do not mention this note.',
    '',
    ...entries,
    '[/ROLLOVER CONTEXT]',
  ].join('\n');
}

function stripAssistantDirectiveTags(content) {
  return String(content || '').replace(/^\s*(?:\[\[[^\]\n]{1,80}\]\]\s*)+/, '').trim();
}

function normalizeHistoryContent(content) {
  return stripAssistantDirectiveTags(content)
    .replace(/\s+/g, ' ')
    .trim();
}

function isLikelyRetryDuplicate(a, b) {
  if (!a || !b || a.role !== b.role) return false;
  const left = normalizeHistoryContent(a.content);
  const right = normalizeHistoryContent(b.content);
  if (!left || left !== right) return false;
  const closeInTime = a.timestamp && b.timestamp
    ? Math.abs(Number(b.timestamp) - Number(a.timestamp)) <= 10 * 60 * 1000
    : true;
  return closeInTime && left.length >= 80;
}

function dedupeHistoryMessages(messages) {
  const result = [];
  for (const msg of messages || []) {
    const prev = result[result.length - 1];
    if (isLikelyRetryDuplicate(prev, msg)) continue;

    const prevPairUser = result[result.length - 2];
    const prevPairAssistant = result[result.length - 1];
    if (prevPairUser?.role === 'user'
        && prevPairAssistant?.role === 'assistant'
        && msg.role === 'user'
        && isLikelyRetryDuplicate(prevPairUser, msg)) {
      continue;
    }
    if (prevPairUser?.role === 'user'
        && prevPairAssistant?.role === 'assistant'
        && msg.role === 'assistant'
        && isLikelyRetryDuplicate(prevPairAssistant, msg)) {
      continue;
    }

    result.push(msg);
  }
  return result;
}

function buildNewTaskBoundary(history) {
  const entries = sanitizeCheckpointHistory(history)
    .slice(-4)
    .map(msg => {
      const role = msg.role === 'assistant' ? '[Ellis, prior]' : 'Chris';
      const content = msg.role === 'user'
        ? extractVisibleUserText(msg.content)
        : stripAssistantDirectiveTags(msg.content);
      const trimmed = truncateForBridge(content, 500).replace(/\s+/g, ' ').trim();
      return trimmed ? `- ${role}: "${trimmed.replace(/"/g, '\\"')}"` : null;
    })
    .filter(Boolean);

  if (entries.length === 0) return null;
  return [
    '[THREAD_BOUNDARY]',
    'Chris intentionally started a new task from the UI. The previous local thread is paused/closed, not forgotten.',
    '',
    'Recent prior thread, for orientation only:',
    ...entries,
    '',
    'Do not continue the prior task unless Chris explicitly reopens it. Let the next user message define the new work.',
    '[/THREAD_BOUNDARY]',
  ].join('\n');
}

function estimateConversationChars(extraText = '') {
  const historyChars = conversationHistory.reduce((sum, msg) => {
    return sum + String(msg?.content || '').length;
  }, 0);
  return historyChars + String(extraText || '').length;
}

function getProactiveRolloverReason(nextMessage = '') {
  if (sessionRolloverInProgress) return null;
  if (currentSessionMessageCount === 0 && conversationHistory.length === 0) return null;
  if (currentSessionMessageCount >= PROACTIVE_ROLLOVER_EXCHANGE_THRESHOLD) {
    return `preemptive-message-threshold:${currentSessionMessageCount}`;
  }
  const estimatedChars = estimateConversationChars(nextMessage);
  if (estimatedChars >= PROACTIVE_ROLLOVER_CHAR_THRESHOLD) {
    return `preemptive-char-threshold:${estimatedChars}`;
  }
  return null;
}

function isContextOverflowSignal(value) {
  const text = String(value || '').toLowerCase();
  return text.includes('context overflow')
    || text.includes('prompt too large')
    || text.includes('context limit')
    || text.includes('maximum context')
    || text.includes('context window')
    || text.includes('tokens exceed');
}

function hasOpenClawContextOverflowSince(sinceMs) {
  const logsDir = path.join(require('os').homedir(), '.openclaw-cotw', 'logs');
  const candidates = ['gateway.log', 'gateway.err.log', 'electron-stream-debug.jsonl'];
  for (const file of candidates) {
    try {
      const fullPath = path.join(logsDir, file);
      if (!fs.existsSync(fullPath)) continue;
      const stat = fs.statSync(fullPath);
      if (sinceMs && stat.mtimeMs < sinceMs - 10000) continue;
      const fd = fs.openSync(fullPath, 'r');
      const length = Math.min(stat.size, 2 * 1024 * 1024);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, Math.max(0, stat.size - length));
      fs.closeSync(fd);
      const lines = buffer.toString('utf8').split('\n');
      for (const line of lines) {
        if (!isContextOverflowSignal(line)) continue;
        const timestamp = line.match(/^(\d{4}-\d{2}-\d{2}T[^\s]+)/)?.[1]
          || line.match(/"at":"([^"]+)"/)?.[1]
          || line.match(/"timestamp":"([^"]+)"/)?.[1];
        if (!sinceMs || !timestamp) return true;
        const loggedAt = new Date(timestamp).getTime();
        if (!Number.isNaN(loggedAt) && loggedAt >= sinceMs - 10000) return true;
      }
    } catch { /* ignore missing/rotating logs */ }
  }
  return false;
}

async function performSessionRollover({ reason = 'manual', keepThread = true, threadId = currentThreadId, notify = true } = {}) {
  if (sessionRolloverInProgress) return sessionRolloverInProgress;

  sessionRolloverInProgress = (async () => {
    const oldSessionId = currentSessionId;
    const oldThreadId = currentThreadId;
    const oldSessionKey = gatewaySessionKeyFor(oldSessionId);

    try { writeSessionRecord(); } catch (err) {
      console.warn('[SessionRollover] Failed to record outgoing session:', err.message);
    }

    let gatewayReset = null;
    try {
      gatewayReset = await callGatewayRPC(
        'sessions.reset',
        { key: oldSessionKey, reason },
        { timeoutMs: 15000 }
      );
      console.log(`[SessionRollover] Gateway sessions.reset completed for ${oldSessionKey}`);
    } catch (err) {
      console.warn(`[SessionRollover] Gateway sessions.reset failed for ${oldSessionKey} (continuing local rollover):`, err.message);
    }

    pendingRolloverBridge = buildRolloverBridge(reason);
    currentSessionId = makeSessionId();
    currentThreadId = keepThread ? (threadId || oldThreadId || currentSessionId) : currentSessionId;
    currentSessionFirstUserMsg = null;
    currentSessionMessageCount = 0;
    conversationHistory = [];
    pendingToolCalls = [];
    activeStreamContent = '';
    activeStreamMessage = '';
    checkpointCounter = 0;
    consecutiveMainStreamFailures = 0;
    try { fs.unlinkSync(checkpointPath); } catch {}
    syncSessionConfig({ clearJsonl: true });

    const result = {
      ok: true,
      reason,
      oldSessionId,
      newSessionId: currentSessionId,
      threadId: currentThreadId,
      gatewayReset: Boolean(gatewayReset?.ok),
    };
    logStreamDebug('session-rollover', result);
    if (notify) {
      sendStatus('session', gatewayReset?.ok ? 'Context refreshed' : 'Context refreshed — gateway reset unavailable');
      mainWindow?.webContents.send('chat:consolidation-restart', result);
    }
    console.log(`[SessionRollover] ${reason}: ${oldSessionId} -> ${currentSessionId}, thread ${currentThreadId}`);
    return result;
  })();

  try {
    return await sessionRolloverInProgress;
  } finally {
    sessionRolloverInProgress = null;
  }
}

function checkpointConversationHistory() {
  try {
    const filteredHistory = sanitizeCheckpointHistory(conversationHistory);
    if (checkpointHistoryHasUnsafeContent(filteredHistory)) {
      try { fs.unlinkSync(checkpointPath); } catch {}
      console.warn('[Checkpoint] Refusing to write unsafe checkpoint history');
      return;
    }
    if (filteredHistory.length === 0) {
      try { fs.unlinkSync(checkpointPath); } catch {}
      return;
    }
    const simplified = filteredHistory.map(m => ({
      role: m.role,
      content: typeof m.content === 'string'
        ? m.content.substring(0, 3000)
        : JSON.stringify(m.content).substring(0, 3000),
    }));
    const data = {
      timestamp: Date.now(),
      sessionId: currentSessionId,
      threadId: currentThreadId,
      history: simplified,
    };
    writeJsonAtomic(checkpointPath, data, 0);
  } catch (err) {
    console.error('[Checkpoint] Failed to write:', err.message);
  }
}

function emitChatActivity(data = {}) {
  mainWindow?.webContents.send('chat:agent-activity', {
    at: Date.now(),
    ...data,
  });
}

function logStreamDebug(event, data = {}) {
  try {
    fs.mkdirSync(path.dirname(streamDebugPath), { recursive: true });
    const entry = {
      at: new Date().toISOString(),
      event,
      ...data,
    };
    fs.appendFileSync(streamDebugPath, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.warn('[StreamDebug] Failed to write:', err.message);
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function contentLooksPossiblyTruncated(content) {
  const text = String(content || '').trim();
  if (!text) return true;
  if (text.length < 80) return true;

  const lastLine = text.split('\n').map(l => l.trim()).filter(Boolean).pop() || text;
  const lastWord = (lastLine.match(/[A-Za-z']+$/) || [''])[0].toLowerCase();
  const weakEndingWords = new Set([
    'a', 'an', 'and', 'as', 'at', 'because', 'between', 'but', 'by', 'for',
    'from', 'if', 'in', 'into', 'nor', 'of', 'on', 'or', 'so', 'than', 'that',
    'the', 'to', 'unless', 'until', 'when', 'where', 'while', 'with', 'without',
  ]);
  if (weakEndingWords.has(lastWord)) return true;
  if (/```$/.test(text)) return false;
  if (/[.!?。！？)"'\]]$/.test(text)) return false;
  return text.length < 1200;
}

function hasAssistantErrorInCurrentSessionSince(sinceMs) {
  const sessionFile = resolveCurrentSessionJsonlFile();
  if (!sessionFile || !fs.existsSync(sessionFile)) return false;

  const lines = fs.readFileSync(sessionFile, 'utf8').trim().split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type !== 'message') continue;
      const msg = event.message;
      if (!msg || msg.role !== 'assistant' || msg.stopReason !== 'error') continue;
      const ts = typeof msg.timestamp === 'number'
        ? msg.timestamp
        : (event.timestamp ? new Date(event.timestamp).getTime() : 0);
      if (!sinceMs || !ts || ts >= sinceMs - 5000) return true;
    } catch { /* skip malformed */ }
  }
  return false;
}

function shouldReconcileCompletedStream({ content, seenDataEvents, requestStartedAt }) {
  const looksSuspicious = seenDataEvents <= 3 || contentLooksPossiblyTruncated(content);
  if (!looksSuspicious) return false;

  const recentFailure = lastMainStreamFailureAt && Date.now() - lastMainStreamFailureAt < 90000;
  if (recentFailure) return true;

  return hasAssistantErrorInCurrentSessionSince(requestStartedAt);
}

function resolveCurrentSessionJsonlFile() {
  const sessionsDir = path.join(require('os').homedir(), '.openclaw-cotw', 'agents', 'trail-guide', 'sessions');
  if (config.currentSessionJsonlFile) {
    const candidate = path.join(sessionsDir, config.currentSessionJsonlFile);
    if (fs.existsSync(candidate)) return candidate;
  }
  if (!fs.existsSync(sessionsDir)) return null;
  const files = fs.readdirSync(sessionsDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({ path: path.join(sessionsDir, f), mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.path || null;
}

function extractSessionMessageText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter(c => c && c.type === 'text' && typeof c.text === 'string')
      .map(c => c.text)
      .join('\n');
  }
  return '';
}

function findLaterAssistantTextInCurrentSession({ content, sinceMs }) {
  const sessionFile = resolveCurrentSessionJsonlFile();
  if (!sessionFile || !fs.existsSync(sessionFile)) return null;

  const current = String(content || '').trim();
  let best = null;
  const lines = fs.readFileSync(sessionFile, 'utf8').trim().split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type !== 'message') continue;
      const msg = event.message;
      if (!msg || msg.role !== 'assistant' || msg.stopReason === 'error') continue;
      const ts = typeof msg.timestamp === 'number'
        ? msg.timestamp
        : (event.timestamp ? new Date(event.timestamp).getTime() : 0);
      if (sinceMs && ts && ts < sinceMs - 5000) continue;

      const text = extractSessionMessageText(msg).trim();
      if (!text) continue;
      if (current && text === current) continue;
      if (current && text.length < current.length + 80) continue;
      best = { content: text.substring(0, 12000), timestamp: ts, sessionFile };
    } catch { /* skip malformed */ }
  }
  return best;
}

async function maybeReconcileCompletedStream({ requestId, requestStartedAt, content, seenDataEvents }) {
  try {
    if (!shouldReconcileCompletedStream({ content, seenDataEvents, requestStartedAt })) return null;

    logStreamDebug('stream-reconcile-start', {
      requestId,
      fullContentLength: String(content || '').length,
      events: seenDataEvents,
      lastMainStreamFailureAgeMs: Date.now() - lastMainStreamFailureAt,
    });
    emitChatActivity({ phase: 'stream-reconcile-start', requestId });

    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const candidate = findLaterAssistantTextInCurrentSession({
        content,
        sinceMs: requestStartedAt,
      });
      if (candidate) {
        logStreamDebug('stream-reconcile-hit', {
          requestId,
          originalLength: String(content || '').length,
          reconciledLength: candidate.content.length,
          sessionFile: path.basename(candidate.sessionFile),
        });
        return candidate;
      }
      await delay(1500);
    }

    logStreamDebug('stream-reconcile-miss', {
      requestId,
      fullContentLength: String(content || '').length,
    });
    return null;
  } catch (err) {
    logStreamDebug('stream-reconcile-error', { requestId, error: err.message });
    return null;
  }
}

async function maybeRecoverFailedStream({ requestId, requestStartedAt, content, seenDataEvents, error }) {
  try {
    logStreamDebug('stream-recover-wait', {
      requestId,
      error: error?.message || String(error || ''),
      partialLength: String(content || '').length,
      events: seenDataEvents,
    });
    emitChatActivity({
      phase: 'stream-recover-wait',
      requestId,
      error: error?.message || String(error || ''),
    });

    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const candidate = findLaterAssistantTextInCurrentSession({
        content,
        sinceMs: requestStartedAt,
      });
      if (candidate?.content) {
        logStreamDebug('stream-recover-hit', {
          requestId,
          error: error?.message || String(error || ''),
          partialLength: String(content || '').length,
          recoveredLength: candidate.content.length,
          sessionFile: path.basename(candidate.sessionFile),
        });
        emitChatActivity({
          phase: 'stream-recover-hit',
          requestId,
          recoveredLength: candidate.content.length,
        });
        return candidate;
      }
      await delay(1500);
    }

    logStreamDebug('stream-recover-miss', {
      requestId,
      error: error?.message || String(error || ''),
      partialLength: String(content || '').length,
    });
    return null;
  } catch (err) {
    logStreamDebug('stream-recover-error', { requestId, error: err.message });
    return null;
  }
}

function extractVisibleUserText(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';

  const currentMarker = '[Current message - respond to this]';
  const markerIndex = raw.lastIndexOf(currentMarker);
  if (markerIndex >= 0) {
    const currentBlock = raw.slice(markerIndex + currentMarker.length).trim();
    const userMatch = currentBlock.match(/^User:\s*([\s\S]*)$/);
    const visible = (userMatch ? userMatch[1] : currentBlock).trim();
    return isSyntheticHistoryContent(visible) ? '' : visible;
  }

  return isSyntheticHistoryContent(raw) ? '' : raw;
}

function isSyntheticHistoryContent(content) {
  const text = String(content || '').trim();
  return text.startsWith('[MORNING ARRIVAL]')
    || text.startsWith('[SESSION START')
    || text.startsWith('[THREAD_BOUNDARY]')
    || text.startsWith('[SYSTEM — not from user')
    || text.startsWith('[SYSTEM - not from user')
    || text.startsWith('[SYSTEM: Session boundary')
    || text.startsWith('[THREAD:')
    || text.startsWith('[SESSION_RESUME]');
}

function sanitizeCheckpointHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.filter(m => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return false;
    const content = String(m.content || '').trim();
    if (!content) return false;
    return !isSyntheticHistoryContent(content);
  });
}

function isQuarantinedContinuityThreadContent(content) {
  const text = String(content || '').toLowerCase();
  return text.includes('holy shit')
    || text.includes('buoyancy')
    || text.includes("clint's workspace")
    || text.includes('clint workspace')
    || text.includes('fabricating dialogue')
    || text.includes('contaminated memory')
    || text.includes('contemplation context')
    || text.includes('phantom')
    || text.includes("wasn't ours")
    || text.includes('bled in from clint');
}

function checkpointHistoryHasUnsafeContent(history) {
  return Array.isArray(history) && history.some(m => {
    const content = m?.content;
    return isSyntheticHistoryContent(content) || isQuarantinedContinuityThreadContent(content);
  });
}

function checkpointHistoryHasSyntheticPrompts(history) {
  return Array.isArray(history) && history.some(m => isSyntheticHistoryContent(m?.content));
}

function writeSessionRecord() {
  if (currentSessionMessageCount === 0) return; // Don't write empty sessions
  const title = generateSessionTitle(currentSessionFirstUserMsg)
    || `${currentSessionMode.charAt(0).toUpperCase() + currentSessionMode.slice(1)} - ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  const jsonlFile = getCurrentJsonlFile();
  writeContinuityDB(
    'INSERT OR REPLACE INTO sessions (id, title, mode, project_id, started_at, ended_at, message_count, jsonl_file) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [currentSessionId, title, currentSessionMode, currentSessionProjectId,
     new Date(parseInt(currentSessionId.split('_')[1]) || Date.now()).toISOString(),
     new Date().toISOString(), currentSessionMessageCount, jsonlFile]
  );
  // Persist session state to config so restarts resume the same session
  config.currentSessionId = currentSessionId;
  config.currentThreadId = currentThreadId;
  config.currentSessionMode = currentSessionMode;
  config.currentSessionFirstUserMsg = currentSessionFirstUserMsg;
  config.currentSessionMessageCount = currentSessionMessageCount;
  config.currentSessionProjectId = currentSessionProjectId;
  config.pendingRolloverBridge = pendingRolloverBridge || null;
  config.pendingNewTaskBoundary = pendingNewTaskBoundary || null;
  if (jsonlFile) config.currentSessionJsonlFile = jsonlFile;
  try { saveConfig(); } catch {}
}

// Continuity DB — opened in-process using Electron's bundled Node, which matches
// the ABI of the better-sqlite3 binary rebuilt by electron-rebuild (postinstall).
// Prior implementation shelled out to system `node`, which broke whenever the
// user's system Node had a different NODE_MODULE_VERSION than Electron's.
let continuityDB = null;
function getContinuityDB() {
  if (continuityDB) return continuityDB;
  try {
    const dbPath = path.join(pluginsPath, 'openclaw-plugin-continuity',
      'data', 'agents', 'trail-guide', 'continuity.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    db.exec("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT, mode TEXT DEFAULT 'chat', project_id TEXT, started_at TEXT, ended_at TEXT, message_count INTEGER DEFAULT 0, archived INTEGER DEFAULT 0, jsonl_file TEXT)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at)");
    try { db.exec("ALTER TABLE sessions ADD COLUMN archived INTEGER DEFAULT 0"); } catch (e) { if (!e.message.includes('duplicate')) throw e; }
    try { db.exec("ALTER TABLE sessions ADD COLUMN jsonl_file TEXT"); } catch (e) { if (!e.message.includes('duplicate')) throw e; }
    continuityDB = db;
    return db;
  } catch (err) {
    console.error('[Continuity DB] Open failed:', err.message);
    return null;
  }
}

function queryContinuityDB(sql, params = []) {
  try {
    const db = getContinuityDB();
    if (!db) return null;
    return db.prepare(sql).all(...params);
  } catch (err) {
    console.error('[Continuity DB] Query error:', err.message);
    return null;
  }
}

function writeContinuityDB(sql, params = []) {
  try {
    const db = getContinuityDB();
    if (!db) return;
    db.prepare(sql).run(...params);
  } catch (err) {
    console.error('[Continuity DB] Write error:', err.message);
  }
}

/**
 * Get recent user context from continuity DB, filtered by mode.
 * @param {'chat'|'code'|'booth'|'robot'} mode - Current mode. Defaults to currentSessionMode.
 *   - 'chat': returns only non-mode exchanges (strips all mode markers)
 *   - 'code': returns Code mode exchanges (has [CODE SESSION] or [TRAINING GROUNDS SESSION])
 *   - 'booth': returns Booth mode exchanges (has [BOOTH ENTRY] or [BOOTH SESSION])
 *   - 'robot': returns Embodiment exchanges (has [EMBODIMENT SESSION START])
 */
function getRecentUserContext(mode) {
  const activeMode = mode || currentSessionMode || 'chat';
  const rows = queryContinuityDB(
    'SELECT user_text, date, topic_tags, created_at FROM exchanges ORDER BY created_at DESC LIMIT 30'
  );
  if (!rows || !rows.length) return null;

  // Mode marker groups — which markers belong to which mode
  const CODE_MARKERS = ['[TRAINING ENTRY]', '[TRAINING GROUNDS SESSION]', '[CODE SESSION]', "[WHAT YOU'VE LEARNED IN CODE MODE]"];
  const BOOTH_MARKERS = ['[BOOTH ENTRY]', '[BOOTH SESSION]'];
  const ROBOT_MARKERS = ['[EMBODIMENT SESSION START]'];
  const ALL_MODE_MARKERS = [...CODE_MARKERS, ...BOOTH_MARKERS, ...ROBOT_MARKERS, '[MODE EXIT]'];

  // System-only content markers — entries that are PURELY system-generated
  // (no real user content). These leak in during rapid restarts.
  // NOTE: Mode markers ([CODE SESSION], [BOOTH SESSION], etc.) are NOT filtered here —
  // they are intentionally prepended to real user messages for mode context.
  const SYSTEM_ONLY_MARKERS = [
    '[SESSION START — FRESH CONTEXT]',
    '[CONTINUITY CONTEXT]', '[YOUR WORKING MEMORY]',
    '[STABILITY CONTEXT]', '[YOUR COHERENCE]',
    '[CONTEMPLATION STATE]', '[WHAT YOU\'VE BEEN THINKING ABOUT]',
    'HEARTBEAT_OK', 'NO_REPLY'
  ];

  const filtered = rows.filter(r => {
    const text = r.user_text || '';
    const trimmed = text.trim();

    // 1. Filter out empty or trivially short entries
    if (trimmed.length < 10) return false;

    // 2. Filter out entries that are entirely system-generated content
    //    (starts with a system marker and has no substantial user text after it)
    if (SYSTEM_ONLY_MARKERS.some(marker => trimmed.startsWith(marker))) {
      // Check if there's real user content after the system block
      // System blocks end with a closing tag like [/BLOCK] — if that's all there is, skip
      const afterBlock = trimmed.replace(/\[.*?\]/g, '').trim();
      if (afterBlock.length < 20) return false;
    }

    // 3. Filter out entries that are just bracketed system tokens
    if (/^\[.*\]$/.test(trimmed)) return false;

    // 4. Mode-based filtering — keep exchanges relevant to current mode
    if (activeMode === 'code') {
      return CODE_MARKERS.some(marker => text.includes(marker));
    } else if (activeMode === 'booth') {
      return BOOTH_MARKERS.some(marker => text.includes(marker));
    } else if (activeMode === 'robot') {
      return ROBOT_MARKERS.some(marker => text.includes(marker));
    } else {
      // In plain chat: return exchanges WITHOUT any mode markers
      return !ALL_MODE_MARKERS.some(marker => text.includes(marker));
    }
  }).slice(0, 10);

  if (!filtered.length) return null;
  return filtered.map(r => {
    let line = `- [${r.date}] ${(r.user_text || '').substring(0, 200)}`;
    if (r.topic_tags) line += ` (topics: ${r.topic_tags})`;
    return line;
  }).join('\n');
}

function sanitizeName(name) {
  if (!name) return 'Scout';
  // Allow letters, numbers, spaces, hyphens, apostrophes, periods
  return name.replace(/[^a-zA-Z0-9\s\-'.]/g, '').trim().substring(0, 50) || 'Scout';
}

function sendStatus(type, message) {
  mainWindow?.webContents.send('status:update', { type, message, timestamp: Date.now() });
}

function createStatusBatcher(type, options = {}) {
  const flushMs = Math.max(50, Number(options.flushMs || 250));
  const maxLines = Math.max(1, Number(options.maxLines || 25));
  const maxChars = Math.max(1000, Number(options.maxChars || 10000));
  let lines = [];
  let chars = 0;
  let timer = null;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!lines.length) return;
    const batch = lines;
    lines = [];
    chars = 0;
    sendStatus(type, batch.join('\n'));
  };

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(flush, flushMs);
    if (typeof timer.unref === 'function') timer.unref();
  };

  return {
    push(message) {
      const text = String(message || '').trim();
      if (!text) return;
      lines.push(text);
      chars += text.length;
      if (lines.length >= maxLines || chars >= maxChars) flush();
      else schedule();
    },
    flush,
  };
}

function createGatewayLogVolumeRecorder(intervalMs = 10000) {
  const counters = {
    stdoutLines: 0,
    stderrLines: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
  };

  const flush = () => {
    const total = counters.stdoutLines + counters.stderrLines + counters.stdoutBytes + counters.stderrBytes;
    if (!total) return;
    appendMetric({
      type: 'gateway_log_volume',
      ...counters,
    });
    counters.stdoutLines = 0;
    counters.stderrLines = 0;
    counters.stdoutBytes = 0;
    counters.stderrBytes = 0;
  };

  const timer = setInterval(flush, Math.max(1000, Number(intervalMs) || 10000));
  if (typeof timer.unref === 'function') timer.unref();

  return {
    observe(streamName, data) {
      const byteLength = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data || ''));
      const lineCount = String(data || '').split(/\r?\n/).filter(Boolean).length;
      if (streamName === 'stderr') {
        counters.stderrLines += lineCount;
        counters.stderrBytes += byteLength;
      } else {
        counters.stdoutLines += lineCount;
        counters.stdoutBytes += byteLength;
      }
    },
    flush,
    stop() {
      clearInterval(timer);
      flush();
    },
  };
}

// ---- Auto-update (electron-updater) -------------------------------------
// Downloads + installs new app DMGs from GitHub releases. Different layer
// from the manifest-based checkForUpdates() above (which handles workspace
// / plugins / openclaw content updates and notifies the UI for manual
// install). This pipeline handles the app binary itself: downloads in the
// background, applies on next quit. Failures are silent — auto-update is
// best-effort, and never blocks the user.
//
// Skipped in dev mode (no DMG to download) and when network is unreachable.
// Coexists with the older app-version check in checkForUpdates() — if that
// proves redundant once the autoUpdater is reliable, the app-version branch
// of the manifest check should be removed in a follow-up.
let _autoUpdaterSetup = false;
function setupAutoUpdater() {
  if (_autoUpdaterSetup) return;
  _autoUpdaterSetup = true;

  if (isDev) {
    console.log('[AutoUpdater] dev mode — skipping update checks');
    return;
  }

  // GitHub feed config is picked up automatically from electron-builder.yml
  // at build time (publish.provider=github, owner/repo). No runtime config
  // needed here.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Let our logger be quiet — surface only meaningful events via console.
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => {
    console.log('[AutoUpdater] Checking for updates...');
  });
  autoUpdater.on('update-available', (info) => {
    console.log(`[AutoUpdater] Update available: ${info.version} (current ${app.getVersion()})`);
    sendStatus('update', `Update available: ${info.version} — downloading in the background`);
  });
  autoUpdater.on('update-not-available', () => {
    console.log('[AutoUpdater] No app updates available');
  });
  autoUpdater.on('error', (err) => {
    // Silent for the user — log only. Auto-update should never annoy.
    console.warn(`[AutoUpdater] Error: ${err?.message || err}`);
  });
  autoUpdater.on('download-progress', (progress) => {
    if (progress?.percent !== undefined) {
      sendStatus('update-progress', `Update download: ${Math.round(progress.percent)}%`);
    }
  });
  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[AutoUpdater] Update downloaded: ${info.version} — will install on next quit`);
    sendStatus('update', `Update ready: ${info.version} — restart Scout to install`);
  });

  // Initial check after a 30s delay so the gateway has time to come up first.
  // Gateway boot is the user's primary concern at startup; updates can wait.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(err => {
      console.warn(`[AutoUpdater] initial check failed: ${err?.message || err}`);
    });
  }, 30000);

  // Re-check every 4 hours while the app is running. Mid-day update releases
  // get noticed without requiring a restart.
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(err => {
      console.warn(`[AutoUpdater] periodic check failed: ${err?.message || err}`);
    });
  }, 4 * 60 * 60 * 1000);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry(fn, { retries = 3, delayMs = 2000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(delayMs);
    }
  }
  throw lastError;
}

function httpGet(url, timeoutMs = 10000, _redirects = 0) {
  if (_redirects > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const transport = url.startsWith('https') ? https : http;
    transport.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(httpGet(res.headers.location, timeoutMs, _redirects + 1));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`HTTP ${res.statusCode}: ${data}`));
      });
    }).on('error', reject);
  });
}

function httpGetBuffer(url, _redirects = 0) {
  if (_redirects > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const transport = url.startsWith('https') ? https : http;
    transport.get(url, { timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(httpGetBuffer(res.headers.location, _redirects + 1));
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(Buffer.concat(chunks));
        else reject(new Error(`HTTP ${res.statusCode}`));
      });
    }).on('error', reject);
  });
}

// ============================================================
// GitHub Workspace Backup & Sync
// ============================================================

const GITHUB_CLIENT_ID = 'Ov23liYbFvVSdHBD73Fr';

function getGitHubToken() {
  try {
    if (config.githubTokenEncrypted && require('electron').safeStorage.isEncryptionAvailable()) {
      return require('electron').safeStorage.decryptString(Buffer.from(config.githubTokenEncrypted, 'base64'));
    }
  } catch {}
  return config.githubToken || null;
}

function setGitHubToken(token) {
  try {
    if (require('electron').safeStorage.isEncryptionAvailable()) {
      config.githubTokenEncrypted = require('electron').safeStorage.encryptString(token).toString('base64');
      delete config.githubToken;
    } else {
      config.githubToken = token;
    }
  } catch {
    config.githubToken = token;
  }
  saveConfig();
}

function gitExec(args, cwd = workspacePath) {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8', timeout: 30000 }).trim();
}

function isGitRepo() {
  try { gitExec('rev-parse --is-inside-work-tree'); return true; } catch { return false; }
}

function gitHasChanges() {
  try {
    const status = gitExec('status --porcelain');
    return status.length > 0;
  } catch { return false; }
}

async function gitSyncWorkspace(label = 'sync') {
  const token = getGitHubToken();
  if (!token || !isGitRepo() || !gitHasChanges()) return;
  try {
    // Recover from any stuck git state first
    try { gitExec('rebase --abort'); } catch {}
    try { gitExec('merge --abort'); } catch {}

    const date = new Date().toISOString().split('T')[0];
    gitExec('add -A');
    try { gitExec(`commit -m "session ${label} ${date}"`); } catch { return; }

    const remote = gitExec('remote get-url origin');
    const cleanRemote = remote.replace(/https:\/\/[^@]+@/, 'https://');
    const authedRemote = cleanRemote.replace('https://', `https://x-access-token:${token}@`);
    try {
      gitExec(`push ${authedRemote} main`);
    } catch {
      // Push rejected — force push. This is a personal backup, not collaborative.
      gitExec(`push ${authedRemote} main --force`);
    }
    config.lastSyncTime = Date.now();
    config.lastSyncStatus = 'ok';
    saveConfig();
    console.log(`[GitHub] Synced workspace: ${label}`);
  } catch (err) {
    config.lastSyncStatus = 'failed';
    config.lastSyncError = err.message;
    saveConfig();
    console.error(`[GitHub] Sync failed: ${err.message}`);
  }
}

function githubApiRequest(method, endpoint, token, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path: endpoint,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'COTW-Trail-Guide',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else reject(new Error(`GitHub API ${res.statusCode}: ${json.message || data}`));
        } catch { reject(new Error(`GitHub API parse error: ${data.substring(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Device Flow: Step 1 — request device code
ipcMain.handle('github:device-flow-start', async () => {
  return new Promise((resolve, reject) => {
    const payload = `client_id=${GITHUB_CLIENT_ID}&scope=repo`;
    const req = https.request({
      hostname: 'github.com',
      path: '/login/device/code',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json); // { device_code, user_code, verification_uri, interval, expires_in }
        } catch { reject(new Error('Failed to parse device flow response')); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
});

// Device Flow: Step 2 — poll for authorization
ipcMain.handle('github:device-flow-poll', async (_event, deviceCode) => {
  return new Promise((resolve, reject) => {
    const payload = `client_id=${GITHUB_CLIENT_ID}&device_code=${deviceCode}&grant_type=urn:ietf:params:oauth:grant-type:device_code`;
    const req = https.request({
      hostname: 'github.com',
      path: '/login/oauth/access_token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          console.log('[GitHub] Poll response:', JSON.stringify(json).substring(0, 200));
          if (json.access_token) {
            console.log('[GitHub] Token received, saving...');
            setGitHubToken(json.access_token);
            console.log('[GitHub] Token saved to config');
            resolve({ status: 'authorized' });
          } else if (json.error === 'authorization_pending') {
            resolve({ status: 'pending' });
          } else if (json.error === 'slow_down') {
            resolve({ status: 'slow_down', interval: json.interval });
          } else {
            console.log('[GitHub] Poll error:', json.error, json.error_description);
            resolve({ status: 'error', error: json.error, description: json.error_description });
          }
        } catch (e) { console.error('[GitHub] Parse error:', e.message, data.substring(0, 200)); reject(new Error('Failed to parse poll response')); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
});

// Create private repo and init workspace as git repo
ipcMain.handle('github:create-repo', async (_event, repoName) => {
  const token = getGitHubToken();
  if (!token) return { ok: false, error: 'Not authenticated' };

  try {
    // Create private repo (or connect to existing one)
    let repoFullName;
    try {
      const repo = await githubApiRequest('POST', '/user/repos', token, {
        name: repoName,
        private: true,
        description: 'COTW Scout — agent workspace backup',
        auto_init: false,
      });
      repoFullName = repo.full_name;
      console.log('[GitHub] Created repo:', repoFullName);
    } catch (createErr) {
      // Repo may already exist — try to get it
      if (createErr.message.includes('422') || createErr.message.includes('already exists')) {
        const user = await githubApiRequest('GET', '/user', token);
        repoFullName = `${user.login}/${repoName}`;
        console.log('[GitHub] Repo exists, connecting to:', repoFullName);
      } else {
        throw createErr;
      }
    }

    // Init git in workspace — recover broken state if needed
    if (!isGitRepo()) {
      const dotGit = path.join(workspacePath, '.git');
      if (fs.existsSync(dotGit)) {
        fs.rmSync(dotGit, { recursive: true, force: true });
      }
      gitExec('init');
      gitExec('checkout -b main');
    }

    // Write .gitignore
    const gitignorePath = path.join(workspacePath, '.gitignore');
    fs.writeFileSync(gitignorePath, [
      'node_modules/', '.DS_Store', '*.db-journal', '*.db-wal', '*.db-shm',
      '*.lock', '*.tmp', '.openclaw-wiki/state.json'
    ].join('\n') + '\n');

    // Also sync app config (minus machine-specific fields)
    const syncConfig = { ...config };
    delete syncConfig.gatewayToken;
    delete syncConfig.githubToken;
    delete syncConfig.githubTokenEncrypted;
    writeJsonAtomic(path.join(workspacePath, '.cotw-config.json'), syncConfig);

    // Set remote (replace if exists)
    const authedUrl = `https://x-access-token:${token}@github.com/${repoFullName}.git`;
    try { gitExec('remote remove origin'); } catch { /* no existing remote */ }
    gitExec(`remote add origin ${authedUrl}`);

    // Commit and push — force push if rejected (personal backup, not collaborative)
    gitExec('add -A');
    try { gitExec('commit -m "workspace sync"'); } catch { /* nothing to commit */ }
    try {
      gitExec(`push -u origin main`);
    } catch {
      gitExec(`push -u origin main --force`);
    }

    // Store repo info
    config.githubRepo = repoFullName;
    config.lastSyncTime = Date.now();
    saveConfig();

    return { ok: true, repoUrl: `https://github.com/${repoFullName}`, fullName: repoFullName };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// List user's cotw-agent-* repos (for restore flow)
ipcMain.handle('github:list-repos', async () => {
  const token = getGitHubToken();
  if (!token) return { ok: false, error: 'Not authenticated' };

  try {
    const repos = await githubApiRequest('GET', '/user/repos?per_page=100&sort=updated', token);
    const agentRepos = repos.filter(r => r.name.startsWith('cotw-agent-'));
    return { ok: true, repos: agentRepos.map(r => ({ name: r.name, fullName: r.full_name, url: r.html_url, updatedAt: r.updated_at })) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Clone an existing repo as workspace (restore flow)
ipcMain.handle('github:clone-repo', async (_event, fullName) => {
  const token = getGitHubToken();
  if (!token) return { ok: false, error: 'Not authenticated' };

  try {
    // Remove existing workspace if present
    if (fs.existsSync(workspacePath)) {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }

    const authedUrl = `https://x-access-token:${token}@github.com/${fullName}.git`;
    execSync(`git clone ${authedUrl} "${workspacePath}"`, { encoding: 'utf8', timeout: 60000 });

    // Restore app config from repo if present
    const syncConfigPath = path.join(workspacePath, '.cotw-config.json');
    if (fs.existsSync(syncConfigPath)) {
      const restored = JSON.parse(fs.readFileSync(syncConfigPath, 'utf8'));
      // Merge restored config (preserve machine-specific fields)
      const machineFields = ['gatewayToken', 'githubToken', 'githubTokenEncrypted'];
      for (const [key, val] of Object.entries(restored)) {
        if (!machineFields.includes(key)) config[key] = val;
      }
      config.setupComplete = true;
      config.githubRepo = fullName;
      config.lastSyncTime = Date.now();
      saveConfig();
    }

    return { ok: true, agentName: config.agentName, userName: config.userName };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Manual sync trigger
ipcMain.handle('github:sync', async () => {
  try {
    await gitSyncWorkspace('manual sync');
    return { ok: true, lastSync: config.lastSyncTime };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Pull latest from remote (restore scenario only — workspace is source of truth)
ipcMain.handle('github:pull', async () => {
  const token = getGitHubToken();
  if (!token || !isGitRepo()) return { ok: false, error: 'Not connected' };

  try {
    // Commit any local changes first
    if (gitHasChanges()) {
      gitExec('add -A');
      try { gitExec('commit -m "pre-pull local changes"'); } catch {}
    }

    // Recover from any stuck state
    try { gitExec('rebase --abort'); } catch {}
    try { gitExec('merge --abort'); } catch {}

    const remote = gitExec('remote get-url origin');
    const cleanRemote = remote.replace(/https:\/\/[^@]+@/, 'https://');
    const authedRemote = cleanRemote.replace('https://', `https://x-access-token:${token}@`);
    try {
      gitExec(`pull --no-rebase --allow-unrelated-histories --no-edit ${authedRemote} main`);
    } catch {
      // Merge conflicts — local workspace wins, just force push
      try { gitExec('merge --abort'); } catch {}
      gitExec('add -A');
      try { gitExec('commit -m "resolve conflicts — local wins"'); } catch {}
      gitExec(`push ${authedRemote} main --force`);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Connection status — honest check (token + repo + remote all valid)
ipcMain.handle('github:status', () => {
  const token = getGitHubToken();
  const hasRepo = isGitRepo();
  let remoteUrl = null;
  let hasRemote = false;
  if (hasRepo) {
    try { remoteUrl = gitExec('remote get-url origin'); hasRemote = true; } catch {}
  }
  // Derive repo name from remote URL if config is missing
  let repoName = config.githubRepo || null;
  if (!repoName && remoteUrl) {
    const match = remoteUrl.match(/github\.com\/(.+?)\.git/);
    if (match) {
      repoName = match[1];
      config.githubRepo = repoName;
      saveConfig();
    }
  }
  return {
    connected: !!token && hasRepo && hasRemote,
    repo: repoName,
    lastSync: config.lastSyncTime || null,
    lastSyncStatus: config.lastSyncStatus || null,
    lastSyncError: config.lastSyncError || null,
    isRepo: hasRepo,
  };
});

// Disconnect
ipcMain.handle('github:disconnect', () => {
  delete config.githubToken;
  delete config.githubTokenEncrypted;
  delete config.githubRepo;
  delete config.lastSyncTime;
  saveConfig();
  // Remove git remote but keep local history
  try { gitExec('remote remove origin'); } catch {}
  return { ok: true };
});

// Auto-sync: pull on startup, periodic sync during off-hours
let syncInterval = null;
function startAutoSync() {
  if (syncInterval) return;
  // Verify remote is reachable on startup (don't pull — workspace is source of truth)
  if (getGitHubToken() && isGitRepo()) {
    const token = getGitHubToken();
    if (token) {
      (async () => {
        try {
          // Recover from any stuck state left by a crash
          try { gitExec('rebase --abort'); } catch {}
          try { gitExec('merge --abort'); } catch {}
          const remote = gitExec('remote get-url origin');
          const cleanRemote = remote.replace(/https:\/\/[^@]+@/, 'https://');
          const authedRemote = cleanRemote.replace('https://', `https://x-access-token:${token}@`);
          gitExec(`fetch ${authedRemote} main`);
          console.log('[GitHub] Remote verified on startup');
        } catch (err) {
          console.error(`[GitHub] Remote unreachable on startup: ${err.message}`);
        }
      })();
    }
  }

  // Periodic sync every 30 min
  syncInterval = setInterval(() => {
    gitSyncWorkspace('auto').catch(err => {
      console.error('[GitHub] Periodic sync failed:', err.message);
    });
  }, 30 * 60 * 1000);
}

function stopAutoSync() {
  if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
}

// ============================================================
// Utility
// ============================================================

function httpPost(url, body, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);
    const req = transport.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`HTTP ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}
