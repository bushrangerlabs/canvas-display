//! Transport-agnostic Core session/stream protocol state machine (hello/welcome, heartbeat,
//! generic ACK/reset, desired/reported state, command classes, resume, time uncertainty).
//!
//! This is a faithful Rust port of the TypeScript reference state machine
//! `edge/simulator/src/edge-simulator.ts`'s `EdgeSimulator` class, which is itself exercised by
//! `edge/simulator/test/edge-simulator.test.ts` and `tests/conformance/device-v1.test.ts`. The
//! port intentionally mirrors the TS control flow, field names (translated to Rust naming
//! conventions), and rejection/error codes exactly, so that the two implementations can be
//! trusted to behave identically against the same `contracts/device/v1` wire messages.
//!
//! This module is pure and synchronous: it has no knowledge of sockets, async runtimes, or
//! timers. Callers feed it [`DeviceV1ControlMessage`] values received from Core and get back the
//! [`DeviceV1ControlMessage`] values that should be sent to Core in response. Wall-clock time is
//! injected via [`EdgeSessionOptions::clock`] so tests can control it deterministically, matching
//! the TS reference's `now: () => string` option.
//!
//! ## Deliberate deviation from the TS reference: message ID generation
//!
//! The TS `EdgeSimulator` generates message IDs with a deterministic fake-UUID counter
//! (`nextId()`), which is a test-fixture convenience appropriate for a simulator. This is
//! production Agent code, so instead we generate real random UUIDv4 values (following the same
//! "real randomness, no seeded path in production code" convention used by
//! `crate::pairing::EdgeIdentity::generate`). This means tests in `tests/session_v1.rs` assert on
//! message *content* (types, codes, sequence numbers, payload fields) rather than on exact
//! fabricated message IDs.

mod state;

pub use state::{ClockFn, EdgeSession, EdgeSessionOptions, EdgeSessionSnapshot};
