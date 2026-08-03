# ADR 0007: Media resolution and the Edge Content Bridge

- Status: Accepted
- Date: 2026-07-18
- Decision IDs: D-007, P-006, O-005, O-013

## Context

Current YouTube playback depends on a local Fastify wrapper to provide a normal HTTP origin/referrer. Removing the sidecar without a replacement can reintroduce YouTube IFrame error 153. Core should not become the default media-byte relay.

## Decision

- Core owns media discovery, policy, candidate ranking, and session manifests.
- Edge owns actual playback and reports real player state/errors.
- YouTube uses the official Data API v3 and IFrame Player API. Canvas does not scrape, extract, download, cache, proxy, or transcode YouTube streams.
- Replace the full local server route with a minimal loopback-only Content Bridge on Edge.
- The bridge provides a stable exact origin, reviewed referrer policy, strict CSP, Host/origin/method limits, validated `postMessage`, and short-lived renderer-session capabilities.
- Secrets never appear in URLs or referrers. The bridge has no fleet API, admin UI, HA token, MQTT, voice orchestration, or LAN listener.
- Scene manifests are authenticated at acquisition and assets are verified by content hash. Separate scene signatures can be added later if export/multi-admin threats require them.

## Consequences

- Video bytes continue directly between the official player and YouTube.
- Existing media can continue through a Core restart.
- The bridge decision is validated on both WebKitGTK architectures before sidecar media routes are disabled.

## Validation gates

- Actual `playing` state succeeds without error 153 on `amd64` and `arm64`. Manual dev-only evidence recorded in `docs/PHASE_0_CONTENT_BRIDGE_MANUAL_VERIFICATION.md`: real `playing` observed on `amd64` (WebKitGTK 2.44.0) and Trixie-dev `arm64` (WebKitGTK 2.52.3) with zero error-153 occurrences across 3 attempts; genuine Bookworm `arm64` hardware evidence is still outstanding as a release gate.
- Network observation confirms exact origin/referrer behavior and no capability leakage.
- Hostile local/web origins and forged callbacks fail closed.
- Media command success requires an actual Edge player result, not merely an opened WebView.
