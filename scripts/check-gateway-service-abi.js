#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'ai.openclaw.cotw.plist');
const wrapperPath = path.join(os.homedir(), '.openclaw-cotw', 'service-env', 'openclaw-electron-node-wrapper.sh');
const electronPath = path.join(rootDir, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
const betterSqlitePath = path.join(rootDir, 'node_modules', 'better-sqlite3');
const expectedWorkspace = process.env.OPENCLAW_WORKSPACE || path.join(os.homedir(), 'Library', 'Application Support', 'COTW Trail Guide', 'workspace');
const trustCircleRegistryPath = path.join(expectedWorkspace, 'circle', 'registry.json');

function extractPlistProgramArguments(plistText) {
  const match = plistText.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!match) return [];
  return [...match[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) =>
    m[1]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim()
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    ...options,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    ok: result.status === 0,
  };
}

function nodeRuntimeInfo(nodePath) {
  const result = run(nodePath, ['-p', 'JSON.stringify({execPath:process.execPath,node:process.versions.node,electron:process.versions.electron,modules:process.versions.modules,napi:process.versions.napi})'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: nodePath === electronPath ? '1' : process.env.ELECTRON_RUN_AS_NODE },
  });
  if (!result.ok) return { ok: false, error: result.stderr || result.stdout };
  try {
    return { ok: true, ...JSON.parse(result.stdout) };
  } catch (error) {
    return { ok: false, error: error.message, raw: result.stdout };
  }
}

function sqliteSmoke(command, argsPrefix = [], env = process.env) {
  const script = `
const Database = require(${JSON.stringify(betterSqlitePath)});
const db = new Database(':memory:');
const row = db.prepare('select 1 as ok').get();
db.close();
console.log(JSON.stringify({ok:true,modules:process.versions.modules,row}));
`;
  const result = run(command, [...argsPrefix, '-e', script], { env: { ...process.env, ...env } });
  if (!result.ok) return { ok: false, error: result.stderr || result.stdout };
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    return { ok: false, error: error.message, raw: result.stdout };
  }
}

const report = {
  plistPath,
  plistExists: fs.existsSync(plistPath),
  wrapperPath,
  wrapperExists: fs.existsSync(wrapperPath),
  electronPath,
  electronExists: fs.existsSync(electronPath),
  serviceArguments: [],
  serviceUsesElectronWrapper: false,
  currentNode: nodeRuntimeInfo(process.execPath),
  electronAsNode: null,
  sqliteUnderCurrentNode: sqliteSmoke(process.execPath),
  sqliteUnderElectronAsNode: null,
  expectedWorkspace,
  trustCircleRegistryPath,
  trustCircleRegistryExists: fs.existsSync(trustCircleRegistryPath),
  wrapperExportsWorkspace: false,
  verdict: 'fail',
  failures: [],
};

if (report.plistExists) {
  report.serviceArguments = extractPlistProgramArguments(fs.readFileSync(plistPath, 'utf8'));
  report.serviceUsesElectronWrapper = report.serviceArguments.includes(wrapperPath);
} else {
  report.failures.push('LaunchAgent plist not found');
}

if (report.wrapperExists) {
  const wrapperText = fs.readFileSync(wrapperPath, 'utf8');
  report.wrapperExportsWorkspace = wrapperText.includes(`OPENCLAW_WORKSPACE='${expectedWorkspace}'`)
    || wrapperText.includes(`OPENCLAW_WORKSPACE=${JSON.stringify(expectedWorkspace)}`)
    || wrapperText.includes(`OPENCLAW_WORKSPACE=${expectedWorkspace}`);
}

if (!report.wrapperExists) report.failures.push('Electron-as-Node wrapper not found');
if (!report.electronExists) report.failures.push('Electron runtime not found');
if (!report.trustCircleRegistryExists) report.failures.push('trust-circle registry not found in expected COTW workspace');
if (report.wrapperExists && !report.wrapperExportsWorkspace) {
  report.failures.push('Electron-as-Node wrapper does not export OPENCLAW_WORKSPACE for trust-circle registry resolution');
}
if (report.plistExists && !report.serviceUsesElectronWrapper) {
  report.failures.push('LaunchAgent ProgramArguments do not use Electron-as-Node wrapper');
}

if (report.electronExists) {
  report.electronAsNode = nodeRuntimeInfo(electronPath);
  report.sqliteUnderElectronAsNode = sqliteSmoke(electronPath, [], { ELECTRON_RUN_AS_NODE: '1' });
  if (!report.electronAsNode.ok) report.failures.push(`Electron-as-Node runtime check failed: ${report.electronAsNode.error}`);
  if (!report.sqliteUnderElectronAsNode?.ok) report.failures.push(`better-sqlite3 failed under Electron-as-Node: ${report.sqliteUnderElectronAsNode?.error}`);
}

if (report.currentNode.ok && report.electronAsNode?.ok && report.currentNode.modules !== report.electronAsNode.modules) {
  report.currentNodeAbiDiffersFromElectron = true;
}

if (report.failures.length === 0) report.verdict = 'pass';

console.log(JSON.stringify(report, null, 2));
process.exit(report.verdict === 'pass' ? 0 : 1);
