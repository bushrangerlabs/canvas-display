//! Real, sysfs-backed display brightness control.
//!
//! [`SysfsBrightnessAdapter`] reads and writes the kernel backlight sysfs interface at
//! `/sys/class/backlight/<device>/brightness` and `/sys/class/backlight/<device>/max_brightness`,
//! the same path the capability probe in [`crate::capabilities::detect`] already inspects to decide
//! whether to advertise the `brightness` hardware capability. This is more direct and more portable
//! than the legacy Tauri sidecar's `xrandr --output <name> --brightness <val>` loop in
//! `browser/linux/src-tauri/src/lib.rs`, which guesses output names (`eDP-1`, `HDMI-1`, ...) and
//! only adjusts the X server's gamma ramp rather than actual backlight power -- on a kiosk with no
//! X server running (or a DRM/KMS-only Pi), `xrandr` is unavailable, but sysfs backlight works
//! regardless of display server.
//!
//! The adapter is injectable with a base path (defaulting to `/sys/class/backlight`) so tests
//! exercise the **real** sysfs-walking logic against a `tempfile` tempdir, exactly like
//! [`crate::capabilities::detect::RealSystemCapabilityProbe::with_paths`]. The fake adapter
//! returns canned values for tests that need a brightness capability without touching the
//! filesystem at all.
//!
//! **Honest scope note:** writing to `/sys/class/backlight/<device>/brightness` requires write
//! permission on the sysfs file (typically `root` or a `video`/`backlight` group membership). The
//! daemon does not attempt to escalate privileges; an `EACCES` here is surfaced as an
//! [`AdapterError::Io`] and the caller (the IPC handler) reports it back to the renderer as an
//! execution failure. A production deployment must grant the Agent's service user the appropriate
//! group membership (e.g. `udev` rules tagging the backlight device with `TAG+="uaccess"`, or
//! adding the service user to the `video` group) -- this is a packaging-time concern, not
//! something the adapter can fix at runtime.

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Errors returned by hardware adapters. Kept as a single enum (rather than `Result<_, String>`)
/// so callers can distinguish "no backlight device present" from "I/O failed mid-write" when
/// surfacing the failure back over IPC.
#[derive(Debug)]
pub enum AdapterError {
    /// No backlight device directory was found under the adapter's base path. This is the normal
    /// state on a desktop/VM with no kernel backlight driver, not a fatal condition -- the caller
    /// should treat it as "brightness control unavailable on this device."
    NoBacklightDevice(PathBuf),
    /// A raw filesystem I/O error (permission denied, file vanished mid-read, etc.). The underlying
    /// [`io::Error`] is preserved so the caller can log the OS-level detail.
    Io(io::Error),
    /// The contents of a sysfs file were not a valid integer. Kernel backlight files are always a
    /// single decimal integer followed by a newline, so this indicates either a non-backlight
    /// directory the adapter walked into by mistake, or a corrupted sysfs entry.
    NotAnInteger {
        path: PathBuf,
        source: std::num::ParseIntError,
    },
    /// A brightness level was outside the range `[0, max_brightness]`. The IPC layer already
    /// validates the `level` argument fits in `u8`, but the adapter additionally clamps against the
    /// device's real `max_brightness` so a caller cannot drive a 255-only panel with level 200 on a
    /// device whose `max_brightness` is 100.
    OutOfRange { level: u32, max: u32 },
}

impl fmt::Display for AdapterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AdapterError::NoBacklightDevice(path) => {
                write!(f, "no backlight device found under {}", path.display())
            }
            AdapterError::Io(err) => write!(f, "{err}"),
            AdapterError::NotAnInteger { path, source } => {
                write!(
                    f,
                    "backlight file {} did not contain a valid integer: {source}",
                    path.display()
                )
            }
            AdapterError::OutOfRange { level, max } => {
                write!(f, "brightness level {level} is out of range [0, {max}]")
            }
        }
    }
}

impl std::error::Error for AdapterError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            AdapterError::Io(err) => Some(err),
            AdapterError::NotAnInteger { source, .. } => Some(source),
            _ => None,
        }
    }
}

impl From<io::Error> for AdapterError {
    fn from(err: io::Error) -> Self {
        AdapterError::Io(err)
    }
}

/// Reads and writes display brightness through the kernel backlight sysfs interface.
///
/// All methods are synchronous (the daemon drives them on its IPC thread, never on tokio -- ADR
/// 0009) and never panic: a missing or unreadable backlight device is reported as
/// [`AdapterError::NoBacklightDevice`] or [`AdapterError::Io`], not a crash.
pub trait BrightnessAdapter: Send + std::fmt::Debug {
    /// Returns the current brightness level as reported by the kernel.
    fn get_brightness(&self) -> Result<u32, AdapterError>;

    /// Sets the brightness level. Implementations should reject `level` values exceeding the
    /// device's real `max_brightness` with [`AdapterError::OutOfRange`] (rather than silently
    /// clamping, so the caller knows the requested level was not honored exactly).
    fn set_brightness(&self, level: u32) -> Result<(), AdapterError>;

    /// Returns the device's maximum brightness level (the value in `max_brightness`).
    fn max_brightness(&self) -> Result<u32, AdapterError>;
}

/// Production adapter: reads and writes `/sys/class/backlight/<device>/brightness` and
/// `/sys/class/backlight/<device>/max_brightness` for the first backlight device found under
/// `backlight_base`.
///
/// The "first device found" policy matches the capability detector's
/// [`crate::capabilities::detect::RealSystemCapabilityProbe::has_backlight`] logic (which also just
/// checks for the presence of any `*/brightness` file). A kiosk typically has exactly one backlight
/// device (`intel_backlight`, `rpi_backlight`, `panel-0`, ...); a machine with multiple would need a
/// future task to select by name, which is out of scope here.
#[derive(Debug)]
pub struct SysfsBrightnessAdapter {
    backlight_base: PathBuf,
}

impl SysfsBrightnessAdapter {
    /// Production constructor: probes the real `/sys/class/backlight` directory.
    pub fn new() -> Self {
        Self {
            backlight_base: PathBuf::from("/sys/class/backlight"),
        }
    }

    /// Test/inspection constructor: probes `backlight_base` instead of the real `/sys/class/backlight`,
    /// so tests can exercise the real sysfs-walking logic against a `tempfile` tempdir without
    /// touching or depending on the real machine's `/sys` tree. Mirrors
    /// [`crate::capabilities::detect::RealSystemCapabilityProbe::with_paths`].
    pub fn with_base(backlight_base: impl Into<PathBuf>) -> Self {
        Self {
            backlight_base: backlight_base.into(),
        }
    }

    /// Walks `backlight_base` and returns the path to the first subdirectory that contains a
    /// `brightness` file. Returns [`AdapterError::NoBacklightDevice`] if the base directory is
    /// missing or no subdirectory has a `brightness` file (the normal state on a desktop/VM with no
    /// kernel backlight driver).
    fn first_backlight_device(&self) -> Result<PathBuf, AdapterError> {
        let Ok(entries) = fs::read_dir(&self.backlight_base) else {
            return Err(AdapterError::NoBacklightDevice(self.backlight_base.clone()));
        };
        for entry in entries.flatten() {
            let brightness_file = entry.path().join("brightness");
            if brightness_file.is_file() {
                return Ok(entry.path());
            }
        }
        Err(AdapterError::NoBacklightDevice(self.backlight_base.clone()))
    }

    /// Reads a single decimal integer from a sysfs file, trimming trailing whitespace/newline.
    fn read_int(path: &Path) -> Result<u32, AdapterError> {
        let contents = fs::read_to_string(path)?;
        let trimmed = contents.trim();
        trimmed
            .parse::<u32>()
            .map_err(|source| AdapterError::NotAnInteger {
                path: path.to_path_buf(),
                source,
            })
    }
}

impl Default for SysfsBrightnessAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl BrightnessAdapter for SysfsBrightnessAdapter {
    fn get_brightness(&self) -> Result<u32, AdapterError> {
        let device = self.first_backlight_device()?;
        Self::read_int(&device.join("brightness"))
    }

    fn set_brightness(&self, level: u32) -> Result<(), AdapterError> {
        let device = self.first_backlight_device()?;
        let max = Self::read_int(&device.join("max_brightness"))?;
        if level > max {
            return Err(AdapterError::OutOfRange { level, max });
        }
        // sysfs brightness files expect a single decimal integer with no newline; writing the bare
        // number (no trailing `\n`) is the conventional form the kernel accepts.
        fs::write(device.join("brightness"), level.to_string())?;
        Ok(())
    }

    fn max_brightness(&self) -> Result<u32, AdapterError> {
        let device = self.first_backlight_device()?;
        Self::read_int(&device.join("max_brightness"))
    }
}

/// Test-only adapter that returns canned values without touching the filesystem. Not used by any
/// production code path. Mirrors [`crate::capabilities::detect::FakeSystemCapabilityProbe`]'s role
/// for [`SystemCapabilityProbe`].
///
/// Call recording uses interior mutability behind a shared `Arc<Mutex<...>>` so the trait can
/// stay `&self` (matching the real sysfs adapter, which is naturally stateless and shareable)
/// and so a test can retain a handle via [`FakeBrightnessAdapter::call_log`] and inspect the
/// recorded calls after the adapter has been boxed and moved into the daemon's IPC handler.
#[derive(Debug, Clone)]
pub struct FakeBrightnessAdapter {
    current: u32,
    max: u32,
    set_calls: Arc<Mutex<Vec<u32>>>,
    next_set_error: Option<AdapterErrorKind>,
}

/// Clone-friendly subset of [`AdapterError`] for the fake's `next_set_error` field. The real
/// `AdapterError` cannot derive `Clone` because `io::Error` is not `Clone`; tests that need a
/// real I/O error should use [`SysfsBrightnessAdapter::with_base`] against a tempdir instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdapterErrorKind {
    NoBacklightDevice,
    OutOfRange { level: u32, max: u32 },
}

impl Default for FakeBrightnessAdapter {
    fn default() -> Self {
        Self::new(0, 255)
    }
}

impl FakeBrightnessAdapter {
    pub fn new(current: u32, max: u32) -> Self {
        Self {
            current,
            max,
            set_calls: Arc::new(Mutex::new(Vec::new())),
            next_set_error: None,
        }
    }

    /// Configures the next `set_brightness` call to fail with the given error kind. Test-only.
    pub fn with_next_set_error(mut self, kind: AdapterErrorKind) -> Self {
        self.next_set_error = Some(kind);
        self
    }

    /// Returns a clone of the shared call log handle, so a test can inspect the recorded
    /// `set_brightness` calls after this adapter has been boxed and moved into the daemon's IPC
    /// handler. Test-only.
    pub fn call_log(&self) -> Arc<Mutex<Vec<u32>>> {
        Arc::clone(&self.set_calls)
    }

    /// Returns every level passed to `set_brightness` since this fake was constructed, in call
    /// order. Test-only.
    pub fn recorded_set_calls(&self) -> Vec<u32> {
        self.set_calls
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }
}

impl BrightnessAdapter for FakeBrightnessAdapter {
    fn get_brightness(&self) -> Result<u32, AdapterError> {
        Ok(self.current)
    }

    fn set_brightness(&self, level: u32) -> Result<(), AdapterError> {
        if let Ok(mut guard) = self.set_calls.lock() {
            guard.push(level);
        }
        match self.next_set_error {
            Some(AdapterErrorKind::NoBacklightDevice) => Err(AdapterError::NoBacklightDevice(
                PathBuf::from("/fake/sys/class/backlight"),
            )),
            Some(AdapterErrorKind::OutOfRange { level, max }) => {
                Err(AdapterError::OutOfRange { level, max })
            }
            None => Ok(()),
        }
    }

    fn max_brightness(&self) -> Result<u32, AdapterError> {
        Ok(self.max)
    }
}
