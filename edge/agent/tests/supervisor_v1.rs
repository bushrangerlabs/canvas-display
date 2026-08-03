//! Integration tests for the sidecar process supervisor in `canvas_edge_agent::supervisor`
//! (Phase 3 checklist item "Make Edge Agent -- not Tauri -- the supervisor for remaining legacy
//! components"). See the module docs in `edge/agent/src/supervisor/mod.rs` for what is genuinely
//! real vs. simplified, and `docs/PHASE_3_SIDECAR_INVENTORY.md` for the sidecar inventory these
//! tests assert against.
//!
//! Which tests exercise the *real* supervisor logic vs. the fully fake supervisor:
//!
//! - `process_*` tests construct `ProcessSidecarSupervisor::new(FakeCommandSpawner)` so they
//!   prove the real supervisor constructs the right `canvas-display-server` command (binary path,
//!   env vars including `HOST=127.0.0.1`, args) and handles `is_running`/`restart`/`stop`/`
//!   health_check` correctly -- without spawning a real sidecar. This mirrors the `xset_*` tests
//!   in `hardware_v1.rs` and the `mpv_*` tests in `audio_v1.rs`.
//! - `fake_*` tests use the fully fake [`FakeSidecarSupervisor`] to verify canned health and call
//!   recording, without any spawner or subprocess involvement at all.
//! - `sidecar_handle_*` tests exercise the monitoring thread ([`SidecarHandle`]) end-to-end with
//!   a fake spawner that simulates a crash, proving the restart policy and shutdown ordering work
//!   on a real `std::thread`.

use std::path::PathBuf;
use std::thread;
use std::time::Duration;

use canvas_edge_agent::supervisor::{
    FakeCommandSpawner, FakeSidecarSupervisor, ProcessCommandSpawner, ProcessSidecarSupervisor,
    SidecarConfig, SidecarHandle, SidecarHealth, SidecarSupervisor,
};

/// Builds a `SidecarConfig` that mirrors exactly what the Tauri app passes to the sidecar today
/// (see `browser/linux/src-tauri/src/lib.rs`'s `setup()` sidecar-spawn block and
/// `docs/PHASE_3_SIDECAR_INVENTORY.md` §9.4), so the tests assert the Edge Agent supervision
/// produces an identical command.
fn tauri_equivalent_config(binary: &str) -> SidecarConfig {
    SidecarConfig {
        binary_path: PathBuf::from(binary),
        env_vars: vec![
            (
                "CANVAS_DATA_DIR".to_string(),
                "/var/lib/canvas-edge-agent".to_string(),
            ),
            (
                "NATIVE_BINDING_DIR".to_string(),
                "/opt/canvas/binaries".to_string(),
            ),
            (
                "STATIC_DIR".to_string(),
                "/opt/canvas/binaries/public".to_string(),
            ),
            ("PORT".to_string(), "3100".to_string()),
            // Phase 1 loopback lock -- the bundled sidecar must never be reachable from the LAN.
            ("HOST".to_string(), "127.0.0.1".to_string()),
        ],
        args: Vec::new(),
        restart_on_crash: true,
        max_restarts: 3,
        restart_delay_ms: 50, // Short for tests; the real default is 1000 ms.
    }
}

// ---------------------------------------------------------------------------
// ProcessSidecarSupervisor + FakeCommandSpawner -- real supervisor logic
// ---------------------------------------------------------------------------

#[test]
fn process_supervisor_start_records_the_binary_path_env_vars_and_args_on_the_fake_spawner() {
    let spawner = FakeCommandSpawner::new();
    let spawn_log = spawner.spawn_log();
    let mut supervisor = ProcessSidecarSupervisor::new(spawner);
    let config = tauri_equivalent_config("/usr/bin/canvas-display-server");

    supervisor.start(&config).expect("start");

    let spawns = spawn_log.lock().unwrap().clone();
    assert_eq!(spawns.len(), 1, "start should spawn exactly once");
    assert_eq!(spawns[0].program, "/usr/bin/canvas-display-server");
    assert!(
        spawns[0].args.is_empty(),
        "the legacy sidecar takes no args"
    );
    // The env vars must include the Phase 1 loopback lock and the Tauri-equivalent set.
    let env: std::collections::HashMap<&String, &String> =
        spawns[0].env_vars.iter().map(|(k, v)| (k, v)).collect();
    assert_eq!(
        env.get(&"HOST".to_string()).map(|s| s.as_str()),
        Some("127.0.0.1")
    );
    assert_eq!(
        env.get(&"PORT".to_string()).map(|s| s.as_str()),
        Some("3100")
    );
    assert!(env.contains_key(&"CANVAS_DATA_DIR".to_string()));
    assert!(env.contains_key(&"NATIVE_BINDING_DIR".to_string()));
    assert!(env.contains_key(&"STATIC_DIR".to_string()));
}

#[test]
fn process_supervisor_is_running_returns_true_after_start_with_no_canned_exit() {
    // An empty exit queue means "always running" (the healthy default).
    let spawner = FakeCommandSpawner::new();
    let mut supervisor = ProcessSidecarSupervisor::new(spawner);
    let config = tauri_equivalent_config("canvas-display-server");

    assert!(!supervisor.is_running(), "no child yet -> not running");
    supervisor.start(&config).expect("start");
    assert!(supervisor.is_running(), "child spawned -> running");
}

#[test]
fn process_supervisor_is_running_returns_false_and_caches_exit_when_the_child_crashes() {
    // Pre-seed one exit: the first `try_wait` reports exit code 1 (crashed).
    let spawner = FakeCommandSpawner::new().with_next_exits(vec![Some(1)]);
    let mut supervisor = ProcessSidecarSupervisor::new(spawner);
    let config = tauri_equivalent_config("canvas-display-server");

    supervisor.start(&config).expect("start");
    assert!(
        !supervisor.is_running(),
        "child crashed with exit 1 -> not running"
    );
    // The exit code should be cached so health_check can report Crashed.
    assert_eq!(supervisor.health_check(), SidecarHealth::Crashed(Some(1)));
}

#[test]
fn process_supervisor_health_check_reports_running_for_a_healthy_child() {
    let spawner = FakeCommandSpawner::new();
    let mut supervisor = ProcessSidecarSupervisor::new(spawner);
    let config = tauri_equivalent_config("canvas-display-server");

    supervisor.start(&config).expect("start");
    assert_eq!(supervisor.health_check(), SidecarHealth::Running);
}

#[test]
fn process_supervisor_health_check_reports_stopped_when_no_child_has_ever_been_started() {
    let spawner = FakeCommandSpawner::new();
    let mut supervisor = ProcessSidecarSupervisor::new(spawner);

    assert_eq!(supervisor.health_check(), SidecarHealth::Stopped);
}

#[test]
fn process_supervisor_stop_kills_the_child_and_clears_last_exit() {
    let spawner = FakeCommandSpawner::new();
    let kill_log = spawner.kill_log();
    let mut supervisor = ProcessSidecarSupervisor::new(spawner);
    let config = tauri_equivalent_config("canvas-display-server");

    supervisor.start(&config).expect("start");
    supervisor.stop().expect("stop");

    let kills = *kill_log.lock().unwrap();
    assert_eq!(kills, 1, "stop should kill the child once");
    assert!(!supervisor.is_running(), "after stop, not running");
    // `stop` clears `last_exit` so health_check reports Stopped, not Crashed.
    assert_eq!(supervisor.health_check(), SidecarHealth::Stopped);
}

#[test]
fn process_supervisor_stop_is_a_no_op_when_no_child_is_running() {
    let spawner = FakeCommandSpawner::new();
    let kill_log = spawner.kill_log();
    let mut supervisor = ProcessSidecarSupervisor::new(spawner);

    supervisor.stop().expect("stop with no child should be Ok");

    assert_eq!(*kill_log.lock().unwrap(), 0, "no child -> no kill");
}

#[test]
fn process_supervisor_restart_kills_the_old_child_and_spawns_a_new_one() {
    let spawner = FakeCommandSpawner::new();
    let kill_log = spawner.kill_log();
    let spawn_log = spawner.spawn_log();
    let mut supervisor = ProcessSidecarSupervisor::new(spawner);
    let config = tauri_equivalent_config("canvas-display-server");

    supervisor.start(&config).expect("start");
    supervisor.restart(&config).expect("restart");

    let kills = *kill_log.lock().unwrap();
    let spawns = spawn_log.lock().unwrap().clone();
    assert_eq!(kills, 1, "restart should kill the old child");
    assert_eq!(spawns.len(), 2, "restart should spawn a second child");
    // Both spawns should construct the same command.
    assert_eq!(spawns[0], spawns[1]);
}

#[test]
fn process_supervisor_start_surfaces_a_spawn_failure_as_an_error() {
    let spawner = FakeCommandSpawner::new().with_next_spawn_error("binary not on PATH");
    let mut supervisor = ProcessSidecarSupervisor::new(spawner);
    let config = tauri_equivalent_config("/nonexistent/canvas-display-server");

    let err = supervisor
        .start(&config)
        .expect_err("spawn failure should error");
    assert!(
        err.to_string().contains("binary not on PATH"),
        "expected the canned error message, got: {err}"
    );
    assert!(!supervisor.is_running());
    assert_eq!(supervisor.health_check(), SidecarHealth::Stopped);
}

#[test]
fn process_supervisor_start_replaces_an_existing_child_by_stopping_it_first() {
    // Calling start while a child is already running should stop the old child first (best-effort)
    // to avoid leaking a process.
    let spawner = FakeCommandSpawner::new();
    let kill_log = spawner.kill_log();
    let spawn_log = spawner.spawn_log();
    let mut supervisor = ProcessSidecarSupervisor::new(spawner);
    let config = tauri_equivalent_config("canvas-display-server");

    supervisor.start(&config).expect("start 1");
    supervisor.start(&config).expect("start 2");

    let kills = *kill_log.lock().unwrap();
    let spawns = spawn_log.lock().unwrap().clone();
    assert_eq!(kills, 1, "second start should kill the first child");
    assert_eq!(spawns.len(), 2, "two starts -> two spawns");
}

#[test]
fn process_command_spawner_is_send_and_sync() {
    // Compile-time assertion: the real spawner must be usable from the daemon's monitoring thread.
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<ProcessCommandSpawner>();
}

// ---------------------------------------------------------------------------
// FakeSidecarSupervisor -- fully fake supervisor for call-recording tests
// ---------------------------------------------------------------------------

#[test]
fn fake_supervisor_records_start_restart_stop_and_health_check_calls_in_order() {
    let supervisor = FakeSidecarSupervisor::new();
    let config = tauri_equivalent_config("canvas-display-server");
    let mut supervisor = supervisor;

    supervisor.start(&config).expect("start");
    supervisor.restart(&config).expect("restart");
    supervisor.health_check();
    supervisor.stop().expect("stop");

    assert_eq!(
        supervisor.recorded_calls(),
        vec!["start", "restart", "health_check", "stop"]
    );
}

#[test]
fn fake_supervisor_is_running_returns_true_after_start_and_false_after_stop() {
    let mut supervisor = FakeSidecarSupervisor::new();
    let config = tauri_equivalent_config("canvas-display-server");

    assert!(!supervisor.is_running(), "before start -> not running");
    supervisor.start(&config).expect("start");
    assert!(supervisor.is_running(), "after start -> running");
    supervisor.stop().expect("stop");
    assert!(!supervisor.is_running(), "after stop -> not running");
}

#[test]
fn fake_supervisor_health_check_reports_running_after_start() {
    let mut supervisor = FakeSidecarSupervisor::new();
    let config = tauri_equivalent_config("canvas-display-server");

    supervisor.start(&config).expect("start");
    assert_eq!(supervisor.health_check(), SidecarHealth::Running);
}

#[test]
fn fake_supervisor_health_check_reports_stopped_after_stop() {
    let mut supervisor = FakeSidecarSupervisor::new();
    let config = tauri_equivalent_config("canvas-display-server");

    supervisor.start(&config).expect("start");
    supervisor.stop().expect("stop");
    assert_eq!(supervisor.health_check(), SidecarHealth::Stopped);
}

#[test]
fn fake_supervisor_with_next_health_returns_the_canned_health_once() {
    let mut supervisor =
        FakeSidecarSupervisor::new().with_next_health(SidecarHealth::Crashed(Some(42)));
    let config = tauri_equivalent_config("canvas-display-server");

    supervisor.start(&config).expect("start");
    // First health_check returns the canned value.
    assert_eq!(supervisor.health_check(), SidecarHealth::Crashed(Some(42)));
    // Second health_check falls back to the default logic (running -> Running).
    assert_eq!(supervisor.health_check(), SidecarHealth::Running);
}

#[test]
fn fake_supervisor_call_log_handle_observes_calls_after_the_supervisor_is_moved() {
    let supervisor = FakeSidecarSupervisor::new();
    let log = supervisor.call_log();
    let config = tauri_equivalent_config("canvas-display-server");
    let mut moved = supervisor;

    moved.start(&config).expect("start");

    let recorded = log.lock().unwrap().clone();
    assert_eq!(recorded, vec!["start"]);
}

// ---------------------------------------------------------------------------
// SidecarConfig serialization
// ---------------------------------------------------------------------------

#[test]
fn sidecar_config_round_trips_through_serde_with_the_tauri_equivalent_env_set() {
    let config = tauri_equivalent_config("/usr/bin/canvas-display-server");
    let json = serde_json::to_string(&config).expect("serialize");
    let back: SidecarConfig = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(config, back);
}

#[test]
fn sidecar_config_default_has_sensible_defaults() {
    let config = SidecarConfig::default();
    assert_eq!(config.binary_path, PathBuf::from("canvas-display-server"));
    assert!(config.restart_on_crash);
    assert_eq!(config.max_restarts, 3);
    assert_eq!(config.restart_delay_ms, 1000);
}

// ---------------------------------------------------------------------------
// SidecarHandle -- monitoring thread with restart policy and shutdown
// ---------------------------------------------------------------------------

#[test]
fn sidecar_handle_spawn_monitor_starts_the_child_and_shuts_down_cleanly() {
    // Empty exit queue = "always running". The monitor should start the child, poll it, find it
    // running, and on shutdown stop it cleanly.
    let spawner = FakeCommandSpawner::new();
    let kill_log = spawner.kill_log();
    let spawn_log = spawner.spawn_log();
    let config = tauri_equivalent_config("canvas-display-server");
    let handle =
        SidecarHandle::spawn_monitor(Box::new(ProcessSidecarSupervisor::new(spawner)), config)
            .expect("spawn monitor");

    // Give the monitor a moment to poll at least once.
    thread::sleep(Duration::from_millis(120));

    let spawns = spawn_log.lock().unwrap().clone();
    assert_eq!(
        spawns.len(),
        1,
        "monitor should start the child exactly once"
    );

    handle.shutdown_and_join();

    let kills = *kill_log.lock().unwrap();
    assert_eq!(kills, 1, "shutdown should kill the child once");
}

#[test]
fn sidecar_handle_monitor_restarts_the_child_after_a_crash_up_to_max_restarts() {
    // Pre-seed exits: the first child crashes immediately (exit 1), the second crashes (exit 1),
    // the third crashes (exit 1). With max_restarts=3, the monitor should attempt 3 restarts
    // (each consuming one spawn + one crash), then stop retrying.
    //
    // Exit queue semantics: each `try_wait` pops one entry. `Some(1)` means "exited with 1".
    // The monitor polls every `restart_delay_ms` (50 ms here). After a crash it calls `restart`,
    // which spawns a new child (consuming the next spawn), whose next `try_wait` pops the next
    // exit. We seed enough crashes to exhaust max_restarts.
    let spawner = FakeCommandSpawner::new().with_next_exits(vec![
        Some(1), // first child crashes
        Some(1), // second child (after 1st restart) crashes
        Some(1), // third child (after 2nd restart) crashes
        Some(1), // fourth child (after 3rd restart) crashes
    ]);
    let spawn_log = spawner.spawn_log();
    let mut config = tauri_equivalent_config("canvas-display-server");
    config.max_restarts = 3;
    config.restart_delay_ms = 30;

    let handle =
        SidecarHandle::spawn_monitor(Box::new(ProcessSidecarSupervisor::new(spawner)), config)
            .expect("spawn monitor");

    // Wait long enough for the monitor to poll, detect each crash, and restart up to max_restarts.
    // 4 crashes * 30 ms poll + slack = ~200 ms.
    thread::sleep(Duration::from_millis(400));

    let spawns = spawn_log.lock().unwrap().clone();
    // 1 initial start + 3 restarts = 4 spawns. The 4th crash exhausts max_restarts, so no 5th
    // spawn.
    assert_eq!(
        spawns.len(),
        4,
        "expected 1 start + 3 restarts = 4 spawns, got {}: {spawns:?}",
        spawns.len()
    );

    handle.shutdown_and_join();
}

#[test]
fn sidecar_handle_monitor_does_not_restart_when_restart_on_crash_is_false() {
    // With restart_on_crash=false, the monitor should start the child, observe the crash, log it,
    // and NOT restart.
    let spawner = FakeCommandSpawner::new().with_next_exits(vec![Some(1)]);
    let spawn_log = spawner.spawn_log();
    let mut config = tauri_equivalent_config("canvas-display-server");
    config.restart_on_crash = false;
    config.restart_delay_ms = 30;

    let handle =
        SidecarHandle::spawn_monitor(Box::new(ProcessSidecarSupervisor::new(spawner)), config)
            .expect("spawn monitor");

    thread::sleep(Duration::from_millis(200));

    let spawns = spawn_log.lock().unwrap().clone();
    assert_eq!(
        spawns.len(),
        1,
        "restart_on_crash=false -> only the initial start, no restarts"
    );

    handle.shutdown_and_join();
}

#[test]
fn sidecar_handle_spawn_monitor_surfaces_a_start_failure_as_an_error() {
    // If the very first start fails (e.g. binary missing), spawn_monitor should return Err
    // immediately, without spawning a monitoring thread.
    let spawner = FakeCommandSpawner::new().with_next_spawn_error("binary not on PATH");
    let config = tauri_equivalent_config("/nonexistent/canvas-display-server");

    let err =
        SidecarHandle::spawn_monitor(Box::new(ProcessSidecarSupervisor::new(spawner)), config)
            .expect_err("start failure should surface as Err");

    assert!(
        err.to_string().contains("binary not on PATH"),
        "expected the canned error, got: {err}"
    );
}

#[test]
fn sidecar_handle_monitor_keeps_a_healthy_child_running_without_restarts() {
    // Empty exit queue = "always running". The monitor should poll, find the child running, and
    // never restart.
    let spawner = FakeCommandSpawner::new();
    let spawn_log = spawner.spawn_log();
    let mut config = tauri_equivalent_config("canvas-display-server");
    config.restart_delay_ms = 30;

    let handle =
        SidecarHandle::spawn_monitor(Box::new(ProcessSidecarSupervisor::new(spawner)), config)
            .expect("spawn monitor");

    // Let the monitor poll several times.
    thread::sleep(Duration::from_millis(200));

    let spawns = spawn_log.lock().unwrap().clone();
    assert_eq!(spawns.len(), 1, "healthy child -> only the initial start");

    handle.shutdown_and_join();
}

// ---------------------------------------------------------------------------
// Compile-time trait bounds
// ---------------------------------------------------------------------------

#[test]
fn process_sidecar_supervisor_is_send() {
    // Compile-time assertion: the supervisor must be movable into the monitoring thread.
    fn assert_send<T: Send>() {}
    assert_send::<ProcessSidecarSupervisor<ProcessCommandSpawner>>();
    assert_send::<ProcessSidecarSupervisor<FakeCommandSpawner>>();
}

#[test]
fn sidecar_supervisor_trait_object_is_send() {
    // The monitoring thread takes a `Box<dyn SidecarSupervisor>`, so the trait must be object-safe
    // and `Send`.
    fn assert_boxed_send(_v: Box<dyn SidecarSupervisor>) {}
    let supervisor: Box<dyn SidecarSupervisor> =
        Box::new(ProcessSidecarSupervisor::new(FakeCommandSpawner::new()));
    assert_boxed_send(supervisor);
}

// ---------------------------------------------------------------------------
// Shared handle sanity (mirrors audio_v1's call-log-after-move pattern)
// ---------------------------------------------------------------------------

#[test]
fn fake_command_spawner_spawn_log_observes_spawns_after_the_spawner_is_moved() {
    let spawner = FakeCommandSpawner::new();
    let spawn_log = spawner.spawn_log();
    let mut supervisor = ProcessSidecarSupervisor::new(spawner);
    let config = tauri_equivalent_config("canvas-display-server");

    supervisor.start(&config).expect("start");

    let spawns = spawn_log.lock().unwrap().clone();
    assert_eq!(spawns.len(), 1);
    assert_eq!(spawns[0].program, "canvas-display-server");
}
