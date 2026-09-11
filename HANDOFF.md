# Canvas Display Hermes — AI Handoff Document

This file explains the project, where everything lives, how to access the machines, and the current state of work. It is meant to let another AI take over seamlessly.

---

## 1. What the project is

**Canvas Display Hermes** is a multi-display "digital canvas" system:

- **Core** (`core/`): Node.js server (runs in Docker) that stores Pages, Scenes, Panels, devices, and assets. Each Page has **panels** with coordinates expressed as **percentages (0–100)** of the screen.
- **Edge** (`edge/`): agent that runs on display devices (Raspberry Pi kiosks), receives `load_page` commands over a Core WebSocket, and drives a native browser to render the page's panels.
- **Browser** (`browser/linux/`): a Tauri v2 + WebKitGTK kiosk app (`canvas-display-browser-linux`) that runs on the Pi, renders panels as webviews, and exposes a control WebSocket on `127.0.0.1:3100` for the edge agent.

The immediate, active task: **make page panels on the edge kiosk render at exactly the percentage geometry defined in Core** (page `gg`: panel `eyeeye` at x0 y0 w100 h85, panel `dab_menu` at x0 y85 w100 h15), while keeping full web capability (YouTube, Google, Home Assistant auth, custom TLS).

---

## 2. Machines and how to access them

### Core host — `mainserver` @ `192.168.1.108`
- SSH: `ssh spetchal@192.168.1.108` (key auth, no password needed from this workstation).
- Core runs in Docker:
  - `canvas-core-canvas-core-1` — the Core server, container port 3100 → host **3101** (`http://192.168.1.108:3101`).
  - `canvas-core-tls-proxy-1` — nginx TLS proxy, host **3100** → container 443 (`https://192.168.1.108:3100`).
- Docker volume: `canvas-core-assets` mounted at `/app/data/assets` in the core container.
- The core source that is RUNNING is built from this repo and copied into the image; check `Dockerfile` at repo root. To redeploy core: rebuild the image on `mainserver` and `docker compose up -d` (compose project `canvas-core`).
- Core API auth: `Authorization: Bearer ac532a515a0d3651b9fa45b462dcdb9599abad0b5d9a699ad124633d41d8b5be`.

### Edge kiosk — Pi 5 `pi5-living-room` @ `192.168.1.216`
- SSH: `ssh spetchal@192.168.1.216` (key auth).
- OS: Linux, Wayland compositor **labwc** (not X11). Screen `1920x1080`, scale 1.0.
- Device ID in Core: `device-2acc4690-b00b-4bf7-9ffe-a532ddf93150`.
- Services:
  - `canvas-display-browser.service` (systemd **user** unit) — the Tauri kiosk browser. Restart: `systemctl --user restart canvas-display-browser.service`.
  - The edge agent runs inside/alongside it (mode `CANVAS_EDGE_SCENE_RENDERER_MODE=core`), talking to Core at `http://192.168.1.108:3101`.
- Log file: `/tmp/canvas-ui-kiosk.log` (truncated on each app start).
- Screenshot: `XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 grim /tmp/shot.png` then `scp` it off the Pi.
- Rust toolchain: user-scoped **1.88.0** at `~/.cargo` (system rust 1.85 is too old — always prefix `PATH=$HOME/.cargo/bin:$PATH`).

### Build workspace for the kiosk browser (on the Pi)
- `/home/spetchal/build/canvas-browser` — a copy of `browser/linux` used to build on-device.
- Build: `PATH=$HOME/.cargo/bin:$PATH npm --prefix /home/spetchal/build/canvas-browser run tauri -- build --no-bundle` (~3 min).
- Install: `sudo install -m 755 /home/spetchal/build/canvas-browser/src-tauri/target/release/canvas-display-browser-linux /usr/bin/canvas-display-browser-linux`
- Sync sources from workstation before building:
  `rsync -av "browser/linux/src/screens/KioskScreen.tsx" spetchal@192.168.1.216:/home/spetchal/build/canvas-browser/src/screens/`
  `rsync -av "browser/linux/src-tauri/src/lib.rs" spetchal@192.168.1.216:/home/spetchal/build/canvas-browser/src-tauri/src/`

---

## 3. Repo layout (workstation: `/home/spetchal/Code/Canvas Display Hermes`)

| Path | What it is |
|---|---|
| `core/src/` | Core server (`index.ts`, `gateway.ts`, `legacy-routes.ts` — assignment/page-delivery transport) |
| `edge/` | Edge agent (runs on the Pi) |
| `browser/linux/` | Tauri kiosk app: `src/screens/KioskScreen.tsx` (frontend), `src-tauri/src/lib.rs` (native), `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` |
| `packages/`, `contracts/` | shared types/contracts |
| `scripts/`, `tools/` | deployment and utility scripts |

### Useful commands
- Force a page onto the kiosk:
  `curl -X POST -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{"device_id":"device-2acc4690-b00b-4bf7-9ffe-a532ddf93150"}' http://192.168.1.108:3101/api/pages/2d640880-c090-4b12-adc0-f5078246c7b6/display`
  (`2d640880-c090-4b12-adc0-f5078246c7b6` = page `gg`)
- Follow kiosk log: `ssh spetchal@192.168.1.216 'tail -f /tmp/canvas-ui-kiosk.log'`

---

## 4. Current state of the geometry problem

### What was already tried
1. **Top-level `WebviewWindow`s per panel** — labwc (Wayland compositor) owns top-level window placement and **ignored the requested x/y, centering/overlapping them**. This is the original bug.
2. **DOM `<iframe>`s inside the controller webview** — pixel-perfect CSS geometry, but broke YouTube/Google/Core TLS/HA auth (iframes don't get the per-view WebKit settings, TLS handling, or HA auth injection). Rejected.
3. **Child webviews via Tauri `unstable` feature** (`WebviewBuilder` + `window.add_child`) — positioned relative to the parent window so the compositor cannot recenter them. This is the current approach.

### SOLVED (2026-08-29): root cause of the geometry bug and the fix
The "correct geometry in the logs, wrong geometry on screen" mystery is **solved and verified on-device**.

**Root cause:** Tauri's `Window::add_child()` (unstable) **never applies the requested position/size on Linux/GTK**. Verified in source: tauri 2.10.3 sets `webview_attributes.bounds`, but tauri-runtime-wry 2.10.1's Linux path for `WebviewKind::WindowChild` calls `webview_builder.build_gtk(window.default_vbox())` (NOT `build_as_child` — that is Windows/macOS-only), and wry 0.54.4's `add_to_container` for a **GtkBox** container does `pack_start(webview, true, true, 0)` — the bounds are silently discarded. Every webview in the window (the black controller included) ended up as a stacked row of the window's vertical GtkBox, splitting 1080 px between them: the screen showed [controller 0–377][eyeeye 377–754][Google 754–1080]. The logs were truthful about what was *requested*; GTK just never applied it. This also explains all previous "webviews are still wrong" reports. (wry only honours bounds when the container is a **GtkFixed**: `set_size_request(w,h)` + `Fixed::put(w,x,y)`; its X11 child path is irrelevant on Wayland.)

**Fix (in `browser/linux/src-tauri/src/lib.rs`):**
1. `place_webview_in_fixed()` — called from the `with_webview` closure inside `create_one_panel()` after each panel build. It re-parents the new panel webview (plus any webviews still packed in the vbox, preserving their allocations/visibility) into a **GtkFixed** named `canvas-webview-fixed` inside the window's vbox, then does `fixed.put(wv, x, y)` + `set_size_request(w, h)` at the exact requested geometry. Tauri labels, IPC, init scripts and the TLS handler are unaffected (only the GTK parent changes). First panel creation moves the controller webview into the fixed too (restoring it to fullscreen — previously it was squeezed to ~377 px, which also broke the corner-tap area).
2. Race hardening — `static PANEL_GENERATION: AtomicU64`; `close_panel_webviews` bumps it and `create_panel_webviews`' batch thread aborts if superseded, so the multiple racing `load_page` pushes at startup (cached page restore + WS pushes) can no longer leave stale panels from an older page stacked over the newer page.
3. `Cargo.toml` now depends on `gtk = "0.18"` directly (webkit2gtk 2.0.2 does not re-export gtk; versions unify with the locked gtk 0.18.2).

**Verified:** after deploy + restart, pixel analysis of `grim` screenshots shows the only strong horizontal transition at **y=917** (spec: 918), `eyeeye` scene filling 0–918 and Google filling 918–1080; a full service restart with racing page loads converges to the correct layout.

### Remaining known issues (minor)
- The controller webview's size request in the fixed uses the toplevel allocation captured at first-panel time; if that happens before the window settles into fullscreen it can be 1970×1130 (slightly oversized, clipped, invisible behind panels). Harmless on the fixed-resolution kiosk; could be improved by re-applying the fixed's allocation to the controller on resize.
- Duplicate panel builds still occur when the same page is loaded twice back-to-back at startup; the second build either loses the `already exists` race (harmless, logged) or recreates after a close. The generation guard keeps the final state correct. A frontend-side serialization of `openPanelWindows` would reduce churn.
- Known build warnings in `lib.rs`: unused `Arc` import, dead `quit_app`, deprecated `webkit2gtk::ProcessModel::MultipleSecondaryProcesses`.

### Where the relevant code is
- `browser/linux/src/screens/KioskScreen.tsx` → `openPanelWindows()` builds a `specs[]` array and calls `invoke('create_panel_webviews', { panels: specs })` once; `navigate_panel` / `panel.patch` / `panel.reload` use native `navigate_webview` / `set_webview_visibility`.
- `browser/linux/src-tauri/src/lib.rs` → `create_one_panel()` (shared helper doing `window.add_child` + `place_webview_in_fixed`), `place_webview_in_fixed()` (GtkFixed re-parent, the geometry fix), `PANEL_GENERATION` (race guard), `create_panel_webview` (single), `create_panel_webviews` (batched, spawned thread, generation-checked), `set_webview_visibility`, `close_panel_webviews` (bumps generation), dual-path `navigate_webview`/`close_webview`, `display_geometry` (returns monitor logical size used to convert % → px).
- `browser/linux/src-tauri/Cargo.toml` → tauri features include `"unstable"` (required for `add_child`); `gtk = "0.18"` dependency added for the GtkFixed fix.

---

## 5. Environment quirks worth knowing

- The Pi's WebKit needs: `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1`, `WEBKIT_DISABLE_COMPOSITING_MODE=1`, `LIBGL_ALWAYS_SOFTWARE=1` (set in `lib.rs` `run()`).
- Core's private CA is provisioned system-wide, but GLib/GIO on the Pi still rejects it — `lib.rs` has a `connect_load_failed_with_tls_errors` handler that allow-lists only `https://192.168.1.108:3100/` and `https://canvas-core.local:3100/`.
- Each panel webview gets `ProcessModel::MultipleSecondaryProcesses` to avoid a WebKit SIGSEGV when multiple same-origin pages share a process.
- HA (Home Assistant) auth is injected via an initialization script (`buildHAAuthScript`) when `config.haToken` is set.
- The Core API/WS the kiosk uses is the **Core** server on 3101 (env `CANVAS_CORE_CONTROL_URL`), not the local sidecars (system display server on 8099, browser sidecar on 127.0.0.1:3100).
