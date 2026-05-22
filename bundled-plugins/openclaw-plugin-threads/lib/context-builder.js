/**
 * Build context injection blocks from parsed PROJECTS.md and DECISIONS.md data.
 */

function buildContext(projects, decisions, config) {
  const lines = [];
  const constraintDays = (config && config.constraintWindowDays) || 30;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - constraintDays);

  // ── Active Projects ──
  if (projects && projects.projects.length > 0) {
    const active = projects.projects.filter(p =>
      !p.status.toLowerCase().includes('complete') &&
      !p.status.toLowerCase().includes('archived')
    );

    if (active.length > 0) {
      lines.push('[ACTIVE PROJECTS]');
      lines.push(`You have ${active.length} active project${active.length > 1 ? 's' : ''}:`);
      lines.push('');
      for (let i = 0; i < active.length; i++) {
        const p = active[i];
        const since = p.started ? ` Since ${p.started}.` : '';
        lines.push(`${i + 1}. **${p.title}** (${p.status}) — ${p.goal || p.details}${since}`);
      }
      lines.push('');
    }
  }

  // ── Active Constraints from DECISIONS.md ──
  if (decisions && decisions.decisions.length > 0) {
    const constraints = decisions.decisions.filter(d =>
      d.type === 'constraint' &&
      d.status === 'active' &&
      new Date(d.date) >= cutoff
    );

    if (constraints.length > 0) {
      lines.push('[ACTIVE CONSTRAINTS]');
      lines.push('These decisions must be respected:');
      for (const c of constraints) {
        lines.push(`- ${c.project}: ${c.decision} (${c.who}, ${c.date})`);
      }
      lines.push('');
    }
  }

  // ── Open Directives from Chris ──
  if (projects && projects.directives.length > 0) {
    const open = projects.directives.filter(d =>
      d.status === 'active' || d.status === 'concept' || d.status === 'open'
    );

    if (open.length > 0) {
      lines.push('[OPEN DIRECTIVES FROM CHRIS]');
      for (const d of open) {
        lines.push(`- ${d.directive} (${d.status}, ${d.added})`);
      }
      lines.push('');
    }
  }

  return lines.length > 0 ? lines.join('\n') : '';
}

/**
 * Build a pulse message for WhatsApp/Telegram delivery.
 * Short, scannable, no JSON.
 */
function buildPulse(projects, decisions) {
  const today = new Date().toLocaleDateString('en-US', {
    month: 'short', day: 'numeric'
  });
  const lines = [`Project Pulse — ${today}`, ''];

  if (projects) {
    const active = projects.projects.filter(p =>
      !p.status.toLowerCase().includes('complete') &&
      !p.status.toLowerCase().includes('archived')
    );

    if (active.length > 0) {
      lines.push('Active:');
      for (const p of active) {
        lines.push(`• ${p.title} — ${p.status}`);
      }
    }

    const openDirectives = projects.directives.filter(d =>
      d.status === 'active' || d.status === 'open'
    );
    if (openDirectives.length > 0) {
      lines.push('');
      lines.push(`Open directives: ${openDirectives.length}`);
    }
  }

  if (decisions) {
    const activeConstraints = decisions.decisions.filter(d =>
      d.type === 'constraint' && d.status === 'active'
    );
    if (activeConstraints.length > 0) {
      lines.push(`Active constraints: ${activeConstraints.length}`);
    }
  }

  return lines.join('\n');
}

module.exports = { buildContext, buildPulse };
