# Project status and session handover

Last reviewed: 2026-09-27. This file records local checkout evidence, not deployment acceptance.

## Start here

- Actual workspace: `Canvas Display Hermes` (Canvas Display Hermes multi-component repository).
- Read `AGENTS.md` for the canonical, maintained agent working guide and this file for current session handover. Both were established during the 2026-09-26 handover work; neither existed at the initial audit. Also follow `.github/copilot-instructions.md`, but its old platform path, MUI version, and single-server description do not describe the whole current repository.
- Read this file, inspect Git status/diff, and verify source before relying on historical claims in `HANDOFF.md`, `STAGE.md`, `NOTES.md`, or `docs/CURRENT_STATUS.md`.
- Do not overwrite preexisting work, restore the Android deletions, stage everything, commit, release, or deploy without explicit authorization.
- Never copy credentials from historical documentation into new notes or output. `HANDOFF.md` contains a plaintext bearer credential: owner-led revocation/rotation and history review are needed if it remains active. Its validity was not tested.

## Active objective: Linux/Android edge functional parity

The user requested full practical parity between the Linux kiosk and native Android edge. Product decisions are fixed: Gateway v1 is the shared protocol; Android uses positioned native WebView layers; both platforms persist the last successfully applied page; Home Assistant access uses Core-issued scoped sessions rather than stored long-lived tokens; Core is authoritative for normal settings; OS-specific functions use equivalent outcomes and return unsupported rather than false success; updater work is excluded; changes are staged locally and then deployed to the existing Pi and Android tablet for live acceptance. Required acceptance includes multi-panel rendering, panel/floating/media controls, voice, show/hide/restart, offline recovery, reconnection, accurate capabilities, and explicit received/applied/rendered/failed/unsupported reporting. Preserve device identities and enrollment and keep strict TLS.

## Git baseline before this session's edits

- Branch `main`; HEAD `5198576` — `chore: update Android edge and platform work` (2026-09-12).
- Prior release commit `cfdf0d1` — `chore: release v0.2.66` (2026-08-06). Local remote-tracking reference was at this commit; no fetch was performed.
- Nothing staged. 73 modified, 261 deleted, 207 untracked status entries (untracked directories collapse multiple files).
- Tracked diff: 334 files, +3,094 / -20,563 lines. Much of this is legacy Android deletion and generated asset replacement, not this session's work.
- Deleted tracked `browser/android/` is accompanied by an untracked native Kotlin replacement at `browser/android-native/`. Preserve both states.
- Generated public assets, native binaries, Gradle caches, and local configuration are mixed with source work. Avoid `git add -A` and `release.sh`, which stages/commits/pushes broadly.

## Architecture and implemented capabilities

| Location | Current role |
| --- | --- |
| `core/` | Fastify/PostgreSQL control plane: admin auth, devices/enrollment, gateway, desired/reported state, scenes/assets, schedules, HA/MQTT, AI providers, ASR/LLM/TTS, tools and visual flows. |
| `server/` | Fastify/SQLite Display sidecar: page/scene APIs, WebSockets, HA bridge, media/audio, local wake-word and satellite modes. |
| `web/` | React admin/display app and canvas editor; current dependencies include MUI 9/Vite 8, unlike old instructions. |
| `browser/linux/` | Tauri/WebKitGTK kiosk with embedded Display sidecar and separate Core control connection. Native child webviews use GtkFixed for panel geometry. |
| `browser/android-native/` | Kotlin/WebView/OkHttp replacement with enrollment, gateway, identity, voice/audio and app commands; incomplete rendering parity. |
| `edge/` | Rust agent/session durability, hardware adapters, local IPC; signed updater delivery/journaling primitives. |
| `editor/canvas-ui-react/` | Separate React editor/HACS-capable build, still MUI 7. |
| `contracts/`, `packages/`, `tests/` | Schemas, generated types, protocol/model tests and regression fixtures. Passing models do not prove production gateway behavior. |
| `custom_components/`, `plugins/` | HA component, Hermes tools, Music Assistant/LiSTNR integration. Some source is not wired into runtime setup. |

Core Docker deployment uses `core/Dockerfile` and `core/docker-compose.yml`; the root Dockerfile builds the Display server. Core includes new gateway and legacy control transports simultaneously.

Version split observed: Core, Linux browser and native Android 0.3.1; Rust edge workspace 0.3.0; add-on `config.yaml` 0.2.66; Display server package 0.1.1. Do not normalize these without deciding independent release policy. `scripts/check-versions.sh` is informational, not an equality gate.

## Likely previous work — inference, not recovered conversation

The uncommitted changes suggest several concurrent tracks:

1. Tauri Android replacement with native Kotlin app, including wake-word/voice and Core integration.
2. Lower-latency local-first HA voice routing, aliases/templates, provider selection, tool parsing and confirmation policy.
3. AI logs/evaluation and disabled automation-flow drafting.
4. Custom SVG icons, shared styles, page roles and device app controls.
5. Packaging/version changes and regenerated frontend/sidecar assets.

There is no trustworthy single task pointer. `HANDOFF.md`'s August Linux geometry task is already implemented and historically reported device-verified; it is not evidence of the latest task.

## Work completed in this session

Repository-wide structural audit with focused source/config/diff inspection across major subsystems. This was not a line-by-line audit of every file or generated artifact. No remote devices/services were contacted.

Fixed a reproducible regression in the already-modified separate editor HTML widget:

- `editor/canvas-ui-react/src/shared/widgets/HtmlWidget.tsx` now delegates document generation to a pure helper.
- New `editor/canvas-ui-react/src/shared/widgets/htmlSrcDoc.ts` emits real HTML script end tags instead of literal backslash-containing tags; escapes embedded user-JS end-tag sequences, including case/whitespace variants.
- New `tests/regression/html-widget/srcdoc.test.ts`: 14 offline tests for document boundaries, embedded strings, trusted HTML preservation, bridge/custom-script execution, entity subscriptions, and service success/error replies.
- Preserved the preexisting iframe and entity/service bridge implementation. The larger diff against HEAD includes work that predates this session.
- Trusted HTML remains executable; this is not a sanitizer or sandbox-security fix.
- No dependency additions, generated asset rebuilds, commits, releases, or deployment.

### Re-run this session's focused checks

From repository root:

```sh
./node_modules/.bin/tsx --test tests/regression/html-widget/*.test.ts
```

From `editor/canvas-ui-react`:

```sh
./node_modules/.bin/tsc -p tsconfig.app.json --noEmit
./node_modules/.bin/tsc -p tsconfig.node.json --noEmit
```

All passed. Scoped `git diff --check` also passed. Tests use a focused raw-text scanner and Node VM mocks, not a browser HTML parser or full iframe integration. The new suite is standalone; it is not yet included in the root aggregate test script or CI.

### Edge app show/hide/restart from Core + boot autostart (2026-09-26)

The start/stop model was replaced with the user's preferred design: the edge apps (Linux kiosk + Android native) are always running and auto-start at boot; Core has **Show** / **Hide** / **Restart** buttons. Hide = background the app and reveal the underlying desktop/launcher (Pi OS / Android home); show = bring it back fullscreen to the foreground; restart = full teardown + relaunch. The process (and its Core WebSocket) stays alive on hide so resume is instant and reachable.

- **Core** (`core/src/index.ts`) — `/api/admin/devices/:id/app` now accepts `action: 'show' | 'hide' | 'restart'`. Routing is unchanged: `android` → gateway `app.<action>`, others → legacy `device_http` `/api/app/<action>`.
- **Linux** — `browser/linux/src-tauri/src/lib.rs` adds a `set_kiosk_visible(bool)` command that shows/hides every kiosk window (hide reveals the Pi OS desktop) and re-asserts fullscreen on show; `browser/linux/src/screens/KioskScreen.tsx` maps `/api/app/hide`/`/api/app/show` to it. `server/src/routes/app.ts` exposes `/api/app/show`/`/api/app/hide` (ack-only) and keeps `/api/app/restart` (exits non-zero); the lib.rs sidecar-termination handler still maps non-zero sidecar exit → kiosk `exit(1)` so systemd `Restart=on-failure` relaunches on restart. Boot autostart is already provided by `packaging/systemd/canvas-display-browser.service` (`WantedBy=default.target`; requires `systemctl --user enable` + auto-login).
- **Android** — new `KioskService` (foreground service) keeps the process at foreground priority while the activity is hidden and is what raises the activity (foreground services are exempt from background-activity-launch restrictions). New `BootReceiver` starts it on `BOOT_COMPLETED`. `MainActivity.kt`: `hideApp()` → `moveTaskToBack(true)`; `showApp()` → start `KioskService` ACTION_SHOW; `restartApp()` → `AlarmManager`/`PendingIntent` relaunch. `CoreEdgeClient.kt` routes `app.hide`/`app.show`/`app.restart`. Manifest adds `FOREGROUND_SERVICE` + `RECEIVE_BOOT_COMPLETED` + the service/receiver declarations.
- Web — `web/src/api/client.ts` widens `deviceAppAction` to `'show' | 'hide' | 'restart'`; `web/src/pages/DevicesPage.tsx` swaps Start/Stop buttons for Show/Hide (keeps Restart).
- Validation: `tsc --noEmit` passes for Core, server, web app, and Linux frontend; `cargo check` (browser/linux/src-tauri) and `:app:compileDebugKotlin` (browser/android-native) pass with only pre-existing warnings. **No on-device validation** — not yet confirmed on a live Pi or Android tablet, and the foreground-service notification + boot behaviour are untested on-device.

### Release builds (2026-09-26)

Built both edge-app artifacts, including their arch-correct/signed variants:

- **Android signing (fixed)** — generated a private release keystore and wired it into the build:
  - Keystore: `browser/android-native/keystore/canvas-edge-release.keystore` (PKCS12, RSA 2048, 30-yr), alias `canvas-edge`.
  - Credentials: `browser/android-native/keystore.properties` (gitignored). `app/build.gradle.kts` reads it for `signingConfigs.release` and falls back to unsigned when absent. `.gitignore` now excludes `*.keystore`/`*.jks`/`keystore.properties`.
  - Signed release APK: `app/build/outputs/apk/release/app-release.apk` (28.0 MB) — SHA-256 `ac13fc4d12a9d078dfa8054bce2eb3efadf21e9301e05c5af28f59400a8eb040`. Verified with `apksigner verify` (cert CN `Canvas Display Edge`, SHA-256 `fbb88ba1d3b1a63196a2aaffb3af15d693c9cf11fb7d1b504b674b9a37a75fc1`).
  - Debug APK still available: `debug/app-debug.apk` (29.5 MB) — SHA-256 `3583d7a4d69f202a1866ee77870b47159119eff5c113e3f5e3f80ad7104e2844`.
- **Linux kiosk arm64 (fixed via native Pi build)** — built natively on the Pi (`192.168.1.216`, `housedisplay`), with SSH authorized by the owner:
  - Backed up remote `src-tauri/src/lib.rs` and `src/screens/KioskScreen.tsx` to `*.bak-20260926` before syncing my updated versions (which add `set_kiosk_visible` + the show/hide handling).
  - The Pi's `PATH` lacked `~/.cargo/bin`, so `/usr/bin/rustc` 1.85 was picked up and failed the MSRV check; building with rustup's `1.88.0` toolchain (`PATH=~/.cargo/bin:...`) succeeded.
  - `npm run tauri:build -- --bundles deb` succeeded (2m54s Rust release). Artifacts under `/home/spetchal/build/canvas-browser/src-tauri/target/release/`:
    - binary `canvas-display-browser-linux` (ARM aarch64, 6.2 MB) — SHA-256 `9bddf1557beab733890df742ba446235f2df979ba5ab6c8e112e2215150fd60b`.
    - `bundle/deb/Canvas Display_0.3.1_arm64.deb` (28 MB) — SHA-256 `8f18bbb3e59dda5b748353cf2afe1c029027f47966a173331962089f018839e7`.
  - x86_64 reference build (local host) also produced `Canvas Display_0.3.1_amd64.deb` (36.5 MB) — SHA-256 `18d6955b347ec32462d596026e914b6ffe1ff4a9b28daea1523a902055263e2b`.
- **Deployed (2026-09-26, owner-authorized)** — both edge apps now run the new show/hide/restart build:
  - **Pi kiosk** — old binary backed up to `/usr/bin/canvas-display-browser-linux.bak-20260926` (SHA-256 `527ab69d…`), new arm64 binary installed to `/usr/bin/` (`sudo install`) and `systemctl --user restart canvas-display-browser.service`. Verified: service `active` with a new MainPID, `/tmp/canvas-ui-kiosk.log` shows a clean `setup: done`, and the on-disk binary SHA matches the arm64 build (`9bddf155…`). Sidecar/resources at `/usr/lib/Canvas Display/binaries/` unchanged.
  - **Android tablet** (`A1064US260402203`) — `adb install -r app-debug.apk` succeeded as an **in-place update** of the debug-signed app (firstInstallTime preserved → enrollment retained). Merged manifest confirms `KioskService`, `BootReceiver`, and both `FOREGROUND_SERVICE`/`RECEIVE_BOOT_COMPLETED` (granted).
  - **Core + web deployed (2026-09-26, owner-authorized)** — rebuilt `core/dist` + `core/public` locally, backed up the remote `core/dist`/`core/public` (`/home/spetchal/canvas-core/dist-public-backup-20260926.tar.gz`), rsync'd only those two dirs (nginx.conf/docker-compose.yml/tls/.env/mcp scripts **untouched**, preserving the remote's live divergences), and `docker compose up -d --build canvas-core`. Verified: health `200` (`role canvas-core v0.3.1`), the running image contains the new `show|hide|restart` route, and the served web admin (`public/assets/index-v0b-wjyF.js`) contains "Show app"/"Hide app". The Pi kiosk is already re-requesting `/api/*` from the new Core.
  - **Still to verify live** — no real show/hide/restart button press yet (requires admin login in the web UI); that is a user click-test, not an infra step.

### Post-deploy bug fixes (2026-09-26)

User-reported after the above deploy; root-caused and refixed:

- **Android app stuck at logo** — `logcat -b crash` showed a `MissingForegroundServiceTypeException` from `KioskService.onCreate` `startForeground()`: Android 16 (API 36) requires a `foregroundServiceType`. Fixed: manifest `android:foregroundServiceType="specialUse"` + `<property PROPERTY_SPECIAL_USE_FGS_SUBTYPE>` + `FOREGROUND_SERVICE_SPECIAL_USE` permission, plus `Service.startForeground(id, notif, FOREGROUND_SERVICE_TYPE_SPECIAL_USE)` on API 34+; `startForegroundService` calls in `MainActivity`/`BootReceiver` wrapped in try/catch so a FGS failure can never crash-loop the kiosk. Rebuilt + `adb install -r`; verified the process stays alive and `KioskService` runs `isForeground=true types=0x40000000`.
- **Linux hide did nothing** — root-caused in stages: `set_kiosk_visible` is reached, but `webview_windows()`/`get_webview_window("main")` both return empty because the kiosk window is a plain `Window` (not a `WebviewWindow` — `is_webview_window()` is false), and injecting `WebviewWindow` also fails. Final fix: inject `tauri::Window` directly and do `set_fullscreen(false)` + `hide()` (and `show()` + `set_focus()` + `set_fullscreen(true)`). Rebuilt natively on the Pi and redeployed. **Confirmed working** — `/tmp/canvas-ui-kiosk.log` shows repeated `[set_kiosk_visible] hidden -> Ok(())` / `shown + fullscreen` from the user's hide→show cycles.
- **Linux "Test Speaker" 502 `mpv exited 2`** — the device's `audio_config.speaker_device` was a bare PipeWire sink name (`bluez_output.09_B8_EB_E3_4D_90.1`), but `mpv --audio-device=` needs an `<ao>/<device>` form (`pipewire/bluez_output…`); a bare name is rejected ("Audio output … not found!"). Two-part fix:
  - Code: added `mpvAudioDevice()` in `server/src/routes/settings.ts` (prefixes bare names with `pipewire/`), applied to `test-speaker` and the `test-mic` playback path. Typechecked but **not yet deployed** (see sidecar rebuild blocker below).
  - Immediate workaround: updated the device's `audio_config.speaker_device` in the Core DB to `pipewire/bluez_output.09_B8_EB_E3_4D_90.1` (via the core container's `pg` driver); verified `mpv --audio-device=pipewire/bluez_output…` exits 0.
- **Sidecar aarch64 rebuild blocker** — `pkg` (6.14.2) `--target node20-linux-arm64` produces a broken sidecar: runtime `Cannot find module '/snapshot/server/dist/index.js'` (arm64 bytecode generation drops the entry; `--no-bytecode` alone errors). The x64 sidecar builds fine, and rolling back to the previous arm64 sidecar restored the kiosk from a crash-loop. The `mpvAudioDevice` code fix will take effect once the sidecar is rebuilt correctly (native build on the Pi, or a pkg config that avoids the arm64 bytecode bug).

## Other local validation during audit

Read-only audit workers reported:

- No-emit TypeScript checks passed for Core, contract tooling, server, web application, Linux frontend, separate editor application, and Hermes TypeScript service.
- Contract validation: 33 fixtures passed; generated TypeScript contract drift check passed.
- 43 tests passed across conformance, Hermes/voice/media regression, direct HA control and AI flow drafting. A separate audit also ran the overlapping 28-test Hermes regression suite; do not count it twice.
- End-of-speech tests: 6 passed.
- Python AST parsing: 17 HA/plugin files passed (no imports or live integration).
- Shell syntax checks passed for Debian lifecycle scripts and version-report script.

Not run: full root/Core test suites, Rust builds/tests, Gradle build, production frontend/native builds, Docker deployment, PostgreSQL migration/restore, physical kiosk rendering/audio, live HA/Music Assistant/Hermes acceptance. Historical device-verification statements in existing docs were not revalidated.

## Known problems and release blockers

### Security / trust boundaries

- Plaintext bearer credential in `HANDOFF.md`; coordinate rotation/revocation, do not merely assume deleting the text revokes it.
- Custom SVG stored-XSS path: importer sanitizes descendants but misses root attributes; icon routes accept essentially raw SVG; `web/src/widgets/components/UniversalIcon.tsx` inserts it with `dangerouslySetInnerHTML`. Relevant files: `web/src/components/VectorIconImporter.tsx`, `server/src/routes/icons.ts`, `core/src/icons.ts`.
- `server/src/routes/app.ts` has no caller-auth gate. Core-facing authenticated controls do not protect direct sidecar endpoints. Standalone server may bind all interfaces; embedded kiosk uses loopback.
- Production gateway identity matching in `core/src/gateway.ts` does not demonstrate device private-key possession; nginx config does not enforce client certificates. Known development auth defaults and open pairing remain in Core config.
- Updater manifest fetch disables certificate validation; artifact fetch uses a different validating client. Android disables hostname verification and contains installation-specific TLS/HTTP workarounds.

### Runtime correctness / unfinished integration

- FIXED + ON-DEVICE CONFIRMED (2026-09-27): Linux app show/hide/restart from Core + boot autostart. `browser/linux/src-tauri/src/lib.rs` maps a non-zero sidecar exit to kiosk `exit(1)` (so systemd `Restart=on-failure` in `packaging/systemd/canvas-display-browser.service` relaunches on restart), and adds `set_kiosk_visible` so hide reveals the Pi OS desktop and show restores fullscreen. `KioskScreen.tsx` maps `/api/app/hide`/`show` to it. The earlier "needs on-device confirmation" gap was closed after fixing the kiosk registration bug below: `/api/app/hide` and `/api/app/show` on the embedded sidecar now return `200` and the window visibly hides (Pi desktop) and shows (kiosk content). The Core admin-UI button click-test is still outstanding.
- Native Android renders only `panels[0]` fullscreen and reports desired scene applied before successful render; clean WebSocket close lacks failure-path reconnection. FIXED (2026-09-26): `restartApp()` in `MainActivity.kt` no longer does `startActivity` + immediate `killProcess`; it schedules the relaunch via `AlarmManager`/`PendingIntent` before teardown. Hide/show added via `moveTaskToBack` + a foreground `KioskService`, and boot autostart via `BootReceiver`. Validated with `:app:compileDebugKotlin` only; needs on-device confirmation (foreground-service notification/boot behaviour untested). ON-DEVICE CONFIRMED + FIXED (2026-09-27): the reboot test showed boot autostart was blocked by Android 14+ BAL (`BAL_BLOCK`, result code 102) because a foreground service is not a BAL exemption; added the `SYSTEM_ALERT_WINDOW` permission + a one-time `ensureOverlayPermission()` prompt in `MainActivity`, after which boot raises `MainActivity` (`BAL_ALLOW_SAW_PERMISSION`) and the app reaches `Core: online`. Instrumentation `OK (9 tests)`.
- Native Android application ID changed, so this is not an in-place update of the old app and existing enrollment/data will not automatically migrate. No wrapper/readme/test gate was found; caches and local.properties need staging hygiene.
- Updater commits downloaded nonempty files as known good without actual activation/restart or running-candidate health check. Resume/recovery remains incomplete.
- Packaged separate agent/updater identities lack provisioned access to restrictive IPC socket/directory permissions; updater service address-family restriction excludes AF_UNIX.
- Real gateway resets stream state while claiming accepted resume; conformance harness tests do not exercise this real implementation.
- HA options update precedence prefers original entry data over options in `custom_components/canvas_display/__init__.py`; media-player source is not registered and coordinator media state is absent.
- Custom icon cache is not reactive to switching/editing/deleting populated icons; reads hard-code `/api/icons` and persistence failures are swallowed (`web/src/widgets/utils/customIcons.ts`).
- Timed panel media navigation sends `hide_floating` on expiry rather than restoring the target panel; older timers can dismiss newer content (`server/src/routes/media.ts`).
- Linux historical residual issues: controller allocation on initial fullscreen transition and duplicate startup panel builds. Current generation guard protects convergence, according to historical handoff.

### Build, persistence and documentation

- `core/Dockerfile` copies host-built `core/dist/`; source typechecking does not establish artifact freshness.
- `.github/workflows/release-edge.yml` has a reversed glibc compatibility comparison.
- Some privacy/rollout/broadcast/confirmation state is process-local and will not survive restart.
- Current Core wires visual flows; existing Routines/Skills modules and August docs are not proof those route sets are active.
- Contracts CI is not a complete application gate and omits relevant application-only changes from triggers.
- Existing docs conflict on versions, timeout values, MCP transport, media-player setup, agent networking and updater feed availability. Keep historical acceptance separate from current observations.

## Agent guide follow-up (2026-09-26)

- User requested a maintained `AGENTS.md`. Created the canonical root guide with startup checks, project map, change-safety rules, security constraints, validation expectations, and mandatory maintenance instructions.
- Removed the incomplete `AGENT.md` draft created during the interrupted preceding turn; no preexisting user file was removed.
- `AGENTS.md` holds durable rules; this file holds current progress, validation and next steps. Future agents must review the guide and update this handover after substantive work.
- Documentation-only follow-up: no application code changed and runtime tests were not needed. Both documents were checked for local Markdown link targets; all resolved. Scoped `git diff --check` passed (Git does not check untracked-file contents with that command).

## Active objective restored by user: Core certificates, then both edge deployments

On 2026-09-26 the user recalled that the previous task was a Core certificate issue, after which both Linux and Android edge code needed updating and deployment. This supersedes the audit's inferred task priority. Local evidence supports the recollection, but does not establish the live deployment state.

### Certificate investigation (read-only, 2026-09-26)

- `core/nginx.conf` and Compose already configure RSA plus Ed25519 server certificates; these changes are committed at HEAD. This is compatibility work, not proof that deployment/trust is complete.
- Local public certificates `core/tls/server.crt` and `core/tls/rsa-server.crt` are self-issued, CA:TRUE, valid September 10, 2026 through September 10, 2027. SANs cover IP `192.168.1.108` and DNS `localhost`, not `canvas-core.local`. Explicit-trust OpenSSL IP verification passed; RSA hostname verification for `canvas-core.local` failed.
- Both private-key paths are tracked in Git (contents were not read). Coordinate owner-controlled rotation and exposure/history review; do not reuse exposed keys as a production trust solution.
- Native Android `CoreTls.kt` bundles certificates matching both local Core public certificates. Its clients disable hostname verification. Its custom store does not include normal system roots.
- Android WebView's `network_security_config.xml` includes only the generic bundled certificate, now Ed25519. The deleted legacy Android app's generic certificate was RSA: this trust change during migration is a concrete compatibility clue.
- Android `MainActivity.kt` rewrites Core HTTPS content to HTTP port 3101 rather than resolving WebView trust. Successful rendering through this path is not HTTPS acceptance.
- Linux `browser/linux/src-tauri/src/lib.rs` accepts whichever certificate is supplied by a failed TLS connection for fixed Core hosts; this is not certificate pinning. Rust agent/update download paths also need deliberate trust provisioning.
- `edge/updaterd/src/main.rs` has a manifest certificate-validation bypass, while artifact fetching still validates. Its missing-SAN comment does not describe the current local certificates.
- `scripts/deploy-core.sh` uses `curl --insecure` for health and does not transfer `core/tls/`; success would not establish valid certificates or matching local/remote TLS material. No reproducible certificate-generation/provisioning implementation was found in inspected tooling.
- Build/deploy paths also need checking: Linux kiosk/embedded sidecar is separate from the Rust agent/updater package; release workflow references missing server npm scripts, and fresh web assets are not reliably copied to the kiosk's source asset directory. Native Android lacks a wrapper/signing setup and has a different application ID from legacy Android.
- Validation: local source/config/diff/history inspection, public-certificate metadata and verification, and local build-tool discovery only. No private-key reads, live TLS handshake, SSH/ADB device contact, build, install or deployment. No application code changed in this investigation.

## TLS repair and edge rollout completed (2026-09-26)

- Read-only live checks reached Core (`192.168.1.108`), Pi (`192.168.1.216`) and ADB tablet `A1064US260402203`; both legacy and native Android apps are installed.
- **Confirmed root cause:** live Core still serves July RSA material with no SANs, unlike local September certificates. Strict `https://localhost:3100/health` failed hostname validation. Live nginx has SSE/WebSocket improvements absent locally; preserve those during TLS-only changes.
- New RSA-3072 CA and SAN-bearing server certificate generated ON Core only, under `/home/spetchal/canvas-core-tls-private-20260926/generation-1`. Private keys never transferred/read into tool output. SANs: IP `192.168.1.108`, DNS `localhost`, DNS `canvas-core.local`; leaf expires 2027-10-28. Public CA SHA-256: `6F:A2:C5:29:BB:12:39:AB:5D:07:1B:6D:B5:87:7D:34:A2:15:E6:14:41:4D:D7:18:92:8C:A1:81:B6:76:D9:86`.
- Added `scripts/provision-core-tls.sh`, `tests/tls/test_provision_core_tls.py`, `docs/CORE_TLS.md`; nine real-OpenSSL offline tests passed. Script refuses existing output/Git destinations and protects key permissions.
- Linux WebKit certificate bypass removed, updater manifest bypass removed. Source-policy tests and both Cargo checks passed. Pi-native kiosk build passed and the final candidate was installed at `/usr/bin/canvas-display-browser-linux`; both the build and installed binary SHA-256 are `c2017b3e38eca5216467bd88bb6dc2a1665083ee3707353fd230fe50a09c30ba`. Remote source formatting differences were preserved; source backup lives alongside remote lib.rs.
- Android uses platform trust in all four OkHttp clients, standard hostname checking, no HTTPS downgrade. NSC scopes only the new public CA (`res/raw/canvas_core_ca.pem`) to Core IP and `canvas-core.local`, prohibits Core HTTP and preserves explicit external-panel policy. Seven JVM tests passed. Built debug app and instrumentation APK; instrumented device tests not yet run at this checkpoint.
- Final Android debug candidate SHA-256 is `4169a2b71656faec97009643db7fd9ccefdc0d1fd47ab8bd112722695bf83daa`; instrumentation APK SHA-256 is `402c79328d8b78064f8b66bb46e347eb886a05164f8448ae868bb41710789d37`. Both are under `browser/android-native/app/build/outputs/apk/`. The candidate and installed APK signing-certificate SHA-256 matched before install, so `adb install -r` preserved app data/enrollment and the original `firstInstallTime` (`2026-09-13 01:33:47`).
- Pi public trust is installed at `/usr/local/share/ca-certificates/canvas-core-ca.crt` and matches the authenticated public CA fingerprint. Strict `wget` and OpenSSL verification from the Pi pass for Core IP `192.168.1.108` and DNS SAN `canvas-core.local`.
- Core now serves the new RSA leaf from all four nginx certificate mount paths. nginx configuration validation passed before restart. Strict OpenSSL verification passes for the IP, `localhost`, and `canvas-core.local`; strict `curl --cacert` health returns Core `0.3.1`. The served leaf fingerprint is `4C:30:2D:56:3D:1F:35:91:82:8C:AD:C6:FA:0F:FE:93:56:E3:6B:80:47:AC:58:59:6A:92:C8:91:B1:E6:6D:A2`. Rollback copies are on Core under `/home/spetchal/canvas-core-tls-backup-20260926-before-san-switch`; private material was not copied into this repository or output.
- Android main and instrumentation APKs were installed in place. `am instrument -e coreHealthUrl https://192.168.1.108:3100/health ...` completed `OK (5 tests)`: Core HTTP rejection, untrusted-chain rejection in OkHttp and WebView, and live strict Core HTTPS in OkHttp and WebView passed; two coordinator-only wrong-host fixture cases were skipped by JUnit assumptions. After relaunch, Core logged a new Android WSS connection, active-page replay, `stream.ack`, and `state.reported`; Android reported a fullscreen resumed activity and foreground `KioskService`.
- Restarted the Pi kiosk after the Core switch. No WebKit certificate rejection appeared, the service remained active, and `setup: done` was logged. A controlled service stop/start confirmed one embedded sidecar owns `127.0.0.1:3100`. A second `canvas-display-server` process is intentional: the enabled system `canvas-display-server.service` runs standalone on `0.0.0.0:8099`; both `/health` endpoints return `{"ok":true}`. The stop/start briefly terminated that system instance while checking for a suspected stale process, and systemd restored it immediately. Do not count the two different service modes as a duplicate-port fault.
- No commit or release was created. `AGENTS.md` was reviewed at completion; no durable guidance change was needed.

## Recommended next session

1. Log into the Core admin UI (Devices → device → Application control) and click Show/Hide/Restart for the Pi. The sidecar-level path and the agent forwarding are now confirmed working on-device, so this is a user click-test of the Core→agent→sidecar chain, not an infra step.
2. Android reboot boot-autostart test — DONE (2026-09-27); see the Android boot-autostart fix above. Remaining Android item: decide the signing rollout (installed tablets are debug-signed; moving to the release keystore needs a same-key reinstall or `adb uninstall`, which wipes enrollment).
3. Core-issued scoped HA display sessions (Linux still injects a legacy local HA long-lived token) and the capability/settings/voice acceptance + final platform functionality matrix remain from the parity objective.
4. Optionally test `https://canvas-core.local:3100` from Android if tablet mDNS is intended to be supported; IP-based strict native and WebView acceptance is complete.
5. See `AGENTS.md` → "Build & deployment" for exact commands. Rollback pointers include Core `/home/spetchal/canvas-core-tls-backup-20260926-before-san-switch`, remote `dist-public-backup-20260926.tar.gz`, Pi `/usr/bin/canvas-display-browser-linux.bak-20260926` and `/usr/bin/canvas-display-browser-linux.bak-20260926-parity`, Pi `/usr/bin/canvas-display-server.bak-20260926-parity`, Pi `/usr/bin/canvas-edge-agentd.bak-20260926-parity`, Core `/home/spetchal/canvas-core/core-dist-backup-parity-20260926.tar.gz`, and the arm64 build dirs on the Pi.

Update this file at the end of each session with exact changes, tests/results, unresolved risks and next action. Do not store secrets or replace evidence with assumptions about previous conversations.

## Active edge parity implementation (2026-09-26)

- User selected full practical Linux/Android parity, Gateway v1 as the canonical control path, native layered Android WebViews, durable last-page restore, Core-authoritative settings, explicit unsupported results, and no updater work. Staged deployment to the existing Pi and tablet is authorized.
- Android now parses and renders all visible page panels with percent geometry, z-order, opacity, floating media, load success/failure tracking, and a durable last-successfully-rendered page cache. Scene state is reported applied only after visible WebViews finish; invalid/failed renders report failure. Non-scene desired-state domains now report unsupported failure instead of false success. Media control no longer claims success without a target.
- Linux child WebViews emit load completion/failure to the kiosk. Inline page delivery waits for the kiosk render result before the sidecar returns success, so the Rust agent's Gateway state report reflects observed rendering. The agent's default loopback renderer is corrected to port 3100.
- Core page delivery now chooses a live Gateway connection rather than stale architecture/protocol labels. Gateway app actions check the device's returned `ok` result. Linux `device.action` is handled at the Rust transport boundary with an app-lifecycle allowlist, forwarded to the loopback sidecar, and show/hide wait for the kiosk window result.
- Local validation passed: `core: npm run build`; `server: npx tsc --noEmit`; `browser/linux: npx tsc --noEmit`; `browser/linux/src-tauri: cargo check`; `edge: cargo check -p canvas-edge-agentd`; Android `:app:assembleDebug :app:assembleDebugAndroidTest`. The first Android JVM test attempt failed because `org.json` is an Android stub; the page/cache tests were correctly moved to `androidTest`, after which the instrumentation APK compiled. An offline Gradle attempt also failed only because uncached test dependencies were unavailable.
- Remaining before completion: native Pi kiosk/sidecar/agent builds and deployment; Android APK/test deployment and on-device render validation; Core build/deployment; Core-issued scoped HA display sessions (Linux still has legacy local HA token injection); capability/settings/voice acceptance and the final platform functionality matrix.

## Edge parity deployment + kiosk registration fix (2026-09-26/27)

Owner-authorized staged deployment to the existing Pi (`192.168.1.216`, `housedisplay`) and tablet (`A1064US260402203`). All builds were native on the Pi (arm64, rustup 1.88.0; the Pi's `PATH` lacks `~/.cargo/bin`). The Pi is SD-card-bound and stalls (`mmc0: Card stuck being busy`), so long links were run as low-priority single-job background builds with a status file; one earlier build was lost to a Pi reboot mid-link.

### Android (deployed + on-device validated)

- Installed `app-debug.apk` + `app-debug-androidTest.apk` in place (`adb install -r`), then ran `am instrument -w com.bushrangerlabs.canvas_display_edge.test/androidx.test.runner.AndroidJUnitRunner` → **`OK (9 tests)`** (`EdgePageTest` multi-panel parsing/cache + `PlatformTlsTest`).
- Relaunched the app; confirmed `MainActivity` resumed, two WebView overlays initialized, the status overlay cleared only after load settled, and the assigned control page rendered. Evidence: `artifacts/android/native-edge-multipanel-parity.png` and `-settled.png`.
- Note: `logcat` still shows historical `MissingForegroundServiceTypeException` crashes from a pre-fix build; the current build runs and `KioskService` stays foreground.

### Pi native builds + deployment

- Kiosk `canvas-display-browser-linux` — full `npm run tauri:build -- --bundles deb` (not bare `cargo build`; see build-hygiene note). Installed binary SHA-256 `2a0d729595ad17a60f0d18e2e75ed51e4fdc3f14a55e9b1a27fc61dfa29643fd`.
- Sidecar `canvas-display-server` — `npm run build` + `esbuild` bundle + `pkg --target node20-linux-arm64 --no-bytecode`. SHA-256 `9fc52a004bd12728d221d9a6148575192d286a331df509581d0e2fba87aaf092`. Standalone smoke test on `127.0.0.1:3199` returned `{"ok":true}`. This rebuild also carries the earlier `mpvAudioDevice()` speaker-device fix that had been blocked by the arm64 `pkg` bytecode bug (the `--no-bytecode` invocation now produces a working arm64 binary).
- Agent `canvas-edge-agentd` — `cargo build --release -p canvas-edge-agentd` (9m18s). SHA-256 `9572f572d5afe4fe2a4e33a800194abcf2c9a6211ebf65c91d6a7483f6a6e8da`. Restarted; logs show `canvas-edge-agent v0.3.0`, `connected to Core`, `core.welcome`, `state.desired`, `stream.ack`, `state.reported`.
- Backups before install: `/usr/bin/canvas-display-browser-linux.bak-20260926-parity`, `/usr/bin/canvas-display-server.bak-20260926-parity`, `/usr/bin/canvas-edge-agentd.bak-20260926-parity`.

### Core (deployed)

- Backed up remote `core/dist` → `/home/spetchal/canvas-core/core-dist-backup-parity-20260926.tar.gz`; rsync'd `core/dist/`; `docker compose up -d --build canvas-core`. Health `200`; logs show live traffic (assets, `/api/scenes/*/published`, `/api/ha/entities`, gateway `state.reported`).

### CRITICAL BUG FOUND + FIXED: kiosk never registered with the embedded loopback sidecar

- Symptom: `POST http://127.0.0.1:3100/api/app/hide` returned `504 {"ok":false,"error":"no kiosk renderer is connected"}`.
- Diagnosis: `ss -tnp` showed **no established WebSocket** from the WebView to `127.0.0.1:3100`, while a direct `ws` probe from the Pi connected fine and received `hello_ack` + `load_page` (so the sidecar was healthy). The Pi screen was blank white (the main webview was not rendering the kiosk UI).
- Root cause: `browser/linux/src/hooks/useServerSocket.ts` `onerror` called `ws.close()` unconditionally. The local renderer socket connects at kiosk start, before the embedded sidecar is listening; the initial connection refusal fired `onerror`, and the unconditional `close()` prevented the normal `onclose`→reconnect path, so the socket never recovered. The control-channel socket was unaffected because Core was already up on its first attempt.
- Fix: only call `ws.close()` when `ws.readyState === WebSocket.OPEN`.
- Validation after fix: established WS to `127.0.0.1:3100` present; kiosk log shows `[create_panel_webviews]`; `/api/app/hide` → `200 {"ok":true,"action":"hide","result":{"action":"hide"}}`; `/api/app/show` → `200`; `grim` screenshots show the Pi desktop (brown wallpaper) when hidden and kiosk content when shown. Full hide/show cycle confirmed on-device.
- Core→agent→sidecar path verified in code: `edge/agent/src/transport/connection.rs` `handle_device_action` forwards `app.show|hide|restart` to `scene_server_url`, which defaults to `http://127.0.0.1:3100` (`edge/agentd/src/main.rs`); `/etc/canvas-edge-agent/renderer.env` sets `CANVAS_EDGE_SCENE_RENDERER_MODE=core`. The kiosk registration was the missing link.

### Build hygiene (learned this session)

- A bare `cargo build --release` in `browser/linux/src-tauri` did **not** re-embed a rebuilt frontend (the binary SHA stayed identical after a frontend edit). Use `npm run tauri:build` (which runs `npm run build` first) when frontend changes must reach the binary.

### Android boot-autostart bug found + fixed (2026-09-27)

- Reboot test (`adb reboot`) revealed the kiosk did **not** come to the foreground: `BootReceiver` fired and `KioskService` started as a foreground service, but `KioskService.bringToFront()`'s direct `startActivity()` was blocked — `ActivityTaskManager: Background activity launch blocked! ... BAL_BLOCK ... result code=102` — so the tablet landed on `launcher3`. The code comment's assumption that a foreground service is exempt from Android 14+ background-activity-launch (BAL) restrictions is wrong.
- Fix: `SYSTEM_ALERT_WINDOW` is a documented BAL exemption. Added `<uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" />` to `AndroidManifest.xml` and a one-time `ensureOverlayPermission()` in `MainActivity` that launches `Settings.ACTION_MANAGE_OVERLAY_PERMISSION` when `Settings.canDrawOverlays()` is false.
- Validation after fix: rebuilt `:app:assembleDebug` (Gradle 8.14.3 from `~/.gradle/wrapper/dists`, AGP 8.7.3), `adb install -r` (in-place, enrollment preserved), granted the appop, rebooted. Log now shows `START ... MainActivity ... (BAL_ALLOW_SAW_PERMISSION) result code=0`, `ResumedActivity: .../.MainActivity`, `KioskService isForeground=true`, and `CanvasEdge: Core: online`. The first-run prompt path was also verified (`MANAGE_OVERLAY_PERMISSION` → `Settings$OverlaySettingsActivity`). Instrumentation re-run: `OK (9 tests)`. Evidence: `artifacts/android/native-edge-boot-autostart.png`.
- Provisioning note: the overlay grant is a one-time user action (or `adb shell appops set com.bushrangerlabs.canvas_display_edge SYSTEM_ALERT_WINDOW allow`). Without it, boot autostart and Core's remote `app.show` fall back to the launcher.

### Commit + push (2026-09-27)

- Committed this session's fixes (`19225d9`) and tracked the native Android app (`3d0281b`), then pushed `main` to `origin` (`cfdf0d1..c3392b9`). Local and remote `main` now match.
- The push was first blocked: the unpushed commit `5198576` ("chore: update Android edge and platform work") had accidentally committed **20.11 GiB** of Android ROM artifacts under `artifacts/android/` (176 files, e.g. `system.raw` 3.2 GB). GitHub rejects >100 MB files and >2 GB pushes, and `git push` hung trying to compress them.
- Fix: rewrote that commit to `5eee549` (dropping `artifacts/android/`, keeping its 1303 source files), replayed the two session commits on top, added `artifacts/` to `.gitignore` (`c3392b9`), and pushed. Because `5198576` was never pushed, this was a clean fast-forward — **no force-push and nothing lost on the remote**. The 20 GB of ROMs remain on disk, now untracked/ignored.
- Note: `browser/linux/src-tauri/binaries/canvas-display-server-*` (~55–63 MB each) are tracked and triggered GitHub's >50 MB warning (accepted, under the 100 MB hard limit).

### Still outstanding after this session

- Core admin-UI Show/Hide/Restart button click-test (needs admin login).
- Android signing rollout decision (installed tablets are debug-signed).
- Core-issued scoped HA display sessions (Linux still injects a legacy local HA long-lived token).
- Capability/settings/voice acceptance and the final platform functionality matrix.

## Edge + Core feature parity workstream (2026-09-27)

User directive: **both** edge apps (Linux kiosk + native Android) must support the same functions, and Core must support them. Target is **full parity**. Tracked here so items can be marked off. Legend: `[ ]` not started · `[~]` partial · `[x]` done · `[?]` needs a decision.

### Voice control

- `[x]` **1. Intent model routing + conversation model + vision model + cloud fallback.** VERIFIED + EXTENDED (2026-09-27): the live Core DB has providers `router-qwen3`, `hermes-conversation`, `vision-qwen3vl` (→ `http://192.168.1.108:8083/v1`), `Gemini`, `Openrouter`, `unsloth/Qwen3.6-35B…`, with `ai_task_assignments`: `intent_routing→router-qwen3`, `conversation→hermes-conversation`, `vision→vision-qwen3vl`, `embedding→unsloth/…`, `asr→local-asr`, `tts→local-tts`. The vision model (`Qwen3-VL-8B-Instruct`) answered a test image correctly. **Cloud policy (new):** `CANVAS_CORE_CLOUD_AI_ENABLED` (master switch, default off) + `CANVAS_CORE_CLOUD_AI_PROVIDER` (provider id; empty = first non-local LLM). When enabled, the cloud model is used (a) directly for coding/HA-automation drafting (`checkAutomationGaps`) and (b) only as the **last-resort** candidate in chat (`conversationCandidates` appends it after all local candidates). Every cloud invocation is logged separately to the new `cloud_ai_usage` table (purpose/provider/model/device/operation/latency/ok/error/prompt/response) for later fine-tuning. Note: `local-asr`/`local-tts` assignments have no matching provider row (dangling).
- `[~]` **2. Full YouTube control.** Findings (2026-09-27): both platforms expose the same `__canvasYouTubeControl` API (`pause`/`resume`/`stop`/`next`) and Core routes `media.play`/`media.control` to both. The Linux gaps vs Android were: no plain-HTML5 fallback (so non-YouTube `<video>`/`<audio>` could not be controlled) and the Rust command only targeted the `floating` webview. FIXED: `control_youtube_webview` now tries the IFrame bridge then falls back to HTML5 media control, and falls back to the last `panel-*` webview when the requested label is gone. Remaining: seek/volume/previous are not exposed by the player bridge on either platform — confirm whether "full" control needs them.
- `[x]` **3. General-question intents → Wikipedia page, search-engine fallback, settable auto-return timer (configurable in code).** Findings (2026-09-27): already implemented — `resolveKnowledgeUrl` opens the Wikipedia article (opensearch) and falls back to a search engine; `openUrl` sends `revert_after_ms` (Android `navigate.search`, Linux `/api/media/open` → `show_floating`/`hide_floating`); the period comes from the `knowledge_display_seconds` setting, defaulting to `config.knowledgeDisplaySeconds` (`CANVAS_CORE_KNOWLEDGE_DISPLAY_SECONDS`, default 30). FIXED: the configured LAN SearXNG (`SEARXNG_PUBLIC_URL`) was never used — the fallback now prefers it and only uses public DuckDuckGo as a last resort.
- `[x]` **4. DAB+ radio.** IMPLEMENTED + VERIFIED (2026-09-27): the SDR radio runs as `sdr-radio-1`/`sdr-radio-2` containers on the Core host (192.168.1.108) with a REST API (`:8088`/`:8091`) and Icecast (`:8001`/`:8002`). `dab.play` resolves the station via `GET /api/stations` (`{dab:[{id,name,city}]}`), tunes via `POST /api/tuners/<tuner>/play {"station":"dab:<id>"}`, and plays the Icecast stream (`http://192.168.1.108:8001/tuner1.mp3`) on the device. Verified: tuning `dab:triplem` → Triple M (9B, 204.64 MHz), Icecast serves `audio/mpeg`. Config: `SDR_RADIO_URL`, `SDR_RADIO_TUNER`, `SDR_RADIO_STREAM_URL`. Note: this is the SDR REST API directly, not routed through Music Assistant.
- `[~]` **5. Works with Music Assistant.** Findings (2026-09-27): the server (sidecar) already supports `source: 'music_assistant'` on `/api/media/play` and `/api/media/control` (resolves via HA/Music Assistant), but Core's voice path hard-rejected any non-YouTube source (`playMedia`/`controlMedia` returned "not supported"), and the intent router's music pattern emitted an unregistered `media.search` tool with no source. FIXED: Core `playMedia`/`controlMedia` now route `source: 'music_assistant'` to the device's local server via `device_http` (Linux), and the intent router's music pattern now emits `media.play` with `source: 'music_assistant'`. **Remaining:** Android has no local server, so Music Assistant playback there depends on the HA media_player workstream item (item 1).
- `[x]` **6. Works with the MCP servers set up in Core.** VERIFIED (2026-09-27): Core loaded 8 MCP servers from the DB and registered 154 MCP tools into the tool registry (`[core][mcp] registered 154 MCP tools into tool registry`). Servers include `ha-mcp` (camera images → vision), `node-red mcp`, `web-search`, `au-weather`, `bowling`, `afl-mcp`.
- `[~]` **7. Custom skills in Core.** DECISION (2026-09-27): treat the visual **Flow** engine as the custom-skill mechanism; ensure voice can trigger Flows (there is already a `trigger_intent` flow trigger). No separate Skills system will be built.
- `[x]` **8. Dispatcharr voice commands.** IMPLEMENTED + VERIFIED (2026-09-27): Dispatcharr runs on the Core host (192.168.1.108:9191, v0.28.2, 55,382 channels). Core resolves channels from the unauthenticated HDHomeRun lineup (`GET /api/hdhr/lineup.json`) and plays the stream URL on the device. Added `dispatcharr.play` + `dispatcharr_play` intent. The authenticated API (`X-API-Key`) also works (for channel/EPG browsing later). Config: `DISPATCHARR_URL`. The API key is NOT stored in the repo — pass it via env if authenticated access is needed. Remaining: on-device playback check.

### Other functions

- `[~]` **1. Both edge apps present themselves to Home Assistant as media players.** Findings (2026-09-27): the HA custom component's `media_player.py` existed but was **never set up** (`PLATFORMS` excluded `MEDIA_PLAYER`) and had no data source. FIXED: added `Platform.MEDIA_PLAYER` + the coordinator polls `/api/media/state` (Linux kiosk). Per-device for both platforms (option A, chosen by the user): `MqttNavigationService` now publishes `homeassistant/media_player/canvas_<device_id>/config` for every registered device on MQTT connect, subscribes to `canvas/devices/+/media_player/cmd`, and publishes per-device state via `updateMediaState` (called from Core's media actions). Remaining: needs MQTT enabled + an end-to-end HA check; the per-device state is in-memory (resets on Core restart).
- `[~]` **2. Amazon-Echo-style audio broadcast.** FINDINGS + IMPLEMENTED (2026-09-27): the broadcast infrastructure already existed — Core `POST /api/edge/tts/broadcast` (multi-room TTS), `POST /api/edge/intercom/broadcast` (recorded audio), `POST /api/edge/alert/broadcast` (overlays), each polled by the edge sidecar (`voice/{tts,intercom,alert}-broadcast-poller.ts`), plus flow nodes `action_broadcast_alert`/`action_broadcast_intercom`. The missing piece was a VOICE trigger: added an `announce.broadcast` tool + an `announce_broadcast` intent (`announce <message>` / `broadcast <message>` / `tell everyone <message>`) that enqueues a TTS broadcast to all displays. Remaining: the SIP option (a Docker SIP server for true two-way intercom) is still a design choice, not implemented.
- `[~]` **3. Dispatcharr (IPTV) support.** IMPLEMENTED (2026-09-27): see voice item 8 — Core resolves channels via the Dispatcharr HDHomeRun lineup and plays the stream URL on the device. Remaining: end-to-end check; channel browsing/EPG not yet surfaced in the UI.
- `[~]` **4. Extra widget controls in Core's editor for DAB+ radio and Dispatcharr scenes.** IMPLEMENTED (2026-09-27): added `DabRadioWidget` (`dabradio`) and `DispatcharrWidget` (`dispatcharr`) to the widget registry + lazy map, backed by new Display-server routes `GET/POST /api/dab/{stations,play}` and `GET/POST /api/dispatcharr/{channels,play}` (which proxy the SDR REST API and the Dispatcharr HDHR lineup). Remaining: build + deploy the web app and verify in the editor.

### Notes

- Full parity is the target; inherently OS-specific functions will be implemented per-platform with equivalent outcomes (and explicit `unsupported` results where a platform genuinely cannot do something).
- Android's YouTube voice control is considered the more mature reference implementation; align Linux to it.
- This is a first-pass source audit. Each item needs a deeper pass before implementation.
- Agreed order (2026-09-27): (1) finish the `[~]` items — HA media-player per-device, Music Assistant + MCP end-to-end from the edge voice path, Wikipedia/search fallback + return timer, full YouTube control; (2) add the missing pieces — vision model, DAB+ (`dab_play_station`), Dispatcharr, editor widgets; (3) audio-broadcast design (intercom → all-devices + optional SIP).

## Cloud-AI settings, ASR/TTS fix, SIP intercom, and deploy (2026-09-27)

- **Cloud AI is now a Core setting, not env.** `cloud_ai_enabled` / `cloud_ai_provider` live in the `settings` table; the intelligence pipeline reads them live via `cloudPolicy` (refreshed on `settingsChanged`). The admin UI has a **Cloud AI** section on the Settings → AI tab (toggle + provider picker). Env vars remain only as initial defaults.
- **Dangling `local-asr` / `local-tts` fixed.** Added provider rows: `local-asr` (whisper → `http://host.docker.internal:10301`, model `Systran/faster-whisper-base.en`) and `local-tts` (piper → `host.docker.internal:10200`). Downloaded `Systran/faster-whisper-base.en` + `small.en` into the speaches container. Core health now reports `local-asr UP`, `local-tts UP`, `mcp 8/8 up`, `ha 2107 entities`. (Note: `local-tts` also comes from the simple-mode env, so the DB row logs a benign "already registered" warning.)
- **SIP intercom installed.** `deploy/sip/` (Asterisk 20 in Docker, host network) deployed to the Core host as `canvas-sip` (healthy). Endpoints `1001`–`1003`; dialplan calls a single device or `8000` to page all. Config in `deploy/sip/config/`; passwords are `CHANGE_ME` placeholders (not committed as real secrets). Remaining: the edge apps do not yet embed a SIP client.
- **Deployed.** Rebuilt `web/dist` → `core/public` and `core/dist`, backed up the remote (`core-dist-public-backup-20260927.tar.gz`), rsync'd both, and `docker compose up -d --build canvas-core`. Verified: Core health 200; the served bundle (`index-DTgQps0s.js`) contains `dabradio` + `dispatcharr`; providers UP as above.

## Audio broadcast (record → store → fan-out) (2026-09-27)

Decision: **neither SIP nor WebRTC** for this feature. The flow is record-then-playback (store-and-forward), no tight sync is needed, and the fan-out must reach HA media players / Music Assistant — which SIP/WebRTC cannot address (they're HA entities). So Core stores the clip and hands out a URL; HA/MA play it via `media_player.play_media`. WebRTC is deferred to a future *live* intercom; the SIP container stays as an optional telephony bridge.

- **Core** (`core/src/broadcast.ts` + `index.ts`): `BroadcastStore` (in-memory, 10-min TTL) + `POST /api/edge/broadcast` (authenticated) stores a clip, serves it at `GET /api/broadcast/:id.<ext>`, and fans out to **every connected edge device** (reusing the `direct_audio` play path) and **every HA `media_player.*` entity** (`media_player.play_media`). `CANVAS_CORE_PUBLIC_URL` (default `https://192.168.1.108:3100`) forms the served URL.
- **Voice flow**: `POST /api/edge/voice/turn` — a transcript matching `broadcast` arms a recording (`pendingBroadcasts`) and replies "What do you want to broadcast?"; the next turn's `audioBase64` is stored + fanned out instead of transcribed. No edge changes needed (the edge already records + uploads audio).
- **Widget**: `BroadcastWidget` (`broadcast`) — records via `MediaRecorder`, uploads to the Display server's `POST /api/broadcast` (new `server/src/routes/broadcast.ts`, which proxies to Core with the edge token).
- **Automation node**: `action_broadcast_announce` (flow) — speaks a message on every display + media player via `broadcastAnnounce` (Core TTS → clip → fan-out).
- **Deployed + verified**: Core health 200; the served bundle (`index-Cks1tiIN.js`) contains `Record broadcast` + `action_broadcast_announce`.
- Remaining: an on-device acceptance pass (record from a real edge, confirm playback on the other edge + an HA/MA speaker).

## Broadcast fan-out fix + DAB+ routing fix (2026-09-27, this session)

### Broadcast fan-out reached 0 edges — root-caused and fixed

Symptom: `POST /api/edge/broadcast` returned `{"edges":0,"ha":23}` even though the Pi agent was connected.

Diagnosis (with temporary per-device logging in `broadcastFanOut`):
- `gateway.connectedDeviceIds()` was **not** empty — it returned the Pi device. The earlier hypothesis was wrong.
- The real failure was the device-side play call: the Pi kiosk relays `device_http /api/media/play` to its local Display server, which rejected the broadcast URL with **"Provided URL appears to be a webpage, not a direct audio stream"**.

Root causes and fixes:
1. **`server/src/routes/media.ts`** — `isLikelyAudioStreamUrl()` did not recognise the container formats Core's broadcast store serves. Added `wav|m4a|mp4|webm` to the extension regex so a recorded clip URL is never mistaken for a webpage.
2. **`browser/linux/src/screens/KioskScreen.tsx`** — the kiosk's `/api/media/play` handler opened a floating WebView for *every* response and threw when the response had no top-level `url`. mpv-backed audio (`direct_audio` / `radio_browser` / `music_assistant`) returns `backend: 'mpv'` with no `url`, so the handler threw and the fan-out counted a failure. Now only the `youtube_iframe_api` backend opens a WebView; mpv-backed audio is accepted as-is.
3. **Android** (`CoreEdgeClient.kt` + `MainActivity.kt`) — `media.play` previously always opened a WebView. It now passes the `source` through and plays `direct_audio` through a native `MediaPlayer` (no window), which is what a broadcast clip needs.

### CRITICAL operational finding: nftables port redirect 3100 → 8099 on the Pi

The Pi runs **two** Display servers: the kiosk-spawned one on `127.0.0.1:3100` and the system service `canvas-display-server.service` on `0.0.0.0:8099`. `canvas-port-redirect.service` installs an nftables `nat OUTPUT` rule:

```
ip daddr != 192.168.1.108 tcp dport 3100 redirect to :8099
```

So the kiosk's `fetch('http://127.0.0.1:3100/...')` is **redirected to the system service on 8099**. Updating only `/usr/bin/canvas-display-server` is not enough — `canvas-display-server.service` must be restarted too, or the old code keeps serving. This cost real debugging time; check it first for any "the sidecar change didn't take effect" symptom.

### Verification (live)

- Broadcast: `edges=2` (Pi + Android). Pi `mpv` played the clip; Android `MediaPlayer` fetched and played the 6 s clip natively (`setDataSource` → `onAudioDeviceUpdate` → played ~6 s).
- DAB+: `play triple m on dab` → `dab.play` → SDR tuned `dab:triplem`; Pi `mpv` playing `http://192.168.1.108:8001/tuner1.mp3` (title "Triple M").
- Dispatcharr: `play the news channel on dispatcharr` → Pi `mpv` playing the Dispatcharr proxy stream ("UK: SKY SPORT NEWS").
- Voice broadcast arming: `broadcast` → "What do you want to broadcast?"; `announce dinner is ready` → "Announcing: dinner is ready".
- Cloud-AI switch: `cloud_ai_enabled` / `cloud_ai_provider` are read from the `settings` table (env only as defaults); no rows set → disabled (correct default). The deployed bundle contains the Cloud AI settings UI.

### DAB+ intent routing fix

`core/src/intent-router.ts` matched DAB+ phrases but emitted `media.play` with `source: 'music_assistant'` instead of the `dab.play` SDR tool, so "play X on dab" never hit the SDR REST API. Fixed to emit `dab.play`; added `dab_play → dab.play` to `mapIntentToTool` and `{ station }` to `mapIntentSlotsToToolParams` in `core/src/intelligence.ts`, and added `dab_play`/`dispatcharr_play` to the no-TTS-over-playback list.

### HA media_player per-device — MQTT discovery is impossible

**Verified against the HA source**: `homeassistant/components/mqtt/` has **no `media_player.py`** — HA's MQTT integration does not support `media_player` at all (neither YAML nor discovery). The `homeassistant/media_player/canvas_<device>/config` discovery messages published by `MqttNavigationService` are retained on the broker but HA silently ignores them, which is why no `media_player.canvas_*` entities ever appeared (only the custom-component `media_player.canvas_ui_device` exists).

Consequence: per-device HA media players must come from the **`canvas_display` custom component** (this repo), not MQTT. That requires deploying the component to the HA config dir, which this session could not reach (no SSH/Samba credentials for the HA host). The MQTT discovery publishing in `MqttNavigationService` is now dead weight and should be replaced by a Core API the component can poll.

**Implemented (needs HA deployment):**
- Core: `GET /api/edge/devices` (edge-token auth) returns every registered device with `{id,name,architecture,online,media}`; `POST /api/edge/devices/:id/media/play` and `/media/control` route to the device (gateway `media.play`/`media.control` for Android, `device_http` for the kiosk) and update the MQTT media state. Verified live: play reached the Pi (`mpv` playing) and stop returned it to idle.
- `custom_components/canvas_display`: new **Core mode** (`core_mode` + `edge_token` in the config/options flow). In Core mode the coordinator polls `/api/edge/devices` and the media_player platform creates **one entity per device** (dynamic — new devices are added on refresh). Legacy single-device mode is unchanged.
- **Deployment still required**: copy `custom_components/canvas_display` into the HA config dir (or update via HACS) and add a Core-mode config entry (URL `https://192.168.1.108:3100`, edge token). This session had no HA config access, so the entities are not yet live in HA.

### Full YouTube control (previous / volume / mute)

Both edges previously exposed only `pause`/`resume`/`stop`/`next`. Added the rest across every layer:

- **Player bridge** (`core/src/youtube.ts` + `server/src/services/youtube.ts`): `previous()` (cycles candidates backwards, falls back to `player.previousVideo()`), `volume(level)`, `mute(muted)`.
- **Linux kiosk**: `control_youtube_webview` now takes an optional `value` and allowlists `previous`/`volume`/`mute`; the `youtube_*` WS handler and the `device_http /api/media/control` relay both pass it.
- **Android**: `MultiPanelRenderer.controlMedia(action, value)` and the `media.control` gateway handler accept the new actions + value.
- **Core**: `controlMedia`/`controlDeviceMedia` carry `value`; new tools `media.previous`, `media.volume`, `media.mute`; the edge device API forwards `source`.
- **Double-execution fix**: the kiosk relays `device_http /api/media/control` to the sidecar, which *also* broadcast `youtube_*` back to the kiosk over `/ws` — so `next`/`previous` ran twice. The kiosk now sends `x-canvas-relay: 1` and the sidecar skips the broadcast for relayed requests (the kiosk performs the control itself).

Verified live: play a YouTube query, then `pause`/`resume`/`next`/`previous`/`volume`/`mute` all return `ok`; the sidecar reports an active `playback_id` with 10 candidates.

### Music Assistant — findings and what is actually blocking it

Investigated the MA path end-to-end. Findings:

- MA server (`big-bear-music-assistant-server`, v2.8.7, host network, `:8095` UI/API, `:8097` streams) is running and HA's `music_assistant` integration is loaded.
- **MA has no music providers with content.** `settings.json` shows music providers `builtin` (empty) and `sdrradio` (the user's SDR plugin). A `music_assistant.search` for "bohemian rhapsody" returns empty; a search for "triple m" returns `library://radio/22` (the SDR station). So MA can only serve DAB+ radio, not general music, until a music provider (Spotify/etc.) is added.
- **MA cannot target the Canvas edges.** MA's player providers are `airplay`, `chromecast`, `dlna`, `sendspin`, `snapcast`, `squeezelite`, `sync_group`, `universal_player` — there is **no "Home Assistant Media Players" provider**, so MA cannot play to the Canvas HA media_player entities. To make the edges MA players they would need a native MA player protocol (DLNA renderer / Snapcast / Squeezelite / Sendspin) — a real architecture decision.
- **The Linux MA voice path is circular.** The sidecar's `music_assistant` branch calls HA `media_player.play_media` on `media_player.canvas_ui_device`, which *is* the `canvas_display` custom component entity (confirmed via the HA entity registry: `platform: canvas_display`). That entity's `async_play_media` calls back into the sidecar's `/api/media/play` with `source: music_assistant` — a loop. It needs to target a real MA player instead.
- The installed `canvas_display` entry "Canvas UI Device" points at `http://192.168.1.216:8099` (the Pi sidecar) and its coordinator is failing to connect (HA system log), so that entity is effectively dead. The new **Core mode** replaces this.

**Not fixed** (needs a decision): making the edges MA players, and the circular sidecar MA branch.

### Broadcast to HA Cast devices — fixed

HA's system log showed Cast devices rejecting the broadcast clip: `Failed to cast media https://192.168.1.108:3100/api/broadcast/...wav` — they cannot validate the self-signed TLS proxy on 3100. `CANVAS_CORE_PUBLIC_URL` was never passed through the compose file, so the HTTPS default always applied. Added the passthrough and set the remote to the plain-HTTP trusted-LAN address (`http://192.168.1.108:3101`). Verified: the clip URL is now HTTP, fetches 200, and the Cast error is gone.

### Intent-router media-source fix

The LLM request classifier's free-form `source` was used verbatim, so "play bohemian rhapsody" became `Media source "user" is not supported`. Now only known sources are accepted (`youtube`/`music_assistant`/`radio_browser`/`direct_audio`), defaulting to YouTube for video and Music Assistant for music. Also tightened the deterministic "play X music" pattern so "play some music from music assistant" no longer yields the query "music from".

### Remote compose repair (important)

While adding the `CANVAS_CORE_PUBLIC_URL` passthrough I overwrote the remote `core/docker-compose.yml` with the repo's version, which requires `CANVAS_CORE_TLS_DIR` (not set on the host). The authoritative remote compose is `/home/spetchal/canvas-core/docker-compose.yml` (build context `.`, TLS dir hardcoded to `/home/spetchal/canvas-core-tls-private-20260926/generation-1`). Both `/home/spetchal/canvas-core/docker-compose.yml` and `/home/spetchal/canvas-core/core/docker-compose.yml` were rewritten with the hardcoded TLS paths + the `PUBLIC_URL` passthrough and now validate. **Note:** the `core/` compose reads `core/.env`; the parent compose reads the (empty) parent `.env` — the `core/` one is the one that carries the real env.

### Deployments this session

- **`local-llm` provider fixed**: the remote `.env` pointed `CANVAS_CORE_LLM_BASE_URL` at a dead `:8092`; repointed to the running local router (`router-qwen3-1.7b` on `:8081`). Core now reports every provider UP (`local-llm`, `local-asr`, `local-tts`, `mcp 8/8`, `ha 2107 entities`). Backup: `.env.bak-20260927`.

- Pi: new `canvas-display-browser-linux` + `canvas-display-server` installed to `/usr/bin/` (backups `*.bak-20260927-broadcast`); `canvas-display-browser.service` **and** `canvas-display-server.service` restarted.
- Core: rebuilt `core/dist`, rsync'd, `docker compose up -d --build canvas-core`.
- Android: `app-debug.apk` installed on the tablet.
