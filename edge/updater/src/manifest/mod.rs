//! Signed release manifest parsing, release-trust-root signature verification, anti-downgrade
//! (monotonic security counter) enforcement, and signed rollback authorization.
//!
//! See `docs/CANVAS_CORE_EDGE_ARCHITECTURE_PLAN.md` section 21 ("Updates, signing, and
//! rollback") for the design intent this module implements, and
//! `docs/adr/0008-deployment-updates-and-platforms.md` for the accepted ADR governing it.
//!
//! Scope note (deliberately deferred, see architecture plan 21.2): the release trust root here is
//! a single active Ed25519 public key. Multi-key rotation/revocation is a future capability, not
//! implemented in this pass -- see [`verify::ReleaseTrustRoot`] docs. Likewise, `version` is kept
//! as an opaque display string; the [`ReleaseManifest::security_counter`] field is what actually
//! determines upgrade/downgrade ordering (see [`rollback::evaluate_candidate`]).

pub mod rollback;
pub mod verify;

use serde::{Deserialize, Serialize};

pub use rollback::{
    evaluate_candidate, RejectionReason, RollbackAuthorization, SignedRollbackAuthorization,
};
pub use verify::{ManifestError, ReleaseTrustRoot, SignedReleaseManifest};

/// The two active Edge release targets (see ADR 0008 and architecture plan 21.1). Android is
/// frozen and intentionally has no variant here.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Architecture {
    Amd64,
    Arm64,
}

/// The signed release metadata described in architecture plan section 21.2.
///
/// `version` is treated as an opaque, human-readable string -- this module does not parse or
/// compare it as semver. Upgrade/downgrade ordering is instead decided entirely by
/// [`security_counter`](Self::security_counter), a monotonic counter that is independent of the
/// free-text version string by design (see architecture plan 21.2: "Monotonic security/version
/// counter and an explicit signed rollback authorization mechanism").
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReleaseManifest {
    pub product: String,
    pub version: String,
    pub architecture: Architecture,
    pub protocol_min: u32,
    pub protocol_max: u32,
    pub artifact_url: String,
    pub artifact_size_bytes: u64,
    /// Lowercase hex-encoded SHA-256 of the release artifact (64 hex characters). Format is
    /// checked by [`is_valid_sha256_hex`] / [`rollback::evaluate_candidate`]; this module never
    /// has the actual artifact bytes to hash, so it cannot (and does not attempt to) verify that
    /// a downloaded artifact actually matches this value -- that is the caller's job (the
    /// journal/install module) once it has real bytes on disk.
    pub artifact_sha256: String,
    pub required_disk_bytes: u64,
    pub rollback_compatible_versions: Vec<String>,
    pub channel: String,
    pub health_check_timeout_secs: u64,
    /// Monotonic anti-downgrade counter. See module docs and [`rollback::evaluate_candidate`].
    pub security_counter: u64,
    pub schema_min: u64,
    pub schema_max: u64,
}

impl ReleaseManifest {
    /// The canonical byte representation of this manifest that gets signed and verified.
    ///
    /// This uses plain `serde_json::to_vec`, not a full canonicalization scheme like RFC 8785.
    /// That is safe here specifically because:
    ///
    /// - `serde_json`'s default `Map` type is a `BTreeMap` (the `preserve_order` feature, which
    ///   would switch it to insertion-ordered, is not enabled in `edge/updater/Cargo.toml`), so
    ///   object keys always serialize in the same sorted order for a given set of keys.
    /// - `ReleaseManifest` has a fixed, struct-derived shape (no `HashMap`/`serde_json::Value`
    ///   fields whose iteration order could vary) and contains no floating-point fields (whose
    ///   textual representation can vary across producers).
    /// - Both the signer and every verifier are this exact same Rust type, compiled from this
    ///   exact same `Serialize`/`Deserialize` derive -- there is no cross-language or
    ///   cross-implementation round trip to protect against, which is the actual problem RFC 8785
    ///   exists to solve.
    ///
    /// If this type ever grows a field whose serialization is not deterministic (a map, a float,
    /// an externally-supplied `Serialize` impl), this reasoning must be revisited.
    pub fn canonical_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self)
            .expect("ReleaseManifest contains only strings, integers, an enum, and a Vec<String>, all of which always serialize successfully")
    }
}

/// Returns true if `value` is exactly 64 lowercase hexadecimal characters -- the expected shape
/// of a SHA-256 digest as used for [`ReleaseManifest::artifact_sha256`].
pub fn is_valid_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
}

/// Lowercase hex-encodes `bytes`. Mirrors the style of `fingerprint_hex` in
/// `edge/agent/src/pairing/mod.rs`.
pub(crate) fn encode_hex(bytes: &[u8]) -> String {
    let mut hex = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// Decodes a lowercase (or uppercase) hex string into bytes, returning `None` on any malformed
/// input (odd length or non-hex characters).
pub(crate) fn decode_hex(hex: &str) -> Option<Vec<u8>> {
    if hex.len() % 2 != 0 {
        return None;
    }
    let bytes = hex.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks(2) {
        let byte_str = std::str::from_utf8(pair).ok()?;
        out.push(u8::from_str_radix(byte_str, 16).ok()?);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_sha256_hex_accepts_64_lowercase_hex_chars() {
        let value = "a".repeat(64);
        assert!(is_valid_sha256_hex(&value));
    }

    #[test]
    fn valid_sha256_hex_rejects_wrong_length_and_case() {
        assert!(!is_valid_sha256_hex(&"a".repeat(63)));
        assert!(!is_valid_sha256_hex(&"a".repeat(65)));
        assert!(!is_valid_sha256_hex(&"A".repeat(64)));
        assert!(!is_valid_sha256_hex(&"g".repeat(64)));
    }

    #[test]
    fn hex_round_trips() {
        let bytes = [0u8, 1, 255, 16, 128];
        let encoded = encode_hex(&bytes);
        assert_eq!(decode_hex(&encoded).unwrap(), bytes.to_vec());
    }
}
