//! Phase 1 executable evidence for `canvas_edge_updater::rollout::perform_rollout`: the real
//! end-to-end wiring between `manifest` verification/anti-downgrade evaluation and the durable
//! `journal` state machine. See module docs in `edge/updater/src/rollout.rs` for the honestly
//! scoped local-file "download" fallback and the real HTTP/TLS download path this exercises for
//! URL-shaped candidate sources.
//!
//! As with `edge/updater/tests/journal_v1.rs`, real temporary directories/files are used
//! throughout -- nothing here mocks the filesystem. The URL-path tests at the bottom use the
//! injectable `FakeHttpClient` so no real network access is required.

use std::fs;
use std::path::PathBuf;

use canvas_edge_updater::fetch::{FakeHttpClient, FakeResponse, FetchError, HttpClient};
use canvas_edge_updater::journal::{InstallJournal, Slot, SlotStatus};
use canvas_edge_updater::manifest::{
    Architecture, ManifestError, ReleaseManifest, ReleaseTrustRoot, RollbackAuthorization,
    SignedReleaseManifest, SignedRollbackAuthorization,
};
use canvas_edge_updater::rollout::{
    default_health_check, perform_rollback, perform_rollout, swap_active_binary, RolloutError,
    RolloutOutcome,
};
use chrono::{Duration, Utc};
use ed25519_dalek::SigningKey;
use sha2::{Digest, Sha256};
use tempfile::tempdir;

fn signing_key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn sample_manifest(artifact_sha256: &str) -> ReleaseManifest {
    ReleaseManifest {
        product: "canvas-edge-agent".to_string(),
        version: "1.4.0".to_string(),
        architecture: Architecture::Amd64,
        protocol_min: 3,
        protocol_max: 7,
        artifact_url: "file:///dev/null".to_string(),
        artifact_size_bytes: 0,
        artifact_sha256: artifact_sha256.to_string(),
        required_disk_bytes: 1,
        rollback_compatible_versions: vec![],
        channel: "stable".to_string(),
        health_check_timeout_secs: 120,
        security_counter: 10,
        schema_min: 5,
        schema_max: 9,
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// Writes `bytes` to a new file under `dir` and returns its path -- the local-file stand-in for
/// a "downloadable" candidate artifact.
fn write_artifact(dir: &std::path::Path, name: &str, bytes: &[u8]) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, bytes).expect("write candidate artifact");
    path
}

// -- Happy path ----------------------------------------------------------------------------------

#[test]
fn full_happy_path_rollout_ends_known_good_and_flips_active_slot() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("journal.sqlite3");
    let installed_root = dir.path().join("installed");
    let mut journal = InstallJournal::open(&db_path).expect("open journal");

    let signing_key = signing_key(1);
    let trust_root = ReleaseTrustRoot::new(signing_key.verifying_key());

    let artifact_bytes = b"real candidate artifact bytes";
    let artifact_path = write_artifact(dir.path(), "candidate.bin", artifact_bytes);
    let manifest = sample_manifest(&sha256_hex(artifact_bytes));
    let signed = SignedReleaseManifest::sign(manifest.clone(), &signing_key);

    let outcome = perform_rollout(
        &mut journal,
        &trust_root,
        &signed,
        artifact_path
            .to_str()
            .expect("artifact path is valid UTF-8"),
        &installed_root,
        5, // installed_security_counter, lower than candidate's 10: a normal upgrade
        Architecture::Amd64,
        5,
        7,
        None,
        Utc::now(),
        default_health_check,
        None, // http_client: local-file path, no HTTP fetch
    )
    .expect("happy path rollout succeeds");

    assert_eq!(
        outcome,
        RolloutOutcome::CommittedKnownGood { slot: Slot::A }
    );
    assert_eq!(journal.active_slot().expect("active"), Some(Slot::A));
    assert_eq!(journal.candidate_slot().expect("candidate cleared"), None);

    let slot_info = journal.slot_info(Slot::A).expect("slot a");
    assert_eq!(slot_info.status, SlotStatus::KnownGood);
    assert_eq!(slot_info.version.as_deref(), Some("1.4.0"));
    assert_eq!(slot_info.security_counter, Some(10));
    assert!(slot_info.health_check_passed);

    let installed_path = installed_root.join("a").join("artifact");
    let installed_bytes = fs::read(&installed_path).expect("installed artifact bytes exist");
    assert_eq!(installed_bytes, artifact_bytes);
}

// -- Rejected by evaluate_candidate: journal never touched ----------------------------------------

#[test]
fn rollout_rejected_by_evaluate_candidate_never_touches_the_journal() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("journal.sqlite3");
    let installed_root = dir.path().join("installed");
    let mut journal = InstallJournal::open(&db_path).expect("open journal");

    let signing_key = signing_key(1);
    let trust_root = ReleaseTrustRoot::new(signing_key.verifying_key());

    let artifact_bytes = b"irrelevant, evaluate_candidate rejects before any bytes are read";
    let artifact_path = write_artifact(dir.path(), "candidate.bin", artifact_bytes);
    // Manifest declares Amd64, but the running architecture below is Arm64: architecture
    // mismatch, rejected by evaluate_candidate.
    let manifest = sample_manifest(&sha256_hex(artifact_bytes));
    let signed = SignedReleaseManifest::sign(manifest, &signing_key);

    let result = perform_rollout(
        &mut journal,
        &trust_root,
        &signed,
        artifact_path
            .to_str()
            .expect("artifact path is valid UTF-8"),
        &installed_root,
        5,
        Architecture::Arm64, // mismatch
        5,
        7,
        None,
        Utc::now(),
        default_health_check,
        None, // http_client: local-file path, no HTTP fetch
    );

    assert!(matches!(result, Err(RolloutError::CandidateRejected(_))));

    // The journal must be completely untouched: staging never happened.
    assert_eq!(journal.active_slot().expect("active"), None);
    assert_eq!(journal.candidate_slot().expect("candidate"), None);
    assert_eq!(
        journal.slot_info(Slot::A).expect("slot a").status,
        SlotStatus::Empty
    );
    assert_eq!(
        journal.slot_info(Slot::B).expect("slot b").status,
        SlotStatus::Empty
    );
}

// -- Two independent signing keys: wrong-key manifest rejected before anything else ---------------

#[test]
fn manifest_signed_by_a_different_key_is_rejected_before_anything_else_happens() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("journal.sqlite3");
    let installed_root = dir.path().join("installed");
    let mut journal = InstallJournal::open(&db_path).expect("open journal");

    let real_signing_key = signing_key(1);
    let attacker_signing_key = signing_key(2);
    assert_ne!(
        real_signing_key.verifying_key().to_bytes(),
        attacker_signing_key.verifying_key().to_bytes()
    );
    let trust_root = ReleaseTrustRoot::new(real_signing_key.verifying_key());

    let artifact_bytes = b"irrelevant, signature verification rejects before any bytes are read";
    let artifact_path = write_artifact(dir.path(), "candidate.bin", artifact_bytes);
    let manifest = sample_manifest(&sha256_hex(artifact_bytes));
    // Signed with a different key than the trust root perform_rollout is given.
    let signed = SignedReleaseManifest::sign(manifest, &attacker_signing_key);

    let result = perform_rollout(
        &mut journal,
        &trust_root,
        &signed,
        artifact_path
            .to_str()
            .expect("artifact path is valid UTF-8"),
        &installed_root,
        5,
        Architecture::Amd64,
        5,
        7,
        None,
        Utc::now(),
        default_health_check,
        None, // http_client: local-file path, no HTTP fetch
    );

    assert!(matches!(
        result,
        Err(RolloutError::ManifestVerification(
            ManifestError::SignatureInvalid
        ))
    ));

    assert_eq!(journal.active_slot().expect("active"), None);
    assert_eq!(journal.candidate_slot().expect("candidate"), None);
    assert_eq!(
        journal.slot_info(Slot::A).expect("slot a").status,
        SlotStatus::Empty
    );
}

// -- Artifact bytes do not hash to artifact_sha256 -------------------------------------------------

#[test]
fn artifact_hash_mismatch_is_caught_and_never_reaches_known_good() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("journal.sqlite3");
    let installed_root = dir.path().join("installed");
    let mut journal = InstallJournal::open(&db_path).expect("open journal");

    let signing_key = signing_key(1);
    let trust_root = ReleaseTrustRoot::new(signing_key.verifying_key());

    let declared_bytes = b"what the manifest says the artifact hashes to";
    let actual_bytes = b"but these are the bytes actually at the candidate path (tampered!)";
    let artifact_path = write_artifact(dir.path(), "candidate.bin", actual_bytes);
    // Manifest's artifact_sha256 is computed over declared_bytes, not the bytes actually at
    // artifact_path.
    let manifest = sample_manifest(&sha256_hex(declared_bytes));
    let signed = SignedReleaseManifest::sign(manifest, &signing_key);

    let result = perform_rollout(
        &mut journal,
        &trust_root,
        &signed,
        artifact_path
            .to_str()
            .expect("artifact path is valid UTF-8"),
        &installed_root,
        5,
        Architecture::Amd64,
        5,
        7,
        None,
        Utc::now(),
        default_health_check,
        None, // http_client: local-file path, no HTTP fetch
    );

    match result {
        Err(RolloutError::ArtifactHashMismatch {
            slot,
            expected_sha256,
            actual_sha256,
        }) => {
            assert_eq!(slot, Slot::A);
            assert_eq!(expected_sha256, sha256_hex(declared_bytes));
            assert_eq!(actual_sha256, sha256_hex(actual_bytes));
        }
        other => panic!("expected ArtifactHashMismatch, got {other:?}"),
    }

    // mark_installed was never called: the slot is stuck at Installing, never KnownGood.
    let slot_info = journal.slot_info(Slot::A).expect("slot a");
    assert_eq!(slot_info.status, SlotStatus::Installing);
    assert_eq!(journal.active_slot().expect("active"), None);
    assert_eq!(journal.candidate_slot().expect("candidate"), Some(Slot::A));

    // No installed artifact bytes were ever written.
    assert!(!installed_root.join("a").join("artifact").exists());
}

// -- Health check failure: commit_known_good is never called --------------------------------------

#[test]
fn failing_health_check_never_commits_known_good() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("journal.sqlite3");
    let installed_root = dir.path().join("installed");
    let mut journal = InstallJournal::open(&db_path).expect("open journal");

    let signing_key = signing_key(1);
    let trust_root = ReleaseTrustRoot::new(signing_key.verifying_key());

    let artifact_bytes = b"real bytes that hash correctly, but the health check will fail anyway";
    let artifact_path = write_artifact(dir.path(), "candidate.bin", artifact_bytes);
    let manifest = sample_manifest(&sha256_hex(artifact_bytes));
    let signed = SignedReleaseManifest::sign(manifest, &signing_key);

    let outcome = perform_rollout(
        &mut journal,
        &trust_root,
        &signed,
        artifact_path
            .to_str()
            .expect("artifact path is valid UTF-8"),
        &installed_root,
        5,
        Architecture::Amd64,
        5,
        7,
        None,
        Utc::now(),
        |_installed_path| false, // simulate a failing health check
        None,                    // http_client: local-file path, no HTTP fetch
    )
    .expect("rollout completes, just with a failed health check");

    assert_eq!(outcome, RolloutOutcome::HealthCheckFailed { slot: Slot::A });

    // commit_known_good must never have been called: no active slot, and the candidate slot is
    // stuck in HealthChecking with health_check_passed = false, exactly as
    // InstallJournal::recover_on_startup expects to find it on the next daemon start.
    assert_eq!(journal.active_slot().expect("active"), None);
    assert_eq!(journal.candidate_slot().expect("candidate"), Some(Slot::A));
    let slot_info = journal.slot_info(Slot::A).expect("slot a");
    assert_eq!(slot_info.status, SlotStatus::HealthChecking);
    assert!(!slot_info.health_check_passed);

    // The artifact bytes were still installed to disk (only the health check failed).
    let installed_path = installed_root.join("a").join("artifact");
    assert_eq!(
        fs::read(&installed_path).expect("installed artifact exists"),
        artifact_bytes
    );
}

// -- A downgrade is accepted with a valid rollback authorization, proving the parameter is wired --

#[test]
fn downgrade_with_valid_rollback_authorization_is_accepted() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("journal.sqlite3");
    let installed_root = dir.path().join("installed");
    let mut journal = InstallJournal::open(&db_path).expect("open journal");

    let signing_key = signing_key(1);
    let trust_root = ReleaseTrustRoot::new(signing_key.verifying_key());

    let artifact_bytes = b"downgrade candidate bytes";
    let artifact_path = write_artifact(dir.path(), "candidate.bin", artifact_bytes);
    let manifest = sample_manifest(&sha256_hex(artifact_bytes)); // security_counter = 10

    let authorization = RollbackAuthorization {
        product: manifest.product.clone(),
        authorized_security_counter: 10,
        reason: "known regression, rolling back".to_string(),
        expires_at: Utc::now() + Duration::hours(1),
    };
    let signed_authorization = SignedRollbackAuthorization::sign(authorization, &signing_key);
    let signed = SignedReleaseManifest::sign(manifest, &signing_key);

    let outcome = perform_rollout(
        &mut journal,
        &trust_root,
        &signed,
        artifact_path
            .to_str()
            .expect("artifact path is valid UTF-8"),
        &installed_root,
        20, // installed counter higher than candidate's 10: this is a downgrade
        Architecture::Amd64,
        5,
        7,
        Some(&signed_authorization),
        Utc::now(),
        default_health_check,
        None, // http_client: local-file path, no HTTP fetch
    )
    .expect("downgrade accepted with valid rollback authorization");

    assert_eq!(
        outcome,
        RolloutOutcome::CommittedKnownGood { slot: Slot::A }
    );
}

// -- Second rollout stages into the opposite (non-active) slot -------------------------------------

#[test]
fn second_rollout_stages_into_the_opposite_slot() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("journal.sqlite3");
    let installed_root = dir.path().join("installed");
    let mut journal = InstallJournal::open(&db_path).expect("open journal");

    let signing_key = signing_key(1);
    let trust_root = ReleaseTrustRoot::new(signing_key.verifying_key());

    // First rollout: lands in slot A.
    let first_bytes = b"first release artifact";
    let first_path = write_artifact(dir.path(), "first.bin", first_bytes);
    let mut first_manifest = sample_manifest(&sha256_hex(first_bytes));
    first_manifest.security_counter = 10;
    let first_signed = SignedReleaseManifest::sign(first_manifest, &signing_key);

    let first_outcome = perform_rollout(
        &mut journal,
        &trust_root,
        &first_signed,
        first_path.to_str().expect("artifact path is valid UTF-8"),
        &installed_root,
        1,
        Architecture::Amd64,
        5,
        7,
        None,
        Utc::now(),
        default_health_check,
        None, // http_client: local-file path, no HTTP fetch
    )
    .expect("first rollout succeeds");
    assert_eq!(
        first_outcome,
        RolloutOutcome::CommittedKnownGood { slot: Slot::A }
    );

    // Second rollout: must land in slot B, the non-active slot.
    let second_bytes = b"second release artifact";
    let second_path = write_artifact(dir.path(), "second.bin", second_bytes);
    let mut second_manifest = sample_manifest(&sha256_hex(second_bytes));
    second_manifest.security_counter = 20;
    let second_signed = SignedReleaseManifest::sign(second_manifest, &signing_key);

    let second_outcome = perform_rollout(
        &mut journal,
        &trust_root,
        &second_signed,
        second_path.to_str().expect("artifact path is valid UTF-8"),
        &installed_root,
        10,
        Architecture::Amd64,
        5,
        7,
        None,
        Utc::now(),
        default_health_check,
        None, // http_client: local-file path, no HTTP fetch
    )
    .expect("second rollout succeeds");
    assert_eq!(
        second_outcome,
        RolloutOutcome::CommittedKnownGood { slot: Slot::B }
    );

    assert_eq!(journal.active_slot().expect("active"), Some(Slot::B));
    // Slot A remains untouched/KnownGood as the retained rollback target.
    assert_eq!(
        journal.slot_info(Slot::A).expect("slot a").status,
        SlotStatus::KnownGood
    );
}

// -- URL-path rollout: candidate source is an https:// URL, fetched via the injected fake client --

/// A `sha256_hex` helper that matches `rollout.rs`'s `encode_hex(&Sha256::digest(...))` shape, so
/// the manifest's `artifact_sha256` and the fake HTTP body line up.
fn sha256_hex_digest(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

#[test]
fn url_path_rollout_downloads_via_http_and_commits_known_good() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("journal.sqlite3");
    let installed_root = dir.path().join("installed");
    let mut journal = InstallJournal::open(&db_path).expect("open journal");

    let signing_key = signing_key(1);
    let trust_root = ReleaseTrustRoot::new(signing_key.verifying_key());

    let artifact_bytes = b"artifact bytes fetched over http via the fake client";
    let mut manifest = sample_manifest(&sha256_hex_digest(artifact_bytes));
    manifest.artifact_url =
        "https://releases.example.com/canvas-edge-agent-1.4.0-amd64.deb".to_string();
    let signed = SignedReleaseManifest::sign(manifest, &signing_key);

    let client = FakeHttpClient::new();
    client.enqueue(FakeResponse {
        status: 200,
        outcome: Ok(artifact_bytes.to_vec()),
    });

    let outcome = perform_rollout(
        &mut journal,
        &trust_root,
        &signed,
        "https://releases.example.com/canvas-edge-agent-1.4.0-amd64.deb",
        &installed_root,
        5,
        Architecture::Amd64,
        5,
        7,
        None,
        Utc::now(),
        default_health_check,
        Some(&client as &dyn HttpClient),
    )
    .expect("url-path rollout succeeds");

    assert_eq!(
        outcome,
        RolloutOutcome::CommittedKnownGood { slot: Slot::A }
    );
    assert_eq!(journal.active_slot().expect("active"), Some(Slot::A));

    // The downloaded bytes were installed to the slot directory, exactly as the local-file path
    // does -- proving the URL path produces the same end state.
    let installed_path = installed_root.join("a").join("artifact");
    assert_eq!(
        fs::read(&installed_path).expect("installed artifact exists"),
        artifact_bytes
    );
}

#[test]
fn url_path_rollout_hash_mismatch_leaves_slot_installing_and_writes_no_installed_bytes() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("journal.sqlite3");
    let installed_root = dir.path().join("installed");
    let mut journal = InstallJournal::open(&db_path).expect("open journal");

    let signing_key = signing_key(1);
    let trust_root = ReleaseTrustRoot::new(signing_key.verifying_key());

    let declared_bytes = b"what the manifest says the artifact hashes to";
    let served_bytes = b"but the server served these wrong bytes instead";
    let mut manifest = sample_manifest(&sha256_hex_digest(declared_bytes));
    manifest.artifact_url = "https://releases.example.com/artifact".to_string();
    let signed = SignedReleaseManifest::sign(manifest, &signing_key);

    let client = FakeHttpClient::new();
    client.enqueue(FakeResponse {
        status: 200,
        outcome: Ok(served_bytes.to_vec()),
    });

    let result = perform_rollout(
        &mut journal,
        &trust_root,
        &signed,
        "https://releases.example.com/artifact",
        &installed_root,
        5,
        Architecture::Amd64,
        5,
        7,
        None,
        Utc::now(),
        default_health_check,
        Some(&client as &dyn HttpClient),
    );

    // The URL path reports a hash mismatch as `FetchFailed` wrapping `FetchError::HashMismatch`,
    // preserving the same "slot stuck at Installing, no installed bytes written" contract as the
    // local-file path's `ArtifactHashMismatch` variant.
    match result {
        Err(RolloutError::FetchFailed {
            slot,
            source: FetchError::HashMismatch { .. },
        }) => {
            assert_eq!(slot, Slot::A);
        }
        other => panic!("expected FetchFailed(HashMismatch), got {other:?}"),
    }

    let slot_info = journal.slot_info(Slot::A).expect("slot a");
    assert_eq!(slot_info.status, SlotStatus::Installing);
    assert_eq!(journal.active_slot().expect("active"), None);
    assert!(!installed_root.join("a").join("artifact").exists());
}

#[test]
fn url_path_rollout_retries_then_succeeds() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("journal.sqlite3");
    let installed_root = dir.path().join("installed");
    let mut journal = InstallJournal::open(&db_path).expect("open journal");

    let signing_key = signing_key(1);
    let trust_root = ReleaseTrustRoot::new(signing_key.verifying_key());

    let artifact_bytes = b"artifact bytes that arrive on the second http attempt";
    let mut manifest = sample_manifest(&sha256_hex_digest(artifact_bytes));
    manifest.artifact_url = "https://releases.example.com/artifact".to_string();
    let signed = SignedReleaseManifest::sign(manifest, &signing_key);

    let client = FakeHttpClient::new();
    client
        .enqueue(FakeResponse {
            status: 0,
            outcome: Err("transient network failure".to_string()),
        })
        .enqueue(FakeResponse {
            status: 200,
            outcome: Ok(artifact_bytes.to_vec()),
        });

    let outcome = perform_rollout(
        &mut journal,
        &trust_root,
        &signed,
        "https://releases.example.com/artifact",
        &installed_root,
        5,
        Architecture::Amd64,
        5,
        7,
        None,
        Utc::now(),
        default_health_check,
        Some(&client as &dyn HttpClient),
    )
    .expect("url-path rollout succeeds after retry");

    assert_eq!(
        outcome,
        RolloutOutcome::CommittedKnownGood { slot: Slot::A }
    );
    let installed_path = installed_root.join("a").join("artifact");
    assert_eq!(
        fs::read(&installed_path).expect("installed artifact exists"),
        artifact_bytes
    );
}

// -- Rollback file-swap (the missing half of perform_rollback) --------------------------------

/// Builds a journal with slot A known-good (active) holding `good_bytes`, then stages/commits a
/// candidate into slot B that represents a broken update, so a rollback should restore A.
fn journal_with_known_good_and_bad_candidate(
    dir: &std::path::Path,
    good_bytes: &[u8],
    bad_bytes: &[u8],
) -> (InstallJournal, PathBuf) {
    let db_path = dir.join("journal.sqlite3");
    let installed_root = dir.join("installed");

    let signing_key = signing_key(1);
    let trust_root = ReleaseTrustRoot::new(signing_key.verifying_key());

    // Known-good install into slot A.
    let good_path = write_artifact(dir, "good.bin", good_bytes);
    let good_manifest = sample_manifest(&sha256_hex(good_bytes));
    let good_signed = SignedReleaseManifest::sign(good_manifest, &signing_key);
    {
        let mut journal = InstallJournal::open(&db_path).expect("open journal");
        perform_rollout(
            &mut journal,
            &trust_root,
            &good_signed,
            good_path.to_str().expect("path"),
            &installed_root,
            0,
            Architecture::Amd64,
            5,
            7,
            None,
            Utc::now(),
            default_health_check,
            None,
        )
        .expect("known-good rollout succeeds");
    }

    // A broken candidate into slot B (committed known-good too, so it becomes the active slot).
    let bad_path = write_artifact(dir, "bad.bin", bad_bytes);
    let mut bad_manifest = sample_manifest(&sha256_hex(bad_bytes));
    bad_manifest.security_counter = 11;
    bad_manifest.version = "1.4.1".to_string();
    let bad_signed = SignedReleaseManifest::sign(bad_manifest, &signing_key);
    {
        let mut journal = InstallJournal::open(&db_path).expect("reopen journal");
        perform_rollout(
            &mut journal,
            &trust_root,
            &bad_signed,
            bad_path.to_str().expect("path"),
            &installed_root,
            10,
            Architecture::Amd64,
            5,
            7,
            None,
            Utc::now(),
            default_health_check,
            None,
        )
        .expect("bad candidate rollout succeeds");
    }

    let journal = InstallJournal::open(&db_path).expect("reopen journal for tests");
    (journal, installed_root)
}

#[test]
fn swap_active_binary_promotes_known_good_slot_and_preserves_previous() {
    let dir = tempdir().expect("tempdir");
    let (mut journal, installed_root) = journal_with_known_good_and_bad_candidate(
        dir.path(),
        b"known-good agent binary",
        b"broken agent binary",
    );

    // The broken candidate is now active (slot B). The live binary currently holds bad bytes.
    assert_eq!(journal.active_slot().expect("active"), Some(Slot::B));
    let active_binary = dir.path().join("canvas-edge-agentd");
    fs::write(&active_binary, b"broken agent binary").expect("seed live binary with bad bytes");

    let target = perform_rollback(&mut journal, &installed_root, &active_binary)
        .expect("rollback swaps the live binary");
    assert_eq!(target, Slot::A);

    // The live binary now holds the known-good bytes, and the previous (bad) binary is preserved.
    assert_eq!(
        fs::read(&active_binary).expect("live binary readable"),
        b"known-good agent binary"
    );
    assert_eq!(
        fs::read(active_binary.with_extension("previous")).expect("previous preserved"),
        b"broken agent binary"
    );
    assert_eq!(journal.active_slot().expect("active now A"), Some(Slot::A));
}

#[test]
fn swap_active_binary_rejects_corrupted_known_good_slot() {
    let dir = tempdir().expect("tempdir");
    let (mut journal, installed_root) = journal_with_known_good_and_bad_candidate(
        dir.path(),
        b"known-good agent binary",
        b"broken agent binary",
    );

    // Corrupt slot A's artifact on disk so its hash no longer matches the journal's recorded hash.
    let good_artifact = installed_root.join("a").join("artifact");
    fs::write(&good_artifact, b"TAMPERED bytes that do not match").expect("corrupt known-good");

    let active_binary = dir.path().join("canvas-edge-agentd");
    fs::write(&active_binary, b"broken agent binary").expect("seed live binary");

    // The rollback must refuse to promote a corrupted known-good slot, not silently swap bad bytes.
    let err = perform_rollback(&mut journal, &installed_root, &active_binary)
        .expect_err("corrupted known-good slot must be rejected");
    assert!(matches!(
        err,
        RolloutError::ArtifactHashMismatch { slot: Slot::A, .. }
    ));

    // The live binary is untouched (still the bad bytes). The journal metadata was already durably
    // flipped to A by rollback_to_known_good (active is now A), but the binary swap was refused, so
    // the caller must retry or intervene -- this is the intended fail-closed split (metadata right,
    // binary not yet swapped).
    assert_eq!(
        fs::read(&active_binary).expect("live binary untouched"),
        b"broken agent binary"
    );
    assert_eq!(journal.active_slot().expect("active now A"), Some(Slot::A));
}

#[test]
fn perform_rollback_fails_closed_without_a_known_good_slot() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("journal.sqlite3");
    let installed_root = dir.path().join("installed");
    let mut journal = InstallJournal::open(&db_path).expect("open journal");

    // Never installed anything: there is no known-good slot to roll back to.
    let active_binary = dir.path().join("canvas-edge-agentd");
    fs::write(&active_binary, b"only binary").expect("seed live binary");

    let err = perform_rollback(&mut journal, &installed_root, &active_binary)
        .expect_err("no known-good slot must fail closed");
    assert!(matches!(
        err,
        RolloutError::Journal(canvas_edge_updater::journal::JournalError::NoKnownGoodSlot)
    ));
    // The live binary is untouched.
    assert_eq!(
        fs::read(&active_binary).expect("live binary untouched"),
        b"only binary"
    );
}

#[test]
fn swap_active_binary_is_atomic_via_temp_then_rename() {
    let dir = tempdir().expect("tempdir");
    let installed_root = dir.path().join("installed");
    fs::create_dir_all(installed_root.join("a")).expect("slot a dir");
    fs::write(installed_root.join("a").join("artifact"), b"good bytes")
        .expect("seed known-good artifact");

    let active_binary = dir.path().join("canvas-edge-agentd");
    fs::write(&active_binary, b"old bytes").expect("seed live binary");

    // Direct swap (no journal involved) -- proves the atomic temp+rename path works standalone.
    swap_active_binary(
        &installed_root,
        Slot::A,
        &sha256_hex(b"good bytes"),
        &active_binary,
    )
    .expect("swap succeeds");
    assert_eq!(
        fs::read(&active_binary).expect("live binary swapped"),
        b"good bytes"
    );
    assert_eq!(
        fs::read(active_binary.with_extension("previous")).expect("previous preserved"),
        b"old bytes"
    );
}
