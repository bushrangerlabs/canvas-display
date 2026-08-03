//! Real, best-effort OS/hardware capability probing.
//!
//! [`SystemCapabilityProbe`] is the injectable-dependency seam, following the exact convention
//! already used by `ipc::peer::PeerCredentialSource` (`SoPeercredSource` for production,
//! `FakePeerCredentialSource` for tests): production code always uses
//! [`RealSystemCapabilityProbe`], which performs genuine filesystem/`PATH` inspection, while tests
//! that want a fixed, non-machine-dependent answer use [`FakeSystemCapabilityProbe`].
//!
//! What is genuinely detected here (see [`RealSystemCapabilityProbe`] docs for exact rules):
//! - Backlight/brightness control, from the presence of `/sys/class/backlight/*/brightness`.
//! - An `mpv` binary, from a real, direct scan of `PATH` entries (no subprocess is spawned).
//!
//! Everything else [`CapabilityDetector::detect`] reports ([`crate::capabilities::HARDWARE_DPMS`],
//! the `canvas-scene-v1` renderer, and the voice capability list) is a static/assumed value, not a
//! deep hardware probe -- see that function's doc comment for exactly why each one is safe to
//! assert unconditionally today.

use std::fs;
use std::path::{Path, PathBuf};

use crate::protocol::{
    AgentInfoArchitecture, EdgeCapabilities, EdgeCapabilitiesHardwareItem,
    EdgeCapabilitiesMediaItem, EdgeCapabilitiesRendererItem, EdgeCapabilitiesVoiceItem,
};

/// Hardware capability string reported when at least one backlight device is detected under
/// `/sys/class/backlight`. Matches the literal Core already expects (see the pre-existing
/// hardcoded value this replaces in `session::state::EdgeSession::create_hello`).
pub const HARDWARE_BRIGHTNESS: &str = "brightness";

/// Hardware capability string for display power management (DPMS). Not deep-probed -- see
/// [`CapabilityDetector::detect`] doc comment for why this is reported unconditionally on Linux.
pub const HARDWARE_DPMS: &str = "dpms";

/// Renderer capability string for the bundled Canvas scene renderer. Static: this renderer is
/// compiled into every build of this Agent, so its presence is a build-time fact, not something
/// that needs a runtime probe.
pub const RENDERER_CANVAS_SCENE_V1: &str = "canvas-scene-v1";

/// Media capability string for the YouTube iframe player embedded in the bundled renderer.
/// Static, for the same reason as [`RENDERER_CANVAS_SCENE_V1`].
pub const MEDIA_YOUTUBE_IFRAME: &str = "youtube-iframe";

/// Media capability string reported when an `mpv` executable is found on `PATH`.
pub const MEDIA_MPV: &str = "mpv";

/// Voice capability strings. **Not currently backed by any real detection** -- the local
/// wake-word/voice pipeline itself does not exist yet (see
/// `docs/CANVAS_CORE_EDGE_ARCHITECTURE_PLAN.md` Phase 1 progress snapshot's "still fully open"
/// list). These are carried over unchanged from the previous hardcoded `create_hello` value so
/// this module's introduction does not silently change today's wire behavior; a future task that
/// implements the voice pipeline should replace these with a real probe (e.g. "is a wake-word
/// model file installed", "can the Opus encoder be initialized") the same way [`MEDIA_MPV`] is
/// real today.
pub const VOICE_WAKEWORD_LOCAL: &str = "wakeword-local";
pub const VOICE_OPUS_WSS: &str = "opus-wss";

/// Resolves genuinely-checkable OS/hardware capability facts. Implementations must never panic or
/// block indefinitely -- capability detection runs during Agent startup/hello, and a crash here
/// would take down the whole daemon over what is, at worst, a missing optional feature.
pub trait SystemCapabilityProbe {
    /// Whether at least one backlight-controllable display device is present.
    fn has_backlight(&self) -> bool;

    /// Whether an `mpv` executable is available for this Agent to launch.
    fn has_mpv_on_path(&self) -> bool;
}

/// Production probe: inspects the real filesystem and (by default) the real `PATH` environment
/// variable. Never panics -- any I/O error (missing directory, permission denied, etc.) is treated
/// as "capability not present," which is exactly what we want in the field: an Edge device without
/// a `/sys/class/backlight` directory (e.g. a desktop monitor with no kernel backlight driver)
/// should simply not claim the `brightness` hardware capability, not crash the Agent.
pub struct RealSystemCapabilityProbe {
    backlight_base: PathBuf,
    path_env: String,
}

impl RealSystemCapabilityProbe {
    /// Production constructor: probes the real `/sys/class/backlight` directory and the current
    /// process's real `PATH` environment variable (empty string if `PATH` is unset, which simply
    /// means "no directories to search," not an error).
    pub fn new() -> Self {
        Self {
            backlight_base: PathBuf::from("/sys/class/backlight"),
            path_env: std::env::var("PATH").unwrap_or_default(),
        }
    }

    /// Test/inspection constructor: probes `backlight_base` instead of the real
    /// `/sys/class/backlight`, and treats `path_env` as an explicit `:`-separated search list
    /// instead of reading the real `PATH` environment variable.
    ///
    /// This exists so tests can exercise the *real* [`SystemCapabilityProbe`] filesystem-walking
    /// logic (not just a fake) against a throwaway directory built with `tempfile`, without ever
    /// touching or depending on the state of the real machine's `/sys` tree or `PATH`. See
    /// `tests/capabilities_v1.rs` for exactly this.
    pub fn with_paths(backlight_base: impl Into<PathBuf>, path_env: impl Into<String>) -> Self {
        Self {
            backlight_base: backlight_base.into(),
            path_env: path_env.into(),
        }
    }
}

impl Default for RealSystemCapabilityProbe {
    fn default() -> Self {
        Self::new()
    }
}

impl SystemCapabilityProbe for RealSystemCapabilityProbe {
    fn has_backlight(&self) -> bool {
        // `read_dir` returns `Err` when the directory doesn't exist (the common case on
        // desktops/VMs with no kernel backlight driver) or isn't readable. Either way, that means
        // "no detected backlight capability," not a fatal condition.
        let Ok(entries) = fs::read_dir(&self.backlight_base) else {
            return false;
        };

        for entry in entries.flatten() {
            let brightness_file = entry.path().join("brightness");
            if brightness_file.is_file() {
                return true;
            }
        }

        false
    }

    fn has_mpv_on_path(&self) -> bool {
        for dir in self.path_env.split(':') {
            if dir.is_empty() {
                continue;
            }
            let candidate = Path::new(dir).join("mpv");
            if is_executable_file(&candidate) {
                return true;
            }
        }

        false
    }
}

/// Returns whether `path` is a regular file with at least one executable-permission bit set. This
/// is a direct filesystem check equivalent to what a `which mpv` shell-out would tell us, without
/// actually spawning a subprocess (which would be slower, less portable, and harder to unit test).
fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }

    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}

/// Test-only probe that returns fixed, injected answers regardless of the real machine's actual
/// hardware. Not used by any production code path. Mirrors
/// `ipc::peer::FakePeerCredentialSource`'s role for `PeerCredentialSource`.
#[derive(Debug, Clone, Copy, Default)]
pub struct FakeSystemCapabilityProbe {
    pub backlight_present: bool,
    pub mpv_present: bool,
}

impl FakeSystemCapabilityProbe {
    pub fn new(backlight_present: bool, mpv_present: bool) -> Self {
        Self {
            backlight_present,
            mpv_present,
        }
    }
}

impl SystemCapabilityProbe for FakeSystemCapabilityProbe {
    fn has_backlight(&self) -> bool {
        self.backlight_present
    }

    fn has_mpv_on_path(&self) -> bool {
        self.mpv_present
    }
}

fn hardware_item(value: &str) -> EdgeCapabilitiesHardwareItem {
    value
        .parse()
        .unwrap_or_else(|error| panic!("static hardware capability literal {value:?} rejected by generated schema type: {error:?}"))
}

fn media_item(value: &str) -> EdgeCapabilitiesMediaItem {
    value
        .parse()
        .unwrap_or_else(|error| panic!("static media capability literal {value:?} rejected by generated schema type: {error:?}"))
}

fn renderer_item(value: &str) -> EdgeCapabilitiesRendererItem {
    value
        .parse()
        .unwrap_or_else(|error| panic!("static renderer capability literal {value:?} rejected by generated schema type: {error:?}"))
}

fn voice_item(value: &str) -> EdgeCapabilitiesVoiceItem {
    value
        .parse()
        .unwrap_or_else(|error| panic!("static voice capability literal {value:?} rejected by generated schema type: {error:?}"))
}

/// Produces a real [`EdgeCapabilities`] value from a [`SystemCapabilityProbe`], instead of the
/// fixed literal `session::state::EdgeSession::create_hello` hardcodes today.
///
/// `architecture` is threaded through (mirroring the existing `AgentInfoArchitecture` already
/// carried on `EdgeSession`, itself ultimately derived from `std::env::consts::ARCH` at the call
/// site that constructs the session) so that a future capability that genuinely differs by CPU
/// architecture -- for example, a Raspberry Pi-specific `vc4`/DRM display-power quirk that does not
/// apply to `amd64` -- can be added to [`CapabilityDetector::detect`] without changing this type's
/// public API. No capability detected today actually varies by architecture, so this field is
/// currently unused by the detection logic itself; it is kept because adding it later would be a
/// breaking API change for callers.
pub struct CapabilityDetector<P: SystemCapabilityProbe> {
    probe: P,
    #[allow(dead_code)]
    architecture: AgentInfoArchitecture,
}

impl<P: SystemCapabilityProbe> CapabilityDetector<P> {
    pub fn new(probe: P, architecture: AgentInfoArchitecture) -> Self {
        Self {
            probe,
            architecture,
        }
    }

    /// Detects and reports this Edge device's current capabilities.
    ///
    /// Per field, what is real vs. assumed:
    /// - `hardware.brightness`: **real**, from [`SystemCapabilityProbe::has_backlight`].
    /// - `hardware.dpms`: **assumed**, not deep-probed. Every supported release target here is a
    ///   Linux desktop/X11 or DRM/KMS environment (`amd64`/`arm64` kiosk builds only, per this
    ///   project's active platform scope), and DPMS-equivalent display power control (`xset dpms`
    ///   under X11, or the DRM `DPMS`/`ACTIVE` connector property under KMS) is a standard part of
    ///   the Linux display stack on every one of those targets. We therefore report this
    ///   capability unconditionally on Linux rather than trying to probe for a specific `xset`
    ///   binary or DRM property file, which would be more fragile than the thing it's meant to
    ///   verify. A future task could tighten this to a real DRM connector-property probe once the
    ///   renderer's actual display-power code path is implemented.
    /// - `media.youtube-iframe`, `renderer.canvas-scene-v1`: **assumed build-time facts**, not
    ///   runtime probes -- both are compiled into this binary unconditionally today.
    /// - `media.mpv`: **real**, from [`SystemCapabilityProbe::has_mpv_on_path`].
    /// - `voice.*`: **assumed, unchanged placeholder** -- see [`VOICE_WAKEWORD_LOCAL`] doc comment;
    ///   no real local voice pipeline exists yet to probe.
    pub fn detect(&self) -> EdgeCapabilities {
        let mut hardware = Vec::new();
        if self.probe.has_backlight() {
            hardware.push(hardware_item(HARDWARE_BRIGHTNESS));
        }
        hardware.push(hardware_item(HARDWARE_DPMS));

        let mut media = vec![media_item(MEDIA_YOUTUBE_IFRAME)];
        if self.probe.has_mpv_on_path() {
            media.push(media_item(MEDIA_MPV));
        }

        EdgeCapabilities {
            hardware,
            media,
            renderer: vec![renderer_item(RENDERER_CANVAS_SCENE_V1)],
            voice: vec![voice_item(VOICE_WAKEWORD_LOCAL), voice_item(VOICE_OPUS_WSS)],
        }
    }
}
