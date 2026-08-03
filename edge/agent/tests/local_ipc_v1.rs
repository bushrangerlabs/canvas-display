//! Integration tests proving real peer-verified, method-scoped local IPC (Phase 1 checklist item,
//! architecture plan §25) for `canvas_edge_agent::ipc`. See module docs in
//! `edge/agent/src/ipc/mod.rs` / `edge/agent/src/ipc/broker.rs` for what is real vs. deliberately
//! simplified, and `tests/local-ipc/local-ipc.test.ts` / `docs/PHASE_0_LOCAL_IPC_SPEC.md` for the
//! design contract this ports from a pure TypeScript model into real Rust with a real transport.
//!
//! Which tests use the real `SO_PEERCRED` path vs. the fake/injectable credential source:
//!
//! - `real_so_peercred_identifies_the_test_processs_own_uid_over_a_real_socket` and
//!   `real_so_peercred_path_authenticates_through_the_broker_accept` are the true end-to-end
//!   tests: they bind a real `UnixListener`, connect a real `UnixStream` client from this same
//!   test process, accept it, and read the connecting process's *real*, kernel-verified
//!   `SO_PEERCRED` credential via `SoPeercredSource`. Since the client and server are the same
//!   test process, the expected uid/pid are simply this process's own `getuid()`/`getpid()`.
//! - Every other test below uses `FakePeerCredentialSource` (or calls `LocalIpcBroker::connect`
//!   directly with a hand-built `PeerCredential`, which is equivalent) to simulate uids that do
//!   not belong to this test process -- a single test process cannot become a different real OS
//!   user, so "wrong peer" / "renderer vs. updater" scenarios are simulated this way, exactly as
//!   the task's design notes anticipated.

use std::os::unix::net::{UnixListener, UnixStream};
use std::thread;

use canvas_edge_agent::ipc::{
    AcceptError, CurrentActionExecutor, CurrentActionHandler, DispatchRequest,
    FakePeerCredentialSource, LocalIpcBroker, LocalIpcConfig, LocalIpcErrorCode, PeerCredential,
    PeerCredentialSource, PeerRole, RecordingActionExecutor, SoPeercredSource,
};
use tempfile::tempdir;

const RENDERER_UID: u32 = 1500;
const UPDATER_UID: u32 = 1501;
const HOSTILE_UID: u32 = 1999;

fn broker() -> LocalIpcBroker {
    LocalIpcBroker::new(LocalIpcConfig {
        renderer_uid: RENDERER_UID,
        updater_uid: UPDATER_UID,
    })
}

fn credential(uid: u32, pid: i32) -> PeerCredential {
    PeerCredential { uid, gid: uid, pid }
}

fn request(capability_token: &str, method: &str) -> DispatchRequest {
    DispatchRequest {
        capability_token: capability_token.to_string(),
        method: method.to_string(),
        nonce: None,
        arguments: None,
    }
}

fn request_with_nonce(capability_token: &str, method: &str, nonce: &str) -> DispatchRequest {
    DispatchRequest {
        capability_token: capability_token.to_string(),
        method: method.to_string(),
        nonce: Some(nonce.to_string()),
        arguments: None,
    }
}

/// Binds a real Unix domain socket in a fresh temp directory, spawns a thread that connects a
/// real client to it from this same process, and returns the accepted server-side stream (the
/// client stream is joined/dropped internally). This is the real transport this crate stands up
/// for the true end-to-end `SO_PEERCRED` tests below.
fn accept_a_real_connection() -> UnixStream {
    let dir = tempdir().expect("tempdir for unix socket");
    let socket_path = dir.path().join("agent.sock");
    let listener = UnixListener::bind(&socket_path).expect("bind unix domain socket");

    let client_path = socket_path.clone();
    let client_thread = thread::spawn(move || {
        UnixStream::connect(&client_path).expect("real client connects to the real socket")
    });

    let (server_stream, _addr) = listener
        .accept()
        .expect("accept the real client connection");
    let _client_stream = client_thread.join().expect("client thread completes");
    // Keep the temp directory alive until after accept() by holding `dir` in scope here.
    drop(dir);
    server_stream
}

#[test]
fn real_so_peercred_identifies_the_test_processs_own_uid_over_a_real_socket() {
    let server_stream = accept_a_real_connection();

    let source = SoPeercredSource;
    let credential = source
        .identify(&server_stream)
        .expect("real SO_PEERCRED getsockopt succeeds for a live local connection");

    let expected_uid = unsafe { libc::getuid() };
    let expected_pid = std::process::id() as i32;

    assert_eq!(credential.uid, expected_uid);
    assert_eq!(credential.pid, expected_pid);
}

#[test]
fn real_so_peercred_path_authenticates_through_the_broker_accept() {
    let real_uid = unsafe { libc::getuid() };

    let dir = tempdir().expect("tempdir for unix socket");
    let socket_path = dir.path().join("agent.sock");
    let listener = UnixListener::bind(&socket_path).expect("bind unix domain socket");

    let client_path = socket_path.clone();
    let client_thread = thread::spawn(move || {
        UnixStream::connect(&client_path).expect("real client connects to the real socket")
    });

    // Configure the real test process's own uid as the "renderer" uid, so the broker's
    // production identify-and-authenticate path succeeds against a genuinely OS-verified
    // credential -- not a simulated one.
    let mut ipc = LocalIpcBroker::new(LocalIpcConfig {
        renderer_uid: real_uid,
        updater_uid: real_uid.wrapping_add(1),
    });

    let (server_stream, session) = ipc
        .accept(&listener, &SoPeercredSource)
        .expect("real accept + real SO_PEERCRED identify + authenticate succeeds");
    let _client_stream = client_thread.join().expect("client thread completes");

    assert_eq!(session.role, PeerRole::Renderer);
    assert_eq!(session.generation, 1);

    let result = ipc.dispatch(request(&session.capability_token, "scene.activate"));
    assert!(result.is_ok());

    drop(server_stream);
}

#[test]
fn wrong_peer_uid_is_rejected_over_a_real_socket_via_the_fake_credential_source() {
    // A single test process cannot itself become a different real OS user, so this test uses a
    // real socket/connection but an injected fake credential to simulate a hostile/unauthorized
    // uid arriving on the other end.
    let server_stream = accept_a_real_connection();
    let fake_source = FakePeerCredentialSource::new(HOSTILE_UID, HOSTILE_UID, 100);

    let credential = fake_source
        .identify(&server_stream)
        .expect("fake source always returns its injected credential");
    assert_eq!(credential.uid, HOSTILE_UID);

    let mut ipc = broker();
    let result = ipc.connect(credential);
    let err =
        result.expect_err("an unauthorized uid must be rejected before any capability is issued");
    assert_eq!(err.code, LocalIpcErrorCode::WrongPeer);
}

#[test]
fn wrong_peer_uid_is_rejected_via_broker_accept_with_a_fake_source() {
    let dir = tempdir().expect("tempdir for unix socket");
    let socket_path = dir.path().join("agent.sock");
    let listener = UnixListener::bind(&socket_path).expect("bind unix domain socket");

    let client_path = socket_path.clone();
    let client_thread = thread::spawn(move || {
        UnixStream::connect(&client_path).expect("real client connects to the real socket")
    });

    let mut ipc = broker();
    let fake_source = FakePeerCredentialSource::new(HOSTILE_UID, HOSTILE_UID, 100);
    let result = ipc.accept(&listener, &fake_source);
    let _client_stream = client_thread.join().expect("client thread completes");

    match result {
        Err(AcceptError::Rejected(err)) => assert_eq!(err.code, LocalIpcErrorCode::WrongPeer),
        other => panic!("expected AcceptError::Rejected(wrong_peer), got {other:?}"),
    }
}

#[test]
fn a_legitimate_renderer_peer_can_call_its_allowlisted_methods() {
    let mut ipc = broker();
    let session = ipc
        .connect(credential(RENDERER_UID, 100))
        .expect("renderer uid is authorized");

    let result = ipc
        .dispatch(request(&session.capability_token, "scene.activate"))
        .expect("allowlisted renderer method is accepted");
    assert!(result.ok);
    assert_eq!(result.result, "scene.activate:accepted");
}

#[test]
fn a_legitimate_updater_peer_can_call_its_allowlisted_methods_with_a_fresh_nonce() {
    let mut ipc = broker();
    let session = ipc
        .connect(credential(UPDATER_UID, 100))
        .expect("updater uid is authorized");

    let result = ipc
        .dispatch(request_with_nonce(
            &session.capability_token,
            "updater.install_package",
            "nonce-1",
        ))
        .expect("allowlisted updater method with a fresh nonce is accepted");
    assert!(result.ok);
}

#[test]
fn renderer_capability_cannot_invoke_an_updater_only_method() {
    let mut ipc = broker();
    let session = ipc
        .connect(credential(RENDERER_UID, 100))
        .expect("renderer uid is authorized");

    let err = ipc
        .dispatch(request_with_nonce(
            &session.capability_token,
            "updater.install_package",
            "x",
        ))
        .expect_err("a renderer capability must never reach an updater method");
    assert_eq!(err.code, LocalIpcErrorCode::MethodNotAllowed);
}

#[test]
fn updater_capability_cannot_invoke_a_renderer_only_method() {
    let mut ipc = broker();
    let session = ipc
        .connect(credential(UPDATER_UID, 100))
        .expect("updater uid is authorized");

    let err = ipc
        .dispatch(request(&session.capability_token, "scene.activate"))
        .expect_err("an updater capability must never reach a renderer method");
    assert_eq!(err.code, LocalIpcErrorCode::MethodNotAllowed);
}

#[test]
fn hostile_webview_style_leaked_renderer_token_cannot_pivot_to_a_privileged_method() {
    // Models content adjacent to the renderer (e.g. a compromised WebView) that has somehow
    // obtained a copy of the renderer's own, otherwise-valid capability token. Because
    // method-scope enforcement never depends on "is this otherwise a valid session," the same
    // allowlist check that stops a legitimate renderer mistake also stops this pivot attempt.
    let mut ipc = broker();
    let session = ipc
        .connect(credential(RENDERER_UID, 100))
        .expect("renderer uid is authorized");
    let leaked_token = session.capability_token.clone();

    let err = ipc
        .dispatch(request_with_nonce(
            &leaked_token,
            "updater.install_package",
            "stolen",
        ))
        .expect_err("a leaked renderer token must not reach a privileged updater method");
    assert_eq!(err.code, LocalIpcErrorCode::MethodNotAllowed);
}

#[test]
fn no_plausible_hostile_method_name_ever_reaches_anything_key_related() {
    // There is no key-store type or import anywhere in `canvas_edge_agent::ipc` (see
    // `broker.rs` module docs) -- the dispatcher has no reference to any key material at all, by
    // construction. Behaviorally, every plausible-sounding hostile method name must fail exactly
    // the same `method_not_allowed` check as any other out-of-scope method, for either role.
    let mut ipc = broker();
    let renderer_session = ipc
        .connect(credential(RENDERER_UID, 100))
        .expect("renderer uid is authorized");

    let hostile_method_names = [
        "agent.export_private_key",
        "agent.read_private_key",
        "debug.dump_key",
        "key.read",
        "agent.key",
    ];

    for method in hostile_method_names {
        let err = ipc
            .dispatch(request(&renderer_session.capability_token, method))
            .expect_err("hostile method names must never be allowlisted");
        assert_eq!(err.code, LocalIpcErrorCode::MethodNotAllowed);
    }
}

#[test]
fn updater_methods_require_a_nonce_and_reject_nonce_replay() {
    let mut ipc = broker();
    let session = ipc
        .connect(credential(UPDATER_UID, 100))
        .expect("updater uid is authorized");

    let missing_nonce = ipc
        .dispatch(request(&session.capability_token, "updater.rollback"))
        .expect_err("a missing nonce must be rejected");
    assert_eq!(missing_nonce.code, LocalIpcErrorCode::NonceRequired);

    let ok = ipc
        .dispatch(request_with_nonce(
            &session.capability_token,
            "updater.rollback",
            "reused",
        ))
        .expect("a fresh nonce is accepted");
    assert!(ok.ok);

    let replayed = ipc
        .dispatch(request_with_nonce(
            &session.capability_token,
            "updater.rollback",
            "reused",
        ))
        .expect_err("a reused nonce must be rejected");
    assert_eq!(replayed.code, LocalIpcErrorCode::NonceReplayed);
}

#[test]
fn stale_capability_a_renderer_restart_fences_out_the_previous_generations_token() {
    let mut ipc = broker();
    let first_generation = ipc
        .connect(credential(RENDERER_UID, 100))
        .expect("first renderer connection succeeds");
    // Renderer crashes and a new process (new pid) reconnects.
    let second_generation = ipc
        .connect(credential(RENDERER_UID, 200))
        .expect("reconnect succeeds");

    assert_eq!(
        second_generation.generation,
        first_generation.generation + 1
    );

    let stale = ipc
        .dispatch(request(
            &first_generation.capability_token,
            "scene.activate",
        ))
        .expect_err("the old token must be rejected even though it was never explicitly revoked");
    assert_eq!(stale.code, LocalIpcErrorCode::StaleCapability);

    let ok = ipc
        .dispatch(request(
            &second_generation.capability_token,
            "scene.activate",
        ))
        .expect("the new generation's token works fine");
    assert!(ok.ok);
}

#[test]
fn stale_capability_an_unknown_never_issued_token_is_rejected_the_same_way() {
    let mut ipc = broker();
    ipc.connect(credential(RENDERER_UID, 100))
        .expect("renderer uid is authorized");

    let err = ipc
        .dispatch(request("forged-token-never-issued", "scene.activate"))
        .expect_err("a forged token must be rejected");
    assert_eq!(err.code, LocalIpcErrorCode::StaleCapability);
}

#[test]
fn renderer_restart_does_not_reset_agent_owned_durable_state() {
    let mut ipc = broker();
    let first = ipc
        .connect(credential(RENDERER_UID, 100))
        .expect("first renderer connection succeeds");
    ipc.durable_state.next_outbox_sequence();
    ipc.durable_state.next_outbox_sequence();
    assert_eq!(ipc.durable_state.outbox_sequence(), 2);

    ipc.disconnect(&first);
    // Renderer restarts (new pid, new generation).
    ipc.connect(credential(RENDERER_UID, 101))
        .expect("reconnect succeeds");

    // Durable Agent state survived the renderer restart untouched.
    assert_eq!(ipc.durable_state.outbox_sequence(), 2);
    ipc.durable_state.next_outbox_sequence();
    assert_eq!(ipc.durable_state.outbox_sequence(), 3);
}

#[test]
fn renderer_and_updater_generations_are_tracked_independently() {
    let mut ipc = broker();
    let renderer_session = ipc
        .connect(credential(RENDERER_UID, 100))
        .expect("renderer uid is authorized");
    let updater_session = ipc
        .connect(credential(UPDATER_UID, 100))
        .expect("updater uid is authorized");

    assert_eq!(renderer_session.generation, 1);
    assert_eq!(updater_session.generation, 1);

    // A second renderer connection does not disturb the updater's generation/capability.
    ipc.connect(credential(RENDERER_UID, 999))
        .expect("renderer reconnect succeeds");
    let still_ok = ipc
        .dispatch(request_with_nonce(
            &updater_session.capability_token,
            "updater.health_report",
            "still-valid",
        ))
        .expect("the updater's capability is unaffected by an unrelated renderer reconnect");
    assert!(still_ok.ok);
}

#[test]
fn dispatch_forwards_to_a_real_action_executor_instead_of_the_placeholder() {
    let mut ipc = LocalIpcBroker::with_token_source_and_executor(
        LocalIpcConfig {
            renderer_uid: RENDERER_UID,
            updater_uid: UPDATER_UID,
        },
        default_token_source_for_tests,
        RecordingActionExecutor::default(),
    );
    let session = ipc
        .connect(credential(RENDERER_UID, 100))
        .expect("renderer uid is authorized");

    let result = ipc
        .dispatch(request(&session.capability_token, "scene.activate"))
        .expect("allowlisted renderer method is accepted");
    assert!(result.ok);
    assert_eq!(result.result, "scene.activate:executed");
}

#[test]
fn current_renderer_actions_are_forwarded_to_a_typed_handler() {
    struct RecordingHandler {
        screen_off_calls: u32,
        screen_on_calls: u32,
        last_brightness: Option<u8>,
    }

    impl CurrentActionHandler for RecordingHandler {
        fn screen_off(&mut self) -> Result<(), String> {
            self.screen_off_calls += 1;
            Ok(())
        }
        fn screen_on(&mut self) -> Result<(), String> {
            self.screen_on_calls += 1;
            Ok(())
        }
        fn set_brightness(&mut self, level: u8) -> Result<(), String> {
            self.last_brightness = Some(level);
            Ok(())
        }
        fn app_version(&mut self) -> Result<String, String> {
            Ok("9.9.9-test".to_string())
        }
        fn device_identity(&mut self) -> Result<String, String> {
            Ok("{\"device_id\":\"test-device\"}".to_string())
        }
        fn audio_play(&mut self, _url: &str, _volume: u8) -> Result<(), String> {
            Ok(())
        }
        fn audio_pause(&mut self) -> Result<(), String> {
            Ok(())
        }
        fn audio_resume(&mut self) -> Result<(), String> {
            Ok(())
        }
        fn audio_stop(&mut self) -> Result<(), String> {
            Ok(())
        }
        fn audio_set_volume(&mut self, _level: u8) -> Result<(), String> {
            Ok(())
        }
        fn audio_set_mute(&mut self, _muted: bool) -> Result<(), String> {
            Ok(())
        }
        fn audio_state(&mut self) -> Result<String, String> {
            Ok("{}".to_string())
        }
        fn media_youtube_play(
            &mut self,
            _query: &str,
            _video_id: &str,
            _api_key: &str,
        ) -> Result<String, String> {
            Ok("{}".to_string())
        }
        fn media_youtube_status(
            &mut self,
            _playback_id: &str,
            _event: &str,
            _video_id: &str,
            _error_code: Option<i64>,
        ) -> Result<String, String> {
            Ok("{}".to_string())
        }
        fn media_youtube_state(&mut self) -> Result<String, String> {
            Ok("{}".to_string())
        }
        fn media_radio_play(&mut self, _query: &str) -> Result<String, String> {
            Ok("{}".to_string())
        }
        fn media_radio_stop(&mut self) -> Result<(), String> {
            Ok(())
        }
        fn media_radio_state(&mut self) -> Result<String, String> {
            Ok("{}".to_string())
        }
        fn recovery_screen(&mut self) -> Result<String, String> {
            Ok("{\"html\":\"recovery\"}".to_string())
        }
    }

    let executor = CurrentActionExecutor::new(RecordingHandler {
        screen_off_calls: 0,
        screen_on_calls: 0,
        last_brightness: None,
    });

    let mut ipc = LocalIpcBroker::with_token_source_and_executor(
        LocalIpcConfig {
            renderer_uid: RENDERER_UID,
            updater_uid: UPDATER_UID,
        },
        default_token_source_for_tests,
        executor,
    );
    let session = ipc
        .connect(credential(RENDERER_UID, 100))
        .expect("renderer uid is authorized");

    let off = ipc
        .dispatch(request(&session.capability_token, "display.screen_off"))
        .expect("display.screen_off is allowlisted for the renderer");
    assert_eq!(off.result, "display.screen_off:executed");

    let mut brightness_request = request(&session.capability_token, "display.set_brightness");
    brightness_request.arguments = Some(serde_json::json!({ "level": 77 }));
    let brightness = ipc
        .dispatch(brightness_request)
        .expect("display.set_brightness with a valid level is accepted");
    assert_eq!(brightness.result, "display.set_brightness:executed");

    let version = ipc
        .dispatch(request(&session.capability_token, "agent.app_version"))
        .expect("agent.app_version is allowlisted for the renderer");
    assert_eq!(version.result, "9.9.9-test");
}

#[test]
fn set_brightness_with_a_malformed_argument_is_rejected_before_reaching_the_handler() {
    struct PanicIfCalledHandler;

    impl CurrentActionHandler for PanicIfCalledHandler {
        fn screen_off(&mut self) -> Result<(), String> {
            panic!("should never be called")
        }
        fn screen_on(&mut self) -> Result<(), String> {
            panic!("should never be called")
        }
        fn set_brightness(&mut self, _level: u8) -> Result<(), String> {
            panic!("a malformed 'level' argument must be rejected before this is ever called")
        }
        fn app_version(&mut self) -> Result<String, String> {
            panic!("should never be called")
        }
        fn device_identity(&mut self) -> Result<String, String> {
            panic!("should never be called")
        }
        fn audio_play(&mut self, _url: &str, _volume: u8) -> Result<(), String> {
            panic!("should never be called")
        }
        fn audio_pause(&mut self) -> Result<(), String> {
            panic!("should never be called")
        }
        fn audio_resume(&mut self) -> Result<(), String> {
            panic!("should never be called")
        }
        fn audio_stop(&mut self) -> Result<(), String> {
            panic!("should never be called")
        }
        fn audio_set_volume(&mut self, _level: u8) -> Result<(), String> {
            panic!("should never be called")
        }
        fn audio_set_mute(&mut self, _muted: bool) -> Result<(), String> {
            panic!("should never be called")
        }
        fn audio_state(&mut self) -> Result<String, String> {
            panic!("should never be called")
        }
        fn media_youtube_play(
            &mut self,
            _query: &str,
            _video_id: &str,
            _api_key: &str,
        ) -> Result<String, String> {
            panic!("should never be called")
        }
        fn media_youtube_status(
            &mut self,
            _playback_id: &str,
            _event: &str,
            _video_id: &str,
            _error_code: Option<i64>,
        ) -> Result<String, String> {
            panic!("should never be called")
        }
        fn media_youtube_state(&mut self) -> Result<String, String> {
            panic!("should never be called")
        }
        fn media_radio_play(&mut self, _query: &str) -> Result<String, String> {
            panic!("should never be called")
        }
        fn media_radio_stop(&mut self) -> Result<(), String> {
            panic!("should never be called")
        }
        fn media_radio_state(&mut self) -> Result<String, String> {
            panic!("should never be called")
        }
        fn recovery_screen(&mut self) -> Result<String, String> {
            panic!("should never be called")
        }
    }

    let mut ipc = LocalIpcBroker::with_token_source_and_executor(
        LocalIpcConfig {
            renderer_uid: RENDERER_UID,
            updater_uid: UPDATER_UID,
        },
        default_token_source_for_tests,
        CurrentActionExecutor::new(PanicIfCalledHandler),
    );
    let session = ipc
        .connect(credential(RENDERER_UID, 100))
        .expect("renderer uid is authorized");

    let mut missing_level = request(&session.capability_token, "display.set_brightness");
    missing_level.arguments = Some(serde_json::json!({ "not_level": 1 }));
    let err = ipc
        .dispatch(missing_level)
        .expect_err("a missing 'level' field must be rejected");
    assert_eq!(err.code, LocalIpcErrorCode::ExecutionFailed);
}

fn default_token_source_for_tests() -> String {
    use rand::rngs::OsRng;
    use rand::RngCore;
    let mut bytes = [0u8; 8];
    OsRng.fill_bytes(&mut bytes);
    format!("cap_{}", u64::from_le_bytes(bytes))
}
