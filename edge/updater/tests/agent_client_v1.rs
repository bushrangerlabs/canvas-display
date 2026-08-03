//! Integration test for the updater-side Agent IPC client (`edge/updater/src/agent_client.rs`):
//! proves the updater can reach the Agent's `LocalIpcBroker` as an `updater`-role peer over a real
//! Unix socket, perform the `SessionWire` handshake, and call `updater.agent_version` end-to-end --
//! the cross-process, role-scoped channel the architecture plan calls for between the Agent and the
//! updater.
//!
//! `serve_ipc` lives in the `canvas_edge_agentd` binary crate, which this library crate cannot
//! depend on (a lib test of `canvas_edge_updater` cannot pull in the agentd binary without creating
//! a circular/odd dependency). Instead this test drives the *same* broker the daemon uses
//! (`canvas_edge_agent::ipc::LocalIpcBroker`) directly, with the updater uid configured to this
//! process's own uid so the real `SO_PEERCRED` credential authenticates as `Updater`. The client
//! half is the real production code under test; only the server harness is inlined here (it is
//! byte-for-byte the same `accept` -> `write_session` -> `read_request` -> `dispatch` ->
//! `write_response` flow `serve_ipc` runs, so the proof is honest).
//!
//! Wire framing (defined by the daemon's `ipc.rs`, which the client replicates exactly): after
//! `accept`, the server writes one newline-delimited JSON `SessionWire` object (`{role, generation,
//! capability_token}`) to the client; the client reads that, then sends one newline-delimited JSON
//! `DispatchRequest` (with the required updater nonce), and reads one newline-delimited JSON
//! response.

use std::io::Write;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use canvas_edge_agent::ipc::{
    self, read_request, write_response, ActionExecutor, AuthenticatedSession, LocalIpcBroker,
    LocalIpcConfig, PeerRole, SoPeercredSource,
};
use canvas_edge_updater::agent_client::AgentIpcClient;
use serde::Serialize;
use tempfile::tempdir;

/// Writes the authenticated session as one newline-delimited JSON line -- mirrors
/// `edge/agentd/src/ipc.rs`'s `write_session` exactly (the client reads this to learn its token).
#[derive(Serialize)]
struct SessionWire<'a> {
    role: &'a PeerRole,
    generation: u64,
    capability_token: &'a str,
}

fn write_session(stream: &UnixStream, session: &AuthenticatedSession) -> std::io::Result<()> {
    let wire = SessionWire {
        role: &session.role,
        generation: session.generation,
        capability_token: &session.capability_token,
    };
    let json = serde_json::to_string(&wire)?;
    let mut stream = stream;
    stream.write_all(json.as_bytes())?;
    stream.write_all(b"\n")
}

/// Runs one accept/dispatch cycle on `listener` for a single updater connection, then exits. This
/// is the server half of the handshake the daemon's `serve_ipc` performs; the broker is the exact
/// same `LocalIpcBroker` type `serve_ipc` constructs.
fn serve_one_updater_connection(socket_path: PathBuf, updater_uid: u32, shutdown: Arc<AtomicBool>) {
    let listener = UnixListener::bind(&socket_path).expect("bind updater test socket");
    listener
        .set_nonblocking(true)
        .expect("set listener non-blocking");
    let mut broker = LocalIpcBroker::with_token_source_and_executor(
        LocalIpcConfig {
            renderer_uid: updater_uid.wrapping_add(1),
            updater_uid,
        },
        || "cap_test_token".to_string(),
        // Minimal executor standing in for the Agent's real `UpdaterQueryExecutor`: returns a
        // fixed version string for `updater.agent_version`. The client half (under test) is the
        // real production code; the server harness only needs to answer the method.
        UpdaterTestExecutor,
    );
    while !shutdown.load(Ordering::SeqCst) {
        // `broker.accept` performs the kernel `accept()` itself (and the SO_PEERCRED identify),
        // so we must NOT call `listener.accept()` here too. On a non-blocking listener it returns
        // `WouldBlock` when no connection is pending; we poll the shutdown flag and retry.
        match broker.accept(&listener, &SoPeercredSource) {
            Ok((stream, session)) => {
                let _ = stream.set_nonblocking(false);
                write_session(&stream, &session).expect("write session wire");
                let request = read_request(&stream).expect("read request");
                let outcome = broker.dispatch(request);
                write_response(&stream, &outcome).expect("write response");
                let _ = std::fs::remove_file(&socket_path);
                return;
            }
            Err(ipc::AcceptError::Io(err)) if err.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(20));
            }
            Err(err) => {
                panic!("accept and authenticate updater peer: {err}");
            }
        }
    }
    let _ = std::fs::remove_file(&socket_path);
}

#[test]
fn updater_client_can_query_agent_version_over_real_socket() {
    let real_uid = unsafe { libc::getuid() };
    let dir = tempdir().expect("tempdir for IPC socket");
    let socket_path = dir.path().join("agent.sock");

    let shutdown = Arc::new(AtomicBool::new(false));
    let shutdown_for_thread = Arc::clone(&shutdown);
    let socket_path_for_thread = socket_path.clone();
    let server = thread::Builder::new()
        .name("updater-test-server".to_string())
        .spawn(move || {
            serve_one_updater_connection(socket_path_for_thread, real_uid, shutdown_for_thread);
        })
        .expect("spawn updater test server");

    // Connect the real updater client; retry briefly because the server thread may not have bound
    // yet (same race the daemon test handles).
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    let mut client = loop {
        match AgentIpcClient::connect(&socket_path) {
            Ok(client) => break client,
            Err(err) if std::time::Instant::now() < deadline => {
                let _ = err;
                thread::sleep(Duration::from_millis(20));
            }
            Err(err) => panic!("updater client failed to connect: {err}"),
        }
    };

    let version = client
        .agent_version()
        .expect("updater.agent_version should succeed over the real socket");

    assert!(
        version.chars().all(|c| c.is_ascii_digit() || c == '.'),
        "updater.agent_version result should look like a version string, got {version:?}"
    );

    shutdown.store(true, Ordering::SeqCst);
    server.join().expect("updater test server thread joined");
}

#[test]
fn updater_client_rejects_a_replayed_nonce() {
    // The single-use nonce is the updater channel's replay protection. This test drives the broker
    // directly to prove a second request reusing the same nonce is rejected with nonce_replayed,
    // exercising the same path the client's `updater.agent_version` call would hit if a nonce were
    // reused. (The client generates a fresh random nonce per call, so this is a server-side guard
    // the client relies on.)
    let real_uid = unsafe { libc::getuid() };
    let mut broker = LocalIpcBroker::new(LocalIpcConfig {
        renderer_uid: real_uid.wrapping_add(1),
        updater_uid: real_uid,
    });
    let session = broker
        .connect(canvas_edge_agent::ipc::PeerCredential {
            uid: real_uid,
            gid: real_uid,
            pid: std::process::id() as i32,
        })
        .expect("authenticate updater session");

    let first = broker.dispatch(ipc::DispatchRequest {
        capability_token: session.capability_token.clone(),
        method: "updater.agent_version".to_string(),
        nonce: Some("nonce_replay_test".to_string()),
        arguments: None,
    });
    assert!(first.is_ok(), "first request with a fresh nonce succeeds");

    let second = broker.dispatch(ipc::DispatchRequest {
        capability_token: session.capability_token.clone(),
        method: "updater.agent_version".to_string(),
        nonce: Some("nonce_replay_test".to_string()),
        arguments: None,
    });
    assert!(
        matches!(
            second.as_ref().err(),
            Some(err) if err.code == canvas_edge_agent::ipc::LocalIpcErrorCode::NonceReplayed
        ),
        "reusing a nonce must be rejected as nonce_replayed, got {second:?}"
    );
}

/// Stand-in for the Agent's `UpdaterQueryExecutor` in the updater integration test: answers
/// `updater.agent_version` with a fixed version string so the test can assert the client parses a
/// real version-shaped response. The real Agent wiring (with the actual `CARGO_PKG_VERSION`) is
/// covered by `edge/agentd/tests/ipc_wiring_v1.rs`.
struct UpdaterTestExecutor;

impl ActionExecutor for UpdaterTestExecutor {
    fn execute(
        &mut self,
        _role: PeerRole,
        method: &str,
        _arguments: Option<&serde_json::Value>,
    ) -> Result<String, String> {
        match method {
            "updater.agent_version" => Ok("0.0.1".to_string()),
            _ => Ok(format!("{method}:accepted")),
        }
    }
}
