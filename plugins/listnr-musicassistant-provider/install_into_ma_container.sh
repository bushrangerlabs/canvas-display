#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./install_into_ma_container.sh <ma_container_name>
# Example:
#   ./install_into_ma_container.sh music-assistant

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <ma_container_name>" >&2
  exit 1
fi

MA_CONTAINER="$1"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "[1/5] Copy provider scaffold into container: $MA_CONTAINER"
docker cp "$SRC_DIR" "$MA_CONTAINER":/tmp/listnr-musicassistant-provider

echo "[2/5] Install Python dependency requests"
docker exec "$MA_CONTAINER" sh -lc 'python3 -m pip install --no-cache-dir requests>=2.31.0'

echo "[3/5] Resolve target providers path"
TARGET_PATH="$(docker exec "$MA_CONTAINER" sh -lc '
for p in \
  /config/providers \
  /data/providers \
  /usr/local/lib/python*/site-packages/music_assistant/providers \
  /app/music_assistant/providers
  do
    for c in $p; do
      if [ -d "$c" ] && [ -w "$c" ]; then echo "$c"; exit 0; fi
    done
  done
exit 1
' || true)"

if [[ -z "$TARGET_PATH" ]]; then
  echo "Could not find writable provider path in container." >&2
  echo "Check container filesystem and copy listnr_provider manually." >&2
  exit 1
fi

echo "Using target path: $TARGET_PATH"

echo "[4/5] Copy provider package"
docker exec "$MA_CONTAINER" sh -lc "mkdir -p '$TARGET_PATH/listnr_provider' && cp -a /tmp/listnr-musicassistant-provider/listnr_provider/. '$TARGET_PATH/listnr_provider/'"

echo "[5/5] Restart container"
docker restart "$MA_CONTAINER" >/dev/null

echo "Done. Tail logs with:"
echo "  docker logs $MA_CONTAINER --tail 200 | grep -Ei 'provider|listnr|error|traceback'"
