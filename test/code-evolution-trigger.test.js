const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const codeEvolutionPlugin = require('../bundled-plugins/openclaw-plugin-code-evolution');
const { readEvolutionLedger } = require('../lib/evolution-ledger');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'code-evolution-trigger-'));
}

function createApi(pluginConfig) {
  const methods = new Map();
  return {
    methods,
    pluginConfig,
    logger: { info() {}, warn() {} },
    on() {},
    registerGatewayMethod(name, handler) {
      methods.set(name, handler);
    }
  };
}

function writeSession(dataDir, session) {
  const sessionsDir = path.join(dataDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, `${session.startedAt.replace(/[:.]/g, '-')}_${session.sessionId}.json`), JSON.stringify(session, null, 2));
}

function session(id, toolCalls) {
  return {
    sessionId: id,
    agentId: 'trail-guide',
    startedAt: `2026-05-21T10:0${id}:00.000Z`,
    endedAt: `2026-05-21T10:1${id}:00.000Z`,
    messageCount: 2,
    toolCalls,
    satisfactionSignals: [],
    scaffoldVersion: 'seed',
    outcome: 'completed'
  };
}

test('code-evolution.trigger records scaffold proposal receipts without mutating evolved scaffold', async () => {
  const dataDir = tmpDir();
  const workspacePath = tmpDir();
  const api = createApi({
    storage: { dataDir },
    analysis: {
      minSessionsForPattern: 2,
      patternConfidenceThreshold: 0.6,
      maxPatternsPerCycle: 5,
      minToolFailuresForProposal: 2,
      highToolCallThreshold: 40,
      minCorrectionSignalsForProposal: 2
    }
  });

  codeEvolutionPlugin.register(api);
  writeSession(dataDir, session('1', [{ toolName: 'exec', success: false, resultSummary: 'command failed' }]));
  writeSession(dataDir, session('2', [{ toolName: 'exec', success: false, resultSummary: 'enoent' }]));

  const rulesPath = path.join(dataDir, 'evolved', 'code-mode-rules.md');
  const rulesBefore = fs.readFileSync(rulesPath, 'utf8');
  const trigger = api.methods.get('code-evolution.trigger');
  assert.equal(typeof trigger, 'function');

  const result = await trigger({ agentId: 'trail-guide', days: 7, ctx: { workspaceDir: workspacePath } });

  assert.equal(result.skipped, false);
  assert.equal(result.recorded, 1);
  assert.equal(result.ledger, 'workspace');
  assert.match(result.message, /recorded 1 proposal receipt/);
  assert.equal(fs.readFileSync(rulesPath, 'utf8'), rulesBefore);

  const ledger = readEvolutionLedger(path.join(workspacePath, 'evolution', 'ledger.json'));
  assert.equal(ledger.events.length, 1);
  assert.equal(ledger.events[0].action, 'scaffold_proposal');
  assert.equal(ledger.events[0].status, 'preview');
  assert.equal(ledger.events[0].metadata.mutationAttempted, 'false');
});

test('code-evolution.trigger skips cleanly when evidence is insufficient', async () => {
  const dataDir = tmpDir();
  const workspacePath = tmpDir();
  const api = createApi({
    storage: { dataDir },
    analysis: { minSessionsForPattern: 3 }
  });

  codeEvolutionPlugin.register(api);
  writeSession(dataDir, session('1', [{ toolName: 'exec', success: false, resultSummary: 'command failed' }]));

  const result = await api.methods.get('code-evolution.trigger')({ agentId: 'trail-guide', days: 7, ctx: { workspaceDir: workspacePath } });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'insufficient_data');
  assert.equal(fs.existsSync(path.join(workspacePath, 'evolution', 'ledger.json')), false);
});
