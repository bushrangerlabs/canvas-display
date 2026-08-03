//! Edge-side local key generation and proof-of-possession pairing client.
//!
//! This module is real production-shaped code (unlike the harness in the sibling
//! `canvas-dev-gateway-harness` crate, which is dev/test-only): a real Edge Agent will always need
//! to generate a local Ed25519 identity, compute its public key fingerprint, and answer an
//! enrollment challenge from whatever issues credentials. What is *not* yet implemented here is
//! wiring this to a real network transport talking to production Canvas Core (see ADR 0004) --
//! that is later Phase 1/2 work. For now this is exercised against
//! `canvas-dev-gateway-harness::DevGatewayHarness` in `tests/pairing_v1.rs`.
//!
//! Scope note: ADR 0004 describes a full production PKI (offline root, issuing intermediate,
//! long-offline recovery, disaster restore -- already modeled in TypeScript in
//! `tests/pki/pki-state-machine.ts`). This module intentionally covers only the minimal real
//! subset needed for the Phase 1 checklist item "local key generation and proof-of-possession
//! pairing against the development gateway harness": generate a real Ed25519 keypair, prove
//! possession of its private key over a server-issued challenge, and receive a credential -- plus
//! a minimal key rotation slice (prove possession of the *current* key while presenting a new one,
//! via `RotationProof`/`build_rotation_proof_payload`, mirroring the enrollment shape with its own
//! domain-separation prefix). Issuer/root key rotation, long-offline recovery, and disaster
//! restore are still not implemented here -- see `DevGatewayHarness::revoke_device` for the
//! matching minimal revocation-check counterpart on the harness side of this slice.

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use rand::rngs::OsRng;
use sha2::{Digest, Sha256};

pub mod credential_store;
pub mod enrollment_client;

// Re-export the most-used enrollment-client types at the module root so callers can write
// `canvas_edge_agent::pairing::EnrolledCredential` rather than reaching into the submodule.
pub use credential_store::{
    delete_credential, identity_from_stored, identity_to_stored, load_credential, load_identity,
    save_credential, save_identity, CredentialStoreError, StoredIdentity, CREDENTIAL_FILENAME,
    IDENTITY_FILENAME,
};
pub use enrollment_client::{
    enroll, EnrolledCredential, FakePairingHttpClient, PairingError, PairingHttpClient,
    RealPairingHttpClient, BEGIN_PATH, COMPLETE_PATH,
};

/// A locally generated Edge identity: an Ed25519 keypair plus the installation ID it will
/// enroll under. The private key never leaves this struct's owner (no `Clone`/`Debug` deriving
/// key material -- callers use `public_key_fingerprint()` for logging/comparison instead).
pub struct EdgeIdentity {
    installation_id: String,
    signing_key: SigningKey,
}

impl EdgeIdentity {
    /// Generates a fresh Ed25519 keypair using the OS CSPRNG. This is real key generation --
    /// there is no seeded/deterministic path in production code (tests that need determinism
    /// use `from_signing_key_bytes_for_test` instead).
    pub fn generate(installation_id: impl Into<String>) -> Self {
        let signing_key = SigningKey::generate(&mut OsRng);
        Self {
            installation_id: installation_id.into(),
            signing_key,
        }
    }

    #[doc(hidden)]
    /// Test-only constructor for deterministic fixtures. Not used by any production code path.
    pub fn from_signing_key_bytes_for_test(
        installation_id: impl Into<String>,
        seed: [u8; 32],
    ) -> Self {
        Self {
            installation_id: installation_id.into(),
            signing_key: SigningKey::from_bytes(&seed),
        }
    }

    pub fn installation_id(&self) -> &str {
        &self.installation_id
    }

    pub fn public_key_bytes(&self) -> [u8; 32] {
        self.signing_key.verifying_key().to_bytes()
    }

    /// Returns the raw 32-byte Ed25519 signing key seed. Used by `canvas-edge-agentd` to durably
    /// persist the identity across process restarts so a re-enrolled credential's
    /// `public_key_fingerprint` still matches the key the device presents on reconnect. The private
    /// key never leaves the agent process in any other form (no `Clone`, no `Debug` deriving key
    /// material); callers must store this output with the same care as any other secret at rest.
    pub fn signing_key_bytes(&self) -> [u8; 32] {
        self.signing_key.to_bytes()
    }

    /// Reconstructs an identity from a persisted signing key seed. This is the production
    /// counterpart to `from_signing_key_bytes_for_test` (which is gated to test fixtures); both
    /// use `SigningKey::from_bytes`, but this constructor is the one the daemon calls when it loads
    /// `identity.json` from the data dir. Callers are responsible for ensuring the seed came from
    /// their own durable store, not an untrusted source.
    pub fn from_signing_key_bytes(installation_id: impl Into<String>, seed: [u8; 32]) -> Self {
        Self {
            installation_id: installation_id.into(),
            signing_key: SigningKey::from_bytes(&seed),
        }
    }

    /// Lowercase hex SHA-256 digest of the raw 32-byte public key. This is the value the dev
    /// gateway harness (and, later, real Core) independently recomputes from the raw bytes it
    /// receives -- it is never trusted as a self-reported claim from the Edge.
    pub fn public_key_fingerprint(&self) -> String {
        fingerprint_hex(&self.public_key_bytes())
    }

    /// Signs the canonical enrollment proof-of-possession payload for `challenge` and returns the
    /// proof to submit back to whatever issued the challenge.
    pub fn answer_enrollment_challenge(&self, challenge: &EnrollmentChallenge) -> EnrollmentProof {
        let payload = build_enrollment_proof_payload(
            &challenge.challenge_id,
            &challenge.nonce_hex,
            &self.installation_id,
            &self.public_key_fingerprint(),
        );
        let signature: Signature = self.signing_key.sign(&payload);
        EnrollmentProof {
            challenge_id: challenge.challenge_id.clone(),
            signature_bytes: signature.to_bytes(),
        }
    }

    /// Signs the canonical rotation proof-of-possession payload proving this identity's *current*
    /// key still controls the device, while presenting `new_public_key_bytes` as the key it wants
    /// to rotate to. `rotation_nonce_hex` comes from a server-issued `RotationChallenge` and
    /// prevents replay against a different rotation attempt.
    ///
    /// This is signed with the *current* signing key -- callers must call `adopt_rotated_key`
    /// only after whoever issued the challenge (the dev harness, or later real Core) confirms this
    /// proof was accepted.
    pub fn generate_rotation_proof(
        &self,
        new_public_key_bytes: [u8; 32],
        rotation_nonce_hex: &str,
    ) -> RotationProof {
        let payload = build_rotation_proof_payload(
            &self.installation_id,
            &self.public_key_fingerprint(),
            &fingerprint_hex(&new_public_key_bytes),
            rotation_nonce_hex,
        );
        let signature: Signature = self.signing_key.sign(&payload);
        RotationProof {
            nonce_hex: rotation_nonce_hex.to_string(),
            signature_bytes: signature.to_bytes(),
        }
    }

    /// Swaps in a new signing key after a rotation has been confirmed accepted by whoever issued
    /// the rotation challenge. The old key is dropped -- callers are responsible for ensuring the
    /// rotation was actually accepted before calling this (calling it prematurely would leave this
    /// identity holding a key the issuer does not yet recognize as current).
    pub fn adopt_rotated_key(&mut self, new_signing_key: SigningKey) {
        self.signing_key = new_signing_key;
    }
}

/// A challenge issued by whatever is running enrollment (dev harness today, real Core later) in
/// response to a presented invitation. `nonce_hex` must be unpredictable per challenge so a
/// captured proof cannot be replayed against a different challenge.
#[derive(Clone, Debug)]
pub struct EnrollmentChallenge {
    pub challenge_id: String,
    pub nonce_hex: String,
    pub expires_at_unix_ms: i64,
}

/// A signed proof of possession of the private key matching the public key presented when
/// enrollment started.
#[derive(Clone, Debug)]
pub struct EnrollmentProof {
    pub challenge_id: String,
    pub signature_bytes: [u8; 64],
}

/// A credential issued after a proof of possession has been verified.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IssuedCredential {
    pub device_id: String,
    pub serial: u64,
    pub installation_id: String,
    pub public_key_fingerprint: String,
    pub issued_at_unix_ms: i64,
}

/// A rotation challenge issued by whoever tracks device credentials (dev harness today, real Core
/// later) in response to a rotation request. `nonce_hex` must be unpredictable per challenge, and
/// doubles as the lookup key for the pending rotation attempt (mirroring how `EnrollmentChallenge`
/// uses `challenge_id`) -- a captured proof cannot be replayed against a different rotation.
#[derive(Clone, Debug)]
pub struct RotationChallenge {
    pub nonce_hex: String,
    pub expires_at_unix_ms: i64,
}

/// A signed proof that the identity presenting `new_public_key_bytes` (bound into the signed
/// payload, not this struct) still controls the private key matching its currently on-file public
/// key. Mirrors `EnrollmentProof`'s shape, using `nonce_hex` in place of `challenge_id` as the
/// lookup key since rotation challenges have no separate challenge identifier.
#[derive(Clone, Debug)]
pub struct RotationProof {
    pub nonce_hex: String,
    pub signature_bytes: [u8; 64],
}

/// Builds the exact byte sequence that gets signed for rotation proof of possession. `pub` for the
/// same reason as `build_enrollment_proof_payload`: the dev gateway harness (and, eventually, real
/// Core) must construct byte-identical input to verify the signature. Uses a distinct
/// domain-separation prefix (`canvas-edge-rotation-v1` vs. `canvas-edge-enrollment-v1`) so a
/// rotation proof can never be replayed as an enrollment proof or vice versa.
pub fn build_rotation_proof_payload(
    installation_id: &str,
    current_public_key_fingerprint_hex: &str,
    new_public_key_fingerprint_hex: &str,
    rotation_nonce_hex: &str,
) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(b"canvas-edge-rotation-v1\n");
    payload.extend_from_slice(installation_id.as_bytes());
    payload.push(b'\n');
    payload.extend_from_slice(current_public_key_fingerprint_hex.as_bytes());
    payload.push(b'\n');
    payload.extend_from_slice(new_public_key_fingerprint_hex.as_bytes());
    payload.push(b'\n');
    payload.extend_from_slice(rotation_nonce_hex.as_bytes());
    payload
}

/// Builds the exact byte sequence that gets signed for enrollment proof of possession. This is
/// `pub` (not `pub(crate)`) because the dev gateway harness -- and, eventually, real Core -- must
/// construct byte-identical input to verify the signature; keeping construction in one place
/// avoids the two sides silently drifting apart.
pub fn build_enrollment_proof_payload(
    challenge_id: &str,
    nonce_hex: &str,
    installation_id: &str,
    public_key_fingerprint_hex: &str,
) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(b"canvas-edge-enrollment-v1\n");
    payload.extend_from_slice(challenge_id.as_bytes());
    payload.push(b'\n');
    payload.extend_from_slice(nonce_hex.as_bytes());
    payload.push(b'\n');
    payload.extend_from_slice(installation_id.as_bytes());
    payload.push(b'\n');
    payload.extend_from_slice(public_key_fingerprint_hex.as_bytes());
    payload
}

/// Reconstructs a verifying key from raw bytes for signature verification. Exposed so the dev
/// gateway harness (and later, real Core) can verify without depending on `EdgeIdentity` at all.
pub fn verifying_key_from_bytes(
    bytes: &[u8; 32],
) -> Result<VerifyingKey, ed25519_dalek::SignatureError> {
    VerifyingKey::from_bytes(bytes)
}

pub fn fingerprint_hex(public_key_bytes: &[u8; 32]) -> String {
    let digest = Sha256::digest(public_key_bytes);
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}
