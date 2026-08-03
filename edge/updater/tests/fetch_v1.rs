//! Phase 1 executable evidence for `canvas_edge_updater::fetch::download_artifact`: the real
//! HTTP/TLS download path with streaming SHA-256 verification and bounded retry, exercised via
//! the injectable `FakeHttpClient` so no real network access is required.
//!
//! See `edge/updater/src/fetch.rs`'s module docs for the design constraints (synchronous
//! `reqwest` blocking client with `rustls-tls`, streaming to a `.partial` file, hash mismatch
//! deletes the partial and never creates `dest_path`, inline exponential backoff independent of
//! `edge/agent`'s transport backoff). These tests follow the style of
//! `edge/updater/tests/rollout_v1.rs` and `edge/updater/tests/manifest_v1.rs`.

use std::fs;
use std::time::Duration;

use canvas_edge_updater::fetch::{
    download_artifact, FakeHttpClient, FakeResponse, FetchBackoffConfig, FetchError, HttpResponse,
};
use sha2::{Digest, Sha256};
use tempfile::tempdir;

fn sha256(bytes: &[u8]) -> [u8; 32] {
    let digest = Sha256::digest(bytes);
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    hex_of(&digest)
}

/// Hex-encodes a 32-byte digest directly (no hashing). Used to assert against
/// `FetchError::HashMismatch::expected_sha256`, which is the hex of the digest passed in, not a
/// hash of that digest.
fn hex_of(bytes: &[u8]) -> String {
    let mut hex = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// A tiny backoff config used across these tests so the retry-sleeps don't slow the suite down.
fn fast_backoff(max_attempts: u32) -> FetchBackoffConfig {
    FetchBackoffConfig {
        base: Duration::from_millis(1),
        max: Duration::from_millis(10),
        max_attempts,
    }
}

// -- Happy path: 200 response whose body hashes to the expected digest ----------------------------

#[test]
fn http_download_success_writes_verified_file_and_leaves_no_partial() {
    let dir = tempdir().expect("tempdir");
    let dest = dir.path().join("artifact.bin");
    let body = b"real artifact bytes streamed over http";
    let expected = sha256(body);

    let client = FakeHttpClient::new();
    client.enqueue(FakeResponse {
        status: 200,
        outcome: Ok(body.to_vec()),
    });

    download_artifact(
        &client,
        "https://releases.example.com/canvas-edge-agent-1.4.0-amd64.deb",
        &dest,
        &expected,
        fast_backoff(1),
    )
    .expect("happy path download succeeds");

    assert_eq!(fs::read(&dest).expect("dest exists"), body);
    assert!(
        !dest.with_extension("partial").exists(),
        "no leftover .partial after success"
    );
}

// -- Hash mismatch: partial deleted, dest never created, not retried --------------------------------

#[test]
fn http_download_hash_mismatch_deletes_partial_and_never_creates_dest() {
    let dir = tempdir().expect("tempdir");
    let dest = dir.path().join("artifact.bin");
    let wrong_body = b"these bytes do not match the manifest's declared hash";
    let expected = sha256(b"these are the bytes the manifest declared");

    let client = FakeHttpClient::new();
    client.enqueue(FakeResponse {
        status: 200,
        outcome: Ok(wrong_body.to_vec()),
    });

    let result = download_artifact(
        &client,
        "https://releases.example.com/artifact",
        &dest,
        &expected,
        // Even with retries available, a hash mismatch is terminal and must not retry.
        fast_backoff(4),
    );

    match result {
        Err(FetchError::HashMismatch {
            expected_sha256,
            actual_sha256,
            ..
        }) => {
            // `expected_sha256` is the hex encoding of the 32-byte digest we passed in, NOT a
            // hash of that digest -- so compare against the hex of `expected` directly.
            assert_eq!(expected_sha256, hex_of(&expected));
            assert_eq!(actual_sha256, sha256_hex(wrong_body));
        }
        other => panic!("expected HashMismatch, got {other:?}"),
    }

    assert!(!dest.exists(), "dest must not exist after hash mismatch");
    assert!(
        !dest.with_extension("partial").exists(),
        "partial must be cleaned up after hash mismatch"
    );
}

// -- Retry path: first attempt fails (network error), second succeeds --------------------------------

#[test]
fn http_download_retries_on_failure_then_succeeds_on_second_attempt() {
    let dir = tempdir().expect("tempdir");
    let dest = dir.path().join("artifact.bin");
    let body = b"artifact bytes that arrive on the second attempt";
    let expected = sha256(body);

    let client = FakeHttpClient::new();
    client
        .enqueue(FakeResponse {
            status: 0,
            outcome: Err("simulated transient network failure".to_string()),
        })
        .enqueue(FakeResponse {
            status: 200,
            outcome: Ok(body.to_vec()),
        });

    download_artifact(
        &client,
        "https://releases.example.com/artifact",
        &dest,
        &expected,
        fast_backoff(4),
    )
    .expect("retry path succeeds on second attempt");

    assert_eq!(fs::read(&dest).expect("dest exists"), body);
    assert!(
        !dest.with_extension("partial").exists(),
        "no leftover .partial after retry success"
    );
}

// -- Retry exhaustion: all attempts fail, dest never created, reports the final attempt --------------

#[test]
fn http_download_gives_up_after_max_attempts_and_reports_final_attempt_number() {
    let dir = tempdir().expect("tempdir");
    let dest = dir.path().join("artifact.bin");
    let expected = sha256(b"never downloaded");

    let client = FakeHttpClient::new();
    for _ in 0..3 {
        client.enqueue(FakeResponse {
            status: 0,
            outcome: Err("persistent network failure".to_string()),
        });
    }

    let result = download_artifact(
        &client,
        "https://releases.example.com/artifact",
        &dest,
        &expected,
        fast_backoff(3),
    );

    match result {
        Err(FetchError::HttpFailed { attempt, .. }) => {
            assert_eq!(attempt, 3, "should report the final (third) attempt");
        }
        other => panic!("expected HttpFailed with attempt=3, got {other:?}"),
    }

    assert!(
        !dest.exists(),
        "dest must not exist after all attempts failed"
    );
    assert!(
        !dest.with_extension("partial").exists(),
        "partial must be cleaned up after final failure"
    );
}

// -- Non-2xx status is rejected without streaming the body -------------------------------------------

#[test]
fn http_download_rejects_non_2xx_status() {
    let dir = tempdir().expect("tempdir");
    let dest = dir.path().join("artifact.bin");
    let expected = sha256(b"irrelevant");

    let client = FakeHttpClient::new();
    client.enqueue(FakeResponse {
        status: 404,
        outcome: Ok(b"not found body".to_vec()),
    });

    let result = download_artifact(
        &client,
        "https://releases.example.com/missing",
        &dest,
        &expected,
        fast_backoff(1),
    );

    assert!(
        matches!(result, Err(FetchError::BadStatus { status: 404, .. })),
        "got {result:?}"
    );
    assert!(!dest.exists());
}

// -- Large-ish body is streamed (not buffered): proves the streaming path handles multi-chunk reads --

#[test]
fn http_download_streams_a_body_larger_than_the_read_buffer() {
    let dir = tempdir().expect("tempdir");
    let dest = dir.path().join("artifact.bin");
    // 64 KiB of patterned bytes -- well over the 16 KiB read buffer in `download_once`, so this
    // exercises multiple `read_chunk` calls and proves the hasher accumulates across chunks.
    let body: Vec<u8> = (0..65536).map(|i| (i % 251) as u8).collect();
    let expected = sha256(&body);

    let client = FakeHttpClient::new();
    client.enqueue(FakeResponse {
        status: 200,
        outcome: Ok(body.clone()),
    });

    download_artifact(
        &client,
        "https://releases.example.com/large-artifact",
        &dest,
        &expected,
        fast_backoff(1),
    )
    .expect("large body download succeeds");

    assert_eq!(fs::read(&dest).expect("dest exists"), body);
}

// -- A retry after a non-2xx response: proves BadStatus is also retryable ---------------------------

#[test]
fn http_download_retries_on_non_2xx_then_succeeds() {
    let dir = tempdir().expect("tempdir");
    let dest = dir.path().join("artifact.bin");
    let body = b"body that arrives after a transient 503";
    let expected = sha256(body);

    let client = FakeHttpClient::new();
    client
        .enqueue(FakeResponse {
            status: 503,
            outcome: Ok(b"service unavailable".to_vec()),
        })
        .enqueue(FakeResponse {
            status: 200,
            outcome: Ok(body.to_vec()),
        });

    download_artifact(
        &client,
        "https://releases.example.com/artifact",
        &dest,
        &expected,
        fast_backoff(4),
    )
    .expect("retry after 503 succeeds");

    assert_eq!(fs::read(&dest).expect("dest exists"), body);
}

// -- The HttpResponse trait's streaming contract: a fake response that yields chunks smaller than
//    the read buffer is still hashed correctly (proves the loop handles partial reads). -----------

#[test]
fn http_download_handles_a_response_that_yields_partial_chunks() {
    let dir = tempdir().expect("tempdir");
    let dest = dir.path().join("artifact.bin");
    let body = b"chunked body whose fake response yields one byte at a time";
    let expected = sha256(body);

    // A custom fake client whose `HttpResponse` yields a single byte per `read_chunk` call,
    // proving the download loop accumulates the hash across many tiny reads rather than assuming
    // a full buffer on every call.
    struct OneByteResponse {
        bytes: Vec<u8>,
        position: usize,
    }
    impl HttpResponse for OneByteResponse {
        fn status(&self) -> u16 {
            200
        }
        fn read_chunk(&mut self, buf: &mut [u8]) -> Result<usize, std::io::Error> {
            if self.position >= self.bytes.len() {
                return Ok(0);
            }
            // Yield exactly one byte per call, regardless of `buf.len()`.
            buf[0] = self.bytes[self.position];
            self.position += 1;
            Ok(1)
        }
    }
    struct OneByteClient {
        bytes: Vec<u8>,
        called: std::sync::Mutex<bool>,
    }
    impl canvas_edge_updater::fetch::HttpClient for OneByteClient {
        fn get(&self, _url: &str) -> Result<Box<dyn HttpResponse>, reqwest::Error> {
            let mut called = self.called.lock().expect("mutex");
            assert!(!*called, "one-byte client only supports a single get call");
            *called = true;
            Ok(Box::new(OneByteResponse {
                bytes: self.bytes.clone(),
                position: 0,
            }))
        }
    }

    let client = OneByteClient {
        bytes: body.to_vec(),
        called: std::sync::Mutex::new(false),
    };

    download_artifact(
        &client,
        "https://releases.example.com/one-byte-stream",
        &dest,
        &expected,
        fast_backoff(1),
    )
    .expect("one-byte-at-a-time download succeeds");

    assert_eq!(fs::read(&dest).expect("dest exists"), body);
}
