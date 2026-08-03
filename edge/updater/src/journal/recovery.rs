//! Crash-recovery entry point and crash-loop policy for [`super::InstallJournal`].

use super::state::{JournalResult, Slot, SlotStatus};
use super::{read_meta, read_slot, write_meta_candidate, write_slot_failed, InstallJournal};

/// How many boot attempts a candidate slot may accumulate (across real process/daemon
/// restarts, via [`InstallJournal::record_boot_attempt`]) without ever reaching `KnownGood`
/// before [`InstallJournal::recover_on_startup`] gives up on it and recommends
/// [`RecoveryAction::RollBack`] instead of continuing to retry indefinitely.
///
/// Chosen as `3`: one attempt is expected to be the normal first boot, a second tolerates a
/// single transient boot flake (e.g. a slow disk or a one-off race during first startup), and a
/// third confirms the pattern is not a fluke. A fourth attempt on the same never-committed
/// candidate is treated as a genuine crash loop. This intentionally mirrors the small,
/// bounded-retry philosophy already used for this daemon family in
/// `packaging/systemd/canvas-edge-agent.service` (`StartLimitBurst=5` over a 60s window for the
/// Agent itself); the updater's candidate-install crash-loop threshold is deliberately smaller
/// and is not time-windowed, since here each "attempt" is an entire boot of a never-yet-trusted
/// package rather than a quick process respawn.
///
/// Scope note: this threshold, and `recover_on_startup`'s use of it, only governs a *candidate*
/// slot that has not yet reached `KnownGood` (the case this Phase 1 pass proves end-to-end: a
/// new rollout crash-looping before it is ever committed, in which case `active_slot` never
/// moved and there is nothing to restore -- the recommended action simply abandons the
/// candidate). A slot that crash-loops *after* `commit_known_good` already flipped it to active
/// is a distinct, harder problem (second-guessing an already-trusted slot and reactivating an
/// older one) that is not built or tested in this pass; `record_boot_attempt` on an active slot
/// still durably records the count for future use, but nothing in this module currently acts on
/// it.
pub const MAX_BOOT_ATTEMPTS_BEFORE_ROLLBACK: u32 = 3;

/// What the caller (the updater daemon) should do at startup, decided purely from what is
/// already durably committed in the journal -- never from in-memory state, since surviving a
/// real process crash is the entire point of this call.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RecoveryAction {
    /// No candidate was in progress, or the active slot is already `KnownGood` with nothing
    /// pending. Nothing to do.
    Nothing,
    /// A candidate was left `Staged`/`Installing` with no completed install yet. Nothing was
    /// ever activated, so it is safe to resume the install step for this slot.
    ResumeInstall(Slot),
    /// A candidate reached `Installed`/`HealthChecking` but has not yet been committed
    /// known-good, and has not yet exceeded the crash-loop threshold
    /// ([`MAX_BOOT_ATTEMPTS_BEFORE_ROLLBACK`]). Since it was never committed, this is
    /// deliberately conservative/fail-closed (matching this codebase's established never-
    /// auto-retry-a-non-repeatable-ambiguous-outcome philosophy from
    /// `recover_non_repeatable_running`): it does not trust an already-recorded passing health
    /// check across a crash boundary, and does not itself resume/skip ahead to a commit. The
    /// recommended caller action is to attempt the boot/health-check cycle again (bounded by the
    /// same crash-loop threshold) rather than to blindly treat the candidate as committed. This
    /// is a non-terminal, side-effect-free recommendation: calling `recover_on_startup` again
    /// with no other state change yields the same answer.
    RollForward(Slot),
    /// A durable crash-loop threshold was exceeded, or an explicit prior `Failed` status was
    /// already recorded for the candidate slot. Recommends rolling back to the last `KnownGood`
    /// slot via [`InstallJournal::rollback_to_known_good`]. This is terminal: reaching this
    /// action durably marks the candidate `Failed` and clears it as the tracked candidate, so a
    /// repeated call finds nothing left to recover and returns `Nothing`.
    RollBack(Slot),
}

impl InstallJournal {
    /// Must be called once when the updater daemon starts, before resuming or acting on any
    /// in-progress rollout. Analogous to `canvas_edge_agent::storage::Storage::
    /// recover_non_repeatable_running`: it durably resolves any ambiguous intermediate state
    /// left by a crash, rather than leaving the caller to re-derive a decision from raw counters
    /// every time.
    ///
    /// When this call decides `RollBack` (crash-loop threshold exceeded, or an explicit prior
    /// `Failed` status), it durably marks the candidate slot `Failed` (with a reason describing
    /// which policy fired) and clears the tracked candidate, so a repeated call finds nothing
    /// left to recover and returns `Nothing` -- the same idempotent-terminal-recovery shape
    /// already used by `recover_non_repeatable_running`. `Nothing`, `ResumeInstall`, and
    /// `RollForward` are all side-effect-free: they only read already-committed state and do not
    /// themselves mutate the journal, so repeated calls with no other state change always agree.
    pub fn recover_on_startup(&mut self) -> JournalResult<RecoveryAction> {
        let tx = self.conn.transaction()?;
        let meta = read_meta(&tx)?;

        let Some(candidate) = meta.candidate_slot else {
            tx.commit()?;
            return Ok(RecoveryAction::Nothing);
        };

        let row = read_slot(&tx, candidate)?;

        let explicit_failure_reason = match &row.status {
            SlotStatus::Failed { reason } => Some(reason.clone()),
            _ => None,
        };
        let crash_looping = !matches!(row.status, SlotStatus::KnownGood)
            && row.boot_attempts > MAX_BOOT_ATTEMPTS_BEFORE_ROLLBACK;

        if let Some(reason) = explicit_failure_reason {
            write_slot_failed(&tx, candidate, &reason)?;
            write_meta_candidate(&tx, None)?;
            tx.commit()?;
            return Ok(RecoveryAction::RollBack(candidate));
        }
        if crash_looping {
            let reason = format!(
                "crash_recovery: exceeded max boot attempts ({}) without reaching known-good",
                row.boot_attempts
            );
            write_slot_failed(&tx, candidate, &reason)?;
            write_meta_candidate(&tx, None)?;
            tx.commit()?;
            return Ok(RecoveryAction::RollBack(candidate));
        }

        // Not (yet) crash-looping: report what is safe to do without mutating anything. Neither
        // branch below writes to the journal -- `ResumeInstall` is genuinely safe to retry
        // as-is, and `RollForward` deliberately does not "resolve" the ambiguity on the
        // candidate's behalf (see the variant's doc comment); the crash-loop counter above is
        // what eventually forces a terminal decision.
        let action = match row.status {
            SlotStatus::Empty | SlotStatus::KnownGood => {
                // Defensive only: a candidate slot should never legitimately be `Empty` or
                // already `KnownGood` while still tracked as the candidate (every code path
                // that reaches those statuses also clears/moves the candidate pointer). If it
                // ever happens, treat it as nothing left to recover rather than panicking.
                write_meta_candidate(&tx, None)?;
                RecoveryAction::Nothing
            }
            SlotStatus::Staged | SlotStatus::Installing => RecoveryAction::ResumeInstall(candidate),
            SlotStatus::Installed | SlotStatus::HealthChecking => {
                RecoveryAction::RollForward(candidate)
            }
            SlotStatus::Failed { .. } => unreachable!("handled above via explicit_failure_reason"),
        };

        tx.commit()?;
        Ok(action)
    }
}
