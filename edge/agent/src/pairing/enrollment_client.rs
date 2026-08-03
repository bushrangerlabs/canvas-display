//! HTTP client that performs the two-step P-003 enrollment handshake against Canvas Core's
//! `/api/pairing/begin` and `/api/pairing/complete` endpoints (see
//! `docs/PAIRING_ENROLLMENT_CONTRACT.md` for the exact wire shapes).
//!
//! This is the real production counterpart to the in-process `canvas-dev-gateway-harness` exercise
//! in `tests/pairing_v1.rs`: it takes a loaded `EdgeIdentity`, presents its public key + an
//! invitation token to Core, signs the returned challenge with
//! [`super::EdgeIdentity::answer_enrollment_challenge`], and submits the proof to receive a signed
//! `DeviceCredentialEnvelope` (the Phase 0 credential the gateway's auth gate checks).
//!
//! ## Blocking, not async
//!
//! The HTTP calls use `reqwest::blocking` (with `rustls-tls`, matching `edge/updater/src/fetch.rs`'s
//! TLS choice) so this module stays synchronous, exactly like the rest of `canvas-edge-agent`
//! outside the WS transport thread. `canvas-edge-agentd` runs [`enroll`] on a plain `std::thread`
//! *before* spawning the transport thread -- this keeps `tokio` confined to the single WS runtime
//! (ADR 0009) and avoids any runtime-nesting hazard. A blocking call on the transport thread would
//! stall WebSocket I/O; a blocking call on the main thread would delay signal handling; a dedicated
//! short-lived `std::thread` avoids both.
//!
//! ## Injectable transport
//!
//! [`PairingHttpClient`] is the injectable seam: production code uses [`RealPairingHttpClient`]
//! (wrapping `reqwest::blocking::Client`), tests use [`FakePairingHttpClient`] to exercise the
//! handshake without any real network access. This mirrors `edge/updater/src/fetch.rs`'s
//! `HttpClient`/`RealHttpClient`/`FakeHttpClient` convention.

use std::error::Error;
use std::fmt;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::pairing::{EdgeIdentity, EnrollmentChallenge};
use crate::protocol::DeviceCredentialEnvelope;

/// The path of the `begin` endpoint relative to Core's HTTP base URL.
pub const BEGIN_PATH: &str = "/api/pairing/begin";
/// The path of the `complete` endpoint relative to Core's HTTP base URL.
pub const COMPLETE_PATH: &str = "/api/pairing/complete";

/// How long the blocking HTTP client waits for a single request (connect + headers + body). The
/// enrollment handshake is two short JSON round trips, so a 30-second bound is generous but finite
/// -- a hung Core should not pin the daemon's startup forever.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// An injectable HTTP transport for the enrollment handshake. Production uses
/// [`RealPairingHttpClient`]; tests use [`FakePairingHttpClient`]. Mirrors
/// `edge/updater/src/fetch.rs`'s `HttpClient` seam.
pub trait PairingHttpClient {
    /// POSTs `body` to `url` and returns the parsed JSON body on a 2xx response. A non-2xx
    /// response is returned as `Err(PairingError::BadStatus { ... })` with Core's JSON error body
    /// (if any) preserved in `body_text` for the caller to log.
    fn post_json(&self, url: &str, body: &Value) -> Result<Value, PairingError>;
}

/// Production HTTP client: a thin wrapper around `reqwest::blocking::Client` configured with
/// `rustls-tls` (see module docs for why not `native-tls`). Follows redirects up to reqwest's
/// default limit -- Core's enrollment routes do not redirect, so a redirect here is almost
/// certainly a misconfigured reverse proxy and the resulting non-2xx will surface as a
/// `PairingError::BadStatus`.
#[derive(Debug, Clone)]
pub struct RealPairingHttpClient {
    client: reqwest::blocking::Client,
}

impl Default for RealPairingHttpClient {
    fn default() -> Self {
        Self::new()
    }
}

impl RealPairingHttpClient {
    /// Constructs a real blocking HTTP client with rustls TLS and a kiosk-appropriate timeout.
    pub fn new() -> Self {
        let client = reqwest::blocking::Client::builder()
            .use_rustls_tls()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .expect("reqwest blocking client with rustls builds with no system dependencies");
        Self { client }
    }
}

impl PairingHttpClient for RealPairingHttpClient {
    fn post_json(&self, url: &str, body: &Value) -> Result<Value, PairingError> {
        let body_bytes = serde_json::to_vec(body).map_err(|source| PairingError::BadJson {
            url: url.to_string(),
            body_text: "<request body>".to_string(),
            source,
        })?;
        let response = self
            .client
            .post(url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body_bytes)
            .send()
            .map_err(|source| PairingError::HttpFailed {
                url: url.to_string(),
                source,
            })?;
        let status = response.status().as_u16();
        let body_text = response.text().unwrap_or_default();
        if !(200..300).contains(&status) {
            return Err(PairingError::BadStatus {
                url: url.to_string(),
                status,
                body_text,
            });
        }
        serde_json::from_str::<Value>(&body_text).map_err(|source| PairingError::BadJson {
            url: url.to_string(),
            body_text,
            source,
        })
    }
}

/// Errors returned by the enrollment handshake. Each variant carries enough context (URL, status,
/// Core's error body) for the daemon to log a precise, actionable failure rather than a bare
/// "enrollment failed".
#[derive(Debug)]
pub enum PairingError {
    /// `reqwest` itself failed (DNS, connect, TLS, read timeout, etc.) before any HTTP status was
    /// received.
    HttpFailed { url: String, source: reqwest::Error },
    /// Core returned a non-2xx status. `body_text` is Core's JSON error body (e.g.
    /// `{"error":"invitation_expired","detail":"..."}`) preserved verbatim so the daemon can log
    /// the exact fail-closed reason.
    BadStatus {
        url: String,
        status: u16,
        body_text: String,
    },
    /// Core returned a 2xx but the body was not valid JSON or did not match the expected shape.
    BadJson {
        url: String,
        body_text: String,
        source: serde_json::Error,
    },
    /// Core's response was valid JSON but was missing a required field or had a field of the wrong
    /// type. `field` names the first field that failed to parse.
    MissingField { field: &'static str },
}

impl fmt::Display for PairingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::HttpFailed { url, source } => {
                write!(f, "HTTP request to {url} failed: {source}")
            }
            Self::BadStatus {
                url,
                status,
                body_text,
            } => write!(f, "Core returned status {status} from {url}: {body_text}"),
            Self::BadJson {
                url,
                body_text,
                source,
            } => write!(
                f,
                "Core returned malformed JSON from {url}: {source}; body was: {body_text}"
            ),
            Self::MissingField { field } => {
                write!(f, "Core's response was missing required field `{field}`")
            }
        }
    }
}

impl Error for PairingError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::HttpFailed { source, .. } => Some(source),
            Self::BadJson { source, .. } => Some(source),
            _ => None,
        }
    }
}

/// The parsed `/api/pairing/begin` response body.
#[derive(Clone, Debug, Deserialize)]
struct BeginResponse {
    challenge_id: String,
    nonce_hex: String,
    expires_at_unix_ms: i64,
}

/// The durable result of a successful enrollment: the signed credential envelope (which the
/// `edge.hello` carries verbatim) plus the `installation_id` and `public_key_fingerprint` the
/// daemon also echoes into the hello so the gateway can match the hello to the registry by either
/// path. Serialized to `credential.json` in the data dir by `canvas-edge-agentd` so reconnection
/// does not re-enroll.
///
/// Does not derive `PartialEq`/`Eq` because the generated `DeviceCredentialEnvelope` (and the
/// newtype wrappers it contains) does not derive them either; tests compare the relevant fields
/// directly instead.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EnrolledCredential {
    /// The signed credential envelope, exactly as Core returned it. Serialized verbatim into
    /// `edge.hello.credential` on every reconnect.
    pub envelope: DeviceCredentialEnvelope,
    /// The installation ID the identity enrolled under. Echoed into `edge.hello.installation_id`.
    pub installation_id: String,
    /// The SHA-256 hex of the identity's raw public key. Echoed into
    /// `edge.hello.public_key_fingerprint` and also recoverable from
    /// `envelope.credential.public_key_fingerprint`; stored separately so the daemon can log it
    /// without deserializing the envelope.
    pub public_key_fingerprint: String,
}

/// Performs the two-step P-003 enrollment handshake against Core.
///
/// 1. `POST /api/pairing/begin` with `{ invitation_token, installation_id, public_key }` (the
///    public key is the raw 32-byte Ed25519 key, lowercase hex -- the canonical encoding Core's
///    `decodeFixedBytes` accepts).
/// 2. Calls `identity.answer_enrollment_challenge(&challenge)` to sign the canonical
///    proof-of-possession payload.
/// 3. `POST /api/pairing/complete` with the proof (signature base64-encoded, matching the contract
///    example and `core/test/enrollment.test.ts`).
/// 4. Parses Core's `{ credential, signature, signer_public_key }` response into an
///    [`EnrolledCredential`] the daemon can persist and feed into `EdgeSessionOptions`.
///
/// `core_http_url` is the base URL of Core's HTTP listener (e.g. `https://core.canvas.invalid`) --
/// the daemon derives this from `CANVAS_EDGE_CORE_HTTP_URL` or by stripping the `/agent/v1` path
/// and `wss://`/`ws://` scheme off `CANVAS_EDGE_CORE_WS_URL`. The caller is responsible for that
/// derivation; this function only joins `BEGIN_PATH`/`COMPLETE_PATH` onto whatever base it gets.
pub fn enroll(
    http: &dyn PairingHttpClient,
    core_http_url: &str,
    invitation_token: &str,
    identity: &EdgeIdentity,
) -> Result<EnrolledCredential, PairingError> {
    let public_key_hex = encode_hex(&identity.public_key_bytes());
    let installation_id = identity.installation_id().to_string();

    // 1. begin
    let begin_url = format!("{}{}", core_http_url.trim_end_matches('/'), BEGIN_PATH);
    let begin_body = json!({
        "invitation_token": invitation_token,
        "installation_id": installation_id,
        "public_key": public_key_hex,
    });
    let begin_response = http.post_json(&begin_url, &begin_body)?;
    let begin_parsed: BeginResponse =
        serde_json::from_value(begin_response).map_err(|source| PairingError::BadJson {
            url: begin_url.clone(),
            body_text: "<parsed Value>".to_string(),
            source,
        })?;
    let challenge = EnrollmentChallenge {
        challenge_id: begin_parsed.challenge_id,
        nonce_hex: begin_parsed.nonce_hex,
        expires_at_unix_ms: begin_parsed.expires_at_unix_ms,
    };

    // 2. sign
    let proof = identity.answer_enrollment_challenge(&challenge);
    let signature_b64 = base64_encode(&proof.signature_bytes);

    // 3. complete
    let complete_url = format!("{}{}", core_http_url.trim_end_matches('/'), COMPLETE_PATH);
    let complete_body = json!({
        "invitation_token": invitation_token,
        "installation_id": installation_id,
        "public_key": public_key_hex,
        "challenge_id": challenge.challenge_id,
        "proof": {
            "challenge_id": proof.challenge_id,
            "signature_bytes": signature_b64,
        },
    });
    let complete_response = http.post_json(&complete_url, &complete_body)?;

    // 4. parse into the durable envelope. Core returns
    // `{ credential: {...}, signature: "<base64>", signer_public_key: "<base64>" }`; the generated
    // `DeviceCredentialEnvelope` has exactly this shape (with `signer_public_key` optional), so we
    // deserialize the whole response directly into it.
    let envelope: DeviceCredentialEnvelope =
        serde_json::from_value(complete_response).map_err(|source| PairingError::BadJson {
            url: complete_url.clone(),
            body_text: "<parsed Value>".to_string(),
            source,
        })?;

    Ok(EnrolledCredential {
        envelope,
        installation_id,
        public_key_fingerprint: identity.public_key_fingerprint(),
    })
}

/// Lowercase hex encoding of `bytes`. Mirrors `super::fingerprint_hex`'s per-byte formatting rather
/// than pulling in a `hex` crate dependency, keeping the agent's dependency surface minimal.
fn encode_hex(bytes: &[u8]) -> String {
    let mut hex = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// Standard base64 (no padding) encoding of `bytes` for the `proof.signature_bytes` field. Core's
/// `decodeFixedBytes` accepts either hex or base64 for the signature; base64 matches the contract
/// example and `core/test/enrollment.test.ts`'s `answerChallenge` helper, so we use it here for
/// wire-shape parity with the reference test.
fn base64_encode(bytes: &[u8]) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine};
    STANDARD.encode(bytes)
}

/// Test-only [`PairingHttpClient`] that returns queued, injected responses in order. Each call to
/// `post_json` pops the next [`FakeResponse`] from the queue. This is what makes it possible to
/// exercise the full begin→sign→complete flow without any real network access, and to assert that
/// the proof submission matches the expected shape (the fake records each request body for the
/// test to inspect).
#[derive(Debug, Default)]
pub struct FakePairingHttpClient {
    responses: std::sync::Mutex<Vec<FakeResponse>>,
    requests: std::sync::Mutex<Vec<Value>>,
}

/// A queued response for [`FakePairingHttpClient`]. `Ok(body)` yields a 200 with that JSON body;
/// `Err(body_text)` yields a 400 with that text body (so fail-closed paths can be exercised).
#[derive(Debug, Clone)]
pub struct FakeResponse {
    pub status: u16,
    pub body: Value,
}

impl FakePairingHttpClient {
    pub fn new() -> Self {
        Self::default()
    }

    /// Queues a 200 response with `body` to be returned by the next `post_json` call.
    pub fn enqueue_ok(&self, body: Value) -> &Self {
        self.responses
            .lock()
            .expect("fake client mutex")
            .push(FakeResponse { status: 200, body });
        self
    }

    /// Queues a non-2xx response with `body` as the raw text body (Core's error JSON).
    pub fn enqueue_error(&self, status: u16, body: Value) -> &Self {
        self.responses
            .lock()
            .expect("fake client mutex")
            .push(FakeResponse { status, body });
        self
    }

    /// Returns the request bodies `post_json` has seen, in order. Tests use this to assert that the
    /// `complete` request carried the expected `proof.signature_bytes` and `challenge_id`.
    pub fn request_bodies(&self) -> Vec<Value> {
        self.requests.lock().expect("fake client mutex").clone()
    }
}

impl PairingHttpClient for FakePairingHttpClient {
    fn post_json(&self, url: &str, body: &Value) -> Result<Value, PairingError> {
        self.requests
            .lock()
            .expect("fake client mutex")
            .push(body.clone());
        let mut queue = self.responses.lock().expect("fake client mutex");
        if queue.is_empty() {
            return Err(PairingError::BadStatus {
                url: url.to_string(),
                status: 599,
                body_text: "fake client queue exhausted".to_string(),
            });
        }
        let response = queue.remove(0);
        drop(queue);
        if !(200..300).contains(&response.status) {
            return Err(PairingError::BadStatus {
                url: url.to_string(),
                status: response.status,
                body_text: response.body.to_string(),
            });
        }
        Ok(response.body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pairing::EdgeIdentity;
    use crate::protocol::{
        DeviceCredential, DeviceCredentialDeviceId, DeviceCredentialEnvelopeSignature,
        DeviceCredentialInstallationId, DeviceCredentialIssuerId,
        DeviceCredentialPublicKeyFingerprint,
    };
    use serde_json::json;
    use std::num::NonZeroU64;

    /// Builds a canned `DeviceCredentialEnvelope` matching Core's response shape, with the
    /// fingerprint the test identity actually computes so the round-trip is realistic.
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
            "signature": "cGhhdWRfc2lnbmF0dXJl", // placeholder base64; the fake does not verify it
            "signer_public_key": "Y29yZV9wdWJsaWNfa2V5",
        })
    }

    #[test]
    fn enroll_round_trips_begin_sign_complete_and_returns_the_credential() {
        let identity =
            EdgeIdentity::from_signing_key_bytes_for_test("installation-alpha", [7u8; 32]);
        let http = FakePairingHttpClient::new();
        http.enqueue_ok(json!({
            "challenge_id": "challenge-abc123",
            "nonce_hex": "deadbeefcafebabe",
            "expires_at_unix_ms": 1_784_440_445_000_i64,
        }));
        http.enqueue_ok(canned_credential_response(&identity));

        let enrolled = enroll(
            &http,
            "https://core.example.invalid",
            "inv-token-xyz",
            &identity,
        )
        .expect("happy path enrollment should succeed");

        // The returned credential carries the identity's installation_id and fingerprint.
        assert_eq!(enrolled.installation_id, "installation-alpha");
        assert_eq!(
            enrolled.public_key_fingerprint,
            identity.public_key_fingerprint()
        );
        assert_eq!(
            enrolled.envelope.credential.serial,
            NonZeroU64::new(1).unwrap()
        );

        // Two POSTs were made, in order: begin then complete.
        let requests = http.request_bodies();
        assert_eq!(requests.len(), 2);

        // The begin request shape matches the contract.
        let begin = &requests[0];
        assert_eq!(begin["invitation_token"], "inv-token-xyz");
        assert_eq!(begin["installation_id"], "installation-alpha");
        assert_eq!(
            begin["public_key"],
            encode_hex(&identity.public_key_bytes())
        );

        // The complete request shape matches the contract, including the proof block.
        let complete = &requests[1];
        assert_eq!(complete["invitation_token"], "inv-token-xyz");
        assert_eq!(complete["installation_id"], "installation-alpha");
        assert_eq!(complete["challenge_id"], "challenge-abc123");
        assert_eq!(complete["proof"]["challenge_id"], "challenge-abc123");
        // signature_bytes is base64 of the real Ed25519 signature over the canonical payload.
        let sig_b64 = complete["proof"]["signature_bytes"].as_str().unwrap();
        let sig_bytes = base64_decode(sig_b64);
        assert_eq!(sig_bytes.len(), 64);

        // The signature actually verifies against the identity's public key over the canonical
        // payload -- proving the client signs byte-identically to what Core verifies.
        use ed25519_dalek::{Signature, Verifier};
        let verifying_key = crate::pairing::verifying_key_from_bytes(&identity.public_key_bytes())
            .expect("valid verifying key");
        let payload = crate::pairing::build_enrollment_proof_payload(
            "challenge-abc123",
            "deadbeefcafebabe",
            "installation-alpha",
            &identity.public_key_fingerprint(),
        );
        let signature = Signature::from_bytes(&{
            let mut arr = [0u8; 64];
            arr.copy_from_slice(&sig_bytes);
            arr
        });
        assert!(verifying_key.verify(&payload, &signature).is_ok());
    }

    #[test]
    fn enroll_surfaces_a_begin_fail_closed_error_without_calling_complete() {
        let identity =
            EdgeIdentity::from_signing_key_bytes_for_test("installation-alpha", [7u8; 32]);
        let http = FakePairingHttpClient::new();
        // Core rejects the invitation at begin (e.g. expired).
        http.enqueue_error(409, json!({ "error": "invitation_expired" }));

        let err = enroll(
            &http,
            "https://core.example.invalid",
            "stale-token",
            &identity,
        )
        .expect_err("an expired invitation should fail closed");

        match err {
            PairingError::BadStatus {
                status, body_text, ..
            } => {
                assert_eq!(status, 409);
                assert!(body_text.contains("invitation_expired"));
            }
            other => panic!("expected BadStatus, got {other:?}"),
        }

        // Only the begin POST was made -- the client must not submit a proof to a challenge that
        // was never issued.
        assert_eq!(http.request_bodies().len(), 1);
    }

    #[test]
    fn enroll_surfaces_a_complete_fail_closed_error() {
        let identity =
            EdgeIdentity::from_signing_key_bytes_for_test("installation-alpha", [7u8; 32]);
        let http = FakePairingHttpClient::new();
        http.enqueue_ok(json!({
            "challenge_id": "challenge-abc123",
            "nonce_hex": "deadbeefcafebabe",
            "expires_at_unix_ms": 1_784_440_445_000_i64,
        }));
        // Core rejects the proof (e.g. signature_invalid -- the invitation is now burned).
        http.enqueue_error(401, json!({ "error": "signature_invalid" }));

        let err = enroll(
            &http,
            "https://core.example.invalid",
            "inv-token-xyz",
            &identity,
        )
        .expect_err("an invalid proof should fail closed");

        match err {
            PairingError::BadStatus {
                status, body_text, ..
            } => {
                assert_eq!(status, 401);
                assert!(body_text.contains("signature_invalid"));
            }
            other => panic!("expected BadStatus, got {other:?}"),
        }

        // Both POSTs were made -- the client did submit the proof (Core burns the invitation on
        // the server side; the client cannot know in advance the proof would be rejected).
        assert_eq!(http.request_bodies().len(), 2);
    }

    #[test]
    fn enroll_rejects_a_malformed_begin_response() {
        let identity =
            EdgeIdentity::from_signing_key_bytes_for_test("installation-alpha", [7u8; 32]);
        let http = FakePairingHttpClient::new();
        // 200 but missing `nonce_hex`.
        http.enqueue_ok(json!({ "challenge_id": "challenge-abc123" }));

        let err = enroll(
            &http,
            "https://core.example.invalid",
            "inv-token-xyz",
            &identity,
        )
        .expect_err("a malformed begin response should error");
        assert!(matches!(err, PairingError::BadJson { .. }));
    }

    #[test]
    fn enrolled_credential_round_trips_through_json_storage() {
        let identity =
            EdgeIdentity::from_signing_key_bytes_for_test("installation-alpha", [7u8; 32]);
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
        let enrolled = EnrolledCredential {
            envelope,
            installation_id: "installation-alpha".to_string(),
            public_key_fingerprint: identity.public_key_fingerprint(),
        };

        let json_text = serde_json::to_string(&enrolled).expect("serializable");
        let parsed: EnrolledCredential = serde_json::from_str(&json_text).expect("deserializable");
        // The generated envelope does not derive PartialEq, so compare the round-trippable fields
        // individually rather than the whole struct.
        assert_eq!(parsed.installation_id, enrolled.installation_id);
        assert_eq!(
            parsed.public_key_fingerprint,
            enrolled.public_key_fingerprint
        );
        assert_eq!(
            parsed.envelope.credential.serial,
            enrolled.envelope.credential.serial
        );
        assert_eq!(
            parsed.envelope.signature.as_str(),
            enrolled.envelope.signature.as_str()
        );
        assert_eq!(
            parsed.envelope.credential.installation_id.as_str(),
            "installation-alpha"
        );
    }

    /// Helper for tests: standard base64 decode.
    fn base64_decode(s: &str) -> Vec<u8> {
        use base64::{engine::general_purpose::STANDARD, Engine};
        STANDARD.decode(s).expect("valid base64 in test")
    }
}
