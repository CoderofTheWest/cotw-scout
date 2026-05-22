const fs = require('fs');
const path = require('path');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function appendGrowthVector(growthVectorsPath, inquiry) {
  ensureDir(path.dirname(growthVectorsPath));

  const existing = readJson(growthVectorsPath, { vectors: [] });
  existing.vectors = existing.vectors || [];

  const pass3 = (inquiry.passes || []).find(p => p.number === 3);
  existing.vectors.push({
    id: `gv_${inquiry.id}`,
    inquiryId: inquiry.id,
    question: inquiry.question,
    source: inquiry.source,
    entropy: inquiry.entropy,
    insight: pass3?.output || '',
    completed: inquiry.completed || new Date().toISOString(),
    created: inquiry.created,
    provenance: {
      exchangeId: inquiry.exchangeId || null,
      inquiryId: inquiry.id,
      source: inquiry.source,
      created: inquiry.created,
      completed: inquiry.completed || new Date().toISOString()
    }
  });

  existing.updated = new Date().toISOString();
  fs.writeFileSync(growthVectorsPath, JSON.stringify(existing, null, 2));
}

function writeInsightFile(insightsPath, inquiry) {
  ensureDir(insightsPath);
  const outPath = path.join(insightsPath, `${inquiry.id}.json`);
  fs.writeFileSync(outPath, JSON.stringify(inquiry, null, 2));
}

/**
 * Index a completed insight into continuity's vec_knowledge for semantic search.
 * Uses global.__ocContinuity.indexInsight() exposed by the continuity plugin.
 * Non-blocking, non-fatal — if continuity isn't available, insight is still persisted to file.
 *
 * @param {string} agentId
 * @param {object} inquiry - completed inquiry with passes
 */
async function indexInsightForSearch(agentId, inquiry) {
  if (!global.__ocContinuity?.indexInsight) return;

  const pass3 = (inquiry.passes || []).find(p => p.number === 3);
  if (!pass3?.output) return;

  try {
    await global.__ocContinuity.indexInsight(agentId, {
      topic: inquiry.question,
      content: pass3.output,
      source: `contemplation:${inquiry.id}`,
      tags: inquiry.tags || [],
      provenance: {
        exchangeId: inquiry.exchangeId || null,
        inquiryId: inquiry.id,
        source: inquiry.source,
        created: inquiry.created,
        completed: inquiry.completed
      }
    });
  } catch (err) {
    // Non-fatal — file-based insight is the primary record
    console.warn(`[Contemplation:writer] Failed to index insight ${inquiry.id} for search: ${err.message}`);
  }
}

module.exports = {
  appendGrowthVector,
  writeInsightFile,
  indexInsightForSearch
};
