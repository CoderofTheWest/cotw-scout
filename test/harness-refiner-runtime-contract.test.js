const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(repoRoot, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(repoRoot, 'preload.js'), 'utf8');

test('main process includes Harness Refiner in ordered bundled plugin load list', () => {
  const codeEvolutionIndex = mainSource.indexOf("'openclaw-plugin-code-evolution'");
  const harnessRefinerIndex = mainSource.indexOf("'openclaw-plugin-harness-refiner'");
  assert.ok(codeEvolutionIndex > 0, 'code-evolution plugin should be listed');
  assert.ok(harnessRefinerIndex > 0, 'harness-refiner plugin should be listed');
  assert.ok(harnessRefinerIndex > codeEvolutionIndex, 'harness-refiner should load after code-evolution');
});

test('main/preload expose read-only Harness Refiner research sidebar API', () => {
  assert.match(mainSource, /ipcMain\.handle\('sidebar:harness-research'/);
  assert.match(mainSource, /function loadHarnessResearchDigests/);
  assert.match(mainSource, /function sanitizeHarnessResearchDigest/);
  assert.match(preloadSource, /getHarnessResearch: \(\) => ipcRenderer\.invoke\('sidebar:harness-research'\)/);
});

test('Harness Refiner plugin registers expected read-only gateway methods', () => {
  const pluginSource = fs.readFileSync(path.join(repoRoot, 'bundled-plugins/openclaw-plugin-harness-refiner/index.js'), 'utf8');
  for (const method of [
    'harness-refiner.getState',
    'harness-refiner.trigger',
    'harness-refiner.getResearchDigest',
    'harness-refiner.exportResearchBundle',
    'harness-refiner.createTeacherRelabel',
    'harness-refiner.runScenarioReplay'
  ]) {
    assert.match(pluginSource, new RegExp(method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(pluginSource, /trainingLaunchAuthorized: false/);
});
