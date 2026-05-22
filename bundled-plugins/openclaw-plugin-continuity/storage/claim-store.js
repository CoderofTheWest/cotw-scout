const {
    CLAIM_STATUSES,
    FRESHNESS_POLICIES,
    createClaimRecord,
    validateClaimRecord
} = require('../lib/claim-records');
const { createClaimEdge, validateClaimEdge } = require('../lib/provenance');

const MIGRATION_NAME = 'source_addressable_memory_v1';

/**
 * ClaimStore — source-addressable memory claim/source/edge storage.
 *
 * Uses the shared per-agent continuity.db opened by Indexer. This class is
 * inert until explicitly instantiated by runtime wiring; Build 2 Patch 2 only
 * adds the store and tests, not any initialization or hook behavior.
 */
class ClaimStore {
    constructor(db, config = {}, options = {}) {
        this.db = db;
        this.config = config.sourceAddressableMemory || {};
        this.clock = options.clock || (() => new Date().toISOString());
    }

    createTables() {
        if (!this.db) return;

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                name TEXT PRIMARY KEY,
                applied_at TEXT DEFAULT (datetime('now'))
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS claims (
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                thread_id TEXT,
                kind TEXT NOT NULL,
                claim TEXT NOT NULL,
                status TEXT NOT NULL,
                confidence REAL NOT NULL,
                authority_rank INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_verified_at TEXT,
                expires_after TEXT,
                staleness_policy TEXT NOT NULL,
                speech_guidance TEXT,
                metadata TEXT
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS claim_sources (
                claim_id TEXT NOT NULL,
                handle TEXT NOT NULL,
                role TEXT NOT NULL,
                quote_hash TEXT,
                excerpt TEXT,
                created_at TEXT NOT NULL,
                metadata TEXT,
                PRIMARY KEY (claim_id, handle, role),
                FOREIGN KEY (claim_id) REFERENCES claims(id)
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS claim_edges (
                from_claim_id TEXT NOT NULL,
                to_claim_id TEXT NOT NULL,
                relation TEXT NOT NULL,
                source_handle TEXT,
                created_at TEXT NOT NULL,
                metadata TEXT,
                PRIMARY KEY (from_claim_id, to_claim_id, relation)
            )
        `);

        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_claims_agent_thread ON claims(agent_id, thread_id)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_claims_kind ON claims(kind)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_claim_sources_handle ON claim_sources(handle)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_claim_edges_to ON claim_edges(to_claim_id, relation)`);

        this.db.prepare(`INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)`).run(MIGRATION_NAME);
    }

    storeClaim(input = {}) {
        if (!this.db) throw new Error('ClaimStore requires an initialized db');
        const claim = isClaimRecord(input) ? input : createClaimRecord(input, { now: this.clock() });
        const validation = validateClaimRecord(claim);
        if (!validation.ok) throw new Error(`Invalid claim record: ${validation.errors.join('; ')}`);

        const insertClaim = this.db.prepare(`
            INSERT OR REPLACE INTO claims
            (id, agent_id, thread_id, kind, claim, status, confidence, authority_rank,
             created_at, updated_at, last_verified_at, expires_after, staleness_policy,
             speech_guidance, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const deleteSources = this.db.prepare(`DELETE FROM claim_sources WHERE claim_id = ?`);
        const insertSource = this.db.prepare(`
            INSERT OR REPLACE INTO claim_sources
            (claim_id, handle, role, quote_hash, excerpt, created_at, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        const tx = this.db.transaction(() => {
            insertClaim.run(
                claim.id,
                claim.agentId,
                claim.threadId || null,
                claim.kind,
                claim.claim,
                claim.status,
                claim.confidence,
                claim.authorityRank,
                claim.createdAt,
                claim.updatedAt,
                claim.freshness?.lastVerifiedAt || null,
                claim.freshness?.expiresAfter || null,
                claim.freshness?.stalenessPolicy,
                claim.speechGuidance || null,
                JSON.stringify(claim.metadata || {})
            );
            deleteSources.run(claim.id);
            for (const source of claim.sources || []) {
                insertSource.run(
                    claim.id,
                    source.handle,
                    source.role,
                    source.quoteHash || null,
                    source.excerpt || '',
                    this.clock(),
                    JSON.stringify(source.metadata || {})
                );
            }
        });
        tx();
        return claim;
    }

    storeEdge(input = {}) {
        if (!this.db) throw new Error('ClaimStore requires an initialized db');
        const edge = input.fromClaimId ? input : createClaimEdge(input);
        const validation = validateClaimEdge(edge);
        if (!validation.ok) throw new Error(`Invalid claim edge: ${validation.errors.join('; ')}`);

        this.db.prepare(`
            INSERT OR REPLACE INTO claim_edges
            (from_claim_id, to_claim_id, relation, source_handle, created_at, metadata)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(
            edge.fromClaimId,
            edge.toClaimId,
            edge.relation,
            edge.sourceHandle || null,
            edge.createdAt,
            JSON.stringify(edge.metadata || {})
        );
        return edge;
    }

    getClaim(id) {
        const row = this.db.prepare(`SELECT * FROM claims WHERE id = ?`).get(id);
        if (!row) return null;
        const sources = this.db.prepare(`
            SELECT * FROM claim_sources WHERE claim_id = ? ORDER BY role, handle
        `).all(id).map(sourceRowToObject);
        const outgoingEdges = this.db.prepare(`
            SELECT * FROM claim_edges WHERE from_claim_id = ? ORDER BY relation, to_claim_id
        `).all(id).map(edgeRowToObject);
        return claimRowToObject(row, sources, outgoingEdges);
    }

    listClaims(filter = {}) {
        return this.queryClaims(filter);
    }

    queryClaims(filter = {}) {
        if (!this.db) throw new Error('ClaimStore requires an initialized db');
        const { where, params } = buildClaimQuery(filter);
        const limit = normalizeLimit(filter.limit);
        const rows = this.db.prepare(`
            SELECT DISTINCT claims.* FROM claims ${where}
            ORDER BY updated_at DESC, created_at DESC
            LIMIT ?
        `).all(...params, limit);
        if (filter.includeSources || filter.includeEdges) {
            return rows.map((row) => {
                const claim = this.getClaim(row.id);
                if (filter.includeSources && filter.includeEdges) return claim;
                if (filter.includeSources) return { ...claim, edges: [] };
                return { ...claim, sources: [] };
            });
        }
        return rows.map((row) => claimRowToObject(row));
    }

    getClaimsBySourceHandle(handle, filter = {}) {
        if (!handle) throw new Error('source handle is required');
        return this.queryClaims({
            ...filter,
            sourceHandle: handle,
            includeSources: filter.includeSources ?? true
        });
    }

    getClaimsNeedingVerification(filter = {}) {
        return this.queryClaims({ ...filter, requiresVerification: true });
    }

    getSourcesByHandle(handle) {
        return this.db.prepare(`
            SELECT * FROM claim_sources WHERE handle = ? ORDER BY created_at DESC
        `).all(handle).map(sourceRowToObject);
    }

    getStats(agentId = null) {
        const agentWhere = agentId ? 'WHERE agent_id = ?' : '';
        const params = agentId ? [agentId] : [];
        const total = this.db.prepare(`SELECT COUNT(*) AS count FROM claims ${agentWhere}`).get(...params).count;
        const byStatus = this.db.prepare(`
            SELECT status, COUNT(*) AS count FROM claims ${agentWhere}
            GROUP BY status ORDER BY status
        `).all(...params).reduce((acc, row) => ({ ...acc, [row.status]: row.count }), {});
        const byKind = this.db.prepare(`
            SELECT kind, COUNT(*) AS count FROM claims ${agentWhere}
            GROUP BY kind ORDER BY kind
        `).all(...params).reduce((acc, row) => ({ ...acc, [row.kind]: row.count }), {});
        const sourceCount = this.db.prepare(`
            SELECT COUNT(*) AS count FROM claim_sources
            ${agentId ? 'WHERE claim_id IN (SELECT id FROM claims WHERE agent_id = ?)' : ''}
        `).get(...params).count;
        const edgeCount = this.db.prepare(`SELECT COUNT(*) AS count FROM claim_edges`).get().count;
        return { total, byStatus, byKind, sourceCount, edgeCount };
    }
}

function buildClaimQuery(filter = {}) {
    const clauses = [];
    const params = [];
    addEqualsClause(clauses, params, 'id', filter.id);
    addInClause(clauses, params, 'id', filter.ids);
    addEqualsClause(clauses, params, 'agent_id', filter.agentId);
    addEqualsClause(clauses, params, 'thread_id', filter.threadId);
    addEqualsClause(clauses, params, 'status', filter.status);
    addInClause(clauses, params, 'status', filter.statuses);
    addEqualsClause(clauses, params, 'kind', filter.kind);
    addInClause(clauses, params, 'kind', filter.kinds);
    if (Number.isFinite(filter.minConfidence)) { clauses.push('confidence >= ?'); params.push(filter.minConfidence); }
    if (Number.isFinite(filter.maxConfidence)) { clauses.push('confidence <= ?'); params.push(filter.maxConfidence); }
    if (filter.updatedAfter) { clauses.push('updated_at >= ?'); params.push(filter.updatedAfter); }
    if (filter.updatedBefore) { clauses.push('updated_at <= ?'); params.push(filter.updatedBefore); }
    if (filter.sourceHandle) {
        clauses.push('EXISTS (SELECT 1 FROM claim_sources WHERE claim_sources.claim_id = claims.id AND claim_sources.handle = ?)');
        params.push(filter.sourceHandle);
    }
    if (filter.sourceRole) {
        clauses.push('EXISTS (SELECT 1 FROM claim_sources WHERE claim_sources.claim_id = claims.id AND claim_sources.role = ?)');
        params.push(filter.sourceRole);
    }
    if (filter.text) {
        clauses.push(`claim LIKE ? ESCAPE '\\'`);
        params.push(`%${escapeLike(filter.text)}%`);
    }
    if (filter.requiresVerification) {
        clauses.push(`(status IN (?, ?) OR staleness_policy IN (?, ?))`);
        params.push(
            CLAIM_STATUSES.VERIFY_REQUIRED,
            CLAIM_STATUSES.STALE,
            FRESHNESS_POLICIES.VERIFY_BEFORE_ASSERTING,
            FRESHNESS_POLICIES.RUNTIME_CHECK_REQUIRED
        );
    }
    return {
        where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
        params
    };
}

function addEqualsClause(clauses, params, column, value) {
    if (value === undefined || value === null || value === '') return;
    clauses.push(`${column} = ?`);
    params.push(value);
}

function addInClause(clauses, params, column, value) {
    const values = normalizeArray(value);
    if (!values.length) return;
    clauses.push(`${column} IN (${values.map(() => '?').join(', ')})`);
    params.push(...values);
}

function normalizeLimit(value) {
    return Number.isInteger(value) ? Math.max(1, Math.min(value, 500)) : 100;
}

function normalizeArray(value) {
    if (value === undefined || value === null || value === '') return [];
    return Array.isArray(value) ? value.filter((entry) => entry !== undefined && entry !== null && entry !== '') : [value];
}

function escapeLike(value) {
    return String(value).replace(/[\\%_]/g, (match) => `\\${match}`);
}

function isClaimRecord(input) {
    return Boolean(
        input?.id &&
        input?.agentId &&
        input?.kind &&
        input?.claim &&
        input?.status &&
        Number.isFinite(input?.confidence) &&
        Number.isFinite(input?.authorityRank) &&
        input?.freshness?.stalenessPolicy &&
        Array.isArray(input?.sources)
    );
}

function claimRowToObject(row, sources = [], edges = []) {
    return {
        id: row.id,
        agentId: row.agent_id,
        threadId: row.thread_id,
        kind: row.kind,
        claim: row.claim,
        status: row.status,
        confidence: row.confidence,
        authorityRank: row.authority_rank,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        freshness: {
            lastVerifiedAt: row.last_verified_at,
            expiresAfter: row.expires_after,
            stalenessPolicy: row.staleness_policy
        },
        speechGuidance: row.speech_guidance,
        metadata: parseJson(row.metadata, {}),
        sources,
        edges
    };
}

function sourceRowToObject(row) {
    return {
        claimId: row.claim_id,
        handle: row.handle,
        role: row.role,
        quoteHash: row.quote_hash,
        excerpt: row.excerpt || '',
        createdAt: row.created_at,
        metadata: parseJson(row.metadata, {})
    };
}

function edgeRowToObject(row) {
    return {
        fromClaimId: row.from_claim_id,
        toClaimId: row.to_claim_id,
        relation: row.relation,
        sourceHandle: row.source_handle,
        createdAt: row.created_at,
        metadata: parseJson(row.metadata, {})
    };
}

function parseJson(value, fallback) {
    if (!value) return fallback;
    try { return JSON.parse(value); } catch { return fallback; }
}

module.exports = {
    ClaimStore,
    MIGRATION_NAME,
    buildClaimQuery
};
