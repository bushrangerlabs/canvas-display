# Current Canvas Core and Edge architecture

Last reviewed: 2026-08-02

## System shape

Canvas is an Echo Show-like application split between a central Core and each end device.
The three Pi-side programs are used together; they are not three alternative products.

```text
Browser administrator
        |
        v
Canvas Core (Docker, PostgreSQL, admin UI, AI/providers)
        |
        | authenticated device gateway / control
        v
Raspberry Pi
  +-- Canvas Edge Agent (identity, durable state, hardware and command execution)
  +-- Canvas Display kiosk (Tauri/WebKit user interface and Core control channel)
  `-- Canvas Display server (local rendering, audio, microphone and wake-word services)
```

### Canvas Core

`core/` is the central Docker application. It owns PostgreSQL-backed device records, enrollment,
desired state, scenes, schedules, Home Assistant credentials, provider configuration,
administration, logs, and the intelligence pipeline. The built web administration UI is served
by Core. Core exposes the device gateway at `/gateway/v1`, voice session compatibility at
`/ws/voice`, authenticated admin APIs, and the Edge voice turn API.

Core may call configured ASR, LLM, TTS, MCP, Home Assistant, and MQTT services. Secrets for
those services belong on Core and must not be copied into scene documents or general Edge
configuration.

The Core Compose application also contains a private `au-weather-mcp` service. The pinned upstream
Australian weather implementation is stdio-only, so `core/au-weather-mcp-http/bridge.py` provides
the stateless HTTP JSON-RPC transport expected by Core without publishing a host port. Core reaches
it at `http://au-weather-mcp:8000`; the bridge leaves the upstream BOM lookup and forecast logic
unchanged. Its container must be healthy before Core starts.

### Canvas Display kiosk

`browser/linux/` is the visible Pi application. Tauri hosts the WebKit interface and launches
the bundled local Display server. The kiosk uses its local server for rendering and device-local
audio/voice work, while a separate Core control WebSocket receives remote actions and
diagnostics. `CANVAS_CORE_CONTROL_URL` and `CANVAS_CORE_DEVICE_ID` identify that control path.

### Canvas Display server

`server/` supplies the kiosk's local HTTP/WebSocket compatibility API, rendered content,
audio-device discovery and tests, microphone capture, speaker playback, and direct wake-word
loop. It is currently required. The active instance is the server embedded by the kiosk.

Some installations also have a system-level Display server. Only one process may own the
microphone/wake detector. The active voice service claims a PID-checked lock in the user's runtime
directory; a second direct or Home Assistant voice path fails closed, while stale locks are
recovered. `CANVAS_DISABLE_DIRECT_WAKEWORD=1` can explicitly disable a non-owning instance.

The server still contains legacy MQTT, Home Assistant, and local-admin surfaces. They are
compatibility paths, not the preferred authority for new features.

### Canvas Edge Agent

`edge/agentd` and `edge/agent` form the durable native daemon. It owns enrolled device identity,
gateway session/resume state, command deduplication, local state, hardware adapters, media
state, diagnostics, and authenticated Unix-socket IPC at
`/run/canvas-edge/agent.sock`. The kiosk can obtain device identity and execute allowlisted
local actions through this IPC boundary.

`edge/updaterd` is a separate least-privilege update process. Signed manifests, journaling,
rollback primitives, and rollout policy exist, but production network rollout is not yet
considered complete; see the roadmap.

## Versions

| Deliverable | Declared version | Meaning |
| --- | --- | --- |
| Core | `0.1.0` | `core/package.json` |
| Display server | `0.1.0` | `server/package.json` |
| Linux kiosk | `0.1.0` | `browser/linux/package.json` |
| Edge Rust workspace | `0.0.0` | inherited from `edge/Cargo.toml`; development workspace version |
| Admin web bundle | `0.0.0` | internal web package, not a separately deployed product |
| Device protocol | v1 | schemas in `contracts/device/v1/` |

Do not treat the protocol hello's historical agent label (currently
`0.3.0-phase0` in some code/deployments) as the package release version. Unifying build and
runtime version reporting is tracked in the roadmap.

## Device control and audio tests

The browser displaying Core is only the administrator. It must not enumerate or test that
browser machine's audio hardware.

1. The admin UI calls `/api/admin/devices/:id/...` on Core.
2. Core sends a `device_http` request over the selected device's authenticated control channel.
3. The Pi kiosk proxies the allowlisted request to its local Display server.
4. The Display server enumerates or operates the Pi's PipeWire/ALSA devices.
5. The result returns along the same route to the admin UI.

The supported paths are:

- `GET /api/admin/devices/:id/audio/devices`
- `POST /api/admin/devices/:id/audio/test-mic`
- `POST /api/admin/devices/:id/audio/test-speaker`
- `POST /api/admin/devices/:id/voice/test-wakeword`
- `POST /api/admin/devices/:id/voice/cue-upload`
- `POST /api/admin/devices/:id/voice/test-cue`

Microphone and speaker selections, volume, wake word, wake threshold, and related voice settings
are stored per device in Core and applied to that device. The Pi's reported inventory is the
source for selectors. A disconnected device should produce a device-unavailable response, never
a silent fallback to browser media APIs.

Wake-detected, usable-intent, and no/bad-intent cues are independently enabled per device. Each
can use one of the packaged presets or a WAV, MP3, OGG, or FLAC file uploaded through Core
(maximum 2 MB). Uploaded audio is transferred to and stored in that Pi's controlled voice-cue
directory; Core stores only its validated device-local cue reference.

## Full voice-return loop

The current intended loop is:

1. The Pi-local detector hears the selected wake word (`hey_jarvis` is the safe default and
   fallback for obsolete model names).
2. If enabled, the Pi plays the device's selected wake-detected cue.
3. The Pi calibrates its microphone noise floor and captures until adaptive end-of-speech,
   no-speech timeout, or the eight-second safety maximum.
4. If enabled, the Pi plays the selected good-intent cue after usable speech/intent, or the
   selected no-intent cue after silence, timeout, or pipeline failure.
5. The Pi posts WAV audio, its `deviceId`, and a correlation ID to Core at
   `/api/edge/voice/turn-stream`, authenticated by
   `CANVAS_CORE_EDGE_VOICE_TOKEN`.
6. Core performs ASR and intent/tool routing. OpenAI-compatible conversational providers stream
   generated text; Core segments it into sentences and synthesizes each sentence with Piper.
7. Core sends newline-delimited transcript, audio-chunk, final metadata, and completion events.
8. That Pi plays chunks in order. Wake detection remains suppressed until every chunk finishes,
   except for an intentional new wake word used for barge-in.

The Pi reports privacy-safe stage timings to Core after each completed voice turn. Core stores
these in `voice_turn_metrics`; the device Voice settings tab shows recent samples and seven-day
p50/p95 summaries. Audio and transcripts are not included in these metrics.

Only the three configurable edge cues above are intentional. Core does not play cue sounds, and
the good-intent cue completes before the first TTS audio. Microphone/wake audio is 16 kHz PCM; raw Piper
PCM is wrapped for playback using `CANVAS_CORE_TTS_SAMPLE_RATE` (normally 22050 Hz).

## Voice-requested YouTube playback

A request such as “Play Bohemian Rhapsody official video on YouTube” uses the deterministic
`media_play` intent. Core preserves the originating `deviceId`, executes the real `media.play`
tool, and sends an allowlisted `POST /api/media/play` request to that device's connected kiosk.
The kiosk forwards it to its local Display server, which resolves an eligible embeddable video
and opens its local YouTube IFrame player. Playback is never broadcast when the originating
device is missing.

Direct YouTube URLs/video IDs do not require search credentials. For title search, the preferred
resolver uses a YouTube Data API v3 key in the Pi Display server's `YOUTUBE_API_KEY` environment
(or its local `youtube_api_key` setting), applying the configured region, language, safe-search,
embeddability, and availability policy. When no key exists, the Pi can use its local `yt-dlp`
binary for best-effort title lookup; those results cannot be pre-validated as embeddable, so the
player may need to try multiple candidates. Player callbacks track loading, playing, failure,
and candidate failover.

Public playlist URLs are resolved into a device-local queue of up to 50 playable items. Spoken
requests containing “playlist” use YouTube Data API playlist search, while album and “music by
artist” requests are normalised to music-playlist searches. “YouTube Music” is accepted as a
voice alias for this public YouTube music path; Canvas does not authenticate to a user's private
YouTube Music library. Playlist playback advances automatically at the end of each item, and its
queue and playback identifier belong only to the Pi that originated the request.

Spoken playlist discovery ranks up to 15 public results by requested-title/artist/decade coverage,
publisher signals and useful item count. It penalises common misleading variants such as karaoke,
reaction, cover and parody collections instead of accepting YouTube's first search result.
The Core media-language parser also distinguishes conversational song, video, artist, album,
playlist and mood/genre requests. It produces content-specific searches (for example official
audio for a named song, official video for a watch request, and greatest-hits playlists for an
artist) instead of forwarding the full spoken sentence as an undifferentiated search string.

Discovery-style artist, album, playlist and mood/genre requests open a fullscreen, device-local
selection surface with the three highest-ranked public playlists. Each card shows its title,
channel, item count, and YouTube playlist artwork (with a local fallback when unavailable). The
user can tap a card or say “first,” “second,” or “third”; “show me
more” pages through the ranked results and “cancel” closes the interaction. Pending choices are
held only on the requesting Pi and expire after two minutes. Exact playlist URLs, named songs and
specific video requests still start immediately.

The scene editor provides a first-class `Playlist Result` widget. Each instance has a stable result
slot (1–8), four presentation presets (artwork above, artwork left, artwork background and compact),
editable colours, borders, typography and field visibility, and container-responsive internals.
Existing widget-based scenes can be reopened from the Core **Scenes** screen in the visual editor.
The editor loads the latest revision and stages subsequent saves against the same scene ID; raw
manifest JSON editing remains available as a separate advanced action.
A published scene containing these widgets can be placed on a page, and **Settings → Default pages**
can assign that immutable page ID to the `playlist_selection_page_id` system role. Core reads enabled unique slots
from the assigned page's published scenes, transforms widget geometry through its containing page
panels, and sends exactly that many ranked results and layout definitions to the requesting Pi.
Missing, deleted, unpublished or empty assignments fall back to the built-in three-choice selector.

The same originating-device route is used for YouTube playback controls. Voice requests and
administrative callers use `POST /api/media/control` with `pause`, `resume`, `next`, or `stop`;
the kiosk applies that command to the Pi's managed YouTube player rather than to the browser
displaying Core.

Core MQTT commands use `canvas/devices/<deviceId>/commands/media` with a JSON payload such as
`{"source":"youtube","action":"pause"}`. Results are published to
`canvas/devices/<deviceId>/state/media`. The edge server also accepts the legacy topic
`canvas_display/<deviceId>/cmd/media` with the same payload.

## Security and ownership

- Core owns fleet authority, service credentials, intelligence, durable scenes, schedules, and
  administration.
- Edge owns physical hardware execution, local survival state, enrolled private material,
  playback, capture, and wake-word detection.
- The kiosk owns presentation and local interaction state.
- The local Display server is reachable only as required by the kiosk/device. New remote control
  belongs on the authenticated Core-to-device channel.
- Admin reads require an authenticated viewer/admin role; mutations require admin role and CSRF
  protection where applicable.
- Edge voice uses a separate scoped bearer token. It is not an admin session.
- Raw Home Assistant panels remain a documented exception: the approved target is a
  Core-authenticated proxy, but legacy kiosk settings can still contain an HA URL/token. This is
  an open security migration item.

## Persistence

- Core: PostgreSQL plus the configured asset directory.
- Edge Agent: SQLite and checkpoint material under its data directory.
- Display server: local compatibility/settings store and rendered assets.
- Kiosk: presentation preferences needed by the local UI.

Back up Core's database, enrollment seed, configuration/secrets, and asset storage together.
Losing or rotating the enrollment seed can invalidate device credentials.

## Build and verification entry points

```sh
npm run test:contracts
npm --prefix core test
npm --prefix core run type-check
npm --prefix web run build
npm --prefix browser/linux run build
cargo test --locked --manifest-path edge/Cargo.toml
```

Hardware acceptance must additionally be run on a Pi: enrollment/reconnect, page control,
audio inventory, selected microphone playback test, selected speaker test, wake-word test, a
successful voice turn, a no-speech turn, TTS playback without cue overlap, restart recovery, and
offline display behavior.
