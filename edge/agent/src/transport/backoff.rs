//! Pure exponential backoff with jitter for the WS reconnect loop (ADR 0009).
//!
//! Deliberately dependency-free and synchronous (`std::time::Duration` in, `Duration` out) so it
//! can be unit tested without a `tokio` runtime, exactly like every other pure-logic module in
//! this crate (compare `journal::recovery`'s crash-loop policy in the sibling `canvas-edge-updater`
//! crate).

use std::time::Duration;

/// Configuration for [`next_delay`]. `base` is the delay after the first failed attempt; each
/// subsequent attempt doubles the previous delay (capped at `max`), with up to `jitter_fraction`
/// of the computed delay added or subtracted at random to avoid a thundering-herd reconnect storm
/// if many Edge devices lose connectivity to Core at the same time.
#[derive(Debug, Clone, Copy)]
pub struct BackoffConfig {
    pub base: Duration,
    pub max: Duration,
    /// Fraction of the computed delay (0.0..=1.0) to jitter by. For example, `0.2` means the
    /// final delay is the computed value +/- up to 20%.
    pub jitter_fraction: f64,
}

impl Default for BackoffConfig {
    fn default() -> Self {
        Self {
            base: Duration::from_secs(1),
            max: Duration::from_secs(60),
            jitter_fraction: 0.2,
        }
    }
}

/// Computes the delay before reconnect attempt number `attempt` (1-based: the delay before the
/// *first* retry, after the *first* failure, is `next_delay(config, 1, ...)`). `jitter_sample` is
/// an injected value in `0.0..=1.0` so this function is fully deterministic and testable -- real
/// callers pass a fresh random sample per call (e.g. `rand::random::<f64>()`), tests pass fixed
/// values to assert exact bounds.
pub fn next_delay(config: BackoffConfig, attempt: u32, jitter_sample: f64) -> Duration {
    debug_assert!(attempt >= 1);
    let jitter_sample = jitter_sample.clamp(0.0, 1.0);

    // 2^(attempt-1) * base, saturating well before it could overflow Duration, since `max` caps
    // the result long before exponentiation could realistically overflow for any sane config.
    let exponent = attempt.saturating_sub(1).min(32);
    let multiplier = 1u64 << exponent;
    let unjittered = config
        .base
        .saturating_mul(multiplier.try_into().unwrap_or(u32::MAX))
        .min(config.max);

    let jitter_range_ns = (unjittered.as_nanos() as f64) * config.jitter_fraction;
    // jitter_sample in 0.0..=1.0 maps to -jitter_range_ns..=+jitter_range_ns.
    let offset_ns = (jitter_sample * 2.0 - 1.0) * jitter_range_ns;
    let final_ns = (unjittered.as_nanos() as f64 + offset_ns).max(0.0);

    Duration::from_nanos(final_ns as u64).min(config.max)
}
