const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const graphPlugin = require('../bundled-plugins/openclaw-plugin-graph');

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

test('live graph plugin registers ResearchGraph narrow canary bridge', { skip: !hasResearchGraphProject(localCotwClawProjectDir()) }, () => {
  const cotwClawProjectDir = localCotwClawProjectDir();
  const hooks = [];
  const logs = [];
  const api = {
    pluginConfig: {
      backfill: { enabled: false },
      researchGraphCanary: {
        enabled: true,
        cotwClawProjectDir,
        runtimeRoot: '/tmp/openclaw-research-graph-bridge-test',
        seedOnStart: false,
        shadow: { enabled: true, limit: 3 },
        canary: { enabled: true, limit: 3, budgetChars: 1300, maxPacketChars: 2400, requireReceipt: true, renderMode: 'fusion' }
      }
    },
    logger: {
      info: (msg) => logs.push(['info', msg]),
      warn: (msg) => logs.push(['warn', msg]),
      error: (msg) => logs.push(['error', msg])
    },
    on(name, handler, options) { hooks.push({ name, handler, options }); },
    registerGatewayMethod() {},
    registerTool() {}
  };

  graphPlugin.register(api);

  assert.ok(logs.some(([, msg]) => msg.includes('ResearchGraph narrow canary bridge registered')));
  assert.ok(hooks.filter((hook) => hook.name === 'before_agent_start').length >= 2);
});
