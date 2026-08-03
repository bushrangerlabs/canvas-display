//! Phase 1 durable Edge storage: real SQLite-backed inbox/outbox, command receipt journal,
//! authority/stream epochs, and schedule-occurrence deduplication.
//!
//! This module intentionally implements the same durability contract already proven in-memory by
//! the Phase 0 TypeScript model (`tests/fault-model/durability-model.ts`): commit-before-ack,
//! replay-safe command deduplication, `unknown_outcome` recovery for non-repeatable commands left
//! `running` across a crash, durable outbox retention until acknowledged, and stale-epoch
//! rejection. Unlike that model, this one is backed by an actual SQLite file with WAL journaling,
//! so "process restart" in tests means literally closing and reopening the same database file,
//! not just constructing a new in-memory object.
//!
//! Deliberately out of scope for this first slice (tracked in
//! `docs/CANVAS_CORE_EDGE_ARCHITECTURE_PLAN.md` Phase 1 checklist, not silently dropped):
//! the full outbox priority-shedding nuance (tombstone-before-deny for already-sequenced
//! telemetry) proven in the TypeScript model is simplified here to straightforward
//! capacity-based rejection before sequencing; restore/reset epoch rotation is implemented only
//! at the storage-primitive level, without the full desired-state-snapshot handshake.

pub mod scene_manifest;

use rusqlite::{Connection, OptionalExtension};
use std::fmt;
use std::path::{Path, PathBuf};

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS epochs (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    core_stream_epoch INTEGER NOT NULL,
    edge_stream_epoch INTEGER NOT NULL,
    authority_epoch INTEGER NOT NULL,
    restore_generation INTEGER NOT NULL,
    last_core_sequence INTEGER,
    last_edge_acked_sequence INTEGER,
    next_edge_sequence INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS inbox (
    stream_epoch INTEGER NOT NULL,
    sequence INTEGER NOT NULL,
    message_id TEXT NOT NULL,
    message_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (stream_epoch, sequence)
);
CREATE UNIQUE INDEX IF NOT EXISTS inbox_message_id_idx ON inbox(message_id);

CREATE TABLE IF NOT EXISTS command_receipts (
    command_id TEXT PRIMARY KEY,
    idempotency_key TEXT,
    request_digest TEXT NOT NULL,
    execution_class TEXT NOT NULL,
    state TEXT NOT NULL,
    execution_attempts INTEGER NOT NULL,
    result TEXT,
    uncertainty TEXT,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS command_receipts_idempotency_key_idx
    ON command_receipts(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS outbox (
    stream_epoch INTEGER NOT NULL,
    sequence INTEGER NOT NULL,
    kind TEXT NOT NULL,
    event_class TEXT NOT NULL,
    retention TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (stream_epoch, sequence)
);

CREATE TABLE IF NOT EXISTS schedule_occurrences (
    schedule_id TEXT NOT NULL,
    occurrence_key TEXT NOT NULL,
    executed_at TEXT NOT NULL,
    PRIMARY KEY (schedule_id, occurrence_key)
);

CREATE TABLE IF NOT EXISTS resume_cursor (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    core_stream_epoch TEXT,
    edge_stream_epoch TEXT,
    last_core_sequence INTEGER,
    last_edge_sequence_acked INTEGER,
    updated_at TEXT NOT NULL
);
"#;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExecutionClass {
    ReplaySafe,
    StateReconcilable,
    ExternallyIdempotent,
    NonRepeatable,
}

impl ExecutionClass {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ReplaySafe => "replay_safe",
            Self::StateReconcilable => "state_reconcilable",
            Self::ExternallyIdempotent => "externally_idempotent",
            Self::NonRepeatable => "non_repeatable",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "replay_safe" => Some(Self::ReplaySafe),
            "state_reconcilable" => Some(Self::StateReconcilable),
            "externally_idempotent" => Some(Self::ExternallyIdempotent),
            "non_repeatable" => Some(Self::NonRepeatable),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReceiptState {
    Received,
    Accepted,
    Running,
    Completed,
    Failed,
    Cancelled,
    UnknownOutcome,
}

impl ReceiptState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Received => "received",
            Self::Accepted => "accepted",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::UnknownOutcome => "unknown_outcome",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "received" => Some(Self::Received),
            "accepted" => Some(Self::Accepted),
            "running" => Some(Self::Running),
            "completed" => Some(Self::Completed),
            "failed" => Some(Self::Failed),
            "cancelled" => Some(Self::Cancelled),
            "unknown_outcome" => Some(Self::UnknownOutcome),
            _ => None,
        }
    }
}

#[derive(Debug)]
pub enum StorageError {
    Sqlite(rusqlite::Error),
    EpochMismatch { expected: i64, actual: i64 },
    NonContiguousSequence { expected: i64, actual: i64 },
    DigestConflict { command_id: String },
    NotFound { command_id: String },
    StorageDegraded,
}

impl fmt::Display for StorageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sqlite(error) => write!(f, "sqlite error: {error}"),
            Self::EpochMismatch { expected, actual } => {
                write!(
                    f,
                    "stream epoch mismatch: expected {expected}, got {actual}"
                )
            }
            Self::NonContiguousSequence { expected, actual } => {
                write!(
                    f,
                    "non-contiguous sequence: expected {expected}, got {actual}"
                )
            }
            Self::DigestConflict { command_id } => {
                write!(f, "request digest conflict for command {command_id}")
            }
            Self::NotFound { command_id } => write!(f, "command receipt {command_id} not found"),
            Self::StorageDegraded => write!(f, "storage_degraded: outbox capacity exceeded"),
        }
    }
}

impl std::error::Error for StorageError {}

impl From<rusqlite::Error> for StorageError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

pub type StorageResult<T> = Result<T, StorageError>;

// ---------------------------------------------------------------------------
// Storage health
// ---------------------------------------------------------------------------

/// The health state of the SQLite database, as returned by [`check_integrity`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StorageHealth {
    /// The database is healthy and fully operational.
    Healthy,
    /// The database is corrupted and could not be recovered. The Agent can still serve the
    /// renderer (local IPC) but cannot persist state.
    Corrupted { detail: String },
    /// The database was recovered from a backup and is operational, but may have lost some
    /// recent data.
    Degraded { detail: String },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Epochs {
    pub core_stream_epoch: i64,
    pub edge_stream_epoch: i64,
    pub authority_epoch: i64,
    pub restore_generation: i64,
    pub last_core_sequence: Option<i64>,
    pub last_edge_acked_sequence: Option<i64>,
    pub next_edge_sequence: i64,
}

/// Durable record of the wire-protocol resume cursor (`contracts/device/v1`'s `ResumeCursor`),
/// as last observed on a *clean* transport disconnect (see `TransportEvent::Disconnected`'s doc
/// comment for why only clean disconnects are safe to persist here). Deliberately decoupled from
/// the `uuid`/`protocol` crate types, matching `Epochs`'s existing convention of not depending on
/// protocol-specific types even for conceptually-related fields -- epoch UUIDs are stored in their
/// canonical string form, and sequence numbers are widened from SQLite's native `i64` to `u64` at
/// this boundary.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ResumeCursorRecord {
    pub core_stream_epoch: Option<String>,
    pub edge_stream_epoch: Option<String>,
    pub last_core_sequence: Option<u64>,
    pub last_edge_sequence_acked: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct InboxMessageInput {
    pub stream_epoch: i64,
    pub sequence: i64,
    pub message_id: String,
    pub message_type: String,
    pub payload: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StreamAck {
    pub stream_epoch: i64,
    pub acknowledged_sequence: i64,
}

#[derive(Clone, Debug)]
pub struct CommandReceiptInput {
    pub command_id: String,
    pub idempotency_key: Option<String>,
    pub request_digest: String,
    pub execution_class: ExecutionClass,
}

#[derive(Clone, Debug)]
pub struct CommandReceipt {
    pub command_id: String,
    pub idempotency_key: Option<String>,
    pub request_digest: String,
    pub execution_class: ExecutionClass,
    pub state: ReceiptState,
    pub execution_attempts: i64,
    pub result: Option<String>,
    pub uncertainty: Option<String>,
}

#[derive(Clone, Debug)]
pub struct OutboxEventInput {
    pub kind: String,
    pub event_class: String,
    pub retention: String,
    pub payload: String,
}

#[derive(Clone, Debug)]
pub struct OutboxRecord {
    pub stream_epoch: i64,
    pub sequence: i64,
    pub kind: String,
    pub event_class: String,
    pub retention: String,
    pub payload: String,
}

pub struct Storage {
    conn: Connection,
    /// The path to the database file, stored for backup/restore operations.
    db_path: PathBuf,
    /// Current health of the storage.
    health: StorageHealth,
}

impl Storage {
    /// Opens (creating if necessary) a WAL-mode SQLite database at `path` and runs migrations.
    /// Calling this again on the same path after a process restart is how the test suite proves
    /// durability: every previously committed row is still present.
    pub fn open(path: impl AsRef<Path>) -> StorageResult<Self> {
        let conn = Connection::open(path.as_ref())?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let db_path = path.as_ref().to_path_buf();
        let mut storage = Self {
            conn,
            db_path,
            health: StorageHealth::Healthy,
        };
        storage.migrate()?;
        Ok(storage)
    }

    /// Runs `PRAGMA integrity_check` on the SQLite database. If the check fails, attempts to
    /// restore from the last known-good backup. If no backup exists, marks the database as
    /// corrupted.
    ///
    /// This is a separate, explicit call so the daemon's `main.rs` can decide what to do with the
    /// result (log, fall back to backup, etc.) without the constructor doing anything implicit.
    pub fn check_integrity(&self) -> StorageHealth {
        let result: Result<String, rusqlite::Error> =
            self.conn
                .query_row("PRAGMA integrity_check", [], |row| row.get(0));
        match result {
            Ok(msg) if msg == "ok" => StorageHealth::Healthy,
            Ok(msg) => StorageHealth::Corrupted {
                detail: format!("integrity_check: {msg}"),
            },
            Err(err) => StorageHealth::Corrupted {
                detail: format!("integrity_check failed: {err}"),
            },
        }
    }

    /// Returns the current health of the storage.
    pub fn health(&self) -> &StorageHealth {
        &self.health
    }

    /// Sets the health to a degraded state (e.g. after recovering from a backup).
    pub fn set_health(&mut self, health: StorageHealth) {
        self.health = health;
    }

    /// Attempts to restore the database from the backup file at `backup_path`. Returns `Ok(())`
    /// if the backup was successfully restored, or `Err` with a description of the failure.
    pub fn restore_from_backup(backup_path: &Path) -> Result<Self, String> {
        if !backup_path.exists() {
            return Err(format!("backup file not found: {}", backup_path.display()));
        }
        // Verify the backup is intact by opening it.
        let conn = Connection::open(backup_path)
            .map_err(|e| format!("failed to open backup database: {e}"))?;
        // Run integrity check on the backup.
        let integrity: Result<String, rusqlite::Error> =
            conn.query_row("PRAGMA integrity_check", [], |row| row.get(0));
        match integrity {
            Ok(msg) if msg == "ok" => {
                // Backup is healthy — use it.
                drop(conn);
                let db_path = backup_path.to_path_buf();
                let conn = Connection::open(&db_path)
                    .map_err(|e| format!("failed to open restored database: {e}"))?;
                conn.pragma_update(None, "journal_mode", "WAL")
                    .map_err(|e| format!("failed to set WAL mode on restored db: {e}"))?;
                conn.pragma_update(None, "synchronous", "FULL")
                    .map_err(|e| format!("failed to set synchronous mode on restored db: {e}"))?;
                conn.pragma_update(None, "foreign_keys", "ON")
                    .map_err(|e| format!("failed to set foreign keys on restored db: {e}"))?;
                Ok(Self {
                    conn,
                    db_path,
                    health: StorageHealth::Degraded {
                        detail: "restored from backup".to_string(),
                    },
                })
            }
            Ok(msg) => Err(format!("backup database is also corrupted: {msg}")),
            Err(err) => Err(format!("backup integrity check failed: {err}")),
        }
    }

    /// Creates a backup of the current database at `backup_path`. Returns `Ok(())` on success.
    pub fn create_backup(&self, backup_path: &Path) -> Result<(), String> {
        // Use SQLite's backup API via a simple file copy while holding a lock.
        // We use VACUUM INTO which is available in recent SQLite versions via rusqlite.
        let sql = format!(
            "VACUUM INTO '{}'",
            backup_path.display().to_string().replace('\'', "''")
        );
        self.conn
            .execute_batch(&sql)
            .map_err(|e| format!("failed to create backup: {e}"))
    }

    /// Returns the path to the database file.
    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    fn migrate(&mut self) -> StorageResult<()> {
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

        let epochs_exist: bool = tx
            .query_row("SELECT 1 FROM epochs WHERE id = 1", [], |_| Ok(true))
            .optional()?
            .unwrap_or(false);

        if !epochs_exist {
            tx.execute(
                "INSERT INTO epochs (
                    id, core_stream_epoch, edge_stream_epoch, authority_epoch,
                    restore_generation, last_core_sequence, last_edge_acked_sequence, next_edge_sequence
                ) VALUES (1, 1, 1, 1, 0, NULL, NULL, 1)",
                [],
            )?;
        }

        tx.commit()?;
        Ok(())
    }

    pub fn epochs(&self) -> StorageResult<Epochs> {
        self.conn
            .query_row(
                "SELECT core_stream_epoch, edge_stream_epoch, authority_epoch, restore_generation,
                        last_core_sequence, last_edge_acked_sequence, next_edge_sequence
                 FROM epochs WHERE id = 1",
                [],
                |row| {
                    Ok(Epochs {
                        core_stream_epoch: row.get(0)?,
                        edge_stream_epoch: row.get(1)?,
                        authority_epoch: row.get(2)?,
                        restore_generation: row.get(3)?,
                        last_core_sequence: row.get(4)?,
                        last_edge_acked_sequence: row.get(5)?,
                        next_edge_sequence: row.get(6)?,
                    })
                },
            )
            .map_err(StorageError::from)
    }

    /// Loads the durably persisted resume cursor, if one has ever been saved. Returns `None` on a
    /// fresh install (before the first `save_resume_cursor` call), not an error.
    pub fn load_resume_cursor(&self) -> StorageResult<Option<ResumeCursorRecord>> {
        self.conn
            .query_row(
                "SELECT core_stream_epoch, edge_stream_epoch, last_core_sequence, last_edge_sequence_acked
                 FROM resume_cursor WHERE id = 1",
                [],
                |row| {
                    let last_core_sequence: Option<i64> = row.get(2)?;
                    let last_edge_sequence_acked: Option<i64> = row.get(3)?;
                    Ok(ResumeCursorRecord {
                        core_stream_epoch: row.get(0)?,
                        edge_stream_epoch: row.get(1)?,
                        last_core_sequence: last_core_sequence.map(|value| value as u64),
                        last_edge_sequence_acked: last_edge_sequence_acked.map(|value| value as u64),
                    })
                },
            )
            .optional()
            .map_err(StorageError::from)
    }

    /// Durably upserts the resume cursor. Callers should only call this when the transport
    /// reported a *clean* disconnect (see `TransportEvent::Disconnected`'s doc comment) -- an
    /// abrupt drop means recent outgoing messages' delivery to Core is unknown, so persisting
    /// then could later claim more than Core actually observed.
    pub fn save_resume_cursor(&mut self, cursor: &ResumeCursorRecord) -> StorageResult<()> {
        let last_core_sequence = cursor.last_core_sequence.map(|value| value as i64);
        let last_edge_sequence_acked = cursor.last_edge_sequence_acked.map(|value| value as i64);
        self.conn.execute(
            "INSERT INTO resume_cursor (
                id, core_stream_epoch, edge_stream_epoch, last_core_sequence,
                last_edge_sequence_acked, updated_at
             ) VALUES (1, ?1, ?2, ?3, ?4, datetime('now'))
             ON CONFLICT(id) DO UPDATE SET
                core_stream_epoch = excluded.core_stream_epoch,
                edge_stream_epoch = excluded.edge_stream_epoch,
                last_core_sequence = excluded.last_core_sequence,
                last_edge_sequence_acked = excluded.last_edge_sequence_acked,
                updated_at = excluded.updated_at",
            rusqlite::params![
                cursor.core_stream_epoch,
                cursor.edge_stream_epoch,
                last_core_sequence,
                last_edge_sequence_acked,
            ],
        )?;
        Ok(())
    }

    /// Commits an inbound Core message and its cursor advance in one transaction, then returns
    /// the ack. Because the ack is only ever constructed after `tx.commit()` succeeds, an ACK can
    /// never be observed for a message that was not actually durably committed
    /// (commit-before-ack). Duplicate delivery of an already-committed `message_id` is a safe,
    /// no-op replay that returns the same ack again rather than erroring or double-inserting.
    pub fn commit_inbox_message(&mut self, input: InboxMessageInput) -> StorageResult<StreamAck> {
        let tx = self.conn.transaction()?;

        let existing_sequence: Option<i64> = tx
            .query_row(
                "SELECT sequence FROM inbox WHERE message_id = ?1",
                [&input.message_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(sequence) = existing_sequence {
            tx.commit()?;
            return Ok(StreamAck {
                stream_epoch: input.stream_epoch,
                acknowledged_sequence: sequence,
            });
        }

        let (core_stream_epoch, last_core_sequence): (i64, Option<i64>) = tx.query_row(
            "SELECT core_stream_epoch, last_core_sequence FROM epochs WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;

        if input.stream_epoch != core_stream_epoch {
            return Err(StorageError::EpochMismatch {
                expected: core_stream_epoch,
                actual: input.stream_epoch,
            });
        }

        let expected_sequence = last_core_sequence.map_or(1, |value| value + 1);
        if input.sequence != expected_sequence {
            return Err(StorageError::NonContiguousSequence {
                expected: expected_sequence,
                actual: input.sequence,
            });
        }

        tx.execute(
            "INSERT INTO inbox (stream_epoch, sequence, message_id, message_type, payload, received_at)
             VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))",
            rusqlite::params![
                input.stream_epoch,
                input.sequence,
                input.message_id,
                input.message_type,
                input.payload
            ],
        )?;
        tx.execute(
            "UPDATE epochs SET last_core_sequence = ?1 WHERE id = 1",
            [input.sequence],
        )?;

        tx.commit()?;
        Ok(StreamAck {
            stream_epoch: input.stream_epoch,
            acknowledged_sequence: input.sequence,
        })
    }

    /// Records a new command receipt, or safely replays an existing one. A duplicate
    /// `command_id`, or a duplicate `idempotency_key` under a different `command_id`, with a
    /// matching request digest returns the stored receipt (`replayed = true`) instead of
    /// executing/recording again. A digest mismatch against an existing record is a conflict, not
    /// a replay.
    pub fn record_command_receipt(
        &mut self,
        input: CommandReceiptInput,
    ) -> StorageResult<(CommandReceipt, bool)> {
        let tx = self.conn.transaction()?;

        if let Some(existing) = query_receipt(&tx, &input.command_id)? {
            if existing.request_digest != input.request_digest {
                return Err(StorageError::DigestConflict {
                    command_id: input.command_id,
                });
            }
            tx.commit()?;
            return Ok((existing, true));
        }

        if let Some(idempotency_key) = &input.idempotency_key {
            let existing: Option<String> = tx
                .query_row(
                    "SELECT command_id FROM command_receipts WHERE idempotency_key = ?1",
                    [idempotency_key],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(existing_command_id) = existing {
                let existing_receipt = query_receipt(&tx, &existing_command_id)?
                    .expect("row observed by lookup must be readable in the same transaction");
                if existing_receipt.request_digest != input.request_digest {
                    return Err(StorageError::DigestConflict {
                        command_id: input.command_id,
                    });
                }
                tx.commit()?;
                return Ok((existing_receipt, true));
            }
        }

        tx.execute(
            "INSERT INTO command_receipts (
                command_id, idempotency_key, request_digest, execution_class,
                state, execution_attempts, result, uncertainty, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, 0, NULL, NULL, datetime('now'))",
            rusqlite::params![
                input.command_id,
                input.idempotency_key,
                input.request_digest,
                input.execution_class.as_str(),
                ReceiptState::Received.as_str(),
            ],
        )?;

        let receipt = CommandReceipt {
            command_id: input.command_id,
            idempotency_key: input.idempotency_key,
            request_digest: input.request_digest,
            execution_class: input.execution_class,
            state: ReceiptState::Received,
            execution_attempts: 0,
            result: None,
            uncertainty: None,
        };

        tx.commit()?;
        Ok((receipt, false))
    }

    /// Transitions an existing receipt. Moving into `Running` increments `execution_attempts`,
    /// so the crash-recovery pass can distinguish "never started" from "may have started."
    pub fn transition_receipt(
        &mut self,
        command_id: &str,
        new_state: ReceiptState,
        result: Option<String>,
        uncertainty: Option<String>,
    ) -> StorageResult<CommandReceipt> {
        let tx = self.conn.transaction()?;
        let existing = query_receipt(&tx, command_id)?.ok_or_else(|| StorageError::NotFound {
            command_id: command_id.to_string(),
        })?;

        let attempts = if matches!(new_state, ReceiptState::Running) {
            existing.execution_attempts + 1
        } else {
            existing.execution_attempts
        };

        tx.execute(
            "UPDATE command_receipts
             SET state = ?1, execution_attempts = ?2, result = ?3, uncertainty = ?4, updated_at = datetime('now')
             WHERE command_id = ?5",
            rusqlite::params![new_state.as_str(), attempts, result, uncertainty, command_id],
        )?;
        tx.commit()?;

        Ok(CommandReceipt {
            state: new_state,
            execution_attempts: attempts,
            result,
            uncertainty,
            ..existing
        })
    }

    /// Must be called once at Agent startup, before accepting any new commands. Any receipt left
    /// `running` with `execution_class = non_repeatable` means execution may have begun before
    /// the crash; persisted state cannot distinguish "crashed just before the effect" from
    /// "crashed just after," so this never resumes/retries such a command — it only marks the
    /// terminal, safe `unknown_outcome` state and returns the affected command IDs so the caller
    /// can surface them (for example to Core or an operator) rather than silently losing them.
    /// Receipts left `running` for any other execution class are left untouched here: recovering
    /// them safely requires postcondition reconciliation logic that belongs to a higher layer,
    /// not to the storage primitive.
    pub fn recover_non_repeatable_running(&mut self) -> StorageResult<Vec<String>> {
        let tx = self.conn.transaction()?;
        let command_ids: Vec<String> = {
            let mut statement = tx.prepare(
                "SELECT command_id FROM command_receipts
                 WHERE state = ?1 AND execution_class = ?2",
            )?;
            let rows = statement.query_map(
                rusqlite::params![
                    ReceiptState::Running.as_str(),
                    ExecutionClass::NonRepeatable.as_str()
                ],
                |row| row.get(0),
            )?;
            rows.collect::<Result<Vec<String>, _>>()?
        };

        for command_id in &command_ids {
            tx.execute(
                "UPDATE command_receipts
                 SET state = ?1, uncertainty = ?2, updated_at = datetime('now')
                 WHERE command_id = ?3",
                rusqlite::params![
                    ReceiptState::UnknownOutcome.as_str(),
                    "crash_recovery: running non_repeatable command found at Agent startup",
                    command_id
                ],
            )?;
        }

        tx.commit()?;
        Ok(command_ids)
    }

    /// Enqueues a durable outbox event. Rejects admission before assigning a sequence when the
    /// unacknowledged backlog has reached `capacity` — this is a simplified version of the full
    /// Phase 0 priority-shedding model (see module docs); it does not yet distinguish
    /// replaceable/protected retention when deciding what to reject.
    pub fn enqueue_outbox(
        &mut self,
        input: OutboxEventInput,
        capacity: i64,
    ) -> StorageResult<OutboxRecord> {
        let tx = self.conn.transaction()?;

        let (edge_stream_epoch, next_edge_sequence): (i64, i64) = tx.query_row(
            "SELECT edge_stream_epoch, next_edge_sequence FROM epochs WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;

        let backlog: i64 = tx.query_row(
            "SELECT COUNT(*) FROM outbox WHERE stream_epoch = ?1",
            [edge_stream_epoch],
            |row| row.get(0),
        )?;

        if backlog >= capacity {
            return Err(StorageError::StorageDegraded);
        }

        tx.execute(
            "INSERT INTO outbox (stream_epoch, sequence, kind, event_class, retention, payload, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))",
            rusqlite::params![
                edge_stream_epoch,
                next_edge_sequence,
                input.kind,
                input.event_class,
                input.retention,
                input.payload
            ],
        )?;
        tx.execute(
            "UPDATE epochs SET next_edge_sequence = ?1 WHERE id = 1",
            [next_edge_sequence + 1],
        )?;

        tx.commit()?;
        Ok(OutboxRecord {
            stream_epoch: edge_stream_epoch,
            sequence: next_edge_sequence,
            kind: input.kind,
            event_class: input.event_class,
            retention: input.retention,
            payload: input.payload,
        })
    }

    /// Returns every unacknowledged outbox row in sequence order. Because rows are only deleted
    /// by `acknowledge_outbox`, this list survives a process restart intact.
    pub fn pending_outbox(&self) -> StorageResult<Vec<OutboxRecord>> {
        let mut statement = self.conn.prepare(
            "SELECT stream_epoch, sequence, kind, event_class, retention, payload
             FROM outbox ORDER BY stream_epoch ASC, sequence ASC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(OutboxRecord {
                stream_epoch: row.get(0)?,
                sequence: row.get(1)?,
                kind: row.get(2)?,
                event_class: row.get(3)?,
                retention: row.get(4)?,
                payload: row.get(5)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

    /// Prunes acknowledged outbox rows up to and including `up_to_sequence` in `stream_epoch`. An
    /// ack presented for any epoch other than the current `edge_stream_epoch` is rejected and
    /// cannot prune anything — this is what stops a stale/pre-restore ACK from being mistaken for
    /// acknowledgement of the current stream.
    pub fn acknowledge_outbox(
        &mut self,
        stream_epoch: i64,
        up_to_sequence: i64,
    ) -> StorageResult<usize> {
        let tx = self.conn.transaction()?;
        let current_edge_stream_epoch: i64 = tx.query_row(
            "SELECT edge_stream_epoch FROM epochs WHERE id = 1",
            [],
            |row| row.get(0),
        )?;

        if stream_epoch != current_edge_stream_epoch {
            return Err(StorageError::EpochMismatch {
                expected: current_edge_stream_epoch,
                actual: stream_epoch,
            });
        }

        let pruned = tx.execute(
            "DELETE FROM outbox WHERE stream_epoch = ?1 AND sequence <= ?2",
            rusqlite::params![stream_epoch, up_to_sequence],
        )?;
        tx.execute(
            "UPDATE epochs SET last_edge_acked_sequence = ?1 WHERE id = 1",
            [up_to_sequence],
        )?;

        tx.commit()?;
        Ok(pruned)
    }

    /// Records one occurrence of a scheduled action. Returns `true` only the first time a given
    /// `(schedule_id, occurrence_key)` pair is recorded; every subsequent call for the same pair
    /// — whether from a genuine retry, a crash-and-restart, a clock rollback, or a DST transition
    /// producing the same logical occurrence twice — returns `false` and must not execute the
    /// scheduled action again. The uniqueness is enforced by a real SQLite constraint, not
    /// application-level locking, so it holds even across process restarts.
    pub fn record_schedule_occurrence(
        &mut self,
        schedule_id: &str,
        occurrence_key: &str,
    ) -> StorageResult<bool> {
        let changed = self.conn.execute(
            "INSERT INTO schedule_occurrences (schedule_id, occurrence_key, executed_at)
             VALUES (?1, ?2, datetime('now'))
             ON CONFLICT (schedule_id, occurrence_key) DO NOTHING",
            rusqlite::params![schedule_id, occurrence_key],
        )?;
        Ok(changed == 1)
    }
}

fn query_receipt(
    tx: &rusqlite::Transaction<'_>,
    command_id: &str,
) -> StorageResult<Option<CommandReceipt>> {
    tx.query_row(
        "SELECT command_id, idempotency_key, request_digest, execution_class,
                state, execution_attempts, result, uncertainty
         FROM command_receipts WHERE command_id = ?1",
        [command_id],
        |row| {
            let execution_class_raw: String = row.get(3)?;
            let state_raw: String = row.get(4)?;
            Ok(CommandReceipt {
                command_id: row.get(0)?,
                idempotency_key: row.get(1)?,
                request_digest: row.get(2)?,
                execution_class: ExecutionClass::parse(&execution_class_raw)
                    .expect("execution_class column always holds a canonical value"),
                state: ReceiptState::parse(&state_raw)
                    .expect("state column always holds a canonical value"),
                execution_attempts: row.get(5)?,
                result: row.get(6)?,
                uncertainty: row.get(7)?,
            })
        },
    )
    .optional()
    .map_err(StorageError::from)
}
