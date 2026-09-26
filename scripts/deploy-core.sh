#!/bin/bash
set +x
set -euo pipefail
# Absolute public CA file on the REMOTE host; deliberately no checkout fallback.
: "${CANVAS_CORE_HEALTH_CA_FILE:?Set CANVAS_CORE_HEALTH_CA_FILE to the remote public CA file}"
case "$CANVAS_CORE_HEALTH_CA_FILE" in
  /*) ;;
  *) echo 'CANVAS_CORE_HEALTH_CA_FILE must be an absolute remote path' >&2; exit 1 ;;
esac
REMOTE="spetchal@192.168.1.108"
DEST="/home/spetchal/canvas-core"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
npm --prefix "$REPO_ROOT/web" run build
rsync -a --delete "$REPO_ROOT/web/dist/" "$REPO_ROOT/core/public/"
npm --prefix "$REPO_ROOT/core" run build
tar czf - -C "$REPO_ROOT" \
  core/src core/test core/dist core/public core/package.json core/package-lock.json \
  core/tsconfig.json core/Dockerfile core/docker-compose.yml core/nginx.conf core/.env.example \
  core/web_search_stdio.py core/ha_intents_stdio.py core/vendor \
  tests/hermes | ssh "$REMOTE" "cd $DEST && tar xzf -"
ssh "$REMOTE" "cd $DEST/core && COMPOSE_IGNORE_ORPHANS=true docker compose up -d --build 2>&1" | tail -6
ssh "$REMOTE" "cd $DEST/core && docker compose restart tls-proxy >/dev/null"
# Quote the path for the remote shell; do not source or print the remote .env.
ssh "$REMOTE" "bash -s -- $(printf '%q' "$CANVAS_CORE_HEALTH_CA_FILE")" <<'HEALTH_CHECK'
set +x
set -euo pipefail
ca_file=$1
if [ ! -f "$ca_file" ] || [ ! -r "$ca_file" ]; then
  echo 'Remote public health CA file is missing or unreadable' >&2
  exit 1
fi
for ((attempt = 1; attempt <= 30; attempt++)); do
  if curl --cacert "$ca_file" --fail --silent --show-error \
    --connect-timeout 2 --max-time 5 https://localhost:3100/health; then
    echo
    exit 0
  fi
  sleep 2
done
echo 'Canvas Core did not become healthy after 30 verified HTTPS attempts' >&2
exit 1
HEALTH_CHECK
