# Phase 0 — Content Bridge Manual WebKitGTK Verification

- Status: Recorded evidence (not a substitute for the automated test suite)
- Date: 2026-07-18
- Reviewed: 2026-07-31; historical snapshot, not a current release claim
- Related: ADR 0007 (`docs/adr/0007-media-and-content-bridge.md`)

## Purpose

The automated Content Bridge test suite (`edge/content-bridge-prototype/test/*.test.ts`) proves
Host/origin/method/CSP/token/expiry/leakage security properties, but cannot prove that a real
YouTube IFrame Player actually reaches the `playing` state inside a real WebKitGTK `WebView` on
each supported architecture, because that requires a live network round-trip to `youtube.com` and
a real GTK/Wayland or X11 display. This document records a manual, dev-only, credential-free
verification run of that specific gap on both supported release architectures.

This is **evidence**, not a new automated regression test. It is not wired into CI and is not a
substitute for `npm run test:contracts`.

## Method

A throwaway harness (`tools/manual-verification/webkit-content-bridge-check.py`) was written to:

1. Start the existing, unmodified `edge/content-bridge-prototype` loopback bridge server
   (`manual.ts`) against a real YouTube video ID.
2. Open the bridge's player URL in a real `WebKitGTK` `WebKit2.WebView` (PyGObject, WebKit2 4.1 +
   Gtk 3.0) on the machine's actual display (X11 on the dev PC, the active Wayland `labwc` session
   on the Pi).
3. Inject a `UserScript` restricted to `TOP_FRAME` / main world only (never `ALL_FRAMES`), so it
   only observes the bridge's own top-level page and never touches the cross-origin
   `youtube.com` iframe. The script monkey-patches `window.fetch` to forward the JSON body of any
   POST to the bridge's own `/events` endpoint — the same endpoint the bridge's real client JS
   (`assets.ts`) already calls — to a `script-message-received` handler, and also forwards
   `window.onerror` / `console.error` / `console.warn`.
4. Run a bounded (~30s) GLib main loop, terminating early on a terminal event
   (`playing`, `identity_error` = YouTube error 153, `player_error`, or `exhausted`).
5. Print every captured event as JSON and exit with a status code reflecting the outcome.

The harness does not modify `edge/content-bridge-prototype/*`; it is a pure external observer of
events the prototype's own code already emits. No credentials are logged, captured, or required —
the bridge issues its own one-time claim/event tokens per session, matching production behavior.

## Results

### `amd64` (local dev machine)

- OS: Linux Mint 22.2 (Ubuntu Noble base), x86_64, glibc 2.39
- WebKitGTK: 2.44.0
- Display: real X11 session (`DISPLAY=:0`)

| Video ID | Outcome | Notes |
|---|---|---|
| `dQw4w9WgXcQ` (Rick Astley) | `player_error` code `150`, twice, reproducibly | **Not** error 153. A generic "embedding not allowed" response from YouTube for this specific, extremely high-profile video ID under a loopback (`http://127.0.0.1:port`) origin. Plausibly an anti-abuse/rate heuristic on YouTube's side for a very frequently automated-tested video ID, not a WebKitGTK or Content Bridge defect — a different video succeeded from the exact same server/origin seconds later (see below). |
| `aqz-KE-bpKQ` (Big Buck Bunny trailer, CC-licensed) | **`playing`** | Real `ready` → `autoplay_blocked` → `playing` sequence observed via genuine network round-trip to `youtube.com`/`iframe_api`. Zero occurrences of `identity_error` (153). |

### `arm64` (Raspberry Pi 5, `192.168.1.216`) — labeled `trixie-dev`

- OS: Debian 13 "Trixie" (**not** Bookworm — this machine is dev-only evidence per project rules;
  it does **not** by itself satisfy the Bookworm-compatible `arm64` release gate)
- WebKitGTK: 2.52.3
- Display: active Wayland `labwc` session (`Desktop=rpd-labwc`, `wayland-0`)
- Node 20.19.6, `npx tsx` fetched cleanly from the npm registry

| Video ID | Outcome | Notes |
|---|---|---|
| `aqz-KE-bpKQ` (Big Buck Bunny trailer) | **`playing`** | Same `ready` → `autoplay_blocked` → `playing` sequence, over a genuine live network path from the Pi to `youtube.com`. Zero occurrences of `identity_error` (153). |

### Interpretation

- The Content Bridge's official-IFrame-API design reaches genuine `playing` state on both
  supported CPU architectures, using a real WebKitGTK engine, a real display session, and a live
  network round trip — this is the core risk ADR 0007 exists to retire, and it did not reproduce
  error 153 on either architecture across 3 total attempts.
- The one observed failure (`150` on `dQw4w9WgXcQ`) is a different YouTube-side embed-restriction
  response, not the identity/origin/referrer failure (153) that motivated this work, and did not
  recur on a second, less-automated-testing-attractive video ID from the same bridge instance.
  This is still worth tracking: **loopback origins may be more likely to trip YouTube-side
  anti-abuse heuristics for extremely high-profile video IDs**; this is a monitoring note for
  Phase 1/2 telemetry, not a blocking defect in the bridge design.
- This evidence satisfies the **architecture-level** intent of the Phase 0 gate on both `amd64`
  and `arm64`. It does **not** by itself satisfy the release-gate requirement for genuine
  **Bookworm** `arm64` hardware (glibc ≤ 2.36) — the Pi used here runs Trixie (glibc 2.41). A
  Bookworm-based arm64 image/device (or the pinned `ubuntu-22.04-arm` CI runner artifact) still
  needs to be checked before the release gate — as opposed to the Phase 0 architecture-decision
  gate — is declared satisfied.

## Reproduction

The harness lives in `tools/manual-verification/webkit-content-bridge-check.py` and is dev-only —
it is not part of the package build or CI. To reproduce on a given host:

```bash
# 1. Start the loopback bridge with a target YouTube video ID, logging to a file
npx tsx edge/content-bridge-prototype/manual.ts <videoId> > /tmp/bridge.log 2>&1 &

# 2. Point the harness at the log file (it parses the printed session URL)
python3 tools/manual-verification/webkit-content-bridge-check.py /tmp/bridge.log 30
```

Exit codes: `0` = `playing` observed, `1` = `identity_error` (153) or `player_error` observed,
`2` = timed out with no terminal event, `3` = usage/setup error. All captured events are always
printed as JSON.

## Outstanding

- Genuine Bookworm `arm64` hardware/image run (this document only covers Trixie-dev evidence).
- PC/Pi resource and latency baselines (tracked separately; not yet started).
