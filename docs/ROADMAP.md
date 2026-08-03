# Canvas Display roadmap

Last reviewed: 2026-08-02

This is the authoritative list of known work remaining after the documentation/code audit.
Items are ordered by operational risk and user impact.

## P0 — complete the production voice and audio path

- **Completed 2026-08-02:** repeatable, device-bound Pi hardware acceptance covers inventory,
  persisted selections, microphone loopback, speaker output, wake-word detection, successful and
  no-speech turns, origin-device response routing, complete TTS, and cue/TTS non-overlap. The strict
  report and live identity gate passed all nine checks on the supported Pi deployment.
- **Baseline implemented 2026-08-02:** correlated Pi/Core logs measure wake, fixed capture, ASR,
  routing, planning/tool execution, TTS, Core round trip, first playback, playback, and total time.
  A deterministic time/date fast path reduced the measured Core portion from 27.97 s to 1.23 s
  and eliminated delayed false turns by resetting queued detector state after playback. Continue
  reducing the fixed 4.5 s capture window and add streaming/chunked TTS for general AI responses;
  today the complete response is generally produced before playback.
- Make single ownership of microphone/wake-word capture an install-time invariant, not only an
  environment convention. Detect and report competing Display server instances.
- Replace explicit audio IPC “not implemented” fallbacks with either real daemon operations or
  a capability rejection that the UI can explain.
- Validate every saved wake-word name against the device-reported inventory and migrate obsolete
  names such as `okay_nabu` to a supported model.
- Configure a YouTube Data API key for production title search and add a live acceptance case
  proving the selected result is embeddable; `yt-dlp` remains a best-effort no-key fallback.

## P0 — security and authority cleanup

- Complete the approved Core-authenticated proxy for raw Home Assistant panels, migrate existing
  kiosk settings, and remove HA tokens from Edge persistence and UI configuration.
- Disable or remove unused LAN, MQTT-command, HA, and admin compatibility surfaces from the
  Display server after confirming no installation depends on them.
- Close production enrollment by default after bootstrap, define credential rotation/revocation
  operations, and exercise backup/restore with the enrollment seed.
- Assign named operational owners to unresolved high-risk items from the threat model.

## P1 — Edge production hardening

- Load supervisor/restart/health policy from durable validated configuration and emit structured
  child-process logs.
- Complete updater network feed integration, staged fleet rollout, recovery, rollback, and
  updater self-upgrade acceptance on Pi and amd64.
- Replace optimistic DPMS reporting with observed state where the platform supports it.
- Complete durable media state and provider work, including Listnr/Music Assistant and durable
  YouTube configuration where those features are required.
- Export Edge telemetry to the chosen OpenTelemetry collector; current metrics are primarily
  in-process/log based.
- Replace assumed voice capabilities with detected/reported capabilities.

## P1 — Core resilience and observability

- Add provider circuit breakers, timeout budgets, and streaming response support across ASR,
  LLM, MCP/tool, and TTS boundaries.
- Remove remaining gateway placeholder behavior or convert it to explicit protocol errors.
- Add correlation IDs spanning admin request → Core command → kiosk/local server → voice
  pipeline and return them in downloadable support bundles.
- Add log retention/rotation limits and structured redaction tests for tokens, transcripts, and
  provider errors.

## P1 — Canvas Routines

- Phases 1–6 in [`CANVAS_ROUTINES_IMPLEMENTATION_GUIDE.md`](./CANVAS_ROUTINES_IMPLEMENTATION_GUIDE.md)
  are implemented. Functional/hardware, restart, clean-room restore, and rollback acceptance are
  recorded. The destructive security-epoch recovery exercise is deferred to an approved maintenance
  window and is not required for normal routine operation.
- Keep Phase 7 sandboxed advanced processing disabled until that production acceptance is approved.
- Implement an HA automation-draft handoff only when the connected Home Assistant exposes a
  supported safe editable-draft API; never write HA YAML/config storage directly.

## P1 — release consistency

- Establish one product release version and inject it into Core, kiosk, Display server, Edge
  Agent, updater, device hello, diagnostics, artifacts, and admin UI.
- Remove the historical `0.3.0-phase0` agent advertisement and generate runtime version data from
  the build.
- Define the supported Pi OS/WebKit/PipeWire matrix and run release acceptance on every supported
  architecture.

## P2 — maintainability

- Retire `/ws` and other legacy API aliases after usage telemetry shows no consumers.
- Decide whether Android remains frozen or returns to the supported-platform matrix.
- Replace historical manual evidence with automated checks where practical, especially loopback
  binding, WebKit content bridge, resource limits, restart behavior, and offline operation.
- Add a documentation link checker and require updates to this roadmap/current architecture when
  component boundaries or public routes change.

## Release gate

A production release is ready only when:

- all P0 items are complete or have an explicitly accepted, owned exception;
- contract, Core, web, kiosk, and Edge test suites pass;
- a clean Pi install, upgrade, rollback, restart, and offline recovery pass;
- the full hardware voice loop passes repeatedly without browser-local audio fallback or cue
  overlap;
- credentials are absent from logs, scenes, support bundles, and general Edge settings;
- backup and restore of Core authority and enrolled devices has been rehearsed.
