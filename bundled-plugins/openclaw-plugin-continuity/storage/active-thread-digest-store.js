const path = require('path');
const fs = require('fs');
const {
    createActiveThreadDigest,
    updateActiveThreadDigest,
    validateActiveThreadDigest
} = require('../lib/active-thread-digest');

/**
 * JSON-backed Active Thread Digest store.
 *
 * This is intentionally inert unless the caller explicitly instantiates and
 * calls it. Build 1 wires runtime usage behind activeThreadDigest.enabled.
 */
class ActiveThreadDigestStore {
    constructor(options = {}) {
        this.baseDir = options.baseDir;
        this.agentId = options.agentId || 'main';
        this.clock = options.clock || (() => new Date().toISOString());
        if (!this.baseDir) throw new Error('ActiveThreadDigestStore requires baseDir');
    }

    ensureDir() {
        fs.mkdirSync(this.baseDir, { recursive: true });
    }

    pathForThread(threadId) {
        return path.join(this.baseDir, `${sanitizeThreadId(threadId)}.json`);
    }

    read(threadId) {
        const filePath = this.pathForThread(threadId);
        if (!fs.existsSync(filePath)) return null;
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    }

    write(digest) {
        const validation = validateActiveThreadDigest(digest);
        if (!validation.ok) {
            throw new Error(`Invalid active thread digest: ${validation.errors.join('; ')}`);
        }
        this.ensureDir();
        const filePath = this.pathForThread(digest.threadId);
        const tmpPath = `${filePath}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(digest, null, 2), 'utf8');
        fs.renameSync(tmpPath, filePath);
        return { filePath, digest };
    }

    create(input = {}) {
        const digest = createActiveThreadDigest({ agentId: this.agentId, ...input }, { now: this.clock() });
        return this.write(digest);
    }

    update(threadId, patch = {}) {
        const existing = this.read(threadId);
        const digest = updateActiveThreadDigest(
            existing,
            { threadId, agentId: this.agentId, ...patch },
            { now: this.clock() }
        );
        return this.write(digest);
    }

    list() {
        if (!fs.existsSync(this.baseDir)) return [];
        return fs.readdirSync(this.baseDir)
            .filter((name) => name.endsWith('.json'))
            .map((name) => JSON.parse(fs.readFileSync(path.join(this.baseDir, name), 'utf8')));
    }
}

function sanitizeThreadId(threadId) {
    const raw = String(threadId || 'main');
    const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
    return safe.slice(0, 120) || 'main';
}

module.exports = {
    ActiveThreadDigestStore,
    sanitizeThreadId
};
