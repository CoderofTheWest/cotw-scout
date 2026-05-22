const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  HANDOFF_LATCH_FILENAME,
  gatewayHandoffLatchPath,
  isGatewayHandoffLatched,
} = require('../lib/gateway-handoff-latch');

test('gatewayHandoffLatchPath resolves inside the OpenClaw profile dir', () => {
  const profileDir = path.join(os.tmpdir(), 'openclaw-profile');

  assert.equal(
    gatewayHandoffLatchPath(profileDir),
    path.join(profileDir, HANDOFF_LATCH_FILENAME)
  );
});

test('isGatewayHandoffLatched reflects latch file presence', () => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-handoff-latch-'));
  try {
    assert.equal(isGatewayHandoffLatched(profileDir), false);

    fs.writeFileSync(gatewayHandoffLatchPath(profileDir), 'handoff in progress\n');

    assert.equal(isGatewayHandoffLatched(profileDir), true);
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
});

test('gatewayHandoffLatchPath requires an explicit profile dir', () => {
  assert.throws(() => gatewayHandoffLatchPath(), /profileDir is required/);
});
