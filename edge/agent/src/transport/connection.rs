//! Drives one established WebSocket connection against `session::EdgeSession` (ADR 0009).
//!
//! [`run_connection`] is the part of the transport that is actually unit tested end-to-end: it is
//! generic over any `AsyncRead + AsyncWrite` stream, so tests drive it over an in-process
//! `tokio::io::duplex` pair with a scripted fake "Core" on the other end, instead of a real TCP
//! socket. The outer reconnect-with-backoff loop that establishes a *real* TLS/WebSocket
//! connection to Core (`transport::spawn`) is comparatively thin glue around this function and is
//! correspondingly less exercised by automated tests -- see that module's docs.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::time::{interval, Interval, MissedTickBehavior};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use crate::protocol::DeviceV1ControlMessage;
use crate::session::EdgeSession;

use super::boundary::{TransportCommand, TransportEvent};

/// Why a connection ended. This distinction is the crux of ADR 0009's resume-cursor correctness
/// requirement: only [`DisconnectReason::CleanClose`] is a point at which the caller may safely
/// treat `EdgeSession`'s current resume-cursor fields as reflecting what Core actually observed.
/// [`DisconnectReason::IoError`] means the last few outgoing messages' delivery is *unknown* --
/// the caller must reconnect and resume from `EdgeSession`'s last-known state without assuming
/// anything more was acknowledged than `EdgeSession` itself already recorded from real replies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DisconnectReason {
    /// A real WebSocket close frame was received (or `TransportCommand::Shutdown` was handled by
    /// sending our own close frame).
    CleanClose,
    /// The heartbeat check failed (too many consecutive missed pongs).
    HeartbeatTimeout,
    /// The underlying stream errored or ended without a close handshake (TCP reset, unexpected
    /// EOF, TLS error, WebSocket protocol error, etc).
    IoError(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionOutcome {
    pub reason: DisconnectReason,
}

/// Heartbeat tuning. Per ADR 0009, `tokio-tungstenite` does not itself declare a connection dead
/// on missed pongs -- that policy lives here. `ping_interval` is jittered by the caller (real
/// production callers should vary it run to run) to avoid many Edge devices on the same flaky
/// Wi-Fi network synchronizing their pings; `max_missed_pongs` requires more than one consecutive
/// miss before declaring the connection dead, so an isolated slow round trip does not false-positive.
#[derive(Debug, Clone, Copy)]
pub struct HeartbeatConfig {
    pub ping_interval: Duration,
    pub max_missed_pongs: u32,
}

impl Default for HeartbeatConfig {
    fn default() -> Self {
        Self {
            ping_interval: Duration::from_secs(15),
            max_missed_pongs: 3,
        }
    }
}

fn make_ping_interval(period: Duration) -> Interval {
    let mut interval = interval(period);
    // A late tick (e.g. because the select! loop was busy) should not fire a burst of catch-up
    // pings -- only ever the next single tick.
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    interval
}

async fn send_message<S>(
    ws: &mut WebSocketStream<S>,
    message: &DeviceV1ControlMessage,
) -> Result<(), DisconnectReason>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let text = serde_json::to_string(message)
        .expect("DeviceV1ControlMessage values are always JSON-serializable");
    ws.send(Message::Text(text))
        .await
        .map_err(|error| DisconnectReason::IoError(error.to_string()))
}

/// Sends `message` over `ws` and reports it on `events` as [`TransportEvent::Outbound`]. A failed
/// `events.send_async` (the receiving end was dropped) is not itself a connection error -- it just
/// means nobody is listening for observability events anymore -- so it is ignored rather than
/// tearing down the connection.
async fn send_and_report<S>(
    ws: &mut WebSocketStream<S>,
    events: &flume::Sender<TransportEvent>,
    message: DeviceV1ControlMessage,
) -> Result<(), DisconnectReason>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    send_message(ws, &message).await?;
    let _ = events
        .send_async(TransportEvent::Outbound(Box::new(message)))
        .await;
    Ok(())
}

/// Drives `ws` against `session` until the connection ends, for any reason. Always sends the
/// initial `edge.hello` before entering the main loop, exactly as `EdgeSession::create_hello`'s
/// own doc comment describes (a fresh hello every time a connection is (re-)established, carrying
/// whatever resume-cursor fields `session` currently holds).
///
/// `commands`' receiver must be polled with [`flume::Receiver::recv_async`] here (never the
/// blocking `recv`) -- see ADR 0009's explicit note on why a blocking receive on this single
/// current-thread runtime would stall WebSocket I/O and heartbeat timers.
pub async fn run_connection<S>(
    mut ws: WebSocketStream<S>,
    session: &mut EdgeSession,
    commands: &flume::Receiver<TransportCommand>,
    events: &flume::Sender<TransportEvent>,
    heartbeat: HeartbeatConfig,
) -> ConnectionOutcome
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let hello: DeviceV1ControlMessage = session.create_hello().into();
    if let Err(reason) = send_and_report(&mut ws, events, hello).await {
        return ConnectionOutcome { reason };
    }
    let _ = events.send_async(TransportEvent::Connected).await;

    let mut missed_pongs: u32 = 0;
    let mut ping_ticker = make_ping_interval(heartbeat.ping_interval);

    let reason = 'conn: loop {
        tokio::select! {
            biased;

            command = commands.recv_async() => {
                match command {
                    Ok(TransportCommand::Send(message)) => {
                        if let Err(reason) = send_and_report(&mut ws, events, *message).await {
                            break reason;
                        }
                    }
                    Ok(TransportCommand::Shutdown) | Err(_) => {
                        // Err(_) means the main thread's Sender was dropped (process shutting
                        // down) -- treat identically to an explicit Shutdown command: send a real
                        // close frame so this is a clean, resume-cursor-safe disconnect.
                        let _ = ws.close(None).await;
                        break DisconnectReason::CleanClose;
                    }
                }
            }

            _ = ping_ticker.tick() => {
                if missed_pongs >= heartbeat.max_missed_pongs {
                    break DisconnectReason::HeartbeatTimeout;
                }
                if ws.send(Message::Ping(Vec::new())).await.is_err() {
                    break DisconnectReason::IoError("failed to send heartbeat ping".to_string());
                }
                missed_pongs += 1;
            }

            frame = ws.next() => {
                match frame {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<DeviceV1ControlMessage>(&text) {
                            Ok(message) => {
                                let _ = events
                                    .send_async(TransportEvent::Inbound(Box::new(message.clone())))
                                    .await;
                                for outgoing in session.handle_core_message(message) {
                                    if let Err(reason) = send_and_report(&mut ws, events, outgoing).await {
                                        break 'conn reason;
                                    }
                                }
                            }
                            Err(error) => {
                                let _ = events
                                    .send_async(TransportEvent::MalformedFrame(error.to_string()))
                                    .await;
                            }
                        }
                    }
                    Some(Ok(Message::Pong(_))) => {
                        missed_pongs = 0;
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if ws.send(Message::Pong(payload)).await.is_err() {
                            break DisconnectReason::IoError("failed to send heartbeat pong".to_string());
                        }
                    }
                    Some(Ok(Message::Close(_))) => {
                        break DisconnectReason::CleanClose;
                    }
                    Some(Ok(Message::Frame(_) | Message::Binary(_))) => {
                        // Protocol v1 is JSON text frames only; an unexpected binary/raw frame is
                        // logged as malformed rather than treated as a connection error.
                        let _ = events
                            .send_async(TransportEvent::MalformedFrame(
                                "received a non-text WebSocket frame".to_string(),
                            ))
                            .await;
                    }
                    Some(Err(error)) => {
                        break DisconnectReason::IoError(error.to_string());
                    }
                    None => {
                        break DisconnectReason::IoError("stream ended without a close frame".to_string());
                    }
                }
            }
        }
    };

    let _ = events
        .send_async(TransportEvent::Disconnected {
            clean: reason == DisconnectReason::CleanClose,
            detail: format!("{reason:?}"),
            resume_cursor: Box::new(session.resume_cursor()),
        })
        .await;

    ConnectionOutcome { reason }
}
