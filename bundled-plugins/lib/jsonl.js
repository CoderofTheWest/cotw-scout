'use strict';

const fs = require('fs');

function readLastLine(filePath, options = {}) {
    const maxBytes = options.maxBytes || 64 * 1024;
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size === 0) return null;

        const bytesToRead = Math.min(stat.size, maxBytes);
        const start = stat.size - bytesToRead;
        const buffer = Buffer.allocUnsafe(bytesToRead);
        const fd = fs.openSync(filePath, 'r');
        try {
            fs.readSync(fd, buffer, 0, bytesToRead, start);
        } finally {
            fs.closeSync(fd);
        }

        let end = buffer.length;
        while (end > 0 && (buffer[end - 1] === 10 || buffer[end - 1] === 13)) end--;
        if (end === 0) return null;

        let lineStart = end - 1;
        while (lineStart >= 0 && buffer[lineStart] !== 10) lineStart--;
        return buffer.subarray(lineStart + 1, end).toString('utf8');
    } catch {
        return null;
    }
}

function readLastJsonlEntry(filePath, options = {}) {
    const line = readLastLine(filePath, options);
    if (!line) return null;
    try {
        return JSON.parse(line);
    } catch {
        return null;
    }
}

function readJsonlBatchFromOffset(filePath, offset = 0, maxEntries = 100, options = {}) {
    const maxBytes = options.maxBytes || 1024 * 1024;
    const entries = [];
    let startOffset = Math.max(0, Number(offset) || 0);

    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size === 0) {
            return { entries, nextOffset: 0, eof: true };
        }
        if (startOffset > stat.size) startOffset = 0;

        const bytesToRead = Math.min(maxBytes, stat.size - startOffset);
        if (bytesToRead <= 0) {
            return { entries, nextOffset: startOffset, eof: true };
        }

        const buffer = Buffer.allocUnsafe(bytesToRead);
        const fd = fs.openSync(filePath, 'r');
        try {
            fs.readSync(fd, buffer, 0, bytesToRead, startOffset);
        } finally {
            fs.closeSync(fd);
        }

        let lineStart = 0;
        let consumedBytes = 0;
        for (let i = 0; i < buffer.length && entries.length < maxEntries; i++) {
            if (buffer[i] !== 10) continue;

            const line = buffer.subarray(lineStart, i).toString('utf8').trim();
            if (line) {
                try {
                    entries.push(JSON.parse(line));
                } catch {
                    // Skip malformed lines but still advance past them.
                }
            }
            consumedBytes = i + 1;
            lineStart = i + 1;
        }

        const nextOffset = startOffset + consumedBytes;
        return { entries, nextOffset, eof: nextOffset >= stat.size };
    } catch {
        return { entries, nextOffset: startOffset, eof: true };
    }
}

module.exports = {
    readJsonlBatchFromOffset,
    readLastJsonlEntry,
    readLastLine,
};
