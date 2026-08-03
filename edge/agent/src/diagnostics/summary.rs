//! [`DiagnosticsSummary`]: a pure, dependency-injected snapshot of Agent health for local
//! diagnostics and (eventually) a renderer-side "safe recovery screen".
//!
//! Everything this module needs is passed in by the caller (see `edge/agentd/src/main.rs`) --
//! this module never opens `Storage` itself. That keeps it unit-testable with plain canned values
//! (see `tests/diagnostics_v1.rs`) instead of requiring a real SQLite file.

use std::fmt;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::storage::Epochs;

/// A point-in-time snapshot of Agent health, built from data the caller already has on hand.
///
/// Construct with [`DiagnosticsSummary::new`]. Render with the [`fmt::Display`] impl (one
/// human-readable paragraph) or [`DiagnosticsSummary::to_log_lines`] (one line per fact, matching
/// the `[canvas-edge-agentd] ...` line-per-fact style already used in `edge/agentd/src/main.rs`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiagnosticsSummary {
    /// Time elapsed since the daemon/module was initialized (i.e. since the `Instant` passed to
    /// `new` was captured), computed at construction time via `Instant::now()`.
    pub uptime: Duration,
    /// How many non-repeatable commands were left `running` at the last crash/restart and were
    /// marked `unknown_outcome` by `Storage::recover_non_repeatable_running` during this
    /// startup's recovery pass. Zero means the previous shutdown was clean (or this is the first
    /// ever startup).
    pub recovered_unknown_outcome_count: usize,
    /// Durable epoch/sequencing state as of the moment `storage.epochs()` was read by the caller.
    pub epochs: Epochs,
    /// Crate version this binary was built from (`env!("CARGO_PKG_VERSION")` of the calling
    /// crate, threaded through rather than read here, since this module must not assume it is
    /// only ever linked into `canvas-edge-agentd`).
    pub version: &'static str,
    /// Target architecture this binary was built for (`std::env::consts::ARCH`, e.g. `"x86_64"`
    /// or `"aarch64"`), which matters for this project since Linux amd64 and Raspberry Pi arm64
    /// are the two supported release targets and diagnostics output should be unambiguous about
    /// which one produced it.
    pub arch: &'static str,
    /// Wall-clock time this summary was generated, as whole seconds since the Unix epoch. This is
    /// real wall-clock time (`SystemTime::now()`), not a monotonic counter -- it is meant for a
    /// human or log-shipper to correlate against other timestamped log lines, not for measuring
    /// durations (that's what `uptime` is for, via `Instant`).
    pub generated_at_unix_seconds: u64,
}

impl DiagnosticsSummary {
    /// Builds a summary from already-available data. `start` should be an `Instant` captured once
    /// at daemon/module startup; uptime is computed as `Instant::now() - start` at the moment this
    /// function runs, so calling `new` again later against the same `start` yields a larger
    /// uptime.
    pub fn new(
        start: Instant,
        recovered_unknown_outcome_count: usize,
        epochs: Epochs,
        version: &'static str,
    ) -> Self {
        Self {
            uptime: Instant::now().saturating_duration_since(start),
            recovered_unknown_outcome_count,
            epochs,
            version,
            arch: std::env::consts::ARCH,
            generated_at_unix_seconds: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
        }
    }

    /// One line per fact, in the same order as the fields above, with no leading process-name
    /// prefix -- callers that want the `[canvas-edge-agentd] ...` convention prepend it themselves
    /// (see `edge/agentd/src/main.rs`), since this module should not assume which binary/prefix is
    /// using it.
    pub fn to_log_lines(&self) -> Vec<String> {
        vec![
            format!(
                "diagnostics: canvas-edge-agent v{} ({}), uptime={}s",
                self.version,
                self.arch,
                self.uptime.as_secs()
            ),
            format!(
                "diagnostics: startup recovery marked {} non-repeatable command(s) unknown_outcome",
                self.recovered_unknown_outcome_count
            ),
            format!(
                "diagnostics: epochs: core_stream={} edge_stream={} authority={} restore_generation={}",
                self.epochs.core_stream_epoch,
                self.epochs.edge_stream_epoch,
                self.epochs.authority_epoch,
                self.epochs.restore_generation
            ),
            format!(
                "diagnostics: generated_at={} (unix seconds)",
                self.generated_at_unix_seconds
            ),
        ]
    }
}

impl fmt::Display for DiagnosticsSummary {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (index, line) in self.to_log_lines().iter().enumerate() {
            if index > 0 {
                writeln!(f)?;
            }
            write!(f, "{line}")?;
        }
        Ok(())
    }
}
