//! Real HTTP/TLS artifact download for the updater, with streaming SHA-256 verification and
//! bounded retry with exponential backoff.
//!
//! This module is the networked counterpart to `rollout.rs`'s local-file "download" fallback.
//! `perform_rollout` decides which path to take based on whether the candidate source string
//! looks like an `http://`/`https://` URL or a local filesystem path; when it chooses the URL
//! path, [`download_artifact`] is what actually fetches the bytes.
//!
//! ## Design constraints (why this module looks the way it does)
//!
//! - **Synchronous, not async.** The rest of `canvas_edge_updater` is synchronous (no `tokio`
//!   runtime anywhere in this crate), and `edge/agent`'s established convention is to confine
//!   async/tokio to one place (its transport thread). The updater follows the same discipline:
//!   `reqwest`'s blocking client is used here, so this crate never pulls in a runtime. This
//!   matches ADR 0008's "the updater must not depend on the Agent process or share its failure
//!   modes" -- a synchronous download path has no shared reactor to fail alongside the Agent.
//!
//! - **`rustls-tls`, not `native-tls`.** Cross-compiling `aarch64-unknown-linux-gnu` with
//!   `native-tls` would require a cross-compiled system OpenSSL, which this project explicitly
//!   avoids (see the active platform scope: "never cross-package native addons"). `edge/agent`'s
//!   transport already made the same choice (`tokio-tungstenite` with `rustls-tls-webpki-roots`);
//!   this module mirrors it for the updater so the whole `edge/` workspace shares one TLS story.
//!
//! - **Streaming, not buffered.** Kiosk release artifacts (`.deb` packages with bundled native
//!   addons) can be tens of megabytes. [`download_artifact`] streams the response body straight
//!   to a temporary file and hashes it as it goes, so peak memory is one read buffer, not the
//!   whole artifact.
//!
//! - **Hash mismatch leaves no partial artifact behind.** The download writes to
//!   `<dest_path>.partial` and only renames it into place on a verified hash match. A mismatch
//!   (or any error mid-stream) deletes the `.partial` file, so `dest_path` is either absent or
//!   fully verified -- never a half-written corrupt blob. This preserves `rollout.rs`'s
//!   existing "hash mismatch leaves the slot stuck at `Installing`, no installed bytes written"
//!   contract: `perform_rollout` calls `download_artifact` *before* `mark_installed`, and a
//!   returned `FetchError::HashMismatch` propagates as `RolloutError::ArtifactHashMismatch`
//!   exactly as the local-file path already does.
//!
//! - **Mockable HTTP client.** [`HttpClient`] is a small trait with a real implementation
//!   ([`RealHttpClient`], wrapping `reqwest::blocking::Client`) and a fake
//!   ([`FakeHttpClient`], returning canned responses from an injected queue). This mirrors the
//!   established `PeerCredentialSource`/`SystemCapabilityProbe` real/fake injection convention
//!   used in `edge/agent/src/ipc/peer.rs` and `edge/agent/src/capabilities/detect.rs`: production
//!   code uses the real one, tests inject the fake so they never touch the real network.
//!
//! - **Inline backoff, not a cross-crate dependency.** The exponential backoff here is a small
//!   inline equivalent of `edge/agent/src/transport/backoff.rs`'s `next_delay`. It is deliberately
//!   *not* imported from `edge/agent`: per ADR 0008, the updater "must not depend on the Agent
//!   process or share its failure modes," and a crate dependency from `updater` on `agent` would
//!   violate that boundary. The two implementations are intentionally independent.
//!
//! ## What is and is not proven here
//!
//! - **Real:** streaming download to disk, SHA-256 verification of the streamed bytes, bounded
//!   retry with exponential backoff on transient HTTP errors, and the real/fake client seam.
//! - **Not done in this pass:** HTTP Range/resume (a failed partial is discarded and re-fetched
//!   from byte 0 on retry, not resumed), bandwidth throttling, HTTP redirect policy customization
//!   (reqwest's default of following up to 10 redirects is used), and any authentication scheme
//!   for the release-artifact endpoint (a future Core release feed may require mTLS or a bearer
//!   token; none is wired here yet). These are documented future work, not silent stubs.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};

/// Lowercase hex-encodes `bytes`, matching `manifest::encode_hex`'s style so hash comparisons
/// against `ReleaseManifest::artifact_sha256` are shape-compatible.
fn encode_hex(bytes: &[u8]) -> String {
    let mut hex = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// Decodes a 64-character lowercase hex SHA-256 string into a 32-byte array, returning `None`
/// on any malformed input. Used by `perform_rollout` to turn the manifest's `artifact_sha256`
/// string into the `[u8; 32]` `download_artifact` expects.
pub(crate) fn decode_sha256_hex(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (index, chunk) in hex.as_bytes().chunks(2).enumerate() {
        let pair = std::str::from_utf8(chunk).ok()?;
        out[index] = u8::from_str_radix(pair, 16).ok()?;
    }
    Some(out)
}

/// Why an artifact download did not complete. `perform_rollout` maps the relevant variants to
/// its own `RolloutError` (see `rollout.rs`'s `perform_rollout`).
#[derive(Debug)]
pub enum FetchError {
    /// The URL was not a valid `http://`/`https://` URL, or `reqwest` rejected it before any
    /// network attempt.
    InvalidUrl { url: String, source: reqwest::Error },
    /// A network/HTTP attempt failed. `attempt` is 1-based (the first failed attempt is `1`).
    /// Carried so callers/tests can distinguish "gave up after N attempts" from "first attempt
    /// failed" without inspecting the error string.
    HttpFailed {
        url: String,
        attempt: u32,
        source: reqwest::Error,
    },
    /// The HTTP response's status was not 2xx after all retries. `status` is the final response
    /// code seen.
    BadStatus { url: String, status: u16 },
    /// Writing the streamed bytes to the `.partial` file failed (disk full, permission denied,
    /// etc.). The `.partial` file has already been deleted by the time this is returned.
    WriteFailed {
        path: PathBuf,
        source: std::io::Error,
    },
    /// Reading a chunk from the response body stream failed mid-download. The `.partial` file
    /// has already been deleted by the time this is returned.
    ReadFailed { url: String, source: std::io::Error },
    /// The downloaded bytes' SHA-256 does not match `expected_sha256`. The `.partial` file has
    /// already been deleted; `dest_path` was never created. This is the networked equivalent of
    /// `RolloutError::ArtifactHashMismatch`'s "no installed bytes written" contract.
    HashMismatch {
        url: String,
        expected_sha256: String,
        actual_sha256: String,
    },
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidUrl { url, source } => {
                write!(f, "invalid artifact URL {url:?}: {source}")
            }
            Self::HttpFailed {
                url,
                attempt,
                source,
            } => {
                write!(
                    f,
                    "HTTP fetch of {url} failed on attempt {attempt}: {source}"
                )
            }
            Self::BadStatus { url, status } => {
                write!(
                    f,
                    "artifact fetch for {url} returned non-success status {status}"
                )
            }
            Self::WriteFailed { path, source } => {
                write!(
                    f,
                    "failed to write artifact to {}: {source}",
                    path.display()
                )
            }
            Self::ReadFailed { url, source } => {
                write!(f, "failed reading artifact body from {url}: {source}")
            }
            Self::HashMismatch {
                url,
                expected_sha256,
                actual_sha256,
            } => write!(
                f,
                "artifact hash mismatch for {url}: expected {expected_sha256}, got {actual_sha256}"
            ),
        }
    }
}

impl std::error::Error for FetchError {}

/// A streamed HTTP response body that can be read chunk-by-chunk. The real implementation wraps
/// `reqwest::blocking::Response`; the fake implementation yields injected byte chunks. This is a
/// trait rather than a concrete type so [`FakeHttpClient`] can produce canned responses without a
/// real network round trip.
pub trait HttpResponse {
    /// The HTTP status code (e.g. 200). Used by `download_artifact` to reject non-2xx responses
    /// without attempting to stream a body.
    fn status(&self) -> u16;

    /// Reads the next chunk of the body into `buf`, returning `Ok(0)` at end of stream (matching
    /// `std::io::Read`'s convention). Implementations may fill `buf` partially. The error type is
    /// `std::io::Error` (not `reqwest::Error`) because the real `reqwest::blocking::Response`
    /// exposes its body as a `std::io::Read` whose error is `io::Error`; the fake implementation
    /// produces `io::Error` directly.
    fn read_chunk(&mut self, buf: &mut [u8]) -> Result<usize, std::io::Error>;
}

/// An injectable HTTP client seam, following the real/fake convention of
/// `edge/agent/src/ipc/peer.rs`'s `PeerCredentialSource` and
/// `edge/agent/src/capabilities/detect.rs`'s `SystemCapabilityProbe`: production code uses
/// [`RealHttpClient`], tests use [`FakeHttpClient`].
pub trait HttpClient {
    /// Issues a GET request for `url` and returns the response. Implementations are free to
    /// fail (return `Err`) without ever producing a response -- `download_artifact` treats that
    /// as a retryable attempt failure.
    fn get(&self, url: &str) -> Result<Box<dyn HttpResponse>, reqwest::Error>;
}

/// Production HTTP client: a thin wrapper around `reqwest::blocking::Client` configured with
/// `rustls-tls` (see module docs for why not `native-tls`). Follows redirects up to reqwest's
/// default limit.
#[derive(Debug, Clone)]
pub struct RealHttpClient {
    client: reqwest::blocking::Client,
}

impl Default for RealHttpClient {
    fn default() -> Self {
        Self::new()
    }
}

impl RealHttpClient {
    /// Constructs a real blocking HTTP client with rustls TLS and a kiosk-appropriate timeout.
    /// The timeout bounds the whole request (connect + headers + body); a future task may want a
    /// separate, longer body-read timeout for very large artifacts, but one combined timeout is
    /// honest and sufficient for this pass.
    pub fn new() -> Self {
        let client = reqwest::blocking::Client::builder()
            .use_rustls_tls()
            .timeout(Duration::from_secs(300))
            .build()
            .expect("reqwest blocking client with rustls builds with no system dependencies");
        Self { client }
    }
}

impl HttpClient for RealHttpClient {
    fn get(&self, url: &str) -> Result<Box<dyn HttpResponse>, reqwest::Error> {
        let response = self.client.get(url).send()?;
        Ok(Box::new(RealHttpResponse { response }))
    }
}

/// Real `HttpResponse` wrapping a `reqwest::blocking::Response`.
struct RealHttpResponse {
    response: reqwest::blocking::Response,
}

impl HttpResponse for RealHttpResponse {
    fn status(&self) -> u16 {
        self.response.status().as_u16()
    }

    fn read_chunk(&mut self, buf: &mut [u8]) -> Result<usize, std::io::Error> {
        use std::io::Read;
        // `reqwest::blocking::Response` implements `Read` via `Read for Response` (chunked
        // transfer decoding is handled internally), so this streams the body without buffering
        // the whole artifact in memory.
        self.response.read(buf)
    }
}

/// Configuration for [`download_artifact`]'s bounded retry with exponential backoff. Mirrors the
/// shape of `edge/agent/src/transport/backoff.rs`'s `BackoffConfig`, but is intentionally an
/// independent, inline implementation -- the updater must not depend on the `agent` crate (ADR
/// 0008: "must not depend on the Agent process or share its failure modes").
#[derive(Debug, Clone, Copy)]
pub struct FetchBackoffConfig {
    /// Delay before the first retry (after the first failed attempt).
    pub base: Duration,
    /// Cap on the computed delay between retries.
    pub max: Duration,
    /// Maximum number of attempts in total, including the first. `1` means "no retries": try
    /// once, fail on any error. Must be >= 1.
    pub max_attempts: u32,
}

impl Default for FetchBackoffConfig {
    fn default() -> Self {
        Self {
            base: Duration::from_secs(1),
            max: Duration::from_secs(30),
            max_attempts: 4,
        }
    }
}

/// Computes the delay before retry attempt number `attempt` (1-based: `attempt == 1` is the delay
/// before the *first* retry, after the *first* failure). Pure and synchronous, mirroring
/// `edge/agent/src/transport/backoff.rs::next_delay`'s shape, but without jitter (the updater is a
/// single process per kiosk, so a thundering herd is not a concern here the way it is for the
/// agent's WS reconnect across many devices).
fn backoff_delay(config: FetchBackoffConfig, attempt: u32) -> Duration {
    debug_assert!(attempt >= 1);
    // Cap the exponent at 31 so `1u32 << exponent` never overflows (a shift by 32 would panic in
    // debug builds). The `max` cap clamps the result long before this matters in practice.
    let exponent = attempt.saturating_sub(1).min(31);
    let multiplier: u32 = 1u32 << exponent;
    config.base.saturating_mul(multiplier).min(config.max)
}

/// Downloads the artifact at `url` to `dest_path`, streaming the body to disk and computing
/// SHA-256 as it goes. On a verified hash match, the artifact is left at `dest_path`. On any
/// error (HTTP failure, non-2xx status, I/O failure, or hash mismatch), any `.partial` file is
/// deleted and `dest_path` is never created -- callers can rely on "either absent or verified."
///
/// `client` is injected so tests can supply a [`FakeHttpClient`]; production callers pass a
/// [`RealHttpClient`]. `expected_sha256` is the 32-byte SHA-256 digest the downloaded bytes must
/// match (typically decoded from `ReleaseManifest::artifact_sha256`).
///
/// Retry behavior: on a retryable failure (an `Err` from `HttpClient::get`, a non-2xx status, or
/// a mid-stream read error), the function sleeps for an exponentially-backed-off duration and
/// tries again, up to `backoff.max_attempts` total attempts. A hash mismatch is **not** retried:
/// a wrong hash means the server served the wrong bytes, and re-fetching the same wrong bytes
/// would not help -- it is a terminal error for this download.
pub fn download_artifact(
    client: &dyn HttpClient,
    url: &str,
    dest_path: &Path,
    expected_sha256: &[u8; 32],
    backoff: FetchBackoffConfig,
) -> Result<(), FetchError> {
    debug_assert!(backoff.max_attempts >= 1, "max_attempts must be >= 1");

    let partial_path = dest_path.with_extension("partial");
    // Ensure no stale `.partial` from a previous crashed attempt lingers.
    let _ = fs::remove_file(&partial_path);

    let mut last_error: Option<FetchError> = None;

    for attempt in 1..=backoff.max_attempts {
        match download_once(client, url, &partial_path, expected_sha256) {
            Ok(()) => {
                // Hash verified; atomically promote the partial file to the final destination.
                // `rename` overwrites an existing dest on Unix, which is the desired behavior for
                // a re-download of the same path.
                if let Err(source) = fs::rename(&partial_path, dest_path) {
                    let _ = fs::remove_file(&partial_path);
                    return Err(FetchError::WriteFailed {
                        path: dest_path.to_path_buf(),
                        source,
                    });
                }
                return Ok(());
            }
            Err(error @ FetchError::HashMismatch { .. }) => {
                // Terminal: do not retry a wrong-hash response. The `download_once` call already
                // deleted the `.partial` file and built the full `HashMismatch` with the real
                // expected/actual digests, so return it verbatim.
                let _ = fs::remove_file(&partial_path);
                return Err(error);
            }
            Err(error) => {
                let _ = fs::remove_file(&partial_path);
                last_error = Some(match error {
                    FetchError::HttpFailed { source, .. } => FetchError::HttpFailed {
                        url: url.to_string(),
                        attempt,
                        source,
                    },
                    other => other,
                });
                if attempt < backoff.max_attempts {
                    std::thread::sleep(backoff_delay(backoff, attempt));
                }
            }
        }
    }

    Err(last_error.unwrap_or_else(|| FetchError::BadStatus {
        url: url.to_string(),
        status: 0,
    }))
}

/// One download attempt: GET the URL, stream to `partial_path`, hash as we go, and verify the
/// final digest. On any error, the caller is responsible for deleting `partial_path` (and
/// `download_artifact` does so).
fn download_once(
    client: &dyn HttpClient,
    url: &str,
    partial_path: &Path,
    expected_sha256: &[u8; 32],
) -> Result<(), FetchError> {
    // Validate the URL up front so that any error from `client.get()` can be classified as a
    // retryable connection/request failure rather than a non-retryable URL-parse failure. This
    // also keeps the fake client's synthetic errors (which are builder-shaped) on the retryable
    // path, since the fake client is only ever used with valid URLs in tests.
    if reqwest::Url::parse(url).is_err() {
        return Err(FetchError::InvalidUrl {
            url: url.to_string(),
            source: fake_reqwest_error("invalid URL"),
        });
    }

    let mut response = client.get(url).map_err(|source| FetchError::HttpFailed {
        url: url.to_string(),
        attempt: 1,
        source,
    })?;

    let status = response.status();
    if !(200..300).contains(&status) {
        return Err(FetchError::BadStatus {
            url: url.to_string(),
            status,
        });
    }

    let mut file = fs::File::create(partial_path).map_err(|source| FetchError::WriteFailed {
        path: partial_path.to_path_buf(),
        source,
    })?;

    let mut hasher = Sha256::new();
    let mut buf = [0u8; 16 * 1024];
    loop {
        let n = response.read_chunk(&mut buf).map_err(|source| {
            // Clean up the partial file on a mid-stream read failure.
            let _ = fs::remove_file(partial_path);
            FetchError::ReadFailed {
                url: url.to_string(),
                source,
            }
        })?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n]).map_err(|source| {
            let _ = fs::remove_file(partial_path);
            FetchError::WriteFailed {
                path: partial_path.to_path_buf(),
                source,
            }
        })?;
    }

    file.flush().map_err(|source| FetchError::WriteFailed {
        path: partial_path.to_path_buf(),
        source,
    })?;

    let digest = hasher.finalize();
    if digest.as_slice() != expected_sha256 {
        let _ = fs::remove_file(partial_path);
        return Err(FetchError::HashMismatch {
            url: url.to_string(),
            expected_sha256: encode_hex(expected_sha256),
            actual_sha256: encode_hex(&digest),
        });
    }

    Ok(())
}

// =================================================================================================
// Test-only fake HTTP client. Lives here (not in tests/) so that `rollout.rs`'s URL-path tests
// and `tests/fetch_v1.rs` can both construct it without duplicating the type. Not used by any
// production code path -- mirrors `FakePeerCredentialSource` / `FakeSystemCapabilityProbe`.
// =================================================================================================

/// A canned response queued up for [`FakeHttpClient`] to return. `Ok(bytes)` yields a 200
/// response whose body is exactly `bytes`; `Err(message)` yields a synthetic `reqwest::Error`
/// (so the retry path can be exercised without a real network failure).
#[derive(Debug, Clone)]
pub struct FakeResponse {
    /// The HTTP status to report. Defaults to 200 for `Ok` responses; set explicitly for `Err`
    /// responses if a non-zero status is desired (usually irrelevant since `Err` short-circuits
    /// before status is checked).
    pub status: u16,
    /// The body bytes to stream, or an error message to turn into a `reqwest::Error`.
    pub outcome: Result<Vec<u8>, String>,
}

/// Test-only [`HttpClient`] that returns queued, injected responses in order. Each call to `get`
/// pops the next [`FakeResponse`] from the queue. This is what makes it possible to exercise the
/// retry path (first attempt fails, second succeeds) and the hash-mismatch path without any real
/// network access -- exactly mirroring how `FakePeerCredentialSource` lets a single test process
/// simulate "a different OS user connected."
#[derive(Debug, Default)]
pub struct FakeHttpClient {
    responses: std::sync::Mutex<Vec<FakeResponse>>,
}

impl FakeHttpClient {
    pub fn new() -> Self {
        Self::default()
    }

    /// Queues a response (or error) to be returned by the next `get` call. Responses are popped
    /// in FIFO order, so queue one per expected attempt.
    pub fn enqueue(&self, response: FakeResponse) -> &Self {
        self.responses
            .lock()
            .expect("fake client mutex")
            .push(response);
        self
    }
}

impl HttpClient for FakeHttpClient {
    fn get(&self, _url: &str) -> Result<Box<dyn HttpResponse>, reqwest::Error> {
        let mut queue = self.responses.lock().expect("fake client mutex");
        let response = queue.remove(0);
        drop(queue);

        match response.outcome {
            Ok(bytes) => Ok(Box::new(FakeHttpResponse {
                status: response.status,
                bytes,
                position: 0,
            })),
            Err(message) => Err(fake_reqwest_error(&message)),
        }
    }
}

/// Fake `HttpResponse` that streams injected bytes from an in-memory buffer.
struct FakeHttpResponse {
    status: u16,
    bytes: Vec<u8>,
    position: usize,
}

impl HttpResponse for FakeHttpResponse {
    fn status(&self) -> u16 {
        self.status
    }

    fn read_chunk(&mut self, buf: &mut [u8]) -> Result<usize, std::io::Error> {
        let remaining = &self.bytes[self.position..];
        let n = remaining.len().min(buf.len());
        buf[..n].copy_from_slice(&remaining[..n]);
        self.position += n;
        Ok(n)
    }
}

/// Constructs a synthetic `reqwest::Error` carrying `message`. This is intentionally simple: the
/// fake client only needs to produce *some* `reqwest::Error` to exercise the retry path, not a
/// realistic one. Also reused by `rollout.rs`'s `download_via_http` to report a malformed
/// manifest hash as an `InvalidUrl`-shaped error without a real HTTP attempt.
pub(crate) fn fake_reqwest_error(message: &str) -> reqwest::Error {
    // `reqwest::Error` has no public constructor, so the only stable way to produce one is to
    // actually fail a request. We use a URL that `reqwest::Url::parse` rejects at parse time
    // (a malformed IPv6 literal), which produces a `BuilderError` *without any network access*
    // -- no DNS lookup, no connect attempt. The `message` is carried in the URL path purely so
    // it shows up in the error's `Debug`/`Display` output for test diagnostics; it is not parsed
    // as a hostname.
    let invalid_url = format!("http://[invalid/{message}");
    reqwest::blocking::Client::new()
        .get(&invalid_url)
        .send()
        .expect_err("a malformed-IPv6 URL always fails at parse time, producing a reqwest::Error")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sha256(bytes: &[u8]) -> [u8; 32] {
        let digest = Sha256::digest(bytes);
        let mut out = [0u8; 32];
        out.copy_from_slice(&digest);
        out
    }

    #[test]
    fn backoff_delay_doubles_and_caps() {
        let config = FetchBackoffConfig {
            base: Duration::from_secs(1),
            max: Duration::from_secs(8),
            max_attempts: 10,
        };
        assert_eq!(backoff_delay(config, 1), Duration::from_secs(1));
        assert_eq!(backoff_delay(config, 2), Duration::from_secs(2));
        assert_eq!(backoff_delay(config, 3), Duration::from_secs(4));
        assert_eq!(backoff_delay(config, 4), Duration::from_secs(8));
        // Capped at max.
        assert_eq!(backoff_delay(config, 5), Duration::from_secs(8));
        assert_eq!(backoff_delay(config, 100), Duration::from_secs(8));
    }

    #[test]
    fn decode_sha256_hex_round_trips() {
        let bytes: [u8; 32] = sha256(b"hello");
        let hex = encode_hex(&bytes);
        assert_eq!(decode_sha256_hex(&hex), Some(bytes));
        assert!(decode_sha256_hex("not hex").is_none());
        assert!(decode_sha256_hex(&hex[..63]).is_none());
    }

    #[test]
    fn download_artifact_success_path_writes_verified_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let dest = dir.path().join("artifact.bin");
        let body = b"real artifact bytes for the happy path";
        let expected = sha256(body);

        let client = FakeHttpClient::new();
        client.enqueue(FakeResponse {
            status: 200,
            outcome: Ok(body.to_vec()),
        });

        download_artifact(
            &client,
            "https://example.com/artifact",
            &dest,
            &expected,
            FetchBackoffConfig::default(),
        )
        .expect("happy path download succeeds");

        assert_eq!(fs::read(&dest).expect("dest exists"), body);
        assert!(
            !dest.with_extension("partial").exists(),
            "no leftover partial"
        );
    }

    #[test]
    fn download_artifact_hash_mismatch_deletes_partial_and_does_not_create_dest() {
        let dir = tempfile::tempdir().expect("tempdir");
        let dest = dir.path().join("artifact.bin");
        let wrong_body = b"these are the wrong bytes";
        let expected = sha256(b"these are the *correct* bytes");

        let client = FakeHttpClient::new();
        client.enqueue(FakeResponse {
            status: 200,
            outcome: Ok(wrong_body.to_vec()),
        });

        let result = download_artifact(
            &client,
            "https://example.com/artifact",
            &dest,
            &expected,
            FetchBackoffConfig::default(),
        );

        match result {
            Err(FetchError::HashMismatch {
                expected_sha256,
                actual_sha256,
                ..
            }) => {
                assert_eq!(expected_sha256, encode_hex(&expected));
                assert_eq!(actual_sha256, encode_hex(&sha256(wrong_body)));
            }
            other => panic!("expected HashMismatch, got {other:?}"),
        }

        assert!(!dest.exists(), "dest must not exist after hash mismatch");
        assert!(
            !dest.with_extension("partial").exists(),
            "partial must be cleaned up"
        );
    }

    #[test]
    fn download_artifact_retries_on_http_failure_then_succeeds() {
        let dir = tempfile::tempdir().expect("tempdir");
        let dest = dir.path().join("artifact.bin");
        let body = b"artifact bytes that arrive on the second attempt";
        let expected = sha256(body);

        let client = FakeHttpClient::new();
        // First attempt: error. Second attempt: success.
        client
            .enqueue(FakeResponse {
                status: 0,
                outcome: Err("simulated transient network failure".to_string()),
            })
            .enqueue(FakeResponse {
                status: 200,
                outcome: Ok(body.to_vec()),
            });

        // Use a tiny backoff so the test doesn't sleep for a full second.
        let backoff = FetchBackoffConfig {
            base: Duration::from_millis(1),
            max: Duration::from_millis(10),
            max_attempts: 4,
        };

        download_artifact(
            &client,
            "https://example.com/artifact",
            &dest,
            &expected,
            backoff,
        )
        .expect("retry path succeeds on second attempt");

        assert_eq!(fs::read(&dest).expect("dest exists"), body);
    }

    #[test]
    fn download_artifact_gives_up_after_max_attempts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let dest = dir.path().join("artifact.bin");
        let expected = sha256(b"never downloaded");

        let client = FakeHttpClient::new();
        for _ in 0..3 {
            client.enqueue(FakeResponse {
                status: 0,
                outcome: Err("persistent failure".to_string()),
            });
        }

        let backoff = FetchBackoffConfig {
            base: Duration::from_millis(1),
            max: Duration::from_millis(10),
            max_attempts: 3,
        };

        let result = download_artifact(
            &client,
            "https://example.com/artifact",
            &dest,
            &expected,
            backoff,
        );

        assert!(
            matches!(result, Err(FetchError::HttpFailed { attempt: 3, .. })),
            "got {result:?}"
        );
        assert!(!dest.exists());
        assert!(!dest.with_extension("partial").exists());
    }

    #[test]
    fn download_artifact_rejects_non_2xx_status() {
        let dir = tempfile::tempdir().expect("tempdir");
        let dest = dir.path().join("artifact.bin");
        let expected = sha256(b"irrelevant");

        let client = FakeHttpClient::new();
        client.enqueue(FakeResponse {
            status: 404,
            outcome: Ok(b"not found body".to_vec()),
        });

        let backoff = FetchBackoffConfig {
            base: Duration::from_millis(1),
            max: Duration::from_millis(10),
            max_attempts: 1,
        };

        let result = download_artifact(
            &client,
            "https://example.com/artifact",
            &dest,
            &expected,
            backoff,
        );

        assert!(
            matches!(result, Err(FetchError::BadStatus { status: 404, .. })),
            "got {result:?}"
        );
        assert!(!dest.exists());
    }
}
