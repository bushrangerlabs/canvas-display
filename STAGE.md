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
- [x] **Voice loop end-to-end** — Auto-provision token deployed (v0.2.24); next wake word will pair
- [x] **Voice settings in the in-app Settings UI** — Core URL and edge token now configurable in Settings > Integrations > Canvas Core bridge (v0.2.25); includes test connection button
- [ ] **Wake word model selection UI** — Currently must know model paths manually; no in-app picker
- [ ] **Voice error recovery feedback** — Display shows no visual indication of voice errors to the user
- [ ] **Streaming TTS interruption** — No way to interrupt TTS mid-playback (e.g., new wake word while speaking)
- [ ] **Multi-room TTS announcement** — Broadcast a spoken TTS message to all/selected display devices simultaneously (e.g., "Dinner is ready")

### AI Self-Learning & Skill Autonomy ⭐ New
The AI should be able to observe interactions, identify patterns, and autonomously create, refine, and deploy new skills — similar to how the Hermes agent learns from its corpus.

- [ ] **Interaction memory** — Core persists every voice turn (transcript, intent, tool calls, outcome) in a learnable log. Currently only metrics are stored; full turn context is not.
- [ ] **Pattern recognition** — Identify frequently repeated requests that have no dedicated skill/routine, and surface them as skill candidates to the admin
- [ ] **Auto-skill generation** — When the AI handles a novel request successfully via tool calls, it can auto-propose a new named skill that encodes that behaviour, ready for admin approval
- [ ] **Skill versioning + rollback** — Skills currently have no version history; need to track changes and support reverting to a previous version
- [ ] **Skill testing harness** — Ability to run a skill in sandbox mode against test transcripts before enabling it (extends shadow-mode)
- [ ] **Contextual skill chaining** — Skills can call other skills, enabling complex multi-step behaviours composed from simpler primitives
- [ ] **User feedback loop** — Display shows thumbs-up/down after voice responses; feedback is stored and used to weight intent routing and skill priority
- [ ] **Corpus auto-growth** — Successful Hermes test runs are promoted to the corpus automatically rather than requiring manual curation
- [ ] **Skill marketplace / sharing** — Export/import skill definitions as JSON so they can be shared between Canvas Core installations

### Audio Broadcast Between Devices ⭐ New
Canvas display devices should be able to broadcast audio to each other — enabling intercom, whole-home announcements, and audio zone control.

- [ ] **Device-to-device audio streaming** — One display can stream its microphone/TTS output to one or more other display devices over the local network (WebRTC or RTP via Core broker)
- [ ] **Whole-home TTS broadcast** — When Core generates a TTS response or announcement, it can push the audio simultaneously to all registered display devices that are online
- [ ] **Intercom mode** — Two display devices can open a two-way audio channel (push-to-talk or open mic) — "Hey kitchen, dinner's ready"
- [ ] **Audio zones** — Group devices into zones (e.g., upstairs, downstairs); target broadcasts to a zone
- [ ] **Core audio broker** — Core acts as the relay/signalling server for device-to-device audio; handles session setup, auth, and teardown
- [ ] **Wake-word broadcast trigger** — Saying "announce: ..." on any device broadcasts the message as TTS to all devices in the zone/home

### HA Media Player Integration + Music Assistant ⭐ New
Each Canvas display device should register and behave as a full HA media player entity, enabling native HA automations and Music Assistant integration.

- [ ] **Register as HA media player** — Each display device auto-registers a `media_player` entity in HA via the integration (canvas-ui-hacs). Supports standard HA media player services: `play_media`, `media_play`, `media_pause`, `media_stop`, `media_next_track`, `media_previous_track`, `volume_set`, `volume_mute`
- [ ] **Now-playing state** — Display pushes current playback state (title, artist, album art, position, duration) back to HA so it shows in dashboards and automations
- [ ] **Music Assistant integration** — Connect Canvas displays as MA speakers/players. Voice command "play jazz in the kitchen" routes to Music Assistant, which queues tracks and pushes to the display's audio output
- [ ] **Music Assistant widget** — A dedicated widget showing MA queue, now playing, album art, and playback controls
- [ ] **Cast/stream receiver** — Display can receive an audio stream cast from HA (`media_player.play_media` with a stream URL) and play it via mpv
- [ ] **Multi-room sync** — Synchronise playback across multiple Canvas displays (join/unjoin group via voice or UI)
- [ ] **Voice music control** — "Play", "pause", "skip", "volume up" voice intents route to the correct MA/mpv player for the active room
- [ ] **Album art on display** — When music is playing, album art and track info auto-populate a Now Playing widget or overlay

### AI Web Lookup & On-Screen Display ⭐ New
When the AI answers a general knowledge question, it should be able to fetch supporting web content and display it on the screen.

- [x] **Web search MCP tool** — `web_search_stdio.py` bundled in Core, uses DuckDuckGo via `duckduckgo_search` library
- [x] **Wikipedia lookup tool** — `wikipedia_lookup` in the same stdio server, fetches Wikipedia summaries
- [x] **Knowledge card widget** — `KnowledgeCardWidget.tsx` — polls `/api/knowledge-card/latest`; shows title, body, source URL, optional image, dismiss button; auto-dismiss configurable
- [x] **Voice-triggered knowledge card** — Core intelligence pipeline extracts knowledge cards from `web_search`/`wikipedia_lookup` tool call results and includes `knowledge_card` in the voice turn response; display server stores it for the widget to display
- [ ] **"Show me" intent** — The AI recognises requests like "show me photos of the Eiffel Tower" or "look up the weather forecast for Sydney" and renders an appropriate widget or webpage
- [ ] **Iframe widget auto-open** — For richer content, AI can command the display to open a specific URL in the IFrame widget (with safe-list of allowed domains)

### Security / Enrollment
- [ ] **Production PKI mode** — `CANVAS_CORE_ALLOW_OPEN_PAIRING=true` warning is always shown; proper enrollment gate (`P-003`) not enabled. Devices aren't verified before accepting commands.
- [ ] **Token rotation** — No mechanism to rotate the voice bridge token without clearing the DB

### Display / UI
- [ ] **Push notifications / alerts** — No way to push alerts to a display from an automation (e.g., doorbell, weather alert overlay)
- [ ] **Doorbell integration** — When doorbell rings, display automatically shows camera feed and plays chime sound
- [ ] **Multi-scene push** — Scene can be assigned to one device but no bulk push to all devices
- [ ] **Display online status in editor** — No way to see if a display device is currently online in the editor
- [ ] **Scene preview thumbnails** — No thumbnail/preview of scenes in the scenes list
- [ ] **Screensaver state to HA** — Screensaver widget exists but screensaver on/off state doesn't feed back to HA
- [ ] **Touch gesture support** — Swipe between pages not implemented
- [ ] **Display orientation handling** — No automatic rotation/responsive layout switching
- [ ] **Persistent display overlay** — A pinned overlay layer (e.g., clock + weather strip) that sits on top of any scene without being part of the scene definition

### Canvas Editor
- [ ] **Widget grouping** — Can't group widgets to move/resize together
- [ ] **Z-index control** — No UI to control widget layer order (bring forward/send backward)
- [ ] **Background image/color per scene** — Not exposed in scene settings
- [ ] **Grid/alignment guides** — Visual snapping lines between widgets
- [ ] **Widget templates/presets** — No saved widget configurations
- [ ] **Scene transition animations** — Smooth fade/slide transitions when navigating between pages

### Core Intelligence
- [ ] **Routine scheduling integration** — Routines can be created via AI chat but the schedule→routine trigger chain needs testing end-to-end
- [ ] **Intent router coverage** — Media control, display navigation, and "show me" intents need dedicated routing paths
- [ ] **Conversational context memory** — Each voice turn is stateless; the AI doesn't remember what was said 2 turns ago in the same session

### Additional Widgets Needed
- [ ] **Now Playing widget** — Music Assistant / mpv now-playing card (art, title, artist, controls)
- [ ] **Knowledge Card widget** — AI web-lookup result display (heading, body, source URL, dismiss)
- [ ] **Announcement overlay widget** — Temporary full-screen message pushed from Core (doorbell, alert, TTS)
- [ ] **Energy monitor widget** — Solar generation, grid import/export, battery SoC from HA energy entities
- [ ] **Traffic / commute widget** — Google Maps travel time to a saved destination
- [ ] **Shopping list widget** — HA shopping list integration with voice add/remove
- [ ] **Countdown timer widget** — Visual timer, voice-set ("set a 10-minute timer")

### Missing Features (Broader Product)
- [ ] **Display screensaver / idle timeout** — Global idle timeout setting independent of the screensaver widget
- [ ] **Multi-display sync** — Push the same command/scene change to all devices at once
- [ ] **Over-the-air Core updates** — Core has no self-update; relies on manual docker pull
- [ ] **Dashboard analytics** — No metrics on scene usage, voice trigger frequency, skill hit rate
- [ ] **Custom wake word training** — Locked to openWakeWord pre-trained models
- [ ] **Offline mode graceful degradation** — When Core is unreachable, display shows a clear status and runs limited local mode
- [ ] **Template variables** — Parameterise scenes with variables (e.g., room name, person name)
- [ ] **Widget data binding manager** — Global manager to see/edit all entity→widget bindings across a scene
- [ ] **Canvas display web remote** — Simple mobile-friendly page to control a specific display (volume, page, now playing) without the full editor

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
| Voice turn storage | Full turn context (transcript + tool calls + outcome) not persisted; only timing metrics stored |
| Tests | Only `youtube.test.ts` found; no integration tests for voice pipeline, intent routing, or scene push |
| Audio routing | mpv is invoked as a subprocess; no proper audio session management for multi-device scenarios |

---

## Version History Summary

| Version | Key Changes |
|---|---|
| 0.2.25 | Core bridge settings in-app (Settings > Integrations): configure Core URL + voice token, test connection button |
| 0.2.26 | Knowledge Card widget; web search + Wikipedia MCP; core MCP stdio fix (all 6/6 MCPs up); knowledge cards extracted from voice turns |
| 0.2.25 | Canvas Core bridge settings in-app (Settings > Integrations); voice token UI; test connection button |
| 0.2.24 | Auto-provision voice token; voice bridge status panel in AI Brain |
| 0.2.23 | Added `canvas_core_url` + `edge_voice_token` addon options; fixed frontend deploy path |
| Earlier | MCP stdio support, bowling MCP, web frontend fixes, logs page, AI intent chat |

---

## Recommended Next Steps (Priority Order)

### Immediate (fix what's broken)
1. **Verify voice loop end-to-end** — Trigger wake word, confirm auto-provision, confirm TTS plays back
2. **Voice settings in-app** — Add Core URL + voice token to Settings > Integrations (remove need for HA addon config UI)

### Short-term (complete the core experience)
3. **Multi-room TTS broadcast** — Push spoken announcements to all display devices via Core
4. **HA media player registration** — Register each display as a `media_player` entity in HA
5. **Web search MCP tool** — Give the AI a built-in web search + Wikipedia lookup tool
6. **Knowledge card / web result widget** — New widget to display AI-fetched web content on screen
7. **Push notification / alert overlay** — Allow HA automations to push timed overlays to displays
8. **Voice settings in-app** — Add Core URL + edge token configuration to the in-app Settings UI

### Medium-term (self-learning AI)
9. **Interaction log persistence** — Store full turn context for every voice turn
10. **Pattern-based skill suggestions** — Identify repeated patterns and surface skill candidates
11. **Auto-skill generation + approval flow** — AI proposes skills; admin approves before enabling
12. **User feedback loop (thumbs up/down)** — Post-response feedback stored and fed back to routing

### Medium-term (audio & media)
13. **Audio broadcast / intercom** — Device-to-device and whole-home audio via Core broker
14. **Music Assistant integration** — Connect displays as MA players; voice music control
15. **Multi-room audio sync** — Join/unjoin display audio groups via voice or UI

### Longer-term (polish & scale)
16. **Production PKI mode** — Proper enrollment gate; disable open pairing
17. **Widget Z-index + grouping** — Complete canvas editor feature set
18. **Scene transition animations** — Smooth page navigation
19. **Scene preview thumbnails** — Mini canvas previews in scene list
20. **Refactor `index.ts`** — Extract route groups into separate files
21. **Integration test suite** — Voice pipeline, intent routing, scene push end-to-end
22. **Offline graceful degradation** — Useful fallback when Core is unreachable
23. **Dashboard analytics** — Scene usage, voice trigger frequency, skill hit rates
