# cotw-telemetry worker

Cloudflare Worker that receives opt-in telemetry from COTW Scout installations during beta and stores it in D1 for research + product iteration.

## What's here

- `src/index.js` — Worker: accepts `POST /ingest` with bearer auth, validates + batches into D1. `GET /health` for liveness.
- `schema.sql` — D1 schema (single `entries` table, JSON payload column).
- `wrangler.toml` — public deploy template with placeholder D1 binding/account values.
- `.ingest-secret.local` — optional local mirror for the live shared secret (gitignored). Source of truth is `wrangler secret` on the deployed Worker. Do not commit or package this value in default plugin config.

## Deployment

- Endpoints: `POST /ingest` (auth required), `GET /health`
- D1 database name: `cotw-telemetry`
- Keep production account ids, database ids, and ingest secrets in private deployment config.

## Plugin wiring

The sister plugin is `bundled-plugins/openclaw-plugin-telemetry/`. Its public `config.default.json` may hold the `syncEndpoint`, but upstream sync stays disabled and `syncSecret` stays empty unless a private beta runtime config enables it. The plugin POSTs batched telemetry during nightshift runs only after opt-in and private sync configuration.

## Re-deploy

```
export CLOUDFLARE_API_TOKEN=<token with D1 + Workers Scripts scopes>
export CLOUDFLARE_ACCOUNT_ID=<account id>
# Set the real D1 database id in wrangler.toml or a private deploy overlay.
npx wrangler deploy
```

## Rotate the shared secret

```
NEW_SECRET=$(openssl rand -hex 32)
printf '%s' "$NEW_SECRET" | npx wrangler secret put INGEST_SECRET
echo "$NEW_SECRET" > .ingest-secret.local
# Update private runtime config with the new secret.
# Do not commit the secret or bake it into public DMGs.
```

## Query the data

```
export CLOUDFLARE_ACCOUNT_ID=<account id>
export CLOUDFLARE_D1_DATABASE_ID=<database id>
./scripts/query-telemetry.sh "SELECT COUNT(*) FROM entries"
./scripts/query-telemetry.sh "SELECT agent_id, COUNT(*) FROM entries GROUP BY agent_id"
```

## Schema

```sql
entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),  -- server-side receive time
  event_timestamp TEXT NOT NULL,                        -- client-side event time
  agent_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL                            -- full original entry as JSON
)
```

Full payload goes in `payload_json` so we don't have to migrate schema when new event fields are added.
