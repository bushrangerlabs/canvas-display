//! Development-only stand-in for Canvas Core's PKI enrollment endpoint (ADR 0004).
//!
//! This harness exists purely so the real Rust `EdgeIdentity` pairing client in
//! `canvas-edge-agent::pairing` can be exercised end-to-end today, before a production Core
//! exists. It intentionally implements only the minimal subset of ADR 0004 needed to prove
//! proof-of-possession pairing: single-use hashed invitations, a server-issued nonce challenge,
//! and Ed25519 signature verification over that challenge before issuing a credential -- plus a
//! minimal key rotation and revocation-check slice (`start_rotation`/`complete_rotation` re-verify
//! proof of possession of the *current* key before accepting a new one on file, and
//! `revoke_device` blocks further rotation for a device).
//!
//! Deliberately out of scope here (see `tests/pki/pki-state-machine.ts` for the full TypeScript
//! design model of these): issuer/root key hierarchy, long-offline expiry recovery,
//! active-session revocation (this harness has no session/connection concept to tear down), clone
//! detection, and disaster restore. Time is caller-supplied (`now_unix_ms`) rather than read from
//! the OS clock, matching this project's established pattern for deterministic test harnesses
//! (compare `edge/simulator`'s injected `now()`).

use std::collections::HashMap;
use std::fmt;

use canvas_edge_agent::pairing::{
    build_enrollment_proof_payload, build_rotation_proof_payload, fingerprint_hex,
    verifying_key_from_bytes, EnrollmentChallenge, EnrollmentProof, IssuedCredential,
    RotationChallenge, RotationProof,
};
use ed25519_dalek::{Signature, Verifier};
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InvitationStatus {
    Pending,
    /// An enrollment challenge has been issued against this invitation; it cannot be reserved
    /// again. This is a deliberate simplification: a failed proof-of-possession attempt leaves
    /// the invitation permanently burned rather than releasing it back to `Pending`, matching
    /// how many real one-time-token systems fail closed rather than allowing unlimited retries
    /// against the same secret.
    Reserved,
    Consumed,
}

struct InvitationRecord {
    secret_hash_hex: String,
    expires_at_unix_ms: i64,
    status: InvitationStatus,
}

struct PendingChallenge {
    invitation_id: String,
    installation_id: String,
    public_key_bytes: [u8; 32],
    nonce_hex: String,
    expires_at_unix_ms: i64,
}

/// A pending rotation attempt, keyed by `nonce_hex` (rotation challenges have no separate
/// challenge identifier -- see `RotationChallenge`/`RotationProof` doc comments in
/// `canvas_edge_agent::pairing`).
struct PendingRotation {
    device_id: String,
    current_public_key_bytes: [u8; 32],
    new_public_key_bytes: [u8; 32],
    expires_at_unix_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CredentialStatus {
    Active,
    Revoked,
}

/// The harness's on-file record of a device's currently-valid credential. This is deliberately
/// minimal: just enough to check a presented "current" key against on rotation, and to gate
/// rotation on the device not having been revoked. There is no active-session/connection concept
/// in this dev-only harness for `revoke_device` to additionally tear down.
struct CredentialRecord {
    installation_id: String,
    current_public_key_fingerprint: String,
    status: CredentialStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HarnessError {
    InvitationNotFound,
    InvitationExpired,
    InvitationNotAvailable,
    InvitationSecretMismatch,
    ChallengeNotFound,
    ChallengeExpired,
    InvalidPublicKey,
    SignatureInvalid,
    DeviceNotFound,
    DeviceRevoked,
    CurrentPublicKeyMismatch,
}

impl fmt::Display for HarnessError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            HarnessError::InvitationNotFound => "invitation not found",
            HarnessError::InvitationExpired => "invitation expired",
            HarnessError::InvitationNotAvailable => "invitation already reserved or consumed",
            HarnessError::InvitationSecretMismatch => "presented invitation secret does not match",
            HarnessError::ChallengeNotFound => {
                "challenge not found (unknown, expired-and-removed, or already completed)"
            }
            HarnessError::ChallengeExpired => "challenge expired",
            HarnessError::InvalidPublicKey => {
                "public key bytes do not form a valid Ed25519 verifying key"
            }
            HarnessError::SignatureInvalid => "proof-of-possession signature failed verification",
            HarnessError::DeviceNotFound => "device not found (no credential on file)",
            HarnessError::DeviceRevoked => "device credential has been revoked",
            HarnessError::CurrentPublicKeyMismatch => {
                "presented current public key does not match the on-file fingerprint for this device"
            }
        };
        f.write_str(message)
    }
}

impl std::error::Error for HarnessError {}

/// An invitation as handed to whoever will run the Edge enrollment (out-of-band, e.g. an admin
/// pairing code). `secret` is only ever known here and by the recipient -- the harness itself
/// stores only its hash.
pub struct Invitation {
    pub invitation_id: String,
    pub secret: String,
    pub expires_at_unix_ms: i64,
}

/// The development stand-in for Core's enrollment endpoint.
pub struct DevGatewayHarness {
    invitations: HashMap<String, InvitationRecord>,
    challenges: HashMap<String, PendingChallenge>,
    credentials: HashMap<String, CredentialRecord>,
    rotation_challenges: HashMap<String, PendingRotation>,
    next_serial: u64,
    next_id_counter: u64,
}

impl Default for DevGatewayHarness {
    fn default() -> Self {
        Self::new()
    }
}

impl DevGatewayHarness {
    pub fn new() -> Self {
        Self {
            invitations: HashMap::new(),
            challenges: HashMap::new(),
            credentials: HashMap::new(),
            rotation_challenges: HashMap::new(),
            next_serial: 1,
            next_id_counter: 1,
        }
    }

    fn next_id(&mut self, prefix: &str) -> String {
        let id = format!("{prefix}-{:08x}", self.next_id_counter);
        self.next_id_counter += 1;
        id
    }

    /// Issues a new single-use invitation. The plaintext `secret` is returned once, exactly as a
    /// real admin bootstrap flow would hand it to an operator out-of-band.
    pub fn create_invitation(&mut self, now_unix_ms: i64, ttl_ms: i64) -> Invitation {
        let invitation_id = self.next_id("invitation");
        let secret = random_hex(32);
        let secret_hash_hex = sha256_hex(secret.as_bytes());
        let expires_at_unix_ms = now_unix_ms + ttl_ms;
        self.invitations.insert(
            invitation_id.clone(),
            InvitationRecord {
                secret_hash_hex,
                expires_at_unix_ms,
                status: InvitationStatus::Pending,
            },
        );
        Invitation {
            invitation_id,
            secret,
            expires_at_unix_ms,
        }
    }

    /// Validates a presented invitation and, if valid, reserves it and issues an enrollment
    /// challenge binding the presented installation ID and raw public key bytes. The public key
    /// fingerprint used later is always recomputed here from `public_key_bytes` -- never trusted
    /// as a claim from the caller.
    pub fn start_enrollment(
        &mut self,
        now_unix_ms: i64,
        invitation_id: &str,
        presented_secret: &str,
        installation_id: &str,
        public_key_bytes: [u8; 32],
    ) -> Result<EnrollmentChallenge, HarnessError> {
        let record = self
            .invitations
            .get_mut(invitation_id)
            .ok_or(HarnessError::InvitationNotFound)?;

        if record.status != InvitationStatus::Pending {
            return Err(HarnessError::InvitationNotAvailable);
        }
        if now_unix_ms >= record.expires_at_unix_ms {
            return Err(HarnessError::InvitationExpired);
        }
        if sha256_hex(presented_secret.as_bytes()) != record.secret_hash_hex {
            return Err(HarnessError::InvitationSecretMismatch);
        }

        record.status = InvitationStatus::Reserved;

        let challenge_id = self.next_id("challenge");
        let nonce_hex = random_hex(16);
        let expires_at_unix_ms = now_unix_ms + 30_000;
        self.challenges.insert(
            challenge_id.clone(),
            PendingChallenge {
                invitation_id: invitation_id.to_string(),
                installation_id: installation_id.to_string(),
                public_key_bytes,
                nonce_hex: nonce_hex.clone(),
                expires_at_unix_ms,
            },
        );

        Ok(EnrollmentChallenge {
            challenge_id,
            nonce_hex,
            expires_at_unix_ms,
        })
    }

    /// Verifies a submitted proof of possession and, only on success, issues a credential.
    ///
    /// The pending challenge is removed unconditionally on the first completion attempt --
    /// whether that attempt succeeds or fails -- so a challenge can never be replayed, brute
    /// forced, or reused after either outcome.
    pub fn complete_enrollment(
        &mut self,
        now_unix_ms: i64,
        proof: &EnrollmentProof,
    ) -> Result<IssuedCredential, HarnessError> {
        let pending = self
            .challenges
            .remove(&proof.challenge_id)
            .ok_or(HarnessError::ChallengeNotFound)?;

        if now_unix_ms >= pending.expires_at_unix_ms {
            return Err(HarnessError::ChallengeExpired);
        }

        let verifying_key = verifying_key_from_bytes(&pending.public_key_bytes)
            .map_err(|_| HarnessError::InvalidPublicKey)?;
        let fingerprint = fingerprint_hex(&pending.public_key_bytes);
        let payload = build_enrollment_proof_payload(
            &proof.challenge_id,
            &pending.nonce_hex,
            &pending.installation_id,
            &fingerprint,
        );
        let signature = Signature::from_bytes(&proof.signature_bytes);
        if verifying_key.verify(&payload, &signature).is_err() {
            return Err(HarnessError::SignatureInvalid);
        }

        if let Some(record) = self.invitations.get_mut(&pending.invitation_id) {
            record.status = InvitationStatus::Consumed;
        }

        let serial = self.next_serial;
        self.next_serial += 1;
        let device_id = self.next_id("device");

        self.credentials.insert(
            device_id.clone(),
            CredentialRecord {
                installation_id: pending.installation_id.clone(),
                current_public_key_fingerprint: fingerprint.clone(),
                status: CredentialStatus::Active,
            },
        );

        Ok(IssuedCredential {
            device_id,
            serial,
            installation_id: pending.installation_id,
            public_key_fingerprint: fingerprint,
            issued_at_unix_ms: now_unix_ms,
        })
    }

    /// Validates that `device_id` has an active (non-revoked) credential on file and that
    /// `current_public_key_bytes` matches the fingerprint recorded for it, then issues a
    /// nonce-bearing rotation challenge. The presented "current" key is always independently
    /// re-fingerprinted here -- never trusted as a claim.
    pub fn start_rotation(
        &mut self,
        now_unix_ms: i64,
        device_id: &str,
        current_public_key_bytes: [u8; 32],
        new_public_key_bytes: [u8; 32],
    ) -> Result<RotationChallenge, HarnessError> {
        let record = self
            .credentials
            .get(device_id)
            .ok_or(HarnessError::DeviceNotFound)?;

        if record.status == CredentialStatus::Revoked {
            return Err(HarnessError::DeviceRevoked);
        }

        if fingerprint_hex(&current_public_key_bytes) != record.current_public_key_fingerprint {
            return Err(HarnessError::CurrentPublicKeyMismatch);
        }

        let nonce_hex = random_hex(16);
        let expires_at_unix_ms = now_unix_ms + 30_000;
        self.rotation_challenges.insert(
            nonce_hex.clone(),
            PendingRotation {
                device_id: device_id.to_string(),
                current_public_key_bytes,
                new_public_key_bytes,
                expires_at_unix_ms,
            },
        );

        Ok(RotationChallenge {
            nonce_hex,
            expires_at_unix_ms,
        })
    }

    /// Verifies a submitted rotation proof of possession -- signed with the *current* key on
    /// file -- and, only on success, updates the device's on-file fingerprint to the new one.
    ///
    /// As with `complete_enrollment`, the pending rotation is removed unconditionally on the
    /// first completion attempt -- whether that attempt succeeds or fails -- so a rotation
    /// challenge can never be replayed, brute forced, or reused after either outcome.
    pub fn complete_rotation(
        &mut self,
        now_unix_ms: i64,
        proof: &RotationProof,
    ) -> Result<(), HarnessError> {
        let pending = self
            .rotation_challenges
            .remove(&proof.nonce_hex)
            .ok_or(HarnessError::ChallengeNotFound)?;

        if now_unix_ms >= pending.expires_at_unix_ms {
            return Err(HarnessError::ChallengeExpired);
        }

        let verifying_key = verifying_key_from_bytes(&pending.current_public_key_bytes)
            .map_err(|_| HarnessError::InvalidPublicKey)?;

        let installation_id = self
            .credentials
            .get(&pending.device_id)
            .ok_or(HarnessError::DeviceNotFound)?
            .installation_id
            .clone();

        let current_fingerprint = fingerprint_hex(&pending.current_public_key_bytes);
        let new_fingerprint = fingerprint_hex(&pending.new_public_key_bytes);
        let payload = build_rotation_proof_payload(
            &installation_id,
            &current_fingerprint,
            &new_fingerprint,
            &proof.nonce_hex,
        );
        let signature = Signature::from_bytes(&proof.signature_bytes);
        if verifying_key.verify(&payload, &signature).is_err() {
            return Err(HarnessError::SignatureInvalid);
        }

        if let Some(record) = self.credentials.get_mut(&pending.device_id) {
            record.current_public_key_fingerprint = new_fingerprint;
        }

        Ok(())
    }

    /// Flips a device's on-file credential status to revoked. A revoked device's key can never
    /// again succeed in `start_rotation`. This dev-only harness has no active-session/connection
    /// concept, so there is nothing else here for revocation to additionally tear down.
    pub fn revoke_device(&mut self, device_id: &str) -> Result<(), HarnessError> {
        let record = self
            .credentials
            .get_mut(device_id)
            .ok_or(HarnessError::DeviceNotFound)?;
        record.status = CredentialStatus::Revoked;
        Ok(())
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

fn random_hex(num_bytes: usize) -> String {
    let mut bytes = vec![0u8; num_bytes];
    OsRng.fill_bytes(&mut bytes);
    let mut hex = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}
