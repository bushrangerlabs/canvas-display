# Phase 0 Content Bridge prototype

This isolated Node/TypeScript prototype validates the security and browser-origin contract for the future Rust Edge Content Bridge. It does **not** replace or modify current production YouTube routes.

## Properties under test

- Binds only to `127.0.0.1`.
- Requires the exact loopback `Host` and same origin for mutation requests.
- Serves generic HTML/JS/CSS containing no candidate IDs or session secrets.
- Places the initial one-use claim token in the URL fragment, which is not sent in the HTTP request or referrer.
- Removes the fragment from browser history before loading YouTube.
- Exchanges the claim once for an in-memory, session-scoped event token.
- Validates playback ID, event name, candidate index/count, and video ID.
- Uses a strict CSP without `unsafe-inline`/`unsafe-eval`.
- Uses `strict-origin-when-cross-origin`, `enablejsapi=1`, and exact `origin: window.location.origin`.
- Exposes no fleet API, database, HA credential, admin UI, MQTT, or voice route.

## Automated tests

```bash
npm run test:content-bridge
```

These tests validate loopback binding, Host/origin enforcement, one-use claim, callback authorization, expiry, CSP/referrer headers, and secret-free assets.

## Manual WebKitGTK validation

The automated tests cannot prove that YouTube reaches `playing` in WebKitGTK. Run this development-only helper with a public YouTube video ID:

```bash
npm run prototype:content-bridge -- 3_TvpBwSZDM
```

Open the printed URL in the target Tauri/WebKitGTK WebView and capture:

- parent URL and exact origin;
- outgoing `Referer` behavior at the network boundary;
- IFrame API `ready`, `playing`, and error events;
- error 153 absence;
- hostile Host/origin/callback rejection;
- no claim/event token in HTTP logs, referrers, history after startup, or player requests.

This must pass on a supported `amd64` PC and a real Bookworm-compatible `arm64` Raspberry Pi runtime before Phase 0 exits. A Debian 13/Trixie Pi run is useful development evidence but does not replace Bookworm acceptance.
