'use strict';

const fs = require('fs');
const path = require('path');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function resolveBaseDataDir(pluginDir, config = {}) {
  const configured = config.storage?.dataDir;
  if (configured && typeof configured === 'string') return ensureDir(path.resolve(configured));
  return ensureDir(path.join(pluginDir, 'data'));
}

function writeJsonl(filePath, entries) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length > 0 ? '\n' : ''));
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function writeAnalysisArtifacts(dataDir, analysis) {
  const analysisDir = ensureDir(path.join(dataDir, 'analysis'));
  writeJsonl(path.join(analysisDir, 'windows.jsonl'), analysis.windows || []);
  writeJsonl(path.join(analysisDir, 'proposals.jsonl'), analysis.proposals || []);
  writeJsonl(path.join(analysisDir, 'scores.jsonl'), analysis.scoreReceipts || []);
  writeJsonl(path.join(analysisDir, 'relabel-candidates.jsonl'), analysis.relabelCandidates || []);
  writeJsonl(path.join(analysisDir, 'research-digests.jsonl'), analysis.digests || []);
  return analysisDir;
}

module.exports = {
  ensureDir,
  readJsonl,
  resolveBaseDataDir,
  writeAnalysisArtifacts,
  writeJsonl
};
