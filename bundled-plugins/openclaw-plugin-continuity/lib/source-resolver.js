const fs = require('fs');
const path = require('path');
const { parseSourceHandle, SOURCE_HANDLE_TYPES } = require('./source-handles');

/**
 * Build 2 source resolver interface/adapters.
 *
 * Runtime-inert: this module exports resolver factories only. It does not read
 * anything until a caller explicitly invokes the returned resolver, and it is
 * not wired into plugin hooks or prompt injection.
 */
function createSourceResolver(options = {}) {
    return async function resolve(sourceOrRef) {
        return resolveSourceHandle(sourceOrRef?.handle || sourceOrRef, options);
    };
}

async function resolveSourceHandle(handle, options = {}) {
    const parsed = parseSourceHandle(handle);
    if (!parsed.ok) return unresolved(handle, parsed.type || 'unknown', parsed.errors.join('; ') || 'invalid source handle');

    const adapter = options.adapters?.[parsed.type];
    if (typeof adapter === 'function') {
        try {
            const result = await adapter(parsed, options);
            return normalizeAdapterResult(parsed, result);
        } catch (err) {
            return unresolved(parsed.handle, parsed.type, err.message);
        }
    }

    switch (parsed.type) {
        case SOURCE_HANDLE_TYPES.FILE:
            return resolveFile(parsed, options);
        case SOURCE_HANDLE_TYPES.HANDOFF:
            return resolveHandoff(parsed, options);
        case SOURCE_HANDLE_TYPES.DIGEST:
            return resolveDigest(parsed, options);
        case SOURCE_HANDLE_TYPES.TRANSCRIPT:
            return resolveTranscript(parsed, options);
        case SOURCE_HANDLE_TYPES.ARCHIVE:
            return resolveArchive(parsed, options);
        default:
            return unresolved(parsed.handle, parsed.type, `no resolver adapter configured for ${parsed.type}`);
    }
}

function resolveFile(parsed, options = {}) {
    const workspaceDir = options.workspaceDir;
    if (!workspaceDir) return unresolved(parsed.handle, parsed.type, 'workspaceDir is required for file handles');
    const filePath = safeJoin(workspaceDir, parsed.path);
    if (!filePath.ok) return unresolved(parsed.handle, parsed.type, filePath.error);
    if (!fs.existsSync(filePath.path)) return unresolved(parsed.handle, parsed.type, 'file does not exist');
    const content = readLineRange(filePath.path, parsed.startLine, parsed.endLine);
    return resolved(parsed, content, {
        path: parsed.path,
        absolutePath: options.includeAbsolutePath ? filePath.path : undefined,
        startLine: parsed.startLine,
        endLine: parsed.endLine
    });
}

function resolveHandoff(parsed, options = {}) {
    const dirs = normalizeArray(options.handoffDirs || options.handoffDir);
    if (!dirs.length) return unresolved(parsed.handle, parsed.type, 'handoffDirs is required for handoff handles');
    const filePath = findHandoffFile(dirs, parsed);
    if (!filePath) return unresolved(parsed.handle, parsed.type, 'handoff file does not exist');
    const content = readLineRange(filePath, parsed.startLine, parsed.endLine);
    return resolved(parsed, content, {
        date: parsed.date,
        threadId: parsed.threadId,
        fileName: path.basename(filePath),
        startLine: parsed.startLine,
        endLine: parsed.endLine
    });
}

function resolveDigest(parsed, options = {}) {
    if (isSummaryDigestField(parsed.field)) {
        const summaryResult = resolveSummaryDigest(parsed, options);
        if (summaryResult.ok || isTerminalSummaryDigestError(summaryResult.error)) return summaryResult;
    }

    const store = options.activeThreadDigestStore || options.digestStore;
    if (!store || typeof store.read !== 'function') {
        return unresolved(parsed.handle, parsed.type, 'activeThreadDigestStore is required for digest handles');
    }
    const digest = store.read(parsed.threadId);
    if (!digest) return unresolved(parsed.handle, parsed.type, 'digest does not exist');
    if (digest.version !== undefined && Number(digest.version) !== parsed.version) {
        return unresolved(parsed.handle, parsed.type, `digest version mismatch: expected ${parsed.version}, found ${digest.version}`);
    }
    const value = getPath(digest, parsed.field);
    if (value === undefined || value === null || value === '') return unresolved(parsed.handle, parsed.type, `digest field not found: ${parsed.field}`);
    return resolved(parsed, stringifyContent(value), {
        threadId: parsed.threadId,
        version: parsed.version,
        field: parsed.field,
        digestUpdatedAt: digest.lastUpdated || null
    }, digest.lastUpdated || null);
}

function resolveSummaryDigest(parsed, options = {}) {
    const store = options.summaryStore || options.digestSummaryStore || summaryStoreFrom(options.activeThreadDigestStore) || summaryStoreFrom(options.digestStore);
    if (!store || typeof store.getSummary !== 'function') {
        return unresolved(parsed.handle, parsed.type, 'summaryStore is required for digest summary handles');
    }

    const candidates = summaryIdCandidates(parsed.field);
    for (const summaryId of candidates) {
        const summary = store.getSummary(summaryId);
        if (!summary) continue;
        if (summary.threadId && parsed.threadId && String(summary.threadId) !== String(parsed.threadId)) {
            return unresolved(parsed.handle, parsed.type, `summary thread mismatch: expected ${parsed.threadId}, found ${summary.threadId}`);
        }
        if (!summary.summaryText) return unresolved(parsed.handle, parsed.type, `summary text not found: ${summaryId}`);
        return resolved(parsed, summary.summaryText, {
            threadId: parsed.threadId,
            version: parsed.version,
            field: parsed.field,
            summaryId,
            summaryLevel: summary.level,
            summaryAgentId: summary.agentId || null,
            summaryThreadId: summary.threadId || null,
            dateRangeStart: summary.dateRangeStart || null,
            dateRangeEnd: summary.dateRangeEnd || null,
            summaryCreatedAt: summary.createdAt || null
        }, summary.createdAt || summary.dateRangeEnd || null);
    }

    return unresolved(parsed.handle, parsed.type, `digest summary not found: ${parsed.field}`);
}

function isTerminalSummaryDigestError(error) {
    return /^summary thread mismatch:/.test(String(error || ''))
        || /^summary text not found:/.test(String(error || ''));
}

function isSummaryDigestField(field) {
    return String(field || '').startsWith('summary_');
}

function summaryStoreFrom(value) {
    return value && typeof value.getSummary === 'function' ? value : null;
}

function summaryIdCandidates(field) {
    const value = String(field || '').trim();
    const candidates = [];
    if (value) candidates.push(value);
    if (value.startsWith('summary_')) candidates.push(value.replace(/^summary_/, ''));
    return unique(candidates);
}

function resolveTranscript(parsed, options = {}) {
    const messages = typeof options.getTranscript === 'function'
        ? options.getTranscript(parsed.sessionId)
        : options.transcriptMessages;
    if (!Array.isArray(messages)) return unresolved(parsed.handle, parsed.type, 'transcript messages are unavailable');
    const message = pickIndexed(messages, parsed.messageIndex);
    if (!message) return unresolved(parsed.handle, parsed.type, 'transcript message does not exist');
    return resolved(parsed, extractMessageText(message), {
        sessionId: parsed.sessionId,
        messageIndex: parsed.messageIndex,
        role: message.role || message.sender || null
    }, message.timestamp || null);
}

function resolveArchive(parsed, options = {}) {
    const archiver = options.archiver;
    if (!archiver || typeof archiver.getConversation !== 'function') return unresolved(parsed.handle, parsed.type, 'archiver is required for archive handles');
    const conversation = archiver.getConversation(parsed.date);
    if (!conversation || !Array.isArray(conversation.messages)) return unresolved(parsed.handle, parsed.type, 'archive conversation does not exist');
    const message = findArchiveMessage(conversation.messages, parsed.exchangeId);
    if (!message) return unresolved(parsed.handle, parsed.type, 'archive exchange does not exist');
    return resolved(parsed, extractMessageText(message), {
        date: parsed.date,
        agentId: parsed.agentId,
        threadId: parsed.threadId,
        exchangeId: parsed.exchangeId,
        sender: message.sender || message.role || null
    }, message.timestamp || null);
}

function findArchiveMessage(messages, exchangeId) {
    const exact = messages.find((message) => [message.exchangeId, message.exchange_id, message.id].some((value) => value !== undefined && String(value) === String(exchangeId)));
    if (exact) return exact;
    const numeric = Number(String(exchangeId).replace(/^0+/, '') || '0');
    if (Number.isFinite(numeric) && numeric > 0) return messages[numeric - 1] || null;
    return null;
}

function findHandoffFile(dirs, parsed) {
    for (const dir of dirs) {
        if (!dir || !fs.existsSync(dir)) continue;
        const direct = path.join(dir, `${parsed.date}.md`);
        if (fs.existsSync(direct)) return direct;
        const candidates = fs.readdirSync(dir)
            .filter((name) => name.endsWith('.md') && name.startsWith(parsed.date))
            .sort();
        const threadSafe = sanitizeFragment(parsed.threadId);
        const threadMatch = candidates.find((name) => sanitizeFragment(name).includes(threadSafe));
        const selected = threadMatch || candidates[0];
        if (selected) return path.join(dir, selected);
    }
    return null;
}

function safeJoin(baseDir, relativePath) {
    if (!relativePath || typeof relativePath !== 'string') return { ok: false, error: 'path is required' };
    if (relativePath.includes('\0')) return { ok: false, error: 'path contains NUL byte' };
    if (/^[a-zA-Z]+:\/\//.test(relativePath)) return { ok: false, error: 'URL paths are not allowed' };
    if (path.isAbsolute(relativePath)) return { ok: false, error: 'absolute paths are not allowed' };
    const base = path.resolve(baseDir);
    const target = path.resolve(base, relativePath);
    if (target !== base && !target.startsWith(base + path.sep)) return { ok: false, error: 'path escapes workspaceDir' };
    return { ok: true, path: target };
}

function readLineRange(filePath, startLine, endLine) {
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    return lines.slice(Math.max(0, startLine - 1), endLine).join('\n');
}

function pickIndexed(items, index) {
    if (items[index]) return items[index];
    if (index > 0 && items[index - 1]) return items[index - 1];
    return null;
}

function extractMessageText(message) {
    if (typeof message === 'string') return message;
    if (typeof message.text === 'string') return message.text;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
        return message.content.map((part) => part?.text || part?.content || '').filter(Boolean).join('\n');
    }
    return stringifyContent(message);
}

function normalizeAdapterResult(parsed, result) {
    if (!result) return unresolved(parsed.handle, parsed.type, 'resolver adapter returned no result');
    if (result.ok === false) return unresolved(parsed.handle, parsed.type, result.error || 'resolver adapter failed', result.metadata || {});
    return {
        ok: true,
        handle: parsed.handle,
        sourceType: result.sourceType || result.source_type || parsed.type,
        content: result.content || '',
        timestamp: result.timestamp || null,
        metadata: result.metadata || {}
    };
}

function resolved(parsed, content, metadata = {}, timestamp = null) {
    return {
        ok: true,
        handle: parsed.handle,
        sourceType: parsed.type,
        content: content || '',
        timestamp,
        metadata: stripUndefined(metadata)
    };
}

function unresolved(handle, sourceType, error, metadata = {}) {
    return {
        ok: false,
        handle: String(handle || ''),
        sourceType,
        error,
        metadata
    };
}

function stringifyContent(value) {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function getPath(object, dottedPath) {
    return String(dottedPath).split('.').reduce((value, key) => value?.[key], object);
}

function normalizeArray(value) {
    if (value === undefined || value === null || value === '') return [];
    return Array.isArray(value) ? value : [value];
}

function unique(values = []) {
    return [...new Set(values.filter(Boolean))];
}

function stripUndefined(object) {
    return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function sanitizeFragment(value) {
    return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

module.exports = {
    createSourceResolver,
    resolveSourceHandle,
    safeJoin
};
