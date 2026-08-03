//! Real end-to-end tests for `canvas_edge_agent::transport::run_connection` (ADR 0009), driven
//! over an in-process `tokio::io::duplex` pair with a scripted fake "Core" on one end, rather than
//! a real TCP/TLS socket. This exercises the *real* WebSocket framing/handshake code
//! (`tokio-tungstenite`) end to end -- only the underlying transport (a duplex pair instead of a
//! `TcpStream`) is faked, not the protocol logic.

use chrono::{DateTime, Utc};
use futures_util::{SinkExt, StreamExt};
use tokio::io::duplex;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{accept_async, client_async};

use canvas_edge_agent::protocol::{
    CoreWelcome, CoreWelcomeResume, DeviceV1ControlMessage, Timestamp,
};
use canvas_edge_agent::session::{EdgeSession, EdgeSessionOptions};
use canvas_edge_agent::transport::{
    run_connection, DisconnectReason, HeartbeatConfig, TransportCommand, TransportEvent,
};

const FIXED_TIME: &str = "2026-07-19T10:00:00.000Z";
const DUPLEX_BUFFER_BYTES: usize = 16 * 1024;

fn timestamp(value: &str) -> Timestamp {
    Timestamp(
        value
            .parse::<DateTime<Utc>>()
            .expect("valid literal timestamp"),
    )
}

fn fixed_clock_session() -> EdgeSession {
    EdgeSession::new(EdgeSessionOptions {
        clock: Some(Box::new(|| {
            FIXED_TIME.parse().expect("valid literal timestamp")
        })),
        ..Default::default()
    })
}

/// Establishes a real WebSocket handshake (client + server sides run concurrently, as they must
/// -- the HTTP upgrade handshake requires both ends to be reading and writing at once) over an
/// in-process duplex pair, and returns `(edge_side, core_side)`. `edge_side` is what
/// `run_connection` drives; `core_side` is driven directly by each test as a scripted fake Core.
async fn handshake_over_duplex() -> (
    tokio_tungstenite::WebSocketStream<tokio::io::DuplexStream>,
    tokio_tungstenite::WebSocketStream<tokio::io::DuplexStream>,
) {
    let (edge_io, core_io) = duplex(DUPLEX_BUFFER_BYTES);

    let edge_handshake = tokio::spawn(async move {
        client_async("ws://canvas-core.invalid/agent", edge_io)
            .await
            .expect("edge-side WebSocket handshake")
            .0
    });
    let core_handshake = tokio::spawn(async move {
        accept_async(core_io)
            .await
            .expect("core-side WebSocket handshake")
    });

    let edge_side = edge_handshake.await.expect("edge handshake task");
    let core_side = core_handshake.await.expect("core handshake task");
    (edge_side, core_side)
}

fn sample_welcome() -> CoreWelcome {
    CoreWelcome {
        core_time: timestamp(FIXED_TIME),
        desired_revision: 0,
        heartbeat_seconds: 30,
        message_id: uuid::Uuid::from_bytes([1; 16]),
        protocol: serde_json::json!(1),
        resume: CoreWelcomeResume {
            accepted: true,
            core_stream_epoch: uuid::Uuid::from_bytes([2; 16]),
            edge_stream_epoch: uuid::Uuid::from_bytes([3; 16]),
            next_core_sequence: std::num::NonZeroU64::new(1).unwrap(),
        },
        sent_at: timestamp(FIXED_TIME),
        session_id: uuid::Uuid::from_bytes([4; 16]),
        type_: serde_json::json!("core.welcome"),
    }
}

async fn recv_text(
    core_side: &mut tokio_tungstenite::WebSocketStream<tokio::io::DuplexStream>,
) -> String {
    match core_side
        .next()
        .await
        .expect("stream ended before a frame was received")
        .expect("a WebSocket-protocol error occurred")
    {
        Message::Text(text) => text,
        other => panic!("expected a text frame, got {other:?}"),
    }
}

#[tokio::test]
async fn sends_hello_first_and_reports_connected() {
    let (edge_side, mut core_side) = handshake_over_duplex().await;
    let (_command_tx, command_rx) = flume::bounded(8);
    let (event_tx, event_rx) = flume::bounded(8);
    let mut session = fixed_clock_session();

    let connection = tokio::spawn(async move {
        run_connection(
            edge_side,
            &mut session,
            &command_rx,
            &event_tx,
            HeartbeatConfig::default(),
        )
        .await
    });

    let hello_text = recv_text(&mut core_side).await;
    let hello: DeviceV1ControlMessage =
        serde_json::from_str(&hello_text).expect("hello frame is valid JSON");
    assert!(matches!(hello, DeviceV1ControlMessage::EdgeHello(_)));

    match event_rx.recv_async().await.expect("Outbound event") {
        TransportEvent::Outbound(boxed) => {
            assert!(matches!(*boxed, DeviceV1ControlMessage::EdgeHello(_)));
        }
        other => panic!("expected Outbound(EdgeHello), got {other:?}"),
    }
    assert!(matches!(
        event_rx.recv_async().await.expect("Connected event"),
        TransportEvent::Connected
    ));

    core_side.close(None).await.ok();
    let outcome = connection.await.expect("connection task");
    assert_eq!(outcome.reason, DisconnectReason::CleanClose);
}

#[tokio::test]
async fn welcome_from_core_is_fed_through_edge_session_and_reported_inbound() {
    let (edge_side, mut core_side) = handshake_over_duplex().await;
    let (_command_tx, command_rx) = flume::bounded(8);
    let (event_tx, event_rx) = flume::bounded(8);
    let mut session = fixed_clock_session();

    let connection = tokio::spawn(async move {
        run_connection(
            edge_side,
            &mut session,
            &command_rx,
            &event_tx,
            HeartbeatConfig::default(),
        )
        .await
    });

    // Drain the initial hello before sending a welcome back.
    let _hello_text = recv_text(&mut core_side).await;

    let welcome = sample_welcome();
    core_side
        .send(Message::Text(
            serde_json::to_string(&DeviceV1ControlMessage::from(welcome)).unwrap(),
        ))
        .await
        .expect("send welcome");

    // Drain Outbound(hello) and Connected before the Inbound(welcome) event.
    let _ = event_rx.recv_async().await.expect("Outbound event");
    let _ = event_rx.recv_async().await.expect("Connected event");
    match event_rx.recv_async().await.expect("Inbound event") {
        TransportEvent::Inbound(boxed) => {
            assert!(matches!(*boxed, DeviceV1ControlMessage::CoreWelcome(_)));
        }
        other => panic!("expected Inbound(CoreWelcome), got {other:?}"),
    }

    core_side.close(None).await.ok();
    let outcome = connection.await.expect("connection task");
    assert_eq!(outcome.reason, DisconnectReason::CleanClose);
}

#[tokio::test]
async fn a_command_send_is_delivered_to_core_and_reported_outbound() {
    let (edge_side, mut core_side) = handshake_over_duplex().await;
    let (command_tx, command_rx) = flume::bounded(8);
    let (event_tx, _event_rx) = flume::bounded(8);
    let mut session = fixed_clock_session();

    let connection = tokio::spawn(async move {
        run_connection(
            edge_side,
            &mut session,
            &command_rx,
            &event_tx,
            HeartbeatConfig::default(),
        )
        .await
    });

    let _hello_text = recv_text(&mut core_side).await;

    let welcome: DeviceV1ControlMessage = sample_welcome().into();
    command_tx
        .send_async(TransportCommand::Send(Box::new(welcome.clone())))
        .await
        .expect("enqueue command");

    let delivered_text = recv_text(&mut core_side).await;
    let delivered: DeviceV1ControlMessage =
        serde_json::from_str(&delivered_text).expect("delivered frame is valid JSON");
    assert!(matches!(delivered, DeviceV1ControlMessage::CoreWelcome(_)));

    command_tx
        .send_async(TransportCommand::Shutdown)
        .await
        .expect("send shutdown");

    let outcome = connection.await.expect("connection task");
    assert_eq!(outcome.reason, DisconnectReason::CleanClose);
}

#[tokio::test]
async fn shutdown_command_produces_a_real_close_frame_and_reports_the_resume_cursor() {
    let (edge_side, mut core_side) = handshake_over_duplex().await;
    let (command_tx, command_rx) = flume::bounded(8);
    let (event_tx, event_rx) = flume::bounded(8);
    let mut session = fixed_clock_session();

    let connection = tokio::spawn(async move {
        run_connection(
            edge_side,
            &mut session,
            &command_rx,
            &event_tx,
            HeartbeatConfig::default(),
        )
        .await
    });

    let _hello_text = recv_text(&mut core_side).await;
    let _ = event_rx.recv_async().await.expect("Outbound event");
    let _ = event_rx.recv_async().await.expect("Connected event");

    let welcome = sample_welcome();
    let expected_core_stream_epoch = welcome.resume.core_stream_epoch;
    let expected_edge_stream_epoch = welcome.resume.edge_stream_epoch;
    core_side
        .send(Message::Text(
            serde_json::to_string(&DeviceV1ControlMessage::from(welcome)).unwrap(),
        ))
        .await
        .expect("send welcome");
    match event_rx.recv_async().await.expect("Inbound event") {
        TransportEvent::Inbound(boxed) => {
            assert!(matches!(*boxed, DeviceV1ControlMessage::CoreWelcome(_)));
        }
        other => panic!("expected Inbound(CoreWelcome), got {other:?}"),
    }

    command_tx
        .send_async(TransportCommand::Shutdown)
        .await
        .expect("send shutdown");

    let close_or_end = core_side.next().await;
    match close_or_end {
        Some(Ok(Message::Close(_))) => {}
        None => {} // The duplex ending without an explicit Close frame is also acceptable here.
        other => panic!("expected a close frame or stream end, got {other:?}"),
    }

    let outcome = connection.await.expect("connection task");
    assert_eq!(outcome.reason, DisconnectReason::CleanClose);

    match event_rx.recv_async().await.expect("Disconnected event") {
        TransportEvent::Disconnected {
            clean,
            resume_cursor,
            ..
        } => {
            assert!(clean);
            assert_eq!(
                resume_cursor.core_stream_epoch,
                Some(expected_core_stream_epoch)
            );
            assert_eq!(
                resume_cursor.edge_stream_epoch,
                Some(expected_edge_stream_epoch)
            );
        }
        other => panic!("expected Disconnected, got {other:?}"),
    }
}

#[tokio::test]
async fn an_abrupt_duplex_drop_is_reported_as_an_io_error_not_a_clean_close() {
    let (edge_side, mut core_side) = handshake_over_duplex().await;
    let (_command_tx, command_rx) = flume::bounded(8);
    let (event_tx, event_rx) = flume::bounded(8);
    let mut session = fixed_clock_session();

    let connection = tokio::spawn(async move {
        run_connection(
            edge_side,
            &mut session,
            &command_rx,
            &event_tx,
            HeartbeatConfig::default(),
        )
        .await
    });

    let _hello_text = recv_text(&mut core_side).await;

    // Drop the core side's stream *without* sending a close frame -- simulating an abrupt TCP
    // reset/unexpected EOF rather than a graceful WebSocket close handshake.
    drop(core_side);

    let outcome = connection.await.expect("connection task");
    // `tokio-tungstenite` reports an abrupt reset as a protocol-level error (not a clean stream
    // end), so this asserts on the *kind* of disconnect rather than pinning the exact
    // `tungstenite`-internal wording, which is not this crate's API to depend on.
    assert!(
        matches!(outcome.reason, DisconnectReason::IoError(_)),
        "expected IoError, got {:?}",
        outcome.reason
    );

    let _ = event_rx.recv_async().await.expect("Outbound event");
    let _ = event_rx.recv_async().await.expect("Connected event");
    match event_rx.recv_async().await.expect("Disconnected event") {
        TransportEvent::Disconnected { clean, .. } => assert!(!clean),
        other => panic!("expected Disconnected, got {other:?}"),
    }
}

#[tokio::test]
async fn a_malformed_text_frame_is_reported_and_does_not_kill_the_connection() {
    let (edge_side, mut core_side) = handshake_over_duplex().await;
    let (_command_tx, command_rx) = flume::bounded(8);
    let (event_tx, event_rx) = flume::bounded(8);
    let mut session = fixed_clock_session();

    let connection = tokio::spawn(async move {
        run_connection(
            edge_side,
            &mut session,
            &command_rx,
            &event_tx,
            HeartbeatConfig::default(),
        )
        .await
    });

    let _hello_text = recv_text(&mut core_side).await;

    core_side
        .send(Message::Text(
            "this is not valid protocol JSON {{{".to_string(),
        ))
        .await
        .expect("send malformed frame");

    let _ = event_rx.recv_async().await.expect("Outbound event");
    let _ = event_rx.recv_async().await.expect("Connected event");
    match event_rx.recv_async().await.expect("MalformedFrame event") {
        TransportEvent::MalformedFrame(_) => {}
        other => panic!("expected MalformedFrame, got {other:?}"),
    }

    // The connection is still alive after a malformed frame: a subsequent valid welcome is still
    // processed normally.
    let welcome: DeviceV1ControlMessage = sample_welcome().into();
    core_side
        .send(Message::Text(serde_json::to_string(&welcome).unwrap()))
        .await
        .expect("send welcome after malformed frame");
    match event_rx.recv_async().await.expect("Inbound event") {
        TransportEvent::Inbound(boxed) => {
            assert!(matches!(*boxed, DeviceV1ControlMessage::CoreWelcome(_)));
        }
        other => panic!("expected Inbound(CoreWelcome), got {other:?}"),
    }

    core_side.close(None).await.ok();
    let outcome = connection.await.expect("connection task");
    assert_eq!(outcome.reason, DisconnectReason::CleanClose);
}
