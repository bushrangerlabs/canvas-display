//! Regression test for `transport::spawn`'s outer reconnect-with-backoff loop (ADR 0009).
//!
//! `run_connection` itself (the part of the transport that drives an already-established
//! connection) is covered end-to-end in `transport_v1.rs`. This file instead exercises `spawn`'s
//! thinner outer glue -- specifically a real bug found and fixed while wiring this module into
//! `canvas-edge-agentd`'s `main()`: the reconnect loop's backoff sleep did not observe a
//! `TransportCommand::Shutdown` sent while it was waiting between failed connection attempts, so
//! sending `Shutdown` against a genuinely unreachable Core could hang `TransportHandle::join()`
//! indefinitely (observed for real: a manual smoke test against an unreachable placeholder host
//! left the daemon process stuck after `Ctrl+C`). This test proves the fix: `Shutdown` sent during
//! a (deliberately long) backoff window is observed promptly rather than only once the full delay
//! elapses.

use std::net::TcpListener;
use std::time::Duration;

use canvas_edge_agent::session::{EdgeSession, EdgeSessionOptions};
use canvas_edge_agent::transport::{self, BackoffConfig, HeartbeatConfig, TransportCommand};

/// Binds an ephemeral local port and immediately drops the listener, so a subsequent connection
/// attempt to it fails fast and deterministically with "connection refused" -- no reliance on any
/// specific unreachable hostname/DNS behavior, which can vary across sandboxes.
fn refused_ws_url() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind an ephemeral port");
    let port = listener.local_addr().expect("local addr").port();
    drop(listener);
    format!("ws://127.0.0.1:{port}/agent")
}

#[tokio::test]
async fn shutdown_is_observed_promptly_even_while_backing_off_against_an_unreachable_core() {
    let session = EdgeSession::new(EdgeSessionOptions::default());

    // A backoff long enough that, before the fix, this test would have to wait out (at least)
    // this whole delay before `Shutdown` was ever noticed -- comfortably longer than the bounded
    // timeout this test allows below, so the old behavior would fail this test.
    let backoff = BackoffConfig {
        base: Duration::from_secs(30),
        max: Duration::from_secs(30),
        jitter_fraction: 0.0,
    };

    let handle = transport::spawn(
        refused_ws_url(),
        session,
        backoff,
        HeartbeatConfig::default(),
    );

    // Give the transport thread a moment to attempt (and fail) its first connection and enter the
    // backoff sleep before sending Shutdown, so this genuinely exercises the "Shutdown arrives
    // during backoff" case rather than a race that might land before the first attempt.
    tokio::time::sleep(Duration::from_millis(200)).await;

    handle
        .commands
        .send(TransportCommand::Shutdown)
        .expect("send shutdown command");

    let join_result = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::task::spawn_blocking(move || handle.join()),
    )
    .await;

    assert!(
        join_result.is_ok(),
        "transport thread did not shut down within 5s of a Shutdown command sent during backoff \
         -- the backoff sleep is not observing Shutdown promptly"
    );
    join_result
        .unwrap()
        .expect("join task did not panic")
        .expect("transport thread itself did not panic");
}
