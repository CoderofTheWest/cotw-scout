#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HELPER_DIR="$ROOT/native/macos/SpeechHelper"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Speech helper is macOS-only; skipping."
  exit 0
fi

cd "$HELPER_DIR"
swift build -c release
mkdir -p "$ROOT/native/macos/bin"
cp "$HELPER_DIR/.build/release/cotw-speech-helper" "$ROOT/native/macos/bin/cotw-speech-helper"
chmod +x "$ROOT/native/macos/bin/cotw-speech-helper"
echo "Built native/macos/bin/cotw-speech-helper"
