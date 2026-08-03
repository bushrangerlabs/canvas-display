# Canvas Core and Edge current status

Last reviewed: 2026-08-02

## Implemented

- Core Docker application, PostgreSQL migrations, authenticated admin UI, device enrollment,
  device gateway, desired/reported state, scenes/assets, schedules, Home Assistant facade, MCP
  registry, AI provider registry, ASR/intent/LLM/TTS pipeline, and authenticated log history/SSE.
- Linux Tauri kiosk with embedded Display server, local rendering, Edge identity IPC, and a
  separate Core control channel.
- Native Edge Agent with durable command/session state, protocol v1, enrollment, hardware
  adapters, local authenticated IPC, media adapters, diagnostics, and recovery primitives.
- Device-scoped audio inventory, microphone test, speaker test, voice settings, wake-word list,
  and one-shot wake-word test routed from Core to the selected Pi.
- Pi-originated wake word → acknowledgement → capture → speech/no-speech cue → Core
  intelligence/TTS → response on the originating Pi.
- Per-device Core controls for independently enabling the wake, good-intent, and no-intent
  sounds, choosing packaged presets, uploading custom audio, and testing each cue on the Pi.
- Voice-requested YouTube title/URL playback through Core's real `media.play` tool to the
  originating Pi, with local Data API resolution, IFrame playback, and candidate failover.
- YouTube playback pause, resume, stop, and next-result controls through voice, Core REST and
  MQTT, legacy edge MQTT, and the Home Assistant media-player integration.
- Public YouTube playlist URL and spoken playlist/album/artist playback, with a device-scoped
  queue of up to 50 items, automatic continuation, and “YouTube Music” as a public-search alias.
- Fullscreen three-choice playlist discovery on the originating Pi with touch selection, ordinal
  voice follow-ups, playlist artwork, more-results paging, cancellation, and a two-minute
  device-local expiry.
- Editor-configurable Playlist Result widgets with four responsive layouts, stable slots 1–8,
  standard visual styling controls, page-role assignment by immutable ID, result-count discovery,
  panel-to-screen geometry mapping, and built-in-selector fallback.
- Signed update-manifest verification, updater journal and rollback primitives.
- Canvas Routine v1 contract and Phase 1 lifecycle: validated structured drafts, immutable
  revisions, enable/disable/archive state, rollback by revision selection, authenticated admin
  APIs, and durable PostgreSQL storage.
- Canvas Routine deterministic execution and simulation: typed Tool Registry calls, permission
  validation, confirmation pause/resume, sequential conditions/delays/results, bounded nesting,
  timeouts, cancellation, idempotency, durable execution/step audit history, and unknown-outcome
  separation.
- Settings → Routines visual management: guided trigger/condition/action/result authoring, live HA
  entity and Canvas page/scene/routine selectors, immutable revision history, permission and
  simulation views, activation/manual-run controls, confirmation/cancellation, and execution
  history.
- Canvas Routine trigger milestone: normalized exact voice phrases run before general AI planning,
  ambiguous phrases execute nothing, Canvas button and authenticated webhook endpoints use the
  same engine, MQTT `canvas/routines/<id>/trigger` messages enforce action-ID/expiry deduplication,
  and timezone schedules plus HA state transitions are operational.
- AI routine planning creates reviewable disabled drafts, independently classifies Canvas/HA/hybrid
  ownership, validates cached entity targets, supports interactive clarification, and edits existing
  routines through immutable draft revisions without changing the enabled revision.
- Repeated-request learning supports off/suggest/automatic-draft modes, excludes failed, ambiguous,
  confirmation-required, sensitive, and elevated plans, and promotes after three identical successes.
  User-approved enabled learned routines use a preflight-validated voice fast path with latency/hit
  metrics and ordinary-planning fallback.
- Canvas Skill v1 supports AI-created and manual disabled drafts, immutable revisions, explicit
  enable/disable/archive lifecycle, exact phrase and guarded multi-keyword voice matching,
  prompt expertise with scoped Tool Registry execution, and optional Canvas Routine backing. Core independently validates allowed
  tool names and routine references; generated skills cannot activate themselves or execute
  arbitrary code. Skills are managed under Settings → Skills.
- A private `au-weather-mcp` container runs beside Core and adapts the upstream stdio Australian
  weather server to Core's stateless HTTP JSON-RPC transport. Its five BOM-backed tools are
  registered as `mcp.au-weather.*`; weather requests receive a routing boost, and the enabled
  Australian weather skill is restricted to its combined location-weather tool.

## Verified in the current development deployment

- Core can address an enrolled Pi over the control path.
- Core's audio controls operate the Pi's hardware rather than the administrator's browser.
- `hey_jarvis` wake-word testing works as the fallback for stale `okay_nabu` configuration.
- Cue playback is edge-only and the wake detector is held until response playback finishes.
- Voice turns carry privacy-safe correlation IDs and stage timings across Pi and Core. A measured
  `What time is it?` turn uses the deterministic local-time fast path (ASR 1165 ms, routing 1 ms,
  planning 8 ms, TTS 57 ms, Core total 1232 ms, wake-to-finished playback 8200 ms). The detector
  subprocess is reset after each turn to discard queued PCM/model state; the verified turn produced
  one Core request, complete TTS, detector-ready recovery, and no delayed false wake.
- Adaptive end-of-speech is verified against the living-room Pi's elevated microphone noise floor:
  ordinary questions stop near two seconds rather than the eight-second maximum, and silence stops
  locally after about 3.5 seconds without invoking Core. The shared runtime ownership lock leaves
  exactly one wake detector active.
- OpenAI-compatible general responses now stream by sentence from generation through Piper to the
  originating Pi. A four-sentence hardware run played completely, began at 30.9 seconds instead of
  50.7 seconds, and did not restart listening until all chunks completed. Remaining time-to-first-
  sentence is local-model generation latency and depends on the selected conversation provider.
- Core log history and streaming are authenticated and the UI filters routine request noise.
- Core has discovered all three configured MCP servers and all 90 tools. The Australian weather
  MCP health check, tool inventory, and a real Melbourne BOM forecast call pass from inside the
  Core container network.
- The automated routine acceptance baseline passes against the live Core with the Pi Agent and kiosk
  connected. Core restart/reconnection and an isolated PostgreSQL dump/restore inventory check pass.
  A second disposable backup/restore also preserves synthetic non-empty routine history and active
  revision linkage. Core assets now use a persistent named volume, and disposable object restore
  preserves size/hash. Credential rows and a non-secret enrollment-seed fingerprint survive Core
  restart. The Devices screen now provides a guided, device-scoped Pi audio/voice acceptance panel
  with privacy-safe evidence export. All nine physical Pi audio/voice checks passed and the report
  was strictly validated against the paired, connected, unrevoked Edge and kiosk identity.
  Stale-restore identity recovery remains a deliberately deferred maintenance drill. Core enforces
  an independently configured monotonic security
  epoch across signed credentials and compatibility identity lookups; live restart acceptance proves
  epoch continuity with open pairing disabled.

The physical observations and automated hardware acceptance now agree for the current Pi deployment.
Host addresses are deliberately omitted because they are installation-specific.

## Partial or compatibility state

- The local Display server remains required. Its legacy MQTT, Home Assistant credential, and
  local administration paths coexist with the preferred Core authority.
- A second system Display server may remain installed; direct wake word must be disabled there
  so it does not contend with the embedded server.
- Raw Home Assistant panels have an approved Core-proxy design but can still use legacy
  device-side credentials.
- Edge update components have strong local primitives, but automated production feed,
  rollout, recovery, and self-update operations need end-to-end completion.
- Some capability/version values are assumed or historically hard-coded rather than generated
  from the running build and detected hardware.
- Device hardware tests require a connected kiosk/control channel; generic Edge IPC traits
  still contain explicit not-implemented fallbacks.
- YouTube title lookup can fall back to local `yt-dlp`, but a Data API key is still recommended
  because only the API path filters for embeddability before playback.
- Personal YouTube Music libraries, liked songs, private playlists, account recommendations,
  shuffle/repeat modes, and explicit-content policy are not yet implemented.

## Release interpretation

The repository is pre-1.0. Core, Display server, and Linux kiosk declare `0.1.0`; the Edge Rust
workspace and internal web package declare `0.0.0`. Protocol v1 is the compatibility contract.
There is not yet one repository-wide release version.

For remaining work and acceptance criteria, use [`ROADMAP.md`](./ROADMAP.md).
