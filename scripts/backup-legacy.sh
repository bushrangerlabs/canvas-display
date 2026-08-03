#!/usr/bin/env bash
# ============================================================================
# Canvas Legacy — Phase 8 Backup and Reconciliation Script
# ============================================================================
# Takes a consistent final backup of all legacy data sources and generates a
# reconciliation report comparing Core's device list with the legacy database.
#
# Usage:
#   bash scripts/backup-legacy.sh [--output-dir <path>] [--incremental]
#   bash scripts/backup-legacy.sh --help
#
# Output:
#   <output-dir>/legacy-backup_<hostname>_<date>.tar.gz
#     Includes: MANIFEST.txt (SHA-256), IMPORT_REPORT.json
#
# Prerequisites:
#   - sha256sum (coreutils)
#   - curl (for Core API calls)
#   - sqlite3 (for Edge Agent database introspection)
# ============================================================================
set -euo pipefail
IFS=$'\n\t'

# ------------------------------------------------------------------
# Configuration
# ------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

OUTPUT_DIR=""
INCREMENTAL=false
VERBOSE=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --output-dir)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        --incremental)
            INCREMENTAL=true
            shift
            ;;
        --verbose|-v)
            VERBOSE=true
            shift
            ;;
        --help|-h)
            echo "Canvas Legacy Backup Script — Phase 8"
            echo ""
            echo "Usage: $0 [--output-dir <path>] [--incremental] [--verbose]"
            echo ""
            echo "  --output-dir <path>  Destination directory (default: current dir)"
            echo "  --incremental        Skip Core API reconciliation (for post-fence diffs)"
            echo "  --verbose, -v        Print detailed progress"
            echo "  --help, -h           Show this help message"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--output-dir <path>] [--incremental] [--verbose]"
            exit 1
            ;;
    esac
done

if [[ -z "${OUTPUT_DIR}" ]]; then
    OUTPUT_DIR="${PWD}"
fi

mkdir -p "${OUTPUT_DIR}"

HOSTNAME="$(hostname -s 2>/dev/null || echo "unknown")"
DATE_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_NAME="legacy-backup_${HOSTNAME}_${DATE_STAMP}"
BACKUP_DIR="$(mktemp -d "/tmp/${BACKUP_NAME}.XXXXXX")"
TARBALL="${OUTPUT_DIR}/${BACKUP_NAME}.tar.gz"

# Sub-directories inside the backup
DB_DIR="${BACKUP_DIR}/databases"
CONFIG_DIR="${BACKUP_DIR}/config"
SCENE_DIR="${BACKUP_DIR}/scenes"
WEB_DIR="${BACKUP_DIR}/web"
EDGE_DIR="${BACKUP_DIR}/edge-agent"
REPORT_DIR="${BACKUP_DIR}/reports"

for dir in "${DB_DIR}" "${CONFIG_DIR}" "${SCENE_DIR}" "${WEB_DIR}" "${EDGE_DIR}" "${REPORT_DIR}"; do
    mkdir -p "${dir}"
done

# ------------------------------------------------------------------
# Helper functions
# ------------------------------------------------------------------

log() {
    if [[ "${VERBOSE}" == true ]]; then
        echo "[$(date -u +%H:%M:%S)] $*"
    fi
}

warn() {
    echo "WARN: $*" >&2
}

error() {
    echo "ERROR: $*" >&2
}

# Compute SHA-256 of a file and append to MANIFEST
record_manifest() {
    local file="$1"
    local label="${2:-$(basename "${file}")}"
    if [[ -f "${file}" ]]; then
        local hash
        hash="$(sha256sum "${file}" | cut -d' ' -f1)"
        printf "%-80s %s\n" "${label}" "${hash}" >> "${BACKUP_DIR}/MANIFEST.txt"
    fi
}

# Safe copy with error handling
safe_copy() {
    local src="$1"
    local dst="$2"
    if [[ -f "${src}" ]]; then
        cp "${src}" "${dst}"
        log "  Copied: ${src}"
    elif [[ -d "${src}" ]]; then
        cp -r "${src}" "${dst}" 2>/dev/null || log "  Warning: partial copy of ${src}"
    else
        log "  Skipped (not found): ${src}"
    fi
}

# ------------------------------------------------------------------
# Banner
# ------------------------------------------------------------------
echo ""
echo "Canvas Legacy Backup — Phase 8"
echo "==============================="
echo "Host:    ${HOSTNAME}"
echo "Date:    ${DATE_STAMP}"
echo "Output:  ${TARBALL}"
if [[ "${INCREMENTAL}" == true ]]; then
    echo "Mode:    INCREMENTAL (skip Core reconciliation)"
fi
echo ""

# ------------------------------------------------------------------
# 1. Sidecar SQLite databases
# ------------------------------------------------------------------
echo "--- Backing up sidecar SQLite databases ---"

SIDECAR_DATA_DIR="${REPO_ROOT}/server/data"
if [[ -d "${SIDECAR_DATA_DIR}" ]]; then
    # Copy main DB files
    for pattern in "*.db" "*.db-wal" "*.db-shm"; do
        for f in "${SIDECAR_DATA_DIR}"/${pattern}; do
            if [[ -f "${f}" ]]; then
                safe_copy "${f}" "${DB_DIR}/"
            fi
        done
    done
    log "Sidecar databases backed up from ${SIDECAR_DATA_DIR}"
else
    log "No sidecar data directory found at ${SIDECAR_DATA_DIR}"
fi

# ------------------------------------------------------------------
# 2. Config files
# ------------------------------------------------------------------
echo "--- Backing up config files ---"

safe_copy "${REPO_ROOT}/config.yaml" "${CONFIG_DIR}/"
safe_copy "${REPO_ROOT}/run.sh" "${CONFIG_DIR}/"
safe_copy "${REPO_ROOT}/.env" "${CONFIG_DIR}/" 2>/dev/null || log "  No .env file found"

# Also capture any Docker Compose or build config files
safe_copy "${REPO_ROOT}/Dockerfile" "${CONFIG_DIR}/"
safe_copy "${REPO_ROOT}/build.yaml" "${CONFIG_DIR}/"
safe_copy "${REPO_ROOT}/repository.yaml" "${CONFIG_DIR}/"

# ------------------------------------------------------------------
# 3. Scene data / server public assets
# ------------------------------------------------------------------
echo "--- Backing up scene data and public assets ---"

PUBLIC_DIR="${REPO_ROOT}/server/public"
if [[ -d "${PUBLIC_DIR}" ]]; then
    mkdir -p "${SCENE_DIR}/public"
    cp -r "${PUBLIC_DIR}/." "${SCENE_DIR}/public/" 2>/dev/null
    log "Public assets backed up from ${PUBLIC_DIR}"
else
    log "No public directory found at ${PUBLIC_DIR}"
fi

# ------------------------------------------------------------------
# 4. Web UI build
# ------------------------------------------------------------------
echo "--- Backing up web UI build ---"

WEB_DIST="${REPO_ROOT}/web/dist"
if [[ -d "${WEB_DIST}" ]]; then
    mkdir -p "${WEB_DIR}/dist"
    cp -r "${WEB_DIST}/." "${WEB_DIR}/dist/" 2>/dev/null
    log "Web UI build backed up from ${WEB_DIST}"
else
    log "No web dist found at ${WEB_DIST}"
fi

# ------------------------------------------------------------------
# 5. Edge Agent SQLite database
# ------------------------------------------------------------------
echo "--- Backing up Edge Agent SQLite database ---"

EDGE_DB="/var/lib/canvas-edge-agent/agent.sqlite3"
if [[ -f "${EDGE_DB}" ]]; then
    safe_copy "${EDGE_DB}" "${EDGE_DIR}/"
    # Also capture WAL and SHM files
    for ext in "-wal" "-shm"; do
        if [[ -f "${EDGE_DB}${ext}" ]]; then
            safe_copy "${EDGE_DB}${ext}" "${EDGE_DIR}/"
        fi
    done
    log "Edge Agent database backed up from ${EDGE_DB}"
else
    log "No Edge Agent database found at ${EDGE_DB}"
fi

# ------------------------------------------------------------------
# 6. Generate SHA-256 manifest
# ------------------------------------------------------------------
echo "--- Generating manifest ---"

cat > "${BACKUP_DIR}/MANIFEST.txt" <<MANIFEST
Canvas Legacy Backup
====================
Generated: ${DATE_STAMP}
Hostname:  ${HOSTNAME}
Backup:    ${BACKUP_NAME}
Type:      $(${INCREMENTAL} && echo "incremental" || echo "full")

Files:
MANIFEST

# Record hashes for all backed-up files
while IFS= read -r -d '' file; do
    rel_path="${file#${BACKUP_DIR}/}"
    record_manifest "${file}" "${rel_path}"
done < <(find "${BACKUP_DIR}" -type f -not -name "MANIFEST.txt" -not -name "IMPORT_REPORT.json" -print0)

echo "" >> "${BACKUP_DIR}/MANIFEST.txt"
echo "--- SHA-256 verification command ---" >> "${BACKUP_DIR}/MANIFEST.txt"
echo "# To verify:" >> "${BACKUP_DIR}/MANIFEST.txt"
echo "#   cd <extract-dir> && sha256sum -c MANIFEST.txt" >> "${BACKUP_DIR}/MANIFEST.txt"

# ------------------------------------------------------------------
# 7. Generate import/reconciliation report
# ------------------------------------------------------------------
echo "--- Generating import/reconciliation report ---"

REPORT="${REPORT_DIR}/IMPORT_REPORT.json"

# Try to reach Core's API to get device list
CORE_URL="${CANVAS_CORE_URL:-http://localhost:3100}"
CORE_DEVICES="[]"
CORE_AVAILABLE=false

if command -v curl &>/dev/null; then
    log "Contacting Core at ${CORE_URL}/api/devices ..."
    CORE_RESPONSE="$(curl --connect-timeout 5 --max-time 10 -s "${CORE_URL}/api/devices" 2>/dev/null || true)"
    if [[ -n "${CORE_RESPONSE}" ]]; then
        # Extract device IDs (simple JSON parse, assumes format { devices: [ {id: ...}, ... ] })
        CORE_DEVICES="$(echo "${CORE_RESPONSE}" | grep -oP '"id"\s*:\s*"[^"]*"' | sed 's/"id"\s*:\s*"//;s/"//' | sort -u || echo "")"
        CORE_AVAILABLE=true
        log "Core API reachable — ${CORE_DEVICES} devices listed"
    else
        log "Core API not reachable at ${CORE_URL}/api/devices"
    fi
else
    log "curl not available — skipping Core API reconciliation"
fi

# Build the report
REPORT_JSON="{}"

# Legacy device data: check sidecar SQLite DBs for device tables
LEGACY_DEVICES="[]"
LEGACY_DB_COUNT=0
if command -v sqlite3 &>/dev/null; then
    for db_file in "${DB_DIR}"/*.db; do
        if [[ -f "${db_file}" ]]; then
            DEVICE_IDS="$(sqlite3 "${db_file}" "SELECT id FROM devices;" 2>/dev/null || true)"
            if [[ -n "${DEVICE_IDS}" ]]; then
                LEGACY_DEVICES="$(echo "${DEVICE_IDS}" | sort -u)"
            fi
            LEGACY_DB_COUNT=$((LEGACY_DB_COUNT + 1))
        fi
    done
fi

# Compare Core vs legacy device lists
MIGRATED_DEVICES=""
REMAINING_DEVICES=""

if [[ "${CORE_AVAILABLE}" == true && -n "${LEGACY_DEVICES}" ]]; then
    MIGRATED_DEVICES="$(echo "${CORE_DEVICES}" | grep -F -x -f <(echo "${LEGACY_DEVICES}") || true)"
    REMAINING_DEVICES="$(echo "${LEGACY_DEVICES}" | grep -v -F -x -f <(echo "${CORE_DEVICES}") || true)"
fi

# Handle empty arrays properly in JSON
migrated_count=0
remaining_count=0
migrated_json="[]"
remaining_json="[]"

if [[ -n "${MIGRATED_DEVICES}" ]]; then
    migrated_count="$(echo "${MIGRATED_DEVICES}" | wc -l)"
    migrated_json="$(echo "${MIGRATED_DEVICES}" | jq -R -s 'split("\n") | map(select(length > 0))' 2>/dev/null || echo "[]")"
fi
if [[ -n "${REMAINING_DEVICES}" ]]; then
    remaining_count="$(echo "${REMAINING_DEVICES}" | wc -l)"
    remaining_json="$(echo "${REMAINING_DEVICES}" | jq -R -s 'split("\n") | map(select(length > 0))' 2>/dev/null || echo "[]")"
fi

cat > "${REPORT}" <<REPORT
{
  "report_generated_at": "${DATE_STAMP}",
  "hostname": "${HOSTNAME}",
  "type": "$(${INCREMENTAL} && echo "incremental" || echo "full")",
  "core_api_available": ${CORE_AVAILABLE},
  "core_api_url": "${CORE_URL}",
  "legacy_databases_found": ${LEGACY_DB_COUNT},
  "migration_summary": {
    "migrated_devices_count": ${migrated_count},
    "remaining_devices_count": ${remaining_count}
  },
  "migrated_devices": ${migrated_json},
  "remaining_devices": ${remaining_json}
}
REPORT

echo "  Report written to ${REPORT}"

# ------------------------------------------------------------------
# 8. Package into tarball
# ------------------------------------------------------------------
echo ""
echo "--- Creating backup tarball ---"
tar -czf "${TARBALL}" -C "$(dirname "${BACKUP_DIR}")" "$(basename "${BACKUP_DIR}")" 2>/dev/null

# Clean up temp directory
rm -rf "${BACKUP_DIR}"

echo ""
echo "Legacy backup created: ${TARBALL}"
echo "Size: $(du -h "${TARBALL}" | cut -f1)"
echo ""

if [[ "${CORE_AVAILABLE}" == true ]]; then
    echo "Reconciliation report summary:"
    echo "  Migrated devices:  ${migrated_count}"
    echo "  Remaining devices: ${remaining_count}"
    echo "  Full report in the archive"
fi
echo ""
echo "Done."