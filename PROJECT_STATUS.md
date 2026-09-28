# Project status and session handover

Last reviewed: 2026-09-28. This file records local checkout evidence, not deployment acceptance.

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

### Edge audio regression + DLNA / HA media-player destinations (2026-09-28)

Objective: the user reported "I don't hear audio on the edge devices" and asked to be able to select DLNA and Home Assistant media-player devices as default playback destinations.

**Root cause of the silent edges (device-ID mismatch).** Device-targeted media playback failed with `[core][media] dispatch to device pi5-living-room failed: device pi5-living-room kiosk is not connected`. The Linux kiosk builds its scene URL from the Edge Agent's `agent.device_identity`, which is the **non-authoritative** `CANVAS_EDGE_DEVICE_ID` diagnostics hint (`pi5-living-room`), not the enrolled Core id. Core records the device under the credential's id (`device-2acc4690-…`), so the widget's `controllerDeviceId` never matched the kiosk's `browser` WebSocket and every dispatch was rejected. Verified live: the same play request succeeded with `device-2acc4690-…` and failed with `pi5-living-room`.

Fix (Core, `core/src/legacy-routes.ts`): new `resolveControllerDeviceId()` maps the renderer-supplied reference to the canonical device id by id **or** name, and is applied in `resolveCanvasPlaybackDevice`, `resolveMaPlaybackPlayer`, `/api/media/destinations`, `/api/media/routing/:deviceId` (+ `/select`), and the device media-defaults routes. Verified live: `POST /api/dab/play` with `controllerDeviceId: "pi5-living-room"` now resolves to `device-2acc4690-…` and the Pi's `mpv` plays.

**DLNA + HA media-player destinations.** `PlaybackTargetKind` gained `dlna` and `media_player` (`core/src/playback-routing.ts`), with `compatibleTargetKinds()` returning the allowed kinds per media type (DAB+/Dispatcharr → canvas/DLNA/HA player; Music Assistant/YouTube Music → MA/HA player/DLNA; YouTube stays Canvas-only). The destination catalogue and `/api/media/destinations` now include DLNA renderers and HA `media_player` entities from the durable `broadcast_outputs` table. `applyAudioPlayback` now takes a resolved `PlaybackTarget`, and Core's new `dispatchMediaToTarget` routes Canvas → gateway/`device_http`, DLNA → UPnP `SetAVTransportURI`+`Play`, HA media_player → `media_player.play_media`. A matching `controlMediaOnTarget` sends stop/pause/resume/volume/mute to DLNA (AVTransport/RenderingControl) and HA (`media_player.*`) destinations, so transport controls reach the selected device instead of broadcasting to browser clients. The Devices page media-defaults dropdowns list every compatible destination grouped by kind, the routing widgets render DLNA/HA icons and labels, and the Audio tab has an inline **Add DLNA renderer** field (Core's SSDP cannot see the LAN from its bridged Docker network, so DLNA renderers are registered by description URL).

Validation: `core` `npm run type-check` PASS; `npx tsx --test test/media-routes.test.ts test/legacy-routes.test.ts` 63/63 PASS; full `npm test` 537 pass / 4 fail (the same pre-existing ASR/intelligence/intent-router failures); `web` `npx tsc -b` PASS and `npm run build` PASS. Deployed Core (rebuilt only `canvas-core` from the parent compose with the hardcoded TLS paths; `core/dist` + `core/public` synced). Live: health `ok`; DAB+ playback reaches the Pi via the hint id; the catalogue reports 34 HA media players + 12 MA players + 2 Canvas displays; a temporary DLNA target dispatched DAB+ to the Pi's own DLNA renderer (`transportState: PLAYING`), a target-scoped `stop` returned it to `STOPPED`, and both the temporary target and the test catalogue row were then removed.

Caveat: DLNA renderers must be present in the broadcast-output catalogue. Core's SSDP discovery cannot see the LAN from its bridged Docker network, so add them under Settings → Broadcast outputs → "Add DLNA" or the Devices → Audio tab's **Add DLNA renderer** field (description URL). HA media players are discovered automatically.

### Pi display update latency: push-based HA entity updates (2026-09-28)

Objective: the Linux Pi 5 display felt slow to refresh/update. Root causes were three overlapping pollers per scene window plus full re-renders on unchanged data.

- **Push instead of poll.** Core now broadcasts `ha_state_update` frames to `role=display` WebSocket clients from the existing `ha.onEntityChange` handler (`core/src/index.ts`); `ClientType` gained a `display` role (`core/src/legacy-routes.ts`). The display's `WebSocketProvider` opens `/ws?role=display`, applies pushed entities, and coalesces bursts into one render every 120 ms.
- **Fallback poll is now adaptive.** Full `/api/ha/entities` snapshots poll every 15 s while the socket is healthy and every 2 s when it is down, so a blocked WebSocket can never be slower than the previous always-poll behaviour.
- **Removed a redundant 1 s poller.** `EntitySubscriptionManager` polled every second on top of the provider's own updates; `useEntityBinding`/`useVisibility` already re-evaluate when the provider swaps `entities`, so the manager and its timer were deleted.
- Validation: `core` and `web` production builds PASS. Deployed Core to `192.168.1.108` (rebuilt only the `canvas-core` service; `tls-proxy` untouched). Live: Core health `ok`; a `role=display` test client received 40 `ha_state_update` frames for 29 distinct entities in 12 s; the Pi (`192.168.1.216`) and Android scene windows reconnected as `display` and loaded the new bundle.

### Playback destination routing and expanded media widgets (2026-09-28)

- Added saved per-display defaults for DAB+, Dispatcharr, Music Assistant, YouTube and YouTube Music (`device_media_defaults`), plus session-only temporary selections that reset when the display renderer reconnects.
- Added a unified destination catalog covering Canvas displays and Music Assistant players, with incompatible targets disabled, and three scene widgets: playback-device list, fixed device button and current-device indicator.
- DAB+/Dispatcharr/YouTube playback and controls now resolve the current Canvas destination; MA and YouTube Music resolve the current MA player. Device Audio settings expose all five durable defaults.
- Added dedicated YouTube search, presets, single-play, now-playing, controls and volume widgets. Added equivalent YouTube Music widgets backed by Music Assistant.
- Expanded Music Assistant with artists/albums in search, browse, queue view/remove/clear, shared destination routing, and configurable row/artwork/text sizing across list widgets.
- Linux now injects its resolved Edge device ID into every panel as well as using the scene URL query parameter. This closes a startup race where a page could render before the async identity lookup and leave destination selectors empty.
- Created and published **Media Routing & Search Demo**: page `e3bd5322-147d-4129-a856-b110735da39d`, scene `ade8b56c-6ce1-464c-a3dd-0c0da04b7941`, with 15 routing, YouTube, YouTube Music and MA browse/search/queue/control widgets. It is currently force-displayed on the Pi; its persistent page assignment was not changed.
- Validation: `cd core && npm run type-check` PASS; `npx tsx --test test/legacy-routes.test.ts test/ma-routes.test.ts test/media-routes.test.ts` PASS 85/85; `cd web && npx tsc -b --pretty false` PASS; production web/Core builds PASS; Linux web build and native Pi `npx tauri build --no-bundle` PASS with existing warnings; `git diff --check` PASS before final generated assets.
- Deployed the rebuilt Core/web and arm64 Linux kiosk. Core health is `ok`; both Canvas displays and MA players appear in the live destination selector, incompatible MA targets are disabled for YouTube, MA provider roots render, and the live queue loads. A Wayland capture confirmed the complete demo layout. The queue currently shows two MA item IDs because those live queue entries do not include resolved media metadata.

### Media integration fixes: MA provider radios, MQTT source, list pagination (2026-09-28)

Objective: make DAB+, Dispatcharr and Music Assistant work end-to-end with the widgets, voice and MQTT, and verify the new Settings → Media configuration the operator entered.

Live verification against the deployed Core (`https://192.168.1.108:3100`, TLS proxy → `canvas-core-canvas-core-1`):

- `GET /api/dab/test` → 117 DAB+ stations; `GET /api/dispatcharr/test` → 55,382 channels; `GET /api/ma/test` → 12 players. Settings → Media tab is present with per-source cards and working "Test connection" buttons.
- Before this session `GET /api/ma/radios` returned only 2 stations (the ones in the MA library). The operator's `sdrradio` "SDR Radio (DAB+)" provider exposes 117 radios via `music/browse` but only 2 were in the library.

Fixes (all deployed):

1. **Music Assistant provider radios** (`core/src/music-assistant.ts`). `fetchMaRadios` now merges the library radios with every provider's radios browsed from `music/browse` (deduped by name, 15 s cache). Added `browseMa`, `clearMaRadioCache` (called from `settingsChanged` in `core/src/index.ts`). `maSearch` also merges provider radios, so the MA Search widget finds DAB+ stations that MA's own search does not index. Live result: `/api/ma/radios` 2 → 92; `?q=abc` search returns 9 provider radios.
2. **MQTT media control** (`core/src/mqtt-navigation.ts`, `core/src/index.ts`). The HA `media_player/cmd` handler now accepts `previous` and resolves the device's actual source instead of hard-coding `youtube`; `DeviceMediaState` gained a `source` field, the published `source` attribute now carries the real source (previously it was the title), and every media state update in `index.ts` populates `source`.
3. **Large-list pagination** (`core/src/legacy-routes.ts`, `web/src/widgets/widgets/media/mediaSource.ts`, `MediaSourceList.tsx`). `/api/dab/stations` and `/api/dispatcharr/channels` accept `search`/`limit` (new `applyListQuery` helper); the picker widgets pass their filter and `maxItems`. The Dispatcharr poll payload dropped from **9.6 MB to ~34 KB** by default and <1 KB when filtered.

Validation: `core` `npm run type-check` clean; `npx tsx --test test/ma-routes.test.ts test/media-routes.test.ts` 47/47 pass; full `npm test` 531 pass / 4 fail (the pre-existing ASR/intelligence/intent-router failures, unrelated). `web` `npx tsc -b` clean and `npm run build` OK. Deployment: `core/dist` + `web/dist` copied into the running container (`/app/dist`, `/app/public`) and restarted; endpoints re-verified live.

Resolved after this note:

- **Transport/volume are now device-targeted.** Every DAB+/Dispatcharr transport and volume command (play/pause, stop, mute, volume, next/previous) goes through `/api/media/control` with the page's `deviceId` (injected by the kiosk on the scene URL), so a wall panel's controls no longer move every other display. Without a `deviceId` the route falls back to a broadcast, matching the old `/api/audio/*` behaviour. See `useMediaAudio` in `web/src/widgets/widgets/media/mediaSource.ts`.
- **Dedicated search widgets added.** `DAB+ Search` and `Dispatcharr Search` (`MediaSearch.tsx` wrappers) use the server-side `search`/`limit` filtering, so the Dispatcharr list stays small even when searching.
- The 4 pre-existing test failures remain and are unrelated to media work.

### Granular DAB+ / Dispatcharr media widgets + next/previous (2026-09-28)

The monolithic `DabRadioWidget` and `DispatcharrWidget` were kept, and a family of single-purpose widgets was added so layouts can be composed freely. Six widgets per source (twelve total), registered in `web/src/widgets/registry/widgetRegistry.ts` and `web/src/widgets/WidgetRenderer.tsx`:

- `DAB+ Stations` / `Dispatcharr Channels` — scrollable picker list (optional header, filter, max items, optional next/previous).
- `DAB+ Now Playing` / `Dispatcharr Now Playing` — title, state, artwork and source label.
- `DAB+ Controls` / `Dispatcharr Controls` — transport buttons (play/pause, stop, mute, status text) with optional next/previous.
- `DAB+ Volume Slider` / `Dispatcharr Volume Slider` — horizontal/vertical slider.
- `DAB+ Volume Dial` / `Dispatcharr Volume Dial` — rotary dial.
- `DAB+ Presets` / `Dispatcharr Presets` — grid of user-ticked presets.

Shared logic lives in `web/src/widgets/widgets/media/` (`mediaSource.ts` polling/control hooks, `mediaMetadata.ts` metadata factories, and the shared `Media*` React components). A new `checklist` inspector field type was added (`web/src/widgets/types/metadata.ts`, rendered in `web/src/pages/EditorPage.tsx`) to drive the Presets widgets' multi-select options from the live station/channel lists.

Next/previous is now resolved **server-side** for both sources: `stepRadio()` in `server/src/routes/radio.ts` walks the station/channel list and tunes the adjacent item, and `/api/media/control` (`server/src/routes/media.ts`) accepts `next`/`previous` for the `dab` and `dispatcharr` sources (falling back to the source that started the current playback). The MQTT media handler (`server/src/mqtt/index.ts`) gained the matching `previous` action. A short-TTL cache (10 s) was added to `fetchDabStations`/`fetchDispatcharrChannels` so polling and stepping do not re-fetch the full lineup each time.

The `DAB+ Controls` / `Dispatcharr Controls` widgets call the server-side `next`/`previous` API via the new `step()` helper on `useMediaAudio` (`mediaSource.ts`), so they no longer poll the item list just to resolve a target. The picker widgets keep their in-list navigation since they already hold the list.

Validation: web and server type-checks and the existing test suites pass.

### Whisper ASR model selection + stronger model on GPU (2026-09-28)

The Core settings UI (Settings → AI providers) exposes a per-provider model/voice selector for ASR (Whisper) and TTS (Piper) providers: it lists what the server reports, lets the operator set the active model, and downloads new Whisper models on demand (`GET/POST /api/admin/ai-providers/:id/models`, `PUT /api/admin/ai-providers/:id/model`). A curated "Recommended" row was added to the ASR panel (base / small / medium / distil-large-v3 / large-v3) so a stronger model can be picked in one click.

Root cause of poor recognition on the live Core (`192.168.1.108`): the `local-asr` provider's active model had been set to `speaches-ai/Kokoro-82M-v1.0-ONNX-fp16` — a text-to-speech model, not a Whisper ASR model — so transcription requests were sent a TTS model id.

Fixes applied on the Core host:

- Downloaded `Systran/faster-whisper-large-v3`, `Systran/faster-distil-whisper-large-v3` and `Systran/faster-whisper-medium.en` into the `localcut-whisper` speaches container.
- Switched `localcut-whisper` from the CPU-only image to `ghcr.io/speaches-ai/speaches:latest-cuda` with an NVIDIA GPU reservation (`/var/lib/casaos/apps/mystifying_tiger/docker-compose.yml`), `WHISPER__COMPUTE_TYPE=float16`, `WHISPER__INFERENCE_DEVICE=cuda`, `WHISPER__TTL=-1` (keep the model resident) and `cpu_shares` raised from 90 to 2048. A backup of the previous compose file is kept alongside it.
- Set the `local-asr` active model to `Systran/faster-whisper-large-v3`.

Verified: warm transcription of a ~4 s clip is ~0.7 s on GPU (was ~22 s on CPU with large-v3, ~1.4 s with base.en); a round-trip TTS→ASR test and a full Core `/api/edge/voice/turn` call both returned the correct transcript. `local-asr` health is `UP`. The web build with the new "Recommended" row was rebuilt and deployed to `192.168.1.108`.

Note: the local dev Core on this workstation has no ASR provider rows and no Whisper service on `:10301`; it is not the instance the user's voice devices use.

### Removed hard-coded HA doorbell trigger (2026-09-27)

Core contained a built-in `ha.onEntityChange` callback from release `v0.2.30` that treated doorbell-named binary sensors as a button press and directly created an alert plus TTS broadcast. The live entity `binary_sensor.doorbell_motion_3` has `device_class: motion`; ordinary motion therefore produced four false “Someone is at the door” broadcasts between 21:52 and 22:04 AEST. Durable delivery made the source visible but did not create the trigger.

Removed the entire hard-coded doorbell listener from `core/src/index.ts`. Core still maintains its general HA cache and configured flow trigger surface; doorbell behavior must now be created explicitly in Home Assistant or the Core flow system. No hard-coded entity replacement was added. Core build passed. The corrected Core was deployed and health checked; no pending doorbell deliveries remained.

Follow-up audit found no other hard-coded HA entity-to-action automation in Core, the Display sidecar, Linux kiosk or Android app. Remaining HA listeners are infrastructure: Core caches all entity changes, forwards them to explicitly enabled `trigger_ha_state` flows, and marks scenes stale when their configured entity subscriptions change; the sidecar polls HA state for display WebSocket updates. None independently calls an HA service or creates an alert. The recurring automation-gap job can create disabled AI flow drafts for administrator review but cannot enable or execute them. Live configuration had one enabled manual-only flow named `test` and no enabled routines.

### Durable broadcast, DLNA and Snapcast reliability (2026-09-27)

The approved reliability-first broadcast plan is implemented and deployed across Core, web, the Linux Display sidecar/kiosk, and native Android, and was pushed in commit `353c702`.

- Core now persists broadcast output routes, events, per-output delivery state, attempts, leases and ten-minute expiry in PostgreSQL (`core/src/broadcast-delivery.ts`, `core/src/db.ts`). Edge deliveries require player `started`/`completed`/`failed` acknowledgements and reclaim expired claimed/started leases. HA and raw-DLNA routes retry failures until event expiry.
- The admin Settings page has a Broadcast outputs checklist, discovery refresh, logical-output grouping, preferred-route selection, online state, and recent delivery results. Sources include Canvas edges, HA `media_player` entities and LAN DLNA renderers. Preferred routes suppress duplicate delivery to the same logical output.
- The Linux sidecar replaces three process-local pollers with one durable delivery worker and SQLite receipt deduplication. Finite mpv clips now complete on exit code 0 instead of being replayed as failures. Snapcast retains desired state while suspended and resumes when local playback releases the sink.
- `CANVAS_DEVICE_SERVICES_ENABLED=false` is set by the Tauri embedded sidecar, leaving DLNA, Snapcast arbitration and Core delivery polling to the canonical system sidecar. This removes the prior port-49500 startup race while retaining the embedded sidecar for kiosk-local APIs.
- Native Android now polls the same durable delivery API, stores completed receipts, wraps raw PCM when needed, and acknowledges real `MediaPlayer` lifecycle callbacks. Broadcast/DLNA playback shares the existing sink arbiter, so Snapcast is suspended and resumed around announcements.
- Android GENA event delivery now writes a raw HTTP `NOTIFY` request. `HttpURLConnection` on this device rejected the UPnP method before opening the connection.
- Core-container SSDP discovery returned no renderers on the deployed bridged Docker network. The admin UI therefore also accepts a private-network DLNA device-description URL and validates/inspects it before saving the raw route. Automatic discovery remains available where multicast reaches Core.

Validation completed so far:

- `cd core && npm run build` — passed.
- `cd core && npm test` — 473/477 passed; the same four pre-existing ASR/intelligence/intent-router failures remain.
- `cd web && npm run build` — passed with existing chunk-size/dynamic-import warnings.
- `cd server && npx tsc --noEmit` — passed.
- `cd server && npm test` — 46/46 passed.
- `cd browser/linux/src-tauri && cargo check` — passed with existing warnings.
- Android cached Gradle 8.14.3 `:app:testDebugUnitTest :app:assembleDebug --offline` — passed; only existing deprecated window-flag warnings.
- `git diff --check` — passed after the final source and generated-asset changes.

Deployment and live acceptance:

- Rebuilt and deployed Core/web to `192.168.1.108`; health returns `status: ok`, role `canvas-core`, version `0.3.1`. PostgreSQL contains the new output/event/delivery tables. The catalog found both Canvas edges and HA media players; only the two Canvas edge routes default to selected.
- Built the sidecar natively on the Pi using the documented TypeScript → esbuild → `pkg --no-bytecode` path, then built the arm64 kiosk with `npx tauri build --no-bundle`. Backed up and replaced `/usr/bin/canvas-display-server`, `/usr/lib/Canvas Display/binaries/canvas-display-server`, and `/usr/bin/canvas-display-browser-linux`.
- The first Pi delivery exposed a historical-schema compatibility issue: its SQLite migration cursor was already version 9, so migration 8 was skipped. `initDb()` now idempotently asserts the receipt table independently of the cursor. After rebuilding/redeploying both sidecar copies, the pending delivery was recovered and completed with one claimed attempt.
- Installed the debug Android APK in place on tablet `A1064US260402203`, preserving enrollment, then relaunched it. Its activity is resumed and `http://192.168.1.41:49500/description.xml` advertises `Android Edge`.
- A synthetic one-second WAV targeted only the two Canvas edge outputs. Android acknowledged started/completed in one attempt; the Pi recovered its initially pending row after the compatibility fix and then acknowledged started/completed in one attempt. Both final delivery rows are `completed` with no error.
- Pi services are active: system sidecar, user kiosk and Snapcast. Exactly one process listens on DLNA port 49500 (system sidecar); the embedded sidecar logs `[device-services] disabled`. Snapcast was active after announcement completion. Pi and Android DLNA description endpoints both responded successfully.

Not fully exercised: a real Music Assistant/DLNA controller subscription after the Android raw-NOTIFY fix, external HA/DLNA playback acknowledgement semantics (those protocols only confirm command acceptance here), and automatic SSDP discovery from the bridged Core container. The manual DLNA description-URL path covers adding raw renderers in this deployment.

Next concrete step: review the uncommitted diff and commit/push only with explicit owner authorization. A short Music Assistant push to each Canvas renderer would close the remaining controller-level DLNA acceptance gap.

### Per-device default start page (2026-09-27)

The Core-wide **Default pages** settings tab was removed from `web/src/pages/SettingsPage.tsx`. Each edge device now has a **Default start page** selector in the Info tab of `web/src/pages/DevicesPage.tsx`. It reads the existing per-device `device_page_state.default_page_id` through the page-library API and uses the existing assignment/unassignment routes, so selecting a page applies it immediately and persists it as that device's default.

`core/src/gateway.ts` now prefers `default_page_id` over transient `active_page_id` when a native edge reconnects. Devices without a configured default retain the previous active-page replay behavior. No database migration was needed because the per-device default column and assignment model already existed.

Validation:

- `cd web && npm run build` — passed (existing Vite chunk-size and ineffective-dynamic-import warnings only).
- `cd core && npm run type-check` — passed.
- `git diff --check` — passed.
- `cd core && npx tsx --test --test-name-pattern='assignment|device library' test/legacy-routes.test.ts` — passed, 4/4 focused page-library/default-assignment tests.
- `cd web && npx eslint src/pages/DevicesPage.tsx src/pages/SettingsPage.tsx --quiet` — passed.
- `cd core && npm test -- --test-name-pattern='assignment|device library'` — the argument order caused the complete 477-test suite to run; 473 passed and the same four pre-existing failures recorded below remained (Whisper response format, two intelligence registry/failover expectations, and intent-router media routing).
- `cd web && npm run lint -- --quiet` — blocked by the pre-existing `react-hooks/preserve-manual-memoization` error in `web/src/components/VoiceStateOverlay.tsx:78`; the changed files did not report lint errors.

Committed and deployed after explicit owner authorization:

- Commit `5cc131f` (`feat: configure default start page per device`) was pushed to `origin/main`.
- Rebuilt `web/`, synchronized `web/dist/` into `core/public/`, and rebuilt Core successfully.
- Synchronized `core/dist/` and `core/public/` to `/home/spetchal/canvas-core/core/` on the Core host, then ran `docker compose up -d --build canvas-core`.
- `docker compose ps canvas-core` reported the recreated container running; `GET http://127.0.0.1:3101/health` returned `status: ok`, role `canvas-core`, version `0.3.1`.
- The bundle served by the deployed Core was `/assets/index-DobzDV3h.js`; it contains `Default start page` and no longer contains `Save default pages`.

The admin UI and Core reconnect behavior are deployed. A physical edge reboot was not performed, so boot-page selection remains locally tested and production-served but not yet accepted through a full device restart.

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
- **Deployment still required**: copy `custom_components/canvas_display` into the HA config dir (or update via HACS) and add a Core-mode config entry (URL `https://192.168.1.108:3100`, edge token). This session had no HA config access, so the entities are not yet live in HA. A helper is provided: `scripts/deploy-ha-component.sh` (set `HA_CONFIG_DIR`, or `HA_SMB_HOST`/`HA_SMB_USER`/`HA_SMB_PASS`).

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

### Ambient-noise / false-wake fix

The Pi kiosk log showed the wake word firing on ambient/TV audio (score 0.988) and the resulting capture being transcribed into a fluent but meaningless sentence (*"You know, he and some of his workers are stopping me from his clean ball game…"*), which the LLM then classified as `media_play` and acted on — random YouTube playback. Two layers added in Core:

1. **ASR confidence gate** (`core/src/providers/asr.ts` + `intelligence.ts`): the ASR provider now requests `verbose_json` and returns Whisper's `no_speech_prob` / `avg_logprob` / `duration`. Transcripts with `no_speech_prob > 0.6` or `avg_logprob < -1.0` (Whisper's own no-speech defaults), or matching known hallucination boilerplate, are discarded as a no-intent turn.
2. **Command-shape gate** (`ambientTranscriptReason` in `intelligence.ts`): only act on an **LLM-classified** request when it is short and command-shaped. A transcript over 18 words, or over 8 words starting with conversational filler (`you know`, `i mean`, `well,`, `he `, `she `, `they `…), is treated as overheard speech and ignored. Deterministic matches are always trusted.

Verified: the observed hallucination is now discarded (`Ignoring ambient transcript (too_long=25_words)`), while "turn on the kitchen lights" and "play some jazz" still act normally. Synthetic noise/tone/babble/melody clips all produce empty transcripts. The sidecar plays the existing no-intent cue on a discarded turn.

Note: the wake word itself scored 0.988, so a threshold change would not help — the guard is at the command level. Thresholds are constants in `intelligence.ts` and easy to tune.

### Music Assistant — wired to the HA media-player path (2026-09-27)

The user installed **YouTube Music** in MA, so MA can now resolve music (`music_assistant.search` for "bohemian rhapsody" returns `ytmusic--vaATCauJ://track/...`). Confirmed the user's model is correct: MA ships a **`hass_players`** provider ("Home Assistant MediaPlayers") that plays to HA media players, and its player id **is the HA entity_id**.

Implemented:
- **Component** (`custom_components/canvas_display/media_player.py`): each Core-mode entity now gets a **predictable entity_id** `media_player.canvas_<slug(device_id)>` (so Core can address its MA player) and exposes `canvas_device_id` as an attribute. `_resolve_source` now prefers a URL over the media type — MA's `hass_players` sends a resolved stream URL with `media_content_type: music`, which previously misclassified as `music_assistant`. Titles come from MA's `extra.metadata`.
- **Core** (`playMedia`/`controlMedia` for `music_assistant`): instead of the old circular sidecar call, Core now calls HA `music_assistant.play_media` with `entity_id = media_player.canvas_<slug>` and `media_id = <query>`; MA resolves and streams to the device. Control uses HA `media_player.media_pause`/`media_play`/`media_stop`/`media_next_track`/`media_previous_track`/`volume_set`/`volume_mute` on the same entity. If the entity is missing, Core returns an actionable error instead of a false success.

Verified: MA's `music_assistant.play_media` works via REST (`entity_id` must be in the **body**, not `target` — `target` 400s) and played Bohemian Rhapsody from YouTube Music on an MA player. Core now reports `Music Assistant is not set up for this display yet (no media_player.canvas_…)` until the HA component is deployed.

**Remaining (user actions):** deploy the HA component in Core mode (`scripts/deploy-ha-component.sh`), then in MA add the **Home Assistant** plugin (HA URL + long-lived token) and the **Home Assistant MediaPlayers** player provider, and tick the Canvas players.

### Deployments this session

- **`local-llm` provider fixed**: the remote `.env` pointed `CANVAS_CORE_LLM_BASE_URL` at a dead `:8092`; repointed to the running local router (`router-qwen3-1.7b` on `:8081`). Core now reports every provider UP (`local-llm`, `local-asr`, `local-tts`, `mcp 8/8`, `ha 2107 entities`). Backup: `.env.bak-20260927`.

- Pi: new `canvas-display-browser-linux` + `canvas-display-server` installed to `/usr/bin/` (backups `*.bak-20260927-broadcast`); `canvas-display-browser.service` **and** `canvas-display-server.service` restarted.
- Core: rebuilt `core/dist`, rsync'd, `docker compose up -d --build canvas-core`.
- Android: `app-debug.apk` installed on the tablet.

## DLNA MediaRenderer + audio arbiter (2026-09-27/28, this session)

User directive carried in from the previous session: **go the DLNA + Snapcast route** (not Sendspin), make Core + edges standalone, expose each edge as **both an HA media player and a DLNA device**, support **video** and **album art**, and get **multi-room sync** via Snapcast. Constraint still in force: **only test on the Canvas edge devices** (Pi + tablet) — do not target other DLNA/HA media devices in the house.

### What was built (sidecar, `server/`)

A dependency-free UPnP/DLNA **MediaRenderer** so Home Assistant's `dlna_dmr` integration and Music Assistant's DLNA player provider can discover and push media to a display without manual configuration. New module `server/src/dlna/`:

| File | Responsibility |
|---|---|
| `xml.ts` | XML escape/unescape, element/attribute readers, DIDL-Lite parsing, UPnP duration parse/format, SOAP action-header parse + envelope/fault builders |
| `descriptions.ts` | Device description + AVTransport / RenderingControl / ConnectionManager SCPDs; `SINK_PROTOCOL_INFO` declares both **audio and video** MIME types |
| `renderer.ts` | Transport state machine (AVTransport, RenderingControl, ConnectionManager) + GENA subscriber registry; maps actions onto an injected `DlnaPlaybackAdapter` |
| `ssdp.ts` | SSDP M-SEARCH responder + NOTIFY alive/byebye with the full service list (so HA auto-discovers it) |
| `index.ts` | HTTP control surface (`/description.xml`, `/service/*.xml`, `/control/*`, `/event/*`, `/video`, `/health`), GENA NOTIFY delivery, lifecycle |

Key behaviours:
- **Audio → mpv, video → the kiosk floating WebView.** The renderer classifies media from the DIDL `protocolInfo` MIME type first, then the UPnP class, then the URL extension. Audio calls the existing `playAudio` (mpv); video broadcasts `show_floating` to the kiosk with a full-screen `<video>` wrapper page served by the renderer (`/video?url=…`).
- **DIDL-Lite metadata** (title/artist/album/`albumArtURI`/duration) is parsed and surfaced through `GET /api/dlna/state`.
- **Stable UUID**: `CANVAS_DLNA_UUID` → persisted `server_settings.dlna_uuid` → generated once. Verified stable across restarts (so HA does not create duplicate devices).
- **Friendly name**: `CANVAS_DLNA_FRIENDLY_NAME` → `server_settings.device_name` → `Canvas Display (<hostname>)`.
- **Config** (`server/src/config.ts`): `CANVAS_DLNA_ENABLED` (default true), `CANVAS_DLNA_PORT` (default **49500**), `CANVAS_DLNA_UUID`, `CANVAS_DLNA_FRIENDLY_NAME`, `CANVAS_DLNA_HOST`.
- New route `GET /api/dlna/state` (`server/src/routes/dlna.ts`).

### Audio arbiter + Snapcast control

The display has one audio output; mpv (voice TTS / radio / DLNA pushes) and the Snapcast client both want it. New `server/src/audio/`:

- `arbiter.ts` — tracks the sink owner (`idle` / `mpv` / `snapcast`) and releases the previous owner before a new one starts. Releasers are injected, so the module has no import cycle with the audio routes.
- `snapcast.ts` — starts/stops the Snapcast client as a systemd **user** unit (default `canvas-snapclient.service`, override with `CANVAS_SNAPCLIENT_SERVICE`; disable with `CANVAS_SNAPCLIENT_ENABLED=false`). Best-effort: a missing unit never blocks playback.
- Wired in `server/src/index.ts` (`initAudioArbiter`): `mpv` releaser → `stopAudio()`, `snapcast` releaser → `stopSnapclient()`. `playAudio` acquires `mpv`; `stopAudio` releases it.
- New routes: `GET /api/audio/snapcast` → `{ enabled, service, running, owner }`; `POST /api/audio/snapcast { action: 'start'|'stop' }`.
- `seekAudio(seconds)` added to `server/src/routes/audio.ts` (used by DLNA `Seek`).

### Validation (this session)

- `cd server && npm test` → **46 tests pass** (new: 19 DLNA unit, 4 DLNA HTTP integration, 6 arbiter; plus the existing 17 YouTube tests). New `test` script added to `server/package.json`.
- `cd server && npx tsc --noEmit` → clean; `npm run build` → clean.
- **Live smoke test** (local, `node dist/index.js` with a temp data dir): server boots, `GET /health` → `{"ok":true}`, `GET /api/dlna/state` reports `enabled:true` with the LAN base URL, `GET /description.xml` serves a valid MediaRenderer description, `GET /api/audio/snapcast` → `{enabled:false,…,owner:"idle"}` (disabled for the test), and the DLNA UUID is identical across two restarts.
- Local env note: `better-sqlite3` had to be rebuilt (`npm rebuild better-sqlite3`) because the checked-in native module was built for Node 20 while the local runtime is Node 22.

### Not yet done (next steps)

1. **Deploy the sidecar to the Pi** — done this session (see below).
2. **Remove the `gmediarender` prototype** — done this session (`canvas-dlna-renderer.service` stopped + disabled). The manually-added HA `dlna_dmr` entry for it still needs removing in HA.
3. **Acceptance on the Pi**: DLNA discovery/description/SOAP, audio push (mpv) and video push (floating overlay) are all verified. Still to do: confirm HA `dlna_dmr` **auto-discovers** the new renderer (no manual entry) and that album art + title reach the UI.
4. **Snapcast arbiter acceptance**: verified in one direction (a DLNA audio push stops snapclient). Still to check: starting snapclient stops mpv.
5. **Android parity**: the native Android app has no DLNA renderer or Snapcast client yet. Snapclient is buildable for Android (the `badaix/snapdroid` project bundles native ARM/X86 clients); a Kotlin DLNA renderer would mirror this design.
6. **Core ↔ Music Assistant direct API** and **Core `/api/tts` `/api/stt` `/api/conversation`** endpoints (so Core/edges are standalone and HA can use them as a TTS/STT device) remain from the previous session's plan.
7. **Deploy the HA `canvas_display` component in Core mode** (needs HA config access) — unchanged from the previous session.
8. **Two page sources race**: the sidecar pushes its own `server_settings.active_page_id` on hello while the Core pushes the device's `device_page_assignments` page. Whichever arrives last wins, so the displayed page is non-deterministic after a kiosk restart. On the Pi the sidecar's value is a stale test page (`480sjZmvtg` → `https://example.com`). Worth making the Core authoritative (e.g. stop the sidecar pushing a page when a Core control channel is configured).

### Pi deployment + acceptance (2026-09-27/28)

Deployed to the Pi (`192.168.1.216`) this session:

- Built the arm64 sidecar natively on the Pi (`/home/spetchal/build/canvas-server`), installed to `/usr/bin/canvas-display-server` (backup `canvas-display-server.bak-20260927-dlna`), and restarted **both** `canvas-display-server.service` (system, `:8099`) and `canvas-display-browser.service` (user).
- **Retired the gmrender prototype**: `systemctl --user stop/disable canvas-dlna-renderer.service`; port 49494 is now free. The manually-added HA `dlna_dmr` entry for it still needs removing in HA.

**Verified on the Pi:**

- `GET /api/dlna/state` → `enabled:true`, `base_url http://192.168.1.216:49500`; `GET /description.xml` serves a valid MediaRenderer description; the DLNA UUID is stable across restarts.
- **DLNA audio push works end-to-end**: `SetAVTransportURI` + `Play` for `http://192.168.1.108:8001/tuner1.mp3` → `200`/`200`, state `PLAYING` with an advancing position, and `mpv` running with that URL.
- **Audio arbiter works**: with `canvas-snapclient.service` active at sidecar start the arbiter reports `owner:"snapcast"`; the DLNA audio push then **stopped snapclient** (`inactive`) and reported `owner:"mpv"`.
- The kiosk is connected to the **system** sidecar as a `browser` client (`Hello from browser (pi5-living-room)`), so `broadcast(..., 'browser')` reaches it. Note both sidecars run the same binary and both try to bind 49500; the system service wins (it starts first at boot) and the kiosk-spawned one logs `EADDRINUSE` and continues without DLNA. This ordering dependency is fragile — see the follow-up below.
- **DLNA video push is classified and routed correctly**: a `.mp4` push reports `isVideo:true` and `PLAYING` and is dispatched to the kiosk `show_floating` path.

### FIXED: the kiosk's `show_floating` overlay never opened

While verifying the DLNA video path I found that the kiosk **never opened the floating overlay** — this broke YouTube fullscreen playback, knowledge-card overlays, **and** the new DLNA video routing. It is now fixed and verified on the Pi.

**Root cause.** `browser/linux/src-tauri/src/lib.rs` documents (in the `set_kiosk_visible` doc comment) that on this kiosk build the main window's `is_webview_window()` is **false**. Tauri's `CommandArg` impl for `tauri::WebviewWindow` rejects in that case with `current webview is not a WebviewWindow`, so **every** command taking a `WebviewWindow` parameter failed from the controller webview:

- `create_panel_webview` (used by `openFloatingUrl`, the fallback, and `load_view`)
- `display_geometry` (silently swallowed by its try/catch fallback, so panel geometry quietly fell back to CSS screen metrics)

A second, independent defect: panel/floating webviews are **child** webviews, so they are absent from Tauri's WebviewWindow registry. `WebviewWindow.getByLabel('floating')` therefore always returned `null` and `WebviewWindow.getAll()` always returned `[]`, so the code always took the "create" branch (hitting `a webview with label \`floating\` already exists`) and `closeAllPanelWindows()` never actually closed anything.

**Fixes:**

- `lib.rs`: `create_one_panel`, `create_panel_webview`, `create_panel_webviews` and `display_geometry` now take `tauri::Window` (which always injects) instead of `tauri::WebviewWindow`; `create_one_panel` calls `window.add_child(...)` directly.
- `lib.rs`: new `webview_exists(label)` command (`app.get_webview(label).is_some()`) — the only reliable way to test for a child webview.
- `lib.rs`: new `client_log(message)` command so frontend failures reach `/tmp/canvas-ui-kiosk.log` (the controller WebView's `console.*` is not captured anywhere).
- `lib.rs`: `close_panel_webviews` now waits for the main thread to finish closing (bounded 5 s) so a following create cannot race the close.
- `KioskScreen.tsx`: `openFloatingUrl`, `hide_floating`, the fallback effect and `load_view` use `webview_exists` / `close_webview` / `set_webview_visibility` / `navigate_webview` instead of `WebviewWindow`; the `WebviewWindow` import is gone. A `floatingOpenRef` covers the gap between requesting creation and the webview existing.
- `KioskScreen.tsx`: `openPanelWindows` is serialised through a promise chain (`panelOpRef`) so the offline cached-page restore and the server's `load_page` push cannot race each other's close/create.

**Verified on the Pi** (live screenshots via `grim`, which was confirmed live by stopping/starting the kiosk):

- `POST /api/media/open {url}` → the overlay opens and plays the video; a second push **navigates** the existing overlay (no duplicate); `revert_after_ms` hides it and the page returns.
- `POST /api/media/play {source:'youtube'}` → the YouTube player overlay opens (the test video itself was "unavailable" — not embeddable — but the player chrome rendered).
- **DLNA video push works end-to-end**: `SetAVTransportURI` + `Play` → the renderer broadcasts `show_floating` with its `/video` wrapper URL → the overlay opens and plays.
- Two page switches in a row produce **0** `already exists` / `BUILD FAILED` log entries (was 1 per switch).

**Build gotcha (cost real time):** the kiosk must be built with the **Tauri CLI** (`npx tauri build --no-bundle`), not raw `cargo build --release`. A raw cargo build compiles with `--cfg dev`, producing a binary that expects the Vite dev server (`Could not connect to React: Connection refused` on screen).

### Operational notes learned this session

- **`server/.env` sets `DB_PATH=./data/canvas-ui.db`**, which takes precedence over `CANVAS_DATA_DIR`. Local smoke tests therefore write to the repo's gitignored `server/data/`. When rsyncing `server/` to a Pi build dir, **exclude `data/`** or you will copy a dev database across (harmless for the running service, which uses `CANVAS_DATA_DIR=/home/spetchal/.local/share/canvas-display`, but confusing).
- The kiosk's `/tmp/canvas-ui-kiosk.log` is **block-buffered** — recent lines may be missing until the buffer flushes. Do not treat a missing line as proof that something did not happen unless the log has since grown past it.
- `screen_off`/`screen_on` use `xset dpms` (X11) and are **no-ops under Wayland/labwc**, so they cannot be used to test whether the kiosk is processing commands.
- `grim` (with `XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0`) is a reliable way to capture the Pi's display; identical PNG hashes across commands are meaningful.
- Restarting the kiosk can briefly leave the `panel-fallback` webview on top of the page panels (a race between the fallback effect and the sidecar's `load_page` push); a second restart cleared it. Worth fixing alongside the `show_floating` bug.

## Android edge: DLNA MediaRenderer (2026-09-27/28, this session)

The Android edge app had **none** of the Linux sidecar's media-rendering stack (no DLNA/SSDP/UPnP, no Snapcast, no audio arbiter) — it only had `MediaPlayer` for direct/broadcast audio and the WebView overlay for video. This session added the **DLNA MediaRenderer** for parity.

### What was built (`browser/android-native/app/src/main/java/.../dlna/`)

| File | Responsibility |
|---|---|
| `DlnaXml.kt` | XML escape/unescape, element/attribute readers, DIDL-Lite parsing, UPnP duration parse/format, SOAP action-header parse + envelope/fault builders |
| `DlnaDescriptions.kt` | Device description + AVTransport / RenderingControl / ConnectionManager SCPDs; `SINK_PROTOCOL_INFO` declares both **audio and video** MIME types |
| `DlnaRenderer.kt` | Transport state machine + GENA subscriber registry; maps actions onto an injected `DlnaPlaybackAdapter` |
| `SsdpServer.kt` | SSDP M-SEARCH responder + NOTIFY alive/byebye with the full service list; `DlnaNetwork`/`DlnaLog` helpers |
| `DlnaHttpServer.kt` | HTTP control surface (`/description.xml`, `/service/*.xml`, `/control/*`, `/event/*`, `/video`, `/health`), GENA NOTIFY delivery |
| `AndroidDlnaAdapter.kt` | `MediaPlayer`-backed audio, WebView-overlay video, and the `AudioSinkArbiter` |
| `DlnaService.kt` | Lifecycle: stable UUID (SharedPreferences), friendly name, `WifiManager.MulticastLock`, SSDP + HTTP wiring |

Behaviour mirrors the sidecar: audio → native `MediaPlayer` (no window), video → the existing floating WebView loading the renderer's own `/video` wrapper page. Media kind is classified from the DIDL MIME type → UPnP class → URL extension. Port **49500** (same as Linux).

`MainActivity` starts the renderer once the `MultiPanelRenderer` exists and stops it in `onDestroy`. `playDirectAudio` (Core broadcast clips) now routes through the DLNA adapter so direct audio and DLNA pushes share one audio sink.

### Verified on the tablet (`A1064US260402203`, 192.168.1.41)

- `GET http://192.168.1.41:49500/description.xml` serves a valid MediaRenderer description; `/health` reports renderer state.
- **SSDP discovery works**: an M-SEARCH for `urn:schemas-upnp-org:device:MediaRenderer:1` gets a response from `192.168.1.41:1900` with `LOCATION=http://192.168.1.41:49500/description.xml` (probe helper: `scripts/ssdp-probe.py`).
- **Audio**: `SetAVTransportURI` + `Play` for the DAB+ Icecast stream → `200`/`200`, state `PLAYING` with an advancing position.
- **Video**: a `.mp4` push reports `isVideo:true` and opens the floating WebView with the `/video` wrapper (confirmed by screenshot — the test clip plays over the page panels).
- `RenderingControl.GetVolume` and `AVTransport.GetTransportInfo` return well-formed SOAP responses.
- `cd browser/android-native && <gradle> :app:testDebugUnitTest` → **31 tests pass** (24 new DLNA + 7 existing); `:app:assembleDebug` and `:app:assembleDebugAndroidTest` build.

### Not done: Snapcast on Android

There is **no Snapcast client on Android**. Unlike the DLNA renderer (pure Kotlin), Snapcast needs either:

1. a **native `snapclient` binary** for Android (arm64), executed from the app's `nativeLibraryDir` — this is what the `badaix/snapdroid` project does. It requires the Android NDK and snapcast's C++ build, and the binary must be shipped per-ABI; or
2. a **Kotlin implementation of the Snapcast protocol** (TCP control channel with length-prefixed JSON, UDP audio chunks with a custom header, and the time-sync ping/pong), playing through `AudioTrack` with drift correction.

Option 1 is closer to the proven Linux path; option 2 avoids shipping native code. Either way the `AudioSinkArbiter` added this session is already in place to hand the sink between Snapcast and local playback.

### Android Snapcast client — IMPLEMENTED (2026-09-28, this session)

Option 2 was chosen and built: a **Kotlin Snapcast client** (`.../snapcast/`). The protocol was reverse-engineered from the live server rather than guessed — see `scripts/snapcast-probe.py` and the notes below.

| File | Responsibility |
|---|---|
| `SnapJson.kt` | Dependency-free flat-JSON reader/writer (keeps the package JVM-testable; `org.json` is an Android stub in unit tests) |
| `SnapcastProtocol.kt` | Wire codec (26-byte header + payload), Hello/Time/ClientInfo encoders, CodecHeader/WireChunk parsers, `SnapcastClockSync` (NTP-style offset estimation) |
| `SnapcastClient.kt` | TCP connection, handshake, 1 Hz `Time` sync, chunk dispatch, reconnect with backoff |
| `SnapcastPlayer.kt` | FLAC via platform `MediaCodec` (csd-0 = the server's FLAC header) → `AudioTrack`; `pcm` streams written straight to `AudioTrack` |
| `SnapcastService.kt` | Lifecycle + `AudioSinkArbiter` integration |

**Protocol facts (verified against snapserver 0.34.0 with `tcpdump`):**

- Every message is a **26-byte little-endian header** — `uint16 type, uint16 id, uint16 refersTo, int32 sent.sec, int32 sent.usec, int32 received.sec, int32 received.usec, uint32 size` — followed by `size` payload bytes. (Not a length-prefixed JSON blob.)
- `Hello` (type 5) uses **capitalised** field names: `MAC`, `HostName`, `Version`, `ClientName`, `OS`, `Arch`, `Instance`, `ID`, `SnapStreamProtocolVersion` (2).
- `ServerSettings` (3) is `{bufferMs, latency, muted, volume}`; the stream list is not included.
- `CodecHeader` (1) is binary: `uint32 codecLen` + codec + `uint32 dataLen` + data. For FLAC the data is a **complete FLAC stream header** (`fLaC` + STREAMINFO + …), which is exactly what `MediaCodec` wants as `csd-0`.
- `WireChunk` (2) is `int32 timestamp.sec` + `int32 timestamp.usec` + `uint32 dataLen` + data — **not** a uint64 timestamp. The timestamp is the chunk's playout time on the server clock.
- `Time` (4) payload is just the client's `latency` (8 bytes); the sync clocks ride in the header's `sent`/`received` fields.
- The bundled MA snapserver uses **flac @ 48000:16:2** (`/etc/snapserver.conf` leaves `codec` commented, and the default is flac).

**Verified on the tablet (192.168.1.41):**

- Client connects, handshake completes, `codec: flac (1362 byte header)`.
- With a 440 Hz tone written into the snapserver's `/tmp/snapfifo`, the tablet received `WireChunk`s and `dumpsys media.audio_flinger` showed the app's `AudioTrack` **active at 48000 Hz stereo with 4.18 M frames written** — i.e. FLAC decode → PCM → speaker works end-to-end.
- **Arbiter handover works**: a DLNA audio push logged `snapcast: releasing the audio sink` and stopped the client.
- `cd browser/android-native && <gradle> :app:testDebugUnitTest` → **46 tests pass** (15 new Snapcast + 24 DLNA + 7 existing).

**Clock-scheduled playback (2026-09-28, this session):**

Playback is now scheduled against the server clock using snapclient's own rule (from `client/stream.cpp`):

```
age = (serverNow - chunkStart) - bufferMs + dacTime
  age == 0 -> play now;  age < 0 -> too early (wait);  age > 0 -> too old (drop)
```

- `SnapcastSync` holds the pure rule (`playAt`, `age`, `decide`, `waitMillis`, `dacTimeMicros`) so it is JVM-testable; `SnapcastPlayer` applies it in its write loop, using `AudioTrack.playbackHeadPosition` to estimate `dacTime` (how long audio written now sits in the output buffer).
- `SnapcastClient` keeps the server↔client offset fresh with a 1 Hz `Time` exchange; `SnapcastClockSync` prefers the lowest-round-trip sample.

**Two protocol bugs found and fixed while verifying this** (both produced plausible-looking but wrong numbers):

1. `WireChunk` carries **`int32 timestamp.sec` + `int32 timestamp.usec`**, not a `uint64` timestamp (`common/message/wire_chunk.hpp`). Reading it as a uint64 made consecutive chunks appear ~28 hours apart.
2. The client's `Time` header used `System.currentTimeMillis()` while `nowMicros()` used `System.nanoTime()` — two different epochs — so the NTP-style offset came out as **0**. Both now use the monotonic clock.

**Verified on the tablet:** chunk timestamps are 24 ms apart (correct), the offset resolves to ~970,553 s (the server/tablet boot-time difference), and the sync stats report `median=13–21ms dropped=0 buffered=24–92ms` with the `AudioTrack` still writing frames. That is a large improvement over the previous unscheduled playback, though not yet snapclient's sub-millisecond accuracy (it soft-corrects with a resampler; we do not).

**Soft correction (2026-09-28, this session):**

Residual drift is now corrected the way snapclient does it — by dropping or duplicating a single frame every few thousand frames, which is inaudible:

```
rate  = 1 ∓ min((|shortMedian| / 100) * 0.00005, 0.0005)
r     = 1 / rate
after = round(r / (r - 1))      // frames between single-frame corrections
```

- `SnapcastSync.correctAfterXFrames` mirrors snapclient's gating (correction only starts once the short *and* mini medians agree with the instantaneous age) and caps the rate adjustment at 0.05%.
- `SnapcastSync.applyFrameCorrection` drops/duplicates frames spread evenly across the buffer; `SnapcastSync.framesCorrection` accumulates the frame counter.
- `MedianWindow` mirrors snapclient's `Buffer`/`MiniBuffer`/`ShortBuffer` statistics.
- `SnapcastPlayer` uses `AudioTrack.getTimestamp()` (falling back to `playbackHeadPosition`) for the output-buffer delay, and its write loop now **retries the same chunk** while it is too early — re-queueing it pushed it behind later chunks and scrambled the audio order.

**Verified on the tablet:** the correction engages (`rate=1/2000`, `corrected` climbing) and the **true lateness** (`serverNow - playAt`, logged separately from `age` because `age` includes the output-buffer term) now stays within **±40 ms**, mostly ±20 ms, where it was previously unbounded. `AudioTrack` kept writing frames throughout.

**Auto-resume + settings (2026-09-28, this session):**

- **Snapcast now resumes after a DLNA push.** `AudioSinkArbiter` gained an `onIdle` hook (fired when the last owner releases the sink, outside the lock so the listener can re-acquire). `SnapcastService` distinguishes *desired* from *running*: the arbiter's releaser now **suspends** (stops the client, keeps `desired = true`) instead of stopping, and `onIdle` resumes when the sink goes free. An explicit `stop()` clears `desired` so it stays down. Verified on the tablet: a DLNA push logs `releasing the audio sink`, and the DLNA stop logs `resuming after the sink went idle` followed by a fresh connect + codec header.
- **Snapcast settings are now editable on-device** (server, port, enable) in the setup screen. Note the setup screen was **dead code** — `showSetup()` was never called — so it is now reachable via a **long-press on the status overlay** (available while the display is connecting or showing an error). The host still defaults to the Core host when left blank.

**Core-authoritative Snapcast settings (2026-09-28, this session):**

- **Core**: `PUT /api/admin/devices/:id/audio` accepts `snapcast_enabled` / `snapcast_host` / `snapcast_port` (stored in the existing `audio_config` jsonb, so no migration; the port is validated 1–65535). `GET /api/devices/:id/voice-config` now returns them (defaults `true` / `''` / `1704`).
- **Admin UI**: the device Audio tab gained a *Snapcast (multi-room audio)* section — enable switch, server (blank = Core host) and port.
- **Android**: `VoiceConfigClient` parses the new fields and `MainActivity.applySnapcastConfig` applies them, restarting the Snapcast client only when they actually change. The on-device fields remain as a fallback for an unconfigured device.

**Verified end-to-end:** the Core endpoint returns the stored values (`snapcast_host: "192.168.1.108"`), and the tablet logged `Snapcast config from Core changed; restarting client` followed by a reconnect to the Core-provided host.

**Known gaps:**

- Sync is **~±20–40 ms**, not snapclient's sub-millisecond accuracy. The soft correction is deliberately slow (0.05% ≈ 0.5 ms/s) and only handles drift; a residual systematic offset remains because the `AudioTrack` output-buffer delay is estimated rather than reported by the backend the way ALSA/Pulse do for snapclient.
- The setup screen's only entry point is the status long-press; with Core now authoritative it is only a fallback for an unconfigured device.
- **Pre-existing Core test failures**: `npm test` in `core/` reports 4 failures (Whisper transcription, `createIntelligence` registry/failover, intent-router media routing). Confirmed pre-existing — they fail identically with this session's Core changes stashed.

### Android DLNA notes / gotchas

- Android only delivers multicast to an app holding a `WifiManager.MulticastLock` — `DlnaService` acquires one (`CHANGE_WIFI_MULTICAST_STATE` + `ACCESS_WIFI_STATE` added to the manifest).
- Android's `MulticastSocket` ends up as a **dual-stack** socket (`[::]:1900`) even when bound to the IPv4 wildcard; it still receives the IPv4 SSDP group, so this is fine (verified by the M-SEARCH probe).
- `DlnaLog.sink` defaults to a no-op so the `dlna` package stays Android-free for JVM tests; `DlnaService` wires it to logcat (`CanvasDlna`).

# Dual SDR modules and media artwork (2026-09-28)

Objective: allow Core to combine two RTL-SDR radio modules and show station/channel artwork in the DAB+ Stations, DAB+ Presets, Dispatcharr Channels and Dispatcharr Presets widgets.

Implemented and deployed to Core (2026-09-28, owner-authorized):

- Core now accepts an optional second SDR tuple through Settings (`sdr_radio_2_url`, `sdr_radio_2_tuner`, `sdr_radio_2_stream_url`) or env (`SDR_RADIO_2_URL`, `SDR_RADIO_2_TUNER`, `SDR_RADIO_2_STREAM_URL`). Settings → Media exposes all three fields.
- `/api/dab/stations` merges both modules. With two modules configured it returns collision-safe IDs (`sdr1::<station-id>` / `sdr2::<station-id>`) plus the module and the SDR service's `image_url`; the play route, next/previous control, connection test and voice DAB path use the matching module's tuner and stream. One-module IDs remain unchanged for compatibility. One unavailable module does not hide stations from the other.
- Dispatcharr lineup loading uses its authenticated channel-summary endpoint (when an API key is configured) to attach each channel's `logo_id`. Widget-facing logo URLs point to `GET /api/dispatcharr/logos/:logoId`, which proxies the Dispatcharr logo cache without exposing the API key.
- The four requested list/preset widgets normalize and render these image URLs. Their inspector metadata now includes `Show station/channel icons` and `Icon size`; preset values are resolved back to full items so labels and artwork remain available.
- DAB playback state now carries station artwork, allowing the existing now-playing widget to use it too.
- Live diagnosis after the first deployment found that this Dispatcharr installation authenticates with `X-API-Key` (the former `Authorization: Api-Key …` header returned 401). All Core Dispatcharr calls now use the working header. The authenticated summary reports 55,260 channels with logos out of 55,382 total.
- The installed SDR APIs expose only `city`, `id` and `name`, so they cannot supply station artwork. DAB+ station/preset widgets now render a radio-icon fallback whenever `image_url` is absent. Real artwork still takes precedence when supplied.
- Configured the second live SDR tuple in Core settings: REST API `:8091`, tuner `tuner1`, Icecast `:8002/tuner1.mp3`. The first tuple remains unchanged. No credentials were written to this file.

Validation:

- `cd core && npx tsx --test test/media-routes.test.ts` — PASS, 29/29 tests.
- `cd core && npm run type-check` — PASS after the final artwork type narrowing.
- `cd web && npx tsc -b --pretty false` — PASS.
- `cd web && npm run build` — PASS; Vite emitted the production bundle to `web/dist` (existing chunk-size/dynamic-import warnings only).
- `cp -r web/dist/. core/public/ && cd core && npm run build` — PASS; Core's local deployable `public/` and `dist/` now contain the change. Generated bundle inspection found the icon controls and second-SDR settings in the served assets.
- `cd web && npm run lint -- --quiet` — FAILS on the pre-existing `react-hooks/preserve-manual-memoization` error in `web/src/components/VoiceStateOverlay.tsx:78`; none of the changed media files produced a lint error.
- An earlier accidental full Core-suite run reported 6 unrelated existing failures, including `core/test/asr.test.ts` expecting `response_format=json` while the current implementation sends `verbose_json`. The focused media suite above is green.
- Deployment: backed up the remote `dist/` and `public/`, synced only those directories, and rebuilt/restarted only `canvas-core` using the existing external TLS directory. Strict HTTPS acceptance passed: health `ok`, live bundle `assets/index-Dl-Ote0B.js`, 234 aggregated DAB+ entries across `sdr1`/`sdr2`, 1,000/1,000 sampled Dispatcharr channels with logo URLs, and a proxied logo returned HTTP 200 `image/jpeg`. Container remained up after restart.

Next step: hard-refresh the editor/display so its browser cache loads `assets/index-Dl-Ote0B.js`, then visually confirm DAB+ fallback icons and Dispatcharr logos in all four widgets. Physical playback through SDR module 2 remains to be checked; its Icecast mount was absent before tuning, which can be normal for an idle module.

## Manual DAB+ logos and single-play widgets (2026-09-28)

Implemented and deployed to Core (owner-authorized continuation):

- Added durable `dab_station_logos` PostgreSQL storage. Admin routes list, upload/replace and delete assignments; `/api/dab/logos/:stationId` serves assigned images publicly for unattended displays. Uploads accept PNG, JPEG, WebP or GIF up to 2 MB. The DAB station feed gives a manual assignment precedence over SDR-provided artwork.
- Settings → Media now includes a **DAB+ station logos** manager with station selection, preview, upload/replace and remove controls. With two SDR modules, selectors distinguish SDR 1 and SDR 2 and mappings use the collision-safe qualified station ID.
- Added **DAB+ Play Button** (`dabplaybutton`) and **Dispatcharr Play Button** (`dispatcharrplaybutton`) widgets. Each plays exactly one configured station/channel through the existing device-targeted media route and supports a logo/icon, label override, sizing and normal universal styling. DAB uses a dynamic station selector; Dispatcharr accepts an exact or partial channel name so the editor does not load all 55,382 channels into a select menu.

Validation and deployment:

- `cd core && npm run type-check` — PASS.
- `cd core && npx tsx --test test/media-routes.test.ts` — PASS, 31/31 tests, including manual logo upload/feed/image validation.
- `cd web && npx tsc -b --pretty false` — PASS.
- `cd web && npm run build`; sync `web/dist/` → `core/public/`; `cd core && npm run build` — PASS (existing Vite size/dynamic-import warnings only).
- Backed up the live Core `dist/` and `public/`, synced only those directories, rebuilt and restarted only `canvas-core`. Strict HTTPS health returned `ok`; live bundle is `assets/index-CwGNnX09.js`; bundle inspection found both widget registrations and the logo manager; the migration table exists with zero initial assignments; an unknown public logo correctly returns 404; container remained up.

Next step: hard-refresh the editor, upload desired station images in Settings → Media → DAB+ station logos, and visually exercise the two live demo pages described below. Physical playback and display rendering remain the final acceptance checks.

## DAB+ and Dispatcharr control demo pages (2026-09-28)

Created through the live Core APIs after the media-widget deployment:

- **DAB+ Controls Demo** — page `83f3e9f4-b948-4cb2-965a-1ea352ad3299`, backed by published scene `991c2a91-7a82-4406-a5a2-b4479933980b`.
- **Dispatcharr Controls Demo** — page `f5728ce4-3c2f-46c0-8ef6-03b71f32bbe8`, backed by published scene `8d7118f7-cbc2-4d3e-b354-05cdde0cf590`.

Both scenes use a 1920×1080 canvas and contain all nine source-specific widgets: combined picker, list, search, now playing, transport controls, volume slider, volume dial, presets and single-play button. Each preset grid contains eight live items. The DAB+ button targets `sdr1::triplem`; the Dispatcharr button targets `AU: ABC news`. Lists, presets and single-play buttons have icons/logos enabled.

Live API verification passed: both pages resolve to their expected published scene, both manifests report nine widgets with the complete expected type set, and their configured preset counts and play-button selections survived persistence. The DAB+ page was subsequently force-displayed and visually verified on the Pi as recorded below; Dispatcharr visual rendering and physical media playback remain to be checked.

## Android-sized media control demo pages (2026-09-28)

The native Android client reports a **1280×800** landscape screen (`browser/android-native/.../CoreEdgeClient.kt` hardcodes `screen_width`/`screen_height`; Core stores them as `devices.display_width`/`display_height`), so the 1920×1080 demo scenes do not fit it. Added Android-sized equivalents via the new `scripts/create-media-control-demos.mjs`:

Confirmed against the physical tablet `A1064US260402203` (model `A10_A16_US`) with `adb shell wm size` / `wm density` / `dumpsys display`: physical panel is **800×1280** portrait, density **213** dpi, and the device is held in `ROTATION_90`, giving an app/display area of **1280×800** landscape — matching the value the client reports. The display renderer uniformly scales the fixed canvas to fit the WebView viewport (`SceneDisplayPage.tsx`), so a 1280×800 canvas maps 1:1 to the tablet's physical pixels (the WebView's CSS viewport is ~962×601 at 213 dpi).

- **DAB+ Controls Demo (Android)** — page `fe362913-8520-414b-9c53-82164174fd9b`, published scene `47382a6a-b442-4590-958f-19448df2c437`.
- **Dispatcharr Controls Demo (Android)** — page `e1012cd0-5bd0-4ff5-8456-e33c2d08e0a2`, published scene `8e6f094f-91e7-4fec-9b87-ecb89dd30779`.

Both scenes are 1280×800 and contain the same nine source-specific widgets as the 1920×1080 demos (combined picker, list, search, now-playing, transport controls, volume slider, volume dial, presets, single-play button), re-laid out for the smaller canvas: three 300×360 pickers across the top-left, a 932×392 preset grid below them, and a 300-wide right rail (now-playing, controls, volume slider, volume dial, single-play). Presets and the single-play target are unchanged (`sdr1::triplem` / `AU: ABC news`). The existing 1920×1080 pages are untouched. Both Android pages are assigned to the Android Edge device (`android-7dcf6644c78118ed805b90f3`).

A stray `resolution` debug widget had been staged onto the Dispatcharr Android scene (revision 2, ~11 min after creation) at `20,20 200×150`, overlapping the picker; the DAB+ scene never had it, so the two pages did not match. It was removed by staging and publishing revision 3, leaving both Android scenes with the identical nine-widget layout.

The creator runs inside the Core container so the automation token is never handled locally: `ssh <core-host> 'docker exec -i -e CANVAS_DEMO_BASE=http://127.0.0.1:3100 canvas-core-canvas-core-1 node -' < scripts/create-media-control-demos.mjs`. It is idempotent (skips a page whose name already exists). Verified via the read-only API: both pages resolve to their published scenes, each manifest reports nine widgets at 1280×800, and each page has a single full-bleed `Main` panel.

## Linux force-display delivery fix (2026-09-28)

Reported behavior: **Force display now** worked on Android but did not change the Linux Raspberry Pi display.

Root cause and fix:

- The Pi has both a Gateway v1 Edge connection and a legacy browser-renderer WebSocket under the same device ID. Core treated any live gateway connection as authoritative and suppressed `load_page` on the browser socket, although the Linux kiosk's panel webviews are controlled by that browser socket. Its stored architecture is `arm64`, so the older `linux` architecture fallback also did not apply.
- `core/src/legacy-routes.ts` now exposes `hasConnectedBrowserClient(deviceId)`. `deliverPageToDevice` in `core/src/index.ts` prefers a live browser renderer when one exists, sends it `load_page`, and reports the direct browser delivery as applied. Gateway-only devices continue through Gateway v1.

Validation and deployment:

- `cd core && npm run type-check` — PASS.
- `cd core && npx tsx --test test/legacy-routes.test.ts` — PASS, 32/32 tests.
- `cd core && npm run build` — PASS.
- Synced only `core/dist/` to the Core host and rebuilt/restarted only `canvas-core`, preserving the externally mounted TLS material. Health returned HTTP 200; both the Pi browser renderer and its Edge gateway reconnected.
- Forced **DAB+ Controls Demo** to `pi5-living-room` through `POST /api/pages/:id/display`; the response reported `delivered: true`. The Pi created a new 1920×1080 panel, fetched scene `991c2a91-7a82-4406-a5a2-b4479933980b` and the media widget bundles, and began polling the DAB endpoints.
- A Wayland capture from the Pi visually confirmed the full DAB+ demo page rendered on screen. The force-display override remains active on the Pi; its persistent page assignment was not changed.
