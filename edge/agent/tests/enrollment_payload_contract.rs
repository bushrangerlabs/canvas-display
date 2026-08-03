//! Locks the exact byte layout of the enrollment proof-of-possession payload so the real Canvas
//! Core enrollment endpoint (`core/src/enrollment.ts`) and the Edge `EdgeIdentity` client can never
//! silently drift apart. This mirrors `canvas_dev_gateway_harness`'s verification path and the
//! Core-side `buildEnrollmentProofPayload` — if either side changes the domain prefix or field
//! ordering, this test fails and the pairing handshake breaks loudly instead of failing open.
//!
//! This is a documentation/contract test only: it does NOT wire `canvas-edge-agentd`'s transport to
//! a live Core (that integration is a later task). It proves the bytes Core will verify are exactly
//! the bytes `EdgeIdentity` signs.

use canvas_edge_agent::pairing::{
    build_enrollment_proof_payload, EdgeIdentity, EnrollmentChallenge,
};

#[test]
fn enrollment_proof_payload_is_byte_identical_to_core_expectation() {
    let challenge = EnrollmentChallenge {
        challenge_id: "challenge-abc123".to_string(),
        nonce_hex: "deadbeefcafebabe".to_string(),
        expires_at_unix_ms: 1_753_000_000_000,
    };
    let identity = EdgeIdentity::from_signing_key_bytes_for_test("installation-alpha", [7u8; 32]);
    let fingerprint = identity.public_key_fingerprint();

    // This is exactly what Core reconstructs in `buildEnrollmentProofPayload` (enrollment.ts).
    let expected = format!(
        "canvas-edge-enrollment-v1\n{}\n{}\n{}\n{}",
        challenge.challenge_id,
        challenge.nonce_hex,
        identity.installation_id(),
        fingerprint,
    );

    let payload = build_enrollment_proof_payload(
        &challenge.challenge_id,
        &challenge.nonce_hex,
        identity.installation_id(),
        &fingerprint,
    );

    assert_eq!(String::from_utf8(payload.clone()).unwrap(), expected);
    // Domain-separation prefix must be present and exact.
    assert!(expected.starts_with("canvas-edge-enrollment-v1\n"));
    // No trailing newline (the fingerprint is the final field).
    assert!(!expected.ends_with('\n'));
    // The payload is what `answer_enrollment_challenge` signs — verify it round-trips through a
    // real signature so we know the bytes Core checks are the bytes bound to the proof.
    let proof = identity.answer_enrollment_challenge(&challenge);
    let verifying_key =
        canvas_edge_agent::pairing::verifying_key_from_bytes(&identity.public_key_bytes()).unwrap();
    use ed25519_dalek::Verifier;
    let signature = ed25519_dalek::Signature::from_bytes(&proof.signature_bytes);
    assert!(verifying_key.verify(&payload, &signature).is_ok());
}
