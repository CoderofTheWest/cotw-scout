const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const nightshift = fs.readFileSync(path.join(repoRoot, 'bundled-plugins/openclaw-plugin-nightshift/index.js'), 'utf8');

test('nightshift keeps cross-plugin registries and timer ownership in a global runtime singleton', () => {
  assert.match(nightshift, /global\.__ocNightshiftRuntime/);
  assert.match(nightshift, /taskRunners: new Map\(\)/);
  assert.match(nightshift, /queueSeeders: new Map\(\)/);
  assert.match(nightshift, /const taskRunners = nightshiftRuntime\.taskRunners/);
  assert.match(nightshift, /const queueSeeders = nightshiftRuntime\.queueSeeders/);
  assert.match(nightshift, /const replacing = taskRunners\.has\(taskType\)/);
  assert.match(nightshift, /const replacing = queueSeeders\.has\(taskType\)/);
  assert.match(nightshift, /clearInterval\(nightshiftRuntime\.processingTimer\)/);
  assert.match(nightshift, /nightshiftRuntime\.processingTimer = processingTimer/);
  assert.match(nightshift, /diagnostics: \(\) => \(\{/);
  assert.match(nightshift, /taskRunnerCount: taskRunners\.size/);
  assert.match(nightshift, /queueSeederCount: queueSeeders\.size/);
});

test('nightshift preserves persisted freshness markers after AgentState load', () => {
  const loadCall = nightshift.indexOf('this.loadState();');
  const lastCompletedInit = nightshift.indexOf('this.lastTaskCompletedAt = null;');
  const lastCatchupInit = nightshift.indexOf('this.lastCatchupAt = null;');
  const lastReportInit = nightshift.indexOf('this.lastReportWrittenAt = null;');

  assert.ok(lastCompletedInit > -1);
  assert.ok(lastCatchupInit > -1);
  assert.ok(lastReportInit > -1);
  assert.ok(loadCall > lastCompletedInit);
  assert.ok(loadCall > lastCatchupInit);
  assert.ok(loadCall > lastReportInit);
  assert.match(nightshift, /this\.lastTaskCompletedAt = saved\.lastTaskCompletedAt \|\| null/);
  assert.match(nightshift, /this\.lastCatchupAt = saved\.lastCatchupAt \|\| null/);
  assert.match(nightshift, /this\.lastReportWrittenAt = saved\.lastReportWrittenAt \|\| null/);
});

test('nightshift capped tasks do not block lower-priority queued work', () => {
  assert.match(nightshift, /function isTaskCapped\(state, task\)/);
  assert.match(nightshift, /while \(true\) \{/);
  assert.match(nightshift, /if \(!isTaskCapped\(state, task\)\) break/);
  assert.match(nightshift, /Skipping capped task type/);
  assert.doesNotMatch(nightshift, /Task type \$\{task\.type\} hit max per night/);
});

test('nightshift forceRun is useful from the GUI while the user is active', () => {
  assert.match(nightshift, /bypassUserActive: params\?\.bypassUserActive !== false/);
  assert.match(nightshift, /queuedBefore/);
  assert.match(nightshift, /queuedAfter: state\.taskQueue\.length/);
  assert.match(nightshift, /processedTonight: state\.processedTonight/);
});

test('nightshift writes reports on clock exit as well as morning detection', () => {
  assert.match(nightshift, /async function writeNightshiftReport\(state, ctx = \{\}, reason = 'morning'\)/);
  assert.match(nightshift, /writeNightshiftReport\(state, ctx, 'morning'\)/);
  assert.match(nightshift, /writeNightshiftReport\(state, \{ agentId: state\.agentId \}, 'office-hours-ended'\)/);
});
