#!/usr/bin/env bash
# W9 acceptance entry point for Figma standalone browsing + playback
# (ADR-0037, ADR-0038, ADR-0039, spec 32.11 incl. criterion #17).
#
# Tiers (kept visibly separate — scaffold/logic tests are NOT full E2E proof):
#   logic   protocol playback bounds + picker policy. No app, no network.
#   e2e     isolated daemon + real Electron app + real renderer navigation + picker
#           guest lifecycle + REST data flow + prototype request bounds + metrics.
#   all     logic then e2e (default).
#
# Runtime acceptance uses REAL data only — no mocks, no fabricated entities, no ALLOW_BLOCKED.
# BOTH required inputs are supplied by the parent at run time (the user is AWAY: no auth
# prompts, no manual-login attempt; missing website session stays BLOCKED, no green full-E2E):
#   JAGENTDESK_FIGMA_E2E_ACCESS_TOKEN    a valid access token (no refresh, no client
#                                        credentials, no vault reads by the harness)
#   JAGENTDESK_FIGMA_E2E_FILE_KEY        real file key/URL — REQUIRED; no user-file default
#                                        lives in the harness (the parent's file is private,
#                                        its link stays in /tmp evidence only)
#   JAGENTDESK_FIGMA_E2E_FRAME_IDS       comma-separated frame ids (default: discovered from the outline)
# A missing credential, 403, or website session is a RED with the unexercised gates listed —
# it never skips to green.
#
# The desktop dist is NOT built here: the harness requires packages/desktop/dist/main.js and
# fails RED naming the integrator-owned merged build when it is absent.
# The production daemon on port 6767 and the installed app are never touched.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
E2E_DIR="$ROOT_DIR/packages/desktop/e2e"

TIER="${1:-all}"
TIER="${TIER#--tier=}"
ARTIFACT_DIR="${JAGENTDESK_FIGMA_STANDALONE_E2E_ARTIFACT_DIR:-/tmp/jagentdesk-figma-redesign/evidence/w9}"
mkdir -p "$ARTIFACT_DIR"

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\033[31mFAIL: %s\033[0m\n' "$*"; exit 1; }

require_files() {
  local missing=0 file
  for file in "$@"; do
    if [[ ! -f "$file" ]]; then
      echo "missing $file"
      missing=1
    fi
  done
  [[ $missing -eq 0 ]] || fail "acceptance harness files are missing (run red until they exist)"
}

run_logic() {
  step "TIER logic — scaffold tests (playback contract bounds + picker policy)"
  require_files "$E2E_DIR/figma-standalone.logic.mjs"
  node --import tsx "$E2E_DIR/figma-standalone.logic.mjs" 2>&1 | tee "$ARTIFACT_DIR/logic.log"
  local code=${PIPESTATUS[0]}
  [[ $code -eq 0 ]] || fail "logic tier failed (exit $code) — see $ARTIFACT_DIR/logic.log"
  step "TIER logic passed"
}

run_e2e() {
  step "TIER e2e — real isolated app, picker lifecycle, data flow, performance evidence"
  require_files "$E2E_DIR/figma-standalone.e2e.mjs"
  # No auto-build here: a stale or missing desktop dist means the merged stack was never built
  # by the integrator. The harness gates it and names the prerequisite; building silently on
  # top of a half-merged tree would manufacture green.
  JAGENTDESK_FIGMA_STANDALONE_E2E_ARTIFACT_DIR="$ARTIFACT_DIR" \
    node "$E2E_DIR/figma-standalone.e2e.mjs" 2>&1 | tee "$ARTIFACT_DIR/e2e.log"
  local code=${PIPESTATUS[0]}
  [[ $code -eq 0 ]] || fail "e2e tier failed (exit $code) — gate table and evidence in $ARTIFACT_DIR"
  step "TIER e2e passed — evidence in $ARTIFACT_DIR"
}

case "$TIER" in
  logic) run_logic ;;
  e2e) run_e2e ;;
  all) run_logic; run_e2e ;;
  *) fail "unknown tier '$TIER' (expected: logic | e2e | all)" ;;
esac

step "verify-figma-standalone-e2e($TIER) complete"
