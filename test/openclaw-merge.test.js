// Regression tests for the bundled→runtime openclaw.json merge.
//
// These lock in the fix for the clobber-on-startup bug where a fresh app boot
// would overwrite the user's runtime model choice and custom provider entries
// with the bundled template values. See main.js writeOpenClawConfig() for the
// caller; lib/openclaw-merge.js for the merge logic under test.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  isPlainObject,
  mergeRuntimeObject,
  getModelKey,
  mergeModelList,
  mergeModelProviders,
} = require('../lib/openclaw-merge');


function materializeOpenClawTemplate(relPath) {
  const templatePath = path.join(__dirname, '..', relPath);
  return JSON.parse(fs.readFileSync(templatePath, 'utf8')
    .replace(/\{\{WORKSPACE_PATH\}\}/g, '/tmp/cotw-workspace')
    .replace(/\{\{AGENT_NAME\}\}/g, 'Scout')
    .replace(/\{\{GATEWAY_TOKEN\}\}/g, 'test-token')
    .replace(/\{\{OPERATOR_ID\}\}/g, 'operator')
    .replace(/\{\{OPERATOR_DISPLAY_NAME\}\}/g, 'Operator')
    .replace(/\{\{PLUGIN_PATHS\}\}/g, '[]'));
}

test('openclaw templates carry non-brittle compaction defaults through runtime merge', () => {
  for (const relPath of ['openclaw.json', 'bundled-openclaw/openclaw.json']) {
    const fresh = materializeOpenClawTemplate(relPath);
    const existingDefaults = {
      model: { primary: 'openai-codex/gpt-5.5' },
      compaction: {
        mode: 'default',
        reserveTokensFloor: 30000,
        maxHistoryShare: 0.4,
        recentTurnsPreserve: 5,
      },
    };
    const merged = mergeRuntimeObject(fresh.agents.defaults, existingDefaults);
    assert.equal(merged.compaction.truncateAfterCompaction, true, `${relPath}: successor transcript rotation must default on`);
    assert.equal(merged.compaction.maxActiveTranscriptBytes, '20mb', `${relPath}: active transcript byte guard must default to 20mb`);
    assert.equal(merged.model.primary, 'openai-codex/gpt-5.5', `${relPath}: existing runtime defaults must still win`);
  }
});

test('mergeRuntimeObject: agents.defaults.model.primary survives merge (literal regression case)', () => {
  const fresh = {
    agents: { defaults: { model: { primary: 'ollama/glm-5:cloud' } } },
  };
  const existing = {
    agents: { defaults: { model: { primary: 'ollama/deepseek-v4-flash:cloud' } } },
  };
  const merged = mergeRuntimeObject(fresh.agents.defaults, existing.agents.defaults);
  assert.equal(merged.model.primary, 'ollama/deepseek-v4-flash:cloud',
    'user runtime primary must override bundled template primary');
});

test('mergeRuntimeObject: agents.defaults.bootstrapMaxChars survives merge', () => {
  const fresh = { bootstrapMaxChars: 50000, blockStreamingDefault: 'on' };
  const existing = { bootstrapMaxChars: 80000 };
  const merged = mergeRuntimeObject(fresh, existing);
  assert.equal(merged.bootstrapMaxChars, 80000,
    'user-customized bootstrap budget must override bundled default');
  assert.equal(merged.blockStreamingDefault, 'on',
    'fresh keys not in existing must remain');
});

test('mergeRuntimeObject: nested objects deep-merge, primitives replace', () => {
  const fresh = { a: { x: 1, y: 2 }, b: 'fresh' };
  const existing = { a: { y: 99, z: 3 }, b: 'existing' };
  const merged = mergeRuntimeObject(fresh, existing);
  assert.deepEqual(merged, { a: { x: 1, y: 99, z: 3 }, b: 'existing' });
});

test('mergeRuntimeObject: missing existing keys do not erase fresh values', () => {
  const fresh = { a: 1, b: 2 };
  const existing = { b: 99 };
  const merged = mergeRuntimeObject(fresh, existing);
  assert.deepEqual(merged, { a: 1, b: 99 });
});

test('mergeRuntimeObject: arrays are replaced wholesale, not deep-merged', () => {
  // Arrays are not plain objects per isPlainObject, so existing wins entirely.
  const fresh = { tags: ['a', 'b', 'c'] };
  const existing = { tags: ['z'] };
  const merged = mergeRuntimeObject(fresh, existing);
  assert.deepEqual(merged.tags, ['z']);
});

test('mergeModelProviders: user-added custom model in providers survives', () => {
  // The "Pro" experiment scenario: user added a custom deepseek-v4-pro:cloud
  // entry to the runtime config; the bundled template only knows about flash.
  // After merge, both should be present.
  const freshProviders = {
    ollama: {
      models: [
        { id: 'glm-5:cloud', name: 'GLM-5 Cloud', reasoning: false },
        { id: 'deepseek-v4-flash:cloud', name: 'DeepSeek V4 Flash', reasoning: true },
      ],
    },
  };
  const existingProviders = {
    ollama: {
      models: [
        { id: 'deepseek-v4-pro:cloud', name: 'DeepSeek V4 Pro Cloud', reasoning: true },
      ],
    },
  };
  const merged = mergeModelProviders(freshProviders, existingProviders);
  const ids = merged.ollama.models.map(m => m.id);
  assert.ok(ids.includes('glm-5:cloud'), 'bundled GLM-5 must remain');
  assert.ok(ids.includes('deepseek-v4-flash:cloud'), 'bundled Flash must remain');
  assert.ok(ids.includes('deepseek-v4-pro:cloud'), 'user-added Pro must survive merge');
});

test('mergeModelProviders: existing model entry overlays fresh entry with same id', () => {
  // User edits a bundled model (e.g. flips reasoning: true). After merge, the
  // user's edit must win — not be overwritten by the bundled default.
  const fresh = {
    ollama: { models: [{ id: 'glm-5:cloud', reasoning: false, name: 'GLM-5' }] },
  };
  const existing = {
    ollama: { models: [{ id: 'glm-5:cloud', reasoning: true }] },
  };
  const merged = mergeModelProviders(fresh, existing);
  const glm = merged.ollama.models.find(m => m.id === 'glm-5:cloud');
  assert.equal(glm.reasoning, true, 'user reasoning override must win');
  assert.equal(glm.name, 'GLM-5', 'fresh fields not overridden by existing must remain');
});

test('mergeModelProviders: new bundled provider passes through when not in existing', () => {
  const fresh = {
    ollama: { models: [{ id: 'glm-5:cloud' }] },
    anthropic: { models: [{ id: 'claude-sonnet' }] },
  };
  const existing = {
    ollama: { models: [{ id: 'deepseek-v4-pro:cloud' }] },
  };
  const merged = mergeModelProviders(fresh, existing);
  assert.ok(merged.anthropic, 'fresh provider not in existing must pass through');
  assert.equal(merged.anthropic.models[0].id, 'claude-sonnet');
});

test('mergeModelProviders: empty inputs do not throw', () => {
  assert.deepEqual(mergeModelProviders({}, {}), {});
  assert.deepEqual(mergeModelProviders({ ollama: { models: [] } }, {}),
    { ollama: { models: [] } });
});

test('isPlainObject: distinguishes plain objects from arrays and primitives', () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject({ a: 1 }), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject([1, 2]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject(undefined), false);
  assert.equal(isPlainObject('string'), false);
  assert.equal(isPlainObject(42), false);
});

test('getModelKey: handles strings, objects with id/name/model, and bad input', () => {
  assert.equal(getModelKey('glm-5:cloud'), 'glm-5:cloud');
  assert.equal(getModelKey({ id: 'foo' }), 'foo');
  assert.equal(getModelKey({ name: 'bar' }), 'bar');
  assert.equal(getModelKey({ model: 'baz' }), 'baz');
  assert.equal(getModelKey({ id: 'foo', name: 'bar' }), 'foo', 'id wins over name');
  assert.equal(getModelKey(null), null);
  assert.equal(getModelKey(undefined), null);
  assert.equal(getModelKey({}), null);
});

test('mergeModelList: dedup by key, existing wins on conflict, new entries appended', () => {
  const fresh = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }];
  const existing = [{ id: 'a', v: 99 }, { id: 'c', v: 1 }];
  const merged = mergeModelList(fresh, existing);
  assert.equal(merged.length, 3);
  assert.equal(merged.find(m => m.id === 'a').v, 99);
  assert.equal(merged.find(m => m.id === 'b').v, 1);
  assert.equal(merged.find(m => m.id === 'c').v, 1);
});
