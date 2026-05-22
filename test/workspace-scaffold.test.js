const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createCircleRegistry,
  ensureCircleScaffold,
  profileIdFromDisplayName,
} = require('../lib/workspace-scaffold');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-scaffold-'));
}

function hasPlaceholder(value) {
  return JSON.stringify(value).includes('<') || JSON.stringify(value).includes('{USER_NAME}') || JSON.stringify(value).includes('{AGENT_NAME}');
}

test('profileIdFromDisplayName creates stable lowercase ids', () => {
  assert.equal(profileIdFromDisplayName('Chris Hunt'), 'chris-hunt');
  assert.equal(profileIdFromDisplayName('  !!!  '), 'operator');
});

test('createCircleRegistry generates valid anchor registry without placeholders', () => {
  const registry = createCircleRegistry({
    displayName: 'Chris Hunt',
    now: new Date('2026-05-12T15:00:00.000Z')
  });

  assert.equal(registry.version, 1);
  assert.equal(registry.profiles.length, 1);
  assert.deepEqual(registry.profiles[0], {
    id: 'chris-hunt',
    rank: 'anchor',
    displayName: 'Chris Hunt',
    vouchedBy: null,
    identityFile: 'ANCHOR.md',
    channels: {},
    lastModifiedBy: 'initial',
    lastModifiedAt: '2026-05-12T15:00:00.000Z'
  });
  assert.equal(hasPlaceholder(registry), false);
});

test('ensureCircleScaffold copies static support files and generates missing registry', () => {
  const dir = tmpdir();
  try {
    const template = path.join(dir, 'template-circle');
    const workspace = path.join(dir, 'workspace');
    fs.mkdirSync(template, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(template, 'README.md'), '# circle\n');
    fs.writeFileSync(path.join(template, 'noise-blacklist.json'), '{"entries":[]}\n');

    const result = ensureCircleScaffold({
      workspacePath: workspace,
      circleTemplatePath: template,
      displayName: 'Chris Hunt',
      now: new Date('2026-05-12T15:00:00.000Z')
    });

    assert.equal(result.skipped, false);
    assert.equal(result.registryWritten, true);
    assert.deepEqual(result.copied.sort(), ['README.md', 'noise-blacklist.json']);
    assert.equal(fs.readFileSync(path.join(workspace, 'circle', 'README.md'), 'utf8'), '# circle\n');

    const registry = JSON.parse(fs.readFileSync(path.join(workspace, 'circle', 'registry.json'), 'utf8'));
    assert.equal(registry.profiles[0].id, 'chris-hunt');
    assert.equal(hasPlaceholder(registry), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureCircleScaffold does not overwrite existing registry or support files', () => {
  const dir = tmpdir();
  try {
    const template = path.join(dir, 'template-circle');
    const workspace = path.join(dir, 'workspace');
    const circle = path.join(workspace, 'circle');
    fs.mkdirSync(template, { recursive: true });
    fs.mkdirSync(circle, { recursive: true });
    fs.writeFileSync(path.join(template, 'README.md'), '# new\n');
    fs.writeFileSync(path.join(template, 'noise-blacklist.json'), '{"entries":["new"]}\n');
    fs.writeFileSync(path.join(circle, 'README.md'), '# existing\n');
    fs.writeFileSync(path.join(circle, 'registry.json'), '{"version":1,"profiles":[{"id":"existing"}]}\n');

    const result = ensureCircleScaffold({
      workspacePath: workspace,
      circleTemplatePath: template,
      displayName: 'Chris Hunt'
    });

    assert.equal(result.registryWritten, false);
    assert.deepEqual(result.copied, ['noise-blacklist.json']);
    assert.equal(fs.readFileSync(path.join(circle, 'README.md'), 'utf8'), '# existing\n');
    assert.equal(JSON.parse(fs.readFileSync(path.join(circle, 'registry.json'), 'utf8')).profiles[0].id, 'existing');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('static template trees do not contain generated circle registry placeholders', () => {
  const root = path.join(__dirname, '..');
  for (const rel of ['template/circle/registry.json', 'bundled-template/circle/registry.json']) {
    assert.equal(fs.existsSync(path.join(root, rel)), false, `${rel} must be generated, not static`);
  }
});

test('fresh dev and packaged template materialization generate valid circle registry', () => {
  const root = path.join(__dirname, '..');
  const dir = tmpdir();
  try {
    for (const templateName of ['template', 'bundled-template']) {
      const workspace = path.join(dir, `${templateName}-workspace`);
      fs.cpSync(path.join(root, templateName), workspace, { recursive: true });
      ensureCircleScaffold({
        workspacePath: workspace,
        circleTemplatePath: path.join(root, templateName, 'circle'),
        displayName: 'Chris Hunt',
        now: new Date('2026-05-12T15:00:00.000Z')
      });

      const registry = JSON.parse(fs.readFileSync(path.join(workspace, 'circle', 'registry.json'), 'utf8'));
      assert.equal(registry.profiles[0].id, 'chris-hunt');
      assert.equal(hasPlaceholder(registry), false, `${templateName} materialized unresolved placeholders`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('static scaffold files are present in both dev and packaged template trees', () => {
  const root = path.join(__dirname, '..');
  const rels = [
    'TACTICAL-SOVEREIGNTY.md',
    'circle/README.md',
    'circle/noise-blacklist.json',
    'skills/visual-first-teaching/SKILL.md',
    'skills/visual-first-teaching/assets/learning-checkpoint-template.html',
  ];

  for (const rel of rels) {
    const devPath = path.join(root, 'template', rel);
    const bundledPath = path.join(root, 'bundled-template', rel);
    assert.equal(fs.existsSync(devPath), true, `template/${rel} missing`);
    assert.equal(fs.existsSync(bundledPath), true, `bundled-template/${rel} missing`);
    assert.equal(fs.readFileSync(devPath, 'utf8'), fs.readFileSync(bundledPath, 'utf8'), `${rel} drifted`);
  }
});
