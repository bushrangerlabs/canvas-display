//! Phase 1 executable evidence for the real SQLite-backed durable storage layer
//! (`canvas_edge_agent::storage`). "Process restart" here means literally dropping the
//! `Storage` handle (which closes the SQLite connection) and reopening the same file path —
//! not constructing a new in-memory object, unlike the Phase 0 TypeScript model.

use canvas_edge_agent::storage::{
    CommandReceiptInput, ExecutionClass, InboxMessageInput, OutboxEventInput, ReceiptState,
    ResumeCursorRecord, Storage, StorageError,
};
use tempfile::tempdir;

fn expect_storage_degraded<T: std::fmt::Debug>(result: Result<T, StorageError>) {
    match result {
        Err(StorageError::StorageDegraded) => {}
        other => panic!("expected StorageDegraded, got {other:?}"),
    }
}

#[test]
fn migrations_apply_once_and_are_idempotent_across_reopen() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("agent.sqlite3");

    {
        let storage = Storage::open(&db_path).expect("first open runs migrations");
        let epochs = storage.epochs().expect("epochs singleton exists");
        assert_eq!(epochs.core_stream_epoch, 1);
        assert_eq!(epochs.restore_generation, 0);
    }

    // Reopening the same file must not fail, duplicate the migration, or reset the singleton row.
    let storage = Storage::open(&db_path).expect("second open is idempotent");
    let epochs = storage.epochs().expect("epochs still present after reopen");
    assert_eq!(epochs.core_stream_epoch, 1);
}

#[test]
fn inbox_commit_is_ack_after_commit_and_survives_restart() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("agent.sqlite3");

    {
        let mut storage = Storage::open(&db_path).expect("open");
        let ack = storage
            .commit_inbox_message(InboxMessageInput {
                stream_epoch: 1,
                sequence: 1,
                message_id: "msg-1".to_string(),
                message_type: "desired_state".to_string(),
                payload: "{}".to_string(),
            })
            .expect("first message commits");
        assert_eq!(ack.acknowledged_sequence, 1);

        // Non-contiguous sequence is rejected before any state changes.
        let rejected = storage.commit_inbox_message(InboxMessageInput {
            stream_epoch: 1,
            sequence: 3,
            message_id: "msg-3".to_string(),
            message_type: "desired_state".to_string(),
            payload: "{}".to_string(),
        });
        assert!(matches!(
            rejected,
            Err(StorageError::NonContiguousSequence {
                expected: 2,
                actual: 3
            })
        ));

        // Duplicate delivery of the same message_id is a safe no-op replay, not an error.
        let replay_ack = storage
            .commit_inbox_message(InboxMessageInput {
                stream_epoch: 1,
                sequence: 1,
                message_id: "msg-1".to_string(),
                message_type: "desired_state".to_string(),
                payload: "{}".to_string(),
            })
            .expect("duplicate message_id replays safely");
        assert_eq!(replay_ack.acknowledged_sequence, 1);

        let epochs = storage.epochs().expect("epochs readable");
        assert_eq!(epochs.last_core_sequence, Some(1));
    }

    // Simulate a process restart: drop and reopen the same database file.
    let mut storage = Storage::open(&db_path).expect("reopen after restart");
    let epochs = storage.epochs().expect("epochs survived restart");
    assert_eq!(epochs.last_core_sequence, Some(1));

    // The cursor correctly continues from the durably committed sequence.
    let ack = storage
        .commit_inbox_message(InboxMessageInput {
            stream_epoch: 1,
            sequence: 2,
            message_id: "msg-2".to_string(),
            message_type: "desired_state".to_string(),
            payload: "{}".to_string(),
        })
        .expect("contiguous message after restart commits");
    assert_eq!(ack.acknowledged_sequence, 2);
}

#[test]
fn inbox_commit_rejects_wrong_stream_epoch() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("agent.sqlite3");
    let mut storage = Storage::open(&db_path).expect("open");

    let result = storage.commit_inbox_message(InboxMessageInput {
        stream_epoch: 99,
        sequence: 1,
        message_id: "msg-wrong-epoch".to_string(),
        message_type: "desired_state".to_string(),
        payload: "{}".to_string(),
    });
    assert!(matches!(
        result,
        Err(StorageError::EpochMismatch {
            expected: 1,
            actual: 99
        })
    ));
}

#[test]
fn command_receipts_are_replay_safe_by_command_id_and_idempotency_key() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("agent.sqlite3");
    let mut storage = Storage::open(&db_path).expect("open");

    let input = CommandReceiptInput {
        command_id: "cmd-1".to_string(),
        idempotency_key: Some("idem-1".to_string()),
        request_digest: "sha256:aaaa".to_string(),
        execution_class: ExecutionClass::ReplaySafe,
    };

    let (first, replayed_first) = storage
        .record_command_receipt(input.clone())
        .expect("first record succeeds");
    assert!(!replayed_first);
    assert_eq!(first.state, ReceiptState::Received);

    // Same command_id again, same digest: replay, not a new row / not an error.
    let (second, replayed_second) = storage
        .record_command_receipt(input.clone())
        .expect("duplicate command_id replays");
    assert!(replayed_second);
    assert_eq!(second.command_id, first.command_id);

    // Different command_id, same idempotency_key, same digest: also replays the original.
    let (third, replayed_third) = storage
        .record_command_receipt(CommandReceiptInput {
            command_id: "cmd-1-retry".to_string(),
            idempotency_key: Some("idem-1".to_string()),
            request_digest: "sha256:aaaa".to_string(),
            execution_class: ExecutionClass::ReplaySafe,
        })
        .expect("duplicate idempotency_key replays");
    assert!(replayed_third);
    assert_eq!(third.command_id, "cmd-1");

    // Same idempotency_key, different digest: conflict, not a silent replay.
    let conflict = storage.record_command_receipt(CommandReceiptInput {
        command_id: "cmd-1-conflict".to_string(),
        idempotency_key: Some("idem-1".to_string()),
        request_digest: "sha256:bbbb".to_string(),
        execution_class: ExecutionClass::ReplaySafe,
    });
    assert!(matches!(conflict, Err(StorageError::DigestConflict { .. })));
}

#[test]
fn non_repeatable_running_receipts_recover_as_unknown_outcome_across_restart() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("agent.sqlite3");

    {
        let mut storage = Storage::open(&db_path).expect("open");
        let (receipt, _) = storage
            .record_command_receipt(CommandReceiptInput {
                command_id: "reboot-1".to_string(),
                idempotency_key: None,
                request_digest: "sha256:cccc".to_string(),
                execution_class: ExecutionClass::NonRepeatable,
            })
            .expect("receipt recorded");
        assert_eq!(receipt.execution_attempts, 0);

        // Move to running -- this is the durable marker written before the (simulated) external
        // effect. The process then "crashes" here: we simply drop `storage` without ever
        // transitioning to a terminal state.
        let running = storage
            .transition_receipt("reboot-1", ReceiptState::Running, None, None)
            .expect("transition to running");
        assert_eq!(running.state, ReceiptState::Running);
        assert_eq!(running.execution_attempts, 1);

        // A replay-safe command left running is a different story: recovery must not touch it.
        storage
            .record_command_receipt(CommandReceiptInput {
                command_id: "replay-safe-1".to_string(),
                idempotency_key: None,
                request_digest: "sha256:dddd".to_string(),
                execution_class: ExecutionClass::ReplaySafe,
            })
            .expect("second receipt recorded");
        storage
            .transition_receipt("replay-safe-1", ReceiptState::Running, None, None)
            .expect("second transition to running");
    }

    // Simulate the Agent restarting after the crash and running its mandatory startup recovery.
    let mut storage = Storage::open(&db_path).expect("reopen after crash");
    let recovered = storage
        .recover_non_repeatable_running()
        .expect("recovery pass runs");
    assert_eq!(recovered, vec!["reboot-1".to_string()]);

    // Idempotent: running it again finds nothing left to recover.
    let recovered_again = storage
        .recover_non_repeatable_running()
        .expect("recovery pass is idempotent");
    assert!(recovered_again.is_empty());

    // The non-repeatable command's receipt is now a terminal, safe unknown_outcome -- never
    // silently retried.
    let receipt = storage
        .transition_receipt(
            "reboot-1",
            ReceiptState::UnknownOutcome,
            None,
            Some("noop".to_string()),
        )
        .expect("receipt exists and can be re-transitioned by the caller (idempotent no-op path)");
    assert_eq!(receipt.state, ReceiptState::UnknownOutcome);

    // The replay-safe command was left untouched by the recovery pass -- still `running`, free
    // for a higher layer to decide whether/how to retry it.
    let (still_running, replayed) = storage
        .record_command_receipt(CommandReceiptInput {
            command_id: "replay-safe-1".to_string(),
            idempotency_key: None,
            request_digest: "sha256:dddd".to_string(),
            execution_class: ExecutionClass::ReplaySafe,
        })
        .expect("lookup via record_command_receipt");
    assert!(replayed);
    assert_eq!(still_running.state, ReceiptState::Running);
}

#[test]
fn outbox_events_survive_restart_until_acknowledged_and_reject_stale_epoch_acks() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("agent.sqlite3");

    {
        let mut storage = Storage::open(&db_path).expect("open");
        storage
            .enqueue_outbox(
                OutboxEventInput {
                    kind: "reported_state".to_string(),
                    event_class: "state".to_string(),
                    retention: "protected".to_string(),
                    payload: "{\"brightness\":80}".to_string(),
                },
                100,
            )
            .expect("first event enqueued");
        storage
            .enqueue_outbox(
                OutboxEventInput {
                    kind: "reported_state".to_string(),
                    event_class: "state".to_string(),
                    retention: "protected".to_string(),
                    payload: "{\"brightness\":90}".to_string(),
                },
                100,
            )
            .expect("second event enqueued");

        let pending = storage.pending_outbox().expect("pending readable");
        assert_eq!(pending.len(), 2);
    }

    // Simulate restart: unacknowledged events are still present.
    let mut storage = Storage::open(&db_path).expect("reopen after restart");
    let pending = storage.pending_outbox().expect("pending survives restart");
    assert_eq!(pending.len(), 2);

    // An ack for the wrong stream epoch is rejected and prunes nothing.
    let stale_ack = storage.acknowledge_outbox(999, pending[1].sequence);
    assert!(matches!(stale_ack, Err(StorageError::EpochMismatch { .. })));
    assert_eq!(storage.pending_outbox().expect("still 2 pending").len(), 2);

    // A correct-epoch ack prunes exactly the acknowledged prefix.
    let pruned = storage
        .acknowledge_outbox(pending[0].stream_epoch, pending[0].sequence)
        .expect("valid ack prunes");
    assert_eq!(pruned, 1);
    let remaining = storage.pending_outbox().expect("one event remains");
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].sequence, pending[1].sequence);
}

#[test]
fn outbox_enqueue_is_rejected_once_capacity_is_reached() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("agent.sqlite3");
    let mut storage = Storage::open(&db_path).expect("open");

    for i in 0..3 {
        storage
            .enqueue_outbox(
                OutboxEventInput {
                    kind: "telemetry".to_string(),
                    event_class: "telemetry".to_string(),
                    retention: "replaceable".to_string(),
                    payload: format!("{{\"i\":{i}}}"),
                },
                3,
            )
            .expect("under capacity enqueue succeeds");
    }

    let rejected = storage.enqueue_outbox(
        OutboxEventInput {
            kind: "telemetry".to_string(),
            event_class: "telemetry".to_string(),
            retention: "replaceable".to_string(),
            payload: "{\"i\":3}".to_string(),
        },
        3,
    );
    expect_storage_degraded(rejected);
}

#[test]
fn schedule_occurrences_execute_at_most_once_even_across_restart() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("agent.sqlite3");

    {
        let mut storage = Storage::open(&db_path).expect("open");
        let first = storage
            .record_schedule_occurrence("morning-lights", "2026-07-19T07:00:00Z")
            .expect("first record succeeds");
        assert!(first, "first occurrence must be reported as newly executed");

        // A genuine retry (e.g. crash immediately after recording, before the action's own
        // side effect confirmed) must not be allowed to execute the same occurrence twice.
        let duplicate = storage
            .record_schedule_occurrence("morning-lights", "2026-07-19T07:00:00Z")
            .expect("second record succeeds without error");
        assert!(
            !duplicate,
            "duplicate occurrence must not be reported as newly executed"
        );
    }

    // Simulate a crash/restart exactly at this point (e.g. clock rollback replaying the same
    // wall-clock trigger, or a DST transition producing the same nominal local time twice).
    let mut storage = Storage::open(&db_path).expect("reopen after restart");
    let after_restart = storage
        .record_schedule_occurrence("morning-lights", "2026-07-19T07:00:00Z")
        .expect("record succeeds after restart");
    assert!(
        !after_restart,
        "the same occurrence key must still be rejected after a restart"
    );

    // A genuinely different occurrence (the next day) is allowed.
    let next_day = storage
        .record_schedule_occurrence("morning-lights", "2026-07-20T07:00:00Z")
        .expect("distinct occurrence succeeds");
    assert!(next_day);
}

#[test]
fn resume_cursor_round_trips_and_survives_restart() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("agent.sqlite3");

    {
        let storage = Storage::open(&db_path).expect("open");
        let loaded = storage
            .load_resume_cursor()
            .expect("load succeeds on a fresh install");
        assert!(
            loaded.is_none(),
            "a fresh install must have no persisted resume cursor"
        );
    }

    let record = ResumeCursorRecord {
        core_stream_epoch: Some("6ba7b810-9dad-11d1-80b4-00c04fd430c8".to_string()),
        edge_stream_epoch: Some("6ba7b811-9dad-11d1-80b4-00c04fd430c8".to_string()),
        last_core_sequence: Some(42),
        last_edge_sequence_acked: Some(7),
    };

    {
        let mut storage = Storage::open(&db_path).expect("reopen");
        storage
            .save_resume_cursor(&record)
            .expect("first save succeeds");
        let loaded = storage
            .load_resume_cursor()
            .expect("load succeeds")
            .expect("a saved cursor is present");
        assert_eq!(loaded, record);
    }

    // Simulate a process restart: drop and reopen the same database file.
    let mut storage = Storage::open(&db_path).expect("reopen after restart");
    let loaded = storage
        .load_resume_cursor()
        .expect("load succeeds after restart")
        .expect("the saved cursor survived the restart");
    assert_eq!(loaded, record);

    // Saving again is an upsert, not a second row: the latest values win.
    let updated = ResumeCursorRecord {
        core_stream_epoch: record.core_stream_epoch.clone(),
        edge_stream_epoch: record.edge_stream_epoch.clone(),
        last_core_sequence: Some(43),
        last_edge_sequence_acked: Some(8),
    };
    storage
        .save_resume_cursor(&updated)
        .expect("second save upserts");
    let loaded_again = storage
        .load_resume_cursor()
        .expect("load succeeds")
        .expect("the updated cursor is present");
    assert_eq!(loaded_again, updated);
}
