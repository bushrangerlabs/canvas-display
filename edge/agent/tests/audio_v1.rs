//! Integration tests for the real, typed audio adapters in `canvas_edge_agent::hardware::audio`
//! (Phase 3 checklist item "Move `mpv`/GStreamer supervision and audio focus into Edge media
//! adapters"). See the module docs in `edge/agent/src/hardware/audio.rs` for what is genuinely
//! real vs. simplified.
//!
//! Which tests exercise the *real* subprocess/socket logic vs. the fake/injectable adapters:
//!
//! - `pactl_*` tests construct `PactlVolumeAdapter::new(FakeVolumeRunner)` so they prove the real
//!   adapter constructs the right `pactl ... @DEFAULT_SINK@ ...` command and parses a canned
//!   `pactl get-sink-volume` output, without spawning a real `pactl`.
//! - `mpv_*` tests construct `MpvPlaybackAdapter::with_paths(FakeMpvSpawner, FakeMpvIpc, ...)`
//!   so they prove the real adapter constructs the right `mpv --no-video --really-quiet
//!   --input-ipc-server=<sock> --volume=<vol> <url>` invocation and the right JSON IPC commands,
//!   without spawning a real `mpv` or opening a real socket.
//! - `mpv_ipc_*` tests construct a real [`UnixSocketMpvIpc`] pointed at a `tempfile` tempdir
//!   socket with a fake server thread, so they prove the real Unix socket JSON client sends the
//!   correct newline-terminated JSON command over a real socket.
//! - `fake_*` tests use the fully fake adapters to verify canned values and call recording.

use std::io::BufRead;
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use canvas_edge_agent::hardware::audio::{
    AudioAdapters, FakeMpvIpc, FakeMpvSpawner, FakePlaybackAdapter, FakeVolumeAdapter,
    FakeVolumeRunner, MpvIpc, MpvPlaybackAdapter, PactlVolumeAdapter, PlaybackAdapter,
    PlaybackSnapshot, PlaybackState, ProcessMpvSpawner, ProcessVolumeRunner, UnixSocketMpvIpc,
    VolumeAdapter, VolumeCommandRunner,
};
use tempfile::tempdir;

// ---------------------------------------------------------------------------
// PactlVolumeAdapter -- real command construction + output parsing via an
// injectable runner
// ---------------------------------------------------------------------------

#[test]
fn pactl_volume_adapter_get_volume_parses_the_first_percentage_from_pactl_output() {
    let runner = FakeVolumeRunner::new().with_stdout(
        "Volume: front-left: 49152 /  75% / -7.97 dB,   front-right: 49152 /  75% / -7.97 dB\n",
    );
    let adapter = PactlVolumeAdapter::new(runner);

    assert_eq!(adapter.get_volume().expect("get_volume"), 75);
}

#[test]
fn pactl_volume_adapter_get_volume_uses_the_first_percentage_when_left_and_right_differ() {
    // The sidecar's regex grabs the *first* `N%` match; we mirror that. A pactl output with
    // different left/right volumes should report the left one.
    let runner = FakeVolumeRunner::new().with_stdout(
        "Volume: front-left: 32768 /  50% / -12.04 dB,   front-right: 49152 /  75% / -7.97 dB\n",
    );
    let adapter = PactlVolumeAdapter::new(runner);

    assert_eq!(adapter.get_volume().expect("get_volume"), 50);
}

#[test]
fn pactl_volume_adapter_get_volume_clamps_above_100_to_100() {
    // A pathological pactl output with a >100% volume (possible with the flat volume scale)
    // should clamp to 100, matching the u8 return type's range.
    let runner = FakeVolumeRunner::new().with_stdout("Volume: 120%\n");
    let adapter = PactlVolumeAdapter::new(runner);

    assert_eq!(adapter.get_volume().expect("get_volume"), 100);
}

#[test]
fn pactl_volume_adapter_get_volume_errors_when_no_percentage_is_present() {
    let runner = FakeVolumeRunner::new().with_stdout("No volume information available\n");
    let adapter = PactlVolumeAdapter::new(runner);

    let err = adapter
        .get_volume()
        .expect_err("no percentage should error");
    let msg = err.to_string();
    assert!(
        msg.contains("no percentage"),
        "expected no-percentage message, got: {msg}"
    );
}

#[test]
fn pactl_volume_adapter_set_volume_constructs_pactl_set_sink_volume_with_percent_suffix() {
    let runner = FakeVolumeRunner::new();
    let log = runner.call_log();
    let adapter = PactlVolumeAdapter::new(runner);

    adapter.set_volume(75).expect("set_volume");

    let recorded = log.lock().unwrap().clone();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].program, "pactl");
    assert_eq!(
        recorded[0].args,
        vec!["set-sink-volume", "@DEFAULT_SINK@", "75%"]
    );
}

#[test]
fn pactl_volume_adapter_set_volume_clamps_above_100_to_100() {
    let runner = FakeVolumeRunner::new();
    let log = runner.call_log();
    let adapter = PactlVolumeAdapter::new(runner);

    // u8 max is 255, so a caller passing 200 should be clamped to 100.
    adapter.set_volume(200).expect("set_volume");

    let recorded = log.lock().unwrap().clone();
    assert_eq!(
        recorded[0].args,
        vec!["set-sink-volume", "@DEFAULT_SINK@", "100%"]
    );
}

#[test]
fn pactl_volume_adapter_set_volume_clamps_below_0_to_0() {
    // u8 cannot be negative, but the clamp logic should still handle the boundary at 0.
    let runner = FakeVolumeRunner::new();
    let log = runner.call_log();
    let adapter = PactlVolumeAdapter::new(runner);

    adapter.set_volume(0).expect("set_volume");

    let recorded = log.lock().unwrap().clone();
    assert_eq!(
        recorded[0].args,
        vec!["set-sink-volume", "@DEFAULT_SINK@", "0%"]
    );
}

#[test]
fn pactl_volume_adapter_set_mute_constructs_pactl_set_sink_mute_with_1_or_0() {
    let runner = FakeVolumeRunner::new();
    let log = runner.call_log();
    let adapter = PactlVolumeAdapter::new(runner);

    adapter.set_mute(true).expect("set_mute true");
    adapter.set_mute(false).expect("set_mute false");

    let recorded = log.lock().unwrap().clone();
    assert_eq!(recorded.len(), 2);
    assert_eq!(
        recorded[0].args,
        vec!["set-sink-mute", "@DEFAULT_SINK@", "1"]
    );
    assert_eq!(
        recorded[1].args,
        vec!["set-sink-mute", "@DEFAULT_SINK@", "0"]
    );
}

#[test]
fn pactl_volume_adapter_is_muted_parses_mute_yes_line() {
    let runner = FakeVolumeRunner::new().with_stdout("Mute: yes\n");
    let adapter = PactlVolumeAdapter::new(runner);

    assert!(adapter.is_muted().expect("is_muted should be true"));
}

#[test]
fn pactl_volume_adapter_is_muted_parses_mute_no_line() {
    let runner = FakeVolumeRunner::new().with_stdout("Mute: no\n");
    let adapter = PactlVolumeAdapter::new(runner);

    assert!(!adapter.is_muted().expect("is_muted should be false"));
}

#[test]
fn pactl_volume_adapter_is_muted_falls_back_to_false_when_the_mute_line_is_absent() {
    // Best-effort: see module docs. An unparseable output should report false, not error.
    let runner =
        FakeVolumeRunner::new().with_stdout("Some other pactl output without a Mute line\n");
    let adapter = PactlVolumeAdapter::new(runner);

    assert!(!adapter
        .is_muted()
        .expect("is_muted should fall back to false"));
}

#[test]
fn pactl_volume_adapter_is_muted_falls_back_to_false_when_pactl_fails() {
    // A transient pactl failure should not break a state poll; the adapter reports false.
    let runner = FakeVolumeRunner::new().with_success(false);
    let adapter = PactlVolumeAdapter::new(runner);

    assert!(!adapter
        .is_muted()
        .expect("is_muted should fall back to false on pactl failure"));
}

#[test]
fn pactl_volume_adapter_surfaces_a_non_zero_pactl_exit_as_an_error_for_get_volume() {
    // Unlike is_muted (best-effort), get_volume surfaces a pactl failure as an error -- the caller
    // asked for the volume and we cannot fabricate one.
    let runner = FakeVolumeRunner::new().with_success(false);
    let adapter = PactlVolumeAdapter::new(runner);

    let err = adapter
        .get_volume()
        .expect_err("pactl failure should error");
    let msg = err.to_string();
    assert!(
        msg.contains("exited non-zero"),
        "expected non-zero exit message, got: {msg}"
    );
}

#[test]
fn process_volume_runner_is_send_and_sync() {
    // Compile-time assertion: the real runner must be usable from the daemon's IPC thread.
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<ProcessVolumeRunner>();
}

// ---------------------------------------------------------------------------
// FakeVolumeAdapter -- canned values + call recording
// ---------------------------------------------------------------------------

#[test]
fn fake_volume_adapter_returns_canned_current_and_muted() {
    let adapter = FakeVolumeAdapter::new(42, true);
    assert_eq!(adapter.get_volume().expect("get"), 42);
    assert!(adapter.is_muted().expect("is_muted"));
}

#[test]
fn fake_volume_adapter_records_set_volume_and_set_mute_calls_in_order() {
    let adapter = FakeVolumeAdapter::new(0, false);
    adapter.set_volume(10).expect("set 10");
    adapter.set_mute(true).expect("mute");
    adapter.set_volume(20).expect("set 20");
    adapter.set_mute(false).expect("unmute");

    assert_eq!(
        adapter.recorded_calls(),
        vec![
            "set_volume:10",
            "set_mute:true",
            "set_volume:20",
            "set_mute:false"
        ]
    );
}

#[test]
fn fake_volume_adapter_call_log_handle_observes_calls_after_the_adapter_is_moved() {
    let adapter = FakeVolumeAdapter::new(0, false);
    let log = adapter.call_log();
    let moved = adapter;
    moved.set_volume(99).expect("set 99");

    let recorded = log.lock().unwrap().clone();
    assert_eq!(recorded, vec!["set_volume:99"]);
}

#[test]
fn fake_volume_adapter_surfaces_a_configured_error() {
    let adapter = FakeVolumeAdapter::new(0, false).with_next_error("fake pactl failure");
    let err = adapter
        .set_volume(50)
        .expect_err("configured error should surface");
    assert!(err.to_string().contains("fake pactl failure"));
}

// ---------------------------------------------------------------------------
// MpvPlaybackAdapter -- real command construction via an injectable spawner
// ---------------------------------------------------------------------------

#[test]
fn mpv_playback_adapter_play_constructs_the_right_mpv_invocation() {
    let spawner = FakeMpvSpawner::new();
    let spawn_log = spawner.spawn_log();
    let ipc = FakeMpvIpc::new();
    let mut adapter = MpvPlaybackAdapter::with_paths(spawner, ipc, "mpv", "/tmp/mpv-canvas.sock");

    adapter
        .play("https://example.com/stream.mp3", 75)
        .expect("play");

    let spawns = spawn_log.lock().unwrap().clone();
    assert_eq!(spawns.len(), 1);
    assert_eq!(spawns[0].program, "mpv");
    assert_eq!(
        spawns[0].args,
        vec![
            "--no-video",
            "--really-quiet",
            "--input-ipc-server=/tmp/mpv-canvas.sock",
            "--volume=75",
            "https://example.com/stream.mp3",
        ]
    );
}

#[test]
fn mpv_playback_adapter_play_clamps_volume_to_0_100() {
    let spawner = FakeMpvSpawner::new();
    let spawn_log = spawner.spawn_log();
    let ipc = FakeMpvIpc::new();
    let mut adapter = MpvPlaybackAdapter::with_paths(spawner, ipc, "mpv", "/tmp/sock");

    adapter.play("https://example.com/x", 200).expect("play");

    let spawns = spawn_log.lock().unwrap().clone();
    assert!(spawns[0].args.iter().any(|a| a == "--volume=100"));
}

#[test]
fn mpv_playback_adapter_play_kills_the_previous_mpv_before_spawning_a_new_one() {
    let spawner = FakeMpvSpawner::new();
    let kill_log = spawner.kill_log();
    let spawn_log = spawner.spawn_log();
    let ipc = FakeMpvIpc::new();
    let mut adapter = MpvPlaybackAdapter::with_paths(spawner, ipc, "mpv", "/tmp/sock");

    adapter
        .play("https://example.com/first", 50)
        .expect("play 1");
    adapter
        .play("https://example.com/second", 60)
        .expect("play 2");

    let kills = *kill_log.lock().unwrap();
    assert_eq!(
        kills, 1,
        "the first mpv should have been killed before the second spawn"
    );
    let spawns = spawn_log.lock().unwrap().clone();
    assert_eq!(spawns.len(), 2);
    assert_eq!(
        spawns[1].args.last(),
        Some(&"https://example.com/second".to_string())
    );
}

#[test]
fn mpv_playback_adapter_play_updates_state_to_playing() {
    let spawner = FakeMpvSpawner::new();
    let ipc = FakeMpvIpc::new();
    let mut adapter = MpvPlaybackAdapter::with_paths(spawner, ipc, "mpv", "/tmp/sock");

    assert_eq!(adapter.state().state, PlaybackState::Idle);
    adapter.play("https://example.com/x", 75).expect("play");
    let snapshot = adapter.state();
    assert_eq!(snapshot.state, PlaybackState::Playing);
    assert_eq!(snapshot.url, "https://example.com/x");
    assert_eq!(snapshot.volume, 75);
}

#[test]
fn mpv_playback_adapter_pause_sends_set_property_pause_true_over_ipc() {
    let spawner = FakeMpvSpawner::new();
    let ipc = FakeMpvIpc::new();
    let sent_log = ipc.sent_log();
    let mut adapter = MpvPlaybackAdapter::with_paths(spawner, ipc, "mpv", "/tmp/sock");

    adapter.play("https://example.com/x", 75).expect("play");
    adapter.pause().expect("pause");

    let sent = sent_log.lock().unwrap().clone();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0], r#"{"command":["set_property","pause",true]}"#);
    assert_eq!(adapter.state().state, PlaybackState::Paused);
}

#[test]
fn mpv_playback_adapter_resume_sends_set_property_pause_false_over_ipc() {
    let spawner = FakeMpvSpawner::new();
    let ipc = FakeMpvIpc::new();
    let sent_log = ipc.sent_log();
    let mut adapter = MpvPlaybackAdapter::with_paths(spawner, ipc, "mpv", "/tmp/sock");

    adapter.play("https://example.com/x", 75).expect("play");
    adapter.pause().expect("pause");
    adapter.resume().expect("resume");

    let sent = sent_log.lock().unwrap().clone();
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[1], r#"{"command":["set_property","pause",false]}"#);
    assert_eq!(adapter.state().state, PlaybackState::Playing);
}

#[test]
fn mpv_playback_adapter_pause_errors_when_not_playing() {
    // Mirrors the sidecar's 409 "Not playing" guard.
    let spawner = FakeMpvSpawner::new();
    let ipc = FakeMpvIpc::new();
    let mut adapter = MpvPlaybackAdapter::with_paths(spawner, ipc, "mpv", "/tmp/sock");

    let err = adapter.pause().expect_err("pause when idle should error");
    assert!(err.to_string().contains("not in the playing state"));
}

#[test]
fn mpv_playback_adapter_resume_errors_when_not_paused() {
    let spawner = FakeMpvSpawner::new();
    let ipc = FakeMpvIpc::new();
    let mut adapter = MpvPlaybackAdapter::with_paths(spawner, ipc, "mpv", "/tmp/sock");

    adapter.play("https://example.com/x", 75).expect("play");
    let err = adapter
        .resume()
        .expect_err("resume when playing should error");
    assert!(err.to_string().contains("not in the paused state"));
}

#[test]
fn mpv_playback_adapter_stop_kills_mpv_and_clears_state() {
    let spawner = FakeMpvSpawner::new();
    let kill_log = spawner.kill_log();
    let ipc = FakeMpvIpc::new();
    let mut adapter = MpvPlaybackAdapter::with_paths(spawner, ipc, "mpv", "/tmp/sock");

    adapter.play("https://example.com/x", 75).expect("play");
    adapter.stop().expect("stop");

    let kills = *kill_log.lock().unwrap();
    assert_eq!(kills, 1, "stop should kill the running mpv");
    let snapshot = adapter.state();
    assert_eq!(snapshot.state, PlaybackState::Idle);
    assert!(snapshot.url.is_empty());
}

#[test]
fn mpv_playback_adapter_set_volume_sends_set_property_volume_over_ipc_when_playing() {
    let spawner = FakeMpvSpawner::new();
    let ipc = FakeMpvIpc::new();
    let sent_log = ipc.sent_log();
    let mut adapter = MpvPlaybackAdapter::with_paths(spawner, ipc, "mpv", "/tmp/sock");

    adapter.play("https://example.com/x", 75).expect("play");
    adapter.set_volume(50).expect("set_volume");

    let sent = sent_log.lock().unwrap().clone();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0], r#"{"command":["set_property","volume",50]}"#);
    assert_eq!(adapter.state().volume, 50);
}

#[test]
fn mpv_playback_adapter_set_volume_does_not_send_ipc_when_idle() {
    // Mirrors the sidecar: `mpvIpc(...).catch(() => {})` is a no-op when mpv is not running, but
    // the recorded volume is still updated for the next play() call.
    let spawner = FakeMpvSpawner::new();
    let ipc = FakeMpvIpc::new();
    let sent_log = ipc.sent_log();
    let mut adapter = MpvPlaybackAdapter::with_paths(spawner, ipc, "mpv", "/tmp/sock");

    adapter.set_volume(50).expect("set_volume");

    let sent = sent_log.lock().unwrap().clone();
    assert!(sent.is_empty(), "no IPC should be sent when idle");
    assert_eq!(adapter.state().volume, 50);
}

#[test]
fn mpv_playback_adapter_surfaces_a_spawn_failure_as_an_error() {
    let spawner = FakeMpvSpawner::new().with_next_spawn_error("mpv not on PATH");
    let ipc = FakeMpvIpc::new();
    let mut adapter = MpvPlaybackAdapter::with_paths(spawner, ipc, "mpv", "/tmp/sock");

    let err = adapter
        .play("https://example.com/x", 75)
        .expect_err("spawn failure should error");
    assert!(err.to_string().contains("mpv not on PATH"));
    assert_eq!(adapter.state().state, PlaybackState::Idle);
}

#[test]
fn process_mpv_spawner_is_send_and_sync() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<ProcessMpvSpawner>();
}

// ---------------------------------------------------------------------------
// UnixSocketMpvIpc -- real Unix socket JSON client against a fake server
// ---------------------------------------------------------------------------

/// Spawns a background thread that accepts one connection on `socket_path`, reads one line, stores
/// it in the shared `received` slot, and exits. Returns a handle the test can join to ensure the
/// line was read before asserting on it.
fn spawn_fake_mpv_server(
    socket_path: PathBuf,
) -> (Arc<Mutex<Option<String>>>, thread::JoinHandle<()>) {
    let received: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let received_for_thread = Arc::clone(&received);
    let listener = UnixListener::bind(&socket_path).expect("bind fake mpv server");
    let handle = thread::spawn(move || {
        // Accept one connection, read one line, store it, exit. A short accept timeout keeps the
        // thread from hanging the test if the client never connects.
        let _ = listener.set_nonblocking(true);
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let (stream, _) = loop {
            match listener.accept() {
                Ok(pair) => break pair,
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    if std::time::Instant::now() > deadline {
                        return;
                    }
                    thread::sleep(Duration::from_millis(10));
                }
                Err(_) => return,
            }
        };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
        let mut reader = std::io::BufReader::new(stream.try_clone().expect("clone stream"));
        let mut line = String::new();
        if reader.read_line(&mut line).is_ok() {
            if let Ok(mut guard) = received_for_thread.lock() {
                *guard = Some(line);
            }
        }
    });
    (received, handle)
}

#[test]
fn unix_socket_mpv_ipc_sends_newline_terminated_json_over_a_real_socket() {
    let dir = tempdir().expect("tempdir for mpv socket");
    let socket_path = dir.path().join("mpv-canvas.sock");
    let (received, server_handle) = spawn_fake_mpv_server(socket_path.clone());

    // Give the server a moment to bind before we connect.
    thread::sleep(Duration::from_millis(50));

    let ipc = UnixSocketMpvIpc::new(socket_path);
    let json = r#"{"command":["set_property","pause",true]}"#;
    ipc.send(json).expect("send should succeed");

    server_handle.join().expect("server thread should exit");

    let line = received
        .lock()
        .unwrap()
        .clone()
        .expect("server should have received a line");
    assert_eq!(
        line,
        format!("{json}\n"),
        "the JSON command should arrive newline-terminated"
    );
}

#[test]
fn unix_socket_mpv_ipc_errors_when_the_socket_does_not_exist() {
    let dir = tempdir().expect("tempdir for mpv socket");
    let socket_path = dir.path().join("does-not-exist.sock");
    let ipc = UnixSocketMpvIpc::new(socket_path);

    let err = ipc
        .send(r#"{"command":["set_property","pause",true]}"#)
        .expect_err("missing socket should error");
    assert!(
        err.to_string().contains("mpv IPC unavailable"),
        "expected unavailable message, got: {err}"
    );
}

// ---------------------------------------------------------------------------
// FakePlaybackAdapter -- canned state + call recording
// ---------------------------------------------------------------------------

#[test]
fn fake_playback_adapter_records_play_pause_resume_stop_set_volume_in_order() {
    let adapter = FakePlaybackAdapter::new();
    let log = adapter.call_log();
    let mut moved = adapter;

    moved.play("https://example.com/a", 75).expect("play");
    moved.pause().expect("pause");
    moved.resume().expect("resume");
    moved.set_volume(50).expect("set_volume");
    moved.stop().expect("stop");

    let recorded = log.lock().unwrap().clone();
    assert_eq!(
        recorded,
        vec![
            "play:https://example.com/a@75",
            "pause",
            "resume",
            "set_volume:50",
            "stop",
        ]
    );
}

#[test]
fn fake_playback_adapter_state_transitions_through_play_pause_stop() {
    let adapter = FakePlaybackAdapter::new();
    let mut moved = adapter;

    assert_eq!(moved.state().state, PlaybackState::Idle);
    moved.play("https://example.com/a", 75).expect("play");
    assert_eq!(moved.state().state, PlaybackState::Playing);
    assert_eq!(moved.state().url, "https://example.com/a");
    assert_eq!(moved.state().volume, 75);
    moved.pause().expect("pause");
    assert_eq!(moved.state().state, PlaybackState::Paused);
    moved.resume().expect("resume");
    assert_eq!(moved.state().state, PlaybackState::Playing);
    moved.stop().expect("stop");
    assert_eq!(moved.state().state, PlaybackState::Idle);
    assert!(moved.state().url.is_empty());
}

#[test]
fn fake_playback_adapter_surfaces_a_configured_error() {
    let mut adapter = FakePlaybackAdapter::new().with_next_error("fake mpv failure");
    let err = adapter
        .play("https://example.com/x", 75)
        .expect_err("configured error should surface");
    assert!(err.to_string().contains("fake mpv failure"));
}

// ---------------------------------------------------------------------------
// AudioAdapters bundle
// ---------------------------------------------------------------------------

#[test]
fn audio_adapters_with_fakes_dispatches_volume_and_playback() {
    let volume = FakeVolumeAdapter::new(50, false);
    let playback = FakePlaybackAdapter::new();
    let v_log = volume.call_log();
    let p_log = playback.call_log();
    let adapters = AudioAdapters::with_fakes(volume, playback);

    adapters.volume.set_volume(77).expect("set_volume");
    {
        let mut playback = adapters.playback.lock().unwrap();
        playback.play("https://example.com/x", 77).expect("play");
    }

    assert_eq!(v_log.lock().unwrap().clone(), vec!["set_volume:77"]);
    assert_eq!(
        p_log.lock().unwrap().clone(),
        vec!["play:https://example.com/x@77"]
    );
}

#[test]
fn audio_adapters_new_real_constructs_without_panicking() {
    // We cannot exercise the real adapters' I/O (no real pactl/mpv in CI), but we can at least
    // prove the production constructor builds the bundle without panicking -- a regression here
    // would mean `main()` cannot construct the handler at startup.
    let _adapters = AudioAdapters::new_real();
}

// ---------------------------------------------------------------------------
// Trait object safety -- prove the seams are usable as Box<dyn ...>
// ---------------------------------------------------------------------------

#[test]
fn volume_command_runner_trait_is_object_safe() {
    let runner: Box<dyn VolumeCommandRunner> = Box::new(FakeVolumeRunner::new());
    runner
        .run("pactl", &["get-sink-volume", "@DEFAULT_SINK@"])
        .expect("boxed runner works");
}

#[test]
fn mpv_ipc_trait_is_object_safe() {
    let ipc: Box<dyn MpvIpc> = Box::new(FakeMpvIpc::new());
    ipc.send(r#"{"command":["set_property","pause",true]}"#)
        .expect("boxed ipc works");
}

#[test]
fn playback_snapshot_is_send_and_sync() {
    // Compile-time assertion: the snapshot crosses thread boundaries (from the IPC handler thread
    // to the test thread).
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<PlaybackSnapshot>();
}

#[test]
fn arc_mutex_is_send_and_sync() {
    // Compile-time assertion: the shared call logs must cross thread boundaries (from the test
    // thread to the IPC handler thread and back).
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<Arc<Mutex<Vec<u8>>>>();
    assert_send_sync::<Arc<Mutex<Vec<String>>>>();
    // The PlaybackSnapshot held behind the Mutex in AudioAdapters must also be Send.
    assert_send_sync::<Arc<Mutex<PlaybackSnapshot>>>();
}
