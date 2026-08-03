//! Integration tests proving real Ed25519 key generation and proof-of-possession pairing
//! (Phase 1 checklist item) using `canvas_dev_gateway_harness::DevGatewayHarness` as the
//! development stand-in for Core's enrollment endpoint. See module docs in
//! `edge/agent/src/pairing/mod.rs` and `edge/dev-gateway-harness/src/lib.rs` for what is real vs.
//! deliberately deferred.

use canvas_dev_gateway_harness::{DevGatewayHarness, HarnessError};
use canvas_edge_agent::pairing::EdgeIdentity;

const T0: i64 = 1_753_000_000_000;

#[test]
fn successful_enrollment_generates_a_real_keypair_and_issues_a_bound_credential() {
    let mut harness = DevGatewayHarness::new();
    let invitation = harness.create_invitation(T0, 60_000);

    let identity = EdgeIdentity::generate("installation-alpha");
    let public_key_bytes = identity.public_key_bytes();
    let fingerprint = identity.public_key_fingerprint();

    let challenge = harness
        .start_enrollment(
            T0 + 1_000,
            &invitation.invitation_id,
            &invitation.secret,
            "installation-alpha",
            public_key_bytes,
        )
        .expect("valid invitation should be accepted");

    let proof = identity.answer_enrollment_challenge(&challenge);
    let credential = harness
        .complete_enrollment(T0 + 2_000, &proof)
        .expect("a genuine proof of possession should be accepted");

    assert_eq!(credential.installation_id, "installation-alpha");
    assert_eq!(credential.public_key_fingerprint, fingerprint);
    assert_eq!(credential.serial, 1);
    assert_eq!(credential.issued_at_unix_ms, T0 + 2_000);

    // A second identity pairing with a fresh invitation gets a distinct fingerprint and serial --
    // proving keys are actually randomly generated per Agent, not fixed/shared.
    let invitation_2 = harness.create_invitation(T0, 60_000);
    let identity_2 = EdgeIdentity::generate("installation-beta");
    let challenge_2 = harness
        .start_enrollment(
            T0 + 1_000,
            &invitation_2.invitation_id,
            &invitation_2.secret,
            "installation-beta",
            identity_2.public_key_bytes(),
        )
        .expect("second invitation should also be accepted");
    let proof_2 = identity_2.answer_enrollment_challenge(&challenge_2);
    let credential_2 = harness
        .complete_enrollment(T0 + 2_000, &proof_2)
        .expect("second pairing should succeed");

    assert_ne!(
        credential_2.public_key_fingerprint,
        credential.public_key_fingerprint
    );
    assert_eq!(credential_2.serial, 2);
}

#[test]
fn wrong_invitation_secret_is_rejected_before_any_challenge_is_issued() {
    let mut harness = DevGatewayHarness::new();
    let invitation = harness.create_invitation(T0, 60_000);
    let identity = EdgeIdentity::generate("installation-alpha");

    let result = harness.start_enrollment(
        T0 + 1_000,
        &invitation.invitation_id,
        "not-the-real-secret",
        "installation-alpha",
        identity.public_key_bytes(),
    );

    assert_eq!(result.unwrap_err(), HarnessError::InvitationSecretMismatch);
}

#[test]
fn unknown_invitation_id_is_rejected() {
    let mut harness = DevGatewayHarness::new();
    let identity = EdgeIdentity::generate("installation-alpha");

    let result = harness.start_enrollment(
        T0,
        "invitation-does-not-exist",
        "any-secret",
        "installation-alpha",
        identity.public_key_bytes(),
    );

    assert_eq!(result.unwrap_err(), HarnessError::InvitationNotFound);
}

#[test]
fn expired_invitation_is_rejected() {
    let mut harness = DevGatewayHarness::new();
    let invitation = harness.create_invitation(T0, 1_000);
    let identity = EdgeIdentity::generate("installation-alpha");

    let result = harness.start_enrollment(
        T0 + 5_000,
        &invitation.invitation_id,
        &invitation.secret,
        "installation-alpha",
        identity.public_key_bytes(),
    );

    assert_eq!(result.unwrap_err(), HarnessError::InvitationExpired);
}

#[test]
fn invitation_cannot_be_reserved_twice_even_before_completion() {
    let mut harness = DevGatewayHarness::new();
    let invitation = harness.create_invitation(T0, 60_000);
    let identity = EdgeIdentity::generate("installation-alpha");

    harness
        .start_enrollment(
            T0 + 1_000,
            &invitation.invitation_id,
            &invitation.secret,
            "installation-alpha",
            identity.public_key_bytes(),
        )
        .expect("first reservation should succeed");

    let second_attempt = harness.start_enrollment(
        T0 + 1_500,
        &invitation.invitation_id,
        &invitation.secret,
        "installation-alpha",
        identity.public_key_bytes(),
    );

    assert_eq!(
        second_attempt.unwrap_err(),
        HarnessError::InvitationNotAvailable
    );
}

#[test]
fn invitation_cannot_be_reused_after_successful_enrollment() {
    let mut harness = DevGatewayHarness::new();
    let invitation = harness.create_invitation(T0, 60_000);
    let identity = EdgeIdentity::generate("installation-alpha");

    let challenge = harness
        .start_enrollment(
            T0 + 1_000,
            &invitation.invitation_id,
            &invitation.secret,
            "installation-alpha",
            identity.public_key_bytes(),
        )
        .expect("first reservation should succeed");
    let proof = identity.answer_enrollment_challenge(&challenge);
    harness
        .complete_enrollment(T0 + 2_000, &proof)
        .expect("first completion should succeed");

    let replay_attempt = harness.start_enrollment(
        T0 + 3_000,
        &invitation.invitation_id,
        &invitation.secret,
        "installation-alpha",
        identity.public_key_bytes(),
    );

    assert_eq!(
        replay_attempt.unwrap_err(),
        HarnessError::InvitationNotAvailable
    );
}

#[test]
fn tampered_signature_is_rejected_and_no_credential_is_issued() {
    let mut harness = DevGatewayHarness::new();
    let invitation = harness.create_invitation(T0, 60_000);
    let identity = EdgeIdentity::generate("installation-alpha");

    let challenge = harness
        .start_enrollment(
            T0 + 1_000,
            &invitation.invitation_id,
            &invitation.secret,
            "installation-alpha",
            identity.public_key_bytes(),
        )
        .expect("reservation should succeed");
    let mut proof = identity.answer_enrollment_challenge(&challenge);
    proof.signature_bytes[0] ^= 0xFF; // flip a bit: this is no longer a valid signature

    let result = harness.complete_enrollment(T0 + 2_000, &proof);
    assert_eq!(result.unwrap_err(), HarnessError::SignatureInvalid);
}

#[test]
fn a_signature_from_the_wrong_identity_is_rejected() {
    let mut harness = DevGatewayHarness::new();
    let invitation = harness.create_invitation(T0, 60_000);
    let identity = EdgeIdentity::generate("installation-alpha");
    let attacker_identity = EdgeIdentity::generate("installation-alpha");

    let challenge = harness
        .start_enrollment(
            T0 + 1_000,
            &invitation.invitation_id,
            &invitation.secret,
            "installation-alpha",
            identity.public_key_bytes(),
        )
        .expect("reservation should succeed");

    // The attacker has a different keypair but tries to answer the challenge that was bound to
    // the legitimate identity's public key.
    let forged_proof = attacker_identity.answer_enrollment_challenge(&challenge);

    let result = harness.complete_enrollment(T0 + 2_000, &forged_proof);
    assert_eq!(result.unwrap_err(), HarnessError::SignatureInvalid);
}

#[test]
fn a_challenge_can_never_be_completed_twice_even_with_a_valid_signature() {
    let mut harness = DevGatewayHarness::new();
    let invitation = harness.create_invitation(T0, 60_000);
    let identity = EdgeIdentity::generate("installation-alpha");

    let challenge = harness
        .start_enrollment(
            T0 + 1_000,
            &invitation.invitation_id,
            &invitation.secret,
            "installation-alpha",
            identity.public_key_bytes(),
        )
        .expect("reservation should succeed");
    let proof = identity.answer_enrollment_challenge(&challenge);

    harness
        .complete_enrollment(T0 + 2_000, &proof)
        .expect("first completion should succeed");
    let replay = harness.complete_enrollment(T0 + 2_500, &proof);

    assert_eq!(replay.unwrap_err(), HarnessError::ChallengeNotFound);
}

#[test]
fn an_expired_challenge_is_rejected_even_with_a_valid_signature() {
    let mut harness = DevGatewayHarness::new();
    let invitation = harness.create_invitation(T0, 60_000);
    let identity = EdgeIdentity::generate("installation-alpha");

    let challenge = harness
        .start_enrollment(
            T0 + 1_000,
            &invitation.invitation_id,
            &invitation.secret,
            "installation-alpha",
            identity.public_key_bytes(),
        )
        .expect("reservation should succeed");
    let proof = identity.answer_enrollment_challenge(&challenge);

    let result = harness.complete_enrollment(challenge.expires_at_unix_ms + 1, &proof);
    assert_eq!(result.unwrap_err(), HarnessError::ChallengeExpired);
}

#[test]
fn deterministic_test_identities_from_different_seeds_never_collide() {
    let identity_a = EdgeIdentity::from_signing_key_bytes_for_test("fixture-a", [7u8; 32]);
    let identity_b = EdgeIdentity::from_signing_key_bytes_for_test("fixture-b", [9u8; 32]);

    assert_ne!(
        identity_a.public_key_fingerprint(),
        identity_b.public_key_fingerprint()
    );

    // The same seed always produces the same keypair -- useful for fixture stability, and proves
    // key derivation is not accidentally mixing in extra randomness.
    let identity_a_again = EdgeIdentity::from_signing_key_bytes_for_test("fixture-a", [7u8; 32]);
    assert_eq!(
        identity_a.public_key_fingerprint(),
        identity_a_again.public_key_fingerprint()
    );
}
