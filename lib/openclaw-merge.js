// Pure merge logic for openclaw.json bundled→runtime reconciliation.
//
// Extracted from main.js so it can be unit-tested without booting Electron.
// On startup, main.js reads the bundled openclaw.json template and merges
// runtime state (user model choices, custom providers, plugin config) into
// the fresh template. These functions implement that merge.

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Deep-merge `existingValue` over `freshValue`. Existing values win for leaves;
// nested plain objects are merged recursively.
function mergeRuntimeObject(freshValue = {}, existingValue = {}) {
  const merged = { ...freshValue };
  for (const [key, value] of Object.entries(existingValue)) {
    if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = mergeRuntimeObject(merged[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function getModelKey(model) {
  if (typeof model === 'string') return model;
  if (!model || typeof model !== 'object') return null;
  return model.id || model.name || model.model || null;
}

// Merge two model lists by key (id/name/model). Existing entries with matching
// keys overlay fresh entries (deep-merge for objects, replace for primitives).
// Existing entries without a fresh match are appended.
function mergeModelList(freshModels = [], existingModels = []) {
  const merged = [];
  const indexes = new Map();

  for (const model of freshModels) {
    const key = getModelKey(model);
    if (key) indexes.set(key, merged.length);
    merged.push(model);
  }

  for (const model of existingModels) {
    const key = getModelKey(model);
    if (key && indexes.has(key)) {
      const index = indexes.get(key);
      merged[index] = isPlainObject(merged[index]) && isPlainObject(model)
        ? mergeRuntimeObject(merged[index], model)
        : model;
    } else {
      if (key) indexes.set(key, merged.length);
      merged.push(model);
    }
  }

  return merged;
}

// Merge providers map. For each existing provider, deep-merge into the fresh
// provider; if either has a `models` array, also merge the model lists by key.
function mergeModelProviders(freshProviders = {}, existingProviders = {}) {
  const merged = { ...freshProviders };
  for (const [providerId, existingProvider] of Object.entries(existingProviders)) {
    const freshProvider = merged[providerId];
    if (isPlainObject(freshProvider) && isPlainObject(existingProvider)) {
      merged[providerId] = mergeRuntimeObject(freshProvider, existingProvider);
      if (Array.isArray(freshProvider.models) || Array.isArray(existingProvider.models)) {
        merged[providerId].models = mergeModelList(
          freshProvider.models || [],
          existingProvider.models || []
        );
      }
    } else {
      merged[providerId] = existingProvider;
    }
  }
  return merged;
}

module.exports = {
  isPlainObject,
  mergeRuntimeObject,
  getModelKey,
  mergeModelList,
  mergeModelProviders,
};
