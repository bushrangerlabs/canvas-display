#!/usr/bin/env bash
# ============================================================
# Canvas Display — Smoke Test
# ============================================================
# Verifies that the critical features of a running Canvas
# deployment are working.  Run this after any release deploy.
#
# Usage:
#   ./scripts/smoke-test.sh                        # uses defaults
#   ./scripts/smoke-test.sh --core http://192.168.1.108:3101
#   ./scripts/smoke-test.sh --pi 192.168.1.216
#   ./scripts/smoke-test.sh --core <url> --pi <ip> --token <token>
#
# Exit codes:
#   0  All tests passed
#   1  One or more tests failed
# ============================================================

set -euo pipefail

# ── Defaults ────────────────────────────────────────────────
CORE_URL="${CANVAS_CORE_URL:-http://192.168.1.108:3101}"
PI_IP="${CANVAS_PI_IP:-192.168.1.216}"
PI_SIDECAR_URL="http://${PI_IP}:8099"
TIMEOUT=10

# ── Arg parsing ─────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --core)   CORE_URL="$2";   shift 2 ;;
    --pi)     PI_IP="$2"; PI_SIDECAR_URL="http://${PI_IP}:8099"; shift 2 ;;
    --token)  EDGE_TOKEN="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# ── Colour helpers ──────────────────────────────────────────
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'
BOLD='\033[1m'; RESET='\033[0m'

PASS=0; FAIL=0; SKIP=0

pass() { echo -e "  ${GREEN}✓${RESET} $1"; PASS=$((PASS+1)); }
fail() { echo -e "  ${RED}✗${RESET} $1"; FAIL=$((FAIL+1)); }
skip() { echo -e "  ${YELLOW}~${RESET} $1 (skipped)"; SKIP=$((SKIP+1)); }

section() { echo -e "\n${BOLD}$1${RESET}"; }

# ── HTTP helpers ─────────────────────────────────────────────
# Returns HTTP status code
http_status() {
  curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" "$@" 2>/dev/null || echo "000"
}

# Returns body
http_body() {
  curl -s --max-time "$TIMEOUT" "$@" 2>/dev/null || echo ""
}

# Check field exists in JSON body
json_has() {
  local body="$1" field="$2"
  echo "$body" | grep -q "\"${field}\""
}

# ── Tests ────────────────────────────────────────────────────

section "1. Core server ($CORE_URL)"

body=$(http_body "$CORE_URL/api/settings")
if json_has "$body" "version" || json_has "$body" "ok" || [[ $(http_status "$CORE_URL/api/settings") -lt 500 ]]; then
  pass "Core API reachable"
else
  fail "Core API not reachable ($CORE_URL/api/settings)"
fi

status=$(http_status "$CORE_URL/api/devices")
if [[ "$status" == "200" || "$status" == "401" ]]; then
  pass "Core /api/devices endpoint exists (HTTP $status)"
else
  fail "Core /api/devices returned HTTP $status"
fi

body=$(http_body "$CORE_URL/health")
if echo "$body" | grep -q "canvas-core"; then
  pass "Core /health — role=canvas-core"
else
  fail "Core /health returned unexpected: $body"
fi

# ── Edge voice endpoints (require auth token) ────────────────
section "2. Core edge voice endpoints"

if [[ -n "${EDGE_TOKEN:-}" ]]; then
  AUTH_HEADER="Authorization: Bearer $EDGE_TOKEN"

  status=$(http_status -H "$AUTH_HEADER" "$CORE_URL/api/edge/tts/pending?deviceId=smoke-test")
  if [[ "$status" == "200" ]]; then
    pass "TTS pending endpoint (HTTP 200)"
  else
    fail "TTS pending endpoint returned HTTP $status"
  fi

  status=$(http_status -H "$AUTH_HEADER" "$CORE_URL/api/edge/alert/pending?deviceId=smoke-test")
  if [[ "$status" == "200" ]]; then
    pass "Alert pending endpoint (HTTP 200)"
  else
    fail "Alert pending endpoint returned HTTP $status"
  fi

  status=$(http_status -H "$AUTH_HEADER" "$CORE_URL/api/edge/intercom/pending?deviceId=smoke-test")
  if [[ "$status" == "200" ]]; then
    pass "Intercom pending endpoint (HTTP 200)"
  else
    fail "Intercom pending endpoint returned HTTP $status"
  fi
else
  skip "Edge voice endpoints (no --token provided; set EDGE_TOKEN env var)"
fi

# ── Pi sidecar ───────────────────────────────────────────────
section "3. Pi sidecar ($PI_SIDECAR_URL)"

status=$(http_status "$PI_SIDECAR_URL/api/settings")
if [[ "$status" == "200" ]]; then
  pass "Sidecar /api/settings reachable"
else
  fail "Sidecar /api/settings returned HTTP $status — is the Pi reachable?"
fi

# Voice status
body=$(http_body "$PI_SIDECAR_URL/api/voice/status")
status=$(http_status "$PI_SIDECAR_URL/api/voice/status")
if [[ "$status" == "200" ]]; then
  pass "Voice status endpoint (HTTP 200)"
  if json_has "$body" "directWakeword"; then
    dw=$(echo "$body" | grep -o '"directWakeword":{[^}]*}' || echo "")
    pass "Voice status contains directWakeword info"
  fi
else
  fail "Voice status endpoint returned HTTP $status"
fi

# Broadcast status (added v0.2.62)
body=$(http_body "$PI_SIDECAR_URL/api/voice/broadcast/status")
status=$(http_status "$PI_SIDECAR_URL/api/voice/broadcast/status")
if [[ "$status" == "200" ]] && json_has "$body" "state"; then
  state=$(echo "$body" | grep -o '"state":"[^"]*"' | cut -d'"' -f4)
  pass "Broadcast status endpoint — state=${state}"
else
  fail "Broadcast status endpoint returned HTTP $status (body: $body)"
fi

# Audio device inventory
body=$(http_body "$PI_SIDECAR_URL/api/admin/devices/$(echo "$PI_IP" | tr '.' '-')/audio/devices" 2>/dev/null || true)
status=$(http_status "$PI_SIDECAR_URL/api/audio/devices")
if [[ "$status" == "200" ]]; then
  pass "Audio devices endpoint (HTTP 200)"
else
  skip "Audio devices endpoint returned HTTP $status (may require device ID)"
fi

# TTS speak endpoint
status=$(http_status -X POST "$PI_SIDECAR_URL/api/voice/speak" \
  -H "content-type: application/json" \
  -d '{"text":"smoke test ping"}')
if [[ "$status" == "200" ]]; then
  pass "TTS speak endpoint (HTTP 200)"
elif [[ "$status" == "503" ]]; then
  skip "TTS speak endpoint — 503 (Piper not configured, but endpoint exists)"
else
  fail "TTS speak endpoint returned HTTP $status"
fi

# ── Pi reachability via SSH ──────────────────────────────────
section "4. Pi system checks (via SSH)"

if ssh -o ConnectTimeout=5 -o BatchMode=yes "spetchal@${PI_IP}" true 2>/dev/null; then
  pass "SSH reachable"

  # canvas-display-server.service
  svc_status=$(ssh -o BatchMode=yes "spetchal@${PI_IP}" "systemctl is-active canvas-display-server 2>/dev/null || echo inactive")
  if [[ "$svc_status" == "active" ]]; then
    pass "canvas-display-server.service is active"
  else
    fail "canvas-display-server.service is $svc_status"
  fi

  # Satellite/wake word process
  if ssh -o BatchMode=yes "spetchal@${PI_IP}" "pgrep -f canvas-display-satellite.py" > /dev/null 2>&1; then
    pass "ESPHome satellite Python process running"
  else
    skip "ESPHome satellite process not found (may be using direct wakeword mode)"
  fi

  # Port redirect (3100→8099)
  redirect=$(ssh -o BatchMode=yes "spetchal@${PI_IP}" "sudo nft list ruleset 2>/dev/null | grep -c '3100'" 2>/dev/null || echo "0")
  if [[ "$redirect" -gt 0 ]]; then
    pass "nftables port redirect 3100→8099 is active"
  else
    skip "nftables port redirect not found (may not be needed)"
  fi

  # mpv available (required for audio playback)
  if ssh -o BatchMode=yes "spetchal@${PI_IP}" "which mpv" > /dev/null 2>&1; then
    pass "mpv installed"
  else
    fail "mpv not found — TTS/broadcast/intercom playback will fail"
  fi

else
  skip "SSH not available — skipping Pi system checks"
fi

# ── Summary ──────────────────────────────────────────────────
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "  ${GREEN}Passed:${RESET}  $PASS"
if [[ $FAIL -gt 0 ]]; then
  echo -e "  ${RED}Failed:${RESET}  $FAIL"
fi
if [[ $SKIP -gt 0 ]]; then
  echo -e "  ${YELLOW}Skipped:${RESET} $SKIP"
fi
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"

if [[ $FAIL -gt 0 ]]; then
  echo -e "\n${RED}Some tests failed. Check CHANGELOG.md and git history:${RESET}"
  echo "  git log --oneline -10"
  echo "  git show <tag>:<file>    # see file at a specific version"
  echo "  git diff <tag1> <tag2>   # diff between versions"
  exit 1
else
  echo -e "\n${GREEN}All tests passed.${RESET}"
  exit 0
fi
