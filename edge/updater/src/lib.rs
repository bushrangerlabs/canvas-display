//! Canvas Edge Updater: release manifest verification, anti-downgrade policy, and a durable
//! two-slot install journal used to recover the Agent after a failed update or interrupted
//! install, per `docs/adr/0008-deployment-updates-and-platforms.md` and
//! `docs/CANVAS_CORE_EDGE_ARCHITECTURE_PLAN.md` section 21.
//!
//! This crate is intentionally separate from `canvas_edge_agent`: per ADR 0008 and the Phase 1
//! privilege-boundary design (`docs/CANVAS_CORE_EDGE_ARCHITECTURE_PLAN.md` section 21.4), the
//! updater/watchdog must be able to recover the Agent even when the Agent itself cannot start, so
//! it must not depend on the Agent process or share its failure modes.
//!
//! Three pieces live here:
//!
//! - [`manifest`]: signed release manifest parsing/verification against a release trust root,
//!   anti-downgrade (monotonic security counter) enforcement, and signed rollback authorization.
//! - [`journal`]: a durable, crash-recoverable two-slot install journal (SQLite-backed, mirroring
//!   `canvas_edge_agent::storage`'s conventions) that lets the updater resume an interrupted
//!   install or roll back to the prior known-good Agent package after a crash, crash loop, or
//!   failed health check.
//! - [`fetch`]: real HTTP/TLS artifact download (synchronous `reqwest` blocking client with
//!   `rustls-tls`, streaming SHA-256 verification, bounded retry with exponential backoff, and
//!   an injectable real/fake `HttpClient` seam for tests). See that module's docs for the design
//!   constraints and what is still deferred (Range/resume, bandwidth throttling, auth).
//! - [`rollout`]: orchestrates the above into one end-to-end rollout attempt (verify ->
//!   evaluate -> stage -> install -> health-check -> commit/leave-for-recovery). The install step
//!   is either a real HTTP/TLS download (when the candidate source is an `http://`/`https://` URL,
//!   via [`fetch`]) or a local file copy (the fallback for tests and the manual demo trigger).
//!   See that module's docs for the honestly-scoped "still not done" notes.
//! - [`self_upgrade`]: the updater's **own** self-upgrade, reusing the same generic two-slot
//!   journal and rollout/rollback logic as the Agent-package path. It opens a second, independent
//!   [`journal`] instance (a separate SQLite file) tracking the updater's own slots, with a
//!   distinct `installed_root` and `active_binary_path` (the running `canvas-edge-updaterd`
//!   binary). The journal schema/logic is shared, not forked.

pub mod agent_client;
pub mod fetch;
pub mod journal;
pub mod manifest;
pub mod rollout;
pub mod self_upgrade;
