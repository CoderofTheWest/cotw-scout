const fs = require('fs');

/**
 * Parse a PROJECTS.md file into structured sections.
 *
 * Expected sections:
 *   ## Current Projects    — ### sub-headings with **Key:** value pairs
 *   ## Open Directives     — markdown table (Directive | Status | Added | Context)
 *   ## Completed Projects  — ### sub-headings with summary bullets
 *   ## Future Ideas        — bullet list
 */
function parseProjectsFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  const sections = splitSections(raw);

  return {
    projects:   parseProjects(sections['current projects'] || ''),
    directives: parseDirectivesTable(sections['open directives from chris'] || sections['open directives'] || ''),
    completed:  parseCompleted(sections['completed projects'] || ''),
    futureIdeas: parseBullets(sections['future ideas'] || '')
  };
}

/**
 * Parse a DECISIONS.md file into structured entries.
 *
 * Each decision is a ### heading followed by **Key:** value lines.
 */
function parseDecisionsFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  const decisions = [];

  // Split into date-grouped sections (## YYYY-MM-DD)
  const dateBlocks = raw.split(/^## \d{4}-\d{2}-\d{2}/m);
  const dateHeaders = raw.match(/^## (\d{4}-\d{2}-\d{2})/gm) || [];

  for (let i = 0; i < dateHeaders.length; i++) {
    const date = dateHeaders[i].replace('## ', '');
    const block = dateBlocks[i + 1] || '';

    // Split into individual decisions (### Title)
    const entries = block.split(/^### /m).filter(s => s.trim());
    for (const entry of entries) {
      const lines = entry.split('\n');
      const title = lines[0].trim();
      const fields = {};

      for (const line of lines.slice(1)) {
        const m = line.match(/^\*\*(\w[\w\s]*?):\*\*\s*(.+)/);
        if (m) {
          fields[m[1].toLowerCase().trim()] = m[2].trim();
        }
      }

      if (title && fields.decision) {
        const typeRaw = (fields.type || '').toLowerCase();
        decisions.push({
          date,
          title,
          who:        fields.who || 'unknown',
          type:       typeRaw.includes('constraint') ? 'constraint' : 'decision',
          project:    fields.project || '',
          decision:   fields.decision,
          status:     (fields.status || 'active').toLowerCase()
        });
      }
    }
  }

  return { decisions };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function splitSections(md) {
  const sections = {};
  let current = '_preamble';
  const lines = md.split('\n');

  for (const line of lines) {
    const h2 = line.match(/^## (.+)/);
    if (h2) {
      current = h2[1].trim().toLowerCase();
      sections[current] = '';
    } else if (current) {
      sections[current] = (sections[current] || '') + line + '\n';
    }
  }
  return sections;
}

function parseProjects(block) {
  const projects = [];
  const chunks = block.split(/^### /m).filter(s => s.trim());

  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    const title = lines[0].trim();
    const fields = {};

    for (const line of lines.slice(1)) {
      const m = line.match(/^- \*\*(\w[\w\s]*?):\*\*\s*(.+)/);
      if (m) fields[m[1].toLowerCase().trim()] = m[2].trim();
    }

    if (title) {
      projects.push({
        title,
        status:  fields.status || 'active',
        goal:    fields.goal || '',
        details: fields.details || '',
        started: fields.started || ''
      });
    }
  }
  return projects;
}

function parseDirectivesTable(block) {
  const directives = [];
  const lines = block.split('\n');

  for (const line of lines) {
    // Skip header row and separator row
    if (line.startsWith('| Directive') || line.startsWith('|---')) continue;
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length >= 4) {
      directives.push({
        directive: cells[0],
        status:    cells[1].toLowerCase(),
        added:     cells[2],
        context:   cells[3]
      });
    }
  }
  return directives;
}

function parseCompleted(block) {
  const completed = [];
  const chunks = block.split(/^### /m).filter(s => s.trim());

  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    const titleLine = lines[0].trim();
    const titleMatch = titleLine.match(/^(.+?)\s*\((\d{4}-\d{2}-\d{2})\)/);
    const bullets = lines.slice(1)
      .filter(l => l.trim().startsWith('-'))
      .map(l => l.trim().replace(/^-\s*/, ''));

    completed.push({
      title:   titleMatch ? titleMatch[1].trim() : titleLine,
      date:    titleMatch ? titleMatch[2] : '',
      summary: bullets.join('; ')
    });
  }
  return completed;
}

function parseBullets(block) {
  return block.split('\n')
    .filter(l => l.trim().startsWith('-'))
    .map(l => l.trim().replace(/^-\s*/, ''));
}

module.exports = { parseProjectsFile, parseDecisionsFile };
