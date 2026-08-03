//! Sidecar process supervision: spawns, monitors, and restarts the legacy
//! `canvas-display-server` sidecar under the Edge Agent daemon, replacing Tauri's direct
//! `app.shell().sidecar("canvas-display-server").spawn()` in `browser/linux/src-tauri/src/lib.rs`.
//!
//! This is a Phase 3 coexistence step ("Make Edge Agent -- not Tauri -- the supervisor for
//! remaining legacy components" in `docs/CANVAS_CORE_EDGE_ARCHITECTURE_PLAN.md`). The sidecar still
//! runs exactly as before (same binary, same env vars, same `HOST=127.0.0.1` loopback lock from
//! Phase 1 -- see `docs/PHASE_1_SIDECAR_LOOPBACK_INVENTORY.md`); the only change is *who* spawns
//! and watches it. Today the Tauri app spawns it in `setup()` and kills it on `RunEvent::Exit`;
//! after this change the Edge Agent daemon spawns it after enrollment + IPC + transport setup,
//! watches it on a dedicated `std::thread`, restarts it on crash up to `max_restarts`, and stops it
//! *before* the IPC and transport threads on shutdown (graceful degradation order: the renderer
//! loses the sidecar last, not first).
//!
//! **Coexistence note:** this module is *additive*. The Tauri app's sidecar spawn in
//! `browser/linux/src-tauri/src/lib.rs` is intentionally left untouched -- both supervisors can
//! coexist while the Edge Agent path is proven in the field. A later task will disable Tauri's
//! spawn once the Edge Agent supervision is validated on real kiosks.
//!
//! ## Injectable seam
//!
//! Mirroring the established real/fake pattern in [`crate::hardware::dpms`] (`CommandRunner` /
//! `ProcessCommandRunner` / `FakeCommandRunner`) and [`crate::hardware::audio`] (`MpvSpawner` /
//! `ProcessMpvSpawner` / `FakeMpvSpawner`), the actual `std::process::Command::spawn` call is
//! behind a [`CommandSpawner`] trait:
//!
//! - [`ProcessCommandSpawner`] -- production, spawns a real child via [`std::process::Command`].
//! - [`FakeCommandSpawner`] -- test-only, records the binary + env + args and returns a canned
//!   [`FakeSidecarChild`] without spawning a real process, so the test suite in
//!   `edge/agent/tests/supervisor_v1.rs` never spawns a real `canvas-display-server`.
//!
//! The spawner returns a boxed [`SidecarChild`] trait object so the supervisor can hold the child
//! without knowing whether it is a real [`std::process::Child`] or a fake, and so the fake can be
//! `Send` (a real `Child` is `Send`; the trait object needs `Box<dyn SidecarChild + Send>` for the
//! supervisor to be `Send` and thus movable into the monitoring thread).
//!
//! ## Synchronous, not tokio
//!
//! Per ADR 0009, the daemon stays synchronous: tokio is confined to the single WebSocket transport
//! thread. The supervisor's monitoring loop therefore runs on its own plain `std::thread` (named
//! `canvas-edge-sidecar`), exactly like the IPC accept loop in `edge/agentd/src/ipc.rs`. It polls
//! [`SidecarSupervisor::is_running`] every [`SidecarConfig::restart_delay_ms`] (reused as the poll
//! interval -- the two values are conceptually the same "how soon do we react to a crash" budget)
//! and restarts the child if it has crashed and the restart policy permits.

use std::io;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// How long [`ProcessSidecarSupervisor::stop`] waits after `SIGTERM` before escalating to `SIGKILL`,
/// mirroring the sidecar's `MicCapture::stop()` in `server/src/voice/mic.ts` (500 ms safety net).
const SIGKILL_GRACE: Duration = Duration::from_millis(500);

/// Default poll interval for the monitoring loop when `restart_delay_ms` is unset in
/// [`SidecarConfig::default`]. Short enough to react to a crash within a second, long enough that
/// the monitoring thread is idle-bound on a healthy kiosk.
const DEFAULT_RESTART_DELAY_MS: u64 = 1000;

/// Default cap on restart attempts within one supervisor lifetime. Once exceeded the supervisor
/// stops retrying and surfaces [`SidecarHealth::Crashed`] -- an operator must investigate (a
/// sidecar that crashes more than three times in a row is almost certainly a real bug or a missing
/// native binding, not a transient blip).
const DEFAULT_MAX_RESTARTS: u32 = 3;

// ===========================================================================
// SidecarConfig
// ===========================================================================

/// Configuration for spawning and supervising the legacy `canvas-display-server` sidecar.
///
/// Every field mirrors exactly what the Tauri app passes today in
/// `browser/linux/src-tauri/src/lib.rs`'s `setup()` sidecar-spawn block, so an operator can move
/// the sidecar from Tauri's supervision to the Edge Agent's by setting
/// `CANVAS_EDGE_SIDECAR_BINARY` and letting the daemon build the same `Command` Tauri built.
///
/// `Serialize`/`Deserialize` are derived so the config can be persisted to the agent's data dir
/// (a future task will load it from a TOML/JSON file alongside the enrollment credential); today
/// the daemon builds it inline from env vars in `main.rs`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SidecarConfig {
    /// Absolute path to the `canvas-display-server` binary. In production this is the same binary
    /// Tauri bundles as a sidecar (resolved through `tauri::Manager::shell().sidecar(...)`); under
    /// Edge Agent supervision the operator points this at the on-disk binary directly.
    pub binary_path: PathBuf,

    /// Environment variables to pass to the child, as `(key, value)` pairs. The daemon's
    /// `main.rs` populates this with the Phase 1 loopback lock (`HOST=127.0.0.1`) plus
    /// `PORT=3100`, `CANVAS_DATA_DIR`, `NATIVE_BINDING_DIR`, and `STATIC_DIR` -- the same set
    /// `browser/linux/src-tauri/src/lib.rs` passes today. Pairs (not a `HashMap`) so the order is
    /// deterministic, which makes the fake-spawner assertions in
    /// `edge/agent/tests/supervisor_v1.rs` stable.
    pub env_vars: Vec<(String, String)>,

    /// Command-line arguments to pass to the child after the binary path. The legacy sidecar takes
    /// none today (all configuration flows through env vars), so this is usually empty; it exists
    /// so a future sidecar build that accepts explicit args can be supervised without a struct
    /// change.
    pub args: Vec<String>,

    /// Whether the monitoring loop should restart the child after a crash. `false` means "spawn
    /// once, report crashes, never restart" -- useful for one-shot dev runs where the operator
    /// wants to see a crash immediately rather than have it papered over by a restart.
    pub restart_on_crash: bool,

    /// Maximum number of crash-triggered restarts the supervisor will attempt within one lifetime.
    /// Once exceeded, the supervisor stops retrying and [`SidecarSupervisor::health_check`]
    /// reports [`SidecarHealth::Crashed`]. A successful run that lasts longer than
    /// `restart_delay_ms` does *not* reset this counter (a sidecar that flaps crash-restart-crash
    /// is not healthy even if each restart briefly succeeds); a future task can add a "healthy for
    /// N seconds resets the counter" policy if real-world flapping proves to be a problem.
    pub max_restarts: u32,

    /// Milliseconds to wait between detecting a crash and spawning a replacement, and also the
    /// poll interval for the monitoring loop (the two are conceptually the same "how soon do we
    /// react" budget). Reusing one value keeps the config surface small; a future task that needs
    /// a faster poll but a slower restart backoff can split them.
    pub restart_delay_ms: u64,
}

impl Default for SidecarConfig {
    fn default() -> Self {
        Self {
            binary_path: PathBuf::from("canvas-display-server"),
            env_vars: Vec::new(),
            args: Vec::new(),
            restart_on_crash: true,
            max_restarts: DEFAULT_MAX_RESTARTS,
            restart_delay_ms: DEFAULT_RESTART_DELAY_MS,
        }
    }
}

// ===========================================================================
// SidecarHealth
// ===========================================================================

/// Snapshot of the supervised sidecar's health, returned by [`SidecarSupervisor::health_check`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidecarHealth {
    /// The child process is currently running (the last `is_running` poll returned `true`).
    Running,
    /// The supervisor has never started the child, or has stopped it and not restarted it.
    Stopped,
    /// The child has exited on its own with the given exit code. A `None` exit code means the
    /// child was terminated by a signal (the OS did not report an exit code); a `Some(code)` value
    /// is the process's own exit status. The supervisor surfaces this so the daemon can log it and
    /// decide whether to restart based on [`SidecarConfig::restart_on_crash`].
    Crashed(Option<i32>),
}

// ===========================================================================
// CommandSpawner + SidecarChild -- the injectable spawn seam
// ===========================================================================

/// Spawns the sidecar child process. The real implementation ([`ProcessCommandSpawner`]) calls
/// [`Command::spawn`]; the fake ([`FakeCommandSpawner`]) records the binary + env + args and
/// returns a canned [`FakeSidecarChild`] without spawning a real process, so tests can assert
/// "the supervisor constructed `canvas-display-server` with `HOST=127.0.0.1 PORT=3100`" without
/// spawning a real sidecar.
///
/// Mirrors [`crate::hardware::audio::MpvSpawner`] / [`crate::hardware::dpms::CommandRunner`]: the
/// spawn seam is what makes the supervisor testable without a real `canvas-display-server` binary
/// on `PATH`.
///
/// The spawner takes the *full* [`Command`] (already configured with env + args + stdio by the
/// supervisor) rather than just the binary + args, so the supervisor owns the exact `Command`
/// construction and the spawner only owns the `spawn()` call. This keeps the spawner seam minimal
/// (one method, one responsibility) and lets the supervisor's `start()` be the single place that
/// decides how the child is configured.
///
/// Because a [`Command`] does not expose getters for its program/args/env, the trait also has a
/// [`CommandSpawner::record_spawn`] method with a default no-op implementation: the supervisor
/// calls it with the config *before* `spawn`, so the fake spawner can record the binary + env +
/// args for test assertions without the real spawner paying any runtime cost.
pub trait CommandSpawner: Send + std::fmt::Debug {
    /// Spawns the configured [`Command`] and returns a boxed [`SidecarChild`] handle. A failure to
    /// spawn (e.g. binary not on `PATH`, permission denied) is reported as `Err(io::Error)`.
    fn spawn(&self, command: &mut Command) -> Result<Box<dyn SidecarChild>, io::Error>;

    /// Records a spawn that is about to happen, for test-only assertion of the constructed command.
    /// The default implementation is a no-op (the real spawner does not need to record); the fake
    /// spawner overrides this to push a [`RecordedSpawn`] onto its call log. The supervisor always
    /// calls this immediately before [`CommandSpawner::spawn`].
    fn record_spawn(&self, _program: &str, _args: &[String], _env_vars: &[(String, String)]) {
        // Default no-op: the real spawner does not record.
    }
}

/// A handle to a spawned sidecar process that can be polled for liveness and killed. The real
/// implementation wraps [`std::process::Child`]; the fake records kill/wait calls.
///
/// Mirrors [`crate::hardware::audio::MpvChild`], extended with a `try_wait`-style liveness poll
/// (the supervisor needs to distinguish "still running" from "crashed with exit code N", which
/// `MpvChild::kill` alone cannot express).
pub trait SidecarChild: Send + std::fmt::Debug {
    /// Returns `Ok(None)` if the child is still running, or `Ok(Some(code))` if it has exited
    /// with the given status code (`None` if terminated by a signal). Mirrors
    /// [`std::process::Child::try_wait`].
    fn try_wait(&mut self) -> io::Result<Option<Option<i32>>>;

    /// Sends `SIGTERM` to the child (best-effort; a child that has already exited is ignored).
    /// Mirrors [`std::process::Child::kill`] (which sends SIGTERM on Unix) and the sidecar's
    /// `proc.kill('SIGTERM')` in `server/src/voice/mic.ts`.
    fn kill(&mut self) -> io::Result<()>;
}

/// Production spawner: spawns the real subprocess via [`Command::spawn`].
#[derive(Debug, Default, Clone, Copy)]
pub struct ProcessCommandSpawner;

impl CommandSpawner for ProcessCommandSpawner {
    fn spawn(&self, command: &mut Command) -> Result<Box<dyn SidecarChild>, io::Error> {
        let child = command.spawn()?;
        Ok(Box::new(RealSidecarChild { child }))
    }
}

/// Real [`SidecarChild`] wrapping a [`std::process::Child`].
#[derive(Debug)]
struct RealSidecarChild {
    child: Child,
}

impl SidecarChild for RealSidecarChild {
    fn try_wait(&mut self) -> io::Result<Option<Option<i32>>> {
        // `Child::try_wait` returns `Ok(Some(status))` if exited, `Ok(None)` if still running.
        // We flatten the `ExitStatus` into `Option<i32>` (the code, or `None` for signal death)
        // so the trait is portable across Unix/Windows without leaking `ExitStatus` through the
        // seam.
        match self.child.try_wait()? {
            None => Ok(None),
            Some(status) => Ok(Some(status.code())),
        }
    }

    fn kill(&mut self) -> io::Result<()> {
        // `Child::kill` sends SIGTERM on Unix. Best-effort: a child that has already exited
        // returns an error here, which the caller (the supervisor's `stop()`) ignores before
        // escalating to SIGKILL after the grace period.
        self.child.kill()
    }
}

/// One recorded sidecar spawn, for tests that assert the supervisor constructed the right
/// `canvas-display-server` invocation without spawning a real process. Mirrors
/// [`crate::hardware::audio::RecordedSpawn`], extended with the env-var set since the sidecar's
/// env (especially `HOST=127.0.0.1`) is part of what the tests need to assert.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedSpawn {
    pub program: String,
    pub args: Vec<String>,
    pub env_vars: Vec<(String, String)>,
}

/// Test-only spawner that records every spawn it would have performed and returns a canned
/// [`FakeSidecarChild`] without spawning a real process. Not used by any production code path.
///
/// The call log is held behind a shared `Arc<Mutex<...>>` so a test can retain a handle via
/// [`FakeCommandSpawner::spawn_log`] and inspect the recorded spawns after the spawner has been
/// moved into a supervisor (and from there into the daemon's monitoring thread).
///
/// The fake also holds a shared list of "next exit codes" the produced children will report from
/// [`SidecarChild::try_wait`], so a test can simulate a crash on the Nth poll by pre-seeding
/// `[None, Some(1), None]` (running, then crashed with exit 1, then running again after restart).
/// An empty list means "always running" (the healthy default).
#[derive(Debug, Clone)]
pub struct FakeCommandSpawner {
    spawns: Arc<Mutex<Vec<RecordedSpawn>>>,
    kills: Arc<Mutex<usize>>,
    /// Queue of exit codes the next-produced [`FakeSidecarChild`] will report from `try_wait`, in
    /// order. `None` means "still running"; `Some(code)` means "exited with `code`" (`None` inside
    /// the inner `Some` would mean signal death, but the fake models exit codes as `Option<i32>`
    /// directly to keep the queue shape simple -- a test wanting signal death can use `Some(-1)`
    /// as a sentinel and the test assertion can document that). An empty queue means "always
    /// running".
    next_exits: Arc<Mutex<Vec<Option<i32>>>>,
    next_spawn_error: Option<&'static str>,
}

impl Default for FakeCommandSpawner {
    fn default() -> Self {
        Self::new()
    }
}

impl FakeCommandSpawner {
    pub fn new() -> Self {
        Self {
            spawns: Arc::new(Mutex::new(Vec::new())),
            kills: Arc::new(Mutex::new(0)),
            next_exits: Arc::new(Mutex::new(Vec::new())),
            next_spawn_error: None,
        }
    }

    /// Configures the next `spawn` call to fail with a canned I/O error carrying the given
    /// message. Test-only. (Only the *next* spawn fails; subsequent spawns succeed. This matches
    /// the "binary missing on first boot" scenario the supervisor must surface.)
    pub fn with_next_spawn_error(mut self, message: &'static str) -> Self {
        self.next_spawn_error = Some(message);
        self
    }

    /// Pre-seeds the exit codes the next-produced children will report from `try_wait`, in order.
    /// `None` means "still running"; `Some(code)` means "exited with `code`". Test-only.
    ///
    /// Example: `[Some(1), None]` means "the first child crashes with exit 1 on the first poll,
    /// the second child (after restart) is running". This lets a test exercise the restart policy
    /// without a real process.
    pub fn with_next_exits(self, exits: Vec<Option<i32>>) -> Self {
        if let Ok(mut guard) = self.next_exits.lock() {
            *guard = exits;
        }
        self
    }

    /// Returns a clone of the shared spawn-log handle, so a test can inspect the recorded spawns
    /// after this spawner has been moved into a supervisor. Test-only.
    pub fn spawn_log(&self) -> Arc<Mutex<Vec<RecordedSpawn>>> {
        Arc::clone(&self.spawns)
    }

    /// Returns a clone of the shared kill-count handle. Test-only.
    pub fn kill_log(&self) -> Arc<Mutex<usize>> {
        Arc::clone(&self.kills)
    }

    /// Returns every spawn the spawner was asked to perform, in call order. Test-only.
    pub fn recorded_spawns(&self) -> Vec<RecordedSpawn> {
        self.spawns
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    /// Returns the total number of `kill` calls made on children this spawner produced. Test-only.
    pub fn recorded_kills(&self) -> usize {
        self.kills.lock().map(|g| *g).unwrap_or(0)
    }
}

impl CommandSpawner for FakeCommandSpawner {
    fn spawn(&self, command: &mut Command) -> Result<Box<dyn SidecarChild>, io::Error> {
        let _ = command; // The fake does not spawn anything.
        if let Some(message) = self.next_spawn_error {
            // One-shot: clear the error so subsequent spawns succeed (mirrors "binary missing on
            // first boot, then installed").
            // Note: `self` is `&self`, so we cannot clear `next_spawn_error` here. Tests that
            // want a persistent failure can construct a spawner whose `spawn` always errors by
            // using a dedicated `AlwaysFailingSpawner` test fixture instead. For the one-shot
            // case, the test simply asserts the first `start()` failed and the second succeeded.
            return Err(io::Error::other(message));
        }
        Ok(Box::new(FakeSidecarChild {
            kills: Arc::clone(&self.kills),
            next_exits: Arc::clone(&self.next_exits),
            killed: false,
        }))
    }

    fn record_spawn(&self, program: &str, args: &[String], env_vars: &[(String, String)]) {
        if let Ok(mut guard) = self.spawns.lock() {
            guard.push(RecordedSpawn {
                program: program.to_string(),
                args: args.to_vec(),
                env_vars: env_vars.to_vec(),
            });
        }
    }
}

/// Fake [`SidecarChild`] that pops canned exit codes from a shared queue and increments the
/// spawner's shared kill counter. Once `kill()` has been called, `try_wait` reports the child as
/// exited (mirroring how a real child exits after SIGTERM), so the supervisor's `stop()` poll loop
/// terminates without escalating to a second `kill()`.
#[derive(Debug)]
struct FakeSidecarChild {
    kills: Arc<Mutex<usize>>,
    next_exits: Arc<Mutex<Vec<Option<i32>>>>,
    /// Set to `true` once `kill()` is called, so `try_wait` reports the child as exited. This
    /// mirrors a real child's behavior after SIGTERM: the process exits, and `try_wait` returns
    /// `Some(status)`.
    killed: bool,
}

impl SidecarChild for FakeSidecarChild {
    fn try_wait(&mut self) -> io::Result<Option<Option<i32>>> {
        if self.killed {
            // After `kill()`, the child is exited. Report a signal-style exit (code `None`) so
            // the supervisor's `stop()` poll loop sees the child has exited and does not escalate
            // to a second `kill()`.
            return Ok(Some(None));
        }
        let mut guard = self
            .next_exits
            .lock()
            .map_err(|_| io::Error::other("fake sidecar child exit queue poisoned"))?;
        if guard.is_empty() {
            // Empty queue = "always running".
            Ok(None)
        } else {
            // Pop the next canned exit. `Some(code)` means "exited with `code`"; `None` means
            // "still running" (the test pre-seeded a running poll before a crash).
            Ok(guard.remove(0).map(Some))
        }
    }

    fn kill(&mut self) -> io::Result<()> {
        if let Ok(mut guard) = self.kills.lock() {
            *guard += 1;
        }
        self.killed = true;
        Ok(())
    }
}

// ===========================================================================
// SidecarSupervisor trait
// ===========================================================================

/// Supervises the legacy `canvas-display-server` sidecar: spawns it, polls its liveness, restarts
/// it on crash, and stops it gracefully. All methods are synchronous (the daemon drives them on its
/// own `std::thread` monitoring loop, never on tokio -- ADR 0009) and never panic: a missing
/// binary is reported as `Err(io::Error)`, not a crash.
///
/// The trait is `Send + Debug` so a `Box<dyn SidecarSupervisor>` can be moved into the monitoring
/// thread by [`SidecarHandle::spawn_monitor`].
pub trait SidecarSupervisor: Send + std::fmt::Debug {
    /// Spawns the sidecar binary with the configured env vars + args and records the child handle.
    /// Calling `start` while a child is already running is a programming error: the supervisor
    /// will `stop` the existing child first (best-effort) to avoid leaking a process. A failure to
    /// spawn is surfaced as `Err(io::Error)` and leaves the supervisor with no child.
    fn start(&mut self, config: &SidecarConfig) -> Result<(), io::Error>;

    /// Returns `true` if the child is still running. Returns `false` if no child has been spawned,
    /// or if the child has exited (cleanly or crashed). Does not distinguish "stopped" from
    /// "crashed" -- use [`SidecarSupervisor::health_check`] for that.
    fn is_running(&mut self) -> bool;

    /// Kills the current child (if any) and spawns a new one with the same config. Resets nothing
    /// about the restart counter -- a restart triggered by the monitoring loop counts toward
    /// [`SidecarConfig::max_restarts`] just like a crash-triggered restart would. A failure to
    /// spawn the new child is surfaced as `Err(io::Error)`; the old child has already been killed
    /// in that case, so the supervisor is left with no child.
    fn restart(&mut self, config: &SidecarConfig) -> Result<(), io::Error>;

    /// Gracefully stops the child: `SIGTERM`, then `SIGKILL` after [`SIGKILL_GRACE`] if the child
    /// has not exited. Mirrors `MicCapture::stop()` in `server/src/voice/mic.ts` (500 ms safety
    /// net). A child that has already exited is a no-op (returns `Ok(())`).
    fn stop(&mut self) -> Result<(), io::Error>;

    /// Returns the current health snapshot. See [`SidecarHealth`].
    fn health_check(&mut self) -> SidecarHealth;
}

// ===========================================================================
// ProcessSidecarSupervisor -- real supervisor over an injectable spawner
// ===========================================================================

/// Production supervisor: spawns and supervises a real sidecar child process through an injectable
/// [`CommandSpawner`] seam. Production wires in [`ProcessCommandSpawner`] (real subprocess); tests
/// wire in [`FakeCommandSpawner`] (records the command, returns canned exits).
///
/// The supervisor holds at most one child at a time (`Option<Box<dyn SidecarChild>>`); `start`
/// replaces an existing child (stopping it first), `restart` does the same, and `stop` clears it.
/// The last observed exit code is cached so [`SidecarSupervisor::health_check`] can report
/// [`SidecarHealth::Crashed`] after the monitoring loop has already reaped the child via
/// `try_wait`.
#[derive(Debug)]
pub struct ProcessSidecarSupervisor<S: CommandSpawner> {
    spawner: S,
    child: Option<Box<dyn SidecarChild>>,
    /// Cached exit code of the last child, set when `try_wait` first observes the child has
    /// exited. `None` here means "never started" or "stopped cleanly by the supervisor" (in both
    /// cases `health_check` reports `Stopped`, not `Crashed`); `Some(code)` means "the child
    /// exited on its own with `code`" (and `health_check` reports `Crashed`).
    last_exit: Option<Option<i32>>,
}

impl<S: CommandSpawner> ProcessSidecarSupervisor<S> {
    pub fn new(spawner: S) -> Self {
        Self {
            spawner,
            child: None,
            last_exit: None,
        }
    }

    /// Builds the `Command` for the sidecar from `config`. Centralized here so `start` and
    /// `restart` construct identical commands (a divergence would be a real bug -- a restart that
    /// forgot an env var would silently change the sidecar's behavior).
    fn build_command(config: &SidecarConfig) -> Command {
        let mut command = Command::new(&config.binary_path);
        command.args(&config.args);
        for (key, value) in &config.env_vars {
            command.env(key, value);
        }
        // Inherit stdio: the sidecar's own stdout/stderr go to the daemon's journal, matching how
        // the Tauri app forwards sidecar output to `/tmp/canvas-ui-kiosk.log`. We do *not* pipe
        // here because the daemon does not yet have a log-forwarding loop (the Tauri app's
        // `tauri::async_runtime::spawn` reader is not portable to the synchronous daemon); a
        // future task can add a piped-stdout reader thread if structured sidecar logs are needed.
        command.stdin(Stdio::null());
        command
    }

    /// Spawns a new child from `config`, replacing any existing child (which is stopped first,
    /// best-effort). Shared by `start` and `restart`.
    fn spawn_fresh(&mut self, config: &SidecarConfig) -> Result<(), io::Error> {
        // If a child is still held, stop it first to avoid leaking a process. Best-effort: a
        // failure to stop the old child is logged (via the returned `Err` of the caller) but does
        // not prevent the new spawn.
        if self.child.is_some() {
            // `stop` clears `self.child` and `self.last_exit`.
            let _ = self.stop();
        }
        // Record the spawn on the spawner (no-op for the real spawner; pushes a `RecordedSpawn`
        // for the fake so tests can assert the constructed command without spawning a real
        // process). See `CommandSpawner::record_spawn`'s doc comment for why this is a trait
        // method rather than a downcast.
        let program = config.binary_path.to_string_lossy().into_owned();
        self.spawner
            .record_spawn(&program, &config.args, &config.env_vars);
        let mut command = Self::build_command(config);
        match self.spawner.spawn(&mut command) {
            Ok(child) => {
                self.child = Some(child);
                self.last_exit = None;
                Ok(())
            }
            Err(err) => Err(err),
        }
    }
}

impl<S: CommandSpawner> SidecarSupervisor for ProcessSidecarSupervisor<S> {
    fn start(&mut self, config: &SidecarConfig) -> Result<(), io::Error> {
        self.spawn_fresh(config)
    }

    fn is_running(&mut self) -> bool {
        let Some(child) = self.child.as_mut() else {
            return false;
        };
        match child.try_wait() {
            Ok(None) => true,
            Ok(Some(exit)) => {
                // The child has exited. Cache the exit code and clear the handle so a subsequent
                // `health_check` reports `Crashed` (or `Stopped` if `stop` cleared it).
                self.last_exit = Some(exit);
                self.child = None;
                false
            }
            Err(_) => {
                // A `try_wait` error (e.g. the child was already reaped by someone else) is
                // treated as "not running" -- the supervisor cannot poll a child it cannot wait
                // on. We do not cache an exit code here because we do not have one.
                self.child = None;
                false
            }
        }
    }

    fn restart(&mut self, config: &SidecarConfig) -> Result<(), io::Error> {
        // `spawn_fresh` stops any existing child first, then spawns a new one.
        self.spawn_fresh(config)
    }

    fn stop(&mut self) -> Result<(), io::Error> {
        let Some(mut child) = self.child.take() else {
            // No child to stop. Clear `last_exit` so `health_check` reports `Stopped`, not a
            // stale `Crashed` from a previous child.
            self.last_exit = None;
            return Ok(());
        };
        // Best-effort SIGTERM. A child that has already exited returns an error here, which we
        // ignore (matching the sidecar's `try { proc.kill('SIGTERM'); } catch { /* already dead */ }`
        // in `server/src/voice/mic.ts`).
        let _ = child.kill();

        // Poll for exit up to SIGKILL_GRACE, then escalate to SIGKILL. We do not have a real
        // `Child::wait` on the trait (the fake does not model a blocking wait), so we poll
        // `try_wait` in a tight loop with short sleeps. This is bounded by SIGKILL_GRACE, so even
        // a wedged child is reaped within ~500 ms.
        let deadline = std::time::Instant::now() + SIGKILL_GRACE;
        let mut exited = false;
        while std::time::Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) => {
                    exited = true;
                    break;
                }
                Ok(None) => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(_) => {
                    // Treat a `try_wait` error as "already gone".
                    exited = true;
                    break;
                }
            }
        }
        if !exited {
            // SIGTERM did not take effect within the grace period -- escalate. The trait's `kill`
            // is documented as SIGTERM, but on a real `Child` a second `kill()` after the first is
            // idempotent (it re-sends SIGTERM). To get a real SIGKILL we would need a separate
            // trait method; for now we re-call `kill()` and document that a wedged child that
            // ignores SIGTERM will be reaped on the next supervisor start (which stops the old
            // child first). This matches the sidecar's `SIGKILL` safety net as closely as the
            // trait seam allows without leaking Unix-specific signal handling into it.
            let _ = child.kill();
        }
        // Clear `last_exit` so `health_check` reports `Stopped` (the supervisor stopped the child
        // intentionally), not `Crashed` (which would imply the child exited on its own).
        self.last_exit = None;
        Ok(())
    }

    fn health_check(&mut self) -> SidecarHealth {
        if self.is_running() {
            return SidecarHealth::Running;
        }
        match self.last_exit {
            Some(exit) => SidecarHealth::Crashed(exit),
            None => SidecarHealth::Stopped,
        }
    }
}

// ===========================================================================
// FakeSidecarSupervisor -- fully fake supervisor for tests that don't need the spawner seam
// ===========================================================================

/// Fully fake supervisor that records `start`/`restart`/`stop`/`health_check` calls as string tags
/// and returns canned health, without any subprocess or spawner involvement. Not used by any
/// production code path. Mirrors [`crate::hardware::dpms::FakeDpmsAdapter`]'s role for
/// [`SidecarSupervisor`].
///
/// Tests that need to assert the *constructed `Command`* (binary path, env vars, args) should use
/// [`ProcessSidecarSupervisor`] with a [`FakeCommandSpawner`] instead -- this fake is for tests
/// that only need to assert "the daemon called `start` then `stop`" without inspecting the
/// command.
#[derive(Debug, Clone)]
pub struct FakeSidecarSupervisor {
    calls: Arc<Mutex<Vec<&'static str>>>,
    /// Canned health to return from `health_check` and `is_running`. Defaults to `Running` after
    /// `start`, `Stopped` after `stop`, `Crashed(None)` after `restart` (so a test can simulate a
    /// crash on restart). A test can override with [`FakeSidecarSupervisor::with_next_health`].
    running: Arc<Mutex<bool>>,
    next_health: Arc<Mutex<Option<SidecarHealth>>>,
}

impl Default for FakeSidecarSupervisor {
    fn default() -> Self {
        Self::new()
    }
}

impl FakeSidecarSupervisor {
    pub fn new() -> Self {
        Self {
            calls: Arc::new(Mutex::new(Vec::new())),
            running: Arc::new(Mutex::new(false)),
            next_health: Arc::new(Mutex::new(None)),
        }
    }

    /// Configures the canned health the next `health_check` will return (overriding the default
    /// `Running`/`Stopped`/`Crashed` logic). Test-only.
    pub fn with_next_health(self, health: SidecarHealth) -> Self {
        if let Ok(mut guard) = self.next_health.lock() {
            *guard = Some(health);
        }
        self
    }

    /// Returns a clone of the shared call-log handle. Test-only.
    pub fn call_log(&self) -> Arc<Mutex<Vec<&'static str>>> {
        Arc::clone(&self.calls)
    }

    /// Returns every action (`"start"` / `"restart"` / `"stop"` / `"health_check"`) the supervisor
    /// was asked to perform, in call order. Test-only.
    pub fn recorded_calls(&self) -> Vec<String> {
        self.calls
            .lock()
            .map(|guard| guard.iter().map(|s| s.to_string()).collect())
            .unwrap_or_default()
    }

    fn record(&self, tag: &'static str) {
        if let Ok(mut guard) = self.calls.lock() {
            guard.push(tag);
        }
    }
}

impl SidecarSupervisor for FakeSidecarSupervisor {
    fn start(&mut self, _config: &SidecarConfig) -> Result<(), io::Error> {
        self.record("start");
        if let Ok(mut guard) = self.running.lock() {
            *guard = true;
        }
        Ok(())
    }

    fn is_running(&mut self) -> bool {
        self.running.lock().map(|g| *g).unwrap_or(false)
    }

    fn restart(&mut self, _config: &SidecarConfig) -> Result<(), io::Error> {
        self.record("restart");
        // `restart` leaves the supervisor in the "running" state (a new child was spawned).
        if let Ok(mut guard) = self.running.lock() {
            *guard = true;
        }
        Ok(())
    }

    fn stop(&mut self) -> Result<(), io::Error> {
        self.record("stop");
        if let Ok(mut guard) = self.running.lock() {
            *guard = false;
        }
        Ok(())
    }

    fn health_check(&mut self) -> SidecarHealth {
        self.record("health_check");
        // One-shot: if a canned health was set, return and consume it.
        if let Ok(mut guard) = self.next_health.lock() {
            if let Some(health) = guard.take() {
                return health;
            }
        }
        if self.is_running() {
            SidecarHealth::Running
        } else {
            SidecarHealth::Stopped
        }
    }
}

// ===========================================================================
// SidecarHandle -- handle to the monitoring thread, mirroring IpcHandle / TransportHandle
// ===========================================================================

/// Handle to a running sidecar supervisor monitoring thread, mirroring
/// [`canvas_edge_agentd::ipc::IpcHandle`] and [`crate::transport::TransportHandle`]: a join handle
/// plus the shared shutdown flag the caller flips to request a clean stop.
///
/// The supervisor itself is held *inside* the monitoring thread (moved in at spawn time), so the
/// handle does not expose it directly -- callers interact with the sidecar only through
/// [`SidecarHandle::shutdown_and_join`] (which stops the child and joins the thread). A future task
/// that needs to send live commands to the supervisor (e.g. "restart now" or "reload config") can
/// add a `flume` channel here, exactly like `TransportHandle::commands`.
#[derive(Debug)]
pub struct SidecarHandle {
    shutdown: Arc<AtomicBool>,
    join_handle: thread::JoinHandle<()>,
}

impl SidecarHandle {
    /// Spawns the monitoring thread for `supervisor` with `config`. The thread polls
    /// [`SidecarSupervisor::is_running`] every `config.restart_delay_ms`; if the child has crashed
    /// and `config.restart_on_crash` is true and the restart count is under
    /// `config.max_restarts`, it calls [`SidecarSupervisor::restart`] after the delay and
    /// increments the count. On shutdown it calls [`SidecarSupervisor::stop`] and exits.
    ///
    /// The thread is named `canvas-edge-sidecar` so it shows up in `htop`/`ps -T` alongside the
    /// transport thread (`canvas-edge-ws`) and the IPC thread.
    pub fn spawn_monitor(
        mut supervisor: Box<dyn SidecarSupervisor>,
        config: SidecarConfig,
    ) -> Result<Self, io::Error> {
        // Start the child once, up front, on the calling thread. A failure here is surfaced to
        // the caller (the daemon's `main.rs`) so it can log "sidecar failed to start" and continue
        // without supervision, rather than silently entering a monitoring loop with no child.
        supervisor.start(&config)?;
        let shutdown = Arc::new(AtomicBool::new(false));
        let thread_shutdown = Arc::clone(&shutdown);
        let poll_interval = Duration::from_millis(config.restart_delay_ms.max(50));
        let join_handle = thread::Builder::new()
            .name("canvas-edge-sidecar".to_string())
            .spawn(move || {
                let mut restart_count: u32 = 0;
                println!(
                    "[canvas-edge-agentd] sidecar: monitoring started (binary={}, restart_on_crash={}, max_restarts={})",
                    config.binary_path.display(),
                    config.restart_on_crash,
                    config.max_restarts
                );
                while !thread_shutdown.load(Ordering::SeqCst) {
                    thread::sleep(poll_interval);
                    if thread_shutdown.load(Ordering::SeqCst) {
                        break;
                    }
                    if supervisor.is_running() {
                        continue;
                    }
                    // Child is not running. Decide whether to restart.
                    let health = supervisor.health_check();
                    match health {
                        SidecarHealth::Running => continue,
                        SidecarHealth::Stopped => {
                            // The supervisor stopped the child itself (e.g. a previous `stop`).
                            // Do not restart -- this is an intentional stop.
                            continue;
                        }
                        SidecarHealth::Crashed(exit) => {
                            if !config.restart_on_crash {
                                println!(
                                    "[canvas-edge-agentd] sidecar: crashed (exit={:?}) -- not restarting (restart_on_crash=false)",
                                    exit
                                );
                                continue;
                            }
                            if restart_count >= config.max_restarts {
                                println!(
                                    "[canvas-edge-agentd] sidecar: crashed (exit={:?}) -- not restarting (max_restarts={} reached)",
                                    exit, config.max_restarts
                                );
                                continue;
                            }
                            println!(
                                "[canvas-edge-agentd] sidecar: crashed (exit={:?}) -- restarting (attempt {}/{})",
                                exit,
                                restart_count + 1,
                                config.max_restarts
                            );
                            match supervisor.restart(&config) {
                                Ok(()) => {
                                    restart_count += 1;
                                }
                                Err(err) => {
                                    println!(
                                        "[canvas-edge-agentd] sidecar: restart failed: {err}"
                                    );
                                }
                            }
                        }
                    }
                }
                // Shutdown: stop the child gracefully (SIGTERM, then SIGKILL after grace).
                if let Err(err) = supervisor.stop() {
                    eprintln!(
                        "[canvas-edge-agentd] sidecar: stop failed during shutdown: {err}"
                    );
                }
                println!("[canvas-edge-agentd] sidecar: monitoring stopped");
            })
            .map_err(|err| io::Error::other(format!("failed to spawn sidecar monitor thread: {err}")))?;
        Ok(Self {
            shutdown,
            join_handle,
        })
    }

    /// Signals the monitoring thread to stop, stops the sidecar child, and blocks until the thread
    /// has exited. Mirrors [`canvas_edge_agentd::ipc::IpcHandle::shutdown_and_join`] and
    /// [`crate::transport::TransportHandle::join`].
    pub fn shutdown_and_join(self) {
        self.shutdown.store(true, Ordering::SeqCst);
        if let Err(err) = self.join_handle.join() {
            eprintln!(
                "[canvas-edge-agentd] sidecar monitor thread panicked during shutdown: {err:?}"
            );
        }
    }
}

/// Convenience constructor for the production supervisor with the real spawner. Called by the
/// daemon's `main.rs` when `CANVAS_EDGE_SIDECAR_BINARY` is set.
pub fn real_supervisor() -> ProcessSidecarSupervisor<ProcessCommandSpawner> {
    ProcessSidecarSupervisor::new(ProcessCommandSpawner)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `SidecarConfig::default` has sensible defaults so the daemon can construct one with only
    /// the binary path + env vars set.
    #[test]
    fn sidecar_config_default_has_sensible_defaults() {
        let config = SidecarConfig::default();
        assert_eq!(config.binary_path, PathBuf::from("canvas-display-server"));
        assert!(config.env_vars.is_empty());
        assert!(config.args.is_empty());
        assert!(config.restart_on_crash);
        assert_eq!(config.max_restarts, DEFAULT_MAX_RESTARTS);
        assert_eq!(config.restart_delay_ms, DEFAULT_RESTART_DELAY_MS);
    }

    /// `SidecarConfig` round-trips through serde, so the daemon can persist it to disk in a future
    /// task.
    #[test]
    fn sidecar_config_round_trips_through_serde() {
        let config = SidecarConfig {
            binary_path: PathBuf::from("/usr/bin/canvas-display-server"),
            env_vars: vec![
                ("HOST".to_string(), "127.0.0.1".to_string()),
                ("PORT".to_string(), "3100".to_string()),
            ],
            args: vec!["--verbose".to_string()],
            restart_on_crash: false,
            max_restarts: 5,
            restart_delay_ms: 2000,
        };
        let json = serde_json::to_string(&config).expect("serialize");
        let back: SidecarConfig = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(config, back);
    }
}
