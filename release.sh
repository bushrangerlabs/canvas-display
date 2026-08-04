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
