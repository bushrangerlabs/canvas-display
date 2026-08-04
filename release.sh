#!/usr/bin/env bash
# release.sh <version> "Release notes"
# Bumps config.yaml, builds web + server sidecar + deb, commits, tags, and pushes.
set -euo pipefail

VERSION="${1:-}"
NOTES="${2:-}"

if [[ -z "$VERSION" ]]; then
  echo "Usage: ./release.sh <version> \"Release notes\""
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

# ── 1. Bump version in config.yaml and tauri.conf.json ───────────────────────
sed -i "s/^version: .*/version: \"${VERSION}\"/" "$REPO_ROOT/config.yaml"
sed -i "s/\"version\": \".*\"/\"version\": \"${VERSION}\"/" "$REPO_ROOT/browser/linux/src-tauri/tauri.conf.json"
echo "✓ config.yaml + tauri.conf.json → $VERSION"

# ── 2. Build web ──────────────────────────────────────────────────────────────
echo "Building web…"
cd "$REPO_ROOT/web"
npm run build
cd "$REPO_ROOT"
echo "✓ web built"

# ── 2b. Copy web build → core/public (served by Canvas Core) ─────────────────
cp -r "$REPO_ROOT/web/dist/." "$REPO_ROOT/core/public/"
echo "✓ web assets copied → core/public/"

# ── 2c. Build Core TypeScript → dist/ (Docker image copies this) ─────────────
echo "Building Core TypeScript…"
cd "$REPO_ROOT/core"
npm run build
cd "$REPO_ROOT"
echo "✓ Core TypeScript built → core/dist/"

# ── 3. Build server sidecar binary ───────────────────────────────────────────
echo "Building server sidecar…"
cd "$REPO_ROOT/server"
npm run build:sidecar
cd "$REPO_ROOT"
echo "✓ server sidecar built"

# ── 4. Build Tauri .deb ───────────────────────────────────────────────────────
echo "Building Tauri .deb…"
cd "$REPO_ROOT/browser/linux"
npm run tauri build -- --bundles deb
cd "$REPO_ROOT"
echo "✓ .deb built → browser/linux/src-tauri/target/release/bundle/deb/"

# ── 5. Commit, tag, push ─────────────────────────────────────────────────────
git add -A
git commit -m "chore: release v${VERSION}${NOTES:+

${NOTES}}"
git tag "v${VERSION}"
git push origin main --tags
echo "✓ pushed v${VERSION}"

# ── 6. Deploy Core to 192.168.1.108 ──────────────────────────────────────────
CORE_HOST="192.168.1.108"
CORE_PATH="/home/spetchal/canvas-core"

if ssh -o ConnectTimeout=5 -o BatchMode=yes "$CORE_HOST" true 2>/dev/null; then
  echo "Deploying core to ${CORE_HOST}…"
  rsync -a --delete --exclude 'node_modules' --exclude '.git' \
    "$REPO_ROOT/core/" "${CORE_HOST}:${CORE_PATH}/core/"
  ssh "$CORE_HOST" "cd ${CORE_PATH} && docker compose up --build -d 2>&1 | tail -5"
  echo "✓ Core deployed and restarted on ${CORE_HOST}"
else
  echo "⚠ Core host ${CORE_HOST} unreachable — skipping auto-deploy. Run manually:"
  echo "  rsync -a --delete --exclude node_modules ${REPO_ROOT}/core/ ${CORE_HOST}:${CORE_PATH}/core/"
  echo "  ssh ${CORE_HOST} 'cd ${CORE_PATH} && docker compose up --build -d'"
fi
