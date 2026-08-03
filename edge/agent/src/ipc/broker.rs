//! `LocalIpcBroker`: the real Rust port of the design contract already proven in
//! `tests/local-ipc/local-ipc-model.ts` / `docs/PHASE_0_LOCAL_IPC_SPEC.md` (threat-model item
//! P0-04, ADR 0003). See that model and spec for the full design rationale; this module implements
//! the same behavior, plus real transport wiring (see `peer.rs` and the `accept`/`read_request`/
//! `write_response` functions below).
//!
//! Simplifications relative to a full production wire protocol (deliberate, Phase 1 scope):
//! - one newline-delimited JSON request and one newline-delimited JSON response per accepted
//!   connection round-trip -- no persistent multi-request session framing, no length-prefixing,
//!   no compression/backpressure handling;
//! - synchronous/blocking I/O only, one connection at a time from the caller's point of view --
//!   no async runtime, no connection pool;
//! - no socket file permission/ownership provisioning (mode `0700`/`0600` directory/socket, as
//!   `docs/PHASE_0_LOCAL_IPC_SPEC.md` requires for production) -- that is packaging/installation
//!   work, not broker logic;
//! - no systemd sandboxing / dedicated service-user provisioning (also explicitly deferred by the
//!   spec to Phase 1 packaging work, not this module).
//!
//! There is deliberately no key-material type or import anywhere in this module. Mirroring the TS
//! model's `AgentKeyStore` design note: the Agent's device private key must never be reachable
//! through any IPC method, for any role, and the absence of any such code path here is itself part
//! of what `tests/local_ipc_v1.rs` asserts.

use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};

use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};

use crate::ipc::peer::{PeerCredential, PeerCredentialSource};

/// The two roles ever authenticated over this boundary. Unrecognized uids never make it this far
/// -- `LocalIpcBroker::connect` rejects them with `wrong_peer` before any role/session exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PeerRole {
    Renderer,
    Updater,
}

/// The single uid permitted to authenticate as each role. The Agent's own configuration is the
/// only place that maps a uid to a role -- there is no code path where a peer can claim one.
#[derive(Debug, Clone, Copy)]
pub struct LocalIpcConfig {
    pub renderer_uid: u32,
    pub updater_uid: u32,
}

/// Illustrative renderer method allowlist (see architecture plan §25 follow-up checklist items
/// for the real, fully-specified renderer action set -- enumerating that is explicitly out of
/// scope for this module), plus the small set of *current* renderer actions this Agent actually
/// forwards today (see `actions.rs`'s `CurrentRendererAction`).
const RENDERER_METHOD_ALLOWLIST: &[&str] = &[
    "scene.activate",
    "media.session.control",
    "hardware.brightness.get",
    "hardware.brightness.set",
    "hardware.query_capabilities",
    "display.screen_off",
    "display.screen_on",
    "display.set_brightness",
    "agent.app_version",
    "audio.play",
    "audio.pause",
    "audio.resume",
    "audio.stop",
    "audio.set_volume",
    "audio.set_mute",
    "audio.state",
    // Media adapters (Phase 3 Content Bridge): YouTube IFrame Player URL resolution + status
    // callbacks, and radio station resolution + playback. These are dispatched by the daemon's
    // `DaemonActionHandler` (see `edge/agentd/src/ipc.rs`) to the `MediaAdapters` bundle.
    "media.youtube.play",
    "media.youtube.status",
    "media.youtube.state",
    "media.radio.play",
    "media.radio.stop",
    "media.radio.state",
    "renderer.recovery_screen",
    "agent.device_identity",
    "audio.list_devices",
    "audio.test_mic",
    "audio.test_speaker",
];

/// Illustrative updater/helper method allowlist, disjoint from the renderer allowlist above.
/// `updater.agent_version` is the Phase 1 proof-of-concept wiring: it lets the updater learn the
/// Agent's running version over the role-scoped channel (see `edge/agentd/src/ipc.rs` and
/// `edge/updater/src/agent_client.rs`). The other three remain unwired server-side handlers today.
const UPDATER_METHOD_ALLOWLIST: &[&str] = &[
    "updater.install_package",
    "updater.rollback",
    "updater.health_report",
    "updater.agent_version",
];

/// Rejection codes, matching the TS model's error codes exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalIpcErrorCode {
    WrongPeer,
    StaleCapability,
    MethodNotAllowed,
    NonceRequired,
    NonceReplayed,
    ExecutionFailed,
}

impl LocalIpcErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            LocalIpcErrorCode::WrongPeer => "wrong_peer",
            LocalIpcErrorCode::StaleCapability => "stale_capability",
            LocalIpcErrorCode::MethodNotAllowed => "method_not_allowed",
            LocalIpcErrorCode::NonceRequired => "nonce_required",
            LocalIpcErrorCode::NonceReplayed => "nonce_replayed",
            LocalIpcErrorCode::ExecutionFailed => "execution_failed",
        }
    }
}

impl std::fmt::Display for LocalIpcErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalIpcError {
    pub code: LocalIpcErrorCode,
    pub message: String,
}

impl LocalIpcError {
    fn new(code: LocalIpcErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for LocalIpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for LocalIpcError {}

/// Returned by [`LocalIpcBroker::connect`] on a successful peer authentication.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthenticatedSession {
    pub role: PeerRole,
    pub generation: u64,
    pub capability_token: String,
}

/// One method call, as it would arrive over the wire (see [`read_request`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DispatchRequest {
    pub capability_token: String,
    pub method: String,
    /// Required only for the updater channel; must be unique per accepted request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nonce: Option<String>,
    /// Opaque method arguments, forwarded to the configured [`crate::ipc::actions::ActionExecutor`]
    /// only after every authorization check has already passed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<serde_json::Value>,
}

/// A successful dispatch result, as it would be written back over the wire (see
/// [`write_response`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DispatchResponse {
    pub ok: bool,
    pub result: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CapabilityRecord {
    role: PeerRole,
    generation: u64,
    revoked: bool,
}

/// A tiny stand-in for Agent-side durable state (outbox sequence, desired hardware state, ...)
/// that must survive renderer restarts. Production is real local SQLite (see
/// `canvas_edge_agent::storage`); this type only proves that the broker's peer-reconnect handling
/// never resets or discards it -- it is deliberately not wired to generation/capability
/// bookkeeping at all.
#[derive(Debug, Default)]
pub struct DurableAgentState {
    outbox_sequence: u64,
}

impl DurableAgentState {
    pub fn next_outbox_sequence(&mut self) -> u64 {
        self.outbox_sequence += 1;
        self.outbox_sequence
    }

    pub fn outbox_sequence(&self) -> u64 {
        self.outbox_sequence
    }
}

/// The real Rust port of the TS model's `LocalIpcBroker`. See the module-level docs for scope and
/// simplifications.
pub struct LocalIpcBroker {
    config: LocalIpcConfig,
    capabilities: HashMap<String, CapabilityRecord>,
    used_nonces: HashSet<String>,
    generation_by_role: HashMap<PeerRole, u64>,
    token_source: Box<dyn FnMut() -> String + Send>,
    executor: Box<dyn crate::ipc::actions::ActionExecutor>,
    /// Agent-owned durable state. Deliberately public (mirroring the TS model's public
    /// `durableState` field): it is decoupled from per-generation capability bookkeeping and must
    /// survive peer reconnects untouched.
    pub durable_state: DurableAgentState,
}

impl LocalIpcBroker {
    pub fn new(config: LocalIpcConfig) -> Self {
        Self::with_token_source(config, default_token_source)
    }

    /// Constructs a broker with an injectable capability-token generator (useful for
    /// deterministic tests). Production callers should use [`LocalIpcBroker::new`].
    pub fn with_token_source(
        config: LocalIpcConfig,
        token_source: impl FnMut() -> String + Send + 'static,
    ) -> Self {
        Self::with_token_source_and_executor(
            config,
            token_source,
            crate::ipc::actions::PlaceholderActionExecutor,
        )
    }

    /// Constructs a broker with an injectable capability-token generator and a real
    /// `ActionExecutor`. Every allowlisted, authorized call reaching [`LocalIpcBroker::dispatch`]
    /// is forwarded to `executor` instead of the `PlaceholderActionExecutor` placeholder
    /// [`LocalIpcBroker::new`] uses by default.
    pub fn with_token_source_and_executor(
        config: LocalIpcConfig,
        token_source: impl FnMut() -> String + Send + 'static,
        executor: impl crate::ipc::actions::ActionExecutor + 'static,
    ) -> Self {
        Self {
            config,
            capabilities: HashMap::new(),
            used_nonces: HashSet::new(),
            generation_by_role: HashMap::new(),
            token_source: Box::new(token_source),
            executor: Box::new(executor),
            durable_state: DurableAgentState::default(),
        }
    }

    /// Identifies the connecting peer from its OS-verified credential. Never trusts a
    /// self-reported role -- the only input is `credential.uid`, and only this method's
    /// comparison against `self.config` decides the role.
    fn identify(&self, credential: &PeerCredential) -> Result<PeerRole, LocalIpcError> {
        if credential.uid == self.config.renderer_uid {
            Ok(PeerRole::Renderer)
        } else if credential.uid == self.config.updater_uid {
            Ok(PeerRole::Updater)
        } else {
            Err(LocalIpcError::new(
                LocalIpcErrorCode::WrongPeer,
                format!("uid {} is not an authorized local IPC peer", credential.uid),
            ))
        }
    }

    /// Called once per new transport connection (production: once per accepted Unix socket
    /// connection, immediately after reading `SO_PEERCRED`; see [`LocalIpcBroker::accept`]). A
    /// successful connection always starts a new generation for that role, immediately
    /// invalidating capability tokens from any prior generation -- this is what makes a stale
    /// token from a crashed/replaced peer process useless, without requiring an explicit
    /// revocation call.
    pub fn connect(
        &mut self,
        credential: PeerCredential,
    ) -> Result<AuthenticatedSession, LocalIpcError> {
        let role = self.identify(&credential)?;

        let previous_generation = *self.generation_by_role.get(&role).unwrap_or(&0);
        let generation = previous_generation + 1;
        self.generation_by_role.insert(role, generation);

        for record in self.capabilities.values_mut() {
            if record.role == role && record.generation < generation {
                record.revoked = true;
            }
        }

        let capability_token = (self.token_source)();
        self.capabilities.insert(
            capability_token.clone(),
            CapabilityRecord {
                role,
                generation,
                revoked: false,
            },
        );

        Ok(AuthenticatedSession {
            role,
            generation,
            capability_token,
        })
    }

    /// Explicit disconnect notification; Agent-owned durable state is intentionally untouched.
    pub fn disconnect(&mut self, _session: &AuthenticatedSession) {
        // Intentionally a no-op on durable state: Agent-owned durable state (outbox, hardware
        // desired state, etc.) must never be reset just because the renderer/updater
        // disconnected.
    }

    /// Dispatches one method call. Every check is independent of whether the token is otherwise
    /// "valid" for its role -- an in-scope role with an out-of-scope method is rejected the same
    /// way a completely wrong peer would be, which is what makes this resistant to a hostile
    /// WebView (or any other code running adjacent to the renderer) that manages to reuse a
    /// leaked, structurally valid renderer capability token to try to reach a privileged method.
    pub fn dispatch(
        &mut self,
        request: DispatchRequest,
    ) -> Result<DispatchResponse, LocalIpcError> {
        let record = match self.capabilities.get(&request.capability_token) {
            Some(record) if !record.revoked => *record,
            _ => {
                return Err(LocalIpcError::new(
                    LocalIpcErrorCode::StaleCapability,
                    "capability token is unknown or superseded by a newer generation",
                ))
            }
        };

        let allowlist = match record.role {
            PeerRole::Renderer => RENDERER_METHOD_ALLOWLIST,
            PeerRole::Updater => UPDATER_METHOD_ALLOWLIST,
        };
        if !allowlist.contains(&request.method.as_str()) {
            return Err(LocalIpcError::new(
                LocalIpcErrorCode::MethodNotAllowed,
                format!(
                    "method '{}' is not in the {:?} allowlist",
                    request.method, record.role
                ),
            ));
        }

        if record.role == PeerRole::Updater {
            match &request.nonce {
                None => {
                    return Err(LocalIpcError::new(
                        LocalIpcErrorCode::NonceRequired,
                        "privileged updater methods require a single-use nonce",
                    ))
                }
                Some(nonce) => {
                    if self.used_nonces.contains(nonce) {
                        return Err(LocalIpcError::new(
                            LocalIpcErrorCode::NonceReplayed,
                            "this nonce has already been consumed",
                        ));
                    }
                    self.used_nonces.insert(nonce.clone());
                }
            }
        }

        let result = self
            .executor
            .execute(record.role, &request.method, request.arguments.as_ref())
            .map_err(|message| LocalIpcError::new(LocalIpcErrorCode::ExecutionFailed, message))?;

        Ok(DispatchResponse { ok: true, result })
    }

    /// Accepts one real connection from `listener`, identifies the peer via `credential_source`
    /// (production: [`crate::ipc::peer::SoPeercredSource`], reading real `SO_PEERCRED`), and
    /// authenticates it into a new session exactly as [`LocalIpcBroker::connect`] would. Returns
    /// the accepted stream (so the caller can use it for request/response framing, e.g.
    /// [`read_request`]/[`write_response`]) together with the resulting session.
    pub fn accept(
        &mut self,
        listener: &UnixListener,
        credential_source: &dyn PeerCredentialSource,
    ) -> Result<(UnixStream, AuthenticatedSession), AcceptError> {
        let (stream, _addr) = listener.accept().map_err(AcceptError::Io)?;
        let credential = credential_source
            .identify(&stream)
            .map_err(AcceptError::Io)?;
        let session = self.connect(credential).map_err(AcceptError::Rejected)?;
        Ok((stream, session))
    }
}

/// Failure modes of [`LocalIpcBroker::accept`]: either a real I/O/credential-read failure, or a
/// successfully identified but unauthorized/rejected peer.
#[derive(Debug)]
pub enum AcceptError {
    Io(io::Error),
    Rejected(LocalIpcError),
}

impl std::fmt::Display for AcceptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AcceptError::Io(err) => write!(f, "io error accepting local IPC connection: {err}"),
            AcceptError::Rejected(err) => write!(f, "local IPC peer rejected: {err}"),
        }
    }
}

impl std::error::Error for AcceptError {}

/// Reads exactly one newline-delimited JSON [`DispatchRequest`] from `stream`. See module docs
/// for why this minimal framing (and not a full production wire protocol) is sufficient for this
/// Phase 1 checklist item.
pub fn read_request(stream: &UnixStream) -> io::Result<DispatchRequest> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    let read = reader.read_line(&mut line)?;
    if read == 0 {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "peer closed the connection before sending a request",
        ));
    }
    serde_json::from_str(line.trim_end())
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))
}

/// Writes one newline-delimited JSON response line: either a successful [`DispatchResponse`] or
/// the `code`/`message` of a [`LocalIpcError`].
pub fn write_response(
    mut stream: &UnixStream,
    outcome: &Result<DispatchResponse, LocalIpcError>,
) -> io::Result<()> {
    #[derive(Serialize)]
    #[serde(untagged)]
    enum WireResponse<'a> {
        Ok(&'a DispatchResponse),
        Err {
            code: LocalIpcErrorCode,
            message: &'a str,
        },
    }

    let wire = match outcome {
        Ok(response) => WireResponse::Ok(response),
        Err(err) => WireResponse::Err {
            code: err.code,
            message: &err.message,
        },
    };

    let json = serde_json::to_string(&wire)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
    stream.write_all(json.as_bytes())?;
    stream.write_all(b"\n")
}

fn default_token_source() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    let mut hex = String::with_capacity(bytes.len() * 2 + 4);
    hex.push_str("cap_");
    for byte in bytes {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}
