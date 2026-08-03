#!/bin/bash
set -e
REMOTE="spetchal@192.168.1.108"
DEST="/home/spetchal/canvas-core"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
npm --prefix "$REPO_ROOT/web" run build
rsync -a --delete "$REPO_ROOT/web/dist/" "$REPO_ROOT/core/public/"
npm --prefix "$REPO_ROOT/core" run build
tar czf - -C "$REPO_ROOT" \
  core/src core/test core/dist core/public core/package.json core/package-lock.json \
  core/tsconfig.json core/Dockerfile core/docker-compose.yml core/nginx.conf core/.env.example \
  core/au-weather-mcp-http \
  tests/hermes | ssh "$REMOTE" "cd $DEST && tar xzf -"
ssh "$REMOTE" "cd $DEST/core && COMPOSE_IGNORE_ORPHANS=true docker compose up -d --build 2>&1" | tail -6
ssh "$REMOTE" "cd $DEST/core && docker compose restart tls-proxy >/dev/null"
ssh "$REMOTE" "for attempt in \$(seq 1 30); do if curl --cacert $DEST/core/tls/ca.crt --fail --silent https://localhost:3100/health; then echo; exit 0; fi; sleep 2; done; echo 'Canvas Core did not become healthy within 60 seconds' >&2; exit 1"
