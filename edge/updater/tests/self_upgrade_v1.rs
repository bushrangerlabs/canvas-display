//! Phase 1 executable evidence for the updater's OWN self-upgrade path
//! (`canvas_edge_updater::self_upgrade`), reusing the generic two-slot journal and the shared
//! rollout/rollback logic from `rollout.rs`.
//!
//! These tests prove that the self-upgrade case is a real, distinct capability from the
//! Agent-package rollout: it uses a SEPARATE `InstallJournal` instance (a different SQLite file),
//! a distinct `installed_root`, and a distinct `active_binary_path` (the `canvas-edge-updaterd`
//! binary). The Agent-package tests in `rollout_v1.rs` / `journal_v1.rs` are untouched and remain
//! the source of truth for that subject.
//!
//! As with the other updater tests, real temporary directories/files are used throughout -- nothing
//! here mocks the filesystem.

use std::fs;
use std::path::PathBuf;

use canvas_edge_updater::journal::{InstallJournal, Slot, SlotStatus};
use canvas_edge_updater::manifest::{
    Architecture, ReleaseManifest, ReleaseTrustRoot, SignedReleaseManifest,
    SignedRollbackAuthorization,
};
use canvas_edge_updater::rollout::{default_health_check, perform_rollback, RolloutOutcome};
use canvas_edge_updater::self_upgrade::{
    perform_self_upgrade_rollout, recover_self_upgrade, run_demo_self_upgrade,
};
use chrono::{Duration, Utc};
use ed25519_dalek::SigningKey;
use sha2::{Digest, Sha256};
use tempfile::tempdir;

fn signing_key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// Writes `bytes` to a new file under `dir` and returns its path -- the local-file stand-in for a
/// "downloadable" candidate artifact.
fn write_artifact(dir: &std::path::Path, name: &str, bytes: &[u8]) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, bytes).expect("write candidate artifact");
    path
}

/// Builds a genuine self-upgrade manifest (product `canvas-edge-updaterd`), signed by `signing_key`.
fn self_upgrade_manifest(
    signing_key: &SigningKey,
    artifact_sha256: &str,
    security_counter: u64,
) -> SignedReleaseManifest {
    let manifest = ReleaseManifest {
        product: "canvas-edge-updaterd".to_string(),
        version: format!("self-{security_counter}"),
        architecture: Architecture::Amd64,
        protocol_min: 0,
        protocol_max: u32::MAX,
        artifact_url: "file:///dev/null".to_string(),
        artifact_size_bytes: 0,
        artifact_sha256: artifact_sha256.to_string(),
        required_disk_bytes: 1,
        rollback_compatible_versions: vec![],
        channel: "stable".to_string(),
        health_check_timeout_secs: 120,
        security_counter,
        schema_min: 0,
        schema_max: u64::MAX,
    };
    SignedReleaseManifest::sign(manifest, signing_key)
}

/// Opens a fresh, independent self-upgrade journal at `db_path` (a different file from the
/// Agent-package journal).
fn open_self_journal(db_path: &std::path::Path) -> InstallJournal {
    InstallJournal::open(db_path).expect("open self-upgrade journal")
}

// -- A self-upgrade manifest with a different `product` passes evaluate_candidate ----------------

#[test]
fn self_upgrade_manifest_with_different_product_passes_evaluation() {
    // Confirms the finding: evaluate_candidate does NOT gate on `product`, so a self-upgrade
    // manifest (product = "canvas-edge-updaterd") with matching architecture/protocol/schema and a
    // higher security counter is accepted exactly like an Agent-package manifest.
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("self.sqlite3");
    let installed_root = dir.path().join("installed-self");
    let mut journal = open_self_journal(&db_path);

    let signing_key = signing_key(1);
    let trust_root = ReleaseTrustRoot::new(signing_key.verifying_key());

    let artifact_bytes = b"canvas-edge-updaterd new binary";
    let manifest = self_upgrade_manifest(&signing_key, &sha256_hex(artifact_bytes), 10);
    let artifact_path = write_artifact(dir.path(), "self.bin", artifact_bytes);

    let outcome = perform_self_upgrade_rollout(
        &mut journal,
        &trust_root,
        &manifest,
        artifact_path
            .to_str()
            .expect("artifact path is valid UTF-8"),
        &installed_root,
        5, // installed_security_counter, lower than candidate's 10: a normal upgrade
        Architecture::Amd64,
        0,
        0,
        None,
        Utc::now(),
        default_health_check,
        None,
    )
    .expect("self-upgrade rollout succeeds");

    assert_eq!(
        outcome,
        RolloutOutcome::CommittedKnownGood { slot: Slot::A }
    );
    assert_eq!(journal.active_slot().expect("active"), Some(Slot::A));
    assert_eq!(
        journal.slot_info(Slot::A).expect("slot a").status,
        SlotStatus::KnownGood
    );
    // The installed artifact lives under the self-upgrade installed_root, isolated from the
    // Agent-package installed_root.
    let installed_path = installed_root.join("a").join("artifact");
    assert_eq!(fs::read(&installed_path).expect("bytes"), artifact_bytes);
}

// -- A self-upgrade rollout commits known-good into the updater's own journal and flips active ---

#[test]
fn self_upgrade_rollout_commits_known_good_and_flips_active_slot() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("self.sqlite3");
    let installed_root = dir.path().join("installed-self");
    let mut journal = open_self_journal(&db_path);

    let signing_key = signing_key(7);
    let trust_root = ReleaseTrustRoot::new(signing_key.verifying_key());

    let artifact_bytes = b"updaterd v2 binary";
    let manifest = self_upgrade_manifest(&signing_key, &sha256_hex(artifact_bytes), 3);
    let artifact_path = write_artifact(dir.path(), "self.bin", artifact_bytes);

    let outcome = perform_self_upgrade_rollout(
        &mut journal,
        &trust_root,
        &manifest,
        artifact_path
            .to_str()
            .expect("artifact path is valid UTF-8"),
        &installed_root,
        0,
        Architecture::Amd64,
        0,
        0,
        None,
        Utc::now(),
        default_health_check,
        None,
    )
    .expect("self-upgrade rollout succeeds");

    assert_eq!(
        outcome,
        RolloutOutcome::CommittedKnownGood { slot: Slot::A }
    );
    assert_eq!(journal.active_slot().expect("active"), Some(Slot::A));
    assert_eq!(journal.candidate_slot().expect("candidate cleared"), None);

    let slot_info = journal.slot_info(Slot::A).expect("slot a");
    assert_eq!(slot_info.status, SlotStatus::KnownGood);
    assert_eq!(slot_info.version.as_deref(), Some("self-3"));
    assert_eq!(slot_info.security_counter, Some(3));
    assert!(slot_info.health_check_passed);
}

// -- A second self-upgrade stages into the opposite slot (reusing journal logic) ------------------

#[test]
fn second_self_upgrade_stages_into_opposite_slot() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("self.sqlite3");
    let installed_root = dir.path().join("installed-self");

    let signing_key = signing_key(1);
    let trust_root = ReleaseTrustRoot::new(signing_key.verifying_key());

    let first_bytes = b"updaterd v1";
    let first = self_upgrade_manifest(&signing_key, &sha256_hex(first_bytes), 1);
    let first_path = write_artifact(dir.path(), "self1.bin", first_bytes);
    {
        let mut journal = open_self_journal(&db_path);
        perform_self_upgrade_rollout(
            &mut journal,
            &trust_root,
            &first,
            first_path.to_str().expect("path"),
            &installed_root,
            0,
            Architecture::Amd64,
            0,
            0,
            None,
            Utc::now(),
            default_health_check,
            None,
        )
        .expect("first self-upgrade succeeds");
    }

    // Second self-upgrade: higher counter, opposite slot (B).
    let second_bytes = b"updaterd v2";
    let second = self_upgrade_manifest(&signing_key, &sha256_hex(second_bytes), 2);
    let second_path = write_artifact(dir.path(), "self2.bin", second_bytes);
    {
        let mut journal = open_self_journal(&db_path);
        let outcome = perform_self_upgrade_rollout(
            &mut journal,
            &trust_root,
            &second,
            second_path.to_str().expect("path"),
            &installed_root,
            1,
            Architecture::Amd64,
            0,
            0,
            None,
            Utc::now(),
            default_health_check,
            None,
        )
        .expect("second self-upgrade succeeds");
        assert_eq!(
            outcome,
            RolloutOutcome::CommittedKnownGood { slot: Slot::B }
        );
        assert_eq!(journal.active_slot().expect("active now B"), Some(Slot::B));
    }
}

// -- A self-upgrade rollback swaps the updater's active_binary_path to the known-good slot -------

/// Builds a self-upgrade journal with two known-good slots: A is the original updater binary, B is
/// a newer (broken) updater binary that became active. Returns (journal, installed_root).
fn self_journal_with_known_good_and_bad_candidate(
    dir: &std::path::Path,
    good_bytes: &[u8],
    bad_bytes: &[u8],
) -> (InstallJournal, PathBuf) {
    let db_path = dir.join("self.sqlite3");
    let installed_root = dir.join("installed-self");

    let signing_key = signing_key(1);
    let trust_root = ReleaseTrustRoot::new(signing_key.verifying_key());

    // Known-good updater binary into slot A.
    let good_path = write_artifact(dir, "good.bin", good_bytes);
    let good = self_upgrade_manifest(&signing_key, &sha256_hex(good_bytes), 1);
    {
        let mut journal = open_self_journal(&db_path);
        perform_self_upgrade_rollout(
            &mut journal,
            &trust_root,
            &good,
            good_path.to_str().expect("path"),
            &installed_root,
            0,
            Architecture::Amd64,
            0,
            0,
            None,
            Utc::now(),
            default_health_check,
            None,
        )
        .expect("known-good self-upgrade succeeds");
    }

    // A broken newer updater binary into slot B (committed known-good too, so it becomes active).
    let bad_path = write_artifact(dir, "bad.bin", bad_bytes);
    let bad_manifest = ReleaseManifest {
        product: "canvas-edge-updaterd".to_string(),
        version: "self-2".to_string(),
        architecture: Architecture::Amd64,
        protocol_min: 0,
        protocol_max: u32::MAX,
        artifact_url: "file:///dev/null".to_string(),
        artifact_size_bytes: 0,
        artifact_sha256: sha256_hex(bad_bytes),
        required_disk_bytes: 1,
        rollback_compatible_versions: vec![],
        channel: "stable".to_string(),
        health_check_timeout_secs: 120,
        security_counter: 2,
        schema_min: 0,
        schema_max: u64::MAX,
    };
    let bad = SignedReleaseManifest::sign(bad_manifest, &signing_key);
    {
        let mut journal = open_self_journal(&db_path);
        perform_self_upgrade_rollout(
            &mut journal,
            &trust_root,
            &bad,
            bad_path.to_str().expect("path"),
            &installed_root,
            1,
            Architecture::Amd64,
            0,
            0,
            None,
            Utc::now(),
            default_health_check,
            None,
        )
        .expect("bad candidate self-upgrade succeeds");
    }

    let journal = open_self_journal(&db_path);
    (journal, installed_root)
}

#[test]
fn self_upgrade_rollback_swaps_updater_binary_to_known_good_slot() {
    let dir = tempdir().expect("tempdir");
    let (mut journal, installed_root) = self_journal_with_known_good_and_bad_candidate(
        dir.path(),
        b"known-good updaterd binary",
        b"broken updaterd binary",
    );

    // The broken candidate is now active (slot B). The live updater binary currently holds bad bytes.
    assert_eq!(journal.active_slot().expect("active"), Some(Slot::B));
    let active_binary = dir.path().join("canvas-edge-updaterd");
    fs::write(&active_binary, b"broken updaterd binary").expect("seed live updater binary");

    // Use the shared perform_rollback (the same one the Agent path uses) against the self journal.
    let target = perform_rollback(&mut journal, &installed_root, &active_binary)
        .expect("self-upgrade rollback swaps the live updater binary");
    assert_eq!(target, Slot::A);

    // The live updater binary now holds the known-good bytes, and the previous (bad) binary is
    // preserved as `.previous`. This is exactly the Agent-package swap behavior, just on the
    // updater's own binary path.
    assert_eq!(
        fs::read(&active_binary).expect("live updater binary readable"),
        b"known-good updaterd binary"
    );
    assert_eq!(
        fs::read(active_binary.with_extension("previous")).expect("previous preserved"),
        b"broken updaterd binary"
    );
    assert_eq!(journal.active_slot().expect("active now A"), Some(Slot::A));
}

// -- A crash-loop on the updater's own journal recommends RollBack; recovery is idempotent --------

#[test]
fn self_upgrade_crash_loop_recommends_rollback_and_recovery_is_idempotent() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("self.sqlite3");
    let installed_root = dir.path().join("installed-self");
    let active_binary = dir.path().join("canvas-edge-updaterd");

    // Bootstrap: A is known-good/active so there is a valid rollback target for the updater's own
    // journal.
    {
        let mut journal = open_self_journal(&db_path);
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

        // Stage B as the new self-upgrade candidate; it will crash-loop and never reach known-good.
        journal
            .stage_candidate(Slot::B, "2.0.0".to_string(), 2, "sha256:bbbb".to_string())
            .expect("stage b");
        journal.mark_installing(Slot::B).expect("installing b");
        journal.mark_installed(Slot::B).expect("installed b");
    }

    // Repeatedly "boot" B across real close/reopen cycles without ever passing its health check --
    // a genuine crash loop on the updater's OWN journal.
    let mut final_action = None;
    for attempt in 1..=(canvas_edge_updater::journal::MAX_BOOT_ATTEMPTS_BEFORE_ROLLBACK + 2) {
        let mut journal = open_self_journal(&db_path);
        let count = journal
            .record_boot_attempt(Slot::B)
            .expect("record boot attempt");
        assert_eq!(count, attempt);
        drop(journal);

        let mut journal = open_self_journal(&db_path);
        let action = journal.recover_on_startup().expect("recover_on_startup");

        if attempt <= canvas_edge_updater::journal::MAX_BOOT_ATTEMPTS_BEFORE_ROLLBACK {
            assert_eq!(
                action,
                canvas_edge_updater::journal::RecoveryAction::RollForward(Slot::B),
                "attempt {attempt} is still within the crash-loop budget"
            );
        } else {
            final_action = Some(action);
            break;
        }
    }

    assert_eq!(
        final_action,
        Some(canvas_edge_updater::journal::RecoveryAction::RollBack(
            Slot::B
        ))
    );

    // `active_slot` never moved away from A (pre-commit crash loop), and B is durably Failed.
    let mut journal = open_self_journal(&db_path);
    assert_eq!(journal.active_slot().expect("active"), Some(Slot::A));
    assert_eq!(journal.candidate_slot().expect("candidate cleared"), None);
    assert!(matches!(
        journal.slot_info(Slot::B).expect("slot b").status,
        SlotStatus::Failed { .. }
    ));

    // `recover_self_upgrade` is idempotent: a repeated call returns Nothing (the candidate was
    // already abandoned), and because there is no prior known-good binary to restore (pre-commit
    // crash loop), it does not attempt a binary swap.
    let action = recover_self_upgrade(&mut journal, &installed_root, &active_binary)
        .expect("recover_self_upgrade idempotent call");
    assert_eq!(
        action,
        canvas_edge_updater::journal::RecoveryAction::Nothing
    );
    // The live updater binary is untouched (no swap happened).
    assert!(!active_binary.exists() || fs::read(&active_binary).is_err());
}

// -- The demo self-upgrade helper exercises the real self-upgrade path end-to-end ----------------

#[test]
fn demo_self_upgrade_runs_against_own_journal() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("self.sqlite3");
    let mut journal = open_self_journal(&db_path);

    let outcome = run_demo_self_upgrade(dir.path(), &mut journal).expect("demo self-upgrade runs");
    assert_eq!(
        outcome,
        RolloutOutcome::CommittedKnownGood { slot: Slot::A }
    );
    assert_eq!(journal.active_slot().expect("active"), Some(Slot::A));

    // The demo installed the updater's own artifact under the self installed_root.
    let installed_path = dir.path().join("installed-self").join("a").join("artifact");
    assert!(
        installed_path.exists(),
        "demo self-upgrade wrote an artifact"
    );
}

// -- Anti-downgrade still applies to self-upgrade manifests (a lower counter is rejected) --------

#[test]
fn self_upgrade_downgrade_without_authorization_is_rejected() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("self.sqlite3");
    let installed_root = dir.path().join("installed-self");
    let mut journal = open_self_journal(&db_path);

    let signing_key = signing_key(1);
    let trust_root = ReleaseTrustRoot::new(signing_key.verifying_key());

    // Currently installed counter is 10; candidate counter 9 is a downgrade and must be rejected
    // before the journal is touched.
    let artifact_bytes = b"older updaterd binary";
    let manifest = self_upgrade_manifest(&signing_key, &sha256_hex(artifact_bytes), 9);
    let artifact_path = write_artifact(dir.path(), "self.bin", artifact_bytes);

    let err = perform_self_upgrade_rollout(
        &mut journal,
        &trust_root,
        &manifest,
        artifact_path
            .to_str()
            .expect("artifact path is valid UTF-8"),
        &installed_root,
        10, // installed_security_counter higher than candidate's 9
        Architecture::Amd64,
        0,
        0,
        None,
        Utc::now(),
        default_health_check,
        None,
    )
    .expect_err("downgrade without authorization must be rejected");

    assert!(matches!(
        err,
        canvas_edge_updater::rollout::RolloutError::CandidateRejected(
            canvas_edge_updater::manifest::RejectionReason::DowngradeWithoutAuthorization { .. }
        )
    ));
    // The journal was never touched.
    assert_eq!(journal.active_slot().expect("active"), None);
    assert_eq!(journal.candidate_slot().expect("candidate"), None);
}

// -- A signed rollback authorization permits a self-upgrade downgrade ----------------------------

#[test]
fn self_upgrade_downgrade_with_valid_rollback_authorization_is_accepted() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("self.sqlite3");
    let installed_root = dir.path().join("installed-self");
    let mut journal = open_self_journal(&db_path);

    let signing_key = signing_key(1);
    let trust_root = ReleaseTrustRoot::new(signing_key.verifying_key());

    // Candidate counter 9, installed counter 10: a downgrade, excused by a signed authorization.
    let artifact_bytes = b"authorized older updaterd binary";
    let manifest = self_upgrade_manifest(&signing_key, &sha256_hex(artifact_bytes), 9);
    let artifact_path = write_artifact(dir.path(), "self.bin", artifact_bytes);

    let authorization = canvas_edge_updater::manifest::RollbackAuthorization {
        product: "canvas-edge-updaterd".to_string(),
        authorized_security_counter: 9,
        reason: "emergency downgrade of updater".to_string(),
        expires_at: Utc::now() + Duration::days(1),
    };
    let signed_authorization = SignedRollbackAuthorization::sign(authorization, &signing_key);

    let outcome = perform_self_upgrade_rollout(
        &mut journal,
        &trust_root,
        &manifest,
        artifact_path
            .to_str()
            .expect("artifact path is valid UTF-8"),
        &installed_root,
        10,
        Architecture::Amd64,
        0,
        0,
        Some(&signed_authorization),
        Utc::now(),
        default_health_check,
        None,
    )
    .expect("authorized downgrade self-upgrade succeeds");

    assert_eq!(
        outcome,
        RolloutOutcome::CommittedKnownGood { slot: Slot::A }
    );
    assert_eq!(journal.active_slot().expect("active"), Some(Slot::A));
}
