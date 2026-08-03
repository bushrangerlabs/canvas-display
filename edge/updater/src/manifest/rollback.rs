//! Anti-downgrade policy and signed rollback authorization, per architecture plan 21.2/21.3:
//! "Monotonic security/version counter and an explicit signed rollback authorization mechanism"
//! and "A signed rollback authorization permits return to a prior known-good version without
//! disabling normal anti-downgrade protection".

use std::fmt;

use chrono::{DateTime, Utc};
use ed25519_dalek::SigningKey;
use serde::{Deserialize, Serialize};

use super::verify::{decode_signature, sign_hex, ManifestError, ReleaseTrustRoot};
use super::{is_valid_sha256_hex, Architecture, ReleaseManifest};

/// A small, separately signed payload authorizing one specific downgrade. Signed by the same
/// release trust root as [`super::ReleaseManifest`] (the architecture plan does not call for a
/// distinct signing key for this, and reusing the trust root avoids provisioning a second one).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RollbackAuthorization {
    pub product: String,
    /// The exact `security_counter` this authorization permits installing, even though it is
    /// less than or equal to the currently installed counter.
    pub authorized_security_counter: u64,
    pub reason: String,
    /// After this time the authorization can no longer be used, so a captured authorization
    /// cannot be replayed indefinitely.
    pub expires_at: DateTime<Utc>,
}

impl RollbackAuthorization {
    /// Canonical bytes signed/verified for this authorization. See
    /// [`ReleaseManifest::canonical_bytes`] for why plain `serde_json::to_vec` is sufficient here
    /// (same reasoning applies: fixed struct shape, no maps/floats, single Rust type on both
    /// sides).
    pub fn canonical_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self)
            .expect("RollbackAuthorization contains only strings, a u64, and a DateTime<Utc>, all of which always serialize successfully")
    }
}

/// A [`RollbackAuthorization`] plus a detached Ed25519 signature over its canonical bytes.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SignedRollbackAuthorization {
    authorization: RollbackAuthorization,
    signature_hex: String,
}

impl SignedRollbackAuthorization {
    pub fn sign(authorization: RollbackAuthorization, signing_key: &SigningKey) -> Self {
        let payload = authorization.canonical_bytes();
        let signature_hex = sign_hex(&payload, signing_key);
        Self {
            authorization,
            signature_hex,
        }
    }

    /// Verifies the signature over the canonical bytes of the enclosed authorization against
    /// `trust_root`, and only then returns the authorization. As with
    /// `SignedReleaseManifest::verify`, callers must not act on the authorization's claimed
    /// fields before this succeeds.
    pub fn verify(
        &self,
        trust_root: &ReleaseTrustRoot,
    ) -> Result<&RollbackAuthorization, ManifestError> {
        let signature = decode_signature(&self.signature_hex)?;
        let payload = self.authorization.canonical_bytes();
        trust_root
            .verifying_key()
            .verify_strict(&payload, &signature)
            .map_err(|_| ManifestError::SignatureInvalid)?;
        Ok(&self.authorization)
    }
}

/// Why a candidate release manifest was rejected by [`evaluate_candidate`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RejectionReason {
    InvalidArtifactHashFormat,
    ArchitectureMismatch {
        running: Architecture,
        candidate: Architecture,
    },
    ProtocolIncompatible {
        current: u32,
        min: u32,
        max: u32,
    },
    SchemaIncompatible {
        current: u64,
        min: u64,
        max: u64,
    },
    /// `candidate.security_counter` is less than or equal to the installed counter, and no
    /// rollback authorization was provided at all.
    DowngradeWithoutAuthorization {
        candidate_counter: u64,
        installed_counter: u64,
    },
    /// A rollback authorization was provided but failed signature verification (tampered, or
    /// signed by a different trust root than the one passed in).
    RollbackAuthorizationInvalid(ManifestError),
    RollbackAuthorizationExpired,
    RollbackAuthorizationProductMismatch,
    RollbackAuthorizationCounterMismatch {
        authorized_counter: u64,
        candidate_counter: u64,
    },
}

impl fmt::Display for RejectionReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidArtifactHashFormat => {
                write!(f, "artifact_sha256 is not 64 lowercase hex characters")
            }
            Self::ArchitectureMismatch { running, candidate } => write!(
                f,
                "candidate architecture {candidate:?} does not match running architecture {running:?}"
            ),
            Self::ProtocolIncompatible { current, min, max } => write!(
                f,
                "current protocol version {current} is outside candidate's supported range [{min}, {max}]"
            ),
            Self::SchemaIncompatible { current, min, max } => write!(
                f,
                "current schema version {current} is outside candidate's supported range [{min}, {max}]"
            ),
            Self::DowngradeWithoutAuthorization {
                candidate_counter,
                installed_counter,
            } => write!(
                f,
                "candidate security_counter {candidate_counter} does not exceed installed security_counter {installed_counter}, and no rollback authorization was provided"
            ),
            Self::RollbackAuthorizationInvalid(inner) => {
                write!(f, "rollback authorization invalid: {inner}")
            }
            Self::RollbackAuthorizationExpired => {
                write!(f, "rollback authorization has expired")
            }
            Self::RollbackAuthorizationProductMismatch => {
                write!(f, "rollback authorization is for a different product")
            }
            Self::RollbackAuthorizationCounterMismatch {
                authorized_counter,
                candidate_counter,
            } => write!(
                f,
                "rollback authorization permits security_counter {authorized_counter}, but candidate has {candidate_counter}"
            ),
        }
    }
}

impl std::error::Error for RejectionReason {}

/// Evaluates whether `candidate` may be installed over the currently installed/running Edge
/// state, per architecture plan 21.3 step 3 ("Edge checks signature chain, anti-downgrade
/// counter, architecture, platform, protocol, disk, dependency availability, hash, and migration
/// compatibility").
///
/// This function assumes `candidate` has *already* passed [`super::SignedReleaseManifest::verify`]
/// -- it does not re-check the manifest's own signature, only its claimed fields against local
/// state. `rollback_authorization`, if present, is independently verified here (signature,
/// expiry, product, and counter match) before it is allowed to excuse a downgrade.
///
/// Deliberately out of scope here (see module/crate docs): actually verifying that a downloaded
/// artifact's bytes hash to `candidate.artifact_sha256`, and checking disk space / dependency
/// availability -- those require real artifact bytes and filesystem state that this pure
/// metadata-evaluation function does not have.
#[allow(clippy::too_many_arguments)]
pub fn evaluate_candidate(
    candidate: &ReleaseManifest,
    installed_security_counter: u64,
    running_architecture: Architecture,
    current_protocol_version: u32,
    current_schema_version: u64,
    trust_root: &ReleaseTrustRoot,
    rollback_authorization: Option<&SignedRollbackAuthorization>,
    now: DateTime<Utc>,
) -> Result<(), RejectionReason> {
    if !is_valid_sha256_hex(&candidate.artifact_sha256) {
        return Err(RejectionReason::InvalidArtifactHashFormat);
    }

    if candidate.architecture != running_architecture {
        return Err(RejectionReason::ArchitectureMismatch {
            running: running_architecture,
            candidate: candidate.architecture,
        });
    }

    if current_protocol_version < candidate.protocol_min
        || current_protocol_version > candidate.protocol_max
    {
        return Err(RejectionReason::ProtocolIncompatible {
            current: current_protocol_version,
            min: candidate.protocol_min,
            max: candidate.protocol_max,
        });
    }

    if current_schema_version < candidate.schema_min
        || current_schema_version > candidate.schema_max
    {
        return Err(RejectionReason::SchemaIncompatible {
            current: current_schema_version,
            min: candidate.schema_min,
            max: candidate.schema_max,
        });
    }

    if candidate.security_counter <= installed_security_counter {
        let signed_authorization =
            rollback_authorization.ok_or(RejectionReason::DowngradeWithoutAuthorization {
                candidate_counter: candidate.security_counter,
                installed_counter: installed_security_counter,
            })?;

        let authorization = signed_authorization
            .verify(trust_root)
            .map_err(RejectionReason::RollbackAuthorizationInvalid)?;

        if authorization.product != candidate.product {
            return Err(RejectionReason::RollbackAuthorizationProductMismatch);
        }

        if authorization.authorized_security_counter != candidate.security_counter {
            return Err(RejectionReason::RollbackAuthorizationCounterMismatch {
                authorized_counter: authorization.authorized_security_counter,
                candidate_counter: candidate.security_counter,
            });
        }

        if authorization.expires_at <= now {
            return Err(RejectionReason::RollbackAuthorizationExpired);
        }
    }

    Ok(())
}
