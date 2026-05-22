#!/usr/bin/env bash
# Query the cotw-telemetry D1 database directly via Cloudflare REST API.
#
# Usage: ./scripts/query-telemetry.sh "SELECT COUNT(*) FROM entries"
#
# Requires CLOUDFLARE_API_TOKEN env var with D1:Read permission.

set -euo pipefail

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "Error: CLOUDFLARE_API_TOKEN env var not set." >&2
  echo "Get one at https://dash.cloudflare.com/profile/api-tokens with D1:Read." >&2
  exit 1
fi

if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" || -z "${CLOUDFLARE_D1_DATABASE_ID:-}" ]]; then
  echo "Error: set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_D1_DATABASE_ID." >&2
  exit 1
fi

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 \"<SQL query>\"" >&2
  exit 1
fi

ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID"
DB_ID="$CLOUDFLARE_D1_DATABASE_ID"
SQL="$1"

PAYLOAD=$(python3 -c 'import json,sys; print(json.dumps({"sql": sys.argv[1]}))' "$SQL")

curl -s -X POST \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/d1/database/$DB_ID/query" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data "$PAYLOAD" \
  | python3 -m json.tool
