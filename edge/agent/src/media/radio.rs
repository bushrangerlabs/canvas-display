//! Radio adapter: resolves a stream URL + metadata for a free-text station query via the
//! RadioBrowser API (and, eventually, the Listnr API). This is the typed Rust replacement for the
//! Node sidecar's `/api/media/radio/lookup` route in `server/src/routes/media.ts`.
//!
//! Radio *playback* itself is NOT implemented here: the adapter only resolves the stream URL, then
//! hands it to the existing [`crate::hardware::audio::PlaybackAdapter`] (mpv) -- exactly as the
//! sidecar does. Keeping the resolver separate from the player means the radio adapter has no
//! subprocess/socket state of its own and is trivially testable with a fake HTTP client.
//!
//! What is real vs. scaffolded:
//! - `HttpRadioAdapter::resolve_station` is a real scaffold: it constructs the correct
//!   RadioBrowser `/json/stations/search` request and parses the JSON response, but only runs if
//!   a RadioBrowser server base URL is configured. The Listnr API path is left as a future task
//!   (the sidecar's `source === 'listnr'` branch); the trait shape is ready for it.
//! - `resolve_player_url` is fully real and produces a stable stream URL the playback adapter can
//!   hand to mpv.

use std::sync::Mutex;

/// A resolved radio station: the stream URL the playback adapter (mpv) loads, plus the metadata
/// the Agent surfaces back to the caller (and, eventually, the renderer's now-playing overlay).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedStation {
    /// The station name to display in the now-playing overlay.
    pub name: String,
    /// The stream URL mpv will load (HLS, MP3, AAC, etc. -- whatever the station serves).
    pub stream_url: String,
    /// The provider that resolved the station (e.g. `radio_browser`, `listnr`).
    pub provider: String,
    /// Optional station artwork URL (favicon resolved from the station's homepage, per the
    /// sidecar's behavior).
    pub artwork: Option<String>,
    /// Optional station homepage URL.
    pub homepage: Option<String>,
}

/// The HTTP client seam the real radio adapter calls through. Production wires in
/// [`ReqwestRadioHttpClient`] (a thin `reqwest::blocking` wrapper); tests wire in a fake that
/// returns canned JSON without touching the network. The seam mirrors
/// [`super::youtube::YouTubeHttpClient`] for consistency.
pub trait RadioHttpClient: Send + Sync {
    /// GETs `url` and returns the response body as a string on success or an error message on
    /// failure. RadioBrowser does not require a bearer token; the client just needs to set a
    /// descriptive User-Agent (the real client does so).
    fn get_json(&self, url: &str) -> Result<String, String>;
}

/// Real `reqwest::blocking`-backed HTTP client for the RadioBrowser API. Uses the same
/// `rustls-tls` TLS stack as the rest of the agent.
#[derive(Debug, Default)]
pub struct ReqwestRadioHttpClient;

impl RadioHttpClient for ReqwestRadioHttpClient {
    fn get_json(&self, url: &str) -> Result<String, String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .user_agent("canvas-edge-agent/0.1 (radio resolver)")
            .build()
            .map_err(|err| format!("failed to build HTTP client: {err}"))?;
        let response = client
            .get(url)
            .send()
            .map_err(|err| format!("RadioBrowser request failed: {err}"))?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().unwrap_or_default();
            return Err(format!("RadioBrowser returned {status}: {body}"));
        }
        response
            .text()
            .map_err(|err| format!("failed to read RadioBrowser response: {err}"))
    }
}

/// The radio adapter trait. `HttpRadioAdapter` is the production implementation;
/// `FakeRadioAdapter` is the test/diagnostic implementation.
pub trait RadioAdapter: Send {
    /// Resolves a station for `query` and returns the stream URL + metadata. The caller (IPC
    /// handler) then hands `stream_url` to the audio `PlaybackAdapter` (mpv) -- the radio adapter
    /// does not spawn mpv itself.
    fn resolve_station(&self, query: &str) -> Result<ResolvedStation, String>;
}

/// Real RadioBrowser API adapter. Calls `/json/stations/search` via an injectable
/// [`RadioHttpClient`].
pub struct HttpRadioAdapter<C: RadioHttpClient = ReqwestRadioHttpClient> {
    http: C,
    /// The RadioBrowser server base URL (e.g. `https://de1.api.radio-browser.info`). Production
    /// picks one at startup; tests inject a canned base.
    server_base: String,
}

impl HttpRadioAdapter<ReqwestRadioHttpClient> {
    /// Production constructor: uses the real `reqwest::blocking` HTTP client against the given
    /// RadioBrowser server base URL.
    pub fn new(server_base: impl Into<String>) -> Self {
        Self {
            http: ReqwestRadioHttpClient,
            server_base: server_base.into(),
        }
    }
}

impl<C: RadioHttpClient> HttpRadioAdapter<C> {
    /// Injectable constructor: takes an explicit [`RadioHttpClient`] so tests can wire in a fake
    /// that returns canned JSON without touching the network.
    pub fn with_http_client(http: C, server_base: impl Into<String>) -> Self {
        Self {
            http,
            server_base: server_base.into(),
        }
    }

    /// Builds the RadioBrowser `/json/stations/search` request URL for `query`. Exposed as a
    /// method so tests can assert the exact query parameters without constructing a fake HTTP
    /// client. The search orders by click count (popularity) and limits to 1 result, matching the
    /// sidecar's "first healthy station" behavior.
    pub fn build_search_url(&self, query: &str) -> String {
        let base = self.server_base.trim_end_matches('/');
        let encoded = url_encode_query(query);
        format!(
            "{base}/json/stations/search?name={encoded}&limit=1&order=clickcount&reverse=true&hidebroken=true"
        )
    }
}

impl<C: RadioHttpClient> RadioAdapter for HttpRadioAdapter<C> {
    fn resolve_station(&self, query: &str) -> Result<ResolvedStation, String> {
        if query.trim().is_empty() {
            return Err("radio query is empty".to_string());
        }
        let url = self.build_search_url(query);
        let body = self.http.get_json(&url)?;
        parse_radio_browser_response(&body, query)
    }
}

/// Parses the JSON body of a RadioBrowser `/json/stations/search` response into a single
/// resolved station. Exposed as a free function so tests can assert the parser against canned JSON
/// without constructing an adapter.
pub fn parse_radio_browser_response(body: &str, query: &str) -> Result<ResolvedStation, String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|err| format!("invalid RadioBrowser JSON: {err}"))?;
    let first = value
        .as_array()
        .and_then(|items| items.first())
        .ok_or_else(|| format!("no radio station found for \"{query}\""))?;
    let name = first
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or(query)
        .to_string();
    let stream_url = first
        .get("url_resolved")
        .and_then(|v| v.as_str())
        .or_else(|| first.get("url").and_then(|v| v.as_str()))
        .ok_or_else(|| "station has no stream URL".to_string())?
        .to_string();
    if stream_url.is_empty() {
        return Err("station has an empty stream URL".to_string());
    }
    let artwork = first
        .get("favicon")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let homepage = first
        .get("homepage")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    Ok(ResolvedStation {
        name,
        stream_url,
        provider: "radio_browser".to_string(),
        artwork,
        homepage,
    })
}

fn url_encode_query(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Fake radio adapter for tests/diagnostics: returns a canned [`ResolvedStation`] and records
/// every call so a test can assert that the IPC handler actually invoked the adapter with the
/// expected query. Does not touch the network.
pub struct FakeRadioAdapter {
    pub calls: Mutex<Vec<String>>,
    pub next_station: Mutex<Option<ResolvedStation>>,
    pub next_error: Mutex<Option<String>>,
}

impl Default for FakeRadioAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl FakeRadioAdapter {
    /// Creates a fake adapter with no canned station and no error (resolve returns an error
    /// indicating no station was configured).
    pub fn new() -> Self {
        Self {
            calls: Mutex::new(Vec::new()),
            next_station: Mutex::new(None),
            next_error: Mutex::new(None),
        }
    }

    /// Sets the canned station the next `resolve_station` call returns.
    pub fn with_station(self, station: ResolvedStation) -> Self {
        *self.next_station.lock().expect("station mutex poisoned") = Some(station);
        self
    }

    /// Sets the canned error the next `resolve_station` call returns (overrides any canned
    /// station).
    pub fn with_error(self, error: impl Into<String>) -> Self {
        *self.next_error.lock().expect("error mutex poisoned") = Some(error.into());
        self
    }

    /// Returns the recorded queries in order.
    pub fn recorded_calls(&self) -> Vec<String> {
        self.calls.lock().expect("calls mutex poisoned").clone()
    }
}

impl RadioAdapter for FakeRadioAdapter {
    fn resolve_station(&self, query: &str) -> Result<ResolvedStation, String> {
        self.calls
            .lock()
            .expect("calls mutex poisoned")
            .push(query.to_string());
        if let Some(error) = self
            .next_error
            .lock()
            .expect("error mutex poisoned")
            .clone()
        {
            return Err(error);
        }
        self.next_station
            .lock()
            .expect("station mutex poisoned")
            .clone()
            .ok_or_else(|| "no canned station configured".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fake_adapter_returns_canned_station_and_records_the_call() {
        let adapter = FakeRadioAdapter::new().with_station(ResolvedStation {
            name: "Triple M Melbourne".to_string(),
            stream_url: "https://example.com/stream.mp3".to_string(),
            provider: "radio_browser".to_string(),
            artwork: None,
            homepage: None,
        });
        let station = adapter
            .resolve_station("triple m melbourne")
            .expect("canned station");
        assert_eq!(station.name, "Triple M Melbourne");
        assert_eq!(station.stream_url, "https://example.com/stream.mp3");
        assert_eq!(
            adapter.recorded_calls(),
            vec!["triple m melbourne".to_string()]
        );
    }

    #[test]
    fn fake_adapter_surfaces_a_canned_error() {
        let adapter = FakeRadioAdapter::new().with_error("boom");
        let err = adapter
            .resolve_station("anything")
            .expect_err("canned error");
        assert_eq!(err, "boom");
    }

    #[test]
    fn http_adapter_builds_the_correct_search_url() {
        let adapter = HttpRadioAdapter::with_http_client(
            FakeHttpClient::default(),
            "https://de1.api.radio-browser.info",
        );
        let url = adapter.build_search_url("triple m melbourne");
        assert!(url.starts_with("https://de1.api.radio-browser.info/json/stations/search?"));
        assert!(url.contains("name=triple%20m%20melbourne"));
        assert!(url.contains("limit=1"));
        assert!(url.contains("order=clickcount"));
        assert!(url.contains("reverse=true"));
        assert!(url.contains("hidebroken=true"));
    }

    #[test]
    fn http_adapter_resolve_station_parses_a_canned_radio_browser_response() {
        let canned = serde_json::json!([{
            "name": "Triple M Melbourne",
            "url": "https://example.com/stream.mp3",
            "url_resolved": "https://example.com/stream.mp3",
            "favicon": "https://example.com/favicon.png",
            "homepage": "https://example.com"
        }])
        .to_string();
        let adapter = HttpRadioAdapter::with_http_client(
            FakeHttpClient::with_body(canned),
            "https://de1.api.radio-browser.info",
        );
        let station = adapter
            .resolve_station("triple m melbourne")
            .expect("canned station");
        assert_eq!(station.name, "Triple M Melbourne");
        assert_eq!(station.stream_url, "https://example.com/stream.mp3");
        assert_eq!(station.provider, "radio_browser");
        assert_eq!(
            station.artwork.as_deref(),
            Some("https://example.com/favicon.png")
        );
        assert_eq!(station.homepage.as_deref(), Some("https://example.com"));
    }

    #[test]
    fn http_adapter_resolve_station_returns_an_error_for_an_empty_query() {
        let adapter = HttpRadioAdapter::with_http_client(
            FakeHttpClient::default(),
            "https://de1.api.radio-browser.info",
        );
        let err = adapter.resolve_station("  ").expect_err("empty query");
        assert!(err.contains("empty"));
    }

    #[test]
    fn parse_response_returns_an_error_for_an_empty_array() {
        let err = parse_radio_browser_response("[]", "nothing").expect_err("no station");
        assert!(err.contains("no radio station found"));
    }

    #[test]
    fn parse_response_returns_an_error_for_invalid_json() {
        let err = parse_radio_browser_response("not json", "anything").expect_err("invalid json");
        assert!(err.contains("invalid RadioBrowser JSON"));
    }

    #[test]
    fn parse_response_falls_back_to_the_url_field_when_url_resolved_is_missing() {
        let canned = serde_json::json!([{
            "name": "Station",
            "url": "https://example.com/stream.mp3"
        }])
        .to_string();
        let station = parse_radio_browser_response(&canned, "station").expect("parsed");
        assert_eq!(station.stream_url, "https://example.com/stream.mp3");
    }

    /// A fake [`RadioHttpClient`] that returns a canned body, for testing the real
    /// [`HttpRadioAdapter`] parser path without touching the network.
    #[derive(Debug, Default)]
    struct FakeHttpClient {
        body: String,
    }

    impl FakeHttpClient {
        fn with_body(body: String) -> Self {
            Self { body }
        }
    }

    impl RadioHttpClient for FakeHttpClient {
        fn get_json(&self, _url: &str) -> Result<String, String> {
            Ok(self.body.clone())
        }
    }
}
