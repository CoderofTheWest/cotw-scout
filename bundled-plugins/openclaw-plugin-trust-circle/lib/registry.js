/**
 * openclaw-plugin-trust-circle / lib / registry.js
 *
 * Loads and validates the trust circle profile registry.
 *
 * The registry is the authoritative source for speakerId resolution
 * (Phase 2) and trust-rank-aware metabolism (Phase 5). It must NEVER
 * default unknown senders to the anchor profile — that recreates the
 * silent-failure trap from the 2026-04-29 Kyle incident.
 *
 * Failure modes are loud by design:
 *   - registry.json missing AND no defaultOperator config -> throw
 *     (we will not bootstrap a registry with unknown operator identity)
 *   - registry.json missing BUT defaultOperator config provided -> return
 *     synthetic in-memory registry with one anchor profile, log a warning
 *     telling the operator to flesh out the registry
 *   - registry.json malformed -> throw with parse error
 *   - profile entry references identityFile that doesn't exist -> throw
 *     naming the offending profile and the missing path
 *     (synthetic-default profile is exempt; we log a warn instead)
 *   - duplicate profile id -> throw
 *   - duplicate channel sender (two profiles claim the same Telegram id) -> throw
 *
 * If the registry loads cleanly, callers get back an object with both
 * the raw profile list and a sender-keyed index for O(1) resolution.
 */

const fs = require('fs');
const path = require('path');

const VALID_RANKS = new Set(['anchor', 'guest', 'visitor']);
// Editor provenance tags. The list is append-only — older deployments may
// have on-disk profiles tagged with any of these, so removing entries would
// reject valid existing data on load.
//   - 'initial'                     bootstrap entries (this plugin)
//   - 'hand-edit'                   operator hand-edited the JSON directly
//   - 'operator-direct'             generic: the operator made the edit through some operator-side tool
//   - 'chris-direct'                Clint-deployment legacy alias of operator-direct
//   - '<plugin>-plugin'             specific plugin authored the change
//   - 'clint-tool'                  Clint-deployment legacy: a clint-side tool wrote the entry
const VALID_EDITOR_TAGS = new Set([
  'initial',
  'hand-edit',
  'operator-direct',
  'chris-direct',
  'standing-plugin',
  'contemplation-plugin',
  'crystallization-plugin',
  'trust-circle-plugin',
  'clint-tool',
  'clint-reconstruct',     // continuity_reconstruct tool output (Tier 3)
  'continuity-expand',     // continuity_expand tool output if it ever writes
  'evidence-quality-plugin' // evidence-quality plugin's own writes if any
]);

/**
 * Build an in-memory synthetic registry from a defaultOperator config.
 * Used when registry.json doesn't exist yet on a fresh deployment.
 *
 * Required fields on defaultOperator: id, displayName.
 * Optional: identityFile (default 'ANCHOR.md'), channels (default {}).
 */
function _bootstrapDefaultRegistry(workspaceDir, defaultOperator, logger) {
  if (!defaultOperator || typeof defaultOperator !== 'object') {
    throw new Error(
      '[trust-circle/registry] defaultOperator config must be an object with at least { id, displayName }'
    );
  }
  if (!defaultOperator.id || typeof defaultOperator.id !== 'string') {
    throw new Error('[trust-circle/registry] defaultOperator.id is required');
  }
  if (!defaultOperator.displayName || typeof defaultOperator.displayName !== 'string') {
    throw new Error('[trust-circle/registry] defaultOperator.displayName is required');
  }

  const identityFile = defaultOperator.identityFile || 'ANCHOR.md';
  const identityPath = path.join(workspaceDir, identityFile);
  if (!fs.existsSync(identityPath) && logger) {
    logger.warn(
      `[trust-circle/registry] bootstrap: identity file ${identityFile} does not exist at ${identityPath}. ` +
      `The operator profile will load anyway (synthetic-default exemption); please author this file before guests are added.`
    );
  }

  const profile = {
    id: defaultOperator.id,
    rank: 'anchor',
    displayName: defaultOperator.displayName,
    vouchedBy: null,
    identityFile,
    channels: defaultOperator.channels || {},
    lastModifiedBy: 'initial',
    lastModifiedAt: new Date().toISOString()
  };

  return { version: 1, profiles: [profile], _synthetic: true };
}

/**
 * Index a parsed registry data object into the runtime shape used by the plugin.
 * Validates each profile, builds byId / byChannelSender maps, and checks vouchedBy refs.
 *
 * @param {Object} data         - the parsed registry JSON
 * @param {string} workspaceDir
 * @param {Object} options      - { skipIdentityFileCheck: bool } — set for synthetic-default
 * @returns {{profiles, byId, byChannelSender, workspaceDir, registryPath, _synthetic}}
 */
function _indexRegistry(data, workspaceDir, options = {}) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.profiles)) {
    throw new Error('[trust-circle/registry] registry data missing or malformed "profiles" array');
  }

  const byId = new Map();
  const byChannelSender = new Map();

  for (const profile of data.profiles) {
    if (!profile || typeof profile !== 'object') {
      throw new Error('[trust-circle/registry] profile entry is not an object');
    }
    if (!profile.id || typeof profile.id !== 'string') {
      throw new Error(`[trust-circle/registry] profile missing string "id": ${JSON.stringify(profile)}`);
    }
    if (!VALID_RANKS.has(profile.rank)) {
      throw new Error(
        `[trust-circle/registry] profile "${profile.id}" has invalid rank "${profile.rank}". ` +
        `Must be one of: ${[...VALID_RANKS].join(', ')}`
      );
    }
    if (!profile.identityFile || typeof profile.identityFile !== 'string') {
      throw new Error(`[trust-circle/registry] profile "${profile.id}" missing "identityFile"`);
    }

    if (!profile.lastModifiedBy || typeof profile.lastModifiedBy !== 'string') {
      throw new Error(
        `[trust-circle/registry] profile "${profile.id}" missing "lastModifiedBy" (provenance is required, not optional)`
      );
    }
    if (!VALID_EDITOR_TAGS.has(profile.lastModifiedBy)) {
      throw new Error(
        `[trust-circle/registry] profile "${profile.id}" lastModifiedBy "${profile.lastModifiedBy}" is not a recognized editor tag. ` +
        `Must be one of: ${[...VALID_EDITOR_TAGS].join(', ')}`
      );
    }
    if (!profile.lastModifiedAt || typeof profile.lastModifiedAt !== 'string') {
      throw new Error(
        `[trust-circle/registry] profile "${profile.id}" missing "lastModifiedAt" ISO timestamp`
      );
    }

    if (!options.skipIdentityFileCheck) {
      const identityPath = path.join(workspaceDir, profile.identityFile);
      if (!fs.existsSync(identityPath)) {
        throw new Error(
          `[trust-circle/registry] profile "${profile.id}" identityFile "${profile.identityFile}" ` +
          `does not exist at ${identityPath}. Either create the file or remove the profile from the registry.`
        );
      }
    }

    if (byId.has(profile.id)) {
      throw new Error(`[trust-circle/registry] duplicate profile id "${profile.id}"`);
    }
    byId.set(profile.id, profile);

    if (profile.channels && typeof profile.channels === 'object') {
      for (const [channel, senders] of Object.entries(profile.channels)) {
        if (!Array.isArray(senders)) {
          throw new Error(
            `[trust-circle/registry] profile "${profile.id}" channels.${channel} must be an array of sender ids`
          );
        }
        for (const senderId of senders) {
          const key = `${channel}:${String(senderId)}`;
          if (byChannelSender.has(key)) {
            const existing = byChannelSender.get(key);
            throw new Error(
              `[trust-circle/registry] sender "${key}" claimed by both "${existing.id}" and "${profile.id}"`
            );
          }
          byChannelSender.set(key, profile);
        }
      }
    }
  }

  for (const profile of data.profiles) {
    if (profile.vouchedBy && !byId.has(profile.vouchedBy)) {
      throw new Error(
        `[trust-circle/registry] profile "${profile.id}" vouchedBy "${profile.vouchedBy}" ` +
        `does not exist in the registry`
      );
    }
  }

  return {
    profiles: data.profiles,
    byId,
    byChannelSender,
    workspaceDir,
    registryPath: path.join(workspaceDir, 'circle', 'registry.json'),
    _synthetic: !!data._synthetic
  };
}

/**
 * Load and validate the trust circle registry from a workspace directory.
 *
 * @param {string} workspaceDir  - absolute path to the OpenClaw workspace
 *                                 (e.g. ~/.openclaw/workspace-clint)
 * @param {Object} [options]
 * @param {Object} [options.defaultOperator] - { id, displayName, identityFile?, channels? }
 *   used to bootstrap a synthetic registry when registry.json doesn't exist
 *   on disk (G2 — fresh deployment). Without this, a missing file throws.
 * @param {Object} [options.logger] - optional logger for warn() during bootstrap
 * @returns {{profiles, byId, byChannelSender, workspaceDir, registryPath, _synthetic}}
 * @throws {Error} on any registry corruption — never silently defaults
 */
function loadRegistry(workspaceDir, options = {}) {
  if (!workspaceDir || typeof workspaceDir !== 'string') {
    throw new Error('[trust-circle/registry] workspaceDir must be a non-empty string');
  }

  const registryPath = path.join(workspaceDir, 'circle', 'registry.json');

  if (!fs.existsSync(registryPath)) {
    if (options.defaultOperator) {
      // G2: bootstrap synthetic registry. Operator can flesh it out on disk
      // by calling the trust_circle_register tool or hand-editing the file.
      if (options.logger) {
        options.logger.warn(
          `[trust-circle/registry] no registry found at ${registryPath} — ` +
          `initialized synthetic in-memory registry from defaultOperator config (` +
          `id=${options.defaultOperator.id}, rank=anchor). ` +
          `Use the trust_circle_register tool or edit ${registryPath} to add guests/visitors.`
        );
      }
      const data = _bootstrapDefaultRegistry(workspaceDir, options.defaultOperator, options.logger);
      return _indexRegistry(data, workspaceDir, { skipIdentityFileCheck: true });
    }
    throw new Error(`[trust-circle/registry] registry.json not found at ${registryPath}`);
  }

  let raw;
  try {
    raw = fs.readFileSync(registryPath, 'utf8');
  } catch (err) {
    throw new Error(`[trust-circle/registry] failed to read ${registryPath}: ${err.message}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`[trust-circle/registry] failed to parse ${registryPath}: ${err.message}`);
  }

  return _indexRegistry(data, workspaceDir);
}

/**
 * Resolve a sender (by channel + senderId) to a profile.
 * Returns null if unknown — caller is responsible for handling visitors loudly.
 *
 * @param {Object} registry  - the object returned by loadRegistry()
 * @param {string} channel   - e.g. "telegram"
 * @param {string|number} senderId
 * @returns {Object|null}    - the matched profile, or null if unknown
 */
function resolveSender(registry, channel, senderId) {
  if (!registry || !registry.byChannelSender) return null;
  const key = `${channel}:${String(senderId)}`;
  return registry.byChannelSender.get(key) || null;
}

/**
 * Atomically update a profile's lastModifiedBy / lastModifiedAt provenance.
 * Used by editors that touch a profile or its identityFile.
 *
 * @param {string} workspaceDir
 * @param {string} profileId
 * @param {string} editorTag - one of VALID_EDITOR_TAGS
 * @returns {Object} the updated profile
 */
function recordEdit(workspaceDir, profileId, editorTag) {
  if (!VALID_EDITOR_TAGS.has(editorTag)) {
    throw new Error(
      `[trust-circle/registry] recordEdit: invalid editorTag "${editorTag}". ` +
      `Must be one of: ${[...VALID_EDITOR_TAGS].join(', ')}`
    );
  }
  const registryPath = path.join(workspaceDir, 'circle', 'registry.json');
  const data = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const profile = data.profiles.find(p => p.id === profileId);
  if (!profile) {
    throw new Error(`[trust-circle/registry] recordEdit: profile "${profileId}" not in registry`);
  }
  profile.lastModifiedBy = editorTag;
  profile.lastModifiedAt = new Date().toISOString();
  fs.writeFileSync(registryPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return profile;
}

/**
 * Atomically add a new profile to registry.json. Creates the file (and the
 * circle/ directory) if missing — used by trust_circle_register tool.
 *
 * Validates the profile via _indexRegistry before writing. If the new file
 * would fail validation, throws and leaves disk untouched.
 *
 * @param {string} workspaceDir
 * @param {Object} profile - { id, rank, displayName, vouchedBy?, identityFile, channels? }
 * @param {Object} [options]
 * @param {string} [options.editorTag='trust-circle-plugin']
 * @returns {Object} the validated registry runtime object
 */
function addProfile(workspaceDir, profile, options = {}) {
  if (!workspaceDir || typeof workspaceDir !== 'string') {
    throw new Error('[trust-circle/registry] addProfile: workspaceDir required');
  }
  if (!profile || typeof profile !== 'object') {
    throw new Error('[trust-circle/registry] addProfile: profile must be an object');
  }

  const editorTag = options.editorTag || 'trust-circle-plugin';
  if (!VALID_EDITOR_TAGS.has(editorTag)) {
    throw new Error(
      `[trust-circle/registry] addProfile: invalid editorTag "${editorTag}"`
    );
  }

  const registryPath = path.join(workspaceDir, 'circle', 'registry.json');
  let data;
  if (fs.existsSync(registryPath)) {
    try {
      data = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    } catch (err) {
      throw new Error(`[trust-circle/registry] addProfile: cannot parse existing ${registryPath}: ${err.message}`);
    }
    if (!Array.isArray(data.profiles)) {
      throw new Error(`[trust-circle/registry] addProfile: existing registry malformed`);
    }
  } else if (options.defaultOperator) {
    // First write to disk on a deployment that's been running off the
    // synthetic-default registry. Materialize the anchor so vouchedBy refs
    // (which always point at the anchor for fresh guests) resolve.
    data = _bootstrapDefaultRegistry(workspaceDir, options.defaultOperator);
    delete data._synthetic; // file-on-disk is no longer synthetic
  } else {
    data = { version: 1, profiles: [] };
  }

  const newEntry = {
    id: profile.id,
    rank: profile.rank,
    displayName: profile.displayName || profile.id,
    vouchedBy: profile.vouchedBy || null,
    identityFile: profile.identityFile,
    channels: profile.channels || {},
    lastModifiedBy: editorTag,
    lastModifiedAt: new Date().toISOString()
  };
  data.profiles.push(newEntry);

  // Validate by indexing — if anything's wrong, throw before touching disk
  const validated = _indexRegistry(data, workspaceDir);

  // Ensure circle/ exists
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify(data, null, 2) + '\n', 'utf8');

  return validated;
}

module.exports = {
  loadRegistry,
  resolveSender,
  recordEdit,
  addProfile,
  VALID_RANKS: [...VALID_RANKS],
  VALID_EDITOR_TAGS: [...VALID_EDITOR_TAGS]
};
