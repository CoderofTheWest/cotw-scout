/**
 * metabolismLock.js — File-Based Concurrency Lock for Metabolism Processing
 *
 * Inspired by KAIROS's consolidationLock.ts. Uses PID + file mtime to
 * coordinate metabolism processing across crashes and process restarts.
 *
 * Lock semantics:
 * - File body = owning process PID
 * - File mtime = timestamp of lock acquisition
 * - Stale threshold: 60 minutes (reclaim if holder is dead or stuck)
 * - Rollback: on failure, rewind mtime so next attempt can proceed
 *
 * March 31, 2026
 */

const fs = require('fs');
const path = require('path');

const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 60 minutes
const LOCK_FILENAME = '.metabolism-lock';

/**
 * Resolve lock file path for an agent.
 * @param {string} dataDir - Plugin data directory
 * @param {string} agentId - Agent identifier
 * @returns {string} Absolute path to lock file
 */
function _lockPath(dataDir, agentId) {
    if (!agentId || agentId === 'main') {
        return path.join(dataDir, LOCK_FILENAME);
    }
    return path.join(dataDir, 'agents', agentId, LOCK_FILENAME);
}

/**
 * Check if a PID is alive.
 * @param {number} pid
 * @returns {boolean}
 */
function _isProcessAlive(pid) {
    try {
        process.kill(pid, 0); // Signal 0 = existence check
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Try to acquire the metabolism lock.
 * Returns the prior mtime (for rollback) on success, or null if blocked.
 *
 * @param {string} dataDir - Plugin data directory
 * @param {string} agentId - Agent identifier
 * @returns {{ priorMtime: number } | null}
 */
function tryAcquireLock(dataDir, agentId) {
    const lockFile = _lockPath(dataDir, agentId);

    try {
        // Check existing lock
        if (fs.existsSync(lockFile)) {
            const stat = fs.statSync(lockFile);
            const ageMs = Date.now() - stat.mtimeMs;
            const priorMtime = stat.mtimeMs;

            // Read holder PID
            let holderPid = null;
            try {
                const body = fs.readFileSync(lockFile, 'utf8').trim();
                holderPid = parseInt(body, 10);
            } catch (e) {
                // Corrupt lock file — treat as stale
            }

            // If holder is alive and lock is fresh, we're blocked
            if (holderPid && _isProcessAlive(holderPid) && ageMs < STALE_THRESHOLD_MS) {
                return null;
            }

            // Lock is stale or holder is dead — reclaim
            console.log(
                `[MetabolismLock:${agentId}] Reclaiming stale lock ` +
                `(holder PID ${holderPid}, age ${Math.round(ageMs / 1000)}s, ` +
                `alive=${holderPid ? _isProcessAlive(holderPid) : false})`
            );

            // Write our PID
            fs.writeFileSync(lockFile, String(process.pid));

            // Verify we won the write race (re-read)
            const verifyBody = fs.readFileSync(lockFile, 'utf8').trim();
            if (parseInt(verifyBody, 10) !== process.pid) {
                return null; // Lost the race
            }

            return { priorMtime };
        }

        // No lock exists — create it
        const dir = path.dirname(lockFile);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(lockFile, String(process.pid));

        // Verify
        const verifyBody = fs.readFileSync(lockFile, 'utf8').trim();
        if (parseInt(verifyBody, 10) !== process.pid) {
            return null;
        }

        return { priorMtime: 0 };
    } catch (err) {
        console.error(`[MetabolismLock:${agentId}] Lock acquisition error:`, err.message);
        return null;
    }
}

/**
 * Release the metabolism lock.
 * Only releases if we're the current holder.
 *
 * @param {string} dataDir
 * @param {string} agentId
 */
function releaseLock(dataDir, agentId) {
    const lockFile = _lockPath(dataDir, agentId);

    try {
        if (!fs.existsSync(lockFile)) return;

        const body = fs.readFileSync(lockFile, 'utf8').trim();
        if (parseInt(body, 10) === process.pid) {
            fs.unlinkSync(lockFile);
        }
    } catch (err) {
        console.warn(`[MetabolismLock:${agentId}] Release error:`, err.message);
    }
}

/**
 * Rollback the lock on failure — rewind mtime so next attempt can proceed.
 *
 * @param {string} dataDir
 * @param {string} agentId
 * @param {number} priorMtime - The mtime before we acquired (0 = no prior lock)
 */
function rollbackLock(dataDir, agentId, priorMtime) {
    const lockFile = _lockPath(dataDir, agentId);

    try {
        if (priorMtime === 0) {
            // No lock existed before — remove it
            if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
        } else {
            // Rewind mtime to prior value
            const priorDate = new Date(priorMtime);
            fs.writeFileSync(lockFile, ''); // Clear PID
            fs.utimesSync(lockFile, priorDate, priorDate);
        }
        console.log(`[MetabolismLock:${agentId}] Rolled back lock (priorMtime=${priorMtime})`);
    } catch (err) {
        console.warn(`[MetabolismLock:${agentId}] Rollback error:`, err.message);
    }
}

/**
 * Check if locked without acquiring.
 *
 * @param {string} dataDir
 * @param {string} agentId
 * @returns {boolean}
 */
function isLocked(dataDir, agentId) {
    const lockFile = _lockPath(dataDir, agentId);

    try {
        if (!fs.existsSync(lockFile)) return false;

        const stat = fs.statSync(lockFile);
        const ageMs = Date.now() - stat.mtimeMs;
        const body = fs.readFileSync(lockFile, 'utf8').trim();
        const holderPid = parseInt(body, 10);

        return holderPid && _isProcessAlive(holderPid) && ageMs < STALE_THRESHOLD_MS;
    } catch (err) {
        return false;
    }
}

module.exports = {
    tryAcquireLock,
    releaseLock,
    rollbackLock,
    isLocked
};
