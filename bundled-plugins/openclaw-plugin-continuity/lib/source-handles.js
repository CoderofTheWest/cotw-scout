/**
 * Source handle primitives for Build 2 of the COTW Continuity Spine.
 *
 * Standalone and dependency-free except Node's built-in crypto module.
 * This module only defines/validates compact provenance handles; it does not
 * touch OpenClaw runtime or the live continuity plugin.
 */

const crypto = require('crypto');

const SOURCE_HANDLE_TYPES = Object.freeze({
  TRANSCRIPT: 'transcript',
  ARCHIVE: 'archive',
  HANDOFF: 'handoff',
  DIGEST: 'digest',
  FILE: 'file',
  TOOL: 'tool',
  WIKI: 'wiki',
  COMMIT: 'commit'
});

const SOURCE_ROLES = Object.freeze({
  EVIDENCE: 'evidence',
  ORIGIN: 'origin',
  VERIFICATION: 'verification',
  SUPERSEDES: 'supersedes',
  SUPPORTS: 'supports'
});

const ROLE_VALUES = new Set(Object.values(SOURCE_ROLES));
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function makeSourceHandle(type, input = {}) {
  switch (type) {
    case SOURCE_HANDLE_TYPES.TRANSCRIPT:
      return `transcript:${required(input.sessionId, 'sessionId')}#m${required(input.messageIndex, 'messageIndex')}`;
    case SOURCE_HANDLE_TYPES.ARCHIVE:
      return `archive:${required(input.date, 'date')}:${required(input.agentId, 'agentId')}:${required(input.threadId, 'threadId')}#e${required(input.exchangeId, 'exchangeId')}`;
    case SOURCE_HANDLE_TYPES.HANDOFF:
      return `handoff:${required(input.date, 'date')}:${required(input.threadId, 'threadId')}#L${required(input.startLine, 'startLine')}-L${required(input.endLine, 'endLine')}`;
    case SOURCE_HANDLE_TYPES.DIGEST:
      return `digest:${required(input.threadId, 'threadId')}#v${required(input.version, 'version')}:${required(input.field, 'field')}`;
    case SOURCE_HANDLE_TYPES.FILE:
      return `file:${required(input.path, 'path')}#L${required(input.startLine, 'startLine')}-L${required(input.endLine, 'endLine')}`;
    case SOURCE_HANDLE_TYPES.TOOL:
      return `tool:${required(input.sessionId, 'sessionId')}#call${required(input.callIndex, 'callIndex')}`;
    case SOURCE_HANDLE_TYPES.WIKI:
      return `wiki:${required(input.pageId, 'pageId')}#claim${required(input.claimId, 'claimId')}`;
    case SOURCE_HANDLE_TYPES.COMMIT:
      return `commit:${required(input.sha, 'sha')}#${required(input.path, 'path')}`;
    default:
      throw new Error(`Unsupported source handle type: ${type}`);
  }
}

function parseSourceHandle(handle) {
  const value = String(handle || '').trim();
  if (!value) return { ok: false, errors: ['handle is empty'], handle: value };

  const [prefix, rest] = splitOnce(value, ':');
  const parsed = { ok: true, type: prefix, handle: value, metadata: {} };
  const errors = [];

  switch (prefix) {
    case SOURCE_HANDLE_TYPES.TRANSCRIPT: {
      const match = rest.match(/^(.+)#m(\d+)$/);
      if (!match) errors.push('transcript handle must match transcript:<session_id>#m<message_index>');
      else Object.assign(parsed, { sessionId: match[1], messageIndex: Number(match[2]) });
      break;
    }
    case SOURCE_HANDLE_TYPES.ARCHIVE: {
      const match = rest.match(/^(\d{4}-\d{2}-\d{2}):([^:]+):(.+)#e([^#]+)$/);
      if (!match) errors.push('archive handle must match archive:<date>:<agent_id>:<thread_id>#e<exchange_id>');
      else Object.assign(parsed, { date: match[1], agentId: match[2], threadId: match[3], exchangeId: match[4] });
      break;
    }
    case SOURCE_HANDLE_TYPES.HANDOFF: {
      const match = rest.match(/^(\d{4}-\d{2}-\d{2}):(.+)#L(\d+)-L(\d+)$/);
      if (!match) errors.push('handoff handle must match handoff:<date>:<thread_id>#L<start>-L<end>');
      else Object.assign(parsed, { date: match[1], threadId: match[2], startLine: Number(match[3]), endLine: Number(match[4]) });
      break;
    }
    case SOURCE_HANDLE_TYPES.DIGEST: {
      const match = rest.match(/^(.+)#v(\d+):([A-Za-z0-9_.-]+)$/);
      if (!match) errors.push('digest handle must match digest:<thread_id>#v<version>:<field>');
      else Object.assign(parsed, { threadId: match[1], version: Number(match[2]), field: match[3] });
      break;
    }
    case SOURCE_HANDLE_TYPES.FILE: {
      const match = rest.match(/^(.+)#L(\d+)-L(\d+)$/);
      if (!match) errors.push('file handle must match file:<workspace_relative_path>#L<start>-L<end>');
      else Object.assign(parsed, { path: match[1], startLine: Number(match[2]), endLine: Number(match[3]) });
      break;
    }
    case SOURCE_HANDLE_TYPES.TOOL: {
      const match = rest.match(/^(.+)#call(\d+)$/);
      if (!match) errors.push('tool handle must match tool:<session_id>#call<call_index>');
      else Object.assign(parsed, { sessionId: match[1], callIndex: Number(match[2]) });
      break;
    }
    case SOURCE_HANDLE_TYPES.WIKI: {
      const match = rest.match(/^(.+)#claim([^#]+)$/);
      if (!match) errors.push('wiki handle must match wiki:<page_id>#claim<claim_id>');
      else Object.assign(parsed, { pageId: match[1], claimId: match[2] });
      break;
    }
    case SOURCE_HANDLE_TYPES.COMMIT: {
      const match = rest.match(/^([a-f0-9]{7,40})#(.+)$/i);
      if (!match) errors.push('commit handle must match commit:<sha>#<path>');
      else Object.assign(parsed, { sha: match[1], path: match[2] });
      break;
    }
    default:
      errors.push(`unsupported handle type: ${prefix}`);
  }

  if (parsed.date && !ISO_DATE.test(parsed.date)) errors.push('date must be YYYY-MM-DD');
  if (parsed.startLine !== undefined && parsed.endLine !== undefined && parsed.endLine < parsed.startLine) {
    errors.push('endLine must be greater than or equal to startLine');
  }

  if (errors.length) return { ok: false, handle: value, type: prefix, errors };
  return parsed;
}

function validateSourceHandle(handle) {
  const parsed = parseSourceHandle(handle);
  return { ok: parsed.ok, errors: parsed.errors || [], parsed };
}

function normalizeSourceRefs(input = [], options = {}) {
  return normalizeArray(input).map((entry) => {
    const ref = typeof entry === 'string' ? { handle: entry } : { ...entry };
    const validation = validateSourceHandle(ref.handle);
    const role = ref.role || options.defaultRole || SOURCE_ROLES.EVIDENCE;
    return {
      handle: ref.handle,
      role: ROLE_VALUES.has(role) ? role : SOURCE_ROLES.EVIDENCE,
      quoteHash: ref.quoteHash || (ref.excerpt ? hashExcerpt(ref.excerpt) : undefined),
      excerpt: ref.excerpt || '',
      valid: validation.ok,
      errors: validation.errors
    };
  });
}

function hashExcerpt(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex')}`;
}

function sourceAuthorityRank(handleOrRef) {
  const handle = typeof handleOrRef === 'string' ? handleOrRef : handleOrRef?.handle;
  const parsed = parseSourceHandle(handle);
  if (!parsed.ok) return 0;
  switch (parsed.type) {
    case SOURCE_HANDLE_TYPES.TOOL:
    case SOURCE_HANDLE_TYPES.COMMIT:
      return 5;
    case SOURCE_HANDLE_TYPES.FILE:
    case SOURCE_HANDLE_TYPES.TRANSCRIPT:
      return 4;
    case SOURCE_HANDLE_TYPES.ARCHIVE:
      return 3;
    case SOURCE_HANDLE_TYPES.DIGEST:
    case SOURCE_HANDLE_TYPES.HANDOFF:
      return 2;
    case SOURCE_HANDLE_TYPES.WIKI:
      return 2;
    default:
      return 1;
  }
}

function strongestSourceRank(sourceRefs = []) {
  return Math.max(0, ...normalizeSourceRefs(sourceRefs).map(sourceAuthorityRank));
}

function splitOnce(value, delimiter) {
  const idx = value.indexOf(delimiter);
  if (idx === -1) return [value, ''];
  return [value.slice(0, idx), value.slice(idx + delimiter.length)];
}

function normalizeArray(value) {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value.filter((entry) => entry !== undefined && entry !== null && entry !== '') : [value];
}

function required(value, name) {
  if (value === undefined || value === null || value === '') throw new Error(`Missing required field: ${name}`);
  return value;
}


module.exports = {
  SOURCE_HANDLE_TYPES,
  SOURCE_ROLES,
  makeSourceHandle,
  parseSourceHandle,
  validateSourceHandle,
  normalizeSourceRefs,
  hashExcerpt,
  sourceAuthorityRank,
  strongestSourceRank
};
