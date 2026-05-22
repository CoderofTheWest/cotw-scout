#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { ClaimStore, MIGRATION_NAME } = require('../storage/claim-store');
const { CLAIM_KINDS, CLAIM_STATUSES, createClaimRecord } = require('../lib/claim-records');
const { PROVENANCE_EDGE_TYPES } = require('../lib/provenance');

const now = '2026-05-04T22:10:00.000Z';
let db;
let store;
const results = [];

function main() {
  db = new FakeDb();
  store = new ClaimStore(db, {
    sourceAddressableMemory: { enabled: false, mode: 'observe', storage: 'sqlite' }
  }, { clock: () => now });

run('createTables is idempotent and records named migration', () => {
  store.createTables();
  store.createTables();
  const migration = db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get(MIGRATION_NAME);
  assert.equal(migration.name, MIGRATION_NAME);
  for (const table of ['claims', 'claim_sources', 'claim_edges']) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table);
    assert.equal(row.name, table);
  }
});

run('storeClaim persists claim and source refs transactionally', () => {
  const claim = createClaimRecord({
    agentId: 'trail-guide',
    threadId: 'main',
    kind: CLAIM_KINDS.PROJECT_STATE,
    claim: 'Build 2 Patch 1 landed as pure modules/tests.',
    sources: [
      { handle: 'commit:17c9698#bundled-plugins/openclaw-plugin-continuity/lib/source-handles.js', role: 'evidence', excerpt: 'pure source handle module' }
    ],
    metadata: { patch: 1 }
  }, { now });
  const stored = store.storeClaim(claim);
  const fetched = store.getClaim(stored.id);
  assert.equal(fetched.id, claim.id);
  assert.equal(fetched.agentId, 'trail-guide');
  assert.equal(fetched.sources.length, 1);
  assert.equal(fetched.sources[0].handle, 'commit:17c9698#bundled-plugins/openclaw-plugin-continuity/lib/source-handles.js');
  assert.equal(fetched.metadata.patch, 1);
});

run('storeClaim accepts raw input with explicit id and normalizes sources', () => {
  const stored = store.storeClaim({
    id: 'claim_raw_input',
    agentId: 'trail-guide',
    threadId: 'main',
    kind: CLAIM_KINDS.SUMMARY,
    claim: 'Raw claim input should become a validated claim record.',
    sources: ['archive:2026-05-04:trail-guide:main#e0000']
  });
  const fetched = store.getClaim(stored.id);
  assert.equal(fetched.id, 'claim_raw_input');
  assert.equal(fetched.sources[0].handle, 'archive:2026-05-04:trail-guide:main#e0000');
});

run('storeClaim replaces old sources for same claim id', () => {
  const claim = createClaimRecord({
    id: 'claim_replace_sources',
    agentId: 'trail-guide',
    threadId: 'main',
    kind: CLAIM_KINDS.SUMMARY,
    claim: 'Replace source refs when a claim is updated.',
    sources: ['archive:2026-05-04:trail-guide:main#e0001']
  }, { now });
  store.storeClaim(claim);
  store.storeClaim({
    ...claim,
    updatedAt: '2026-05-04T22:11:00.000Z',
    sources: [{ handle: 'archive:2026-05-04:trail-guide:main#e0002', role: 'verification', valid: true, errors: [] }]
  });
  const fetched = store.getClaim('claim_replace_sources');
  assert.equal(fetched.sources.length, 1);
  assert.equal(fetched.sources[0].handle, 'archive:2026-05-04:trail-guide:main#e0002');
});

run('storeEdge persists supersession relationship', () => {
  const edge = store.storeEdge({
    fromClaimId: 'claim_replace_sources',
    toClaimId: 'claim_old_summary',
    relation: PROVENANCE_EDGE_TYPES.SUPERSEDES,
    sourceHandle: 'archive:2026-05-04:trail-guide:main#e0002',
    createdAt: now,
    metadata: { reason: 'newer source' }
  });
  assert.equal(edge.relation, 'supersedes');
  const fetched = store.getClaim('claim_replace_sources');
  assert.equal(fetched.edges.length, 1);
  assert.equal(fetched.edges[0].toClaimId, 'claim_old_summary');
  assert.equal(fetched.edges[0].metadata.reason, 'newer source');
});

run('listClaims and getSourcesByHandle return filtered records', () => {
  const runtime = store.storeClaim({
    agentId: 'trail-guide',
    threadId: 'ops',
    kind: CLAIM_KINDS.RUNTIME,
    claim: 'Gateway reachable requires runtime verification.',
    sources: [{ handle: 'tool:session_abc#call7', role: 'verification', excerpt: 'reachable' }]
  });
  const runtimeClaims = store.listClaims({ agentId: 'trail-guide', kind: CLAIM_KINDS.RUNTIME });
  assert.ok(runtimeClaims.some((claim) => claim.id === runtime.id));
  assert.equal(runtime.status, CLAIM_STATUSES.VERIFY_REQUIRED);
  const sources = store.getSourcesByHandle('tool:session_abc#call7');
  assert.equal(sources.length, 1);
  assert.equal(sources[0].claimId, runtime.id);
});

run('queryClaims supports source handle and source inclusion filters', () => {
  const sourceClaims = store.getClaimsBySourceHandle('tool:session_abc#call7');
  assert.equal(sourceClaims.length, 1);
  assert.equal(sourceClaims[0].kind, CLAIM_KINDS.RUNTIME);
  assert.equal(sourceClaims[0].sources.length, 1);
  assert.equal(sourceClaims[0].sources[0].handle, 'tool:session_abc#call7');
});

run('getClaimsBySourceHandle requires an explicit handle', () => {
  assert.throws(() => store.getClaimsBySourceHandle(''), /source handle is required/);
});

run('queryClaims supports verification and confidence/text filters', () => {
  const needsVerification = store.getClaimsNeedingVerification({ agentId: 'trail-guide', limit: 10 });
  assert.ok(needsVerification.some((claim) => claim.id === 'claim_raw_input'));
  assert.ok(needsVerification.some((claim) => claim.kind === CLAIM_KINDS.RUNTIME));

  const textMatches = store.queryClaims({
    text: 'Gateway reachable',
    minConfidence: 0.3,
    kinds: [CLAIM_KINDS.RUNTIME],
    includeSources: false
  });
  assert.equal(textMatches.length, 1);
  assert.equal(textMatches[0].sources.length, 0);
  assert.equal(textMatches[0].claim, 'Gateway reachable requires runtime verification.');
});

run('getStats summarizes claims/sources/edges', () => {
  const stats = store.getStats('trail-guide');
  assert.ok(stats.total >= 3);
  assert.ok(stats.sourceCount >= 3);
  assert.ok(stats.edgeCount >= 1);
  assert.ok(stats.byKind.project_state >= 1);
  assert.ok(stats.byStatus.active >= 1);
});

const pass = results.filter((r) => r.status === 'PASS').length;
const fail = results.length - pass;
const lines = [];
lines.push('# Claim Store Test Report');
lines.push('');
lines.push(`- PASS: ${pass}`);
lines.push(`- FAIL: ${fail}`);
lines.push(`- Total: ${results.length}`);
lines.push('');
lines.push('| Fixture | Status | Detail |');
lines.push('|---|---:|---|');
for (const result of results) lines.push(`| ${escapePipes(result.name)} | ${result.status} | ${escapePipes(result.detail || 'ok')} |`);
lines.push('');

const reportPath = path.join(__dirname, 'reports', 'claim-store.md');
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

console.log(`Claim store tests: PASS=${pass} FAIL=${fail}`);
console.log(`Report: ${path.relative(process.cwd(), reportPath)}`);
if (fail) {
  for (const r of results.filter((r) => r.status === 'FAIL')) console.error(`${r.name}: ${r.detail}`);
  process.exit(1);
}
}

function run(name, fn) {
  try {
    fn();
    results.push({ name, status: 'PASS', detail: 'ok' });
  } catch (err) {
    results.push({ name, status: 'FAIL', detail: err.message });
  }
}

function escapePipes(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

class FakeDb {
  constructor() {
    this.tables = new Set();
    this.migrations = new Set();
    this.claims = new Map();
    this.sources = [];
    this.edges = [];
  }

  exec(sql) {
    for (const match of String(sql).matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/g)) {
      this.tables.add(match[1]);
    }
  }

  transaction(fn) {
    return () => fn();
  }

  prepare(sql) {
    return new FakeStatement(this, String(sql));
  }
}

class FakeStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql.replace(/\s+/g, ' ').trim();
  }

  run(...params) {
    const sql = this.sql;
    if (sql.startsWith('INSERT OR IGNORE INTO schema_migrations')) {
      this.db.migrations.add(params[0]);
      return { changes: 1 };
    }
    if (sql.startsWith('INSERT OR REPLACE INTO claims')) {
      const [id, agent_id, thread_id, kind, claim, status, confidence, authority_rank,
        created_at, updated_at, last_verified_at, expires_after, staleness_policy,
        speech_guidance, metadata] = params;
      this.db.claims.set(id, { id, agent_id, thread_id, kind, claim, status, confidence, authority_rank, created_at, updated_at, last_verified_at, expires_after, staleness_policy, speech_guidance, metadata });
      return { changes: 1 };
    }
    if (sql.startsWith('DELETE FROM claim_sources WHERE claim_id = ?')) {
      this.db.sources = this.db.sources.filter((source) => source.claim_id !== params[0]);
      return { changes: 1 };
    }
    if (sql.startsWith('INSERT OR REPLACE INTO claim_sources')) {
      const [claim_id, handle, role, quote_hash, excerpt, created_at, metadata] = params;
      this.db.sources = this.db.sources.filter((source) => !(source.claim_id === claim_id && source.handle === handle && source.role === role));
      this.db.sources.push({ claim_id, handle, role, quote_hash, excerpt, created_at, metadata });
      return { changes: 1 };
    }
    if (sql.startsWith('INSERT OR REPLACE INTO claim_edges')) {
      const [from_claim_id, to_claim_id, relation, source_handle, created_at, metadata] = params;
      this.db.edges = this.db.edges.filter((edge) => !(edge.from_claim_id === from_claim_id && edge.to_claim_id === to_claim_id && edge.relation === relation));
      this.db.edges.push({ from_claim_id, to_claim_id, relation, source_handle, created_at, metadata });
      return { changes: 1 };
    }
    return { changes: 0 };
  }

  get(...params) {
    const sql = this.sql;
    if (sql.startsWith('SELECT name FROM schema_migrations')) {
      return this.db.migrations.has(params[0]) ? { name: params[0] } : undefined;
    }
    if (sql.startsWith('SELECT name FROM sqlite_master')) {
      return this.db.tables.has(params[0]) ? { name: params[0] } : undefined;
    }
    if (sql.startsWith('SELECT * FROM claims WHERE id = ?')) {
      return this.db.claims.get(params[0]);
    }
    if (sql.includes('COUNT(*) AS count FROM claim_sources')) {
      const agentId = params[0];
      return { count: agentId ? this.db.sources.filter((source) => this.db.claims.get(source.claim_id)?.agent_id === agentId).length : this.db.sources.length };
    }
    if (sql.includes('COUNT(*) AS count FROM claim_edges')) {
      return { count: this.db.edges.length };
    }
    if (sql.includes('COUNT(*) AS count FROM claims')) {
      const rows = filterClaims(this.db.claimsArray(), sql, params);
      return { count: rows.length };
    }
    return undefined;
  }

  all(...params) {
    const sql = this.sql;
    if (sql.startsWith('SELECT * FROM claim_sources WHERE claim_id = ?')) {
      return this.db.sources.filter((source) => source.claim_id === params[0]).sort((a, b) => `${a.role}:${a.handle}`.localeCompare(`${b.role}:${b.handle}`));
    }
    if (sql.startsWith('SELECT * FROM claim_edges WHERE from_claim_id = ?')) {
      return this.db.edges.filter((edge) => edge.from_claim_id === params[0]).sort((a, b) => `${a.relation}:${a.to_claim_id}`.localeCompare(`${b.relation}:${b.to_claim_id}`));
    }
    if (sql.startsWith('SELECT * FROM claim_sources WHERE handle = ?')) {
      return this.db.sources.filter((source) => source.handle === params[0]);
    }
    if (sql.startsWith('SELECT DISTINCT claims.* FROM claims') || sql.startsWith('SELECT * FROM claims')) {
      const limit = params[params.length - 1];
      return filterClaims(this.db.claimsArray(), sql, params.slice(0, -1), this.db).slice(0, limit);
    }
    if (sql.startsWith('SELECT status, COUNT(*) AS count FROM claims')) {
      return groupCounts(filterClaims(this.db.claimsArray(), sql, params), 'status');
    }
    if (sql.startsWith('SELECT kind, COUNT(*) AS count FROM claims')) {
      return groupCounts(filterClaims(this.db.claimsArray(), sql, params), 'kind');
    }
    return [];
  }
}

FakeDb.prototype.claimsArray = function claimsArray() {
  return [...this.claims.values()].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || String(b.created_at).localeCompare(String(a.created_at)));
};

function filterClaims(rows, sql, params, db = null) {
  return rows.filter((row) => {
    let idx = 0;
    if (hasColumnEquals(sql, 'id') && row.id !== params[idx++]) return false;
    if (hasColumnIn(sql, 'id')) {
      const count = placeholderCount(segmentAfter(sql, 'id IN ('));
      const values = params.slice(idx, idx + count);
      idx += count;
      if (!values.includes(row.id)) return false;
    }
    if (sql.includes('agent_id = ?') && row.agent_id !== params[idx++]) return false;
    if (sql.includes('thread_id = ?') && row.thread_id !== params[idx++]) return false;
    if (sql.includes('status = ?') && row.status !== params[idx++]) return false;
    if (sql.includes('status IN (') && !sql.includes('status IN (?, ?) OR staleness_policy IN (?, ?)')) {
      const count = placeholderCount(segmentAfter(sql, 'status IN ('));
      const values = params.slice(idx, idx + count);
      idx += count;
      if (!values.includes(row.status)) return false;
    }
    if (sql.includes('kind = ?') && row.kind !== params[idx++]) return false;
    if (sql.includes('kind IN (')) {
      const count = placeholderCount(segmentAfter(sql, 'kind IN ('));
      const values = params.slice(idx, idx + count);
      idx += count;
      if (!values.includes(row.kind)) return false;
    }
    if (sql.includes('confidence >= ?') && !(row.confidence >= params[idx++])) return false;
    if (sql.includes('confidence <= ?') && !(row.confidence <= params[idx++])) return false;
    if (sql.includes('updated_at >= ?') && !(row.updated_at >= params[idx++])) return false;
    if (sql.includes('updated_at <= ?') && !(row.updated_at <= params[idx++])) return false;
    if (sql.includes('claim_sources.handle = ?')) {
      const handle = params[idx++];
      if (!db?.sources.some((source) => source.claim_id === row.id && source.handle === handle)) return false;
    }
    if (sql.includes('claim_sources.role = ?')) {
      const role = params[idx++];
      if (!db?.sources.some((source) => source.claim_id === row.id && source.role === role)) return false;
    }
    if (sql.includes('claim LIKE ?')) {
      const needle = String(params[idx++]).replace(/^%|%$/g, '');
      if (!String(row.claim).includes(needle)) return false;
    }
    if (sql.includes('status IN (?, ?) OR staleness_policy IN (?, ?)')) {
      const [statusA, statusB, policyA, policyB] = params.slice(idx, idx + 4);
      idx += 4;
      if (![statusA, statusB].includes(row.status) && ![policyA, policyB].includes(row.staleness_policy)) return false;
    }
    return true;
  });
}

function hasColumnEquals(sql, column) {
  return new RegExp(`(^|\\s|\\()${column} = \\?`).test(sql);
}

function hasColumnIn(sql, column) {
  return new RegExp(`(^|\\s|\\()${column} IN \\(`).test(sql);
}

function segmentAfter(sql, marker) {
  return sql.slice(sql.indexOf(marker) + marker.length).split(')')[0];
}

function placeholderCount(segment) {
  return (segment.match(/\?/g) || []).length;
}

function groupCounts(rows, key) {
  const counts = new Map();
  for (const row of rows) counts.set(row[key], (counts.get(row[key]) || 0) + 1);
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([value, count]) => ({ [key]: value, count }));
}

main();
