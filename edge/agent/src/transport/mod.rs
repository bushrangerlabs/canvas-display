//! Async WebSocket transport wrapping the pure, synchronous `session::EdgeSession` state machine
//! (ADR 0009: `docs/adr/0009-edge-agent-async-transport.md`).
//!
//! This module is the only place in `canvas-edge-agent` that depends on `tokio`. Everything else
//! in this crate (storage, IPC, pairing, capabilities, the session state machine itself) remains
//! synchronous by design. [`spawn`] confines all of `tokio` to one dedicated OS thread running a
//! single-threaded (`current_thread`) runtime; the rest of the daemon (`canvas-edge-agentd`'s
//! `main()`, SQLite storage, the local IPC broker) talks to that thread only through the
//! `flume` channel endpoints in [`TransportHandle`], never through `EdgeSession` directly.

mod backoff;
mod boundary;
mod connection;

use tokio_tungstenite::connect_async;

pub use backoff::{next_delay, BackoffConfig};
pub use boundary::{TransportCommand, TransportEvent};
pub use connection::{run_connection, ConnectionOutcome, DisconnectReason, HeartbeatConfig};

use crate::session::EdgeSession;

const CHANNEL_CAPACITY: usize = 64;

pub struct TransportHandle {
    pub commands: flume::Sender<TransportCommand>,
    pub events: flume::Receiver<TransportEvent>,
    join_handle: std::thread::JoinHandle<()>,
}

impl TransportHandle {
    pub fn join(self) -> std::thread::Result<()> {
        self.join_handle.join()
    }
}

/// Spawns the dedicated WS thread.
pub fn spawn(
    url: String,
    session: EdgeSession,
    backoff: BackoffConfig,
    heartbeat: HeartbeatConfig,
) -> TransportHandle {
    let (command_tx, command_rx) = flume::bounded(CHANNEL_CAPACITY);
    let (event_tx, event_rx) = flume::bounded(CHANNEL_CAPACITY);

    let join_handle = std::thread::Builder::new()
        .name("canvas-edge-ws".to_string())
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("failed to build the transport thread's current-thread tokio runtime");
            runtime.block_on(reconnect_loop(
                url, session, command_rx, event_tx, backoff, heartbeat,
            ));
        })
        .expect("failed to spawn the dedicated canvas-edge-ws OS thread");

    TransportHandle {
        commands: command_tx,
        events: event_rx,
        join_handle,
    }
}

async fn reconnect_loop(
    url: String,
    mut session: EdgeSession,
    commands: flume::Receiver<TransportCommand>,
    events: flume::Sender<TransportEvent>,
    backoff: BackoffConfig,
    heartbeat: HeartbeatConfig,
) {
    let mut attempt: u32 = 0;

    loop {
        match connect_async(&url).await {
            Ok((ws_stream, _response)) => {
                attempt = 0;
                let _outcome =
                    run_connection(ws_stream, &mut session, &commands, &events, heartbeat).await;
            }
            Err(error) => {
                let _ = events
                    .send_async(TransportEvent::Disconnected {
                        clean: false,
                        detail: format!("connect failed: {error}"),
                        resume_cursor: Box::new(session.resume_cursor()),
                    })
                    .await;
            }
        }

        if commands.is_disconnected() {
            return;
        }

        attempt += 1;
        let delay = next_delay(backoff, attempt, rand::random::<f64>());

        tokio::select! {
            _ = tokio::time::sleep(delay) => {},
            _ = commands.recv_async() => {},
        };
    }
}
