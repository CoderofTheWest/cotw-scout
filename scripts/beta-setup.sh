#!/usr/bin/env bash
# COTW Scout — beta setup script.
# Verifies your environment and installs what it can. White-gloves the rest.
#
# Run from the repo root: ./scripts/beta-setup.sh

set -euo pipefail

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'
BOLD=$'\033[1m'
RESET=$'\033[0m'

say_info()  { printf "%sℹ%s %s\n" "$BLUE"  "$RESET" "$*"; }
say_ok()    { printf "%s✓%s %s\n" "$GREEN" "$RESET" "$*"; }
say_warn()  { printf "%s⚠%s %s\n" "$YELLOW" "$RESET" "$*"; }
say_fail()  { printf "%s✗%s %s\n" "$RED"   "$RESET" "$*" >&2; }
say_step()  { printf "\n%s→ %s%s\n" "$BOLD" "$*" "$RESET"; }

FAILURES=0
note_failure() { FAILURES=$((FAILURES + 1)); }

# ----------------------------------------------------------------------
# 1. Platform — macOS + Apple Silicon only for this beta
# ----------------------------------------------------------------------
say_step "Checking platform"
if [[ "$(uname -s)" != "Darwin" ]]; then
  say_fail "This beta supports macOS only. Detected: $(uname -s)"
  exit 1
fi
if [[ "$(uname -m)" != "arm64" ]]; then
  say_fail "This beta supports Apple Silicon (arm64) only. Detected: $(uname -m)"
  exit 1
fi
say_ok "macOS $(sw_vers -productVersion) on Apple Silicon"

# ----------------------------------------------------------------------
# 2. Homebrew (optional — we use it for remediations when present)
# ----------------------------------------------------------------------
say_step "Checking Homebrew (optional)"
HAS_BREW=0
if command -v brew >/dev/null 2>&1; then
  say_ok "Homebrew present"
  HAS_BREW=1
else
  say_warn "Homebrew not installed. Not required, but makes installing dependencies easier."
  say_warn "Install from https://brew.sh if you'd like."
fi

# ----------------------------------------------------------------------
# 3. git
# ----------------------------------------------------------------------
say_step "Checking git"
if ! command -v git >/dev/null 2>&1; then
  say_fail "git not found."
  say_fail "Install with: xcode-select --install"
  note_failure
else
  say_ok "git $(git --version | awk '{print $3}')"
fi

# ----------------------------------------------------------------------
# 4. Node.js (>= 22.14)
# ----------------------------------------------------------------------
say_step "Checking Node.js (>= 22.14.0)"
NODE_MIN="22.14.0"
if ! command -v node >/dev/null 2>&1; then
  say_fail "Node.js not found."
  if [[ $HAS_BREW -eq 1 ]]; then
    say_fail "Install with: brew install node@22"
  else
    say_fail "Install LTS from https://nodejs.org (or install Homebrew first, then brew install node@22)"
  fi
  note_failure
else
  NODE_CURRENT=$(node -e 'process.stdout.write(process.versions.node)')
  MIN_WINNER=$(printf '%s\n%s\n' "$NODE_MIN" "$NODE_CURRENT" | sort -V | head -n1)
  if [[ "$MIN_WINNER" != "$NODE_MIN" ]]; then
    say_fail "Node $NODE_CURRENT found, but $NODE_MIN+ required."
    if [[ $HAS_BREW -eq 1 ]]; then
      say_fail "Upgrade with: brew install node@22 && brew link --overwrite node@22"
    else
      say_fail "Upgrade from https://nodejs.org"
    fi
    note_failure
  else
    say_ok "Node $NODE_CURRENT"
  fi
fi

# ----------------------------------------------------------------------
# 5. Ollama — installed
# ----------------------------------------------------------------------
say_step "Checking Ollama"
OLLAMA_APP="/Applications/Ollama.app"
if command -v ollama >/dev/null 2>&1 || [[ -d "$OLLAMA_APP" ]]; then
  say_ok "Ollama installed"
  OLLAMA_PRESENT=1
else
  say_fail "Ollama not found."
  say_fail "Download from https://ollama.com"
  if [[ $HAS_BREW -eq 1 ]]; then
    say_fail "Or: brew install --cask ollama"
  fi
  note_failure
  OLLAMA_PRESENT=0
fi

# ----------------------------------------------------------------------
# 6. Ollama — running
# ----------------------------------------------------------------------
if [[ $OLLAMA_PRESENT -eq 1 ]]; then
  say_step "Checking Ollama daemon (localhost:11434)"
  if curl -fsS --max-time 3 http://localhost:11434/api/version >/dev/null 2>&1; then
    say_ok "Ollama is running"
  else
    say_warn "Ollama is installed but not running."
    say_warn "Open Ollama.app (or run 'ollama serve' in a spare Terminal), then re-run this script."
    note_failure
  fi
fi

# ----------------------------------------------------------------------
# 7. Ollama — glm-5:cloud model
# ----------------------------------------------------------------------
if [[ $OLLAMA_PRESENT -eq 1 ]] && curl -fsS --max-time 3 http://localhost:11434/api/version >/dev/null 2>&1; then
  say_step "Checking glm-5:cloud model"
  if ollama list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "glm-5:cloud"; then
    say_ok "glm-5:cloud already pulled"
  else
    say_warn "glm-5:cloud not pulled yet — attempting now (requires a free Ollama account)."
    say_info "If this fails with 'please sign in', run:  ollama signin  then re-run this script."
    if ollama pull glm-5:cloud; then
      say_ok "glm-5:cloud pulled"
    else
      say_fail "Pull failed. Try 'ollama signin' then re-run this script."
      note_failure
    fi
  fi
fi

# ----------------------------------------------------------------------
# 8. Repo prerequisites: npm install
# ----------------------------------------------------------------------
if [[ $FAILURES -eq 0 ]]; then
  say_step "Running npm install (this takes a few minutes)"
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
  cd "$REPO_ROOT"
  if ! npm install --no-audit --no-fund; then
    say_fail "npm install failed. See output above."
    note_failure
  else
    say_ok "npm install complete"
  fi
else
  say_warn "Skipping npm install — please fix the issues above first and re-run."
fi

# ----------------------------------------------------------------------
# 9. Sanity-check critical binaries
# ----------------------------------------------------------------------
if [[ $FAILURES -eq 0 ]]; then
  say_step "Verifying critical dependencies"
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
  if [[ -f "$REPO_ROOT/node_modules/.bin/openclaw" ]]; then
    say_ok "openclaw binary present"
  else
    say_fail "openclaw binary not found in node_modules — npm install may be incomplete."
    note_failure
  fi
  if [[ -d "$REPO_ROOT/node_modules/better-sqlite3" ]]; then
    say_ok "better-sqlite3 native module present"
  else
    say_fail "better-sqlite3 not found — npm install may be incomplete."
    note_failure
  fi
fi

# ----------------------------------------------------------------------
# 10. Port check (informational)
# ----------------------------------------------------------------------
say_step "Checking default gateway port 18789"
if lsof -i :18789 >/dev/null 2>&1; then
  say_warn "Port 18789 is in use — the app will auto-pick the next free port on launch."
else
  say_ok "Port 18789 free"
fi

# ----------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------
echo
if [[ $FAILURES -eq 0 ]]; then
  printf "%s%sYou're set.%s\n" "$GREEN" "$BOLD" "$RESET"
  echo "Start the app with: ${BOLD}npm start${RESET}"
  echo
  echo "On first launch you'll walk through naming your agent and setting your values."
  echo "If anything breaks, paste the error output back to Chris."
else
  printf "%s%s$FAILURES item(s) need attention.%s\n" "$RED" "$BOLD" "$RESET"
  echo "Fix the issues flagged above, then re-run this script."
  exit 1
fi
