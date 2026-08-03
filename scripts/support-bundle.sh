#!/usr/bin/env bash
# ============================================================================
# Canvas Edge — Support Bundle Generator
# ============================================================================
# Collects system diagnostics, logs, and configuration into a timestamped,
# redacted tarball for troubleshooting.
#
# Usage:
#   bash scripts/support-bundle.sh [--output-dir <path>]
#
# Optionally uploads to CANVAS_SUPPORT_UPLOAD_URL when set.
# ============================================================================
set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ------------------------------------------------------------------
# Configuration
# ------------------------------------------------------------------
OUTPUT_DIR="${1:-${CANVAS_SUPPORT_BUNDLE_DIR:-/tmp}}"
if [[ "${1:-}" == "--output-dir" ]]; then
    OUTPUT_DIR="$2"
fi

HOSTNAME="$(hostname -s 2>/dev/null || echo "unknown")"
DATE_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BUNDLE_NAME="support-bundle_${HOSTNAME}_${DATE_STAMP}"
BUNDLE_DIR="$(mktemp -d "/tmp/${BUNDLE_NAME}.XXXXXX")"
TARBALL="${OUTPUT_DIR}/${BUNDLE_NAME}.tar.gz"

# Directories inside the bundle
DATA_DIR="${BUNDLE_DIR}/data"
LOGS_DIR="${BUNDLE_DIR}/logs"
SYSINFO_DIR="${BUNDLE_DIR}/system"
CONFIG_DIR="${BUNDLE_DIR}/config"
mkdir -p "${DATA_DIR}" "${LOGS_DIR}" "${SYSINFO_DIR}" "${CONFIG_DIR}"

# Redaction patterns (matched case-insensitively in values)
REDACT_PATTERNS=(
    "token"
    "password"
    "passwd"
    "secret"
    "credential"
    "certificate"
    "private.key"
    "private_key"
    "api_key"
    "apikey"
    "authorization"
    "bearer"
    "jwt"
    "session"
    "access_key"
    "accesskey"
)

# ------------------------------------------------------------------
# Helper functions
# ------------------------------------------------------------------

# Redact sensitive values in a file: replaces anything that looks like
# a token/password/secret after a known sensitive key with [REDACTED].
redact_file() {
    local file="$1"
    if [[ ! -f "${file}" ]]; then
        return
    fi
    local tmp="${file}.redacted"
    # Build a sed pattern that matches lines with sensitive keys and redacts the value
    # Pattern: match key=value or key: value or "key": "value"
    local pattern=""
    for pat in "${REDACT_PATTERNS[@]}"; do
        if [[ -n "${pattern}" ]]; then
            pattern="${pattern}|"
        fi
        pattern="${pattern}([Ii][Ss][Ss]|[Kk][Ee][Yy]|[Vv][Aa][Ll][Uu][Ee]|[Tt][Oo][Kk][Ee][Nn]|[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll]|[Cc][Ee][Rr][Tt][Ii][Ff][Ii][Cc][Aa][Tt][Ee]|[Bb][Ee][Aa][Rr][Ee][Rr]|[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]|[Aa][Pp][Ii]_[Kk][Ee][Yy]|[Aa][Pp][Ii][Kk][Ee][Yy]|[Jj][Ww][Tt]|[Ss][Ee][Ss][Ss][Ii][Oo][Nn]|[Tt][Oo][Kk][Ee][Nn])[=:][[:space:]]*[^[:space:]]+"
    done
    # Replace any value that looks like a hex string, base64 string, or UUID
    # after a sensitive key with [REDACTED]
    sed -E \
        -e "s/(${pattern})/\1 [REDACTED]/g" \
        -e 's/(token|secret|password|credential|private_key|api_key|authorization|bearer)[=:]["'"'"']?[^"'"'"'[:space:]]+/[REDACTED]/gi' \
        "${file}" > "${tmp}" 2>/dev/null || cp "${file}" "${tmp}"
    mv "${tmp}" "${file}"
}

# Run a command, capture output to a file, redact it
capture() {
    local dest="$1"
    shift
    local cmd=("$@")
    if "${cmd[@]}" > "${dest}" 2>&1; then
        redact_file "${dest}"
        echo "  OK   ${dest##*/}"
    else
        echo "  WARN ${dest##*/}: command failed (exit $?)"
        # Still keep partial output
        redact_file "${dest}" 2>/dev/null || true
    fi
}

# ------------------------------------------------------------------
# Banner
# ------------------------------------------------------------------
echo ""
echo "Canvas Edge — Support Bundle Generator"
echo "======================================="
echo "Host:    ${HOSTNAME}"
echo "Date:    ${DATE_STAMP}"
echo "Output:  ${TARBALL}"
echo ""

# ------------------------------------------------------------------
# 1. Edge Agent logs
# ------------------------------------------------------------------
echo "--- Collecting Edge Agent logs ---"
if command -v journalctl &>/dev/null; then
    capture "${LOGS_DIR}/canvas-edge-agent.log" \
        journalctl -u canvas-edge-agent --no-pager -n 500 --output=short-iso
    capture "${LOGS_DIR}/canvas-edge-updater.log" \
        journalctl -u canvas-edge-updater --no-pager -n 500 --output=short-iso
    # Also capture recent system journal for crash context
    capture "${LOGS_DIR}/journal-system.log" \
        journalctl --no-pager -n 200 --priority=err --output=short-iso
else
    echo "  SKIP  journalctl not available (not running under systemd)"
fi

# ------------------------------------------------------------------
# 2. Core reachability check
# ------------------------------------------------------------------
echo "--- Checking Core reachability ---"
CORE_URL="${CANVAS_EDGE_CORE_HTTP_URL:-http://127.0.0.1:3100}"
if command -v curl &>/dev/null; then
    capture "${DATA_DIR}/core-health.txt" \
        curl --connect-timeout 5 --max-time 10 -s -w "\nHTTP_CODE:%{http_code}\n" "${CORE_URL}/health" || true
else
    echo "  SKIP  curl not available"
fi

# ------------------------------------------------------------------
# 3. System information
# ------------------------------------------------------------------
echo "--- Collecting system information ---"
capture "${SYSINFO_DIR}/uname.txt" uname -a
if [[ -f /etc/os-release ]]; then
    cp /etc/os-release "${SYSINFO_DIR}/os-release"
    redact_file "${SYSINFO_DIR}/os-release"
fi
if [[ -f /etc/hostname ]]; then
    cp /etc/hostname "${SYSINFO_DIR}/hostname"
fi
capture "${SYSINFO_DIR}/uptime.txt" uptime
capture "${SYSINFO_DIR}/dmesg.txt" dmesg -l err,warn 2>/dev/null || dmesg 2>/dev/null || echo "dmesg not available"

# ------------------------------------------------------------------
# 4. Hardware information
# ------------------------------------------------------------------
echo "--- Collecting hardware information ---"
if [[ -f /proc/cpuinfo ]]; then
    cp /proc/cpuinfo "${SYSINFO_DIR}/cpuinfo"
    # Redact serial numbers that might be sensitive
    redact_file "${SYSINFO_DIR}/cpuinfo"
fi
capture "${SYSINFO_DIR}/memory.txt" free -m
capture "${SYSINFO_DIR}/disk.txt" df -h
if [[ -f /proc/meminfo ]]; then
    cp /proc/meminfo "${SYSINFO_DIR}/meminfo"
fi
if [[ -f /proc/loadavg ]]; then
    cp /proc/loadavg "${SYSINFO_DIR}/loadavg"
fi
capture "${SYSINFO_DIR}/temperature.txt" \
    cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null || echo "thermal zone not available"
capture "${SYSINFO_DIR}/disk-io.txt" iostat -x 1 2 2>/dev/null || echo "iostat not available"

# ------------------------------------------------------------------
# 5. Network information
# ------------------------------------------------------------------
echo "--- Collecting network information ---"
capture "${SYSINFO_DIR}/ip-addr.txt" ip addr 2>/dev/null || ifconfig 2>/dev/null || echo "neither ip nor ifconfig available"
capture "${SYSINFO_DIR}/ss-listening.txt" ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || echo "neither ss nor netstat available"
capture "${SYSINFO_DIR}/network-connections.txt" ss -tunp 2>/dev/null || netstat -tunp 2>/dev/null || echo "n/a"
capture "${SYSINFO_DIR}/resolvectl.txt" resolvectl status 2>/dev/null || echo "resolvectl not available"

# Redact IP addresses in certain files? Not doing that since internal IPs are
# expected in support bundles. But we do redact the ss output for tokens.
redact_file "${SYSINFO_DIR}/ss-listening.txt" 2>/dev/null || true

# ------------------------------------------------------------------
# 6. Audio information
# ------------------------------------------------------------------
echo "--- Collecting audio information ---"
if command -v pactl &>/dev/null; then
    capture "${SYSINFO_DIR}/pactl-info.txt" pactl info 2>/dev/null || echo "pactl info failed"
    # List sinks/sources without detailed device info that might contain PII
    capture "${SYSINFO_DIR}/pactl-sinks.txt" pactl list sinks short 2>/dev/null || echo "n/a"
    capture "${SYSINFO_DIR}/pactl-sources.txt" pactl list sources short 2>/dev/null || echo "n/a"
else
    echo "  SKIP  pactl not available (PulseAudio/PipeWire not installed)"
fi
if command -v aplay &>/dev/null; then
    capture "${SYSINFO_DIR}/aplay-devices.txt" aplay -l 2>/dev/null || echo "aplay -l failed"
else
    echo "  SKIP  aplay not available"
fi

# ------------------------------------------------------------------
# 7. Docker information
# ------------------------------------------------------------------
echo "--- Collecting Docker information ---"
if command -v docker &>/dev/null; then
    capture "${SYSINFO_DIR}/docker-version.txt" docker --version
    capture "${SYSINFO_DIR}/docker-ps.txt" docker ps --format 'table {{.ID}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || echo "docker ps failed"
    capture "${SYSINFO_DIR}/docker-info.txt" docker info 2>/dev/null || echo "docker info failed"
    # Redact the docker info output since it may contain tokens in registry config
    redact_file "${SYSINFO_DIR}/docker-info.txt" 2>/dev/null || true
else
    echo "  SKIP  docker not available"
fi

# ------------------------------------------------------------------
# 8. Edge Agent configuration
# ------------------------------------------------------------------
echo "--- Collecting Edge Agent configuration ---"
# Environment variables (redacted)
capture "${CONFIG_DIR}/env-sorted.txt" env -0 2>/dev/null | tr '\0' '\n' | sort || env | sort > "${CONFIG_DIR}/env-sorted.txt" 2>&1
redact_file "${CONFIG_DIR}/env-sorted.txt"

# Systemd unit files
if [[ -f /etc/systemd/system/canvas-edge-agent.service ]]; then
    cp /etc/systemd/system/canvas-edge-agent.service "${CONFIG_DIR}/canvas-edge-agent.service"
    redact_file "${CONFIG_DIR}/canvas-edge-agent.service"
elif [[ -f "${REPO_ROOT}/packaging/systemd/canvas-edge-agent.service" ]]; then
    cp "${REPO_ROOT}/packaging/systemd/canvas-edge-agent.service" "${CONFIG_DIR}/canvas-edge-agent.service"
fi
if [[ -f /etc/systemd/system/canvas-edge-updater.service ]]; then
    cp /etc/systemd/system/canvas-edge-updater.service "${CONFIG_DIR}/canvas-edge-updater.service"
    redact_file "${CONFIG_DIR}/canvas-edge-updater.service"
elif [[ -f "${REPO_ROOT}/packaging/systemd/canvas-edge-updater.service" ]]; then
    cp "${REPO_ROOT}/packaging/systemd/canvas-edge-updater.service" "${CONFIG_DIR}/canvas-edge-updater.service"
fi

# Data directory listing (structure only, not contents)
AGENT_DATA_DIR="${CANVAS_EDGE_AGENT_DATA_DIR:-/var/lib/canvas-edge-agent}"
if [[ -d "${AGENT_DATA_DIR}" ]]; then
    capture "${DATA_DIR}/agent-data-dir-ls.txt" find "${AGENT_DATA_DIR}" -type f -o -type l 2>/dev/null | head -100 || echo "find failed"
    redact_file "${DATA_DIR}/agent-data-dir-ls.txt" 2>/dev/null || true
else
    echo "  INFO  Agent data directory ${AGENT_DATA_DIR} not accessible"
fi

UPDATER_DATA_DIR="${CANVAS_EDGE_UPDATER_DATA_DIR:-/var/lib/canvas-edge-updater}"
if [[ -d "${UPDATER_DATA_DIR}" ]]; then
    capture "${DATA_DIR}/updater-data-dir-ls.txt" find "${UPDATER_DATA_DIR}" -type f -o -type l 2>/dev/null | head -100 || echo "find failed"
    redact_file "${DATA_DIR}/updater-data-dir-ls.txt" 2>/dev/null || true
fi

# ------------------------------------------------------------------
# 9. Version information
# ------------------------------------------------------------------
echo "--- Collecting version information ---"
TARGET_DIR="${REPO_ROOT}/target"
if [[ -f "${TARGET_DIR}/release/canvas-edge-agentd" ]]; then
    capture "${DATA_DIR}/agent-binary-version.txt" strings "${TARGET_DIR}/release/canvas-edge-agentd" 2>/dev/null \
        | grep -E '^[0-9]+\.[0-9]+\.[0-9]+' | head -5 || echo "version string not found"
fi

# Capture the Edge workspace Cargo.toml version
if [[ -f "${REPO_ROOT}/edge/Cargo.toml" ]]; then
    grep -E '^version' "${REPO_ROOT}/edge/Cargo.toml" > "${CONFIG_DIR}/workspace-version.txt" 2>/dev/null || true
fi

# ------------------------------------------------------------------
# 10. Manifest
# ------------------------------------------------------------------
echo "--- Creating bundle manifest ---"
cat > "${BUNDLE_DIR}/MANIFEST.txt" <<MANIFEST
Canvas Edge — Support Bundle
=============================
Generated:    ${DATE_STAMP}
Hostname:     ${HOSTNAME}
OS:           $(uname -s -r -m 2>/dev/null || echo "unknown")
Uptime:       $(uptime -s 2>/dev/null || uptime 2>/dev/null || echo "unknown")
Bundle tools: $(command -v journalctl >/dev/null && echo "journalctl" || true) $(command -v pactl >/dev/null && echo "pactl" || true) $(command -v docker >/dev/null && echo "docker" || true)

Contents:
  logs/               - Service logs and system journal excerpts
  system/             - OS, hardware, and network information
  config/             - Configuration files and environment
  data/               - Edge Agent diagnostics and Core health

Redaction:
  Sensitive values (tokens, passwords, secrets, certificates, API keys,
  authorization headers) are redacted before packing. This is a best-effort
  automated redaction — verify the bundle before sharing.
MANIFEST

# ------------------------------------------------------------------
# 11. Package
# ------------------------------------------------------------------
echo ""
echo "--- Creating tarball ---"
tar -czf "${TARBALL}" -C "$(dirname "${BUNDLE_DIR}")" "$(basename "${BUNDLE_DIR}")" 2>/dev/null

# Clean up temp directory
rm -rf "${BUNDLE_DIR}"

echo ""
echo "Support bundle created: ${TARBALL}"
echo "Size: $(du -h "${TARBALL}" | cut -f1)"
echo ""

# ------------------------------------------------------------------
# 12. Optional upload
# ------------------------------------------------------------------
if [[ -n "${CANVAS_SUPPORT_UPLOAD_URL:-}" ]]; then
    echo "--- Uploading to secure endpoint ---"
    if command -v curl &>/dev/null; then
        echo "Uploading to ${CANVAS_SUPPORT_UPLOAD_URL} ..."
        curl --connect-timeout 30 --max-time 120 \
            -X POST \
            -H "Content-Type: application/gzip" \
            --data-binary "@${TARBALL}" \
            "${CANVAS_SUPPORT_UPLOAD_URL}" \
            -o /dev/null -w "HTTP %{http_code}\n" \
            -s || echo "WARN: Upload failed"
        echo "Upload complete."
    else
        echo "WARN: curl not available, cannot upload"
        echo "Bundle saved locally at: ${TARBALL}"
    fi
fi

echo "Done."