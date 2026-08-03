use std::collections::HashMap;
use std::num::NonZeroU64;

use chrono::{DateTime, Utc};
use rand::rngs::OsRng;
use rand::RngCore;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::capabilities::{
    to_domain_application, CapabilityDetector, Domain, DomainOutcome, RealSystemCapabilityProbe,
};
use crate::hardware::HardwareAdapters;
use crate::protocol::{
    AgentInfo, AgentInfoArchitecture, AgentInfoVersion, CommandCompleted, CommandCompletedPayload,
    CommandCompletedPayloadIdempotencyKey, CommandCompletedPayloadResult, CommandReceived,
    CommandReceivedPayload, CommandReceivedPayloadIdempotencyKey, CommandRejected,
    CommandRejectedPayload, CommandRejectedPayloadCode, CommandRejectedPayloadIdempotencyKey,
    CommandRejectedPayloadMessage, CoreWelcome, DesiredState, DesiredStateDisplayPower,
    DeviceCredentialEnvelope, DeviceV1ControlMessage, DiagnosticsEchoCommandIssue,
    DomainApplication, EdgeHello, EdgeHelloInstallationId, EdgeHelloInvitationToken,
    EdgeHelloPublicKeyFingerprint, ProtocolError, ProtocolErrorCode, ProtocolErrorMessage,
    ProtocolRange, ReportedState, ReportedStateConnectivity, ReportedStateConnectivityCore,
    ReportedStateDisplay, ReportedStateDisplayPower, ReportedStateScene, ReportedStateSceneStatus,
    ResumeCursor, Sha256Digest, StateDesired, StateReported, StateReportedPayload,
    StateReportedPayloadStatus, StreamAck, StreamReset, Timestamp,
};

/// Injectable wall clock, matching the TS reference's `now: () => string` option. Boxed so tests
/// can supply a fixed/deterministic time. Requires `Send` so an `EdgeSession` (and therefore this
/// closure) can be moved into the dedicated WS thread spawned by `crate::transport::spawn` --
/// every real clock (including every test fixture in this crate) only closes over `Copy`/`Send`
/// data (a fixed timestamp, an `Arc<AtomicI64>`, etc.), so this is not a real restriction in
/// practice.
pub type ClockFn = Box<dyn Fn() -> DateTime<Utc> + Send>;

fn native_architecture() -> AgentInfoArchitecture {
    #[cfg(target_arch = "aarch64")]
    {
        AgentInfoArchitecture::Arm64
    }
    #[cfg(not(target_arch = "aarch64"))]
    {
        AgentInfoArchitecture::Amd64
    }
}

/// Options accepted by [`EdgeSession::new`], mirroring the TS `EdgeSimulatorOptions` interface.
#[derive(Default)]
pub struct EdgeSessionOptions {
    pub agent_version: Option<String>,
    pub architecture: Option<AgentInfoArchitecture>,
    pub core_stream_epoch: Option<Uuid>,
    pub edge_stream_epoch: Option<Uuid>,
    /// Seeds the resume cursor's `last_core_sequence`, matching what [`EdgeSession::resume_cursor`]
    /// would have returned for a prior session -- used to restore state across a process restart.
    /// Defaults to `0` (a fresh session that has not yet processed any Core message), same as
    /// before this field existed.
    pub last_core_sequence: Option<u64>,
    /// Seeds the resume cursor's `last_edge_sequence_acked`, for the same reason as
    /// `last_core_sequence` above. Defaults to `0`.
    pub last_edge_sequence_acked: Option<u64>,
    pub clock_uncertainty_ms: Option<i64>,
    pub clock: Option<ClockFn>,
    /// Optional, NON-AUTHORITATIVE device identifier included in `edge.hello` for
    /// bootstrap/diagnostics only (plan doc §12.4 and `contracts/device/v1`). In production Core
    /// derives device identity from the authenticated mTLS connection and ignores this value for
    /// authorization; the bootstrap Device Gateway may record it as a convenience key. When `None`,
    /// no `device_id` is emitted (the field is `skip_serializing_if = "Option::is_none"`).
    pub device_id: Option<String>,
    /// P-003 enrollment gate: optional stable Edge installation identifier. When open pairing is
    /// OFF, Core's gateway matches this against the paired `device_credentials` registry to
    /// authorize the hello. Populated by `canvas-edge-agentd` from the enrolled `EdgeIdentity`'s
    /// `installation_id` after a successful enrollment (or a durable credential load).
    pub installation_id: Option<String>,
    /// P-003 enrollment gate: optional SHA-256 hex of the device's raw 32-byte Ed25519 public key
    /// (matches `EdgeIdentity::public_key_fingerprint()`). Populated by the daemon after enrollment
    /// so the gateway can match the hello to a paired registry row by fingerprint.
    pub public_key_fingerprint: Option<String>,
    /// Optional one-time invitation token (P-003 bootstrap). Populated by the daemon from
    /// `CANVAS_EDGE_INVITATION_TOKEN` when the device has not yet enrolled -- the bootstrap gateway
    /// may mark the device paired/known on presentation. Left unset once a credential is on file.
    pub invitation_token: Option<String>,
    /// P-003 enrollment gate: optional Phase 0 signed credential issued by Core's enrollment
    /// endpoint. Populated by the daemon after a successful enrollment (or a durable credential
    /// load) so the gateway can verify the Core signature and match the hello to the registry even
    /// when open pairing is OFF. `None` falls back to the open-hello behavior.
    pub credential: Option<DeviceCredentialEnvelope>,
    /// Real hardware reconciliation used by the production daemon for desired display state.
    /// Simulators/tests leave this unset and inject domain outcomes explicitly.
    pub desired_hardware: Option<HardwareAdapters>,
    /// Loopback compatibility renderer base URL. Production points this at the legacy display
    /// server while native scene rendering is migrated; tests leave it unset.
    pub scene_server_url: Option<String>,
}

/// A snapshot of internal counters, mirroring the TS reference's `get snapshot()` accessor. Used
/// by tests to assert on state machine progress without exposing private fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EdgeSessionSnapshot {
    pub applied_desired_revision: u64,
    pub desired_apply_count: u64,
    pub echo_execution_count: u64,
    pub last_core_sequence: u64,
    pub last_edge_sequence_acked: u64,
    pub next_edge_sequence: u64,
    pub processed_desired_revision: u64,
}

#[derive(Clone, Debug)]
struct StoredEchoResult {
    request_digest: String,
    echoed: String,
}

/// Outcome of observing an incoming Core stream sequence number, mirroring the TS reference's
/// internal `SequenceDecision` (with the error case folded into `Result::Err`).
enum SequenceOutcome {
    Fresh,
    Duplicate,
}

/// A transport-agnostic Core↔Edge control-plane session/stream state machine.
///
/// Faithfully ported from `edge/simulator/src/edge-simulator.ts`'s `EdgeSimulator` class. See the
/// module-level docs for the one deliberate deviation (message ID generation).
pub struct EdgeSession {
    agent_version: String,
    architecture: AgentInfoArchitecture,
    clock_uncertainty_ms: i64,
    clock: ClockFn,
    core_stream_epoch: Uuid,
    edge_stream_epoch: Uuid,
    last_core_sequence: u64,
    last_edge_sequence_acked: u64,
    next_edge_sequence: u64,
    processed_desired_revision: u64,
    applied_desired_revision: u64,
    reported_revision: u64,
    desired_digest: Option<Sha256Digest>,
    authority_epoch: Option<Uuid>,
    desired_state: DesiredState,
    core_message_by_sequence: HashMap<u64, Value>,
    echo_results: HashMap<String, StoredEchoResult>,
    desired_apply_count: u64,
    echo_execution_count: u64,
    /// Optional, non-authoritative device identifier echoed into `edge.hello` for bootstrap/
    /// diagnostics (see `EdgeSessionOptions::device_id`). Never used for authorization.
    device_id: Option<String>,
    /// P-003 enrollment identity claim echoed into `edge.hello` (see `EdgeSessionOptions`). The
    /// gateway treats these as the real device identity when open pairing is OFF; they are `None`
    /// for the legacy open-hello path.
    installation_id: Option<String>,
    public_key_fingerprint: Option<String>,
    invitation_token: Option<String>,
    credential: Option<DeviceCredentialEnvelope>,
    /// Real per-domain reconciliation outcomes, injected via [`Self::set_domain_outcome`] by
    /// whatever component actually talks to the renderer/display/audio backends (out of scope
    /// for this session state machine itself -- see `crate::capabilities::domain` module docs).
    /// A domain with no entry here is reported as [`DomainOutcome::Pending`] by
    /// [`Self::report_applied_state`], not [`DomainOutcome::Applied`].
    domain_outcomes: HashMap<Domain, DomainOutcome>,
    desired_hardware: Option<HardwareAdapters>,
    scene_server_url: Option<String>,
}

fn default_core_stream_epoch() -> Uuid {
    Uuid::parse_str("0190efff-0000-7000-8000-000000000010").expect("valid literal UUID")
}

fn default_edge_stream_epoch() -> Uuid {
    Uuid::parse_str("0190efff-0000-7000-8000-000000000011").expect("valid literal UUID")
}

fn default_clock() -> DateTime<Utc> {
    Utc::now()
}

/// Generates a real random UUIDv4. See the module docs for why this replaces the TS reference's
/// deterministic fake-UUID counter.
fn generate_uuid_v4() -> Uuid {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
    Uuid::from_bytes(bytes)
}

/// Parses `value` into a schema-constrained wrapper type, panicking if it does not validate.
/// Used only for values Edge itself constructs (from already-validated inputs or fixed literals),
/// so a panic here indicates a programming error, not bad input from Core.
fn convert<T>(value: impl Into<String>) -> T
where
    T: std::str::FromStr,
    T::Err: std::fmt::Debug,
{
    let value = value.into();
    match value.parse() {
        Ok(parsed) => parsed,
        Err(error) => panic!("failed to convert {value:?}: {error:?}"),
    }
}

fn message_type_name(message: &DeviceV1ControlMessage) -> &'static str {
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

impl EdgeSession {
    pub fn new(options: EdgeSessionOptions) -> Self {
        Self {
            agent_version: options
                .agent_version
                .unwrap_or_else(|| "0.3.0-phase0".to_string()),
            architecture: options.architecture.unwrap_or_else(native_architecture),
            clock_uncertainty_ms: options.clock_uncertainty_ms.unwrap_or(0),
            clock: options.clock.unwrap_or_else(|| Box::new(default_clock)),
            core_stream_epoch: options
                .core_stream_epoch
                .unwrap_or_else(default_core_stream_epoch),
            edge_stream_epoch: options
                .edge_stream_epoch
                .unwrap_or_else(default_edge_stream_epoch),
            last_core_sequence: options.last_core_sequence.unwrap_or(0),
            last_edge_sequence_acked: options.last_edge_sequence_acked.unwrap_or(0),
            next_edge_sequence: 1,
            processed_desired_revision: 0,
            applied_desired_revision: 0,
            reported_revision: 0,
            desired_digest: None,
            authority_epoch: None,
            desired_state: DesiredState::default(),
            core_message_by_sequence: HashMap::new(),
            echo_results: HashMap::new(),
            desired_apply_count: 0,
            echo_execution_count: 0,
            domain_outcomes: HashMap::new(),
            desired_hardware: options.desired_hardware,
            scene_server_url: options.scene_server_url,
            device_id: options.device_id,
            installation_id: options.installation_id,
            public_key_fingerprint: options.public_key_fingerprint,
            invitation_token: options.invitation_token,
            credential: options.credential,
        }
    }

    /// Records the real reconciliation outcome for `domain`, to be reported by the next
    /// [`Self::report_applied_state`] call. Callers/tests can use this to inject an outcome
    /// without needing full IPC wiring to the renderer/display/audio backends, which is a
    /// separate, later task (see `crate::capabilities::domain` module docs).
    pub fn set_domain_outcome(&mut self, domain: Domain, outcome: DomainOutcome) {
        self.domain_outcomes.insert(domain, outcome);
    }

    pub fn snapshot(&self) -> EdgeSessionSnapshot {
        EdgeSessionSnapshot {
            applied_desired_revision: self.applied_desired_revision,
            desired_apply_count: self.desired_apply_count,
            echo_execution_count: self.echo_execution_count,
            last_core_sequence: self.last_core_sequence,
            last_edge_sequence_acked: self.last_edge_sequence_acked,
            next_edge_sequence: self.next_edge_sequence,
            processed_desired_revision: self.processed_desired_revision,
        }
    }

    /// Returns the resume-cursor fields this session would currently embed in a fresh
    /// `edge.hello` (see [`Self::create_hello`]) -- i.e. exactly what a caller needs to durably
    /// persist (e.g. in `canvas_edge_agent::storage::Storage`) so that a *future* `EdgeSession`,
    /// constructed after a process restart via [`EdgeSessionOptions`], can resume from the same
    /// point rather than starting from the compiled-in defaults. Callers should only treat this as
    /// safe-to-persist after a clean disconnect (see `transport::connection::DisconnectReason`) --
    /// this method itself does not know or care how/when it is called, that policy lives with the
    /// caller, per ADR 0009.
    pub fn resume_cursor(&self) -> ResumeCursor {
        ResumeCursor {
            core_stream_epoch: Some(self.core_stream_epoch),
            edge_stream_epoch: Some(self.edge_stream_epoch),
            last_core_sequence: Some(self.last_core_sequence),
            last_edge_sequence_acked: Some(self.last_edge_sequence_acked),
        }
    }

    /// Produces the initial `edge.hello` handshake message. Does not mutate session state, same
    /// as the TS reference's `createHello()`.
    ///
    /// P-003: when the daemon has enrolled (or loaded a durable credential), the hello carries the
    /// enrolled `credential`, `installation_id`, and `public_key_fingerprint` so Core's gateway can
    /// authorize it even with open pairing OFF. When none of those are configured, the hello falls
    /// back to the legacy open-pairing shape (optionally carrying an `invitation_token` for the
    /// bootstrap path). Invalid optional string fields are silently omitted rather than panicking,
    /// matching the `device_id` policy: a missing claim is always acceptable to Core in open-pairing
    /// mode, and a missing claim in closed-pairing mode produces a clean `unauthorized` rejection
    /// rather than a protocol error.
    pub fn create_hello(&self) -> EdgeHello {
        EdgeHello {
            agent: AgentInfo {
                architecture: self.architecture,
                platform: json!("linux"),
                version: convert::<AgentInfoVersion>(self.agent_version.clone()),
            },
            capabilities: CapabilityDetector::new(
                RealSystemCapabilityProbe::new(),
                self.architecture,
            )
            .detect(),
            message_id: self.next_id(),
            protocol: ProtocolRange {
                minimum: NonZeroU64::new(1).expect("nonzero literal"),
                maximum: NonZeroU64::new(1).expect("nonzero literal"),
            },
            resume: ResumeCursor {
                core_stream_epoch: Some(self.core_stream_epoch),
                edge_stream_epoch: Some(self.edge_stream_epoch),
                last_core_sequence: Some(self.last_core_sequence),
                last_edge_sequence_acked: Some(self.last_edge_sequence_acked),
            },
            sent_at: Timestamp(self.now()),
            type_: json!("edge.hello"),
            // Optional, non-authoritative diagnostics identity (plan doc §12.4). If the configured
            // value is somehow invalid for the wire type it is simply omitted rather than panicking
            // -- a missing `device_id` is always acceptable to Core.
            device_id: self
                .device_id
                .as_ref()
                .and_then(|value| crate::protocol::EdgeHelloDeviceId::try_from(value.clone()).ok()),
            // P-003 enrollment claims. Each is independently optional and silently omitted if the
            // configured value fails the wire type's length/charset constraints -- see the method
            // doc for why omission (not panic) is the right policy.
            installation_id: self
                .installation_id
                .as_ref()
                .and_then(|value| EdgeHelloInstallationId::try_from(value.clone()).ok()),
            public_key_fingerprint: self
                .public_key_fingerprint
                .as_ref()
                .and_then(|value| EdgeHelloPublicKeyFingerprint::try_from(value.clone()).ok()),
            invitation_token: self
                .invitation_token
                .as_ref()
                .and_then(|value| EdgeHelloInvitationToken::try_from(value.clone()).ok()),
            credential: self.credential.clone(),
        }
    }

    /// Dispatches an incoming Core message, mirroring `handleCoreMessage`'s `switch`.
    pub fn handle_core_message(
        &mut self,
        message: DeviceV1ControlMessage,
    ) -> Vec<DeviceV1ControlMessage> {
        match message {
            DeviceV1ControlMessage::CoreWelcome(welcome) => self.handle_welcome(welcome),
            DeviceV1ControlMessage::CoreHeartbeat(_) => Vec::new(),
            // The generated protocol enum is untagged, and EdgeHeartbeat/CoreHeartbeat have
            // identical field shapes. Serde therefore selects the first variant even when the
            // wire discriminator is `core.heartbeat`. Honor the frozen wire `type` value rather
            // than rejecting a valid Core heartbeat because of that generator limitation.
            DeviceV1ControlMessage::EdgeHeartbeat(heartbeat)
                if heartbeat.type_ == serde_json::json!("core.heartbeat") =>
            {
                Vec::new()
            }
            DeviceV1ControlMessage::StreamAck(ack) => {
                self.handle_stream_ack(ack);
                Vec::new()
            }
            DeviceV1ControlMessage::StreamReset(reset) => self.handle_stream_reset(reset),
            DeviceV1ControlMessage::StateDesired(desired) => self.handle_desired(desired),
            DeviceV1ControlMessage::DiagnosticsEchoCommandIssue(command) => {
                self.handle_echo_command(command)
            }
            other => {
                let kind = message_type_name(&other);
                vec![self
                    .protocol_error(
                        ProtocolErrorCode::UnknownMessage,
                        &format!("Edge simulator cannot consume {kind}."),
                        None,
                    )
                    .into()]
            }
        }
    }

    fn handle_welcome(&mut self, message: CoreWelcome) -> Vec<DeviceV1ControlMessage> {
        let protocol_value = message.protocol.as_i64().unwrap_or_default();
        if protocol_value != 1 {
            return vec![self
                .protocol_error(
                    ProtocolErrorCode::UnsupportedProtocol,
                    &format!("Unsupported negotiated protocol {protocol_value}."),
                    None,
                )
                .into()];
        }

        if self.core_stream_epoch != message.resume.core_stream_epoch {
            self.core_stream_epoch = message.resume.core_stream_epoch;
            self.last_core_sequence = 0;
            self.core_message_by_sequence.clear();
            // A new Core stream is an explicit resynchronization boundary. The next desired
            // message establishes the authority epoch for that stream.
            self.authority_epoch = None;
        }
        if self.edge_stream_epoch != message.resume.edge_stream_epoch {
            self.edge_stream_epoch = message.resume.edge_stream_epoch;
            self.last_edge_sequence_acked = 0;
            self.next_edge_sequence = 1;
        }
        Vec::new()
    }

    fn handle_stream_ack(&mut self, message: StreamAck) {
        if message.stream_epoch != self.edge_stream_epoch {
            return;
        }
        self.last_edge_sequence_acked = self
            .last_edge_sequence_acked
            .max(message.acknowledged_sequence.get());
    }

    fn handle_stream_reset(&mut self, message: StreamReset) -> Vec<DeviceV1ControlMessage> {
        if message.previous_stream_epoch != self.core_stream_epoch {
            return vec![self
                .protocol_error(
                    ProtocolErrorCode::StreamResetRequired,
                    "Stream reset did not match the active Core epoch.",
                    None,
                )
                .into()];
        }

        self.core_stream_epoch = message.new_stream_epoch;
        self.last_core_sequence = 0;
        self.core_message_by_sequence.clear();
        Vec::new()
    }

    fn handle_desired(&mut self, message: StateDesired) -> Vec<DeviceV1ControlMessage> {
        let content = serde_json::to_value(&message).expect("state.desired serializes to JSON");
        let outcome = match self.observe_core_sequence(
            message.stream_epoch,
            message.sequence,
            message.message_id,
            content,
        ) {
            Err(error) => return vec![(*error).into()],
            Ok(outcome) => outcome,
        };

        let ack = self.acknowledge(message.sequence);
        if matches!(outcome, SequenceOutcome::Duplicate) {
            return vec![ack.into()];
        }

        if let Some(authority_epoch) = self.authority_epoch {
            if message.payload.authority_epoch != authority_epoch {
                return vec![
                    ack.into(),
                    self.protocol_error(
                        ProtocolErrorCode::StreamResetRequired,
                        "Authority epoch changed without an explicit resynchronization.",
                        Some(message.message_id),
                    )
                    .into(),
                ];
            }
        }

        let revision = message.payload.revision.get();
        if revision < self.processed_desired_revision {
            return vec![
                ack.into(),
                self.protocol_error(
                    ProtocolErrorCode::StaleRevision,
                    "Desired revision is older than the processed revision.",
                    Some(message.message_id),
                )
                .into(),
            ];
        }

        if revision == self.processed_desired_revision {
            if self.desired_digest.as_ref() != Some(&message.payload.desired_digest) {
                return vec![
                    ack.into(),
                    self.protocol_error(
                        ProtocolErrorCode::StaleRevision,
                        "The same desired revision was received with a different digest.",
                        Some(message.message_id),
                    )
                    .into(),
                ];
            }
            return vec![ack.into()];
        }

        self.authority_epoch = Some(message.payload.authority_epoch);
        self.desired_digest = Some(message.payload.desired_digest.clone());
        self.desired_state = message.payload.state.clone();
        self.reconcile_display_hardware();
        self.reconcile_audio();
        self.reconcile_scene_renderer();
        self.processed_desired_revision = revision;
        self.applied_desired_revision = revision;
        self.desired_apply_count += 1;
        self.reported_revision += 1;

        let reported = self.report_applied_state(&message);
        vec![ack.into(), reported.into()]
    }

    fn reconcile_display_hardware(&mut self) {
        let Some(display) = self.desired_state.display.as_ref() else {
            return;
        };
        let Some(hardware) = self.desired_hardware.as_ref() else {
            return;
        };

        let result = (|| {
            if let Some(power) = display.power {
                match power {
                    DesiredStateDisplayPower::On => hardware.dpms.screen_on()?,
                    DesiredStateDisplayPower::Off => hardware.dpms.screen_off()?,
                }
            }
            if let Some(brightness) = display.brightness {
                let maximum = hardware.brightness.max_brightness()?;
                let level = u32::try_from(brightness).unwrap_or(0) * maximum / 100;
                hardware.brightness.set_brightness(level)?;
            }
            Ok::<(), crate::hardware::brightness::AdapterError>(())
        })();

        self.domain_outcomes.insert(
            Domain::Display,
            match result {
                Ok(()) => DomainOutcome::Applied,
                Err(error) => DomainOutcome::Failed {
                    reason: error.to_string(),
                },
            },
        );
    }

    fn reconcile_scene_renderer(&mut self) {
        let Some(scene) = self.desired_state.scene.as_ref() else {
            return;
        };
        let Some(base_url) = self.scene_server_url.as_ref() else {
            self.domain_outcomes.insert(
                Domain::Scene,
                DomainOutcome::Failed {
                    reason: "renderer URL is not configured".to_string(),
                },
            );
            return;
        };
        let revision_id = scene.revision_id.to_string();
        let command = if scene.page.is_empty() {
            serde_json::json!({ "page_id": revision_id })
        } else {
            serde_json::json!({ "page_id": revision_id, "page_data": scene.page })
        };
        let result = reqwest::blocking::Client::new()
            .post(format!(
                "{}/api/commands/page",
                base_url.trim_end_matches('/')
            ))
            .json(&command)
            .send()
            .map_err(|error| error.to_string())
            .and_then(|response| {
                if response.status().is_success() {
                    Ok(())
                } else {
                    Err(format!("renderer returned HTTP {}", response.status()))
                }
            });
        self.domain_outcomes.insert(
            Domain::Scene,
            match result {
                Ok(()) => DomainOutcome::Applied,
                Err(reason) => DomainOutcome::Failed { reason },
            },
        );
    }

    fn reconcile_audio(&mut self) {
        let Some(audio) = self.desired_state.audio.as_ref() else {
            return;
        };
        let Some(volume) = audio.volume else {
            return;
        };
        let Some(base_url) = self.scene_server_url.as_ref() else {
            return;
        };
        let result = reqwest::blocking::Client::new()
            .post(format!("{}/api/audio/volume", base_url.trim_end_matches('/')))
            .json(&serde_json::json!({ "level": volume }))
            .send()
            .map_err(|error| error.to_string())
            .and_then(|response| {
                if response.status().is_success() {
                    Ok(())
                } else {
                    Err(format!("audio service returned HTTP {}", response.status()))
                }
            });
        self.domain_outcomes.insert(
            Domain::Audio,
            match result {
                Ok(()) => DomainOutcome::Applied,
                Err(reason) => DomainOutcome::Failed { reason },
            },
        );
    }

    fn handle_echo_command(
        &mut self,
        message: DiagnosticsEchoCommandIssue,
    ) -> Vec<DeviceV1ControlMessage> {
        let content = serde_json::to_value(&message).expect("command.issue serializes to JSON");
        if let Err(error) = self.observe_core_sequence(
            message.stream_epoch,
            message.sequence,
            message.message_id,
            content,
        ) {
            return vec![(*error).into()];
        }

        let ack = self.acknowledge(message.sequence);
        let idempotency_key = String::from(message.payload.idempotency_key.clone());
        let request_digest = String::from(message.payload.request_digest.clone());

        if let Some(existing) = self.echo_results.get(&idempotency_key).cloned() {
            if existing.request_digest != request_digest {
                return vec![
                    ack.into(),
                    self.reject_command(
                        &message,
                        CommandRejectedPayloadCode::IdempotencyConflict,
                        "The idempotency key was already used with a different request digest.",
                    )
                    .into(),
                ];
            }

            let received = self.command_received(&message, true);
            let completed = self.command_completed(&message, existing.echoed, true);
            return vec![ack.into(), received.into(), completed.into()];
        }

        if self.clock_uncertainty_ms > message.payload.max_clock_uncertainty_ms {
            return vec![
                ack.into(),
                self.reject_command(
                    &message,
                    CommandRejectedPayloadCode::ClockUntrusted,
                    "Edge clock uncertainty exceeds the command policy.",
                )
                .into(),
            ];
        }

        let now = self.now();
        if now >= *message.expires_at {
            return vec![
                ack.into(),
                self.reject_command(
                    &message,
                    CommandRejectedPayloadCode::Expired,
                    "Command expired before execution.",
                )
                .into(),
            ];
        }
        if now < *message.payload.not_before {
            return vec![
                ack.into(),
                self.reject_command(
                    &message,
                    CommandRejectedPayloadCode::PreconditionFailed,
                    "Command is not eligible to run yet.",
                )
                .into(),
            ];
        }

        let echoed = String::from(message.payload.parameters.message.clone());
        self.echo_execution_count += 1;
        self.echo_results.insert(
            idempotency_key,
            StoredEchoResult {
                request_digest,
                echoed: echoed.clone(),
            },
        );

        let received = self.command_received(&message, false);
        let completed = self.command_completed(&message, echoed, false);
        vec![ack.into(), received.into(), completed.into()]
    }

    /// Mirrors the TS reference's private `observeCoreSequence`, folding its
    /// `{ duplicate, error? }` result into a `Result`. The error is boxed because
    /// `ProtocolError` is large relative to `SequenceOutcome`, and this is a cold/error-only path.
    fn observe_core_sequence(
        &mut self,
        stream_epoch: Uuid,
        sequence: NonZeroU64,
        message_id: Uuid,
        content: Value,
    ) -> Result<SequenceOutcome, Box<ProtocolError>> {
        if stream_epoch != self.core_stream_epoch {
            return Err(Box::new(self.protocol_error(
                ProtocolErrorCode::StreamResetRequired,
                "Message uses an inactive Core stream epoch.",
                Some(message_id),
            )));
        }

        let sequence = sequence.get();
        if let Some(prior) = self.core_message_by_sequence.get(&sequence) {
            if *prior != content {
                return Err(Box::new(self.protocol_error(
                    ProtocolErrorCode::StreamResetRequired,
                    "A Core sequence was reused for different content.",
                    Some(message_id),
                )));
            }
            return Ok(SequenceOutcome::Duplicate);
        }

        if sequence != self.last_core_sequence + 1 {
            return Err(Box::new(self.protocol_error(
                ProtocolErrorCode::StreamResetRequired,
                "Core stream sequence is not contiguous.",
                Some(message_id),
            )));
        }

        self.core_message_by_sequence.insert(sequence, content);
        self.last_core_sequence = sequence;
        Ok(SequenceOutcome::Fresh)
    }

    fn acknowledge(&self, sequence: NonZeroU64) -> StreamAck {
        StreamAck {
            acknowledged_sequence: sequence,
            protocol: json!(1),
            sent_at: Timestamp(self.now()),
            stream_epoch: self.core_stream_epoch,
            type_: json!("stream.ack"),
        }
    }

    fn report_applied_state(&mut self, message: &StateDesired) -> StateReported {
        let revision = message.payload.revision.get();

        let mut application: HashMap<String, DomainApplication> = HashMap::new();
        if self.desired_state.scene.is_some() {
            application.insert(
                Domain::Scene.as_str().to_string(),
                to_domain_application(
                    revision,
                    self.domain_outcomes
                        .get(&Domain::Scene)
                        .unwrap_or(&DomainOutcome::Pending),
                ),
            );
        }
        if self.desired_state.display.is_some() {
            application.insert(
                Domain::Display.as_str().to_string(),
                to_domain_application(
                    revision,
                    self.domain_outcomes
                        .get(&Domain::Display)
                        .unwrap_or(&DomainOutcome::Pending),
                ),
            );
        }
        if self.desired_state.audio.is_some() {
            application.insert(
                Domain::Audio.as_str().to_string(),
                to_domain_application(
                    revision,
                    self.domain_outcomes
                        .get(&Domain::Audio)
                        .unwrap_or(&DomainOutcome::Pending),
                ),
            );
        }
        if self.desired_state.voice.is_some() {
            application.insert(
                Domain::Voice.as_str().to_string(),
                to_domain_application(
                    revision,
                    self.domain_outcomes
                        .get(&Domain::Voice)
                        .unwrap_or(&DomainOutcome::Pending),
                ),
            );
        }
        if self.desired_state.update.is_some() {
            application.insert(
                Domain::Update.as_str().to_string(),
                to_domain_application(
                    revision,
                    self.domain_outcomes
                        .get(&Domain::Update)
                        .unwrap_or(&DomainOutcome::Pending),
                ),
            );
        }

        let scene = self
            .desired_state
            .scene
            .as_ref()
            .map(|scene| ReportedStateScene {
                revision_id: Some(convert(scene.revision_id.to_string())),
                status: Some(ReportedStateSceneStatus::Active),
            });

        let display = self
            .desired_state
            .display
            .as_ref()
            .map(|display| ReportedStateDisplay {
                brightness: display.brightness,
                power: display.power.map(|power| match power {
                    DesiredStateDisplayPower::On => ReportedStateDisplayPower::On,
                    DesiredStateDisplayPower::Off => ReportedStateDisplayPower::Off,
                }),
            });

        let state = ReportedState {
            connectivity: Some(ReportedStateConnectivity {
                core: Some(ReportedStateConnectivityCore::Online),
            }),
            display,
            scene,
        };

        StateReported {
            correlation_id: Some(message.message_id),
            message_id: self.next_id(),
            payload: StateReportedPayload {
                application,
                applied_revision: revision,
                authority_epoch: message.payload.authority_epoch,
                desired_revision: revision,
                divergences: Vec::new(),
                processed_desired_revision: revision,
                reported_revision: NonZeroU64::new(self.reported_revision)
                    .expect("reported_revision is incremented before use"),
                state,
                status: StateReportedPayloadStatus::Applied,
            },
            payload_version: json!(1),
            protocol: json!(1),
            sent_at: Timestamp(self.now()),
            sequence: self.take_edge_sequence(),
            stream_epoch: self.edge_stream_epoch,
            type_: json!("state.reported"),
        }
    }

    fn command_received(
        &mut self,
        message: &DiagnosticsEchoCommandIssue,
        duplicate: bool,
    ) -> CommandReceived {
        CommandReceived {
            correlation_id: message.correlation_id,
            message_id: self.next_id(),
            payload: CommandReceivedPayload {
                command_id: message.payload.command_id,
                duplicate,
                idempotency_key: convert::<CommandReceivedPayloadIdempotencyKey>(String::from(
                    message.payload.idempotency_key.clone(),
                )),
                request_digest: message.payload.request_digest.clone(),
            },
            payload_version: json!(1),
            protocol: json!(1),
            sent_at: Timestamp(self.now()),
            sequence: self.take_edge_sequence(),
            stream_epoch: self.edge_stream_epoch,
            type_: json!("command.received"),
        }
    }

    fn command_completed(
        &mut self,
        message: &DiagnosticsEchoCommandIssue,
        echoed: String,
        replayed: bool,
    ) -> CommandCompleted {
        CommandCompleted {
            correlation_id: message.correlation_id,
            message_id: self.next_id(),
            payload: CommandCompletedPayload {
                command_id: message.payload.command_id,
                idempotency_key: convert::<CommandCompletedPayloadIdempotencyKey>(String::from(
                    message.payload.idempotency_key.clone(),
                )),
                replayed,
                request_digest: message.payload.request_digest.clone(),
                result: CommandCompletedPayloadResult { echoed },
            },
            payload_version: json!(1),
            protocol: json!(1),
            sent_at: Timestamp(self.now()),
            sequence: self.take_edge_sequence(),
            stream_epoch: self.edge_stream_epoch,
            type_: json!("command.completed"),
        }
    }

    fn reject_command(
        &mut self,
        message: &DiagnosticsEchoCommandIssue,
        code: CommandRejectedPayloadCode,
        rejection_message: &str,
    ) -> CommandRejected {
        CommandRejected {
            correlation_id: message.correlation_id,
            message_id: self.next_id(),
            payload: CommandRejectedPayload {
                code,
                command_id: message.payload.command_id,
                idempotency_key: convert::<CommandRejectedPayloadIdempotencyKey>(String::from(
                    message.payload.idempotency_key.clone(),
                )),
                message: convert::<CommandRejectedPayloadMessage>(rejection_message),
                request_digest: message.payload.request_digest.clone(),
            },
            payload_version: json!(1),
            protocol: json!(1),
            sent_at: Timestamp(self.now()),
            sequence: self.take_edge_sequence(),
            stream_epoch: self.edge_stream_epoch,
            type_: json!("command.rejected"),
        }
    }

    fn protocol_error(
        &self,
        code: ProtocolErrorCode,
        message: &str,
        correlation_id: Option<Uuid>,
    ) -> ProtocolError {
        ProtocolError {
            code,
            correlation_id,
            message: convert::<ProtocolErrorMessage>(message),
            message_id: self.next_id(),
            protocol: json!(1),
            sent_at: Timestamp(self.now()),
            type_: json!("protocol.error"),
        }
    }

    fn take_edge_sequence(&mut self) -> NonZeroU64 {
        let sequence = self.next_edge_sequence;
        self.next_edge_sequence += 1;
        NonZeroU64::new(sequence).expect("edge sequence counter starts at 1")
    }

    fn next_id(&self) -> Uuid {
        generate_uuid_v4()
    }

    fn now(&self) -> DateTime<Utc> {
        (self.clock)()
    }
}
