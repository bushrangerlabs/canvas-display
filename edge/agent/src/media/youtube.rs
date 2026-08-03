//! YouTube adapter: resolves a video ID from a free-text query via the YouTube Data API v3
//! `search.list` endpoint, and constructs the loopback Content Bridge player URL the renderer
//! loads in a WebView. This is the typed Rust replacement for the Node sidecar's
//! `resolveYouTubeCandidates` + `getYouTubePlayerBaseUrl` path in `server/src/routes/media.ts`.
//!
//! The adapter trait is injectable so tests can wire in [`FakeYouTubeAdapter`] (canned search
//! results, no network) while production wires in [`HttpYouTubeAdapter`] (real `reqwest::blocking`
//! call to `https://www.googleapis.com/youtube/v3/search`). The HTTP client itself is also
//! injectable so a future test can point the real adapter at a mock server without monkey-patching.
//!
//! What is real vs. scaffolded:
//! - `resolve_player_url` is fully real and is the direct fix for the YouTube error 153 bug: it
//!   always produces a loopback `http://127.0.0.1:<port>/youtube/<video_id>` URL with a stable
//!   origin, never a malformed search-query URL.
//! - `HttpYouTubeAdapter::search` is a real scaffold: it constructs the correct
//!   `search.list?part=snippet&type=video&...` request and parses the JSON response, but only
//!   runs if an API key is configured. With no key it returns an error, matching the sidecar's
//!   `youtube_api_key_missing` behavior. A future task will wire the API key from durable
//!   settings; the trait shape is ready for it.
//!
//! Per the task constraints, the Content Bridge server itself (serving the IFrame Player HTML)
//! is the priority; the full YouTube Data API search client is a scaffold that supports the trait
//! shape but does not implement real API-key handling beyond passing the key through.

use std::sync::Mutex;

/// Optional search parameters mirroring the sidecar's `YouTubeSearchOptions` (region code,
/// relevance language, safe-search mode). All fields are optional; the adapter applies whatever is
/// set.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct YouTubeSearchOptions {
    /// ISO 3166-1 alpha-2 country code (e.g. `AU`) for region-restricted search results.
    pub region_code: Option<String>,
    /// BCP-47 language tag (e.g. `en-AU`) for result relevance weighting.
    pub relevance_language: Option<String>,
    /// Safe-search mode: `none`, `moderate`, or `strict`. Defaults to `strict` on the sidecar.
    pub safe_search: Option<String>,
}

/// One YouTube search result: a video ID plus the metadata the Agent surfaces back to the caller
/// (and, eventually, to the renderer for a "now playing" display).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct YouTubeSearchResult {
    pub video_id: String,
    pub title: String,
    pub channel: String,
}

/// A minimal HTTP client seam the real YouTube adapter calls through. Production wires in
/// [`ReqwestYouTubeHttpClient`] (a thin `reqwest::blocking` wrapper); tests wire in a fake that
/// returns canned JSON without touching the network. The seam is deliberately narrow -- just
/// "GET a URL with an optional API key bearer header and return the body" -- so it does not leak
/// `reqwest` types into the trait.
pub trait YouTubeHttpClient: Send + Sync {
    /// GETs `url` with `Authorization: Bearer <api_key>` if `api_key` is non-empty, and returns
    /// the response body as a string on success or an error message on failure.
    fn get_json(&self, url: &str, api_key: &str) -> Result<String, String>;
}

/// Real `reqwest::blocking`-backed HTTP client for the YouTube Data API. Uses the same
/// `rustls-tls` TLS stack as the rest of the agent (see `edge/agent/Cargo.toml`) so it
/// cross-compiles for `aarch64-unknown-linux-gnu` without a cross-compiled system OpenSSL.
#[derive(Debug, Default)]
pub struct ReqwestYouTubeHttpClient;

impl YouTubeHttpClient for ReqwestYouTubeHttpClient {
    fn get_json(&self, url: &str, api_key: &str) -> Result<String, String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|err| format!("failed to build HTTP client: {err}"))?;
        let mut request = client.get(url);
        if !api_key.is_empty() {
            request = request.bearer_auth(api_key);
        }
        let response = request
            .send()
            .map_err(|err| format!("YouTube API request failed: {err}"))?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().unwrap_or_default();
            return Err(format!("YouTube API returned {status}: {body}"));
        }
        response
            .text()
            .map_err(|err| format!("failed to read YouTube API response: {err}"))
    }
}

/// The YouTube adapter trait. `HttpYouTubeAdapter` is the production implementation;
/// `FakeYouTubeAdapter` is the test/diagnostic implementation.
pub trait YouTubeAdapter: Send {
    /// Searches YouTube for `query` and returns ordered candidate results. The first result is
    /// the primary candidate; subsequent results are fallbacks the renderer may advance through on
    /// `candidate_error` (mirroring the sidecar's candidate-fallback behavior).
    fn search(
        &self,
        query: &str,
        api_key: &str,
        options: &YouTubeSearchOptions,
    ) -> Result<Vec<YouTubeSearchResult>, String>;

    /// Constructs the loopback Content Bridge player URL for `video_id`. The renderer loads this
    /// URL in a WebView; the Content Bridge serves the IFrame Player wrapper HTML with the correct
    /// origin/referrer/CSP. This is the direct fix for YouTube error 153: the URL is always a
    /// stable loopback origin, never a malformed search-query URL.
    fn resolve_player_url(&self, video_id: &str, bridge_base_url: &str) -> String {
        resolve_youtube_player_url(video_id, bridge_base_url)
    }
}

/// Constructs the loopback Content Bridge player URL for `video_id` against `bridge_base_url`.
/// `bridge_base_url` should be a base like `http://127.0.0.1:8765` (no trailing slash); this
/// function normalizes the trailing slash and URL-encodes the video ID.
///
/// This is a free function (not just a trait method) so the Content Bridge server itself can
/// construct the same URL shape without owning an adapter, and so tests can assert the exact
/// shape without constructing a fake adapter.
pub fn resolve_youtube_player_url(video_id: &str, bridge_base_url: &str) -> String {
    let mut base = bridge_base_url.trim_end_matches('/');
    // Defensive: if the caller passes an empty base, fall back to the documented default port.
    if base.is_empty() {
        base = "http://127.0.0.1:8765";
    }
    format!("{base}/youtube/{}", url_encode_path_segment(video_id))
}

/// URL-encodes a single path segment. YouTube video IDs are ASCII `[A-Za-z0-9_-]{11}` so this is
/// almost always a no-op, but the encoder is here so a malformed caller-supplied ID cannot inject
/// path separators or query characters.
fn url_encode_path_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Real YouTube Data API v3 adapter. Calls `search.list` via an injectable [`YouTubeHttpClient`].
pub struct HttpYouTubeAdapter<C: YouTubeHttpClient = ReqwestYouTubeHttpClient> {
    http: C,
}

impl HttpYouTubeAdapter<ReqwestYouTubeHttpClient> {
    /// Production constructor: uses the real `reqwest::blocking` HTTP client.
    pub fn new() -> Self {
        Self {
            http: ReqwestYouTubeHttpClient,
        }
    }
}

impl Default for HttpYouTubeAdapter<ReqwestYouTubeHttpClient> {
    fn default() -> Self {
        Self::new()
    }
}

impl<C: YouTubeHttpClient> HttpYouTubeAdapter<C> {
    /// Injectable constructor: takes an explicit [`YouTubeHttpClient`] so tests can wire in a fake
    /// that returns canned JSON without touching the network.
    pub fn with_http_client(http: C) -> Self {
        Self { http }
    }

    /// Builds the `search.list` request URL for `query` and `options`. Exposed as a method so
    /// tests can assert the exact query parameters without constructing a fake HTTP client.
    pub fn build_search_url(&self, query: &str, options: &YouTubeSearchOptions) -> String {
        let mut params: Vec<(String, String)> = vec![
            ("part".to_string(), "snippet".to_string()),
            ("type".to_string(), "video".to_string()),
            ("q".to_string(), query.to_string()),
            ("maxResults".to_string(), "5".to_string()),
        ];
        if let Some(region) = &options.region_code {
            params.push(("regionCode".to_string(), region.clone()));
        }
        if let Some(lang) = &options.relevance_language {
            params.push(("relevanceLanguage".to_string(), lang.clone()));
        }
        if let Some(safe) = &options.safe_search {
            params.push(("safeSearch".to_string(), safe.clone()));
        }
        let query_string = params
            .iter()
            .map(|(k, v)| format!("{}={}", url_encode_query(k), url_encode_query(v)))
            .collect::<Vec<_>>()
            .join("&");
        format!("https://www.googleapis.com/youtube/v3/search?{query_string}")
    }
}

impl<C: YouTubeHttpClient> YouTubeAdapter for HttpYouTubeAdapter<C> {
    fn search(
        &self,
        query: &str,
        api_key: &str,
        options: &YouTubeSearchOptions,
    ) -> Result<Vec<YouTubeSearchResult>, String> {
        if api_key.is_empty() {
            return Err(
                "youtube_api_key_missing: a YouTube Data API v3 key is required for search"
                    .to_string(),
            );
        }
        let url = self.build_search_url(query, options);
        let body = self.http.get_json(&url, api_key)?;
        parse_youtube_search_response(&body)
    }
}

/// Parses the JSON body of a YouTube Data API `search.list` response into ordered results.
/// Exposed as a free function so tests can assert the parser against canned JSON without
/// constructing an adapter.
pub fn parse_youtube_search_response(body: &str) -> Result<Vec<YouTubeSearchResult>, String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|err| format!("invalid YouTube JSON: {err}"))?;
    let items = value
        .get("items")
        .and_then(|items| items.as_array())
        .ok_or_else(|| "YouTube response missing 'items' array".to_string())?;
    let mut results = Vec::with_capacity(items.len());
    for item in items {
        let video_id = item
            .get("id")
            .and_then(|id| id.get("videoId"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| "YouTube item missing id.videoId".to_string())?
            .to_string();
        let snippet = item
            .get("snippet")
            .ok_or_else(|| "YouTube item missing snippet".to_string())?;
        let title = snippet
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let channel = snippet
            .get("channelTitle")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        results.push(YouTubeSearchResult {
            video_id,
            title,
            channel,
        });
    }
    Ok(results)
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

/// Fake YouTube adapter for tests/diagnostics: returns canned search results and records every
/// call so a test can assert that the IPC handler actually invoked the adapter with the expected
/// arguments. Does not touch the network.
pub struct FakeYouTubeAdapter {
    pub calls: Mutex<Vec<RecordedYouTubeCall>>,
    pub next_results: Mutex<Vec<YouTubeSearchResult>>,
    pub next_error: Mutex<Option<String>>,
}

/// One recorded call to `search` or `resolve_player_url`, for tests that need to assert "the IPC
/// handler called search with this query and these options."
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedYouTubeCall {
    pub method: &'static str,
    pub query: String,
    pub api_key: String,
    pub options: YouTubeSearchOptions,
}

impl Default for FakeYouTubeAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl FakeYouTubeAdapter {
    /// Creates a fake adapter with no canned results and no error (search returns an empty vec).
    pub fn new() -> Self {
        Self {
            calls: Mutex::new(Vec::new()),
            next_results: Mutex::new(Vec::new()),
            next_error: Mutex::new(None),
        }
    }

    /// Sets the canned results the next `search` call returns.
    pub fn with_results(self, results: Vec<YouTubeSearchResult>) -> Self {
        *self.next_results.lock().expect("results mutex poisoned") = results;
        self
    }

    /// Sets the canned error the next `search` call returns (overrides any canned results).
    pub fn with_error(self, error: impl Into<String>) -> Self {
        *self.next_error.lock().expect("error mutex poisoned") = Some(error.into());
        self
    }

    /// Returns the recorded calls in order.
    pub fn recorded_calls(&self) -> Vec<RecordedYouTubeCall> {
        self.calls.lock().expect("calls mutex poisoned").clone()
    }
}

impl YouTubeAdapter for FakeYouTubeAdapter {
    fn search(
        &self,
        query: &str,
        api_key: &str,
        options: &YouTubeSearchOptions,
    ) -> Result<Vec<YouTubeSearchResult>, String> {
        self.calls
            .lock()
            .expect("calls mutex poisoned")
            .push(RecordedYouTubeCall {
                method: "search",
                query: query.to_string(),
                api_key: api_key.to_string(),
                options: options.clone(),
            });
        if let Some(error) = self
            .next_error
            .lock()
            .expect("error mutex poisoned")
            .clone()
        {
            return Err(error);
        }
        Ok(self
            .next_results
            .lock()
            .expect("results mutex poisoned")
            .clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_player_url_produces_a_loopback_url_with_the_video_id() {
        let url = resolve_youtube_player_url("aqz-KE-bpKQ", "http://127.0.0.1:8765");
        assert_eq!(url, "http://127.0.0.1:8765/youtube/aqz-KE-bpKQ");
    }

    #[test]
    fn resolve_player_url_normalizes_a_trailing_slash_on_the_base() {
        let url = resolve_youtube_player_url("aqz-KE-bpKQ", "http://127.0.0.1:8765/");
        assert_eq!(url, "http://127.0.0.1:8765/youtube/aqz-KE-bpKQ");
    }

    #[test]
    fn resolve_player_url_falls_back_to_the_default_port_for_an_empty_base() {
        let url = resolve_youtube_player_url("aqz-KE-bpKQ", "");
        assert_eq!(url, "http://127.0.0.1:8765/youtube/aqz-KE-bpKQ");
    }

    #[test]
    fn resolve_player_url_url_encodes_unsafe_characters_in_the_video_id() {
        let url = resolve_youtube_player_url("a/b?c", "http://127.0.0.1:8765");
        assert_eq!(url, "http://127.0.0.1:8765/youtube/a%2Fb%3Fc");
    }

    #[test]
    fn fake_adapter_returns_canned_results_and_records_the_call() {
        let adapter = FakeYouTubeAdapter::new().with_results(vec![YouTubeSearchResult {
            video_id: "aqz-KE-bpKQ".to_string(),
            title: "Big Buck Bunny".to_string(),
            channel: "Blender".to_string(),
        }]);
        let results = adapter
            .search("big buck bunny", "key", &YouTubeSearchOptions::default())
            .expect("canned search");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].video_id, "aqz-KE-bpKQ");
        let calls = adapter.recorded_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].method, "search");
        assert_eq!(calls[0].query, "big buck bunny");
        assert_eq!(calls[0].api_key, "key");
    }

    #[test]
    fn fake_adapter_surfaces_a_canned_error() {
        let adapter = FakeYouTubeAdapter::new().with_error("boom");
        let err = adapter
            .search("anything", "key", &YouTubeSearchOptions::default())
            .expect_err("canned error");
        assert_eq!(err, "boom");
    }

    #[test]
    fn http_adapter_search_returns_an_error_without_an_api_key() {
        let adapter = HttpYouTubeAdapter::with_http_client(FakeHttpClient::default());
        let err = adapter
            .search("anything", "", &YouTubeSearchOptions::default())
            .expect_err("missing API key");
        assert!(err.contains("youtube_api_key_missing"));
    }

    #[test]
    fn http_adapter_builds_the_correct_search_url_with_all_options() {
        let adapter = HttpYouTubeAdapter::with_http_client(FakeHttpClient::default());
        let url = adapter.build_search_url(
            "rick astley",
            &YouTubeSearchOptions {
                region_code: Some("AU".to_string()),
                relevance_language: Some("en-AU".to_string()),
                safe_search: Some("strict".to_string()),
            },
        );
        assert!(url.starts_with("https://www.googleapis.com/youtube/v3/search?"));
        assert!(url.contains("part=snippet"));
        assert!(url.contains("type=video"));
        assert!(url.contains("q=rick%20astley"));
        assert!(url.contains("maxResults=5"));
        assert!(url.contains("regionCode=AU"));
        assert!(url.contains("relevanceLanguage=en-AU"));
        assert!(url.contains("safeSearch=strict"));
    }

    #[test]
    fn http_adapter_search_parses_a_canned_youtube_response() {
        let canned = serde_json::json!({
            "items": [
                {
                    "id": {"videoId": "aqz-KE-bpKQ"},
                    "snippet": {"title": "Big Buck Bunny", "channelTitle": "Blender"}
                },
                {
                    "id": {"videoId": "dQw4w9WgXcQ"},
                    "snippet": {"title": "Rick Astley", "channelTitle": "Rick Astley"}
                }
            ]
        })
        .to_string();
        let adapter = HttpYouTubeAdapter::with_http_client(FakeHttpClient::with_body(canned));
        let results = adapter
            .search("big buck bunny", "key", &YouTubeSearchOptions::default())
            .expect("canned search");
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].video_id, "aqz-KE-bpKQ");
        assert_eq!(results[0].title, "Big Buck Bunny");
        assert_eq!(results[0].channel, "Blender");
        assert_eq!(results[1].video_id, "dQw4w9WgXcQ");
    }

    #[test]
    fn parse_response_returns_an_error_for_missing_items() {
        let err = parse_youtube_search_response("{}").expect_err("missing items");
        assert!(err.contains("missing 'items'"));
    }

    #[test]
    fn parse_response_returns_an_error_for_invalid_json() {
        let err = parse_youtube_search_response("not json").expect_err("invalid json");
        assert!(err.contains("invalid YouTube JSON"));
    }

    /// A fake [`YouTubeHttpClient`] that returns a canned body, for testing the real
    /// [`HttpYouTubeAdapter`] parser path without touching the network.
    #[derive(Debug, Default)]
    struct FakeHttpClient {
        body: String,
    }

    impl FakeHttpClient {
        fn with_body(body: String) -> Self {
            Self { body }
        }
    }

    impl YouTubeHttpClient for FakeHttpClient {
        fn get_json(&self, _url: &str, _api_key: &str) -> Result<String, String> {
            Ok(self.body.clone())
        }
    }
}
