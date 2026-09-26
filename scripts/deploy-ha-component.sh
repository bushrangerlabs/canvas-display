#!/usr/bin/env bash
# Deploy the canvas_display Home Assistant custom component.
#
# HA's MQTT integration has no media_player platform, so the per-device media
# players come from this custom component (Core mode). Copy it into the HA
# config dir and add a Core-mode config entry.
#
# Usage:
#   HA_CONFIG_DIR=/path/to/ha/config ./scripts/deploy-ha-component.sh
#   # or over Samba:
#   HA_SMB_HOST=192.168.1.103 HA_SMB_USER=user HA_SMB_PASS=pass \
#     ./scripts/deploy-ha-component.sh
#
# Then in HA: Settings -> Devices & services -> Add integration -> Canvas
# Display, with:
#   Platform API URL : https://192.168.1.108:3100
#   API token        : (any non-empty value; unused in Core mode)
#   Core mode        : on
#   Edge voice token : the Core edge voice token
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/custom_components/canvas_display"
DEST_NAME="canvas_display"

if [[ ! -d "$SRC" ]]; then
  echo "error: $SRC not found" >&2
  exit 1
fi

if [[ -n "${HA_CONFIG_DIR:-}" ]]; then
  DEST="$HA_CONFIG_DIR/custom_components/$DEST_NAME"
  echo "Deploying to $DEST"
  mkdir -p "$(dirname "$DEST")"
  rm -rf "$DEST"
  cp -r "$SRC" "$DEST"
  find "$DEST" -name '__pycache__' -type d -prune -exec rm -rf {} +
  echo "Done. Restart Home Assistant (or reload the integration) to pick it up."
  exit 0
fi

if [[ -n "${HA_SMB_HOST:-}" ]]; then
  : "${HA_SMB_USER:?set HA_SMB_USER}"
  : "${HA_SMB_PASS:?set HA_SMB_PASS}"
  command -v smbclient >/dev/null || { echo "error: smbclient not installed" >&2; exit 1; }
  echo "Deploying to //$HA_SMB_HOST/config/custom_components/$DEST_NAME over Samba"
  smbclient "//$HA_SMB_HOST/config" -U "$HA_SMB_USER%$HA_SMB_PASS" \
    -c "prompt OFF; recurse ON; mkdir custom_components; cd custom_components; mkdir $DEST_NAME; cd $DEST_NAME; lcd $SRC; mput *"
  echo "Done. Restart Home Assistant (or reload the integration) to pick it up."
  exit 0
fi

echo "error: set HA_CONFIG_DIR, or HA_SMB_HOST + HA_SMB_USER + HA_SMB_PASS" >&2
exit 1
