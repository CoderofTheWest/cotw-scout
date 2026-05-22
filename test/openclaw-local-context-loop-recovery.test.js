const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const patchScript = path.join(root, 'scripts', 'apply-openclaw-local-patches.js');
const distDir = path.join(root, 'node_modules', 'openclaw', 'dist');

function findSelectionFile() {
  const files = fs.readdirSync(distDir)
    .filter((name) => /^selection-.*\.js$/.test(name))
    .map((name) => path.join(distDir, name));
  const target = files.find((file) => fs.readFileSync(file, 'utf8').includes('function installToolResultContextGuard(params)'));
  assert.ok(target, 'selection dist file with installToolResultContextGuard should exist');
  return target;
}


function findOpenClawToolsFile() {
  const files = fs.readdirSync(distDir)
    .filter((name) => /^openclaw-tools-.*\.js$/.test(name))
    .map((name) => path.join(distDir, name));
  const target = files.find((file) => {
    const source = fs.readFileSync(file, 'utf8');
    return source.includes('function collectPresentOpenClawTools(candidates)') && source.includes('function createSessionStatusTool(opts)');
  });
  assert.ok(target, 'openclaw tools dist file should exist');
  return target;
}

function hashFiles(files) {
  return Object.fromEntries(files.map((file) => [file, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
}

function findCompactionFile() {
  const files = fs.readdirSync(distDir)
    .filter((name) => /^(?:compaction|preemptive-compaction)-.*\.js$/.test(name))
    .map((name) => path.join(distDir, name));
  const target = files.find((file) => fs.readFileSync(file, 'utf8').includes('function truncateToolResultMessage(msg, maxChars, options = {})'));
  assert.ok(target, 'compaction/preemptive-compaction dist file with truncateToolResultMessage should exist');
  return target;
}

test('local OpenClaw patcher carries context-loop recovery patch', () => {
  const source = fs.readFileSync(patchScript, 'utf8');
  assert.match(source, /function applyContextLoopRecoveryPatch\(\)/);
  assert.match(source, /buildPreemptiveOverflowMidTurnRequest/);
  assert.match(source, /function applyToolResultFidelityPatch\(\)/);
  assert.match(source, /archiveToolResultText/);
  assert.match(source, /readArchivedToolResultRange/);
  assert.match(source, /truncate_with_pointer/);
  assert.match(source, /tool_result_archived/);
  assert.match(source, /tool_result_range/);
  assert.match(source, /createToolResultRangeTool/);
  assert.match(source, /midTurnResumeManifest/);
  assert.match(source, /recovery_budget_exhausted/);
  assert.match(source, /emitMidTurnRecoveryEvent/);
  assert.match(source, /mid_turn_precheck_fired/);
  assert.match(source, /mid_turn_recovery_resumed/);
  assert.match(source, /mid_turn_recovery_exhausted/);
  assert.match(source, /throw new MidTurnPrecheckSignal\(request\)/);
});

test('tool-loop overflow guard routes through mid-turn recovery signal', () => {
  const source = fs.readFileSync(findSelectionFile(), 'utf8');
  assert.match(source, /function (buildPreemptiveOverflowMidTurnRequest|toMidTurnPrecheckRequest)\(/);
  assert.match(source, /function emitMidTurnRecoveryEvent\(params, phase, data = \{\}\)/);
  assert.match(source, /params\.midTurnPrecheck(?:\?\.)?onMidTurnPrecheck\?\.\(request\)|params\.midTurnPrecheck\.onMidTurnPrecheck\?\.\(request\)/);
  assert.match(source, /emitMidTurnRecoveryEvent\(params, "mid_turn_precheck_fired"/);
  assert.match(source, /emitMidTurnRecoveryEvent\(params, "compaction_started"/);
  assert.match(source, /emitMidTurnRecoveryEvent\(params, "mid_turn_recovery_resumed"/);
  assert.match(source, /emitMidTurnRecoveryEvent\(params, "mid_turn_recovery_exhausted"/);
  assert.match(source, /throw new MidTurnPrecheckSignal\(request\)/);
});


test('tool-result fidelity patch archives oversized verbatim output before truncating', async () => {
  const source = fs.readFileSync(findCompactionFile(), 'utf8');
  assert.match(source, /DEFAULT_TOOL_RESULT_AGGREGATE_CHARS = 128e3/);
  assert.match(source, /TOOL_RESULT_ARCHIVE_SINGLE_TRIGGER_BYTES = 64 \* 1024/);
  assert.match(source, /TOOL_RESULT_ARCHIVE_AGGREGATE_TRIGGER_BYTES = 256 \* 1024/);
  assert.match(source, /function archiveToolResultText\(params\)/);
  assert.match(source, /strategy=truncate_with_pointer/);
  assert.match(source, /resolveToolResultNormalizationEnabled/);
  assert.match(source, /normalizationEnabled/);

  const mod = await import(`file://${findCompactionFile()}`);
  const truncateToolResultMessage = mod.h ?? mod.m;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-tool-result-'));
  const sessionFile = path.join(tmp, 'session.jsonl');
  const raw = `${'alpha path/file.js:12: exact evidence\n'.repeat(2200)}FINAL_SENTINEL`;
  const result = truncateToolResultMessage({
    role: 'toolResult',
    content: [{ type: 'text', text: raw }],
  }, 4000, { sessionFile });

  const text = result.content[0].text;
  assert.ok(text.length <= 4000, 'preview should stay within requested inline budget');
  assert.match(text, /full verbatim tool result archived as toolr_/);
  assert.match(text, /sha256=/);
  assert.match(text, /strategy=truncate_with_pointer/);
  assert.doesNotMatch(text, new RegExp(tmp.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')), 'pointer should not expose absolute archive paths');
  const archiveId = text.match(/archived as (toolr_[0-9a-f]+);/)?.[1];
  assert.ok(archiveId, 'archive id should be present in pointer suffix');
  const archivedFiles = fs.readdirSync(path.join(tmp, 'tool-results'), { recursive: true })
    .filter((name) => String(name).endsWith('.txt'));
  assert.equal(archivedFiles.length, 1, 'one archive file should be written for this content');
  const archivedPath = path.join(tmp, 'tool-results', archivedFiles[0]);
  assert.equal(fs.readFileSync(archivedPath, 'utf8'), raw);

  const secondResult = truncateToolResultMessage({
    role: 'toolResult',
    content: [{ type: 'text', text: raw }],
  }, 4000, { sessionFile });
  const secondId = secondResult.content[0].text.match(/archived as (toolr_[0-9a-f]+);/)?.[1];
  assert.equal(secondId, archiveId, 'identical content should reuse the same content-hash archive id');
});

test('tool-result fidelity flag can disable archive pointers without disabling bounded truncation', async () => {
  const mod = await import(`file://${findCompactionFile()}`);
  const truncateToolResultMessage = mod.h ?? mod.m;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-tool-result-flag-'));
  const sessionFile = path.join(tmp, 'session.jsonl');
  const raw = `${'beta path/file.js:99: exact evidence\n'.repeat(2200)}FINAL_SENTINEL`;
  const result = truncateToolResultMessage({
    role: 'toolResult',
    content: [{ type: 'text', text: raw }],
  }, 4000, { sessionFile, normalizationEnabled: false });

  const text = result.content[0].text;
  assert.ok(text.length <= 4000, 'preview should still stay within requested inline budget');
  assert.doesNotMatch(text, /full verbatim tool result archived as toolr_/);
  assert.match(text, /more characters truncated/);
  assert.equal(fs.existsSync(path.join(tmp, 'tool-results')), false, 'disabled normalization should not write archive files');
});

test('archived tool results are exact-range readable without reinjecting full payload', async () => {
  const mod = await import(`file://${findCompactionFile()}?range=${Date.now()}`);
  const truncateToolResultMessage = mod.h ?? mod.m;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-tool-result-range-'));
  const sessionFile = path.join(tmp, 'session.jsonl');
  const raw = Array.from({ length: 2600 }, (_, index) => `line-${index + 1}: exact evidence ${'x'.repeat(40)}`).join('\n');
  const result = truncateToolResultMessage({
    role: 'toolResult',
    content: [{ type: 'text', text: raw }],
  }, 1200, { sessionFile });
  const text = result.content[0].text;
  const archiveId = text.match(/archived as (toolr_[0-9a-f]+);/)?.[1];
  assert.ok(archiveId, 'archive id should be available for range reads');

  const range = mod.q({ id: archiveId, sessionFile, startLine: 100, lineCount: 3, maxChars: 500 });
  assert.equal(range.text, [
    `line-100: exact evidence ${'x'.repeat(40)}`,
    `line-101: exact evidence ${'x'.repeat(40)}`,
    `line-102: exact evidence ${'x'.repeat(40)}`,
  ].join('\n'));
  assert.equal(range.range.kind, 'line');
  assert.equal(range.range.startLine, 100);
  assert.equal(range.range.lineCount, 3);
  assert.equal(range.totalLines, 2600);

  const capped = mod.q({ id: archiveId, sessionFile, startLine: 1, lineCount: 2600, maxChars: 300 });
  assert.ok(capped.text.length <= 300, 'range reader should refuse accidental oversized reinjection');
  assert.equal(capped.range.truncated, true);
});

test('recovery visibility includes archive events and bounded resume manifest metadata', () => {
  const source = fs.readFileSync(findSelectionFile(), 'utf8');
  assert.match(source, /function resolveMidTurnRecoveryBudget\(config\)/);
  assert.match(source, /kind: "mid_turn_resume_manifest"/);
  assert.match(source, /recoveryBudget/);
  assert.match(source, /maxAttempts/);
  assert.match(source, /recovery_budget_exhausted/);
  assert.match(source, /tool_result_archived/);
  assert.match(source, /archiveIds: truncationResult\.archiveIds/);
  assert.match(source, /manifestId: manifest\.id/);
  assert.match(source, /mid_turn_recovery_resumed/);
});


test('recovery event wiring has no duplicate compact-only or exhausted emissions', () => {
  const source = fs.readFileSync(findSelectionFile(), 'utf8');
  assert.equal(
    (source.match(/emitMidTurnRecoveryEvent\(params, "compaction_started", buildMidTurnRecoveryEventData\(request, currentMidTurnRecoveryEventData\(\)\)\);/g) ?? []).length,
    1,
    'compact-only path should emit one manifest-bearing compaction_started event'
  );
  assert.doesNotMatch(
    source,
    /emitMidTurnRecoveryEvent\(params, "compaction_started", buildMidTurnRecoveryEventData\(request, currentMidTurnRecoveryEventData\(\)\)\);\n\s*emitMidTurnRecoveryEvent\(params, "compaction_started", buildMidTurnRecoveryEventData\(request\)\);/,
    'compact-only path should not also emit a bare duplicate compaction_started event'
  );
  assert.match(
    source,
    /else if \(preflightRecovery && promptError && preflightRecovery\.exhausted !== true\) emitMidTurnRecoveryEvent\(params, "mid_turn_recovery_exhausted"/,
    'final exhausted event should not duplicate budget-exhausted handler emission'
  );
});

test('archived tool-result range recall is exposed as an agent tool', () => {
  const source = fs.readFileSync(findOpenClawToolsFile(), 'utf8');
  assert.match(source, /import \{ q as readArchivedToolResultRange \} from "\.\/(?:compaction|preemptive-compaction)-[^";]+\.js";/);
  assert.match(source, /const ToolResultRangeSchema = Type\.Object/);
  assert.match(source, /name: "tool_result_range"/);
  assert.match(source, /createToolResultRangeTool\(\{/);
  assert.match(source, /readArchivedToolResultRange\(request\)/);
  assert.match(source, /resolveCurrentToolResultSessionFile/);
});

test('local patcher is idempotent across repeated runs on patched dist', () => {
  const files = [
    findSelectionFile(),
    findCompactionFile(),
    findOpenClawToolsFile(),
  ];
  const before = hashFiles(files);
  for (let index = 0; index < 2; index += 1) {
    const result = spawnSync(process.execPath, [patchScript], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  assert.deepEqual(hashFiles(files), before, 'running patcher twice should not rewrite already-patched dist files');
});
