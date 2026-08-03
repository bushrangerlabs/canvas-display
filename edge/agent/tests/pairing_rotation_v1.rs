//! Integration tests proving the minimal key rotation and revocation-check slice added on top of
//! the enrollment flow proven in the sibling `tests/pairing_v1.rs`. See module docs in
//! `edge/agent/src/pairing/mod.rs` and `edge/dev-gateway-harness/src/lib.rs` for what is real vs.
//! deliberately deferred (full ADR 0004 issuer rotation, long-offline recovery, disaster restore
//! are out of scope here).

use canvas_dev_gateway_harness::{DevGatewayHarness, HarnessError};
use canvas_edge_agent::pairing::{
    build_enrollment_proof_payload, build_rotation_proof_payload, EdgeIdentity,
    EnrollmentChallenge, EnrollmentProof, RotationProof,
};
use ed25519_dalek::SigningKey;

const T0: i64 = 1_753_000_000_000;

/// Enrolls a fresh identity end-to-end via the existing enrollment flow and returns the identity
/// plus the issued credential's `device_id`, exactly mirroring `pairing_v1.rs`'s happy path.
fn enroll(harness: &mut DevGatewayHarness, installation_id: &str) -> (EdgeIdentity, String) {
    let invitation = harness.create_invitation(T0, 60_000);
    let identity = EdgeIdentity::generate(installation_id);

    let challenge = harness
        .start_enrollment(
            T0 + 1_000,
            &invitation.invitation_id,
            &invitation.secret,
            installation_id,
            identity.public_key_bytes(),
        )
        .expect("valid invitation should be accepted");

    let proof = identity.answer_enrollment_challenge(&challenge);
    let credential = harness
        .complete_enrollment(T0 + 2_000, &proof)
        .expect("a genuine proof of possession should be accepted");

    (identity, credential.device_id)
}

#[test]
fn rotating_to_a_fresh_keypair_lets_a_second_rotation_start_from_the_newly_adopted_key() {
    let mut harness = DevGatewayHarness::new();
    let (mut identity, device_id) = enroll(&mut harness, "installation-alpha");

    // First rotation: currently-enrolled key -> fresh key A.
    let new_signing_key_a = SigningKey::from_bytes(&[11u8; 32]);
    let new_public_key_bytes_a = new_signing_key_a.verifying_key().to_bytes();

    let challenge = harness
        .start_rotation(
            T0 + 3_000,
            &device_id,
            identity.public_key_bytes(),
            new_public_key_bytes_a,
        )
        .expect("rotation from the currently active key should be accepted");

    let proof = identity.generate_rotation_proof(new_public_key_bytes_a, &challenge.nonce_hex);
    harness
        .complete_rotation(T0 + 3_500, &proof)
        .expect("a genuine rotation proof of possession should be accepted");

    // Adopt the new key locally, exactly as a real caller would only do after the harness (or,
    // later, real Core) confirmed the rotation was accepted.
    identity.adopt_rotated_key(new_signing_key_a);
    assert_eq!(identity.public_key_bytes(), new_public_key_bytes_a);

    // Second rotation, presenting key A as "current": this only succeeds if the harness's on-file
    // fingerprint was actually updated to key A's fingerprint during the first rotation, rather
    // than merely accepted-and-ignored.
    let new_signing_key_b = SigningKey::from_bytes(&[12u8; 32]);
    let new_public_key_bytes_b = new_signing_key_b.verifying_key().to_bytes();

    let challenge_2 = harness
        .start_rotation(
            T0 + 4_000,
            &device_id,
            identity.public_key_bytes(),
            new_public_key_bytes_b,
        )
        .expect("rotation from the newly-adopted key should be accepted");

    let proof_2 = identity.generate_rotation_proof(new_public_key_bytes_b, &challenge_2.nonce_hex);
    harness
        .complete_rotation(T0 + 4_500, &proof_2)
        .expect("second rotation's proof of possession should also be accepted");
}

#[test]
fn rotation_is_rejected_when_presented_current_key_does_not_match_the_on_file_fingerprint() {
    let mut harness = DevGatewayHarness::new();
    let (_identity, device_id) = enroll(&mut harness, "installation-alpha");

    let stale_or_wrong_key =
        EdgeIdentity::from_signing_key_bytes_for_test("installation-alpha", [42u8; 32]);
    let new_identity =
        EdgeIdentity::from_signing_key_bytes_for_test("installation-alpha", [43u8; 32]);

    let result = harness.start_rotation(
        T0 + 3_000,
        &device_id,
        stale_or_wrong_key.public_key_bytes(),
        new_identity.public_key_bytes(),
    );

    assert_eq!(result.unwrap_err(), HarnessError::CurrentPublicKeyMismatch);
}

#[test]
fn a_revoked_device_cannot_start_a_new_rotation() {
    let mut harness = DevGatewayHarness::new();
    let (identity, device_id) = enroll(&mut harness, "installation-alpha");

    harness
        .revoke_device(&device_id)
        .expect("revoking a known device should succeed");

    let new_identity =
        EdgeIdentity::from_signing_key_bytes_for_test("installation-alpha", [21u8; 32]);
    let result = harness.start_rotation(
        T0 + 3_000,
        &device_id,
        identity.public_key_bytes(),
        new_identity.public_key_bytes(),
    );

    assert_eq!(result.unwrap_err(), HarnessError::DeviceRevoked);
}

#[test]
fn a_rotation_proofs_signature_cannot_be_replayed_as_an_enrollment_proof() {
    // Prove the two domain-separation prefixes actually differ in practice: take a genuinely
    // valid rotation proof's signature bytes and attempt to submit them through the enrollment
    // completion path. It must be rejected, because `build_rotation_proof_payload` and
    // `build_enrollment_proof_payload` never produce identical bytes.
    let mut harness = DevGatewayHarness::new();
    let (identity, device_id) = enroll(&mut harness, "installation-alpha");

    let new_identity =
        EdgeIdentity::from_signing_key_bytes_for_test("installation-alpha", [77u8; 32]);
    let rotation_challenge = harness
        .start_rotation(
            T0 + 3_000,
            &device_id,
            identity.public_key_bytes(),
            new_identity.public_key_bytes(),
        )
        .expect("rotation should be accepted");

    let rotation_proof = identity.generate_rotation_proof(
        new_identity.public_key_bytes(),
        &rotation_challenge.nonce_hex,
    );

    // Sanity-check the two payload shapes are never byte-identical for the same logical inputs.
    let rotation_payload = build_rotation_proof_payload(
        "installation-alpha",
        &identity.public_key_fingerprint(),
        &new_identity.public_key_fingerprint(),
        &rotation_challenge.nonce_hex,
    );
    let analogous_enrollment_payload = build_enrollment_proof_payload(
        &rotation_challenge.nonce_hex,
        &rotation_challenge.nonce_hex,
        "installation-alpha",
        &identity.public_key_fingerprint(),
    );
    assert_ne!(rotation_payload, analogous_enrollment_payload);

    // Now actually attempt the replay: submit the rotation proof's raw signature bytes as though
    // they were an enrollment proof against a freshly started, unrelated enrollment challenge.
    let invitation = harness.create_invitation(T0 + 5_000, 60_000);
    let enrollment_challenge = harness
        .start_enrollment(
            T0 + 5_100,
            &invitation.invitation_id,
            &invitation.secret,
            "installation-alpha",
            new_identity.public_key_bytes(),
        )
        .expect("fresh enrollment invitation should be accepted");

    let forged_enrollment_proof = EnrollmentProof {
        challenge_id: enrollment_challenge.challenge_id.clone(),
        signature_bytes: rotation_proof.signature_bytes,
    };

    let result = harness.complete_enrollment(T0 + 5_200, &forged_enrollment_proof);
    assert_eq!(result.unwrap_err(), HarnessError::SignatureInvalid);
}

#[test]
fn an_enrollment_proofs_signature_cannot_be_replayed_as_a_rotation_proof() {
    let mut harness = DevGatewayHarness::new();
    let (identity, device_id) = enroll(&mut harness, "installation-alpha");

    let new_signing_key = SigningKey::from_bytes(&[88u8; 32]);
    let new_public_key_bytes = new_signing_key.verifying_key().to_bytes();

    let rotation_challenge = harness
        .start_rotation(
            T0 + 3_000,
            &device_id,
            identity.public_key_bytes(),
            new_public_key_bytes,
        )
        .expect("rotation should be accepted");

    // Build a fake enrollment challenge that happens to reuse the rotation nonce, and get a
    // genuine enrollment proof signed over the enrollment-shaped payload for it.
    let fake_enrollment_challenge = EnrollmentChallenge {
        challenge_id: "irrelevant-challenge-id".to_string(),
        nonce_hex: rotation_challenge.nonce_hex.clone(),
        expires_at_unix_ms: T0 + 100_000,
    };
    let enrollment_proof = identity.answer_enrollment_challenge(&fake_enrollment_challenge);

    // Attempt to replay that enrollment proof's signature bytes as if it were a rotation proof
    // for the real pending rotation challenge.
    let forged_rotation_proof = RotationProof {
        nonce_hex: rotation_challenge.nonce_hex.clone(),
        signature_bytes: enrollment_proof.signature_bytes,
    };

    let result = harness.complete_rotation(T0 + 3_500, &forged_rotation_proof);
    assert_eq!(result.unwrap_err(), HarnessError::SignatureInvalid);
}

#[test]
fn a_rotation_challenge_can_never_be_completed_twice_even_with_a_valid_signature() {
    let mut harness = DevGatewayHarness::new();
    let (identity, device_id) = enroll(&mut harness, "installation-alpha");

    let new_identity =
        EdgeIdentity::from_signing_key_bytes_for_test("installation-alpha", [99u8; 32]);
    let challenge = harness
        .start_rotation(
            T0 + 3_000,
            &device_id,
            identity.public_key_bytes(),
            new_identity.public_key_bytes(),
        )
        .expect("rotation should be accepted");

    let proof =
        identity.generate_rotation_proof(new_identity.public_key_bytes(), &challenge.nonce_hex);

    harness
        .complete_rotation(T0 + 3_500, &proof)
        .expect("first completion should succeed");
    let replay = harness.complete_rotation(T0 + 4_000, &proof);

    assert_eq!(replay.unwrap_err(), HarnessError::ChallengeNotFound);
}
