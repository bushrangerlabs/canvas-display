# Canvas UI Platform — Notes & Planning

> Living document. Updated as decisions are made.  
> Last updated: May 2026

---

## ⚠️ Voice Architecture — Needs Refactor (TODO)

The current voice implementation uses a custom Python OWW subprocess + direct HA WebSocket `assist_pipeline/run`. This works but is fragile (venv setup, model management, manual tflite shim).

**We should migrate to follow [OHF-Voice/linux-voice-assistant](https://github.com/OHF-Voice/linux-voice-assistant):**
- Uses the **ESPHome/Wyoming protocol** (port 6053) — HA treats it as a proper voice satellite device
- Ships `okay_nabu` and other wake word models directly in the repo (`wakewords/` dir)
- Local OWW detection on-device, HA handles STT + TTS
- Supports MicroWakeWord, WebRTC noise suppression, auto-gain
- Tested on Python 3.11 and 3.12, runs as a Docker container or systemd service
- Model loading via `--wake-word-dir` path (avoids the openwakeword package API churn we hit)

Canvas display already has `server/src/voice/esphome-server.ts` — the ESPHome protocol is partially there. The refactor would be:
1. Drop the custom Python OWW subprocess (`wakeword-local.ts`)
2. Drop the direct WebSocket pipeline client (`ha-pipeline.ts`)
3. Ship `okay_nabu` (and others) as bundled `.tflite` files in server resources
4. Rewrite voice to use the Wyoming/ESPHome satellite protocol — HA's voice integration then handles the full pipeline

---

## 🔊 Voice Satellite — Setup & Troubleshooting (May 2026)

### Architecture
- Canvas Display server runs an **ESPHome API TCP server** on port **6053**
- HA connects to it as if it were an ESPHome voice satellite device
- Server streams mic audio to HA → HA sends to OWW for wake word detection → STT → TTS response
- TTS audio comes back over TCP and is played via `mpv`

### Key files
| File | Purpose |
|---|---|
| `server/src/voice/esphome-server.ts` | ESPHome TCP protocol, mic streaming, TTS playback |
| `server/src/voice/index.ts` | Start/stop lifecycle, settings hot-reload |
| `server/src/voice/mic.ts` | `arecord` wrapper — captures mic as 16kHz mono PCM |
| `server/src/voice/proto.ts` | Protobuf encode/decode for ESPHome messages |
| `server/src/voice/framing.ts` | ESPHome binary framing (0x00 + varint length + msgType) |

### Wake word support
Server advertises two wake words to HA:
- `okay_nabu` — Okay Nabu
- `hey_jarvis` — Hey Jarvis

Active wake word is set via Settings → Voice Satellite → Wake Word dropdown and stored in DB. HA / OWW picks whichever is set as active.

### Root cause fixed: wake word not detecting (May 2026)
All HA assist pipelines had `wake_word_entity: null` — HA couldn't connect to OWW so the pipeline would start then immediately end.

**Fix applied directly to HA storage:**
```bash
# On HA server: /config/.storage/assist_pipeline.pipelines
# Pipeline id: 01jtybpfrx4garq8np5d2afxfg ("Home Assistant Cloud 1")
# Set:
"wake_word_entity": "wake_word.openwakeword"
"wake_word_id": "okay_nabu"
# Then restart HA core
```

If this happens again: HA UI → Settings → Voice Assistants → select pipeline → Wake word → choose openWakeWord entity.

### OWW log patterns — normal vs. problem
| Pattern | Meaning |
|---|---|
| `Loaded models → Receiving audio → disconnect` (every ~30s) | ✅ Normal — one pipeline session cycling |
| `Sent info + disconnect` (every ~32s) | ✅ Normal — HA polling OWW for wake word list |
| `Receiving audio` never appears | ❌ Audio not reaching OWW — check pipeline config |
| No score lines with debug logging on | Audio flowing but wake word not triggering — check mic quality / threshold |

### OWW configuration (on HA add-on)
- Threshold: **0.3** (lowered from 0.5 for better sensitivity)
- Trigger level: **1** (fire on first activation)
- Debug logging: **ON**

### Mic device
- Working device: `plughw:4,0` (HD Pro Webcam C920)
- Test mic directly: `arecord -D plughw:4,0 -f S16_LE -r 16000 -c 1 -d 3 /tmp/test.wav && aplay /tmp/test.wav`
- Server uses `arecord` child process, killed/restarted on settings change — the `mic error: Aborted by signal Terminated` log line on restart is **normal**

### Server log — expected sequence on startup
```
[voice] ESPHome voice server listening on port 6053
[voice] Voice satellite started — listening for HA on port 6053
[voice] HA connected from 192.168.1.103
[voice] Pipeline accepted by HA (port=0)
[voice] Mic started, streaming to HA
[voice] Wake word detection started        ← pipeline live, audio streaming to OWW
[voice] Wake word detected!                ← fires when wake word recognised
[voice] STT started — listening
[voice] STT ended: <transcript>
[voice] TTS started / TTS audio stream starting
[voice] Playing TTS audio (NNNN bytes PCM)
[voice] Pipeline run complete — restarting wake word   ← loops back
```

### Unhandled msgTypes — known safe to ignore
- `msgType=3` — `GetTimeRequest` — HA requests server time; we don't respond (HA ignores no-response)
- `msgType=34` — `ListEntitiesBinarySensorRequest`
- `msgType=38` — `ListEntitiesTextSensorRequest`

These are HA polling all entity types after connection. We send `LIST_ENTITIES_DONE` for `MSG.LIST_ENTITIES_REQUEST` but HA also sends per-type requests. Safe to ignore.

---

## 📋 Live Log Viewer (v0.2.1)

Added a real-time server log viewer accessible at `/logs`.

| File | Role |
|---|---|
| `server/src/logs.ts` | Monkey-patches `console.log/warn/error`; 1000-line ring buffer; emits via `logEmitter` EventEmitter |
| `server/src/routes/logs.ts` | `GET /api/logs/history` (JSON) · `GET /api/logs/stream` (SSE) |
| `web/src/pages/LogsPage.tsx` | SSE-based viewer — filter, level filter (All/Warn+/Errors), pause scroll, download |

**Important:** `server/src/index.ts` imports `./logs` as the **very first import** so no log lines are missed before modules load.

---

## 🏗️ Architecture Overview

```
canvas-ui-platform/
├── server/          Node.js + SQLite  — config store, REST API, WebSocket hub
├── web/             React SPA         — drag-drop editor, device/page management UI
├── browser/
│   ├── linux/       Tauri app         — kiosk display client (Linux / RPi AppImage)
│   └── android/     Tauri app         — kiosk display client (Android APK)
```

### Data Flow

```
Home Assistant  ──WebSocket──►  browser app  (live entity states — direct connection)
                                     │
Canvas UI Server ──WebSocket──►  browser app  (pages, commands, navigation)
                                     │
Canvas UI Web   ──REST/WS───►   server        (build views, manage devices/pages)

canvas-ui-hacs  ──REST───────►  server        (HA service calls → device commands)
(HACS integration)
```

### Why server-hosted views

The canvas-ui-platform server runs on the same hardware as HA (LAN). It is only unavailable when HA itself is down — in which case entity state is also gone regardless. There is no meaningful offline resilience benefit to caching views on the device; the server is effectively always local.

---

## ✅ Current Status (April 2026)

| Component | Status | Notes |
|---|---|---|
| `server/` | ✅ Complete | Views, devices, commands, AI proxy, HA proxy, schedules |
| `web/` editor | ✅ Complete | Full drag-drop editor, 35+ widgets, inspector, AI panel |
| `browser/linux` | 🔶 In progress | Tauri 2 scaffold done, settings + registration working |
| `browser/android` | 🔲 Not started | After Linux is stable — Tauri 2 Android target |
| Device management UI | ✅ Complete | List, edit, assign page, online status |
| Pages system | 🔲 Not started | See Pages section below |
| HACS bridge | 🔲 Not started | See HACS Integration Bridge section below |
| Automations | 🔲 Not started | See Automations section below |
| Device groups | 🔲 Not started | See Device Groups section below |
| QR code pairing | 🔲 Not started | Server generates QR; browser app scans on first boot |

---

## 📐 Pages, Panels & WebViews

### Hierarchy

```
Device
└── default_page_id
    Page
    ├── panels[]: up to 4 regular WebViews
    │   ├── id (friendly name: "header", "main", "footer")
    │   ├── position: x%, y%, w%, h%  (percentage of screen)
    │   ├── content: view_id  OR  url
    │   └── each independently navigable
    ├── floating WebView (optional, always on top, show/hide)
    │   └── content: view_id OR url (e.g. YouTube embed, persistent overlay)
    ├── swipe_left_page_id  (optional — full page swap on swipe left)
    └── swipe_right_page_id (optional — full page swap on swipe right)
```

### Key decisions

- **Swipe = full page swap** — all panels change simultaneously. Sub-pages are independent (own panel layout).
- **Sub-pages are one level deep** — a page has left/right sub-pages only; no further nesting.
- **Panel sizing = percentage-based** — x, y, w, h defined as % of screen. Editor shows pixel dimensions based on device's reported screen resolution.
- **Views designed to fit panels** — set canvas size to match the panel's pixel dimensions (editor shows this as a hint).
- **Panel IDs are friendly names** — "header", "main", "footer", "sidebar" etc. Used in navigation commands and button actions.
- **Floating WebView persists across swipe** — stays visible during page transitions unless sub-page defines its own floating config.
- **Page transition** — slide animation (like phone home screen), deferred to implementation.

### Page data model

```json
{
  "id": "page_abc",
  "name": "Main Dashboard",
  "swipe_left_page_id": "camera_page",
  "swipe_right_page_id": "climate_page",
  "panels": [
    { "id": "header", "x": 0, "y": 0,  "w": 100, "h": 20, "view_id": "header_view" },
    { "id": "main",   "x": 0, "y": 20, "w": 100, "h": 60, "view_id": "dashboard_view" },
    { "id": "footer", "x": 0, "y": 80, "w": 100, "h": 20, "view_id": "nav_view" }
  ],
  "floating": {
    "view_id": null,
    "url": null,
    "x": 10, "y": 10, "w": 80, "h": 80,
    "visible": false
  }
}
```

### DB changes needed

```sql
CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  swipe_left_page_id TEXT,
  swipe_right_page_id TEXT,
  floating_config TEXT,   -- JSON
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE page_panels (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  name TEXT NOT NULL,       -- friendly name: "header", "main" etc
  x REAL NOT NULL,          -- % 0-100
  y REAL NOT NULL,
  w REAL NOT NULL,
  h REAL NOT NULL,
  view_id TEXT,             -- NULL if url is set
  url TEXT,                 -- NULL if view_id is set
  position INTEGER NOT NULL -- display order
);

-- devices: add default_page_id (migrate from default_view_id)
ALTER TABLE devices ADD COLUMN default_page_id TEXT REFERENCES pages(id);
-- screen resolution (reported by browser app on hello)
ALTER TABLE devices ADD COLUMN screen_width INTEGER;
ALTER TABLE devices ADD COLUMN screen_height INTEGER;
ALTER TABLE devices ADD COLUMN pixel_ratio REAL;
-- friendly slug for HA service targeting
ALTER TABLE devices ADD COLUMN slug TEXT UNIQUE;
```

### Migration from default_view_id

On migrate: auto-create a single-panel full-screen Page for each device that has `default_view_id`. Point `default_page_id` at it. Non-breaking for existing users.

---

## 🖥️ Page Creator UI

New section in the web app alongside the canvas editor: **Pages**.

- Form-based panel editor (name, x%, y%, w%, h%, view/url picker)
- Live preview: coloured blocks showing panel layout at correct proportions
- Shows pixel dimensions per panel based on selected device's reported screen resolution
- Swipe page pickers (left/right sub-pages)
- Floating WebView config (position, size, initial content, show/hide)

No drag-to-resize for v1 — form + preview is sufficient and faster to build.

---

## 📱 Browser App — Design Decisions

### Settings / First Boot
- Local settings screen — always accessible
- QR code fast-path: server device page shows QR containing `{ serverUrl, haUrl, haToken, deviceName }`
- Settings screen on first boot (no config) or hidden gesture (5-tap on corner)
- Config persisted in Tauri app data dir (`config.json`)

### Screen resolution reporting
- On `hello` WS message, device reports `screen_width`, `screen_height`, `pixel_ratio`
- Server stores on device record — used by Page Creator to show pixel dimensions per panel

### Page rendering — Tauri multi-WebView
- Each panel = a native Tauri WebView, positioned absolutely by Tauri window config
- Floating = additional WebView, z-order above panels, shown/hidden via Tauri command
- Each WebView loads: `http://server/display?view=<view_id>` OR external URL
- Page swipe = slide all panel WebViews out, load new page's WebViews in

### Navigation commands (server → device via WebSocket)

| Command | Payload | Action |
|---|---|---|
| `load_page` | `page_id` | Replace entire page layout |
| `navigate_panel` | `panel_id, view_id OR url` | Load new content into one panel |
| `show_floating` | `view_id OR url, x, y, w, h` | Show floating WebView |
| `hide_floating` | — | Hide floating WebView |
| `show_popup` | `view_id OR url` | Show popup WebView (modal) |
| `hide_popup` | — | Hide popup WebView |
| `screen_on` | — | Turn display on |
| `screen_off` | — | Turn display off |
| `set_brightness` | `0–100` | Set display brightness |
| `reload` | — | Full app reload |

### Button widget navigation actions

Buttons send commands **via the server** (not direct Tauri invoke) so they are loggable and can trigger automations:

```
Button tap in View
  → POST /api/devices/{id}/command
  → server: logs, fires automation triggers
  → WS command to device
  → Tauri updates target WebView
```

Example payloads:
```json
{ "action": "navigate_panel", "target_panel": "main", "view_id": "climate_view" }
{ "action": "show_floating", "url": "https://youtube.com/embed/xyz" }
{ "action": "load_page", "page_id": "camera_page" }
{ "action": "hide_floating" }
```

### Screen Management
- **Linux/RPi**: `xset dpms force off/on` + `/sys/class/backlight/` via Tauri shell
- **Android**: `PowerManager.WakeLock` + `WindowManager.LayoutParams.screenBrightness` via Tauri plugin

### HA Entity Data
- Browser connects **directly** to HA WebSocket — not proxied through server
- Uses `home-assistant-js-websocket` library
- Constructs full `hass` object — used by canvas-ui widgets AND by LovelaceCardWidget
- Reconnects with exponential backoff on HA unavailability

### Lovelace cards
- Card JS bundles (`/hacsfiles/...`, `/local/...`) fetched from HA and cached locally on first load
- `hass` object from direct HA WS connection passed to card custom element
- If HA is down: card shows error state (identical to HA's own Lovelace behaviour)

---

## 🔗 HACS Integration Bridge (canvas-ui-hacs → canvas-ui-platform)

### Purpose
Expose canvas-ui-platform device commands as **native HA services**, making them available in HA's automation editor with full UI support (device picker, autocomplete, friendly names).

### Discovery
Auto-discover platform add-on via HA Supervisor API. Falls back to manual URL config.

### HA Services registered

```yaml
canvas_ui.navigate_page:
  device_id: kitchen_tablet   # friendly slug, UUID, or group ID
  page_id: night_mode

canvas_ui.navigate_panel:
  device_id: kitchen_tablet
  panel: main
  view_id: climate_view       # OR url: https://...

canvas_ui.show_floating:
  device_id: kitchen_tablet
  view_id: weather_overlay    # OR url: https://...

canvas_ui.hide_floating:
  device_id: kitchen_tablet

canvas_ui.show_popup:
  device_id: kitchen_tablet
  view_id: confirm_dialog

canvas_ui.hide_popup:
  device_id: kitchen_tablet

canvas_ui.screen_on:
  device_id: kitchen_tablet   # or group_id: downstairs

canvas_ui.screen_off:
  device_id: kitchen_tablet

canvas_ui.set_brightness:
  device_id: kitchen_tablet
  brightness: 50              # 0-100

canvas_ui.send_notification:  # future
  device_id: kitchen_tablet
  message: "Door bell rang"
  duration: 5
```

`device_id` accepts: UUID, friendly slug, group ID, or `all`.

### HA Device Registry

HACS integration registers each canvas-ui device as an HA device:

```
HA Device: "Kitchen Tablet"
├── sensor.canvas_ui_kitchen_tablet_status       (online / offline)
├── sensor.canvas_ui_kitchen_tablet_current_page (page name)
└── sensor.canvas_ui_kitchen_tablet_current_view (active view names)
```

Example HA automation using device entities:
```yaml
trigger:
  platform: state
  entity_id: sensor.canvas_ui_kitchen_tablet_status
  to: online
action:
  service: canvas_ui.navigate_page
  data:
    device_id: kitchen_tablet
    page_id: welcome_page
```

### Back-channel: platform → HA (webhook)

Platform fires HA webhooks for events:
- `canvas_ui_button_pressed` — `{ device_id, widget_id, action_data }`
- `canvas_ui_device_online`
- `canvas_ui_device_offline`

Enables: button presses on tablets triggering HA automations (lights, scenes, etc.).

### Auth
Supervisor token for local add-on discovery. Direct REST calls to platform trust Supervisor-originated requests on LAN.

---

## 👥 Device Groups

Devices can be assigned to named groups (e.g. "Downstairs Displays", "Bedrooms").

- All service calls accept `group_id` as alternative to `device_id`
- Special group `all` targets every registered device
- Groups managed in Devices section of web UI
- DB: `device_groups` + `device_group_members` tables

---

## 🤖 Automations (platform-native)

Lightweight automation engine inside the add-on, complementing HA automations.

### Trigger types
- **Time/cron** — "every day at 22:00"
- **HA entity state** — via HA WS subscription
- **Device event** — device comes online, button pressed
- **Manual** — from Automations UI or REST API

### Condition types
- Time range
- HA entity state
- Device currently on page X

### Action types
All WS commands above. Target: single device, group, or `all`.

### Example automations

```
Night Mode
  Trigger: Time → 22:00 daily
  Actions:
    navigate_page  → Kitchen Tablet → night_dashboard
    set_brightness → Kitchen Tablet → 20%
    navigate_page  → Bedroom Tablet → sleep_mode

Alert Mode
  Trigger: HA entity → alarm_control_panel.home = triggered
  Actions:
    navigate_page  → group:all → security_alert_page
    screen_on      → group:all
    set_brightness → group:all → 100%
```

---

## 🔧 Tech Stack

| Layer | Stack |
|---|---|
| Server | Node.js, Fastify, better-sqlite3, nanoid |
| Web editor | React 19, TypeScript, Vite, Material-UI |
| Browser app | Tauri 2 (Rust shell + React frontend) |
| HA entity data | home-assistant-js-websocket (direct from device) |
| Database | SQLite (server) |
| Realtime | WebSocket (server↔device, device↔HA) |
| Build/release | GitHub Actions, `release.sh` |

---

## 🗺️ Build Roadmap

### Phase 1 — Pages system (server + web UI)
- [ ] DB migration: `pages`, `page_panels` tables + device slug/resolution columns
- [ ] REST API: CRUD for pages + panels
- [ ] Page Creator UI in web app
- [ ] Device assignment: `default_page_id` replaces `default_view_id`
- [ ] Server pushes `load_page` to device on assignment change
- [ ] Migration: auto-create single-panel pages for existing device assignments

### Phase 2 — Browser app: multi-WebView pages
- [ ] Screen resolution reporting in `hello` message
- [ ] Tauri multi-WebView: create/position WebViews per panel config
- [ ] Page swipe: slide transition, load sub-page
- [ ] Floating WebView: show/hide, load URL or view
- [ ] WS command handler for all navigation commands

### Phase 3 — Navigation from widgets
- [ ] Button widget: new action types (`navigate_panel`, `load_page`, `show_floating` etc.)
- [ ] Commands routed via server (loggable, automation-triggerable)
- [ ] Server command log

### Phase 4 — HACS integration bridge
- [ ] Auto-discover platform add-on via Supervisor API
- [ ] Register HA services (navigate_page, screen_on/off etc.)
- [ ] Register HA devices + status/page entities
- [ ] Webhook back-channel: button presses → HA automations

### Phase 5 — Automations
- [ ] Automation engine in server
- [ ] Automations UI in web app
- [ ] HA entity state triggers via HA WS

### Phase 6 — Device groups
- [ ] `device_groups` + `device_group_members` DB tables
- [ ] Group management UI
- [ ] Group targeting in all service calls

### Phase 7 — Android
- [ ] Tauri 2 Android target in `browser/android/`
- [ ] Android screen management (wake lock, brightness)
- [ ] APK build + release

---

## 🤖 AI Panel
- Server-side proxy: ✅ Complete (`/api/ai/chat`, `/api/ai/settings`, `/api/ai/models`)
- Client AIService: ✅ Complete
- Providers: OpenAI, GitHub Models, Groq, OpenWebUI, Copilot Proxy
- Status: Needs real-world testing

---

## 📋 Deferred / Open

- **MQTT** — deferred; WebSocket covers LAN use case
- **View transitions** — slide animation on page swipe (implementation detail, deferred to Phase 2)
- **Authentication** — server has no auth; fine for LAN; needs consideration for remote access
- **Lovelace card converter** — import Lovelace YAML → native canvas-ui widgets (best-effort, top 10 card types). Deferred post-Phase 3.
- **View auto-scale** — CSS transform to fit any view into a panel regardless of canvas size. Deferred; designer sets canvas size to match panel for now.
- **Deep swipe nesting** — sub-pages of sub-pages. Deferred; one level only for now.
