//! Boundary types crossing the synchronous-main-thread / async-WS-thread divide (ADR 0009).
//!
//! Per ADR 0009, `session::EdgeSession` is owned entirely by the dedicated WS thread; the rest of
//! the daemon (SQLite storage, the local IPC broker) remains fully synchronous and never touches
//! `EdgeSession` directly. These two enums are the only things that cross that boundary, over a
//! `flume` channel in each direction.

use crate::protocol::{DeviceV1ControlMessage, ResumeCursor};

/// Sent from the synchronous main thread to the WS thread.
#[derive(Debug, Clone)]
pub enum TransportCommand {
    /// Enqueue a message to send to Core as soon as a connection is available. If no connection
    /// is currently established, this is held until `run_connection` sends its next `edge.hello`
    /// (there is currently no queuing/replay across reconnects beyond what `EdgeSession` itself
    /// tracks via the resume cursor -- see module docs in `transport::connection`). Boxed because
    /// `DeviceV1ControlMessage` is a large generated enum and this variant otherwise made
    /// `TransportCommand` itself large relative to `Shutdown` (clippy::large_enum_variant).
    Send(Box<DeviceV1ControlMessage>),
    /// Cleanly close the current connection (if any) and stop the WS thread's reconnect loop.
    Shutdown,
}

/// Sent from the WS thread back to the synchronous main thread, for observability (logging,
/// diagnostics, and future integration points such as relaying `Inbound` messages to other
/// in-process components). `EdgeSession`'s own reaction to an inbound message has already
/// happened by the time `Inbound` is emitted -- this is a notification, not a request for the
/// main thread to do anything with `EdgeSession` itself (it never leaves the WS thread).
#[derive(Debug, Clone)]
pub enum TransportEvent {
    /// A new WebSocket connection was established and the initial `edge.hello` was sent.
    Connected,
    /// The connection ended. `clean` distinguishes a real WebSocket close frame from an
    /// I/O-level drop (see `transport::connection::DisconnectReason`) -- this distinction matters
    /// for resume-cursor correctness per ADR 0009. `resume_cursor` is `EdgeSession::resume_cursor`'s
    /// value at the moment of disconnect -- the only way for the rest of the daemon to observe it
    /// at all, since `EdgeSession` itself never leaves the WS thread. Per ADR 0009, callers should
    /// only treat this as safe to durably persist when `clean` is `true`: an abrupt drop means the
    /// last few outgoing messages' delivery to Core is unknown, so presenting this exact cursor on
    /// the next reconnect could claim more than Core actually observed.
    Disconnected {
        clean: bool,
        detail: String,
        resume_cursor: Box<ResumeCursor>,
    },
    /// A message was received from Core and already fed through `EdgeSession::handle_core_message`.
    /// Boxed for the same reason as `TransportCommand::Send` -- see its doc comment.
    Inbound(Box<DeviceV1ControlMessage>),
    /// A message was sent to Core (either `EdgeSession`'s own reaction to an `Inbound` message, the
    /// initial hello, or a caller-supplied `TransportCommand::Send`). Boxed for the same reason.
    Outbound(Box<DeviceV1ControlMessage>),
    /// A text frame was received that could not be parsed as a `DeviceV1ControlMessage`. The frame
    /// is dropped rather than crashing the connection -- Core is a trusted, versioned protocol
    /// partner in this Phase 1 development slice, so a malformed frame is treated as a
    /// (loggable) anomaly, not grounds to tear down an otherwise-healthy connection.
    MalformedFrame(String),
}
