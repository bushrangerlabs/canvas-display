//! Library facade for `canvas-edge-agentd`: exposes the daemon's testable subsystems so the
//! integration tests in `edge/agentd/tests/` can drive them directly, while `src/main.rs` remains
//! the thin binary entry point that wires those subsystems together.
//!
//! Today the exposed subsystems are:
//! - [`ipc`] -- the local IPC server that runs the `LocalIpcBroker` against a real `UnixListener`
//!   on its own OS thread.
//! - [`enrollment`] -- the startup enrollment orchestration that loads (or runs) the durable
//!   `EdgeIdentity` + `EnrolledCredential` and decides what identity claims `edge.hello` carries.
//!
//! Everything else (storage, transport, the idle loop, signal handling) still lives in
//! `src/main.rs` because it is not meaningfully unit-testable without a real Core endpoint or a
//! real display.

pub mod enrollment;
pub mod ipc;
