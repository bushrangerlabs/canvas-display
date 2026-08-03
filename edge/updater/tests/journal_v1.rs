//! Phase 1 executable evidence for the durable SQLite-backed install journal
//! (`canvas_edge_updater::journal`). "Process restart" here means literally dropping the
//! `InstallJournal` handle (which closes the SQLite connection) and reopening the same file
//! path -- not constructing a new in-memory object, mirroring
//! `edge/agent/tests/storage_v1.rs`'s convention exactly.
//!
//! Scope note: this only exercises the Agent-package two-slot case end-to-end, per this
//! module's own doc comments -- the updater's own self-upgrade is documented future reuse of
//! the same schema, not tested here.

use canvas_edge_updater::journal::{
    InstallJournal, JournalError, RecoveryAction, Slot, SlotStatus,
    MAX_BOOT_ATTEMPTS_BEFORE_ROLLBACK,
};
use tempfile::tempdir;

#[test]
fn migrations_apply_once_and_are_idempotent_across_reopen() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("journal.sqlite3");

    {
        let journal = InstallJournal::open(&db_path).expect("first open runs migrations");
        assert_eq!(journal.active_slot().expect("active_slot"), None);
        assert_eq!(journal.candidate_slot().expect("candidate_slot"), None);
        let a = journal.slot_info(Slot::A).expect("slot a exists");
        assert_eq!(a.status, SlotStatus::Empty);
        let b = journal.slot_info(Slot::B).expect("slot b exists");
        assert_eq!(b.status, SlotStatus::Empty);
    }

    // Reopening the same file must not fail, duplicate the migration, or reset the singleton
    // rows.
    let journal = InstallJournal::open(&db_path).expect("second open is idempotent");
    assert_eq!(journal.active_slot().expect("active_slot survives"), None);
    assert_eq!(
        journal.slot_info(Slot::A).expect("slot a survives").status,
        SlotStatus::Empty
    );
}

#[test]
fn full_happy_path_rollout_then_recovery_reports_nothing() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("journal.sqlite3");

    {
        let mut journal = InstallJournal::open(&db_path).expect("open");

        journal
            .stage_candidate(Slot::A, "1.0.0".to_string(), 10, "sha256:aaaa".to_string())
            .expect("stage candidate into empty, non-active slot");
        assert_eq!(journal.candidate_slot().expect("candidate"), Some(Slot::A));

        journal
            .mark_installing(Slot::A)
            .expect("staged -> installing");
        journal
            .mark_installed(Slot::A)
            .expect("installing -> installed");

        let attempts = journal
            .record_boot_attempt(Slot::A)
            .expect("first boot attempt");
        assert_eq!(attempts, 1);
        assert_eq!(
            journal.slot_info(Slot::A).expect("slot a").status,
            SlotStatus::HealthChecking
        );

        journal
            .record_health_check_result(Slot::A, true)
            .expect("health check passes");

        journal
            .commit_known_good(Slot::A)
            .expect("commit known-good");

        assert_eq!(journal.active_slot().expect("active"), Some(Slot::A));
        assert_eq!(journal.candidate_slot().expect("candidate cleared"), None);
        assert_eq!(
            journal.slot_info(Slot::A).expect("slot a").status,
            SlotStatus::KnownGood
        );
    }

    // Simulate a process restart: drop and reopen the same database file.
    let mut journal = InstallJournal::open(&db_path).expect("reopen after restart");
    assert_eq!(
        journal.active_slot().expect("active survives"),
        Some(Slot::A)
    );

    let action = journal
        .recover_on_startup()
        .expect("recovery runs after clean commit");
    assert_eq!(action, RecoveryAction::Nothing);

    // Idempotent: running it again still finds nothing to do.
    let action_again = journal
        .recover_on_startup()
        .expect("recovery is idempotent");
    assert_eq!(action_again, RecoveryAction::Nothing);
}

#[test]
fn second_rollout_retains_prior_known_good_as_rollback_target() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("journal.sqlite3");
    let mut journal = InstallJournal::open(&db_path).expect("open");

    // First rollout: A becomes known-good/active.
    journal
        .stage_candidate(Slot::A, "1.0.0".to_string(), 10, "sha256:aaaa".to_string())
        .expect("stage a");
    journal.mark_installing(Slot::A).expect("installing a");
    journal.mark_installed(Slot::A).expect("installed a");
    journal.record_boot_attempt(Slot::A).expect("boot a");
    journal
        .record_health_check_result(Slot::A, true)
        .expect("health check a");
    journal.commit_known_good(Slot::A).expect("commit a");

    // Rolling back before any second rollout has ever started must fail cleanly: there is no
    // other known-good slot yet.
    let err = journal
        .rollback_to_known_good()
        .expect_err("no prior known-good slot exists yet");
    assert!(matches!(err, JournalError::NoKnownGoodSlot));

    // Second rollout: B becomes known-good/active; A must remain untouched as the retained
    // rollback target.
    journal
        .stage_candidate(Slot::B, "2.0.0".to_string(), 20, "sha256:bbbb".to_string())
        .expect("stage b into the non-active slot");
    journal.mark_installing(Slot::B).expect("installing b");
    journal.mark_installed(Slot::B).expect("installed b");
    journal.record_boot_attempt(Slot::B).expect("boot b");
    journal
        .record_health_check_result(Slot::B, true)
        .expect("health check b");
    journal.commit_known_good(Slot::B).expect("commit b");

    assert_eq!(journal.active_slot().expect("active"), Some(Slot::B));
    assert_eq!(
        journal.slot_info(Slot::A).expect("a untouched").status,
        SlotStatus::KnownGood
    );

    // Now a rollback correctly restores A's real recorded version/hash.
    let restored = journal
        .rollback_to_known_good()
        .expect("rollback to prior known-good slot a");
    assert_eq!(restored.slot, Slot::A);
    assert_eq!(restored.version.as_deref(), Some("1.0.0"));
    assert_eq!(restored.security_counter, Some(10));
    assert_eq!(restored.artifact_sha256.as_deref(), Some("sha256:aaaa"));
    assert_eq!(
        journal.active_slot().expect("active flipped back"),
        Some(Slot::A)
    );
    assert_eq!(journal.rollback_count().expect("rollback recorded"), 1);
}

#[test]
fn crash_between_mark_installed_and_commit_known_good_is_never_silently_active() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("journal.sqlite3");

    {
        let mut journal = InstallJournal::open(&db_path).expect("open");
        journal
            .stage_candidate(Slot::A, "1.0.0".to_string(), 1, "sha256:aaaa".to_string())
            .expect("stage");
        journal.mark_installing(Slot::A).expect("installing");
        journal.mark_installed(Slot::A).expect("installed");
        // Simulated crash: process dies here, before any boot attempt/health check/commit is
        // ever recorded. `journal` is dropped without another call.
    }

    let mut journal = InstallJournal::open(&db_path).expect("reopen after crash");
    // The candidate must never be silently reported as active.
    assert_eq!(journal.active_slot().expect("active"), None);

    let action = journal
        .recover_on_startup()
        .expect("recovery runs after interrupted install");
    assert!(
        matches!(
            action,
            RecoveryAction::RollForward(Slot::A) | RecoveryAction::RollBack(Slot::A)
        ),
        "expected a conservative recommendation, got {action:?}"
    );

    // `RollForward` is a non-terminal, side-effect-free recommendation: with no other state
    // change, calling recovery again yields the same answer rather than silently flipping to
    // success.
    let action_again = journal
        .recover_on_startup()
        .expect("recovery is deterministic");
    assert_eq!(action_again, action);
}

#[test]
fn crash_after_boot_and_health_check_but_before_commit_recommends_recovery_not_success() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("journal.sqlite3");

    {
        let mut journal = InstallJournal::open(&db_path).expect("open");
        journal
            .stage_candidate(Slot::A, "1.0.0".to_string(), 1, "sha256:aaaa".to_string())
            .expect("stage");
        journal.mark_installing(Slot::A).expect("installing");
        journal.mark_installed(Slot::A).expect("installed");
        journal.record_boot_attempt(Slot::A).expect("boot attempt");
        journal
            .record_health_check_result(Slot::A, true)
            .expect("health check passes");
        // Simulated crash: process dies here, before `commit_known_good` is ever called.
    }

    let mut journal = InstallJournal::open(&db_path).expect("reopen after crash");
    assert_eq!(journal.active_slot().expect("active"), None);

    let action = journal
        .recover_on_startup()
        .expect("recovery runs after uncommitted health-checked candidate");
    assert!(
        matches!(
            action,
            RecoveryAction::RollForward(Slot::A) | RecoveryAction::RollBack(Slot::A)
        ),
        "an uncommitted health-checked candidate must never be silently treated as success, got {action:?}"
    );
}

#[test]
fn crash_loop_across_repeated_restarts_eventually_recommends_rollback() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("journal.sqlite3");

    // Bootstrap: A is known-good/active so there is a valid rollback target.
    {
        let mut journal = InstallJournal::open(&db_path).expect("open");
        journal
            .stage_candidate(Slot::A, "1.0.0".to_string(), 1, "sha256:aaaa".to_string())
            .expect("stage a");
        journal.mark_installing(Slot::A).expect("installing a");
        journal.mark_installed(Slot::A).expect("installed a");
        journal.record_boot_attempt(Slot::A).expect("boot a");
        journal
            .record_health_check_result(Slot::A, true)
            .expect("health check a");
        journal.commit_known_good(Slot::A).expect("commit a");

        // Stage B as the new candidate; it will crash-loop and never reach known-good.
        journal
            .stage_candidate(Slot::B, "2.0.0".to_string(), 2, "sha256:bbbb".to_string())
            .expect("stage b");
        journal.mark_installing(Slot::B).expect("installing b");
        journal.mark_installed(Slot::B).expect("installed b");
    }

    // Repeatedly "boot" B across real close/reopen cycles without ever passing its health
    // check -- a genuine crash loop. Confirm recovery keeps recommending a retry (`RollForward`)
    // while within the crash-loop budget, then flips to a terminal rollback recommendation
    // (`RollBack`) once `MAX_BOOT_ATTEMPTS_BEFORE_ROLLBACK` is exceeded.
    let mut final_action = None;
    for attempt in 1..=(MAX_BOOT_ATTEMPTS_BEFORE_ROLLBACK + 2) {
        let mut journal = InstallJournal::open(&db_path).expect("reopen for crash-loop cycle");
        let count = journal
            .record_boot_attempt(Slot::B)
            .expect("record boot attempt");
        assert_eq!(count, attempt);
        // The candidate never gets a passing health check before "crashing" again.
        drop(journal);

        let mut journal = InstallJournal::open(&db_path).expect("reopen to recover");
        let action = journal.recover_on_startup().expect("recover_on_startup");

        if attempt <= MAX_BOOT_ATTEMPTS_BEFORE_ROLLBACK {
            assert_eq!(
                action,
                RecoveryAction::RollForward(Slot::B),
                "attempt {attempt} is still within the crash-loop budget"
            );
        } else {
            final_action = Some(action);
            break;
        }
    }

    assert_eq!(final_action, Some(RecoveryAction::RollBack(Slot::B)));

    // Because `commit_known_good` was never reached for B, `active_slot` never moved away from
    // A in the first place -- there is nothing to "restore": A kept running the whole time. The
    // recovery decision durably abandoned B (marked `Failed`, no longer tracked as candidate),
    // which is exactly what `RecoveryAction::RollBack` promises for a pre-commit crash loop.
    let mut journal = InstallJournal::open(&db_path).expect("reopen to confirm final state");
    assert_eq!(journal.active_slot().expect("active"), Some(Slot::A));
    assert_eq!(journal.candidate_slot().expect("candidate cleared"), None);
    assert!(matches!(
        journal.slot_info(Slot::B).expect("slot b").status,
        SlotStatus::Failed { .. }
    ));

    // `recover_on_startup` remains idempotent: nothing further is recommended.
    assert_eq!(
        journal.recover_on_startup().expect("recover_on_startup"),
        RecoveryAction::Nothing
    );
}

#[test]
fn rollback_with_no_known_good_slot_fails_cleanly() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("journal.sqlite3");
    let mut journal = InstallJournal::open(&db_path).expect("open");

    // Nothing has ever been installed at all.
    let err = journal
        .rollback_to_known_good()
        .expect_err("no active slot at all yet");
    assert!(matches!(err, JournalError::NoKnownGoodSlot));
}

#[test]
fn staging_into_active_slot_is_rejected() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("journal.sqlite3");
    let mut journal = InstallJournal::open(&db_path).expect("open");

    journal
        .stage_candidate(Slot::A, "1.0.0".to_string(), 1, "sha256:aaaa".to_string())
        .expect("stage a");
    journal.mark_installing(Slot::A).expect("installing a");
    journal.mark_installed(Slot::A).expect("installed a");
    journal.record_boot_attempt(Slot::A).expect("boot a");
    journal
        .record_health_check_result(Slot::A, true)
        .expect("health check a");
    journal.commit_known_good(Slot::A).expect("commit a");

    let err = journal
        .stage_candidate(Slot::A, "1.0.1".to_string(), 2, "sha256:cccc".to_string())
        .expect_err("cannot stage into the currently active slot");
    assert!(matches!(err, JournalError::SlotIsActive { slot: Slot::A }));
}

#[test]
fn staging_while_another_candidate_is_unresolved_is_rejected() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("journal.sqlite3");
    let mut journal = InstallJournal::open(&db_path).expect("open");

    journal
        .stage_candidate(Slot::A, "1.0.0".to_string(), 1, "sha256:aaaa".to_string())
        .expect("stage a");
    journal.mark_installing(Slot::A).expect("installing a");
    journal.mark_installed(Slot::A).expect("installed a");
    journal.record_boot_attempt(Slot::A).expect("boot a");
    journal
        .record_health_check_result(Slot::A, true)
        .expect("health check a");
    journal.commit_known_good(Slot::A).expect("commit a");

    // Start staging B as the candidate, but don't resolve it yet.
    journal
        .stage_candidate(Slot::B, "2.0.0".to_string(), 2, "sha256:bbbb".to_string())
        .expect("stage b");

    // Re-staging the same in-progress candidate slot is allowed (idempotent overwrite)...
    journal
        .stage_candidate(Slot::B, "2.0.1".to_string(), 3, "sha256:dddd".to_string())
        .expect("re-staging the same candidate slot is allowed");

    // ...but there is no third slot to stage a genuinely different candidate into while B is
    // unresolved. Attempting to stage into the active slot A remains rejected for its own
    // reason (still active), which itself demonstrates that a second concurrent candidate
    // cannot be introduced through the other slot either.
    let err = journal
        .stage_candidate(Slot::A, "1.0.1".to_string(), 4, "sha256:eeee".to_string())
        .expect_err("a is still active");
    assert!(matches!(err, JournalError::SlotIsActive { slot: Slot::A }));
}

#[test]
fn invalid_transitions_are_rejected_without_panicking() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("journal.sqlite3");
    let mut journal = InstallJournal::open(&db_path).expect("open");

    // Cannot mark an empty slot as installing without staging it first.
    let err = journal
        .mark_installing(Slot::A)
        .expect_err("empty slot cannot go straight to installing");
    assert!(matches!(
        err,
        JournalError::NotCurrentCandidate { slot: Slot::A }
    ));

    journal
        .stage_candidate(Slot::A, "1.0.0".to_string(), 1, "sha256:aaaa".to_string())
        .expect("stage a");

    // Cannot mark installed before installing.
    let err = journal
        .mark_installed(Slot::A)
        .expect_err("cannot skip installing");
    assert!(matches!(
        err,
        JournalError::InvalidTransition {
            slot: Slot::A,
            from: "staged",
            action: "mark_installed"
        }
    ));

    // Cannot commit known-good before any health check has ever passed.
    let err = journal
        .commit_known_good(Slot::A)
        .expect_err("never health-checked");
    assert!(matches!(
        err,
        JournalError::NotEligibleForCommit { slot: Slot::A }
    ));

    // Cannot record a health check result before the slot is even installed.
    let err = journal
        .record_health_check_result(Slot::A, true)
        .expect_err("not installed yet");
    assert!(matches!(
        err,
        JournalError::InvalidTransition {
            slot: Slot::A,
            from: "staged",
            action: "record_health_check_result"
        }
    ));
}

#[test]
fn failed_health_check_alone_does_not_flip_status_to_failed() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("journal.sqlite3");
    let mut journal = InstallJournal::open(&db_path).expect("open");

    journal
        .stage_candidate(Slot::A, "1.0.0".to_string(), 1, "sha256:aaaa".to_string())
        .expect("stage a");
    journal.mark_installing(Slot::A).expect("installing a");
    journal.mark_installed(Slot::A).expect("installed a");
    journal.record_boot_attempt(Slot::A).expect("boot a");

    journal
        .record_health_check_result(Slot::A, false)
        .expect("a single failed health check is recorded, not fatal");

    let info = journal.slot_info(Slot::A).expect("slot a info");
    assert_eq!(info.status, SlotStatus::HealthChecking);
    assert!(!info.health_check_passed);

    // A subsequent passing health check still allows commit.
    journal
        .record_health_check_result(Slot::A, true)
        .expect("retry health check passes");
    journal
        .commit_known_good(Slot::A)
        .expect("commit succeeds after an eventual passing health check");
}
