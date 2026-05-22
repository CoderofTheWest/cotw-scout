const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainJs = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('main process actively monitors service-owned gateway attachments', () => {
  assert.match(mainJs, /let gatewayHealthMonitorTimer = null;/);
  assert.match(mainJs, /const GATEWAY_ATTACHED_HEALTH_INTERVAL_MS = 5000;/);
  assert.match(mainJs, /function startGatewayHealthMonitor\(\)/);
  assert.match(mainJs, /await httpGet\(`http:\/\/localhost:\$\{gatewayPort\}\/health`, 1500\);/);
  assert.match(mainJs, /gatewayHealthFailureCount >= GATEWAY_ATTACHED_HEALTH_FAILURES_BEFORE_RECONNECT/);
  assert.match(mainJs, /scheduleGatewayReconnect\('attached-health-monitor'\)/);
});

test('gateway attachment and detachment keep reconnect state coherent', () => {
  assert.match(mainJs, /function markGatewayAttached\(message = 'Attached to existing OpenClaw gateway'\)/);
  assert.match(mainJs, /gatewayReconnectAttempts = 0;/);
  assert.match(mainJs, /clearGatewayReconnectTimer\(\);/);
  assert.match(mainJs, /startGatewayHealthMonitor\(\);/);
  assert.match(mainJs, /openclawProcess\.on\('close', \(code\) => \{[\s\S]*?stopGatewayHealthMonitor\(\);[\s\S]*?scheduleGatewayReconnect\('process-close'\);[\s\S]*?\}\);/);
  assert.match(mainJs, /if \(gatewayAttached\) \{[\s\S]*?gatewayAttached = false;[\s\S]*?stopGatewayHealthMonitor\(\);[\s\S]*?sendStatus\('gateway', 'Gateway detached'\);[\s\S]*?return;[\s\S]*?\}/);
});

test('chat preflight can reattach to a recovered service gateway', () => {
  assert.match(mainJs, /if \(!openclawProcess && !gatewayAttached\) \{[\s\S]*?markGatewayAttached\('Reattached to existing OpenClaw gateway'\);[\s\S]*?\} else \{[\s\S]*?lastGatewayHealthCheck = Date\.now\(\);[\s\S]*?\}/);
});

test('main process watches restart continuation result and renders it into chat', () => {
  assert.match(mainJs, /resolveRestartContinuationResultPath/);
  assert.match(mainJs, /function extractRestartContinuationText\(raw\)/);
  assert.match(mainJs, /parsed\?\.result\?\.payloads/);
  assert.match(mainJs, /function startRestartContinuationWatcher\(\)/);
  assert.match(mainJs, /mainWindow\.webContents\.send\('chat:message', \{[\s\S]*?source: 'restart-continuation',[\s\S]*?\}\);/);
  assert.match(mainJs, /startGatewayHealthMonitor\(\);[\s\S]*?startRestartContinuationWatcher\(\);/);
});

test('gateway recovery never kills an occupied listener opportunistically', () => {
  assert.match(mainJs, /Gateway listener present but not healthy; waiting to reattach/);
  assert.match(mainJs, /gateway_listener_unhealthy_or_not_ready/);
  assert.doesNotMatch(mainJs, /Killing unhealthy\/orphaned process\(es\)/);
  assert.doesNotMatch(mainJs, /killPid\(pid, 'SIGKILL'\)/);
});

test('shutdown only cleans up listener when Electron owns a gateway process handle', () => {
  assert.match(mainJs, /let hadOwnedGatewayProcess = false;/);
  assert.match(mainJs, /if \(openclawProcess\) \{[\s\S]*?hadOwnedGatewayProcess = true;[\s\S]*?proc\.kill\('SIGTERM'\);/);
  assert.match(mainJs, /if \(hadOwnedGatewayProcess\) \{[\s\S]*?getPidsOnPort\(gatewayPort\);[\s\S]*?killPid\(pid, 'SIGTERM'\);[\s\S]*?\} else \{[\s\S]*?leaving listener untouched/);
});
