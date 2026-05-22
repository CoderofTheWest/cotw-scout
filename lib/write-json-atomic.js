// Atomic file writers.
//
// Writes to a temp file, fsyncs, then renames into place. Prevents
// partial-write corruption if the process crashes or is killed mid-write —
// readers either see the old complete file or the new complete file, never
// a half-written one.
//
// Use writeJsonAtomic for the common JSON.stringify case. Use writeFileAtomic
// for arbitrary string/buffer content (e.g. template-substituted JSON strings,
// or any non-JSON file that needs the same crash safety).

const fs = require('fs');

// Write `content` (string or Buffer) to `filePath` atomically.
//
// By default, preserve the existing target file mode. Without this, replacing
// a sensitive file via temp+rename can silently fall back to the process umask
// (commonly 0644), which is exactly the wrong behavior for runtime config files
// that carry credentials/tokens.
function writeFileAtomic(filePath, content, options = {}) {
  const tmpPath = filePath + '.tmp';
  let targetMode = options.mode;
  if (targetMode == null) {
    try {
      targetMode = fs.statSync(filePath).mode & 0o777;
    } catch { /* file may not exist yet */ }
  }
  const fd = targetMode == null
    ? fs.openSync(tmpPath, 'w')
    : fs.openSync(tmpPath, 'w', targetMode);
  try {
    if (targetMode != null) fs.fchmodSync(fd, targetMode);
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
  return filePath;
}

// Write `data` as JSON to `filePath` atomically. Default indent is 2.
function writeJsonAtomic(filePath, data, indent = 2, options = {}) {
  return writeFileAtomic(filePath, JSON.stringify(data, null, indent), options);
}

module.exports = { writeFileAtomic, writeJsonAtomic };
