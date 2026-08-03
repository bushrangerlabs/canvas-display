//! Regression test: the real `canvas_edge_agent::transport::run_connection` must speak the
//! frozen device-protocol-v1 contract (`contracts/device/v1`) end to end against a fake Core that
//! mimics `core/src/gateway.ts`'s bootstrap behavior: it accepts an `edge.hello` and replies with a
//! `core.welcome`, and the Edge session must process that welcome (advancing its stream epochs) and
//! report it as an inbound `core.welcome` -- NOT treat it as a malformed frame.
//!
//! This locks in the contract without needing the network: the underlying stream is a real
//! `tokio::io::duplex` pair, but the WebSocket framing/handshake (`tokio-tungstenite`) and the
//! `EdgeSession` state machine are the genuine production code paths.

use futures_util::{SinkExt, StreamExt};
use tokio::io::duplex;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{accept_async, client_async};

use canvas_edge_agent::protocol::{
    CoreWelcome, CoreWelcomeResume, DeviceV1ControlMessage, Timestamp,
};
use canvas_edge_agent::session::{EdgeSession, EdgeSessionOptions};
use canvas_edge_agent::transport::{
    run_connection, DisconnectReason, HeartbeatConfig, TransportEvent,
};

const FIXED_TIME: &str = "2026-07-19T10:00:00.000Z";
const DUPLEX_BUFFER_BYTES: usize = 16 * 1024;

fn timestamp(value: &str) -> Timestamp {
    Timestamp(
        value
            .parse::<chrono::DateTime<chrono::Utc>>()
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

/// Establishes a real WebSocket handshake over an in-process duplex pair and returns
/// `(edge_side, core_side)`. `edge_side` is what `run_connection` drives; `core_side` is the
/// scripted fake Core (mimicking `core/src/gateway.ts`).
async fn handshake_over_duplex() -> (
    tokio_tungstenite::WebSocketStream<tokio::io::DuplexStream>,
    tokio_tungstenite::WebSocketStream<tokio::io::DuplexStream>,
) {
    let (edge_io, core_io) = duplex(DUPLEX_BUFFER_BYTES);

    let edge_handshake = tokio::spawn(async move {
        client_async("ws://canvas-core.invalid/gateway/v1", edge_io)
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

/// A `core.welcome` shaped exactly like `core/src/gateway.ts` emits for a bootstrap connection
/// (protocol v1, `type: "core.welcome"`, fabricated resume epochs/sequences).
fn gateway_style_welcome() -> CoreWelcome {
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

/// The fake Core mimics `core/src/gateway.ts`: read the first frame, assert it is an `edge.hello`,
/// reply with a `core.welcome`, then close. Returns the parsed hello so callers can assert on its
/// shape (e.g. that it carried a non-authoritative `device_id`).
async fn fake_gateway_accept(
    mut core_side: tokio_tungstenite::WebSocketStream<tokio::io::DuplexStream>,
) -> DeviceV1ControlMessage {
    let hello_text = recv_text(&mut core_side).await;
    let hello: DeviceV1ControlMessage =
        serde_json::from_str(&hello_text).expect("hello frame is valid protocol JSON");
    assert!(
        matches!(hello, DeviceV1ControlMessage::EdgeHello(_)),
        "fake Core expected an edge.hello, got {hello:?}"
    );

    let welcome = gateway_style_welcome();
    core_side
        .send(Message::Text(
            serde_json::to_string(&DeviceV1ControlMessage::from(welcome)).unwrap(),
        ))
        .await
        .expect("send welcome");

    core_side.close(None).await.ok();
    hello
}

#[tokio::test]
async fn edge_hello_is_accepted_and_core_welcome_is_processed_not_malformed() {
    let (edge_side, core_side) = handshake_over_duplex().await;
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

    // The fake Core (mimicking core/src/gateway.ts) accepts the hello and replies core.welcome.
    let hello = fake_gateway_accept(core_side).await;
    assert!(matches!(hello, DeviceV1ControlMessage::EdgeHello(_)));

    // Edge must report: Outbound(edge.hello), Connected, then Inbound(core.welcome) -- and crucially
    // NOT a MalformedFrame (which is what a legacy `type:"welcome"` would have produced).
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
    match event_rx.recv_async().await.expect("Inbound event") {
        TransportEvent::Inbound(boxed) => {
            assert!(matches!(*boxed, DeviceV1ControlMessage::CoreWelcome(_)));
        }
        other => panic!("expected Inbound(CoreWelcome), got {other:?}"),
    }

    let outcome = connection.await.expect("connection task");
    assert_eq!(outcome.reason, DisconnectReason::CleanClose);
}

#[tokio::test]
async fn edge_hello_carries_non_authoritative_device_id_when_configured() {
    let (edge_side, core_side) = handshake_over_duplex().await;
    let (_command_tx, command_rx) = flume::bounded(8);
    let (event_tx, _event_rx) = flume::bounded(8);
    // The daemon sets `device_id` from CANVAS_EDGE_DEVICE_ID; emulate that here.
    let mut session = EdgeSession::new(EdgeSessionOptions {
        clock: Some(Box::new(|| {
            FIXED_TIME.parse().expect("valid literal timestamp")
        })),
        device_id: Some("0190f000-0000-7000-8000-0000000000aa".to_string()),
        ..Default::default()
    });

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

    let hello = fake_gateway_accept(core_side).await;
    match hello {
        DeviceV1ControlMessage::EdgeHello(edge_hello) => {
            assert_eq!(
                edge_hello.device_id.as_deref().map(|id| id.as_str()),
                Some("0190f000-0000-7000-8000-0000000000aa")
            );
        }
        other => panic!("expected EdgeHello, got {other:?}"),
    }

    let outcome = connection.await.expect("connection task");
    assert_eq!(outcome.reason, DisconnectReason::CleanClose);
}
