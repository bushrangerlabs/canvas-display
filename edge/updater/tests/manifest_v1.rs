//! Integration tests for signed release manifest verification and anti-downgrade policy
//! (Phase 1 checklist item). See module docs in `edge/updater/src/manifest/mod.rs` and
//! `docs/CANVAS_CORE_EDGE_ARCHITECTURE_PLAN.md` section 21 for what this proves.

use canvas_edge_updater::manifest::{
    evaluate_candidate, is_valid_sha256_hex, Architecture, ManifestError, RejectionReason,
    ReleaseManifest, ReleaseTrustRoot, RollbackAuthorization, SignedReleaseManifest,
    SignedRollbackAuthorization,
};
use chrono::{Duration, Utc};
use ed25519_dalek::SigningKey;

fn signing_key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn trust_root(seed: u8) -> ReleaseTrustRoot {
    ReleaseTrustRoot::new(signing_key(seed).verifying_key())
}

fn sample_manifest() -> ReleaseManifest {
    ReleaseManifest {
        product: "canvas-edge-agent".to_string(),
        version: "1.4.0".to_string(),
        architecture: Architecture::Amd64,
        protocol_min: 3,
        protocol_max: 7,
        artifact_url: "https://releases.example.com/canvas-edge-agent-1.4.0-amd64.deb".to_string(),
        artifact_size_bytes: 12_345_678,
        artifact_sha256: "a".repeat(64),
        required_disk_bytes: 200_000_000,
        rollback_compatible_versions: vec!["1.3.0".to_string(), "1.2.0".to_string()],
        channel: "stable".to_string(),
        health_check_timeout_secs: 120,
        security_counter: 10,
        schema_min: 5,
        schema_max: 9,
    }
}

// -- Signature verification -------------------------------------------------------------------

#[test]
fn validly_signed_manifest_verifies_against_correct_trust_root() {
    let signing_key = signing_key(1);
    let trust_root = ReleaseTrustRoot::new(signing_key.verifying_key());
    let manifest = sample_manifest();

    let signed = SignedReleaseManifest::sign(manifest.clone(), &signing_key);

    let verified = signed.verify(&trust_root).expect("should verify");
    assert_eq!(verified, &manifest);
}

#[test]
fn manifest_signed_by_one_key_fails_verification_against_a_different_trust_root() {
    let signing_key_a = signing_key(1);
    let signing_key_b = signing_key(2);
    assert_ne!(
        signing_key_a.verifying_key().to_bytes(),
        signing_key_b.verifying_key().to_bytes()
    );

    let wrong_trust_root = ReleaseTrustRoot::new(signing_key_b.verifying_key());
    let signed = SignedReleaseManifest::sign(sample_manifest(), &signing_key_a);

    let result = signed.verify(&wrong_trust_root);
    assert_eq!(result.unwrap_err(), ManifestError::SignatureInvalid);
}

#[test]
fn tampering_with_any_field_after_signing_invalidates_the_signature() {
    let signing_key = signing_key(1);
    let trust_root = ReleaseTrustRoot::new(signing_key.verifying_key());

    // Tamper with security_counter -- the field the anti-downgrade decision depends on.
    let mut signed = SignedReleaseManifest::sign(sample_manifest(), &signing_key);
    let json = serde_json::to_string(&signed).unwrap();
    let mut value: serde_json::Value = serde_json::from_str(&json).unwrap();
    value["manifest"]["security_counter"] = serde_json::json!(999);
    signed = serde_json::from_value(value).unwrap();

    let result = signed.verify(&trust_root);
    assert_eq!(result.unwrap_err(), ManifestError::SignatureInvalid);
}

#[test]
fn tampering_with_artifact_hash_after_signing_invalidates_the_signature() {
    let signing_key = signing_key(1);
    let trust_root = ReleaseTrustRoot::new(signing_key.verifying_key());

    let signed = SignedReleaseManifest::sign(sample_manifest(), &signing_key);
    let json = serde_json::to_string(&signed).unwrap();
    let mut value: serde_json::Value = serde_json::from_str(&json).unwrap();
    value["manifest"]["artifact_sha256"] = serde_json::json!("b".repeat(64));
    let tampered: SignedReleaseManifest = serde_json::from_value(value).unwrap();

    let result = tampered.verify(&trust_root);
    assert_eq!(result.unwrap_err(), ManifestError::SignatureInvalid);
}

// -- evaluate_candidate: normal upgrade / downgrade rejection ----------------------------------

#[test]
fn normal_upgrade_with_higher_security_counter_is_accepted() {
    let trust_root = trust_root(1);
    let candidate = sample_manifest(); // security_counter = 10

    let result = evaluate_candidate(
        &candidate,
        5, // installed counter is lower
        Architecture::Amd64,
        5,
        7,
        &trust_root,
        None,
        Utc::now(),
    );

    assert!(result.is_ok());
}

#[test]
fn same_or_lower_security_counter_is_rejected_without_rollback_authorization() {
    let trust_root = trust_root(1);
    let candidate = sample_manifest(); // security_counter = 10

    // Equal counter.
    let result = evaluate_candidate(
        &candidate,
        10,
        Architecture::Amd64,
        5,
        7,
        &trust_root,
        None,
        Utc::now(),
    );
    assert_eq!(
        result.unwrap_err(),
        RejectionReason::DowngradeWithoutAuthorization {
            candidate_counter: 10,
            installed_counter: 10,
        }
    );

    // Lower counter.
    let result = evaluate_candidate(
        &candidate,
        20,
        Architecture::Amd64,
        5,
        7,
        &trust_root,
        None,
        Utc::now(),
    );
    assert_eq!(
        result.unwrap_err(),
        RejectionReason::DowngradeWithoutAuthorization {
            candidate_counter: 10,
            installed_counter: 20,
        }
    );
}

// -- evaluate_candidate: rollback authorization -----------------------------------------------

fn valid_authorization(product: &str, authorized_security_counter: u64) -> RollbackAuthorization {
    RollbackAuthorization {
        product: product.to_string(),
        authorized_security_counter,
        reason: "known regression in 1.4.0, rolling back to last known-good".to_string(),
        expires_at: Utc::now() + Duration::hours(1),
    }
}

#[test]
fn downgrade_is_accepted_with_a_valid_unexpired_matching_rollback_authorization() {
    let signing_key = signing_key(1);
    let trust_root = ReleaseTrustRoot::new(signing_key.verifying_key());
    let candidate = sample_manifest(); // security_counter = 10

    let authorization = valid_authorization(&candidate.product, 10);
    let signed_authorization = SignedRollbackAuthorization::sign(authorization, &signing_key);

    let result = evaluate_candidate(
        &candidate,
        20, // installed counter is higher: this is a downgrade
        Architecture::Amd64,
        5,
        7,
        &trust_root,
        Some(&signed_authorization),
        Utc::now(),
    );

    assert!(result.is_ok());
}

#[test]
fn downgrade_is_rejected_when_authorization_is_expired() {
    let signing_key = signing_key(1);
    let trust_root = ReleaseTrustRoot::new(signing_key.verifying_key());
    let candidate = sample_manifest();

    let expired_authorization = RollbackAuthorization {
        product: candidate.product.clone(),
        authorized_security_counter: 10,
        reason: "expired".to_string(),
        expires_at: Utc::now() - Duration::hours(1),
    };
    let signed_authorization =
        SignedRollbackAuthorization::sign(expired_authorization, &signing_key);

    let result = evaluate_candidate(
        &candidate,
        20,
        Architecture::Amd64,
        5,
        7,
        &trust_root,
        Some(&signed_authorization),
        Utc::now(),
    );

    assert_eq!(
        result.unwrap_err(),
        RejectionReason::RollbackAuthorizationExpired
    );
}

#[test]
fn downgrade_is_rejected_when_authorization_is_for_the_wrong_security_counter() {
    let signing_key = signing_key(1);
    let trust_root = ReleaseTrustRoot::new(signing_key.verifying_key());
    let candidate = sample_manifest(); // security_counter = 10

    let authorization = valid_authorization(&candidate.product, 9); // wrong counter
    let signed_authorization = SignedRollbackAuthorization::sign(authorization, &signing_key);

    let result = evaluate_candidate(
        &candidate,
        20,
        Architecture::Amd64,
        5,
        7,
        &trust_root,
        Some(&signed_authorization),
        Utc::now(),
    );

    assert_eq!(
        result.unwrap_err(),
        RejectionReason::RollbackAuthorizationCounterMismatch {
            authorized_counter: 9,
            candidate_counter: 10,
        }
    );
}

#[test]
fn downgrade_is_rejected_when_authorization_is_signed_by_the_wrong_trust_root() {
    let real_signing_key = signing_key(1);
    let attacker_signing_key = signing_key(99);
    let trust_root = ReleaseTrustRoot::new(real_signing_key.verifying_key());
    let candidate = sample_manifest();

    let authorization = valid_authorization(&candidate.product, 10);
    // Signed with a different key than the trust root evaluate_candidate is given.
    let signed_authorization =
        SignedRollbackAuthorization::sign(authorization, &attacker_signing_key);

    let result = evaluate_candidate(
        &candidate,
        20,
        Architecture::Amd64,
        5,
        7,
        &trust_root,
        Some(&signed_authorization),
        Utc::now(),
    );

    assert_eq!(
        result.unwrap_err(),
        RejectionReason::RollbackAuthorizationInvalid(ManifestError::SignatureInvalid)
    );
}

#[test]
fn downgrade_is_rejected_when_authorization_is_for_a_different_product() {
    let signing_key = signing_key(1);
    let trust_root = ReleaseTrustRoot::new(signing_key.verifying_key());
    let candidate = sample_manifest();

    let authorization = valid_authorization("some-other-product", 10);
    let signed_authorization = SignedRollbackAuthorization::sign(authorization, &signing_key);

    let result = evaluate_candidate(
        &candidate,
        20,
        Architecture::Amd64,
        5,
        7,
        &trust_root,
        Some(&signed_authorization),
        Utc::now(),
    );

    assert_eq!(
        result.unwrap_err(),
        RejectionReason::RollbackAuthorizationProductMismatch
    );
}

// -- evaluate_candidate: architecture / protocol / schema mismatches ---------------------------

#[test]
fn architecture_mismatch_is_rejected() {
    let trust_root = trust_root(1);
    let candidate = sample_manifest(); // Amd64

    let result = evaluate_candidate(
        &candidate,
        5,
        Architecture::Arm64,
        5,
        7,
        &trust_root,
        None,
        Utc::now(),
    );

    assert_eq!(
        result.unwrap_err(),
        RejectionReason::ArchitectureMismatch {
            running: Architecture::Arm64,
            candidate: Architecture::Amd64,
        }
    );
}

#[test]
fn protocol_range_mismatch_is_rejected() {
    let trust_root = trust_root(1);
    let candidate = sample_manifest(); // protocol_min = 3, protocol_max = 7

    let result = evaluate_candidate(
        &candidate,
        5,
        Architecture::Amd64,
        100, // outside [3, 7]
        7,
        &trust_root,
        None,
        Utc::now(),
    );

    assert_eq!(
        result.unwrap_err(),
        RejectionReason::ProtocolIncompatible {
            current: 100,
            min: 3,
            max: 7,
        }
    );
}

#[test]
fn schema_range_mismatch_is_rejected() {
    let trust_root = trust_root(1);
    let candidate = sample_manifest(); // schema_min = 5, schema_max = 9

    let result = evaluate_candidate(
        &candidate,
        5,
        Architecture::Amd64,
        5,
        100, // outside [5, 9]
        &trust_root,
        None,
        Utc::now(),
    );

    assert_eq!(
        result.unwrap_err(),
        RejectionReason::SchemaIncompatible {
            current: 100,
            min: 5,
            max: 9,
        }
    );
}

// -- artifact_sha256 format validation ----------------------------------------------------------

#[test]
fn artifact_sha256_format_validation() {
    assert!(is_valid_sha256_hex(&"a".repeat(64)));
    assert!(is_valid_sha256_hex(&"0123456789abcdef".repeat(4)));

    assert!(!is_valid_sha256_hex(&"a".repeat(63))); // too short
    assert!(!is_valid_sha256_hex(&"a".repeat(65))); // too long
    assert!(!is_valid_sha256_hex(&"A".repeat(64))); // uppercase
    assert!(!is_valid_sha256_hex(&"g".repeat(64))); // non-hex character
}

#[test]
fn evaluate_candidate_rejects_malformed_artifact_hash_before_any_other_check() {
    let trust_root = trust_root(1);
    let mut candidate = sample_manifest();
    candidate.artifact_sha256 = "not-a-valid-hash".to_string();

    let result = evaluate_candidate(
        &candidate,
        5,
        Architecture::Amd64,
        5,
        7,
        &trust_root,
        None,
        Utc::now(),
    );

    assert_eq!(
        result.unwrap_err(),
        RejectionReason::InvalidArtifactHashFormat
    );
}

// -- serde round trip ----------------------------------------------------------------------------

#[test]
fn release_manifest_round_trips_through_json_without_data_loss() {
    let manifest = sample_manifest();
    let json = serde_json::to_string(&manifest).unwrap();
    let round_tripped: ReleaseManifest = serde_json::from_str(&json).unwrap();
    assert_eq!(manifest, round_tripped);
}

#[test]
fn signed_release_manifest_round_trips_through_json_and_still_verifies() {
    let signing_key = signing_key(1);
    let trust_root = ReleaseTrustRoot::new(signing_key.verifying_key());
    let signed = SignedReleaseManifest::sign(sample_manifest(), &signing_key);

    let json = serde_json::to_string(&signed).unwrap();
    let round_tripped: SignedReleaseManifest = serde_json::from_str(&json).unwrap();

    let verified = round_tripped
        .verify(&trust_root)
        .expect("should still verify");
    assert_eq!(verified, &sample_manifest());
}
