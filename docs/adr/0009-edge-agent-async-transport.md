# ADR 0009: Async runtime and WebSocket transport for the Edge Agent

- Status: Accepted
- Date: 2026-07-19
- Decision IDs: P-002, P-005

## Context

`edge/agent/src/session/` implements the Core session/reconnect/resume protocol state machine
(`EdgeSession`) as pure, synchronous, dependency-free Rust: it takes a deserialized
`DeviceV1ControlMessage` in and returns zero or more `DeviceV1ControlMessage` values to send back,
with an injectable clock and full unit-test coverage. It has no knowledge of sockets, async
runtimes, or timers (see that module's own doc comment). Everything else in the `edge/` workspace
today is also synchronous: SQLite storage via `rusqlite` (blocking), the Unix-domain-socket local
IPC broker (blocking `std::net`/`std::os::unix::net`), the pairing/manifest/journal/rollout code.
No `tokio` or other async runtime exists anywhere in this workspace yet.

Phase 1 requires a real network transport: an Agent that connects to Core over authenticated WSS
(P-005), feeds received frames into `EdgeSession::handle_core_message`, sends back whatever it
returns, reconnects with backoff on failure, and resumes correctly using the resume-cursor fields
(`core_stream_epoch`, `edge_stream_epoch`, `last_core_sequence`, `last_edge_sequence_acked`) already
modeled in `EdgeSession::create_hello`. This is a single WSS connection per systemd-supervised
daemon process (`canvas-edge-agentd`), on Linux `amd64`/`arm64` only, coexisting in the same binary
as the daemon's existing blocking storage/IPC code.

This decision was informed by first-pass research against a local model (Qwen3.6-35B via the
project's `llama.cpp` endpoint) on current (2026) crate maturity and known transport pitfalls, then
independently reviewed against this codebase's actual `EdgeSession`/IPC/storage code before being
adopted here -- the model's suggestions were treated as input to this decision, not as a substitute
for it. A second, independent adversarial review pass (a free model via OpenRouter) was run
specifically against the drafted ADR text looking for concurrency/soundness problems; it correctly
identified that using a blocking channel receive inside the single-threaded async WS loop would
stall the runtime, which is now captured explicitly in the Decision below. Both reviews were used as
input and re-verified against this codebase, not accepted at face value.

## Decision

- Use **`tokio`** as the async runtime, restricted to a **single-threaded (`current_thread`)
  runtime** confined to its own OS thread. `canvas-edge-agentd`'s `main()` and the rest of the
  binary (SQLite storage, the local IPC broker) remain fully synchronous; only the WS connection
  thread runs inside `tokio`. This avoids infecting the rest of the codebase with async and avoids
  the multi-threaded scheduler's overhead/complexity for a single always-idle connection --
  appropriate for a resource-constrained Raspberry Pi `arm64` target.
- Use **`tokio-tungstenite`** for the WebSocket client, with the **`rustls-tls` feature/backend**,
  not `native-tls`. `rustls` is pure Rust with no system OpenSSL/`pkg-config` dependency, which
  avoids known cross-compilation brittleness for `aarch64-unknown-linux-gnu` and keeps the arm64
  build environment consistent with the rest of this workspace's dependency-free build story
  (`ed25519-dalek`, `rusqlite` with the `bundled` SQLite feature, etc. are already chosen the same
  way for the same reason).
- Bridge the synchronous main process and the dedicated WS thread with a bounded MPSC channel
  (`flume`, added as a new workspace dependency) carrying a small, explicit boundary enum (outgoing
  `DeviceV1ControlMessage`s to send, and status/error events back), rather than sharing `EdgeSession`
  or any other state directly across the thread boundary. `EdgeSession` itself is owned entirely by
  the WS thread.
- **Critical implementation constraint, caught in adversarial review before implementation started:**
  inside the WS thread's `tokio::select!` loop, the flume receiver must be polled with its async API
  (`Receiver::recv_async()` / `into_stream()`), never the blocking `Receiver::recv()`. This is a
  single-threaded (`current_thread`) runtime with no other executor thread to fall back to -- a
  blocking channel receive would stall WebSocket I/O and heartbeat timers for as long as the main
  thread has nothing to send, which defeats the entire design. The main thread (synchronous, no
  tokio) is fine using the blocking `Sender::send()`/`Receiver::recv()` API on its side of the same
  channel; only the WS-thread side must use the async API. Channel backpressure/full-channel
  behavior (block vs. drop vs. error) must be an explicit, tested decision per direction when this is
  implemented, not left implicit.
- Implement **application-level heartbeat/liveness detection explicitly** (`tokio-tungstenite` does
  not surface an automatic dead-connection signal from missed pongs) using jittered ping intervals
  and a required count of consecutively missed pongs before declaring the connection dead, rather
  than a single fixed timeout -- this matters concretely for the Wi-Fi-connected Raspberry Pi target,
  where a naive fixed short timeout would false-positive on ordinary roaming/latency spikes.
- Treat a clean WebSocket close frame and an abrupt I/O-level disconnect (`ConnectionReset`,
  `BrokenPipe`, `UnexpectedEof`) as **distinct cases**: only a clean close is treated as a
  known-good point to persist the resume cursor from; an I/O-level drop discards in-flight
  assumptions and always goes through the same reconnect-with-backoff-and-resume path as any other
  failure, never assuming the last-sent message was received.
- Rely on `tokio-tungstenite`'s own frame reassembly (its `Stream`/`Sink` implementation already
  reassembles fragmented WebSocket frames into complete messages) rather than reading raw frames
  directly -- do not bypass it for a hand-rolled fragmentation path.
- Represent the protocol's sequence-number fields as genuine Rust integer types (`u64`, matching
  the generated protocol types' existing `NonZeroU64`/`u64` fields) end to end, and never round-trip
  them through a floating-point JSON number representation. This is already how the generated
  protocol types work (`serde_json` deserializes a JSON number directly into the target Rust integer
  type when the target field is typed as an integer, not `f64`), so this is a discipline to preserve
  going forward (e.g. in any new boundary/logging code), not a defect to fix in existing generated
  code.

## Consequences

- The workspace gains its first async dependency (`tokio`, `tokio-tungstenite`, `flume`), scoped
  deliberately narrowly (one thread, one connection) rather than adopted as the workspace's general
  concurrency model. `agentd`'s startup sequence gains a step that spawns this thread and holds the
  `flume` sender/receiver alongside its existing SQLite/IPC-broker handles.
- `EdgeSession` itself requires no changes -- the existing pure/sync design was already shaped to be
  wrapped by exactly this kind of thin I/O loop (see that module's own doc comments describing
  callers "feeding it messages and getting back messages to send").
- Resume-cursor correctness now depends on the WS thread's reconnect loop correctly distinguishing
  clean-close from I/O-drop (see Decision), which needs explicit test coverage (a fake/mock
  WebSocket transport exercising both paths), not just `EdgeSession`'s existing pure unit tests.
- Cross-compiling for Raspberry Pi `arm64` should remain no harder than it is today (rustls has no
  new system library requirements), but this should still be validated on real Pi hardware as part
  of Phase 1 exit, the same way the rest of the `edge/` workspace already was.

## Validation gates

- A fake/mock transport (not a real network socket) proves: reconnect-with-backoff triggers on both
  clean close and I/O-level drop; the resume cursor sent on the next `edge.hello` after reconnect
  matches what `EdgeSession` last observed; a clean close persists cursor state, an I/O drop does
  not assume the last outgoing message was received.
- A real, live WSS round trip against a minimal WS-enabled version of `dev-gateway-harness` (or an
  equivalent test server) proves the full loop end-to-end: connect, hello/welcome, at least one
  desired-state/state-reported round trip, forced disconnect, and a successful resumed reconnect
  with no duplicate or lost sequence numbers observed on either side.
- This must build and pass on both `amd64` and real Raspberry Pi 5 `arm64` hardware (per this
  project's established Pi validation pattern from the rest of Phase 1), not just `amd64`.
