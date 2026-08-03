//! Ed25519 signature verification for signed release manifests, using the same
//! `ed25519-dalek` conventions established in `edge/agent/src/pairing/mod.rs`.

use std::fmt;

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};

use super::{decode_hex, encode_hex, ReleaseManifest};

/// Errors returned when verifying a signed manifest or rollback authorization.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ManifestError {
    /// The signature does not verify against the provided trust root for the canonical payload
    /// bytes -- either the payload was tampered with after signing, or the wrong trust root was
    /// used.
    SignatureInvalid,
    /// The stored signature is not well-formed hex of the expected length, so it could not even
    /// be checked.
    MalformedSignatureEncoding,
}

impl fmt::Display for ManifestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SignatureInvalid => write!(f, "signature does not verify against trust root"),
            Self::MalformedSignatureEncoding => write!(f, "signature is not valid hex-64-bytes"),
        }
    }
}

impl std::error::Error for ManifestError {}

/// The release public trust root: the Ed25519 public key that signs release manifests and
/// rollback authorizations, "provisioned independently of ordinary Core data" (architecture plan
/// 21.2).
///
/// Scope note: this wraps exactly one active key. Planned multi-key rotation/revocation
/// (architecture plan 21.2 mentions this as a future capability) is intentionally not
/// implemented here -- callers that need to rotate trust roots must construct a new
/// `ReleaseTrustRoot` and handle the transition themselves.
#[derive(Clone, Copy, Debug)]
pub struct ReleaseTrustRoot {
    verifying_key: VerifyingKey,
}

impl ReleaseTrustRoot {
    pub fn new(verifying_key: VerifyingKey) -> Self {
        Self { verifying_key }
    }

    pub fn from_public_key_bytes(bytes: &[u8; 32]) -> Result<Self, ed25519_dalek::SignatureError> {
        Ok(Self::new(VerifyingKey::from_bytes(bytes)?))
    }

    pub fn verifying_key(&self) -> &VerifyingKey {
        &self.verifying_key
    }
}

impl From<VerifyingKey> for ReleaseTrustRoot {
    fn from(verifying_key: VerifyingKey) -> Self {
        Self::new(verifying_key)
    }
}

/// A [`ReleaseManifest`] plus a detached Ed25519 signature over its canonical bytes
/// ([`ReleaseManifest::canonical_bytes`]).
///
/// Real releases are signed offline or in CI, per ADR 0008 ("The release signing private key is
/// offline or isolated in CI"). [`SignedReleaseManifest::sign`] exists so production tooling
/// (and test fixtures) have a single, correct way to produce one -- it is not meant to be called
/// from a running Edge Agent, which only ever verifies.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SignedReleaseManifest {
    manifest: ReleaseManifest,
    /// Lowercase hex-encoded raw 64-byte Ed25519 signature, mirroring the hex-fingerprint style
    /// used throughout `edge/agent/src/pairing/mod.rs`.
    signature_hex: String,
}

impl SignedReleaseManifest {
    /// Signs `manifest` with `signing_key` over its canonical bytes.
    pub fn sign(manifest: ReleaseManifest, signing_key: &SigningKey) -> Self {
        let payload = manifest.canonical_bytes();
        let signature: Signature = signing_key.sign(&payload);
        Self {
            manifest,
            signature_hex: encode_hex(&signature.to_bytes()),
        }
    }

    /// Independently verifies the signature over the canonical bytes of the enclosed manifest
    /// against `trust_root`, and only then returns the manifest.
    ///
    /// Callers must never read fields off a `SignedReleaseManifest` before calling this: the
    /// whole point (mirroring the "always recompute, never trust a client claim" principle
    /// already used for fingerprint verification in `edge/agent/src/pairing/mod.rs`) is that an
    /// unverified manifest is just an untrusted claim until this check passes.
    /// Returns the hex-encoded Ed25519 signature, for use by release tooling.
    pub fn signature_hex(&self) -> &str {
        &self.signature_hex
    }

    /// Returns a reference to the inner manifest (without verification).
    /// Callers should prefer [`verify`](Self::verify) for trust-root verification.
    pub fn manifest(&self) -> &ReleaseManifest {
        &self.manifest
    }

    pub fn verify(&self, trust_root: &ReleaseTrustRoot) -> Result<&ReleaseManifest, ManifestError> {
        let signature = decode_signature(&self.signature_hex)?;
        let payload = self.manifest.canonical_bytes();
        trust_root
            .verifying_key()
            .verify_strict(&payload, &signature)
            .map_err(|_| ManifestError::SignatureInvalid)?;
        Ok(&self.manifest)
    }
}

/// Decodes a hex-encoded 64-byte signature. Shared by [`SignedReleaseManifest::verify`] and
/// `super::rollback::SignedRollbackAuthorization::verify`.
pub(super) fn decode_signature(signature_hex: &str) -> Result<Signature, ManifestError> {
    let bytes = decode_hex(signature_hex).ok_or(ManifestError::MalformedSignatureEncoding)?;
    let bytes: [u8; 64] = bytes
        .try_into()
        .map_err(|_| ManifestError::MalformedSignatureEncoding)?;
    Ok(Signature::from_bytes(&bytes))
}

/// Signs arbitrary canonical `payload` bytes with `signing_key` and hex-encodes the result.
/// Shared signing helper for both manifests and rollback authorizations.
pub(super) fn sign_hex(payload: &[u8], signing_key: &SigningKey) -> String {
    let signature: Signature = signing_key.sign(payload);
    encode_hex(&signature.to_bytes())
}
