//! Minimal Agent↔updater IPC client: lets the updater/helper process reach the Agent's local IPC
//! broker as an `updater`-role peer and call one `updater.*` method (Phase 1 proof-of-concept
//! wiring, per the architecture plan's "IPC between the Agent and updater" checklist item).
//!
//! This is the updater's half of the cross-process channel. The Agent side is
//! `canvas_edge_agentd::ipc::serve_ipc` (which runs the `LocalIpcBroker` against a real
//! `UnixListener`); this module is the client that speaks the daemon's exact wire framing:
//!
//! 1. Connect to the Agent's IPC Unix socket (path from `CANVAS_EDGE_IPC_SOCKET`, defaulting to
//!    `/run/canvas-edge/agent.sock` -- the same default the Agent uses).
//! 2. The server authenticates the connecting process via real `SO_PEERCRED` and, on success,
//!    writes one newline-delimited JSON `SessionWire` line: `{"role":"updater","generation":N,
//!    "capability_token":"cap_..."}`. The client reads that line to learn its capability token.
//!    The client never self-reports a role -- the kernel-verified uid is the only thing that maps
//!    to a role, server-side.
//! 3. The client sends one newline-delimited JSON `DispatchRequest` (including the capability token
//!    and a single-use `nonce`, which the updater channel requires) and reads one
//!    newline-delimited JSON response.
//!
//! The updater must run as the uid the Agent's broker is configured to treat as the `Updater` role
//! (see `docs/PHASE_0_LOCAL_IPC_SPEC.md` "Peer identity and role resolution"); otherwise the
//! `SO_PEERCRED` check rejects the connection with `wrong_peer` before any token is issued. In the
//! integration tests the server is started with `updater_uid` set to the test process's own uid, so
//! the same process authenticates as `updater`.
//!
//! Honest scope note: this is a single-request-per-connection client mirroring the daemon's
//! minimal Phase 1 framing. It proves the cross-process, role-scoped channel works end-to-end
//! (real `SO_PEERCRED`, real allowlist enforcement, real dispatch). It is not the full update
//! orchestration -- the other `updater.*` methods (`install_package`, `rollback`,
//! `health_report`) are not yet wired server-side beyond the allowlist.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;

use serde::Deserialize;

/// Environment variable overriding the Agent IPC socket path. Must match the Agent's
/// `CANVAS_EDGE_IPC_SOCKET` (see `canvas_edge_agentd::ipc::IPC_SOCKET_PATH_ENV`).
pub const AGENT_IPC_SOCKET_ENV: &str = "CANVAS_EDGE_IPC_SOCKET";

/// Default socket path, matching the Agent's `DEFAULT_IPC_SOCKET_PATH`
/// (`/run/canvas-edge/agent.sock`).
pub const DEFAULT_AGENT_IPC_SOCKET: &str = "/run/canvas-edge/agent.sock";

/// Resolves the Agent IPC socket path from the environment, falling back to
/// [`DEFAULT_AGENT_IPC_SOCKET`].
pub fn resolve_socket_path() -> PathBuf {
    match std::env::var(AGENT_IPC_SOCKET_ENV) {
        Ok(value) if !value.is_empty() => PathBuf::from(value),
        _ => PathBuf::from(DEFAULT_AGENT_IPC_SOCKET),
    }
}

/// The session line the Agent writes to the client immediately after `accept`. Mirrors the
/// `SessionWire` struct in `edge/agentd/src/ipc.rs`. Only `capability_token` is needed by the
/// client (the role/generation are server-asserted and logged for diagnostics), so the other
/// fields are read but not otherwise used.
#[derive(Debug, Deserialize)]
struct SessionWire {
    #[allow(dead_code)]
    role: String,
    #[allow(dead_code)]
    generation: u64,
    capability_token: String,
}

/// A response line: either `{"ok":true,"result":"..."}` or `{"code":"...","message":"..."}`.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ResponseWire {
    Ok { ok: bool, result: String },
    Err { code: String, message: String },
}

/// Reads exactly one newline-delimited JSON line from `reader` and deserializes it as `T`.
fn read_json_line<T: serde::de::DeserializeOwned>(reader: &mut impl BufRead) -> std::io::Result<T> {
    let mut line = String::new();
    let n = reader.read_line(&mut line)?;
    if n == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "peer closed the connection before sending a line",
        ));
    }
    serde_json::from_str(line.trim_end())
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))
}

/// Error returned by [`AgentIpcClient`] calls. Wraps the underlying I/O failure or an explicit
/// rejection the Agent returned over the wire (`code`/`message`).
#[derive(Debug)]
pub enum AgentIpcError {
    /// The connection/handshake/read/write failed at the transport layer.
    Io(std::io::Error),
    /// The Agent authenticated the connection but rejected the request (e.g. `method_not_allowed`,
    /// `nonce_replayed`, `stale_capability`).
    Rejected { code: String, message: String },
}

impl std::fmt::Display for AgentIpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AgentIpcError::Io(err) => write!(f, "agent IPC transport error: {err}"),
            AgentIpcError::Rejected { code, message } => {
                write!(f, "agent IPC request rejected ({code}): {message}")
            }
        }
    }
}

impl std::error::Error for AgentIpcError {}

impl From<std::io::Error> for AgentIpcError {
    fn from(err: std::io::Error) -> Self {
        AgentIpcError::Io(err)
    }
}

/// A minimal client for the Agent's local IPC broker, authenticated as an `updater` peer.
///
/// Construct with [`AgentIpcClient::connect`], then call one method (e.g.
/// [`AgentIpcClient::agent_version`]). Each client opens its own connection, performs the
/// `SessionWire` handshake, and closes the connection after the single request/response round-trip
/// -- matching the daemon's one-request-per-connection framing.
pub struct AgentIpcClient {
    stream: UnixStream,
    capability_token: String,
}

impl AgentIpcClient {
    /// Connects to the Agent IPC socket at `socket_path` and performs the `SessionWire` handshake,
    /// learning the capability token the Agent issued for this connection. The connecting process's
    /// real `SO_PEERCRED` uid must be the one the Agent's broker treats as the `Updater` role, or
    /// the Agent rejects the connection before this returns successfully.
    pub fn connect(socket_path: &std::path::Path) -> Result<Self, AgentIpcError> {
        let stream = UnixStream::connect(socket_path)?;
        let mut reader = BufReader::new(stream);
        let session: SessionWire = read_json_line(&mut reader)?;
        // The role is server-asserted from SO_PEERCRED; we only need the token to send requests.
        // Keep the BufReader's inner stream for subsequent writes.
        let stream = reader.into_inner();
        Ok(Self {
            stream,
            capability_token: session.capability_token,
        })
    }

    /// Sends one `updater.*` request with a single-use nonce and reads the response. The nonce is
    /// required by the updater channel; callers must supply a unique value per request (this client
    /// is single-request-per-connection, so a fresh random nonce per call is sufficient).
    fn call(&mut self, method: &str, nonce: &str) -> Result<String, AgentIpcError> {
        let request = serde_json::json!({
            "capability_token": self.capability_token,
            "method": method,
            "nonce": nonce,
        });
        let mut stream = &self.stream;
        serde_json::to_writer(&mut stream, &request).map_err(|err| {
            AgentIpcError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, err))
        })?;
        stream.write_all(b"\n")?;
        stream.flush()?;

        let mut reader = BufReader::new(&self.stream);
        let response: ResponseWire = read_json_line(&mut reader)?;
        match response {
            ResponseWire::Ok { ok: true, result } => Ok(result),
            ResponseWire::Ok { ok: false, .. } => Err(AgentIpcError::Rejected {
                code: "execution_failed".to_string(),
                message: "agent returned ok:false".to_string(),
            }),
            ResponseWire::Err { code, message } => Err(AgentIpcError::Rejected { code, message }),
        }
    }

    /// Queries the Agent's running version (`updater.agent_version`). Returns the Agent's
    /// `CARGO_PKG_VERSION` string. This is the minimal, honest cross-process query the updater uses
    /// to learn what version of the Agent it is supervising.
    pub fn agent_version(&mut self) -> Result<String, AgentIpcError> {
        let nonce = generate_nonce();
        self.call("updater.agent_version", &nonce)
    }
}

/// Generates a single-use nonce for an updater request. Uses `OsRng` so it matches the strength of
/// the Agent's capability tokens without pulling in extra dependencies.
fn generate_nonce() -> String {
    use rand::rngs::OsRng;
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    let mut hex = String::with_capacity(bytes.len() * 2 + 5);
    hex.push_str("nonce_");
    for byte in bytes {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// Convenience helper: connect to the Agent IPC socket (path resolved from the environment or the
/// default) and call `updater.agent_version` in one shot. Useful for the updater daemon's
/// "what version is the Agent running?" probe.
pub fn query_agent_version(socket_path: &std::path::Path) -> Result<String, AgentIpcError> {
    let mut client = AgentIpcClient::connect(socket_path)?;
    client.agent_version()
}
