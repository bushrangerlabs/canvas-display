# Phase 4 Decision: Raw HA Panel Credential Handling & Cache Quota Design

**Status:** Approved target, not fully migrated; see `docs/ROADMAP.md`

**Date:** 2026-07-19

**Last reviewed:** 2026-07-31

**Authors:** Architecture Working Group  
**Relates to:** D-012 and O-009

---

## 1. Problem Statement

The Canvas Edge renderer (Tauri WebView) needs to display Home Assistant panels and pages that require authentication. These include:

- **Lovelace dashboards** — the primary HA UI, served at `/api/panel/lovelace/...`
- **Media browsing** — the HA media player browser panel
- **Configuration panels** — any HA panel loaded via the `panel_custom` or `panel_iframe` integrations

Currently, the Edge sidecar injects a raw HA long-lived access token into the WebView's `localStorage` before loading these panels. This violates **D-012** ("Core is the primary HA integration point; Edge devices never connect to HA directly and hold no HA credentials") and **O-009** ("persistent HA refresh tokens on Edge are not acceptable").

The Phase 4 entry gate (§25) requires: *"Raw HA/Lovelace policy is decided. If no supported ephemeral session exists, required panels have a Canvas-native replacement plan before credential removal."*

The Phase 4 exit gate (§25) requires: *"Forensic scans find no HA long-lived bearer/refresh credential anywhere on Edge."*

---

## 2. Options Analysis

### Option A: Core-authenticated proxy

**Description:** Canvas Core maintains the HA token and proxies all panel requests. The WebView loads panels through Core's local proxy, which transparently injects the HA auth header. No token ever reaches the WebView session.

**Mechanism:**
- Core exposes `/api/panel-proxy/*` routes that forward to HA's panel endpoints.
- The Content Bridge (or a new Core route) serves the panel HTML through the proxy.
- The WebView loads `http://127.0.0.1:<bridge-port>/panel-proxy/lovelace/...`
- Core injects the `Authorization: Bearer <ha-token>` header server-side.

**Pros:**
- ✅ Token never enters WebView storage, memory, or network — fully server-side.
- ✅ Aligns with the existing Content Bridge pattern proven in Phase 0/3 for YouTube (§17.3).
- ✅ No changes to HA's authentication model — Core already holds the token.
- ✅ HTTP-only, same-origin cookies possible for further hardening.
- ✅ Works with any HA panel without per-panel widget work.
- ✅ Can be implemented incrementally; individual panels migrate one at a time.

**Cons:**
- ❌ Adds latency — every panel request traverses Edge → Core → HA → Core → Edge.
- ❌ Core must be reachable (network break = panels unavailable).
- ❌ Adds complexity to the Content Bridge route table and request forwarding.
- ❌ Panel WebSocket connections (Lovelace uses WebSocket for state updates) must also be proxied or handled separately.

**Risk rating:** Low — proven pattern, minimal new attack surface, no credential exposure.

---

### Option B: Short-lived viewer token

**Description:** Core issues a short-lived (5-minute) HA viewer token that the WebView can use. The token has minimal scope (read-only, no service execution). Implemented via HA's `auth/refresh_token` endpoint or a custom HA integration endpoint.

**Mechanism:**
- Core requests a viewer-scoped token from HA (either via `auth/token` with limited scope or a custom integration endpoint).
- Core passes the short-lived token to the WebView via the Content Bridge.
- The WebView uses the token for panel requests; token expires after 5 minutes.
- Core periodically refreshes and pushes new tokens as needed.

**Pros:**
- ✅ No Core dependency for the panel request itself after token is obtained.
- ✅ Lower latency than Option A — direct Edge → HA requests.
- ✅ Token lifetime is bounded (5 min), reducing exposure window.
- ✅ Works offline for up to 5 minutes after last Core contact.

**Cons:**
- ❌ Token still enters WebView memory and storage (even if only briefly).
- ❌ HA's scope model may not support granular viewer-only tokens out of the box — may require custom HA integration work.
- ❌ Token refresh introduces a periodic Core dependency anyway.
- ❌ If HA WebSocket reconnection uses the token, the 5-minute expiry causes frequent reconnections.
- ❌ Forensic scans would need to verify the token is *never* persisted — harder to prove.

**Risk rating:** Medium — reduces but does not eliminate credential exposure; depends on HA scope support.

---

### Option C: iframe sandbox with postMessage

**Description:** The panel is loaded in an iframe with restricted permissions, and authentication is handled via `postMessage` to Core. Core authenticates on behalf of the iframe.

**Mechanism:**
- The WebView loads a Canvas-hosted page that embeds the HA panel in an iframe.
- The iframe has `sandbox="allow-scripts allow-same-origin"` (no `allow-credentials`).
- Core's page communicates with the iframe via `postMessage`.
- The iframe sends requests to Core via `postMessage`; Core proxies them to HA with the token.
- Panel responses are relayed back to the iframe.

**Pros:**
- ✅ Token never enters the iframe's origin or storage.
- ✅ Fine-grained control over what the iframe can do.
- ✅ Works with Core reachable.

**Cons:**
- ❌ Significant complexity — must intercept and proxy all iframe requests, including XHR, fetch, and WebSocket.
- ❌ HA panels are not designed for iframe embedding — CORS, framing protections (`X-Frame-Options`), CSP, and same-origin assumptions will break.
- ❌ Lovelace's WebSocket connection to HA is particularly difficult to proxy through `postMessage`.
- ❌ Many HA panels will simply not work in a sandboxed iframe without extensive patching.
- ❌ High maintenance burden as HA panel internals change.

**Risk rating:** **High** — technically fragile, HA panels are not designed for this pattern; likely to break with every HA update.

---

### Option D: Remove raw panels entirely

**Description:** All HA interactions go through Canvas-native widgets instead of raw panels. This is the long-term architectural goal but requires full widget coverage.

**Mechanism:**
- Every HA panel feature is replaced by a Canvas-native widget (or widget composition).
- The widget catalog (§Widget Architecture) is expanded to cover all panel use cases.
- The raw-panel WebView route is removed entirely.

**Pros:**
- ✅ Cleanest security posture — no HA panel code or credentials on Edge.
- ✅ Full offline capability — Canvas-native widgets work without Core.
- ✅ Consistent rendering and interaction model.
- ✅ No proxy complexity, no token management.

**Cons:**
- ❌ Current widget catalog (29 widgets) does not cover all HA panel use cases.
- ❌ Full widget coverage is a multi-phase effort — blocks Phase 4 indefinitely.
- ❌ Custom panels (`panel_custom`, `panel_iframe`) cannot be Canvas-native by definition.
- ❌ Some HA panels (e.g., media browser, automations editor) are complex and would require significant widget investment.
- ❌ Users who rely on custom HA panels would lose functionality.

**Risk rating:** Medium-long-term — correct destination, but not achievable within Phase 4 timeline.

---

## 3. Recommendation

**Recommendation: Option A — Core-authenticated proxy**

| Criterion | Option A | Option B | Option C | Option D |
|---|---|---|---|---|
| Token never reaches Edge | ✅ | ❌ | ✅ | ✅ (N/A) |
| Works with existing HA panels | ✅ | ✅ | ❌ | ❌ |
| Proven pattern | ✅ | ❌ | ❌ | ❌ |
| Offline capability | ❌ | Partial | ❌ | ✅ |
| Phase 4 achievable | ✅ | ✅ | ❌ | ❌ |
| Long-term viability | ✅ | Partial | ❌ | ✅ |

**Rationale:**

1. **Security first.** D-012 is unambiguous: Edge holds no HA credentials. Option A is the only option that guarantees zero token exposure on Edge while still supporting existing HA panels.

2. **Proven pattern.** The Content Bridge already demonstrates this architecture for YouTube (§17.3): Core holds credentials, the bridge serves content, Edge renders. The raw-panel proxy is a straightforward extension of the same principle.

3. **Phase 4 achievable.** Option A can be implemented within Phase 4 scope. It does not require changes to HA, does not require full widget coverage, and does not require brittle iframe workarounds.

4. **Migration path.** Option A does not prevent Option D (native widgets) from being the long-term goal. As Canvas-native widgets replace panel use cases, the proxy routes can be removed incrementally. The proxy is a transitional bridge, not a permanent architecture.

5. **Offline tradeoff.** Panels requiring Core access are inherently offline-limited. This is consistent with the existing design: Canvas-native scenes work offline, raw panels are a transitional capability acknowledged in §16.3.

---

## 4. Implementation Specification

### 4.1 Core proxy routes

Core exposes the following routes, forwarded to HA with the Core-managed HA token:

```
GET /api/panel-proxy/<panel-path>  →  HA /api/panel/<panel-path>
GET /api/panel-proxy/lovelace/...  →  HA /api/panel/lovelace/...
GET /api/panel-proxy/media-browser/... →  HA /api/panel/media-browser/...
```

**Forwarding rules:**
- `Host` header rewritten to HA's internal hostname.
- `Authorization: Bearer <ha-token>` injected from Core's secret store.
- `X-Forwarded-For` set to the Core's internal IP (not the Edge IP).
- Response headers preserved, with `Set-Cookie` stripped (no credential leakage).
- Response body streamed — no buffering for large panel responses.
- Content-Type and Content-Length proxied as-is.

### 4.2 WebSocket proxy

Lovelace panels use HA WebSocket connections for real-time state updates. Core must also proxy these:

```
WS /api/panel-proxy/ws  →  HA WS /api/websocket
```

**WebSocket forwarding:**
- Core intercepts the HA WebSocket upgrade.
- On the initial `auth` message, Core injects the HA token (replacing any Edge-supplied token).
- Subsequent messages are transparently forwarded.
- Connection lifecycle is managed by Core; Edge sees only the proxied socket.

### 4.3 Content Bridge integration

The Content Bridge (or a new Core route) serves the panel HTML through the proxy:

```
http://127.0.0.1:<bridge-port>/panel-proxy/lovelace/...
```

**Bridge responsibilities:**
- Serve a minimal HTML shell that loads the panel iframe pointing to the proxy URL.
- The iframe `src` points to Core's proxy, not directly to HA.
- No HA token is ever embedded in the HTML, iframe attributes, or query strings.
- CSP on the bridge page restricts the iframe to the Core proxy origin only.

### 4.4 Sidecar route replacement

The existing `lovelace` panel route in the sidecar is **replaced** by the Core proxy. The sidecar's current panel-serving code is removed as part of the credential cleanup:

- Remove `/api/panel/lovelace` from the sidecar route table.
- Remove token injection from the sidecar's WebView setup.
- Remove any localStorage token-persistence logic in the sidecar.

### 4.5 Migration sequence

| Step | Description | Depends on |
|---|---|---|
| 1 | Core proxy routes implemented and tested against HA | Core deployment |
| 2 | WebSocket proxy implemented and tested | Step 1 |
| 3 | Content Bridge route added for panel proxy | Step 2 |
| 4 | Edge WebView URL updated to use proxy | Step 3 |
| 5 | Sidecar panel routes removed | Step 4 |
| 6 | Token injection code removed from sidecar | Step 5 |
| 7 | Forensic scan confirms no token on Edge | Step 6 |

---

## 5. Cache Quota Design

### 5.1 Constants

| Constant | Default | Purpose |
|---|---|---|
| `CANVAS_CORE_ASSET_QUOTA_BYTES` | 1,073,741,824 (1 GB) | Total cache quota for content-addressed assets on Core |
| `CANVAS_CORE_RESERVED_KNOWN_GOOD_BYTES` | 104,857,600 (100 MB) | Reserved space for current and previous known-good scene revisions; never reclaimed by GC |

### 5.2 GC behavior

The `POST /api/admin/storage/gc` endpoint triggers garbage collection:

1. **Scan phase:** Walk the `asset_index` table to identify unreferenced assets.
   - An asset is *referenced* if it appears in any active scene manifest, previous known-good scene manifest, or has an outstanding download reference count.
   - An asset is *unreferenced* otherwise.

2. **Eviction phase:** Delete unreferenced assets in LRU order (last access time).
   - Stop when either:
     - All unreferenced assets are deleted, or
     - The remaining cache size (active + reserved known-good) reaches the quota floor: `CANVAS_CORE_RESERVED_KNOWN_GOOD_BYTES`.

3. **Safety rules:**
   - Never delete assets referenced by the current active scene revision.
   - Never delete assets referenced by the previous known-good scene revision (rollback safety).
   - Never delete below the reserved floor — GC is best-effort for the reserved space.
   - GC runs automatically when the cache exceeds `CANVAS_CORE_ASSET_QUOTA_BYTES` after a new asset download, and is also available as an admin API.

### 5.3 Upload rejection

When a new scene manifest upload would cause the cache to exceed `CANVAS_CORE_ASSET_QUOTA_BYTES`:

1. Core first attempts an automatic GC cycle.
2. If after GC the new manifest still exceeds quota, the upload is **rejected** with HTTP 507 (Insufficient Storage).
3. The rejection response includes:
   - `current_cache_bytes` — current cache size
   - `quota_bytes` — the quota limit
   - `reserved_bytes` — the reserved known-good floor
   - `required_bytes` — bytes needed to accept the upload

### 5.4 Edge-side cache interaction

The Edge cache (§11.1) independently manages its own local asset storage:

- Edge's `asset_index` table tracks local cache with hash, size, path, last access, and reference count.
- Edge GC runs independently with its own local quota (not yet specified — Phase 5/6).
- The Core GC does not evict assets that Edge may still need; Core notifies Edge of manifest obsolescence, and Edge GC decides when to evict.

---

## 6. Related Decisions

| ID | Relationship |
|---|---|
| D-012 | Core is the primary HA integration point; Edge holds no HA credentials. This decision implements D-012. |
| O-009 | Prefer Canvas-native views; persistent HA refresh tokens on Edge are not acceptable. This decision provides the approved mechanism for transitional panels. |
| P-006 | Loopback Content Bridge for local renderer assets. This decision extends the bridge to also serve panel proxies. |
| §16.3 | Transitional raw HA panels. This decision resolves the §16.3 requirement with an approved mechanism. |

---

## 7. Rejected Alternatives

| Alternative | Reason for rejection |
|---|---|
| **Store HA token in Edge keychain/TPM** | Violates D-012 — credential is still on Edge, even if encrypted. |
| **OAuth2 device flow** | HA does not natively support OAuth2 device flow for long-lived access; adds complexity for no security gain over Option A. |
| **HA Cloud proxy** | Requires HA Cloud subscription; not available to all users. |
| **Do nothing (keep current injection)** | Violates D-012, O-009, and Phase 4 exit criteria. |
