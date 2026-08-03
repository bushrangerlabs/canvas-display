//! Observability infrastructure for the Edge Agent: structured logging and metrics collection.
//!
//! ## Design
//!
//! - [`MetricsCollector`] is a trait that can be injected (real/fake) for testing. The real
//!   implementation ([`RealMetricsCollector`]) tracks counters, gauges, and reads RSS memory from
//!   `/proc/self/status`.
//! - [`StructuredLogger`] wraps `println!`/`eprintln!` with JSON-formatted log lines, preserving
//!   the existing `[canvas-edge-agentd]` process-label prefix so journalctl filters still work.
//! - The metrics collector is a standalone singleton that the daemon's `main()` wires into its
//!   idle loop (heartbeat every 5 minutes) and into each subsystem's event handler (transport
//!   connect/disconnect, IPC request dispatch, command execution).
//!
//! ## Metrics
//!
//! | Metric | Type | Description |
//! |---|---|---|
//! | `agent_uptime_seconds` | gauge | Seconds since agent startup |
//! | `agent_connections` | gauge | Current device gateway connections |
//! | `agent_commands_total` | counter | Total commands executed |
//! | `agent_commands_failed_total` | counter | Failed commands |
//! | `agent_ipc_requests_total` | counter | IPC requests handled |
//! | `agent_transport_reconnects_total` | counter | Transport reconnection attempts |
//! | `agent_memory_bytes` | gauge | Current RSS memory usage (from `/proc/self/status`) |
//!
//! ## OTel compatibility
//!
//! The metrics are tracked as plain counters/gauges in-process. A future OTel exporter can be
//! added by implementing [`MetricsExporter`] and calling [`MetricsSnapshot::export`] through an
//! OTLP HTTP/gRPC client. The snapshot format is intentionally flat and OTel-semantic-convention
//! compatible (metric names use dots, not underscores, following OTel's naming convention for
//! process metrics).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

// ---------------------------------------------------------------------------
// MetricsCollector trait
// ---------------------------------------------------------------------------

/// A point-in-time snapshot of all metrics, suitable for serialization or export.
#[derive(Debug, Clone, PartialEq)]
pub struct MetricsSnapshot {
    /// Seconds since the collector was created.
    pub uptime_seconds: f64,
    /// Current number of device gateway connections.
    pub connections: u64,
    /// Total commands executed since agent start.
    pub commands_total: u64,
    /// Total commands that failed since agent start.
    pub commands_failed_total: u64,
    /// Total IPC requests handled since agent start.
    pub ipc_requests_total: u64,
    /// Total transport reconnection attempts since agent start.
    pub transport_reconnects_total: u64,
    /// Current RSS memory usage in bytes, or 0 if unavailable.
    pub memory_bytes: u64,
    /// Unix timestamp (seconds) when this snapshot was taken.
    pub collected_at: u64,
}

impl MetricsSnapshot {
    /// Returns a JSON-serializable representation of the snapshot.
    ///
    /// The field names use dots (e.g. `agent.uptime_seconds`) following OTel semantic
    /// convention conventions for process-level metrics.
    pub fn as_fields(&self) -> HashMap<&'static str, f64> {
        let mut fields = HashMap::new();
        fields.insert("agent.uptime_seconds", self.uptime_seconds);
        fields.insert("agent.connections", self.connections as f64);
        fields.insert("agent.commands_total", self.commands_total as f64);
        fields.insert(
            "agent.commands_failed_total",
            self.commands_failed_total as f64,
        );
        fields.insert("agent.ipc_requests_total", self.ipc_requests_total as f64);
        fields.insert(
            "agent.transport_reconnects_total",
            self.transport_reconnects_total as f64,
        );
        fields.insert("agent.memory_bytes", self.memory_bytes as f64);
        fields
    }
}

/// A trait for injecting metrics collection into the Edge Agent daemon.
///
/// - Use [`RealMetricsCollector`] in production.
/// - Use [`FakeMetricsCollector`] in tests to assert on recorded values.
pub trait MetricsCollector: Send + Sync {
    /// Returns a snapshot of all current metrics.
    fn snapshot(&self) -> MetricsSnapshot;

    /// Increments the command counter.
    fn record_command(&self);

    /// Increments the failed command counter.
    fn record_command_failed(&self);

    /// Increments the IPC requests counter.
    fn record_ipc_request(&self);

    /// Increments the transport reconnection counter.
    fn record_transport_reconnect(&self);

    /// Sets the current connection count (e.g. after a transport connect/disconnect).
    fn set_connections(&self, count: u64);
}

// ---------------------------------------------------------------------------
// RealMetricsCollector
// ---------------------------------------------------------------------------

/// Production metrics collector that tracks counters via atomics and reads RSS from
/// `/proc/self/status`.
pub struct RealMetricsCollector {
    start: Instant,
    connections: AtomicU64,
    commands_total: AtomicU64,
    commands_failed_total: AtomicU64,
    ipc_requests_total: AtomicU64,
    transport_reconnects_total: AtomicU64,
}

impl RealMetricsCollector {
    /// Creates a new collector with all counters zeroed and `start` set to `Instant::now()`.
    pub fn new() -> Self {
        Self {
            start: Instant::now(),
            connections: AtomicU64::new(0),
            commands_total: AtomicU64::new(0),
            commands_failed_total: AtomicU64::new(0),
            ipc_requests_total: AtomicU64::new(0),
            transport_reconnects_total: AtomicU64::new(0),
        }
    }

    /// Reads the current RSS (resident set size) in bytes from `/proc/self/status`.
    ///
    /// Returns 0 when the file is unreadable (e.g. not on Linux, inside a container without
    /// procfs, or during testing). This is a best-effort diagnostic — not a hard dependency.
    fn read_rss_bytes() -> u64 {
        let status = match std::fs::read_to_string("/proc/self/status") {
            Ok(s) => s,
            Err(_) => return 0,
        };
        for line in status.lines() {
            if let Some(rest) = line.strip_prefix("VmRSS:") {
                // Format: "VmRSS:    12345 kB"
                let rest = rest.trim();
                if let Some(kb_str) = rest.split_whitespace().next() {
                    if let Ok(kb) = kb_str.parse::<u64>() {
                        return kb.saturating_mul(1024);
                    }
                }
            }
        }
        0
    }
}

impl Default for RealMetricsCollector {
    fn default() -> Self {
        Self::new()
    }
}

impl MetricsCollector for RealMetricsCollector {
    fn snapshot(&self) -> MetricsSnapshot {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        MetricsSnapshot {
            uptime_seconds: self.start.elapsed().as_secs_f64(),
            connections: self.connections.load(Ordering::Relaxed),
            commands_total: self.commands_total.load(Ordering::Relaxed),
            commands_failed_total: self.commands_failed_total.load(Ordering::Relaxed),
            ipc_requests_total: self.ipc_requests_total.load(Ordering::Relaxed),
            transport_reconnects_total: self.transport_reconnects_total.load(Ordering::Relaxed),
            memory_bytes: Self::read_rss_bytes(),
            collected_at: now,
        }
    }

    fn record_command(&self) {
        self.commands_total.fetch_add(1, Ordering::Relaxed);
    }

    fn record_command_failed(&self) {
        self.commands_failed_total.fetch_add(1, Ordering::Relaxed);
    }

    fn record_ipc_request(&self) {
        self.ipc_requests_total.fetch_add(1, Ordering::Relaxed);
    }

    fn record_transport_reconnect(&self) {
        self.transport_reconnects_total
            .fetch_add(1, Ordering::Relaxed);
    }

    fn set_connections(&self, count: u64) {
        self.connections.store(count, Ordering::Relaxed);
    }
}

// ---------------------------------------------------------------------------
// FakeMetricsCollector
// ---------------------------------------------------------------------------

/// A fake metrics collector for testing, backed by `Arc<Mutex<...>>` so test assertions
/// can inspect recorded values.
///
/// # Example
///
/// ```ignore
/// use canvas_edge_agent::observability::FakeMetricsCollector;
///
/// let collector = FakeMetricsCollector::new();
/// collector.record_command();
/// collector.record_command_failed();
/// let snap = collector.snapshot();
/// assert_eq!(snap.commands_total, 1);
/// assert_eq!(snap.commands_failed_total, 1);
/// ```
pub struct FakeMetricsCollector {
    inner: std::sync::Mutex<FakeMetricsInner>,
}

#[derive(Debug, Clone)]
struct FakeMetricsInner {
    start: Instant,
    connections: u64,
    commands_total: u64,
    commands_failed_total: u64,
    ipc_requests_total: u64,
    transport_reconnects_total: u64,
    memory_bytes: u64,
}

impl Default for FakeMetricsInner {
    fn default() -> Self {
        Self {
            start: Instant::now(),
            connections: 0,
            commands_total: 0,
            commands_failed_total: 0,
            ipc_requests_total: 0,
            transport_reconnects_total: 0,
            memory_bytes: 0,
        }
    }
}

impl FakeMetricsCollector {
    /// Creates a new fake collector with all values zeroed.
    pub fn new() -> Self {
        Self {
            inner: std::sync::Mutex::new(FakeMetricsInner::default()),
        }
    }

    /// Sets the RSS memory value returned by [`snapshot`]. Tests can use this to simulate
    /// memory pressure without reading `/proc/self/status`.
    pub fn set_memory_bytes(&self, bytes: u64) {
        let mut inner = self.inner.lock().unwrap();
        inner.memory_bytes = bytes;
    }
}

impl Default for FakeMetricsCollector {
    fn default() -> Self {
        Self::new()
    }
}

impl MetricsCollector for FakeMetricsCollector {
    fn snapshot(&self) -> MetricsSnapshot {
        let inner = self.inner.lock().unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        MetricsSnapshot {
            uptime_seconds: inner.start.elapsed().as_secs_f64(),
            connections: inner.connections,
            commands_total: inner.commands_total,
            commands_failed_total: inner.commands_failed_total,
            ipc_requests_total: inner.ipc_requests_total,
            transport_reconnects_total: inner.transport_reconnects_total,
            memory_bytes: inner.memory_bytes,
            collected_at: now,
        }
    }

    fn record_command(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.commands_total += 1;
    }

    fn record_command_failed(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.commands_failed_total += 1;
    }

    fn record_ipc_request(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.ipc_requests_total += 1;
    }

    fn record_transport_reconnect(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.transport_reconnects_total += 1;
    }

    fn set_connections(&self, count: u64) {
        let mut inner = self.inner.lock().unwrap();
        inner.connections = count;
    }
}

// ---------------------------------------------------------------------------
// StructuredLogger
// ---------------------------------------------------------------------------

/// A JSON-structured logger that wraps `println!`/`eprintln!` with consistent log envelopes.
///
/// Each log line is a JSON object with fields:
/// - `ts`: ISO 8601 timestamp (UTC)
/// - `level`: log level string
/// - `module`: the Rust module or subsystem name
/// - `message`: the human-readable message
/// - `fields`: optional key-value pairs for structured data
///
/// The log line is prefixed with `[canvas-edge-agentd]` so journalctl filters and existing
/// log-parsing tools work unchanged.
///
/// # Example output
///
/// ```json
/// [canvas-edge-agentd] {"ts":"2026-07-19T10:30:00Z","level":"info","module":"main","message":"agent starting","fields":{"version":"0.0.0","arch":"x86_64"}}
/// ```
pub struct StructuredLogger {
    module_name: &'static str,
}

impl StructuredLogger {
    /// Creates a new structured logger for the given module.
    ///
    /// `module_name` should be a short, kebab-case identifier like `"main"`, `"transport"`,
    /// `"ipc"`, `"updater-agent"`, etc.
    pub fn new(module_name: &'static str) -> Self {
        Self { module_name }
    }

    /// Logs a structured message at the given level.
    ///
    /// `fields` is an optional set of key-value pairs. Each value is serialized with its
    /// `Display` implementation.
    pub fn log(
        &self,
        level: &str,
        message: &str,
        fields: Option<&[(&str, &dyn std::fmt::Display)]>,
    ) {
        let ts = self.timestamp();
        let fields_json = match fields {
            Some(fields) if !fields.is_empty() => {
                let pairs: Vec<String> = fields
                    .iter()
                    .map(|(k, v)| format!("\"{}\":\"{}\"", k, v))
                    .collect();
                format!(",\"fields\":{{{}}}", pairs.join(","))
            }
            _ => String::new(),
        };
        println!(
            "[canvas-edge-agentd] {{\"ts\":\"{}\",\"level\":\"{}\",\"module\":\"{}\",\"message\":\"{}\"{}}}",
            ts, level, self.module_name, message, fields_json
        );
    }

    /// Logs at `info` level.
    pub fn info(&self, message: &str, fields: Option<&[(&str, &dyn std::fmt::Display)]>) {
        self.log("info", message, fields);
    }

    /// Logs at `warn` level.
    pub fn warn(&self, message: &str, fields: Option<&[(&str, &dyn std::fmt::Display)]>) {
        self.log("warn", message, fields);
    }

    /// Logs at `error` level to stderr.
    pub fn error(&self, message: &str, fields: Option<&[(&str, &dyn std::fmt::Display)]>) {
        let ts = self.timestamp();
        let fields_json = match fields {
            Some(fields) if !fields.is_empty() => {
                let pairs: Vec<String> = fields
                    .iter()
                    .map(|(k, v)| format!("\"{}\":\"{}\"", k, v))
                    .collect();
                format!(",\"fields\":{{{}}}", pairs.join(","))
            }
            _ => String::new(),
        };
        eprintln!(
            "[canvas-edge-agentd] {{\"ts\":\"{}\",\"level\":\"error\",\"module\":\"{}\",\"message\":\"{}\"{}}}",
            ts, self.module_name, message, fields_json
        );
    }

    fn timestamp(&self) -> String {
        // ISO 8601 in UTC, formatted manually to avoid pulling in chrono for this one concern.
        // The `chrono` crate is already a dependency of the workspace, but keeping this
        // dependency-free lets this module be usable without chrono if needed.
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::ZERO);
        let secs = now.as_secs();
        // Compute YYYY-MM-DDTHH:MM:SSZ from a Unix timestamp.
        // Based on the standard leap-year-aware algorithm.
        let days = secs / 86400;
        let time_secs = secs % 86400;
        let hours = time_secs / 3600;
        let minutes = (time_secs % 3600) / 60;
        let seconds = time_secs % 60;

        let (y, m, d) = civil_from_days(days as i64);
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
            y, m, d, hours, minutes, seconds
        )
    }
}

// ---------------------------------------------------------------------------
// Utility: Gregorian calendar from days since Unix epoch
// ---------------------------------------------------------------------------

/// Converts a number of days since the Unix epoch (1970-01-01) to a
/// (year, month, day) triple. Based on Howard Hinnant's chrono::year_month_day
/// algorithm, which is public-domain-equivalent.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097; // day of era [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // year of era [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // day of year [0, 365]
    let mp = (5 * doy + 2) / 153; // month phase [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // day [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // month [1, 12]
    let y = if m <= 2 { y + 1 } else { y }; // adjust year for Jan/Feb
    (y, m as u32, d as u32)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- RealMetricsCollector tests ----------

    #[test]
    fn test_real_collector_defaults() {
        let c = RealMetricsCollector::new();
        let snap = c.snapshot();
        assert_eq!(snap.connections, 0);
        assert_eq!(snap.commands_total, 0);
        assert_eq!(snap.commands_failed_total, 0);
        assert_eq!(snap.ipc_requests_total, 0);
        assert_eq!(snap.transport_reconnects_total, 0);
        // memory_bytes and uptime_seconds are non-deterministic, just check they exist
        assert!(snap.collected_at > 0);
    }

    #[test]
    fn test_real_collector_counters() {
        let c = RealMetricsCollector::new();
        c.record_command();
        c.record_command();
        c.record_command_failed();
        c.record_ipc_request();
        c.record_transport_reconnect();
        c.set_connections(3);

        let snap = c.snapshot();
        assert_eq!(snap.commands_total, 2);
        assert_eq!(snap.commands_failed_total, 1);
        assert_eq!(snap.ipc_requests_total, 1);
        assert_eq!(snap.transport_reconnects_total, 1);
        assert_eq!(snap.connections, 3);
    }

    #[test]
    fn test_real_collector_uptime_increases() {
        let c = RealMetricsCollector::new();
        let snap1 = c.snapshot();
        std::thread::sleep(Duration::from_millis(10));
        let snap2 = c.snapshot();
        assert!(snap2.uptime_seconds >= snap1.uptime_seconds);
    }

    // ---------- FakeMetricsCollector tests ----------

    #[test]
    fn test_fake_collector_defaults() {
        let c = FakeMetricsCollector::new();
        let snap = c.snapshot();
        assert_eq!(snap.connections, 0);
        assert_eq!(snap.commands_total, 0);
        assert_eq!(snap.commands_failed_total, 0);
        assert_eq!(snap.ipc_requests_total, 0);
        assert_eq!(snap.transport_reconnects_total, 0);
        assert_eq!(snap.memory_bytes, 0);
    }

    #[test]
    fn test_fake_collector_counters() {
        let c = FakeMetricsCollector::new();
        c.record_command();
        c.record_command_failed();
        c.record_ipc_request();
        c.record_transport_reconnect();
        c.set_connections(2);

        let snap = c.snapshot();
        assert_eq!(snap.commands_total, 1);
        assert_eq!(snap.commands_failed_total, 1);
        assert_eq!(snap.ipc_requests_total, 1);
        assert_eq!(snap.transport_reconnects_total, 1);
        assert_eq!(snap.connections, 2);
    }

    #[test]
    fn test_fake_collector_set_memory_bytes() {
        let c = FakeMetricsCollector::new();
        assert_eq!(c.snapshot().memory_bytes, 0);
        c.set_memory_bytes(42_000_000);
        assert_eq!(c.snapshot().memory_bytes, 42_000_000);
    }

    #[test]
    fn test_fake_collector_is_send_sync() {
        // Compile-time check: FakeMetricsCollector implements Send + Sync
        fn assert_send<T: Send>() {}
        fn assert_sync<T: Sync>() {}
        assert_send::<FakeMetricsCollector>();
        assert_sync::<FakeMetricsCollector>();
    }

    // ---------- MetricsSnapshot tests ----------

    #[test]
    fn test_snapshot_as_fields() {
        let snap = MetricsSnapshot {
            uptime_seconds: 123.45,
            connections: 2,
            commands_total: 10,
            commands_failed_total: 1,
            ipc_requests_total: 42,
            transport_reconnects_total: 3,
            memory_bytes: 50_000_000,
            collected_at: 1_000_000,
        };
        let fields = snap.as_fields();
        assert!((fields["agent.uptime_seconds"] - 123.45).abs() < 0.001);
        assert_eq!(fields["agent.connections"] as u64, 2);
        assert_eq!(fields["agent.commands_total"] as u64, 10);
        assert_eq!(fields["agent.commands_failed_total"] as u64, 1);
        assert_eq!(fields["agent.ipc_requests_total"] as u64, 42);
        assert_eq!(fields["agent.transport_reconnects_total"] as u64, 3);
        assert_eq!(fields["agent.memory_bytes"] as u64, 50_000_000);
    }

    // ---------- StructuredLogger tests ----------

    #[test]
    fn test_structured_logger_info_format() {
        let logger = StructuredLogger::new("test");
        // Capture stdout: we can't easily do this in a unit test, but we can verify
        // the log method doesn't panic and produces valid-looking output.
        // The actual test is that the format matches the expected schema.
        // We'll just verify the logger can be constructed and called.
        logger.info("test message", None);
        // No assertion — we just verify no panic. The output goes to stdout.
    }

    #[test]
    fn test_structured_logger_with_fields() {
        let logger = StructuredLogger::new("test");
        logger.info(
            "command executed",
            Some(&[("command_id", &"cmd-123"), ("status", &"ok")]),
        );
        // No assertion — just verifying no panic.
    }

    #[test]
    fn test_structured_logger_error() {
        let logger = StructuredLogger::new("test");
        logger.error("something went wrong", Some(&[("code", &"E42")]));
        // No assertion — just verifying no panic.
    }

    #[test]
    fn test_structured_logger_timestamp_format() {
        let logger = StructuredLogger::new("test");
        let ts = logger.timestamp();
        // Should be ISO 8601: YYYY-MM-DDTHH:MM:SSZ
        assert_eq!(ts.len(), 20, "timestamp should be 20 chars: {ts}");
        assert_eq!(&ts[4..5], "-", "expected dash at position 4: {ts}");
        assert_eq!(&ts[7..8], "-", "expected dash at position 7: {ts}");
        assert_eq!(&ts[10..11], "T", "expected T at position 10: {ts}");
        assert_eq!(&ts[13..14], ":", "expected colon at position 13: {ts}");
        assert_eq!(&ts[16..17], ":", "expected colon at position 16: {ts}");
        assert_eq!(&ts[19..20], "Z", "expected Z at position 19: {ts}");
    }

    // ---------- civil_from_days tests ----------

    #[test]
    fn test_civil_from_days_epoch() {
        // 1970-01-01 is day 0
        let (y, m, d) = civil_from_days(0);
        assert_eq!(y, 1970i64);
        assert_eq!(m, 1);
        assert_eq!(d, 1);
    }

    #[test]
    fn test_civil_from_days_known_date() {
        // 2026-07-19: days since 1970-01-01
        // We trust the algorithm; spot-check a few known dates.
        // 2026-07-19: let's compute via known values.
        // 2026 is 56 years after 1970; 56*365 = 20440 + 14 leap days = 20454 days
        // Jan 31, Feb 28, Mar 31, Apr 30, May 31, Jun 30 = 181 days through June
        // Jul 19 = 19 days into July = 181 + 19 = 200 days into the year
        // Total = 20454 + 200 = 20654 approximately
        // (actual: 20654 + 1 for the leap day offset algorithm)
        let (y, m, d) = civil_from_days(20653);
        assert_eq!(y, 2026i64);
        assert_eq!(m, 7);
        assert_eq!(d, 19);
    }

    #[test]
    fn test_civil_from_days_leap_year() {
        // 2024-02-29 (leap day)
        // 2024 is 54 years after 1970; 54*365 = 19710 + 13 leap days = 19723
        // Jan 31 = 31, Feb 29 = 29 -> 31 + 29 = 60 days
        // Total = 19723 + 60 = 19783
        // (actual: 19783 -- algorithm is correct)
        let (y, m, d) = civil_from_days(19782);
        assert_eq!(y, 2024i64);
        assert_eq!(m, 2);
        assert_eq!(d, 29);
    }

    // ---------- Trait injectability test ----------

    #[test]
    fn test_metrics_collector_trait_object() {
        // Both Real and Fake implement the trait, so they can be used polymorphically.
        let real: Box<dyn MetricsCollector> = Box::new(RealMetricsCollector::new());
        let fake: Box<dyn MetricsCollector> = Box::new(FakeMetricsCollector::new());

        let snap_real = real.snapshot();
        let snap_fake = fake.snapshot();

        // Both should return valid snapshots
        assert!(snap_real.collected_at > 0);
        assert!(snap_fake.collected_at > 0);
    }
}
