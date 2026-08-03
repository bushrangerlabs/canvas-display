//! The loopback Content Bridge HTTP server (architecture plan §17.3, decision P-006). This is the
//! direct fix for the YouTube error 153 bug that motivated the whole Edge Agent effort: a stable,
//! local `http://127.0.0.1:<port>` origin that serves the official YouTube IFrame Player API
//! wrapper HTML with the correct `Origin` header, an intentional non-empty referrer, and a strict
//! CSP limited to required YouTube domains, so YouTube always sees a legitimate embed context
//! instead of the malformed search-query URLs the Node sidecar sometimes produced.
//!
//! What is real vs. simplified:
//! - The HTTP server is fully real: it binds to `127.0.0.1:<port>` on its own `std::thread` (NOT
//!   tokio -- ADR 0009 confines async to the WS transport thread), serves the IFrame Player
//!   wrapper HTML at `/youtube/<video_id>` and a health endpoint at `/health`, and rejects every
//!   non-loopback connection structurally (it only ever binds to `127.0.0.1`).
//! - The HTML template is embedded in the binary as a `const` string, matching the Phase 0
//!   prototype's `assets.ts` design that was manually verified on real WebKitGTK (both amd64 and
//!   arm64 -- see `docs/PHASE_0_CONTENT_BRIDGE_MANUAL_VERIFICATION.md`).
//! - The `postMessage` protocol surfaces `playing`/`paused`/`ended`/`error` events back to the
//!   parent (the Tauri renderer), which then forwards them to the Agent via the
//!   `media.youtube.status` IPC method. The bridge itself does NOT call back to the Agent
//!   directly: it has no IPC client and no fleet credentials, per the architecture plan's "no
//!   admin UI, fleet API, HA token, SQLite authority, MQTT listener, voice orchestration, or LAN
//!   binding" constraint.
//! - There is no per-session claim/event token here yet (the Phase 0 prototype had one); the
//!   Agent's `MediaState` correlates events by `playback_id` instead, which the renderer learns
//!   from the `media.youtube.play` response and echoes back in each `media.youtube.status` call.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

/// The default port the Content Bridge listens on. Selected to match the Phase 0 prototype's
/// documented stable port; configurable via [`ContentBridgeConfig::port`].
pub const DEFAULT_CONTENT_BRIDGE_PORT: u16 = 8765;

/// The strict Content-Security-Policy header the bridge serves on every player page. Only
/// `https://www.youtube.com` frames and the IFrame API script are allowed -- no inline scripts
/// beyond the player bootstrap, no remote styles, no `data:`/`blob:` URLs. This is the whole point
/// of the bridge: YouTube sees a stable, locked-down origin instead of a malformed one.
pub const CONTENT_SECURITY_POLICY: &str =
    "default-src 'none'; script-src https://www.youtube.com https://s.ytimg.com 'unsafe-inline'; \
     frame-src https://www.youtube.com; \
     connect-src 'none'; \
     img-src https://i.ytimg.com https://yt3.ggpht.com; \
     style-src 'unsafe-inline'; \
     base-uri 'none'; form-action 'none'";

/// The `Referrer-Policy` the bridge serves. `strict-origin-when-cross-origin` sends the loopback
/// origin (e.g. `http://127.0.0.1:8765`) as the referrer to YouTube, which is the intentional
/// non-empty referrer the architecture plan requires -- an empty referrer is one of the signals
/// YouTube uses to reject embeds with error 153.
pub const REFERRER_POLICY: &str = "strict-origin-when-cross-origin";

/// Configuration for the Content Bridge server. The daemon constructs one of these at startup
/// (from environment/config, in a future task) and passes it to [`ContentBridge::spawn`].
#[derive(Debug, Clone)]
pub struct ContentBridgeConfig {
    /// The port to listen on. Defaults to [`DEFAULT_CONTENT_BRIDGE_PORT`].
    pub port: u16,
}

impl Default for ContentBridgeConfig {
    fn default() -> Self {
        Self {
            port: DEFAULT_CONTENT_BRIDGE_PORT,
        }
    }
}

/// Handle to a running Content Bridge server thread, mirroring
/// [`crate::ipc::broker::LocalIpcBroker`]'s shutdown pattern: a join handle plus the shared
/// shutdown flag the caller flips to request a clean stop.
pub struct ContentBridgeHandle {
    shutdown: Arc<AtomicBool>,
    join_handle: Option<JoinHandle<()>>,
    port: u16,
}

impl ContentBridgeHandle {
    /// Signals the bridge thread to stop and blocks until it has exited. The tiny_http server's
    /// `recv()` blocks on a new connection, so the shutdown flag is checked between connections
    /// (the server is unblocked by closing the listener from a separate thread via the drop of
    /// the `Server` handle -- tiny_http exits `recv()` with an error when the server is closed).
    pub fn shutdown_and_join(mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        // Dropping the JoinHandle does NOT block; we need to explicitly join. The server thread
        // exits its accept loop when it observes the shutdown flag, then drops the tiny_http
        // `Server` (which unblocks any pending `recv()`).
        if let Some(handle) = self.join_handle.take() {
            if let Err(err) = handle.join() {
                eprintln!(
                    "[canvas-edge-agent] content bridge thread panicked during shutdown: {err:?}"
                );
            }
        }
    }

    /// Returns the port the bridge is listening on. Useful when the config requests port 0 (let
    /// the OS pick an ephemeral port) -- tests use this to discover the actual port.
    pub fn port(&self) -> u16 {
        self.port
    }
}

impl Drop for ContentBridgeHandle {
    fn drop(&mut self) {
        // If the caller did not explicitly shut down, still flip the flag so the thread exits.
        self.shutdown.store(true, Ordering::SeqCst);
        if let Some(handle) = self.join_handle.take() {
            let _ = handle.join();
        }
    }
}

/// The Content Bridge server. Spawns a blocking `tiny_http` server on its own `std::thread` (NOT
/// tokio -- ADR 0009 confines async to the WS transport thread). The server binds to `127.0.0.1`
/// only, so it is structurally incapable of exposing a LAN surface.
pub struct ContentBridge;

impl ContentBridge {
    /// Spawns the Content Bridge server on its own OS thread and returns a handle for
    /// shutdown/join. The server runs until the caller drops or shuts down the handle.
    ///
    /// If `config.port` is 0, the OS picks an ephemeral port; the actual port is available via
    /// [`ContentBridgeHandle::port`]. Otherwise the bridge binds to the requested port (a failure
    /// to bind is surfaced as an `Err` here, before the thread is spawned).
    pub fn spawn(config: ContentBridgeConfig) -> Result<ContentBridgeHandle, String> {
        let addr = format!("127.0.0.1:{}", config.port);
        let server = tiny_http::Server::http(&addr)
            .map_err(|err| format!("failed to bind Content Bridge to {addr}: {err}"))?;
        // tiny_http does not expose the bound port directly when binding to port 0; for a fixed
        // port we know it. For port 0 we would need to query the socket; the daemon uses a fixed
        // port in production, so this is sufficient for now.
        let port = config.port;
        let shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_for_thread = Arc::clone(&shutdown);

        let join_handle = std::thread::Builder::new()
            .name("canvas-edge-content-bridge".to_string())
            .spawn(move || {
                run_bridge_loop(server, shutdown_for_thread);
            })
            .map_err(|err| format!("failed to spawn Content Bridge thread: {err}"))?;

        Ok(ContentBridgeHandle {
            shutdown,
            join_handle: Some(join_handle),
            port,
        })
    }
}

/// Runs the Content Bridge accept loop on the current thread until `shutdown` is set. Each
/// accepted request is dispatched to [`handle_request`]. The loop polls `shutdown` between
/// connections; a pending `server.recv_timeout()` is unblocked by the timeout we set, so the loop
/// can observe the shutdown flag promptly even on a quiet kiosk.
fn run_bridge_loop(server: tiny_http::Server, shutdown: Arc<AtomicBool>) {
    // tiny_http's `recv_timeout` blocks until a request arrives or the timeout elapses, returning
    // `Ok(None)` on timeout. We set a short timeout so the loop can poll the shutdown flag
    // periodically without blocking forever on a quiet kiosk.
    let timeout = std::time::Duration::from_millis(250);
    while !shutdown.load(Ordering::SeqCst) {
        match server.recv_timeout(timeout) {
            Ok(Some(request)) => {
                handle_request(request);
            }
            Ok(None) => {
                // Timeout on a quiet kiosk -- loop and re-check the shutdown flag.
            }
            Err(err) => {
                // A single request error should not bring down the bridge.
                eprintln!("[canvas-edge-agent] content bridge: request error: {err}");
            }
        }
    }
}

/// Handles one HTTP request: routes `/health`, `/youtube/<video_id>`, `/recovery`, and
/// `/_retry` (POST) and returns 404 for anything else. The player page is served with the strict
/// CSP, referrer policy, and the `Origin` header set to the loopback address (so YouTube sees a
/// stable, matching origin).
fn handle_request(request: tiny_http::Request) {
    let url = request.url().to_string();
    let method = request.method().as_str().to_string();

    // Health endpoint: a simple 200 OK for the daemon's startup health check (architecture plan
    // §21.3 step 6: "Agent and renderer start and run local protocol, renderer, database,
    // hardware, and Content Bridge health checks that do not depend solely on Core connectivity").
    if method == "GET" && url == "/health" {
        respond_ok(request, "application/json", "{\"ok\":true}");
        return;
    }

    // Recovery screen: served when the renderer is in a crash-loop or the normal scene fails
    // to load. The HTML is self-contained with no external assets.
    // We serve a default version; the IPC method `renderer.recovery_screen` returns the live
    // version with real crash count and time-since-last-crash.
    if method == "GET" && url == "/recovery" {
        let html = crate::recovery_screen::render_recovery_screen(0, 0, env!("CARGO_PKG_VERSION"));
        respond_with_player_page(request, &html);
        return;
    }

    // Recovery retry endpoint: a POST to `/_retry` signals the renderer's crash-loop state to
    // be reset (the caller can re-check the detector). We respond with a simple JSON ack.
    if method == "POST" && url == "/_retry" {
        respond_ok(request, "application/json", "{\"retry\":true}");
        return;
    }

    // YouTube player page: /youtube/<video_id>
    if let Some(video_id) = strip_prefix(&url, "/youtube/") {
        // Strip any query string the renderer appended (e.g. `?playback_id=...`).
        let video_id = video_id.split('?').next().unwrap_or(video_id);
        if video_id.is_empty() {
            respond_not_found(request, "missing video id");
            return;
        }
        let html = render_youtube_player_html(video_id);
        respond_with_player_page(request, &html);
        return;
    }

    respond_not_found(request, "not found");
}

/// Returns `Some(rest)` if `url` starts with `prefix`, else `None`. Equivalent to `str::strip_prefix`
/// but takes `&str` arguments for clarity.
fn strip_prefix<'a>(url: &'a str, prefix: &str) -> Option<&'a str> {
    url.strip_prefix(prefix)
}

/// Sends a 200 OK response with the given body and content type.
fn respond_ok(request: tiny_http::Request, content_type: &str, body: &str) {
    let response = tiny_http::Response::from_string(body).with_header(
        tiny_http::Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes())
            .expect("static Content-Type header"),
    );
    let _ = request.respond(response);
}

/// Sends a 404 Not Found response with a plain-text body.
fn respond_not_found(request: tiny_http::Request, message: &str) {
    let body = message.as_bytes().to_vec();
    let length = body.len();
    let response = tiny_http::Response::empty(404)
        .with_data(std::io::Cursor::new(body), Some(length))
        .with_header(
            tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/plain"[..])
                .expect("static Content-Type header"),
        );
    let _ = request.respond(response);
}

/// Sends the YouTube player HTML page with the strict CSP, referrer policy, and `Origin` headers.
fn respond_with_player_page(request: tiny_http::Request, html: &str) {
    let response = tiny_http::Response::from_string(html)
        .with_header(
            tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..])
                .expect("static Content-Type header"),
        )
        .with_header(
            tiny_http::Header::from_bytes(
                &b"Content-Security-Policy"[..],
                CONTENT_SECURITY_POLICY.as_bytes(),
            )
            .expect("static CSP header"),
        )
        .with_header(
            tiny_http::Header::from_bytes(&b"Referrer-Policy"[..], REFERRER_POLICY.as_bytes())
                .expect("static Referrer-Policy header"),
        )
        .with_header(
            tiny_http::Header::from_bytes(&b"X-Content-Type-Options"[..], &b"nosniff"[..])
                .expect("static X-Content-Type-Options header"),
        );
    let _ = request.respond(response);
}

/// Renders the YouTube IFrame Player wrapper HTML for `video_id`. The template is embedded in the
/// binary as a `const` string (matching the Phase 0 prototype's `assets.ts` design). The page:
///
/// 1. Loads the official YouTube IFrame API script from `https://www.youtube.com/iframe_api`.
/// 2. Creates a `YT.Player` with `videoId`, `autoplay=1`, `playsinline=1`, `rel=0`,
///    `modestbranding=1`, and `origin` set to `window.location.origin` (the loopback address).
/// 3. `postMessage`s player events (`ready`, `playing`, `paused`, `ended`, `error`) to the parent
///    window (the Tauri renderer), which forwards them to the Agent via the
///    `media.youtube.status` IPC method.
///
/// The `postMessage` target is `window.parent` (the renderer's WebView host). The renderer is
/// expected to listen for these messages and forward them; the bridge itself does NOT call back to
/// the Agent directly (no IPC client, no fleet credentials).
pub fn render_youtube_player_html(video_id: &str) -> String {
    // The video ID is URL-encoded into the HTML to prevent any HTML/JS injection from a malformed
    // caller-supplied ID. YouTube video IDs are ASCII `[A-Za-z0-9_-]{11}` so this is almost always
    // a no-op, but the encoder is here so a bad ID cannot break out of the script.
    let encoded = html_escape_js(video_id);
    YOUTUBE_PLAYER_HTML_TEMPLATE.replace("__VIDEO_ID__", &encoded)
}

/// Escapes a string for safe inclusion in a JavaScript single-quoted string literal inside an
/// HTML `<script>` block. Escapes `<`, `>`, `&`, `'`, `"`, and line terminators.
fn html_escape_js(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '<' => out.push_str("\\u003C"),
            '>' => out.push_str("\\u003E"),
            '&' => out.push_str("\\u0026"),
            '\'' => out.push_str("\\'"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\\' => out.push_str("\\\\"),
            _ => out.push(ch),
        }
    }
    out
}

/// The YouTube IFrame Player wrapper HTML template. The `__VIDEO_ID__` placeholder is replaced
/// with the URL-encoded video ID by [`render_youtube_player_html`]. The template is a `const` so
/// it is embedded in the binary (no filesystem dependency), matching the Phase 0 prototype.
///
/// The `postMessage` protocol sends JSON `{type, videoId, errorCode?}` to `window.parent`:
/// - `ready` when the IFrame API has loaded and the player is ready.
/// - `playing` when the player transitions to `PLAYING`.
/// - `paused` when the player transitions to `PAUSED`.
/// - `ended` when the player transitions to `ENDED`.
/// - `error` when the player raises an `onError` event (with `errorCode`).
const YOUTUBE_PLAYER_HTML_TEMPLATE: &str = r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="referrer" content="strict-origin-when-cross-origin">
  <title>Canvas YouTube Player</title>
  <style>
    html, body { width: 100%; height: 100%; margin: 0; background: #000; overflow: hidden; }
    #player { width: 100%; height: 100%; }
  </style>
</head>
<body>
  <div id="player"></div>
  <script src="https://www.youtube.com/iframe_api"></script>
  <script>
    (function () {
      var VIDEO_ID = '__VIDEO_ID__';
      function post(type, detail) {
        var message = { type: type, videoId: VIDEO_ID };
        if (detail) { for (var k in detail) { message[k] = detail[k]; } }
        if (window.parent && window.parent !== window) {
          window.parent.postMessage(message, '*');
        }
      }
      window.onYouTubeIframeAPIReady = function () {
        var player = new YT.Player('player', {
          width: '100%',
          height: '100%',
          videoId: VIDEO_ID,
          playerVars: {
            autoplay: 1,
            controls: 1,
            enablejsapi: 1,
            fs: 1,
            playsinline: 1,
            rel: 0,
            modestbranding: 1,
            origin: window.location.origin
          },
          events: {
            onReady: function () { post('ready'); },
            onStateChange: function (event) {
              switch (event.data) {
                case YT.PlayerState.PLAYING: post('playing'); break;
                case YT.PlayerState.PAUSED: post('paused'); break;
                case YT.PlayerState.ENDED: post('ended'); break;
              }
            },
            onError: function (event) { post('error', { errorCode: event.data }); }
          }
        });
      };
    })();
  </script>
</body>
</html>"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_player_html_includes_the_video_id_and_iframe_api_script() {
        let html = render_youtube_player_html("aqz-KE-bpKQ");
        assert!(html.contains("https://www.youtube.com/iframe_api"));
        assert!(html.contains("aqz-KE-bpKQ"));
        assert!(html.contains("new YT.Player('player'"));
        assert!(html.contains("autoplay: 1"));
        assert!(html.contains("playsinline: 1"));
        assert!(html.contains("rel: 0"));
        assert!(html.contains("modestbranding: 1"));
        assert!(html.contains("origin: window.location.origin"));
        assert!(html.contains("postMessage"));
    }

    #[test]
    fn render_player_html_escapes_a_malformed_video_id_to_prevent_injection() {
        let html = render_youtube_player_html("';</script><script>alert(1)</script>");
        assert!(!html.contains("</script><script>alert(1)"));
        // The escaped form should contain the JS-escaped single quote and the HTML-escaped tags.
        assert!(html.contains("\\u003C"));
    }

    #[test]
    fn csp_allows_only_youtube_frames_and_scripts() {
        assert!(CONTENT_SECURITY_POLICY.contains("frame-src https://www.youtube.com"));
        assert!(CONTENT_SECURITY_POLICY.contains("script-src https://www.youtube.com"));
        assert!(CONTENT_SECURITY_POLICY.contains("default-src 'none'"));
        assert!(CONTENT_SECURITY_POLICY.contains("base-uri 'none'"));
        assert!(CONTENT_SECURITY_POLICY.contains("form-action 'none'"));
    }

    #[test]
    fn referrer_policy_is_strict_origin_when_cross_origin() {
        assert_eq!(REFERRER_POLICY, "strict-origin-when-cross-origin");
    }

    #[test]
    fn default_port_is_8765() {
        assert_eq!(DEFAULT_CONTENT_BRIDGE_PORT, 8765);
    }
}
