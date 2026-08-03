//! Real, `xset`-backed display power management (DPMS) control.
//!
//! [`XsetDpmsAdapter`] drives `xset dpms force off` / `xset dpms force on` via
//! [`std::process::Command`] through an injectable [`CommandRunner`] seam, mirroring the
//! established real/fake probe pattern in [`crate::capabilities::detect`] and
//! [`crate::ipc::peer`]. The real runner ([`ProcessCommandRunner`]) spawns `xset` as a subprocess;
//! the fake runner ([`FakeCommandRunner`]) records the command for tests so no real `xset` is ever
//! spawned from `cargo test`.
//!
//! This replaces the legacy Tauri sidecar's `screen_off`/`screen_on` commands in
//! `browser/linux/src-tauri/src/lib.rs`, which shell out to the same `xset dpms force off/on`
//! invocations through Tauri's `app.shell().command("xset")` API. Moving the subprocess call into
//! the Edge Agent means the renderer no longer needs shell permission for DPMS -- it just sends an
//! authenticated, allowlisted `display.screen_off` IPC request and the daemon owns the hardware.
//!
//! **Honest scope note:** [`DpmsAdapter::is_on`] is **best-effort**. Parsing `xset q`'s DPMS state
//! line ("DPMS is Enabled" / "Monitor is On/Off/Suspend/Standby") is fragile across X server
//! versions and display configurations, and the kiosk use case only needs *forcing* on/off (not
//! polling state). The real adapter therefore returns `Ok(true)` and documents why; a future task
//! that needs real state polling should replace it with a DRM connector-property probe (the same
//! direction called out in [`crate::capabilities::detect::CapabilityDetector::detect`] for the
//! `dpms` capability itself).

use std::process::Command;
use std::sync::{Arc, Mutex};

use super::brightness::AdapterError;

/// Runs an external command. The real implementation ([`ProcessCommandRunner`]) calls
/// [`Command::status`] (spawning the subprocess); the fake ([`FakeCommandRunner`]) records the
/// command name + args and returns a canned status, so tests can assert "the adapter constructed
/// `xset dpms force off`" without spawning a real `xset`.
///
/// Mirrors the real/fake seam convention from [`crate::capabilities::detect::SystemCapabilityProbe`]
/// and [`crate::ipc::peer::PeerCredentialSource`].
pub trait CommandRunner: Send + std::fmt::Debug {
    /// Runs `program` with `args` and returns whether the subprocess exited successfully. A
    /// failure to spawn (e.g. `xset` not on `PATH`) is reported as `Err(AdapterError::Io(...))`.
    fn run(&self, program: &str, args: &[&str]) -> Result<bool, AdapterError>;
}

/// Production runner: spawns the real subprocess via [`std::process::Command`].
#[derive(Debug, Default, Clone, Copy)]
pub struct ProcessCommandRunner;

impl CommandRunner for ProcessCommandRunner {
    fn run(&self, program: &str, args: &[&str]) -> Result<bool, AdapterError> {
        let status = Command::new(program).args(args).status()?;
        Ok(status.success())
    }
}

/// One recorded command invocation, for tests that assert the adapter constructed the right
/// `xset` invocation without spawning a real subprocess.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedCommand {
    pub program: String,
    pub args: Vec<String>,
}

/// Test-only runner that records every command it would have run and returns a canned success
/// status. Not used by any production code path.
///
/// The call log is held behind a shared `Arc<Mutex<...>>` so a test can retain a handle via
/// [`FakeCommandRunner::call_log`] and inspect the recorded commands after the runner has been
/// moved into an adapter (and from there into the daemon's IPC handler thread).
#[derive(Debug, Clone)]
pub struct FakeCommandRunner {
    calls: Arc<Mutex<Vec<RecordedCommand>>>,
    /// The success value returned from [`CommandRunner::run`]. Defaults to `true` (the adapter
    /// treats `false` as a failed `xset` invocation and surfaces it as an error).
    next_success: bool,
}

impl Default for FakeCommandRunner {
    fn default() -> Self {
        Self::new()
    }
}

impl FakeCommandRunner {
    pub fn new() -> Self {
        Self {
            calls: Arc::new(Mutex::new(Vec::new())),
            next_success: true,
        }
    }

    /// Configures the canned success status returned by the next (and all subsequent) `run` calls.
    pub fn with_success(mut self, success: bool) -> Self {
        self.next_success = success;
        self
    }

    /// Returns a clone of the shared call log handle, so a test can inspect the recorded commands
    /// after this runner has been moved into an adapter. Test-only.
    pub fn call_log(&self) -> Arc<Mutex<Vec<RecordedCommand>>> {
        Arc::clone(&self.calls)
    }

    /// Returns every command the runner was asked to run, in call order. Test-only.
    pub fn recorded_commands(&self) -> Vec<RecordedCommand> {
        self.calls
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }
}

impl CommandRunner for FakeCommandRunner {
    fn run(&self, program: &str, args: &[&str]) -> Result<bool, AdapterError> {
        if let Ok(mut guard) = self.calls.lock() {
            guard.push(RecordedCommand {
                program: program.to_string(),
                args: args.iter().map(|s| s.to_string()).collect(),
            });
        }
        Ok(self.next_success)
    }
}

/// Forces display power on/off through `xset dpms force on/off`.
///
/// All methods are synchronous (the daemon drives them on its IPC thread, never on tokio -- ADR
/// 0009) and never panic: a missing `xset` binary is reported as [`AdapterError::Io`], not a crash.
pub trait DpmsAdapter: Send + std::fmt::Debug {
    /// Forces the display on (`xset dpms force on`).
    fn screen_on(&self) -> Result<(), AdapterError>;

    /// Forces the display off (`xset dpms force off`).
    fn screen_off(&self) -> Result<(), AdapterError>;

    /// Best-effort query of whether the display is currently on. See the module docs for why the
    /// real adapter returns `Ok(true)` rather than parsing `xset q`.
    fn is_on(&self) -> Result<bool, AdapterError>;
}

/// Production adapter: drives `xset dpms force off/on` through an injectable [`CommandRunner`].
///
/// The `CommandRunner` seam is what makes this adapter testable without spawning a real `xset`:
/// production wires in [`ProcessCommandRunner`] (real subprocess), tests wire in
/// [`FakeCommandRunner`] (records the command and returns a canned status).
#[derive(Debug)]
pub struct XsetDpmsAdapter<R: CommandRunner> {
    runner: R,
}

/// Production DPMS adapter that selects the compositor-native command from the daemon's
/// configured environment: `wlopm` for Wayland and `xset` for X11.
#[derive(Debug)]
pub struct DesktopDpmsAdapter<R: CommandRunner> {
    runner: R,
}

impl<R: CommandRunner> DesktopDpmsAdapter<R> {
    pub fn new(runner: R) -> Self {
        Self { runner }
    }

    fn force(&self, state: &str) -> Result<(), AdapterError> {
        let (program, args): (&str, Vec<&str>) = if std::env::var_os("WAYLAND_DISPLAY").is_some() {
            let action = if state == "on" { "--on" } else { "--off" };
            ("wlopm", vec![action, "*"])
        } else {
            ("xset", vec!["dpms", "force", state])
        };
        if self.runner.run(program, &args)? {
            Ok(())
        } else {
            Err(AdapterError::Io(std::io::Error::other(format!(
                "{program} display power {state} exited non-zero"
            ))))
        }
    }
}

impl<R: CommandRunner> DpmsAdapter for DesktopDpmsAdapter<R> {
    fn screen_on(&self) -> Result<(), AdapterError> {
        self.force("on")
    }

    fn screen_off(&self) -> Result<(), AdapterError> {
        self.force("off")
    }

    fn is_on(&self) -> Result<bool, AdapterError> {
        Ok(true)
    }
}

impl<R: CommandRunner> XsetDpmsAdapter<R> {
    pub fn new(runner: R) -> Self {
        Self { runner }
    }

    /// Runs `xset dpms force <state>` and surfaces a non-zero exit as an I/O error (the kiosk
    /// operator-facing message is "xset failed", which is accurate -- the subprocess ran but
    /// returned a non-zero status, e.g. no X server connected).
    fn force(&self, state: &str) -> Result<(), AdapterError> {
        let success = self.runner.run("xset", &["dpms", "force", state])?;
        if success {
            Ok(())
        } else {
            Err(AdapterError::Io(std::io::Error::other(format!(
                "xset dpms force {state} exited non-zero"
            ))))
        }
    }
}

impl<R: CommandRunner> DpmsAdapter for XsetDpmsAdapter<R> {
    fn screen_on(&self) -> Result<(), AdapterError> {
        self.force("on")
    }

    fn screen_off(&self) -> Result<(), AdapterError> {
        self.force("off")
    }

    fn is_on(&self) -> Result<bool, AdapterError> {
        // Best-effort: see module docs. Parsing `xset q`'s DPMS state line is fragile across X
        // server versions and the kiosk use case only needs forcing on/off, so we report `true`
        // (the display is presumed on unless the operator just forced it off) and document the
        // limitation. A future DRM connector-property probe can replace this.
        Ok(true)
    }
}

/// Test-only adapter that records `screen_on`/`screen_off` calls as string tags without any
/// subprocess or filesystem involvement. Not used by any production code path. Mirrors
/// [`super::brightness::FakeBrightnessAdapter`]'s role for [`BrightnessAdapter`].
///
/// The call log is held behind a shared `Arc<Mutex<...>>` so a test can retain a handle via
/// [`FakeDpmsAdapter::call_log`] and inspect the recorded calls after the adapter has been boxed
/// and moved into the daemon's IPC handler thread.
#[derive(Debug, Clone)]
pub struct FakeDpmsAdapter {
    calls: Arc<Mutex<Vec<&'static str>>>,
    next_error: Option<&'static str>,
}

impl Default for FakeDpmsAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl FakeDpmsAdapter {
    pub fn new() -> Self {
        Self {
            calls: Arc::new(Mutex::new(Vec::new())),
            next_error: None,
        }
    }

    /// Configures the adapter to fail the next `screen_on`/`screen_off` call with a canned I/O
    /// error carrying the given message. Test-only.
    pub fn with_next_error(mut self, message: &'static str) -> Self {
        self.next_error = Some(message);
        self
    }

    /// Returns a clone of the shared call log handle, so a test can inspect the recorded calls
    /// after this adapter has been boxed and moved into the daemon's IPC handler. Test-only.
    pub fn call_log(&self) -> Arc<Mutex<Vec<&'static str>>> {
        Arc::clone(&self.calls)
    }

    /// Returns every action (`"screen_on"` / `"screen_off"`) the adapter was asked to perform, in
    /// call order. Test-only.
    pub fn recorded_calls(&self) -> Vec<String> {
        self.calls
            .lock()
            .map(|guard| guard.iter().map(|s| s.to_string()).collect())
            .unwrap_or_default()
    }

    fn record(&self, tag: &'static str) -> Result<(), AdapterError> {
        if let Ok(mut guard) = self.calls.lock() {
            guard.push(tag);
        }
        if let Some(message) = self.next_error {
            return Err(AdapterError::Io(std::io::Error::other(message)));
        }
        Ok(())
    }
}

impl DpmsAdapter for FakeDpmsAdapter {
    fn screen_on(&self) -> Result<(), AdapterError> {
        self.record("screen_on")
    }

    fn screen_off(&self) -> Result<(), AdapterError> {
        self.record("screen_off")
    }

    fn is_on(&self) -> Result<bool, AdapterError> {
        Ok(true)
    }
}
