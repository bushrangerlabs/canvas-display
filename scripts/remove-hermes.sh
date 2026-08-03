#!/usr/bin/env bash
# ============================================================================
# Canvas Phase 8 — Hermes Runtime Removal Script
# ============================================================================
# Safely removes the Hermes runtime, plugins, settings, and deployment
# dependencies from the Canvas Core system. Defaults to --dry-run so you
# can inspect exactly what would be removed before committing.
#
# Usage:
#   bash scripts/remove-hermes.sh          # dry-run (default)
#   bash scripts/remove-hermes.sh --force  # actually remove
#   bash scripts/remove-hermes.sh --help   # show help
# ============================================================================
set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ------------------------------------------------------------------
# Configuration
# ------------------------------------------------------------------
DRY_RUN=true
VERBOSE=false

# Hermes identifiers
HERMES_CONTAINER_NAME="hermes"
HERMES_IMAGE_NAME="ghcr.io/nicholasgriffintn/hermes:latest"
HERMES_SYSTEMD_UNIT="canvas-hermes"
HERMES_ENV_VAR="CANVAS_CORE_HERMES_URL"

# Paths within the repo where Hermes plugin/config files may exist
HERMES_PLUGIN_DIRS=(
    "${REPO_ROOT}/plugins/hermes"
    "${REPO_ROOT}/packages/hermes"
)

# ------------------------------------------------------------------
# Parse arguments
# ------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
    case "$1" in
        --force)
            DRY_RUN=false
            shift
            ;;
        --verbose|-v)
            VERBOSE=true
            shift
            ;;
        --help|-h)
            echo "Canvas Phase 8 — Hermes Removal Script"
            echo ""
            echo "Usage: $0 [--force] [--verbose]"
            echo ""
            echo "  --force         Actually perform the removal (default: dry-run)"
            echo "  --verbose, -v   Print detailed progress"
            echo "  --help, -h      Show this help message"
            echo ""
            echo "Dry-run mode (default):"
            echo "  Inspects the system and reports what would be removed"
            echo "  without making any changes."
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--force] [--verbose]"
            exit 1
            ;;
    esac
done

# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

log() {
    if [[ "${VERBOSE}" == true ]]; then
        echo "[$(date -u +%H:%M:%S)] $*"
    fi
}

info() {
    echo "  • $*"
}

warn() {
    echo "  ! $*" >&2
}

action() {
    local label="$1"
    shift
    if [[ "${DRY_RUN}" == true ]]; then
        echo "  [DRY-RUN] ${label}"
    else
        echo "  [REMOVE]  ${label}"
        "$@"
    fi
}

# ------------------------------------------------------------------
# Banner
# ------------------------------------------------------------------
echo ""
echo "Canvas Phase 8 — Hermes Removal"
echo "================================"
if [[ "${DRY_RUN}" == true ]]; then
    echo "Mode: DRY-RUN (no changes will be made)"
    echo "Run with --force to perform actual removal"
else
    echo "Mode: FORCE (changes will be made)"
fi
echo ""

SUMMARY_REMOVED=()

# ------------------------------------------------------------------
# 1. Check if Hermes container is running
# ------------------------------------------------------------------
echo "--- Step 1: Check Hermes container ---"

HERMES_CONTAINER_RUNNING=false
HERMES_CONTAINER_EXISTS=false

if command -v docker &>/dev/null; then
    CONTAINER_ID="$(docker ps -q -f "name=${HERMES_CONTAINER_NAME}" 2>/dev/null || true)"
    if [[ -n "${CONTAINER_ID}" ]]; then
        HERMES_CONTAINER_RUNNING=true
        info "Hermes container is RUNNING (id: ${CONTAINER_ID})"
    else
        CONTAINER_EXISTS_ID="$(docker ps -aq -f "name=${HERMES_CONTAINER_NAME}" 2>/dev/null || true)"
        if [[ -n "${CONTAINER_EXISTS_ID}" ]]; then
            HERMES_CONTAINER_EXISTS=true
            info "Hermes container exists but is STOPPED (id: ${CONTAINER_EXISTS_ID})"
        else
            info "No Hermes container found"
        fi
    fi
else
    info "Docker not available — skipping container check"
fi

# ------------------------------------------------------------------
# 2. Check Hermes systemd unit
# ------------------------------------------------------------------
echo ""
echo "--- Step 2: Check Hermes systemd unit ---"

HERMES_UNIT_EXISTS=false
if command -v systemctl &>/dev/null; then
    if systemctl is-enabled "${HERMES_SYSTEMD_UNIT}" &>/dev/null 2>&1; then
        HERMES_UNIT_EXISTS=true
        info "Hermes systemd unit '${HERMES_SYSTEMD_UNIT}' is enabled"
    elif systemctl cat "${HERMES_SYSTEMD_UNIT}" &>/dev/null 2>&1; then
        HERMES_UNIT_EXISTS=true
        info "Hermes systemd unit '${HERMES_SYSTEMD_UNIT}' exists but is disabled"
    else
        info "No Hermes systemd unit found"
    fi
else
    info "systemctl not available"
fi

# ------------------------------------------------------------------
# 3. Remove Hermes config from Core env
# ------------------------------------------------------------------
echo ""
echo "--- Step 3: Check Hermes env configuration ---"

ENV_FILE="${REPO_ROOT}/.env"
HERMES_ENV_SET=false
if [[ -f "${ENV_FILE}" ]]; then
    if grep -q "^${HERMES_ENV_VAR}=" "${ENV_FILE}" 2>/dev/null; then
        HERMES_ENV_SET=true
        info "Hermes env var '${HERMES_ENV_VAR}' is set in .env"
    else
        info "Hermes env var not found in .env"
    fi
fi

# Also check docker-compose.yml
COMPOSE_FILE="${REPO_ROOT}/docker-compose.yml"
HERMES_COMPOSE_SERVICE=false
if [[ -f "${COMPOSE_FILE}" ]]; then
    if grep -qi "hermes" "${COMPOSE_FILE}" 2>/dev/null; then
        HERMES_COMPOSE_SERVICE=true
        info "Hermes service found in docker-compose.yml"
    fi
fi

# ------------------------------------------------------------------
# 4. Remove Hermes plugin files
# ------------------------------------------------------------------
echo ""
echo "--- Step 4: Check Hermes plugin directories ---"

for dir in "${HERMES_PLUGIN_DIRS[@]}"; do
    if [[ -d "${dir}" ]]; then
        info "Hermes plugin directory exists: ${dir}"
        SUMMARY_REMOVED+=("${dir}")
    fi
done

# Search for any files with 'hermes' in the name in plugins/ and packages/
HERMES_FILES=()
while IFS= read -r -d '' file; do
    HERMES_FILES+=("${file}")
done < <(find "${REPO_ROOT}/plugins" "${REPO_ROOT}/packages" -iname "*hermes*" -print0 2>/dev/null || true)

if [[ ${#HERMES_FILES[@]} -gt 0 ]]; then
    info "Hermes-related files found:"
    for f in "${HERMES_FILES[@]}"; do
        info "  ${f}"
    done
fi

# ------------------------------------------------------------------
# 5. Remove Hermes settings from the settings database
# ------------------------------------------------------------------
echo ""
echo "--- Step 5: Check Hermes settings in databases ---"

# Check for hermes-related settings in sidecar SQLite databases
SIDECAR_DATA_DIR="${REPO_ROOT}/server/data"
HERMES_DB_SETTINGS=false
if command -v sqlite3 &>/dev/null && [[ -d "${SIDECAR_DATA_DIR}" ]]; then
    for db_file in "${SIDECAR_DATA_DIR}"/*.db; do
        if [[ -f "${db_file}" ]]; then
            # Check for a settings table with hermes-related rows
            SETTINGS="$(sqlite3 "${db_file}" "SELECT key, value FROM settings WHERE key LIKE '%hermes%' OR value LIKE '%hermes%' LIMIT 10;" 2>/dev/null || true)"
            if [[ -n "${SETTINGS}" ]]; then
                HERMES_DB_SETTINGS=true
                info "Hermes settings found in ${db_file}:"
                echo "${SETTINGS}" | while IFS='|' read -r key value; do
                    info "  ${key} = ${value}"
                done
            fi
        fi
    done
fi

if [[ "${HERMES_DB_SETTINGS}" != true ]]; then
    info "No Hermes settings found in sidecar databases"
fi

# ------------------------------------------------------------------
# Perform removals (only in --force mode)
# ------------------------------------------------------------------
if [[ "${DRY_RUN}" != true ]]; then
    echo ""
    echo "--- Performing removals ---"

    # 1. Stop and remove Hermes container
    if command -v docker &>/dev/null; then
        if [[ "${HERMES_CONTAINER_RUNNING}" == true ]]; then
            action "Stopping Hermes container" docker stop "${HERMES_CONTAINER_NAME}"
            action "Removing Hermes container" docker rm "${HERMES_CONTAINER_NAME}"
            SUMMARY_REMOVED+=("docker container ${HERMES_CONTAINER_NAME}")
        elif [[ "${HERMES_CONTAINER_EXISTS}" == true ]]; then
            action "Removing stopped Hermes container" docker rm "${HERMES_CONTAINER_NAME}"
            SUMMARY_REMOVED+=("docker container ${HERMES_CONTAINER_NAME}")
        fi

        # Remove the Hermes image if it exists
        if docker image inspect "${HERMES_IMAGE_NAME}" &>/dev/null 2>&1; then
            action "Removing Hermes Docker image" docker rmi "${HERMES_IMAGE_NAME}" 2>/dev/null || true
            SUMMARY_REMOVED+=("docker image ${HERMES_IMAGE_NAME}")
        fi
    fi

    # 2. Stop and disable Hermes systemd unit
    if command -v systemctl &>/dev/null && [[ "${HERMES_UNIT_EXISTS}" == true ]]; then
        action "Stopping Hermes systemd unit" systemctl stop "${HERMES_SYSTEMD_UNIT}" 2>/dev/null || true
        action "Disabling Hermes systemd unit" systemctl disable "${HERMES_SYSTEMD_UNIT}" 2>/dev/null || true
        SUMMARY_REMOVED+=("systemd unit ${HERMES_SYSTEMD_UNIT}")
    fi

    # 3. Remove Hermes env var from .env
    if [[ -f "${ENV_FILE}" ]] && [[ "${HERMES_ENV_SET}" == true ]]; then
        action "Commenting out ${HERMES_ENV_VAR} in .env" \
            sed -i "s/^${HERMES_ENV_VAR}=/#${HERMES_ENV_VAR}= (removed by remove-hermes.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ))/" "${ENV_FILE}"
        SUMMARY_REMOVED+=("env var ${HERMES_ENV_VAR} in .env")
    fi

    # 4. Remove Hermes plugin directories
    for dir in "${HERMES_PLUGIN_DIRS[@]}"; do
        if [[ -d "${dir}" ]]; then
            action "Removing Hermes plugin directory: ${dir}" rm -rf "${dir}"
        fi
    done

    # 5. Remove Hermes-related files in plugins/packages
    for f in "${HERMES_FILES[@]}"; do
        action "Removing Hermes file: ${f}" rm -f "${f}"
        SUMMARY_REMOVED+=("${f}")
    done

    # 6. Remove Hermes settings from databases
    if [[ "${HERMES_DB_SETTINGS}" == true ]] && command -v sqlite3 &>/dev/null; then
        for db_file in "${SIDECAR_DATA_DIR}"/*.db; do
            if [[ -f "${db_file}" ]]; then
                KEY_COUNT="$(sqlite3 "${db_file}" "SELECT COUNT(*) FROM settings WHERE key LIKE '%hermes%' OR value LIKE '%hermes%';" 2>/dev/null || echo 0)"
                if [[ "${KEY_COUNT}" -gt 0 ]]; then
                    action "Removing ${KEY_COUNT} Hermes settings from ${db_file}" \
                        sqlite3 "${db_file}" "DELETE FROM settings WHERE key LIKE '%hermes%' OR value LIKE '%hermes%';"
                fi
            fi
        done
        SUMMARY_REMOVED+=("Hermes settings from sidecar databases")
    fi

    echo ""
    echo "All removals completed."
fi

# ------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------
echo ""
echo "--- Summary ---"
echo ""

if [[ "${DRY_RUN}" == true ]]; then
    echo "DRY-RUN complete. No changes were made."
    echo ""
    echo "The following items WOULD be removed with --force:"
fi

[[ "${HERMES_CONTAINER_RUNNING}" == true ]] && info "Hermes Docker container (RUNNING)"
[[ "${HERMES_CONTAINER_EXISTS}" == true ]] && info "Hermes Docker container (STOPPED)"
[[ "${HERMES_UNIT_EXISTS}" == true ]] && info "Hermes systemd unit"
[[ "${HERMES_ENV_SET}" == true ]] && info "Hermes env var in .env"
[[ "${HERMES_COMPOSE_SERVICE}" == true ]] && info "Hermes service in docker-compose.yml"
for dir in "${HERMES_PLUGIN_DIRS[@]}"; do
    [[ -d "${dir}" ]] && info "Hermes plugin directory: ${dir}"
done
[[ ${#HERMES_FILES[@]} -gt 0 ]] && info "${#HERMES_FILES[@]} Hermes-related files in plugins/packages"
[[ "${HERMES_DB_SETTINGS}" == true ]] && info "Hermes settings in sidecar databases"

if [[ "${DRY_RUN}" == true ]]; then
    echo ""
    echo "To perform actual removal, run:"
    echo "  $0 --force"
fi

echo ""
echo "Done."