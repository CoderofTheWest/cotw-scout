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

function loadRenderer() {
  const context = {
    Number,
    String,
    RegExp,
    encodeURIComponent,
    globalThis: null,
    katex: {
      renderToString(expr, opts = {}) {
        return opts.displayMode
          ? `<span class="katex-display" data-expr="${expr}"></span>`
          : `<span class="katex" data-expr="${expr}"></span>`;
      }
    },
    escapeHtml(text) {
      return String(text).replace(/[&<>"']/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      }[ch]));
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(`
    ${extractFunction(html, 'renderMarkdown')}
    ${extractFunction(html, 'renderMarkdownLine')}
    ${extractFunction(html, 'parseMarkdownHeading')}
    ${extractFunction(html, 'renderMarkdownHeading')}
    ${extractFunction(html, 'parseMarkdownListItem')}
    ${extractFunction(html, 'parseDisplayMathBlock')}
    ${extractFunction(html, 'renderInlineMarkdown')}
    ${extractFunction(html, 'renderInlineMath')}
    ${extractFunction(html, 'findUnescaped')}
    ${extractFunction(html, 'renderPlainMarkdownText')}
    ${extractFunction(html, 'renderMathExpression')}
    ${extractFunction(html, 'parseHostedEmbedDirective')}
    ${extractFunction(html, 'sanitizeHostedEmbedRef')}
    ${extractFunction(html, 'sanitizeHostedEmbedUrl')}
    ${extractFunction(html, 'hostedEmbedRefFromUrl')}
    ${extractFunction(html, 'renderHostedEmbed')}
    this.api = { renderMarkdown, parseHostedEmbedDirective };
  `, context);
  return context.api;
}

test('assistant embed directives render as hosted canvas iframes', () => {
  const { renderMarkdown } = loadRenderer();
  const out = renderMarkdown('Made you a visual:\n\n[embed ref="calculus-first-bridge" title="Calculus visual bridge" height="460" /]\n\nThat is the lane.');

  assert.match(out, /Made you a visual/);
  assert.match(out, /class="hosted-embed"/);
  assert.match(out, /data-hosted-embed-ref="calculus-first-bridge"/);
  assert.match(out, /data-hosted-embed-url="\/__openclaw__\/canvas\/documents\/calculus-first-bridge\/index\.html"/);
  assert.match(out, /title="Calculus visual bridge"/);
  assert.match(out, /height="460"/);
  assert.doesNotMatch(out, /\[embed ref=/);
});

test('markdown renderer renders headings and lists as block markup', () => {
  const { renderMarkdown } = loadRenderer();

  const out = renderMarkdown('### Section **Title**\n- first item\n- second `code` item\n\n1. ordered item\n2. next item');

  assert.match(out, /<h3>Section <strong>Title<\/strong><\/h3>/);
  assert.match(out, /<ul><li>first item<\/li><li>second <code[^>]*>code<\/code> item<\/li><\/ul>/);
  assert.match(out, /<ol><li>ordered item<\/li><li>next item<\/li><\/ol>/);
  assert.doesNotMatch(out, /### Section/);
});

test('markdown renderer renders inline and display math through KaTeX', () => {
  const { renderMarkdown } = loadRenderer();

  const inline = renderMarkdown('Policy: $\\pi(y \\mid x, s)$ chooses outputs.');
  assert.match(inline, /class="katex"/);
  assert.match(inline, /data-expr="\\pi\(y \\mid x, s\)"/);
  assert.match(inline, /Policy:/);

  const display = renderMarkdown('$$\\pi(y \\mid x, s) = \\sum_z P(z \\mid x,s)\\pi_z(y \\mid x)$$');
  assert.match(display, /class="katex-display"/);
  assert.match(display, /\\sum_z/);
});

test('math renderer leaves code spans escaped and unrendered', () => {
  const { renderMarkdown } = loadRenderer();

  const out = renderMarkdown('Code stays code: `$x$ <tag>` but math renders: $x^2$.');
  assert.match(out, /<code/);
  assert.match(out, /\$x\$ &lt;tag&gt;/);
  assert.match(out, /data-expr="x\^2"/);
  assert.doesNotMatch(out, /<tag>/);
});

test('embed renderer accepts only hosted canvas refs or hosted canvas document urls', () => {
  const { renderMarkdown, parseHostedEmbedDirective } = loadRenderer();

  assert.equal(parseHostedEmbedDirective('[embed ref="../../secret" title="bad" /]'), null);
  assert.equal(parseHostedEmbedDirective('[embed url="file:///tmp/secret.html" title="bad" /]'), null);
  assert.equal(parseHostedEmbedDirective('[embed url="https://example.com/x" title="bad" /]'), null);
  const safeUrlEmbed = parseHostedEmbedDirective('[embed url="/__openclaw__/canvas/documents/safe_doc-1/index.html" title="Safe" height="9999" /]');
  assert.equal(safeUrlEmbed.ref, 'safe_doc-1');
  assert.equal(safeUrlEmbed.url, '/__openclaw__/canvas/documents/safe_doc-1/index.html');
  assert.equal(safeUrlEmbed.title, 'Safe');
  assert.equal(safeUrlEmbed.height, 900);

  const out = renderMarkdown('[embed url="file:///tmp/secret.html" title="bad" /]');
  assert.match(out, /\[embed url=&quot;file:\/\/\/tmp\/secret\.html&quot;/);
  assert.doesNotMatch(out, /<iframe/);
});
