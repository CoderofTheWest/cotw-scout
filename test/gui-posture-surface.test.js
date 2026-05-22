const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const guiPath = path.join(repoRoot, 'cotw-scout-gui.html');
const html = fs.readFileSync(guiPath, 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `expected ${name} to exist`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`could not extract ${name}`);
}

test('GUI exposes the unified posture surface', () => {
  for (const id of ['postureSurface', 'postureChip', 'postureLabel', 'postureWorking', 'postureWorkingLabel', 'postureAuthority', 'postureAuthorityLabel', 'postureDetail']) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }

  assert.match(html, /function updatePostureSurface\(/);
  assert.match(html, /function classifyToolAuthority\(/);
  assert.match(html, /window\.cotw\.onToolCall/);
  assert.match(html, /activeToolAuthority = classifyToolAuthority\(data\.name, data\.args\)/);
  assert.match(html, /window\.cotw\.onModeChanged/);
});

test('tool authority classifier keeps read-only tools quiet and marks boundary crossings', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${extractFunction(html, 'classifyToolAuthority')}; this.classifyToolAuthority = classifyToolAuthority;`, context);
  const classify = context.classifyToolAuthority;

  assert.equal(classify('read', { path: 'PRD.md' }), null);
  assert.equal(classify('web_search', { query: 'docs' }), null);
  assert.equal(classify('continuity_claims', { action: 'context' }), null);
  assert.equal(classify('write', { path: 'x' }), 'File write');
  assert.equal(classify('apply_patch', {}), 'File write');
  assert.equal(classify('exec', { command: 'npm test' }), 'Command');
  assert.equal(classify('gateway', { action: 'restart' }), 'Gateway control');
  assert.equal(classify('message', { action: 'send' }), 'External send');
  assert.equal(classify('cron', { action: 'add' }), 'Scheduler');
  assert.equal(classify('cron', { action: 'status' }), null);
  assert.equal(classify('nodes', { action: 'camera_snap' }), 'Hardware control');
  assert.equal(classify('continuity_claims', { action: 'apply_review_decision' }), 'Memory write gated');
  assert.equal(classify('sessions_spawn', { task: 'check' }), 'Session control');
});

test('GUI renders safe expandable process trails below assistant messages', () => {
  assert.match(html, /function startProcessTrail\(/);
  assert.match(html, /function recordProcessTrailStep\(/);
  assert.match(html, /function renderProcessTrail\(/);
  assert.match(html, /function sanitizeProcessTrailText\(/);
  assert.match(html, /attachProcessTrail\(el, 'done'\)/);
  assert.match(html, /recordProcessTrailStep\(\{ phase: 'Running tool'/);
  assert.match(html, /data\.status === 'observed'/);
  assert.match(html, /completeProcessTrailStep\(data\.name \|\| '', 'done'\)/);
  assert.match(html, /recordProcessTrailStep\(\{ phase: 'Running tool', name, status \}\)/);
  assert.match(html, /carryRecentToolStepsIntoTrail/);
  assert.match(html, /PROCESS_TRAIL_CARRY_WINDOW_MS/);
  assert.match(html, /markProcessTrailInterrupted\('Connection hiccup/);
  assert.match(html, /class="process-trail"/);
  assert.match(html, /Worked \$\{elapsed\}s · \$\{toolSteps\} tool/);
  assert.match(html, /system prompt\|hidden reasoning\|chain\[- \]of\[- \]thought/);
  assert.doesNotMatch(html, /chain[- ]of[- ]thought[^\n]{0,80}<\/summary>/i);
});

test('process trail collector renders sanitized lifecycle details', () => {
  const context = {
    Date,
    Math,
    String,
    RegExp,
    Set,
    escapeHtml(text) {
      return String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }
  };
  vm.createContext(context);
  const processTrailStart = html.indexOf('let currentProcessTrail = null;');
  const processTrailEnd = html.indexOf('function stripAssistantDirectiveTags', processTrailStart);
  assert.ok(processTrailStart > 0 && processTrailEnd > processTrailStart);
  vm.runInContext(`
    const TOOL_DISPLAY = {
      exec: { label: 'Running command', argKey: 'command' },
      read: { label: 'Reading', argKey: 'path' }
    };
    ${extractFunction(html, 'getToolDisplay')}
    ${extractFunction(html, 'classifyToolAuthority')}
    ${html.slice(processTrailStart, processTrailEnd)}
    this.api = { startProcessTrail, recordProcessTrailStep, completeProcessTrailStep, finishProcessTrail, renderProcessTrail, sanitizeProcessTrailText, state() { return { recentProcessTrailToolSteps }; } };
  `, context);

  context.api.startProcessTrail('Thinking with hidden reasoning');
  context.api.recordProcessTrailStep({
    phase: 'Running tool',
    name: 'exec',
    args: { command: 'cat /Users/chris/private/file && curl http://127.0.0.1:12345/secret --header token=abcdefghijklmnopqrstuvwxyz1234567890' },
    status: 'running'
  });
  context.api.completeProcessTrailStep('exec', 'done');
  const rendered = context.api.renderProcessTrail(context.api.finishProcessTrail('done'));

  assert.match(rendered, /<details class="process-trail">/);
  assert.match(rendered, /Worked \d+s · 1 tool · Command/);
  assert.match(rendered, /Running command/);
  assert.match(rendered, /\[redacted-url\]/);
  assert.match(rendered, /\[redacted-path\]/);
  assert.match(context.api.sanitizeProcessTrailText('token=abcdefghijklmnopqrstuvwxyz1234567890'), /\[redacted-token\]/);
  assert.doesNotMatch(rendered, /127\.0\.0\.1|12345|\/Users\/chris|abcdefghijklmnopqrstuvwxyz|hidden reasoning/i);

  context.api.startProcessTrail('Thinking');
  context.api.completeProcessTrailStep('read', 'done');
  const fallbackRendered = context.api.renderProcessTrail(context.api.finishProcessTrail('done'));
  assert.match(fallbackRendered, /Worked \d+s · 1 tool/);
  assert.match(fallbackRendered, /Reading/);


  context.api.state().recentProcessTrailToolSteps.length = 0;
  context.api.startProcessTrail('First active work');
  context.api.recordProcessTrailStep({ phase: 'Running tool', name: 'exec', args: { command: 'npm test' }, status: 'done' });
  context.api.finishProcessTrail('done');
  context.api.startProcessTrail('Queued summary wait');
  const priorNow = Date.now;
  Date.now = () => priorNow() + 20000;
  const carriedRendered = context.api.renderProcessTrail(context.api.finishProcessTrail('done'));
  Date.now = priorNow;
  assert.match(carriedRendered, /Tool activity from prior active work/);
  assert.match(carriedRendered, /Worked \d+s · 1 tool · Command/);
});

test('posture surface tracks mode changes and working-state updates', () => {
  const context = {
    elements: new Map(),
    document: {
      getElementById(id) {
        if (!context.elements.has(id)) {
          const classes = new Set();
          context.elements.set(id, {
            id,
            className: '',
            textContent: '',
            classList: {
              add(value) { classes.add(value); },
              contains(value) { return classes.has(value); },
              remove(value) { classes.delete(value); }
            }
          });
        }
        return context.elements.get(id);
      }
    }
  };
  vm.createContext(context);

  const constantsStart = html.indexOf('const POSTURE_META =');
  const functionsStart = html.indexOf('// ============================================\n// UNIFIED POSTURE SURFACE');
  const chatStart = html.indexOf('// ============================================\n// CHAT', functionsStart + 1);
  assert.ok(constantsStart > 0 && functionsStart > 0 && chatStart > functionsStart);

  const constantsBlock = html.slice(constantsStart, html.indexOf('// ============================================\n// INIT', constantsStart));
  const functionsBlock = html.slice(functionsStart, chatStart);
  vm.runInContext(`
    let chatBusy = false;
    let activeToolAuthority = null;
    let activeToolDetail = '';
    let lastWorkingLabel = 'Ready';
    let embodimentMode = false;
    let trainingMode = false;
    let boothMode = false;
    ${constantsBlock}
    ${functionsBlock}
    this.api = {
      updatePostureSurface,
      setPostureWorking,
      setState(next) {
        if ('chatBusy' in next) chatBusy = next.chatBusy;
        if ('activeToolAuthority' in next) activeToolAuthority = next.activeToolAuthority;
        if ('activeToolDetail' in next) activeToolDetail = next.activeToolDetail;
        if ('embodimentMode' in next) embodimentMode = next.embodimentMode;
        if ('trainingMode' in next) trainingMode = next.trainingMode;
        if ('boothMode' in next) boothMode = next.boothMode;
      }
    };
  `, context);

  context.api.updatePostureSurface();
  assert.equal(context.elements.get('postureLabel').textContent, 'Chat');
  assert.equal(context.elements.get('postureWorkingLabel').textContent, 'Ready');
  assert.equal(context.elements.get('postureAuthorityLabel').textContent, 'Read-only');

  context.api.setState({ trainingMode: true, chatBusy: true, activeToolAuthority: 'File write' });
  context.api.setPostureWorking('Running tool', 'Writing: PRD.md');
  assert.equal(context.elements.get('postureLabel').textContent, 'Code');
  assert.equal(context.elements.get('postureWorkingLabel').textContent, 'Running tool');
  assert.equal(context.elements.get('postureAuthorityLabel').textContent, 'File write');
  assert.equal(context.elements.get('postureDetail').textContent, 'Writing: PRD.md');
});
