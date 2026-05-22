/**
 * Contamination Check — read-time warning layer for recalled exchanges.
 *
 * Reads `<dataDir>/contamination-windows.json` and checks whether a given
 * exchange date falls inside a known contamination window. When it does,
 * returns a disconfirm hint that retrieval paths can surface alongside
 * the recalled content, so the agent knows to treat that recall with
 * extra skepticism rather than ground-truth trust.
 *
 * Ported conceptually from Wren's Continuity v2 disconfirm-hints
 * mechanism — the Phase D weekly pass writes hints to individual exchange
 * rows. For Ellis, a date-range window is a simpler first cut that
 * doesn't require schema migration or a nightshift-gated generation pass.
 * Windows can be added over time by editing the JSON file.
 *
 * Schema (contamination-windows.json):
 *   {
 *     "windows": [
 *       {
 *         "id": "short-id",
 *         "start_date": "YYYY-MM-DD",
 *         "end_date": "YYYY-MM-DD",
 *         "description": "what happened",
 *         "signatures": ["..."],
 *         "disconfirm_hint": "text to surface at recall time"
 *       }
 *     ]
 *   }
 *
 * Missing file / parse error → empty list → no-op (safe degradation).
 */

const fs = require('fs');
const path = require('path');

let _cache = null;
let _cacheMtimeMs = 0;
let _cachedPath = null;

/**
 * Load contamination windows from the data dir. Cached by mtime so
 * hot-path retrieval doesn't re-read the file unless it changes.
 *
 * @param {string} dataDir - plugin data directory
 * @returns {Array} array of window objects, or [] on any failure
 */
function loadWindows(dataDir) {
    if (!dataDir) return [];
    const windowsPath = path.join(dataDir, 'contamination-windows.json');
    if (!fs.existsSync(windowsPath)) {
        _cache = [];
        return _cache;
    }
    try {
        const stat = fs.statSync(windowsPath);
        if (_cache && _cachedPath === windowsPath && stat.mtimeMs === _cacheMtimeMs) {
            return _cache;
        }
        const parsed = JSON.parse(fs.readFileSync(windowsPath, 'utf8'));
        _cache = Array.isArray(parsed.windows) ? parsed.windows : [];
        _cacheMtimeMs = stat.mtimeMs;
        _cachedPath = windowsPath;
        return _cache;
    } catch (err) {
        // Malformed file — never block retrieval on it.
        _cache = [];
        return _cache;
    }
}

/**
 * Check whether an exchange date falls inside any contamination window.
 *
 * @param {string} dateStr - YYYY-MM-DD (archive date on the exchange)
 * @param {Array} windows - from loadWindows()
 * @returns {object|null} { windowId, description, disconfirmHint, signatures } or null
 */
function checkDate(dateStr, windows) {
    if (!dateStr || !Array.isArray(windows) || windows.length === 0) return null;
    for (const w of windows) {
        if (!w || !w.start_date || !w.end_date) continue;
        // String compare works because dates are ISO-8601 YYYY-MM-DD.
        if (dateStr >= w.start_date && dateStr <= w.end_date) {
            return {
                windowId: w.id || 'unknown',
                description: w.description || '',
                disconfirmHint: w.disconfirm_hint || '',
                signatures: Array.isArray(w.signatures) ? w.signatures : []
            };
        }
    }
    return null;
}

/**
 * Convenience — given a list of exchanges (each with a `date` field),
 * return the unique set of disconfirm hints that apply.
 *
 * @param {Array} exchanges
 * @param {Array} windows
 * @returns {Array<string>} deduped hints, suitable for rendering
 */
function collectHints(exchanges, windows) {
    if (!Array.isArray(exchanges) || exchanges.length === 0) return [];
    const seen = new Set();
    const hints = [];
    for (const ex of exchanges) {
        const hit = checkDate(ex && ex.date, windows);
        if (hit && hit.disconfirmHint && !seen.has(hit.disconfirmHint)) {
            seen.add(hit.disconfirmHint);
            hints.push(hit.disconfirmHint);
        }
    }
    return hints;
}

module.exports = { loadWindows, checkDate, collectHints };
