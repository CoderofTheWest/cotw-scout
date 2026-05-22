/**
 * cotw-telemetry — Cloudflare Worker for COTW beta telemetry ingestion.
 *
 * Accepts POST /ingest with JSON body { entries: [...] }.
 * Validates shared-secret auth header. Inserts entries into D1.
 *
 * Sister to openclaw-plugin-telemetry in the COTW Scout app.
 * Deployed via `wrangler deploy`. D1 binding name: DB.
 * Secret: INGEST_SECRET (set via `wrangler secret put`).
 */

const MAX_BATCH = 100;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, service: 'cotw-telemetry', time: new Date().toISOString() });
    }

    if (request.method !== 'POST' || url.pathname !== '/ingest') {
      return json({ error: 'Not found' }, 404);
    }

    const auth = request.headers.get('Authorization');
    if (!auth || auth !== `Bearer ${env.INGEST_SECRET}`) {
      return json({ error: 'Unauthorized' }, 401);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON' }, 400);
    }

    const entries = body?.entries;
    if (!Array.isArray(entries) || entries.length === 0) {
      return json({ error: 'Expected non-empty entries array' }, 400);
    }
    if (entries.length > MAX_BATCH) {
      return json({ error: `Batch too large (max ${MAX_BATCH})` }, 400);
    }

    const stmt = env.DB.prepare(
      'INSERT INTO entries (event_timestamp, agent_id, type, payload_json) VALUES (?, ?, ?, ?)'
    );

    const batch = entries.map(e => stmt.bind(
      e.timestamp || new Date().toISOString(),
      e.agent_id || 'unknown',
      e.type || 'unknown',
      JSON.stringify(e)
    ));

    try {
      await env.DB.batch(batch);
    } catch (err) {
      return json({ error: 'Database write failed', detail: err.message }, 500);
    }

    return json({ accepted: entries.length });
  }
};
