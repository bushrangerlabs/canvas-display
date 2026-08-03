//! Local diagnostics summary (uptime, recovery counts, epoch state) for the Edge Agent daemon.
//!
//! Implements the "local diagnostics" portion of the Phase 1 checklist item "Add systemd
//! hardening, bounded logs, crash restart, safe recovery screen, and local diagnostics" from
//! `docs/CANVAS_CORE_EDGE_ARCHITECTURE_PLAN.md`. See [`summary::DiagnosticsSummary`] for the real
//! type; this module is intentionally small.
//!
//! ## Design: dependency injection, not a `Storage` handle
//!
//! [`summary::DiagnosticsSummary::new`] takes plain, already-available data (an [`crate::storage::Epochs`]
//! snapshot, a recovered-command count, a start `Instant`, a version string) instead of opening
//! `Storage` itself. The caller (`edge/agentd/src/main.rs`) already has all of this from its own
//! `storage.recover_non_repeatable_running()` / `storage.epochs()` calls at startup, so this
//! module just assembles it. That keeps it unit-testable with canned values and with no real
//! SQLite file involved -- see `edge/agent/tests/diagnostics_v1.rs`.
//!
//! ## What's explicitly out of scope here: the renderer-side "safe recovery screen"
//!
//! The architecture plan's checklist item bundles "safe recovery screen" together with "local
//! diagnostics", but they are different layers:
//!
//! - **Local diagnostics** (this module): a pure Rust struct + rendering, consumed today by
//!   `canvas-edge-agentd`'s own startup log line. This is fully in scope for this crate and is
//!   what's implemented here.
//! - **Safe recovery screen**: an actual on-screen UI a kiosk operator would see after a crash
//!   (e.g. "the display recovered from an unexpected shutdown; N commands could not be confirmed
//!   and were not retried"). That is a renderer/Tauri concern living in `browser/linux` (a
//!   separate TypeScript app), not this Rust workspace, and is **not attempted here**.
//!
//! The planned integration path for a future renderer-side recovery screen, so the next person
//! who picks this up doesn't have to re-derive it:
//!
//! 1. The renderer already authenticates to the Agent over the real Unix-socket IPC broker in
//!    `edge/agent/src/ipc/broker.rs` (see `RENDERER_METHOD_ALLOWLIST`).
//! 2. A future `diagnostics.summary` (or similarly named) method would need to be added to that
//!    allowlist, with a handler that calls `DiagnosticsSummary::new` (fed by that broker's already
//!    -open `Storage` handle) and serializes the result as its `DispatchResponse::result` string
//!    (JSON, most likely, to be consumable by TypeScript).
//! 3. The renderer would call that method once at its own startup (or on demand from a
//!    diagnostics/settings view) and decide whether to show a "recovered from a bad shutdown"
//!    banner/screen based on `recovered_unknown_outcome_count > 0`.
//!
//! This module deliberately does **not** add that IPC method -- doing so would mean editing
//! `edge/agent/src/ipc/broker.rs`, which is out of scope for this change (see this crate's other
//! in-flight work on the IPC layer). Adding it is a small, separate follow-up once someone owns
//! that file again.

pub mod summary;

pub use summary::DiagnosticsSummary;
