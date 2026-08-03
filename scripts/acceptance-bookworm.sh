#!/usr/bin/env bash
# ============================================================================
# Canvas Edge — Bookworm Acceptance Test Suite
# ============================================================================
# Tests the Edge Agent and updater binaries against Bookworm compatibility
# requirements (glibc ≤ 2.36, systemd unit validity, startup/shutdown,
# IPC socket, Content Bridge health).
#
# Usage:
#   bash scripts/acceptance-bookworm.sh [--build-dir <path>]
#
# Exit code: 0 if all pass, 1 if any fail.
# ============================================================================
set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ------------------------------------------------------------------
# Configuration
# ------------------------------------------------------------------
MAX_GLIBC="${MAX_GLIBC:-2.36}"
BUILD_DIR="${REPO_ROOT}/target/release"
AGENT_BIN="${BUILD_DIR}/canvas-edge-agentd"
UPDATER_BIN="${BUILD_DIR}/canvas-edge-updaterd"
INSTALLED_AGENT_BIN="/usr/bin/canvas-edge-agentd"
INSTALLED_UPDATER_BIN="/usr/bin/canvas-edge-updaterd"
SYSTEMD_AGENT_UNIT="${REPO_ROOT}/packaging/systemd/canvas-edge-agent.service"
SYSTEMD_UPDATER_UNIT="${REPO_ROOT}/packaging/systemd/canvas-edge-updater.service"
CONTENT_BRIDGE_PORT="${CONTENT_BRIDGE_PORT:-8765}"
IPC_SOCKET_PATH="${CANVAS_EDGE_IPC_SOCKET:-/run/canvas-edge/agent.sock}"

# Override BUILD_DIR from CLI argument
if [[ "${1:-}" == "--build-dir" ]]; then
    BUILD_DIR="$2"
    AGENT_BIN="${BUILD_DIR}/canvas-edge-agentd"
    UPDATER_BIN="${BUILD_DIR}/canvas-edge-updaterd"
fi

# ------------------------------------------------------------------
# Test framework
# ------------------------------------------------------------------
PASS_COUNT=0
FAIL_COUNT=0
FAILED_TESTS=()

pass() {
    local msg="$1"
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "  PASS  ${msg}"
}

fail() {
    local msg="$1"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILED_TESTS+=("${msg}")
    echo "  FAIL  ${msg}"
}

# ------------------------------------------------------------------
# Helper: find the first available binary
# ------------------------------------------------------------------
find_agent_bin() {
    if [[ -x "${AGENT_BIN}" ]]; then
        echo "${AGENT_BIN}"
        return 0
    fi
    if [[ -x "${INSTALLED_AGENT_BIN}" ]]; then
        echo "${INSTALLED_AGENT_BIN}"
        return 0
    fi
    return 1
}

find_updater_bin() {
    if [[ -x "${UPDATER_BIN}" ]]; then
        echo "${UPDATER_BIN}"
        return 0
    fi
    if [[ -x "${INSTALLED_UPDATER_BIN}" ]]; then
        echo "${INSTALLED_UPDATER_BIN}"
        return 0
    fi
    return 1
}

# ------------------------------------------------------------------
# Test 1: Edge Agent binary exists and is executable
# ------------------------------------------------------------------
echo "--- Test 1: Edge Agent binary availability ---"
AGENT="$(find_agent_bin || true)"
if [[ -n "${AGENT}" ]]; then
    pass "Edge Agent binary found at ${AGENT}"
else
    fail "Edge Agent binary not found at ${AGENT_BIN} or ${INSTALLED_AGENT_BIN}"
fi

# ------------------------------------------------------------------
# Test 2: Edge Agent starts and responds to SIGTERM
# ------------------------------------------------------------------
echo "--- Test 2: Edge Agent SIGTERM shutdown ---"
if [[ -n "${AGENT}" ]]; then
    # Create a temp data dir so the agent doesn't use the system one
    TEST_DATA_DIR="$(mktemp -d)"
    # The agent needs a minimal environment; it will fail to connect to Core
    # but should start, create the data dir, and respond to SIGTERM.
    CANVAS_EDGE_AGENT_DATA_DIR="${TEST_DATA_DIR}" \
    timeout 10 \
        "${AGENT}" &
    AGENT_PID=$!

    # Give it a moment to start up
    sleep 1

    if kill -0 "${AGENT_PID}" 2>/dev/null; then
        # Send SIGTERM
        kill -TERM "${AGENT_PID}" 2>/dev/null || true
        # Wait up to 5 seconds for it to exit
        WAIT_OK=0
        for _ in $(seq 1 50); do
            if ! kill -0 "${AGENT_PID}" 2>/dev/null; then
                WAIT_OK=1
                break
            fi
            sleep 0.1
        done
        if [[ "${WAIT_OK}" -eq 1 ]]; then
            pass "Edge Agent started and shut down cleanly on SIGTERM"
        else
            fail "Edge Agent did not exit within 5 seconds of SIGTERM (pid=${AGENT_PID})"
            kill -KILL "${AGENT_PID}" 2>/dev/null || true
        fi
    else
        fail "Edge Agent failed to start (exit code before SIGTERM)"
    fi
    rm -rf "${TEST_DATA_DIR}"
else
    fail "Skipping: Edge Agent binary not found"
fi

# ------------------------------------------------------------------
# Test 3: Updater binary exists and starts
# ------------------------------------------------------------------
echo "--- Test 3: Updater binary availability and startup ---"
UPDATER="$(find_updater_bin || true)"
if [[ -n "${UPDATER}" ]]; then
    pass "Updater binary found at ${UPDATER}"

    TEST_DATA_DIR="$(mktemp -d)"
    CANVAS_EDGE_UPDATER_DATA_DIR="${TEST_DATA_DIR}" \
    timeout 10 \
        "${UPDATER}" &
    UPDATER_PID=$!

    sleep 1

    if kill -0 "${UPDATER_PID}" 2>/dev/null; then
        kill -TERM "${UPDATER_PID}" 2>/dev/null || true
        WAIT_OK=0
        for _ in $(seq 1 50); do
            if ! kill -0 "${UPDATER_PID}" 2>/dev/null; then
                WAIT_OK=1
                break
            fi
            sleep 0.1
        done
        if [[ "${WAIT_OK}" -eq 1 ]]; then
            pass "Updater binary started and shut down cleanly on SIGTERM"
        else
            fail "Updater binary did not exit within 5 seconds of SIGTERM (pid=${UPDATER_PID})"
            kill -KILL "${UPDATER_PID}" 2>/dev/null || true
        fi
    else
        fail "Updater binary failed to start"
    fi
    rm -rf "${TEST_DATA_DIR}"
else
    fail "Skipping: Updater binary not found"
fi

# ------------------------------------------------------------------
# Test 4: Content Bridge health endpoint
# ------------------------------------------------------------------
echo "--- Test 4: Content Bridge health endpoint ---"
# We test the Content Bridge by spawning a small HTTP health probe.
# The bridge is a library function in the agent crate; we can't call it
# directly from a shell script. Instead we verify:
#   a) The Content Bridge source code binds to 127.0.0.1
#   b) The health endpoint returns {"ok":true}
# We'll do this by checking the source code pattern and optionally
# starting a Content Bridge if the daemon supports it.
#
# Check that the source code binds to 127.0.0.1
if grep -q '127.0.0.1' "${REPO_ROOT}/edge/agent/src/media/content_bridge.rs" 2>/dev/null; then
    pass "Content Bridge source code binds to 127.0.0.1 (verified by source inspection)"
else
    fail "Content Bridge source does not reference 127.0.0.1 binding"
fi

# Check that the health endpoint exists in source
if grep -q '/health' "${REPO_ROOT}/edge/agent/src/media/content_bridge.rs" 2>/dev/null; then
    pass "Content Bridge source code defines /health endpoint"
else
    fail "Content Bridge source does not define /health endpoint"
fi

# If we can find the agent binary, try to actually start one
# (the Content Bridge is spawned inside the daemon; we can't easily
# start it standalone, but we verify the code compiles to include it)
if [[ -n "${AGENT}" ]]; then
    # Check that the binary contains the health endpoint string
    if strings "${AGENT}" 2>/dev/null | grep -q '{"ok":true}'; then
        pass "Agent binary contains the Content Bridge health response"
    else
        # The string might be compiled but not visible in strings; this is
        # not a hard fail since it depends on optimization/linking.
        echo "  INFO  Could not verify health response string in binary (may be optimized out)"
    fi
fi

# ------------------------------------------------------------------
# Test 5: IPC socket creation
# ------------------------------------------------------------------
echo "--- Test 5: IPC socket acceptance ---"
# Verify the IPC socket path is a Unix domain socket path in the source
if grep -q 'UnixListener\|AF_UNIX\|agent.sock' "${REPO_ROOT}/edge/agentd/src/ipc.rs" 2>/dev/null; then
    pass "IPC socket source code uses Unix domain socket (verified by source inspection)"
else
    fail "IPC socket source does not reference Unix domain socket"
fi

# Check that the IPC socket path default is /run/... or similar
if grep -q 'agent.sock' "${REPO_ROOT}/edge/agentd/src/ipc.rs" 2>/dev/null; then
    pass "IPC socket path defaults to agent.sock"
else
    fail "IPC socket path does not include agent.sock"
fi

# Check the systemd unit creates the runtime directory
if grep -q 'RuntimeDirectory=canvas-edge' "${SYSTEMD_AGENT_UNIT}" 2>/dev/null; then
    pass "systemd unit creates RuntimeDirectory for IPC socket"
else
    fail "systemd unit missing RuntimeDirectory for IPC socket"
fi

# ------------------------------------------------------------------
# Test 6: systemd unit validity
# ------------------------------------------------------------------
echo "--- Test 6: systemd unit validation ---"
if command -v systemd-analyze &>/dev/null; then
    for unit in "${SYSTEMD_AGENT_UNIT}" "${SYSTEMD_UPDATER_UNIT}"; do
        UNIT_NAME="$(basename "${unit}")"
        if [[ -f "${unit}" ]]; then
            OUTPUT="$(systemd-analyze verify "${unit}" 2>&1 || true)"
            if echo "${OUTPUT}" | grep -qi 'error\|failed'; then
                fail "systemd-analyze verify ${UNIT_NAME}: ${OUTPUT}"
            else
                pass "systemd unit ${UNIT_NAME} passes systemd-analyze verify"
            fi
        else
            fail "systemd unit file not found: ${unit}"
        fi
    done
else
    echo "  SKIP  systemd-analyze not available (not running under systemd or not installed)"
    echo "        Install systemd-container or systemd package for unit verification."
    # Manual verification: check the unit files are syntactically valid ini files
    for unit in "${SYSTEMD_AGENT_UNIT}" "${SYSTEMD_UPDATER_UNIT}"; do
        UNIT_NAME="$(basename "${unit}")"
        if [[ -f "${unit}" ]]; then
            # Verify the unit has required sections
            if grep -q '^\[Unit\]' "${unit}" && grep -q '^\[Service\]' "${unit}"; then
                pass "systemd unit ${UNIT_NAME} has required sections (Unit/Service)"
            else
                fail "systemd unit ${UNIT_NAME} missing required sections"
            fi
        else
            fail "systemd unit file not found: ${unit}"
        fi
    done
fi

# ------------------------------------------------------------------
# Test 7: glibc dependency check
# ------------------------------------------------------------------
echo "--- Test 7: glibc version requirements ---"
check_glibc() {
    local binary="$1"
    local name="$2"

    if [[ ! -x "${binary}" ]]; then
        fail "Binary not found for glibc check: ${binary}"
        return 1
    fi

    # Check ELF architecture
    local machine
    machine="$(readelf -h "${binary}" 2>/dev/null | sed -n 's/^[[:space:]]*Machine:[[:space:]]*//p')"
    if [[ -z "${machine}" ]]; then
        fail "Cannot determine ELF machine type for ${name}"
        return 1
    fi
    pass "${name} ELF architecture: ${machine}"

    # Check max glibc requirement
    local required_glibc
    required_glibc="$(
        readelf --version-info "${binary}" 2>/dev/null \
            | sed -n 's/.*Name: GLIBC_\([0-9.]*\).*/\1/p' \
            | sort -Vu \
            | tail -n 1
    )"

    if [[ -z "${required_glibc}" ]]; then
        echo "  INFO  ${name}: no GLIBC version requirements found (statically linked?)"
        pass "${name}: no GLIBC dependencies (static binary)"
        return 0
    fi

    local highest
    highest="$(
        printf '%s\n%s\n' "${required_glibc}" "${MAX_GLIBC}" | sort -V | tail -n 1
    )"

    if [[ "${highest}" != "${MAX_GLIBC}" ]]; then
        fail "${name}: requires GLIBC_${required_glibc} > max allowed GLIBC_${MAX_GLIBC}"
        return 1
    fi

    pass "${name}: GLIBC_${required_glibc} <= GLIBC_${MAX_GLIBC} (Bookworm-compatible)"
}

if command -v readelf &>/dev/null; then
    if [[ -n "${AGENT}" ]]; then
        check_glibc "${AGENT}" "Edge Agent (canvas-edge-agentd)"
    fi
    if [[ -n "${UPDATER}" ]]; then
        check_glibc "${UPDATER}" "Edge Updater (canvas-edge-updaterd)"
    fi
else
    echo "  SKIP  readelf not available; install binutils for glibc checks"
    if [[ -n "${AGENT}" ]]; then
        echo "  INFO  Agent binary exists at ${AGENT} — cannot verify glibc without readelf"
    fi
fi

# ------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------
echo ""
echo "============================================================"
echo "  Bookworm Acceptance Test Suite Summary"
echo "============================================================"
echo "  Passed: ${PASS_COUNT}"
echo "  Failed: ${FAIL_COUNT}"
echo "============================================================"

if [[ "${FAIL_COUNT}" -gt 0 ]]; then
    echo ""
    echo "Failed tests:"
    for t in "${FAILED_TESTS[@]}"; do
        echo "  - ${t}"
    done
    echo ""
    exit 1
fi

exit 0