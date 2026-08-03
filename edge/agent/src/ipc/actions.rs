//! Forwarding an authenticated, allowlisted [`crate::ipc::DispatchRequest`] into a real,
//! typed Agent-side action -- instead of [`crate::ipc::LocalIpcBroker::dispatch`] returning a
//! synthetic `"{method}:accepted"` placeholder for every method regardless of what it does.
//!
//! This module implements the Phase 1 checklist item "Forward a small allowlisted set of current
//! renderer actions through IPC" (architecture plan §25). The renderer methods it forwards are
//! deliberately the small, *current* set the kiosk renderer already invokes today via direct
//! Tauri `invoke()` calls in `browser/linux/src-tauri/src/lib.rs` (`screen_off`, `screen_on`,
//! `set_brightness`, `app_version`) -- not a larger, speculative future action set. Wiring the
//! actual Tauri renderer to call through this IPC layer instead of `invoke()` directly is
//! out of scope here (`browser/linux` is a separate TypeScript/Tauri app, not part of this Rust
//! workspace); this module proves the Agent-side forwarding mechanism a future renderer change
//! would call into.
//!
//! The broker calls [`ActionExecutor::execute`] only *after* every authorization check
//! (capability validity, role-scoped allowlist membership, updater nonce) has already passed --
//! this trait is never a place to re-check authorization, and it has no access to the capability
//! token or nonce at all.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ipc::broker::PeerRole;

/// Implemented by whatever the Agent wires up to actually perform allowlisted renderer/updater
/// actions: real hardware/session calls in production, a recording stub in tests. See the module
/// docs for why this is never itself an authorization boundary.
pub trait ActionExecutor: Send {
    /// Executes `method` for `role` with the given (already-allowlisted) `arguments`. Returns an
    /// opaque result string on success, or a human-readable failure reason. Execution failures
    /// are surfaced to the caller as [`crate::ipc::LocalIpcErrorCode::ExecutionFailed`] -- a
    /// distinct code from every authorization rejection code, so a caller can tell "you weren't
    /// allowed to call this" apart from "you were allowed, but it failed."
    fn execute(
        &mut self,
        role: PeerRole,
        method: &str,
        arguments: Option<&Value>,
    ) -> Result<String, String>;
}

/// Default executor used when a [`crate::ipc::LocalIpcBroker`] is constructed without an
/// explicit one via [`crate::ipc::LocalIpcBroker::new`]/[`crate::ipc::LocalIpcBroker::with_token_source`].
/// Preserves the original placeholder behavior (`"{method}:accepted"`), so every caller/test that
/// predates this module keeps working unchanged.
#[derive(Debug, Default)]
pub struct PlaceholderActionExecutor;

impl ActionExecutor for PlaceholderActionExecutor {
    fn execute(
        &mut self,
        _role: PeerRole,
        method: &str,
        _arguments: Option<&Value>,
    ) -> Result<String, String> {
        Ok(format!("{method}:accepted"))
    }
}

/// One recorded call, for tests/diagnostics that need to assert real dispatch-to-executor wiring
/// (which role, which method, with which arguments) without needing actual hardware.
#[derive(Debug, Clone, PartialEq)]
pub struct RecordedCall {
    pub role: PeerRole,
    pub method: String,
    pub arguments: Option<Value>,
}

/// Test/diagnostic executor that records every call it receives and returns a canned
/// `"{method}:executed"` result (distinct from the placeholder's `"{method}:accepted"`, so tests
/// can tell "the real executor ran" apart from "the default placeholder ran").
#[derive(Debug, Default)]
pub struct RecordingActionExecutor {
    pub calls: Vec<RecordedCall>,
}

impl ActionExecutor for RecordingActionExecutor {
    fn execute(
        &mut self,
        role: PeerRole,
        method: &str,
        arguments: Option<&Value>,
    ) -> Result<String, String> {
        self.calls.push(RecordedCall {
            role,
            method: method.to_string(),
            arguments: arguments.cloned(),
        });
        Ok(format!("{method}:executed"))
    }
}

/// The small, current set of renderer actions this executor forwards, named after the real Tauri
/// commands they stand in for (`browser/linux/src-tauri/src/lib.rs`) plus the audio actions the
/// Node sidecar previously handled at `server/src/routes/audio.ts`. Kept separate from the
/// illustrative `hardware.*`/`scene.*`/`media.*` method names already in
/// [`crate::ipc::broker`]'s allowlists, which remain unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CurrentRendererAction {
    /// Forwards to the real `screen_off` Tauri command.
    ScreenOff,
    /// Forwards to the real `screen_on` Tauri command.
    ScreenOn,
    /// Forwards to the real `set_brightness` Tauri command. Expects `arguments` to be a JSON
    /// object with a numeric `level` field; [`CurrentActionExecutor`] rejects anything else.
    SetBrightness,
    /// Forwards to the real `app_version` Tauri command (read-only; takes no arguments).
    AppVersion,
    /// Forwards to the audio playback adapter's `play(url, volume)`. Expects `arguments` to be a
    /// JSON object with a string `url` field and an optional numeric `volume` field (0–100).
    AudioPlay,
    /// Forwards to the audio playback adapter's `pause()`.
    AudioPause,
    /// Forwards to the audio playback adapter's `resume()`.
    AudioResume,
    /// Forwards to the audio playback adapter's `stop()`.
    AudioStop,
    /// Forwards to the volume adapter's `set_volume(level)` (and updates the running mpv's
    /// volume if playing). Expects `arguments` to be a JSON object with a numeric `level` field
    /// (0–100).
    AudioSetVolume,
    /// Forwards to the volume adapter's `set_mute(muted)`. Expects `arguments` to be a JSON
    /// object with a boolean `muted` field.
    AudioSetMute,
    /// Returns the current playback + volume state as a JSON object string. Read-only.
    AudioState,
    /// Resolves a YouTube player URL for the renderer to load. Expects `arguments` to be a JSON
    /// object with either a string `query` field (free-text search) or a string `video_id` field
    /// (direct play), plus an optional string `api_key` field. Returns a JSON object with the
    /// player URL, video ID, playback ID, and candidate list.
    MediaYoutubePlay,
    /// Records a YouTube player event reported by the renderer's IFrame Player. Expects
    /// `arguments` to be a JSON object with `playback_id`, `event`, optional `video_id`, and
    /// optional `error_code` fields. Mirrors the sidecar's `/api/media/youtube/player-event`
    /// callback.
    MediaYoutubeStatus,
    /// Returns the current YouTube playback status + candidate IDs as a JSON object string.
    /// Read-only.
    MediaYoutubeState,
    /// Resolves a radio station for `query` and plays it via the audio playback adapter (mpv).
    /// Expects `arguments` to be a JSON object with a string `query` field. Returns a JSON object
    /// with the station metadata.
    MediaRadioPlay,
    /// Stops radio playback (stops the running mpv).
    MediaRadioStop,
    /// Returns the current radio playback state as a JSON object string. Read-only.
    MediaRadioState,
    /// Returns the recovery screen HTML with live crash count and time-since-last-crash.
    /// Read-only; takes no arguments.
    RecoveryScreen,
    /// Returns the Edge device's stable identity as a JSON object with `device_id`,
    /// `installation_id`, and `public_key_fingerprint`. Read-only; takes no arguments.
    DeviceIdentity,
    /// Lists available audio input (microphone) and output (speaker) devices by running `pactl`.
    /// Read-only; takes no arguments.
    AudioListDevices,
    /// Captures a short audio sample from the given mic device, encodes it as base64, and returns
    /// a JSON object with `sample`, `format`, and `duration_ms`.
    AudioTestMic,
    /// Plays a test tone (or arbitrary URL) through the given speaker device via `mpv`.
    AudioTestSpeaker,
}

impl CurrentRendererAction {
    pub fn method_name(self) -> &'static str {
        match self {
            CurrentRendererAction::ScreenOff => "display.screen_off",
            CurrentRendererAction::ScreenOn => "display.screen_on",
            CurrentRendererAction::SetBrightness => "display.set_brightness",
            CurrentRendererAction::AppVersion => "agent.app_version",
            CurrentRendererAction::AudioPlay => "audio.play",
            CurrentRendererAction::AudioPause => "audio.pause",
            CurrentRendererAction::AudioResume => "audio.resume",
            CurrentRendererAction::AudioStop => "audio.stop",
            CurrentRendererAction::AudioSetVolume => "audio.set_volume",
            CurrentRendererAction::AudioSetMute => "audio.set_mute",
            CurrentRendererAction::AudioState => "audio.state",
            CurrentRendererAction::MediaYoutubePlay => "media.youtube.play",
            CurrentRendererAction::MediaYoutubeStatus => "media.youtube.status",
            CurrentRendererAction::MediaYoutubeState => "media.youtube.state",
            CurrentRendererAction::MediaRadioPlay => "media.radio.play",
            CurrentRendererAction::MediaRadioStop => "media.radio.stop",
            CurrentRendererAction::MediaRadioState => "media.radio.state",
            CurrentRendererAction::RecoveryScreen => "renderer.recovery_screen",
            CurrentRendererAction::DeviceIdentity => "agent.device_identity",
            CurrentRendererAction::AudioListDevices => "audio.list_devices",
            CurrentRendererAction::AudioTestMic => "audio.test_mic",
            CurrentRendererAction::AudioTestSpeaker => "audio.test_speaker",
        }
    }

    fn from_method_name(method: &str) -> Option<Self> {
        match method {
            "display.screen_off" => Some(CurrentRendererAction::ScreenOff),
            "display.screen_on" => Some(CurrentRendererAction::ScreenOn),
            "display.set_brightness" => Some(CurrentRendererAction::SetBrightness),
            "agent.app_version" => Some(CurrentRendererAction::AppVersion),
            "audio.play" => Some(CurrentRendererAction::AudioPlay),
            "audio.pause" => Some(CurrentRendererAction::AudioPause),
            "audio.resume" => Some(CurrentRendererAction::AudioResume),
            "audio.stop" => Some(CurrentRendererAction::AudioStop),
            "audio.set_volume" => Some(CurrentRendererAction::AudioSetVolume),
            "audio.set_mute" => Some(CurrentRendererAction::AudioSetMute),
            "audio.state" => Some(CurrentRendererAction::AudioState),
            "media.youtube.play" => Some(CurrentRendererAction::MediaYoutubePlay),
            "media.youtube.status" => Some(CurrentRendererAction::MediaYoutubeStatus),
            "media.youtube.state" => Some(CurrentRendererAction::MediaYoutubeState),
            "media.radio.play" => Some(CurrentRendererAction::MediaRadioPlay),
            "media.radio.stop" => Some(CurrentRendererAction::MediaRadioStop),
            "media.radio.state" => Some(CurrentRendererAction::MediaRadioState),
            "renderer.recovery_screen" => Some(CurrentRendererAction::RecoveryScreen),
            "agent.device_identity" => Some(CurrentRendererAction::DeviceIdentity),
            "audio.list_devices" => Some(CurrentRendererAction::AudioListDevices),
            "audio.test_mic" => Some(CurrentRendererAction::AudioTestMic),
            "audio.test_speaker" => Some(CurrentRendererAction::AudioTestSpeaker),
            _ => None,
        }
    }
}

/// Implemented by whatever actually performs the small set of current renderer actions in
/// [`CurrentRendererAction`] (real display/hardware/audio calls in production; a recording stub
/// in tests). [`CurrentActionExecutor`] is the [`ActionExecutor`] adapter that parses the wire
/// method name into a [`CurrentRendererAction`] and validates arguments before calling this.
pub trait CurrentActionHandler: Send {
    fn screen_off(&mut self) -> Result<(), String>;
    fn screen_on(&mut self) -> Result<(), String>;
    fn set_brightness(&mut self, level: u8) -> Result<(), String>;
    fn app_version(&mut self) -> Result<String, String>;
    /// Spawns `mpv` for `url` at `volume` (0–100), killing any previously-spawned `mpv` first.
    fn audio_play(&mut self, url: &str, volume: u8) -> Result<(), String>;
    /// Pauses the running `mpv`.
    fn audio_pause(&mut self) -> Result<(), String>;
    /// Resumes the paused `mpv`.
    fn audio_resume(&mut self) -> Result<(), String>;
    /// Kills the running `mpv`.
    fn audio_stop(&mut self) -> Result<(), String>;
    /// Sets the system volume (and the running mpv's volume if playing). `level` is 0–100.
    fn audio_set_volume(&mut self, level: u8) -> Result<(), String>;
    /// Mutes or unmutes the default sink.
    fn audio_set_mute(&mut self, muted: bool) -> Result<(), String>;
    /// Returns the current playback + volume state as a JSON object string.
    fn audio_state(&mut self) -> Result<String, String>;
    /// Resolves a YouTube player URL for the renderer to load. `query` is the free-text search
    /// (empty if `video_id` is given directly); `video_id` is the direct video ID (empty if
    /// `query` should be searched); `api_key` is the YouTube Data API v3 key (may be empty, in
    /// which case the adapter returns an error for query-based search). Returns a JSON object
    /// string with `url`, `video_id`, `playback_id`, and `candidates`.
    fn media_youtube_play(
        &mut self,
        query: &str,
        video_id: &str,
        api_key: &str,
    ) -> Result<String, String>;
    /// Records a YouTube player event reported by the renderer. The handler validates `event`
    /// against the allowed set before recording. Returns `Ok("{ok:true,stale:false}")` if the
    /// event matched the current playback, or `Ok("{ok:true,stale:true}")` if it was a stale
    /// callback for a previous playback (mirroring the sidecar's behavior of accepting stale
    /// callbacks without error).
    fn media_youtube_status(
        &mut self,
        playback_id: &str,
        event: &str,
        video_id: &str,
        error_code: Option<i64>,
    ) -> Result<String, String>;
    /// Returns the current YouTube playback status + candidate IDs as a JSON object string.
    fn media_youtube_state(&mut self) -> Result<String, String>;
    /// Resolves a radio station for `query` and plays it via the audio playback adapter. Returns
    /// a JSON object string with the station metadata (`name`, `stream_url`, `provider`,
    /// `artwork`, `homepage`).
    fn media_radio_play(&mut self, query: &str) -> Result<String, String>;
    /// Stops radio playback (stops the running mpv).
    fn media_radio_stop(&mut self) -> Result<(), String>;
    /// Returns the current radio playback state as a JSON object string. Read-only.
    fn media_radio_state(&mut self) -> Result<String, String>;
    /// Returns the recovery screen HTML with live crash count and time-since-last-crash.
    /// Read-only; takes no arguments.
    fn recovery_screen(&mut self) -> Result<String, String>;
    /// Returns the Edge device's stable identity as a JSON object with `device_id`,
    /// `installation_id`, and `public_key_fingerprint`. Read-only; takes no arguments.
    fn device_identity(&mut self) -> Result<String, String>;
    /// Lists available audio input/output devices by running `pactl`. Returns a JSON object with
    /// `"microphones"` and `"speakers"` arrays.
    fn audio_list_devices(&mut self) -> Result<String, String> {
        Err("audio.list_devices is not implemented".to_string())
    }
    /// Captures a short audio sample from `device` for `duration_ms`, returns it base64-encoded
    /// as a JSON object `{ sample, format, duration_ms }`.
    fn audio_test_mic(&mut self, _device: &str, _duration_ms: u64) -> Result<String, String> {
        Err("audio.test_mic is not implemented".to_string())
    }
    /// Plays a test tone (or arbitrary URL) through `device` via `mpv`.
    fn audio_test_speaker(&mut self, _device: &str, _url: &str) -> Result<String, String> {
        Err("audio.test_speaker is not implemented".to_string())
    }
}

/// Adapts a [`CurrentActionHandler`] into an [`ActionExecutor`]: parses the wire method name,
/// validates/extracts arguments (rejecting anything malformed *before* calling the handler, so a
/// handler implementation never has to defend against a malformed `set_brightness` payload), and
/// only forwards methods in [`CurrentRendererAction`] -- everything else falls through to the
/// broker's existing `PlaceholderActionExecutor` behavior via [`Self::fallback`].
pub struct CurrentActionExecutor<H: CurrentActionHandler> {
    handler: H,
}

impl<H: CurrentActionHandler> CurrentActionExecutor<H> {
    pub fn new(handler: H) -> Self {
        Self { handler }
    }
}

impl<H: CurrentActionHandler> ActionExecutor for CurrentActionExecutor<H> {
    fn execute(
        &mut self,
        role: PeerRole,
        method: &str,
        arguments: Option<&Value>,
    ) -> Result<String, String> {
        let Some(action) = CurrentRendererAction::from_method_name(method) else {
            // Not one of the small current-action set this executor knows about -- preserve the
            // original placeholder behavior for every other allowlisted method (e.g. the
            // illustrative `scene.activate`/`media.session.control` methods), so wiring this
            // executor in does not silently change behavior for methods it isn't responsible for.
            return PlaceholderActionExecutor.execute(role, method, arguments);
        };

        match action {
            CurrentRendererAction::ScreenOff => {
                self.handler.screen_off()?;
                Ok(format!("{method}:executed"))
            }
            CurrentRendererAction::ScreenOn => {
                self.handler.screen_on()?;
                Ok(format!("{method}:executed"))
            }
            CurrentRendererAction::SetBrightness => {
                let level = arguments
                    .and_then(|value| value.get("level"))
                    .and_then(Value::as_u64)
                    .ok_or_else(|| {
                        "set_brightness requires an integer 'level' argument".to_string()
                    })?;
                let level: u8 = level
                    .try_into()
                    .map_err(|_| "set_brightness 'level' must fit in 0..=255".to_string())?;
                self.handler.set_brightness(level)?;
                Ok(format!("{method}:executed"))
            }
            CurrentRendererAction::AppVersion => {
                let version = self.handler.app_version()?;
                Ok(version)
            }
            CurrentRendererAction::AudioPlay => {
                let url = arguments
                    .and_then(|value| value.get("url"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| "audio.play requires a string 'url' argument".to_string())?;
                let volume = arguments
                    .and_then(|value| value.get("volume"))
                    .and_then(Value::as_u64)
                    .map(|v| v.clamp(0, 100) as u8);
                // If `volume` is omitted, pass 0 and let the handler fall back to its last
                // recorded volume (the sidecar's behavior: `volume ?? _state.volume`). The
                // handler knows its own last volume; the executor does not.
                let volume = volume.unwrap_or(0);
                self.handler.audio_play(url, volume)?;
                Ok(format!("{method}:executed"))
            }
            CurrentRendererAction::AudioPause => {
                self.handler.audio_pause()?;
                Ok(format!("{method}:executed"))
            }
            CurrentRendererAction::AudioResume => {
                self.handler.audio_resume()?;
                Ok(format!("{method}:executed"))
            }
            CurrentRendererAction::AudioStop => {
                self.handler.audio_stop()?;
                Ok(format!("{method}:executed"))
            }
            CurrentRendererAction::AudioSetVolume => {
                let level = arguments
                    .and_then(|value| value.get("level"))
                    .and_then(Value::as_u64)
                    .ok_or_else(|| {
                        "audio.set_volume requires an integer 'level' argument".to_string()
                    })?;
                let level: u8 = level
                    .try_into()
                    .map_err(|_| "audio.set_volume 'level' must fit in 0..=255".to_string())?;
                self.handler.audio_set_volume(level)?;
                Ok(format!("{method}:executed"))
            }
            CurrentRendererAction::AudioSetMute => {
                let muted = arguments
                    .and_then(|value| value.get("muted"))
                    .and_then(Value::as_bool)
                    .ok_or_else(|| {
                        "audio.set_mute requires a boolean 'muted' argument".to_string()
                    })?;
                self.handler.audio_set_mute(muted)?;
                Ok(format!("{method}:executed"))
            }
            CurrentRendererAction::AudioState => {
                let state = self.handler.audio_state()?;
                Ok(state)
            }
            CurrentRendererAction::MediaYoutubePlay => {
                let query = arguments
                    .and_then(|value| value.get("query"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let video_id = arguments
                    .and_then(|value| value.get("video_id"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let api_key = arguments
                    .and_then(|value| value.get("api_key"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if query.is_empty() && video_id.is_empty() {
                    return Err(
                        "media.youtube.play requires a 'query' or 'video_id' argument".to_string(),
                    );
                }
                self.handler.media_youtube_play(query, video_id, api_key)
            }
            CurrentRendererAction::MediaYoutubeStatus => {
                let playback_id = arguments
                    .and_then(|value| value.get("playback_id"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        "media.youtube.status requires a string 'playback_id' argument".to_string()
                    })?;
                let event = arguments
                    .and_then(|value| value.get("event"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        "media.youtube.status requires a string 'event' argument".to_string()
                    })?;
                let video_id = arguments
                    .and_then(|value| value.get("video_id"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let error_code = arguments
                    .and_then(|value| value.get("error_code"))
                    .and_then(|value| value.as_i64());
                self.handler
                    .media_youtube_status(playback_id, event, video_id, error_code)
            }
            CurrentRendererAction::MediaYoutubeState => self.handler.media_youtube_state(),
            CurrentRendererAction::MediaRadioPlay => {
                let query = arguments
                    .and_then(|value| value.get("query"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        "media.radio.play requires a string 'query' argument".to_string()
                    })?;
                self.handler.media_radio_play(query)
            }
            CurrentRendererAction::MediaRadioStop => {
                self.handler.media_radio_stop()?;
                Ok(format!("{method}:executed"))
            }
            CurrentRendererAction::MediaRadioState => self.handler.media_radio_state(),
            CurrentRendererAction::RecoveryScreen => self.handler.recovery_screen(),
            CurrentRendererAction::DeviceIdentity => self.handler.device_identity(),
            CurrentRendererAction::AudioListDevices => self.handler.audio_list_devices(),
            CurrentRendererAction::AudioTestMic => {
                let device = arguments
                    .and_then(|value| value.get("device"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        "audio.test_mic requires a string 'device' argument".to_string()
                    })?;
                let duration_ms = arguments
                    .and_then(|value| value.get("duration_ms"))
                    .and_then(Value::as_u64)
                    .unwrap_or(3000);
                self.handler.audio_test_mic(device, duration_ms)
            }
            CurrentRendererAction::AudioTestSpeaker => {
                let device = arguments
                    .and_then(|value| value.get("device"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        "audio.test_speaker requires a string 'device' argument".to_string()
                    })?;
                let url = arguments
                    .and_then(|value| value.get("url"))
                    .and_then(Value::as_str)
                    .unwrap_or("https://www.soundjay.com/buttons/sounds/beep-01a.wav");
                self.handler.audio_test_speaker(device, url)
            }
        }
    }
}
