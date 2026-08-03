//! Slot/status primitives shared by [`super::InstallJournal`], kept decoupled from
//! `canvas_edge_updater::manifest`'s types: this module only ever stores plain
//! `String`/`u64` fields for version and security-counter bookkeeping, never the manifest
//! module's `ReleaseManifest` type itself.

use std::fmt;

/// One of the two durable install slots the Agent package can occupy.
///
/// This journal is deliberately generic enough to describe *either* subject a two-slot
/// design can cover per `docs/adr/0008-deployment-updates-and-platforms.md` ("The updater
/// uses a separate-package or two-slot self-update design so it can recover when the Agent
/// fails"): the Agent package's own two install slots, or (as documented future reuse of this
/// same schema/logic, not built or tested in this pass) the updater's own self-upgrade slots.
/// This pass only proves the Agent-package case end-to-end.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub enum Slot {
    A,
    B,
}

impl Slot {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::A => "a",
            Self::B => "b",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "a" => Some(Self::A),
            "b" => Some(Self::B),
            _ => None,
        }
    }

    /// The other slot. With exactly two slots, "not this one" is always unambiguous.
    pub const fn opposite(self) -> Self {
        match self {
            Self::A => Self::B,
            Self::B => Self::A,
        }
    }
}

impl fmt::Display for Slot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

/// Lifecycle state of a single slot, per
/// `docs/CANVAS_CORE_EDGE_ARCHITECTURE_PLAN.md` section 21.3 steps 4-9.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SlotStatus {
    /// The slot has never held a package.
    Empty,
    /// A candidate artifact has been cached/verified but installation has not started.
    Staged,
    /// Installation is in progress.
    Installing,
    /// Files are in place, but no boot/health check has been recorded yet.
    Installed,
    /// At least one boot attempt has been recorded and/or a health check has run; the slot is
    /// awaiting the local gate period before it can be committed as known-good.
    HealthChecking,
    /// Passed the health gate; a safe rollback/commit target.
    KnownGood,
    /// Terminally abandoned for this rollout attempt (crash loop, explicit failed health check
    /// carried through recovery, or an operator-initiated rollback past this slot).
    Failed { reason: String },
}

impl SlotStatus {
    /// The discriminant only, excluding `Failed`'s reason (stored in its own column).
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::Staged => "staged",
            Self::Installing => "installing",
            Self::Installed => "installed",
            Self::HealthChecking => "healthchecking",
            Self::KnownGood => "knowngood",
            Self::Failed { .. } => "failed",
        }
    }

    pub fn parse(status: &str, reason: Option<String>) -> Option<Self> {
        match status {
            "empty" => Some(Self::Empty),
            "staged" => Some(Self::Staged),
            "installing" => Some(Self::Installing),
            "installed" => Some(Self::Installed),
            "healthchecking" => Some(Self::HealthChecking),
            "knowngood" => Some(Self::KnownGood),
            "failed" => Some(Self::Failed {
                reason: reason.unwrap_or_default(),
            }),
            _ => None,
        }
    }
}

/// A full snapshot of one slot's durable state, returned by [`super::InstallJournal`] read
/// operations and as the payload of [`crate::journal::recovery::RecoveryAction`] variants'
/// companion lookups.
#[derive(Clone, Debug, PartialEq)]
pub struct SlotInfo {
    pub slot: Slot,
    pub status: SlotStatus,
    pub version: Option<String>,
    pub security_counter: Option<u64>,
    pub artifact_sha256: Option<String>,
    pub boot_attempts: u32,
    pub health_check_passed: bool,
}

#[derive(Debug)]
pub enum JournalError {
    Sqlite(rusqlite::Error),
    /// Attempted to stage a candidate into the slot that is currently active/running.
    SlotIsActive {
        slot: Slot,
    },
    /// Attempted to stage a candidate while a *different* slot already has an unresolved
    /// (not yet known-good or failed) candidate in progress.
    CandidateInProgress {
        slot: Slot,
    },
    /// A transition was requested from a status that does not legally allow it (for example,
    /// `mark_installing` on a slot that is still `Empty`).
    InvalidTransition {
        slot: Slot,
        from: &'static str,
        action: &'static str,
    },
    /// A slot-scoped operation (e.g. `mark_installing`, `commit_known_good`) was requested for
    /// a slot that is not the currently tracked in-progress candidate.
    NotCurrentCandidate {
        slot: Slot,
    },
    /// `commit_known_good` was requested for a slot that has not yet passed a health check.
    NotEligibleForCommit {
        slot: Slot,
    },
    /// `rollback_to_known_good` was requested but no other slot is currently `KnownGood`
    /// (for example, on the very first install ever, before any rollout has ever completed).
    NoKnownGoodSlot,
}

impl fmt::Display for JournalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sqlite(error) => write!(f, "sqlite error: {error}"),
            Self::SlotIsActive { slot } => {
                write!(f, "cannot stage a candidate into active slot {slot}")
            }
            Self::CandidateInProgress { slot } => {
                write!(
                    f,
                    "slot {slot} already has an unresolved candidate in progress"
                )
            }
            Self::InvalidTransition { slot, from, action } => {
                write!(f, "cannot {action} slot {slot} from status {from}")
            }
            Self::NotCurrentCandidate { slot } => {
                write!(f, "slot {slot} is not the currently tracked candidate")
            }
            Self::NotEligibleForCommit { slot } => {
                write!(
                    f,
                    "slot {slot} is not eligible for commit_known_good (never health-checked, or health check has not passed)"
                )
            }
            Self::NoKnownGoodSlot => {
                write!(f, "no other slot is currently known-good to roll back to")
            }
        }
    }
}

impl std::error::Error for JournalError {}

impl From<rusqlite::Error> for JournalError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

pub type JournalResult<T> = Result<T, JournalError>;
