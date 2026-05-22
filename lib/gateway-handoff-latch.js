const fs = require('node:fs');
const path = require('node:path');

const HANDOFF_LATCH_FILENAME = 'gateway-service-handoff.lock';

function gatewayHandoffLatchPath(profileDir) {
  if (!profileDir || typeof profileDir !== 'string') {
    throw new TypeError('profileDir is required');
  }
  return path.join(profileDir, HANDOFF_LATCH_FILENAME);
}

function isGatewayHandoffLatched(profileDir) {
  return fs.existsSync(gatewayHandoffLatchPath(profileDir));
}

module.exports = {
  HANDOFF_LATCH_FILENAME,
  gatewayHandoffLatchPath,
  isGatewayHandoffLatched,
};
