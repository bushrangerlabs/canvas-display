#!/usr/bin/env bash
# build-deb.sh <arch_label> <target_triple> <deb_arch> <deb_tag> <version>
#
# Builds a .deb package for a single architecture. Called by the CI workflow
# and by release-edge.sh. Arguments:
#   arch_label  - human-readable name (amd64, arm64)
#   target_triple - Rust target triple (x86_64-unknown-linux-gnu, aarch64-unknown-linux-gnu)
#   deb_arch    - dpkg architecture name (amd64, arm64)
#   deb_tag     - output filename suffix (amd64, arm64, arm64-trixie-dev)
#   version     - release version string

set -euo pipefail

ARCH_LABEL="$1"
TARGET_TRIPLE="$2"
DEB_ARCH="$3"
DEB_TAG="$4"
VERSION="$5"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARTIFACTS_DIR="$REPO_ROOT/artifacts"
mkdir -p "$ARTIFACTS_DIR"

TARGET_DIR="$REPO_ROOT/edge/target/$TARGET_TRIPLE/release"
AGENT_BIN="$TARGET_DIR/canvas-edge-agentd"
UPDATER_BIN="$TARGET_DIR/canvas-edge-updaterd"

if [[ ! -f "$AGENT_BIN" ]]; then
  echo "ERROR: $AGENT_BIN not found — build may have failed" >&2
  exit 1
fi
if [[ ! -f "$UPDATER_BIN" ]]; then
  echo "ERROR: $UPDATER_BIN not found — build may have failed" >&2
  exit 1
fi

# ── Create .deb package structure ──────────────────────────────────────────────
DEB_DIR=$(mktemp -d)
DEB_PKG_DIR="$DEB_DIR/canvas-edge_${VERSION}_${DEB_ARCH}"

mkdir -p "$DEB_PKG_DIR/DEBIAN"
mkdir -p "$DEB_PKG_DIR/usr/lib/canvas-edge"
mkdir -p "$DEB_PKG_DIR/etc/systemd/system"
mkdir -p "$DEB_PKG_DIR/usr/bin"

# Install binaries
install -m 0755 "$AGENT_BIN" "$DEB_PKG_DIR/usr/lib/canvas-edge/canvas-edge-agentd"
install -m 0755 "$UPDATER_BIN" "$DEB_PKG_DIR/usr/lib/canvas-edge/canvas-edge-updaterd"

# Install systemd units
install -m 0644 "$REPO_ROOT/packaging/systemd/canvas-edge-agent.service" \
  "$DEB_PKG_DIR/etc/systemd/system/canvas-edge-agent.service"
install -m 0644 "$REPO_ROOT/packaging/systemd/canvas-edge-updater.service" \
  "$DEB_PKG_DIR/etc/systemd/system/canvas-edge-updater.service"

# Symlinks for PATH compatibility
ln -s /usr/lib/canvas-edge/canvas-edge-agentd "$DEB_PKG_DIR/usr/bin/canvas-edge-agentd"
ln -s /usr/lib/canvas-edge/canvas-edge-updaterd "$DEB_PKG_DIR/usr/bin/canvas-edge-updaterd"

# Generate control file
INSTALLED_SIZE_MB=$(( ($(stat -c%s "$AGENT_BIN") + $(stat -c%s "$UPDATER_BIN")) / 1024 / 1024 + 2 ))
cat > "$DEB_PKG_DIR/DEBIAN/control" <<DEBCONTROL
Package: canvas-edge
Version: ${VERSION}
Architecture: ${DEB_ARCH}
Maintainer: Canvas Display Team <dev@canvas-display.example.com>
Installed-Size: ${INSTALLED_SIZE_MB}
Depends: systemd (>= 247), libc6 (>= 2.31)
Section: utils
Priority: optional
Homepage: https://github.com/bushrangerlabs/canvas-display
Description: Canvas Edge Agent and Updater
 Canvas Edge is the local execution plane for Canvas Display.
 This package provides the Edge Agent daemon and the independently
 supervised updater daemon with signed release verification.
DEBCONTROL

# Install maintainer scripts
if [[ -f "$REPO_ROOT/packaging/debian/postinst" ]]; then
  install -m 0755 "$REPO_ROOT/packaging/debian/postinst" "$DEB_PKG_DIR/DEBIAN/postinst"
fi
if [[ -f "$REPO_ROOT/packaging/debian/prerm" ]]; then
  install -m 0755 "$REPO_ROOT/packaging/debian/prerm" "$DEB_PKG_DIR/DEBIAN/prerm"
fi
if [[ -f "$REPO_ROOT/packaging/debian/postrm" ]]; then
  install -m 0755 "$REPO_ROOT/packaging/debian/postrm" "$DEB_PKG_DIR/DEBIAN/postrm"
fi

# Build .deb
DEB_FILENAME="canvas-edge_${VERSION}_${DEB_TAG}.deb"
fakeroot dpkg-deb --build "$DEB_PKG_DIR" "$ARTIFACTS_DIR/$DEB_FILENAME" 2>/dev/null || \
  dpkg-deb --build "$DEB_PKG_DIR" "$ARTIFACTS_DIR/$DEB_FILENAME"

echo "✓ Built $DEB_FILENAME"

# Store metadata for the signing step
SHA256=$(sha256sum "$ARTIFACTS_DIR/$DEB_FILENAME" | cut -d' ' -f1)
SIZE=$(stat -c%s "$ARTIFACTS_DIR/$DEB_FILENAME")
echo "$SHA256" > "$ARTIFACTS_DIR/.metadata_${DEB_TAG}_sha256"
echo "$SIZE" > "$ARTIFACTS_DIR/.metadata_${DEB_TAG}_size"
echo "$DEB_FILENAME" > "$ARTIFACTS_DIR/.metadata_${DEB_TAG}_filename"

# Cleanup
rm -rf "$DEB_DIR"