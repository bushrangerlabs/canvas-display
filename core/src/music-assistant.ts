/**
 * Music Assistant server HTTP client.
 *
 * Music Assistant exposes a plain HTTP command API: `POST /api` with a Bearer
 * token and a `{"command": "...", "args": {...}}` body (verified against
 * server 2.8.7). This backs the Music Assistant editor widgets:
 *   • players     — `players/all`, transport via `players/cmd/*`
 *   • radio       — `music/radios/library_items` (includes the SDR DAB+ provider)
 *   • playlists   — `music/playlists/library_items`
 *   • search      — `music/search`
 *   • play media  — `player_queues/play_media` on the player's active queue
 *
 * Authentication is either a long-lived token (`music_assistant_token`) or a
 * username/password login (`POST /auth/login`), which returns a long-lived
 * token that we cache in memory and refresh on 401.
 */

export interface MaConnection {
  /** Base URL, e.g. http://192.168.1.108:8095 (no trailing slash). */
  base: string;
  /** Long-lived access token (optional when username/password are given). */
  token?: string;
  /** Builtin auth username (optional when a token is given). */
  username?: string;
  /** Builtin auth password. */
  password?: string;
}

/** Normalised MA player for the widget layer. */
export interface MaPlayer {
  id: string;
  name: string;
  /** idle | playing | paused | stopped | standby (MA PlaybackState). */
  state: string;
  /** 0–100 */
  volume: number;
  muted: boolean;
  powered: boolean;
  available: boolean;
  title: string;
  artist: string;
  artwork?: string;
  elapsedSeconds: number;
  durationSeconds: number;
}

/** Normalised MA radio station (e.g. a DAB+ station from the SDR provider). */
export interface MaRadio {
  uri: string;
  name: string;
  artwork?: string;
}

/** Normalised MA playlist. */
export interface MaPlaylist {
  uri: string;
  name: string;
  artwork?: string;
  trackCount: number;
}

export class MusicAssistantError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MusicAssistantError';
  }
}

const DEFAULT_TIMEOUT_MS = 12_000;

/** Login token cache keyed by base+username so a settings change re-logins. */
let cachedLogin: { key: string; token: string } | null = null;

/** Drop the cached login token (settings change / tests). */
export function clearMaTokenCache(): void {
  cachedLogin = null;
}

function trimBase(url: string): string {
  return url.replace(/\/+$/, '');
}

async function maFetch(
  base: string,
  path: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const res = await fetch(`${trimBase(base)}${path}`, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401) throw new MusicAssistantError('Music Assistant authentication failed', 401);
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new MusicAssistantError(detail || `Music Assistant returned HTTP ${res.status}`, res.status);
  }
  return res;
}

/**
 * Log in with the builtin auth provider and return a long-lived token.
 * Tokens are cached per base+username; call `clearMaTokenCache()` to force a
 * fresh login.
 */
export async function maLogin(conn: MaConnection): Promise<string> {
  if (!conn.username || !conn.password) {
    throw new MusicAssistantError('Music Assistant username and password are required to log in');
  }
  const key = `${trimBase(conn.base)}|${conn.username}`;
  if (cachedLogin?.key === key) return cachedLogin.token;
  const res = await maFetch(conn.base, '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: 'builtin',
      credentials: { username: conn.username, password: conn.password },
      device_name: 'Canvas Core',
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { token?: string };
  if (!data.token) throw new MusicAssistantError('Music Assistant login returned no token');
  cachedLogin = { key, token: data.token };
  return data.token;
}

async function resolveToken(conn: MaConnection): Promise<string> {
  if (conn.token) return conn.token;
  return maLogin(conn);
}

/**
 * Execute a Music Assistant API command. Uses the configured token, or logs in
 * with username/password. A 401 with credentials available triggers one
 * re-login and retry.
 */
export async function maCommand(
  conn: MaConnection,
  command: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const post = (token: string) =>
    maFetch(conn.base, '/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ command, args }),
    });

  let token = await resolveToken(conn);
  let res: Response;
  try {
    res = await post(token);
  } catch (err) {
    if (err instanceof MusicAssistantError && err.status === 401 && !conn.token && conn.username) {
      clearMaTokenCache();
      token = await maLogin(conn);
      res = await post(token);
    } else {
      throw err;
    }
  }
  const text = await res.text();
  // MA returns plain-text errors for command failures (e.g. "Invalid Command: x").
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new MusicAssistantError(text.slice(0, 300) || `Music Assistant command ${command} failed`);
  }
  if (typeof data === 'string') {
    // Error responses are plain strings ("Authentication required", …).
    throw new MusicAssistantError(data);
  }
  return data;
}

// ─── Normalisation ───────────────────────────────────────────────────────────

function str(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** MA serialises playback as `state`; older payloads use `playback_state`. */
function playerState(raw: Record<string, unknown>): string {
  const state = str(raw.state ?? raw.playback_state ?? 'idle').toLowerCase();
  return state || 'idle';
}

function currentMedia(raw: Record<string, unknown>): Record<string, unknown> {
  const media = raw.current_media ?? raw.currentMedia;
  if (media && typeof media === 'object') return media as Record<string, unknown>;
  return {};
}

function currentItem(raw: Record<string, unknown>): Record<string, unknown> {
  const item = raw.current_item ?? raw.currentItem;
  if (item && typeof item === 'object') return item as Record<string, unknown>;
  return {};
}

function firstArtistName(source: Record<string, unknown>): string {
  const artists = source.artists;
  if (Array.isArray(artists) && artists.length > 0) {
    const first = artists[0];
    if (first && typeof first === 'object') return str((first as Record<string, unknown>).name);
    if (typeof first === 'string') return first;
  }
  return str(source.artist);
}

export function normalizeMaPlayer(raw: Record<string, unknown>): MaPlayer {
  const media = currentMedia(raw);
  const item = currentItem(raw);
  const artwork =
    str(media.image_url ?? media.imageUrl ?? item.image_url ?? item.imageUrl) || undefined;
  return {
    id: str(raw.player_id ?? raw.playerId ?? raw.id),
    name: str(raw.name ?? raw.display_name ?? raw.player_id),
    state: playerState(raw),
    volume: Math.round(Math.min(100, Math.max(0, num(raw.volume_level, 0)))),
    muted: !!(raw.volume_muted ?? raw.muted),
    powered: raw.powered !== false,
    available: raw.available !== false,
    title: str(media.title ?? media.name ?? item.name ?? raw.media_title),
    artist: firstArtistName(media).trim() || firstArtistName(item).trim(),
    artwork,
    elapsedSeconds: Math.max(0, Math.round(num(raw.elapsed_time, 0))),
    durationSeconds: Math.max(0, Math.round(num(media.duration ?? item.duration, 0))),
  };
}

export function normalizeMaRadio(raw: Record<string, unknown>): MaRadio {
  return {
    uri: str(raw.uri),
    name: str(raw.name),
    artwork: str(raw.image_url) || undefined,
  };
}

export function normalizeMaPlaylist(raw: Record<string, unknown>): MaPlaylist {
  return {
    uri: str(raw.uri),
    name: str(raw.name),
    artwork: str(raw.image_url) || undefined,
    trackCount: Math.max(0, Math.round(num(raw.track_count, 0))),
  };
}

// ─── High-level operations ───────────────────────────────────────────────────

/** List all Music Assistant players. */
export async function fetchMaPlayers(conn: MaConnection): Promise<MaPlayer[]> {
  const result = await maCommand(conn, 'players/all');
  const list = Array.isArray(result) ? result : [];
  return list
    .map((raw) => normalizeMaPlayer((raw ?? {}) as Record<string, unknown>))
    .filter((player) => player.id.length > 0);
}

/** Fetch a single player by id (null when not found). */
export async function fetchMaPlayer(conn: MaConnection, playerId: string): Promise<MaPlayer | null> {
  const players = await fetchMaPlayers(conn);
  const needle = playerId.trim().toLowerCase();
  return players.find((player) => player.id.toLowerCase() === needle) ?? null;
}

/** A single item returned by Music Assistant's `music/browse` command. */
export interface MaBrowseItem {
  uri: string;
  name: string;
  /** MA media type: 'radio' | 'playlist' | 'track' | 'album' | 'artist' | 'folder'. */
  mediaType: string;
  provider: string;
  artwork?: string;
}

/**
 * Browse a Music Assistant path (for example `sdrradio://` or the bare root)
 * and return its items. This is how provider radios are reached: only the ones
 * the user added to the library show up in `music/radios/library_items`, while
 * browsing the provider root returns every station it exposes.
 */
export async function browseMa(conn: MaConnection, path = ''): Promise<MaBrowseItem[]> {
  const result = await maCommand(conn, 'music/browse', path ? { path } : {});
  const list = Array.isArray(result) ? result : [];
  return list
    .map((raw) => {
      const item = (raw ?? {}) as Record<string, unknown>;
      return {
        uri: str(item.uri),
        name: str(item.name),
        mediaType: str(item.media_type),
        provider: str(item.provider),
        artwork: str(item.image) || undefined,
      };
    })
    .filter((item) => item.uri.length > 0 && item.name.length > 0);
}

// The merged radio list (library + every provider's radios) is cached briefly so
// polling widgets do not re-browse the whole MA library on every tick.
const RADIO_CACHE_TTL_MS = 15_000;
let radioCache: { key: string; at: number; data: MaRadio[] } | null = null;

/** Drop the cached merged radio list (settings change / tests). */
export function clearMaRadioCache(): void {
  radioCache = null;
}

async function loadAllMaRadios(conn: MaConnection): Promise<MaRadio[]> {
  const [library, roots] = await Promise.all([
    maCommand(conn, 'music/radios/library_items', { limit: 500 }).catch(() => []),
    maCommand(conn, 'music/browse', {}).catch(() => []),
  ]);
  const merged = (Array.isArray(library) ? library : [])
    .map((raw) => normalizeMaRadio((raw ?? {}) as Record<string, unknown>))
    .filter((radio) => radio.uri.length > 0 && radio.name.length > 0);
  // Deduplicate by name so a station that is both in the library and exposed by
  // its provider (the common case for the SDR DAB+ provider) appears once.
  const seen = new Set(merged.map((radio) => radio.name.trim().toLowerCase()));
  const providerRoots = (Array.isArray(roots) ? roots : [])
    .map((raw) => str((raw as Record<string, unknown>)?.uri))
    .filter((uri) => uri.length > 0);
  const providerLists = await Promise.all(providerRoots.map((path) => browseMa(conn, path).catch(() => [])));
  for (const list of providerLists) {
    for (const item of list) {
      if (item.mediaType !== 'radio') continue;
      const key = item.name.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ uri: item.uri, name: item.name, artwork: item.artwork });
    }
  }
  return merged;
}

/**
 * List radio stations, optionally filtered by a search substring.
 *
 * Returns the library radios merged with every provider's radios (browsed from
 * `music/browse`), so provider-only stations such as the DAB+ SDR lineup are
 * visible even before they are added to the Music Assistant library.
 */
export async function fetchMaRadios(conn: MaConnection, search = ''): Promise<MaRadio[]> {
  const key = trimBase(conn.base);
  let all: MaRadio[];
  if (radioCache && radioCache.key === key && Date.now() - radioCache.at < RADIO_CACHE_TTL_MS) {
    all = radioCache.data;
  } else {
    all = await loadAllMaRadios(conn);
    radioCache = { key, at: Date.now(), data: all };
  }
  const needle = search.trim().toLowerCase();
  return needle ? all.filter((radio) => radio.name.toLowerCase().includes(needle)) : all;
}

/** List playlists. */
export async function fetchMaPlaylists(conn: MaConnection): Promise<MaPlaylist[]> {
  const result = await maCommand(conn, 'music/playlists/library_items', { limit: 500 });
  const list = Array.isArray(result) ? result : [];
  return list
    .map((raw) => normalizeMaPlaylist((raw ?? {}) as Record<string, unknown>))
    .filter((playlist) => playlist.uri.length > 0 && playlist.name.length > 0);
}

export interface MaSearchResults {
  tracks: { uri: string; name: string; artist: string; artwork?: string }[];
  albums: { uri: string; name: string; artist: string; artwork?: string }[];
  artists: { uri: string; name: string; artwork?: string }[];
  radios: MaRadio[];
  playlists: MaPlaylist[];
}

/** Search the Music Assistant library. */
export async function maSearch(conn: MaConnection, query: string, limit = 20): Promise<MaSearchResults> {
  const result = (await maCommand(conn, 'music/search', {
    search_query: query,
    limit,
  })) as Record<string, unknown> | null;
  const raw = result ?? {};
  const tracks = (Array.isArray(raw.tracks) ? raw.tracks : []) as Record<string, unknown>[];
  const albums = (Array.isArray(raw.albums) ? raw.albums : []) as Record<string, unknown>[];
  const artists = (Array.isArray(raw.artists) ? raw.artists : []) as Record<string, unknown>[];
  const radios = (Array.isArray(raw.radios) ? raw.radios : [])
    .map((radio) => normalizeMaRadio((radio ?? {}) as Record<string, unknown>))
    .filter((radio) => radio.uri.length > 0);
  // Music Assistant's search only indexes the library, so provider radios such
  // as the DAB+ SDR lineup never appear. Merge in matches from the provider
  // browse so the search widget can find them too.
  const seen = new Set(radios.map((radio) => radio.name.trim().toLowerCase()));
  for (const radio of await fetchMaRadios(conn, query).catch(() => [])) {
    if (radios.length >= limit) break;
    const key = radio.name.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    radios.push(radio);
  }
  return {
    tracks: tracks.map((track) => ({
      uri: str(track.uri),
      name: str(track.name),
      artist: firstArtistName(track),
      artwork: str(track.image_url) || undefined,
    })).filter((track) => track.uri.length > 0),
    albums: albums.map((album) => ({ uri: str(album.uri), name: str(album.name), artist: firstArtistName(album), artwork: str(album.image_url) || undefined })).filter(album => album.uri),
    artists: artists.map((artist) => ({ uri: str(artist.uri), name: str(artist.name), artwork: str(artist.image_url) || undefined })).filter(artist => artist.uri),
    radios,
    playlists: (Array.isArray(raw.playlists) ? raw.playlists : [])
      .map((playlist) => normalizeMaPlaylist((playlist ?? {}) as Record<string, unknown>))
      .filter((playlist) => playlist.uri.length > 0),
  };
}

export interface MaQueueItem { queueItemId: string; uri: string; name: string; artist: string; artwork?: string }

export async function fetchMaQueue(conn: MaConnection, playerId: string): Promise<MaQueueItem[]> {
  const result = await maCommand(conn, 'player_queues/items', { queue_id: playerId, limit: 500 });
  return (Array.isArray(result) ? result : []).map(raw => {
    const item = (raw ?? {}) as Record<string, unknown>;
    const media = (item.media_item ?? item.mediaItem ?? {}) as Record<string, unknown>;
    return { queueItemId: str(item.queue_item_id ?? item.queueItemId ?? item.item_id), uri: str(media.uri ?? item.uri), name: str(media.name ?? item.name), artist: firstArtistName(media), artwork: str(media.image_url ?? item.image_url) || undefined };
  }).filter(item => item.queueItemId || item.uri);
}

export async function maQueueAction(conn: MaConnection, playerId: string, action: 'clear' | 'remove', queueItemId?: string): Promise<void> {
  if (action === 'clear') await maCommand(conn, 'player_queues/clear', { queue_id: playerId });
  else await maCommand(conn, 'player_queues/delete_item', { queue_id: playerId, queue_item_id: queueItemId });
}

/**
 * Play a media URI (track / radio / playlist) on a Music Assistant player.
 * MA resolves the URI on the player's active queue.
 */
export async function maPlayMedia(
  conn: MaConnection,
  playerId: string,
  uri: string,
  option = 'replace',
): Promise<void> {
  await maCommand(conn, 'player_queues/play_media', {
    queue_id: playerId,
    media: uri,
    option,
  });
}

export type MaControlAction =
  | 'play'
  | 'pause'
  | 'play_pause'
  | 'stop'
  | 'next'
  | 'previous'
  | 'volume'
  | 'mute';

/** Send a transport command to a Music Assistant player. */
export async function maControl(
  conn: MaConnection,
  playerId: string,
  action: MaControlAction,
  value?: number | boolean,
): Promise<void> {
  const command = `players/cmd/${action === 'volume' ? 'volume_set' : action === 'mute' ? 'volume_mute' : action}`;
  const args: Record<string, unknown> = { player_id: playerId };
  if (action === 'volume') {
    if (typeof value !== 'number') throw new Error('level is required for volume');
    args.volume_level = Math.round(Math.min(100, Math.max(0, value)));
  } else if (action === 'mute') {
    if (typeof value !== 'boolean') throw new Error('muted is required for mute');
    args.muted = value;
  }
  await maCommand(conn, command, args);
}
