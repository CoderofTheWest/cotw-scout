/**
 * openclaw-plugin-evidence-quality / index.js
 *
 * Plugin shell. Loads config, exposes `evaluate()` as a gateway method
 * and as a direct require() target so other plugins (graph, contemplation,
 * standing, crystallization, continuity-reconstruct) can call it without
 * going through the gateway bus.
 *
 * Stateless: no per-agent state, no hooks. Pure function over DB reads.
 * The plugin form is just for config loading + gateway registration.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const evaluator = require('./lib/evaluator');

function loadDefaultConfig() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.default.json'), 'utf8'));
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source || {})) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else if (source[key] !== undefined) {
      result[key] = source[key];
    }
  }
  return result;
}

// G3: workspace resolution mirrors trust-circle's pattern. Tries env first,
// then known home-directory candidates. Returns null if no candidate exists
// and no env override is set — caller falls through to defaults-only blacklist.
function _resolveWorkspaceForBlacklist() {
  if (process.env.OPENCLAW_WORKSPACE) return process.env.OPENCLAW_WORKSPACE;
  const candidates = [
    path.join(os.homedir(), '.openclaw', 'workspace'),
    path.join(os.homedir(), '.openclaw', 'workspace-clint'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return null;
}

// G3: load and merge a per-agent noise blacklist from
//   <workspace>/circle/noise-blacklist.json
// Format: { "entries": ["mary", "walk_path", ...] }   OR   ["mary", ...]
// Universal entries (in config.default.json) are preserved and the per-agent
// entries are concatenated. Duplicate entries are deduped (case-insensitive).
function _loadPerAgentBlacklist(workspaceDir, logger) {
  if (!workspaceDir) return [];
  const blacklistPath = path.join(workspaceDir, 'circle', 'noise-blacklist.json');
  if (!fs.existsSync(blacklistPath)) return [];
  let raw;
  try { raw = fs.readFileSync(blacklistPath, 'utf8'); }
  catch (err) {
    if (logger) logger.warn(`[evidence-quality] failed to read ${blacklistPath}: ${err.message}`);
    return [];
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (err) {
    if (logger) logger.warn(`[evidence-quality] ${blacklistPath} is malformed JSON; ignoring: ${err.message}`);
    return [];
  }
  // Accept either a bare array or { entries: [...] } shape
  const entries = Array.isArray(parsed) ? parsed
    : (parsed && Array.isArray(parsed.entries) ? parsed.entries : null);
  if (!entries) {
    if (logger) logger.warn(`[evidence-quality] ${blacklistPath} must be an array or { entries: [...] }; ignoring`);
    return [];
  }
  return entries.filter(e => typeof e === 'string' && e.trim().length > 0);
}

function _mergeBlacklists(universal, perAgent) {
  const seen = new Set();
  const out = [];
  for (const list of [universal, perAgent]) {
    for (const entry of list || []) {
      const key = String(entry).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
    }
  }
  return out;
}

module.exports = {
  id: 'evidence-quality',
  name: 'Evidence Quality',

  configSchema: {
    jsonSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        thresholds: { type: 'object' },
        noiseBlacklist: { type: 'array', items: { type: 'string' } },
        logEvaluations: { type: 'boolean' }
      }
    }
  },

  register(api) {
    const defaults = loadDefaultConfig();
    const config = deepMerge(defaults, api.pluginConfig || {});

    if (config.enabled === false) {
      api.logger.info('[evidence-quality] disabled by config');
      return;
    }

    // G3: layer the per-agent corpus-specific noise blacklist on top of the
    // universal one. The merged list lives on `config.noiseBlacklist` so all
    // downstream evaluator calls pick it up without further plumbing.
    const universalCount = config.noiseBlacklist.length;
    const workspaceDir = _resolveWorkspaceForBlacklist();
    const perAgent = _loadPerAgentBlacklist(workspaceDir, api.logger);
    config.noiseBlacklist = _mergeBlacklists(config.noiseBlacklist, perAgent);

    api.logger.info(
      `[evidence-quality] loaded — ${config.noiseBlacklist.length} blacklisted names ` +
      `(${universalCount} universal + ${perAgent.length} per-agent from ${workspaceDir || '<no-workspace>'}), ` +
      `entity-min-name-length=${config.thresholds.entity.minNameLength}, ` +
      `person-min-exchanges=${config.thresholds.person.minDistinctExchangesForSufficient}`
    );

    // Expose evaluate as a gateway method so other plugins can call across the bus
    if (typeof api.registerGatewayMethod === 'function') {
      api.registerGatewayMethod('evidenceQuality.evaluate', (scope) => {
        const result = evaluator.evaluate(scope, config);
        if (config.logEvaluations) {
          api.logger.info(
            `[evidence-quality] evaluate(${scope.kind}) -> ${result.confidence}` +
            (result.reasonsBelow.length ? ` (${result.reasonsBelow.join('; ')})` : '')
          );
        }
        return result;
      });
    }

    // Stash config on the module export so direct require() callers can use it.
    // (Some plugins call sibling plugins via require() instead of the bus.)
    module.exports._activeConfig = config;
  },

  // Direct API for sibling plugins
  evaluate(scope, configOverride) {
    const config = configOverride || module.exports._activeConfig || loadDefaultConfig();
    return evaluator.evaluate(scope, config);
  },

  // Re-export specific evaluators for tighter call sites
  evaluateEntity:          (s, c) => evaluator.evaluateEntity(s,          c || module.exports._activeConfig || loadDefaultConfig()),
  evaluatePerson:          (s, c) => evaluator.evaluatePerson(s,          c || module.exports._activeConfig || loadDefaultConfig()),
  evaluateTopic:           (s, c) => evaluator.evaluateTopic(s,           c || module.exports._activeConfig || loadDefaultConfig()),
  evaluateExchangeWindow:  (s, c) => evaluator.evaluateExchangeWindow(s,  c || module.exports._activeConfig || loadDefaultConfig()),
  evaluateSpeaker:         (s, c) => evaluator.evaluateSpeaker(s,         c || module.exports._activeConfig || loadDefaultConfig()),

  loadDefaultConfig
};
