const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const guiPath = path.join(repoRoot, 'cotw-scout-gui.html');
const html = fs.readFileSync(guiPath, 'utf8');

function extractWorkbenchBlock() {
  const start = html.indexOf('// ---- Workbench ----');
  const end = html.indexOf('// ---- Evolution ----', start);
  assert.ok(start > 0, 'expected Workbench block to exist');
  assert.ok(end > start, 'expected Evolution block after Workbench block');
  return html.slice(start, end);
}

function createHarness() {
  const elements = new Map();
  elements.set('workbenchTab', { innerHTML: '' });
  const context = {
    window: {},
    document: { getElementById(id) { return elements.get(id) || null; } },
    escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    },
    openSidebarDetail(title, body) { context.detail = { title, body }; }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(`${extractWorkbenchBlock()}; this.api = { getWorkbenchCapabilities, getWorkbenchArtifacts, summarizeProjectRadar, getProjectRadarArtifact, renderProjectRadarDetail, renderWorkbenchCapabilityRow, renderWorkbenchArtifactCard, renderInlineDesignCard, renderWorkbenchSurface, loadWorkbench, showWorkbenchDetail };`, context);
  return { context, elements };
}

test('Workbench surface is present as app-native review UI', () => {
  assert.match(html, /switchTab\(this, 'workbench'\)/);
  assert.match(html, /id="workbenchTab"/);
  assert.match(html, /GUI workbench/);
  assert.match(html, /function loadWorkbench\(/);
  assert.match(html, /function renderWorkbenchSurface\(/);
  assert.match(html, /function renderInlineDesignCard\(/);
  assert.match(html, /Review Stage/);
});

test('Sidebar tabs scroll horizontally so Workbench remains accessible', () => {
  assert.match(html, /\.sidebar-tabs \{[\s\S]*?overflow-x: auto;[\s\S]*?scroll-snap-type: x proximity;/);
  assert.match(html, /-webkit-overflow-scrolling: touch;/);
  assert.match(html, /\.sidebar-tab \{[\s\S]*?flex: 0 0 auto;[\s\S]*?min-width: 58px;/);
  assert.match(html, /scroll-snap-align: start;/);
});

test('Workbench renders capability status and sanitized artifacts', () => {
  const { context } = createHarness();
  const artifact = {
    id: 'artifact-1',
    title: 'Preview <script>alert(1)</script>',
    intent: 'Show before/after safely',
    targetSurface: 'status bar',
    status: 'review_only',
    previewType: 'manual_static',
    refs: { files: ['cotw-scout-gui.html'], receipt: 'receipt-1' },
    verificationNotes: ['No hidden browser action']
  };
  const output = context.api.renderWorkbenchSurface([artifact], {
    canvasAvailable: false,
    nodeScreenAvailable: true,
    screenshotAvailable: true,
    manualFallback: true,
    authority: 'review-only'
  });

  assert.match(output, /Visual capability/);
  assert.match(output, /Canvas \/ browser preview/);
  assert.match(output, /fallback/);
  assert.match(output, /Paired node screen/);
  assert.match(output, /available/);
  assert.match(output, /Preview &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(output, /<script>alert/);
  assert.match(output, /review only/i);
});

test('Workbench loads default artifact and opens review-only detail', () => {
  const { context, elements } = createHarness();
  context.api.loadWorkbench();
  const tab = elements.get('workbenchTab');
  assert.match(tab.innerHTML, /Integrated GUI Workbench v1/);
  assert.match(tab.innerHTML, /review-only/);

  context.api.showWorkbenchDetail(0);
  assert.equal(context.detail.title, 'Integrated GUI Workbench v1');
  assert.match(context.detail.body, /Review Stage/);
  assert.match(context.detail.body, /does not deploy, mutate config, change tool policy, schedule work, or perform hidden browser actions/);
});

test('Workbench renders Project Radar as read-only operating state', () => {
  const { context } = createHarness();
  const projectRadar = {
    exists: true,
    trackerPath: 'projects/operating-board/TRACKER.yaml',
    lanes: ['now', 'next'],
    counts: { total: 2, needsChris: 1, byStatus: { now: 1, next: 1 }, byStream: { evolve: 1 } },
    authority: 'read-only Project Radar view; no file edits, calendar writes, Evolve actions, or code mutations',
    items: [
      { id: 'evolve-ux', title: 'Evolve UX <script>', type: 'prd', status: 'now', stream: 'evolve', priority: 'high', needs_chris: false, next_action: 'Review card shape', outcome: 'Simple approval card', due: 'none' },
      { id: 'book-release', title: 'Launch plan', type: 'complex-project', status: 'next', stream: 'book-release', priority: 'medium', needs_chris: true, next_action: 'Pick milestone dates', outcome: 'Reusable project plan', due: '2026-09' }
    ]
  };
  const artifact = context.api.getProjectRadarArtifact(projectRadar);
  const surface = context.api.renderWorkbenchSurface([artifact]);
  assert.match(surface, /Project Radar/);
  assert.match(surface, /2 items · 1 now · 1 next · 1 need Chris/);
  assert.match(surface, /read only/i);

  const detail = context.api.renderProjectRadarDetail(projectRadar);
  assert.match(detail, /Operating Board/);
  assert.match(detail, /Evolve UX &lt;script&gt;/);
  assert.match(detail, /needs Chris/);
  assert.doesNotMatch(detail, /<script>/);
  assert.doesNotMatch(detail, /approve|reject|create calendar|write calendar/i);
});

test('Inline design cards stay review-only and do not expose mutation controls', () => {
  const { context } = createHarness();
  const output = context.api.renderInlineDesignCard({
    id: 'inline-1',
    title: 'Status bar proof',
    intent: 'Show active model label inside the app',
    previewType: 'rendered_html'
  });
  assert.match(output, /Status bar proof/);
  assert.match(output, /review only/);
  assert.doesNotMatch(output, /onclick="[^\"]*(deploy|switchProvider|setSearchProvider|startGateway|invoke|camera|message|cron)/i);
});

test('Workbench block contains no authority-granting IPC calls in v1', () => {
  const block = extractWorkbenchBlock();
  assert.doesNotMatch(block, /window\.cotw\.(switchProvider|setSearchProvider|startGateway|restart|sendMessage|invoke|camera|notify|createProject|evolutionAction)/);
  assert.doesNotMatch(block, /ipcRenderer|ipcMain|cron|message:send|gateway:restart/);
});
