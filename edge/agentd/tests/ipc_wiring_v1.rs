//! Integration test for the daemon's local IPC wiring (`edge/agentd/src/ipc.rs`): proves that
//! `serve_ipc` actually opens a real `UnixListener`, authenticates a real `SO_PEERCRED` peer,
//! and dispatches allowlisted / rejects non-allowlisted requests over a real socket -- the
//! end-to-end path that `edge/agent/tests/local_ipc_v1.rs` exercises at the library level, here
//! driven through the daemon's own `serve_ipc` entry point.
//!
//! The test process is both the server (via `serve_ipc` on a background thread) and the client
//! (a real `UnixStream` from this same process), exactly mirroring the real-`SO_PEERCRED` tests
//! in `local_ipc_v1.rs`. The broker's `renderer_uid` is configured to this process's own uid so
//! the kernel-verified credential authenticates as the `Renderer` role.
//!
//! Wire framing (defined by the daemon's `ipc.rs`, not the broker library): after `accept`, the
//! server writes one newline-delimited JSON `SessionWire` object (`{role, generation,
//! capability_token}`) to the client; the client reads that, then sends one newline-delimited
//! JSON `DispatchRequest`, and reads one newline-delimited JSON response. This test drives that
//! full handshake.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use canvas_edge_agent::hardware::{
    FakeBrightnessAdapter, FakeCommandRunner, FakeDpmsAdapter, HardwareAdapters,
};
use serde::Deserialize;
use serde_json::json;
use tempfile::tempdir;

/// The session line the daemon writes to the client immediately after `accept`. Mirrors the
/// `SessionWire` struct in `edge/agentd/src/ipc.rs`.
#[derive(Debug, Deserialize)]
struct SessionWire {
    role: String,
    generation: u64,
    capability_token: String,
}

/// A response line: either `{"ok":true,"result":"..."}` or `{"code":"...","message":"..."}`.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ResponseWire {
    Ok { ok: bool, result: String },
    Err { code: String, message: String },
}

/// Reads exactly one newline-delimited JSON line from `reader` and deserializes it as `T`.
fn read_json_line<T: serde::de::DeserializeOwned>(reader: &mut impl BufRead) -> std::io::Result<T> {
    let mut line = String::new();
    let n = reader.read_line(&mut line)?;
    if n == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "peer closed the connection before sending a line",
        ));
    }
    serde_json::from_str(line.trim_end())
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))
}

/// Connects a real client to the daemon's IPC socket, performs the session handshake, and returns
/// the authenticated session (with capability token) plus a `BufReader` over the stream. The
/// caller writes requests via `reader.get_ref().try_clone()` (a second handle to the same socket)
/// and reads responses via the returned `BufReader`.
///
/// The connect is retried briefly: `serve_ipc` binds on its own thread before returning, but a
/// client connecting immediately can still race the kernel making the socket visible. A short
/// retry window keeps the test robust without a flake.
fn connect_and_handshake(socket_path: &PathBuf) -> (BufReader<UnixStream>, SessionWire) {
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    let stream = loop {
        match UnixStream::connect(socket_path) {
            Ok(stream) => break stream,
            Err(err) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
                let _ = err;
            }
            Err(err) => panic!(
                "failed to connect to IPC socket {}: {err}",
                socket_path.display()
            ),
        }
    };

    let mut reader = BufReader::new(stream);
    let session =
        read_json_line::<SessionWire>(&mut reader).expect("read session line from daemon");
    (reader, session)
}

/// Sends one newline-delimited JSON `DispatchRequest` over the socket, using `writer` (a cloned
/// handle to the same fd `reader` is reading from).
fn send_request(
    writer: &mut impl Write,
    capability_token: &str,
    method: &str,
    arguments: Option<serde_json::Value>,
) {
    let mut request = json!({
        "capability_token": capability_token,
        "method": method,
    });
    if let Some(args) = arguments {
        request["arguments"] = args;
    }
    serde_json::to_writer(&mut *writer, &request).expect("write request JSON");
    writer.write_all(b"\n").expect("write request newline");
    writer.flush().expect("flush request");
}

#[test]
fn serve_ipc_accepts_a_real_so_peercred_renderer_and_dispatches_an_allowlisted_request() {
    let real_uid = unsafe { libc::getuid() };
    let dir = tempdir().expect("tempdir for IPC socket");
    let socket_path = dir.path().join("agent.sock");

    let handle = canvas_edge_agentd::ipc::serve_ipc_with_identity(
        socket_path.clone(),
        real_uid,
        real_uid.wrapping_add(1),
        "test-device",
        "test-installation",
        "test-fingerprint",
    )
    .expect("serve_ipc binds and spawns the IPC thread");

    // Connect a real client from this same process; the kernel-verified SO_PEERCRED credential
    // will be this process's own uid, which we configured as the renderer uid above.
    let (mut reader, session) = connect_and_handshake(&socket_path);
    assert_eq!(
        session.role, "renderer",
        "real SO_PEERCRED uid authenticates as renderer"
    );
    assert_eq!(session.generation, 1, "first connection is generation 1");

    // Send an allowlisted renderer request: agent.app_version. The daemon's DaemonActionHandler
    // returns the real CARGO_PKG_VERSION.
    let mut writer = reader.get_ref().try_clone().expect("clone for writing");
    send_request(
        &mut writer,
        &session.capability_token,
        "agent.app_version",
        None,
    );

    let response =
        read_json_line::<ResponseWire>(&mut reader).expect("read response line from daemon");
    match response {
        ResponseWire::Ok { ok, result } => {
            assert!(
                ok,
                "agent.app_version should succeed for an allowlisted renderer request"
            );
            assert!(
                result.chars().all(|c| c.is_ascii_digit() || c == '.'),
                "agent.app_version result should look like a version string, got {result:?}"
            );
        }
        ResponseWire::Err { code, message } => {
            panic!("agent.app_version was rejected: {code}: {message}");
        }
    }

    handle.shutdown_and_join();
}

#[test]
fn serve_ipc_rejects_a_non_allowlisted_method_from_a_renderer_token() {
    let real_uid = unsafe { libc::getuid() };
    let dir = tempdir().expect("tempdir for IPC socket");
    let socket_path = dir.path().join("agent.sock");

    let handle = canvas_edge_agentd::ipc::serve_ipc_with_identity(
        socket_path.clone(),
        real_uid,
        real_uid.wrapping_add(1),
        "test-device",
        "test-installation",
        "test-fingerprint",
    )
    .expect("serve_ipc binds and spawns the IPC thread");

    let (mut reader, session) = connect_and_handshake(&socket_path);
    assert_eq!(session.role, "renderer");

    // Send an updater-only method from a renderer-scoped token. The broker's method allowlist is
    // disjoint per role, so this must be rejected with method_not_allowed -- the same defense that
    // stops a hostile WebView from pivoting to a privileged method.
    let mut writer = reader.get_ref().try_clone().expect("clone for writing");
    send_request(
        &mut writer,
        &session.capability_token,
        "updater.install_package",
        None,
    );

    let response =
        read_json_line::<ResponseWire>(&mut reader).expect("read response line from daemon");
    match response {
        ResponseWire::Err { code, message } => {
            assert_eq!(
                code, "method_not_allowed",
                "updater method from a renderer token must be rejected as method_not_allowed, got: {message}"
            );
        }
        ResponseWire::Ok { ok, result } => {
            panic!(
                "updater.install_package from a renderer token was accepted (ok={ok}, result={result})"
            );
        }
    }

    handle.shutdown_and_join();
}

#[test]
fn serve_ipc_rejects_a_request_with_a_forged_capability_token() {
    let real_uid = unsafe { libc::getuid() };
    let dir = tempdir().expect("tempdir for IPC socket");
    let socket_path = dir.path().join("agent.sock");

    let handle = canvas_edge_agentd::ipc::serve_ipc_with_identity(
        socket_path.clone(),
        real_uid,
        real_uid.wrapping_add(1),
        "test-device",
        "test-installation",
        "test-fingerprint",
    )
    .expect("serve_ipc binds and spawns the IPC thread");

    let (mut reader, _session) = connect_and_handshake(&socket_path);

    // A forged/never-issued token must be rejected with stale_capability, even for an allowlisted
    // method -- proving the dispatch path checks the token before the method allowlist.
    let mut writer = reader.get_ref().try_clone().expect("clone for writing");
    send_request(
        &mut writer,
        "cap_forged_never_issued_by_the_daemon",
        "agent.app_version",
        None,
    );

    let response =
        read_json_line::<ResponseWire>(&mut reader).expect("read response line from daemon");
    match response {
        ResponseWire::Err { code, .. } => {
            assert_eq!(
                code, "stale_capability",
                "a forged token must be rejected as stale_capability"
            );
        }
        ResponseWire::Ok { .. } => {
            panic!("a forged capability token was accepted");
        }
    }

    handle.shutdown_and_join();
}

#[test]
fn serve_ipc_accepts_an_updater_role_peer_and_dispatches_updater_agent_version() {
    let real_uid = unsafe { libc::getuid() };
    let dir = tempdir().expect("tempdir for IPC socket");
    let socket_path = dir.path().join("agent.sock");

    // Configure THIS process's own uid as the updater uid, so the kernel-verified SO_PEERCRED
    // credential authenticates the connection as the `Updater` role (the renderer uid is set to a
    // different value so the two roles stay disjoint, as in production).
    let handle =
        canvas_edge_agentd::ipc::serve_ipc(socket_path.clone(), real_uid.wrapping_add(1), real_uid)
            .expect("serve_ipc binds and spawns the IPC thread");

    let (mut reader, session) = connect_and_handshake(&socket_path);
    assert_eq!(
        session.role, "updater",
        "real SO_PEERCRED uid authenticates as updater when configured as the updater uid"
    );
    assert_eq!(session.generation, 1, "first connection is generation 1");

    // The updater channel requires a single-use nonce; send updater.agent_version with one.
    let mut writer = reader.get_ref().try_clone().expect("clone for writing");
    let request = json!({
        "capability_token": session.capability_token,
        "method": "updater.agent_version",
        "nonce": "nonce_test_updater_agent_version",
    });
    serde_json::to_writer(&mut writer, &request).expect("write request JSON");
    writer.write_all(b"\n").expect("write request newline");
    writer.flush().expect("flush request");

    let response =
        read_json_line::<ResponseWire>(&mut reader).expect("read response line from daemon");
    match response {
        ResponseWire::Ok { ok, result } => {
            assert!(
                ok,
                "updater.agent_version should succeed for an allowlisted updater request"
            );
            assert!(
                result.chars().all(|c| c.is_ascii_digit() || c == '.'),
                "updater.agent_version result should look like a version string, got {result:?}"
            );
        }
        ResponseWire::Err { code, message } => {
            panic!("updater.agent_version was rejected: {code}: {message}");
        }
    }

    handle.shutdown_and_join();
}

#[test]
fn serve_ipc_rejects_an_updater_request_missing_its_required_nonce() {
    let real_uid = unsafe { libc::getuid() };
    let dir = tempdir().expect("tempdir for IPC socket");
    let socket_path = dir.path().join("agent.sock");

    let handle =
        canvas_edge_agentd::ipc::serve_ipc(socket_path.clone(), real_uid.wrapping_add(1), real_uid)
            .expect("serve_ipc binds and spawns the IPC thread");

    let (mut reader, session) = connect_and_handshake(&socket_path);
    assert_eq!(session.role, "updater");

    // An updater request without a nonce must be rejected with nonce_required -- the single-use
    // nonce is the updater channel's replay protection (threat UPD-05).
    let mut writer = reader.get_ref().try_clone().expect("clone for writing");
    send_request(
        &mut writer,
        &session.capability_token,
        "updater.agent_version",
        None,
    );

    let response =
        read_json_line::<ResponseWire>(&mut reader).expect("read response line from daemon");
    match response {
        ResponseWire::Err { code, .. } => {
            assert_eq!(
                code, "nonce_required",
                "updater request without a nonce must be rejected as nonce_required"
            );
        }
        ResponseWire::Ok { ok, result } => {
            panic!("updater.agent_version without a nonce was accepted (ok={ok}, result={result})");
        }
    }

    handle.shutdown_and_join();
}

#[test]
fn serve_ipc_rejects_a_renderer_token_calling_an_updater_method() {
    let real_uid = unsafe { libc::getuid() };
    let dir = tempdir().expect("tempdir for IPC socket");
    let socket_path = dir.path().join("agent.sock");

    // This process's uid is the RENDERER uid here, so the token it receives is renderer-scoped.
    let handle = canvas_edge_agentd::ipc::serve_ipc_with_identity(
        socket_path.clone(),
        real_uid,
        real_uid.wrapping_add(1),
        "test-device",
        "test-installation",
        "test-fingerprint",
    )
    .expect("serve_ipc binds and spawns the IPC thread");

    let (mut reader, session) = connect_and_handshake(&socket_path);
    assert_eq!(session.role, "renderer");

    // A renderer-scoped token calling an updater-only method must be rejected with
    // method_not_allowed -- proving the two allowlists are disjoint (role isolation), the same
    // defense that stops a hostile WebView from pivoting to a privileged method.
    let mut writer = reader.get_ref().try_clone().expect("clone for writing");
    send_request(
        &mut writer,
        &session.capability_token,
        "updater.agent_version",
        Some(json!({ "nonce": "nonce_renderer_pivot_attempt" })),
    );

    let response =
        read_json_line::<ResponseWire>(&mut reader).expect("read response line from daemon");
    match response {
        ResponseWire::Err { code, message } => {
            assert_eq!(
                code, "method_not_allowed",
                "updater method from a renderer token must be rejected as method_not_allowed, got: {message}"
            );
        }
        ResponseWire::Ok { ok, result } => {
            panic!(
                "updater.agent_version from a renderer token was accepted (ok={ok}, result={result})"
            );
        }
    }

    handle.shutdown_and_join();
}

#[test]
fn serve_ipc_thread_joins_promptly_after_shutdown_signal() {
    let real_uid = unsafe { libc::getuid() };
    let dir = tempdir().expect("tempdir for IPC socket");
    let socket_path = dir.path().join("agent.sock");

    let handle = canvas_edge_agentd::ipc::serve_ipc_with_identity(
        socket_path.clone(),
        real_uid,
        real_uid.wrapping_add(1),
        "test-device",
        "test-installation",
        "test-fingerprint",
    )
    .expect("serve_ipc binds and spawns the IPC thread");

    // No client ever connects; the thread is idle in the non-blocking accept poll loop. Signalling
    // shutdown must let `shutdown_and_join` return within a bounded window, proving the
    // non-blocking accept loop actually observes the shutdown flag (mirroring the regression in
    // `transport_spawn_v1.rs` where a blocking sleep did not observe shutdown).
    let start = std::time::Instant::now();
    handle.shutdown_and_join();
    let elapsed = start.elapsed();
    assert!(
        elapsed < Duration::from_secs(3),
        "IPC thread took {elapsed:?} to shut down -- the non-blocking accept loop is not observing the shutdown flag promptly"
    );

    // The socket file should be cleaned up on shutdown.
    assert!(
        !socket_path.exists(),
        "socket file should be unlinked on shutdown, but still exists at {}",
        socket_path.display()
    );
}

// ---------------------------------------------------------------------------
// Phase 3: real hardware adapter dispatch through the daemon's IPC handler
// ---------------------------------------------------------------------------
//
// These tests prove that `display.screen_off` / `display.screen_on` /
// `display.set_brightness` now actually call the hardware adapters (via injected fakes), not just
// log. They use `serve_ipc_with_hardware` with `FakeBrightnessAdapter` + `FakeDpmsAdapter` and
// retain shared call-log handles so they can inspect what the daemon's IPC thread actually did
// after the request round-trip completes.

/// Builds a `HardwareAdapters` bundle from fakes and returns it plus shared call-log handles the
/// test can inspect after the IPC thread has dispatched requests through the adapters.
fn fake_hardware_bundle() -> FakeHardwareBundle {
    let brightness = FakeBrightnessAdapter::new(0, 255);
    let dpms = FakeDpmsAdapter::new();
    let b_log = brightness.call_log();
    let d_log = dpms.call_log();
    let adapters = HardwareAdapters::with_fakes(brightness, dpms);
    (adapters, b_log, d_log)
}

/// The return type of [`fake_hardware_bundle`]: the adapters plus shared call-log handles. Kept as
/// a named type (rather than an anonymous tuple) so clippy's `type_complexity` lint is satisfied
/// and the test bodies read more clearly.
type FakeHardwareBundle = (
    HardwareAdapters,
    Arc<Mutex<Vec<u32>>>,
    Arc<Mutex<Vec<&'static str>>>,
);

#[test]
fn serve_ipc_display_screen_off_calls_the_dpms_adapter() {
    let real_uid = unsafe { libc::getuid() };
    let dir = tempdir().expect("tempdir for IPC socket");
    let socket_path = dir.path().join("agent.sock");

    let (hardware, _b_log, d_log) = fake_hardware_bundle();
    let handle = canvas_edge_agentd::ipc::serve_ipc_with_hardware(
        socket_path.clone(),
        real_uid,
        real_uid.wrapping_add(1),
        hardware,
    )
    .expect("serve_ipc_with_hardware binds and spawns the IPC thread");

    let (mut reader, session) = connect_and_handshake(&socket_path);
    assert_eq!(session.role, "renderer");

    let mut writer = reader.get_ref().try_clone().expect("clone for writing");
    send_request(
        &mut writer,
        &session.capability_token,
        "display.screen_off",
        None,
    );

    let response =
        read_json_line::<ResponseWire>(&mut reader).expect("read response line from daemon");
    match response {
        ResponseWire::Ok { ok, result } => {
            assert!(ok, "display.screen_off should succeed");
            assert_eq!(result, "display.screen_off:executed");
        }
        ResponseWire::Err { code, message } => {
            panic!("display.screen_off was rejected: {code}: {message}");
        }
    }

    handle.shutdown_and_join();

    // The DPMS adapter must have actually been called with screen_off -- proving the IPC handler
    // dispatched to real hardware, not just logged.
    let dpms_calls = d_log.lock().unwrap().clone();
    assert_eq!(
        dpms_calls,
        vec!["screen_off"],
        "DPMS adapter should have recorded screen_off"
    );
}

#[test]
fn serve_ipc_display_screen_on_calls_the_dpms_adapter() {
    let real_uid = unsafe { libc::getuid() };
    let dir = tempdir().expect("tempdir for IPC socket");
    let socket_path = dir.path().join("agent.sock");

    let (hardware, _b_log, d_log) = fake_hardware_bundle();
    let handle = canvas_edge_agentd::ipc::serve_ipc_with_hardware(
        socket_path.clone(),
        real_uid,
        real_uid.wrapping_add(1),
        hardware,
    )
    .expect("serve_ipc_with_hardware binds and spawns the IPC thread");

    let (mut reader, session) = connect_and_handshake(&socket_path);
    assert_eq!(session.role, "renderer");

    let mut writer = reader.get_ref().try_clone().expect("clone for writing");
    send_request(
        &mut writer,
        &session.capability_token,
        "display.screen_on",
        None,
    );

    let response =
        read_json_line::<ResponseWire>(&mut reader).expect("read response line from daemon");
    match response {
        ResponseWire::Ok { ok, result } => {
            assert!(ok, "display.screen_on should succeed");
            assert_eq!(result, "display.screen_on:executed");
        }
        ResponseWire::Err { code, message } => {
            panic!("display.screen_on was rejected: {code}: {message}");
        }
    }

    handle.shutdown_and_join();

    let dpms_calls = d_log.lock().unwrap().clone();
    assert_eq!(
        dpms_calls,
        vec!["screen_on"],
        "DPMS adapter should have recorded screen_on"
    );
}

#[test]
fn serve_ipc_display_set_brightness_calls_the_brightness_adapter_with_the_level() {
    let real_uid = unsafe { libc::getuid() };
    let dir = tempdir().expect("tempdir for IPC socket");
    let socket_path = dir.path().join("agent.sock");

    let (hardware, b_log, _d_log) = fake_hardware_bundle();
    let handle = canvas_edge_agentd::ipc::serve_ipc_with_hardware(
        socket_path.clone(),
        real_uid,
        real_uid.wrapping_add(1),
        hardware,
    )
    .expect("serve_ipc_with_hardware binds and spawns the IPC thread");

    let (mut reader, session) = connect_and_handshake(&socket_path);
    assert_eq!(session.role, "renderer");

    let mut writer = reader.get_ref().try_clone().expect("clone for writing");
    send_request(
        &mut writer,
        &session.capability_token,
        "display.set_brightness",
        Some(json!({ "level": 137 })),
    );

    let response =
        read_json_line::<ResponseWire>(&mut reader).expect("read response line from daemon");
    match response {
        ResponseWire::Ok { ok, result } => {
            assert!(ok, "display.set_brightness should succeed");
            assert_eq!(result, "display.set_brightness:executed");
        }
        ResponseWire::Err { code, message } => {
            panic!("display.set_brightness was rejected: {code}: {message}");
        }
    }

    handle.shutdown_and_join();

    let brightness_calls = b_log.lock().unwrap().clone();
    assert_eq!(
        brightness_calls,
        vec![137],
        "brightness adapter should have recorded set_brightness(137)"
    );
}

#[test]
fn serve_ipc_display_set_brightness_surfaces_an_adapter_error_as_execution_failed() {
    let real_uid = unsafe { libc::getuid() };
    let dir = tempdir().expect("tempdir for IPC socket");
    let socket_path = dir.path().join("agent.sock");

    // Configure the DPMS adapter to fail screen_off with a canned message; the IPC handler should
    // surface that as an execution failure rather than silently succeeding.
    let dpms = FakeDpmsAdapter::new().with_next_error("fake dpms hardware failure");
    let d_log = dpms.call_log();
    let brightness = FakeBrightnessAdapter::new(0, 255);
    let hardware = HardwareAdapters::with_fakes(brightness, dpms);

    let handle = canvas_edge_agentd::ipc::serve_ipc_with_hardware(
        socket_path.clone(),
        real_uid,
        real_uid.wrapping_add(1),
        hardware,
    )
    .expect("serve_ipc_with_hardware binds and spawns the IPC thread");

    let (mut reader, session) = connect_and_handshake(&socket_path);
    assert_eq!(session.role, "renderer");

    let mut writer = reader.get_ref().try_clone().expect("clone for writing");
    send_request(
        &mut writer,
        &session.capability_token,
        "display.screen_off",
        None,
    );

    let response =
        read_json_line::<ResponseWire>(&mut reader).expect("read response line from daemon");
    match response {
        ResponseWire::Err { code, message } => {
            assert_eq!(
                code, "execution_failed",
                "adapter failure should surface as execution_failed, got: {message}"
            );
            assert!(
                message.contains("fake dpms hardware failure"),
                "error message should carry the adapter's reason, got: {message}"
            );
        }
        ResponseWire::Ok { ok, result } => {
            panic!("display.screen_off should have failed (ok={ok}, result={result})");
        }
    }

    handle.shutdown_and_join();

    // The adapter was still called (the failure happened *inside* the adapter, not before it).
    let dpms_calls = d_log.lock().unwrap().clone();
    assert_eq!(dpms_calls, vec!["screen_off"]);
}

#[test]
fn serve_ipc_with_injectable_real_sysfs_brightness_writes_through_the_real_adapter() {
    // End-to-end: real sysfs brightness adapter (against a tempdir) + fake command runner for
    // DPMS, dispatched through the daemon's real IPC path. Proves the daemon can drive real
    // sysfs hardware, not just fakes.
    let real_uid = unsafe { libc::getuid() };
    let ipc_dir = tempdir().expect("tempdir for IPC socket");
    let socket_path = ipc_dir.path().join("agent.sock");

    let backlight_dir = tempdir().expect("tempdir for fake backlight");
    let device = backlight_dir.path().join("test_panel");
    std::fs::create_dir_all(&device).expect("create fake backlight device dir");
    std::fs::write(device.join("brightness"), b"5\n").expect("write brightness");
    std::fs::write(device.join("max_brightness"), b"255\n").expect("write max_brightness");

    let runner = FakeCommandRunner::new();
    let cmd_log = runner.call_log();
    let hardware = HardwareAdapters::with_injectable(backlight_dir.path(), runner);

    let handle = canvas_edge_agentd::ipc::serve_ipc_with_hardware(
        socket_path.clone(),
        real_uid,
        real_uid.wrapping_add(1),
        hardware,
    )
    .expect("serve_ipc_with_hardware binds and spawns the IPC thread");

    let (mut reader, session) = connect_and_handshake(&socket_path);
    assert_eq!(session.role, "renderer");

    let mut writer = reader.get_ref().try_clone().expect("clone for writing");
    send_request(
        &mut writer,
        &session.capability_token,
        "display.set_brightness",
        Some(json!({ "level": 200 })),
    );

    let response =
        read_json_line::<ResponseWire>(&mut reader).expect("read response line from daemon");
    match response {
        ResponseWire::Ok { ok, result } => {
            assert!(ok, "display.set_brightness should succeed");
            assert_eq!(result, "display.set_brightness:executed");
        }
        ResponseWire::Err { code, message } => {
            panic!("display.set_brightness was rejected: {code}: {message}");
        }
    }

    handle.shutdown_and_join();

    // The real sysfs adapter should have written 200 to the fake brightness file.
    let written =
        std::fs::read_to_string(device.join("brightness")).expect("read back brightness file");
    assert_eq!(written.trim(), "200");

    // And the DPMS path was not exercised by this request (no xset invocation).
    let recorded = cmd_log.lock().unwrap().clone();
    assert!(recorded.is_empty(), "no xset should have been spawned");
}

// ---------------------------------------------------------------------------
// Phase 3: audio adapter dispatch through the daemon's IPC handler
// ---------------------------------------------------------------------------
//
// These tests prove that `audio.play` / `audio.pause` / `audio.resume` / `audio.stop` /
// `audio.set_volume` / `audio.set_mute` / `audio.state` now actually call the audio adapters (via
// injected fakes), not just log. They use `serve_ipc_with_hardware_and_audio` with
// `FakeVolumeAdapter` + `FakePlaybackAdapter` and retain shared call-log handles so they can
// inspect what the daemon's IPC thread actually did after the request round-trip completes.

use canvas_edge_agent::hardware::audio::{FakePlaybackAdapter, FakeVolumeAdapter, PlaybackState};
use canvas_edge_agent::hardware::AudioAdapters;

/// Builds an `AudioAdapters` bundle from fakes and returns it plus shared call-log handles the
/// test can inspect after the IPC thread has dispatched requests through the adapters.
fn fake_audio_bundle() -> FakeAudioBundle {
    let volume = FakeVolumeAdapter::new(50, false);
    let playback = FakePlaybackAdapter::new();
    let v_log = volume.call_log();
    let p_log = playback.call_log();
    let adapters = AudioAdapters::with_fakes(volume, playback);
    (adapters, v_log, p_log)
}

/// The return type of [`fake_audio_bundle`]: the adapters plus shared call-log handles. Kept as a
/// named type (rather than an anonymous tuple) so clippy's `type_complexity` lint is satisfied.
type FakeAudioBundle = (
    AudioAdapters,
    Arc<Mutex<Vec<String>>>,
    Arc<Mutex<Vec<String>>>,
);

#[test]
fn serve_ipc_audio_play_calls_the_playback_and_volume_adapters() {
    let real_uid = unsafe { libc::getuid() };
    let dir = tempdir().expect("tempdir for IPC socket");
    let socket_path = dir.path().join("agent.sock");

    let (hardware, _b_log, _d_log) = fake_hardware_bundle();
    let (audio, v_log, p_log) = fake_audio_bundle();
    let handle = canvas_edge_agentd::ipc::serve_ipc_with_hardware_and_audio(
        socket_path.clone(),
        real_uid,
        real_uid.wrapping_add(1),
        hardware,
        audio,
    )
    .expect("serve_ipc_with_hardware_and_audio binds and spawns the IPC thread");

    let (mut reader, session) = connect_and_handshake(&socket_path);
    assert_eq!(session.role, "renderer");

    let mut writer = reader.get_ref().try_clone().expect("clone for writing");
    send_request(
        &mut writer,
        &session.capability_token,
        "audio.play",
        Some(json!({ "url": "https://example.com/stream.mp3", "volume": 75 })),
    );

    let response =
        read_json_line::<ResponseWire>(&mut reader).expect("read response line from daemon");
    match response {
        ResponseWire::Ok { ok, result } => {
            assert!(ok, "audio.play should succeed");
            assert_eq!(result, "audio.play:executed");
        }
        ResponseWire::Err { code, message } => {
            panic!("audio.play was rejected: {code}: {message}");
        }
    }

    handle.shutdown_and_join();

    // The volume adapter should have been called with set_volume(75) (the daemon sets the system
    // volume before spawning mpv, mirroring the sidecar).
    let volume_calls = v_log.lock().unwrap().clone();
    assert_eq!(
        volume_calls,
        vec!["set_volume:75"],
        "volume adapter should have recorded set_volume(75)"
    );

    // The playback adapter should have been called with play(url, 75).
    let playback_calls = p_log.lock().unwrap().clone();
    assert_eq!(
        playback_calls,
        vec!["play:https://example.com/stream.mp3@75"],
        "playback adapter should have recorded play(url, 75)"
    );
}

#[test]
fn serve_ipc_audio_pause_calls_the_playback_adapter() {
    let real_uid = unsafe { libc::getuid() };
    let dir = tempdir().expect("tempdir for IPC socket");
    let socket_path = dir.path().join("agent.sock");

    let (hardware, _b_log, _d_log) = fake_hardware_bundle();
    let (audio, _v_log, p_log) = fake_audio_bundle();
    let handle = canvas_edge_agentd::ipc::serve_ipc_with_hardware_and_audio(
        socket_path.clone(),
        real_uid,
        real_uid.wrapping_add(1),
        hardware,
        audio,
    )
    .expect("serve_ipc_with_hardware_and_audio binds and spawns the IPC thread");

    let (mut reader, session) = connect_and_handshake(&socket_path);
    assert_eq!(session.role, "renderer");

    let mut writer = reader.get_ref().try_clone().expect("clone for writing");
    send_request(&mut writer, &session.capability_token, "audio.pause", None);

    let response =
        read_json_line::<ResponseWire>(&mut reader).expect("read response line from daemon");
    match response {
        ResponseWire::Ok { ok, result } => {
            assert!(ok, "audio.pause should succeed");
            assert_eq!(result, "audio.pause:executed");
        }
        ResponseWire::Err { code, message } => {
            panic!("audio.pause was rejected: {code}: {message}");
        }
    }

    handle.shutdown_and_join();

    let playback_calls = p_log.lock().unwrap().clone();
    assert_eq!(
        playback_calls,
        vec!["pause"],
        "playback adapter should have recorded pause"
    );
}

#[test]
fn serve_ipc_audio_stop_calls_the_playback_adapter() {
    let real_uid = unsafe { libc::getuid() };
    let dir = tempdir().expect("tempdir for IPC socket");
    let socket_path = dir.path().join("agent.sock");

    let (hardware, _b_log, _d_log) = fake_hardware_bundle();
    let (audio, _v_log, p_log) = fake_audio_bundle();
    let handle = canvas_edge_agentd::ipc::serve_ipc_with_hardware_and_audio(
        socket_path.clone(),
        real_uid,
        real_uid.wrapping_add(1),
        hardware,
        audio,
    )
    .expect("serve_ipc_with_hardware_and_audio binds and spawns the IPC thread");

    let (mut reader, session) = connect_and_handshake(&socket_path);
    assert_eq!(session.role, "renderer");

    let mut writer = reader.get_ref().try_clone().expect("clone for writing");
    send_request(&mut writer, &session.capability_token, "audio.stop", None);

    let response =
        read_json_line::<ResponseWire>(&mut reader).expect("read response line from daemon");
    match response {
        ResponseWire::Ok { ok, result } => {
            assert!(ok, "audio.stop should succeed");
            assert_eq!(result, "audio.stop:executed");
        }
        ResponseWire::Err { code, message } => {
            panic!("audio.stop was rejected: {code}: {message}");
        }
    }

    handle.shutdown_and_join();

    let playback_calls = p_log.lock().unwrap().clone();
    assert_eq!(
        playback_calls,
        vec!["stop"],
        "playback adapter should have recorded stop"
    );
}

#[test]
fn serve_ipc_audio_set_volume_calls_the_volume_and_playback_adapters() {
    let real_uid = unsafe { libc::getuid() };
    let dir = tempdir().expect("tempdir for IPC socket");
    let socket_path = dir.path().join("agent.sock");

    let (hardware, _b_log, _d_log) = fake_hardware_bundle();
    let (audio, v_log, p_log) = fake_audio_bundle();
    let handle = canvas_edge_agentd::ipc::serve_ipc_with_hardware_and_audio(
        socket_path.clone(),
        real_uid,
        real_uid.wrapping_add(1),
        hardware,
        audio,
    )
    .expect("serve_ipc_with_hardware_and_audio binds and spawns the IPC thread");

    let (mut reader, session) = connect_and_handshake(&socket_path);
    assert_eq!(session.role, "renderer");

    let mut writer = reader.get_ref().try_clone().expect("clone for writing");
    send_request(
        &mut writer,
        &session.capability_token,
        "audio.set_volume",
        Some(json!({ "level": 42 })),
    );

    let response =
        read_json_line::<ResponseWire>(&mut reader).expect("read response line from daemon");
    match response {
        ResponseWire::Ok { ok, result } => {
            assert!(ok, "audio.set_volume should succeed");
            assert_eq!(result, "audio.set_volume:executed");
        }
        ResponseWire::Err { code, message } => {
            panic!("audio.set_volume was rejected: {code}: {message}");
        }
    }

    handle.shutdown_and_join();

    // The volume adapter should have been called with set_volume(42).
    let volume_calls = v_log.lock().unwrap().clone();
    assert_eq!(
        volume_calls,
        vec!["set_volume:42"],
        "volume adapter should have recorded set_volume(42)"
    );

    // The playback adapter should have been called with set_volume(42) too (the daemon updates the
    // running mpv's volume when set_volume is called, mirroring the sidecar).
    let playback_calls = p_log.lock().unwrap().clone();
    assert_eq!(
        playback_calls,
        vec!["set_volume:42"],
        "playback adapter should have recorded set_volume(42)"
    );
}

#[test]
fn serve_ipc_audio_set_mute_calls_the_volume_adapter() {
    let real_uid = unsafe { libc::getuid() };
    let dir = tempdir().expect("tempdir for IPC socket");
    let socket_path = dir.path().join("agent.sock");

    let (hardware, _b_log, _d_log) = fake_hardware_bundle();
    let (audio, v_log, _p_log) = fake_audio_bundle();
    let handle = canvas_edge_agentd::ipc::serve_ipc_with_hardware_and_audio(
        socket_path.clone(),
        real_uid,
        real_uid.wrapping_add(1),
        hardware,
        audio,
    )
    .expect("serve_ipc_with_hardware_and_audio binds and spawns the IPC thread");

    let (mut reader, session) = connect_and_handshake(&socket_path);
    assert_eq!(session.role, "renderer");

    let mut writer = reader.get_ref().try_clone().expect("clone for writing");
    send_request(
        &mut writer,
        &session.capability_token,
        "audio.set_mute",
        Some(json!({ "muted": true })),
    );

    let response =
        read_json_line::<ResponseWire>(&mut reader).expect("read response line from daemon");
    match response {
        ResponseWire::Ok { ok, result } => {
            assert!(ok, "audio.set_mute should succeed");
            assert_eq!(result, "audio.set_mute:executed");
        }
        ResponseWire::Err { code, message } => {
            panic!("audio.set_mute was rejected: {code}: {message}");
        }
    }

    handle.shutdown_and_join();

    let volume_calls = v_log.lock().unwrap().clone();
    assert_eq!(
        volume_calls,
        vec!["set_mute:true"],
        "volume adapter should have recorded set_mute(true)"
    );
}

#[test]
fn serve_ipc_audio_state_returns_the_current_playback_and_volume_state() {
    let real_uid = unsafe { libc::getuid() };
    let dir = tempdir().expect("tempdir for IPC socket");
    let socket_path = dir.path().join("agent.sock");

    let (hardware, _b_log, _d_log) = fake_hardware_bundle();
    // Configure the fake volume adapter with a known current volume + muted state so we can
    // assert the state response carries them.
    let volume = FakeVolumeAdapter::new(42, true);
    let playback = FakePlaybackAdapter::new();
    let audio = AudioAdapters::with_fakes(volume, playback);
    let handle = canvas_edge_agentd::ipc::serve_ipc_with_hardware_and_audio(
        socket_path.clone(),
        real_uid,
        real_uid.wrapping_add(1),
        hardware,
        audio,
    )
    .expect("serve_ipc_with_hardware_and_audio binds and spawns the IPC thread");

    let (mut reader, session) = connect_and_handshake(&socket_path);
    assert_eq!(session.role, "renderer");

    let mut writer = reader.get_ref().try_clone().expect("clone for writing");
    send_request(&mut writer, &session.capability_token, "audio.state", None);

    let response =
        read_json_line::<ResponseWire>(&mut reader).expect("read response line from daemon");
    let result = match response {
        ResponseWire::Ok { ok, result } => {
            assert!(ok, "audio.state should succeed");
            result
        }
        ResponseWire::Err { code, message } => {
            panic!("audio.state was rejected: {code}: {message}");
        }
    };

    handle.shutdown_and_join();

    // The result should be a JSON object with the playback state (idle, since the fake playback
    // adapter starts idle), the volume (42, from the fake volume adapter), and muted (true).
    let parsed: serde_json::Value =
        serde_json::from_str(&result).expect("audio.state result should be JSON");
    assert_eq!(parsed["state"], serde_json::json!("idle"));
    assert_eq!(parsed["volume"], serde_json::json!(42));
    assert_eq!(parsed["muted"], serde_json::json!(true));
}

#[test]
fn serve_ipc_audio_play_without_volume_falls_back_to_the_current_system_volume() {
    // Mirrors the sidecar's `volume ?? _state.volume`: when the caller omits `volume`, the daemon
    // falls back to the current system volume (from the volume adapter).
    let real_uid = unsafe { libc::getuid() };
    let dir = tempdir().expect("tempdir for IPC socket");
    let socket_path = dir.path().join("agent.sock");

    let (hardware, _b_log, _d_log) = fake_hardware_bundle();
    // Configure the fake volume adapter with a known current volume (50) so the fallback is
    // deterministic.
    let volume = FakeVolumeAdapter::new(50, false);
    let playback = FakePlaybackAdapter::new();
    let v_log = volume.call_log();
    let p_log = playback.call_log();
    let audio = AudioAdapters::with_fakes(volume, playback);
    let handle = canvas_edge_agentd::ipc::serve_ipc_with_hardware_and_audio(
        socket_path.clone(),
        real_uid,
        real_uid.wrapping_add(1),
        hardware,
        audio,
    )
    .expect("serve_ipc_with_hardware_and_audio binds and spawns the IPC thread");

    let (mut reader, session) = connect_and_handshake(&socket_path);
    assert_eq!(session.role, "renderer");

    let mut writer = reader.get_ref().try_clone().expect("clone for writing");
    send_request(
        &mut writer,
        &session.capability_token,
        "audio.play",
        Some(json!({ "url": "https://example.com/x" })),
    );

    let response =
        read_json_line::<ResponseWire>(&mut reader).expect("read response line from daemon");
    match response {
        ResponseWire::Ok { ok, result } => {
            assert!(ok, "audio.play should succeed");
            assert_eq!(result, "audio.play:executed");
        }
        ResponseWire::Err { code, message } => {
            panic!("audio.play was rejected: {code}: {message}");
        }
    }

    handle.shutdown_and_join();

    // The volume adapter should have been called with set_volume(50) (the fallback), and the
    // playback adapter with play(url, 50).
    let volume_calls = v_log.lock().unwrap().clone();
    assert_eq!(
        volume_calls,
        vec!["set_volume:50"],
        "volume adapter should have recorded set_volume(50)"
    );
    let playback_calls = p_log.lock().unwrap().clone();
    assert_eq!(
        playback_calls,
        vec!["play:https://example.com/x@50"],
        "playback adapter should have recorded play(url, 50)"
    );
}

#[test]
fn serve_ipc_audio_play_surfaces_an_adapter_error_as_execution_failed() {
    let real_uid = unsafe { libc::getuid() };
    let dir = tempdir().expect("tempdir for IPC socket");
    let socket_path = dir.path().join("agent.sock");

    let (hardware, _b_log, _d_log) = fake_hardware_bundle();
    // Configure the volume adapter to fail set_volume with a canned message; the IPC handler
    // should surface that as an execution failure rather than silently succeeding.
    let volume = FakeVolumeAdapter::new(50, false).with_next_error("fake pactl hardware failure");
    let playback = FakePlaybackAdapter::new();
    let audio = AudioAdapters::with_fakes(volume, playback);
    let handle = canvas_edge_agentd::ipc::serve_ipc_with_hardware_and_audio(
        socket_path.clone(),
        real_uid,
        real_uid.wrapping_add(1),
        hardware,
        audio,
    )
    .expect("serve_ipc_with_hardware_and_audio binds and spawns the IPC thread");

    let (mut reader, session) = connect_and_handshake(&socket_path);
    assert_eq!(session.role, "renderer");

    let mut writer = reader.get_ref().try_clone().expect("clone for writing");
    send_request(
        &mut writer,
        &session.capability_token,
        "audio.play",
        Some(json!({ "url": "https://example.com/x", "volume": 75 })),
    );

    let response =
        read_json_line::<ResponseWire>(&mut reader).expect("read response line from daemon");
    match response {
        ResponseWire::Err { code, message } => {
            assert_eq!(
                code, "execution_failed",
                "adapter failure should surface as execution_failed, got: {message}"
            );
            assert!(
                message.contains("fake pactl hardware failure"),
                "error message should carry the adapter's reason, got: {message}"
            );
        }
        ResponseWire::Ok { ok, result } => {
            panic!("audio.play should have failed (ok={ok}, result={result})");
        }
    }

    handle.shutdown_and_join();
}

#[test]
fn serve_ipc_audio_resume_calls_the_playback_adapter() {
    let real_uid = unsafe { libc::getuid() };
    let dir = tempdir().expect("tempdir for IPC socket");
    let socket_path = dir.path().join("agent.sock");

    let (hardware, _b_log, _d_log) = fake_hardware_bundle();
    let (audio, _v_log, p_log) = fake_audio_bundle();
    let handle = canvas_edge_agentd::ipc::serve_ipc_with_hardware_and_audio(
        socket_path.clone(),
        real_uid,
        real_uid.wrapping_add(1),
        hardware,
        audio,
    )
    .expect("serve_ipc_with_hardware_and_audio binds and spawns the IPC thread");

    let (mut reader, session) = connect_and_handshake(&socket_path);
    assert_eq!(session.role, "renderer");

    let mut writer = reader.get_ref().try_clone().expect("clone for writing");
    send_request(&mut writer, &session.capability_token, "audio.resume", None);

    let response =
        read_json_line::<ResponseWire>(&mut reader).expect("read response line from daemon");
    match response {
        ResponseWire::Ok { ok, result } => {
            assert!(ok, "audio.resume should succeed");
            assert_eq!(result, "audio.resume:executed");
        }
        ResponseWire::Err { code, message } => {
            panic!("audio.resume was rejected: {code}: {message}");
        }
    }

    handle.shutdown_and_join();

    let playback_calls = p_log.lock().unwrap().clone();
    assert_eq!(
        playback_calls,
        vec!["resume"],
        "playback adapter should have recorded resume"
    );
}

#[test]
fn playback_state_as_str_matches_the_sidecar_string_values() {
    // The state strings must match the sidecar's `AudioPlayState` ('idle' | 'playing' | 'paused')
    // so the renderer does not have to translate between the two.
    assert_eq!(PlaybackState::Idle.as_str(), "idle");
    assert_eq!(PlaybackState::Playing.as_str(), "playing");
    assert_eq!(PlaybackState::Paused.as_str(), "paused");
}
