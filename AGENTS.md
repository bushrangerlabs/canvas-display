# Agent working guide

Last reviewed: 2026-09-26.

This is the maintained working guide for **Canvas Display Hermes**. It applies throughout this repository; read any additional instructions scoped to the files you change. Do not assume previous conversation history is available.

## Start every session

1. Read this file and `PROJECT_STATUS.md` before changing code.
2. Read applicable repository instructions, including `.github/copilot-instructions.md`. Its historical platform path and stack description cover only part of this repository; verify actual paths and dependency versions in source and manifests.
3. Inspect Git status, relevant diffs, and recent history. Distinguish preexisting work from your own changes.
4. Inspect relevant source, configuration, documentation, and tests. Treat historical deployment claims as historical, not current verification.
5. For a handover/resumption request, summarize current state, verified functionality, known problems, likely unfinished work, and the next step before editing. Label inferences explicitly.
6. Treat conversation context as temporary working memory. Keep durable discoveries, decisions, failed approaches, validation results and next steps in `PROJECT_STATUS.md` as work progresses; do not wait until context exhaustion or session end to preserve important state.

## Project map

| Path                                           | Responsibility                                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `core/`                                        | Fastify/PostgreSQL control plane, device gateway, scenes, schedules, AI/voice, tools and flows. |
| `server/`                                      | Fastify/SQLite Display sidecar, local APIs, WebSockets, HA bridge, media and voice.             |
| `web/`                                         | React administration/display application and canvas editor.                                     |
| `browser/linux/`                               | Tauri/WebKitGTK kiosk with embedded Display sidecar and native panel webviews.                  |
| `browser/android-native/`                      | Native Kotlin Android client replacing the legacy Tauri Android client.                         |
| `edge/`                                        | Rust agent, durable session state, local IPC and updater components.                            |
| `editor/canvas-ui-react/`                      | Separate React editor with HACS-capable builds; not interchangeable with `web/`.                |
| `contracts/`, `packages/`                      | Protocol/schema definitions and shared/generated types.                                         |
| `tests/`                                       | Contract/model and regression suites; component tests also live alongside their components.     |
| `custom_components/`, `plugins/`               | Home Assistant integration and Hermes/Music Assistant plugins.                                  |
| `packaging/`, `scripts/`, `.github/workflows/` | Installation, validation, deployment and release tooling.                                       |

Core uses `core/Dockerfile` and `core/docker-compose.yml`. The root Dockerfile builds the Display server. Do not confuse the Core control plane, local Display sidecar, and native kiosk processes.

Consult component manifests for versions and commands. Components currently have different release versions; do not synchronize them without an agreed release policy.

## Safe changes

* Preserve existing modified, deleted and untracked files. The checkout contains substantial in-progress work; consult `PROJECT_STATUS.md` for the recorded baseline and recheck Git for current state.
* Do not restore deleted legacy Android sources or remove their native replacement merely to clean Git status.
* Make focused changes that address the requested behavior. Avoid unrelated refactors, dependency upgrades, generated-asset churn and formatting sweeps.
* Read before editing. Reuse existing dependencies and patterns. Keep widget metadata separate from lazy-loaded component implementation where required by the relevant editor.
* Fix root causes and add regression coverage when practical. Do not weaken meaningful code or tests just to silence errors.
* Treat protocol acknowledgements, rendered/applied state, process lifecycle and updater health as observable behavior, not just successful function calls.
* Inspect build scripts before running them: builds may overwrite checked-in public assets or native sidecars.
* Do not commit, create branches, push, release, or deploy without explicit authorization. Authorized commits go to `main` under the current project policy unless the user changes it.
* Avoid broad staging such as `git add -A`. `release.sh` performs broad staging, commits and pushes; it is not a validation command.
* Do not contact or modify live devices/services solely because historical notes provide connection details.

## Security

* Never copy secrets, bearer tokens, private keys or personal data into code, tests, logs or handover notes.
* Historical documentation contains a plaintext credential. Do not use or reproduce it. Flag owner-led rotation/revocation if still active; removing text does not revoke credentials or remove history.
- Do not disable TLS verification or weaken authentication to make a test/deployment pass.
- For Core certificate changes, verify intended hostname/IP SANs and all client trust paths separately: Linux WebKit, Rust agent/updater, Android native HTTP/WSS and Android WebView. A native trust-store change does not configure WebView. Distinguish local certificate files from the certificates actually served, and server TLS trust from device enrollment credentials.
- Certificate deployment acceptance must use strict validation, not `curl --insecure`, hostname bypasses or HTTPS-to-HTTP rewrites. Never read or reproduce private keys for diagnosis; inspect public certificate metadata and coordinate secure provisioning/rotation.
* Treat uploaded SVG/HTML, iframe messaging and direct sidecar endpoints as explicit trust boundaries. Do not describe executable trusted HTML as sanitized or sandboxed without evidence.
* Keep fixtures synthetic or sanitized. Record security concerns without including sensitive values.

## Validation and reporting

* Start with tests for changed behavior and the relevant component's typecheck, then broaden as needed.
* Prefer no-emit checks during inspection. Use bounded runtimes for tests/builds and report timeouts honestly.
* Inspect component `package.json`, Cargo manifests and build configuration rather than assuming one root command validates the whole repository.
* Root contract/conformance tests include executable models; they do not establish that the real gateway, hardware or deployed services behave identically.
* Distinguish source inspection, automated local checks, browser integration, native build and on-device acceptance.
* Record exact commands, working directories, results and validation that was not run. Never claim a check passed unless it actually ran successfully.
* At completion, summarize changed files, behavioral impact, validation, and unresolved blockers. Do not claim the whole project is complete after a scoped fix.

## Build & deployment

Deploy/build only with explicit owner authorization for the release/deploy path and device; the *build-only* (compile/typecheck) commands are safe any time. Never commit signing keys or `.env`-style secrets.

### Android native — `browser/android-native/`

* Build (the system `gradle` shim is broken; use a cached wrapper dist, e.g. `~/.gradle/wrapper/dists/gradle-8.14.3-bin/*/gradle-8.14.3/bin/gradle`):
  `:app:assembleDebug :app:assembleRelease` (add `--offline` once deps are cached).
* Release signing: keystore `browser/android-native/keystore/canvas-edge-release.keystore` + `keystore.properties` (both **gitignored secrets**). `app/build.gradle.kts` reads `keystore.properties`; when absent, release is unsigned.
* Two signing identities exist in the field: `app-debug.apk` uses the machine debug key (in-place `adb install -r` preserves enrollment); `app-release.apk` uses the new keystore, a *different* identity, so it cannot update a debug-installed app without `adb uninstall` (wipes enrollment). Keep this in mind before switching devices to release builds.
* Deploy to a tablet: `adb install -r app/build/outputs/apk/debug/app-debug.apk` (adb here: `~/Android/Sdk/platform-tools/adb`).
* Unit tests: `<gradle> :app:testDebugUnitTest` (JVM — `src/test`); instrumentation: `:app:assembleDebugAndroidTest` then `adb shell am instrument -w com.bushrangerlabs.canvas_display_edge.test/androidx.test.runner.AndroidJUnitRunner`.
* The app hosts a **DLNA MediaRenderer** (`.../dlna/`) on port **49500**, mirroring the Linux sidecar: SSDP + HTTP + SOAP + GENA, audio via `MediaPlayer`, video via the floating WebView. `DlnaService` acquires a `WifiManager.MulticastLock` (Android only delivers multicast to a lock holder). `DlnaLog.sink` is a no-op by default so the `dlna` package stays Android-free for JVM tests; `DlnaService` wires it to logcat (`CanvasDlna`).
* The app also runs a **Kotlin Snapcast client** (`.../snapcast/`) for multi-room audio: TCP to the MA snapserver (default port 1704, host defaults to the Core host), FLAC decoded with platform `MediaCodec` into `AudioTrack`. `AudioSinkArbiter` (in the `dlna` package) hands the single audio sink between Snapcast and local playback. Protocol details and a probe helper: `scripts/snapcast-probe.py`. Playback is clock-scheduled and drift-corrected (`SnapcastSync`, mirroring snapclient's `age = serverNow - chunkStart - bufferMs + dacTime` rule plus its 0.05%-capped frame drop/duplicate soft correction) to roughly ±20–40 ms. Gotchas: `WireChunk` carries `int32 sec` + `int32 usec` (not a uint64); all client clocks must use the monotonic source or the NTP-style offset comes out as 0; and the write loop must retry a too-early chunk in place rather than re-queueing it (re-queueing scrambles audio order).

### Linux kiosk — `browser/linux/`

* **Never cross-compile** — build amd64 on amd64, arm64/armhf on the matching target.
* Local amd64 build: `npm run tauri:build -- --bundles deb` → `src-tauri/target/release/canvas-display-browser-linux` and `bundle/deb/*.deb`.
* arm64 (Pi 5) build: run natively on the Pi in a copy of `browser/linux` (e.g. `/home/spetchal/build/canvas-browser`). Gotcha: `/usr/bin/rustc` is 1.85 (too old for `Cargo.lock`); use rustup's 1.88 via `PATH=~/.cargo/bin:${PATH}` (the build fails an MSRV check otherwise).
* Deploy to the Pi: back up the current binary, then `sudo install -m 0755 <binary> /usr/bin/canvas-display-browser-linux` and `systemctl --user restart canvas-display-browser.service` (a systemd **user** unit under `~/.config/systemd/user/`; verify with `systemctl --user status`). The sidecar + resources live at `/usr/lib/Canvas Display/binaries/` and are reused unchanged when only the kiosk binary changes; logs go to `/tmp/canvas-ui-kiosk.log`.
* Sidecar (`server/`) rebuild:
  * x64: `npm run build:sidecar` (compiles with `tsc` and bundles `public/` + the binary into `browser/linux/src-tauri/binaries/`).
  * aarch64 (Pi): `pkg --target node20-linux-arm64` **alone produces a broken binary** (arm64 bytecode generation drops the entry → runtime `Cannot find module '/snapshot/server/dist/index.js'`). Build natively on the Pi in a copy of `server/` (e.g. `/home/spetchal/build/canvas-server`):
    1. `npm run build` — compiles `src/**` (incl. `bindings-shim.ts` and `pkg-native-patch.ts`) to `dist/`.
    2. `npx esbuild dist/index.js --bundle --platform=node --target=node20 --format=cjs --outfile=dist/bundle.js --alias:bindings=./dist/bindings-shim.js`
    3. `npx pkg dist/bundle.js --target node20-linux-arm64 --compress GZip --no-bytecode --public --public-packages "*" --output canvas-display-server`
    4. `sudo install -m 0755 canvas-display-server /usr/bin/canvas-display-server` then `systemctl --user restart canvas-display-browser.service` (the kiosk respawns its sidecar).
  * The native `better_sqlite3.node` is resolved at runtime from `NATIVE_BINDING_DIR` (via `pkg-native-patch.ts` + `bindings-shim.ts`, which the `--alias:bindings` above wires in) — never bundle it into the snapshot.
  * After replacing the sidecar, confirm only one `canvas-display-server` process is running (a stale PID keeps port 3100 bound and the new sidecar can't bind).
  * Sidecar tests: `cd server && npm test` (`tsx --test` over `src/audio/*.test.ts`, `src/dlna/*.test.ts`, `src/services/*.test.ts`). `npx tsc --noEmit` for types. If `better-sqlite3` fails to load locally with `NODE_MODULE_VERSION`, run `npm rebuild better-sqlite3`.

### DLNA renderer + Snapcast (sidecar)

* The sidecar hosts a UPnP/DLNA **MediaRenderer** (`server/src/dlna/`) so HA `dlna_dmr` and Music Assistant can push audio/video to a display. It listens on `CANVAS_DLNA_PORT` (default **49500**) and advertises over SSDP on UDP 1900. Audio plays through mpv; video opens the kiosk's floating WebView via a `/video` wrapper page.
* `server/src/audio/arbiter.ts` arbitrates the single audio sink between mpv and the Snapcast client (`server/src/audio/snapcast.ts`, systemd user unit `canvas-snapclient.service`). Config: `CANVAS_SNAPCLIENT_ENABLED`, `CANVAS_SNAPCLIENT_SERVICE`.
* The Pi previously ran a `gmediarender` prototype (`canvas-dlna-renderer.service`, port 49494) that is **audio-only** and superseded — remove it and its manual HA `dlna_dmr` entry when deploying this renderer.
* DLNA state is exposed at `GET /api/dlna/state`; Snapcast/sink state at `GET /api/audio/snapcast`.
* Both the system sidecar (`:8099`) and the kiosk-spawned one try to bind the DLNA port; the system service wins (it starts first at boot) and the other logs `EADDRINUSE` and continues. The kiosk connects to the **system** sidecar, so video broadcast reaches it — but this ordering dependency is fragile.
* When rsyncing `server/` to a Pi build dir, **exclude `data/`** — `server/.env` sets `DB_PATH=./data/...`, so a local dev database lives there and would otherwise be copied across.
* The kiosk's `/tmp/canvas-ui-kiosk.log` is block-buffered; a missing line is not proof something did not happen. `screen_off`/`screen_on` use `xset` (X11) and are no-ops under Wayland/labwc. Capture the Pi display with `XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 grim <file>`.
* **Build the kiosk with the Tauri CLI** (`npx tauri build --no-bundle`), never raw `cargo build --release` — the latter compiles with `--cfg dev` and produces a binary that expects the Vite dev server (`Could not connect to React: Connection refused`).
* **Tauri command parameters on the kiosk:** the main window's `is_webview_window()` is **false** on this build, so any command taking `tauri::WebviewWindow` fails with `current webview is not a WebviewWindow`. Use `tauri::Window` instead. Panel/floating webviews are *child* webviews and are absent from Tauri's WebviewWindow registry, so `WebviewWindow.getByLabel`/`getAll` return nothing — use the `webview_exists` Rust command. `client_log(message)` writes frontend diagnostics to the kiosk log (the controller WebView's `console.*` is not captured).

### Core + web control plane (show/hide/restart)

* The show/hide/restart actions live in `core/src/index.ts` (`POST /api/admin/devices/:id/app` with `action: show|hide|restart`) and the web UI (`web/src/pages/DevicesPage.tsx`). These must be deployed to the Core host (and the web react built into `core/public`) for the buttons to drive the edge apps end-to-end; the edge apps alone only expose the actions on the device side.
* Build & deploy to the Core host (`192.168.1.108`, compose dir `/home/spetchal/canvas-core/core`):
  1. `cd web && npm run build`
  2. `cp -r web/dist/. core/public/`
  3. `cd core && npm run build`
  4. `rsync -a --delete core/dist/ core/public/` → `spetchal@192.168.1.108:/home/spetchal/canvas-core/core/` (sync **only** `dist/` + `public/` — preserve the remote `nginx.conf`, `docker-compose.yml`, `tls/`, `.env`).
  5. `ssh spetchal@192.168.1.108 'cd /home/spetchal/canvas-core/core && docker compose up -d --build canvas-core'`
  * Core listens on `3101` (control plane); Postgres is external (`casaos`/`casaos`/`canvas_core`). Query it from the host with `docker exec canvas-core-canvas-core-1 node -e "...require('pg')..."` (there is no `psql` on the host).

### Versioning — where versions live and how to bump

There is no single source of truth; each component carries its own version. `release.sh` only bumps `config.yaml` + the Linux `tauri.conf.json` and must NOT be treated as a complete bump.

| Component | Version location(s) |
|---|---|
| HA add-on ("Canvas UI Platform") | `config.yaml` → `version:` |
| Core control plane | `core/package.json` → `version` |
| Web admin (served by Core) | `web/package.json` (kept `0.0.0`; versioned with Core in practice) |
| Linux kiosk | `browser/linux/src-tauri/tauri.conf.json` (`version`) **and** `browser/linux/src-tauri/Cargo.toml` (`version`) — keep both identical |
| Linux/Display sidecar | `server/package.json` → `version` |
| Android native app | `browser/android-native/app/build.gradle.kts` → `versionName`; **also bump `versionCode` (monotonic int) or the APK is not a newer version** |
| Edge agent/updater (Rust) | `edge/Cargo.toml` → `[workspace.package] version` (member crates use `version.workspace = true`) |

Rules:
* Always bump Android `versionCode` alongside `versionName`.
* Keep `tauri.conf.json` and `src-tauri/Cargo.toml` in sync for the kiosk.
* The Rust `edge/` workspace version is a single edit (members inherit it).
* Components currently differ (Core/Linux/Android `0.3.1`, edge `0.3.0`, sidecar `0.1.1`, add-on `0.2.66`); do not normalize versions without an agreed release policy.

## Mandatory maintenance

Maintain both handover files as part of relevant work:

### `AGENTS.md` — durable working rules

* Update when project structure, development commands/policy, safety constraints or reliable working practices change.
* Review at the end of each session; edit only when needed and update the review date when reviewed.
* Keep it concise and actionable. Do not accumulate per-session logs, current Git counts, release-version snapshots or speculative task lists here.
* Remove or correct obsolete guidance when source/configuration establishes a replacement. Do not silently turn historical assumptions into rules.

### `PROJECT_STATUS.md` — current state and session handover

* Update throughout substantive work at meaningful milestones and again at the end of each substantive work session, including incomplete work or failed validation.
* During long or tool-heavy sessions, update this file at meaningful milestones rather than waiting until session end, especially after important discoveries, architectural decisions, failed approaches, configuration changes or significant validation.
* Record the current objective, what changed this session, relevant file paths, exact validation commands/results, unresolved issues and the next concrete step.
* Separate preexisting work from new edits, and verified facts from inference or historical deployment claims.
* Keep enough context for a fresh agent to continue without conversation history; revise stale sections rather than adding contradictory notes indefinitely.
* Never store secrets. Link to source/configuration rather than duplicating sensitive configuration.

### Context management and compaction

Long-running and tool-heavy sessions can exhaust the model's available context. Protect project continuity proactively rather than waiting for a context-limit failure.

* Monitor conversation/context usage when the current agent or runtime exposes that information.
* Prefer proactive compaction when approximately 75–80% of the available context has been consumed rather than waiting until the context window is exhausted.
* When the conversation has become large or is approaching its context limit, first update `PROJECT_STATUS.md` with all important durable state that may currently exist only in conversation history.
* Before compaction, make sure `PROJECT_STATUS.md` records important discoveries, decisions, failed approaches and their reasons, configuration changes, files modified, significant validation results, unresolved problems and the exact next step.
* After preserving project state, use `/compact` when the current agent supports it.
* Do not repeatedly compact unnecessarily. Compaction should be used when context pressure warrants it rather than as a routine operation after every task.
* Treat compaction as potentially lossy. Do not assume every detail from earlier conversation history will survive summarization.
* After compaction, re-read `AGENTS.md` and `PROJECT_STATUS.md` as needed and verify the current repository/project state before relying on details from before compaction.
* Continue from the documented state rather than relying on memory of conversation content that may have been removed during compaction.
* If `/compact` is unavailable, unsupported or cannot execute because the context limit has already been reached, continue in a fresh agent thread.
* In a fresh thread, read `AGENTS.md` and `PROJECT_STATUS.md`, inspect Git status and relevant repository state, and verify the documented state before making changes.
* Never increase, invent or assume a model context limit merely to avoid compaction. Configured context values must reflect the actual model/runtime capabilities.
* The repository, source code, Git state, `AGENTS.md` and `PROJECT_STATUS.md` are the durable sources of truth. Conversation history is temporary working context.

## End-of-session continuity check

Before ending a substantive work session, or before intentionally starting a fresh agent thread:

1. Update `PROJECT_STATUS.md` with the current objective and actual project state.
2. Record significant work completed during the session.
3. Record exact validation commands and their results.
4. Record failed approaches when knowing about them will prevent unnecessary repetition.
5. Record unresolved issues and blockers.
6. Record the next concrete step so a fresh agent can resume without conversation history.
7. Review `AGENTS.md` and update it only if durable project guidance has changed.
8. Verify that no secrets or sensitive values were copied into either handover file.

If the session is documentation-only, say so and record that runtime tests were not needed.

Keep `AGENTS.md` as the single canonical agent guide; do not create a competing `AGENT.md`.
