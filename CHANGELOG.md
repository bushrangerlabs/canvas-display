# Changelog

All notable changes to **Canvas UI Platform** are documented here.
Each version is a git tag (`v0.2.xx`) — to inspect exact code at any version:

```bash
# See a specific file at a specific version
git show v0.2.60:server/src/voice/intercom-poller.ts

# Diff between two versions
git diff v0.2.60 v0.2.63 -- server/src/voice/

# Check out a version to a temp branch
git checkout -b investigate-v0.2.60 v0.2.60
```

Run `scripts/smoke-test.sh` after any deploy to verify core features are working.

---

## [0.2.66] — 2026-08-06
### Summary
Always log TTS and STT text in all voice modes

### Key files
- _TODO: list modified files and what changed_

## [0.2.65] — 2026-08-06
### Summary
Broadcast: play TTS prompt before recording ('What would you like to broadcast?')

### Key files
- _TODO: list modified files and what changed_

## [0.2.65] — 2026-08-06
### Added — Broadcast prompt before recording
Before recording starts, the device now speaks a TTS prompt so the user knows when to talk.

**Default prompt:** *"What would you like to broadcast?"*

**Customisable via API:**
```json
{ "duration": 8 }                              // default prompt
{ "duration": 8, "prompt": false }             // skip prompt, record immediately
{ "duration": 8, "prompt": "Speak now..." }    // custom prompt text
```

State machine: `idle → prompting → recording → uploading → idle`

**Modified files:**
- `server/src/voice/broadcast-recorder.ts` — added `playPrompt()` using `speakWithPiper` + mpv; `startBroadcast()` now accepts `BroadcastOptions` object (back-compat number still works)
- `server/src/routes/voice.ts` — `POST /api/voice/broadcast` passes `prompt` option; returns `action: "prompting"` instead of `"recording"`
- `server/src/voice/ha-pipeline.ts` — voice "broadcast" intercept passes `{ prompt: true }` options


### Added — Regression tracking
- `CHANGELOG.md` — documents every release: what changed, which files, root cause of fixes
- `scripts/smoke-test.sh` — 13 live checks against Core + Pi sidecar; run after any deploy
- `release.sh` — now auto-inserts a CHANGELOG stub entry on every release

### Known-working features as of this version ✅
The following features are confirmed working end-to-end on the Pi edge device (192.168.1.216):
- **YouTube playback** — video/audio via the display kiosk
- **Music Assistant** — plays music through the display
- **TTS broadcast** — Core pushes TTS audio → Pi polls → plays via mpv on HDMI
- **Alert broadcast** — Core pushes alerts → Pi polls → shows on display
- **Intercom broadcast** — Pi records real mic audio → uploads to Core → plays on all devices
- **ESPHome satellite** — wake word (Hey Jarvis) → HA pipeline → STT + intent + TTS response
- **Voice broadcast trigger** — saying "broadcast" starts intercom recording
- **Automation flows** — visual flow editor with TTS, scene switch, page switch, HA service, HTTP, AI, broadcast nodes
- **Canvas editor** — drag-and-drop widget placement, multi-select, copy/paste, undo/redo
- **29 widgets** — text, value, gauge, clock variants, button, switch, camera, iframe, etc.

## [0.2.63] — 2026-08-06
### Fixed
- `voiceRoutes` was imported but never registered in `server/src/index.ts` — `/api/voice/speak`, `/api/voice/broadcast`, `/api/voice/mic-test`, `/api/voice/turn` were all returning 404

### Key files
- `server/src/index.ts` — added `app.register(voiceRoutes, { prefix: '/api' })`

---

## [0.2.62] — 2026-08-06
### Added — Broadcast Intercom (real mic audio)
Rewritten from TTS-based to Amazon Echo Drop-In style: a device records real audio from its mic and relays it to all edge devices for playback.

**Flow:** button press / "broadcast" voice command → sidecar records mic → uploads WAV to Core → all intercom pollers receive and play via mpv

**New files:**
- `server/src/voice/broadcast-recorder.ts` — records from mic via `MicCapture`, wraps 16kHz mono PCM in WAV header, uploads to Core's `/api/edge/intercom/broadcast`

**Modified files:**
- `server/src/routes/voice.ts` — `POST /api/voice/broadcast` (start recording), `POST /api/voice/broadcast` with `{action:"stop"}` (stop early), `GET /api/voice/broadcast/status`
- `server/src/voice/ha-pipeline.ts` — intercepts "broadcast" transcript at `stt-end`; triggers `startBroadcast()` and returns pipeline to wake-word listening
- `core/src/flows.ts` — `action_broadcast_intercom` now triggers recording on a device, not TTS synthesis
- `core/src/index.ts` — `broadcastIntercom` dep sends `device_http` to `POST /api/voice/broadcast` on target device(s)
- `web/src/pages/FlowEditorPage.tsx` — updated node config fields (device_id + duration instead of text + from)

### Changed
- `action_broadcast_intercom` automation node: was synthesising TTS and relaying; now triggers real mic recording on target device

---

## [0.2.61] — 2026-08-06
### Added — Broadcast Alert + Broadcast Intercom automation nodes

**New automation action nodes:**
- `action_broadcast_alert` — queues an alert notification to all edge device displays (title, message, type: info/warning/error/success)
- `action_broadcast_intercom` — (original TTS version, superseded in v0.2.62)

**Modified files:**
- `core/src/flows.ts` — added both node types to `NodeType` union and `FlowExecutorDeps` interface; added case handlers
- `core/src/index.ts` — `flowBroadcastAlert` closure wired to `pendingAlerts` map; `broadcastAlert` + `broadcastIntercom` deps added to `FlowExecutor`
- `web/src/api/client.ts` — added both types to `FlowNodeType` union
- `web/src/pages/FlowEditorPage.tsx` — added node metadata to node catalog

---

## [0.2.60] — 2026-08-05
### Fixed — Broadcast pollers using wrong device ID + intercom playback broken

**Root cause 1:** `alert-broadcast-poller.ts` and `intercom-poller.ts` were polling Core with `device_id` (MQTT nanoid `uDJLm5Tkmrdo`) instead of `edge_device_id` (`device-2acc4690-b00b-4bf7-9ffe-a532ddf93150`). Core queues by `edge_device_id`.

**Root cause 2:** `intercom-poller.ts` was calling `POST /api/audio/play` with `{audioBase64: ...}` — that endpoint only accepts `{url: ...}`. Audio silently dropped.

**New file:** `server/src/voice/audio-utils.ts` — shared helpers:
- `ensureWav(pcm, sampleRate, channels)` — wraps raw PCM in RIFF header (Core Piper returns headerless PCM)
- `buildMpvAudioArgs(volume, filePath)` — builds mpv args with correct PulseAudio device
- `getSpeakerDevice()` — reads `audio_speaker_device` from DB

**Modified files:**
- `server/src/voice/tts-broadcast-poller.ts` — uses `ensureWav()` + `buildMpvAudioArgs()`; reads `edge_device_id` from DB
- `server/src/voice/alert-broadcast-poller.ts` — fixed to use `edge_device_id` first, `device_id` as fallback
- `server/src/voice/intercom-poller.ts` — rewritten: writes WAV temp file, spawns mpv directly (same approach as TTS poller)
- `server/src/db/index.ts` — replaced `nanoid` with `crypto.randomBytes` (nanoid v5 is ESM-only, breaks pkg binary bundling)
- `server/src/routes/pages.ts`, `server/src/routes/devices.ts` — same nanoid → crypto replacement
- `server/src/index.ts` — `startIntercomPoller()` called without argument (removed `localPort` param)

### Pi infrastructure added
- `/etc/systemd/system/canvas-port-redirect.service` — nftables redirect 3100→8099 (kiosk hardcodes 3100, server runs on 8099)
- `/etc/nftables-canvas.conf` — nftables config for the redirect

---

## [0.2.59] — 2026-08-05
### Fixed — OWW satellite API mismatch

**Root cause:** `satellite.ts` was calling `openwakeword.Model(wakeword_models=[path])` but the installed OWW version changed the parameter name.

**Fix:** `server/src/voice/satellite.ts` line ~275: `wakeword_models=[raw_path]` → `wakeword_model_paths=[raw_path]`

Note: `wakeword-local.ts` already had the correct parameter name; only `satellite.ts` needed fixing.

### Pi infrastructure
- `/etc/systemd/system/canvas-sidecar.service` — persistent sidecar service (since superseded by `canvas-display-server.service`)
- `/etc/canvas-sidecar.env` — environment file (handles paths with spaces that `Environment=` in unit file can't)

---

## [0.2.58] — 2026-08-05
### Fixed — pkg binary bundling failures

**Root cause 1:** `nanoid` v5 is ESM-only (`"type":"module"`) — pkg's snapshot system can't include it, silently excludes the module.

**Root cause 2:** Mixed `||` and `??` operators without parentheses caused pkg's Babel parser to exclude files from snapshot.

**Fixes:**
- `server/src/db/index.ts` — replaced `require('nanoid')` with `crypto.randomBytes(12).toString('base64url')`
- `server/src/routes/pages.ts`, `devices.ts` — same replacement

**Build note:** Must use project-local `node_modules/.bin/pkg` (v6.14.2) NOT global `npx pkg` (v5.8.1). Target: `node20-linux-arm64`. Build must run natively on Pi arm64.

---

## [0.2.57] — 2026-08-04
### Fixed — Wake word disabled by env var even when DB says enabled

**Root cause:** `direct-wakeword.ts` checked `CANVAS_DISABLE_DIRECT_WAKEWORD=1` env var first and returned early. The old Tauri binary (Jul 31) sets this env var, so wake word was always disabled regardless of DB setting.

**Fix:** `server/src/voice/direct-wakeword.ts` ~line 500: DB setting `voice_integration_wake_enabled=1` now overrides the env var.

---

## [0.2.56] — 2026-08-04
### Added
- Flow engine: `action_send_intent` node — runs text through the full AI intent pipeline (intent, reply, slots)
- Flow engine: `action_load_url` node — navigates a device's webview to a URL
- Automation screen: delete key removes selected nodes/edges; edges clickable to select/delete

---

## [0.2.55] — 2026-08-03
### Fixed
- Switch page automation action: uses `page_picker` dropdown (was text input)
- Switch page / switch scene: now sends command to the connected display kiosk via WS (was only updating Core state)

---

## [0.2.54] — 2026-08-03
### Added
- `action_switch_page` automation node (companion to `action_scene`)
- `action_knowledge_card` automation node — pushes a knowledge overlay card to display devices

---

## [0.2.53] — 2026-08-02
### Added — Flow engine overhaul
- Visual flow editor with drag-and-drop nodes, connections, multi-select
- Trigger nodes: `trigger_voice`, `trigger_schedule`, `trigger_ha_state`, `trigger_webhook`, `trigger_manual`, `trigger_intent`
- Action nodes: `action_ha_service`, `action_tts`, `action_scene`, `action_delay`, `action_http`, `action_set_variable`, `action_ai_reply`, `action_device_command`, `action_log`
- Logic nodes: `logic_if_else`, `logic_switch`, `logic_for_each`
- Variable interpolation `{{var}}` in all string fields
- `core/src/flows.ts` — `FlowExecutor` class with full node execution engine

---

## [0.2.52] — 2026-08-01
### Added
- Doorbell integration: HA `binary_sensor` with `device_class=doorbell` triggers TTS + alert broadcast on state change
- Knowledge display overlay: display devices can receive and show knowledge cards from voice pipeline

---

## [0.2.51] — 2026-07-31
### Added
- TTS broadcast poller (`server/src/voice/tts-broadcast-poller.ts`) — edge device polls Core for server-pushed TTS audio
- Alert broadcast poller (`server/src/voice/alert-broadcast-poller.ts`) — polls Core for alert notifications
- Intercom poller (`server/src/voice/intercom-poller.ts`) — polls Core for intercom audio (initial version)
- Core: `/api/edge/tts/pending`, `/api/edge/alert/pending`, `/api/edge/intercom/pending` polling endpoints

---

## [0.2.50] — 2026-07-30
### Added
- MCP server support: both stdio and HTTP transport types
- Weather MCP: replaced HTTP workaround with proper stdio MCP integration

---

## [0.2.40–0.2.49] — 2026-07-20–29
### Summary
- Voice pipeline: wake word detection (OWW), HA Assist integration, STT + TTS
- `server/src/voice/` subsystem: `ha-pipeline.ts`, `direct-wakeword.ts`, `satellite.ts`, `wakeword-local.ts`, `mic.ts`
- Admin device management UI
- Scene staging and publishing workflow
- Widget library expansion (29 widgets total)
- ESPHome satellite mode for Pi voice hardware

---

## [0.2.1–0.2.39] — 2026-06-01–07-19
### Summary
- Initial canvas editor with drag-and-drop widget placement
- Multi-select, copy/paste, undo/redo
- Display/scene routing (`/display/scenes/:id`, `/display/pages/:id`)
- HA entity state binding via WebSocket
- Widget catalog: text, value, gauge, clock, button, switch, camera, etc.
- Fastify + SQLite server architecture
- Tauri kiosk browser wrapper
- MQTT device presence
- Pairing/enrollment flow
