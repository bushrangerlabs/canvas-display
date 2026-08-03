//! Renderer crash-loop detection and safe recovery screen integration.
//!
//! The [`CrashDetector`] trait (and its two implementations, [`RealCrashDetector`] and
//! [`FakeCrashDetector`]) track renderer process restarts over a configurable time window. When the
//! crash threshold is exceeded, the detector reports a crash-loop, and the supervisor can stop
//! restarting the renderer (to avoid CPU burn and display flicker) and serve the recovery screen
//! instead. After a cooldown period, the crash-loop state is automatically cleared so the renderer
//! can be restarted again (the crash loop may have been transient).

use std::time::{Duration, Instant};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// Tuning parameters for crash-loop detection.
#[derive(Debug, Clone, Copy)]
pub struct CrashDetectorConfig {
    /// Maximum number of crashes allowed within `window` before a crash-loop is declared.
    pub max_crashes: u32,
    /// Time window (in milliseconds) within which crashes are counted toward the threshold.
    pub window_ms: u64,
    /// Cooldown period (in milliseconds) after a crash-loop is detected, during which the
    /// renderer is not restarted. After this period, the crash-loop state is cleared.
    pub cooldown_ms: u64,
}

impl Default for CrashDetectorConfig {
    fn default() -> Self {
        Self {
            max_crashes: 5,
            window_ms: 60_000,
            cooldown_ms: 30_000,
        }
    }
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/// The health state of the renderer as reported by the crash detector.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RendererHealth {
    /// The renderer is healthy and can be (re)started.
    Healthy,
    /// The renderer is in a crash-loop and should not be restarted until the cooldown expires.
    CrashLoop,
}

// ---------------------------------------------------------------------------
// Trait
// ---------------------------------------------------------------------------

/// A crash detector that tracks renderer process restarts over time.
///
/// Production code uses [`RealCrashDetector`]; tests use [`FakeCrashDetector`] for deterministic
/// crash-loop scenarios.
pub trait CrashDetector: Send + std::fmt::Debug {
    /// Records a crash event at the current instant. Returns `true` if a crash-loop is now
    /// detected (i.e. the crash threshold has been exceeded within the window).
    fn record_crash(&mut self) -> bool;

    /// Returns the current renderer health state.
    fn health(&self) -> RendererHealth;

    /// Returns the number of crashes recorded within the current window.
    fn crash_count(&self) -> u32;

    /// Returns the time (in seconds) since the last recorded crash, or `u64::MAX` if none.
    fn seconds_since_last_crash(&self) -> u64;
}

// ---------------------------------------------------------------------------
// RealCrashDetector
// ---------------------------------------------------------------------------

/// Real crash-loop detector backed by `Instant::now()`.
///
/// Maintains a ring of crash timestamps. When a new crash is recorded, timestamps outside the
/// window are pruned, and if the remaining count exceeds `max_crashes`, a crash-loop is declared.
/// After `cooldown_ms` elapses from the crash-loop declaration, the loop is automatically cleared.
#[derive(Debug)]
pub struct RealCrashDetector {
    config: CrashDetectorConfig,
    /// Monotonically increasing timestamps of crash events, newest last.
    crashes: Vec<Instant>,
    /// The instant at which the crash-loop was declared, if currently in a crash-loop.
    loop_declared_at: Option<Instant>,
}

impl RealCrashDetector {
    pub fn new(config: CrashDetectorConfig) -> Self {
        Self {
            config,
            crashes: Vec::new(),
            loop_declared_at: None,
        }
    }
}

impl CrashDetector for RealCrashDetector {
    fn record_crash(&mut self) -> bool {
        let now = Instant::now();
        self.crashes.push(now);

        // Prune crashes outside the window.
        let window = Duration::from_millis(self.config.window_ms);
        self.crashes.retain(|t| now.duration_since(*t) <= window);

        // Check if the threshold is exceeded.
        if self.crashes.len() > self.config.max_crashes as usize {
            if self.loop_declared_at.is_none() {
                self.loop_declared_at = Some(now);
            }
            true
        } else {
            false
        }
    }

    fn health(&self) -> RendererHealth {
        match self.loop_declared_at {
            None => RendererHealth::Healthy,
            Some(declared_at) => {
                let cooldown = Duration::from_millis(self.config.cooldown_ms);
                if Instant::now().duration_since(declared_at) >= cooldown {
                    // Cooldown expired — the crash-loop may have been transient.
                    RendererHealth::Healthy
                } else {
                    RendererHealth::CrashLoop
                }
            }
        }
    }

    fn crash_count(&self) -> u32 {
        let now = Instant::now();
        let window = Duration::from_millis(self.config.window_ms);
        self.crashes
            .iter()
            .filter(|t| now.duration_since(**t) <= window)
            .count() as u32
    }

    fn seconds_since_last_crash(&self) -> u64 {
        self.crashes
            .last()
            .map(|t| Instant::now().duration_since(*t).as_secs())
            .unwrap_or(u64::MAX)
    }
}

// ---------------------------------------------------------------------------
// FakeCrashDetector (for tests)
// ---------------------------------------------------------------------------

/// Fake crash detector for deterministic testing. Records crash events and returns pre-configured
/// health, count, and seconds-since-last-crash values.
#[derive(Debug, Clone)]
pub struct FakeCrashDetector {
    health: RendererHealth,
    crash_count: u32,
    seconds_since_last_crash: u64,
    crash_events: u32,
    /// If set, every `record_crash` call increments the count and returns whether the threshold
    /// would be exceeded (simulating a real window-based check).
    pub max_crashes: Option<u32>,
}

impl FakeCrashDetector {
    pub fn new(health: RendererHealth, crash_count: u32, seconds_since_last_crash: u64) -> Self {
        Self {
            health,
            crash_count,
            seconds_since_last_crash,
            crash_events: 0,
            max_crashes: None,
        }
    }

    /// Creates a fake detector that uses a threshold-based check (like the real detector) but
    /// with a deterministic notion of time. Each `record_crash` increments an internal counter;
    /// when the counter exceeds `max_crashes`, the health transitions to `CrashLoop`.
    pub fn with_threshold(max_crashes: u32) -> Self {
        Self {
            health: RendererHealth::Healthy,
            crash_count: 0,
            seconds_since_last_crash: u64::MAX,
            crash_events: 0,
            max_crashes: Some(max_crashes),
        }
    }
}

impl CrashDetector for FakeCrashDetector {
    fn record_crash(&mut self) -> bool {
        self.crash_events += 1;
        if let Some(max) = self.max_crashes {
            if self.crash_events > max {
                self.health = RendererHealth::CrashLoop;
                self.crash_count = self.crash_events;
                self.seconds_since_last_crash = 0;
                return true;
            }
        }
        self.crash_count = self.crash_events;
        self.seconds_since_last_crash = 0;
        false
    }

    fn health(&self) -> RendererHealth {
        self.health
    }

    fn crash_count(&self) -> u32 {
        self.crash_count
    }

    fn seconds_since_last_crash(&self) -> u64 {
        self.seconds_since_last_crash
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    /// Helper: creates a detector with a tight window for testing.
    fn detector_with_window(
        window_ms: u64,
        max_crashes: u32,
        cooldown_ms: u64,
    ) -> RealCrashDetector {
        RealCrashDetector::new(CrashDetectorConfig {
            max_crashes,
            window_ms,
            cooldown_ms,
        })
    }

    #[test]
    fn crashes_within_window_crosses_threshold() {
        let mut detector = detector_with_window(10_000, 2, 60_000);
        // Record 3 crashes within the window — should cross the threshold of 2.
        assert!(!detector.record_crash(), "first crash should not trigger");
        assert!(!detector.record_crash(), "second crash should not trigger");
        assert!(
            detector.record_crash(),
            "third crash should trigger crash-loop"
        );
        assert_eq!(detector.health(), RendererHealth::CrashLoop);
        assert_eq!(detector.crash_count(), 3);
    }

    #[test]
    fn crash_outside_window_does_not_cross_threshold() {
        let mut detector = detector_with_window(10, 2, 60_000);
        // Record 2 crashes within the window.
        assert!(!detector.record_crash());
        assert!(!detector.record_crash());
        // Wait for the window to expire (slightly more than 10 ms).
        thread::sleep(Duration::from_millis(20));
        // This crash is outside the window; the old ones should have been pruned.
        // The count should be 1 (only the new one), and the threshold should not be crossed.
        assert!(
            !detector.record_crash(),
            "crash outside window should not trigger"
        );
        assert_eq!(detector.crash_count(), 1);
    }

    #[test]
    fn cooldown_re_enables_renderer() {
        let mut detector = detector_with_window(60_000, 2, 50);
        // Trigger a crash-loop.
        assert!(!detector.record_crash());
        assert!(!detector.record_crash());
        assert!(detector.record_crash());
        assert_eq!(detector.health(), RendererHealth::CrashLoop);

        // Wait for the cooldown to expire.
        thread::sleep(Duration::from_millis(60));
        assert_eq!(detector.health(), RendererHealth::Healthy);
    }

    #[test]
    fn fake_crash_detector_is_injectable() {
        // Test that FakeCrashDetector implements the trait and can be used where CrashDetector is expected.
        let mut detector: Box<dyn CrashDetector> =
            Box::new(FakeCrashDetector::new(RendererHealth::Healthy, 0, u64::MAX));
        assert!(!detector.record_crash());
        assert_eq!(detector.health(), RendererHealth::Healthy);
        assert_eq!(detector.seconds_since_last_crash(), 0);

        // A fake detector that starts in a crash-loop.
        let detector: Box<dyn CrashDetector> =
            Box::new(FakeCrashDetector::new(RendererHealth::CrashLoop, 5, 2));
        assert_eq!(detector.health(), RendererHealth::CrashLoop);
        assert_eq!(detector.crash_count(), 5);
        assert_eq!(detector.seconds_since_last_crash(), 2);
    }

    #[test]
    fn fake_crash_detector_threshold_works() {
        let mut detector = FakeCrashDetector::with_threshold(2);
        assert!(!detector.record_crash());
        assert!(!detector.record_crash());
        assert!(detector.record_crash());
        assert_eq!(detector.health(), RendererHealth::CrashLoop);
        assert_eq!(detector.crash_count(), 3);
    }

    #[test]
    fn renderer_health_starts_healthy() {
        let detector = RealCrashDetector::new(CrashDetectorConfig::default());
        assert_eq!(detector.health(), RendererHealth::Healthy);
        assert_eq!(detector.crash_count(), 0);
        assert_eq!(detector.seconds_since_last_crash(), u64::MAX);
    }
}
