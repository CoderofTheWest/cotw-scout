const fs = require('fs');
const path = require('path');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Semantic dedup for contemplation inquiries.
 *
 * Metabolism rephrases the same concept across candidates. Exact string
 * match misses these. This extracts stemmed keyword sets and uses Jaccard
 * similarity to catch reformulations.
 */

const DEDUP_STOP_WORDS = new Set(['this', 'that', 'with', 'from', 'into', 'when', 'what',
  'where', 'which', 'have', 'been', 'will', 'does', 'more', 'also', 'than',
  'very', 'just', 'some', 'each', 'only', 'about', 'could', 'would', 'should',
  'their', 'there', 'these', 'those', 'other', 'being', 'after', 'before',
  'noted', 'requires', 'unclear', 'indicates', 'across', 'apply', 'operate',
  'need', 'know', 'make', 'like', 'take', 'come', 'look', 'want', 'give']);

function stemWord(w) {
  const suffixes = [/ness$/, /tion$/, /sion$/, /ment$/, /ence$/, /ance$/, /ity$/,
    /ing$/, /ated$/, /ates$/, /ies$/, /ous$/, /ive$/, /able$/, /ible$/, /ed$/, /es$/, /s$/];
  for (const s of suffixes) {
    if (s.test(w)) {
      const stemmed = w.replace(s, '');
      if (stemmed.length >= 4) return stemmed;
    }
  }
  return w;
}

function getKeyWords(question) {
  let q = question || '';
  q = q.replace(/^\[[\w\s-]+\]\s*/, '');       // strip [topic] prefix
  q = q.replace(/\|.*$/, '');                    // strip | category suffix
  q = q.replace(/\.\s*(?:Why|How to apply):.*$/s, ''); // strip structured suffixes
  q = q.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = q.split(' ')
    .filter(w => w.length >= 4 && !DEDUP_STOP_WORDS.has(w))
    .map(w => stemWord(w))
    .filter(w => w.length >= 3);
  return new Set(words);
}

function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  const intersection = [...setA].filter(w => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return intersection / union;
}

const DEDUP_JACCARD_THRESHOLD = 0.5;

class InquiryStore {
  constructor(baseDir, agentId, passesConfig) {
    this.agentId = agentId || 'main';
    this.passesConfig = passesConfig || {};
    this.agentDir = path.join(baseDir, 'agents', this.agentId);
    this.filePath = path.join(this.agentDir, 'inquiries.json');
    ensureDir(this.agentDir);
    this.state = readJson(this.filePath, { inquiries: [] });
  }

  persist() {
    ensureDir(this.agentDir);
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  list() {
    return this.state.inquiries;
  }

  addInquiry({ question, source, entropy, context }) {
    // Dedup layer 1: exact match
    const existing = this.state.inquiries.find(inq =>
      inq.question === question && (inq.status === 'in_progress' || inq.status === 'pending')
    );
    if (existing) {
      return existing;
    }

    // Dedup layer 2: semantic similarity — catches metabolism reformulations
    const newWords = getKeyWords(question);
    if (newWords.size >= 3) {
      const semanticMatch = this.state.inquiries.find(inq => {
        if (inq.status !== 'in_progress' && inq.status !== 'pending') return false;
        const existingWords = getKeyWords(inq.question);
        return jaccardSimilarity(newWords, existingWords) >= DEDUP_JACCARD_THRESHOLD;
      });
      if (semanticMatch) {
        return semanticMatch;
      }
    }

    // Dedup layer 3: topic-tag + concept overlap — catches rephrased questions
    // that use different vocabulary but are about the same thing.
    // e.g., "[embodiment] spatial mapping persistence" vs "[embodiment] somatic questioning persists"
    const tagMatch = question.match(/^\[([^\]]+)\]/);
    if (tagMatch) {
      const newTag = tagMatch[1].toLowerCase();
      const newLower = question.toLowerCase();
      // Extract core concept words (nouns/verbs that survive across rephrasings)
      const conceptWords = newLower.match(/\b(persist|spatial|somatic|mapping|awareness|questioning|integration|embodi|continu|session|resolut|uncert)/g) || [];
      if (conceptWords.length > 0) {
        const tagConceptMatch = this.state.inquiries.find(inq => {
          if (inq.status !== 'in_progress' && inq.status !== 'pending') return false;
          const existingTag = (inq.question.match(/^\[([^\]]+)\]/) || [])[1];
          if (!existingTag || existingTag.toLowerCase() !== newTag) return false;
          // Check if existing inquiry shares any concept word
          const existingLower = inq.question.toLowerCase();
          return conceptWords.some(cw => existingLower.includes(cw));
        });
        if (tagConceptMatch) {
          return tagConceptMatch;
        }
      }
    }

    const createdMs = Date.now();
    const id = `inq_${Math.random().toString(36).slice(2, 10)}`;
    const pass1Delay = this.passesConfig['1']?.delayMs || 0;

    const inquiry = {
      id,
      question,
      source: source || 'agent_end',
      entropy: Number.isFinite(entropy) ? entropy : 0,
      context: context || '',
      passes: [
        {
          number: 1,
          scheduled: iso(createdMs + pass1Delay),
          completed: null,
          output: null
        },
        {
          number: 2,
          scheduled: null,
          completed: null,
          output: null
        },
        {
          number: 3,
          scheduled: null,
          completed: null,
          output: null
        }
      ],
      tags: [],
      status: 'in_progress',
      created: iso(createdMs),
      persisted: false
    };

    this.state.inquiries.push(inquiry);
    this.persist();
    return inquiry;
  }

  getDuePass(nowMs = Date.now()) {
    for (const inquiry of this.state.inquiries) {
      if (inquiry.status !== 'in_progress') continue;
      for (const p of inquiry.passes) {
        if (!p.scheduled || p.completed) continue;
        if (Date.parse(p.scheduled) <= nowMs) {
          return { inquiry, passNumber: p.number };
        }
      }
    }
    return null;
  }

  completePass(inquiryId, passNumber, output) {
    const inquiry = this.state.inquiries.find(i => i.id === inquiryId);
    if (!inquiry) return null;

    const pass = inquiry.passes.find(p => p.number === passNumber);
    if (!pass) return null;

    pass.completed = new Date().toISOString();
    pass.output = output;

    const nextPassNumber = passNumber + 1;
    const nextPass = inquiry.passes.find(p => p.number === nextPassNumber);
    if (nextPass) {
      const delayMs = this.passesConfig[String(nextPassNumber)]?.delayMs || 0;
      nextPass.scheduled = new Date(Date.now() + delayMs).toISOString();
    } else {
      inquiry.status = 'completed';
      inquiry.completed = new Date().toISOString();
    }

    this.persist();
    return inquiry;
  }

  getCompletedUnpersisted() {
    return this.state.inquiries.filter(i => i.status === 'completed' && !i.persisted);
  }

  markPersisted(inquiryId) {
    const inquiry = this.state.inquiries.find(i => i.id === inquiryId);
    if (!inquiry) return false;
    inquiry.persisted = true;
    this.persist();
    return true;
  }
}

module.exports = InquiryStore;
