//! Startup enrollment orchestration: loads (or generates) the durable `EdgeIdentity`, loads (or
//! runs) the durable `EnrolledCredential`, and returns the `EdgeSessionOptions` fields the daemon
//! should feed into `EdgeSession` so `edge.hello` carries the enrolled identity.
//!
//! This module is the testable seam between the daemon's `main()` and the
//! `canvas_edge_agent::pairing` library: [`resolve_enrollment`] takes the daemon's config (data
//! dir, env-resolved invitation token, core HTTP URL, an injectable [`PairingHttpClient`]) and
//! returns an [`EnrollmentOutcome`] describing exactly what to put in `EdgeSessionOptions` and
//! whether enrollment was performed, skipped (no invitation configured), or loaded from disk.
//!
//! ## Why a separate module
//!
//! `main.rs` is intentionally thin and not unit-testable (it wires signal handling, the transport
//! thread, and the idle loop together with real OS resources). The enrollment decision tree --
//! "do we have a cached credential? do we have an invitation? do we need to enroll? what do we put
//! in the hello?" -- is the part that benefits from unit tests, so it lives here where a test can
//! drive it with a `FakePairingHttpClient` and a `tempfile` data dir.
//!
//! ## Blocking HTTP on a dedicated thread
//!
//! [`resolve_enrollment`] is synchronous and calls [`canvas_edge_agent::pairing::enroll`], which
//! uses `reqwest::blocking`. The daemon's `main()` runs this *before* spawning the transport
//! thread, so there is no tokio runtime on the calling thread to conflict with. If a future caller
//! wants to run this from inside a tokio context, it MUST spawn a dedicated `std::thread` first
//! (a blocking call inside a `current_thread` tokio runtime would stall it) -- see
//! `edge/agent/src/pairing/enrollment_client.rs`'s module docs for the rationale.

use std::path::Path;

use canvas_edge_agent::pairing::{
    self, credential_store, EnrolledCredential, PairingError, PairingHttpClient,
    RealPairingHttpClient,
};
use canvas_edge_agent::protocol::DeviceCredentialEnvelope;
use canvas_edge_agent::session::EdgeSessionOptions;

/// Environment variable holding the one-time invitation token the admin issued for this device.
/// When set and no durable credential is on disk, the daemon runs the enrollment handshake. When
/// unset, the daemon falls back to the legacy open-hello behavior (no `credential` /
/// `installation_id` / `public_key_fingerprint` in `edge.hello`).
pub const INVITATION_TOKEN_ENV: &str = "CANVAS_EDGE_INVITATION_TOKEN";

/// Environment variable holding Core's HTTP base URL (e.g. `https://core.canvas.invalid`). The
/// enrollment endpoints live at `${CANVAS_EDGE_CORE_HTTP_URL}/api/pairing/{begin,complete}`. When
/// unset, the daemon derives a default from `CANVAS_EDGE_CORE_WS_URL` if possible (see
/// [`derive_core_http_url`]); if that also fails, enrollment is skipped with a logged warning.
pub const CORE_HTTP_URL_ENV: &str = "CANVAS_EDGE_CORE_HTTP_URL";

/// The default installation ID the daemon enrolls under when `CANVAS_EDGE_INSTALLATION_ID` is
/// unset. This is a stable, non-authoritative identifier -- Core's real device identity is the
/// enrolled credential, not this string (plan doc §12.4) -- so a process-generated UUID is fine
/// for the bootstrap path. Production deployments SHOULD set `CANVAS_EDGE_INSTALLATION_ID` to a
/// stable, operator-chosen value so the registry row is human-meaningful.
pub const INSTALLATION_ID_ENV: &str = "CANVAS_EDGE_INSTALLATION_ID";

/// What [`resolve_enrollment`] decided to do, plus the fields the daemon should feed into
/// `EdgeSessionOptions`. The outcome is logged by `main()` so operators can see (in the journal)
/// whether a given startup enrolled, loaded a cached credential, or fell back to open hello.
#[derive(Debug, Clone)]
pub enum EnrollmentOutcome {
    /// No invitation token was configured and no durable credential was on disk. The daemon
    /// should send the legacy open `edge.hello` (no `credential` / `installation_id` /
    /// `public_key_fingerprint`). This is the dev/bootstrap path and is explicitly supported by
    /// Core when open pairing is ON.
    OpenHello {
        /// The identity the daemon generated (and persisted) for future enrollment, if any. The
        /// open hello does not carry this identity's claims, but persisting it means a later
        /// enrollment (after an admin issues an invitation) reuses the same key.
        installation_id: String,
    },
    /// A durable credential was loaded from `data_dir/credential.json`. The daemon should send an
    /// `edge.hello` carrying the `credential`, `installation_id`, and `public_key_fingerprint`.
    /// No HTTP call was made.
    LoadedFromDisk {
        installation_id: String,
        public_key_fingerprint: String,
        credential: DeviceCredentialEnvelope,
    },
    /// The daemon ran the two-step enrollment handshake against Core and received a fresh
    /// credential, which has been durably persisted to `data_dir/credential.json`. The daemon
    /// should send an `edge.hello` carrying the new `credential`, `installation_id`, and
    /// `public_key_fingerprint`.
    Enrolled {
        installation_id: String,
        public_key_fingerprint: String,
        credential: DeviceCredentialEnvelope,
    },
}

impl EnrollmentOutcome {
    /// Applies this outcome to `options`, setting the `credential` / `installation_id` /
    /// `public_key_fingerprint` fields the hello will carry. The caller is still responsible for
    /// setting `device_id` and the resume-cursor fields.
    pub fn apply_to(&self, options: &mut EdgeSessionOptions) {
        match self {
            Self::OpenHello { .. } => {
                // No enrollment claims -- the hello falls back to the legacy open shape.
            }
            Self::LoadedFromDisk {
                installation_id,
                public_key_fingerprint,
                credential,
            }
            | Self::Enrolled {
                installation_id,
                public_key_fingerprint,
                credential,
            } => {
                options.installation_id = Some(installation_id.clone());
                options.public_key_fingerprint = Some(public_key_fingerprint.clone());
                options.credential = Some(credential.clone());
            }
        }
    }

    /// Returns the installation ID the daemon enrolled under (or would enroll under), for logging.
    pub fn installation_id(&self) -> &str {
        match self {
            Self::OpenHello { installation_id } => installation_id,
            Self::LoadedFromDisk {
                installation_id, ..
            } => installation_id,
            Self::Enrolled {
                installation_id, ..
            } => installation_id,
        }
    }
}

/// Resolves the daemon's enrollment state at startup. The decision tree, in order:
///
/// 1. Load (or generate + persist) the durable `EdgeIdentity` from `data_dir/identity.json`. A
///    missing file is normal on first boot; a corrupt file is a hard error (the operator should
///    decide whether to delete it and re-enroll, not have the daemon silently regenerate a key
///    that orphans the existing registry row).
/// 2. Load any durable credential from `data_dir/credential.json`. If present, return
///    [`EnrollmentOutcome::LoadedFromDisk`] -- no HTTP call is made, the daemon reconnects with
///    the same identity it enrolled with before.
/// 3. If no durable credential is present AND no invitation token is configured, return
///    [`EnrollmentOutcome::OpenHello`] -- the daemon falls back to the legacy open-pairing path.
/// 4. If no durable credential is present AND an invitation token IS configured, run
///    [`pairing::enroll`] against `core_http_url`, persist the resulting credential, and return
///    [`EnrollmentOutcome::Enrolled`]. An enrollment failure is returned as `Err` so `main()` can
///    log it and decide whether to exit or fall back to open hello.
///
/// `http` is injectable so tests can drive the enrollment path with a `FakePairingHttpClient`;
/// production passes a `RealPairingHttpClient`.
pub fn resolve_enrollment(
    data_dir: &Path,
    installation_id: &str,
    invitation_token: Option<&str>,
    core_http_url: Option<&str>,
    http: &dyn PairingHttpClient,
) -> Result<EnrollmentOutcome, EnrollmentError> {
    // 1. Load or generate the identity.
    let identity = match credential_store::load_identity(data_dir)? {
        Some(stored) => credential_store::identity_from_stored(&stored)
            .map_err(EnrollmentError::CorruptIdentity)?,
        None => {
            let new_identity = pairing::EdgeIdentity::generate(installation_id);
            let stored = credential_store::identity_to_stored(&new_identity);
            credential_store::save_identity(data_dir, &stored)?;
            new_identity
        }
    };

    // 2. Cached credential?
    if let Some(credential) = credential_store::load_credential(data_dir)? {
        return Ok(EnrollmentOutcome::LoadedFromDisk {
            installation_id: credential.installation_id.clone(),
            public_key_fingerprint: credential.public_key_fingerprint.clone(),
            credential: credential.envelope,
        });
    }

    // 3. No credential + no invitation -> open hello.
    let invitation_token = match invitation_token {
        Some(token) if !token.is_empty() => token,
        _ => {
            return Ok(EnrollmentOutcome::OpenHello {
                installation_id: installation_id.to_string(),
            });
        }
    };

    // 4. No credential + invitation -> enroll. Need a Core HTTP URL.
    let core_http_url = match core_http_url {
        Some(url) if !url.is_empty() => url,
        _ => {
            return Err(EnrollmentError::MissingCoreHttpUrl);
        }
    };

    let enrolled = pairing::enroll(http, core_http_url, invitation_token, &identity)
        .map_err(EnrollmentError::Pairing)?;
    let EnrolledCredential {
        envelope,
        installation_id,
        public_key_fingerprint,
    } = enrolled;
    let to_store = EnrolledCredential {
        envelope: envelope.clone(),
        installation_id: installation_id.clone(),
        public_key_fingerprint: public_key_fingerprint.clone(),
    };
    credential_store::save_credential(data_dir, &to_store)?;

    Ok(EnrollmentOutcome::Enrolled {
        installation_id,
        public_key_fingerprint,
        credential: envelope,
    })
}

/// Errors returned by [`resolve_enrollment`]. Each variant carries enough context for `main()` to
/// log a precise, actionable failure.
#[derive(Debug)]
pub enum EnrollmentError {
    /// The credential store returned an I/O or parse error (see `CredentialStoreError`).
    Store(pairing::CredentialStoreError),
    /// `identity.json` exists but its signing key seed is corrupt (not 64 hex chars / not 32
    /// bytes). The operator should delete the file and re-enroll with a fresh invitation; the
    /// daemon must not silently regenerate a key that orphans the existing registry row.
    CorruptIdentity(pairing::CredentialStoreError),
    /// An invitation token was configured but no `CANVAS_EDGE_CORE_HTTP_URL` (or derivable WS URL)
    /// was available to POST the handshake to.
    MissingCoreHttpUrl,
    /// The HTTP handshake itself failed (invitation expired, signature rejected, network error,
    /// etc.). See `PairingError` for the per-case detail.
    Pairing(PairingError),
}

impl std::fmt::Display for EnrollmentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(err) => write!(f, "credential store error: {err}"),
            Self::CorruptIdentity(err) => {
                write!(
                    f,
                    "stored identity is corrupt; delete identity.json and re-enroll: {err}"
                )
            }
            Self::MissingCoreHttpUrl => write!(
                f,
                "an invitation token was configured but no Core HTTP URL was available \
                 (set {CORE_HTTP_URL_ENV} or {CORE_WS_URL_ENV})"
            ),
            Self::Pairing(err) => write!(f, "enrollment handshake failed: {err}"),
        }
    }
}

impl std::error::Error for EnrollmentError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Store(err) | Self::CorruptIdentity(err) => Some(err),
            Self::Pairing(err) => Some(err),
            _ => None,
        }
    }
}

impl From<pairing::CredentialStoreError> for EnrollmentError {
    fn from(err: pairing::CredentialStoreError) -> Self {
        Self::Store(err)
    }
}

/// The WebSocket URL env var, used by [`derive_core_http_url`]. Mirrors the constant in `main.rs`;
/// re-declared here so this module is self-contained and testable without depending on `main.rs`'s
/// private items.
pub const CORE_WS_URL_ENV: &str = "CANVAS_EDGE_CORE_WS_URL";

/// Derives a Core HTTP base URL from a WebSocket URL by swapping the scheme (`wss://` -> `https://`,
/// `ws://` -> `http://`) and stripping the current `/gateway/v1` path suffix (or the legacy
/// `/agent/v1` suffix). Returns `None` if the input is not a recognizable Core WS URL.
///
/// Examples:
/// - `wss://core.canvas.invalid/gateway/v1` -> `https://core.canvas.invalid`
/// - `ws://localhost:3100/agent/v1` -> `http://localhost:3100` (legacy)
/// - `wss://core.canvas.invalid/other` -> `None` (path suffix not recognized)
/// - `garbage` -> `None`
pub fn derive_core_http_url(ws_url: &str) -> Option<String> {
    let (scheme, rest) = if let Some(rest) = ws_url.strip_prefix("wss://") {
        ("https://", rest)
    } else if let Some(rest) = ws_url.strip_prefix("ws://") {
        ("http://", rest)
    } else {
        return None;
    };
    let rest = rest
        .strip_suffix("/gateway/v1")
        .or_else(|| rest.strip_suffix("/agent/v1"))?;
    Some(format!("{scheme}{rest}"))
}

/// Reads the Core HTTP URL from `CANVAS_EDGE_CORE_HTTP_URL`, falling back to deriving it from
/// `CANVAS_EDGE_CORE_WS_URL` via [`derive_core_http_url`]. Returns `None` if neither is set or
/// the WS URL is not a recognizable Core WS URL.
pub fn resolve_core_http_url() -> Option<String> {
    if let Ok(value) = std::env::var(CORE_HTTP_URL_ENV) {
        if !value.is_empty() {
            return Some(value);
        }
    }
    if let Ok(value) = std::env::var(CORE_WS_URL_ENV) {
        if !value.is_empty() {
            return derive_core_http_url(&value);
        }
    }
    None
}

/// Reads the configured installation ID, falling back to a process-stable random UUIDv4 when
/// `CANVAS_EDGE_INSTALLATION_ID` is unset. Mirrors `main.rs`'s `generate_device_id` shape (real
/// random UUIDv4, no seeded/test path) so a fresh install without a configured installation ID
/// still has a stable-for-this-process identifier.
pub fn resolve_installation_id() -> String {
    if let Ok(value) = std::env::var(INSTALLATION_ID_ENV) {
        if !value.is_empty() {
            return value;
        }
    }
    generate_uuid_v4()
}

fn generate_uuid_v4() -> String {
    use rand::rngs::OsRng;
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
    uuid::Uuid::from_bytes(bytes).to_string()
}

/// Convenience wrapper for `main()` that uses a real HTTP client and reads env vars itself. This
/// keeps `main()` thin: one call that returns the outcome or an error to log.
pub fn resolve_enrollment_with_real_http(
    data_dir: &Path,
    http: &RealPairingHttpClient,
) -> Result<EnrollmentOutcome, EnrollmentError> {
    let installation_id = resolve_installation_id();
    let invitation_token = std::env::var(INVITATION_TOKEN_ENV).ok();
    let core_http_url = resolve_core_http_url();
    resolve_enrollment(
        data_dir,
        &installation_id,
        invitation_token.as_deref(),
        core_http_url.as_deref(),
        http,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use canvas_edge_agent::pairing::{EdgeIdentity, FakePairingHttpClient};
    use canvas_edge_agent::protocol::{
        DeviceCredential, DeviceCredentialDeviceId, DeviceCredentialEnvelope,
        DeviceCredentialEnvelopeSignature, DeviceCredentialInstallationId,
        DeviceCredentialIssuerId, DeviceCredentialPublicKeyFingerprint,
    };
    use serde_json::{json, Value};
    use std::num::NonZeroU64;
    use tempfile::tempdir;

    fn identity_fixture(installation_id: &str) -> EdgeIdentity {
        EdgeIdentity::from_signing_key_bytes_for_test(installation_id, [7u8; 32])
    }

    fn canned_credential_response(identity: &EdgeIdentity) -> Value {
        json!({
            "credential": {
                "format": "canvas-phase0-device-credential-v1",
                "serial": 1,
                "device_id": "device-test-uuid",
                "installation_id": identity.installation_id(),
                "public_key_fingerprint": identity.public_key_fingerprint(),
                "issued_at_unix_ms": 1_784_440_442_000_i64,
                "expires_at_unix_ms": 1_815_976_442_000_i64,
                "issuer_id": "canvas-core",
                "security_epoch": 1,
            },
            "signature": "cGhhdWRfc2lnbmF0dXJl",
            "signer_public_key": "Y29yZV9wdWJsaWNfa2V5",
        })
    }

    /// Pre-seeds `data_dir/identity.json` with a known identity so `resolve_enrollment` reuses it
    /// rather than generating a fresh one. Returns the identity for the test to assert against.
    fn seed_identity(data_dir: &Path, identity: &EdgeIdentity) {
        let stored = credential_store::identity_to_stored(identity);
        credential_store::save_identity(data_dir, &stored).expect("seed identity");
    }

    /// Pre-seeds `data_dir/credential.json` with a canned credential so `resolve_enrollment` loads
    /// it from disk rather than enrolling.
    fn seed_credential(data_dir: &Path, identity: &EdgeIdentity) {
        let envelope = DeviceCredentialEnvelope {
            credential: DeviceCredential {
                device_id: DeviceCredentialDeviceId::try_from("device-test").unwrap(),
                expires_at_unix_ms: 1_815_976_442_000,
                format: json!("canvas-phase0-device-credential-v1"),
                installation_id: DeviceCredentialInstallationId::try_from(
                    identity.installation_id(),
                )
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
        let enrolled = EnrolledCredential {
            envelope,
            installation_id: identity.installation_id().to_string(),
            public_key_fingerprint: identity.public_key_fingerprint(),
        };
        credential_store::save_credential(data_dir, &enrolled).expect("seed credential");
    }

    #[test]
    fn no_invitation_and_no_credential_falls_back_to_open_hello() {
        let dir = tempdir().expect("tempdir");
        let http = FakePairingHttpClient::new();
        let outcome = resolve_enrollment(
            dir.path(),
            "installation-alpha",
            None,
            Some("https://core.example.invalid"),
            &http,
        )
        .expect("open hello path should succeed");

        match outcome {
            EnrollmentOutcome::OpenHello { installation_id } => {
                assert_eq!(installation_id, "installation-alpha");
            }
            other => panic!("expected OpenHello, got {other:?}"),
        }

        // No HTTP calls were made.
        assert!(http.request_bodies().is_empty());
        // But the identity WAS persisted, so a later enrollment reuses the same key.
        assert!(credential_store::load_identity(dir.path())
            .expect("load")
            .is_some());
    }

    #[test]
    fn empty_invitation_string_is_treated_as_unset() {
        let dir = tempdir().expect("tempdir");
        let http = FakePairingHttpClient::new();
        let outcome = resolve_enrollment(
            dir.path(),
            "installation-alpha",
            Some(""),
            Some("https://core.example.invalid"),
            &http,
        )
        .expect("empty invitation -> open hello");
        assert!(matches!(outcome, EnrollmentOutcome::OpenHello { .. }));
        assert!(http.request_bodies().is_empty());
    }

    #[test]
    fn cached_credential_is_loaded_from_disk_without_enrolling() {
        let dir = tempdir().expect("tempdir");
        let identity = identity_fixture("installation-alpha");
        seed_identity(dir.path(), &identity);
        seed_credential(dir.path(), &identity);

        let http = FakePairingHttpClient::new();
        let outcome = resolve_enrollment(
            dir.path(),
            "installation-alpha",
            Some("unused-invitation-token"),
            Some("https://core.example.invalid"),
            &http,
        )
        .expect("cached credential should load");

        match outcome {
            EnrollmentOutcome::LoadedFromDisk {
                installation_id,
                public_key_fingerprint,
                ..
            } => {
                assert_eq!(installation_id, "installation-alpha");
                assert_eq!(public_key_fingerprint, identity.public_key_fingerprint());
            }
            other => panic!("expected LoadedFromDisk, got {other:?}"),
        }

        // No HTTP calls -- the cached credential short-circuits the handshake.
        assert!(http.request_bodies().is_empty());
    }

    #[test]
    fn invitation_with_no_credential_runs_enrollment_and_persists_the_result() {
        let dir = tempdir().expect("tempdir");
        let identity = identity_fixture("installation-alpha");
        seed_identity(dir.path(), &identity);

        let http = FakePairingHttpClient::new();
        http.enqueue_ok(json!({
            "challenge_id": "challenge-abc123",
            "nonce_hex": "deadbeefcafebabe",
            "expires_at_unix_ms": 1_784_440_445_000_i64,
        }));
        http.enqueue_ok(canned_credential_response(&identity));

        let outcome = resolve_enrollment(
            dir.path(),
            "installation-alpha",
            Some("inv-token-xyz"),
            Some("https://core.example.invalid"),
            &http,
        )
        .expect("enrollment should succeed");

        let (installation_id, public_key_fingerprint) = match outcome {
            EnrollmentOutcome::Enrolled {
                installation_id,
                public_key_fingerprint,
                ..
            } => (installation_id, public_key_fingerprint),
            other => panic!("expected Enrolled, got {other:?}"),
        };
        assert_eq!(installation_id, "installation-alpha");
        assert_eq!(public_key_fingerprint, identity.public_key_fingerprint());

        // The credential was persisted -- a second resolve_enrollment call loads from disk and
        // makes no HTTP calls.
        let http2 = FakePairingHttpClient::new();
        let outcome2 = resolve_enrollment(
            dir.path(),
            "installation-alpha",
            Some("inv-token-xyz"),
            Some("https://core.example.invalid"),
            &http2,
        )
        .expect("second call should load from disk");
        assert!(matches!(outcome2, EnrollmentOutcome::LoadedFromDisk { .. }));
        assert!(http2.request_bodies().is_empty());
    }

    #[test]
    fn invitation_with_no_core_http_url_errors_rather_than_silently_skipping() {
        let dir = tempdir().expect("tempdir");
        let identity = identity_fixture("installation-alpha");
        seed_identity(dir.path(), &identity);

        let http = FakePairingHttpClient::new();
        let err = resolve_enrollment(
            dir.path(),
            "installation-alpha",
            Some("inv-token-xyz"),
            None,
            &http,
        )
        .expect_err("missing Core HTTP URL should error");
        assert!(matches!(err, EnrollmentError::MissingCoreHttpUrl));
    }

    #[test]
    fn enrollment_handshake_failure_surfaces_the_pairing_error() {
        let dir = tempdir().expect("tempdir");
        let identity = identity_fixture("installation-alpha");
        seed_identity(dir.path(), &identity);

        let http = FakePairingHttpClient::new();
        // Core rejects the invitation at begin (e.g. expired).
        http.enqueue_error(409, json!({ "error": "invitation_expired" }));

        let err = resolve_enrollment(
            dir.path(),
            "installation-alpha",
            Some("stale-token"),
            Some("https://core.example.invalid"),
            &http,
        )
        .expect_err("expired invitation should fail closed");
        assert!(matches!(err, EnrollmentError::Pairing(_)));

        // No credential was persisted (the handshake failed).
        assert!(credential_store::load_credential(dir.path())
            .expect("load")
            .is_none());
    }

    #[test]
    fn first_boot_generates_and_persists_a_new_identity() {
        let dir = tempdir().expect("tempdir");
        let http = FakePairingHttpClient::new();

        // No invitation -> open hello, but the identity is still generated + persisted.
        let outcome = resolve_enrollment(
            dir.path(),
            "installation-alpha",
            None,
            Some("https://core.example.invalid"),
            &http,
        )
        .expect("open hello");
        assert!(matches!(outcome, EnrollmentOutcome::OpenHello { .. }));

        let stored = credential_store::load_identity(dir.path())
            .expect("load")
            .expect("identity was persisted");
        assert_eq!(stored.installation_id, "installation-alpha");
        assert_eq!(stored.signing_key_hex.len(), 64);
    }

    #[test]
    fn apply_to_sets_the_session_options_for_an_enrolled_outcome() {
        let identity = identity_fixture("installation-alpha");
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
        let outcome = EnrollmentOutcome::Enrolled {
            installation_id: "installation-alpha".to_string(),
            public_key_fingerprint: identity.public_key_fingerprint(),
            credential: envelope.clone(),
        };

        let mut options = EdgeSessionOptions::default();
        outcome.apply_to(&mut options);
        assert_eq!(
            options.installation_id.as_deref(),
            Some("installation-alpha")
        );
        assert_eq!(
            options.public_key_fingerprint.as_deref(),
            Some(identity.public_key_fingerprint().as_str())
        );
        assert!(options.credential.is_some());
    }

    #[test]
    fn apply_to_leaves_options_empty_for_an_open_hello_outcome() {
        let outcome = EnrollmentOutcome::OpenHello {
            installation_id: "installation-alpha".to_string(),
        };
        let mut options = EdgeSessionOptions {
            device_id: Some("dev-hint".to_string()),
            ..Default::default()
        };
        outcome.apply_to(&mut options);
        assert!(options.credential.is_none());
        assert!(options.installation_id.is_none());
        assert!(options.public_key_fingerprint.is_none());
        // device_id is untouched -- apply_to only manages the enrollment claims.
        assert_eq!(options.device_id.as_deref(), Some("dev-hint"));
    }

    #[test]
    fn derive_core_http_url_swaps_scheme_and_strips_known_gateway_suffixes() {
        assert_eq!(
            derive_core_http_url("wss://core.canvas.invalid/gateway/v1"),
            Some("https://core.canvas.invalid".to_string())
        );
        assert_eq!(
            derive_core_http_url("ws://localhost:3100/gateway/v1"),
            Some("http://localhost:3100".to_string())
        );
        assert_eq!(
            derive_core_http_url("wss://core.canvas.invalid/agent/v1"),
            Some("https://core.canvas.invalid".to_string())
        );
        assert_eq!(
            derive_core_http_url("ws://localhost:3100/agent/v1"),
            Some("http://localhost:3100".to_string())
        );
        assert_eq!(
            derive_core_http_url("wss://core.canvas.invalid/other"),
            None
        );
        assert_eq!(derive_core_http_url("garbage"), None);
    }
}
