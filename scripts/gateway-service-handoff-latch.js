#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  gatewayHandoffLatchPath,
  isGatewayHandoffLatched,
} = require('../lib/gateway-handoff-latch');

const profileDir = path.join(os.homedir(), '.openclaw-cotw');
const latchPath = gatewayHandoffLatchPath(profileDir);
const action = process.argv[2] || 'status';

function print(extra = {}) {
  console.log(JSON.stringify({
    profileDir,
    latchPath,
    latched: isGatewayHandoffLatched(profileDir),
    ...extra,
  }, null, 2));
}

if (action === 'set') {
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(latchPath, `service handoff in progress\ncreated=${new Date().toISOString()}\n`, { mode: 0o600 });
  print({ action });
} else if (action === 'clear') {
  fs.rmSync(latchPath, { force: true });
  print({ action });
} else if (action === 'status') {
  print({ action });
} else {
  console.error(`Usage: ${path.basename(process.argv[1])} [status|set|clear]`);
  process.exit(2);
}
