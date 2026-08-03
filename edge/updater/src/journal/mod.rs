//! A durable, crash-recoverable two-slot install journal for the Agent package, backed by
//! SQLite.
//!
//! This mirrors `canvas_edge_agent::storage`'s durability conventions closely (WAL mode,
//! `synchronous = FULL`, an idempotent versioned migration, and "process restart" in tests
//! means literally closing and reopening the same database file): every state transition here
//! is a single committed SQLite transaction, so a crash between any two calls always leaves the
//! journal in a *legible* intermediate state that [`InstallJournal::recover_on_startup`] can
//! deterministically act on from the committed file alone -- never from in-memory state.
//!
//! ## Scope
//!
//! Per `docs/adr/0008-deployment-updates-and-platforms.md` and
//! `docs/CANVAS_CORE_EDGE_ARCHITECTURE_PLAN.md` section 21.3/21.4, a full two-slot design
//! covers both (a) recovering the Agent package after a failed update, and (b) the updater
//! safely self-upgrading without bricking itself. **This module builds the slot/journal state
//! machine generically enough to represent either subject** ([`state::Slot`] and
//! [`state::SlotStatus`] carry no Agent-specific fields) **but this pass only proves it
//! end-to-end for the Agent-package case**, matching the Phase 1 exit criterion "Updater/
//! watchdog can restore the prior development Agent after an induced startup failure". The
//! updater's own self-replacement reusing this same schema/logic is documented future work, not
//! built or tested here.
//!
//! This module tracks *state only*. It does not download artifacts, extract packages, swap
//! binaries, or verify signatures/manifests (that is the sibling [`crate::manifest`] module's
//! job, which this module does not import or depend on). A future daemon layer calls out to the
//! real install/download logic and reports outcomes into this journal via the methods below.
//!
//! ## Crash-loop policy
//!
//! [`recovery::MAX_BOOT_ATTEMPTS_BEFORE_ROLLBACK`] bounds how many boot attempts a candidate
//! slot may accumulate (across real process/daemon restarts) before it has not yet reached
//! `KnownGood`, before [`InstallJournal::recover_on_startup`] gives up on it and recommends
//! rolling back rather than retrying forever. See that constant's doc comment for the exact
//! reasoning and which call site enforces it.

mod recovery;
mod state;

pub use recovery::{RecoveryAction, MAX_BOOT_ATTEMPTS_BEFORE_ROLLBACK};
pub use state::{JournalError, JournalResult, Slot, SlotInfo, SlotStatus};

use rusqlite::{Connection, OptionalExtension, Transaction};
use std::path::Path;

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS journal_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    active_slot TEXT,
    candidate_slot TEXT,
    rollback_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS journal_slots (
    slot TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    failed_reason TEXT,
    installed_version TEXT,
    security_counter INTEGER,
    artifact_sha256 TEXT,
    boot_attempts INTEGER NOT NULL DEFAULT 0,
    health_check_passed INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);
"#;

/// The durable two-slot install journal. Mirrors `canvas_edge_agent::storage::Storage`'s shape:
/// a thin wrapper around a single WAL-mode SQLite [`Connection`], opened once per process.
pub struct InstallJournal {
    conn: Connection,
}

struct MetaRow {
    active_slot: Option<Slot>,
    candidate_slot: Option<Slot>,
}

impl InstallJournal {
    /// Opens (creating if necessary) a WAL-mode SQLite database at `path` and runs migrations.
    /// Calling this again on the same path after a process restart is how the test suite proves
    /// durability: every previously committed row is still present.
    pub fn open(path: impl AsRef<Path>) -> JournalResult<Self> {
        let conn = Connection::open(path.as_ref())?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let mut journal = Self { conn };
        journal.migrate()?;
        Ok(journal)
    }

    fn migrate(&mut self) -> JournalResult<()> {
        let tx = self.conn.transaction()?;
        tx.execute_batch(SCHEMA_SQL)?;

        let already_migrated: bool = tx
            .query_row(
                "SELECT 1 FROM schema_migrations WHERE version = 1",
                [],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !already_migrated {
            tx.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (1, datetime('now'))",
                [],
            )?;
        }

        let meta_exists: bool = tx
            .query_row("SELECT 1 FROM journal_meta WHERE id = 1", [], |_| Ok(true))
            .optional()?
            .unwrap_or(false);
        if !meta_exists {
            tx.execute(
                "INSERT INTO journal_meta (id, active_slot, candidate_slot, rollback_count)
                 VALUES (1, NULL, NULL, 0)",
                [],
            )?;
        }

        for slot in [Slot::A, Slot::B] {
            let slot_exists: bool = tx
                .query_row(
                    "SELECT 1 FROM journal_slots WHERE slot = ?1",
                    [slot.as_str()],
                    |_| Ok(true),
                )
                .optional()?
                .unwrap_or(false);
            if !slot_exists {
                tx.execute(
                    "INSERT INTO journal_slots (
                        slot, status, failed_reason, installed_version, security_counter,
                        artifact_sha256, boot_attempts, health_check_passed, updated_at
                    ) VALUES (?1, ?2, NULL, NULL, NULL, NULL, 0, 0, datetime('now'))",
                    rusqlite::params![slot.as_str(), SlotStatus::Empty.as_str()],
                )?;
            }
        }

        tx.commit()?;
        Ok(())
    }

    /// Returns the currently active (running) slot, or `None` if no install has ever completed.
    pub fn active_slot(&self) -> JournalResult<Option<Slot>> {
        Ok(read_meta(&self.conn)?.active_slot)
    }

    /// Returns the slot currently tracked as an in-progress candidate, if any.
    pub fn candidate_slot(&self) -> JournalResult<Option<Slot>> {
        Ok(read_meta(&self.conn)?.candidate_slot)
    }

    /// Returns the full durable snapshot of one slot.
    pub fn slot_info(&self, slot: Slot) -> JournalResult<SlotInfo> {
        read_slot(&self.conn, slot)
    }

    /// Records a new candidate in `Staged` status in `slot`. Rejects (does not panic) if `slot`
    /// is currently active, or if a *different* slot already has an unresolved candidate in
    /// progress. Re-staging the same slot that is already the tracked candidate is allowed and
    /// simply overwrites it (this supports resuming a staging attempt that never got as far as
    /// `mark_installing`).
    pub fn stage_candidate(
        &mut self,
        slot: Slot,
        version: String,
        security_counter: u64,
        artifact_sha256: String,
    ) -> JournalResult<()> {
        let tx = self.conn.transaction()?;
        let meta = read_meta(&tx)?;

        if meta.active_slot == Some(slot) {
            return Err(JournalError::SlotIsActive { slot });
        }
        if let Some(candidate) = meta.candidate_slot {
            if candidate != slot {
                return Err(JournalError::CandidateInProgress { slot: candidate });
            }
        }

        tx.execute(
            "UPDATE journal_slots
             SET status = ?1, failed_reason = NULL, installed_version = ?2,
                 security_counter = ?3, artifact_sha256 = ?4, boot_attempts = 0,
                 health_check_passed = 0, updated_at = datetime('now')
             WHERE slot = ?5",
            rusqlite::params![
                SlotStatus::Staged.as_str(),
                version,
                security_counter as i64,
                artifact_sha256,
                slot.as_str(),
            ],
        )?;
        write_meta_candidate(&tx, Some(slot))?;

        tx.commit()?;
        Ok(())
    }

    /// Transitions `slot` from `Staged` (or idempotently, `Installing`) to `Installing`.
    pub fn mark_installing(&mut self, slot: Slot) -> JournalResult<()> {
        let tx = self.conn.transaction()?;
        require_current_candidate(&tx, slot)?;
        let row = read_slot(&tx, slot)?;
        match row.status {
            SlotStatus::Staged | SlotStatus::Installing => {}
            other => {
                return Err(JournalError::InvalidTransition {
                    slot,
                    from: other.as_str(),
                    action: "mark_installing",
                });
            }
        }
        write_slot_status(&tx, slot, &SlotStatus::Installing)?;
        tx.commit()?;
        Ok(())
    }

    /// Transitions `slot` from `Installing` (or idempotently, `Installed`) to `Installed`.
    /// Files are considered in place after this call, but the slot is not yet a safe rollback
    /// target until [`InstallJournal::commit_known_good`] succeeds.
    pub fn mark_installed(&mut self, slot: Slot) -> JournalResult<()> {
        let tx = self.conn.transaction()?;
        require_current_candidate(&tx, slot)?;
        let row = read_slot(&tx, slot)?;
        match row.status {
            SlotStatus::Installing | SlotStatus::Installed => {}
            other => {
                return Err(JournalError::InvalidTransition {
                    slot,
                    from: other.as_str(),
                    action: "mark_installed",
                });
            }
        }
        write_slot_status(&tx, slot, &SlotStatus::Installed)?;
        tx.commit()?;
        Ok(())
    }

    /// Durably increments `slot`'s boot-attempt counter and returns the new count. The first
    /// boot attempt recorded against an `Installed` slot also advances it to `HealthChecking`,
    /// since a boot attempt is a prerequisite for any health check to run.
    ///
    /// This call by itself never triggers a rollback recommendation -- see
    /// [`InstallJournal::recover_on_startup`] (this module's documented policy: the crash-loop
    /// threshold is enforced at recovery time, not by this call).
    pub fn record_boot_attempt(&mut self, slot: Slot) -> JournalResult<u32> {
        let tx = self.conn.transaction()?;
        let row = read_slot(&tx, slot)?;
        let new_count = row.boot_attempts + 1;
        let new_status = if matches!(row.status, SlotStatus::Installed) {
            SlotStatus::HealthChecking
        } else {
            row.status
        };
        tx.execute(
            "UPDATE journal_slots
             SET status = ?1, boot_attempts = ?2, updated_at = datetime('now')
             WHERE slot = ?3",
            rusqlite::params![new_status.as_str(), new_count, slot.as_str()],
        )?;
        tx.commit()?;
        Ok(new_count)
    }

    /// Records the outcome of a local health check for `slot`. Requires `slot` to already be
    /// `Installed` or `HealthChecking`. A single failed health check (`passed = false`) does
    /// *not* immediately flip the slot to `Failed` -- only the crash-loop policy in
    /// [`InstallJournal::recover_on_startup`] makes that call, so a transient failure on an
    /// otherwise healthy candidate doesn't permanently burn it on the first bad reading.
    pub fn record_health_check_result(&mut self, slot: Slot, passed: bool) -> JournalResult<()> {
        let tx = self.conn.transaction()?;
        let row = read_slot(&tx, slot)?;
        if !matches!(
            row.status,
            SlotStatus::Installed | SlotStatus::HealthChecking
        ) {
            return Err(JournalError::InvalidTransition {
                slot,
                from: row.status.as_str(),
                action: "record_health_check_result",
            });
        }
        tx.execute(
            "UPDATE journal_slots
             SET status = ?1, health_check_passed = ?2, updated_at = datetime('now')
             WHERE slot = ?3",
            rusqlite::params![
                SlotStatus::HealthChecking.as_str(),
                passed as i64,
                slot.as_str()
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// The local gate period has elapsed and health checks passed: marks `slot` as `KnownGood`
    /// and flips the active slot to it. The previously active slot (if any) is left completely
    /// untouched -- still `KnownGood`, retained as the rollback target for
    /// [`InstallJournal::rollback_to_known_good`] -- per
    /// `docs/CANVAS_CORE_EDGE_ARCHITECTURE_PLAN.md` section 21.3 step 9's requirement that
    /// returning to a prior known-good version remain possible.
    ///
    /// Rejects if `slot` is not the currently tracked candidate, or has not recorded a passing
    /// health check while in `HealthChecking` status.
    pub fn commit_known_good(&mut self, slot: Slot) -> JournalResult<()> {
        let tx = self.conn.transaction()?;
        require_current_candidate(&tx, slot)?;
        let row = read_slot(&tx, slot)?;
        if !(matches!(row.status, SlotStatus::HealthChecking) && row.health_check_passed) {
            return Err(JournalError::NotEligibleForCommit { slot });
        }
        write_slot_status(&tx, slot, &SlotStatus::KnownGood)?;
        write_meta(&tx, Some(slot), None)?;
        tx.commit()?;
        Ok(())
    }

    /// Returns the previously active slot's real recorded info so a caller can restore it, and
    /// durably records that a rollback occurred (incrementing the audit/crash-loop
    /// `rollback_count`, and marking the slot rolled back *away from* as `Failed`).
    ///
    /// The rollback target is always "the slot that is not currently active" -- with exactly
    /// two slots, a candidate can only ever be staged into that same non-active slot, so while
    /// a new candidate is mid-rollout, this correctly reports `NoKnownGoodSlot` once that
    /// candidate has overwritten the non-active slot's previous `KnownGood` record (a known,
    /// documented limitation of a pure two-slot design with no separately cached backup -- see
    /// ADR 0008's "cached compatible rollback" note, which is broader than this module alone
    /// implements).
    ///
    /// Rejects (does not panic) if there is no other slot currently `KnownGood` to roll back to
    /// -- for example, on the very first install ever, before any rollout has completed.
    pub fn rollback_to_known_good(&mut self) -> JournalResult<SlotInfo> {
        let tx = self.conn.transaction()?;
        let meta = read_meta(&tx)?;
        let active = meta.active_slot.ok_or(JournalError::NoKnownGoodSlot)?;
        let target = active.opposite();
        let target_row = read_slot(&tx, target)?;
        if !matches!(target_row.status, SlotStatus::KnownGood) {
            return Err(JournalError::NoKnownGoodSlot);
        }

        write_slot_failed(&tx, active, "rolled back to prior known-good slot")?;
        write_meta(
            &tx,
            Some(target),
            meta.candidate_slot.filter(|c| *c != active),
        )?;
        tx.execute(
            "UPDATE journal_meta SET rollback_count = rollback_count + 1 WHERE id = 1",
            [],
        )?;

        tx.commit()?;
        Ok(target_row)
    }

    /// The number of rollbacks ever recorded, for audit/crash-loop purposes.
    pub fn rollback_count(&self) -> JournalResult<u64> {
        self.conn
            .query_row(
                "SELECT rollback_count FROM journal_meta WHERE id = 1",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map(|value| value as u64)
            .map_err(JournalError::from)
    }
}

fn read_meta(conn: &Connection) -> JournalResult<MetaRow> {
    conn.query_row(
        "SELECT active_slot, candidate_slot FROM journal_meta WHERE id = 1",
        [],
        |row| {
            let active_slot: Option<String> = row.get(0)?;
            let candidate_slot: Option<String> = row.get(1)?;
            Ok((active_slot, candidate_slot))
        },
    )
    .map_err(JournalError::from)
    .map(|(active_slot, candidate_slot)| MetaRow {
        active_slot: active_slot.and_then(|s| Slot::parse(&s)),
        candidate_slot: candidate_slot.and_then(|s| Slot::parse(&s)),
    })
}

fn write_meta(
    tx: &Transaction<'_>,
    active_slot: Option<Slot>,
    candidate_slot: Option<Slot>,
) -> JournalResult<()> {
    tx.execute(
        "UPDATE journal_meta SET active_slot = ?1, candidate_slot = ?2 WHERE id = 1",
        rusqlite::params![
            active_slot.map(Slot::as_str),
            candidate_slot.map(Slot::as_str)
        ],
    )?;
    Ok(())
}

fn write_meta_candidate(tx: &Transaction<'_>, candidate_slot: Option<Slot>) -> JournalResult<()> {
    tx.execute(
        "UPDATE journal_meta SET candidate_slot = ?1 WHERE id = 1",
        rusqlite::params![candidate_slot.map(Slot::as_str)],
    )?;
    Ok(())
}

fn read_slot(conn: &Connection, slot: Slot) -> JournalResult<SlotInfo> {
    conn.query_row(
        "SELECT status, failed_reason, installed_version, security_counter, artifact_sha256,
                boot_attempts, health_check_passed
         FROM journal_slots WHERE slot = ?1",
        [slot.as_str()],
        |row| {
            let status_str: String = row.get(0)?;
            let failed_reason: Option<String> = row.get(1)?;
            let version: Option<String> = row.get(2)?;
            let security_counter: Option<i64> = row.get(3)?;
            let artifact_sha256: Option<String> = row.get(4)?;
            let boot_attempts: i64 = row.get(5)?;
            let health_check_passed: i64 = row.get(6)?;
            Ok((
                status_str,
                failed_reason,
                version,
                security_counter,
                artifact_sha256,
                boot_attempts,
                health_check_passed,
            ))
        },
    )
    .map_err(JournalError::from)
    .map(
        |(
            status_str,
            failed_reason,
            version,
            security_counter,
            artifact_sha256,
            boot_attempts,
            health_check_passed,
        )| {
            SlotInfo {
                slot,
                status: SlotStatus::parse(&status_str, failed_reason)
                    .expect("status column always holds a value written by this module"),
                version,
                security_counter: security_counter.map(|value| value as u64),
                artifact_sha256,
                boot_attempts: boot_attempts as u32,
                health_check_passed: health_check_passed != 0,
            }
        },
    )
}

fn write_slot_status(tx: &Transaction<'_>, slot: Slot, status: &SlotStatus) -> JournalResult<()> {
    tx.execute(
        "UPDATE journal_slots
         SET status = ?1, failed_reason = NULL, updated_at = datetime('now')
         WHERE slot = ?2",
        rusqlite::params![status.as_str(), slot.as_str()],
    )?;
    Ok(())
}

fn write_slot_failed(tx: &Transaction<'_>, slot: Slot, reason: &str) -> JournalResult<()> {
    tx.execute(
        "UPDATE journal_slots
         SET status = ?1, failed_reason = ?2, updated_at = datetime('now')
         WHERE slot = ?3",
        rusqlite::params![
            SlotStatus::Failed {
                reason: reason.to_string()
            }
            .as_str(),
            reason,
            slot.as_str()
        ],
    )?;
    Ok(())
}

fn require_current_candidate(tx: &Transaction<'_>, slot: Slot) -> JournalResult<()> {
    let meta = read_meta(tx)?;
    if meta.candidate_slot != Some(slot) {
        return Err(JournalError::NotCurrentCandidate { slot });
    }
    Ok(())
}
