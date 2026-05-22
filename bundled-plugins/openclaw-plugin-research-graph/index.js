const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { instrumentApiHooks } = require('../lib/runtime-metrics');

function deepMerge(target, source) {
  const result = { ...(target || {}) };
  for (const key of Object.keys(source || {})) {
    const next = source[key];
    if (next && typeof next === 'object' && !Array.isArray(next)) {
      result[key] = deepMerge(result[key] || {}, next);
    } else {
      result[key] = next;
    }
  }
  return result;
}

function loadConfig(userConfig) {
  const defaults = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.default.json'), 'utf8'));
  return deepMerge(defaults, userConfig || {});
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function lastUserText(messages) {
  const last = [...(messages || [])].reverse().find((m) => m && m.role === 'user');
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  if (typeof last.text === 'string') return last.text;
  if (Array.isArray(last.content)) {
    return last.content.map((part) => typeof part === 'string' ? part : part?.text || '').join('\n');
  }
  return '';
}

function compact(text, max = 180) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length <= max ? value : `${value.slice(0, max - 15)}... [truncated]`;
}

function resolveProjectDir(config) {
  const configured = config.cotwClawProjectDir || process.env.COTW_CLAW_PROJECT_DIR;
  if (configured) return path.resolve(__dirname, configured);
  return path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'COTW Scout',
    'workspace',
    'projects',
    'cotw-claw'
  );
}

function loadResearchGraphModules(config) {
  const projectDir = resolveProjectDir(config);
  const srcDir = path.join(projectDir, 'src');
  return {
    projectDir,
    ResearchGraphStore: require(path.join(srcDir, 'research-graph-store.js')).ResearchGraphStore,
    classifyCreativeGraphPrompt: require(path.join(srcDir, 'creative-graph-mode.js')).classifyCreativeGraphPrompt,
    buildFusedContext: require(path.join(srcDir, 'context-ranker.js')).buildFusedContext,
    renderFusedContext: require(path.join(srcDir, 'context-ranker.js')).renderFusedContext
  };
}

function defaultBaseRuntimeRoot() {
  return path.join(process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw-cotw'), 'research-graph');
}

function agentRuntimeRoot(config, agentId) {
  const base = path.resolve(config.runtimeRoot || defaultBaseRuntimeRoot());
  return path.join(base, 'agents', agentId || 'main');
}

function seedIfNeeded({ store, config, projectDir, logger, agentId }) {
  if (config.seedOnStart === false) return { seeded: false, reason: 'disabled' };
  const counts = store.countRows();
  const beforeNodes = Number(counts.research_nodes || counts.nodes || 0);
  const beforeEdges = Number(counts.research_edges || counts.edges || 0);
  if (beforeNodes > 0) return { seeded: false, reason: 'already_seeded', counts };
  const fixtureDir = path.join(projectDir, 'src', 'eval', 'fixtures', 'research-graph-real-corpus');
  const files = config.seedFixtures || [];
  const imported = [];
  for (const file of files) {
    const fullPath = path.join(fixtureDir, file);
    if (!fs.existsSync(fullPath)) continue;
    imported.push(store.ingestEpisodeFile(fullPath));
  }
  const after = store.countRows();
  const afterNodes = Number(after.research_nodes || after.nodes || 0);
  const afterEdges = Number(after.research_edges || after.edges || 0);
  logger?.info?.(`[ResearchGraph:${agentId}] Seeded ${imported.length} fixture episode(s): ${beforeNodes} → ${afterNodes} nodes, ${beforeEdges} → ${afterEdges} edges`);
  return { seeded: true, imported: imported.length, before: counts, after };
}

function buildCanaryPacket({ modules, runtime, prompt, searchResult, config, sessionId, turnId }) {
  const budgetChars = Number(config.canary?.budgetChars || 1300);
  const limit = Number(config.canary?.limit || 3);
  const fusion = modules.buildFusedContext({
    runtime,
    sessionId: sessionId || 'openclaw_research_graph',
    turnId: turnId || new Date().toISOString().replace(/[:.]/g, '-'),
    prompt,
    creativeGraphContext: searchResult,
    limit,
    budgetChars
  });
  if (!fusion?.ok || !fusion.results?.length || !fusion.receipt) return null;
  const packet = modules.renderFusedContext(fusion).trimEnd();
  const maxPacketChars = Number(config.canary?.maxPacketChars || 2400);
  if (packet.length > maxPacketChars) return null;
  return packet;
}

module.exports = {
  id: 'research-graph',
  name: 'Research Graph Canary',

  register(api) {
    api = instrumentApiHooks(api, 'research-graph');
    const config = loadConfig(api.pluginConfig || {});
    if (!config.enabled) {
      api.logger?.info?.('ResearchGraph plugin disabled via config');
      return;
    }

    let modules;
    try {
      modules = loadResearchGraphModules(config);
    } catch (error) {
      api.logger?.error?.(`[ResearchGraph] Failed to load COTW Claw modules: ${error.message}`);
      return;
    }

    const states = new Map();
    function getState(agentId) {
      const id = agentId || 'main';
      if (!states.has(id)) {
        const runtimeRoot = agentRuntimeRoot(config, id);
        ensureDir(runtimeRoot);
        const store = new modules.ResearchGraphStore({ runtimeRoot });
        const seeded = seedIfNeeded({ store, config, projectDir: modules.projectDir, logger: api.logger, agentId: id });
        states.set(id, { agentId: id, runtimeRoot, store, runtime: store.runtime, seeded });
        api.logger?.info?.(`[ResearchGraph] Initialized state for agent "${id}" — runtime: ${runtimeRoot}`);
      }
      return states.get(id);
    }

    api.on('before_agent_start', async (event, ctx) => {
      const agentId = ctx.agentId || 'main';
      const prompt = lastUserText(event.messages);
      if (!prompt || prompt.trim().length < 5) return {};

      const state = getState(agentId);
      const eligibility = modules.classifyCreativeGraphPrompt(prompt);
      const shouldSearch = config.shadow?.enabled === true || config.canary?.enabled === true;
      if (!shouldSearch) return {};

      let searchResult;
      try {
        searchResult = state.store.search(prompt, {
          limit: Number(config.shadow?.limit || config.canary?.limit || 3),
          contextAlready: [prompt]
        });
      } catch (error) {
        api.logger?.warn?.(`[ResearchGraph:${agentId}] Search failed closed: ${error.message}`);
        return {};
      }

      const shadowCount = Number(searchResult?.resultCount || 0);
      api.logger?.info?.(`[ResearchGraph:${agentId}] shadow mode=${eligibility.mode} eligible=${eligibility.eligibleForCanary} hits=${shadowCount} receipt=${searchResult?.receipt || 'none'} query="${compact(prompt)}"`);

      if (config.canary?.enabled !== true) return {};
      if (!eligibility.eligibleForCanary) return {};
      if (!searchResult?.ok || shadowCount <= 0) return {};
      if (config.canary?.requireReceipt !== false && !searchResult.receipt) return {};
      if ((config.canary?.renderMode || 'fusion') !== 'fusion') return {};

      const packet = buildCanaryPacket({
        modules,
        runtime: state.runtime,
        prompt,
        searchResult,
        config,
        sessionId: event.metadata?.sessionId || ctx.sessionId,
        turnId: event.metadata?.exchangeId || ctx.runId
      });
      if (!packet) {
        api.logger?.warn?.(`[ResearchGraph:${agentId}] Canary packet suppressed by fusion/budget gate`);
        return {};
      }

      api.logger?.info?.(`[ResearchGraph:${agentId}] Injecting narrow fused canary packet chars=${packet.length} receipt=${searchResult.receipt}`);
      return { prependContext: packet };
    }, { priority: 9 });
  },

  _private: {
    loadConfig,
    lastUserText,
    agentRuntimeRoot,
    buildCanaryPacket,
    seedIfNeeded,
    defaultBaseRuntimeRoot
  }
};
