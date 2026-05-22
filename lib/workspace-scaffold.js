const fs = require('fs');
const path = require('path');

const CIRCLE_STATIC_FILES = ['noise-blacklist.json', 'README.md'];

function profileIdFromDisplayName(displayName) {
  return String(displayName || 'Operator')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'operator';
}

function createCircleRegistry({ displayName = 'Operator', now = new Date() } = {}) {
  const resolvedDisplayName = displayName || 'Operator';
  const lastModifiedAt = now instanceof Date ? now.toISOString() : String(now);
  return {
    version: 1,
    profiles: [
      {
        id: profileIdFromDisplayName(resolvedDisplayName),
        rank: 'anchor',
        displayName: resolvedDisplayName,
        vouchedBy: null,
        identityFile: 'ANCHOR.md',
        channels: {},
        lastModifiedBy: 'initial',
        lastModifiedAt
      }
    ]
  };
}

function copyMissingCircleStaticFiles({ circleTemplatePath, circleDir }) {
  const copied = [];
  if (!circleTemplatePath || !fs.existsSync(circleTemplatePath)) return copied;

  for (const file of CIRCLE_STATIC_FILES) {
    const src = path.join(circleTemplatePath, file);
    const dst = path.join(circleDir, file);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
      copied.push(file);
    }
  }
  return copied;
}

function ensureCircleScaffold({ workspacePath, circleTemplatePath, displayName, now } = {}) {
  if (!workspacePath || !fs.existsSync(workspacePath)) {
    return { skipped: true, reason: 'workspace-missing', copied: [], registryWritten: false };
  }

  const circleDir = path.join(workspacePath, 'circle');
  const registryPath = path.join(circleDir, 'registry.json');
  fs.mkdirSync(circleDir, { recursive: true });

  const copied = copyMissingCircleStaticFiles({ circleTemplatePath, circleDir });
  let registryWritten = false;

  if (!fs.existsSync(registryPath)) {
    const registry = createCircleRegistry({ displayName, now });
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf8');
    registryWritten = true;
  }

  return { skipped: false, copied, registryWritten, registryPath };
}

module.exports = {
  CIRCLE_STATIC_FILES,
  profileIdFromDisplayName,
  createCircleRegistry,
  copyMissingCircleStaticFiles,
  ensureCircleScaffold,
};
