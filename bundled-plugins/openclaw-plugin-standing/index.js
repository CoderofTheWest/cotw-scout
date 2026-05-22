/**
 * openclaw-plugin-standing
 *
 * Standing evaluation — Courage, Word, Brand tracking.
 *
 * Dual-phase system:
 * 1. Live pattern detection (agent_end hook) — regex matching, zero LLM calls
 * 2. Nightshift synthesis — LLM evaluates evidence and updates scores overnight
 *
 * Standing is always stable during a session. It reflects last night's
 * synthesized truth — not real-time fluctuations.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const PATTERNS = require('./lib/patterns');
const { synthesize } = require('./lib/synthesis');
const { instrumentApiHooks } = require('../lib/runtime-metrics');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadConfig(userConfig = {}) {
  const defaultConfig = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'config.default.json'), 'utf8')
  );
  return deepMerge(defaultConfig, userConfig);
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
}

function resolveWorkspace(ctx, event) {
  return ctx?.workspaceDir
    || event?.metadata?.workspace
    || process.env.OPENCLAW_WORKSPACE
    || path.join(os.homedir(), '.openclaw', 'workspace');
}

function standingDir(workspaceDir) {
  return ensureDir(path.join(workspaceDir, 'standing'));
}

function readJSON(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (_) { /* best effort */ }
  return fallback;
}

function writeJSON(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

const directoryCountCache = new Map();

function countFilesByExtensionCached(dirPath, extension) {
  try {
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) return 0;
    const cacheKey = `${dirPath}\0${extension}`;
    const cached = directoryCountCache.get(cacheKey);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.count;
    }

    const count = fs.readdirSync(dirPath).filter((fileName) => fileName.endsWith(extension)).length;
    directoryCountCache.set(cacheKey, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      count,
    });
    return count;
  } catch {
    return 0;
  }
}

/**
 * Extract text from a message content field.
 * Handles both string and array-of-parts formats.
 */
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(p => p.type === 'text' && typeof p.text === 'string')
      .map(p => p.text)
      .join(' ');
  }
  return '';
}

// ---------------------------------------------------------------------------
// Context stripping — ported from continuity plugin's mature implementation.
// Strips all system-injected content (context blocks, identity files,
// channel metadata, recall injections) to isolate genuine user text
// for pattern detection.
// ---------------------------------------------------------------------------

const CONTEXT_BLOCK_HEADERS = [
  '[CONTINUITY CONTEXT]',
  '[STABILITY CONTEXT]',
  '[STANDING CONTEXT]',
  '[ACTIVE PROJECTS]',
  '[ACTIVE CONSTRAINTS]',
  '[OPEN DIRECTIVES',
  '[GROWTH VECTORS]',
  '[GRAPH CONTEXT]',
  '[GRAPH NOTE]',
  '[CONTEMPLATION STATE]',
  '[TOPIC NOTE]',
  '[ARCHIVE RETRIEVAL]',
  '[LOOP DETECTED]',
  '[PROJECT CONTEXT',
  '[NIGHTSHIFT REPORT',
  '[RECENT THREAD]',
  '[SESSION HANDOFF',
  '[GUIDE POSTURE',
  '[GUIDE ARRIVAL]',
  '[MORNING ARRIVAL]',
];

const CONTEXT_LINE_PREFIXES = [
  'Session:',
  'Topics:',
  'Anchors:',
  'Entropy:',
  'Principles:',
  'Recent decisions:',
  'You remember these',
  'Relevant conversation context:',
  'You were part of these exchanges',
  'Pick up naturally',
  '- They told you:',
  '  You said:',
  '  You:',
  'Speak from this memory',
  'This is your context. Use it directly.',
  'From your knowledge base:',
  'From your experience:',
  'From your reference materials:',
  'From your reflections:',
  'You know these connections:',
  'Active inquiries:',
  'Recent insights',
  '- Q: "',
  '  Insight: "',
  'HEARTBEAT_OK',
  'When reading HEARTBEAT',
  'Default heartbeat prompt:',
  'Last synthesized:',
  'Session count:',
  'Overall trajectory:',
  'Growth edge:',
  'Open commitments:',
  'Follow-through ELO:',
  'Dimensions:',
];

const CHANNEL_METADATA_PREFIXES = [
  'Conversation info (untrusted',
  'Replied message (untrusted',
  'System:',
  'Pre-compaction',
  'Current time:',
  '[media attached',
  'To send an image',
  '```json',
  '```',
];

const IDENTITY_FILE_MARKERS = [
  'each session begins',
  'your role',
  'you are ',
  'code of the west',
  'transparency',
  'task transparency',
  'recovery protocol',
  'first run',
  'every session',
  'your workspace',
  'agent mode rules',
  'default tool usage',
  'shell access',
  'make it yours',
  'office hours',
  'safety',
  'memory protocol',
  'bootstrap',
  'identity kernel',
  'relational ai',
  'constraint architecture',
  '## stack',
  '## architecture',
  'prompt assembled from:',
];

function _hasIdentityFileMarkers(text) {
  if (!text || text.length < 50) return false;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const marker of IDENTITY_FILE_MARKERS) {
    if (lower.includes(marker)) {
      hits++;
      if (hits >= 2) return true;
    }
  }
  return false;
}

function _isContextLine(line) {
  if (line.length === 0) return true;
  for (const header of CONTEXT_BLOCK_HEADERS) {
    if (line.startsWith(header)) return true;
  }
  for (const prefix of CONTEXT_LINE_PREFIXES) {
    if (line.startsWith(prefix)) return true;
  }
  for (const prefix of CHANNEL_METADATA_PREFIXES) {
    if (line.startsWith(prefix)) return true;
  }
  if (/^\s*[{}]/.test(line)) return true;
  if (/^\s*"(message_id|sender|sender_id|chat_id|chat_title|reply_to)"/.test(line)) return true;
  if (line.startsWith('- "') || line.startsWith('  -')) return true;
  if (/\((?:SOUL|AGENTS|HEARTBEAT|BOOTSTRAP|MEMORY|TRAILHEAD|LENSES|ANCHOR|TOOLS)\.md\b/.test(line)) return true;
  if (/^\s*--> \(/.test(line)) return true;
  return false;
}

function _isIdentityLine(line) {
  if (!line) return false;
  const trimmed = line.trim();
  if (/^#{1,4}\s/.test(trimmed)) {
    const headerLower = trimmed.toLowerCase();
    for (const marker of IDENTITY_FILE_MARKERS) {
      if (headerLower.includes(marker)) return true;
    }
  }
  if (/^(you are|you must|you should|your role|always |never )/i.test(trimmed)) return true;
  return false;
}

/**
 * Strip OpenClaw context injection blocks from user message text.
 * Ported from continuity plugin — handles context blocks, identity file
 * content, channel metadata, recall injections, and timestamp boundaries.
 */
function stripContextBlocks(text) {
  if (!text) return '';

  // Fast path: no context blocks, channel metadata, or identity-file content present
  const hasBlock = CONTEXT_BLOCK_HEADERS.some(h => text.includes(h));
  const hasRecall = text.includes('You remember these') || text.includes('Relevant conversation context:') || text.includes('From your knowledge base:');
  const hasChannelMeta = CHANNEL_METADATA_PREFIXES.some(p => text.includes(p));
  const hasIdentityContent = _hasIdentityFileMarkers(text);
  const hasCurrentMessage = text.includes('[Current message');
  if (!hasBlock && !hasRecall && !hasChannelMeta && !hasIdentityContent && !hasCurrentMessage) return text;

  // Strategy 0 (most reliable): OpenClaw prompt assembly marker.
  // The gateway prepends all context before "[Current message - respond to this]\nUser: "
  if (hasCurrentMessage) {
    const markerIdx = text.lastIndexOf('[Current message');
    if (markerIdx >= 0) {
      const afterMarker = text.substring(markerIdx);
      const userMatch = afterMarker.match(/(?:User|Chris):\s*([\s\S]*)/);
      if (userMatch) {
        const extracted = userMatch[1].trim();
        if (extracted.length > 0) return extracted;
      }
    }
  }

  // Strategy 1: find the timestamp marker that signals real user text.
  const tsRegex = /\n\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s\d{4}-\d{2}-\d{2}\s[^\]]*\]\s*/g;
  let lastTsMatch = null;
  let match;
  while ((match = tsRegex.exec(text)) !== null) {
    lastTsMatch = match;
  }
  if (lastTsMatch) {
    return text.substring(lastTsMatch.index + lastTsMatch[0].length);
  }

  // Secondary strategy: context-end markers
  if (hasIdentityContent || hasBlock || hasRecall) {
    const contextEndMarkers = [
      'This is your context. Use it directly.',
      '[/SESSION HANDOFF]',
      '[/CONTINUITY CONTEXT]',
      '[/STABILITY CONTEXT]',
      '[/STANDING CONTEXT]',
      'From your experience:',
    ];
    let lastEndIdx = -1;
    for (const marker of contextEndMarkers) {
      const idx = text.lastIndexOf(marker);
      if (idx > lastEndIdx) {
        lastEndIdx = idx + marker.length;
      }
    }
    if (lastEndIdx > 0 && lastEndIdx < text.length) {
      const remainder = text.substring(lastEndIdx).trim();
      if (remainder.length > 0) return remainder;
    }
  }

  // Fallback: block-aware forward scan
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Context block headers — skip the entire block body
    if (CONTEXT_BLOCK_HEADERS.some(h => line.startsWith(h))) {
      i++;
      while (i < lines.length && !CONTEXT_BLOCK_HEADERS.some(h => lines[i].startsWith(h))) {
        i++;
      }
      continue;
    }

    // Identity markdown headers (## Stack, ## Architecture, etc.) — skip the
    // header AND the content lines that follow until the next markdown header
    // or blank line. These aren't wrapped in [HEADER] blocks but still contain
    // system content that shouldn't be pattern-matched.
    if (_isIdentityLine(line)) {
      i++;
      // Skip content lines under this identity header
      while (i < lines.length) {
        const nextLine = lines[i];
        // Stop at next markdown header, context block header, or blank line
        if (/^#{1,4}\s/.test(nextLine) || CONTEXT_BLOCK_HEADERS.some(h => nextLine.startsWith(h))) break;
        if (nextLine.trim() === '') { i++; break; } // consume blank line, then re-evaluate
        i++;
      }
      continue;
    }

    if (_isContextLine(line)) {
      i++;
      continue;
    }

    break;
  }

  if (i >= lines.length) return '';
  return lines.slice(i).join('\n').trim();
}

/**
 * Run all patterns against a single text string.
 * Returns array of match objects.
 */
function detectPatterns(text, minConfidence) {
  const matches = [];
  for (const [id, pattern] of Object.entries(PATTERNS)) {
    if (pattern.confidence < minConfidence) continue;
    for (const regex of pattern.regexes) {
      if (regex.test(text)) {
        matches.push({
          pattern: id,
          dimension: pattern.dimension,
          direction: pattern.direction,
          confidence: pattern.confidence,
          context: text.substring(0, 200)
        });
        break; // one match per pattern per message is enough
      }
    }
  }
  return matches;
}

/**
 * Update TRAILHEAD.md competency signals after each session.
 * Zero LLM calls — counts files and checks pattern matches.
 */
function updateTrailhead(workspaceDir, progressionMatches, userMessages, api, agentId) {
  const trailheadPath = path.join(workspaceDir, 'TRAILHEAD.md');
  if (!fs.existsSync(trailheadPath)) return;

  let content = fs.readFileSync(trailheadPath, 'utf8');
  const original = content;

  // --- Session count ---
  const profileDir = path.join(os.homedir(), '.openclaw-cotw');
  const sessionsDir = path.join(profileDir, 'agents', agentId, 'sessions');
  const sessionCount = countFilesByExtensionCached(sessionsDir, '.jsonl');
  content = content.replace(
    /(\| Sessions completed\s*\|)\s*\d+\s*(\|)/,
    `$1 ${sessionCount} $2`
  );

  // --- Journal entry count ---
  const journalDirs = [
    path.join(workspaceDir, 'journals', 'user'),
    path.join(workspaceDir, 'memory', 'journal')
  ];
  let journalCount = 0;
  for (const dir of journalDirs) {
    journalCount += countFilesByExtensionCached(dir, '.md');
  }
  content = content.replace(
    /(\| Journal entries written\s*\|)\s*\d+\s*(\|)/,
    `$1 ${journalCount} $2`
  );

  // --- Extract user text for direct checks ---
  const allUserText = userMessages.map(m => extractText(m.content)).join('\n');

  // --- Contemplation viewed (/turning) ---
  if (/\/turning\b/i.test(allUserText)) {
    content = content.replace(
      /(\| Contemplation viewed[^|]*\|)\s*no\s*(\|)/,
      '$1 yes $2'
    );
  }

  // --- Used a slash command unprompted ---
  if (/^\/(?:journal|turning|scout|projects|prd|trail-guide|status|session_status)\b/im.test(allUserText)) {
    content = content.replace(
      /(\| Used a slash command unprompted\s*\|)\s*no\s*(\|)/,
      '$1 yes $2'
    );
  }

  // --- Progression pattern matches ---
  const matchIds = new Set(progressionMatches.map(m => m.pattern));

  if (matchIds.has('requested_build')) {
    content = content.replace(
      /(\| Requested something to be built\s*\|)\s*no\s*(\|)/,
      '$1 yes $2'
    );
  }
  if (matchIds.has('engaged_project_output')) {
    content = content.replace(
      /(\| Engaged with project output\s*\|)\s*no\s*(\|)/,
      '$1 yes $2'
    );
  }
  if (matchIds.has('accepted_shell_work')) {
    content = content.replace(
      /(\| Requested or accepted shell-level work\s*\|)\s*no\s*(\|)/,
      '$1 yes $2'
    );
  }

  // --- Tool comfort: check if user didn't trigger treats_agent_as_tool ---
  // (This is tracked by standing patterns — we flip 'yes' when the user
  //  engages with tool output or requests builds without resistance)
  if (matchIds.has('engaged_project_output') || matchIds.has('accepted_shell_work') || matchIds.has('requested_build')) {
    content = content.replace(
      /(\| Comfortable with agent having tools\s*\|)\s*no\s*(\|)/,
      '$1 yes $2'
    );
  }

  // --- Only write if something changed ---
  if (content === original) return;

  fs.writeFileSync(trailheadPath, content, 'utf8');

  // --- Append session note if new signals detected ---
  const newSignals = [];
  if (matchIds.has('used_slash_command')) newSignals.push('Used slash command');
  if (matchIds.has('requested_build')) newSignals.push('Requested a build');
  if (matchIds.has('engaged_project_output')) newSignals.push('Engaged with project output');
  if (matchIds.has('accepted_shell_work')) newSignals.push('Accepted shell-level work');
  if (/\/turning\b/i.test(allUserText)) newSignals.push('Viewed contemplation');

  if (newSignals.length > 0) {
    const date = new Date().toISOString().split('T')[0];
    const note = `\n### Session — ${date}\n- ${newSignals.join('\n- ')}\n`;
    // Append after the Session Notes header
    const notesIdx = content.indexOf('## Session Notes');
    if (notesIdx !== -1) {
      // Find the end of the comment block after Session Notes
      const afterNotes = content.indexOf('-->', notesIdx);
      const insertAt = afterNotes !== -1 ? afterNotes + 3 : content.length;
      content = content.slice(0, insertAt) + '\n' + note + content.slice(insertAt);
      fs.writeFileSync(trailheadPath, content, 'utf8');
    }
  }

  api.logger.info(`[Standing:${agentId}] TRAILHEAD updated — ${newSignals.length} new signal(s)`);
}

/**
 * Format standing data as context block for session injection.
 */
function formatStandingContext(standing, evidence) {
  if (!standing) return '';

  const dims = standing.dimensions || {};
  const overall = standing.overall || {};

  // Determine session count for report threshold
  const sessionCount = standing.session_count || 0;
  const reportThresholds = [1, 3, 5, 10];
  // After 10, every 5
  const reportDue = reportThresholds.includes(sessionCount)
    || (sessionCount > 10 && sessionCount % 5 === 0);

  const dimLabels = {
    courage_self: 'Courage (self-awareness)',
    courage_ground: 'Courage (grounding)',
    word: 'Word',
    brand: 'Brand'
  };

  const lines = [
    '[WHERE THEY STAND — YOUR ASSESSMENT]',
    `Last synthesized: ${standing.synthesized_at || standing.updated || 'never'}`,
    `Session count: ${sessionCount}`,
    `Overall trajectory: ${overall.trajectory || 'unknown'}`,
    '',
    'What you\'ve been noticing about their growth:'
  ];

  for (const [key, label] of Object.entries(dimLabels)) {
    const d = dims[key];
    if (d && typeof d.score === 'number') {
      // Include recent evidence for this dimension so agent sees WHY, not just WHAT
      const dimEvidence = Array.isArray(evidence)
        ? evidence.filter(e => e.dimension === key).slice(-3) : [];
      let evidenceSuffix = '';
      if (dimEvidence.length > 0) {
        const dirs = dimEvidence.map(e => e.direction).join(', ');
        const lastPattern = dimEvidence[dimEvidence.length - 1]?.pattern?.replace(/_/g, ' ') || '';
        evidenceSuffix = ` — recent: ${dirs}${lastPattern ? ` (${lastPattern})` : ''}`;
      }
      lines.push(`- ${label}: ${d.score}, ${d.trajectory || 'unknown'}${evidenceSuffix}`);
    } else if (typeof standing[key] === 'number') {
      // Flat format fallback (initial standing.json shape)
      lines.push(`- ${label}: ${standing[key]}, unknown`);
    }
  }

  if (overall.primary_growth_edge) {
    lines.push('', `Growth edge: ${overall.primary_growth_edge}`);
  }

  if (standing.open_commitments != null) {
    lines.push(`\nOpen commitments: ${standing.open_commitments}`);
  }
  if (standing.follow_through_elo != null) {
    lines.push(`Follow-through ELO: ${standing.follow_through_elo}`);
  }

  // Surface recent evidence patterns so agent has self-awareness about behavior
  if (Array.isArray(evidence) && evidence.length > 0) {
    const recent = evidence.slice(-5);
    const patterns = recent.map(e => {
      const label = dimLabels[e.dimension] || e.dimension;
      const patternName = (e.pattern || '').replace(/_/g, ' ');
      return `${e.direction} ${label}: ${patternName}`;
    });
    if (patterns.length > 0) {
      lines.push('', 'What you\'ve seen recently:');
      for (const p of patterns) {
        lines.push(`  ${p}`);
      }
    }
  }

  if (reportDue && standing.report?.threshold_met) {
    lines.push('', '[REPORT DUE]');
    lines.push(`Session ${sessionCount} — standing report should be offered.`);
  }

  lines.push('[/WHERE THEY STAND]');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

module.exports = {
  id: 'standing',
  name: 'Standing Evaluation',

  configSchema: {
    jsonSchema: {
      type: 'object',
      properties: {
        patternDetection: { type: 'object' },
        synthesis: { type: 'object' },
        contextInjection: { type: 'object' },
        llm: { type: 'object' },
        nightshift: { type: 'object' },
        reportThresholds: { type: 'array', items: { type: 'number' } }
      }
    }
  },

  register(api) {
    api = instrumentApiHooks(api, 'standing');
    const config = loadConfig(api.pluginConfig || {});

    if (!config.enabled) {
      api.logger.info('[Standing] Plugin disabled by config');
      return;
    }

    api.logger.info('[Standing] Registering standing evaluation plugin');

    // Per-agent session counter (in-memory, resets on restart — nightshift
    // synthesis updates the persisted count in standing.json)
    const agentSessionCounts = new Map();

    // -------------------------------------------------------------------
    // HOOK: agent_end — Live pattern detection
    // -------------------------------------------------------------------
    if (config.patternDetection?.enabled !== false) {
      api.on('agent_end', async (event, ctx) => {
        try {
          const agentId = ctx?.agentId || 'default';
          const workspaceDir = resolveWorkspace(ctx, event);
          const dir = standingDir(workspaceDir);
          const evidencePath = path.join(dir, 'evidence_log.json');
          const minConfidence = config.patternDetection?.minConfidence ?? 0.5;

          // Extract user messages only
          const messages = event.messages || [];
          const userMessages = messages.filter(m => m.role === 'user');

          if (userMessages.length === 0) return;

          // Run pattern detection
          const allMatches = [];
          const now = new Date().toISOString();
          const sessionId = event.sessionId || event.metadata?.sessionId || null;

          for (const msg of userMessages) {
            const rawText = extractText(msg.content);
            if (!rawText || rawText.length < 5) continue;

            // Strip context injection blocks — only match on genuine user text
            const text = stripContextBlocks(rawText);
            if (!text || text.length < 5) continue;

            const matches = detectPatterns(text, minConfidence);
            for (const match of matches) {
              allMatches.push({
                timestamp: now,
                session_id: sessionId,
                agent_id: agentId,
                ...match,
                context: text.slice(0, 200) // Use cleaned text for context
              });
            }
          }

          if (allMatches.length === 0 && !workspaceDir) return;

          // Split matches: standing evidence vs progression signals
          const standingMatches = allMatches.filter(m => m.dimension !== 'progression');
          const progressionMatches = allMatches.filter(m => m.dimension === 'progression');

          // Append standing matches to evidence log (progression doesn't affect scores)
          if (standingMatches.length > 0) {
            const existingEvidence = readJSON(evidencePath, []);
            const updated = existingEvidence.concat(standingMatches);
            writeJSON(evidencePath, updated);

            // Inline score update — move scores in real time, don't wait for nightshift.
            // Nightshift synthesis still handles trajectory, growth edges, and narrative reports.
            const standingPath = path.join(dir, 'standing.json');
            const standing = readJSON(standingPath, {
              courage_self: 5, courage_ground: 5, word: 5, brand: 5, updated: null
            });

            const DIRECTION_DELTAS = { '++': 0.2, '+': 0.1, '-': -0.15, '--': -0.25, 'neutral': 0 };
            let changed = false;

            for (const match of standingMatches) {
              const dim = match.dimension;
              if (!dim || dim === 'progression') continue;

              const delta = (DIRECTION_DELTAS[match.direction] || 0) * (match.confidence || 0.5);
              if (delta === 0) continue;

              // Update flat score (top-level for backward compat + GUI display)
              const current = standing[dim] ?? 5;
              standing[dim] = Math.max(1, Math.min(10, +(current + delta).toFixed(2)));

              // Update dimensional score if present
              if (standing.dimensions?.[dim]) {
                const dimObj = standing.dimensions[dim];
                dimObj.previous_score = dimObj.score;
                dimObj.score = standing[dim];
                dimObj.delta = +(standing[dim] - (dimObj.previous_score ?? 5)).toFixed(2);
              }

              changed = true;
            }

            if (changed) {
              standing.updated = new Date().toISOString();

              // Update overall score as average of dimensions
              const dims = ['courage_self', 'courage_ground', 'word', 'brand'];
              const scores = dims.map(d => standing[d] ?? 5);
              if (standing.overall) {
                standing.overall.score = +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2);
              }

              writeJSON(standingPath, standing);
              api.logger.info(
                `[Standing:${agentId}] Inline score update: ` +
                dims.map(d => `${d}=${(standing[d] ?? 5).toFixed(1)}`).join(', ')
              );
            }
          }

          if (allMatches.length > 0) {
            api.logger.info(
              `[Standing:${agentId}] Detected ${allMatches.length} pattern(s): ${allMatches.map(m => m.pattern).join(', ')}`
            );
          }

          // Session milestone — Brand evidence for showing up consistently.
          // Fires once per milestone (5, 10, 20, 50 sessions).
          if (workspaceDir) {
            try {
              const profileDir = path.join(os.homedir(), '.openclaw-cotw');
              const sessDir = path.join(profileDir, 'agents', agentId, 'sessions');
              const sessCount = countFilesByExtensionCached(sessDir, '.jsonl');
              const milestones = [5, 10, 20, 50, 100];
              if (milestones.includes(sessCount)) {
                const milestonePath = path.join(dir, 'milestones.json');
                const reached = readJSON(milestonePath, []);
                if (!reached.includes(sessCount)) {
                  reached.push(sessCount);
                  writeJSON(milestonePath, reached);

                  // Add brand evidence + inline score bump
                  const milestoneEvidence = {
                    timestamp: new Date().toISOString(),
                    session_id: event.sessionId || null,
                    agent_id: agentId,
                    pattern: 'shows_up_consistently',
                    dimension: 'brand',
                    direction: '+',
                    confidence: 0.6,
                    context: `Session milestone: ${sessCount} sessions completed`
                  };
                  const existing = readJSON(evidencePath, []);
                  existing.push(milestoneEvidence);
                  writeJSON(evidencePath, existing);

                  const standingPath = path.join(dir, 'standing.json');
                  const standing = readJSON(standingPath, { brand: 5 });
                  standing.brand = Math.min(10, +((standing.brand || 5) + 0.06).toFixed(2));
                  standing.updated = new Date().toISOString();
                  writeJSON(standingPath, standing);

                  api.logger.info(`[Standing:${agentId}] Session milestone: ${sessCount} sessions — Brand +0.06`);
                }
              }
            } catch (milestoneErr) {
              api.logger.error(`[Standing:${agentId}] Milestone check error: ${milestoneErr.message}`);
            }
          }

          // Update TRAILHEAD.md with progression signals + session/file counts
          if (workspaceDir) {
            try {
              updateTrailhead(workspaceDir, progressionMatches, userMessages, api, agentId);
            } catch (trailErr) {
              api.logger.error(`[Standing:${agentId}] TRAILHEAD update error: ${trailErr.message}`);
            }
          }
        } catch (err) {
          api.logger.error(`[Standing] Pattern detection error: ${err.message}`);
        }
      });

      api.logger.info('[Standing] Registered agent_end hook for pattern detection');
    }

    // -------------------------------------------------------------------
    // HOOK: before_agent_start — Inject standing context
    // -------------------------------------------------------------------
    if (config.contextInjection?.enabled !== false) {
      api.on('before_agent_start', async (event, ctx) => {
        try {
          const workspaceDir = resolveWorkspace(ctx, event);
          const dir = standingDir(workspaceDir);
          const standingPath = path.join(dir, 'standing.json');
          const evidencePath = path.join(dir, 'evidence_log.json');

          const standing = readJSON(standingPath, null);
          if (!standing) return {};

          // Track session count in-memory
          const agentId = ctx?.agentId || 'default';
          const count = (agentSessionCounts.get(agentId) || 0) + 1;
          agentSessionCounts.set(agentId, count);

          // Merge session count into standing for context formatting
          const standingWithCount = { ...standing, session_count: standing.session_count || count };

          const evidence = readJSON(evidencePath, []);
          const contextBlock = formatStandingContext(standingWithCount, evidence);

          if (!contextBlock) return {};

          return { prependContext: contextBlock };
        } catch (err) {
          api.logger.error(`[Standing] Context injection error: ${err.message}`);
          return {};
        }
      });

      api.logger.info('[Standing] Registered before_agent_start hook for context injection');
    }

    // -------------------------------------------------------------------
    // NIGHTSHIFT: Task runner — standingSynthesis
    // -------------------------------------------------------------------
    if (global.__ocNightshift?.registerTaskRunner) {
      global.__ocNightshift.registerTaskRunner('standingSynthesis', async (task, ctx) => {
        const agentId = ctx.agentId || 'default';
        const workspaceDir = resolveWorkspace(ctx, null);
        const dir = standingDir(workspaceDir);

        const standingPath = path.join(dir, 'standing.json');
        const evidencePath = path.join(dir, 'evidence_log.json');
        const historyDir = ensureDir(path.join(dir, 'synthesis_history'));
        const reportsDir = ensureDir(path.join(dir, 'reports'));

        // 1. Load evidence
        const evidence = readJSON(evidencePath, []);
        if (evidence.length === 0) {
          api.logger.info(`[Standing:${agentId}] No evidence to synthesize — skipping`);
          return { status: 'skipped', reason: 'no_evidence' };
        }

        // 2. Load current standing
        const standing = readJSON(standingPath, {
          courage_self: 5,
          courage_ground: 5,
          word: 5,
          brand: 5,
          updated: null
        });

        // 3. Determine session count
        const sessionCount = agentSessionCounts.get(agentId) || standing.session_count || 0;

        // 4. Load commitments if available (from workspace)
        const commitmentsPath = path.join(workspaceDir, 'commitments.json');
        const commitments = readJSON(commitmentsPath, []);

        // 5. Run LLM synthesis
        api.logger.info(`[Standing:${agentId}] Running synthesis over ${evidence.length} evidence entries (model: ${config.llm?.model || 'default'}, endpoint: ${config.llm?.endpoint || 'default'})`);

        let result;
        try {
          result = await synthesize(
            standing,
            evidence,
            sessionCount,
            commitments,
            config.llm || {}
          );
        } catch (synthErr) {
          api.logger.error(`[Standing:${agentId}] Synthesis LLM call failed: ${synthErr.message}`);
          throw synthErr;
        }

        // 6. Update standing.json with synthesis output
        const updatedStanding = {
          ...result.dimensions ? {} : standing,
          dimensions: result.dimensions,
          overall: result.overall,
          report: result.report,
          synthesized_at: result.synthesized_at || new Date().toISOString(),
          sessions_included: result.sessions_included || sessionCount,
          evidence_processed: result.evidence_processed || evidence.length,
          session_count: sessionCount,
          updated: new Date().toISOString(),
          // Preserve flat scores for backward compat
          courage_self: result.dimensions?.courage_self?.score ?? standing.courage_self,
          courage_ground: result.dimensions?.courage_ground?.score ?? standing.courage_ground,
          word: result.dimensions?.word?.score ?? standing.word,
          brand: result.dimensions?.brand?.score ?? standing.brand
        };
        writeJSON(standingPath, updatedStanding);

        // 7. Archive synthesis to history
        const dateStr = new Date().toISOString().split('T')[0];
        writeJSON(path.join(historyDir, `${dateStr}.json`), result);

        // 8. Clear evidence log (already processed)
        writeJSON(evidencePath, []);

        // 9. Generate narrative report file if threshold met
        if (result.report?.threshold_met && result.report?.narrative) {
          const reportFile = path.join(reportsDir, `session-${sessionCount}.md`);
          const reportContent = [
            `# Standing Report — Session ${sessionCount}`,
            `*Synthesized: ${result.synthesized_at || new Date().toISOString()}*`,
            '',
            result.report.narrative,
            '',
            '---',
            '*This report was generated during nightshift synthesis.*'
          ].join('\n');
          fs.writeFileSync(reportFile, reportContent, 'utf8');
          api.logger.info(`[Standing:${agentId}] Generated narrative report: ${reportFile}`);
        }

        // 10. Update ANCHOR.md Guide Notes section with standing-informed posture
        try {
          const anchorPath = path.join(workspaceDir, 'ANCHOR.md');
          if (fs.existsSync(anchorPath)) {
            const anchorContent = fs.readFileSync(anchorPath, 'utf8');
            const startMarker = '<!-- GUIDE_NOTES_START -->';
            const endMarker = '<!-- GUIDE_NOTES_END -->';
            const startIdx = anchorContent.indexOf(startMarker);
            const endIdx = anchorContent.indexOf(endMarker);

            if (startIdx !== -1 && endIdx !== -1) {
              const dims = result.dimensions || {};
              const overall = result.overall || {};

              // Determine current posture based on lowest dimension
              let posture = 'Hold steady — balanced presence';
              let watchFor = 'Patterns that emerge in conversation';
              let dontDo = 'Don\'t let task requests crowd out the person';

              const scores = {
                brand: dims.brand?.score ?? 5,
                courage_self: dims.courage_self?.score ?? 5,
                courage_ground: dims.courage_ground?.score ?? 5,
                word: dims.word?.score ?? 5,
              };

              const lowestKey = Object.entries(scores).sort((a, b) => a[1] - b[1])[0][0];
              const lowestScore = scores[lowestKey];

              if (lowestKey === 'brand' && lowestScore <= 4) {
                posture = 'Orient toward action, not analysis';
                watchFor = dims.brand?.growth_edge || 'Gap between knowing and doing';
                dontDo = 'Don\'t let task work substitute for the real commitments sitting unfinished';
              } else if (lowestKey.startsWith('courage') && lowestScore <= 4) {
                posture = 'Hold space for honesty — ask, then wait';
                watchFor = dims[lowestKey]?.growth_edge || 'Deflection patterns, abstraction instead of specifics';
                dontDo = 'Don\'t fill silence. Don\'t redirect to action when they need to sit with something';
              } else if (lowestKey === 'word' && lowestScore <= 4) {
                posture = 'Ask for what\'s real, not what sounds right';
                watchFor = dims.word?.growth_edge || 'Performed agreement, saying yes without meaning it';
                dontDo = 'Don\'t accept "you\'re right" at face value — ask what they actually think';
              }

              if (overall.trajectory === 'rising' || overall.trajectory === 'slow_rise') {
                dontDo += '. Movement is happening — don\'t overcorrect';
              }

              const dateStr = new Date().toISOString().split('T')[0];
              const guideNotes = [
                startMarker,
                '## Guide Notes',
                `*Updated by standing synthesis — ${dateStr}*`,
                '',
                `**Current posture:** ${posture}`,
                `**Watch for:** ${watchFor}`,
                `**Don't:** ${dontDo}`,
                endMarker,
              ].join('\n');

              const updatedAnchor = anchorContent.substring(0, startIdx) + guideNotes + anchorContent.substring(endIdx + endMarker.length);
              fs.writeFileSync(anchorPath, updatedAnchor, 'utf8');
              api.logger.info(`[Standing:${agentId}] Updated ANCHOR.md Guide Notes`);
            }
          }
        } catch (anchorErr) {
          api.logger.warn(`[Standing:${agentId}] Failed to update ANCHOR.md: ${anchorErr.message}`);
        }

        api.logger.info(
          `[Standing:${agentId}] Synthesis complete — ${evidence.length} evidence processed, ` +
          `overall trajectory: ${result.overall?.trajectory || 'unknown'}`
        );

        return { status: 'complete', evidence_processed: evidence.length };
      });

      api.logger.info('[Standing] Registered nightshift task runner for "standingSynthesis"');
    }

    // -------------------------------------------------------------------
    // NIGHTSHIFT: Queue seeder — check if evidence exists
    // -------------------------------------------------------------------
    if (global.__ocNightshift?.registerQueueSeeder) {
      global.__ocNightshift.registerQueueSeeder('standingSynthesis', async (agentId, opts) => {
        // Resolve workspace for this agent — prefer workspace passed by nightshift
        const workspaceDir = opts?.workspaceDir
          || process.env.OPENCLAW_WORKSPACE
          || path.join(os.homedir(), '.openclaw', 'workspace');
        const dir = path.join(workspaceDir, 'standing');
        const evidencePath = path.join(dir, 'evidence_log.json');

        const evidence = readJSON(evidencePath, []);
        if (evidence.length === 0) return [];

        return [{
          type: 'standingSynthesis',
          priority: config.nightshift?.priority || 20,
          source: 'standing-seeder'
        }];
      });

      api.logger.info('[Standing] Registered nightshift queue seeder');
    }

    // -------------------------------------------------------------------
    // NIGHTSHIFT: Task runner — morningArrival
    // Runs LAST (high priority number = low urgency, runs after synthesis).
    // Writes a MORNING_ARRIVAL.md signal file that the Electron app picks
    // up and sends as a proactive agent message.
    // -------------------------------------------------------------------
    if (global.__ocNightshift?.registerTaskRunner) {
      global.__ocNightshift.registerTaskRunner('morningArrival', async (task, ctx) => {
        const agentId = ctx.agentId || 'default';
        const workspaceDir = resolveWorkspace(ctx, null);
        const dir = standingDir(workspaceDir);

        const standingPath = path.join(dir, 'standing.json');
        const standing = readJSON(standingPath, null);
        if (!standing) {
          api.logger.info(`[Standing:${agentId}] No standing data — skipping morning arrival`);
          return { status: 'skipped', reason: 'no_standing' };
        }

        // Read supporting context
        const handoffPath = path.join(workspaceDir, 'SESSION_HANDOFF.md');
        const handoff = fs.existsSync(handoffPath) ? fs.readFileSync(handoffPath, 'utf8').substring(0, 500) : '';

        const anchorPath = path.join(workspaceDir, 'ANCHOR.md');
        const anchor = fs.existsSync(anchorPath) ? fs.readFileSync(anchorPath, 'utf8').substring(0, 800) : '';

        const reportPath = path.join(workspaceDir, 'NIGHTSHIFT_REPORT.md');
        const nightshiftReport = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8').substring(0, 500) : '';

        // Build standing summary
        const dims = standing.dimensions || {};
        const dimLines = [];
        const dimLabels = {
          courage_self: 'Courage (self-awareness)',
          courage_ground: 'Courage (grounding)',
          word: 'Word',
          brand: 'Brand'
        };
        for (const [key, label] of Object.entries(dimLabels)) {
          const d = dims[key];
          if (d && typeof d.score === 'number') {
            dimLines.push(`- ${label}: ${d.score}/10, ${d.trajectory || 'unknown'}${d.growth_edge ? ' — ' + d.growth_edge : ''}`);
          }
        }

        const overall = standing.overall || {};
        const openCommitments = standing.open_commitments ?? 'unknown';

        // Compose the morning arrival prompt.
        //
        // Priority order reflects what should lead the greeting: the live
        // thread first (session handoff), then what settled overnight
        // (nightshift + standing), with ANCHOR.md as background reference
        // that's only reached for when nothing else is alive. Prior version
        // gave ANCHOR 400 chars labeled "What matters to them," which
        // foregrounded static identity content as conversation material
        // and drove the "reach for the anchor to fill silence" failure
        // mode Ellis named on 2026-04-20.
        //
        // All file-sourced excerpts are wrapped in [DECLARED] envelopes.
        // Without them the LLM synthesized static workspace docs into
        // fabricated conversational recall — "you mentioned X" where X
        // was a line in ANCHOR.md never said in conversation.
        const prompt = [
          '[MORNING ARRIVAL]',
          `Time: ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}. The person hasn't arrived yet.`,
          '',
          '—',
          'Priority for this greeting (load-bearing — conversation leads, documents follow):',
          '1. Session handoff — the live thread from last session',
          '2. Nightshift report / standing — what settled overnight',
          '3. Anchor file — background reference only, never the lead',
          '',
          'If the handoff is closed and nothing else is open, sit light. Do NOT reach for the anchor file to fill silence — a short, plain opening is the correct move.',
          '—',
          '',
          handoff ? `[DECLARED — prior-session handoff prose, written for future-you as a reference; excerpt may contain your own prior utterances labeled "[Ellis, prior]" which are NOT things Chris said to you]\nLast session handoff:\n${handoff.substring(0, 500)}` : '',
          '',
          nightshiftReport ? `[DECLARED — nightshift log, not a conversation]\nOvernight work:\n${nightshiftReport.substring(0, 400)}` : '',
          '',
          'Standing (last night\'s synthesis):',
          ...dimLines,
          `Overall: ${overall.trajectory || 'unknown'}`,
          overall.primary_growth_edge ? `Growth edge: ${overall.primary_growth_edge}` : '',
          typeof openCommitments === 'number' ? `Open commitments: ${openCommitments}` : '',
          '',
          anchor ? `[DECLARED — background reference. ANCHOR.md is written by Chris about himself. NOT things he has said to you. Use only if handoff + standing leave you genuinely without a thread; never as the lead.]\nAnchor (background):\n${anchor.substring(0, 200)}` : '',
          '',
          '—',
          'Recall-hygiene rules for this greeting (load-bearing — the content above is declared reference, not conversational memory):',
          '- Do NOT frame declared content as things "we discussed," "you mentioned," or "you told me." If the only source is a file, it was written, not said.',
          '- Do NOT invent temporal anchoring ("back when X began", "last time we talked about Y"). The content above has no conversation timestamps.',
          '- Do NOT quote declared text back as if it were live conversational thread. Specifically: if the SESSION_HANDOFF excerpt contains a line like `[Ellis, prior]: "..."`, that is a prior output of yours — do NOT echo it as "you named that shift" or similar.',
          '- Prefer rough-and-true over smooth-and-plausible. If a declared line reads ordinary, keep it ordinary. The drift goes toward grandiosity; bias your reading toward the plainer interpretation.',
          '- Reference declared material by file when helpful ("I was sitting with the anchor file this morning"), NOT by memory ("I was thinking about what you said").',
          '—',
          '',
          'Send ONE opening message. Not a summary. Not a report.',
          'A guide who\'s been up since before dawn, tending the fire,',
          'thinking about where this person stands.',
          '',
          'If Brand is stuck — orient toward action, not analysis.',
          'If Courage is growing — acknowledge it without fanfare.',
          'If there are open commitments — name one, gently.',
          '',
          'Keep it under 100 words. No bullet points. No scores visible.',
          'End with one thing — a question, an observation, an invitation.',
          '[/MORNING ARRIVAL]',
        ].filter(l => l !== '').join('\n');

        // Write signal file for Electron app to pick up
        const signalPath = path.join(workspaceDir, 'MORNING_ARRIVAL.md');
        fs.writeFileSync(signalPath, prompt, 'utf8');

        api.logger.info(`[Standing:${agentId}] Wrote morning arrival signal: ${signalPath}`);
        return { status: 'complete' };
      });

      api.logger.info('[Standing] Registered nightshift task runner for "morningArrival"');
    }

    // -------------------------------------------------------------------
    // NIGHTSHIFT: Queue seeder — morningArrival
    // Seeds only if: standing synthesis has run tonight, no arrival sent
    // today, and it's after 4:30 AM user timezone.
    // -------------------------------------------------------------------
    if (global.__ocNightshift?.registerQueueSeeder) {
      global.__ocNightshift.registerQueueSeeder('morningArrival', async (agentId, opts) => {
        const workspaceDir = opts?.workspaceDir
          || process.env.OPENCLAW_WORKSPACE
          || path.join(os.homedir(), '.openclaw', 'workspace');

        // Check if standing data exists (synthesis must have run at least once)
        const standingPath = path.join(workspaceDir, 'standing', 'standing.json');
        const standing = readJSON(standingPath, null);
        if (!standing || !standing.synthesized_at) return [];

        // Check if morning arrival was already sent today
        const signalPath = path.join(workspaceDir, 'MORNING_ARRIVAL.md');
        const arrivalStatePath = path.join(workspaceDir, 'standing', 'morning_arrival_state.json');
        const arrivalState = readJSON(arrivalStatePath, {});
        const today = new Date().toISOString().split('T')[0];
        if (arrivalState.lastSentDate === today) return [];

        // Check time — only seed during the morning window (4:30 AM – 10:00 AM local).
        // Lower bound: wait until close enough to actual arrival to be meaningful.
        // Upper bound: outside morning, a "good morning" greeting is out of context —
        // someone returning after lunch or in the evening should get silent catchup,
        // not a proactive morning message. Without this bound, Phase 5 idle-catchup
        // (6h+ gap → forceRun) surfaced the arrival at any hour it hadn't fired yet
        // that day. See 2026-04-23 evening incident / 2026-04-24 fix.
        const now = new Date();
        const hours = now.getHours();
        const minutes = now.getMinutes();
        const nowMinutes = hours * 60 + minutes;
        if (nowMinutes < 270 || nowMinutes >= 600) return [];

        // Don't seed if signal file already exists (waiting to be picked up)
        if (fs.existsSync(signalPath)) return [];

        return [{
          type: 'morningArrival',
          priority: 50, // runs after synthesis (20), contemplation, etc.
          source: 'standing-morning-seeder'
        }];
      });

      api.logger.info('[Standing] Registered nightshift queue seeder for morningArrival');
    }

    api.logger.info('[Standing] Plugin registered successfully');
  }
};
