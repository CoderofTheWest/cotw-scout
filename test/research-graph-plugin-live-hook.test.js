const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const plugin = require('../bundled-plugins/openclaw-plugin-research-graph');

function makeApi(pluginConfig) {
  const hooks = new Map();
  const logs = [];
  return {
    pluginConfig,
    logger: {
      info: (msg) => logs.push(['info', msg]),
      warn: (msg) => logs.push(['warn', msg]),
      error: (msg) => logs.push(['error', msg])
    },
    on(name, handler) { hooks.set(name, handler); },
    hooks,
    logs
  };
}

async function runHook(api, prompt) {
  const handler = api.hooks.get('before_agent_start');
  assert.equal(typeof handler, 'function');
  return handler({ messages: [{ role: 'user', content: prompt }], metadata: { sessionId: 's1', exchangeId: 'e1' } }, { agentId: 'trail-guide', sessionId: 's1', runId: 'r1' });
}

function tempRuntime() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'research-graph-plugin-'));
}

function localCotwClawProjectDir() {
  return process.env.COTW_CLAW_PROJECT_DIR || path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'COTW Trail Guide',
    'workspace',
    'projects',
    'cotw-claw'
  );
}

function hasResearchGraphProject(projectDir) {
  return fs.existsSync(path.join(projectDir, 'src', 'research-graph-store.js'));
}

function makePluginConfig(runtimeRoot) {
  return {
    runtimeRoot,
    cotwClawProjectDir: localCotwClawProjectDir()
  };
}

const researchGraphProjectAvailable = hasResearchGraphProject(localCotwClawProjectDir());

test('research graph plugin shadows normal prompts without injection', { skip: !researchGraphProjectAvailable }, async () => {
  const runtimeRoot = tempRuntime();
  const api = makeApi(makePluginConfig(runtimeRoot));
  plugin.register(api);

  const result = await runHook(api, 'Hey, I am back. How are we doing?');
  assert.deepEqual(result, {});
  assert.ok(api.logs.some(([, msg]) => msg.includes('shadow mode=normal_conversation')));
  assert.ok(api.logs.some(([, msg]) => msg.includes('hits=')));
});

test('research graph plugin injects fused canary for explicit research prompts', { skip: !researchGraphProjectAvailable }, async () => {
  const runtimeRoot = tempRuntime();
  const api = makeApi(makePluginConfig(runtimeRoot));
  plugin.register(api);

  const result = await runHook(api, 'Design a research plan for Build 7 autonomous maturation lane with experiments and architecture tradeoffs.');
  assert.equal(typeof result.prependContext, 'string');
  assert.match(result.prependContext, /## Fused ContextRank Context/);
  assert.match(result.prependContext, /creative=/);
  assert.ok(!result.prependContext.includes('## Creative Graph Context'));
  assert.ok(result.prependContext.length <= 2400);
});

test('research graph plugin fails closed when canary disabled', { skip: !researchGraphProjectAvailable }, async () => {
  const runtimeRoot = tempRuntime();
  const api = makeApi({ ...makePluginConfig(runtimeRoot), canary: { enabled: false }, shadow: { enabled: true } });
  plugin.register(api);

  const result = await runHook(api, 'Design a research plan for Build 7 autonomous maturation lane.');
  assert.deepEqual(result, {});
  assert.ok(api.logs.some(([, msg]) => msg.includes('shadow mode=creative_research')));
});
