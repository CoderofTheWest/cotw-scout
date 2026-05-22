/**
 * tunnel.js — Cloudflare Tunnel lifecycle for the Companion.
 *
 * Phase 1 (this file): quick-tunnel mode only. Spawns `cloudflared tunnel --url`,
 * extracts the trycloudflare.com hostname from stdout, logs to userData/tunnel.log,
 * supervises the process, supports clean shutdown.
 *
 * Phase 2 (not yet): named-tunnel mode with a credentials file + stable hostname
 * under a Chris-owned domain. API glue + persistence go in this same module.
 */

const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

const QUICK_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const DEFAULT_START_TIMEOUT_MS = 20_000;

function findCloudflaredBinary({ isDev, resourcesPath }) {
  if (isDev) {
    try {
      const p = execSync('command -v cloudflared', { encoding: 'utf8', timeout: 2000 }).trim();
      if (p && fs.existsSync(p)) return p;
    } catch { /* fall through */ }
    for (const candidate of ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared']) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  const osArch = `${process.platform}-${process.arch}`;
  const bundled = path.join(resourcesPath, 'cloudflared', osArch, 'cloudflared');
  return fs.existsSync(bundled) ? bundled : null;
}

class TunnelController {
  constructor({ userDataPath, isDev, resourcesPath, onStatus }) {
    this.userDataPath = userDataPath;
    this.isDev = isDev;
    this.resourcesPath = resourcesPath;
    this.onStatus = onStatus || (() => {});
    this.proc = null;
    this.hostname = null;
    this.mode = null;
    this.logStream = null;
    this.shuttingDown = false;
  }

  get running() { return this.proc !== null; }

  async start({ port, mode = 'quick', startTimeoutMs = DEFAULT_START_TIMEOUT_MS } = {}) {
    if (this.running) {
      return { hostname: this.hostname, mode: this.mode, alreadyRunning: true };
    }
    if (mode !== 'quick') {
      throw new Error(`tunnel mode '${mode}' not implemented yet (Phase 2)`);
    }

    const binary = findCloudflaredBinary({ isDev: this.isDev, resourcesPath: this.resourcesPath });
    if (!binary) {
      throw new Error(this.isDev
        ? 'cloudflared not found on PATH. Install: brew install cloudflared'
        : 'bundled cloudflared missing (expected under resources/cloudflared/<os>-<arch>/)');
    }

    this._rotateLog();
    const logPath = path.join(this.userDataPath, 'tunnel.log');
    this.logStream = fs.createWriteStream(logPath, { flags: 'a' });
    this.logStream.write(`\n=== Tunnel started ${new Date().toISOString()} mode=quick port=${port} ===\n`);

    const args = ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'];
    this.onStatus({ phase: 'spawning', mode: 'quick' });

    this.proc = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.mode = 'quick';
    this.hostname = null;

    const hostnamePromise = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`tunnel did not report a hostname within ${startTimeoutMs}ms`));
      }, startTimeoutMs);

      const handleLine = (line) => {
        const match = line.match(QUICK_URL_RE);
        if (match && !settled) {
          settled = true;
          clearTimeout(timer);
          this.hostname = match[0].replace(/^https?:\/\//i, '');
          resolve(this.hostname);
        }
      };

      const stream = (src, prefix) => {
        src.on('data', (buf) => {
          const text = buf.toString();
          for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            this.logStream?.write(`[${new Date().toISOString()}] ${prefix}${line}\n`);
            handleLine(line);
          }
        });
      };
      stream(this.proc.stdout, '');
      stream(this.proc.stderr, 'ERR: ');

      this.proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });

      this.proc.on('close', (code) => {
        this.logStream?.write(`[${new Date().toISOString()}] cloudflared exited code=${code}\n`);
        this.logStream?.end();
        this.logStream = null;
        const wasRunning = this.proc !== null;
        this.proc = null;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`cloudflared exited (code=${code}) before reporting a hostname`));
          return;
        }
        if (wasRunning && !this.shuttingDown) {
          this.onStatus({ phase: 'crashed', code });
        }
      });
    });

    const hostname = await hostnamePromise;
    this.onStatus({ phase: 'ready', hostname, mode: 'quick' });
    return { hostname, mode: 'quick' };
  }

  async stop({ graceMs = 5000 } = {}) {
    if (!this.proc) return;
    this.shuttingDown = true;
    const proc = this.proc;
    this.proc = null;

    try { proc.kill('SIGTERM'); } catch { /* already dead */ }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* */ }
        resolve();
      }, graceMs);
      proc.once('close', () => { clearTimeout(timer); resolve(); });
    });

    this.hostname = null;
    this.mode = null;
    this.shuttingDown = false;
    this.onStatus({ phase: 'stopped' });
  }

  status() {
    return {
      running: this.running,
      mode: this.mode,
      hostname: this.hostname,
    };
  }

  _rotateLog() {
    const logPath = path.join(this.userDataPath, 'tunnel.log');
    const prevPath = path.join(this.userDataPath, 'tunnel.prev.log');
    try {
      if (fs.existsSync(logPath)) fs.renameSync(logPath, prevPath);
    } catch { /* best effort */ }
  }
}

module.exports = { TunnelController, findCloudflaredBinary };
