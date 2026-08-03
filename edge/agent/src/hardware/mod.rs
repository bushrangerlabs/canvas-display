//! Real, typed hardware adapters that the Edge Agent owns directly, replacing the Node/Tauri
//! sidecar's subprocess-based hardware control with Rust adapters the daemon drives on its own
//! IPC thread (ADR 0009: the daemon stays synchronous; these adapters never touch tokio).
//!
//! This is the first concrete Phase 3 extraction ("Move brightness, DPMS, reboot, orientation,
//! touch, and hardware status into typed Edge adapters"). Today the kiosk renderer calls these
//! controls through Tauri `invoke()` commands in `browser/linux/src-tauri/src/lib.rs`, which shell
//! out to `xset dpms force off/on` (DPMS) and `xrandr --output <name> --brightness <val>`
//! (brightness). The adapters here replace those two paths with direct Rust:
//!
//! - [`brightness`]: reads/writes `/sys/class/backlight/<device>/brightness` and
//!   `/sys/class/backlight/<device>/max_brightness` via sysfs (the same path the capability probe
//!   in [`crate::capabilities::detect`] already inspects for `has_backlight`). This is more direct
//!   and more portable than the sidecar's `xrandr --brightness` loop (which guesses output names
//!   and only adjusts the gamma ramp, not actual backlight power), and it matches what the
//!   capability detector already advertises as the `brightness` hardware capability.
//! - [`dpms`]: drives `xset dpms force off/on` via [`std::process::Command`] through an injectable
//!   [`dpms::CommandRunner`] seam, mirroring the established real/fake probe pattern in
//!   [`crate::capabilities::detect`]. The real runner spawns `xset`; the fake runner records the
//!   command for tests so no real subprocess is ever spawned from `cargo test`.
//!
//! Both modules follow the injectable-dependency-for-testability convention already used by
//! [`crate::capabilities::detect`] (`RealSystemCapabilityProbe`/`FakeSystemCapabilityProbe`) and
//! [`crate::ipc::peer`] (`SoPeercredSource`/`FakePeerCredentialSource`): production code gets a
//! real implementation that touches the real OS, and tests get a fake/injectable one that returns
//! canned results, so the test suite in `edge/agent/tests/hardware_v1.rs` never depends on -- or
//! mutates -- the actual hardware state of whatever machine happens to run `cargo test`.
//!
//! What is real vs. simplified here (see each adapter's doc comment for the per-field breakdown):
//! - `SysfsBrightnessAdapter` performs **real** sysfs reads/writes (proven against a `tempfile`
//!   tempdir in tests, exactly like `RealSystemCapabilityProbe`).
//! - `XsetDpmsAdapter` performs **real** `xset` subprocess invocations in production; tests use
//!   `FakeCommandRunner` to assert the constructed command without spawning `xset`.
//! - `DpmsAdapter::is_on` is **best-effort**: parsing `xset q`'s DPMS state line is fragile across
//!   X server versions and the kiosk use case only needs on/off forcing, so the real adapter
//!   returns `Ok(true)` and documents why. A future task that needs real state polling can replace
//!   it with a DRM connector-property probe.

pub mod audio;
pub mod brightness;
pub mod dpms;
pub mod mic;

pub use audio::{
    AudioAdapters, FakeMpvIpc, FakeMpvSpawner, FakePlaybackAdapter, FakeVolumeAdapter,
    FakeVolumeRunner, MpvChild, MpvIpc, MpvPlaybackAdapter, MpvSpawner, PactlVolumeAdapter,
    PlaybackAdapter, PlaybackSnapshot, PlaybackState, ProcessMpvSpawner, ProcessVolumeRunner,
    RecordedSpawn, RecordedVolumeCommand, UnixSocketMpvIpc, VolumeAdapter, VolumeCommandRunner,
    DEFAULT_MPV_SOCKET_PATH,
};
pub use brightness::{BrightnessAdapter, FakeBrightnessAdapter, SysfsBrightnessAdapter};
pub use dpms::{
    CommandRunner, DesktopDpmsAdapter, DpmsAdapter, FakeCommandRunner, FakeDpmsAdapter,
    ProcessCommandRunner, XsetDpmsAdapter,
};
pub use mic::{
    FakeMicAdapter, FakeMicCommandRunner, MicAdapter, MicAdapters, MicCommandRunner,
    ParecMicAdapter, PcmChunk, ProcessMicCommandRunner, RecordedMicCommand,
};

use std::path::PathBuf;

/// A bundle of the daemon's real hardware adapters, constructed once at startup in `main.rs` and
/// handed to the IPC action handler so it can dispatch `display.*` methods to real hardware without
/// the handler having to know how each adapter is built.
///
/// Each adapter is held as a trait object so the IPC handler can be constructed with fakes in tests
/// (see `edge/agentd/tests/ipc_wiring_v1.rs`), and so a future adapter implementation swap (e.g.
/// replacing `XsetDpmsAdapter` with a DRM-property adapter) does not require touching the handler.
#[derive(Debug)]
pub struct HardwareAdapters {
    /// Brightness control (sysfs `/sys/class/backlight/...`).
    pub brightness: Box<dyn BrightnessAdapter>,
    /// Display power management (`xset dpms force off/on`).
    pub dpms: Box<dyn DpmsAdapter>,
}

impl HardwareAdapters {
    /// Production constructor: real sysfs brightness against `/sys/class/backlight` and real
    /// `xset`-via-`std::process::Command` DPMS. Called by the daemon's `main()`.
    pub fn new_real() -> Self {
        Self {
            brightness: Box::new(SysfsBrightnessAdapter::new()),
            dpms: Box::new(DesktopDpmsAdapter::new(ProcessCommandRunner)),
        }
    }

    /// Test/inspection constructor: real sysfs brightness against `backlight_base` (so tests
    /// exercise the real filesystem-walking logic against a `tempfile` tempdir, exactly like
    /// `RealSystemCapabilityProbe::with_paths`), and DPMS through an injectable
    /// [`CommandRunner`] (so tests never spawn a real `xset`).
    pub fn with_injectable(
        backlight_base: impl Into<PathBuf>,
        command_runner: impl CommandRunner + 'static,
    ) -> Self {
        Self {
            brightness: Box::new(SysfsBrightnessAdapter::with_base(backlight_base)),
            dpms: Box::new(XsetDpmsAdapter::new(command_runner)),
        }
    }

    /// Test-only constructor that takes fully fake adapters, for IPC wiring tests that need to
    /// assert "the handler called screen_off" without any filesystem or subprocess involvement at
    /// all. Not used by any production code path.
    pub fn with_fakes(brightness: FakeBrightnessAdapter, dpms: FakeDpmsAdapter) -> Self {
        Self {
            brightness: Box::new(brightness),
            dpms: Box::new(dpms),
        }
    }
}
