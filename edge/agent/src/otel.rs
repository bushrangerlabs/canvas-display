//! OpenTelemetry-compatible metrics export for the Edge Agent.
//!
//! Extends the [`MetricsCollector`] from `observability.rs` to export metrics in
//! Prometheus text exposition format on an HTTP `/metrics` endpoint.
//!
//! ## Design
//!
//! - [`MetricsExporter`] trait abstracts the export destination (Prometheus HTTP,
//!   OTLP gRPC in future, or fake for testing).
//! - [`PrometheusMetricsExporter`] formats metrics as Prometheus text exposition
//!   (plan doc §22.3) and serves them via a tiny_http server on a configurable
//!   address.
//! - [`FakeMetricsExporter`] stores the last exported text in memory for assertions.
//! - The server runs on a plain `std::thread` (NOT tokio, consistent with ADR 0009)
//!   and is stopped via an `AtomicBool` shutdown flag.
//!
//! ## OTel naming convention
//!
//! Metric names use dots (not underscores) following OTel semantic conventions for
//! process-level metrics. The Prometheus format uses underscores internally but we
//! map to Prometheus-style names with underscores as the convention for the text
//! exposition format. All 7 metrics from `observability.rs` are exported.

use crate::observability::{MetricsCollector, MetricsSnapshot};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};

// ---------------------------------------------------------------------------
// MetricsExporter trait
// ---------------------------------------------------------------------------

/// A trait for exporting metrics snapshots to an external system.
pub trait MetricsExporter: Send + Sync + 'static {
    /// Export the given snapshot. Returns the rendered metrics text on success.
    fn export(&self, snapshot: &MetricsSnapshot) -> Result<String, String>;
}

// ---------------------------------------------------------------------------
// Prometheus text exposition format
// ---------------------------------------------------------------------------

/// Formats a `MetricsSnapshot` as Prometheus text exposition format (plan doc §22.3).
pub fn format_prometheus(snapshot: &MetricsSnapshot) -> String {
    let mut out = String::new();

    out.push_str("# HELP canvas_agent_uptime_seconds Agent uptime in seconds\n");
    out.push_str("# TYPE canvas_agent_uptime_seconds counter\n");
    out.push_str(&format!(
        "canvas_agent_uptime_seconds {}\n",
        snapshot.uptime_seconds
    ));

    out.push_str("# HELP canvas_agent_connections Current number of device gateway connections\n");
    out.push_str("# TYPE canvas_agent_connections gauge\n");
    out.push_str(&format!(
        "canvas_agent_connections {}\n",
        snapshot.connections
    ));

    out.push_str("# HELP canvas_agent_commands_total Total commands executed\n");
    out.push_str("# TYPE canvas_agent_commands_total counter\n");
    out.push_str(&format!(
        "canvas_agent_commands_total {}\n",
        snapshot.commands_total
    ));

    out.push_str("# HELP canvas_agent_commands_failed_total Total failed commands\n");
    out.push_str("# TYPE canvas_agent_commands_failed_total counter\n");
    out.push_str(&format!(
        "canvas_agent_commands_failed_total {}\n",
        snapshot.commands_failed_total
    ));

    out.push_str("# HELP canvas_agent_ipc_requests_total Total IPC requests handled\n");
    out.push_str("# TYPE canvas_agent_ipc_requests_total counter\n");
    out.push_str(&format!(
        "canvas_agent_ipc_requests_total {}\n",
        snapshot.ipc_requests_total
    ));

    out.push_str(
        "# HELP canvas_agent_transport_reconnects_total Transport reconnection attempts\n",
    );
    out.push_str("# TYPE canvas_agent_transport_reconnects_total counter\n");
    out.push_str(&format!(
        "canvas_agent_transport_reconnects_total {}\n",
        snapshot.transport_reconnects_total
    ));

    out.push_str("# HELP canvas_agent_memory_bytes Current RSS memory usage in bytes\n");
    out.push_str("# TYPE canvas_agent_memory_bytes gauge\n");
    out.push_str(&format!(
        "canvas_agent_memory_bytes {}\n",
        snapshot.memory_bytes
    ));

    out
}

// ---------------------------------------------------------------------------
// PrometheusMetricsExporter
// ---------------------------------------------------------------------------

/// A metrics exporter that serves Prometheus text exposition format on an HTTP
/// `/metrics` endpoint using `tiny_http`.
///
/// The server runs on a `std::thread` (NOT tokio, per ADR 0009). A shutdown flag
/// (`AtomicBool`) is checked after each request; setting it to `true` causes the
/// server loop to exit.
pub struct PrometheusMetricsExporter {
    collector: Arc<dyn MetricsCollector>,
    shutdown: Arc<AtomicBool>,
    addr: String,
}

impl PrometheusMetricsExporter {
    /// Create a new Prometheus exporter.
    ///
    /// `addr` is the bind address (e.g. `"127.0.0.1:9100"`). Default is from env
    /// `CANVAS_EDGE_METRICS_ADDR` or `127.0.0.1:9100`.
    pub fn new(collector: Arc<dyn MetricsCollector>) -> Self {
        let addr = std::env::var("CANVAS_EDGE_METRICS_ADDR")
            .unwrap_or_else(|_| "127.0.0.1:9100".to_string());
        Self {
            collector,
            shutdown: Arc::new(AtomicBool::new(false)),
            addr,
        }
    }

    /// Create with an explicit address (for testing).
    pub fn new_with_addr(collector: Arc<dyn MetricsCollector>, addr: &str) -> Self {
        Self {
            collector,
            shutdown: Arc::new(AtomicBool::new(false)),
            addr: addr.to_string(),
        }
    }

    /// Returns a clone of the shutdown flag so the caller can signal shutdown.
    pub fn shutdown_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.shutdown)
    }

    /// Returns the bind address.
    pub fn addr(&self) -> &str {
        &self.addr
    }

    /// Spawn the metrics HTTP server on a `std::thread` (NOT tokio).
    ///
    /// Returns a `JoinHandle` that the caller can join on shutdown.
    pub fn spawn(&self) -> JoinHandle<()> {
        let collector = Arc::clone(&self.collector);
        let shutdown = Arc::clone(&self.shutdown);
        let addr = self.addr.clone();

        thread::spawn(move || {
            // tiny_http::Server blocks on bind; if it fails we can't do much.
            let server = match tiny_http::Server::http(&addr) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!(
                        "[canvas-edge-agentd] metrics server failed to bind {}: {}",
                        addr, e
                    );
                    return;
                }
            };

            eprintln!("[canvas-edge-agentd] metrics server listening on {}", addr);

            // Serve requests until shutdown is signalled.
            loop {
                if shutdown.load(Ordering::Relaxed) {
                    break;
                }

                // `recv_timeout` so we can check the shutdown flag periodically.
                match server.recv_timeout(std::time::Duration::from_millis(500)) {
                    Ok(Some(request)) => {
                        let snapshot = collector.snapshot();
                        let body = format_prometheus(&snapshot);

                        let response = tiny_http::Response::from_string(body)
                            .with_status_code(200)
                            .with_header(
                                "Content-Type: text/plain; charset=utf-8"
                                    .parse::<tiny_http::Header>()
                                    .unwrap(),
                            );

                        let _ = request.respond(response);
                    }
                    Ok(None) => {
                        // Timeout, loop back to check shutdown.
                    }
                    Err(e) => {
                        eprintln!("[canvas-edge-agentd] metrics server error: {}", e);
                        // Brief sleep to avoid busy-looping on persistent errors.
                        thread::sleep(std::time::Duration::from_millis(100));
                    }
                }
            }

            eprintln!("[canvas-edge-agentd] metrics server shut down");
        })
    }
}

impl MetricsExporter for PrometheusMetricsExporter {
    fn export(&self, snapshot: &MetricsSnapshot) -> Result<String, String> {
        Ok(format_prometheus(snapshot))
    }
}

// ---------------------------------------------------------------------------
// FakeMetricsExporter
// ---------------------------------------------------------------------------

/// A fake metrics exporter for testing. Stores the last exported text.
pub struct FakeMetricsExporter {
    last_export: std::sync::Mutex<Option<String>>,
}

impl FakeMetricsExporter {
    pub fn new() -> Self {
        Self {
            last_export: std::sync::Mutex::new(None),
        }
    }

    /// Returns the last exported metrics text, or `None` if nothing has been exported.
    pub fn last_exported(&self) -> Option<String> {
        let guard = self.last_export.lock().unwrap();
        guard.clone()
    }
}

impl Default for FakeMetricsExporter {
    fn default() -> Self {
        Self::new()
    }
}

impl MetricsExporter for FakeMetricsExporter {
    fn export(&self, snapshot: &MetricsSnapshot) -> Result<String, String> {
        let text = format_prometheus(snapshot);
        let mut guard = self.last_export.lock().unwrap();
        *guard = Some(text.clone());
        Ok(text)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::observability::FakeMetricsCollector;

    fn make_snapshot() -> MetricsSnapshot {
        MetricsSnapshot {
            uptime_seconds: 12345.67,
            connections: 3,
            commands_total: 42,
            commands_failed_total: 2,
            ipc_requests_total: 99,
            transport_reconnects_total: 7,
            memory_bytes: 50_000_000,
            collected_at: 1_700_000_000,
        }
    }

    // ---------- Prometheus format tests ----------

    #[test]
    fn test_prometheus_format_contains_all_metrics() {
        let snapshot = make_snapshot();
        let text = format_prometheus(&snapshot);

        assert!(text.contains("canvas_agent_uptime_seconds 12345.67"));
        assert!(text.contains("canvas_agent_connections 3"));
        assert!(text.contains("canvas_agent_commands_total 42"));
        assert!(text.contains("canvas_agent_commands_failed_total 2"));
        assert!(text.contains("canvas_agent_ipc_requests_total 99"));
        assert!(text.contains("canvas_agent_transport_reconnects_total 7"));
        assert!(text.contains("canvas_agent_memory_bytes 50000000"));
    }

    #[test]
    fn test_prometheus_format_has_help_and_type_lines() {
        let snapshot = make_snapshot();
        let text = format_prometheus(&snapshot);

        assert!(text.contains("# HELP canvas_agent_uptime_seconds"));
        assert!(text.contains("# TYPE canvas_agent_uptime_seconds counter"));
        assert!(text.contains("# HELP canvas_agent_memory_bytes"));
        assert!(text.contains("# TYPE canvas_agent_memory_bytes gauge"));
    }

    #[test]
    fn test_prometheus_format_each_metric_on_its_own_line() {
        let snapshot = make_snapshot();
        let text = format_prometheus(&snapshot);

        let lines: Vec<&str> = text.lines().collect();
        let metric_lines: Vec<&&str> = lines
            .iter()
            .filter(|l| l.starts_with("canvas_agent_"))
            .collect();

        assert_eq!(metric_lines.len(), 7, "expected 7 metric lines");
    }

    #[test]
    fn test_prometheus_format_zero_values() {
        let snapshot = MetricsSnapshot {
            uptime_seconds: 0.0,
            connections: 0,
            commands_total: 0,
            commands_failed_total: 0,
            ipc_requests_total: 0,
            transport_reconnects_total: 0,
            memory_bytes: 0,
            collected_at: 0,
        };
        let text = format_prometheus(&snapshot);

        assert!(text.contains("canvas_agent_uptime_seconds 0"));
        assert!(text.contains("canvas_agent_connections 0"));
    }

    // ---------- FakeMetricsExporter tests ----------

    #[test]
    fn test_fake_exporter_stores_last_export() {
        let exporter = FakeMetricsExporter::new();
        assert!(exporter.last_exported().is_none());

        let snapshot = make_snapshot();
        let result = exporter.export(&snapshot).unwrap();
        assert!(result.contains("canvas_agent_uptime_seconds 12345.67"));

        let stored = exporter.last_exported().unwrap();
        assert!(stored.contains("canvas_agent_uptime_seconds 12345.67"));
    }

    // ---------- PrometheusMetricsExporter tests ----------

    #[test]
    fn test_prometheus_exporter_implements_metrics_exporter() {
        let collector = Arc::new(FakeMetricsCollector::new()) as Arc<dyn MetricsCollector>;
        let exporter = PrometheusMetricsExporter::new(collector);

        let snapshot = make_snapshot();
        let result = exporter.export(&snapshot).unwrap();
        assert!(result.contains("canvas_agent_connections"));
    }

    #[test]
    fn test_prometheus_exporter_shutdown_flag() {
        let collector = Arc::new(FakeMetricsCollector::new()) as Arc<dyn MetricsCollector>;
        let exporter = PrometheusMetricsExporter::new_with_addr(collector, "127.0.0.1:0");

        let flag = exporter.shutdown_flag();
        assert!(!flag.load(Ordering::Relaxed));
        flag.store(true, Ordering::Relaxed);
        assert!(flag.load(Ordering::Relaxed));
    }

    // ---------- HTTP endpoint integration test ----------

    #[test]
    fn test_metrics_http_endpoint_returns_200() {
        let collector = Arc::new(FakeMetricsCollector::new()) as Arc<dyn MetricsCollector>;
        // Find a free port by binding to port 0.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener); // release so tiny_http can bind

        let exporter =
            PrometheusMetricsExporter::new_with_addr(collector, &format!("127.0.0.1:{}", port));
        let shutdown = exporter.shutdown_flag();

        let handle = exporter.spawn();

        // Wait briefly for the server to start.
        std::thread::sleep(std::time::Duration::from_millis(200));

        // Fetch /metrics.
        let url = format!("http://127.0.0.1:{}/metrics", port);
        let response = reqwest::blocking::get(&url).unwrap();
        assert_eq!(response.status(), 200);

        let body = response.text().unwrap();
        assert!(body.contains("canvas_agent_uptime_seconds"));
        assert!(body.contains("canvas_agent_connections"));
        assert!(body.contains("canvas_agent_commands_total"));
        assert!(body.contains("canvas_agent_commands_failed_total"));
        assert!(body.contains("canvas_agent_ipc_requests_total"));
        assert!(body.contains("canvas_agent_transport_reconnects_total"));
        assert!(body.contains("canvas_agent_memory_bytes"));

        // Shutdown the server.
        shutdown.store(true, Ordering::Relaxed);
        let _ = handle.join();
    }
}
