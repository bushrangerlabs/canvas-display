//! Local IPC server wiring: runs the [`canvas_edge_agent::ipc::LocalIpcBroker`] against a real
//! `UnixListener` on a configurable socket path, on its own dedicated OS thread (NOT a tokio
//! task -- ADR 0009 confines all of `tokio` to the single transport thread; the rest of the
//! daemon, including this IPC accept loop, stays fully synchronous).
//!
//! This module is the bridge between the library-only broker proven in
//! `edge/agent/tests/local_ipc_v1.rs` and the actual running daemon: [`serve_ipc`] opens the
//! socket, sets conservative file permissions, and drives the broker's `accept` -> `read_request`
//! -> `dispatch` -> `write_response` loop until the caller signals shutdown via the shared
//! [`std::sync::atomic::AtomicBool`]. [`IpcHandle`] mirrors
//! [`canvas_edge_agent::transport::TransportHandle`]: a join handle plus the shutdown flag the
//! daemon's existing `Ctrl+C` path flips before joining.
//!
//! **Honest scope note:** the [`DaemonActionHandler`] wired in here drives **real hardware** for
//! the display actions (`display.screen_off`, `display.screen_on`, `display.set_brightness`)
//! through the typed `canvas_edge_agent::hardware` adapters (sysfs backlight for brightness,
//! `xset dpms force off/on` for DPMS). `agent.app_version` is real (it returns the daemon's
//! `CARGO_PKG_VERSION`). The adapters are constructed in `main()` and injected here so the
//! handler is testable with fakes (see `edge/agentd/tests/ipc_wiring_v1.rs`). This wiring closes
//! the Phase 1 "renderer never receives the device private key" proof: the broker has no
//! reference to any key store, and the only way to reach the Agent from a local peer is through
//! this method-scoped boundary.

use std::fs;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use canvas_edge_agent::hardware::{AudioAdapters, HardwareAdapters};
use canvas_edge_agent::ipc::{
    self, read_request, write_response, AcceptError, ActionExecutor, AuthenticatedSession,
    CurrentActionExecutor, CurrentActionHandler, LocalIpcBroker, LocalIpcConfig, PeerRole,
    SoPeercredSource,
};
use canvas_edge_agent::media::{
    resolve_youtube_player_url, MediaAdapters, YouTubePlaybackEvent, YouTubeSearchOptions,
    ALLOWED_YOUTUBE_EVENTS,
};
use serde::Serialize;

/// Environment variable overriding the IPC socket path. The default lives under `/run`, which is
/// a `tmpfs` cleared on reboot -- appropriate for a runtime-only socket file that must not
/// survive a restart of the machine (a stale socket file is unlinked before every bind anyway).
pub const IPC_SOCKET_PATH_ENV: &str = "CANVAS_EDGE_IPC_SOCKET";

/// Default socket path, matching the example in `docs/PHASE_0_LOCAL_IPC_SPEC.md`. The parent
/// directory (`/run/canvas-edge`) is expected to be created and owned by the Agent's service user
/// at install/runtime -- for systemd, `RuntimeDirectory=canvas-edge` in the unit does this; for
/// a manual dev run the daemon creates the directory itself with `0700` if it does not exist.
pub const DEFAULT_IPC_SOCKET_PATH: &str = "/run/canvas-edge/agent.sock";

/// Environment variables overriding the two peer uids the broker authenticates. Production must
/// set these to the distinct, dedicated service-user uids of the renderer and updater processes
/// (see `docs/PHASE_0_LOCAL_IPC_SPEC.md` "Peer identity and role resolution"). The default --
/// the daemon's own uid for both -- is a deliberately permissive dev/test fallback so an
/// unconfigured daemon still authenticates a same-user client (e.g. the integration test in
/// `edge/agentd/tests/ipc_wiring_v1.rs`); it is NOT a production posture.
pub const RENDERER_UID_ENV: &str = "CANVAS_EDGE_RENDERER_UID";
pub const UPDATER_UID_ENV: &str = "CANVAS_EDGE_UPDATER_UID";

/// File mode applied to the socket file after `bind`. `0600` (owner read/write only) matches the
/// spec's "socket itself is mode `0600`" requirement. The parent directory's ownership/mode is a
/// packaging-time concern (systemd `RuntimeDirectory`/`StateDirectory`, or manual `install`); the
/// daemon only ensures the socket file itself is not world-accessible.
const SOCKET_FILE_MODE: u32 = 0o600;

/// How long the accept loop waits between polls of the shutdown flag. The listener is
/// non-blocking, so `accept()` returns `WouldBlock` immediately when no connection is pending;
/// this sleep keeps the loop from busy-spinning while still noticing a shutdown request within
/// this interval.
const ACCEPT_POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Resolves the IPC socket path from the environment, falling back to [`DEFAULT_IPC_SOCKET_PATH`].
pub fn resolve_socket_path() -> PathBuf {
    match std::env::var(IPC_SOCKET_PATH_ENV) {
        Ok(value) if !value.is_empty() => PathBuf::from(value),
        _ => PathBuf::from(DEFAULT_IPC_SOCKET_PATH),
    }
}

/// Resolves the renderer uid from the environment, falling back to the daemon's own uid (dev
/// posture -- see [`RENDERER_UID_ENV`] doc).
pub fn resolve_renderer_uid() -> u32 {
    match std::env::var(RENDERER_UID_ENV) {
        Ok(value) => value.parse().unwrap_or_else(|_| unsafe { libc::getuid() }),
        Err(_) => unsafe { libc::getuid() },
    }
}

/// Resolves the updater uid from the environment, falling back to the daemon's own uid + 1 (dev
/// posture -- see [`UPDATER_UID_ENV`] doc). The `+ 1` keeps it distinct from the renderer default
/// so the two roles never accidentally share a uid in an unconfigured run.
pub fn resolve_updater_uid() -> u32 {
    match std::env::var(UPDATER_UID_ENV) {
        Ok(value) => value
            .parse()
            .unwrap_or_else(|_| unsafe { libc::getuid() }.wrapping_add(1)),
        Err(_) => unsafe { libc::getuid() }.wrapping_add(1),
    }
}

/// The daemon's [`CurrentActionHandler`]: drives real hardware for the display actions, real
/// audio adapters for the `audio.*` actions, and returns the real `agent.app_version`. The
/// hardware and audio adapters are injected so tests can wire in fakes (see
/// `edge/agentd/tests/ipc_wiring_v1.rs`); production wires in the real `HardwareAdapters::new_real()`
/// and `AudioAdapters::new_real()` bundles constructed in `main()`. The `media.*` actions are
/// dispatched to a [`MediaAdapters`] bundle (YouTube/Radio adapters + shared playback adapter +
/// in-process state); production wires in the real bundle, tests wire in fakes. The `media` field
/// is `Option` so the existing `with_hardware_and_audio` constructors (which do not need media)
/// keep working unchanged; `media.*` methods return an error if no media bundle is wired.
pub struct DaemonActionHandler {
    pkg_version: &'static str,
    device_id: String,
    installation_id: String,
    public_key_fingerprint: String,
    hardware: HardwareAdapters,
    audio: AudioAdapters,
    media: Option<MediaAdapters>,
}

impl DaemonActionHandler {
    /// Production constructor: wires in the real sysfs brightness + `xset` DPMS adapters and the
    /// real `pactl` volume + `mpv` playback adapters. Called by [`serve_ipc`] when no explicit
    /// adapter bundle is provided.
    pub fn new(device_id: &str, installation_id: &str, public_key_fingerprint: &str) -> Self {
        Self::with_hardware_and_audio(
            HardwareAdapters::new_real(),
            AudioAdapters::new_real(),
            device_id,
            installation_id,
            public_key_fingerprint,
        )
    }

    /// Injectable constructor: takes an explicit [`HardwareAdapters`] bundle, with real audio
    /// adapters. Kept for callers that only need to inject display hardware fakes.
    pub fn with_hardware(hardware: HardwareAdapters) -> Self {
        Self::with_hardware_and_audio(
            hardware,
            AudioAdapters::new_real(),
            "unknown",
            "unknown",
            "unknown",
        )
    }

    /// Injectable constructor: takes explicit [`HardwareAdapters`] and [`AudioAdapters`] bundles so
    /// tests can wire in fakes for both surfaces without depending on the actual machine's `/sys`
    /// tree, spawning a real `xset`/`pactl`/`mpv`, or opening a real IPC socket.
    pub fn with_hardware_and_audio(
        hardware: HardwareAdapters,
        audio: AudioAdapters,
        device_id: &str,
        installation_id: &str,
        public_key_fingerprint: &str,
    ) -> Self {
        Self {
            pkg_version: env!("CARGO_PKG_VERSION"),
            device_id: device_id.to_string(),
            installation_id: installation_id.to_string(),
            public_key_fingerprint: public_key_fingerprint.to_string(),
            hardware,
            audio,
            media: None,
        }
    }

    /// Injectable constructor: takes explicit [`HardwareAdapters`], [`AudioAdapters`], and
    /// [`MediaAdapters`] bundles so tests can wire in fakes for all three surfaces. Production
    /// (`main()`) calls [`serve_ipc`], which wires in the real adapters; tests call
    /// [`serve_ipc_with_hardware_audio_and_media`] to inject fakes.
    pub fn with_hardware_audio_and_media(
        hardware: HardwareAdapters,
        audio: AudioAdapters,
        media: MediaAdapters,
        device_id: &str,
        installation_id: &str,
        public_key_fingerprint: &str,
    ) -> Self {
        Self {
            pkg_version: env!("CARGO_PKG_VERSION"),
            device_id: device_id.to_string(),
            installation_id: installation_id.to_string(),
            public_key_fingerprint: public_key_fingerprint.to_string(),
            hardware,
            audio,
            media: Some(media),
        }
    }
}

impl Default for DaemonActionHandler {
    fn default() -> Self {
        Self::new("unknown", "unknown", "unknown")
    }
}

impl CurrentActionHandler for DaemonActionHandler {
    fn screen_off(&mut self) -> Result<(), String> {
        self.hardware
            .dpms
            .screen_off()
            .map_err(|err| err.to_string())?;
        println!("[canvas-edge-agentd] ipc: display.screen_off (dpms forced off)");
        Ok(())
    }

    fn screen_on(&mut self) -> Result<(), String> {
        self.hardware
            .dpms
            .screen_on()
            .map_err(|err| err.to_string())?;
        println!("[canvas-edge-agentd] ipc: display.screen_on (dpms forced on)");
        Ok(())
    }

    fn set_brightness(&mut self, level: u8) -> Result<(), String> {
        self.hardware
            .brightness
            .set_brightness(u32::from(level))
            .map_err(|err| err.to_string())?;
        println!("[canvas-edge-agentd] ipc: display.set_brightness level={level}");
        Ok(())
    }

    fn app_version(&mut self) -> Result<String, String> {
        Ok(self.pkg_version.to_string())
    }

    fn device_identity(&mut self) -> Result<String, String> {
        let json = serde_json::json!({
            "device_id": self.device_id,
            "installation_id": self.installation_id,
            "public_key_fingerprint": self.public_key_fingerprint,
        });
        Ok(json.to_string())
    }

    fn audio_play(&mut self, url: &str, volume: u8) -> Result<(), String> {
        // If the caller omitted `volume` (the executor passes 0 in that case), fall back to the
        // last recorded volume -- mirroring the sidecar's `volume ?? _state.volume`.
        let level = if volume == 0 {
            self.audio.volume.get_volume().unwrap_or(volume)
        } else {
            volume
        };
        self.audio
            .volume
            .set_volume(level)
            .map_err(|err| err.to_string())?;
        let mut playback = self.audio.playback.lock().map_err(|err| err.to_string())?;
        playback.play(url, level).map_err(|err| err.to_string())?;
        println!("[canvas-edge-agentd] ipc: audio.play url={url} volume={level}");
        Ok(())
    }

    fn audio_pause(&mut self) -> Result<(), String> {
        let mut playback = self.audio.playback.lock().map_err(|err| err.to_string())?;
        playback.pause().map_err(|err| err.to_string())?;
        println!("[canvas-edge-agentd] ipc: audio.pause");
        Ok(())
    }

    fn audio_resume(&mut self) -> Result<(), String> {
        let mut playback = self.audio.playback.lock().map_err(|err| err.to_string())?;
        playback.resume().map_err(|err| err.to_string())?;
        println!("[canvas-edge-agentd] ipc: audio.resume");
        Ok(())
    }

    fn audio_stop(&mut self) -> Result<(), String> {
        let mut playback = self.audio.playback.lock().map_err(|err| err.to_string())?;
        playback.stop().map_err(|err| err.to_string())?;
        println!("[canvas-edge-agentd] ipc: audio.stop");
        Ok(())
    }

    fn audio_set_volume(&mut self, level: u8) -> Result<(), String> {
        self.audio
            .volume
            .set_volume(level)
            .map_err(|err| err.to_string())?;
        // Mirror the sidecar: if mpv is running, update its volume too. The playback adapter
        // swallows IPC errors here (a stale socket after mpv exited is routine).
        let mut playback = self.audio.playback.lock().map_err(|err| err.to_string())?;
        let _ = playback.set_volume(level);
        println!("[canvas-edge-agentd] ipc: audio.set_volume level={level}");
        Ok(())
    }

    fn audio_set_mute(&mut self, muted: bool) -> Result<(), String> {
        self.audio
            .volume
            .set_mute(muted)
            .map_err(|err| err.to_string())?;
        println!("[canvas-edge-agentd] ipc: audio.set_mute muted={muted}");
        Ok(())
    }

    fn audio_state(&mut self) -> Result<String, String> {
        let playback = self.audio.playback.lock().map_err(|err| err.to_string())?;
        let snapshot = playback.state();
        let volume = self.audio.volume.get_volume().unwrap_or(snapshot.volume);
        let muted = self.audio.volume.is_muted().unwrap_or(false);
        // Serialize with serde_json (already a daemon dependency) so the URL is escaped correctly
        // and the shape is stable. The shape mirrors the sidecar's `AudioState` minus `title`
        // (which the caller already knows).
        let json = serde_json::json!({
            "state": snapshot.state.as_str(),
            "url": snapshot.url,
            "volume": volume,
            "muted": muted,
        });
        Ok(json.to_string())
    }

    // ── Media (YouTube + Radio) ──────────────────────────────────────────────

    fn media_youtube_play(
        &mut self,
        query: &str,
        video_id: &str,
        api_key: &str,
    ) -> Result<String, String> {
        let media = self
            .media
            .as_mut()
            .ok_or_else(|| "media adapters not configured".to_string())?;

        let resolved_id = if !video_id.is_empty() {
            video_id.to_string()
        } else if query.is_empty() {
            return Err("media.youtube.play requires a 'query' or 'video_id' argument".to_string());
        } else if api_key.is_empty() {
            return Err(
                "media.youtube.play requires an 'api_key' for query-based search".to_string(),
            );
        } else {
            let results = media
                .youtube
                .search(query, api_key, &YouTubeSearchOptions::default())
                .map_err(|e| e.to_string())?;
            if results.is_empty() {
                return Err(format!("no YouTube results for query: {query}"));
            }
            results[0].video_id.clone()
        };

        let url = resolve_youtube_player_url(&resolved_id, &media.bridge_base_url);
        let playback_id = format!(
            "yt-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        );
        let candidate_ids = vec![resolved_id.clone()];
        media
            .state
            .start_youtube_playback(&playback_id, candidate_ids.clone(), query);

        let (_, candidates) = media.state.youtube_state();
        let json = serde_json::json!({
            "url": url,
            "video_id": resolved_id,
            "playback_id": playback_id,
            "candidates": candidates,
        });
        Ok(json.to_string())
    }

    fn media_youtube_status(
        &mut self,
        playback_id: &str,
        event: &str,
        video_id: &str,
        error_code: Option<i64>,
    ) -> Result<String, String> {
        let media = self
            .media
            .as_mut()
            .ok_or_else(|| "media adapters not configured".to_string())?;

        if !ALLOWED_YOUTUBE_EVENTS.contains(&event) {
            return Err(format!("unknown YouTube event: {event}"));
        }

        let recorded = media.state.record_youtube_event(&YouTubePlaybackEvent {
            playback_id: playback_id.to_string(),
            event: event.to_string(),
            video_id: video_id.to_string(),
            error_code,
        });

        Ok(serde_json::json!({"ok": true, "stale": !recorded}).to_string())
    }

    fn media_youtube_state(&mut self) -> Result<String, String> {
        let media = self
            .media
            .as_ref()
            .ok_or_else(|| "media adapters not configured".to_string())?;
        let (status, candidates) = media.state.youtube_state();
        let json = serde_json::json!({
            "status": {
                "playback_id": status.playback_id,
                "status": status.status,
                "video_id": status.video_id,
                "candidate_index": status.candidate_index,
                "candidate_count": status.candidate_count,
                "error_code": status.error_code,
                "query": status.query,
            },
            "candidates": candidates,
        });
        Ok(json.to_string())
    }

    fn media_radio_play(&mut self, query: &str) -> Result<String, String> {
        let media = self
            .media
            .as_mut()
            .ok_or_else(|| "media adapters not configured".to_string())?;

        let station = media
            .radio
            .resolve_station(query)
            .map_err(|e| e.to_string())?;

        // Play the resolved stream URL via the shared playback adapter (mpv)
        let volume = media.playback.state().volume;
        media
            .playback
            .play(&station.stream_url, volume)
            .map_err(|e| e.to_string())?;

        let json = serde_json::json!({
            "name": station.name,
            "stream_url": station.stream_url,
            "provider": station.provider,
            "artwork": station.artwork,
            "homepage": station.homepage,
        });
        Ok(json.to_string())
    }

    fn media_radio_stop(&mut self) -> Result<(), String> {
        let media = self
            .media
            .as_mut()
            .ok_or_else(|| "media adapters not configured".to_string())?;
        media.playback.stop().map_err(|e| e.to_string())?;
        Ok(())
    }

    fn media_radio_state(&mut self) -> Result<String, String> {
        let media = self
            .media
            .as_ref()
            .ok_or_else(|| "media adapters not configured".to_string())?;
        let snapshot = media.playback.state();
        let json = serde_json::json!({
            "state": snapshot.state.as_str(),
            "url": snapshot.url,
            "volume": snapshot.volume,
        });
        Ok(json.to_string())
    }

    fn recovery_screen(&mut self) -> Result<String, String> {
        let html =
            canvas_edge_agent::recovery_screen::render_recovery_screen(0, 0, self.pkg_version);
        Ok(serde_json::json!({"html": html}).to_string())
    }

    fn audio_list_devices(&mut self) -> Result<String, String> {
        // Helper: parse tab-separated pactl output (index, name, driver, ...) into device names
        let parse_pactl_list = |output: &str| -> Vec<serde_json::Value> {
            output
                .lines()
                .filter(|line| !line.trim().is_empty())
                .filter_map(|line| {
                    let fields: Vec<&str> = line.split('\t').collect();
                    if fields.len() < 2 {
                        return None;
                    }
                    let name = fields[1].trim().to_string();
                    let display_name = if name.contains("bluez_") {
                        format!("{} (Bluetooth)", name)
                    } else {
                        name.clone()
                    };
                    Some(serde_json::json!({"id": name, "name": display_name}))
                })
                .collect()
        };

        let (microphones, speakers) = match (
            std::process::Command::new("pactl")
                .args(["list", "sources", "short"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .output(),
            std::process::Command::new("pactl")
                .args(["list", "sinks", "short"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .output(),
        ) {
            (Ok(src_out), Ok(sink_out))
                if src_out.status.success() && sink_out.status.success() =>
            {
                let src_stdout = String::from_utf8_lossy(&src_out.stdout);
                let sink_stdout = String::from_utf8_lossy(&sink_out.stdout);
                (
                    parse_pactl_list(&src_stdout),
                    parse_pactl_list(&sink_stdout),
                )
            }
            _ => {
                // Fallback hardcoded list if pactl is unavailable
                let fallback_mics = vec![serde_json::json!({"id": "default", "name": "Default"})];
                let fallback_speakers =
                    vec![serde_json::json!({"id": "default", "name": "Default"})];
                (fallback_mics, fallback_speakers)
            }
        };

        let json = serde_json::json!({
            "microphones": microphones,
            "speakers": speakers,
        });
        Ok(json.to_string())
    }

    fn audio_test_mic(&mut self, device: &str, duration_ms: u64) -> Result<String, String> {
        // Decide whether to use parec or arecord
        let use_pulse = !device.starts_with("hw:") && !device.starts_with("plughw:");

        let (cmd, args): (&str, Vec<String>) = if use_pulse {
            let mut args = vec![
                "--format=s16le".to_string(),
                "--rate=16000".to_string(),
                "--channels=1".to_string(),
                // Force small server-side buffers so a short diagnostic capture emits PCM
                // before the child is stopped.
                "--latency-msec=32".to_string(),
            ];
            if device != "default" {
                args.push(format!("--device={}", device));
            }
            ("parec", args)
        } else {
            let alsa_device = if device.starts_with("hw:") {
                device.replacen("hw:", "plughw:", 1)
            } else {
                device.to_string()
            };
            let args = vec![
                "-D".to_string(),
                alsa_device,
                "-f".to_string(),
                "S16_LE".to_string(),
                "-r".to_string(),
                "16000".to_string(),
                "-c".to_string(),
                "1".to_string(),
                "-t".to_string(),
                "raw".to_string(),
            ];
            ("arecord", args)
        };

        let mut child = std::process::Command::new(cmd)
            .args(&args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("failed to spawn {cmd}: {e}"))?;

        let duration = Duration::from_millis(duration_ms);
        thread::sleep(duration);
        let _ = child.kill();
        let output = child
            .wait_with_output()
            .map_err(|e| format!("failed to collect microphone capture: {e}"))?;
        let pcm = output.stdout;
        if pcm.is_empty() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("microphone captured no audio: {}", stderr.trim()));
        }

        // The capture processes emit signed 16-bit mono PCM. Package it as a real WAV so the
        // browser can play the returned sample directly.
        let mut data = Vec::with_capacity(44 + pcm.len());
        let data_len = pcm.len() as u32;
        data.extend_from_slice(b"RIFF");
        data.extend_from_slice(&(36 + data_len).to_le_bytes());
        data.extend_from_slice(b"WAVEfmt ");
        data.extend_from_slice(&16_u32.to_le_bytes());
        data.extend_from_slice(&1_u16.to_le_bytes());
        data.extend_from_slice(&1_u16.to_le_bytes());
        data.extend_from_slice(&16_000_u32.to_le_bytes());
        data.extend_from_slice(&32_000_u32.to_le_bytes());
        data.extend_from_slice(&2_u16.to_le_bytes());
        data.extend_from_slice(&16_u16.to_le_bytes());
        data.extend_from_slice(b"data");
        data.extend_from_slice(&data_len.to_le_bytes());
        data.extend_from_slice(&pcm);

        use base64::{engine::general_purpose::STANDARD, Engine};
        let encoded = STANDARD.encode(&data);
        let json = serde_json::json!({
            "sample": format!("base64:{}", encoded),
            "format": "wav",
            "duration_ms": duration_ms,
        });
        Ok(json.to_string())
    }

    fn audio_test_speaker(&mut self, device: &str, url: &str) -> Result<String, String> {
        let mpv_device = if device == "default" { "pulse" } else { device };
        let status = std::process::Command::new("mpv")
            .args(["--no-video", &format!("--audio-device={}", mpv_device), url])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .status()
            .map_err(|e| format!("failed to spawn mpv: {e}"))?;

        if status.success() {
            Ok(serde_json::json!({ "ok": true, "device": device, "url": url }).to_string())
        } else {
            Err(format!(
                "mpv exited with status: {}",
                status.code().unwrap_or(-1)
            ))
        }
    }
}

/// Implemented by whatever answers the small set of *updater*-scoped queries the Agent exposes to
/// the updater/helper peer (Phase 1 proof-of-concept wiring only). The updater channel is a
/// distinct, role-scoped IPC surface disjoint from the renderer's `CurrentActionHandler`; the
/// broker enforces that a renderer token can never reach these methods and vice versa.
///
/// The broker calls [`UpdaterQueryHandler::agent_version`] only *after* every authorization check
/// (capability validity, role-scoped allowlist membership, single-use nonce) has already passed --
/// this trait is never an authorization boundary and has no access to the capability token or nonce.
pub trait UpdaterQueryHandler: Send {
    /// Returns the Agent's running version string (its `CARGO_PKG_VERSION`). Read-only; takes no
    /// arguments. This is the minimal, honest cross-process query the updater uses to learn what
    /// version of the Agent it is supervising.
    fn agent_version(&mut self) -> Result<String, String>;
}

impl UpdaterQueryHandler for DaemonActionHandler {
    fn agent_version(&mut self) -> Result<String, String> {
        Ok(self.pkg_version.to_string())
    }
}

/// Adapts a [`UpdaterQueryHandler`] into an [`ActionExecutor`] for the `updater.*` allowlist. Only
/// `updater.agent_version` is wired today (the other `updater.*` methods remain unwired server-side
/// handlers); every other allowlisted method falls through to the renderer executor (which itself
/// falls through to the placeholder for methods neither knows about), so wiring this executor in
/// does not change behavior for methods it is not responsible for.
pub struct UpdaterQueryExecutor<H: UpdaterQueryHandler> {
    renderer_executor: Box<dyn ActionExecutor>,
    handler: H,
}

impl<H: UpdaterQueryHandler> UpdaterQueryExecutor<H> {
    pub fn new(renderer_executor: Box<dyn ActionExecutor>, handler: H) -> Self {
        Self {
            renderer_executor,
            handler,
        }
    }
}

impl<H: UpdaterQueryHandler> ActionExecutor for UpdaterQueryExecutor<H> {
    fn execute(
        &mut self,
        role: PeerRole,
        method: &str,
        arguments: Option<&serde_json::Value>,
    ) -> Result<String, String> {
        // This executor is only ever invoked for an `Updater` session (the broker's allowlist gates
        // it), but guard on the role anyway so a future refactor that reuses this executor for other
        // roles cannot accidentally expose the updater query surface.
        if role != PeerRole::Updater {
            return self.renderer_executor.execute(role, method, arguments);
        }
        match method {
            "updater.agent_version" => {
                let version = self.handler.agent_version()?;
                Ok(version)
            }
            _ => self.renderer_executor.execute(role, method, arguments),
        }
    }
}

/// Capability-token generator for the daemon's broker. Mirrors the private
/// `default_token_source` in `edge/agent/src/ipc/broker.rs` (OsRng-backed, `cap_`-prefixed hex)
/// so the daemon's tokens are as strong as the library's default without needing to export that
/// private function.
fn daemon_token_source() -> String {
    use rand::rngs::OsRng;
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    let mut hex = String::with_capacity(bytes.len() * 2 + 4);
    hex.push_str("cap_");
    for byte in bytes {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// Handle to a running IPC server thread, mirroring
/// [`canvas_edge_agent::transport::TransportHandle`]: a join handle plus the shared shutdown flag
/// the caller flips to request a clean stop.
pub struct IpcHandle {
    shutdown: Arc<AtomicBool>,
    join_handle: thread::JoinHandle<()>,
    socket_path: PathBuf,
}

impl IpcHandle {
    /// Signals the IPC thread to stop accepting new connections and blocks until it has exited.
    /// The socket file is unlinked by the thread on its way out (and best-effort again here in
    /// case the thread panicked before reaching its cleanup).
    pub fn shutdown_and_join(self) {
        self.shutdown.store(true, Ordering::SeqCst);
        if let Err(err) = self.join_handle.join() {
            eprintln!("[canvas-edge-agentd] ipc thread panicked during shutdown: {err:?}");
        }
        let _ = fs::remove_file(&self.socket_path);
    }
}

/// Binds a `UnixListener` at `socket_path`, setting the socket file to mode `0600`. Any stale
/// socket file at the path is unlinked first (Unix sockets require this before a re-bind). The
/// parent directory is created with mode `0700` if it does not already exist.
///
/// Returns the listener. Errors here are fatal to the daemon -- a failure to open the IPC socket
/// means the renderer can never reach the Agent, so `main()` should exit rather than silently
/// running without IPC.
pub fn bind_socket(socket_path: &Path) -> io::Result<UnixListener> {
    if let Some(parent) = socket_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
            // Best-effort tighten on the directory; packaging may own this, but ensure it is not
            // world-accessible if the daemon just created it.
            let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
        }
    }

    // Unlink a stale socket file from a previous run before binding. Ignore "not found" -- that
    // is the common, expected case.
    match fs::remove_file(socket_path) {
        Ok(()) => {}
        Err(err) if err.kind() == io::ErrorKind::NotFound => {}
        Err(err) => return Err(err),
    }

    let listener = UnixListener::bind(socket_path)?;
    // The spec requires the socket file itself to be mode 0600. `UnixListener::bind` inherits the
    // process umask; set it explicitly so the mode is correct regardless of the caller's umask.
    fs::set_permissions(socket_path, fs::Permissions::from_mode(SOCKET_FILE_MODE))?;

    Ok(listener)
}

/// Runs the IPC accept/dispatch loop on the current thread until `shutdown` is set. Each accepted
/// connection is authenticated via real `SO_PEERCRED` ([`SoPeercredSource`]), dispatched through
/// the broker, and the response is written back. One request per connection (matching the
/// broker's current Phase 1 framing -- see `edge/agent/src/ipc/broker.rs` module docs).
///
/// The listener is set non-blocking so the loop can poll `shutdown` every
/// [`ACCEPT_POLL_INTERVAL`] rather than blocking forever in `accept()` -- this is what lets the
/// daemon's `Ctrl+C` path join this thread promptly. Accepted streams are flipped back to
/// blocking before request/response I/O so `read_request`/`write_response` block normally.
fn run_accept_loop(
    mut broker: LocalIpcBroker,
    listener: UnixListener,
    shutdown: Arc<AtomicBool>,
    credential_source: &dyn ipc::PeerCredentialSource,
) {
    listener
        .set_nonblocking(true)
        .expect("set IPC listener non-blocking");

    while !shutdown.load(Ordering::SeqCst) {
        match broker.accept(&listener, credential_source) {
            Ok((stream, session)) => {
                // The accepted stream inherits the listener's non-blocking mode on Linux; flip it
                // back so the blocking `read_request`/`write_response` below work as intended.
                let _ = stream.set_nonblocking(false);
                handle_one_connection(&mut broker, &stream, &session);
            }
            Err(AcceptError::Rejected(err)) => {
                // A successfully identified but unauthorized peer. Log and continue; this is a
                // routine "some other local process tried to connect" event, not a fatal error.
                eprintln!("[canvas-edge-agentd] ipc: rejected connection: {err}");
            }
            Err(AcceptError::Io(err)) if err.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(ACCEPT_POLL_INTERVAL);
            }
            Err(AcceptError::Io(err)) => {
                eprintln!("[canvas-edge-agentd] ipc: accept error: {err}");
                thread::sleep(ACCEPT_POLL_INTERVAL);
            }
        }
    }
}

/// Handles one full connection: writes the authenticated session (including the fresh
/// capability token) to the client as the first newline-delimited JSON line, then reads one
/// request, dispatches it, and writes the response back. Any I/O or framing error is logged and
/// the connection is dropped (one bad request does not bring down the broker).
///
/// The capability-token-as-first-response line is the daemon's wire-framing choice, not part of
/// the broker library's Phase 1 framing (the broker itself only defines request/response types;
/// how the client learns its token is the daemon's concern). This is deliberately minimal: a
/// single JSON object `{role, generation, capability_token}` followed by `\n`, before the
/// request/response round-trip. A future, fuller wire protocol would replace this with a proper
/// handshake frame; for now this is what makes the end-to-end path real and testable.
fn handle_one_connection(
    broker: &mut LocalIpcBroker,
    stream: &std::os::unix::net::UnixStream,
    session: &AuthenticatedSession,
) {
    if let Err(err) = write_session(stream, session) {
        eprintln!("[canvas-edge-agentd] ipc: failed to write session to client: {err}");
        return;
    }

    let request = match read_request(stream) {
        Ok(request) => request,
        Err(err) => {
            eprintln!("[canvas-edge-agentd] ipc: failed to read request: {err}");
            return;
        }
    };

    let outcome = broker.dispatch(request);
    if let Err(err) = &outcome {
        eprintln!(
            "[canvas-edge-agentd] ipc: dispatch rejected (role={:?}, generation={}): {}",
            session.role, session.generation, err
        );
    }
    if let Err(err) = write_response(stream, &outcome) {
        eprintln!("[canvas-edge-agentd] ipc: failed to write response: {err}");
    }
}

/// Writes the authenticated session as one newline-delimited JSON line to `stream`. The client
/// reads this first line to learn its role, generation, and capability token before sending its
/// first (and currently only) request.
fn write_session(
    stream: &std::os::unix::net::UnixStream,
    session: &AuthenticatedSession,
) -> io::Result<()> {
    use std::io::Write;
    #[derive(Serialize)]
    struct SessionWire<'a> {
        role: &'a ipc::PeerRole,
        generation: u64,
        capability_token: &'a str,
    }
    let wire = SessionWire {
        role: &session.role,
        generation: session.generation,
        capability_token: &session.capability_token,
    };
    let json = serde_json::to_string(&wire)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
    let mut stream = stream;
    stream.write_all(json.as_bytes())?;
    stream.write_all(b"\n")
}

/// Spawns the IPC server thread and returns a handle for shutdown/join.
///
/// `socket_path` is the path to bind (a stale file there is unlinked first). `renderer_uid` /
/// `updater_uid` configure the broker's peer-identity allowlist (see [`LocalIpcConfig`]). The
/// thread owns its `UnixListener` and unlinks the socket file on exit.
///
/// This is the function `main()` calls and the integration test in
/// `edge/agentd/tests/ipc_wiring_v1.rs` calls directly -- keeping all of the IPC lifecycle in one
/// testable place rather than inlining it into `main()`.
pub fn serve_ipc(
    socket_path: PathBuf,
    renderer_uid: u32,
    updater_uid: u32,
) -> io::Result<IpcHandle> {
    serve_ipc_with_identity(socket_path, renderer_uid, updater_uid, "", "", "")
}

/// Starts the IPC server with the stable identity returned by `agent.device_identity`.
pub fn serve_ipc_with_identity(
    socket_path: PathBuf,
    renderer_uid: u32,
    updater_uid: u32,
    device_id: &str,
    installation_id: &str,
    public_key_fingerprint: &str,
) -> io::Result<IpcHandle> {
    serve_ipc_with_hardware_and_audio_and_identity(
        socket_path,
        renderer_uid,
        updater_uid,
        HardwareAdapters::new_real(),
        AudioAdapters::new_real(),
        device_id,
        installation_id,
        public_key_fingerprint,
    )
}

/// Same as [`serve_ipc`] but with an injectable [`HardwareAdapters`] bundle, so the integration
/// tests in `edge/agentd/tests/ipc_wiring_v1.rs` can assert that `display.screen_off`/
/// `screen_on`/`set_brightness` actually call the hardware adapters (via injected fakes) rather
/// than just logging. Production (`main()`) calls [`serve_ipc`], which wires in the real adapters.
/// Audio adapters default to real (`AudioAdapters::new_real()`); use
/// [`serve_ipc_with_hardware_and_audio`] to inject audio fakes too.
pub fn serve_ipc_with_hardware(
    socket_path: PathBuf,
    renderer_uid: u32,
    updater_uid: u32,
    hardware: HardwareAdapters,
) -> io::Result<IpcHandle> {
    serve_ipc_with_hardware_and_identity(
        socket_path,
        renderer_uid,
        updater_uid,
        hardware,
        "",
        "",
        "",
    )
}

/// Injectable-hardware variant with stable device identity.
pub fn serve_ipc_with_hardware_and_identity(
    socket_path: PathBuf,
    renderer_uid: u32,
    updater_uid: u32,
    hardware: HardwareAdapters,
    device_id: &str,
    installation_id: &str,
    public_key_fingerprint: &str,
) -> io::Result<IpcHandle> {
    serve_ipc_with_hardware_and_audio_and_identity(
        socket_path,
        renderer_uid,
        updater_uid,
        hardware,
        AudioAdapters::new_real(),
        device_id,
        installation_id,
        public_key_fingerprint,
    )
}

/// Same as [`serve_ipc_with_hardware`] but with an injectable [`AudioAdapters`] bundle too, so the
/// integration tests in `edge/agentd/tests/ipc_wiring_v1.rs` can assert that `audio.play`/`pause`/
/// `stop`/`set_volume` actually call the audio adapters (via injected fakes) rather than just
/// logging. Production (`main()`) calls [`serve_ipc`], which wires in the real adapters.
pub fn serve_ipc_with_hardware_and_audio(
    socket_path: PathBuf,
    renderer_uid: u32,
    updater_uid: u32,
    hardware: HardwareAdapters,
    audio: AudioAdapters,
) -> io::Result<IpcHandle> {
    serve_ipc_with_hardware_and_audio_and_identity(
        socket_path,
        renderer_uid,
        updater_uid,
        hardware,
        audio,
        "",
        "",
        "",
    )
}

/// Injectable hardware/audio variant with stable device identity.
#[allow(clippy::too_many_arguments)]
pub fn serve_ipc_with_hardware_and_audio_and_identity(
    socket_path: PathBuf,
    renderer_uid: u32,
    updater_uid: u32,
    hardware: HardwareAdapters,
    audio: AudioAdapters,
    device_id: &str,
    installation_id: &str,
    public_key_fingerprint: &str,
) -> io::Result<IpcHandle> {
    let listener = bind_socket(&socket_path)?;
    println!(
        "[canvas-edge-agentd] ipc: listening on {} (renderer_uid={renderer_uid}, updater_uid={updater_uid})",
        socket_path.display()
    );

    let handler = DaemonActionHandler::with_hardware_and_audio(
        hardware,
        audio,
        device_id,
        installation_id,
        public_key_fingerprint,
    );
    let broker = LocalIpcBroker::with_token_source_and_executor(
        LocalIpcConfig {
            renderer_uid,
            updater_uid,
        },
        daemon_token_source,
        UpdaterQueryExecutor::new(
            Box::new(CurrentActionExecutor::new(handler)),
            DaemonActionHandler::default(),
        ),
    );

    let shutdown = Arc::new(AtomicBool::new(false));
    let shutdown_for_thread = Arc::clone(&shutdown);
    let owned_socket_path = socket_path.clone();

    let join_handle = std::thread::Builder::new()
        .name("canvas-edge-ipc".to_string())
        .spawn(move || {
            run_accept_loop(broker, listener, shutdown_for_thread, &SoPeercredSource);
            // Clean up the socket file on the way out so a restart does not trip over a stale one.
            let _ = fs::remove_file(&owned_socket_path);
        })
        .expect("failed to spawn the canvas-edge-ipc OS thread");

    Ok(IpcHandle {
        shutdown,
        join_handle,
        socket_path,
    })
}

/// Like [`serve_ipc_with_hardware_and_audio`] but also wires in a [`MediaAdapters`] bundle so the
/// `media.*` IPC methods (YouTube play/status/state, radio play/stop/state) are dispatched to real
/// or fake media adapters. Tests use this to inject fake YouTube/Radio adapters with call logs.
#[allow(clippy::too_many_arguments)]
pub fn serve_ipc_with_hardware_audio_and_media(
    socket_path: PathBuf,
    renderer_uid: u32,
    updater_uid: u32,
    hardware: HardwareAdapters,
    audio: AudioAdapters,
    media: MediaAdapters,
    device_id: &str,
    installation_id: &str,
    public_key_fingerprint: &str,
) -> io::Result<IpcHandle> {
    let listener = bind_socket(&socket_path)?;
    println!(
        "[canvas-edge-agentd] ipc: listening on {} (renderer_uid={renderer_uid}, updater_uid={updater_uid})",
        socket_path.display()
    );

    let handler = DaemonActionHandler::with_hardware_audio_and_media(
        hardware,
        audio,
        media,
        device_id,
        installation_id,
        public_key_fingerprint,
    );
    let broker = LocalIpcBroker::with_token_source_and_executor(
        LocalIpcConfig {
            renderer_uid,
            updater_uid,
        },
        daemon_token_source,
        UpdaterQueryExecutor::new(
            Box::new(CurrentActionExecutor::new(handler)),
            DaemonActionHandler::default(),
        ),
    );

    let shutdown = Arc::new(AtomicBool::new(false));
    let shutdown_for_thread = Arc::clone(&shutdown);
    let owned_socket_path = socket_path.clone();

    let join_handle = std::thread::Builder::new()
        .name("canvas-edge-ipc".to_string())
        .spawn(move || {
            run_accept_loop(broker, listener, shutdown_for_thread, &SoPeercredSource);
            let _ = fs::remove_file(&owned_socket_path);
        })
        .expect("failed to spawn the canvas-edge-ipc OS thread");

    Ok(IpcHandle {
        shutdown,
        join_handle,
        socket_path,
    })
}
