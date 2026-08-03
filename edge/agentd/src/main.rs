//! Canvas Edge Agent daemon entry point.
//!
//! Opens the durable SQLite-backed `Storage` at a configurable data directory, runs the
//! crash-recovery pass (`recover_non_repeatable_running`) once at startup exactly as a real
//! restart-after-crash would require, logs a summary (including a `canvas_edge_agent::diagnostics`
//! summary -- uptime, recovery count, epoch state, version/arch -- re-logged periodically), loads
//! a persisted wire-protocol resume cursor (`Storage::load_resume_cursor`, distinct from
//! `Storage::Epochs`'s local `i64` durability-journal counters -- see `ResumeCursorRecord`'s doc
//! comment) if one exists, spawns the real async WebSocket transport
//! (`canvas_edge_agent::transport::spawn`, ADR 0009) against a configurable Core URL, and idles
//! until it receives a termination signal, logging every `TransportEvent` it observes and
//! persisting the resume cursor again on each *clean* disconnect.
//!
//! **Honest scope note:** the resume cursor is only durably updated on a clean disconnect (per
//! ADR 0009 -- an abrupt drop means recent outgoing messages' delivery to Core is unknown, so
//! persisting then could later claim more than Core actually observed); there is no real Core to
//! verify an actual reconnect-and-resume round trip against yet. `TransportEvent`s other than
//! `Disconnected` are still only logged, not fed back into `Storage` (e.g. pruning the outbox on
//! an acked event).
//!
//! The local IPC surface IS now wired up: [`ipc::serve_ipc`] opens a real `UnixListener` on a
//! configurable socket path and runs the `LocalIpcBroker` (proven in `edge/agent/tests/local_ipc_v1.rs`)
//! on its own dedicated OS thread, mirroring the transport thread's shutdown pattern. See
//! `edge/agentd/src/ipc.rs` for what is real vs. logging-only in the wired-up action handler.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use rand::rngs::OsRng;
use rand::Rng;
use uuid::Uuid;

use canvas_edge_agent::diagnostics::DiagnosticsSummary;
use canvas_edge_agent::pairing::RealPairingHttpClient;
use canvas_edge_agent::protocol::DeviceV1ControlMessage;
use canvas_edge_agent::session::{EdgeSession, EdgeSessionOptions};
use canvas_edge_agent::storage::{ResumeCursorRecord, Storage};
use canvas_edge_agent::supervisor::{self, SidecarConfig};
use canvas_edge_agent::transport::{self, BackoffConfig, HeartbeatConfig, TransportEvent};

use canvas_edge_agentd::enrollment::{resolve_enrollment_with_real_http, EnrollmentOutcome};
use canvas_edge_agentd::ipc;

const DATA_DIR_ENV: &str = "CANVAS_EDGE_AGENT_DATA_DIR";
const DEFAULT_DATA_DIR: &str = "/var/lib/canvas-edge-agent";

/// Non-authoritative device identifier included in `edge.hello` for bootstrap/diagnostics only
/// (plan doc §12.4). In production Core derives device identity from the authenticated mTLS
/// connection and ignores this for authorization; the bootstrap Device Gateway records it as a
/// convenience key. When unset we generate a stable random UUIDv4 once per process so repeated
/// reconnects to the bootstrap gateway map to the same device row (a fresh UUID each run would
/// litter the devices table). This is NOT persisted to disk -- it is a diagnostics hint, not the
/// device's real, certificate-bound identity.
const DEVICE_ID_ENV: &str = "CANVAS_EDGE_DEVICE_ID";

/// Core WebSocket URL to connect to. There is no real production Core to connect to yet in this
/// development slice -- the default is a deliberately unreachable placeholder host, so an
/// unconfigured daemon fails to connect (and logs that failure via `TransportEvent::Disconnected`
/// and backs off) rather than silently doing nothing.
const CORE_URL_ENV: &str = "CANVAS_EDGE_CORE_WS_URL";
const DEFAULT_CORE_URL: &str = "wss://core.canvas.invalid/agent/v1";

/// P-003 enrollment env vars. See `edge/agentd/src/enrollment.rs` for the full semantics. These
/// are re-declared here only so the fallback-error log line in `main()` can name them without
/// reaching into the enrollment module's private items; the actual resolution lives in
/// `enrollment::resolve_enrollment_with_real_http`.
const CANVAS_EDGE_INVITATION_TOKEN_ENV: &str = "CANVAS_EDGE_INVITATION_TOKEN";
const CANVAS_EDGE_CORE_HTTP_URL_ENV: &str = "CANVAS_EDGE_CORE_HTTP_URL";
const CANVAS_EDGE_CORE_WS_URL_ENV: &str = "CANVAS_EDGE_CORE_WS_URL";

/// Path to the legacy `canvas-display-server` sidecar binary. When set, the daemon spawns and
/// supervises the sidecar on a dedicated `std::thread` (see `edge/agent/src/supervisor/`),
/// replacing Tauri's direct `app.shell().sidecar(...).spawn()` in
/// `browser/linux/src-tauri/src/lib.rs`. When unset, sidecar supervision is skipped -- this is
/// fine for dev/testing without a real sidecar binary on disk, and matches the coexistence posture
/// (Tauri's own spawn is left untouched and can keep running in parallel until the Edge Agent path
/// is proven).
const SIDECAR_BINARY_ENV: &str = "CANVAS_EDGE_SIDECAR_BINARY";

/// Sidecar HTTP bind port, matching the `PORT=3100` the Tauri app passes today (see
/// `browser/linux/src-tauri/src/lib.rs`'s `setup()` sidecar-spawn block and
/// `docs/PHASE_3_SIDECAR_INVENTORY.md` §9.4).
const SIDECAR_PORT_DEFAULT: &str = "3100";

/// Sidecar HTTP bind address. Hardcoded to `127.0.0.1` to preserve the Phase 1 loopback lock (see
/// `docs/PHASE_1_SIDECAR_LOOPBACK_INVENTORY.md`): the bundled sidecar must never be reachable
/// from the LAN, only from the kiosk's own webview. The Tauri app's spawn already sets this; the
/// Edge Agent supervision sets the same value so the two supervisors produce identical binds.
const SIDECAR_HOST_DEFAULT: &str = "127.0.0.1";

/// How often the idle loop below re-logs a diagnostics summary. This is a coarse, best-effort
/// heartbeat for anyone tailing the journal live -- it is not a substitute for the on-demand
/// `diagnostics.summary` IPC method a future renderer-side recovery screen would use (see
/// `edge/agent/src/diagnostics/mod.rs` doc comments for that plan).
const PERIODIC_DIAGNOSTICS_INTERVAL: Duration = Duration::from_secs(300);

fn resolve_data_dir() -> PathBuf {
    match env::var(DATA_DIR_ENV) {
        Ok(value) if !value.is_empty() => PathBuf::from(value),
        _ => PathBuf::from(DEFAULT_DATA_DIR),
    }
}

fn resolve_core_url() -> String {
    match env::var(CORE_URL_ENV) {
        Ok(value) if !value.is_empty() => value,
        _ => DEFAULT_CORE_URL.to_string(),
    }
}

/// Builds the [`SidecarConfig`] for the legacy `canvas-display-server` sidecar from the daemon's
/// own env vars, mirroring exactly what the Tauri app passes in `browser/linux/src-tauri/src/lib.rs`'s
/// `setup()` sidecar-spawn block: `CANVAS_DATA_DIR`, `NATIVE_BINDING_DIR`, `STATIC_DIR`, `PORT=3100`,
/// and `HOST=127.0.0.1` (the Phase 1 loopback lock -- see `docs/PHASE_1_SIDECAR_LOOPBACK_INVENTORY.md`).
///
/// `binary_path` comes from `CANVAS_EDGE_SIDECAR_BINARY`. `CANVAS_DATA_DIR` defaults to the daemon's
/// own data dir (the sidecar shares the daemon's durable storage location, exactly as it shares
/// the Tauri app's `app_data_dir` today). `NATIVE_BINDING_DIR` and `STATIC_DIR` default to empty
/// strings (the sidecar treats an unset value the same as the Tauri app's
/// `{resource_dir}/binaries` fallback when running outside a Tauri bundle); an operator running
/// under Edge Agent supervision should set them explicitly to the on-disk locations.
///
/// Returns `None` when `CANVAS_EDGE_SIDECAR_BINARY` is unset, signaling "skip sidecar supervision"
/// -- this is the dev/testing default and the coexistence posture (Tauri's own spawn is left
/// untouched).
fn resolve_sidecar_config(data_dir: &std::path::Path) -> Option<SidecarConfig> {
    let binary_path = match env::var(SIDECAR_BINARY_ENV) {
        Ok(value) if !value.is_empty() => std::path::PathBuf::from(value),
        _ => return None,
    };
    let canvas_data_dir =
        env::var("CANVAS_DATA_DIR").unwrap_or_else(|_| data_dir.to_string_lossy().into_owned());
    let native_binding_dir = env::var("NATIVE_BINDING_DIR").unwrap_or_default();
    let static_dir = env::var("STATIC_DIR").unwrap_or_default();
    let port = env::var("PORT").unwrap_or_else(|_| SIDECAR_PORT_DEFAULT.to_string());
    let env_vars = vec![
        ("CANVAS_DATA_DIR".to_string(), canvas_data_dir),
        ("NATIVE_BINDING_DIR".to_string(), native_binding_dir),
        ("STATIC_DIR".to_string(), static_dir),
        ("PORT".to_string(), port),
        // Phase 1 loopback lock: the bundled sidecar must never be reachable from the LAN.
        ("HOST".to_string(), SIDECAR_HOST_DEFAULT.to_string()),
    ];
    Some(SidecarConfig {
        binary_path,
        env_vars,
        args: Vec::new(),
        ..SidecarConfig::default()
    })
}

/// Resolves the non-authoritative `device_id` sent in `edge.hello`. Honors
/// `CANVAS_EDGE_DEVICE_ID` when set; otherwise loads a durable ID from the Edge data directory.
/// A new UUID is generated and persisted only on the first launch, so daemon restarts and
/// reconnects update one Core registry row instead of creating ghost devices.
fn resolve_device_id(data_dir: &Path) -> String {
    if let Ok(value) = env::var(DEVICE_ID_ENV) {
        if !value.is_empty() {
            return value;
        }
    }

    let path = data_dir.join("device-id");
    if let Ok(value) = fs::read_to_string(&path) {
        let value = value.trim();
        if Uuid::parse_str(value).is_ok() {
            return value.to_string();
        }
        eprintln!(
            "[canvas-edge-agentd] ignoring invalid persisted device ID at {}",
            path.display()
        );
    }

    let device_id = generate_device_id();
    if let Err(err) = fs::create_dir_all(data_dir).and_then(|_| fs::write(&path, &device_id)) {
        eprintln!(
            "[canvas-edge-agentd] failed to persist device ID at {}: {err}; this identity will last only for this process",
            path.display()
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(err) = fs::set_permissions(&path, fs::Permissions::from_mode(0o600)) {
            eprintln!(
                "[canvas-edge-agentd] failed to restrict permissions on {}: {err}",
                path.display()
            );
        }
    }
    device_id
}

/// Generates a stable random UUIDv4 for this process when `CANVAS_EDGE_DEVICE_ID` is unset. Mirrors
/// `canvas_edge_agent::session::state::generate_uuid_v4`'s construction (real random UUIDv4, no
/// seeded/test counter) rather than pulling in the `uuid` crate's `v4` feature.
fn generate_device_id() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
    Uuid::from_bytes(bytes).to_string()
}

/// Builds and logs a [`DiagnosticsSummary`], one `[canvas-edge-agentd] ...`-prefixed line per
/// fact (matching every other log line in this file). Called once right after startup recovery,
/// and again periodically from the idle loop below.
fn log_diagnostics_summary(
    start: Instant,
    recovered_count: usize,
    epochs: canvas_edge_agent::storage::Epochs,
) {
    let summary =
        DiagnosticsSummary::new(start, recovered_count, epochs, env!("CARGO_PKG_VERSION"));
    for line in summary.to_log_lines() {
        println!("[canvas-edge-agentd] {line}");
    }
}

/// Logs one line per [`TransportEvent`] observed from the transport thread, and durably persists
/// the resume cursor on a *clean* disconnect (see `TransportEvent::Disconnected`'s doc comment for
/// why an abrupt disconnect is not safe to persist: recent outgoing messages' delivery to Core is
/// unknown in that case, so persisting could later claim more than Core actually observed).
fn handle_transport_event(storage: &mut Storage, event: TransportEvent) {
    match event {
        TransportEvent::Connected => {
            println!("[canvas-edge-agentd] transport: connected to Core");
        }
        TransportEvent::Disconnected {
            clean,
            detail,
            resume_cursor,
        } => {
            if clean {
                let record = ResumeCursorRecord {
                    core_stream_epoch: resume_cursor.core_stream_epoch.map(|id| id.to_string()),
                    edge_stream_epoch: resume_cursor.edge_stream_epoch.map(|id| id.to_string()),
                    last_core_sequence: resume_cursor.last_core_sequence,
                    last_edge_sequence_acked: resume_cursor.last_edge_sequence_acked,
                };
                match storage.save_resume_cursor(&record) {
                    Ok(()) => {
                        println!(
                            "[canvas-edge-agentd] transport: disconnected (clean={clean}): {detail} -- resume cursor persisted"
                        );
                    }
                    Err(err) => {
                        eprintln!(
                            "[canvas-edge-agentd] transport: disconnected (clean={clean}): {detail} -- failed to persist resume cursor: {err}"
                        );
                    }
                }
            } else {
                println!(
                    "[canvas-edge-agentd] transport: disconnected (clean={clean}): {detail} -- not persisting resume cursor (unclean disconnect)"
                );
            }
        }
        TransportEvent::Inbound(message) => {
            println!(
                "[canvas-edge-agentd] transport: inbound {}",
                safe_message_type(&message)
            );
        }
        TransportEvent::Outbound(message) => {
            println!(
                "[canvas-edge-agentd] transport: outbound {}",
                safe_message_type(&message)
            );
        }
        TransportEvent::MalformedFrame(detail) => {
            println!("[canvas-edge-agentd] transport: malformed frame: {detail}");
        }
    }
}

fn safe_message_type(message: &DeviceV1ControlMessage) -> &'static str {
    match message {
        DeviceV1ControlMessage::EdgeHello(_) => "edge.hello",
        DeviceV1ControlMessage::CoreWelcome(_) => "core.welcome",
        DeviceV1ControlMessage::EdgeHeartbeat(_) => "edge.heartbeat",
        DeviceV1ControlMessage::CoreHeartbeat(_) => "core.heartbeat",
        DeviceV1ControlMessage::StreamAck(_) => "stream.ack",
        DeviceV1ControlMessage::StreamReset(_) => "stream.reset",
        DeviceV1ControlMessage::StateDesired(_) => "state.desired",
        DeviceV1ControlMessage::StateReported(_) => "state.reported",
        DeviceV1ControlMessage::DiagnosticsEchoCommandIssue(_) => "command.issue",
        DeviceV1ControlMessage::CommandReceived(_) => "command.received",
        DeviceV1ControlMessage::CommandCompleted(_) => "command.completed",
        DeviceV1ControlMessage::CommandRejected(_) => "command.rejected",
        DeviceV1ControlMessage::CommandFailed(_) => "command.failed",
        DeviceV1ControlMessage::CommandCancelled(_) => "command.cancelled",
        DeviceV1ControlMessage::CommandUnknownOutcome(_) => "command.unknown_outcome",
        DeviceV1ControlMessage::ProtocolError(_) => "protocol.error",
    }
}

fn main() {
    let start = Instant::now();
    let data_dir = resolve_data_dir();

    if let Err(err) = std::fs::create_dir_all(&data_dir) {
        eprintln!(
            "[canvas-edge-agentd] failed to create data dir {}: {err}",
            data_dir.display()
        );
        std::process::exit(1);
    }

    let db_path = data_dir.join("agent.sqlite3");
    println!(
        "[canvas-edge-agentd] opening durable storage at {}",
        db_path.display()
    );

    let mut storage = match Storage::open(&db_path) {
        Ok(storage) => storage,
        Err(err) => {
            eprintln!("[canvas-edge-agentd] failed to open storage: {err}");
            std::process::exit(1);
        }
    };

    let recovered_count = match storage.recover_non_repeatable_running() {
        Ok(recovered) if recovered.is_empty() => {
            println!(
                "[canvas-edge-agentd] startup recovery: no non-repeatable commands were left running"
            );
            0
        }
        Ok(recovered) => {
            println!(
                "[canvas-edge-agentd] startup recovery: {} non-repeatable command(s) left running \
                 before the last shutdown were marked unknown_outcome and will not be retried: {:?}",
                recovered.len(),
                recovered
            );
            recovered.len()
        }
        Err(err) => {
            eprintln!("[canvas-edge-agentd] startup recovery failed: {err}");
            std::process::exit(1);
        }
    };

    let epochs = match storage.epochs() {
        Ok(epochs) => {
            println!(
                "[canvas-edge-agentd] epochs: core_stream={} edge_stream={} authority={} restore_generation={}",
                epochs.core_stream_epoch, epochs.edge_stream_epoch, epochs.authority_epoch, epochs.restore_generation
            );
            epochs
        }
        Err(err) => {
            eprintln!("[canvas-edge-agentd] failed to read epochs: {err}");
            std::process::exit(1);
        }
    };

    log_diagnostics_summary(start, recovered_count, epochs);

    let session_options = match storage.load_resume_cursor() {
        Ok(Some(record)) => {
            println!("[canvas-edge-agentd] restoring resume cursor from storage: {record:?}");
            let core_stream_epoch = record.core_stream_epoch.as_deref().and_then(|value| {
                Uuid::parse_str(value)
                    .inspect_err(|err| {
                        eprintln!(
                            "[canvas-edge-agentd] failed to parse persisted core_stream_epoch {value:?}: {err}; falling back to a fresh epoch"
                        );
                    })
                    .ok()
            });
            let edge_stream_epoch = record.edge_stream_epoch.as_deref().and_then(|value| {
                Uuid::parse_str(value)
                    .inspect_err(|err| {
                        eprintln!(
                            "[canvas-edge-agentd] failed to parse persisted edge_stream_epoch {value:?}: {err}; falling back to a fresh epoch"
                        );
                    })
                    .ok()
            });
            EdgeSessionOptions {
                core_stream_epoch,
                edge_stream_epoch,
                last_core_sequence: record.last_core_sequence,
                last_edge_sequence_acked: record.last_edge_sequence_acked,
                ..EdgeSessionOptions::default()
            }
        }
        Ok(None) => {
            println!("[canvas-edge-agentd] no persisted resume cursor found -- starting fresh");
            EdgeSessionOptions::default()
        }
        Err(err) => {
            eprintln!(
                "[canvas-edge-agentd] failed to load persisted resume cursor: {err}; starting fresh"
            );
            EdgeSessionOptions::default()
        }
    };

    let core_url = resolve_core_url();
    let device_id = resolve_device_id(&data_dir);

    // P-003 enrollment handshake: load (or generate + persist) the durable `EdgeIdentity`, then
    // either load a cached credential from disk, run the two-step HTTP handshake against Core if an
    // invitation token is configured, or fall back to the legacy open hello. This runs on the main
    // thread *before* the transport thread is spawned: the HTTP client is blocking (`reqwest::blocking`)
    // and must not run inside the transport thread's `current_thread` tokio runtime (ADR 0009 confines
    // tokio to the WS thread; a blocking call there would stall WebSocket I/O and heartbeat timers).
    // A failure here is logged but NOT fatal: the daemon falls back to an open hello so an
    // unconfigured or temporarily-unreachable Core does not prevent the agent from starting and
    // serving the renderer over local IPC. The operator can re-enroll with a fresh invitation later.
    //
    // See `edge/agentd/src/enrollment.rs` for the testable decision tree and
    // `docs/PAIRING_ENROLLMENT_CONTRACT.md` for the wire shapes.
    let http_client = RealPairingHttpClient::new();
    let enrollment_outcome = match resolve_enrollment_with_real_http(&data_dir, &http_client) {
        Ok(outcome) => {
            match &outcome {
                EnrollmentOutcome::OpenHello { .. } => {
                    println!(
                        "[canvas-edge-agentd] enrollment: no invitation configured and no cached \
                         credential -- falling back to open hello"
                    );
                }
                EnrollmentOutcome::LoadedFromDisk { .. } => {
                    println!(
                        "[canvas-edge-agentd] enrollment: loaded cached credential from disk"
                    );
                }
                EnrollmentOutcome::Enrolled { .. } => {
                    println!(
                        "[canvas-edge-agentd] enrollment: handshake completed and credential persisted"
                    );
                }
            }
            outcome
        }
        Err(err) => {
            eprintln!(
                "[canvas-edge-agentd] enrollment: {err}; falling back to open hello. \
                 Set {CANVAS_EDGE_INVITATION_TOKEN_ENV} (and {CANVAS_EDGE_CORE_HTTP_URL_ENV} or \
                 {CANVAS_EDGE_CORE_WS_URL_ENV}) to enroll."
            );
            EnrollmentOutcome::OpenHello {
                installation_id: canvas_edge_agentd::enrollment::resolve_installation_id(),
            }
        }
    };

    println!(
        "[canvas-edge-agentd] starting transport thread, Core URL: {core_url} (device_id: {device_id})"
    );
    let mut session_options = session_options;
    session_options.device_id = Some(device_id.clone());
    session_options.desired_hardware =
        Some(canvas_edge_agent::hardware::HardwareAdapters::new_real());
    session_options.scene_server_url = Some(
        std::env::var("CANVAS_EDGE_SCENE_SERVER_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:8099".to_string()),
    );
    enrollment_outcome.apply_to(&mut session_options);
    let session = EdgeSession::new(session_options);
    let transport_handle = transport::spawn(
        core_url,
        session,
        BackoffConfig::default(),
        HeartbeatConfig::default(),
    );

    let content_bridge = match canvas_edge_agent::media::ContentBridge::spawn(
        canvas_edge_agent::media::ContentBridgeConfig::default(),
    ) {
        Ok(handle) => {
            println!(
                "[canvas-edge-agentd] content bridge: listening on 127.0.0.1:{}",
                handle.port()
            );
            handle
        }
        Err(error) => {
            eprintln!("[canvas-edge-agentd] failed to start content bridge: {error}");
            let _ = transport_handle
                .commands
                .send(canvas_edge_agent::transport::TransportCommand::Shutdown);
            let _ = transport_handle.join();
            std::process::exit(1);
        }
    };

    // Start the local IPC broker on its own dedicated OS thread (NOT tokio -- ADR 0009 confines
    // tokio to the transport thread above). The broker authenticates local peers via real
    // SO_PEERCRED and dispatches allowlisted renderer/updater methods; see `edge/agentd/src/ipc.rs`
    // and `edge/agent/src/ipc/` for the full design. A failure to bind the IPC socket is fatal:
    // the renderer can never reach the Agent without it.
    let ipc_socket_path = ipc::resolve_socket_path();
    let renderer_uid = ipc::resolve_renderer_uid();
    let updater_uid = ipc::resolve_updater_uid();

    // Extract stable identity fields for the IPC handler's `agent.device_identity` method.
    let (installation_id, public_key_fingerprint) = match &enrollment_outcome {
        EnrollmentOutcome::OpenHello { installation_id } => (installation_id.as_str(), ""),
        EnrollmentOutcome::LoadedFromDisk {
            installation_id,
            public_key_fingerprint,
            ..
        }
        | EnrollmentOutcome::Enrolled {
            installation_id,
            public_key_fingerprint,
            ..
        } => (installation_id.as_str(), public_key_fingerprint.as_str()),
    };

    let ipc_handle = match ipc::serve_ipc_with_identity(
        ipc_socket_path,
        renderer_uid,
        updater_uid,
        &device_id,
        installation_id,
        public_key_fingerprint,
    ) {
        Ok(handle) => handle,
        Err(err) => {
            eprintln!("[canvas-edge-agentd] failed to open local IPC socket: {err}; shutting down");
            // Still shut the transport thread down cleanly before exiting.
            let _ = transport_handle
                .commands
                .send(canvas_edge_agent::transport::TransportCommand::Shutdown);
            let _ = transport_handle.join();
            std::process::exit(1);
        }
    };

    // Start the sidecar supervisor AFTER the IPC and transport threads are up, so the sidecar
    // comes up last (and goes down first on shutdown -- see the shutdown block below). When
    // `CANVAS_EDGE_SIDECAR_BINARY` is unset, sidecar supervision is skipped: this is the
    // dev/testing default and the coexistence posture (Tauri's own spawn in
    // `browser/linux/src-tauri/src/lib.rs` is left untouched and can keep running in parallel
    // until the Edge Agent supervision is proven on real kiosks). A failure to start the sidecar
    // is logged but NOT fatal: the daemon still serves the renderer over IPC and the transport
    // thread still talks to Core; the sidecar is one subsystem among several, not a hard
    // dependency.
    //
    // The supervisor runs its monitoring loop on its own `std::thread` (named
    // `canvas-edge-sidecar`), NOT tokio -- ADR 0009 confines tokio to the single WS transport
    // thread. See `edge/agent/src/supervisor/` for the full design.
    let sidecar_handle = resolve_sidecar_config(&data_dir)
        .and_then(|config| {
            println!(
                "[canvas-edge-agentd] sidecar: starting supervision of {} (HOST={}, PORT={})",
                config.binary_path.display(),
                config
                    .env_vars
                    .iter()
                    .find(|(k, _)| k == "HOST")
                    .map(|(_, v)| v.as_str())
                    .unwrap_or("unset"),
                config
                    .env_vars
                    .iter()
                    .find(|(k, _)| k == "PORT")
                    .map(|(_, v)| v.as_str())
                    .unwrap_or("unset"),
            );
            match supervisor::SidecarHandle::spawn_monitor(
                Box::new(supervisor::real_supervisor()),
                config,
            ) {
                Ok(handle) => Some(handle),
                Err(err) => {
                    eprintln!(
                        "[canvas-edge-agentd] sidecar: failed to start supervision: {err} (continuing without sidecar)"
                    );
                    None
                }
            }
        });

    let running = Arc::new(AtomicBool::new(true));
    let handler_running = Arc::clone(&running);
    if let Err(err) = ctrlc::set_handler(move || {
        println!("[canvas-edge-agentd] shutdown signal received");
        handler_running.store(false, Ordering::SeqCst);
    }) {
        eprintln!("[canvas-edge-agentd] failed to install signal handler: {err}");
        std::process::exit(1);
    }

    println!(
        "[canvas-edge-agentd] ready (idle loop; transport + IPC threads running in the background)"
    );
    let mut last_diagnostics_log = Instant::now();
    while running.load(Ordering::SeqCst) {
        while let Ok(event) = transport_handle.events.try_recv() {
            handle_transport_event(&mut storage, event);
        }
        thread::sleep(Duration::from_millis(250));
        if last_diagnostics_log.elapsed() >= PERIODIC_DIAGNOSTICS_INTERVAL {
            last_diagnostics_log = Instant::now();
            log_diagnostics_summary(start, recovered_count, epochs);
        }
    }

    // Shut the SIDECAR down FIRST, before the IPC and transport threads: the sidecar is the
    // renderer's content source (the legacy `canvas-display-server` HTTP/WS server the kiosk webview
    // talks to), and graceful degradation order means the renderer should lose the sidecar *last*
    // during normal operation -- but during *shutdown* we stop it first so it does not get orphaned
    // if the IPC/transport threads are already gone. Stopping the sidecar first also means a
    // renderer that is still connected sees the sidecar go away cleanly (its own reconnect logic
    // kicks in) rather than hanging on a half-up Agent. This is the inverse of the startup order
    // (sidecar started last), which is the standard supervisor pattern.
    if let Some(handle) = sidecar_handle {
        println!("[canvas-edge-agentd] shutting down sidecar supervisor");
        handle.shutdown_and_join();
    } else {
        println!("[canvas-edge-agentd] sidecar supervision was not started -- nothing to stop");
    }

    println!("[canvas-edge-agentd] shutting down content bridge");
    content_bridge.shutdown_and_join();

    // Shut the IPC thread down NEXT: it serves local peers, and stopping it before the
    // transport thread means a renderer that connects during shutdown gets a clean refusal
    // (connection refused / stale socket) rather than a half-up Agent that accepted a request
    // it can no longer forward anywhere. This mirrors the transport thread's explicit-Shutdown
    // + join pattern, just applied to the IPC thread's AtomicBool flag.
    println!("[canvas-edge-agentd] shutting down IPC thread");
    ipc_handle.shutdown_and_join();

    println!("[canvas-edge-agentd] shutting down transport thread");
    let _ = transport_handle
        .commands
        .send(canvas_edge_agent::transport::TransportCommand::Shutdown);
    if let Err(err) = transport_handle.join() {
        eprintln!("[canvas-edge-agentd] transport thread panicked during shutdown: {err:?}");
    }

    println!("[canvas-edge-agentd] shutting down cleanly");
}
