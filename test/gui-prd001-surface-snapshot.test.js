const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(repoRoot, 'cotw-scout-gui.html'), 'utf8');

test('PRD-001 surface snapshot keeps ledger, evolve cards, approval cards, and process trails in one UI', () => {
  const snapshotContract = [
    'id="evolveTab"',
    'Read-only spine ledger',
    'renderEvolutionCard',
    'evolution-card',
    'renderEvolutionApprovalCard',
    'evolution-card--approval',
    'Approval required:',
    'renderEvolutionApprovalControls',
    '>Approve</button>',
    '>Deny</button>',
    'process-trail',
    'process-trail-summary',
    'Worked ${elapsed}s · ${toolSteps} tool',
    'sanitizeProcessTrailText',
    'renderProcessTrail',
    'recordProcessTrailStep',
    'showEvolutionDetail',
    'openEvolutionInChat'
  ];

  for (const marker of snapshotContract) {
    assert.ok(html.includes(marker), `missing PRD-001 UI marker: ${marker}`);
  }

  assert.doesNotMatch(html, /window\.open\([^)]*process-trail|target="_blank"[^>]*process-trail/i, 'process trails must stay in the single-window surface');
  assert.doesNotMatch(html, /chain[- ]of[- ]thought[^\n]{0,120}<summary/i, 'process trail summary must not expose raw reasoning labels');
});
