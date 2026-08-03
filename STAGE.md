# Canvas Platform — Stage Document

**Last updated:** 2026-08-03  
**Canvas Display version:** 0.2.24  
**Architecture:** Canvas Core Server (standalone Docker) + Canvas Display (HA add-on)

---

## What We Are Building

A **self-hosted smart home display platform** comprising two components:

1. **Canvas Core Server** — A centralized AI brain running on a dedicated machine (Docker container). It holds all intelligence, configuration, device registry, and automation logic. It connects to Home Assistant and exposes APIs for display devices.

2. **Canvas Display** — A Home Assistant add-on running on display devices (tablets, touchscreens). Each device renders canvas scenes built in the web-based editor, handles local voice input, and connects to the Core for AI-powered responses. It is the "thin client" — the Core does the heavy lifting.

Together they form a platform where you design pixel-perfect smart home displays with a canvas editor, voice-control them with a full AI pipeline (wake word → ASR → intent routing → LLM + tool calls → TTS), and manage multiple display devices from one place.

---

## Canvas Core Server — Implemented

### Infrastructure
- [x] PostgreSQL datastore with full schema migration system
- [x] Fastify HTTP server on port 3100
- [x] CSRF protection, JWT/cookie auth (roles: `admin`, `viewer`, `voice`)
- [x] Admin login (`/api/admin/login`, `/api/admin/logout`)
- [x] Log streaming (`/api/admin/logs/stream`, `/api/admin/logs/history`)
- [x] Log level control (`/api/admin/log-level`)
- [x] Health endpoint (`/health`, `/api`)
- [x] Static file serving (web UI from `public/`)

### AI Intelligence
- [x] **Multi-provider AI registry** — local (Ollama, llama.cpp, vLLM, OpenAI-compat) + cloud (OpenAI, Anthropic, Azure, Gemini, Groq, OpenRouter)
- [x] AI provider CRUD routes (`/api/admin/ai-providers/*`) + task assignments
- [x] **Intent router** — classifies voice transcripts to intents (HA control, time/date, general, media, etc.) with confidence threshold
- [x] **Tool registry** — registers MCP tools + HA service tools, maps intents to tools
- [x] **Intelligent pipeline** — `runIntelligentPipeline()`: ASR → intent routing → tool execution → streaming TTS
- [x] **Voice pipeline** — `runVoicePipeline()`: simple ASR → LLM → TTS (for admin WebSocket session)
- [x] **Tool-aware conversation** — `runToolAwareConversation()`: handles unknown/HA intents with MCP tools
- [x] **Request routing policy** — configurable confidence threshold, clarification mode, per-domain enable/disable
- [x] **Shadow mode** — Hermes test corpus (16 cases), run-single, comparison, report

### Voice
- [x] **ASR** — Whisper (via Wyoming protocol over HTTP/TCP)
- [x] **TTS** — Piper (Wyoming protocol), returns raw PCM16 at 22050 Hz
- [x] **Edge voice bridge** — auto-provisioning token system
  - `POST /api/edge/voice/turn` — non-streaming voice turn for display devices
  - `POST /api/edge/voice/turn-stream` — streaming NDJSON voice turn (transcript → audio chunks)
  - `POST /api/edge/voice/metrics` — turn metric reporting from display
  - `GET /api/admin/voice-bridge` — view current token source/status
- [x] **Voice session WebSocket** — `wss://core/ws/voice` for admin UI test input
- [x] **Audio focus state** — tracks TTS playback state globally

### MCP (Model Context Protocol)
- [x] MCP server management — CRUD via `mcp_servers` table
- [x] **HTTP transport** — JSON-RPC over HTTP POST
- [x] **stdio transport** — child process spawn, JSON-RPC over stdin/stdout
- [x] **MultiMcpManager** — manages multiple servers, aggregates tools
- [x] Seed MCP servers from env vars on startup
- [x] Tool invocation with confirmation gate (`requiresConfirmation`)
- [x] MCP server admin UI with add/edit/delete
- [x] Bundled: `au-weather-mcp` (Python, stdio), `bowling-mcp` (Python, stdio)

### Home Assistant Integration
- [x] HA WebSocket client — subscribes to state changes
- [x] Entity catalog cache — synced to `ha_entities`, `ha_devices`, `ha_areas` tables
- [x] `GET /api/ha/entities` — full entity list
- [x] `GET /api/ha/catalog` — areas + devices + entities grouped
- [x] `POST /api/ha/entities/refresh` — force re-sync
- [x] `GET /api/ha/entities/:entityId` — single entity
- [x] `POST /api/ha/services` — call HA service

### Device Registry & Enrollment
- [x] Device CRUD (`/api/devices`, `/api/devices/:id`)
- [x] PKI-based enrollment — challenge/response with Ed25519 signatures
- [x] Device credentials stored (`device_credentials` table)
- [x] Authority watermark + epoch logging
- [x] Open pairing mode (for development — `CANVAS_CORE_ALLOW_OPEN_PAIRING`)
- [x] **Gateway WebSocket** (`/gateway/v1`) — device hello, auth, edge command delivery
- [x] Device capability/group tracking

### Scenes
- [x] Scene CRUD — create, get, list, delete
- [x] Scene revisions — versioned publishing
- [x] `POST /api/scenes/:id/publish` — publish a revision
- [x] `POST /api/scenes/:id/push` — push to assigned devices
- [x] Scene assignments — link scenes to devices
- [x] `GET /api/scenes/:id/published` — display devices fetch their scene

### Pages & Panels (legacy local-to-display)
- [x] Pages CRUD (SQLite on display device)
- [x] Panels CRUD within pages
- [x] Push page to device
- [x] Device page library + default page assignment
- [x] Panel state per device

### Schedules
- [x] Schedule types: `cron`, `once`, `daily`, `interval`
- [x] Occurrence tracking (`pending`, `dispatched`, `failed`, `missed`)
- [x] Offline reconciliation — catch up missed occurrences on restart
- [x] Schedule CRUD routes

### Routines
- [x] Routine definition schema (Zod-validated)
- [x] Routine engine — executes routine steps
- [x] AI routine planner — creates routines from natural language
- [x] Routine tool registration (`routine.plan`, `routine.create_draft`)
- [x] Routine CRUD routes
- [x] Routine execution + step results tracking

### Skills
- [x] Skill definition schema
- [x] Skill service — registers skills as tools
- [x] Skill CRUD routes

### MQTT
- [x] MQTT broker connection (configurable)
- [x] Navigation commands via MQTT topics (`canvas/devices/<id>/commands/page`)

### Privacy & Storage
- [x] Privacy settings — `retain_transcripts`, `retain_audio`, `transcript_log` mode
- [x] Garbage collection (`gc.ts`) — prunes old data

### AI Chat
- [x] `POST /api/admin/ai/chat` — multi-turn AI chat with tool calls, streaming NDJSON
- [x] `POST /api/admin/ai/chat/confirm` — confirm pending tool executions
- [x] Tool confirmation gate with pending confirmation state

### Assets
- [x] Content-addressed asset storage (`assets` table)

---

## Canvas Display (HA Add-on) — Implemented

### Add-on Infrastructure
- [x] HA add-on packaging (config.yaml, run.sh, Dockerfile)
- [x] Ingress on port 3100
- [x] Options: `jwt_secret`, `log_level`, `canvas_core_url`, `edge_voice_token`
- [x] HA supervisor token + URL auto-injected
- [x] Fastify server (SQLite-backed via `server/src/db/`)
- [x] JWT auth for API
- [x] Log streaming

### Canvas Editor (Web UI)
- [x] Full drag-and-drop canvas editor (`/editor` route)
- [x] Multi-select (Ctrl+A, shift-click)
- [x] Undo/redo (history stack)
- [x] Copy/paste/duplicate
- [x] Snap-to-grid (configurable grid size)
- [x] Arrow key nudge
- [x] Widget inspector panel (right sidebar)
- [x] Widget library sidebar (left)
- [x] View management (create, rename, delete canvas views)
- [x] Widget property forms with all field types (text, number, color, select, checkbox, entity, icon, slider, file)
- [x] Entity picker field (live HA entity search)

### Widget Library (31 widgets)

| Widget | Category | Notes |
|---|---|---|
| Text | display | Static/dynamic text |
| Value | display | HA entity value display |
| Gauge | display | Radial gauge |
| ProgressBar | display | Horizontal/vertical bar |
| ProgressCircle | display | Circular progress |
| Icon | display | MUI/HA icon |
| HTML | display | Raw HTML embed |
| ScrollingText | display | Ticker tape |
| Weather | display | Current conditions |
| Graph | display | Entity history sparkline |
| Resolution | display | Screen resolution info |
| AnalogClock | clock | SVG analog |
| FlipClock | clock | Flip animation |
| DigitalClock | clock | Configurable format |
| Button | control | HA service call |
| Switch | control | Toggle entity |
| Slider | control | Range entity control |
| Knob | control | Rotary entity control |
| InputText | control | Text input entity |
| Keyboard | control | On-screen keyboard |
| RadioButton | control | Option select |
| ColorPicker | control | Light color control |
| Image | media | Static/URL image |
| Camera | media | HA camera stream |
| IFrame | media | Embedded web page |
| Border | layout | Decorative border |
| Shape | layout | Rectangle/circle/line |
| Calendar | display | HA calendar integration |
| Screensaver | display | Idle dim/navigate |
| ScrollableContainer | layout | Scrollable widget grid |
| PlaylistResult | media | Voice-selected media result slot |

### Scene Display
- [x] Fullscreen kiosk view (`/display/scenes/:sceneId`)
- [x] Widget runtime rendering (lazy-loaded)
- [x] HA entity state binding (live WebSocket updates)
- [x] Widget interaction (button press → HA service call)

### Voice Loop
- [x] **Local wake word detection** (openWakeWord models)
- [x] **HA ESPHome satellite mode** — TCP-based, compatible with HA voice pipeline
- [x] **Direct Core mode** — HTTP streaming to Canvas Core (`/api/edge/voice/turn-stream`)
- [x] **End-of-speech VAD** — adaptive PCM16 silence detection
- [x] **Microphone ownership lock** — prevents dual pipeline activation
- [x] **Wake-ack cue sounds** — 6 configurable audio cues
- [x] **Intent cue sounds** — success/error audio feedback
- [x] **TTS playback** — raw PCM16 → WAV via `pcm16ToWav()`, played with `mpv`
- [x] Auto-provision voice token (captures and stores token on first Core connection)

### Settings UI
- [x] **General** — device name, display settings
- [x] **Integrations** — HA URL/token, MQTT broker
- [x] **Default pages** — assign default page per device
- [x] **Request routing** — confidence threshold, per-domain toggles, clarification mode
- [x] **Routines** — AI routine builder
- [x] **Skills** — custom skill definitions
- [x] **Privacy & Storage** — transcript/audio retention
- [x] **AI Providers** — multi-provider config, model assignments

### Intelligence Page (Admin)
- [x] Provider health status cards (LLM, ASR, TTS, MCP)
- [x] Shadow mode status
- [x] Audio focus state
- [x] **Voice bridge status** — shows token, source (env/db/none), copyable
- [x] Test voice intent (shadow-mode single run)
- [x] AI chat panel (multi-turn with tool execution)
- [x] MCP servers management (add/edit/delete/test, HTTP + stdio)

### Devices Page
- [x] Device registry list
- [x] Invitation management (generate/revoke)
- [x] PKI acceptance flow (challenge/response)
- [x] Authority mode status

### Logs Page
- [x] Real-time streaming log viewer
- [x] Log history

### Other
- [x] MQTT navigation commands
- [x] YouTube / media playback service
- [x] Hermes integration (AI shadow testing corpus)

---

## Known Gaps & What's Missing

### Voice Pipeline (High Priority)
- [ ] **Voice loop end-to-end testing** — Token auto-provision just deployed (v0.2.24); needs real-world verification that the full wake-word → Core → TTS loop works
- [ ] **Wake word model selection UI** — Currently must know model paths manually; no in-app picker
- [ ] **Voice settings in the in-app Settings UI** — Core URL and edge token must be set in HA addon config tab, not the in-app settings page
- [ ] **Voice error recovery feedback** — Display shows no visual indication of voice errors to the user

### Security / Enrollment
- [ ] **Production PKI mode** — `CANVAS_CORE_ALLOW_OPEN_PAIRING=true` warning is always shown; proper enrollment gate (`P-003`) not enabled. Devices aren't verified before accepting commands.
- [ ] **Token rotation** — No mechanism to rotate the voice bridge token without clearing the DB

### Display / UI
- [ ] **Multi-scene push** — Scene can be assigned to one device but no bulk push to all devices
- [ ] **Display status on editor** — No way to see if a display device is currently online in the editor
- [ ] **Scene preview** — No thumbnail/preview of scenes in the scenes list
- [ ] **Screensaver widget integration** — Exists as a widget but screensaver state doesn't feed back to HA
- [ ] **Touch gesture support** — Swipe between pages not implemented
- [ ] **Display orientation handling** — No automatic rotation/responsive layout switching

### Canvas Editor
- [ ] **Widget grouping** — Can't group widgets to move/resize together
- [ ] **Z-index control** — No UI to control widget layer order (bring forward/send backward)
- [ ] **Background image/color per scene** — Not exposed in scene settings
- [ ] **Grid/alignment guides** — Snap-to-grid exists but no visual alignment snapping between widgets
- [ ] **Widget templates/presets** — No saved widget configurations

### Core Intelligence
- [ ] **Routine scheduling integration** — Routines can be created via AI chat but the schedule→routine trigger chain needs testing
- [ ] **Skill runtime execution clarity** — Skills register as tools but the distinction between skills and MCP tools in practice is unclear
- [ ] **Intent router coverage** — Some intent types (media control, display navigation) may route incorrectly depending on LLM
- [ ] **Streaming TTS interruption** — No way to interrupt TTS mid-playback (e.g., new wake word while speaking)

### Missing Features (Product-level)
- [ ] **Push notifications / alerts** — No way to push alerts to a display from an automation (e.g., doorbell, weather alert)
- [ ] **Display screensaver / idle timeout** — Screensaver widget exists but no global idle timeout setting
- [ ] **Multi-display sync** — No way to push the same command/scene change to all devices simultaneously
- [ ] **Over-the-air updates** — Relies entirely on HA addon update mechanism; Core has no self-update
- [ ] **Dashboard analytics** — No metrics on which scenes are used, how often voice is triggered, etc.
- [ ] **Custom wake word training** — Locked to openWakeWord pre-trained models
- [ ] **Offline mode** — If Core is unreachable, display falls back to basic mode (no voice/AI); could be more graceful
- [ ] **Mobile companion app** — No mobile interface for quick display control
- [ ] **Template variables** — Can't parameterize scenes with variables (e.g., room name)
- [ ] **Widget data binding editor** — Entity-to-widget bindings are per-widget config only; no global binding manager

---

## Architecture Gaps / Technical Debt

| Area | Issue |
|---|---|
| Core `index.ts` | 1744 lines — should be split into route modules |
| `legacy-routes.ts` | 1510 lines — mixed concerns, "legacy" label implies planned refactor |
| PKI enrollment | `ALLOW_OPEN_PAIRING` always warned; production gate not hooked up |
| Scene sync | Core manages scenes; display fetches via `/api/scenes/:id/published` — no bidirectional sync |
| DB migrations | Append-only migration in single `migrate()` function — no versioned migration framework |
| Error handling | Voice loop backs off after multiple 401s but user sees no feedback |
| Tests | Only `youtube.test.ts` found; no integration tests for voice pipeline, intent routing, or scene push |

---

## Version History Summary

| Version | Key Changes |
|---|---|
| 0.2.24 | Auto-provision voice token; voice bridge status panel in AI Brain |
| 0.2.23 | Added `canvas_core_url` + `edge_voice_token` addon options; fixed frontend deploy path |
| Earlier | MCP stdio support, bowling MCP, web frontend fixes, logs page, AI intent chat |

---

## Recommended Next Steps (Priority Order)

1. **Verify voice loop end-to-end** — Trigger wake word on display, confirm Core auto-provisions token, confirm TTS audio plays back
2. **Voice settings in-app** — Add Core URL + voice token fields to the in-app Settings > Integrations tab (so users don't need the HA addon config UI)
3. **Production PKI mode** — Gate device connections behind enrollment; disable open pairing
4. **Push notification widget** — Allow HA automations to push alerts to display screens via Core
5. **Scene preview thumbnails** — Render mini canvas previews in the scene list
6. **Widget Z-index + grouping** — Complete the canvas editor feature set
7. **Multi-display broadcast** — Push scene/command to all registered devices at once
8. **Refactor `index.ts`** — Extract route groups into separate files
9. **Integration test suite** — Cover voice pipeline, intent routing, scene push end-to-end
10. **Offline graceful degradation** — Display shows useful fallback when Core is unreachable
