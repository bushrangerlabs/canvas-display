//! Playback status tracking for the Content Bridge media adapters, mirroring the Node sidecar's
//! `youtubePlaybackStatus` / `youtubePlaybackCandidateIds` state (see `server/src/routes/media.ts`)
//! so status callbacks from the renderer's YouTube IFrame Player can be recorded and queried back
//! by the Agent without retaining the full Fastify sidecar.
//!
//! This is intentionally in-process state, held under a `Mutex`: the Content Bridge serves a
//! single kiosk renderer, and the IPC dispatch path is synchronous (ADR 0009). There is no
//! cross-process broadcast channel here -- the renderer reports player events via the
//! `media.youtube.status` IPC method, and the Agent records them so a later `media.youtube.state`
//! query (or a future Core reconnect) can report truthfully without re-asking the renderer.
//!
//! What is real vs. simplified:
//! - The status shape and the candidate-index/error-code semantics are lifted directly from the
//!   sidecar's `youtubePlaybackStatus` object, so a future migration of the renderer's
//!   `postMessage`/event callback path can drop in unchanged.
//! - There is no persistence here yet (the sidecar kept this state in memory only); a future
//!   continuity task (architecture plan §17.5) may snapshot it to durable storage.

use std::sync::Mutex;

/// One YouTube player event reported by the renderer, matching the sidecar's allowed event set
/// (`ready`, `playing`, `ended`, `candidate_error`, `candidate_switch`, `exhausted`,
/// `identity_error`, `player_error`, `autoplay_blocked`). Kept as an opaque string rather than a
/// Rust enum so the bridge can forward events it does not yet have typed handling for without
/// rejecting the callback -- the sidecar's own allowlist is the authoritative validation point.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct YouTubePlaybackEvent {
    /// The playback ID the Agent issued when it resolved the player URL. Correlates this event
    /// with the originating `media.youtube.play` request.
    pub playback_id: String,
    /// The event name (`ready`, `playing`, `ended`, ...). Validated by the IPC handler before
    /// recording.
    pub event: String,
    /// The video ID the renderer reports the event for. May differ from the initially-selected
    /// candidate after a `candidate_switch`.
    pub video_id: String,
    /// YouTube error code if `event` is `player_error` / `identity_error` / `candidate_error`
    /// (e.g. `100`, `101`, `150`, `153`). `None` for non-error events.
    pub error_code: Option<i64>,
}

/// The current YouTube playback status, mirroring the sidecar's `youtubePlaybackStatus` object
/// field-for-field (minus the ISO timestamp, which the Agent does not need to expose).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct YouTubePlaybackStatus {
    /// The playback ID the Agent issued, or `None` if no playback has been started yet.
    pub playback_id: Option<String>,
    /// The last recorded event name (`loading` initially, matching the sidecar).
    pub status: String,
    /// The video ID the renderer is currently playing (or attempting to play).
    pub video_id: Option<String>,
    /// The index into `candidate_ids` the renderer is currently on (0-based).
    pub candidate_index: usize,
    /// The total number of candidates the Agent offered for this playback.
    pub candidate_count: usize,
    /// The last recorded YouTube error code, if any.
    pub error_code: Option<i64>,
    /// The normalized search query that produced this playback, if any (empty for direct
    /// `video_id` plays).
    pub query: String,
}

impl YouTubePlaybackStatus {
    /// The initial status the sidecar sets when a playback is dispatched: `loading`, with the
    /// first candidate selected.
    pub fn loading(
        playback_id: impl Into<String>,
        video_id: impl Into<String>,
        candidate_count: usize,
        query: impl Into<String>,
    ) -> Self {
        Self {
            playback_id: Some(playback_id.into()),
            status: "loading".to_string(),
            video_id: Some(video_id.into()),
            candidate_index: 0,
            candidate_count,
            error_code: None,
            query: query.into(),
        }
    }
}

/// The full YouTube playback state the Agent holds: the current status plus the ordered candidate
/// video IDs the renderer may fall back through on `candidate_error` (mirroring the sidecar's
/// `youtubePlaybackCandidateIds` array).
#[derive(Debug, Default)]
pub struct YouTubePlaybackState {
    pub status: YouTubePlaybackStatus,
    pub candidate_ids: Vec<String>,
}

/// Thread-safe wrapper around [`YouTubePlaybackState`] so the IPC handler (which runs on the IPC
/// thread) and a future Core reconnect path can both read/update it without moving ownership
/// around. The mutex is short-lived -- only held for the duration of a record or snapshot.
#[derive(Debug, Default)]
pub struct MediaState {
    youtube: Mutex<YouTubePlaybackState>,
}

/// Allowed YouTube player event names, matching the sidecar's allowlist exactly. The IPC handler
/// rejects any status callback whose `event` is not in this set, so the recorded state never
/// contains an untrusted string the renderer invented.
pub const ALLOWED_YOUTUBE_EVENTS: &[&str] = &[
    "ready",
    "playing",
    "ended",
    "candidate_error",
    "candidate_switch",
    "exhausted",
    "identity_error",
    "player_error",
    "autoplay_blocked",
];

impl MediaState {
    /// Creates an empty media state. The daemon constructs one of these at startup and shares it
    /// between the IPC handler and (eventually) the Core reconnect path.
    pub fn new() -> Self {
        Self::default()
    }

    /// Begins a new YouTube playback: resets the candidate list and status to `loading` for the
    /// first candidate. Called by the IPC handler when `media.youtube.play` resolves a player URL.
    pub fn start_youtube_playback(
        &self,
        playback_id: impl Into<String>,
        candidate_ids: Vec<String>,
        query: impl Into<String>,
    ) {
        let playback_id = playback_id.into();
        let query = query.into();
        let count = candidate_ids.len();
        let first = candidate_ids.first().cloned().unwrap_or_default();
        let mut state = self.youtube.lock().expect("youtube state mutex poisoned");
        state.candidate_ids = candidate_ids;
        state.status = YouTubePlaybackStatus::loading(playback_id, first, count, query);
    }

    /// Records a YouTube player event reported by the renderer. Returns `true` if the event
    /// matched the current playback (same `playback_id` and `video_id` is one of the candidates)
    /// and was recorded, or `false` if it was a stale callback for a previous playback and was
    /// ignored -- mirroring the sidecar's `eventMatchesCurrentPlayback` gate.
    ///
    /// The caller (IPC handler) is responsible for validating `event` against
    /// [`ALLOWED_YOUTUBE_EVENTS`] before calling this; this function trusts the event name.
    pub fn record_youtube_event(&self, event: &YouTubePlaybackEvent) -> bool {
        let mut state = self.youtube.lock().expect("youtube state mutex poisoned");
        let matches_current = state.status.playback_id.as_deref()
            == Some(event.playback_id.as_str())
            && state.candidate_ids.iter().any(|id| id == &event.video_id);
        if !matches_current {
            return false;
        }
        // If the renderer reports a candidate switch, advance the index to the reported video_id.
        if event.event == "candidate_switch" {
            if let Some(index) = state
                .candidate_ids
                .iter()
                .position(|id| id == &event.video_id)
            {
                state.status.candidate_index = index;
            }
        }
        state.status.status = event.event.clone();
        state.status.video_id = Some(event.video_id.clone());
        state.status.error_code = event.error_code;
        true
    }

    /// Returns a snapshot of the current YouTube playback status + candidate IDs. Used by the
    /// `media.youtube.state` IPC method and (eventually) the Core reconnect continuity path.
    pub fn youtube_state(&self) -> (YouTubePlaybackStatus, Vec<String>) {
        let state = self.youtube.lock().expect("youtube state mutex poisoned");
        (state.status.clone(), state.candidate_ids.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loading_status_has_the_first_candidate_selected() {
        let status = YouTubePlaybackStatus::loading("pb1", "vid1", 3, "rick astley");
        assert_eq!(status.status, "loading");
        assert_eq!(status.playback_id.as_deref(), Some("pb1"));
        assert_eq!(status.video_id.as_deref(), Some("vid1"));
        assert_eq!(status.candidate_index, 0);
        assert_eq!(status.candidate_count, 3);
        assert_eq!(status.query, "rick astley");
    }

    #[test]
    fn start_youtube_playback_resets_state_and_records_loading() {
        let state = MediaState::new();
        state.start_youtube_playback("pb1", vec!["a".to_string(), "b".to_string()], "query");
        let (status, candidates) = state.youtube_state();
        assert_eq!(status.status, "loading");
        assert_eq!(status.playback_id.as_deref(), Some("pb1"));
        assert_eq!(status.video_id.as_deref(), Some("a"));
        assert_eq!(status.candidate_count, 2);
        assert_eq!(candidates, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn record_event_for_current_playback_updates_status() {
        let state = MediaState::new();
        state.start_youtube_playback("pb1", vec!["a".to_string(), "b".to_string()], "query");
        let recorded = state.record_youtube_event(&YouTubePlaybackEvent {
            playback_id: "pb1".to_string(),
            event: "playing".to_string(),
            video_id: "a".to_string(),
            error_code: None,
        });
        assert!(recorded);
        let (status, _) = state.youtube_state();
        assert_eq!(status.status, "playing");
        assert_eq!(status.error_code, None);
    }

    #[test]
    fn record_event_for_a_stale_playback_id_is_ignored() {
        let state = MediaState::new();
        state.start_youtube_playback("pb1", vec!["a".to_string()], "query");
        let recorded = state.record_youtube_event(&YouTubePlaybackEvent {
            playback_id: "pb-old".to_string(),
            event: "playing".to_string(),
            video_id: "a".to_string(),
            error_code: None,
        });
        assert!(!recorded);
        let (status, _) = state.youtube_state();
        assert_eq!(status.status, "loading");
    }

    #[test]
    fn record_event_for_a_video_id_not_in_candidates_is_ignored() {
        let state = MediaState::new();
        state.start_youtube_playback("pb1", vec!["a".to_string()], "query");
        let recorded = state.record_youtube_event(&YouTubePlaybackEvent {
            playback_id: "pb1".to_string(),
            event: "playing".to_string(),
            video_id: "not-a-candidate".to_string(),
            error_code: None,
        });
        assert!(!recorded);
    }

    #[test]
    fn candidate_switch_advances_the_candidate_index() {
        let state = MediaState::new();
        state.start_youtube_playback(
            "pb1",
            vec!["a".to_string(), "b".to_string(), "c".to_string()],
            "query",
        );
        let recorded = state.record_youtube_event(&YouTubePlaybackEvent {
            playback_id: "pb1".to_string(),
            event: "candidate_switch".to_string(),
            video_id: "c".to_string(),
            error_code: Some(150),
        });
        assert!(recorded);
        let (status, _) = state.youtube_state();
        assert_eq!(status.candidate_index, 2);
        assert_eq!(status.video_id.as_deref(), Some("c"));
        assert_eq!(status.error_code, Some(150));
    }

    #[test]
    fn record_event_preserves_the_error_code_for_error_events() {
        let state = MediaState::new();
        state.start_youtube_playback("pb1", vec!["a".to_string()], "query");
        state.record_youtube_event(&YouTubePlaybackEvent {
            playback_id: "pb1".to_string(),
            event: "player_error".to_string(),
            video_id: "a".to_string(),
            error_code: Some(153),
        });
        let (status, _) = state.youtube_state();
        assert_eq!(status.status, "player_error");
        assert_eq!(status.error_code, Some(153));
    }
}
