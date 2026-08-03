#!/usr/bin/env bash
# generate-release-manifest.sh <version> <artifacts-dir>
#
# Generates a signed release manifest from the metadata files produced by
# build-deb.sh and the release-signer tool.
#
# Outputs:
#   <artifacts-dir>/canvas-edge_<version>_manifest.json   (signed manifest)
#   <artifacts-dir>/canvas-edge_<version>_manifest.sig    (detached signature)

set -euo pipefail

VERSION="$1"
ARTIFACTS_DIR="$2"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Configuration
PRODUCT="canvas-edge"
PROTOCOL_MIN=1
PROTOCOL_MAX=1
SCHEMA_MIN=1
SCHEMA_MAX=1
CHANNEL="stable"
HEALTH_CHECK_TIMEOUT=30
REQUIRED_DISK_MB=256

# Security counter: use the version's numeric prefix
SECURITY_COUNTER=$(echo "$VERSION" | grep -oP '^\d+' || echo "0")

# Signing key
SIGNING_KEY="${RELEASE_SIGNING_KEY:-}"
if [[ -z "$SIGNING_KEY" ]]; then
  echo "⚠  RELEASE_SIGNING_KEY unset — generating development key" >&2
  KEY_OUTPUT=$(cargo run --manifest-path "$REPO_ROOT/edge/Cargo.toml" -p canvas-edge-release-signer -- generate-key 2>&1)
  SIGNING_KEY=$(echo "$KEY_OUTPUT" | grep RELEASE_SIGNING_KEY | cut -d= -f2)
  TRUST_ROOT=$(echo "$KEY_OUTPUT" | grep RELEASE_TRUST_ROOT | cut -d= -f2)
else
  TRUST_ROOT=$(cargo run --manifest-path "$REPO_ROOT/edge/Cargo.toml" -p canvas-edge-release-signer -- generate-key 2>&1 | grep RELEASE_TRUST_ROOT | cut -d= -f2 || echo "unknown-dev-key")
fi

# Collect metadata for each architecture
declare -a ARCHES
for meta_file in "$ARTIFACTS_DIR"/.metadata_*_sha256; do
  [ -f "$meta_file" ] || continue
  arch_tag=$(echo "$meta_file" | sed 's/.*\.metadata_//; s/_sha256//')
  ARCHES+=("$arch_tag")
done

if [ ${#ARCHES[@]} -eq 0 ]; then
  echo "ERROR: no build metadata found in $ARTIFACTS_DIR" >&2
  exit 1
fi

echo "Found architectures: ${ARCHES[*]}"
echo "Signing with key: ${SIGNING_KEY:0:16}..."

# Generate manifest for each architecture (we sign them separately)
for arch_tag in "${ARCHES[@]}"; do
  sha256_file="$ARTIFACTS_DIR/.metadata_${arch_tag}_sha256"
  size_file="$ARTIFACTS_DIR/.metadata_${arch_tag}_size"
  filename_file="$ARTIFACTS_DIR/.metadata_${arch_tag}_filename"

  ARTIFACT_SHA256=$(cat "$sha256_file" 2>/dev/null || echo "0000000000000000000000000000000000000000000000000000000000000000")
  ARTIFACT_SIZE=$(cat "$size_file" 2>/dev/null || echo "0")
  ARTIFACT_FILENAME=$(cat "$filename_file" 2>/dev/null || echo "canvas-edge_${VERSION}_${arch_tag}.deb")

  # Map arch_tag to ReleaseManifest architecture enum
  case "$arch_tag" in
    amd64) ARCH_ENUM="amd64" ;;
    arm64) ARCH_ENUM="arm64" ;;
    arm64-trixie-dev) ARCH_ENUM="arm64" ;;
    *) ARCH_ENUM="$arch_tag" ;;
  esac

  # Create the manifest JSON input
  MANIFEST_INPUT=$(mktemp)
  cat > "$MANIFEST_INPUT" <<MANIFEST_JSON
{
  "product": "${PRODUCT}",
  "version": "${VERSION}",
  "architecture": "${ARCH_ENUM}",
  "protocol_min": ${PROTOCOL_MIN},
  "protocol_max": ${PROTOCOL_MAX},
  "artifact_url": "https://releases.canvas-display.example.com/edge/v${VERSION}/${ARTIFACT_FILENAME}",
  "artifact_size_bytes": ${ARTIFACT_SIZE},
  "artifact_sha256": "${ARTIFACT_SHA256}",
  "required_disk_bytes": $((REQUIRED_DISK_MB * 1024 * 1024)),
  "rollback_compatible_versions": ["canvas-edge_${VERSION}"],
  "channel": "${CHANNEL}",
  "health_check_timeout_secs": ${HEALTH_CHECK_TIMEOUT},
  "security_counter": ${SECURITY_COUNTER},
  "schema_min": ${SCHEMA_MIN},
  "schema_max": ${SCHEMA_MAX}
}
MANIFEST_JSON

  # Sign
  cargo run --manifest-path "$REPO_ROOT/edge/Cargo.toml" -p canvas-edge-release-signer -- \
    sign \
    --manifest "$MANIFEST_INPUT" \
    --key "$SIGNING_KEY" \
    --output-signed "$ARTIFACTS_DIR/canvas-edge_${VERSION}_manifest.json" \
    --output-sig "$ARTIFACTS_DIR/canvas-edge_${VERSION}_manifest.sig"

  rm -f "$MANIFEST_INPUT"
done

# Verify
cargo run --manifest-path "$REPO_ROOT/edge/Cargo.toml" -p canvas-edge-release-signer -- \
  verify \
  --signed "$ARTIFACTS_DIR/canvas-edge_${VERSION}_manifest.json" \
  --trust-root "$TRUST_ROOT" \
  > /dev/null

echo "✓ Signed manifest verified: $ARTIFACTS_DIR/canvas-edge_${VERSION}_manifest.json"
echo "✓ Detached signature: $ARTIFACTS_DIR/canvas-edge_${VERSION}_manifest.sig"