//! Integration tests for the real, typed hardware adapters in `canvas_edge_agent::hardware`
//! (Phase 3 checklist item "Move brightness, DPMS, reboot, orientation, touch, and hardware status
//! into typed Edge adapters"). See the module docs in `edge/agent/src/hardware/mod.rs`,
//! `brightness.rs`, and `dpms.rs` for what is genuinely real vs. simplified.
//!
//! Which tests exercise the *real* filesystem/subprocess logic vs. the fake/injectable adapters:
//!
//! - `sysfs_*` tests construct `SysfsBrightnessAdapter::with_base(...)` pointing at a throwaway
//!   `tempfile::tempdir()` (never the real `/sys/class/backlight`), so they prove the real
//!   sysfs-walking read/write logic works without depending on -- or mutating -- the actual test
//!   machine's hardware state. This mirrors the `real_probe_*` tests in `capabilities_v1.rs`.
//! - `xset_*` tests construct `XsetDpmsAdapter::new(FakeCommandRunner)` so they prove the real
//!   adapter constructs the right `xset dpms force off/on` command without spawning a real `xset`.
//! - `fake_*` tests use the fully fake adapters to verify canned values and call recording.

use std::fs;
use std::sync::Arc;
use std::sync::Mutex;

use canvas_edge_agent::hardware::{
    BrightnessAdapter, CommandRunner, DpmsAdapter, FakeBrightnessAdapter, FakeCommandRunner,
    FakeDpmsAdapter, HardwareAdapters, ProcessCommandRunner, SysfsBrightnessAdapter,
    XsetDpmsAdapter,
};
use tempfile::tempdir;

// ---------------------------------------------------------------------------
// SysfsBrightnessAdapter -- real sysfs logic against a tempdir
// ---------------------------------------------------------------------------

#[test]
fn sysfs_brightness_adapter_reads_brightness_and_max_from_a_real_backlight_dir() {
    let base = tempdir().expect("create tempdir");
    let device = base.path().join("intel_backlight");
    fs::create_dir_all(&device).expect("create fake backlight device dir");
    fs::write(device.join("brightness"), b"128\n").expect("write brightness file");
    fs::write(device.join("max_brightness"), b"255\n").expect("write max_brightness file");

    let adapter = SysfsBrightnessAdapter::with_base(base.path());

    assert_eq!(adapter.get_brightness().expect("get_brightness"), 128);
    assert_eq!(adapter.max_brightness().expect("max_brightness"), 255);
}

#[test]
fn sysfs_brightness_adapter_writes_a_new_brightness_level_to_the_real_sysfs_file() {
    let base = tempdir().expect("create tempdir");
    let device = base.path().join("rpi_backlight");
    fs::create_dir_all(&device).expect("create fake backlight device dir");
    fs::write(device.join("brightness"), b"50\n").expect("write initial brightness");
    fs::write(device.join("max_brightness"), b"100\n").expect("write max_brightness");

    let adapter = SysfsBrightnessAdapter::with_base(base.path());
    adapter.set_brightness(75).expect("set_brightness");

    // Re-read the file directly to prove the write actually happened on disk.
    let written = fs::read_to_string(device.join("brightness")).expect("read back brightness file");
    assert_eq!(written.trim(), "75");
}

#[test]
fn sysfs_brightness_adapter_rejects_a_level_above_max_brightness() {
    let base = tempdir().expect("create tempdir");
    let device = base.path().join("panel_0");
    fs::create_dir_all(&device).expect("create fake backlight device dir");
    fs::write(device.join("brightness"), b"10\n").expect("write brightness");
    fs::write(device.join("max_brightness"), b"100\n").expect("write max_brightness");

    let adapter = SysfsBrightnessAdapter::with_base(base.path());
    let err = adapter
        .set_brightness(200)
        .expect_err("level above max should be rejected");
    match err {
        canvas_edge_agent::hardware::brightness::AdapterError::OutOfRange { level, max } => {
            assert_eq!(level, 200);
            assert_eq!(max, 100);
        }
        other => panic!("expected OutOfRange, got {other:?}"),
    }
}

#[test]
fn sysfs_brightness_adapter_reports_no_backlight_device_when_the_base_dir_is_missing() {
    let base = tempdir().expect("create tempdir");
    let missing = base.path().join("does-not-exist");

    let adapter = SysfsBrightnessAdapter::with_base(&missing);

    let err = adapter
        .get_brightness()
        .expect_err("missing base dir should error");
    assert!(matches!(
        err,
        canvas_edge_agent::hardware::brightness::AdapterError::NoBacklightDevice(_)
    ));
}

#[test]
fn sysfs_brightness_adapter_reports_no_backlight_device_when_no_subdir_has_a_brightness_file() {
    let base = tempdir().expect("create tempdir");
    // A subdirectory without a `brightness` file -- the walker should skip it.
    fs::create_dir_all(base.path().join("not_a_backlight"))
        .expect("create dir without brightness file");

    let adapter = SysfsBrightnessAdapter::with_base(base.path());

    let err = adapter
        .max_brightness()
        .expect_err("no brightness file should error");
    assert!(matches!(
        err,
        canvas_edge_agent::hardware::brightness::AdapterError::NoBacklightDevice(_)
    ));
}

#[test]
fn sysfs_brightness_adapter_picks_the_first_backlight_device_with_a_brightness_file() {
    let base = tempdir().expect("create tempdir");
    // Two devices; the walker should pick the first one `read_dir` returns that has a `brightness`
    // file. (We cannot assert *which* one without depending on `read_dir` ordering, but we can
    // assert it picks one of them and not neither.)
    let d1 = base.path().join("aaa_backlight");
    fs::create_dir_all(&d1).expect("create first device dir");
    fs::write(d1.join("brightness"), b"10\n").expect("write brightness");
    fs::write(d1.join("max_brightness"), b"100\n").expect("write max");

    let d2 = base.path().join("zzz_backlight");
    fs::create_dir_all(&d2).expect("create second device dir");
    fs::write(d2.join("brightness"), b"20\n").expect("write brightness");
    fs::write(d2.join("max_brightness"), b"200\n").expect("write max");

    let adapter = SysfsBrightnessAdapter::with_base(base.path());
    let max = adapter
        .max_brightness()
        .expect("max_brightness should resolve");
    assert!(max == 100 || max == 200, "unexpected max: {max}");
}

// ---------------------------------------------------------------------------
// FakeBrightnessAdapter -- canned values + call recording
// ---------------------------------------------------------------------------

#[test]
fn fake_brightness_adapter_returns_canned_current_and_max() {
    let adapter = FakeBrightnessAdapter::new(42, 255);
    assert_eq!(adapter.get_brightness().expect("get"), 42);
    assert_eq!(adapter.max_brightness().expect("max"), 255);
}

#[test]
fn fake_brightness_adapter_records_set_brightness_calls_in_order() {
    let adapter = FakeBrightnessAdapter::new(0, 255);
    adapter.set_brightness(10).expect("set 10");
    adapter.set_brightness(20).expect("set 20");
    adapter.set_brightness(30).expect("set 30");

    assert_eq!(adapter.recorded_set_calls(), vec![10, 20, 30]);
}

#[test]
fn fake_brightness_adapter_call_log_handle_observes_calls_after_the_adapter_is_moved() {
    // Simulate the IPC handler thread pattern: the adapter is moved away, but a clone of the
    // shared call log stays behind for the test to inspect.
    let adapter = FakeBrightnessAdapter::new(0, 255);
    let log = adapter.call_log();
    let moved = adapter;
    moved.set_brightness(99).expect("set 99");

    let recorded = log.lock().unwrap().clone();
    assert_eq!(recorded, vec![99]);
}

// ---------------------------------------------------------------------------
// XsetDpmsAdapter -- real command construction via an injectable runner
// ---------------------------------------------------------------------------

#[test]
fn xset_dpms_adapter_screen_off_constructs_xset_dpms_force_off() {
    let runner = FakeCommandRunner::new();
    let log = runner.call_log();
    let adapter = XsetDpmsAdapter::new(runner);

    adapter.screen_off().expect("screen_off should succeed");

    let recorded = log.lock().unwrap().clone();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].program, "xset");
    assert_eq!(recorded[0].args, vec!["dpms", "force", "off"]);
}

#[test]
fn xset_dpms_adapter_screen_on_constructs_xset_dpms_force_on() {
    let runner = FakeCommandRunner::new();
    let log = runner.call_log();
    let adapter = XsetDpmsAdapter::new(runner);

    adapter.screen_on().expect("screen_on should succeed");

    let recorded = log.lock().unwrap().clone();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].program, "xset");
    assert_eq!(recorded[0].args, vec!["dpms", "force", "on"]);
}

#[test]
fn xset_dpms_adapter_surfaces_a_non_zero_xset_exit_as_an_error() {
    let runner = FakeCommandRunner::new().with_success(false);
    let adapter = XsetDpmsAdapter::new(runner);

    let err = adapter
        .screen_off()
        .expect_err("non-zero exit should error");
    let msg = err.to_string();
    assert!(
        msg.contains("xset dpms force off exited non-zero"),
        "expected non-zero exit message, got: {msg}"
    );
}

#[test]
fn xset_dpms_adapter_is_on_returns_true_best_effort() {
    // Documented best-effort: see dpms.rs module docs. The real adapter does not parse `xset q`.
    let runner = FakeCommandRunner::new();
    let adapter = XsetDpmsAdapter::new(runner);
    assert!(adapter.is_on().expect("is_on"));
}

#[test]
fn process_command_runner_is_send_and_sync() {
    // Compile-time assertion: the real runner must be usable from the daemon's IPC thread.
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<ProcessCommandRunner>();
}

// ---------------------------------------------------------------------------
// FakeDpmsAdapter -- call recording
// ---------------------------------------------------------------------------

#[test]
fn fake_dpms_adapter_records_screen_on_and_screen_off_calls_in_order() {
    let adapter = FakeDpmsAdapter::new();
    let log = adapter.call_log();
    let moved = adapter;

    moved.screen_off().expect("screen_off");
    moved.screen_on().expect("screen_on");

    let recorded: Vec<String> = log.lock().unwrap().iter().map(|s| s.to_string()).collect();
    assert_eq!(recorded, vec!["screen_off", "screen_on"]);
}

#[test]
fn fake_dpms_adapter_surfaces_a_configured_error() {
    let adapter = FakeDpmsAdapter::new().with_next_error("fake dpms failure");
    let err = adapter
        .screen_off()
        .expect_err("configured error should surface");
    assert!(err.to_string().contains("fake dpms failure"));
}

// ---------------------------------------------------------------------------
// HardwareAdapters bundle
// ---------------------------------------------------------------------------

#[test]
fn hardware_adapters_with_fakes_dispatches_brightness_and_dpms() {
    let brightness = FakeBrightnessAdapter::new(0, 255);
    let dpms = FakeDpmsAdapter::new();
    let b_log = brightness.call_log();
    let d_log = dpms.call_log();

    let adapters = HardwareAdapters::with_fakes(brightness, dpms);
    adapters
        .brightness
        .set_brightness(77)
        .expect("set_brightness");
    adapters.dpms.screen_off().expect("screen_off");

    assert_eq!(b_log.lock().unwrap().clone(), vec![77]);
    assert_eq!(
        d_log
            .lock()
            .unwrap()
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>(),
        vec!["screen_off"]
    );
}

#[test]
fn hardware_adapters_with_injectable_uses_real_sysfs_and_fake_command_runner() {
    let base = tempdir().expect("create tempdir");
    let device = base.path().join("test_panel");
    fs::create_dir_all(&device).expect("create device dir");
    fs::write(device.join("brightness"), b"5\n").expect("write brightness");
    fs::write(device.join("max_brightness"), b"10\n").expect("write max");

    let runner = FakeCommandRunner::new();
    let cmd_log = runner.call_log();
    let adapters = HardwareAdapters::with_injectable(base.path(), runner);

    // Real sysfs path:
    assert_eq!(adapters.brightness.max_brightness().expect("max"), 10);
    adapters.brightness.set_brightness(8).expect("set 8");
    assert_eq!(adapters.brightness.get_brightness().expect("get"), 8);

    // Fake command runner path:
    adapters.dpms.screen_off().expect("screen_off");
    let recorded = cmd_log.lock().unwrap().clone();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].program, "xset");
    assert_eq!(recorded[0].args, vec!["dpms", "force", "off"]);
}

#[test]
fn hardware_adapters_new_real_constructs_without_panicking() {
    // We cannot exercise the real adapters' I/O (no real /sys or xset in CI), but we can at least
    // prove the production constructor builds the bundle without panicking -- a regression here
    // would mean `main()` cannot construct the handler at startup.
    let _adapters = HardwareAdapters::new_real();
}

// ---------------------------------------------------------------------------
// CommandRunner trait object -- prove the trait is object-safe
// ---------------------------------------------------------------------------

#[test]
fn command_runner_trait_is_object_safe() {
    // Compile-time assertion: the daemon holds `Box<dyn CommandRunner>` indirectly through
    // `XsetDpmsAdapter<Box<dyn CommandRunner>>` would require `CommandRunner: Sized`, but the
    // `HardwareAdapters` struct holds `Box<dyn DpmsAdapter>` which wraps a concrete
    // `XsetDpmsAdapter<R>`. This test proves the concrete runner types are usable as trait objects
    // where needed.
    let runner: Box<dyn CommandRunner> = Box::new(FakeCommandRunner::new());
    runner.run("echo", &["hi"]).expect("boxed runner works");
}

#[test]
fn arc_mutex_is_send_and_sync() {
    // Compile-time assertion: the shared call logs must cross thread boundaries (from the test
    // thread to the IPC handler thread and back).
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<Arc<Mutex<Vec<u32>>>>();
    assert_send_sync::<Arc<Mutex<Vec<String>>>>();
}
