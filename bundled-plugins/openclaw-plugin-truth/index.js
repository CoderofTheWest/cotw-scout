/**
 * openclaw-plugin-truth — "Current State"
 *
 * Lightweight truth table that supersedes outdated memories.
 * 
 * Provides:
 * - Single table in knowledge.db with current state facts
 * - Automatic injection via prependContext on session start
 * - Manual updates via truth_update tool
 *
 * How it works:
 * 1. When Chris corrects me, I call truth_update tool
 * 2. Plugin writes to truth table
 * 3. Every session, plugin injects [CURRENT STATE] block
 * 4. This supersedes older memories that contradict current state
 *
 * Based on human memory reconsolidation: retrieval enters unstable state
 * where corrections can be applied. This automates that process.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { instrumentApiHooks } = require('../lib/runtime-metrics');

// Load sqlite-vec extension
const sqliteVec = require('sqlite-vec');

let db = null;

function getDb(workspacePath) {
    if (db) return db;
    
    const dbPath = path.join(workspacePath, 'knowledge.db');
    if (!fs.existsSync(dbPath)) {
        console.error(`[Truth] knowledge.db not found at ${dbPath} — creating it`);
    }

    db = new Database(dbPath, { readonly: false });
    sqliteVec.load(db);
    
    // Ensure table exists
    db.exec(`
        CREATE TABLE IF NOT EXISTS truth (
            key TEXT PRIMARY KEY,
            current_value TEXT NOT NULL,
            supersedes TEXT,
            reasoning TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_truth_key ON truth(key);
    `);
    
    return db;
}

function getAllTruth(db) {
    try {
        const rows = db.prepare('SELECT key, current_value, supersedes, reasoning FROM truth').all();
        return rows;
    } catch (err) {
        console.error(`[Truth] Failed to read truth table: ${err.message}`);
        return [];
    }
}

function setTruth(db, key, currentValue, supersedes = null, reasoning = null) {
    try {
        db.prepare(`
            INSERT OR REPLACE INTO truth (key, current_value, supersedes, reasoning, updated_at)
            VALUES (?, ?, ?, ?, datetime('now'))
        `).run(key, currentValue, supersedes, reasoning);
        return true;
    } catch (err) {
        console.error(`[Truth] Failed to update truth table: ${err.message}`);
        return false;
    }
}

module.exports = {
    id: 'truth',
    name: 'Current State — Truth Table',
    
    configSchema: {
        jsonSchema: {
            type: 'object',
            properties: {
                enabled: { type: 'boolean' }
            }
        }
    },
    
    register(api) {
        api = instrumentApiHooks(api, 'truth');
        const config = api.pluginConfig || {};
        
        // HOOK: before_agent_start — Inject current state via prependContext
        api.on('before_agent_start', async (event, ctx) => {
            if (config.enabled === false) return;
            
            const workspacePath = ctx.workspaceDir || process.env.OPENCLAW_WORKSPACE;
            if (!workspacePath) return;
            
            const db = getDb(workspacePath);
            if (!db) return;
            
            const truths = getAllTruth(db);
            if (truths.length === 0) return;
            
            // Build [CURRENT STATE] block
            const lines = ['[CURRENT STATE — Supersedes older memories]'];
            for (const t of truths) {
                let line = `- ${t.key}: ${t.current_value}`;
                if (t.supersedes) {
                    line += ` (was: ${t.supersedes})`;
                }
                lines.push(line);
            }
            lines.push('');
            
            console.error(`[Truth] Injecting ${truths.length} current state entries`);
            return { prependContext: lines.join('\n') };
        });
        
        // TOOL: truth_update — Update a truth entry
        api.registerTool({
            name: 'truth_update',
            description: 'Update a current state fact that supersedes older memories. Use when corrected about outdated information.',
            parameters: {
                type: 'object',
                properties: {
                    key: {
                        type: 'string',
                        description: 'The fact key (e.g., "vector_db", "architecture", "servo_config")'
                    },
                    currentValue: {
                        type: 'string',
                        description: 'The current correct value'
                    },
                    supersedes: {
                        type: 'string',
                        description: 'The old incorrect value being superseded'
                    },
                    reasoning: {
                        type: 'string',
                        description: 'Why this correction was made'
                    }
                },
                required: ['key', 'currentValue']
            },
            async handler(params, ctx) {
                const workspacePath = ctx.workspaceDir || process.env.OPENCLAW_WORKSPACE;
                if (!workspacePath) {
                    return { error: 'No workspace path available' };
                }
                
                const db = getDb(workspacePath);
                if (!db) {
                    return { error: 'Could not open knowledge database' };
                }
                
                const success = setTruth(
                    db,
                    params.key,
                    params.currentValue,
                    params.supersedes || null,
                    params.reasoning || null
                );
                
                if (success) {
                    return {
                        success: true,
                        message: `Updated truth: ${params.key} = ${params.currentValue}`,
                        supersedes: params.supersedes
                    };
                } else {
                    return { error: 'Failed to update truth table' };
                }
            }
        });
        
        // TOOL: truth_list — List all current truths
        api.registerTool({
            name: 'truth_list',
            description: 'List all current state facts in the truth table.',
            parameters: {
                type: 'object',
                properties: {}
            },
            async handler(params, ctx) {
                const workspacePath = ctx.workspaceDir || process.env.OPENCLAW_WORKSPACE;
                if (!workspacePath) {
                    return { error: 'No workspace path available' };
                }
                
                const db = getDb(workspacePath);
                if (!db) {
                    return { error: 'Could not open knowledge database' };
                }
                
                const truths = getAllTruth(db);
                return {
                    count: truths.length,
                    truths: truths
                };
            }
        });
    }
};
