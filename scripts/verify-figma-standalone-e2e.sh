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
#                                        credentials, no vault reads by the harness). These
#                                        E2E_* vars stay in THIS process only — stripped from
#                                        the daemon/desktop/Metro child env so the booted app
#                                        never re-reads them (the isolated daemon home's sealed
#                                        vault is its only credential source).
#   JAGENTDESK_FIGMA_E2E_FILE_KEY        real file key/URL — REQUIRED; no user-file default
#                                        lives in the harness (the parent's file is private,
#                                        its link stays in /tmp evidence only)
#   JAGENTDESK_FIGMA_E2E_FRAME_IDS       comma-separated frame ids (default: discovered from the outline)
#   JAGENTDESK_FIGMA_STANDALONE_E2E_NO_PICKER_PROBE=1
#                                        user-AWAY mode: the native probe already reached
#                                        figma.com/login and was closed — do NOT open a second
#                                        login window. The website-selection gates are recorded
#                                        BLOCKED/UNEXERCISED (never skipped to green) while the
#                                        independent API proof and real UI read/perf gates run.
#                                        Default acceptance still requires ALL-PASS, so this
#                                        mode reports overall RED.
# A missing credential, 403, or website session is a RED with the unexercised gates listed —
# it never skips to green.
#
# The desktop dist is NOT built here: the harness requires packages/desktop/dist/main.js and
# fails RED naming the integrator-owned merged build when it is absent.
# The production daemon on port 6767 and the installed app are never touched.
# Boot is an ISOLATED LOOPBACK READ TEST: the tailnet bridge is disabled for the children
# (JAGENTDESK_TAILSCALE_ENABLED=0) and no separate Tailscale daemon is started — this run
# never claims tailnet acceptance and needs no FigmaDesktop or Link plugin. The harness-owned
# daemon boots with the product's own JAGENTDESK_DESKTOP_MANAGED=1 so the Desktop daemon
# manager genuinely recognizes and REUSES it (root run 4: an unmanaged external daemon was
# not reusable — the Local onboarding's start_desktop_daemon spawned a second daemon that
# died on the PID lock).
# boot-isolated-daemon PASSes only on a bounded WS server_info handshake with a usable wire
# serverId (a transiently open port false-passes). boot-electron-renderer is proven by the
# SUPPORTED product user flow observed live (bootstrap-registered built-in host on the reused
# managed daemon, or actual clicks: tailscale-login → Local → Continue with
# Local → welcome → Direct connection → 127.0.0.1 + reserved port → ONE Connect, the optional
# password field cleared before that submit); the rendered error screen fails fast and the
# desktop-managed IPC status is recorded as diagnostic only and never blocks; every
# page.evaluate IPC probe is individually deadline-bounded; teardown RECORDS the isolated
# home's managed-PID-lock holder in evidence for root review and never speculatively signals
# an untracked PID (no broad daemon scan, production daemon untouched). The fps bar passes only on
# main-frame DrawFrame trace events during continuous trusted input, attributed through
# SetLayerTreeId (missing correlation/input rate leaves it UNEXERCISED). No per-frame pixel
# readback or screencast-delivery rate is used. Link status is read before/after to keep the
# data proof attributable to standalone REST. Boot/output logs live under the artifact dir.
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
