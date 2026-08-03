#!/usr/bin/env bash
set -euo pipefail

EXPECTED_ARCH="${1:-}"
MAX_GLIBC="${MAX_GLIBC:-2.36}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEB_DIR="${REPO_ROOT}/browser/linux/src-tauri/target/release/bundle/deb"

case "${EXPECTED_ARCH}" in
  amd64)
    EXPECTED_MACHINE="Advanced Micro Devices X86-64"
    ;;
  arm64)
    EXPECTED_MACHINE="AArch64"
    ;;
  *)
    echo "Usage: $0 <amd64|arm64>" >&2
    exit 2
    ;;
esac

mapfile -t DEBS < <(find "${DEB_DIR}" -maxdepth 1 -type f -name '*.deb' -print | sort)
if [[ "${#DEBS[@]}" -ne 1 ]]; then
  echo "Expected exactly one .deb in ${DEB_DIR}; found ${#DEBS[@]}" >&2
  printf '  %s\n' "${DEBS[@]:-}"
  exit 1
fi

DEB="${DEBS[0]}"
ACTUAL_ARCH="$(dpkg-deb -f "${DEB}" Architecture)"
if [[ "${ACTUAL_ARCH}" != "${EXPECTED_ARCH}" ]]; then
  echo "Debian architecture mismatch: expected ${EXPECTED_ARCH}, got ${ACTUAL_ARCH}" >&2
  exit 1
fi

ROOT="$(mktemp -d)"
DATA_DIR="$(mktemp -d)"
SERVER_PID=""
cleanup() {
  if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
  rm -rf "${ROOT}" "${DATA_DIR}"
}
trap cleanup EXIT

dpkg-deb -x "${DEB}" "${ROOT}"
APP="${ROOT}/usr/bin/canvas-display-browser-linux"
SIDECAR="${ROOT}/usr/bin/canvas-display-server"
ADDON="$(find "${ROOT}" -type f -name 'better_sqlite3.node' -print -quit)"

for FILE in "${APP}" "${SIDECAR}" "${ADDON}"; do
  if [[ ! -f "${FILE}" ]]; then
    echo "Expected packaged file not found: ${FILE}" >&2
    exit 1
  fi

  MACHINE="$(readelf -h "${FILE}" | sed -n 's/^[[:space:]]*Machine:[[:space:]]*//p')"
  if [[ "${MACHINE}" != "${EXPECTED_MACHINE}" ]]; then
    echo "ELF architecture mismatch for ${FILE}: expected ${EXPECTED_MACHINE}, got ${MACHINE}" >&2
    exit 1
  fi

  REQUIRED_GLIBC="$(
    readelf --version-info "${FILE}" 2>/dev/null \
      | sed -n 's/.*Name: GLIBC_\([0-9.]*\).*/\1/p' \
      | sort -Vu \
      | tail -n 1
  )"
  if [[ -n "${REQUIRED_GLIBC}" ]]; then
    HIGHEST="$(printf '%s\n%s\n' "${REQUIRED_GLIBC}" "${MAX_GLIBC}" | sort -V | tail -n 1)"
    if [[ "${HIGHEST}" != "${MAX_GLIBC}" ]]; then
      echo "glibc requirement too new for ${FILE}: GLIBC_${REQUIRED_GLIBC} > GLIBC_${MAX_GLIBC}" >&2
      exit 1
    fi
  fi

done

BINARY_RESOURCE_DIR="$(dirname "${ADDON}")"
SERVER_LOG="${DATA_DIR}/server.log"
PORT=31991

CANVAS_DATA_DIR="${DATA_DIR}" \
DB_PATH="${DATA_DIR}/canvas-display.db" \
IMAGES_DIR="${DATA_DIR}/images" \
NATIVE_BINDING_DIR="${BINARY_RESOURCE_DIR}" \
STATIC_DIR="${BINARY_RESOURCE_DIR}/public" \
HOST="127.0.0.1" \
PORT="${PORT}" \
LOG_LEVEL="error" \
"${SIDECAR}" >"${SERVER_LOG}" 2>&1 &
SERVER_PID="$!"

HEALTHY=0
for _ in {1..100}; do
  if curl --fail --silent "http://127.0.0.1:${PORT}/health" >/dev/null; then
    HEALTHY=1
    break
  fi
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "Packaged sidecar exited before becoming healthy:" >&2
    cat "${SERVER_LOG}" >&2
    exit 1
  fi
  sleep 0.1
done

if [[ "${HEALTHY}" -ne 1 ]]; then
  echo "Packaged sidecar did not become healthy:" >&2
  cat "${SERVER_LOG}" >&2
  exit 1
fi

kill "${SERVER_PID}"
wait "${SERVER_PID}" || true
SERVER_PID=""

echo "Verified ${DEB}: ${EXPECTED_ARCH}, GLIBC <= ${MAX_GLIBC}, packaged sidecar healthy"
