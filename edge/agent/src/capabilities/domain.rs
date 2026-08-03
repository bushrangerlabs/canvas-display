//! Pure per-domain application-state model, and its conversion into the generated
//! [`DomainApplication`]/[`DomainApplicationStatus`]/[`DomainApplicationReason`] wire types.
//!
//! This module deliberately does **not** implement live reconciliation against real renderer
//! state -- that requires wiring into `session::state::EdgeSession` and the IPC/renderer boundary
//! (talking to the actual scene renderer, display backend, audio backend, etc. over
//! `crate::ipc`), which is a separate, later task. What is here is the data model a future
//! reconciliation pass should produce, plus a pure, fully-tested conversion function from that
//! model into the wire types Core actually receives.
//!
//! ## How this would replace today's `applied_domain` in `session/state.rs`
//!
//! `session::state::EdgeSession::report_applied_state` currently calls a private helper,
//! `applied_domain(revision)`, which unconditionally returns
//! `DomainApplication { status: DomainApplicationStatus::Applied, reason: None, .. }` for every
//! domain present in `desired_state`, regardless of whether anything was actually applied
//! successfully. A future integration task should instead:
//!
//! 1. Give `EdgeSession` a way to receive a real [`DomainOutcome`] per [`Domain`] -- most likely a
//!    small `HashMap<Domain, DomainOutcome>` populated by whatever component actually talks to the
//!    renderer/display/audio backends over `crate::ipc` (e.g. after issuing a `scene.activate`
//!    local IPC call and getting back success/failure, or after comparing the renderer's last
//!    reported scene revision against the desired one to detect [`DomainOutcome::Diverged`]).
//! 2. In `report_applied_state`, replace each `application.insert("scene".to_string(),
//!    applied_domain(revision))` call with something like
//!    `application.insert(Domain::Scene.as_str().to_string(),
//!    to_domain_application(revision, &self.domain_outcomes[&Domain::Scene]))`, falling back to
//!    `DomainOutcome::Pending` for any domain present in `desired_state` that hasn't been
//!    reconciled yet this pass.
//! 3. For a domain whose desired state names a capability this Edge's [`super::CapabilityDetector`]
//!    didn't detect (for example, desired voice config on a build with no voice pipeline), that
//!    reconciliation step should produce `DomainOutcome::Unsupported` rather than attempting to
//!    apply it and failing.
//!
//! None of the above is performed by this module; it only supplies the data types and the pure
//! conversion function ([`to_domain_application`]) that step 2 would call.

use crate::protocol::{DomainApplication, DomainApplicationReason, DomainApplicationStatus};

/// The reconciliation domain keys currently used as string literals in
/// `session::state::EdgeSession::report_applied_state` (`"scene"`, `"display"`, `"audio"`,
/// `"voice"`, `"update"`). Modeled as an enum here so a future integration has a
/// typo-proof key to reconcile against instead of repeating string literals.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Domain {
    Scene,
    Display,
    Audio,
    Voice,
    Update,
}

impl Domain {
    /// The exact wire-format key this domain is reported under in
    /// `state.reported.payload.application`, matching the string literals already used in
    /// `session/state.rs`.
    pub fn as_str(self) -> &'static str {
        match self {
            Domain::Scene => "scene",
            Domain::Display => "display",
            Domain::Audio => "audio",
            Domain::Voice => "voice",
            Domain::Update => "update",
        }
    }
}

/// Maximum length accepted by the generated `DomainApplicationReason` schema type (see
/// `protocol::generated::DomainApplicationReason::from_str`). Reason strings longer than this are
/// truncated (never panicked on) by [`to_domain_application`] -- see that function's doc comment.
const MAX_REASON_CHARS: usize = 128;

/// A pure, hardware-agnostic model of one domain's real reconciliation outcome for a given desired
/// revision. Produced by a future integration step (see module docs); this type itself performs no
/// I/O and holds no reference to the desired revision number, so the same [`DomainOutcome`] value
/// can be converted against any revision via [`to_domain_application`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DomainOutcome {
    /// This domain's desired state for the current revision has not yet been evaluated/applied.
    Pending,
    /// This domain's desired state was fully and successfully applied.
    Applied,
    /// This domain's actually-applied state has drifted away from the last desired state that was
    /// successfully applied (for example, the renderer process restarted and came back showing a
    /// different scene than the one Edge last confirmed).
    Diverged,
    /// Applying this domain's desired state failed. `reason` should be a short, operator-facing
    /// explanation (for example, "asset digest mismatch" or "renderer IPC call timed out").
    Failed { reason: String },
    /// This domain's desired state cannot be satisfied by this Edge's detected
    /// hardware/software capabilities (for example, desired display brightness control on a device
    /// with no detected backlight, or desired voice configuration on a build with no voice
    /// pipeline). `reason` should name the missing capability.
    Unsupported { reason: String },
}

/// Converts a `reason` string into a [`DomainApplicationReason`], truncating to fit the generated
/// schema's maximum length and substituting a fixed placeholder for an empty string, rather than
/// ever panicking or dropping the domain's status update. Reconciliation reasons may originate from
/// arbitrary lower-level error messages (subprocess output, IPC error strings, etc.), so unlike
/// `session::state::convert` (which panics on invalid *fixed literals* that are a pure programming
/// error to get wrong), this function must tolerate arbitrary real-world input gracefully -- a
/// truncated reason is far preferable to a crashed Agent.
fn domain_application_reason(reason: &str) -> DomainApplicationReason {
    let trimmed = reason.trim();
    let candidate = if trimmed.is_empty() {
        "unspecified".to_string()
    } else if trimmed.chars().count() > MAX_REASON_CHARS {
        trimmed.chars().take(MAX_REASON_CHARS).collect()
    } else {
        trimmed.to_string()
    };

    candidate
        .parse()
        .unwrap_or_else(|error| {
            panic!("truncated/sanitized reason {candidate:?} still rejected by generated schema type: {error:?}")
        })
}

/// Converts an internal [`DomainOutcome`] into the wire-format [`DomainApplication`] Core actually
/// receives, for the given `desired_revision`. Pure and infallible: every [`DomainOutcome`] variant
/// has a well-defined [`DomainApplicationStatus`], and reason strings are sanitized by
/// [`domain_application_reason`] rather than rejected.
pub fn to_domain_application(desired_revision: u64, outcome: &DomainOutcome) -> DomainApplication {
    let (status, reason) = match outcome {
        DomainOutcome::Pending => (DomainApplicationStatus::Pending, None),
        DomainOutcome::Applied => (DomainApplicationStatus::Applied, None),
        DomainOutcome::Diverged => (DomainApplicationStatus::Diverged, None),
        DomainOutcome::Failed { reason } => (
            DomainApplicationStatus::Failed,
            Some(domain_application_reason(reason)),
        ),
        DomainOutcome::Unsupported { reason } => (
            DomainApplicationStatus::Unsupported,
            Some(domain_application_reason(reason)),
        ),
    };

    DomainApplication {
        desired_revision,
        reason,
        status,
    }
}
