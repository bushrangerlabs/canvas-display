//! Microphone capture adapter — replaces the Node sidecar's `parec`/`arecord` spawning
//! (Phase 5, architecture plan §14.5, checklist item "Add audio-focus state machine, media
//! ducking/restoration, and barge-in").
//!
//! The adapter spawns `parec` (PipeWire/PulseAudio path) or `arecord` (bare ALSA path) as a
//! subprocess and delivers raw S16LE 16 kHz mono PCM chunks to a consumer via a channel.
//!
//! The adapter follows the same injectable-dependency-for-testability convention as
//! [`super::audio`] and [`super::dpms`]: production code gets a real implementation that
//! spawns real subprocesses, and tests get a fake one that emits canned PCM chunks, so the
//! test suite never depends on — or mutates — the actual microphone hardware of whatever
//! machine happens to run `cargo test`.
//!
//! **Honest scope note:** this adapter is a direct Rust port of the subprocess-spawning
//! approach in `server/src/voice/mic.ts`. It does NOT implement VAD, AEC, noise suppression,
//! or gain control — those are separate Phase 5/6 concerns that run on top of the raw PCM
//! stream this adapter delivers.

use std::io::{self, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use super::brightness::AdapterError;

// ---------------------------------------------------------------------------
// Command runner seam (mirrors `VolumeCommandRunner` / `dpms::CommandRunner`)
// ---------------------------------------------------------------------------

/// Runs an external command and returns its stdout. The real implementation
/// ([`ProcessMicCommandRunner`]) spawns the subprocess via [`Command::output`]; the fake
/// ([`FakeMicCommandRunner`]) records the command and returns a canned stdout + success flag,
/// so tests can assert "the adapter constructed `parec --format=s16le --rate=16000 ...`"
/// without spawning a real process.
pub trait MicCommandRunner: Send + std::fmt::Debug {
    /// Runs `program` with `args` and returns the captured stdout on success.
    fn run(&self, program: &str, args: &[&str]) -> Result<String, AdapterError>;
}

/// Production runner: spawns the real subprocess via [`Command::output`] and returns its stdout.
#[derive(Debug, Default, Clone, Copy)]
pub struct ProcessMicCommandRunner;

impl MicCommandRunner for ProcessMicCommandRunner {
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
                output.status.code().unwrap_or(-1)
            ))));
        }
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }
}

/// A recorded command that was "run" by a fake runner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedMicCommand {
    pub program: String,
    pub args: Vec<String>,
}

/// Fake runner that records commands and returns canned results.
#[derive(Debug)]
pub struct FakeMicCommandRunner {
    calls: Arc<Mutex<Vec<RecordedMicCommand>>>,
    next_stdout: Arc<Mutex<String>>,
    next_success: Arc<Mutex<bool>>,
}

impl Default for FakeMicCommandRunner {
    fn default() -> Self {
        Self::new()
    }
}

impl FakeMicCommandRunner {
    pub fn new() -> Self {
        Self {
            calls: Arc::new(Mutex::new(Vec::new())),
            next_stdout: Arc::new(Mutex::new(String::new())),
            next_success: Arc::new(Mutex::new(true)),
        }
    }

    pub fn with_stdout(self, stdout: impl Into<String>) -> Self {
        *self.next_stdout.lock().unwrap() = stdout.into();
        self
    }

    pub fn with_success(self, success: bool) -> Self {
        *self.next_success.lock().unwrap() = success;
        self
    }

    /// Returns a clone of the call log for assertion.
    pub fn call_log(&self) -> Arc<Mutex<Vec<RecordedMicCommand>>> {
        self.calls.clone()
    }

    /// Returns the recorded commands for assertion.
    pub fn recorded_commands(&self) -> Vec<RecordedMicCommand> {
        self.calls.lock().unwrap().clone()
    }
}

impl MicCommandRunner for FakeMicCommandRunner {
    fn run(&self, program: &str, args: &[&str]) -> Result<String, AdapterError> {
        self.calls.lock().unwrap().push(RecordedMicCommand {
            program: program.to_string(),
            args: args.iter().map(|a| a.to_string()).collect(),
        });
        if !*self.next_success.lock().unwrap() {
            return Err(AdapterError::Io(io::Error::other("fake runner error")));
        }
        Ok(self.next_stdout.lock().unwrap().clone())
    }
}

// ---------------------------------------------------------------------------
// MicAdapter trait
// ---------------------------------------------------------------------------

/// A PCM chunk delivered by the mic adapter.
#[derive(Debug, Clone)]
pub struct PcmChunk {
    /// Raw S16LE PCM bytes.
    pub data: Vec<u8>,
    /// Sample rate (always 16000 for this adapter).
    pub sample_rate: u32,
    /// Number of channels (always 1 for this adapter).
    pub channels: u8,
}

/// Microphone capture adapter.
pub trait MicAdapter: Send + std::fmt::Debug {
    /// Start capturing. The adapter spawns the capture subprocess and begins delivering PCM
    /// chunks to the receiver. Returns an error if already running or if the subprocess fails
    /// to spawn.
    fn start(&mut self) -> Result<(), AdapterError>;

    /// Stop capturing. Kills the subprocess and waits for it to exit.
    fn stop(&mut self) -> Result<(), AdapterError>;

    /// Returns true if the adapter is currently capturing.
    fn is_running(&self) -> bool;

    /// Get a receiver for PCM chunks. Returns `None` if the adapter hasn't been started.
    fn receiver(&self) -> Option<flume::Receiver<PcmChunk>>;
}

// ---------------------------------------------------------------------------
// ParecMicAdapter — real subprocess-based capture
// ---------------------------------------------------------------------------

/// Real mic adapter that spawns `parec` (PipeWire/PulseAudio) or `arecord` (bare ALSA).
///
/// Device selection matches `server/src/voice/mic.ts`:
/// - PulseAudio source name (e.g. `alsa_input.usb-...analog-stereo`) → `parec`
/// - `'default'` → `parec` (PA default source)
/// - `'plughw:X,Y'` or `'hw:X,Y'` → `arecord` (bare ALSA, no PipeWire)
#[derive(Debug)]
pub struct ParecMicAdapter<R: MicCommandRunner> {
    // The runner is stored for future use when the MicAdapter impl needs to run
    // commands; it's kept here to maintain the injectable seam pattern.
    #[allow(dead_code)]
    runner: R,
    device: String,
    running: Arc<AtomicBool>,
    /// Handle to the spawned subprocess.
    child: Arc<Mutex<Option<Child>>>,
    /// Flume sender for PCM chunks (cloneable).
    sender: Arc<Mutex<Option<flume::Sender<PcmChunk>>>>,
    /// Flume receiver for PCM chunks (cloneable — returned by `receiver()`).
    receiver: Arc<Mutex<Option<flume::Receiver<PcmChunk>>>>,
    /// Handle to the reader thread.
    reader_thread: Arc<Mutex<Option<JoinHandle<()>>>>,
}

impl<R: MicCommandRunner + 'static> ParecMicAdapter<R> {
    /// Create a new `ParecMicAdapter`.
    ///
    /// `device` follows the same rules as `server/src/voice/mic.ts`:
    /// - `'default'` or a PulseAudio source name → uses `parec`
    /// - `'plughw:X,Y'` or `'hw:X,Y'` → uses `arecord`
    pub fn new(runner: R, device: impl Into<String>) -> Self {
        let device = device.into();
        // hw: → plughw: enables the ALSA plug layer for bare-ALSA users
        let device = if device.starts_with("hw:") {
            device.replacen("hw:", "plughw:", 1)
        } else {
            device
        };

        Self {
            runner,
            device,
            running: Arc::new(AtomicBool::new(false)),
            child: Arc::new(Mutex::new(None)),
            sender: Arc::new(Mutex::new(None)),
            receiver: Arc::new(Mutex::new(None)),
            reader_thread: Arc::new(Mutex::new(None)),
        }
    }

    /// Returns true if the device should use `parec` (PipeWire/PulseAudio path).
    fn use_pulse(&self) -> bool {
        !self.device.starts_with("plughw:") && !self.device.starts_with("hw:")
    }

    /// Build the command and args for the capture subprocess.
    fn build_command(&self) -> (&str, Vec<String>) {
        if self.use_pulse() {
            let mut args = vec![
                "--format=s16le".to_string(),
                "--rate=16000".to_string(),
                "--channels=1".to_string(),
                "--latency-msec=32".to_string(),
            ];
            if self.device != "default" {
                args.push(format!("--device={}", self.device));
            }
            ("parec", args)
        } else {
            let args = vec![
                "-D".to_string(),
                self.device.clone(),
                "-f".to_string(),
                "S16_LE".to_string(),
                "-r".to_string(),
                "16000".to_string(),
                "-c".to_string(),
                "1".to_string(),
                "-t".to_string(),
                "raw".to_string(),
                "--period-size=512".to_string(),
                "--buffer-size=4096".to_string(),
            ];
            ("arecord", args)
        }
    }
}

impl<R: MicCommandRunner + 'static> MicAdapter for ParecMicAdapter<R> {
    fn start(&mut self) -> Result<(), AdapterError> {
        if self.running.load(Ordering::SeqCst) {
            return Err(AdapterError::Io(io::Error::other(
                "mic adapter is already running",
            )));
        }

        let (cmd, args) = self.build_command();

        // Spawn the subprocess
        let mut child = Command::new(cmd)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                AdapterError::Io(io::Error::other(format!("failed to spawn {cmd}: {e}")))
            })?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AdapterError::Io(io::Error::other("no stdout from capture process")))?;

        // Create the flume channel (cloneable sender/receiver)
        let (tx, rx) = flume::unbounded::<PcmChunk>();
        *self.sender.lock().unwrap() = Some(tx);
        *self.receiver.lock().unwrap() = Some(rx);
        *self.child.lock().unwrap() = Some(child);

        self.running.store(true, Ordering::SeqCst);

        // Spawn the reader thread
        let running = self.running.clone();
        let sender = self.sender.clone();
        let reader_handle = thread::Builder::new()
            .name("mic-reader".into())
            .spawn(move || {
                let mut reader = BufReader::with_capacity(4096, stdout);
                // Read raw PCM bytes in chunks
                let mut buf = Vec::with_capacity(4096);
                loop {
                    if !running.load(Ordering::SeqCst) {
                        break;
                    }
                    buf.clear();
                    // Use std::io::Read::take to limit each read
                    let mut limited = reader.by_ref().take(4096);
                    match limited.read_to_end(&mut buf) {
                        Ok(0) => break, // EOF
                        Ok(_) => {
                            let sender_guard = sender.lock().unwrap();
                            if let Some(ref tx) = *sender_guard {
                                let chunk = PcmChunk {
                                    data: buf.clone(),
                                    sample_rate: 16000,
                                    channels: 1,
                                };
                                // Ignore send errors (receiver dropped)
                                let _ = tx.send(chunk);
                            }
                            buf = Vec::with_capacity(4096);
                        }
                        Err(_) => break,
                    }
                }
            })
            .map_err(|e| {
                AdapterError::Io(io::Error::other(format!(
                    "failed to spawn reader thread: {e}"
                )))
            })?;

        *self.reader_thread.lock().unwrap() = Some(reader_handle);

        Ok(())
    }

    fn stop(&mut self) -> Result<(), AdapterError> {
        if !self.running.load(Ordering::SeqCst) {
            return Ok(());
        }

        self.running.store(false, Ordering::SeqCst);

        // Kill the subprocess
        if let Ok(mut guard) = self.child.lock() {
            if let Some(ref mut child) = *guard {
                let _ = child.kill();
                let _ = child.wait();
            }
            *guard = None;
        }

        // Drop the sender to signal the reader thread to stop
        *self.sender.lock().unwrap() = None;

        // Wait for the reader thread to finish
        if let Ok(mut guard) = self.reader_thread.lock() {
            if let Some(handle) = guard.take() {
                let _ = handle.join();
            }
        }

        *self.receiver.lock().unwrap() = None;

        Ok(())
    }

    fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    fn receiver(&self) -> Option<flume::Receiver<PcmChunk>> {
        // flume::Receiver is Clone, so we can return a clone
        self.receiver.lock().unwrap().clone()
    }
}

// ---------------------------------------------------------------------------
// FakeMicAdapter — canned PCM chunks for tests
// ---------------------------------------------------------------------------

/// Fake mic adapter that emits canned PCM chunks without spawning any subprocess.
#[derive(Debug)]
pub struct FakeMicAdapter {
    running: bool,
    /// Canned chunks to emit (replayed in order).
    chunks: Vec<PcmChunk>,
    /// Flume channel for delivering chunks.
    sender: Option<flume::Sender<PcmChunk>>,
    receiver: Option<flume::Receiver<PcmChunk>>,
    /// Call log for assertions.
    calls: Arc<Mutex<Vec<String>>>,
}

impl Default for FakeMicAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl FakeMicAdapter {
    pub fn new() -> Self {
        let (tx, rx) = flume::unbounded();
        Self {
            running: false,
            chunks: Vec::new(),
            sender: Some(tx),
            receiver: Some(rx),
            calls: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Add a canned PCM chunk to emit on start.
    pub fn with_chunk(mut self, chunk: PcmChunk) -> Self {
        self.chunks.push(chunk);
        self
    }

    /// Add a canned chunk from raw bytes.
    pub fn with_data(mut self, data: Vec<u8>) -> Self {
        self.chunks.push(PcmChunk {
            data,
            sample_rate: 16000,
            channels: 1,
        });
        self
    }

    /// Returns the call log for assertions.
    pub fn call_log(&self) -> Arc<Mutex<Vec<String>>> {
        self.calls.clone()
    }

    /// Returns the recorded calls.
    pub fn recorded_calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

impl MicAdapter for FakeMicAdapter {
    fn start(&mut self) -> Result<(), AdapterError> {
        self.calls.lock().unwrap().push("start".to_string());
        if self.running {
            return Err(AdapterError::Io(io::Error::other(
                "fake mic already running",
            )));
        }
        self.running = true;

        // Emit canned chunks
        if let Some(ref tx) = self.sender {
            for chunk in &self.chunks {
                let _ = tx.send(chunk.clone());
            }
        }

        Ok(())
    }

    fn stop(&mut self) -> Result<(), AdapterError> {
        self.calls.lock().unwrap().push("stop".to_string());
        self.running = false;
        Ok(())
    }

    fn is_running(&self) -> bool {
        self.running
    }

    fn receiver(&self) -> Option<flume::Receiver<PcmChunk>> {
        // flume::Receiver is Clone, so we can return a clone
        self.receiver.clone()
    }
}

// ---------------------------------------------------------------------------
// MicAdapters bundle
// ---------------------------------------------------------------------------

/// A bundle containing the mic adapter, following the same pattern as [`super::AudioAdapters`].
#[derive(Debug)]
pub struct MicAdapters {
    pub mic: Box<dyn MicAdapter>,
}

impl MicAdapters {
    /// Production constructor: real `parec`/`arecord` mic capture with the default device.
    pub fn new_real() -> Self {
        Self {
            mic: Box::new(ParecMicAdapter::new(ProcessMicCommandRunner, "default")),
        }
    }

    /// Constructor with a specific device.
    pub fn new_real_with_device(device: impl Into<String>) -> Self {
        Self {
            mic: Box::new(ParecMicAdapter::new(ProcessMicCommandRunner, device)),
        }
    }

    /// Test/inspection constructor: takes a fully fake mic adapter.
    pub fn with_fakes(mic: FakeMicAdapter) -> Self {
        Self { mic: Box::new(mic) }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -- FakeMicAdapter tests --

    #[test]
    fn fake_mic_adapter_start_stop_lifecycle() {
        let mut adapter = FakeMicAdapter::new();
        assert!(!adapter.is_running());

        adapter.start().expect("start should succeed");
        assert!(adapter.is_running());

        adapter.stop().expect("stop should succeed");
        assert!(!adapter.is_running());
    }

    #[test]
    fn fake_mic_adapter_emits_canned_chunks() {
        let chunk1 = PcmChunk {
            data: vec![0x00, 0x01, 0x02, 0x03],
            sample_rate: 16000,
            channels: 1,
        };
        let chunk2 = PcmChunk {
            data: vec![0x04, 0x05, 0x06, 0x07],
            sample_rate: 16000,
            channels: 1,
        };

        let mut adapter = FakeMicAdapter::new()
            .with_chunk(chunk1.clone())
            .with_chunk(chunk2.clone());

        adapter.start().expect("start");
        let rx = adapter.receiver().expect("receiver");

        let received1 = rx.recv().expect("should receive chunk1");
        assert_eq!(received1.data, chunk1.data);
        assert_eq!(received1.sample_rate, 16000);
        assert_eq!(received1.channels, 1);

        let received2 = rx.recv().expect("should receive chunk2");
        assert_eq!(received2.data, chunk2.data);

        adapter.stop().expect("stop");
    }

    #[test]
    fn fake_mic_adapter_records_calls() {
        let mut adapter = FakeMicAdapter::new();
        adapter.start().unwrap();
        adapter.stop().unwrap();

        let calls = adapter.recorded_calls();
        assert_eq!(calls, vec!["start", "stop"]);
    }

    #[test]
    fn fake_mic_adapter_errors_on_double_start() {
        let mut adapter = FakeMicAdapter::new();
        adapter.start().expect("first start");
        let err = adapter.start().expect_err("second start should fail");
        assert!(
            err.to_string().contains("already running"),
            "expected 'already running', got: {err}"
        );
    }

    // -- ParecMicAdapter command construction tests --

    #[test]
    fn parec_mic_adapter_uses_parec_for_default_device() {
        let runner = FakeMicCommandRunner::new();
        let adapter = ParecMicAdapter::new(runner, "default");
        let (cmd, args) = adapter.build_command();

        assert_eq!(cmd, "parec");
        assert!(args.contains(&"--format=s16le".to_string()));
        assert!(args.contains(&"--rate=16000".to_string()));
        assert!(args.contains(&"--channels=1".to_string()));
        assert!(args.contains(&"--latency-msec=32".to_string()));
        // No --device for default
        assert!(!args.iter().any(|a| a.starts_with("--device=")));
    }

    #[test]
    fn parec_mic_adapter_uses_parec_with_device_flag_for_named_source() {
        let runner = FakeMicCommandRunner::new();
        let adapter = ParecMicAdapter::new(runner, "alsa_input.usb-046d-analog-stereo");
        let (cmd, args) = adapter.build_command();

        assert_eq!(cmd, "parec");
        assert!(args.contains(&"--device=alsa_input.usb-046d-analog-stereo".to_string()));
    }

    #[test]
    fn parec_mic_adapter_uses_arecord_for_plughw_device() {
        let runner = FakeMicCommandRunner::new();
        let adapter = ParecMicAdapter::new(runner, "plughw:1,0");
        let (cmd, args) = adapter.build_command();

        assert_eq!(cmd, "arecord");
        assert!(args.contains(&"-D".to_string()));
        assert!(args.contains(&"plughw:1,0".to_string()));
        assert!(args.contains(&"-f".to_string()));
        assert!(args.contains(&"S16_LE".to_string()));
        assert!(args.contains(&"-r".to_string()));
        assert!(args.contains(&"16000".to_string()));
        assert!(args.contains(&"-c".to_string()));
        assert!(args.contains(&"1".to_string()));
    }

    #[test]
    fn parec_mic_adapter_converts_hw_to_plughw() {
        let runner = FakeMicCommandRunner::new();
        // The constructor should convert hw: to plughw:
        let adapter = ParecMicAdapter::new(runner, "hw:2,1");
        let (cmd, args) = adapter.build_command();

        assert_eq!(cmd, "arecord");
        assert!(args.contains(&"plughw:2,1".to_string()));
    }

    #[test]
    fn parec_mic_adapter_start_errors_when_already_running() {
        let runner = FakeMicCommandRunner::new();
        let mut adapter = ParecMicAdapter::new(runner, "default");

        // Set running to true manually to simulate already-running state
        adapter.running.store(true, Ordering::SeqCst);

        let err = adapter.start().expect_err("double start should fail");
        assert!(
            err.to_string().contains("already running"),
            "expected 'already running', got: {err}"
        );
    }

    #[test]
    fn parec_mic_adapter_stop_is_idempotent_when_not_running() {
        let runner = FakeMicCommandRunner::new();
        let mut adapter = ParecMicAdapter::new(runner, "default");

        // Stopping when not running should be a no-op
        adapter
            .stop()
            .expect("stop when not running should succeed");
    }

    #[test]
    fn fake_mic_command_runner_records_commands() {
        let runner = FakeMicCommandRunner::new().with_stdout("ok");
        let result = runner.run("parec", &["--version"]);
        assert!(result.is_ok());

        let cmds = runner.recorded_commands();
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].program, "parec");
        assert_eq!(cmds[0].args, vec!["--version"]);
    }

    #[test]
    fn fake_mic_command_runner_reports_failure() {
        let runner = FakeMicCommandRunner::new().with_success(false);
        let result = runner.run("parec", &["--bad-flag"]);
        assert!(result.is_err());
    }

    #[test]
    fn mic_adapters_bundle_constructs_real() {
        let bundle = MicAdapters::new_real();
        assert!(!bundle.mic.is_running());
    }

    #[test]
    fn mic_adapters_bundle_constructs_with_fakes() {
        let fake = FakeMicAdapter::new();
        let bundle = MicAdapters::with_fakes(fake);
        assert!(!bundle.mic.is_running());
    }
}
