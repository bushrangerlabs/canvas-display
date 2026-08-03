//! Media adapters and the loopback Content Bridge (architecture plan §17, decision P-006). This
//! module is the typed Rust replacement for the Node sidecar's YouTube/radio wrappers in
//! `server/src/routes/media.ts`, and is the direct fix for the YouTube error 153 bug that
//! motivated the whole Edge Agent effort.
//!
//! Three subsystems live here:
//!
//! - [`content_bridge`]: a loopback HTTP server (`tiny_http`) bound to `127.0.0.1:<port>` that
//!   serves the official YouTube IFrame Player wrapper HTML with the correct `Origin` header, an
//!   intentional non-empty referrer, and a strict CSP limited to required YouTube domains. This is
//!   the stable, local origin YouTube sees instead of the malformed search-query URLs the sidecar
//!   sometimes produced. The server runs on its own `std::thread` (NOT tokio -- ADR 0009 confines
//!   async to the WS transport thread), mirroring the IPC accept loop's shutdown pattern.
//! - [`youtube`]: a `YouTubeAdapter` trait + `HttpYouTubeAdapter` (real, calls the YouTube Data
//!   API `search.list` endpoint via `reqwest::blocking` with `rustls-tls`) + `FakeYouTubeAdapter`
//!   (canned search results). Resolves a video ID from a free-text query and constructs the
//!   loopback player URL the renderer loads in a WebView.
//! - [`radio`]: a `RadioAdapter` trait + `HttpRadioAdapter` (real, calls the RadioBrowser API via
//!   `reqwest::blocking`) + `FakeRadioAdapter`. Resolves a stream URL + metadata for a station
//!   query; playback itself uses the existing [`crate::hardware::audio::PlaybackAdapter`] (mpv)
//!   from `audio.rs` -- the radio adapter just resolves the URL, then hands it to the playback
//!   adapter, exactly as the sidecar does.
//! - [`state`]: playback status tracking mirroring the sidecar's `youtubePlaybackStatus` /
//!   `youtubePlaybackCandidateIds` state, so status callbacks from the renderer's IFrame Player
//!   can be recorded and queried back by the Agent.
//!
//! All three adapters follow the established real/fake trait-injection convention from
//! [`crate::hardware`] (`BrightnessAdapter`/`DpmsAdapter`/`PlaybackAdapter`): production code gets
//! a real implementation that touches the network, and tests get a fake that returns canned
//! results, so the test suite never depends on -- or mutates -- the actual network.
//!
//! What is real vs. scaffolded (see each submodule's doc comment for the per-field breakdown):
//! - The Content Bridge HTTP server is fully real and is the priority deliverable.
//! - The YouTube Data API search client is a real scaffold: it constructs the correct request and
//!   parses the response, but only runs if an API key is configured. A future task wires the API
//!   key from durable settings; the trait shape is ready for it.
//! - The RadioBrowser resolver is a real scaffold; the Listnr API path is left as a future task.

pub mod content_bridge;
pub mod radio;
pub mod state;
pub mod youtube;

pub use content_bridge::{
    ContentBridge, ContentBridgeConfig, ContentBridgeHandle, DEFAULT_CONTENT_BRIDGE_PORT,
};
pub use radio::{
    FakeRadioAdapter, HttpRadioAdapter, RadioAdapter, RadioHttpClient, ReqwestRadioHttpClient,
    ResolvedStation,
};
pub use state::{
    MediaState, YouTubePlaybackEvent, YouTubePlaybackState, YouTubePlaybackStatus,
    ALLOWED_YOUTUBE_EVENTS,
};
pub use youtube::{
    resolve_youtube_player_url, FakeYouTubeAdapter, HttpYouTubeAdapter, RecordedYouTubeCall,
    ReqwestYouTubeHttpClient, YouTubeAdapter, YouTubeHttpClient, YouTubeSearchOptions,
    YouTubeSearchResult,
};

use crate::hardware::audio::PlaybackAdapter;

/// A bundle of the daemon's real media adapters + the Content Bridge server, constructed once at
/// startup in `main.rs` and handed to the IPC action handler so it can dispatch `media.*` methods
/// to real adapters without the handler having to know how each adapter is built. Mirrors the
/// [`crate::hardware::HardwareAdapters`] and [`crate::hardware::AudioAdapters`] bundle pattern.
///
/// The Content Bridge server is NOT part of this bundle -- it is spawned separately in `main.rs`
/// on its own thread and its handle is held by `main()` for shutdown, exactly like the IPC thread.
/// The bundle only holds the adapters the IPC handler needs to resolve URLs and record state.
pub struct MediaAdapters {
    /// YouTube search + player URL resolution. Held as a trait object so the IPC handler can be
    /// constructed with a fake in tests (see `edge/agentd/tests/ipc_wiring_v1.rs`).
    pub youtube: Box<dyn YouTubeAdapter>,
    /// Radio station resolution. Same trait-object pattern as `youtube`.
    pub radio: Box<dyn RadioAdapter>,
    /// The audio playback adapter (mpv) the radio handler hands the resolved stream URL to. Shared
    /// with the `audio.*` IPC handler so a single mpv process is supervised for both radio and
    /// direct audio playback.
    pub playback: Box<dyn PlaybackAdapter>,
    /// The in-process media state (YouTube playback status + candidates). Shared between the IPC
    /// handler and (eventually) the Core reconnect continuity path.
    pub state: MediaState,
    /// The base URL the YouTube adapter constructs player URLs against (e.g.
    /// `http://127.0.0.1:8765`). Set at startup from the Content Bridge's bound port.
    pub bridge_base_url: String,
}

impl MediaAdapters {
    /// Production constructor: real YouTube + Radio adapters (real `reqwest::blocking` HTTP
    /// clients), the given playback adapter (shared with the `audio.*` handler), and the given
    /// Content Bridge base URL. The YouTube Data API key is NOT wired here yet -- the IPC handler
    /// passes it through from the caller's `media.youtube.play` arguments until a future task
    /// wires it from durable settings.
    pub fn new_real(
        playback: Box<dyn PlaybackAdapter>,
        bridge_base_url: String,
        radio_browser_base: String,
    ) -> Self {
        Self {
            youtube: Box::new(HttpYouTubeAdapter::new()),
            radio: Box::new(HttpRadioAdapter::new(radio_browser_base)),
            playback,
            state: MediaState::new(),
            bridge_base_url,
        }
    }

    /// Test/inspection constructor: takes fully fake adapters, for IPC wiring tests that need to
    /// assert "the handler called `media.youtube.play` and it resolved the right URL" without any
    /// network or subprocess involvement. Not used by any production code path.
    pub fn with_fakes(
        youtube: FakeYouTubeAdapter,
        radio: FakeRadioAdapter,
        playback: Box<dyn PlaybackAdapter>,
        bridge_base_url: String,
    ) -> Self {
        Self {
            youtube: Box::new(youtube),
            radio: Box::new(radio),
            playback,
            state: MediaState::new(),
            bridge_base_url,
        }
    }
}
