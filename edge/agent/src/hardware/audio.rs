//! Real, typed audio playback + system volume control adapters, replacing the Node/Fastify
//! sidecar's `mpv` supervision and `pactl` volume control with Rust adapters the daemon drives on
//! its own IPC thread (ADR 0009: the daemon stays synchronous; these adapters never touch tokio).
//!
//! This is the second Phase 3 extraction (after `brightness`/`dpms`): the architecture plan's
//! Phase 3 checklist calls for "Move `mpv`/GStreamer supervision and audio focus into Edge media
//! adapters." Today the kiosk renderer reaches audio control through the sidecar's
//! `server/src/routes/audio.ts` HTTP routes, which shell out to `mpv` (playback) and `pactl`
//! (PulseAudio/PipeWire-pulse system volume). The adapters here replace those two paths with direct
//! Rust:
//!
//! - [`VolumeAdapter`] / [`PactlVolumeAdapter`]: drives `pactl get-sink-volume` /
//!   `set-sink-volume` / `set-sink-mute` against `@DEFAULT_SINK@` through an injectable
//!   [`VolumeCommandRunner`] seam, mirroring the [`super::dpms::CommandRunner`] pattern. The real
//!   runner spawns `pactl`; the fake runner records the command and returns a canned stdout +
//!   status, so tests can assert "the adapter constructed `pactl set-sink-volume @DEFAULT_SINK@
//!   75%`" without spawning a real `pactl`.
//! - [`PlaybackAdapter`] / [`MpvPlaybackAdapter`]: supervises a single `mpv` child process for
//!   audio-only playback, controlling it through mpv's JSON IPC over a Unix domain socket. The
//!   `mpv` spawn is behind an injectable [`MpvSpawner`] seam (the real spawner calls
//!   [`std::process::Command::spawn`]; the fake spawner records the binary + args without spawning
//!   a real process), and the IPC socket path is injectable so tests can point it at a `tempfile`
//!   tempdir path and exercise the real [`std::os::unix::net::UnixStream`] JSON client against a
//!   fake server thread without ever spawning a real `mpv`.
//!
//! Both modules follow the injectable-dependency-for-testability convention already used by
//! [`super::brightness`] and [`super::dpms`]: production code gets a real implementation that
//! touches the real OS, and tests get a fake/injectable one that returns canned results, so the
//! test suite in `edge/agent/tests/audio_v1.rs` never spawns a real `mpv` or `pactl` and never
//! mutates the actual machine's audio state.
//!
//! **Honest scope note (mic capture):** the sidecar's `parec`/`arecord` microphone capture path is
//! *not* implemented here. Mic capture is a streaming concern (continuous sample delivery to a
//! consumer), not a command/response one, and is explicitly deferred to Phase 5. This module covers
//! playback + volume only, matching the Phase 3 checklist item as scoped.
//!
//! **Honest scope note ([`VolumeAdapter::is_muted`]):** parsing `pactl get-sink-mute
//! @DEFAULT_SINK@` is best-effort. PulseAudio's output format is `Mute: yes|no` (one line among
//! several), but PipeWire-pulse and locale settings can shift the wording; the kiosk use case only
//! needs *setting* mute (not polling it). The real adapter parses `Mute:\s*(yes|no)` and falls back
//! to `Ok(false)` if the line is absent or unparseable, and documents the limitation. A future task
//! that needs reliable mute polling can replace it with a PulseAudio DBus / `pactl list`
//! properties probe.

use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::brightness::AdapterError;

/// Default mpv JSON IPC socket path, matching the sidecar's `MPV_SOCK` in
/// `server/src/routes/audio.ts`.
pub const DEFAULT_MPV_SOCKET_PATH: &str = "/tmp/mpv-canvas.sock";

/// Default `mpv` binary name (resolved through `PATH`). Production can override via
/// [`MpvPlaybackAdapter::with_mpv_binary`].
pub const DEFAULT_MPV_BINARY: &str = "mpv";

/// How long the mpv IPC client waits for a connect/write/read before giving up. Matches the
/// sidecar's 1000 ms timeout in `mpvIpc()`.
const MPV_IPC_TIMEOUT: Duration = Duration::from_millis(1000);

// ===========================================================================
// VolumeAdapter -- system volume via `pactl`
// ===========================================================================

/// Runs an external command and returns its stdout. The real implementation
/// ([`ProcessVolumeRunner`]) spawns the subprocess via [`Command::output`]; the fake
/// ([`FakeVolumeRunner`]) records the command and returns a canned stdout + success flag, so tests
/// can assert "the adapter constructed `pactl get-sink-volume @DEFAULT_SINK@`" and feed a canned
/// `Volume: front-left: 49152 /  75% / -7.97 dB, ...` line back without spawning a real `pactl`.
///
/// This is a separate trait from [`super::dpms::CommandRunner`] because volume control needs the
/// subprocess *stdout* (to parse the current volume), whereas DPMS only needs the exit status.
/// Keeping the two seams distinct avoids forcing the DPMS runner to capture stdout it never uses.
pub trait VolumeCommandRunner: Send + std::fmt::Debug {
    /// Runs `program` with `args` and returns the captured stdout on success. A failure to spawn
    /// (e.g. `pactl` not on `PATH`) is reported as `Err(AdapterError::Io(...))`. A non-zero exit
    /// is reported as `Err(AdapterError::Io(...))` with a descriptive message, matching how
    /// [`super::dpms::XsetDpmsAdapter`] surfaces a non-zero `xset` exit.
    fn run(&self, program: &str, args: &[&str]) -> Result<String, AdapterError>;
}

/// Production runner: spawns the real subprocess via [`Command::output`] and returns its stdout.
#[derive(Debug, Default, Clone, Copy)]
pub struct ProcessVolumeRunner;

impl VolumeCommandRunner for ProcessVolumeRunner {
    fn run(&self, program: &str, args: &[&str]) -> Result<String, AdapterError> {
        let output = Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()?;
        if !output.status.success() {
            return Err(AdapterError::Io(io::Error::other(format!(
                "{program} exited non-zero (status={})",
                output.status
            ))));
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }
}

/// One recorded volume command invocation, for tests that assert the adapter constructed the right
/// `pactl` invocation without spawning a real subprocess.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedVolumeCommand {
    pub program: String,
    pub args: Vec<String>,
}

/// Test-only runner that records every command it would have run and returns a canned stdout.
/// Not used by any production code path.
///
/// The call log is held behind a shared `Arc<Mutex<...>>` so a test can retain a handle via
/// [`FakeVolumeRunner::call_log`] and inspect the recorded commands after the runner has been moved
/// into an adapter (and from there into the daemon's IPC handler thread).
#[derive(Debug, Clone)]
pub struct FakeVolumeRunner {
    calls: Arc<Mutex<Vec<RecordedVolumeCommand>>>,
    /// The canned stdout returned by the next `run` call. Defaults to a typical
    /// `pactl get-sink-volume @DEFAULT_SINK@` line at 75%, so a bare `FakeVolumeRunner::new()`
    /// works for the common "get_volume returns a value" test without further setup.
    next_stdout: String,
    /// The canned success flag. `false` makes the next `run` return a non-zero-exit error.
    next_success: bool,
}

impl Default for FakeVolumeRunner {
    fn default() -> Self {
        Self::new()
    }
}

impl FakeVolumeRunner {
    pub fn new() -> Self {
        Self {
            calls: Arc::new(Mutex::new(Vec::new())),
            // A realistic `pactl get-sink-volume @DEFAULT_SINK@` line at 75%, so the default
            // fake runner works for the common get_volume test without further setup.
            next_stdout: "Volume: front-left: 49152 /  75% / -7.97 dB,   front-right: 49152 /  \
                          75% / -7.97 dB\n"
                .to_string(),
            next_success: true,
        }
    }

    /// Configures the canned stdout returned by the next (and all subsequent) `run` calls.
    pub fn with_stdout(mut self, stdout: impl Into<String>) -> Self {
        self.next_stdout = stdout.into();
        self
    }

    /// Configures the canned success flag. `false` makes the next `run` return a non-zero-exit
    /// error.
    pub fn with_success(mut self, success: bool) -> Self {
        self.next_success = success;
        self
    }

    /// Returns a clone of the shared call log handle, so a test can inspect the recorded commands
    /// after this runner has been moved into an adapter. Test-only.
    pub fn call_log(&self) -> Arc<Mutex<Vec<RecordedVolumeCommand>>> {
        Arc::clone(&self.calls)
    }

    /// Returns every command the runner was asked to run, in call order. Test-only.
    pub fn recorded_commands(&self) -> Vec<RecordedVolumeCommand> {
        self.calls
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }
}

impl VolumeCommandRunner for FakeVolumeRunner {
    fn run(&self, program: &str, args: &[&str]) -> Result<String, AdapterError> {
        if let Ok(mut guard) = self.calls.lock() {
            guard.push(RecordedVolumeCommand {
                program: program.to_string(),
                args: args.iter().map(|s| s.to_string()).collect(),
            });
        }
        if !self.next_success {
            return Err(AdapterError::Io(io::Error::other(format!(
                "{program} exited non-zero (fake)"
            ))));
        }
        Ok(self.next_stdout.clone())
    }
}

/// Controls system output volume through PulseAudio/PipeWire-pulse (`pactl`).
///
/// All methods are synchronous (the daemon drives them on its IPC thread, never on tokio -- ADR
/// 0009) and never panic: a missing `pactl` binary is reported as [`AdapterError::Io`], not a
/// crash.
pub trait VolumeAdapter: Send + std::fmt::Debug {
    /// Returns the current system volume level (0–100).
    fn get_volume(&self) -> Result<u8, AdapterError>;

    /// Sets the system volume level. Implementations should clamp `level` to `0..=100` before
    /// invoking `pactl set-sink-volume`.
    fn set_volume(&self, level: u8) -> Result<(), AdapterError>;

    /// Mutes or unmutes the default sink.
    fn set_mute(&self, muted: bool) -> Result<(), AdapterError>;

    /// Best-effort query of whether the default sink is currently muted. See the module docs for
    /// why the real adapter falls back to `Ok(false)` when the `pactl get-sink-mute` output cannot
    /// be parsed.
    fn is_muted(&self) -> Result<bool, AdapterError>;
}

/// Production adapter: drives `pactl ... @DEFAULT_SINK@ ...` through an injectable
/// [`VolumeCommandRunner`].
///
/// The `VolumeCommandRunner` seam is what makes this adapter testable without spawning a real
/// `pactl`: production wires in [`ProcessVolumeRunner`] (real subprocess), tests wire in
/// [`FakeVolumeRunner`] (records the command and returns a canned stdout).
#[derive(Debug)]
pub struct PactlVolumeAdapter<R: VolumeCommandRunner> {
    runner: R,
}

impl<R: VolumeCommandRunner> PactlVolumeAdapter<R> {
    pub fn new(runner: R) -> Self {
        Self { runner }
    }

    /// Parses the first `N%` percentage out of `pactl get-sink-volume` output. The sidecar's regex
    /// is `/\s*(\d+)%/` applied to the whole output; this mirrors it by scanning for the first
    /// `<digits>%` substring. Returns `Ok(level)` clamped to `0..=100`, or
    /// [`AdapterError::Io`] if no percentage is present (the sink is in an unexpected state).
    fn parse_volume(output: &str) -> Result<u8, AdapterError> {
        // Find the first `<digits>%` in the output. The sidecar's regex `/\s*(\d+)%/` matches the
        // same thing; we walk byte-by-byte to avoid pulling in a regex crate for one pattern.
        let bytes = output.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i].is_ascii_digit() {
                let start = i;
                while i < bytes.len() && bytes[i].is_ascii_digit() {
                    i += 1;
                }
                if i < bytes.len() && bytes[i] == b'%' {
                    let parsed = &output[start..i];
                    let value: u32 = parsed.parse().map_err(|source| {
                        AdapterError::Io(io::Error::other(format!(
                            "pactl volume percentage '{parsed}' did not parse: {source}"
                        )))
                    })?;
                    return Ok(value.clamp(0, 100) as u8);
                }
            } else {
                i += 1;
            }
        }
        Err(AdapterError::Io(io::Error::other(
            "pactl get-sink-volume output contained no percentage",
        )))
    }

    /// Parses `Mute: yes|no` out of `pactl get-sink-mute` output. Returns `Ok(false)` if the line
    /// is absent or unparseable -- see the module docs for why this is best-effort.
    fn parse_mute(output: &str) -> bool {
        for line in output.lines() {
            let trimmed = line.trim();
            let Some(rest) = trimmed.strip_prefix("Mute:") else {
                continue;
            };
            let value = rest.trim().to_ascii_lowercase();
            return value == "yes" || value == "true" || value == "1";
        }
        false
    }
}

impl<R: VolumeCommandRunner> VolumeAdapter for PactlVolumeAdapter<R> {
    fn get_volume(&self) -> Result<u8, AdapterError> {
        let output = self
            .runner
            .run("pactl", &["get-sink-volume", "@DEFAULT_SINK@"])?;
        Self::parse_volume(&output)
    }

    fn set_volume(&self, level: u8) -> Result<(), AdapterError> {
        let clamped = level.clamp(0, 100);
        let arg = format!("{clamped}%");
        self.runner
            .run("pactl", &["set-sink-volume", "@DEFAULT_SINK@", &arg])?;
        Ok(())
    }

    fn set_mute(&self, muted: bool) -> Result<(), AdapterError> {
        let flag = if muted { "1" } else { "0" };
        self.runner
            .run("pactl", &["set-sink-mute", "@DEFAULT_SINK@", flag])?;
        Ok(())
    }

    fn is_muted(&self) -> Result<bool, AdapterError> {
        // Best-effort: see module docs. If `pactl get-sink-mute` fails or its output is
        // unparseable, report `false` rather than erroring -- the kiosk use case only needs
        // *setting* mute, not polling it, and a transient `pactl` failure should not break a
        // state poll.
        match self
            .runner
            .run("pactl", &["get-sink-mute", "@DEFAULT_SINK@"])
        {
            Ok(output) => Ok(Self::parse_mute(&output)),
            Err(_) => Ok(false),
        }
    }
}

/// Test-only adapter that records `set_volume`/`set_mute` calls and returns canned values for
/// `get_volume`/`is_muted`, without any subprocess involvement. Not used by any production code
/// path. Mirrors [`super::brightness::FakeBrightnessAdapter`]'s role for [`BrightnessAdapter`].
///
/// The call log is held behind a shared `Arc<Mutex<...>>` so a test can retain a handle via
/// [`FakeVolumeAdapter::call_log`] and inspect the recorded calls after the adapter has been boxed
/// and moved into the daemon's IPC handler thread.
#[derive(Debug, Clone)]
pub struct FakeVolumeAdapter {
    current: u8,
    muted: bool,
    calls: Arc<Mutex<Vec<String>>>,
    next_error: Option<&'static str>,
}

impl Default for FakeVolumeAdapter {
    fn default() -> Self {
        Self::new(75, false)
    }
}

impl FakeVolumeAdapter {
    pub fn new(current: u8, muted: bool) -> Self {
        Self {
            current,
            muted,
            calls: Arc::new(Mutex::new(Vec::new())),
            next_error: None,
        }
    }

    /// Configures the adapter to fail the next mutating call (`set_volume`/`set_mute`) with a
    /// canned I/O error carrying the given message. Test-only.
    pub fn with_next_error(mut self, message: &'static str) -> Self {
        self.next_error = Some(message);
        self
    }

    /// Returns a clone of the shared call log handle, so a test can inspect the recorded calls
    /// after this adapter has been boxed and moved into the daemon's IPC handler. Test-only.
    pub fn call_log(&self) -> Arc<Mutex<Vec<String>>> {
        Arc::clone(&self.calls)
    }

    /// Returns every action the adapter was asked to perform (e.g. `"set_volume:75"`,
    /// `"set_mute:true"`), in call order. Test-only.
    pub fn recorded_calls(&self) -> Vec<String> {
        self.calls
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    fn record(&self, tag: String) -> Result<(), AdapterError> {
        if let Ok(mut guard) = self.calls.lock() {
            guard.push(tag);
        }
        if let Some(message) = self.next_error {
            return Err(AdapterError::Io(io::Error::other(message)));
        }
        Ok(())
    }
}

impl VolumeAdapter for FakeVolumeAdapter {
    fn get_volume(&self) -> Result<u8, AdapterError> {
        Ok(self.current)
    }

    fn set_volume(&self, level: u8) -> Result<(), AdapterError> {
        let clamped = level.clamp(0, 100);
        self.record(format!("set_volume:{clamped}"))
    }

    fn set_mute(&self, muted: bool) -> Result<(), AdapterError> {
        self.record(format!("set_mute:{muted}"))
    }

    fn is_muted(&self) -> Result<bool, AdapterError> {
        Ok(self.muted)
    }
}

// ===========================================================================
// PlaybackAdapter -- mpv supervision + JSON IPC
// ===========================================================================

/// The playback state the adapter tracks in-memory, mirroring the sidecar's `AudioPlayState`.
///
/// This is what the *adapter* last requested, not a parse of mpv's IPC state -- matching the
/// sidecar's `_state.state` field, which it updates on each play/pause/resume/stop call rather than
/// polling mpv. A future task that needs real end-of-stream detection can wire mpv's `idle`/`eof`
/// events back into this state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaybackState {
    /// No `mpv` process is running.
    Idle,
    /// `mpv` is running and not paused.
    Playing,
    /// `mpv` is running and paused.
    Paused,
}

impl PlaybackState {
    pub fn as_str(self) -> &'static str {
        match self {
            PlaybackState::Idle => "idle",
            PlaybackState::Playing => "playing",
            PlaybackState::Paused => "paused",
        }
    }
}

/// A snapshot of the playback adapter's in-memory state, returned by [`PlaybackAdapter::state`]
/// and surfaced over IPC as the `audio.state` result. Mirrors the sidecar's `AudioState` (minus
/// `title`, which the sidecar derives from the request URL and which the daemon does not need to
/// re-derive here -- the caller already knows what it asked to play).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaybackSnapshot {
    pub state: PlaybackState,
    /// The URL currently playing, or `""` when idle.
    pub url: String,
    /// The last volume level passed to `play` or `set_volume` (0–100).
    pub volume: u8,
}

/// Spawns the `mpv` child process. The real implementation ([`ProcessMpvSpawner`]) calls
/// [`Command::spawn`]; the fake ([`FakeMpvSpawner`]) records the binary + args and returns a
/// canned [`FakeMpvChild`] without spawning a real process, so tests can assert "the adapter
/// constructed `mpv --no-video --really-quiet --input-ipc-server=<sock> --volume=75 <url>`"
/// without spawning a real `mpv`.
///
/// The spawn seam returns a boxed [`MpvChild`] trait object so the adapter can hold the child
/// process without knowing whether it is a real [`std::process::Child`] or a fake -- and so the
/// fake can be `Send` (a real `Child` is `Send`, but the trait object needs to be `Box<dyn
/// MpvChild + Send>` for the adapter to be `Send`).
pub trait MpvSpawner: Send + std::fmt::Debug {
    /// Spawns `program` with `args` and returns a handle that can be killed later. A failure to
    /// spawn (e.g. `mpv` not on `PATH`) is reported as `Err(AdapterError::Io(...))`.
    fn spawn(&self, program: &str, args: &[&str]) -> Result<Box<dyn MpvChild>, AdapterError>;
}

/// A handle to a spawned `mpv` process that can be killed. The real implementation wraps
/// [`std::process::Child`]; the fake records that `kill` was called.
pub trait MpvChild: Send + std::fmt::Debug {
    /// Sends `SIGTERM` to the child (best-effort; a child that has already exited is ignored).
    fn kill(&mut self);
}

/// Production spawner: spawns the real `mpv` subprocess via [`Command::spawn`].
#[derive(Debug, Default, Clone, Copy)]
pub struct ProcessMpvSpawner;

impl MpvSpawner for ProcessMpvSpawner {
    fn spawn(&self, program: &str, args: &[&str]) -> Result<Box<dyn MpvChild>, AdapterError> {
        let child = Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        Ok(Box::new(RealMpvChild { child }))
    }
}

/// Real [`MpvChild`] wrapping a [`std::process::Child`].
#[derive(Debug)]
struct RealMpvChild {
    child: Child,
}

impl MpvChild for RealMpvChild {
    fn kill(&mut self) {
        // Best-effort: a child that has already exited returns an error here, which we ignore
        // (matching the sidecar's `try { _mpv.kill('SIGTERM'); } catch { /* already dead */ }`).
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// One recorded `mpv` spawn, for tests that assert the adapter constructed the right `mpv`
/// invocation without spawning a real process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedSpawn {
    pub program: String,
    pub args: Vec<String>,
}

/// Test-only spawner that records every spawn it would have performed and returns a canned
/// [`FakeMpvChild`] without spawning a real process. Not used by any production code path.
#[derive(Debug, Clone)]
pub struct FakeMpvSpawner {
    spawns: Arc<Mutex<Vec<RecordedSpawn>>>,
    /// How many `kill` calls have been made on children this spawner produced. Tests assert this
    /// to prove `stop()`/`play()` (which kills the previous mpv) actually killed the old child.
    kills: Arc<Mutex<usize>>,
    next_spawn_error: Option<&'static str>,
}

impl Default for FakeMpvSpawner {
    fn default() -> Self {
        Self::new()
    }
}

impl FakeMpvSpawner {
    pub fn new() -> Self {
        Self {
            spawns: Arc::new(Mutex::new(Vec::new())),
            kills: Arc::new(Mutex::new(0)),
            next_spawn_error: None,
        }
    }

    /// Configures the next `spawn` call to fail with a canned I/O error carrying the given
    /// message. Test-only.
    pub fn with_next_spawn_error(mut self, message: &'static str) -> Self {
        self.next_spawn_error = Some(message);
        self
    }

    /// Returns a clone of the shared spawn-log handle, so a test can inspect the recorded spawns
    /// after this spawner has been moved into an adapter. Test-only.
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

impl MpvSpawner for FakeMpvSpawner {
    fn spawn(&self, program: &str, args: &[&str]) -> Result<Box<dyn MpvChild>, AdapterError> {
        if let Ok(mut guard) = self.spawns.lock() {
            guard.push(RecordedSpawn {
                program: program.to_string(),
                args: args.iter().map(|s| s.to_string()).collect(),
            });
        }
        if let Some(message) = self.next_spawn_error {
            return Err(AdapterError::Io(io::Error::other(message)));
        }
        Ok(Box::new(FakeMpvChild {
            kills: Arc::clone(&self.kills),
        }))
    }
}

/// Fake [`MpvChild`] that increments the spawner's shared kill counter.
#[derive(Debug)]
struct FakeMpvChild {
    kills: Arc<Mutex<usize>>,
}

impl MpvChild for FakeMpvChild {
    fn kill(&mut self) {
        if let Ok(mut guard) = self.kills.lock() {
            *guard += 1;
        }
    }
}

/// Sends JSON commands to a running `mpv` over its IPC Unix socket. The real implementation
/// ([`UnixSocketMpvIpc`]) opens a [`UnixStream`] to `socket_path`; the fake ([`FakeMpvIpc`])
/// records the JSON it was asked to send, so tests can assert "the adapter sent
/// `{ "command": ["set_property", "pause", true] }`" without a real socket.
///
/// The seam is split out from [`MpvSpawner`] because the spawn and the IPC client have different
/// lifecycles: the spawn happens once per `play()` call, while the IPC client is opened fresh on
/// each `pause()`/`resume()`/`set_volume()` call (matching the sidecar's `mpvIpc()` which opens a
/// new `net.createConnection` per command).
pub trait MpvIpc: Send + std::fmt::Debug {
    /// Sends one JSON command to `mpv`'s IPC socket. Returns `Ok(())` on a successful write, or
    /// an [`AdapterError::Io`] if the socket cannot be connected or the write fails.
    fn send(&self, json: &str) -> Result<(), AdapterError>;
}

/// Real IPC client: opens a [`UnixStream`] to `socket_path`, writes the JSON command followed by a
/// newline, and closes the connection. Uses a short read/write timeout (matching the sidecar's
/// 1000 ms timeout) so a hung `mpv` does not block the daemon's IPC thread indefinitely.
#[derive(Debug, Clone)]
pub struct UnixSocketMpvIpc {
    socket_path: PathBuf,
}

impl UnixSocketMpvIpc {
    pub fn new(socket_path: impl Into<PathBuf>) -> Self {
        Self {
            socket_path: socket_path.into(),
        }
    }
}

impl MpvIpc for UnixSocketMpvIpc {
    fn send(&self, json: &str) -> Result<(), AdapterError> {
        use std::os::unix::net::UnixStream;
        let stream = UnixStream::connect(&self.socket_path).map_err(|err| {
            AdapterError::Io(io::Error::other(format!(
                "mpv IPC unavailable at {}: {err}",
                self.socket_path.display()
            )))
        })?;
        let _ = stream.set_read_timeout(Some(MPV_IPC_TIMEOUT));
        let _ = stream.set_write_timeout(Some(MPV_IPC_TIMEOUT));
        let mut stream = stream;
        // mpv's IPC protocol expects each command on its own newline-terminated line. We write the
        // JSON + newline and then shut down the write side; we do not need to read mpv's response
        // (the sidecar's `mpvIpc()` likewise ignores the response and resolves on write).
        stream.write_all(json.as_bytes())?;
        stream.write_all(b"\n")?;
        let _ = stream.shutdown(std::net::Shutdown::Write);
        // Drain any response mpv writes back so it does not get a broken pipe before we close --
        // best-effort, ignore errors (the sidecar does the same with `sock.end()`).
        let _ = stream.read(&mut [0u8; 0]);
        Ok(())
    }
}

/// Test-only IPC client that records every JSON command it was asked to send, without opening a
/// real socket. Not used by any production code path.
#[derive(Debug, Clone, Default)]
pub struct FakeMpvIpc {
    sent: Arc<Mutex<Vec<String>>>,
    next_error: Option<&'static str>,
}

impl FakeMpvIpc {
    pub fn new() -> Self {
        Self::default()
    }

    /// Configures the next `send` call to fail with a canned I/O error carrying the given message.
    /// Test-only.
    pub fn with_next_error(mut self, message: &'static str) -> Self {
        self.next_error = Some(message);
        self
    }

    /// Returns a clone of the shared sent-log handle, so a test can inspect the recorded JSON
    /// commands after this IPC client has been moved into an adapter. Test-only.
    pub fn sent_log(&self) -> Arc<Mutex<Vec<String>>> {
        Arc::clone(&self.sent)
    }

    /// Returns every JSON command the client was asked to send, in call order. Test-only.
    pub fn recorded_sends(&self) -> Vec<String> {
        self.sent.lock().map(|g| g.clone()).unwrap_or_default()
    }
}

impl MpvIpc for FakeMpvIpc {
    fn send(&self, json: &str) -> Result<(), AdapterError> {
        if let Ok(mut guard) = self.sent.lock() {
            guard.push(json.to_string());
        }
        if let Some(message) = self.next_error {
            return Err(AdapterError::Io(io::Error::other(message)));
        }
        Ok(())
    }
}

/// Supervises a single `mpv` child process for audio-only playback.
///
/// All methods are synchronous (the daemon drives them on its IPC thread, never on tokio -- ADR
/// 0009) and never panic: a missing `mpv` binary is reported as [`AdapterError::Io`], not a crash.
pub trait PlaybackAdapter: Send + std::fmt::Debug {
    /// Spawns a new `mpv` for `url` at `volume` (0–100), killing any previously-spawned `mpv`
    /// first. Updates the adapter's in-memory state to [`PlaybackState::Playing`].
    fn play(&mut self, url: &str, volume: u8) -> Result<(), AdapterError>;

    /// Pauses the running `mpv` via its IPC socket. Updates the in-memory state to
    /// [`PlaybackState::Paused`].
    fn pause(&mut self) -> Result<(), AdapterError>;

    /// Resumes the paused `mpv` via its IPC socket. Updates the in-memory state to
    /// [`PlaybackState::Playing`].
    fn resume(&mut self) -> Result<(), AdapterError>;

    /// Kills the running `mpv` and removes the stale IPC socket. Updates the in-memory state to
    /// [`PlaybackState::Idle`].
    fn stop(&mut self) -> Result<(), AdapterError>;

    /// Sets the volume of the running `mpv` via its IPC socket. Does not change the in-memory
    /// playback state (only the recorded volume level).
    fn set_volume(&mut self, level: u8) -> Result<(), AdapterError>;

    /// Returns a snapshot of the adapter's in-memory playback state.
    fn state(&self) -> PlaybackSnapshot;
}

/// Production adapter: supervises a real `mpv` child process and controls it through a real Unix
/// socket JSON IPC client.
///
/// The `MpvSpawner` and `MpvIpc` seams are what make this adapter testable without spawning a real
/// `mpv` or opening a real socket: production wires in [`ProcessMpvSpawner`] +
/// [`UnixSocketMpvIpc`], tests wire in [`FakeMpvSpawner`] + [`FakeMpvIpc`] (or a real
/// [`UnixSocketMpvIpc`] pointed at a tempdir socket with a fake server thread).
#[derive(Debug)]
pub struct MpvPlaybackAdapter<S: MpvSpawner, I: MpvIpc> {
    spawner: S,
    ipc: I,
    mpv_binary: String,
    socket_path: PathBuf,
    child: Option<Box<dyn MpvChild>>,
    state: PlaybackState,
    url: String,
    volume: u8,
}

impl<S: MpvSpawner, I: MpvIpc> MpvPlaybackAdapter<S, I> {
    /// Production constructor: real `mpv` spawner + real Unix socket IPC client at the default
    /// socket path, using `mpv` from `PATH`.
    pub fn new(spawner: S, ipc: I) -> Self {
        Self::with_paths(spawner, ipc, DEFAULT_MPV_BINARY, DEFAULT_MPV_SOCKET_PATH)
    }

    /// Injectable constructor: takes explicit `mpv_binary` and `socket_path` values so tests can
    /// point the IPC client at a tempdir socket and use a fake binary name without spawning a real
    /// `mpv`.
    pub fn with_paths(
        spawner: S,
        ipc: I,
        mpv_binary: impl Into<String>,
        socket_path: impl Into<PathBuf>,
    ) -> Self {
        Self {
            spawner,
            ipc,
            mpv_binary: mpv_binary.into(),
            socket_path: socket_path.into(),
            child: None,
            state: PlaybackState::Idle,
            url: String::new(),
            volume: 75,
        }
    }

    /// Kills the current child (if any) and removes the stale IPC socket, matching the sidecar's
    /// `killMpv()`. Best-effort on the socket unlink (a missing file is the common case).
    fn kill_current(&mut self) {
        if let Some(mut child) = self.child.take() {
            child.kill();
        }
        let _ = std::fs::remove_file(&self.socket_path);
    }

    /// Sends a `set_property` command over the IPC socket. The JSON shape matches the sidecar's
    /// `{ command: ['set_property', '<prop>', <value>] }`.
    fn set_property(&self, property: &str, value: &str) -> Result<(), AdapterError> {
        // Serialize manually to keep the exact shape the sidecar uses (a JSON array command with
        // a bare boolean/number value, not a stringified one) and to avoid pulling in a serde
        // dependency for three small commands.
        let json = format!(r#"{{"command":["set_property","{property}",{value}]}}"#);
        self.ipc.send(&json)
    }
}

impl<S: MpvSpawner, I: MpvIpc> PlaybackAdapter for MpvPlaybackAdapter<S, I> {
    fn play(&mut self, url: &str, volume: u8) -> Result<(), AdapterError> {
        let clamped = volume.clamp(0, 100);
        self.kill_current();

        let socket_arg = format!("--input-ipc-server={}", self.socket_path.display());
        let volume_arg = format!("--volume={clamped}");
        let args: [&str; 4] = ["--no-video", "--really-quiet", &socket_arg, &volume_arg];
        // The URL is the positional argument. `MpvSpawner::spawn` takes `&[&str]`, so we build a
        // 5-element slice including the URL as the last element.
        let mut full_args: Vec<&str> = args.to_vec();
        full_args.push(url);

        let child = self.spawner.spawn(&self.mpv_binary, &full_args)?;
        self.child = Some(child);
        self.state = PlaybackState::Playing;
        self.url = url.to_string();
        self.volume = clamped;
        Ok(())
    }

    fn pause(&mut self) -> Result<(), AdapterError> {
        if self.state != PlaybackState::Playing {
            // Mirror the sidecar's 409 "Not playing" guard: pausing when not playing is a no-op
            // error, not a crash.
            return Err(AdapterError::Io(io::Error::other(
                "pause requested but playback is not in the playing state",
            )));
        }
        self.set_property("pause", "true")?;
        self.state = PlaybackState::Paused;
        Ok(())
    }

    fn resume(&mut self) -> Result<(), AdapterError> {
        if self.state != PlaybackState::Paused {
            return Err(AdapterError::Io(io::Error::other(
                "resume requested but playback is not in the paused state",
            )));
        }
        self.set_property("pause", "false")?;
        self.state = PlaybackState::Playing;
        Ok(())
    }

    fn stop(&mut self) -> Result<(), AdapterError> {
        self.kill_current();
        self.state = PlaybackState::Idle;
        self.url.clear();
        Ok(())
    }

    fn set_volume(&mut self, level: u8) -> Result<(), AdapterError> {
        let clamped = level.clamp(0, 100);
        // Mirror the sidecar: if mpv is running, update its volume too; otherwise just record the
        // level for the next play() call. The sidecar's `mpvIpc(...).catch(() => {})` swallows
        // IPC errors here (a stale socket after mpv exited is routine); we do the same.
        if self.state != PlaybackState::Idle {
            let _ = self.set_property("volume", &clamped.to_string());
        }
        self.volume = clamped;
        Ok(())
    }

    fn state(&self) -> PlaybackSnapshot {
        PlaybackSnapshot {
            state: self.state,
            url: self.url.clone(),
            volume: self.volume,
        }
    }
}

/// Test-only adapter that records `play`/`pause`/`resume`/`stop`/`set_volume` calls and returns a
/// canned [`PlaybackSnapshot`], without any subprocess or socket involvement. Not used by any
/// production code path. Mirrors [`super::dpms::FakeDpmsAdapter`]'s role for [`DpmsAdapter`].
#[derive(Debug, Clone)]
pub struct FakePlaybackAdapter {
    calls: Arc<Mutex<Vec<String>>>,
    snapshot: Arc<Mutex<PlaybackSnapshot>>,
    next_error: Option<&'static str>,
}

impl Default for FakePlaybackAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl FakePlaybackAdapter {
    pub fn new() -> Self {
        Self {
            calls: Arc::new(Mutex::new(Vec::new())),
            snapshot: Arc::new(Mutex::new(PlaybackSnapshot {
                state: PlaybackState::Idle,
                url: String::new(),
                volume: 75,
            })),
            next_error: None,
        }
    }

    /// Configures the adapter to fail the next call with a canned I/O error carrying the given
    /// message. Test-only.
    pub fn with_next_error(mut self, message: &'static str) -> Self {
        self.next_error = Some(message);
        self
    }

    /// Returns a clone of the shared call-log handle, so a test can inspect the recorded calls
    /// after this adapter has been boxed and moved into the daemon's IPC handler. Test-only.
    pub fn call_log(&self) -> Arc<Mutex<Vec<String>>> {
        Arc::clone(&self.calls)
    }

    /// Returns every action the adapter was asked to perform (e.g. `"play:url@75"`, `"pause"`,
    /// `"set_volume:50"`), in call order. Test-only.
    pub fn recorded_calls(&self) -> Vec<String> {
        self.calls.lock().map(|g| g.clone()).unwrap_or_default()
    }

    fn record(&self, tag: String) -> Result<(), AdapterError> {
        if let Ok(mut guard) = self.calls.lock() {
            guard.push(tag);
        }
        if let Some(message) = self.next_error {
            return Err(AdapterError::Io(io::Error::other(message)));
        }
        Ok(())
    }

    fn update_snapshot(&self, f: impl FnOnce(&mut PlaybackSnapshot)) {
        if let Ok(mut guard) = self.snapshot.lock() {
            f(&mut guard);
        }
    }
}

impl PlaybackAdapter for FakePlaybackAdapter {
    fn play(&mut self, url: &str, volume: u8) -> Result<(), AdapterError> {
        let clamped = volume.clamp(0, 100);
        self.record(format!("play:{url}@{clamped}"))?;
        self.update_snapshot(|s| {
            s.state = PlaybackState::Playing;
            s.url = url.to_string();
            s.volume = clamped;
        });
        Ok(())
    }

    fn pause(&mut self) -> Result<(), AdapterError> {
        self.record("pause".to_string())?;
        self.update_snapshot(|s| s.state = PlaybackState::Paused);
        Ok(())
    }

    fn resume(&mut self) -> Result<(), AdapterError> {
        self.record("resume".to_string())?;
        self.update_snapshot(|s| s.state = PlaybackState::Playing);
        Ok(())
    }

    fn stop(&mut self) -> Result<(), AdapterError> {
        self.record("stop".to_string())?;
        self.update_snapshot(|s| {
            s.state = PlaybackState::Idle;
            s.url.clear();
        });
        Ok(())
    }

    fn set_volume(&mut self, level: u8) -> Result<(), AdapterError> {
        let clamped = level.clamp(0, 100);
        self.record(format!("set_volume:{clamped}"))?;
        self.update_snapshot(|s| s.volume = clamped);
        Ok(())
    }

    fn state(&self) -> PlaybackSnapshot {
        self.snapshot
            .lock()
            .map(|g| g.clone())
            .unwrap_or_else(|_| PlaybackSnapshot {
                state: PlaybackState::Idle,
                url: String::new(),
                volume: 75,
            })
    }
}

// ===========================================================================
// AudioAdapters bundle
// ===========================================================================

/// A bundle of the daemon's real audio adapters, constructed once at startup in `main.rs` and
/// handed to the IPC action handler so it can dispatch `audio.*` methods to real audio hardware
/// without the handler having to know how each adapter is built. Mirrors [`super::HardwareAdapters`].
///
/// Each adapter is held as a trait object so the IPC handler can be constructed with fakes in tests
/// (see `edge/agentd/tests/ipc_wiring_v1.rs`). `PlaybackAdapter` is `&mut self` (it owns the mpv
/// child process), so the bundle holds it behind a `Mutex` -- the daemon's IPC thread is the only
/// caller, so the mutex is never contended in production, but it lets the `&self` handler trait
/// reach the `&mut` playback adapter without `RefCell` (which is not `Sync`).
#[derive(Debug)]
pub struct AudioAdapters {
    pub volume: Box<dyn VolumeAdapter>,
    pub playback: std::sync::Mutex<Box<dyn PlaybackAdapter>>,
}

impl AudioAdapters {
    /// Production constructor: real `pactl` volume + real `mpv` playback at the default socket
    /// path. Called by the daemon's `main()`.
    pub fn new_real() -> Self {
        Self {
            volume: Box::new(PactlVolumeAdapter::new(ProcessVolumeRunner)),
            playback: std::sync::Mutex::new(Box::new(MpvPlaybackAdapter::new(
                ProcessMpvSpawner,
                UnixSocketMpvIpc::new(DEFAULT_MPV_SOCKET_PATH),
            ))),
        }
    }

    /// Test/inspection constructor: takes fully fake adapters, for IPC wiring tests that need to
    /// assert "the handler called `audio.play`" without any subprocess or socket involvement. Not
    /// used by any production code path.
    pub fn with_fakes(volume: FakeVolumeAdapter, playback: FakePlaybackAdapter) -> Self {
        Self {
            volume: Box::new(volume),
            playback: std::sync::Mutex::new(Box::new(playback)),
        }
    }
}
