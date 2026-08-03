//! Durable on-disk storage for the Edge's enrollment identity and issued credential.
//!
//! `canvas-edge-agentd` needs to persist two things across process restarts so reconnection does
//! not re-enroll (which would burn a fresh invitation every restart and produce a new device row):
//!
//! 1. The `EdgeIdentity`'s Ed25519 signing key seed + installation ID (`identity.json`). Without
//!    this, a restarted daemon would present a different public key and the stored credential's
//!    `public_key_fingerprint` would no longer match.
//! 2. The `EnrolledCredential` returned by Core (`credential.json`) -- the signed credential
//!    envelope the gateway's auth gate verifies.
//!
//! Both are stored as JSON files in the daemon's data dir (alongside `agent.sqlite3` and the resume
//! cursor), not in SQLite. This is deliberate: the credential is a self-contained signed document
//! that the daemon reads once at startup and feeds into `EdgeSessionOptions`, never querying by
//! partial fields; a JSON file is the simplest durable shape for that access pattern and keeps the
//! credential trivially inspectable for operators debugging a pairing issue. The resume cursor, by
//! contrast, is updated on every clean disconnect and queried by the storage layer, so it lives in
//! SQLite -- different access pattern, different store.
//!
//! ## Threat model note
//!
//! `identity.json` contains the raw Ed25519 signing key seed. Production deployment MUST protect
//! it with filesystem permissions (0600, owner = the agent's service user) -- this module sets
//! those permissions on creation, but cannot retroactively fix a file that was copied through an
//! insecure channel. Phase 0 (per `docs/PHASE_0_PKI_BOOTSTRAP_SPEC.md`) treats the device's local
//! key as a secret at rest; OS-level keyring integration is a later hardening task, not in scope
//! here.
//!
//! ## File format stability
//!
//! Both files are `serde_json`-serialized with `pretty` formatting so a diff is reviewable. The
//! structs (`StoredIdentity`, `EnrolledCredential`) derive `Serialize`/`Deserialize` and are
//! versioned by their field set -- a future schema change MUST be additive (new optional fields)
//! or accompanied by a migration, never a breaking rename. There is no `format`/`version` field
//! today because the Phase 0 shape is fixed by the pairing contract; adding one is a future task
//! if the credential format ever diverges.

use std::fs;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::pairing::{EdgeIdentity, EnrolledCredential};

/// The durable form of an `EdgeIdentity`: the installation ID it enrolled under plus the raw
/// 32-byte Ed25519 signing key seed. Serialized to `identity.json`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredIdentity {
    pub installation_id: String,
    /// Raw 32-byte Ed25519 signing key seed, hex-encoded so the JSON file is text-inspectable.
    /// `EdgeIdentity::from_signing_key_bytes` reconstructs the keypair from this.
    pub signing_key_hex: String,
}

/// Errors returned by the credential store. Kept as a single enum so the daemon can match on the
/// kind (missing file vs. corrupt file vs. I/O error) and decide whether to re-enroll or exit.
#[derive(Debug)]
pub enum CredentialStoreError {
    /// An I/O error occurred reading or writing the file. The underlying `io::Error` is preserved.
    Io(PathBuf, std::io::Error),
    /// The file exists but its JSON did not deserialize into the expected shape. The file is
    /// almost certainly corrupt or was hand-edited incorrectly; the daemon should re-enroll (for
    /// `credential.json`) or regenerate the identity (for `identity.json`) rather than trust a
    /// partial parse.
    Corrupt(PathBuf, serde_json::Error),
}

impl std::fmt::Display for CredentialStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(path, source) => {
                write!(f, "I/O error on {}: {source}", path.display())
            }
            Self::Corrupt(path, source) => {
                write!(f, "corrupt credential file {}: {source}", path.display())
            }
        }
    }
}

impl std::error::Error for CredentialStoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(_, source) => Some(source),
            Self::Corrupt(_, source) => Some(source),
        }
    }
}

/// The filename (relative to the data dir) under which the enrollment identity is stored.
pub const IDENTITY_FILENAME: &str = "identity.json";
/// The filename (relative to the data dir) under which the enrolled credential is stored.
pub const CREDENTIAL_FILENAME: &str = "credential.json";

/// Loads a stored identity from `data_dir/identity.json`, if present. Returns `Ok(None)` when the
/// file does not exist (a fresh install that has never enrolled) -- the caller should generate a
/// new identity in that case. Any other I/O or parse error is returned as `Err` so the caller can
/// decide whether to fail hard or regenerate.
pub fn load_identity(data_dir: &Path) -> Result<Option<StoredIdentity>, CredentialStoreError> {
    let path = data_dir.join(IDENTITY_FILENAME);
    load_json::<StoredIdentity>(&path)
}

/// Loads a stored credential from `data_dir/credential.json`, if present. Returns `Ok(None)` when
/// the file does not exist (the device has not yet enrolled, or its credential was revoked and the
/// file removed) -- the caller should enroll in that case.
pub fn load_credential(
    data_dir: &Path,
) -> Result<Option<EnrolledCredential>, CredentialStoreError> {
    let path = data_dir.join(CREDENTIAL_FILENAME);
    load_json::<EnrolledCredential>(&path)
}

/// Durably persists `identity` to `data_dir/identity.json` with `0600` permissions (owner-only
/// read/write) since it contains the raw Ed25519 signing key seed. The write is atomic-ish: write
/// to a sibling `.tmp` file then rename, so a crash mid-write leaves either the old file or the
/// new file, never a truncated mix.
pub fn save_identity(
    data_dir: &Path,
    identity: &StoredIdentity,
) -> Result<(), CredentialStoreError> {
    let path = data_dir.join(IDENTITY_FILENAME);
    save_json_secret(&path, identity)
}

/// Durably persists `credential` to `data_dir/credential.json`. The credential is a signed
/// document, not a secret key, so it is written with default file permissions (the data dir itself
/// is owner-only in a correct deployment) -- but the same atomic write-then-rename pattern is used
/// so a crash never leaves a truncated credential that would fail to parse on the next startup.
pub fn save_credential(
    data_dir: &Path,
    credential: &EnrolledCredential,
) -> Result<(), CredentialStoreError> {
    let path = data_dir.join(CREDENTIAL_FILENAME);
    save_json(&path, credential)
}

/// Removes `data_dir/credential.json`, if present. Used when the daemon detects the credential has
/// been revoked (e.g. the gateway rejected the hello with `unauthorized`) and must re-enroll with a
/// fresh invitation. A missing file is not an error -- the caller's intent is "ensure no credential
/// is cached", and that is satisfied either way.
pub fn delete_credential(data_dir: &Path) -> Result<(), CredentialStoreError> {
    let path = data_dir.join(CREDENTIAL_FILENAME);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(CredentialStoreError::Io(path, err)),
    }
}

/// Reconstructs an `EdgeIdentity` from a `StoredIdentity`. Decodes the hex signing key seed and
/// calls `EdgeIdentity::from_signing_key_bytes`. Returns `Err` if the hex is not 32 bytes -- this
/// indicates a corrupt `identity.json` and the caller should regenerate the identity (and
/// re-enroll, since a regenerated key has a different fingerprint).
pub fn identity_from_stored(stored: &StoredIdentity) -> Result<EdgeIdentity, CredentialStoreError> {
    let seed = decode_hex_32(&stored.signing_key_hex).map_err(|message| {
        // `serde_json::Error::custom` is exposed via `serde::de::Error::custom`; reuse it so the
        // error kind stays consistent with the `Corrupt` variant's existing `serde_json::Error`.
        use serde::de::Error as _;
        CredentialStoreError::Corrupt(
            PathBuf::from(IDENTITY_FILENAME),
            serde_json::Error::custom(message),
        )
    })?;
    Ok(EdgeIdentity::from_signing_key_bytes(
        stored.installation_id.clone(),
        seed,
    ))
}

/// Converts a live `EdgeIdentity` into its durable form.
pub fn identity_to_stored(identity: &EdgeIdentity) -> StoredIdentity {
    let signing_key_hex = encode_hex(&identity.signing_key_bytes());
    StoredIdentity {
        installation_id: identity.installation_id().to_string(),
        signing_key_hex,
    }
}

// --- internals -------------------------------------------------------------

fn load_json<T: serde::de::DeserializeOwned>(
    path: &Path,
) -> Result<Option<T>, CredentialStoreError> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(CredentialStoreError::Io(path.to_path_buf(), err)),
    };
    serde_json::from_str::<T>(&text)
        .map(Some)
        .map_err(|source| CredentialStoreError::Corrupt(path.to_path_buf(), source))
}

fn save_json(path: &Path, value: &impl Serialize) -> Result<(), CredentialStoreError> {
    let text = serde_json::to_string_pretty(value)
        .map_err(|source| CredentialStoreError::Corrupt(path.to_path_buf(), source))?;
    atomic_write(path, &text, /* mode = */ None)
}

fn save_json_secret(path: &Path, value: &impl Serialize) -> Result<(), CredentialStoreError> {
    let text = serde_json::to_string_pretty(value)
        .map_err(|source| CredentialStoreError::Corrupt(path.to_path_buf(), source))?;
    // 0o600: owner read/write only. The signing key seed is a secret at rest.
    atomic_write(path, &text, Some(0o600))
}

/// Writes `text` to `path` via a sibling `.tmp` file then rename, so a crash mid-write leaves
/// either the previous file or the new file, never a truncated mix. `mode` (when `Some`) is the
/// Unix file mode to set on the temp file before rename.
fn atomic_write(path: &Path, text: &str, mode: Option<u32>) -> Result<(), CredentialStoreError> {
    let tmp_path = path.with_extension("json.tmp");
    {
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        if let Some(mode) = mode {
            opts.mode(mode);
        }
        let mut file = opts
            .open(&tmp_path)
            .map_err(|err| CredentialStoreError::Io(tmp_path.clone(), err))?;
        file.write_all(text.as_bytes())
            .map_err(|err| CredentialStoreError::Io(tmp_path.clone(), err))?;
        file.sync_all()
            .map_err(|err| CredentialStoreError::Io(tmp_path.clone(), err))?;
    }
    fs::rename(&tmp_path, path).map_err(|err| CredentialStoreError::Io(path.to_path_buf(), err))
}

fn encode_hex(bytes: &[u8]) -> String {
    let mut hex = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

fn decode_hex_32(hex: &str) -> Result<[u8; 32], String> {
    if hex.len() != 64 {
        return Err(format!("expected 64 hex chars, got {}", hex.len()));
    }
    let mut out = [0u8; 32];
    for (i, chunk) in hex.as_bytes().chunks(2).enumerate() {
        let hi = hex_nibble(chunk[0])?;
        let lo = hex_nibble(chunk[1])?;
        out[i] = (hi << 4) | lo;
    }
    Ok(out)
}

fn hex_nibble(byte: u8) -> Result<u8, String> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        other => Err(format!("invalid hex nibble {other:#x}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pairing::EdgeIdentity;
    use crate::protocol::{
        DeviceCredential, DeviceCredentialDeviceId, DeviceCredentialEnvelope,
        DeviceCredentialEnvelopeSignature, DeviceCredentialInstallationId,
        DeviceCredentialIssuerId, DeviceCredentialPublicKeyFingerprint,
    };
    use serde_json::json;
    use std::num::NonZeroU64;
    use tempfile::tempdir;

    fn stored_identity_fixture() -> (EdgeIdentity, StoredIdentity) {
        let identity =
            EdgeIdentity::from_signing_key_bytes_for_test("installation-alpha", [7u8; 32]);
        let stored = identity_to_stored(&identity);
        (identity, stored)
    }

    fn canned_credential(identity: &EdgeIdentity) -> EnrolledCredential {
        let envelope = DeviceCredentialEnvelope {
            credential: DeviceCredential {
                device_id: DeviceCredentialDeviceId::try_from("device-test").unwrap(),
                expires_at_unix_ms: 1_815_976_442_000,
                format: json!("canvas-phase0-device-credential-v1"),
                installation_id: DeviceCredentialInstallationId::try_from("installation-alpha")
                    .unwrap(),
                issued_at_unix_ms: 1_784_440_442_000,
                issuer_id: DeviceCredentialIssuerId::try_from("canvas-core").unwrap(),
                public_key_fingerprint: DeviceCredentialPublicKeyFingerprint::try_from(
                    identity.public_key_fingerprint(),
                )
                .unwrap(),
                security_epoch: NonZeroU64::new(1).unwrap(),
                serial: NonZeroU64::new(1).unwrap(),
            },
            signature: DeviceCredentialEnvelopeSignature::try_from("cGhhdWRfc2lnbmF0dXJl").unwrap(),
            signer_public_key: None,
        };
        EnrolledCredential {
            envelope,
            installation_id: "installation-alpha".to_string(),
            public_key_fingerprint: identity.public_key_fingerprint(),
        }
    }

    #[test]
    fn load_identity_returns_none_when_no_file_exists() {
        let dir = tempdir().expect("tempdir");
        assert!(matches!(load_identity(dir.path()), Ok(None)));
    }

    #[test]
    fn save_then_load_identity_round_trips() {
        let dir = tempdir().expect("tempdir");
        let (identity, stored) = stored_identity_fixture();
        save_identity(dir.path(), &stored).expect("save");
        let loaded = load_identity(dir.path()).expect("load").expect("present");
        assert_eq!(loaded, stored);

        // And the stored identity reconstructs to the same keypair (same fingerprint).
        let restored = identity_from_stored(&loaded).expect("reconstruct");
        assert_eq!(
            restored.public_key_fingerprint(),
            identity.public_key_fingerprint()
        );
    }

    #[test]
    fn save_then_load_credential_round_trips() {
        let dir = tempdir().expect("tempdir");
        let (identity, _) = stored_identity_fixture();
        let credential = canned_credential(&identity);
        save_credential(dir.path(), &credential).expect("save");
        let loaded = load_credential(dir.path()).expect("load").expect("present");
        // The generated envelope does not derive PartialEq, so compare the round-trippable fields
        // individually rather than the whole struct.
        assert_eq!(loaded.installation_id, credential.installation_id);
        assert_eq!(
            loaded.public_key_fingerprint,
            credential.public_key_fingerprint
        );
        assert_eq!(
            loaded.envelope.credential.serial,
            credential.envelope.credential.serial
        );
        assert_eq!(
            loaded.envelope.signature.as_str(),
            credential.envelope.signature.as_str()
        );
    }

    #[test]
    fn load_credential_returns_none_when_no_file_exists() {
        let dir = tempdir().expect("tempdir");
        assert!(matches!(load_credential(dir.path()), Ok(None)));
    }

    #[test]
    fn delete_credential_is_idempotent_when_no_file_exists() {
        let dir = tempdir().expect("tempdir");
        delete_credential(dir.path()).expect("delete on missing file is not an error");
    }

    #[test]
    fn delete_credential_removes_an_existing_file() {
        let dir = tempdir().expect("tempdir");
        let (identity, stored) = stored_identity_fixture();
        save_identity(dir.path(), &stored).expect("save identity");
        let credential = canned_credential(&identity);
        save_credential(dir.path(), &credential).expect("save credential");
        delete_credential(dir.path()).expect("delete");
        assert!(matches!(load_credential(dir.path()), Ok(None)));
        // The identity file is untouched -- deleting the credential does not also delete the key.
        assert!(load_identity(dir.path()).expect("load identity").is_some());
    }

    #[test]
    fn corrupt_identity_file_surfaces_a_corrupt_error_not_silent_regenerate() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join(IDENTITY_FILENAME);
        fs::write(&path, "not valid json").expect("write");
        let err = load_identity(dir.path()).expect_err("corrupt file should error");
        assert!(matches!(err, CredentialStoreError::Corrupt(_, _)));
    }

    #[test]
    fn identity_file_is_written_with_owner_only_permissions() {
        // Unix-only check; on other platforms this test would need a different assertion. The
        // daemon runs on Linux (amd64/arm64) per the project's active platform scope.
        let dir = tempdir().expect("tempdir");
        let (_, stored) = stored_identity_fixture();
        save_identity(dir.path(), &stored).expect("save");
        let path = dir.path().join(IDENTITY_FILENAME);
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&path).expect("stat").permissions().mode();
        // 0o100600 = regular file + owner read/write only.
        assert_eq!(
            mode & 0o777,
            0o600,
            "identity.json must be owner-only (0600), got {mode:o}"
        );
    }

    #[test]
    fn identity_from_stored_rejects_a_bad_hex_seed() {
        let stored = StoredIdentity {
            installation_id: "installation-alpha".to_string(),
            signing_key_hex: "zz".to_string(),
        };
        assert!(identity_from_stored(&stored).is_err());
    }
}
