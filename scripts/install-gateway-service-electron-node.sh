#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw-cotw}"
PROFILE="${OPENCLAW_PROFILE:-cotw}"
PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
WORKSPACE="${OPENCLAW_WORKSPACE:-$HOME/Library/Application Support/COTW Trail Guide/workspace}"
SERVICE_ENV_DIR="$STATE_DIR/service-env"
WRAPPER="$SERVICE_ENV_DIR/openclaw-electron-node-wrapper.sh"
ELECTRON="$ROOT_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
OPENCLAW_BIN="$ROOT_DIR/node_modules/.bin/openclaw"
ABI_CHECK="$ROOT_DIR/scripts/check-gateway-service-abi.js"

if [[ ! -x "$ELECTRON" ]]; then
  echo "Electron runtime not found or not executable: $ELECTRON" >&2
  exit 1
fi

if [[ ! -x "$OPENCLAW_BIN" ]]; then
  echo "OpenClaw CLI not found or not executable: $OPENCLAW_BIN" >&2
  exit 1
fi

if [[ ! -f "$ABI_CHECK" ]]; then
  echo "Gateway ABI preflight script not found: $ABI_CHECK" >&2
  exit 1
fi

if [[ ! -d "$WORKSPACE" ]]; then
  echo "COTW workspace not found: $WORKSPACE" >&2
  exit 1
fi

mkdir -p "$SERVICE_ENV_DIR"
cat > "$WRAPPER" <<EOF
#!/bin/sh
set -eu
export ELECTRON_RUN_AS_NODE=1
export OPENCLAW_WORKSPACE='$WORKSPACE'
exec "$ELECTRON" "\$@"
EOF
chmod 755 "$WRAPPER"

"$OPENCLAW_BIN" --profile "$PROFILE" gateway install \
  --force \
  --port "$PORT" \
  --wrapper "$WRAPPER"

echo "Installed OpenClaw Gateway service for profile '$PROFILE' on port '$PORT' using Electron-as-Node wrapper: $WRAPPER"
node "$ABI_CHECK"
