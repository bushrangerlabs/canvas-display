import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const SEARCH_CACHE_TTL_MS = 15 * 60_000;
const API_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_RESULTS = 25;
const MAX_PLAYER_CANDIDATES = 10;
const MAX_PLAYLIST_ITEMS = 50;
const execFileAsync = promisify(execFile);

export type YouTubeSafeSearch = 'none' | 'moderate' | 'strict';

export interface YouTubeSearchOptions {
  apiKey?: string;
  regionCode?: string;
  relevanceLanguage?: string;
  safeSearch?: YouTubeSafeSearch;
  maxResults?: number;
  fetchImpl?: typeof fetch;
  /** Permit the local yt-dlp binary as a title-search fallback when no Data API key exists. */
  allowYtDlpFallback?: boolean;
  /** Injectable fallback used by tests; production uses yt-dlp. */
  fallbackSearch?: (query: string, maxResults: number) => Promise<YouTubeCandidate[]>;
}

export interface YouTubeCandidate {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string;
  madeForKids: boolean | null;
  searchPosition: number;
}

export type YouTubeApiErrorCode =
  | 'youtube_api_key_missing'
  | 'youtube_api_key_invalid'
  | 'youtube_quota_exceeded'
  | 'youtube_api_request_failed'
  | 'youtube_api_response_invalid';

export class YouTubeApiError extends Error {
  constructor(
    public readonly code: YouTubeApiErrorCode,
    message: string,
    public readonly httpStatus = 502,
  ) {
    super(message);
    this.name = 'YouTubeApiError';
  }
}

type CachedCandidates = {
  candidates: YouTubeCandidate[];
  expiresAt: number;
};

type SearchCandidate = {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string;
  searchPosition: number;
};

type YouTubeSearchResponse = {
  regionCode?: string;
  items?: Array<{
    id?: { videoId?: string; playlistId?: string };
    snippet?: {
      title?: string;
      channelTitle?: string;
      thumbnails?: Record<string, { url?: string }>;
    };
  }>;
};

type YouTubePlaylistItemsResponse = {
  nextPageToken?: string;
  items?: Array<{
    snippet?: {
      title?: string;
      channelTitle?: string;
      position?: number;
      resourceId?: { videoId?: string };
      thumbnails?: Record<string, { url?: string }>;
    };
  }>;
};

type YouTubePlaylistsResponse = {
  items?: Array<{
    id?: string;
    snippet?: {
      title?: string;
      channelTitle?: string;
      description?: string;
      thumbnails?: Record<string, { url?: string }>;
    };
    contentDetails?: { itemCount?: number };
  }>;
};

export type YouTubePlaylistCandidate = {
  playlistId: string;
  title: string;
  channelTitle: string;
  description: string;
  itemCount: number;
  searchPosition: number;
  thumbnailUrl?: string;
};

type YouTubeVideosResponse = {
  items?: Array<{
    id?: string;
    snippet?: {
      title?: string;
      channelTitle?: string;
      thumbnails?: Record<string, { url?: string }>;
    };
    status?: {
      embeddable?: boolean;
      privacyStatus?: string;
      uploadStatus?: string;
      madeForKids?: boolean;
    };
    contentDetails?: {
      regionRestriction?: {
        allowed?: string[];
        blocked?: string[];
      };
      contentRating?: {
        ytRating?: string;
      };
    };
  }>;
};

const candidateCache = new Map<string, CachedCandidates>();

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '');
}

function isYouTubeHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  return host === 'youtube.com'
    || host.endsWith('.youtube.com')
    || host === 'youtube-nocookie.com'
    || host.endsWith('.youtube-nocookie.com')
    || host === 'youtu.be';
}

function validVideoId(value: string | null | undefined): string | null {
  const candidate = (value ?? '').trim();
  return VIDEO_ID_PATTERN.test(candidate) ? candidate : null;
}

export function validateYouTubeVideoId(value: string | null | undefined): string | null {
  return validVideoId(value);
}

function decodeFormValue(value: string): string {
  const withSpaces = value.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(withSpaces);
  } catch {
    return withSpaces;
  }
}

function normalizeUrlCandidate(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.includes('://')) return trimmed;
  if (/^(?:www\.)?(?:youtube\.com|youtu\.be)\//i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

export function extractYouTubeVideoId(value: string): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;

  const directId = validVideoId(raw);
  // A bare alphabetic 11-character value can be a normal title (for example,
  // "Radioactive"). Treat those as search text; callers can use a watch URL
  // when an all-letter ID must be supplied explicitly.
  if (directId && !/^[A-Za-z]{11}$/.test(raw)) return directId;

  const candidate = normalizeUrlCandidate(raw);
  try {
    const parsed = new URL(candidate);
    if (!isYouTubeHost(parsed.hostname)) return null;

    const host = normalizeHost(parsed.hostname);
    if (host === 'youtu.be') {
      return validVideoId(parsed.pathname.split('/').filter(Boolean)[0]);
    }

    const queryId = validVideoId(parsed.searchParams.get('v'))
      ?? validVideoId(parsed.searchParams.get('vi'));
    if (queryId) return queryId;

    const pathParts = parsed.pathname.split('/').filter(Boolean);
    if (['embed', 'shorts', 'live', 'watch'].includes(pathParts[0] ?? '')) {
      const pathId = validVideoId(pathParts[1]);
      if (pathId) return pathId;
    }

    const nestedUrl = parsed.searchParams.get('u') ?? parsed.searchParams.get('q');
    if (nestedUrl) return extractYouTubeVideoId(decodeFormValue(nestedUrl));
  } catch {
    // Fall through to recovery patterns for malformed URLs returned by agents.
  }

  if (/youtube|youtu\.be/i.test(raw)) {
    const recovered = raw.match(/(?:youtu\.be\/|(?:watch|embed|shorts|live)(?:\?v=|\/))([A-Za-z0-9_-]{11})(?:[^A-Za-z0-9_-]|$)/i);
    if (recovered?.[1]) return recovered[1];
  }

  return null;
}

export function extractYouTubePlaylistId(value: string): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(normalizeUrlCandidate(raw));
    if (!isYouTubeHost(parsed.hostname)) return null;
    const playlistId = (parsed.searchParams.get('list') ?? '').trim();
    return /^[A-Za-z0-9_-]{10,80}$/.test(playlistId) ? playlistId : null;
  } catch {
    const recovered = raw.match(/[?&]list=([A-Za-z0-9_-]{10,80})(?:[^A-Za-z0-9_-]|$)/i);
    return recovered?.[1] ?? null;
  }
}

function unwrapSearchQuery(value: string): string {
  let current = (value ?? '').trim();
  for (let depth = 0; depth < 5; depth += 1) {
    const match = current.match(/[?&]search_query=([^&#]*)/i);
    if (!match?.[1]) break;
    const decoded = decodeFormValue(match[1]).trim();
    if (!decoded || decoded === current) break;
    current = decoded;
  }
  return current;
}

export function normalizeYouTubeQuery(value: string): string {
  const unwrapped = unwrapSearchQuery(value);
  if (!unwrapped || extractYouTubeVideoId(unwrapped)) return '';

  if (/^https?:\/\//i.test(unwrapped)) return '';

  return unwrapped
    .replace(/^site:youtube\.com\/watch\s+/i, '')
    .replace(/\b(on\s+youtube|youtube|youtu\.be)\b/gi, '')
    .replace(/^\s*(play|watch|listen to|listen|search|find|open|show|start|put on)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildYouTubeWatchUrl(videoId: string, autoplay = true): string {
  const id = validVideoId(videoId);
  if (!id) throw new Error(`Invalid YouTube video id: ${videoId}`);
  return autoplay
    ? `https://www.youtube.com/watch?v=${id}&autoplay=1`
    : `https://www.youtube.com/watch?v=${id}`;
}

export function buildYouTubeEmbedUrl(videoId: string): string {
  const id = validVideoId(videoId);
  if (!id) throw new Error(`Invalid YouTube video id: ${videoId}`);
  return `https://www.youtube.com/embed/${id}?autoplay=1&enablejsapi=1&playsinline=1&rel=0`;
}

function uniqueValidVideoIds(values: string[], limit = MAX_PLAYER_CANDIDATES): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const id = validVideoId(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= limit) break;
  }
  return ids;
}

export function buildYouTubePlayerHtml(videoIds: string | string[], playbackId = '', playlistMode = false): string {
  const ids = uniqueValidVideoIds(Array.isArray(videoIds) ? videoIds : [videoIds], playlistMode ? MAX_PLAYLIST_ITEMS : MAX_PLAYER_CANDIDATES);
  if (ids.length === 0) throw new Error('At least one valid YouTube video id is required');
  const safePlaybackId = /^[A-Za-z0-9_-]{0,80}$/.test(playbackId) ? playbackId : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="referrer" content="strict-origin-when-cross-origin">
  <title>YouTube Player</title>
  <style>
    html, body { width: 100%; height: 100%; margin: 0; background: #000; color: #fff; overflow: hidden; }
    body { display: flex; flex-direction: column; font: 500 16px/1.4 system-ui, sans-serif; }
    #player-shell { flex: 1 1 auto; min-width: 200px; min-height: 200px; background: #000; }
    #player { width: 100%; height: 100%; }
    #canvas-controls {
      position: fixed; z-index: 2147483647; right: 112px;
      top: 48px; display: flex; gap: 12px;
      align-items: center; pointer-events: auto;
    }
    .canvas-control {
      width: 58px; height: 58px; border: 1px solid rgba(255,255,255,.55);
      border-radius: 50%; color: #fff; background: rgba(12,12,12,.72);
      box-shadow: 0 3px 18px rgba(0,0,0,.55); font: 700 25px/1 system-ui, sans-serif;
      cursor: pointer; touch-action: manipulation; opacity: .45;
      transition: opacity 140ms ease, transform 140ms ease, background 140ms ease;
    }
    .canvas-control:hover, .canvas-control:focus-visible, .canvas-control:active {
      opacity: 1; background: rgba(12,12,12,.94); transform: scale(1.06); outline: 2px solid #fff;
    }
    #canvas-close { opacity: .9; background: rgba(120,12,12,.82); font-size: 31px; }
    #status {
      flex: 0 0 auto; display: flex; align-items: center; justify-content: center; gap: 12px;
      min-height: 44px; padding: 8px 16px; box-sizing: border-box; color: #fff;
      background: #151515; text-align: center;
    }
    #status[hidden] { display: none; }
    #retry { border: 1px solid #fff; border-radius: 5px; padding: 7px 14px; color: #fff; background: #272727; font: inherit; }
    #retry[hidden] { display: none; }
  </style>
</head>
<body>
  <div id="player-shell"><div id="player"></div></div>
  <div id="canvas-controls" aria-label="YouTube playback controls">
    <button id="canvas-pause" class="canvas-control" type="button" aria-label="Pause video" title="Pause">Ⅱ</button>
    <button id="canvas-next" class="canvas-control" type="button" aria-label="Next video" title="Next">›</button>
    <button id="canvas-close" class="canvas-control" type="button" aria-label="Close video" title="Close">×</button>
  </div>
  <div id="status"><span id="status-text">Loading YouTube…</span><button id="retry" type="button" hidden>Play</button></div>
  <script>
    const candidates = ${JSON.stringify(ids)};
    const playbackId = ${JSON.stringify(safePlaybackId)};
    const playlistMode = ${playlistMode ? 'true' : 'false'};
    const status = document.getElementById('status');
    const statusText = document.getElementById('status-text');
    const retryButton = document.getElementById('retry');
    const pauseButton = document.getElementById('canvas-pause');
    const nextButton = document.getElementById('canvas-next');
    const closeButton = document.getElementById('canvas-close');
    let candidateIndex = 0;
    let reportedPlayingVideoId = '';
    let switchTimer = null;
    let switchingCandidate = false;
    let fatalPlayerError = false;
    let player;

    function currentVideoId() {
      return candidates[candidateIndex] || '';
    }

    function setStatus(message, retryable) {
      statusText.textContent = message || '';
      status.hidden = !message;
      retryButton.hidden = !retryable;
    }

    function report(event, detail) {
      const body = Object.assign({
        playback_id: playbackId,
        event,
        video_id: currentVideoId(),
        candidate_index: candidateIndex,
        candidate_count: candidates.length
      }, detail || {});
      fetch('/api/media/youtube/player-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true
      }).catch(function () {});
    }

    function tryNextCandidate(errorCode) {
      if (fatalPlayerError || switchingCandidate) return;
      switchingCandidate = true;
      report('candidate_error', { error_code: errorCode });
      if (candidateIndex + 1 >= candidates.length) {
        setStatus('No embeddable YouTube result could be played.', false);
        report('exhausted', { error_code: errorCode });
        return;
      }

      candidateIndex += 1;
      reportedPlayingVideoId = '';
      setStatus('Trying another YouTube result…', false);
      report('candidate_switch', { previous_error_code: errorCode });
      switchTimer = window.setTimeout(function () {
        switchTimer = null;
        if (fatalPlayerError) return;
        switchingCandidate = false;
        player.loadVideoById({ videoId: currentVideoId(), startSeconds: 0 });
      }, 250);
    }

    function nextCandidate() {
      if (!player || candidates.length < 2) {
        report('next_unavailable');
        return false;
      }
      candidateIndex = (candidateIndex + 1) % candidates.length;
      reportedPlayingVideoId = '';
      switchingCandidate = false;
      setStatus('Loading next YouTube result…', false);
      report('candidate_switch', { manual: true });
      player.loadVideoById({ videoId: currentVideoId(), startSeconds: 0 });
      return true;
    }

    function closePlayer() {
      if (player && typeof player.stopVideo === 'function') player.stopVideo();
      report('stopped', { control: 'touch_close' });
      window.setTimeout(function () {
        window.location.href = 'canvas-player://close';
      }, 60);
    }

    function togglePlayback() {
      if (!player || typeof player.getPlayerState !== 'function') return;
      if (player.getPlayerState() === YT.PlayerState.PLAYING) {
        window.__canvasYouTubeControl.pause();
        pauseButton.textContent = '▶';
        pauseButton.setAttribute('aria-label', 'Resume video');
        pauseButton.title = 'Resume';
      } else {
        window.__canvasYouTubeControl.resume();
        pauseButton.textContent = 'Ⅱ';
        pauseButton.setAttribute('aria-label', 'Pause video');
        pauseButton.title = 'Pause';
      }
    }

    window.__canvasYouTubeControl = {
      pause: function () {
        if (!player) return false;
        player.pauseVideo();
        setStatus('Paused', false);
        report('paused');
        return true;
      },
      resume: function () {
        if (!player) return false;
        reportedPlayingVideoId = '';
        player.playVideo();
        report('resumed');
        return true;
      },
      stop: function () {
        if (!player) return false;
        player.stopVideo();
        report('stopped');
        return true;
      },
      next: nextCandidate
    };

    pauseButton.addEventListener('click', togglePlayback);
    nextButton.addEventListener('click', nextCandidate);
    closeButton.addEventListener('click', closePlayer);

    retryButton.addEventListener('click', function () {
      retryButton.hidden = true;
      setStatus('Starting YouTube…', false);
      player.playVideo();
    });

    window.onYouTubeIframeAPIReady = function () {
      player = new YT.Player('player', {
        width: '100%',
        height: '100%',
        videoId: currentVideoId(),
        playerVars: {
          autoplay: 1,
          controls: 1,
          fs: 0,
          playsinline: 1,
          rel: 0,
          origin: window.location.origin
        },
        events: {
          onReady: function (event) {
            report('ready');
            event.target.playVideo();
          },
          onStateChange: function (event) {
            if (event.data === YT.PlayerState.PLAYING) {
              pauseButton.textContent = 'Ⅱ';
              pauseButton.setAttribute('aria-label', 'Pause video');
              setStatus('', false);
              if (reportedPlayingVideoId !== currentVideoId()) {
                reportedPlayingVideoId = currentVideoId();
                report('playing');
              }
            } else if (event.data === YT.PlayerState.ENDED) {
              report('ended');
              if (playlistMode) nextCandidate();
            }
          },
          onError: function (event) {
            const code = Number(event.data);
            console.error('[youtube-player] error', code, currentVideoId());
            if (code === 153) {
              fatalPlayerError = true;
              switchingCandidate = false;
              if (switchTimer !== null) {
                window.clearTimeout(switchTimer);
                switchTimer = null;
              }
              setStatus('YouTube client identity error 153. Check the player Referer configuration.', false);
              report('identity_error', { error_code: code });
              return;
            }
            if ([2, 5, 100, 101, 150].includes(code)) {
              tryNextCandidate(code);
              return;
            }
            setStatus('YouTube playback error ' + code, false);
            report('player_error', { error_code: code });
          },
          onAutoplayBlocked: function () {
            setStatus('YouTube blocked autoplay. Select Play to continue.', true);
            report('autoplay_blocked');
          }
        }
      });
    };
  </script>
  <script src="https://www.youtube.com/iframe_api" referrerpolicy="strict-origin-when-cross-origin"></script>
</body>
</html>`;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function normalizeMatchText(value: string): string {
  return decodeHtmlEntities(value)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueTokens(value: string): string[] {
  return Array.from(new Set(normalizeMatchText(value).split(' ').filter(Boolean)));
}

const PLAYLIST_QUERY_FILLER = new Set([
  'a', 'an', 'the', 'my', 'some', 'please', 'play', 'playlist', 'youtube',
  'official', 'artist', 'music', 'greatest', 'hits',
]);

function playlistTokens(value: string): string[] {
  const canonical = normalizeMatchText(value)
    .replace(/\beighties\b/g, '80s')
    .replace(/\bnineties\b/g, '90s')
    .replace(/\bseventies\b/g, '70s')
    .replace(/\bsixties\b/g, '60s')
    .replace(/\btwo thousands\b/g, '2000s');
  return Array.from(new Set(canonical.split(' ').filter(token => token && !PLAYLIST_QUERY_FILLER.has(token))));
}

export function scoreYouTubePlaylistCandidate(candidate: YouTubePlaylistCandidate, query: string): number {
  const queryTokens = playlistTokens(query);
  const titleTokens = playlistTokens(candidate.title);
  const haystackTokens = new Set(playlistTokens(`${candidate.title} ${candidate.channelTitle} ${candidate.description}`));
  const titleSet = new Set(titleTokens);
  const titleMatches = queryTokens.filter(token => titleSet.has(token)).length;
  const allMatches = queryTokens.filter(token => haystackTokens.has(token)).length;
  const titleCoverage = queryTokens.length ? titleMatches / queryTokens.length : 0;
  const allCoverage = queryTokens.length ? allMatches / queryTokens.length : 0;
  let score = titleCoverage * 320 + allCoverage * 90;
  const normalizedQuery = playlistTokens(query).join(' ');
  const normalizedTitle = playlistTokens(candidate.title).join(' ');
  if (normalizedQuery && normalizedTitle === normalizedQuery) score += 220;
  if (normalizedQuery && normalizedTitle.includes(normalizedQuery)) score += 100;
  if (/\b(official|vevo|topic|records|music)\b/i.test(candidate.channelTitle)) score += 18;
  if (/\b(official|complete|full album|greatest hits|best of)\b/i.test(candidate.title)) score += 15;
  if (/\b(karaoke|reaction|review|tutorial|cover|fan made|parody)\b/i.test(candidate.title)) score -= 100;
  if (candidate.itemCount < 2) score -= 250;
  else score += Math.min(35, Math.log2(candidate.itemCount + 1) * 6);
  score -= candidate.searchPosition * 0.5;
  return score;
}

export function rankYouTubePlaylistCandidates(
  candidates: YouTubePlaylistCandidate[],
  query: string,
): YouTubePlaylistCandidate[] {
  return candidates
    .map((candidate, stableIndex) => ({ candidate, stableIndex, score: scoreYouTubePlaylistCandidate(candidate, query) }))
    .sort((a, b) => b.score - a.score || a.candidate.searchPosition - b.candidate.searchPosition || a.stableIndex - b.stableIndex)
    .map(({ candidate }) => candidate);
}

const VARIANT_PENALTIES: Array<{ pattern: RegExp; penalty: number }> = [
  { pattern: /\b(mashup|medley|versus|vs)\b/i, penalty: 100 },
  { pattern: /\b(reaction|review|analysis|documentary|interview|tutorial|explained|story)\b/i, penalty: 85 },
  { pattern: /\b(karaoke|instrumental|cover|parody|tribute)\b/i, penalty: 70 },
  { pattern: /\b(remix|extended|mix|edit|sped up|slowed|reverb|nightcore|alternate|alternative)\b/i, penalty: 48 },
  { pattern: /\b(live|concert|tour|performance|session|acoustic|archive|hootenanny)\b/i, penalty: 32 },
  { pattern: /\b(lyrics?|lyric video)\b/i, penalty: 8 },
];

export function scoreYouTubeCandidate(candidate: YouTubeCandidate, query: string): number {
  const normalizedQuery = normalizeMatchText(query);
  const normalizedTitle = normalizeMatchText(candidate.title);
  if (!normalizedQuery) return -candidate.searchPosition;

  const queryTokens = uniqueTokens(normalizedQuery);
  const titleTokens = uniqueTokens(normalizedTitle);
  const titleTokenSet = new Set(titleTokens);
  const matchedTokens = queryTokens.filter((token) => titleTokenSet.has(token));
  const coverage = queryTokens.length > 0 ? matchedTokens.length / queryTokens.length : 0;
  const extraTokenCount = titleTokens.filter((token) => !queryTokens.includes(token)).length;

  let score = coverage * 220;
  score += matchedTokens.length * 5;
  score -= Math.min(45, extraTokenCount * 1.5);

  if (normalizedTitle === normalizedQuery) score += 180;
  if (normalizedTitle.includes(normalizedQuery)) score += 120;
  if (normalizedTitle.startsWith(normalizedQuery) || normalizedTitle.endsWith(normalizedQuery)) score += 15;

  for (const { pattern, penalty } of VARIANT_PENALTIES) {
    if (pattern.test(candidate.title) && !pattern.test(query)) score -= penalty;
  }

  if (/\bofficial (audio|video)\b/i.test(candidate.title) && !/\b(unofficial|fan)\b/i.test(candidate.title)) {
    score += 16;
  }

  const slashSegments = candidate.title.split(/\s+[|/]\s*|\s*\/\s+/).filter(Boolean);
  if (slashSegments.length > 1 && !/[|/]/.test(query)) {
    const nonQuerySegment = slashSegments.some((segment) => {
      const normalizedSegment = normalizeMatchText(segment);
      return normalizedSegment && !normalizedSegment.includes(normalizedQuery) && uniqueTokens(segment).length >= 3;
    });
    if (nonQuerySegment) score -= 90;
  }

  score -= Math.max(0, candidate.searchPosition) * 0.25;
  return score;
}

export function rankYouTubeCandidates(candidates: YouTubeCandidate[], query: string): YouTubeCandidate[] {
  return candidates
    .map((candidate, stableIndex) => ({ candidate, stableIndex, score: scoreYouTubeCandidate(candidate, query) }))
    .sort((a, b) => b.score - a.score || a.candidate.searchPosition - b.candidate.searchPosition || a.stableIndex - b.stableIndex)
    .map(({ candidate }) => candidate);
}

function normalizeRegionCode(value: string | undefined): string {
  const region = (value ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(region) ? region : 'US';
}

function normalizeLanguage(value: string | undefined): string {
  const language = (value ?? '').trim();
  return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language) ? language : 'en';
}

function normalizeSafeSearch(value: YouTubeSafeSearch | undefined): YouTubeSafeSearch {
  return value === 'none' || value === 'strict' ? value : 'moderate';
}

function thumbnailFromMap(thumbnails: Record<string, { url?: string }> | undefined): string {
  return thumbnails?.maxres?.url
    ?? thumbnails?.standard?.url
    ?? thumbnails?.high?.url
    ?? thumbnails?.medium?.url
    ?? thumbnails?.default?.url
    ?? '';
}

function isAllowedInRegion(
  regionCode: string,
  restriction: { allowed?: string[]; blocked?: string[] } | undefined,
): boolean {
  if (!restriction) return true;
  if (restriction.allowed !== undefined) return restriction.allowed.includes(regionCode);
  if (restriction.blocked !== undefined) return !restriction.blocked.includes(regionCode);
  return true;
}

function classifyApiFailure(status: number, payload: unknown): YouTubeApiError {
  const serialized = JSON.stringify(payload ?? {});
  if (/quotaExceeded|dailyLimitExceeded|rateLimitExceeded/i.test(serialized)) {
    return new YouTubeApiError('youtube_quota_exceeded', 'YouTube Data API search quota is unavailable', 503);
  }
  if (/keyInvalid|API_KEY_INVALID|accessNotConfigured|forbidden/i.test(serialized) || status === 401) {
    return new YouTubeApiError('youtube_api_key_invalid', 'The configured YouTube Data API key was rejected', 503);
  }
  return new YouTubeApiError('youtube_api_request_failed', `YouTube Data API request failed with HTTP ${status}`, 502);
}

async function requestYouTubeJson<T>(url: URL, fetchImpl: typeof fetch): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    throw new YouTubeApiError(
      'youtube_api_request_failed',
      `YouTube Data API request failed: ${(err as Error).message}`,
      502,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    throw new YouTubeApiError('youtube_api_response_invalid', 'YouTube Data API returned invalid JSON', 502);
  }

  if (!response.ok) throw classifyApiFailure(response.status, payload);
  return payload as T;
}

async function searchYouTubeDataApi(
  query: string,
  options: Required<Pick<YouTubeSearchOptions, 'apiKey' | 'regionCode' | 'relevanceLanguage' | 'safeSearch' | 'maxResults'>>,
  fetchImpl: typeof fetch,
): Promise<SearchCandidate[]> {
  const url = new URL('https://www.googleapis.com/youtube/v3/search');
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('type', 'video');
  url.searchParams.set('q', query);
  url.searchParams.set('videoEmbeddable', 'true');
  url.searchParams.set('videoSyndicated', 'true');
  url.searchParams.set('order', 'relevance');
  url.searchParams.set('regionCode', options.regionCode);
  url.searchParams.set('relevanceLanguage', options.relevanceLanguage);
  url.searchParams.set('safeSearch', options.safeSearch);
  url.searchParams.set('maxResults', String(options.maxResults));
  url.searchParams.set('key', options.apiKey);

  const response = await requestYouTubeJson<YouTubeSearchResponse>(url, fetchImpl);
  const candidates: SearchCandidate[] = [];
  const seen = new Set<string>();

  for (const [position, item] of (response.items ?? []).entries()) {
    const videoId = validVideoId(item.id?.videoId);
    if (!videoId || seen.has(videoId)) continue;
    seen.add(videoId);
    candidates.push({
      videoId,
      title: item.snippet?.title ?? '',
      channelTitle: item.snippet?.channelTitle ?? '',
      thumbnailUrl: thumbnailFromMap(item.snippet?.thumbnails),
      searchPosition: position,
    });
  }

  return candidates;
}

async function validateYouTubeCandidates(
  candidates: SearchCandidate[],
  apiKey: string,
  regionCode: string,
  fetchImpl: typeof fetch,
): Promise<YouTubeCandidate[]> {
  const ids = uniqueValidVideoIds(candidates.map((candidate) => candidate.videoId), 50);
  if (ids.length === 0) return [];

  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part', 'snippet,status,contentDetails');
  url.searchParams.set('id', ids.join(','));
  url.searchParams.set('key', apiKey);

  const response = await requestYouTubeJson<YouTubeVideosResponse>(url, fetchImpl);
  const detailById = new Map((response.items ?? []).map((item) => [item.id ?? '', item]));
  const validated: YouTubeCandidate[] = [];

  for (const candidate of candidates) {
    const item = detailById.get(candidate.videoId);
    if (!item) continue;
    const status = item.status;
    const contentDetails = item.contentDetails;
    if (status?.embeddable !== true) continue;
    if (status.privacyStatus !== 'public') continue;
    if (status.uploadStatus !== 'processed') continue;
    if (contentDetails?.contentRating?.ytRating === 'ytAgeRestricted') continue;
    if (!isAllowedInRegion(regionCode, contentDetails?.regionRestriction)) continue;

    validated.push({
      videoId: candidate.videoId,
      title: item.snippet?.title ?? candidate.title,
      channelTitle: item.snippet?.channelTitle ?? candidate.channelTitle,
      thumbnailUrl: thumbnailFromMap(item.snippet?.thumbnails) || candidate.thumbnailUrl,
      madeForKids: typeof status?.madeForKids === 'boolean' ? status.madeForKids : null,
      searchPosition: candidate.searchPosition,
    });
  }

  return validated;
}

function directCandidate(videoId: string): YouTubeCandidate {
  return {
    videoId,
    title: '',
    channelTitle: '',
    thumbnailUrl: '',
    madeForKids: null,
    searchPosition: -1,
  };
}

async function searchYouTubeWithYtDlp(query: string, maxResults: number): Promise<YouTubeCandidate[]> {
  let stdout: string;
  try {
    const result = await execFileAsync('yt-dlp', [
      '--dump-single-json',
      '--flat-playlist',
      '--playlist-end', String(maxResults),
      '--no-warnings',
      '--no-playlist',
      `ytsearch${maxResults}:${query}`,
    ], {
      timeout: API_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (error) {
    throw new YouTubeApiError(
      'youtube_api_request_failed',
      `YouTube title search fallback failed: ${error instanceof Error ? error.message : String(error)}`,
      502,
    );
  }

  let payload: {
    entries?: Array<{
      id?: string;
      title?: string;
      channel?: string;
      uploader?: string;
      thumbnail?: string;
      age_limit?: number | null;
      availability?: string | null;
      live_status?: string | null;
    }>;
  };
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new YouTubeApiError(
      'youtube_api_response_invalid',
      'YouTube title search fallback returned invalid JSON',
      502,
    );
  }

  return (payload.entries ?? []).flatMap((entry, position) => {
    const videoId = validVideoId(entry.id);
    if (!videoId) return [];
    if (typeof entry.age_limit === 'number' && entry.age_limit > 0) return [];
    if (entry.availability && !['public', 'unlisted'].includes(entry.availability)) return [];
    if (entry.live_status && ['is_upcoming', 'is_live'].includes(entry.live_status)) return [];
    return [{
      videoId,
      title: entry.title ?? '',
      channelTitle: entry.channel ?? entry.uploader ?? '',
      thumbnailUrl: entry.thumbnail ?? '',
      madeForKids: null,
      searchPosition: position,
    }];
  });
}

async function resolvePlaylistWithYtDlp(value: string, maxResults: number): Promise<YouTubeCandidate[]> {
  let stdout: string;
  try {
    const result = await execFileAsync('yt-dlp', [
      '--dump-single-json',
      '--flat-playlist',
      '--playlist-end', String(maxResults),
      '--no-warnings',
      value,
    ], { timeout: API_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
    stdout = result.stdout;
  } catch (error) {
    throw new YouTubeApiError(
      'youtube_api_request_failed',
      `YouTube playlist lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      502,
    );
  }
  try {
    const payload = JSON.parse(stdout) as { entries?: Array<{ id?: string; title?: string; channel?: string; uploader?: string; thumbnail?: string }> };
    return (payload.entries ?? []).flatMap((entry, position) => {
      const videoId = validVideoId(entry.id);
      return videoId ? [{
        videoId,
        title: entry.title ?? '',
        channelTitle: entry.channel ?? entry.uploader ?? '',
        thumbnailUrl: entry.thumbnail ?? '',
        madeForKids: null,
        searchPosition: position,
      }] : [];
    });
  } catch {
    throw new YouTubeApiError('youtube_api_response_invalid', 'YouTube playlist lookup returned invalid JSON', 502);
  }
}

export async function searchYouTubePlaylists(
  query: string,
  apiKey: string,
  regionCode: string,
  relevanceLanguage: string,
  safeSearch: YouTubeSafeSearch,
  fetchImpl: typeof fetch,
): Promise<YouTubePlaylistCandidate[]> {
  const url = new URL('https://www.googleapis.com/youtube/v3/search');
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('type', 'playlist');
  const cleanedQuery = query.replace(/\bplaylist\b/gi, '').replace(/^\s*(?:a|an|the|my|some)\s+/i, '').trim() || query;
  url.searchParams.set('q', cleanedQuery);
  url.searchParams.set('order', 'relevance');
  url.searchParams.set('regionCode', regionCode);
  url.searchParams.set('relevanceLanguage', relevanceLanguage);
  url.searchParams.set('safeSearch', safeSearch);
  url.searchParams.set('maxResults', '15');
  url.searchParams.set('key', apiKey);
  const response = await requestYouTubeJson<YouTubeSearchResponse>(url, fetchImpl);
  const searchCandidates = (response.items ?? []).flatMap((item, searchPosition) => {
    const playlistId = item.id?.playlistId ?? '';
    if (!/^[A-Za-z0-9_-]{10,80}$/.test(playlistId)) return [];
    return [{
      playlistId,
      title: item.snippet?.title ?? '',
      channelTitle: item.snippet?.channelTitle ?? '',
      description: '',
      itemCount: 0,
      searchPosition,
      thumbnailUrl: thumbnailFromMap(item.snippet?.thumbnails),
    } satisfies YouTubePlaylistCandidate];
  });
  if (searchCandidates.length === 0) return [];

  const detailsUrl = new URL('https://www.googleapis.com/youtube/v3/playlists');
  detailsUrl.searchParams.set('part', 'snippet,contentDetails');
  detailsUrl.searchParams.set('id', searchCandidates.map(candidate => candidate.playlistId).join(','));
  detailsUrl.searchParams.set('key', apiKey);
  const details = await requestYouTubeJson<YouTubePlaylistsResponse>(detailsUrl, fetchImpl);
  const detailsById = new Map((details.items ?? []).map(item => [item.id ?? '', item]));
  const enriched = searchCandidates.flatMap(candidate => {
    const item = detailsById.get(candidate.playlistId);
    if (!item) return [];
    return [{
      ...candidate,
      title: item.snippet?.title ?? candidate.title,
      channelTitle: item.snippet?.channelTitle ?? candidate.channelTitle,
      description: item.snippet?.description ?? '',
      itemCount: item.contentDetails?.itemCount ?? 0,
      thumbnailUrl: thumbnailFromMap(item.snippet?.thumbnails) || candidate.thumbnailUrl,
    }];
  });
  const ranked = rankYouTubePlaylistCandidates(enriched, cleanedQuery);
  console.log('[youtube] Ranked playlist search:', {
    query: cleanedQuery,
    candidates: ranked.slice(0, 5).map(candidate => ({
      playlistId: candidate.playlistId,
      title: candidate.title,
      channel: candidate.channelTitle,
      itemCount: candidate.itemCount,
      score: Math.round(scoreYouTubePlaylistCandidate(candidate, cleanedQuery)),
    })),
  });
  return ranked;
}

async function resolvePlaylistWithDataApi(
  playlistId: string,
  apiKey: string,
  regionCode: string,
  fetchImpl: typeof fetch,
): Promise<YouTubeCandidate[]> {
  const discovered: SearchCandidate[] = [];
  let pageToken = '';
  while (discovered.length < MAX_PLAYLIST_ITEMS) {
    const url = new URL('https://www.googleapis.com/youtube/v3/playlistItems');
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('playlistId', playlistId);
    url.searchParams.set('maxResults', String(Math.min(50, MAX_PLAYLIST_ITEMS - discovered.length)));
    url.searchParams.set('key', apiKey);
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await requestYouTubeJson<YouTubePlaylistItemsResponse>(url, fetchImpl);
    for (const item of response.items ?? []) {
      const videoId = validVideoId(item.snippet?.resourceId?.videoId);
      if (!videoId) continue;
      discovered.push({
        videoId,
        title: item.snippet?.title ?? '',
        channelTitle: item.snippet?.channelTitle ?? '',
        thumbnailUrl: thumbnailFromMap(item.snippet?.thumbnails),
        searchPosition: item.snippet?.position ?? discovered.length,
      });
    }
    pageToken = response.nextPageToken ?? '';
    if (!pageToken) break;
  }
  return validateYouTubeCandidates(discovered, apiKey, regionCode, fetchImpl);
}

export type YouTubeQueue = { candidates: YouTubeCandidate[]; playlist: boolean; playlistId: string | null };

export async function resolveYouTubeQueue(
  value: string,
  fallbackQuery = '',
  options: YouTubeSearchOptions = {},
): Promise<YouTubeQueue> {
  let playlistId = extractYouTubePlaylistId(value) ?? extractYouTubePlaylistId(fallbackQuery);
  const query = normalizeYouTubeQuery(value) || normalizeYouTubeQuery(fallbackQuery);
  const wantsPlaylist = Boolean(playlistId) || /\bplaylist\b/i.test(`${value} ${fallbackQuery}`);
  if (!wantsPlaylist) {
    return { candidates: await resolveYouTubeCandidates(value, fallbackQuery, options), playlist: false, playlistId: null };
  }

  const apiKey = (options.apiKey ?? '').trim();
  const fetchImpl = options.fetchImpl ?? fetch;
  const regionCode = normalizeRegionCode(options.regionCode);
  if (!playlistId && apiKey) {
    const playlistMatches = await searchYouTubePlaylists(
      query,
      apiKey,
      regionCode,
      normalizeLanguage(options.relevanceLanguage),
      normalizeSafeSearch(options.safeSearch),
      fetchImpl,
    );
    playlistId = playlistMatches[0]?.playlistId ?? null;
  }
  if (!playlistId) {
    throw new YouTubeApiError(
      apiKey ? 'youtube_api_response_invalid' : 'youtube_api_key_missing',
      'No public YouTube playlist could be found. Configure a YouTube API key for spoken playlist searches.',
      apiKey ? 404 : 503,
    );
  }

  const playlistUrl = `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`;
  const candidates = apiKey
    ? await resolvePlaylistWithDataApi(playlistId, apiKey, regionCode, fetchImpl)
    : await resolvePlaylistWithYtDlp(playlistUrl, MAX_PLAYLIST_ITEMS);
  if (candidates.length === 0) {
    throw new YouTubeApiError('youtube_api_response_invalid', 'The YouTube playlist is empty or has no playable public videos', 404);
  }
  return { candidates, playlist: true, playlistId };
}

export function clearYouTubeCandidateCache(): void {
  candidateCache.clear();
}

export async function resolveYouTubeCandidates(
  value: string,
  fallbackQuery = '',
  options: YouTubeSearchOptions = {},
): Promise<YouTubeCandidate[]> {
  const directId = extractYouTubeVideoId(value) ?? extractYouTubeVideoId(fallbackQuery);
  const query = normalizeYouTubeQuery(value) || normalizeYouTubeQuery(fallbackQuery);
  const apiKey = (options.apiKey ?? '').trim();

  if (!apiKey) {
    if (directId) return [directCandidate(directId)];
    if (!query) return [];
    if (options.allowYtDlpFallback || options.fallbackSearch) {
      const maxResults = Math.max(5, Math.min(50, Math.trunc(options.maxResults ?? DEFAULT_MAX_RESULTS)));
      const fallback = options.fallbackSearch ?? searchYouTubeWithYtDlp;
      const candidates = await fallback(query, maxResults);
      const ranked = rankYouTubeCandidates(candidates, query).slice(0, MAX_PLAYER_CANDIDATES);
      console.log('[youtube] Resolved candidate pool with yt-dlp fallback:', {
        query,
        candidates: ranked.map((candidate) => ({ videoId: candidate.videoId, title: candidate.title })),
      });
      return ranked;
    }
    throw new YouTubeApiError(
      'youtube_api_key_missing',
      'A YouTube Data API key is required to search by title',
      503,
    );
  }

  const regionCode = normalizeRegionCode(options.regionCode);
  const relevanceLanguage = normalizeLanguage(options.relevanceLanguage);
  const safeSearch = normalizeSafeSearch(options.safeSearch);
  const maxResults = Math.max(5, Math.min(50, Math.trunc(options.maxResults ?? DEFAULT_MAX_RESULTS)));
  const cacheKey = [apiKey, directId ?? '', query.toLowerCase(), regionCode, relevanceLanguage, safeSearch, maxResults].join('|');
  const useCache = !options.fetchImpl;
  const cached = useCache ? candidateCache.get(cacheKey) : undefined;
  if (cached && cached.expiresAt > Date.now()) return cached.candidates.map((candidate) => ({ ...candidate }));
  if (cached) candidateCache.delete(cacheKey);

  const fetchImpl = options.fetchImpl ?? fetch;
  const discovered: SearchCandidate[] = [];
  if (directId) {
    discovered.push({
      videoId: directId,
      title: '',
      channelTitle: '',
      thumbnailUrl: '',
      searchPosition: -1,
    });
  }

  try {
    if (query) {
      const searched = await searchYouTubeDataApi(query, {
        apiKey,
        regionCode,
        relevanceLanguage,
        safeSearch,
        maxResults,
      }, fetchImpl);
      const seen = new Set(discovered.map((candidate) => candidate.videoId));
      for (const candidate of searched) {
        if (seen.has(candidate.videoId)) continue;
        seen.add(candidate.videoId);
        discovered.push(candidate);
      }
    }

    const validated = await validateYouTubeCandidates(discovered, apiKey, regionCode, fetchImpl);
    const validatedDirect = directId
      ? validated.find((candidate) => candidate.videoId === directId) ?? null
      : null;
    const searchedCandidates = validated.filter((candidate) => candidate.videoId !== directId);
    const rankedSearchCandidates = query
      ? rankYouTubeCandidates(searchedCandidates, query)
      : searchedCandidates;
    const result = [
      ...(validatedDirect ? [validatedDirect] : []),
      ...rankedSearchCandidates,
    ].slice(0, MAX_PLAYER_CANDIDATES);

    if (useCache) {
      if (candidateCache.size >= 100) {
        const oldestKey = candidateCache.keys().next().value as string | undefined;
        if (oldestKey) candidateCache.delete(oldestKey);
      }
      candidateCache.set(cacheKey, { candidates: result, expiresAt: Date.now() + SEARCH_CACHE_TTL_MS });
    }

    console.log('[youtube] Resolved candidate pool:', {
      query: query || null,
      regionCode,
      candidates: result.map((candidate) => ({ videoId: candidate.videoId, title: candidate.title })),
    });
    return result.map((candidate) => ({ ...candidate }));
  } catch (err) {
    if (directId) {
      console.warn('[youtube] Candidate lookup failed; using supplied video ID:', {
        videoId: directId,
        error: (err as Error).message,
      });
      return [directCandidate(directId)];
    }
    throw err;
  }
}

export async function resolveYouTubeVideoId(
  value: string,
  fallbackQuery = '',
  options: YouTubeSearchOptions = {},
): Promise<string | null> {
  const candidates = await resolveYouTubeCandidates(value, fallbackQuery, options);
  return candidates[0]?.videoId ?? null;
}

export async function resolveEmbeddableYouTubeVideoId(
  value: string,
  fallbackQuery = '',
  options: YouTubeSearchOptions = {},
): Promise<string | null> {
  return resolveYouTubeVideoId(value, fallbackQuery, options);
}

export async function resolveYouTubeWatchUrl(
  value: string,
  fallbackQuery = '',
  options: YouTubeSearchOptions = {},
): Promise<string | null> {
  const videoId = await resolveYouTubeVideoId(value, fallbackQuery, options);
  return videoId ? buildYouTubeWatchUrl(videoId, true) : null;
}

export async function resolveYouTubeEmbedUrl(
  value: string,
  fallbackQuery = '',
  options: YouTubeSearchOptions = {},
): Promise<string | null> {
  const videoId = await resolveYouTubeVideoId(value, fallbackQuery, options);
  return videoId ? buildYouTubeEmbedUrl(videoId) : null;
}
