const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  parseBytes,
  readCompactionCheckpoints,
  buildContinuityHealthReport,
  formatHealthReportMarkdown
} = require('../lib/continuity-compaction-health');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-compaction-health-'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function appendJsonl(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
}

test('parseBytes accepts numeric and human-readable byte settings', () => {
  assert.equal(parseBytes(1024), 1024);
  assert.equal(parseBytes('1kb'), 1024);
  assert.equal(parseBytes('1.5mb'), 1572864);
  assert.equal(parseBytes('2 gb'), 2147483648);
  assert.equal(parseBytes(null), null);
  assert.equal(parseBytes('not bytes'), null);
});

test('readCompactionCheckpoints extracts compact metadata without exposing summary text', () => {
  const root = tmpDir();
  const transcript = path.join(root, 'session.jsonl');
  appendJsonl(transcript, [
    { type: 'session', id: 'session-1' },
    { type: 'message', id: 'm1' },
    {
      type: 'compaction',
      id: 'c1',
      parentId: 'm1',
      timestamp: '2026-05-11T19:18:19.389Z',
      firstKeptEntryId: 'm2',
      tokensBefore: 118734,
      summary: 'secret summary text that should not be returned',
      details: { readFiles: ['a.md'], modifiedFiles: ['b.md', 'c.md'] }
    }
  ]);

  const checkpoints = readCompactionCheckpoints(transcript);
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].lineNumber, 3);
  assert.equal(checkpoints[0].id, 'c1');
  assert.equal(checkpoints[0].tokensBefore, 118734);
  assert.equal(checkpoints[0].summaryChars, 'secret summary text that should not be returned'.length);
  assert.equal(checkpoints[0].readFilesCount, 1);
  assert.equal(checkpoints[0].modifiedFilesCount, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(checkpoints[0], 'summary'), false);
});

test('buildContinuityHealthReport flags inherited context and missing transcript rotation after compaction', () => {
  const root = tmpDir();
  const openclawHome = path.join(root, '.openclaw-test');
  const agentId = 'trail-guide';
  const sessionsDir = path.join(openclawHome, 'agents', agentId, 'sessions');
  const sessionId = 'session-123';
  const sessionKey = 'agent:trail-guide:test';
  const transcript = path.join(sessionsDir, `${sessionId}.jsonl`);

  writeJson(path.join(openclawHome, 'openclaw.json'), {
    agents: {
      defaults: {
        compaction: {
          mode: 'default',
          reserveTokensFloor: 30000,
          maxHistoryShare: 0.4,
          recentTurnsPreserve: 5
        }
      },
      list: [{ id: agentId }]
    }
  });
  writeJson(path.join(sessionsDir, 'sessions.json'), {
    [sessionKey]: {
      sessionId,
      sessionFile: transcript,
      contextTokens: 272000,
      totalTokens: 79000,
      compactionCount: 1,
      updatedAt: 1778527563559
    }
  });
  appendJsonl(transcript, [
    { type: 'session', id: sessionId },
    { type: 'message', id: 'm1' },
    { type: 'compaction', id: 'c1', timestamp: '2026-05-11T19:18:19.389Z', firstKeptEntryId: 'm2', tokensBefore: 118734, summary: 'summary' }
  ]);

  const report = buildContinuityHealthReport({ openclawHome, agentId, sessionKey, now: '2026-05-11T20:00:00.000Z' });
  assert.equal(report.contextWindow.effectiveContextTokens, 272000);
  assert.equal(report.contextWindow.inherited, true);
  assert.equal(report.compaction.truncateAfterCompaction, false);
  assert.equal(report.transcript.checkpointCount, 1);
  assert.equal(report.analysis.status, 'brittle');
  assert.ok(report.analysis.warnings.some((warning) => warning.code === 'context_window_inherited'));
  assert.ok(report.analysis.warnings.some((warning) => warning.code === 'active_transcript_growth_after_compaction'));
  assert.ok(report.recommendedConfigReceipt.changes.includes('Enable successor transcript rotation after compaction.'));
});

test('configured byte guard without successor transcript rotation is reported as inactive', () => {
  const root = tmpDir();
  const openclawHome = path.join(root, '.openclaw-test');
  const agentId = 'trail-guide';
  const sessionsDir = path.join(openclawHome, 'agents', agentId, 'sessions');
  const sessionId = 'session-guard';
  const sessionKey = 'agent:trail-guide:guard';
  const transcript = path.join(sessionsDir, `${sessionId}.jsonl`);

  writeJson(path.join(openclawHome, 'openclaw.json'), {
    agents: {
      defaults: {
        contextTokens: 100000,
        compaction: { maxActiveTranscriptBytes: '20mb' }
      }
    }
  });
  writeJson(path.join(sessionsDir, 'sessions.json'), {
    [sessionKey]: { sessionId, sessionFile: transcript, contextTokens: 100000, compactionCount: 0, updatedAt: 1 }
  });
  appendJsonl(transcript, [{ type: 'session', id: sessionId }]);

  const report = buildContinuityHealthReport({ openclawHome, agentId, sessionKey });
  assert.equal(report.contextWindow.inherited, false);
  assert.equal(report.compaction.maxActiveTranscriptBytesParsed, 20971520);
  assert.ok(report.analysis.warnings.some((warning) => warning.code === 'inactive_active_transcript_byte_guard'));
});

test('successor transcript rotation plus byte guard removes rotation brittleness warning', () => {
  const root = tmpDir();
  const openclawHome = path.join(root, '.openclaw-test');
  const agentId = 'trail-guide';
  const sessionsDir = path.join(openclawHome, 'agents', agentId, 'sessions');
  const sessionId = 'session-healthy';
  const sessionKey = 'agent:trail-guide:healthy';
  const transcript = path.join(sessionsDir, `${sessionId}.jsonl`);

  writeJson(path.join(openclawHome, 'openclaw.json'), {
    agents: {
      defaults: {
        contextTokens: 100000,
        compaction: {
          truncateAfterCompaction: true,
          maxActiveTranscriptBytes: '20mb',
          memoryFlush: { enabled: false }
        }
      }
    }
  });
  writeJson(path.join(sessionsDir, 'sessions.json'), {
    [sessionKey]: { sessionId, sessionFile: transcript, contextTokens: 100000, compactionCount: 1, updatedAt: 1 }
  });
  appendJsonl(transcript, [
    { type: 'session', id: sessionId },
    { type: 'compaction', id: 'c1', timestamp: '2026-05-11T19:18:19.389Z', firstKeptEntryId: 'm2', tokensBefore: 90000, summary: 'summary' }
  ]);

  const report = buildContinuityHealthReport({ openclawHome, agentId, sessionKey });
  assert.equal(report.compaction.truncateAfterCompaction, true);
  assert.ok(report.analysis.observations.some((item) => item.code === 'successor_transcript_rotation_enabled'));
  assert.equal(report.analysis.warnings.some((warning) => warning.code === 'active_transcript_growth_after_compaction'), false);
});

test('markdown formatter renders compact operator-facing health summary', () => {
  const report = {
    analysis: { status: 'watch', warnings: [{ severity: 'watch', code: 'context_window_inherited', message: 'Inherited.' }] },
    agentId: 'trail-guide',
    sessionKey: 'agent:trail-guide:test',
    contextWindow: {
      effectiveContextTokens: 272000,
      effectiveSource: 'session store runtime estimate',
      configuredContextTokens: null,
      configuredSource: 'runtime/model inherited'
    },
    transcript: { bytes: 1234, checkpointCount: 1 },
    compaction: { truncateAfterCompaction: false, maxActiveTranscriptBytes: null },
    checkpoints: [{ lineNumber: 3, id: 'c1', tokensBefore: 42, firstKeptEntryId: 'm2', timestamp: 'now' }],
    recommendedConfigReceipt: { changes: ['Enable successor transcript rotation after compaction.'] }
  };
  const markdown = formatHealthReportMarkdown(report);
  assert.match(markdown, /Continuity Compaction Health/);
  assert.match(markdown, /context_window_inherited/);
  assert.match(markdown, /Enable successor transcript rotation/);
});
