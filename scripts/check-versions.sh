#!/usr/bin/env bash
# Version-number reminder/check for Canvas Core + Edge device updates.
#
# Every version location is listed below. Bump them TOGETHER when shipping a
# Core or Edge update so devices can detect the new version:
#
#   Core         → core/src/version.ts (CORE_VERSION, reported by /health + API)
#                  core/package.json (version)
#   Android Edge → browser/android-native/app/build.gradle.kts (versionCode + versionName;
#                  versionName is sent in edge.hello via BuildConfig.VERSION_NAME)
#   Rust Agent   → edge/Cargo.toml ([workspace.package] version; reported in edge.hello)
#   Linux Edge   → browser/linux/src-tauri/tauri.conf.json (version)
#                  browser/linux/src-tauri/Cargo.toml (version)
#                  browser/linux/package.json (version)
#   HA add-on    → config.yaml (version)
#
# Run this before/after a release to see what still needs bumping.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "== Core =="
grep -H "CORE_VERSION" "$ROOT/core/src/version.ts"
grep -H '"version"' "$ROOT/core/package.json"

echo "== Android Edge =="
grep -HnE 'versionCode|versionName' "$ROOT/browser/android-native/app/build.gradle.kts"
grep -Hn "BuildConfig.VERSION_NAME" "$ROOT/browser/android-native/app/src/main/java/com/bushrangerlabs/canvas_display_edge/CoreEdgeClient.kt"

echo "== Rust Agent =="
awk '/^\[workspace.package\]/{p=1; next} p&&/^version =/{print FILENAME":"FNR": "$0; exit}' "$ROOT/edge/Cargo.toml"

echo "== Linux Edge =="
grep -H '"version"' "$ROOT/browser/linux/src-tauri/tauri.conf.json"
grep -H '^version' "$ROOT/browser/linux/src-tauri/Cargo.toml"
grep -H '"version"' "$ROOT/browser/linux/package.json"

echo "== HA add-on =="
grep -H '^version' "$ROOT/config.yaml" | head -1

echo ""
echo "⚠️  REMINDER: bump EVERY one of the above when shipping a Core or Edge update,"
echo "    so devices can detect the new version."
echo "    Core → version.ts + package.json"
echo "    Android Edge → versionName (+versionCode)"
echo "    Rust Agent → edge/Cargo.toml [workspace.package] version"
echo "    Linux Edge → tauri.conf.json + Cargo.toml + package.json + useServerSocket.ts"