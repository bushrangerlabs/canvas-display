//! Real peer-verified, method-scoped local IPC between the Edge Agent and the Tauri
//! renderer/updater processes, over a Unix domain socket with `SO_PEERCRED` peer-identity
//! verification (Phase 1 checklist item, architecture plan §25).
//!
//! This is the real Rust port of the design contract already proven in
//! `tests/local-ipc/local-ipc-model.ts` / `docs/PHASE_0_LOCAL_IPC_SPEC.md` (threat-model item
//! P0-04, ADR 0003) -- but with a real transport this time: [`peer::SoPeercredSource`] calls the
//! actual `getsockopt(SOL_SOCKET, SO_PEERCRED)` on an accepted `std::os::unix::net::UnixStream`,
//! and [`broker::LocalIpcBroker::accept`] wires that into a real `UnixListener`.
//!
//! What this module deliberately does *not* do (see `broker.rs` module docs for the full list):
//! implement a full production multi-request wire protocol, or provision socket
//! permissions/systemd sandboxing. Those are separate, later Phase 1 checklist items.
//! `actions.rs` forwards a small, current set of renderer actions (`display.screen_off`,
//! `display.screen_on`, `display.set_brightness`, `agent.app_version`) to a real, typed
//! `ActionExecutor` -- the illustrative TS-model method names (`scene.activate`,
//! `media.session.control`, etc.) still fall back to a placeholder executor, since enumerating
//! the full real renderer action set beyond today's Tauri commands remains future work.
//!
//! There is no key-material type anywhere under this module -- see `broker.rs` module docs.

mod actions;
mod broker;
mod peer;

pub use actions::{
    ActionExecutor, CurrentActionExecutor, CurrentActionHandler, CurrentRendererAction,
    PlaceholderActionExecutor, RecordedCall, RecordingActionExecutor,
};
pub use broker::{
    read_request, write_response, AcceptError, AuthenticatedSession, DispatchRequest,
    DispatchResponse, DurableAgentState, LocalIpcBroker, LocalIpcConfig, LocalIpcError,
    LocalIpcErrorCode, PeerRole,
};
pub use peer::{FakePeerCredentialSource, PeerCredential, PeerCredentialSource, SoPeercredSource};
