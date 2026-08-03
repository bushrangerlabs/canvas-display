//! Integration tests for the real Core↔Edge session/stream protocol state machine
//! (`canvas_edge_agent::session::EdgeSession`), ported from the TypeScript reference at
//! `edge/simulator/src/edge-simulator.ts` and its conformance suite
//! `edge/simulator/test/edge-simulator.test.ts`. See `edge/agent/src/session/state.rs` module
//! docs for the one deliberate deviation from the reference (real UUID message IDs instead of a
//! deterministic fake-UUID test counter), which is why these tests assert on message content
//! (types, codes, sequence numbers, payload fields) rather than exact message IDs.

use std::sync::atomic::{AtomicU64, Ordering};

use chrono::{DateTime, Utc};
use uuid::Uuid;

use canvas_edge_agent::capabilities::{Domain, DomainOutcome};
use canvas_edge_agent::hardware::{
    brightness::FakeBrightnessAdapter, dpms::FakeDpmsAdapter, HardwareAdapters,
};
use canvas_edge_agent::protocol::{
    AgentInfoArchitecture, CommandRejectedPayloadCode, CoreWelcome, CoreWelcomeResume,
    DesiredState, DesiredStateDisplay, DesiredStateDisplayPower, DesiredStateScene,
    DeviceV1ControlMessage, DiagnosticsEchoCommandIssue, DiagnosticsEchoCommandIssuePayload,
    DiagnosticsEchoCommandIssuePayloadParameters, DomainApplicationStatus, ProtocolErrorCode,
    Sha256Digest, StateDesired, StateDesiredPayload, StateReportedPayloadStatus, StreamReset,
    StreamResetReason, Timestamp,
};
use canvas_edge_agent::session::{EdgeSession, EdgeSessionOptions};

const CORE_STREAM_EPOCH: &str = "0190efff-0000-7000-8000-000000000010";
const EDGE_STREAM_EPOCH: &str = "0190efff-0000-7000-8000-000000000011";
const AUTHORITY_EPOCH: &str = "0190efff-0000-7000-8000-000000000001";
const FIXED_TIME: &str = "2026-07-18T10:00:00.000Z";

fn uuid(value: &str) -> Uuid {
    Uuid::parse_str(value).expect("valid literal UUID")
}

/// Produces an arbitrary, unique UUID for test fixture fields whose exact value doesn't matter
/// (e.g. `message_id`, `correlation_id`). Does not rely on the `uuid` crate's "v4"/"v7"
/// generation features, which aren't enabled for this workspace.
fn arbitrary_uuid() -> Uuid {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut bytes = [0u8; 16];
    bytes[8..].copy_from_slice(&n.to_be_bytes());
    Uuid::from_bytes(bytes)
}

fn timestamp(value: &str) -> Timestamp {
    Timestamp(
        value
            .parse::<DateTime<Utc>>()
            .expect("valid literal timestamp"),
    )
}

fn digest(byte: char) -> Sha256Digest {
    format!("sha256:{}", byte.to_string().repeat(64))
        .parse()
        .expect("valid literal digest")
}

#[test]
fn session_defaults_to_the_native_architecture() {
    let hello = fixed_clock_session(EdgeSessionOptions::default()).create_hello();

    #[cfg(target_arch = "aarch64")]
    assert_eq!(hello.agent.architecture, AgentInfoArchitecture::Arm64);
    #[cfg(not(target_arch = "aarch64"))]
    assert_eq!(hello.agent.architecture, AgentInfoArchitecture::Amd64);
}

#[test]
fn session_default_clock_uses_current_utc_time() {
    let before = Utc::now();
    let hello = EdgeSession::new(EdgeSessionOptions::default()).create_hello();
    let after = Utc::now();

    assert!(hello.sent_at.0 >= before);
    assert!(hello.sent_at.0 <= after);
}

fn fixed_clock_session(options: EdgeSessionOptions) -> EdgeSession {
    let mut options = options;
    if options.clock.is_none() {
        options.clock = Some(Box::new(|| {
            FIXED_TIME.parse().expect("valid literal timestamp")
        }));
    }
    EdgeSession::new(options)
}

/// A session whose clock is at/after `base_command`'s default `not_before`
/// (`2026-07-18T10:00:03.000Z`), so echo-command tests that aren't specifically exercising the
/// not-before precondition (see `echo_command_rejected_before_not_before_precondition`, which
/// deliberately uses an earlier clock) can reach their happy-path/idempotency/replay assertions.
fn command_ready_session() -> EdgeSession {
    fixed_clock_session(EdgeSessionOptions {
        clock: Some(Box::new(|| {
            "2026-07-18T10:00:03.000Z"
                .parse()
                .expect("valid literal timestamp")
        })),
        ..Default::default()
    })
}

fn base_desired(sequence: u64, revision: u64, digest_char: char) -> StateDesired {
    StateDesired {
        correlation_id: None,
        message_id: arbitrary_uuid(),
        payload: StateDesiredPayload {
            authority_epoch: uuid(AUTHORITY_EPOCH),
            desired_digest: digest(digest_char),
            revision: std::num::NonZeroU64::new(revision).expect("nonzero revision"),
            state: {
                DesiredState {
                    display: Some(DesiredStateDisplay {
                        brightness: Some(70),
                        power: Some(DesiredStateDisplayPower::On),
                    }),
                    ..Default::default()
                }
            },
        },
        payload_version: serde_json::json!(1),
        protocol: serde_json::json!(1),
        sent_at: timestamp(FIXED_TIME),
        sequence: std::num::NonZeroU64::new(sequence).expect("nonzero sequence"),
        stream_epoch: uuid(CORE_STREAM_EPOCH),
        type_: serde_json::json!("state.desired"),
    }
}

fn message_types(messages: &[DeviceV1ControlMessage]) -> Vec<&'static str> {
    messages
        .iter()
        .map(|message| match message {
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
        })
        .collect()
}

/// Renders a slice of generated `#[serde(transparent)]` string-wrapper items (e.g.
/// `EdgeCapabilitiesHardwareItem`) as owned `String`s, mirroring the identical helper in
/// `tests/capabilities_v1.rs`, so capability-shape assertions can use plain `&str` comparisons.
fn capability_strings<T: std::ops::Deref<Target = String>>(items: &[T]) -> Vec<String> {
    items.iter().map(|item| item.to_string()).collect()
}

#[test]
fn create_hello_reflects_configured_agent_and_resume_cursor() {
    let session = fixed_clock_session(EdgeSessionOptions {
        agent_version: Some("9.9.9-test".to_string()),
        architecture: Some(AgentInfoArchitecture::Arm64),
        ..Default::default()
    });

    let hello = session.create_hello();
    assert_eq!(hello.agent.architecture, AgentInfoArchitecture::Arm64);
    assert_eq!(String::from(hello.agent.version), "9.9.9-test");
    assert_eq!(hello.resume.last_core_sequence, Some(0));
    assert_eq!(hello.resume.last_edge_sequence_acked, Some(0));
    assert_eq!(hello.protocol.minimum.get(), 1);
    assert_eq!(hello.protocol.maximum.get(), 1);
}

/// `create_hello`'s `capabilities` field is produced by a real
/// `canvas_edge_agent::capabilities::CapabilityDetector` probing the real machine's
/// `/sys/class/backlight` and `PATH` (see `EdgeSession::create_hello`). Whether this test
/// machine happens to have a backlight device or an `mpv` binary installed is not something
/// this test should depend on -- asserting on `hardware`'s exact contents (specifically
/// whether `brightness` is present) or `media`'s exact contents (whether `mpv` is present)
/// would make this test flaky across dev machines/CI. Instead, this test only asserts on the
/// shape invariants that hold unconditionally on every supported target, per
/// `capabilities::detect::CapabilityDetector::detect`'s doc comment: the bundled renderer,
/// the YouTube iframe player, and DPMS display-power support are all compiled-in/assumed
/// facts, not machine-dependent probes. Real probe-dependent behavior (`brightness`, `mpv`)
/// is already covered against a synthetic `tempfile` tempdir by `tests/capabilities_v1.rs`.
#[test]
fn create_hello_capabilities_reflect_real_capability_detection() {
    let session = fixed_clock_session(EdgeSessionOptions::default());
    let hello = session.create_hello();

    let renderer = capability_strings(&hello.capabilities.renderer);
    let media = capability_strings(&hello.capabilities.media);
    let hardware = capability_strings(&hello.capabilities.hardware);

    assert!(renderer.contains(&"canvas-scene-v1".to_string()));
    assert!(media.contains(&"youtube-iframe".to_string()));
    assert!(hardware.contains(&"dpms".to_string()));
}

#[test]
fn resume_cursor_matches_what_create_hello_would_embed_before_and_after_state_changes() {
    let mut session = fixed_clock_session(EdgeSessionOptions::default());

    // Before any messages: resume_cursor() must match create_hello()'s embedded resume cursor
    // exactly, since a real caller uses resume_cursor() specifically to persist what a *future*
    // create_hello() would need to reconstruct. `ResumeCursor` (generated) does not derive
    // `PartialEq`, so fields are compared individually rather than via `assert_eq!` on the whole
    // struct.
    let fresh_cursor = session.resume_cursor();
    let fresh_hello_resume = session.create_hello().resume;
    assert_eq!(
        fresh_cursor.core_stream_epoch,
        fresh_hello_resume.core_stream_epoch
    );
    assert_eq!(
        fresh_cursor.edge_stream_epoch,
        fresh_hello_resume.edge_stream_epoch
    );
    assert_eq!(
        fresh_cursor.last_core_sequence,
        fresh_hello_resume.last_core_sequence
    );
    assert_eq!(
        fresh_cursor.last_edge_sequence_acked,
        fresh_hello_resume.last_edge_sequence_acked
    );

    // After a welcome adopts new epochs and a desired-state message advances last_core_sequence,
    // resume_cursor() must reflect the *current* state, not the state at construction time.
    let welcome = CoreWelcome {
        core_time: timestamp(FIXED_TIME),
        desired_revision: 0,
        heartbeat_seconds: 30,
        message_id: arbitrary_uuid(),
        protocol: serde_json::json!(1),
        resume: CoreWelcomeResume {
            accepted: true,
            core_stream_epoch: uuid("0190efff-0000-7000-8000-0000000000aa"),
            edge_stream_epoch: uuid("0190efff-0000-7000-8000-0000000000bb"),
            next_core_sequence: std::num::NonZeroU64::new(1).unwrap(),
        },
        sent_at: timestamp(FIXED_TIME),
        session_id: arbitrary_uuid(),
        type_: serde_json::json!("core.welcome"),
    };
    session.handle_core_message(welcome.into());

    let mut desired = base_desired(1, 1, 'a');
    desired.stream_epoch = uuid("0190efff-0000-7000-8000-0000000000aa");
    session.handle_core_message(desired.into());

    let cursor = session.resume_cursor();
    assert_eq!(
        cursor.core_stream_epoch,
        Some(uuid("0190efff-0000-7000-8000-0000000000aa"))
    );
    assert_eq!(
        cursor.edge_stream_epoch,
        Some(uuid("0190efff-0000-7000-8000-0000000000bb"))
    );
    assert_eq!(cursor.last_core_sequence, Some(1));

    let hello_resume = session.create_hello().resume;
    assert_eq!(cursor.core_stream_epoch, hello_resume.core_stream_epoch);
    assert_eq!(cursor.edge_stream_epoch, hello_resume.edge_stream_epoch);
    assert_eq!(cursor.last_core_sequence, hello_resume.last_core_sequence);
    assert_eq!(
        cursor.last_edge_sequence_acked,
        hello_resume.last_edge_sequence_acked
    );
}

#[test]
fn edge_session_options_seed_the_resume_cursor_sequence_numbers() {
    let session = fixed_clock_session(EdgeSessionOptions {
        last_core_sequence: Some(42),
        last_edge_sequence_acked: Some(7),
        ..Default::default()
    });

    let cursor = session.resume_cursor();
    assert_eq!(cursor.last_core_sequence, Some(42));
    assert_eq!(cursor.last_edge_sequence_acked, Some(7));

    let hello_resume = session.create_hello().resume;
    assert_eq!(cursor.last_core_sequence, hello_resume.last_core_sequence);
    assert_eq!(
        cursor.last_edge_sequence_acked,
        hello_resume.last_edge_sequence_acked
    );
}

#[test]
fn welcome_with_supported_protocol_adopts_resume_epochs_and_emits_nothing() {
    let mut session = fixed_clock_session(EdgeSessionOptions {
        last_core_sequence: Some(42),
        last_edge_sequence_acked: Some(7),
        ..Default::default()
    });
    let new_core_epoch = uuid("0190efff-0000-7000-8000-000000000099");
    let new_edge_epoch = uuid("0190efff-0000-7000-8000-000000000098");

    let welcome = CoreWelcome {
        core_time: timestamp(FIXED_TIME),
        desired_revision: 0,
        heartbeat_seconds: 30,
        message_id: arbitrary_uuid(),
        protocol: serde_json::json!(1),
        resume: CoreWelcomeResume {
            accepted: true,
            core_stream_epoch: new_core_epoch,
            edge_stream_epoch: new_edge_epoch,
            next_core_sequence: std::num::NonZeroU64::new(1).unwrap(),
        },
        sent_at: timestamp(FIXED_TIME),
        session_id: arbitrary_uuid(),
        type_: serde_json::json!("core.welcome"),
    };

    let output = session.handle_core_message(welcome.into());
    assert!(output.is_empty());

    // The adopted epochs are observable via a subsequent hello.
    let hello = session.create_hello();
    assert_eq!(hello.resume.core_stream_epoch, Some(new_core_epoch));
    assert_eq!(hello.resume.edge_stream_epoch, Some(new_edge_epoch));
    let snapshot = session.snapshot();
    assert_eq!(snapshot.last_core_sequence, 0);
    assert_eq!(snapshot.last_edge_sequence_acked, 0);
    assert_eq!(snapshot.next_edge_sequence, 1);
}

#[test]
fn welcome_with_unsupported_protocol_is_rejected() {
    let mut session = fixed_clock_session(EdgeSessionOptions::default());
    let welcome = CoreWelcome {
        core_time: timestamp(FIXED_TIME),
        desired_revision: 0,
        heartbeat_seconds: 30,
        message_id: arbitrary_uuid(),
        protocol: serde_json::json!(2),
        resume: CoreWelcomeResume {
            accepted: true,
            core_stream_epoch: uuid(CORE_STREAM_EPOCH),
            edge_stream_epoch: uuid(EDGE_STREAM_EPOCH),
            next_core_sequence: std::num::NonZeroU64::new(1).unwrap(),
        },
        sent_at: timestamp(FIXED_TIME),
        session_id: arbitrary_uuid(),
        type_: serde_json::json!("core.welcome"),
    };

    let output = session.handle_core_message(welcome.into());
    assert_eq!(message_types(&output), vec!["protocol.error"]);
    match &output[0] {
        DeviceV1ControlMessage::ProtocolError(error) => {
            assert_eq!(error.code, ProtocolErrorCode::UnsupportedProtocol);
        }
        other => panic!("expected protocol.error, got {other:?}"),
    }
}

#[test]
fn heartbeat_is_a_no_op() {
    use canvas_edge_agent::protocol::CoreHeartbeat;

    let mut session = fixed_clock_session(EdgeSessionOptions::default());
    let heartbeat = CoreHeartbeat {
        last_received_sequence: 0,
        protocol: serde_json::json!(1),
        sent_at: timestamp(FIXED_TIME),
        stream_epoch: uuid(CORE_STREAM_EPOCH),
        type_: serde_json::json!("core.heartbeat"),
    };

    let output = session.handle_core_message(heartbeat.into());
    assert!(output.is_empty());
}

#[test]
fn core_heartbeat_deserialized_as_the_structurally_identical_edge_variant_is_a_no_op() {
    let mut session = fixed_clock_session(EdgeSessionOptions::default());
    let raw = serde_json::json!({
        "type": "core.heartbeat",
        "protocol": 1,
        "sent_at": FIXED_TIME,
        "stream_epoch": CORE_STREAM_EPOCH,
        "last_received_sequence": 0
    });
    let heartbeat: DeviceV1ControlMessage =
        serde_json::from_value(raw).expect("valid protocol heartbeat");

    assert!(
        matches!(heartbeat, DeviceV1ControlMessage::EdgeHeartbeat(_)),
        "regression setup must exercise the generated untagged-enum ambiguity"
    );
    assert!(session.handle_core_message(heartbeat).is_empty());
}

#[test]
fn desired_state_happy_path_applies_and_reports() {
    let mut session = fixed_clock_session(EdgeSessionOptions::default());
    let desired = base_desired(1, 1, 'a');

    let output = session.handle_core_message(desired.into());
    assert_eq!(message_types(&output), vec!["stream.ack", "state.reported"]);
    assert_eq!(session.snapshot().desired_apply_count, 1);
    assert_eq!(session.snapshot().applied_desired_revision, 1);

    match &output[1] {
        DeviceV1ControlMessage::StateReported(reported) => {
            assert_eq!(reported.payload.status, StateReportedPayloadStatus::Applied);
            assert_eq!(reported.payload.applied_revision, 1);
            assert_eq!(reported.payload.reported_revision.get(), 1);
            assert!(reported.payload.state.display.is_some());
        }
        other => panic!("expected state.reported, got {other:?}"),
    }
}

#[test]
fn desired_display_is_applied_to_hardware_before_reported() {
    let brightness = FakeBrightnessAdapter::new(0, 200);
    let dpms = FakeDpmsAdapter::new();
    let brightness_log = brightness.call_log();
    let dpms_log = dpms.call_log();
    let mut session = fixed_clock_session(EdgeSessionOptions {
        desired_hardware: Some(HardwareAdapters::with_fakes(brightness, dpms)),
        ..Default::default()
    });

    let output = session.handle_core_message(base_desired(1, 1, 'a').into());

    assert_eq!(brightness_log.lock().unwrap().clone(), vec![140]);
    assert_eq!(
        dpms_log.lock().unwrap().iter().copied().collect::<Vec<_>>(),
        vec!["screen_on"]
    );
    match &output[1] {
        DeviceV1ControlMessage::StateReported(reported) => {
            let display = reported.payload.application.get("display").unwrap();
            assert_eq!(display.status, DomainApplicationStatus::Applied);
        }
        other => panic!("expected state.reported, got {other:?}"),
    }
}

/// Core behavior change proven by this test: a domain present in `desired_state` that has no
/// recorded `DomainOutcome` yet (i.e. no one has called `EdgeSession::set_domain_outcome` for
/// it this pass) must be reported as `DomainApplicationStatus::Pending`, not `Applied` -- the
/// old `applied_domain` helper this replaces always reported `Applied` unconditionally, which
/// was never actually backed by a real reconciliation outcome.
#[test]
fn domain_present_in_desired_state_with_no_recorded_outcome_is_reported_pending() {
    let mut session = fixed_clock_session(EdgeSessionOptions::default());
    let desired = base_desired(1, 1, 'a'); // sets `display` in desired state.

    let output = session.handle_core_message(desired.into());

    match &output[1] {
        DeviceV1ControlMessage::StateReported(reported) => {
            let display_application = reported
                .payload
                .application
                .get("display")
                .expect("display domain application should be present");
            assert_eq!(display_application.status, DomainApplicationStatus::Pending);
            assert!(display_application.reason.is_none());
        }
        other => panic!("expected state.reported, got {other:?}"),
    }
}

#[test]
fn set_domain_outcome_failed_is_reported_as_failed_with_its_reason() {
    let mut session = fixed_clock_session(EdgeSessionOptions {
        scene_server_url: Some("http://core:3100".to_string()),
        ..Default::default()
    });
    session.set_domain_outcome(
        Domain::Scene,
        DomainOutcome::Failed {
            reason: "renderer IPC call timed out".to_string(),
        },
    );

    let mut desired = base_desired(1, 1, 'a');
    desired.payload.state.scene = Some(DesiredStateScene {
        page: Default::default(),
        revision_id: "rev-1".parse().expect("valid literal revision id"),
    });

    let output = session.handle_core_message(desired.into());

    match &output[1] {
        DeviceV1ControlMessage::StateReported(reported) => {
            let scene_application = reported
                .payload
                .application
                .get("scene")
                .expect("scene domain application should be present");
            assert_eq!(scene_application.status, DomainApplicationStatus::Failed);
            assert_eq!(
                scene_application
                    .reason
                    .as_ref()
                    .expect("reason should be present")
                    .to_string(),
                "error sending request for url (http://core:3100/api/commands/page)"
            );
        }
        other => panic!("expected state.reported, got {other:?}"),
    }
}

/// Proves both `DomainOutcome::Unsupported` and `DomainOutcome::Diverged` convert correctly
/// through `EdgeSession::report_applied_state`, in one test against two different domains from
/// a single desired-state application (matching this brief's suggestion to fold these into one
/// test).
#[test]
fn set_domain_outcome_unsupported_and_diverged_convert_correctly() {
    let mut session = fixed_clock_session(EdgeSessionOptions {
        scene_server_url: Some("http://core:3100".to_string()),
        ..Default::default()
    });
    session.set_domain_outcome(
        Domain::Scene,
        DomainOutcome::Unsupported {
            reason: "no voice pipeline in this build".to_string(),
        },
    );
    session.set_domain_outcome(Domain::Display, DomainOutcome::Diverged);

    let mut desired = base_desired(1, 1, 'a'); // already sets `display`.
    desired.payload.state.scene = Some(DesiredStateScene {
        page: Default::default(),
        revision_id: "rev-1".parse().expect("valid literal revision id"),
    });

    let output = session.handle_core_message(desired.into());

    match &output[1] {
        DeviceV1ControlMessage::StateReported(reported) => {
            let scene_application = reported
                .payload
                .application
                .get("scene")
                .expect("scene domain application should be present");
            assert_eq!(scene_application.status, DomainApplicationStatus::Failed);
            assert_eq!(
                scene_application
                    .reason
                    .as_ref()
                    .expect("reason should be present")
                    .to_string(),
                "error sending request for url (http://core:3100/api/commands/page)"
            );

            let display_application = reported
                .payload
                .application
                .get("display")
                .expect("display domain application should be present");
            assert_eq!(
                display_application.status,
                DomainApplicationStatus::Diverged
            );
            assert!(display_application.reason.is_none());
        }
        other => panic!("expected state.reported, got {other:?}"),
    }
}

#[test]
fn duplicate_desired_delivery_is_acknowledged_without_reapplying_state() {
    let mut session = fixed_clock_session(EdgeSessionOptions::default());
    let message = base_desired(1, 1, 'a');
    let first = session.handle_core_message(message.clone().into());
    assert_eq!(message_types(&first), vec!["stream.ack", "state.reported"]);
    assert_eq!(session.snapshot().desired_apply_count, 1);

    // A genuine duplicate re-delivery is byte-for-byte the same message (same `message_id`),
    // e.g. a network-level retry of the exact same Core message — not a logically-equivalent
    // but freshly re-minted message. `arbitrary_uuid()`-based helpers mint a new `message_id`
    // on every call, so we clone the original message rather than calling `base_desired` again.
    let duplicate = session.handle_core_message(message.into());
    assert_eq!(message_types(&duplicate), vec!["stream.ack"]);
    assert_eq!(session.snapshot().desired_apply_count, 1);
}

#[test]
fn reused_sequence_with_different_content_fails_closed() {
    let mut session = fixed_clock_session(EdgeSessionOptions::default());
    session.handle_core_message(base_desired(1, 1, 'a').into());

    // Same sequence number, different digest => different content.
    let changed = base_desired(1, 1, 'd');
    let output = session.handle_core_message(changed.into());

    assert_eq!(message_types(&output), vec!["protocol.error"]);
    match &output[0] {
        DeviceV1ControlMessage::ProtocolError(error) => {
            assert_eq!(error.code, ProtocolErrorCode::StreamResetRequired);
        }
        other => panic!("expected protocol.error, got {other:?}"),
    }
    assert_eq!(session.snapshot().desired_apply_count, 1);
}

#[test]
fn non_contiguous_sequence_requires_stream_reset() {
    let mut session = fixed_clock_session(EdgeSessionOptions::default());
    // Skips sequence 1 and jumps straight to 2.
    let output = session.handle_core_message(base_desired(2, 1, 'a').into());

    assert_eq!(message_types(&output), vec!["protocol.error"]);
    match &output[0] {
        DeviceV1ControlMessage::ProtocolError(error) => {
            assert_eq!(error.code, ProtocolErrorCode::StreamResetRequired);
        }
        other => panic!("expected protocol.error, got {other:?}"),
    }
}

#[test]
fn wrong_stream_epoch_requires_stream_reset() {
    let mut session = fixed_clock_session(EdgeSessionOptions::default());
    let mut desired = base_desired(1, 1, 'a');
    desired.stream_epoch = uuid("0190efff-0000-7000-8000-00000000ffff");

    let output = session.handle_core_message(desired.into());
    assert_eq!(message_types(&output), vec!["protocol.error"]);
    match &output[0] {
        DeviceV1ControlMessage::ProtocolError(error) => {
            assert_eq!(error.code, ProtocolErrorCode::StreamResetRequired);
        }
        other => panic!("expected protocol.error, got {other:?}"),
    }
}

#[test]
fn stream_reset_establishes_a_new_epoch_before_newer_desired_state_applies() {
    let mut session = fixed_clock_session(EdgeSessionOptions::default());
    session.handle_core_message(base_desired(1, 1, 'a').into());

    let new_epoch = uuid("0190efff-0000-7000-8000-000000000012");
    let reset = StreamReset {
        desired_revision: 2,
        message_id: arbitrary_uuid(),
        new_stream_epoch: new_epoch,
        previous_stream_epoch: uuid(CORE_STREAM_EPOCH),
        protocol: serde_json::json!(1),
        reason: StreamResetReason::HistoryTruncated,
        sent_at: timestamp("2026-07-18T10:00:01.000Z"),
        type_: serde_json::json!("stream.reset"),
    };
    let reset_output = session.handle_core_message(reset.into());
    assert!(reset_output.is_empty());

    let mut next = base_desired(1, 2, 'd');
    next.stream_epoch = new_epoch;
    let output = session.handle_core_message(next.into());

    assert_eq!(message_types(&output), vec!["stream.ack", "state.reported"]);
    let snapshot = session.snapshot();
    assert_eq!(snapshot.last_core_sequence, 1);
    assert_eq!(snapshot.applied_desired_revision, 2);
    assert_eq!(snapshot.desired_apply_count, 2);
}

#[test]
fn stream_reset_with_mismatched_previous_epoch_is_rejected() {
    let mut session = fixed_clock_session(EdgeSessionOptions::default());
    let reset = StreamReset {
        desired_revision: 0,
        message_id: arbitrary_uuid(),
        new_stream_epoch: uuid("0190efff-0000-7000-8000-000000000012"),
        previous_stream_epoch: uuid("0190efff-0000-7000-8000-00000000dead"),
        protocol: serde_json::json!(1),
        reason: StreamResetReason::OperatorReset,
        sent_at: timestamp(FIXED_TIME),
        type_: serde_json::json!("stream.reset"),
    };

    let output = session.handle_core_message(reset.into());
    assert_eq!(message_types(&output), vec!["protocol.error"]);
    match &output[0] {
        DeviceV1ControlMessage::ProtocolError(error) => {
            assert_eq!(error.code, ProtocolErrorCode::StreamResetRequired);
        }
        other => panic!("expected protocol.error, got {other:?}"),
    }
}

#[test]
fn lower_desired_revision_on_a_new_sequence_is_acknowledged_and_rejected_as_stale() {
    let mut session = fixed_clock_session(EdgeSessionOptions::default());
    session.handle_core_message(base_desired(1, 2, 'a').into());

    let stale = base_desired(2, 1, 'a');
    let output = session.handle_core_message(stale.into());

    assert_eq!(message_types(&output), vec!["stream.ack", "protocol.error"]);
    match &output[1] {
        DeviceV1ControlMessage::ProtocolError(error) => {
            assert_eq!(error.code, ProtocolErrorCode::StaleRevision);
        }
        other => panic!("expected protocol.error, got {other:?}"),
    }
    assert_eq!(session.snapshot().applied_desired_revision, 2);
}

#[test]
fn same_revision_with_different_digest_is_rejected_as_stale() {
    let mut session = fixed_clock_session(EdgeSessionOptions::default());
    session.handle_core_message(base_desired(1, 1, 'a').into());

    let same_revision_different_digest = base_desired(2, 1, 'b');
    let output = session.handle_core_message(same_revision_different_digest.into());

    assert_eq!(message_types(&output), vec!["stream.ack", "protocol.error"]);
    match &output[1] {
        DeviceV1ControlMessage::ProtocolError(error) => {
            assert_eq!(error.code, ProtocolErrorCode::StaleRevision);
        }
        other => panic!("expected protocol.error, got {other:?}"),
    }
}

#[test]
fn same_revision_with_same_digest_on_a_new_sequence_is_a_silent_ack() {
    let mut session = fixed_clock_session(EdgeSessionOptions::default());
    session.handle_core_message(base_desired(1, 1, 'a').into());

    let replay_same_content_new_sequence = base_desired(2, 1, 'a');
    let output = session.handle_core_message(replay_same_content_new_sequence.into());

    assert_eq!(message_types(&output), vec!["stream.ack"]);
    assert_eq!(session.snapshot().desired_apply_count, 1);
}

#[test]
fn authority_epoch_change_without_resync_requires_stream_reset() {
    let mut session = fixed_clock_session(EdgeSessionOptions::default());
    session.handle_core_message(base_desired(1, 1, 'a').into());

    let mut changed_authority = base_desired(2, 2, 'b');
    changed_authority.payload.authority_epoch = uuid("0190efff-0000-7000-8000-000000000fff");
    let output = session.handle_core_message(changed_authority.into());

    assert_eq!(message_types(&output), vec!["stream.ack", "protocol.error"]);
    match &output[1] {
        DeviceV1ControlMessage::ProtocolError(error) => {
            assert_eq!(error.code, ProtocolErrorCode::StreamResetRequired);
        }
        other => panic!("expected protocol.error, got {other:?}"),
    }
}

fn base_command(sequence: u64, max_clock_uncertainty_ms: i64) -> DiagnosticsEchoCommandIssue {
    DiagnosticsEchoCommandIssue {
        correlation_id: arbitrary_uuid(),
        expires_at: timestamp("2026-07-18T10:05:03.000Z"),
        message_id: arbitrary_uuid(),
        payload: DiagnosticsEchoCommandIssuePayload {
            command_id: arbitrary_uuid(),
            created_at: timestamp("2026-07-18T10:00:02.900Z"),
            execution_class: serde_json::json!("replay_safe"),
            idempotency_key: "diagnostics-echo-1".parse().unwrap(),
            kind: serde_json::json!("diagnostics.echo"),
            max_clock_uncertainty_ms,
            not_before: timestamp("2026-07-18T10:00:03.000Z"),
            parameters: DiagnosticsEchoCommandIssuePayloadParameters {
                message: "hello edge".parse().unwrap(),
            },
            request_digest: digest('1'),
        },
        payload_version: serde_json::json!(1),
        protocol: serde_json::json!(1),
        sent_at: timestamp("2026-07-18T10:00:03.000Z"),
        sequence: std::num::NonZeroU64::new(sequence).expect("nonzero sequence"),
        stream_epoch: uuid(CORE_STREAM_EPOCH),
        type_: serde_json::json!("command.issue"),
    }
}

#[test]
fn echo_command_happy_path_executes_and_completes() {
    let mut session = command_ready_session();
    let command = base_command(1, 1000);

    let output = session.handle_core_message(command.into());
    assert_eq!(
        message_types(&output),
        vec!["stream.ack", "command.received", "command.completed"]
    );
    assert_eq!(session.snapshot().echo_execution_count, 1);

    match &output[1] {
        DeviceV1ControlMessage::CommandReceived(received) => {
            assert!(!received.payload.duplicate);
        }
        other => panic!("expected command.received, got {other:?}"),
    }
    match &output[2] {
        DeviceV1ControlMessage::CommandCompleted(completed) => {
            assert!(!completed.payload.replayed);
            assert_eq!(completed.payload.result.echoed, "hello edge");
        }
        other => panic!("expected command.completed, got {other:?}"),
    }
}

#[test]
fn echo_command_replay_is_idempotent_and_does_not_re_execute() {
    let mut session = command_ready_session();
    session.handle_core_message(base_command(1, 1000).into());
    assert_eq!(session.snapshot().echo_execution_count, 1);

    // Same idempotency key + digest, delivered on a new sequence.
    let output = session.handle_core_message(base_command(2, 1000).into());
    assert_eq!(
        message_types(&output),
        vec!["stream.ack", "command.received", "command.completed"]
    );
    assert_eq!(session.snapshot().echo_execution_count, 1);

    match &output[1] {
        DeviceV1ControlMessage::CommandReceived(received) => {
            assert!(received.payload.duplicate);
        }
        other => panic!("expected command.received, got {other:?}"),
    }
    match &output[2] {
        DeviceV1ControlMessage::CommandCompleted(completed) => {
            assert!(completed.payload.replayed);
            assert_eq!(completed.payload.result.echoed, "hello edge");
        }
        other => panic!("expected command.completed, got {other:?}"),
    }
}

#[test]
fn echo_command_idempotency_key_reused_with_different_digest_is_rejected() {
    let mut session = command_ready_session();
    session.handle_core_message(base_command(1, 1000).into());

    let mut conflicting = base_command(2, 1000);
    conflicting.payload.request_digest = digest('2');
    let output = session.handle_core_message(conflicting.into());

    assert_eq!(
        message_types(&output),
        vec!["stream.ack", "command.rejected"]
    );
    match &output[1] {
        DeviceV1ControlMessage::CommandRejected(rejected) => {
            assert_eq!(
                rejected.payload.code,
                CommandRejectedPayloadCode::IdempotencyConflict
            );
        }
        other => panic!("expected command.rejected, got {other:?}"),
    }
    assert_eq!(session.snapshot().echo_execution_count, 1);
}

#[test]
fn echo_command_rejected_when_clock_uncertainty_exceeds_policy() {
    let mut session = fixed_clock_session(EdgeSessionOptions {
        clock_uncertainty_ms: Some(2000),
        ..Default::default()
    });
    let command = base_command(1, 1000);

    let output = session.handle_core_message(command.into());
    assert_eq!(
        message_types(&output),
        vec!["stream.ack", "command.rejected"]
    );
    match &output[1] {
        DeviceV1ControlMessage::CommandRejected(rejected) => {
            assert_eq!(
                rejected.payload.code,
                CommandRejectedPayloadCode::ClockUntrusted
            );
        }
        other => panic!("expected command.rejected, got {other:?}"),
    }
    assert_eq!(session.snapshot().echo_execution_count, 0);
}

#[test]
fn echo_command_rejected_when_already_expired() {
    let mut session = fixed_clock_session(EdgeSessionOptions {
        clock: Some(Box::new(|| {
            "2026-07-18T10:06:00.000Z"
                .parse()
                .expect("valid literal timestamp")
        })),
        ..Default::default()
    });
    let command = base_command(1, 1000);

    let output = session.handle_core_message(command.into());
    assert_eq!(
        message_types(&output),
        vec!["stream.ack", "command.rejected"]
    );
    match &output[1] {
        DeviceV1ControlMessage::CommandRejected(rejected) => {
            assert_eq!(rejected.payload.code, CommandRejectedPayloadCode::Expired);
        }
        other => panic!("expected command.rejected, got {other:?}"),
    }
    assert_eq!(session.snapshot().echo_execution_count, 0);
}

#[test]
fn echo_command_rejected_before_not_before_precondition() {
    let mut session = fixed_clock_session(EdgeSessionOptions {
        clock: Some(Box::new(|| {
            "2026-07-18T09:59:00.000Z"
                .parse()
                .expect("valid literal timestamp")
        })),
        ..Default::default()
    });
    let command = base_command(1, 1000);

    let output = session.handle_core_message(command.into());
    assert_eq!(
        message_types(&output),
        vec!["stream.ack", "command.rejected"]
    );
    match &output[1] {
        DeviceV1ControlMessage::CommandRejected(rejected) => {
            assert_eq!(
                rejected.payload.code,
                CommandRejectedPayloadCode::PreconditionFailed
            );
        }
        other => panic!("expected command.rejected, got {other:?}"),
    }
    assert_eq!(session.snapshot().echo_execution_count, 0);
}

#[test]
fn command_on_wrong_stream_epoch_requires_stream_reset() {
    let mut session = fixed_clock_session(EdgeSessionOptions::default());
    let mut command = base_command(1, 1000);
    command.stream_epoch = uuid("0190efff-0000-7000-8000-00000000ffff");

    let output = session.handle_core_message(command.into());
    assert_eq!(message_types(&output), vec!["protocol.error"]);
    match &output[0] {
        DeviceV1ControlMessage::ProtocolError(error) => {
            assert_eq!(error.code, ProtocolErrorCode::StreamResetRequired);
        }
        other => panic!("expected protocol.error, got {other:?}"),
    }
}

#[test]
fn unknown_message_kind_produces_a_protocol_error() {
    use canvas_edge_agent::protocol::EdgeHeartbeat;

    let mut session = fixed_clock_session(EdgeSessionOptions::default());
    // `edge.heartbeat` is a message Edge sends, not one Core would send to Edge; the state
    // machine should still treat it as unrecognized input, matching the TS reference's default
    // switch branch.
    let heartbeat = EdgeHeartbeat {
        last_received_sequence: 0,
        protocol: serde_json::json!(1),
        sent_at: timestamp(FIXED_TIME),
        stream_epoch: uuid(EDGE_STREAM_EPOCH),
        type_: serde_json::json!("edge.heartbeat"),
    };

    let output = session.handle_core_message(heartbeat.into());
    assert_eq!(message_types(&output), vec!["protocol.error"]);
    match &output[0] {
        DeviceV1ControlMessage::ProtocolError(error) => {
            assert_eq!(error.code, ProtocolErrorCode::UnknownMessage);
        }
        other => panic!("expected protocol.error, got {other:?}"),
    }
}
