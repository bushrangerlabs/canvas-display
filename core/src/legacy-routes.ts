/**
 * Legacy sidecar API compatibility routes (plan doc §20.5, D-009..D-013).
 *
 * The web UI was originally built against the per-Pi sidecar (`server/src/routes/`),
 * which stored pages/panels/settings in local SQLite. Core is now the single hub,
 * so the web UI must work against Core's Postgres instead of each Pi's SQLite.
 *
 * This module re-implements the legacy REST surface the web UI actually calls:
 *
 *   • Pages + panels CRUD  — `/api/pages`, `/api/pages/:id`, `/api/pages/:id/panels[/:panelId]`
 *   • Page push            — `POST /api/pages/:id/push` (broadcasts `load_page` over `/ws`)
 *   • Settings             — `GET/PUT /api/settings` (global key/value store)
 *   • Audio                — `/api/audio/{state,play,pause,resume,stop,volume,mute}`
 *   • Commands             — `POST /api/commands/{page,navigate,reload,quit,screen_on,screen_off}`
 *   • WebSocket            — `/ws?role=browser&deviceId=...` (real-time command channel)
 *
 * Storage:
 *   • Pages/panels/settings live in Postgres (`pages`, `page_panels`, `settings` tables
 *     created by `db.ts` migrate()). These are global, not per-device — per-device
 *     settings come later via the desired/reported state model.
 *   • Audio state is in-memory default; audio actions are dispatched to the connected
 *     Edge Agent over the device gateway. When no device is connected, the routes
 *     return the default state so the web UI still renders.
 *
 * The WebSocket here is the browser/editor channel — separate from the device
 * gateway (`/gateway/v1`) and the voice session WSS (`/ws/voice`). It mirrors the
 * legacy sidecar's `/ws` so the existing browser hook (`useServerSocket.ts`)
 * connects without changes.
 */
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { makeRequireAdmin } from './auth.js';
import type { CoreConfig } from './config.js';
import {
  clearMediaCaches,
  fetchDabStations,
  fetchDispatcharrChannels,
  resolveDispatcharrChannel,
  stepTargetIndex,
  tuneDabStation,
} from './media-sources.js';
import {
  clearMaTokenCache,
  fetchMaPlayers,
  fetchMaPlayer,
  fetchMaPlaylists,
  fetchMaRadios,
  maControl,
  maPlayMedia,
  maSearch,
  type MaConnection,
  type MaControlAction,
} from './music-assistant.js';

/** The bound `requireAdmin` preHandler factory returned by `registerAuth`. */
export type RequireAdmin = ReturnType<typeof makeRequireAdmin>;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PageRow {
  id: string;
  name: string;
  panels: PanelRow[];
  assigned_device_ids: string[];
  floating_config: unknown | null;
  created_at: string;
  updated_at: string;
}

export interface PanelRow {
  id: string;
  page_id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  view_id: string | null;
  content_type: 'url' | 'scene';
  url: string | null;
  scene_id: string | null;
  z_index: number;
  visible: boolean;
  opacity: number;
  position: number;
}

export type AudioPlayState = 'idle' | 'playing' | 'paused';

export interface AudioState {
  state: AudioPlayState;
  title: string;
  url: string;
  volume: number; // 0–100
  muted: boolean;
  /** Logical source of the current playback (e.g. 'dab', 'dispatcharr'). */
  source?: string;
}

type ClientType = 'browser' | 'editor' | 'api';

interface ConnectedClient {
  ws: WebSocket;
  clientType: ClientType;
  deviceId?: string;
  remoteAddress?: string;
  connectedAt: Date;
}

// ─── Settings defaults ───────────────────────────────────────────────────────

/**
 * Known settings keys + their defaults. Mirrors the legacy sidecar's
 * `SETTING_DEFAULTS` so the web UI's SettingsPage renders the same fields.
 *
 * NOTE: these are global settings (server-wide). Per-device settings (brightness,
 * audio, HA config on a specific Pi) come later via the desired/reported state
 * model — not this table.
 */
const SETTING_DEFAULTS: Record<string, string> = {
  device_name: 'Canvas UI Device',
  server_port: '3100',
  // Canvas Core bridge. In Core these describe Core itself: the LAN URL edge
  // devices should use and the shared edge voice token. Empty values fall back
  // to the Core env config (see coreBridgeEnvDefaults()).
  canvas_core_url: '',
  edge_voice_token: '',
  mqtt_enabled: '0',
  mqtt_broker_url: 'mqtt://localhost:1883',
  mqtt_username: '',
  mqtt_password: '',
  cloud_ai_enabled: '0',
  cloud_ai_provider: '',
  voice_enabled: '0',
  voice_mic_device: 'default',
  voice_wake_word: 'okay_nabu',
  voice_tts_volume: '80',
  voice_wake_ack_enabled: '1',
  voice_wake_ack_sound: 'builtin:ready_up',
  voice_good_intent_enabled: '1',
  voice_good_intent_sound: 'builtin:digital_pop',
  voice_no_intent_enabled: '1',
  voice_no_intent_sound: 'builtin:wood_tap',
  voice_port: '6053',
  voice_friendly_name: 'Canvas Display',
  voice_ha_url: 'http://homeassistant.local:8123',
  voice_ha_token: '',
  voice_pipeline_id: '',
  active_page_id: '',
  playlist_selection_page_id: '',
  request_routing_enabled: '1',
  request_routing_use_ai: '1',
  request_routing_prefer_deterministic: '1',
  request_routing_confidence_threshold: '0.72',
  request_routing_clarify_below_threshold: '1',
  request_routing_use_context: '1',
  request_routing_fallback: 'clarify',
  request_routing_debug_logging: '1',
  request_routing_domain_general_knowledge: '1',
  request_routing_domain_home_automation: '1',
  request_routing_domain_music_audio: '1',
  request_routing_domain_video: '1',
  request_routing_domain_display_navigation: '1',
  request_routing_domain_device_control: '1',
  routine_learning_mode: 'suggest',
  // Media sources (DAB+/SDR radio, Dispatcharr IPTV, Music Assistant). Empty
  // values fall back to the Core env config (see mediaSetting()).
  sdr_radio_url: '',
  sdr_radio_tuner: '',
  sdr_radio_stream_url: '',
  dispatcharr_url: '',
  dispatcharr_api_key: '',
  music_assistant_url: '',
  music_assistant_token: '',
  music_assistant_username: '',
  music_assistant_password: '',
};

const REDACTED_KEYS = new Set([
  'mqtt_password',
  'voice_ha_token',
  'edge_voice_token',
  'dispatcharr_api_key',
  'music_assistant_token',
  'music_assistant_password',
]);
const REDACTED_PLACEHOLDER = '••••••••';

// ─── Audio state (in-memory; dispatch to device gateway) ─────────────────────

const DEFAULT_AUDIO_STATE: AudioState = {
  state: 'idle',
  title: '',
  url: '',
  volume: 75,
  muted: false,
};

let audioState: AudioState = { ...DEFAULT_AUDIO_STATE };

/** Returns a copy of the current audio state. */
export function getAudioState(): AudioState {
  return { ...audioState };
}

/** Replace the audio state wholesale (used by the media-source routes). */
export function setAudioState(next: AudioState): AudioState {
  audioState = { ...next };
  return getAudioState();
}

/** Direct state mutation (used by tests / future device-reported state). */
export function setAudioStateField<K extends keyof AudioState>(key: K, value: AudioState[K]): void {
  audioState[key] = value;
}

/** Reset audio state to defaults (used by tests). */
export function resetAudioState(): void {
  audioState = { ...DEFAULT_AUDIO_STATE };
}

/**
 * Start playback of a resolved stream: update the shared audio state and tell
 * the connected display clients to play it. When `deviceId` is given and the
 * host wired `dispatchMediaToDevice`, the stream is dispatched to that one
 * device instead (device-targeted widget playback). Returns the new state.
 */
function applyAudioPlayback(
  input: { url: string; title: string; source?: string },
  deviceId?: string,
  dispatch?: LegacyRoutesOptions['dispatchMediaToDevice'],
): AudioState {
  audioState = {
    ...audioState,
    state: 'playing',
    url: input.url,
    title: input.title,
    muted: false,
    source: input.source,
  };
  if (deviceId && dispatch) {
    // Fire-and-forget: the HTTP response should not wait on the device round-trip.
    void dispatch(deviceId, input.url, input.title, input.source ?? 'direct_audio').catch((err) => {
      console.warn(`[core][media] dispatch to device ${deviceId} failed:`, err instanceof Error ? err.message : err);
    });
  } else {
    broadcast(
      { type: 'command', action: 'audio_play', payload: { url: input.url, title: input.title, volume: audioState.volume } },
      'browser',
    );
  }
  return getAudioState();
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── WebSocket hub (browser/editor channel) ──────────────────────────────────

const clients = new Map<WebSocket, ConnectedClient>();
const pendingDeviceRequests = new Map<string, {
  deviceId: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}>();
const MAX_PANELS_PER_PAGE = 5;

function send(ws: WebSocket, msg: object): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/** Broadcast to all clients of a given type, or to a specific device id. */
export function broadcast(msg: object, target: ClientType | 'all' | string = 'all'): void {
  for (const client of clients.values()) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    const shouldSend =
      target === 'all' ||
      client.clientType === target ||
      client.deviceId === target;
    if (shouldSend) client.ws.send(JSON.stringify(msg));
  }
}

/** Send a command to a specific device or all browser clients ('*'). */
export function sendCommand(deviceId: string, command: object): void {
  if (deviceId === '*') {
    broadcast(command, 'browser');
    return;
  }
  for (const client of clients.values()) {
    if (client.deviceId === deviceId) {
      send(client.ws, command);
    }
  }
}

/** Execute an allowlisted local Agent IPC action through the connected kiosk controller. */
export function requestDeviceAction(
  deviceId: string,
  action: string,
  payload: Record<string, unknown> = {},
  timeoutMs = 10_000,
): Promise<unknown> {
  const client = [...clients.values()].find(
    item => item.clientType === 'browser' && item.deviceId === deviceId && item.ws.readyState === WebSocket.OPEN,
  );
  if (!client) {
    return Promise.reject(new Error(`device ${deviceId} kiosk is not connected`));
  }

  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingDeviceRequests.delete(requestId);
      reject(new Error(`device ${deviceId} did not complete ${action} within ${timeoutMs}ms`));
    }, timeoutMs);
    pendingDeviceRequests.set(requestId, { deviceId, resolve, reject, timer });
    send(client.ws, {
      type: 'device_request',
      request_id: requestId,
      action,
      payload,
    });
  });
}

/** List currently-connected browser device ids. */
export function getConnectedDeviceIds(): string[] {
  const ids: string[] = [];
  for (const client of clients.values()) {
    if (client.clientType === 'browser' && client.deviceId) ids.push(client.deviceId);
  }
  return ids;
}

/** Get the remote IP address of a connected browser device. */
export function getDeviceIp(deviceId: string): string | undefined {
  for (const client of clients.values()) {
    if (client.clientType === 'browser' && client.deviceId === deviceId) {
      return client.remoteAddress;
    }
  }
  return undefined;
}

// ─── Repository helpers ──────────────────────────────────────────────────────

async function getPageWithPanels(pool: Pool, id: string): Promise<PageRow | null> {
  const pageRes = await pool.query('SELECT * FROM pages WHERE id = $1', [id]);
  const page = pageRes.rows[0];
  if (!page) return null;
  const [panelsRes, assignmentsRes] = await Promise.all([
    pool.query('SELECT * FROM page_panels WHERE page_id = $1 ORDER BY position, id', [id]),
    pool.query(
      'SELECT device_id FROM device_page_library WHERE page_id = $1 ORDER BY device_id',
      [id],
    ),
  ]);
  return {
    id: page.id,
    name: page.name,
    floating_config: page.floating_config ?? null,
    panels: panelsRes.rows.map(rowToPanel),
    assigned_device_ids: assignmentsRes.rows.map((row) => String(row.device_id)),
    created_at: page.created_at,
    updated_at: page.updated_at,
  };
}

function rowToPanel(row: Record<string, unknown>): PanelRow {
  return {
    id: String(row.id),
    page_id: String(row.page_id),
    name: String(row.name ?? ''),
    x: Number(row.x ?? 0),
    y: Number(row.y ?? 0),
    w: Number(row.w ?? 100),
    h: Number(row.h ?? 100),
    view_id: (row.view_id as string | null) ?? null,
    content_type: row.content_type === 'scene' ? 'scene' : 'url',
    url: (row.url as string | null) ?? null,
    scene_id: (row.scene_id as string | null) ?? null,
    z_index: Number(row.z_index ?? row.position ?? 0),
    visible: row.visible !== false,
    opacity: Number(row.opacity ?? 1),
    position: Number(row.position ?? 0),
  };
}

async function listPages(pool: Pool): Promise<PageRow[]> {
  const pagesRes = await pool.query('SELECT * FROM pages ORDER BY name');
  const pages = pagesRes.rows;
  if (pages.length === 0) return [];
  // Fetch all panels in one query and group in JS (avoids N+1).
  const ids = pages.map((p) => p.id);
  const [panelsRes, assignmentsRes] = await Promise.all([
    pool.query(
      'SELECT * FROM page_panels WHERE page_id = ANY($1::text[]) ORDER BY page_id, position, id',
      [ids],
    ),
    pool.query(
      'SELECT page_id, device_id FROM device_page_library ORDER BY page_id, device_id',
    ),
  ]);
  const panelsByPage = new Map<string, PanelRow[]>;
  for (const row of panelsRes.rows) {
    const pid = String(row.page_id);
    if (!panelsByPage.has(pid)) panelsByPage.set(pid, []);
    panelsByPage.get(pid)!.push(rowToPanel(row));
  }
  const assignmentsByPage = new Map<string, string[]>();
  for (const row of assignmentsRes.rows) {
    const pageId = String(row.page_id);
    if (!assignmentsByPage.has(pageId)) assignmentsByPage.set(pageId, []);
    assignmentsByPage.get(pageId)!.push(String(row.device_id));
  }
  return pages.map((p) => ({
    id: p.id,
    name: p.name,
    floating_config: p.floating_config ?? null,
    panels: panelsByPage.get(p.id) ?? [],
    assigned_device_ids: assignmentsByPage.get(p.id) ?? [],
    created_at: p.created_at,
    updated_at: p.updated_at,
  }));
}

async function getAllSettings(pool: Pool, config?: CoreConfig): Promise<Record<string, string>> {
  const res = await pool.query('SELECT key, value FROM settings');
  const stored: Record<string, string> = {};
  for (const row of res.rows) stored[row.key] = row.value;
  const envDefaults = { ...mediaEnvDefaults(config), ...coreBridgeEnvDefaults(config) };
  const merged: Record<string, string> = { ...SETTING_DEFAULTS, ...envDefaults, ...stored };
  // An empty stored value falls back to the env-derived default so the UI shows
  // the effective endpoint rather than a blank field.
  for (const key of Object.keys(envDefaults)) {
    if (!merged[key]) merged[key] = envDefaults[key];
  }
  for (const key of REDACTED_KEYS) {
    if (merged[key]) merged[key] = REDACTED_PLACEHOLDER;
  }
  return merged;
}

/**
 * Env-derived defaults for the media-source settings. These are the fallback when
 * the corresponding DB setting is empty, so a fresh install works with the values
 * already present in the Core container environment.
 */
function mediaEnvDefaults(config?: CoreConfig): Record<string, string> {
  return {
    sdr_radio_url: config?.sdrRadioUrl ?? '',
    sdr_radio_tuner: config?.sdrRadioTuner ?? '',
    sdr_radio_stream_url: config?.sdrRadioStreamUrl ?? '',
    dispatcharr_url: config?.dispatcharrUrl ?? '',
    dispatcharr_api_key: config?.dispatcharrApiKey ?? '',
    music_assistant_url: config?.musicAssistantUrl ?? '',
    music_assistant_token: config?.musicAssistantToken ?? '',
    music_assistant_username: config?.musicAssistantUsername ?? '',
    music_assistant_password: config?.musicAssistantPassword ?? '',
  };
}

/**
 * Env-derived defaults for the Canvas Core bridge settings. Core is the bridge
 * endpoint itself, so the URL defaults to Core's public URL and the token to the
 * env-configured edge voice token (which otherwise auto-provisions in the DB).
 */
function coreBridgeEnvDefaults(config?: CoreConfig): Record<string, string> {
  return {
    canvas_core_url: config?.publicUrl ?? '',
    edge_voice_token: config?.edgeVoiceToken ?? '',
  };
}

/**
 * Read a media-source setting, falling back to the env-derived default.
 *
 * Exported so the voice media tools in `index.ts` resolve the same DB-backed
 * endpoints the widgets and Settings UI use — otherwise a voice command would
 * keep using the env default after the operator changed the URL in the UI.
 */
export async function mediaSetting(pool: Pool, config: CoreConfig | undefined, key: string): Promise<string> {
  const stored = await getSetting(pool, key);
  if (stored && stored.trim()) return stored.trim();
  return mediaEnvDefaults(config)[key] ?? '';
}

/**
 * Apply the widget's `search` (case-insensitive name substring) and `limit`
 * query parameters to a station/channel list. Returns the filtered slice plus
 * the unfiltered total so the UI can show how many items exist. This keeps the
 * Dispatcharr lineup (tens of thousands of channels) from being shipped whole
 * on every poll.
 */
function applyListQuery<T extends { name?: string }>(
  items: T[],
  search?: string,
  limit?: string,
): { items: T[]; total: number } {
  const total = items.length;
  const needle = (search ?? '').trim().toLowerCase();
  let filtered = needle
    ? items.filter((item) => String(item.name ?? '').toLowerCase().includes(needle))
    : items;
  const parsed = Number.parseInt(limit ?? '', 10);
  if (Number.isFinite(parsed) && parsed > 0) filtered = filtered.slice(0, parsed);
  return { items: filtered, total };
}

/**
 * Resolve the Music Assistant connection from settings. Returns null when the
 * URL is not configured, or throws when neither a token nor credentials are
 * available.
 */
async function maConnection(
  pool: Pool,
  config: CoreConfig | undefined,
): Promise<MaConnection | null> {
  const base = await mediaSetting(pool, config, 'music_assistant_url');
  if (!base) return null;
  const token = await mediaSetting(pool, config, 'music_assistant_token');
  const username = await mediaSetting(pool, config, 'music_assistant_username');
  const password = await mediaSetting(pool, config, 'music_assistant_password');
  if (!token && (!username || !password)) {
    throw new Error(
      'Music Assistant needs either an API token or a username and password — set them in Settings → Media.',
    );
  }
  return { base, token: token || undefined, username: username || undefined, password: password || undefined };
}

async function setSetting(pool: Pool, key: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value],
  );
}

async function getSetting(pool: Pool, key: string): Promise<string | null> {
  const res = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  if (res.rowCount === 0) return null;
  return String(res.rows[0].value);
}

// ─── Plugin options ───────────────────────────────────────────────────────────

export interface LegacyRoutesOptions {
  pool: Pool;
  /** Bound `requireAdmin` preHandler from `registerAuth`. Optional: if absent,
   * mutation routes are left open (dev mode). In production wire this through. */
  requireAdmin?: RequireAdmin;
  /** Authenticated Core→Edge page activation. Compatibility tests may omit it. */
  onDisplayPage?: (page: PageRow, deviceId: string) => Promise<unknown>;
  /** Current Core MQTT runtime state and lifecycle controls. */
  getMqttStatus?: () => Record<string, unknown>;
  reconnectMqtt?: () => Promise<Record<string, unknown>>;
  disconnectMqtt?: () => Promise<void>;
  settingsChanged?: (updatedKeys: string[]) => Promise<void>;
  connectedDeviceIds?: () => string[];
  /** Core runtime config — supplies env-derived defaults for media-source settings. */
  config?: CoreConfig;
  /** Architecture-aware direct-audio dispatch to a specific device (Android →
   * gateway media.play, Linux → device_http /api/media/play). Used by the
   * device-targeted widget playback (deviceId in the play request). */
  dispatchMediaToDevice?: (deviceId: string, url: string, title: string, source: string) => Promise<void>;
  /** Dispatch a media control action to a specific device's local server. */
  controlMediaOnDevice?: (deviceId: string, action: string, value?: number | boolean) => Promise<void>;
}

// Convenience wrapper: if requireAdmin is provided, return its preHandler; else
// return a no-op preHandler that allows the request through.
function adminPreHandler(opts: LegacyRoutesOptions, roles: ('admin' | 'viewer' | 'voice')[] = ['admin'], csrf = true) {
  if (!opts.requireAdmin) return undefined;
  return opts.requireAdmin({ roles, csrf });
}

// Body shapes for the legacy routes.
interface PageCreateBody {
  name?: string;
  panels?: Array<{
    name?: string;
    x?: number; y?: number; w?: number; h?: number;
    view_id?: string | null; content_type?: 'url' | 'scene'; url?: string | null;
    scene_id?: string | null; z_index?: number; visible?: boolean; opacity?: number;
    position?: number;
  }>;
}

interface PageUpdateBody {
  name?: string;
  floating_config?: unknown;
}

interface PanelCreateBody {
  name?: string;
  x?: number; y?: number; w?: number; h?: number;
  view_id?: string | null; content_type?: 'url' | 'scene'; url?: string | null;
  scene_id?: string | null; z_index?: number; visible?: boolean; opacity?: number;
  position?: number;
}

interface PanelUpdateBody extends PanelCreateBody {}

interface DevicePageBody {
  device_id?: string;
}

interface CommandPageBody {
  page_id?: string;
  page?: string;
}

interface CommandNavigateBody {
  panel_id?: string;
  panel?: string;
  page_id?: string;
  page?: string;
  url: string;
}

interface CommandPanelBody {
  device_id?: string;
  panel_id?: string;
  panel?: string;
  page_id?: string;
  page?: string;
  content_type?: 'url' | 'scene';
  url?: string;
  scene_id?: string;
  visible?: boolean;
  reload?: boolean;
}

function validatePanel(panel: PanelCreateBody): string | null {
  const x = panel.x ?? 0;
  const y = panel.y ?? 0;
  const w = panel.w ?? 100;
  const h = panel.h ?? 100;
  if (![x, y, w, h].every(Number.isFinite)) return 'Panel geometry must contain finite numbers';
  if (x < 0 || x > 100 || y < 0 || y > 100) return 'Panel x and y must be between 0 and 100';
  if (w <= 0 || w > 100 || h <= 0 || h > 100) return 'Panel w and h must be greater than 0 and at most 100';
  if (x + w > 100 || y + h > 100) return 'Panel geometry must fit within page bounds (x + w <= 100 and y + h <= 100)';
  const contentType = panel.content_type ?? (panel.scene_id ? 'scene' : undefined);
  if (contentType !== undefined && contentType !== 'url' && contentType !== 'scene') return 'Panel content_type must be url or scene';
  if ((contentType === 'url' || panel.url) && (!panel.url || !/^https?:\/\//i.test(panel.url))) {
    return 'URL panels require a URL starting with http:// or https://';
  }
  if (contentType === 'scene' && !panel.scene_id) return 'Scene panels require scene_id';
  if (panel.opacity !== undefined && (!Number.isFinite(panel.opacity) || panel.opacity < 0 || panel.opacity > 1)) {
    return 'Panel opacity must be between 0 and 1';
  }
  return null;
}

async function validatePanelContentReference(pool: Pool, panel: PanelCreateBody): Promise<string | null> {
  if ((panel.content_type === 'scene' || panel.scene_id) && panel.scene_id) {
    const scene = await pool.query('SELECT status FROM scenes WHERE id = $1', [panel.scene_id]);
    if (scene.rowCount === 0) return 'Panel scene does not exist';
    if (scene.rows[0].status !== 'published') return 'Panel scenes must reference a published scene';
  }
  return null;
}

function isDeviceConnected(deviceId: string): boolean {
  return getConnectedDeviceIds().includes(deviceId);
}

// ─── Registration ────────────────────────────────────────────────────────────

export async function registerLegacyRoutes(
  fastify: FastifyInstance,
  options: LegacyRoutesOptions,
): Promise<void> {
  const { pool } = options;
  const deliverPage = async (page: PageRow, deviceId: string): Promise<boolean> => {
    if (options.onDisplayPage) {
      await options.onDisplayPage(page, deviceId);
      return true;
    }
    sendCommand(deviceId, { type: 'load_page', page_id: page.id, page_data: page });
    return isDeviceConnected(deviceId);
  };
  const deliverWithOutcome = async (page: PageRow, deviceId: string, offlineDetail: string) => {
    try {
      const delivered = await deliverPage(page, deviceId);
      return { delivered, detail: delivered ? undefined : offlineDetail };
    } catch (error) {
      return {
        delivered: false,
        detail: isDeviceConnected(deviceId)
          ? (error instanceof Error ? error.message : String(error))
          : offlineDetail,
      };
    }
  };

  // ═══ Pages ═══════════════════════════════════════════════════════════════

  // GET /api/pages — list all pages with their panels
  fastify.get('/api/pages', async () => listPages(pool));

  // GET /api/pages/:id — single page with panels
  fastify.get<{ Params: { id: string } }>('/api/pages/:id', async (req, reply) => {
    const page = await getPageWithPanels(pool, req.params.id);
    if (!page) return reply.code(404).send({ error: 'Page not found' });
    return page;
  });

  // POST /api/pages { name?, panels?[] }
  fastify.post<{ Body: PageCreateBody }>('/api/pages', {
    preHandler: adminPreHandler(options),
  }, async (req, reply) => {
    const body = req.body ?? {};
    const id = randomUUID();
    const name = body.name ?? 'New Page';
    const panels = Array.isArray(body.panels) ? body.panels : [];
    if (panels.length > MAX_PANELS_PER_PAGE) {
      return reply.code(400).send({ error: `A page may contain at most ${MAX_PANELS_PER_PAGE} panels/WebViews` });
    }
    for (const panel of panels) {
      const validationError = validatePanel(panel ?? {});
      if (validationError) return reply.code(400).send({ error: validationError });
      const referenceError = await validatePanelContentReference(pool, panel ?? {});
      if (referenceError) return reply.code(400).send({ error: referenceError });
    }
    await pool.query(
      'INSERT INTO pages (id, name, created_at, updated_at) VALUES ($1, $2, now(), now())',
      [id, name],
    );
    for (let i = 0; i < panels.length; i++) {
      const p = panels[i] ?? {};
      await pool.query(
        `INSERT INTO page_panels
          (id, page_id, name, x, y, w, h, view_id, content_type, url, scene_id,
           position, z_index, visible, opacity, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())`,
        [
          randomUUID(), id,
          p.name ?? `Panel ${i + 1}`,
          p.x ?? 0, p.y ?? 0, p.w ?? 100, p.h ?? 100,
          p.view_id ?? null, p.content_type ?? (p.scene_id ? 'scene' : 'url'),
          p.url ?? null, p.scene_id ?? null, p.position ?? i, p.z_index ?? i,
          p.visible ?? true, p.opacity ?? 1,
        ],
      );
    }
    reply.code(201);
    return getPageWithPanels(pool, id);
  });

  // PATCH /api/pages/:id { name?, floating_config? }
  fastify.patch<{ Params: { id: string }; Body: PageUpdateBody }>('/api/pages/:id', {
    preHandler: adminPreHandler(options),
  }, async (req, reply) => {
    const { id } = req.params;
    const exists = await pool.query('SELECT 1 FROM pages WHERE id = $1', [id]);
    if (exists.rowCount === 0) return reply.code(404).send({ error: 'Page not found' });

    const body = req.body ?? {};
    const fields: string[] = [];
    const vals: unknown[] = [];
    let idx = 1;
    if (typeof body.name === 'string') {
      fields.push(`name = $${idx++}`);
      vals.push(body.name);
    }
    if (body.floating_config !== undefined) {
      fields.push(`floating_config = $${idx++}::jsonb`);
      vals.push(JSON.stringify(body.floating_config));
    }
    if (fields.length) {
      fields.push('updated_at = now()');
      vals.push(id);
      await pool.query(`UPDATE pages SET ${fields.join(', ')} WHERE id = $${idx}`, vals);
    }
    return getPageWithPanels(pool, id);
  });

  // DELETE /api/pages/:id
  fastify.delete<{ Params: { id: string } }>('/api/pages/:id', {
    preHandler: adminPreHandler(options),
  }, async (req, reply) => {
    const exists = await pool.query('SELECT 1 FROM pages WHERE id = $1', [req.params.id]);
    if (exists.rowCount === 0) return reply.code(404).send({ error: 'Page not found' });
    await pool.query('DELETE FROM pages WHERE id = $1', [req.params.id]);
    return { success: true };
  });

  // POST /api/pages/:id/push — broadcast load_page to browser clients + record active page
  fastify.post<{ Params: { id: string } }>('/api/pages/:id/push', {
    preHandler: adminPreHandler(options),
  }, async (req, reply) => {
    const page = await getPageWithPanels(pool, req.params.id);
    if (!page) return reply.code(404).send({ error: 'Page not found' });
    await setSetting(pool, 'active_page_id', page.id);
    broadcast({ type: 'load_page', page_id: page.id, page_data: page }, 'browser');
    return { pushed_to: 1 };
  });

  // PUT /api/pages/:id/assign { device_id }
  fastify.put<{ Params: { id: string }; Body: DevicePageBody }>('/api/pages/:id/assign', {
    preHandler: adminPreHandler(options),
  }, async (req, reply) => {
    const deviceId = req.body?.device_id;
    if (!deviceId) return reply.code(400).send({ error: 'device_id is required' });
    const [page, deviceRes] = await Promise.all([
      getPageWithPanels(pool, req.params.id),
      pool.query('SELECT 1 FROM devices WHERE id = $1', [deviceId]),
    ]);
    if (!page) return reply.code(404).send({ error: 'Page not found' });
    if (deviceRes.rowCount === 0) return reply.code(404).send({ error: 'Device not found' });
    await pool.query(
      `INSERT INTO device_page_library (device_id, page_id, sync_status, assigned_at)
       VALUES ($1, $2, 'pending', now())
       ON CONFLICT (device_id, page_id) DO UPDATE
       SET assigned_at = excluded.assigned_at`,
      [deviceId, page.id],
    );
    const assignmentRes = await pool.query(
      `INSERT INTO device_page_assignments (device_id, page_id, assigned_at)
       VALUES ($1, $2, now())
       ON CONFLICT (device_id) DO UPDATE SET page_id = excluded.page_id, assigned_at = excluded.assigned_at
       RETURNING device_id, page_id, assigned_at`,
      [deviceId, page.id],
    );
    await pool.query(
      `INSERT INTO device_page_state (device_id, active_page_id, default_page_id, history, updated_at)
       VALUES ($1, NULL, $2, '[]'::jsonb, now())
       ON CONFLICT (device_id) DO UPDATE
       SET active_page_id = NULL,
           default_page_id = excluded.default_page_id,
           history = '[]'::jsonb,
           updated_at = now()`,
      [deviceId, page.id],
    );
    // Assignment is the device's durable default. It intentionally replaces any
    // temporary force-display override and records desired state even when Edge
    // is offline, so the page applies after the device reconnects.
    const outcome = await deliverWithOutcome(
      page,
      deviceId,
      'Device is offline — assignment saved and will apply when it reconnects.',
    );
    return {
      ...assignmentRes.rows[0],
      active_page_id: null,
      default_page_id: page.id,
      ...outcome,
    };
  });

  // DELETE /api/pages/:id/assign/:deviceId
  fastify.delete<{ Params: { id: string; deviceId: string } }>('/api/pages/:id/assign/:deviceId', {
    preHandler: adminPreHandler(options),
  }, async (req, reply) => {
    const pageId = req.params.id;
    const deviceId = req.params.deviceId;
    const pageRes = await pool.query('SELECT 1 FROM pages WHERE id = $1', [pageId]);
    if (pageRes.rowCount === 0) return reply.code(404).send({ error: 'Page not found' });
    const assignmentRes = await pool.query(
      'DELETE FROM device_page_assignments WHERE page_id = $1 AND device_id = $2 RETURNING page_id',
      [pageId, deviceId],
    );
    if (assignmentRes.rowCount === 0) return reply.code(404).send({ error: 'Assignment not found' });
    const delRes = await pool.query(
      'DELETE FROM device_page_library WHERE page_id = $1 AND device_id = $2',
      [pageId, deviceId],
    );
    // Reset only pointers that reference the unassigned page. A force-display
    // override for a different page remains active.
    const stateRes = await pool.query(
      'SELECT active_page_id, default_page_id, fallback_page_id, history FROM device_page_state WHERE device_id = $1',
      [deviceId],
    );
    const row = stateRes.rows[0];
    const history = Array.isArray(row?.history)
      ? (row.history as unknown[]).map(String).filter(id => id !== pageId)
      : [];
    const priorActivePageId = row?.active_page_id ? String(row.active_page_id) : null;
    let activePageId = priorActivePageId === pageId ? (history.pop() ?? null) : priorActivePageId;
    const defaultPageId = row?.default_page_id === pageId ? null : (row?.default_page_id ? String(row.default_page_id) : null);
    const fallbackPageId = row?.fallback_page_id === pageId ? null : (row?.fallback_page_id ? String(row.fallback_page_id) : null);

    if (priorActivePageId === pageId && !activePageId) {
      activePageId = fallbackPageId ?? defaultPageId;
      if (!activePageId) {
        const global = await getSetting(pool, 'active_page_id');
        activePageId = global && global !== pageId ? global : null;
      }
    }

    await pool.query(
      `INSERT INTO device_page_state (device_id, active_page_id, default_page_id, fallback_page_id, history, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, now())
       ON CONFLICT (device_id) DO UPDATE SET
         active_page_id = excluded.active_page_id,
         default_page_id = excluded.default_page_id,
         fallback_page_id = excluded.fallback_page_id,
         history = excluded.history,
         updated_at = now()`,
      [deviceId, activePageId, defaultPageId, fallbackPageId, JSON.stringify(history)],
    );

    let outcome: { delivered: boolean; detail?: string } = { delivered: false };
    if (priorActivePageId === pageId && activePageId) {
      const nextPage = await getPageWithPanels(pool, activePageId);
      outcome = nextPage
        ? await deliverWithOutcome(nextPage, deviceId, 'Device is offline — assignment removed and the fallback page will apply when it reconnects.')
        : { delivered: false, detail: 'Assignment removed, but its fallback page no longer exists.' };
    } else if (priorActivePageId === pageId) {
      outcome = { delivered: false, detail: 'Assignment removed. No fallback page is configured for this device.' };
    } else {
      outcome = { delivered: false, detail: 'Assignment removed. The current force-display override was preserved.' };
    }
    return {
      success: true,
      removed_library_rows: delRes.rowCount ?? 0,
      active_page_id: activePageId,
      default_page_id: defaultPageId,
      ...outcome,
    };
  });

  // POST /api/pages/:id/display { device_id }
  fastify.post<{ Params: { id: string }; Body: DevicePageBody }>('/api/pages/:id/display', {
    preHandler: adminPreHandler(options),
  }, async (req, reply) => {
    const deviceId = req.body?.device_id;
    if (!deviceId) return reply.code(400).send({ error: 'device_id is required' });
    const [page, deviceRes, assignmentRes] = await Promise.all([
      getPageWithPanels(pool, req.params.id),
      pool.query('SELECT 1 FROM devices WHERE id = $1', [deviceId]),
      pool.query('SELECT page_id FROM device_page_assignments WHERE device_id = $1', [deviceId]),
    ]);
    if (!page) return reply.code(404).send({ error: 'Page not found' });
    if (deviceRes.rowCount === 0) return reply.code(404).send({ error: 'Device not found' });
    await pool.query(
      `INSERT INTO device_page_library (device_id, page_id, sync_status, assigned_at)
       VALUES ($1, $2, 'pending', now())
       ON CONFLICT (device_id, page_id) DO NOTHING`,
      [deviceId, page.id],
    );
    const priorState = await pool.query(
      'SELECT active_page_id, history FROM device_page_state WHERE device_id = $1',
      [deviceId],
    );
    const priorActive = priorState.rows[0]?.active_page_id as string | null | undefined;
    const history = Array.isArray(priorState.rows[0]?.history)
      ? priorState.rows[0].history.map(String)
      : [];
    if (priorActive && priorActive !== page.id) history.push(priorActive);
    await pool.query(
      `INSERT INTO device_page_state (device_id, active_page_id, history, updated_at)
       VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (device_id) DO UPDATE SET
         history = excluded.history,
         active_page_id = excluded.active_page_id,
         updated_at = now()`,
      [deviceId, page.id, JSON.stringify(history.slice(-50))],
    );
    // Force display is an active override only; it deliberately leaves the
    // persistent assignment untouched. Delivery still records desired state
    // while offline so the override can apply when Edge reconnects.
    const outcome = await deliverWithOutcome(
      page,
      deviceId,
      'Device is offline — display override queued and will apply when it reconnects.',
    );
    return {
      page_id: page.id,
      active_page_id: page.id,
      persistent_page_id: assignmentRes.rows[0]?.page_id ?? null,
      override: true,
      ...outcome,
    };
  });

  // Device page library and navigation. All entry points (UI, HA, MQTT and AI)
  // should ultimately produce these same typed operations.
  fastify.get<{ Params: { deviceId: string } }>('/api/devices/:deviceId/pages', {
    preHandler: adminPreHandler(options, ['admin', 'viewer'], false),
  }, async (req, reply) => {
    const device = await pool.query('SELECT 1 FROM devices WHERE id = $1', [req.params.deviceId]);
    if (device.rowCount === 0) return reply.code(404).send({ error: 'Device not found' });
    const [library, state] = await Promise.all([
      pool.query(
        `SELECT l.page_id, p.name, l.sync_status, l.cached_revision, l.bytes,
                l.last_error, l.assigned_at, l.synced_at
         FROM device_page_library l JOIN pages p ON p.id = l.page_id
         WHERE l.device_id = $1 ORDER BY p.name`,
        [req.params.deviceId],
      ),
      pool.query('SELECT * FROM device_page_state WHERE device_id = $1', [req.params.deviceId]),
    ]);
    return {
      device_id: req.params.deviceId,
      pages: library.rows,
      active_page_id: state.rows[0]?.active_page_id ?? null,
      default_page_id: state.rows[0]?.default_page_id ?? null,
      fallback_page_id: state.rows[0]?.fallback_page_id ?? null,
      history: state.rows[0]?.history ?? [],
    };
  });

  fastify.post<{ Params: { deviceId: string } }>('/api/devices/:deviceId/page/back', {
    preHandler: adminPreHandler(options),
  }, async (req, reply) => {
    const stateRes = await pool.query('SELECT * FROM device_page_state WHERE device_id = $1', [req.params.deviceId]);
    const state = stateRes.rows[0];
    const history = Array.isArray(state?.history) ? state.history.map(String) : [];
    const pageId = history.pop();
    if (!pageId) return reply.code(409).send({ error: 'Page history is empty' });
    const page = await getPageWithPanels(pool, pageId);
    if (!page) return reply.code(409).send({ error: 'Previous page no longer exists' });
    await pool.query(
      'UPDATE device_page_state SET active_page_id = $2, history = $3::jsonb, updated_at = now() WHERE device_id = $1',
      [req.params.deviceId, pageId, JSON.stringify(history)],
    );
    try {
      const delivered = await deliverPage(page, req.params.deviceId);
      return { delivered, page_id: pageId };
    } catch (error) {
      return reply.code(409).send({
        delivered: false,
        error: 'page_delivery_failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  fastify.post<{ Params: { deviceId: string } }>('/api/devices/:deviceId/page/reload', {
    preHandler: adminPreHandler(options),
  }, async (req, reply) => {
    const state = await pool.query('SELECT active_page_id FROM device_page_state WHERE device_id = $1', [req.params.deviceId]);
    const pageId = state.rows[0]?.active_page_id;
    if (!pageId) return reply.code(409).send({ error: 'Device has no active page' });
    const page = await getPageWithPanels(pool, String(pageId));
    if (!page) return reply.code(409).send({ error: 'Active page no longer exists' });
    try {
      const delivered = await deliverPage(page, req.params.deviceId);
      return { delivered, page_id: page.id };
    } catch (error) {
      return reply.code(409).send({
        delivered: false,
        error: 'page_delivery_failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  fastify.patch<{
    Params: { deviceId: string; panelId: string };
    Body: { content_type?: 'url' | 'scene'; url?: string; scene_id?: string; visible?: boolean };
  }>('/api/devices/:deviceId/panels/:panelId', {
    preHandler: adminPreHandler(options),
  }, async (req, reply) => {
    const panel = await pool.query('SELECT * FROM page_panels WHERE id = $1', [req.params.panelId]);
    if (panel.rowCount === 0) return reply.code(404).send({ error: 'Panel not found' });
    const body = req.body ?? {};
    const contentType = body.content_type;
    if (contentType === 'url' && (!body.url || !/^https?:\/\//i.test(body.url))) {
      return reply.code(400).send({ error: 'URL content requires an http:// or https:// URL' });
    }
    if (contentType === 'scene' && !body.scene_id) {
      return reply.code(400).send({ error: 'Scene content requires scene_id' });
    }
    if (body.scene_id) {
      const scene = await pool.query('SELECT 1 FROM scenes WHERE id = $1', [body.scene_id]);
      if (scene.rowCount === 0) return reply.code(404).send({ error: 'Scene not found' });
    }
    const content = contentType
      ? { type: contentType, ...(contentType === 'url' ? { url: body.url } : { scene_id: body.scene_id }) }
      : null;
    await pool.query(
      `INSERT INTO device_panel_state (device_id, panel_id, content, visible, updated_at)
       VALUES ($1, $2, $3::jsonb, COALESCE($4, true), now())
       ON CONFLICT (device_id, panel_id) DO UPDATE SET
         content = COALESCE(excluded.content, device_panel_state.content),
         visible = COALESCE($4, device_panel_state.visible),
         updated_at = now()`,
      [req.params.deviceId, req.params.panelId, content ? JSON.stringify(content) : null, body.visible ?? null],
    );
    const active = await pool.query(
      'SELECT active_page_id FROM device_page_state WHERE device_id = $1',
      [req.params.deviceId],
    );
    const activePageId = active.rows[0]?.active_page_id as string | undefined;
    let delivered = false;
    if (activePageId) {
      const activePage = await getPageWithPanels(pool, activePageId);
      if (activePage) {
        try {
          delivered = await deliverPage(activePage, req.params.deviceId);
        } catch (error) {
          return reply.code(409).send({
            delivered: false,
            error: 'panel_delivery_failed',
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return { delivered, panel_id: req.params.panelId, content, visible: body.visible };
  });

  fastify.post<{ Params: { deviceId: string; panelId: string } }>(
    '/api/devices/:deviceId/panels/:panelId/reload',
    { preHandler: adminPreHandler(options) },
    async (req, reply) => {
      const active = await pool.query(
        'SELECT active_page_id FROM device_page_state WHERE device_id = $1',
        [req.params.deviceId],
      );
      const page = active.rows[0]?.active_page_id
        ? await getPageWithPanels(pool, String(active.rows[0].active_page_id))
        : null;
      if (!page) return reply.code(409).send({ error: 'Device has no active page' });
      try {
        return {
          delivered: await deliverPage(page, req.params.deviceId),
          panel_id: req.params.panelId,
        };
      } catch (error) {
        return reply.code(409).send({
          delivered: false,
          error: 'panel_delivery_failed',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  // ═══ Panel sub-routes ════════════════════════════════════════════════════

  // POST /api/pages/:id/panels
  fastify.post<{ Params: { id: string }; Body: PanelCreateBody }>('/api/pages/:id/panels', {
    preHandler: adminPreHandler(options),
  }, async (req, reply) => {
    const { id } = req.params;
    const exists = await pool.query('SELECT 1 FROM pages WHERE id = $1', [id]);
    if (exists.rowCount === 0) return reply.code(404).send({ error: 'Page not found' });

    const b = req.body ?? {};
    const validationError = validatePanel(b);
    if (validationError) return reply.code(400).send({ error: validationError });
    const referenceError = await validatePanelContentReference(pool, b);
    if (referenceError) return reply.code(400).send({ error: referenceError });
    const statsRes = await pool.query(
      'SELECT COUNT(*)::int AS count, COALESCE(MAX(position), -1) AS m FROM page_panels WHERE page_id = $1',
      [id],
    );
    if (Number(statsRes.rows[0].count) >= MAX_PANELS_PER_PAGE) {
      return reply.code(400).send({ error: `A page may contain at most ${MAX_PANELS_PER_PAGE} panels/WebViews` });
    }
    const nextPos = Number(statsRes.rows[0].m) + 1;
    const panelId = randomUUID();
    await pool.query(
      `INSERT INTO page_panels
        (id, page_id, name, x, y, w, h, view_id, content_type, url, scene_id,
         position, z_index, visible, opacity, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())`,
      [
        panelId, id,
        b.name ?? 'New Panel',
        b.x ?? 0, b.y ?? 0, b.w ?? 100, b.h ?? 100,
        b.view_id ?? null, b.content_type ?? (b.scene_id ? 'scene' : 'url'),
        b.url ?? null, b.scene_id ?? null, b.position ?? nextPos, b.z_index ?? nextPos,
        b.visible ?? true, b.opacity ?? 1,
      ],
    );
    await pool.query('UPDATE pages SET updated_at = now() WHERE id = $1', [id]);
    reply.code(201);
    const res = await pool.query('SELECT * FROM page_panels WHERE id = $1', [panelId]);
    return rowToPanel(res.rows[0]);
  });

  // PATCH /api/pages/:id/panels/:panelId
  fastify.patch<{ Params: { id: string; panelId: string }; Body: PanelUpdateBody }>(
    '/api/pages/:id/panels/:panelId',
    { preHandler: adminPreHandler(options) },
    async (req, reply) => {
      const { id, panelId } = req.params;
      const exists = await pool.query(
        'SELECT 1 FROM page_panels WHERE id = $1 AND page_id = $2',
        [panelId, id],
      );
      if (exists.rowCount === 0) return reply.code(404).send({ error: 'Panel not found' });

      const b = req.body ?? {};
      const currentRes = await pool.query('SELECT * FROM page_panels WHERE id = $1', [panelId]);
      const current = rowToPanel(currentRes.rows[0]);
      const validationError = validatePanel({ ...current, ...b });
      if (validationError) return reply.code(400).send({ error: validationError });
      const referenceError = await validatePanelContentReference(pool, { ...current, ...b });
      if (referenceError) return reply.code(400).send({ error: referenceError });
      const fields: string[] = [];
      const vals: unknown[] = [];
      let idx = 1;
      const fieldKeys = [
        'name', 'x', 'y', 'w', 'h', 'view_id', 'content_type', 'url', 'scene_id',
        'position', 'z_index', 'visible', 'opacity',
      ] as const;
      for (const f of fieldKeys) {
        if (b[f] !== undefined) {
          fields.push(`${f} = $${idx++}`);
          vals.push(b[f]);
        }
      }
      if (fields.length) {
        vals.push(panelId);
        await pool.query(`UPDATE page_panels SET ${fields.join(', ')} WHERE id = $${idx}`, vals);
        await pool.query('UPDATE pages SET updated_at = now() WHERE id = $1', [id]);
      }
      const res = await pool.query('SELECT * FROM page_panels WHERE id = $1', [panelId]);
      return rowToPanel(res.rows[0]);
    },
  );

  // DELETE /api/pages/:id/panels/:panelId
  fastify.delete<{ Params: { id: string; panelId: string } }>(
    '/api/pages/:id/panels/:panelId',
    { preHandler: adminPreHandler(options) },
    async (req, reply) => {
      const { id, panelId } = req.params;
      const exists = await pool.query(
        'SELECT 1 FROM page_panels WHERE id = $1 AND page_id = $2',
        [panelId, id],
      );
      if (exists.rowCount === 0) return reply.code(404).send({ error: 'Panel not found' });
      await pool.query('DELETE FROM page_panels WHERE id = $1', [panelId]);
      await pool.query('UPDATE pages SET updated_at = now() WHERE id = $1', [id]);
      return { success: true };
    },
  );

  // ═══ Settings ════════════════════════════════════════════════════════════

  // GET /api/settings — all settings (passwords redacted)
  fastify.get('/api/settings', async () => getAllSettings(pool, options.config));

  // PUT /api/settings — bulk update { key: value, ... }
  fastify.put<{ Body: Record<string, string> }>('/api/settings', {
    preHandler: adminPreHandler(options, ['admin'], true),
  }, async (req) => {
    const body = req.body ?? {};
    const allowed = new Set(Object.keys(SETTING_DEFAULTS));
    const updated: string[] = [];
    for (const [key, value] of Object.entries(body)) {
      if (!allowed.has(key)) continue;
      // Don't overwrite password if sent as redacted placeholder
      if (REDACTED_KEYS.has(key) && value === REDACTED_PLACEHOLDER) continue;
      await setSetting(pool, key, String(value));
      updated.push(key);
    }
    if (updated.length && options.settingsChanged) await options.settingsChanged(updated);
    return { updated };
  });

  fastify.get('/api/settings/mqtt', async () =>
    options.getMqttStatus?.() ?? { enabled: false, url: '', connected: false });

  fastify.post('/api/settings/mqtt/reconnect', {
    preHandler: adminPreHandler(options),
  }, async () => {
    const status = await options.reconnectMqtt?.();
    return { ok: true, ...(status ?? { connected: false }) };
  });

  fastify.post('/api/settings/mqtt/disconnect', {
    preHandler: adminPreHandler(options),
  }, async () => {
    await options.disconnectMqtt?.();
    return { ok: true };
  });

  // GET /api/settings/voice — voice satellite status (legacy: Core runs the voice
  // pipeline itself; report disabled here so the SettingsPage doesn't try to
  // restart a non-existent local voice server).
  fastify.get('/api/settings/voice', async () => ({
    status: 'disabled' as const,
    micDevice: 'default',
    port: 0,
  }));

  // POST /api/settings/voice/restart — no-op in Core
  fastify.post('/api/settings/voice/restart', async (_req, reply) => {
    reply.code(202);
    return { ok: true, status: 'disabled' };
  });

  // GET /api/settings/voice/microphones — empty list (Core doesn't probe ALSA)
  fastify.get('/api/settings/voice/microphones', async () => []);

  // GET /api/settings/core-bridge — Canvas Core bridge status. Core is the bridge
  // endpoint itself, so this reports the LAN URL edge devices should use and
  // whether the shared edge voice token is provisioned (env or auto-provisioned).
  fastify.get('/api/settings/core-bridge', async () => {
    const dbUrl = (await getSetting(pool, 'canvas_core_url')) ?? '';
    const dbToken = (await getSetting(pool, 'edge_voice_token')) ?? '';
    const envUrl = options.config?.publicUrl ?? '';
    const envToken = options.config?.edgeVoiceToken ?? '';
    const url = dbUrl || envUrl;
    const token = dbToken || envToken;
    const source = dbUrl || dbToken ? 'db' : (envUrl || envToken ? 'env' : 'none');
    return { url, tokenSet: Boolean(token), source };
  });

  // POST /api/settings/core-bridge/test — verify Core's own health endpoint.
  //
  // Core IS the bridge, so we probe the local listener rather than looping out
  // through the public TLS proxy (whose self-signed CA the container doesn't
  // trust). This confirms the Core process is healthy and serving the API.
  fastify.post('/api/settings/core-bridge/test', async (_req, reply) => {
    const dbUrl = (await getSetting(pool, 'canvas_core_url')) ?? '';
    const url = dbUrl || options.config?.publicUrl || '';
    const local = `http://127.0.0.1:${options.config?.port ?? 3100}/health`;
    try {
      const res = await fetch(local, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) { reply.code(502); return { ok: false, error: `Core returned ${res.status}` }; }
      const body = await res.json() as Record<string, unknown>;
      return { ok: true, url, status: body };
    } catch (err) {
      reply.code(502);
      return { ok: false, error: (err as Error).message };
    }
  });

  // ═══ Audio ═══════════════════════════════════════════════════════════════

  // GET /api/audio/state
  fastify.get('/api/audio/state', async () => getAudioState());

  // POST /api/audio/play { url, title?, volume? }
  fastify.post<{ Body: { url?: string; title?: string; volume?: number } }>(
    '/api/audio/play',
    { preHandler: adminPreHandler(options, ['admin', 'viewer'], false) },
    async (req, reply) => {
      const { url, title, volume } = req.body ?? {};
      if (!url) return reply.code(400).send({ error: 'url is required' });
      const vol = volume !== undefined ? clampVolume(volume) : audioState.volume;
      audioState = {
        state: 'playing',
        url,
        title: title ?? url,
        volume: vol,
        muted: false,
      };
      // Dispatch to connected browser/renderer clients (best-effort).
      broadcast({ type: 'command', action: 'audio_play', payload: { url, title: audioState.title, volume: vol } }, 'browser');
      return getAudioState();
    },
  );

  // POST /api/audio/pause
  fastify.post('/api/audio/pause', {
    preHandler: adminPreHandler(options, ['admin', 'viewer'], false),
  }, async (_req, reply) => {
    if (audioState.state !== 'playing') return reply.code(409).send({ error: 'Not playing' });
    audioState.state = 'paused';
    broadcast({ type: 'command', action: 'audio_pause', payload: {} }, 'browser');
    return getAudioState();
  });

  // POST /api/audio/resume
  fastify.post('/api/audio/resume', {
    preHandler: adminPreHandler(options, ['admin', 'viewer'], false),
  }, async (_req, reply) => {
    if (audioState.state !== 'paused') return reply.code(409).send({ error: 'Not paused' });
    audioState.state = 'playing';
    broadcast({ type: 'command', action: 'audio_resume', payload: {} }, 'browser');
    return getAudioState();
  });

  // POST /api/audio/stop
  fastify.post('/api/audio/stop', {
    preHandler: adminPreHandler(options, ['admin', 'viewer'], false),
  }, async () => {
    audioState = { ...audioState, state: 'idle', url: '', title: '' };
    broadcast({ type: 'command', action: 'audio_stop', payload: {} }, 'browser');
    return getAudioState();
  });

  // POST /api/audio/volume { level: 0–100 }
  fastify.post<{ Body: { level?: number } }>('/api/audio/volume', {
    preHandler: adminPreHandler(options, ['admin', 'viewer'], false),
  }, async (req, reply) => {
    const level = req.body?.level;
    if (level === undefined || level === null) return reply.code(400).send({ error: 'level is required' });
    const clamped = clampVolume(Number(level));
    audioState.volume = clamped;
    audioState.muted = false;
    broadcast({ type: 'command', action: 'audio_volume', payload: { level: clamped } }, 'browser');
    return getAudioState();
  });

  // POST /api/audio/mute { muted: boolean }
  fastify.post<{ Body: { muted?: boolean } }>('/api/audio/mute', {
    preHandler: adminPreHandler(options, ['admin', 'viewer'], false),
  }, async (req, reply) => {
    const muted = req.body?.muted;
    if (muted === undefined) return reply.code(400).send({ error: 'muted is required' });
    audioState.muted = !!muted;
    broadcast({ type: 'command', action: 'audio_mute', payload: { muted: audioState.muted } }, 'browser');
    return getAudioState();
  });

  // ═══ Media sources (DAB+ / Dispatcharr) ══════════════════════════════════
  //
  // Backs the DAB+ and Dispatcharr editor widgets. Playback updates the shared
  // audio state (above) and is dispatched to connected display clients, matching
  // the /api/audio/* routes.

  const stepMedia = async (source: string, direction: 1 | -1, deviceId?: string): Promise<AudioState> => {
    if (source === 'dab') {
      const base = await mediaSetting(pool, options.config, 'sdr_radio_url');
      if (!base) throw new Error('DAB+ radio is not configured');
      const tuner = (await mediaSetting(pool, options.config, 'sdr_radio_tuner')) || 'tuner1';
      const streamUrl = await mediaSetting(pool, options.config, 'sdr_radio_stream_url');
      const stations = (await fetchDabStations(base))
        .map((station) => ({ name: String(station.name ?? station.id ?? '').trim() }))
        .filter((item) => item.name.length > 0);
      const target = stepTargetIndex(stations, audioState.title, direction);
      const title = await tuneDabStation(base, tuner, stations[target].name);
      return applyAudioPlayback({ url: streamUrl, title, source: 'dab' }, deviceId, options.dispatchMediaToDevice);
    }
    if (source === 'dispatcharr') {
      const base = await mediaSetting(pool, options.config, 'dispatcharr_url');
      if (!base) throw new Error('Dispatcharr is not configured');
      const apiKey = await mediaSetting(pool, options.config, 'dispatcharr_api_key');
      const channels = (await fetchDispatcharrChannels(base, apiKey || undefined))
        .map((channel) => ({ name: String(channel.name ?? '').trim(), url: channel.url }))
        .filter((item) => item.name.length > 0);
      const target = stepTargetIndex(channels, audioState.title, direction);
      const resolved = resolveDispatcharrChannel(channels, channels[target].name, channels[target].url);
      return applyAudioPlayback(
        { url: resolved.url, title: resolved.name, source: 'dispatcharr' },
        deviceId,
        options.dispatchMediaToDevice,
      );
    }
    throw new Error('Unknown media source');
  };

  // GET /api/dab/stations?search=&limit= — the SDR lineup can be large, so the
  // widget's filter and visible-item cap are applied server-side to keep the
  // polled payload small.
  fastify.get<{ Querystring: { search?: string; limit?: string } }>('/api/dab/stations', async (req, reply) => {
    const base = await mediaSetting(pool, options.config, 'sdr_radio_url');
    if (!base) {
      return reply.code(503).send({ error: 'DAB+ radio is not configured — set the SDR radio URL in Settings → Media.' });
    }
    try {
      const { items, total } = applyListQuery(await fetchDabStations(base), req.query?.search, req.query?.limit);
      return { stations: items, total };
    } catch (err) {
      return reply.code(502).send({ error: `SDR radio unavailable: ${errorText(err)}` });
    }
  });

  // POST /api/dab/play { station, deviceId? } — deviceId targets one display
  fastify.post<{ Body: { station?: string; deviceId?: string } }>('/api/dab/play', {
    preHandler: adminPreHandler(options, ['admin', 'viewer'], false),
  }, async (req, reply) => {
    const station = (req.body?.station ?? '').trim();
    if (!station) return reply.code(400).send({ error: 'station is required' });
    const deviceId = (req.body?.deviceId ?? '').trim();
    const base = await mediaSetting(pool, options.config, 'sdr_radio_url');
    if (!base) return reply.code(503).send({ error: 'DAB+ radio is not configured' });
    const tuner = (await mediaSetting(pool, options.config, 'sdr_radio_tuner')) || 'tuner1';
    const streamUrl = await mediaSetting(pool, options.config, 'sdr_radio_stream_url');
    try {
      const title = await tuneDabStation(base, tuner, station);
      const state = applyAudioPlayback({ url: streamUrl, title, source: 'dab' }, deviceId, options.dispatchMediaToDevice);
      return { success: true, station: title, url: streamUrl, state, ...(deviceId ? { deviceId } : {}) };
    } catch (err) {
      return reply.code(502).send({ error: `DAB+ tune failed: ${errorText(err)}` });
    }
  });

  // GET /api/dispatcharr/channels?search=&limit= — the lineup can hold tens of
  // thousands of channels (megabytes of JSON), so the widget's filter and
  // visible-item cap are applied server-side.
  fastify.get<{ Querystring: { search?: string; limit?: string } }>('/api/dispatcharr/channels', async (req, reply) => {
    const base = await mediaSetting(pool, options.config, 'dispatcharr_url');
    if (!base) {
      return reply.code(503).send({ error: 'Dispatcharr is not configured — set the URL in Settings → Media.' });
    }
    const apiKey = await mediaSetting(pool, options.config, 'dispatcharr_api_key');
    try {
      const { items, total } = applyListQuery(
        await fetchDispatcharrChannels(base, apiKey || undefined),
        req.query?.search,
        req.query?.limit,
      );
      return { channels: items, total };
    } catch (err) {
      return reply.code(502).send({ error: `Dispatcharr unavailable: ${errorText(err)}` });
    }
  });

  // POST /api/dispatcharr/play { channel, url?, deviceId? } — deviceId targets one display
  fastify.post<{ Body: { channel?: string; url?: string; deviceId?: string } }>('/api/dispatcharr/play', {
    preHandler: adminPreHandler(options, ['admin', 'viewer'], false),
  }, async (req, reply) => {
    const name = (req.body?.channel ?? '').trim();
    const url = (req.body?.url ?? '').trim();
    const deviceId = (req.body?.deviceId ?? '').trim();
    if (!name && !url) return reply.code(400).send({ error: 'channel or url is required' });
    try {
      let resolved = { name, url };
      if (!url) {
        const base = await mediaSetting(pool, options.config, 'dispatcharr_url');
        if (!base) return reply.code(503).send({ error: 'Dispatcharr is not configured' });
        const apiKey = await mediaSetting(pool, options.config, 'dispatcharr_api_key');
        const channels = await fetchDispatcharrChannels(base, apiKey || undefined);
        resolved = resolveDispatcharrChannel(channels, name, url);
      }
      const state = applyAudioPlayback(
        { url: resolved.url, title: resolved.name || resolved.url, source: 'dispatcharr' },
        deviceId,
        options.dispatchMediaToDevice,
      );
      return { success: true, channel: resolved.name, url: resolved.url, state, ...(deviceId ? { deviceId } : {}) };
    } catch (err) {
      return reply.code(502).send({ error: `Dispatcharr play failed: ${errorText(err)}` });
    }
  });

  // GET /api/media/state — device-wide audio state (widget polling)
  fastify.get('/api/media/state', async () => ({ audio: getAudioState() }));

  // POST /api/media/control { action, source?, deviceId?, level?, muted? }
  fastify.post<{ Body: { action?: string; source?: string; deviceId?: string; level?: number; muted?: boolean } }>(
    '/api/media/control',
    { preHandler: adminPreHandler(options, ['admin', 'viewer'], false) },
    async (req, reply) => {
      const action = (req.body?.action ?? '').trim();
      const source = (req.body?.source ?? audioState.source ?? '').trim();
      const deviceId = (req.body?.deviceId ?? '').trim();
      // Transport commands on a specific device go to that device's local server
      // (the same one the voice path uses), so only that display reacts.
      const deviceControl = deviceId && options.controlMediaOnDevice ? options.controlMediaOnDevice : undefined;
      try {
        switch (action) {
          case 'pause': {
            if (audioState.state !== 'playing') return reply.code(409).send({ error: 'Not playing' });
            audioState.state = 'paused';
            if (deviceControl) {
              void deviceControl(deviceId, 'pause').catch((err) => console.warn('[core][media] device pause failed:', err instanceof Error ? err.message : err));
            } else {
              broadcast({ type: 'command', action: 'audio_pause', payload: {} }, 'browser');
            }
            return getAudioState();
          }
          case 'resume': {
            if (audioState.state !== 'paused') return reply.code(409).send({ error: 'Not paused' });
            audioState.state = 'playing';
            if (deviceControl) {
              void deviceControl(deviceId, 'resume').catch((err) => console.warn('[core][media] device resume failed:', err instanceof Error ? err.message : err));
            } else {
              broadcast({ type: 'command', action: 'audio_resume', payload: {} }, 'browser');
            }
            return getAudioState();
          }
          case 'stop': {
            audioState = { ...audioState, state: 'idle', url: '', title: '', source: undefined };
            if (deviceControl) {
              void deviceControl(deviceId, 'stop').catch((err) => console.warn('[core][media] device stop failed:', err instanceof Error ? err.message : err));
            } else {
              broadcast({ type: 'command', action: 'audio_stop', payload: {} }, 'browser');
            }
            return getAudioState();
          }
          case 'volume': {
            const level = req.body?.level;
            if (level === undefined || level === null) return reply.code(400).send({ error: 'level is required' });
            const clamped = clampVolume(Number(level));
            audioState.volume = clamped;
            audioState.muted = false;
            if (deviceControl) {
              void deviceControl(deviceId, 'volume', clamped).catch((err) => console.warn('[core][media] device volume failed:', err instanceof Error ? err.message : err));
            } else {
              broadcast({ type: 'command', action: 'audio_volume', payload: { level: clamped } }, 'browser');
            }
            return getAudioState();
          }
          case 'mute': {
            const muted = req.body?.muted;
            if (muted === undefined) return reply.code(400).send({ error: 'muted is required' });
            audioState.muted = !!muted;
            if (deviceControl) {
              void deviceControl(deviceId, 'mute', !!muted).catch((err) => console.warn('[core][media] device mute failed:', err instanceof Error ? err.message : err));
            } else {
              broadcast({ type: 'command', action: 'audio_mute', payload: { muted: audioState.muted } }, 'browser');
            }
            return getAudioState();
          }
          case 'next':
          case 'previous':
            return await stepMedia(source, action === 'next' ? 1 : -1, deviceId || undefined);
          default:
            return reply.code(400).send({ error: 'action must be one of pause, resume, stop, volume, mute, next, previous' });
        }
      } catch (err) {
        return reply.code(502).send({ error: errorText(err) });
      }
    },
  );

  // ═══ Music Assistant ═══════════════════════════════════════════════════════
  //
  // Backs the Music Assistant widget family. MA exposes a plain HTTP command
  // API (POST /api with a Bearer token), so Core talks to it directly — no HA
  // dependency. Widgets target MA's own players, turning a Canvas display into
  // a wall-panel remote for the whole-home music system.

  // GET /api/ma/players — list Music Assistant players
  fastify.get('/api/ma/players', async (_req, reply) => {
    let conn: MaConnection | null;
    try {
      conn = await maConnection(pool, options.config);
    } catch (err) {
      return reply.code(503).send({ error: errorText(err) });
    }
    if (!conn) {
      return reply.code(503).send({ error: 'Music Assistant is not configured — set the server URL in Settings → Integrations.' });
    }
    try {
      return { players: await fetchMaPlayers(conn) };
    } catch (err) {
      return reply.code(502).send({ error: `Music Assistant unavailable: ${errorText(err)}` });
    }
  });

  // GET /api/ma/state?playerId= — a single player's state (widget polling)
  fastify.get<{ Querystring: { playerId?: string } }>('/api/ma/state', async (req, reply) => {
    const playerId = (req.query?.playerId ?? '').trim();
    if (!playerId) return reply.code(400).send({ error: 'playerId is required' });
    let conn: MaConnection | null;
    try {
      conn = await maConnection(pool, options.config);
    } catch (err) {
      return reply.code(503).send({ error: errorText(err) });
    }
    if (!conn) return reply.code(503).send({ error: 'Music Assistant is not configured' });
    try {
      const player = await fetchMaPlayer(conn, playerId);
      if (!player) return reply.code(404).send({ error: `Player "${playerId}" not found` });
      return { player };
    } catch (err) {
      return reply.code(502).send({ error: `Music Assistant unavailable: ${errorText(err)}` });
    }
  });

  // GET /api/ma/radios?search= — radio stations (includes the DAB+ SDR provider)
  fastify.get<{ Querystring: { search?: string } }>('/api/ma/radios', async (req, reply) => {
    let conn: MaConnection | null;
    try {
      conn = await maConnection(pool, options.config);
    } catch (err) {
      return reply.code(503).send({ error: errorText(err) });
    }
    if (!conn) {
      return reply.code(503).send({ error: 'Music Assistant is not configured — set the server URL in Settings → Integrations.' });
    }
    try {
      return { radios: await fetchMaRadios(conn, req.query?.search ?? '') };
    } catch (err) {
      return reply.code(502).send({ error: `Music Assistant unavailable: ${errorText(err)}` });
    }
  });

  // GET /api/ma/playlists — playlists
  fastify.get('/api/ma/playlists', async (_req, reply) => {
    let conn: MaConnection | null;
    try {
      conn = await maConnection(pool, options.config);
    } catch (err) {
      return reply.code(503).send({ error: errorText(err) });
    }
    if (!conn) return reply.code(503).send({ error: 'Music Assistant is not configured' });
    try {
      return { playlists: await fetchMaPlaylists(conn) };
    } catch (err) {
      return reply.code(502).send({ error: `Music Assistant unavailable: ${errorText(err)}` });
    }
  });

  // GET /api/ma/search?q=&limit= — search tracks/radios/playlists
  fastify.get<{ Querystring: { q?: string; limit?: string } }>('/api/ma/search', async (req, reply) => {
    const query = (req.query?.q ?? '').trim();
    if (!query) return reply.code(400).send({ error: 'q is required' });
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query?.limit ?? '20', 10) || 20));
    let conn: MaConnection | null;
    try {
      conn = await maConnection(pool, options.config);
    } catch (err) {
      return reply.code(503).send({ error: errorText(err) });
    }
    if (!conn) return reply.code(503).send({ error: 'Music Assistant is not configured' });
    try {
      return await maSearch(conn, query, limit);
    } catch (err) {
      return reply.code(502).send({ error: `Music Assistant search failed: ${errorText(err)}` });
    }
  });

  // POST /api/ma/play { uri, playerId, option? } — play media on an MA player
  fastify.post<{ Body: { uri?: string; playerId?: string; option?: string } }>(
    '/api/ma/play',
    { preHandler: adminPreHandler(options, ['admin', 'viewer'], false) },
    async (req, reply) => {
      const uri = (req.body?.uri ?? '').trim();
      const playerId = (req.body?.playerId ?? '').trim();
      if (!uri) return reply.code(400).send({ error: 'uri is required' });
      if (!playerId) return reply.code(400).send({ error: 'playerId is required' });
      const option = ['replace', 'play', 'queue', 'add'].includes(req.body?.option ?? '')
        ? String(req.body?.option)
        : 'replace';
      let conn: MaConnection | null;
      try {
        conn = await maConnection(pool, options.config);
      } catch (err) {
        return reply.code(503).send({ error: errorText(err) });
      }
      if (!conn) return reply.code(503).send({ error: 'Music Assistant is not configured' });
      try {
        await maPlayMedia(conn, playerId, uri, option);
        return { success: true, uri, playerId, option };
      } catch (err) {
        return reply.code(502).send({ error: `Music Assistant play failed: ${errorText(err)}` });
      }
    },
  );

  // POST /api/ma/control { action, playerId, level?, muted? } — transport control
  fastify.post<{ Body: { action?: string; playerId?: string; level?: number; muted?: boolean } }>(
    '/api/ma/control',
    { preHandler: adminPreHandler(options, ['admin', 'viewer'], false) },
    async (req, reply) => {
      const action = (req.body?.action ?? '').trim();
      const playerId = (req.body?.playerId ?? '').trim();
      const allowed = ['play', 'pause', 'play_pause', 'stop', 'next', 'previous', 'volume', 'mute'];
      if (!allowed.includes(action)) {
        return reply.code(400).send({ error: `action must be one of ${allowed.join(', ')}` });
      }
      if (!playerId) return reply.code(400).send({ error: 'playerId is required' });
      let conn: MaConnection | null;
      try {
        conn = await maConnection(pool, options.config);
      } catch (err) {
        return reply.code(503).send({ error: errorText(err) });
      }
      if (!conn) return reply.code(503).send({ error: 'Music Assistant is not configured' });
      try {
        const value = action === 'volume' ? req.body?.level : action === 'mute' ? req.body?.muted : undefined;
        await maControl(conn, playerId, action as MaControlAction, value);
        return { success: true, action, playerId };
      } catch (err) {
        return reply.code(502).send({ error: `Music Assistant control failed: ${errorText(err)}` });
      }
    },
  );

  // ═══ Media source connection tests ═══════════════════════════════════════
  //
  // Back the "Test connection" buttons in Settings → Media. Each returns a
  // small { ok, detail?, error? } payload instead of throwing, so the UI can
  // show a friendly result without treating a failed probe as an HTTP error.

  // GET /api/dab/test — reach the SDR radio and count DAB+ stations
  fastify.get('/api/dab/test', async () => {
    const base = await mediaSetting(pool, options.config, 'sdr_radio_url');
    if (!base) return { ok: false, error: 'SDR radio URL is not configured.' };
    try {
      const stations = await fetchDabStations(base);
      return {
        ok: true,
        detail: `Reached the SDR radio — ${stations.length} DAB+ station${stations.length === 1 ? '' : 's'}.`,
      };
    } catch (err) {
      return { ok: false, error: `SDR radio unavailable: ${errorText(err)}` };
    }
  });

  // GET /api/dispatcharr/test — reach Dispatcharr and count channels
  fastify.get('/api/dispatcharr/test', async () => {
    const base = await mediaSetting(pool, options.config, 'dispatcharr_url');
    if (!base) return { ok: false, error: 'Dispatcharr URL is not configured.' };
    const apiKey = await mediaSetting(pool, options.config, 'dispatcharr_api_key');
    try {
      const channels = await fetchDispatcharrChannels(base, apiKey || undefined);
      return {
        ok: true,
        detail: `Reached Dispatcharr — ${channels.length} channel${channels.length === 1 ? '' : 's'}.`,
      };
    } catch (err) {
      return { ok: false, error: `Dispatcharr unavailable: ${errorText(err)}` };
    }
  });

  // GET /api/ma/test — log in to Music Assistant and count players
  fastify.get('/api/ma/test', async () => {
    let conn: MaConnection | null;
    try {
      conn = await maConnection(pool, options.config);
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
    if (!conn) return { ok: false, error: 'Music Assistant URL is not configured.' };
    try {
      const players = await fetchMaPlayers(conn);
      return {
        ok: true,
        detail: `Connected to Music Assistant — ${players.length} player${players.length === 1 ? '' : 's'}.`,
      };
    } catch (err) {
      return { ok: false, error: `Music Assistant unavailable: ${errorText(err)}` };
    }
  });

  // ═══ Commands ════════════════════════════════════════════════════════════

  // POST /api/commands/page { page_id?, page? }
  fastify.post<{ Body: CommandPageBody }>('/api/commands/page', {
    preHandler: adminPreHandler(options, ['admin', 'viewer'], false),
  }, async (req, reply) => {
    const body = req.body ?? {};
    let pageRow: { id: string; name: string } | null = null;
    if (body.page_id) {
      const res = await pool.query('SELECT id, name FROM pages WHERE id = $1', [body.page_id]);
      pageRow = res.rows[0] ?? null;
    } else if (body.page) {
      const res = await pool.query('SELECT id, name FROM pages WHERE LOWER(name) = LOWER($1)', [body.page]);
      pageRow = res.rows[0] ?? null;
    }
    if (!pageRow) return reply.code(404).send({ error: 'Page not found' });
    await setSetting(pool, 'active_page_id', pageRow.id);
    const pageWithPanels = await getPageWithPanels(pool, pageRow.id);
    const devices = options.connectedDeviceIds?.() ?? [];
    const deliveries = pageWithPanels && options.onDisplayPage
      ? await Promise.allSettled(devices.map(async deviceId => {
          await pool.query(
            `INSERT INTO device_page_library (device_id, page_id, sync_status, assigned_at)
             VALUES ($1, $2, 'pending', now())
             ON CONFLICT (device_id, page_id) DO NOTHING`,
            [deviceId, pageRow.id],
          );
          await pool.query(
            `INSERT INTO device_page_state (device_id, active_page_id, updated_at)
             VALUES ($1, $2, now())
             ON CONFLICT (device_id) DO UPDATE SET active_page_id = excluded.active_page_id, updated_at = now()`,
            [deviceId, pageRow.id],
          );
          return options.onDisplayPage!(pageWithPanels, deviceId);
        }))
      : [];
    if (!options.onDisplayPage) broadcast({ type: 'load_page', page_id: pageRow.id, page_data: pageWithPanels }, 'browser');
    return {
      success: true,
      page_id: pageRow.id,
      page_name: pageRow.name,
      delivered: deliveries.filter(result => result.status === 'fulfilled').length,
    };
  });

  // POST /api/commands/navigate { panel_id?, panel?, page_id?, page?, url }
  fastify.post<{ Body: CommandNavigateBody }>('/api/commands/navigate', {
    preHandler: adminPreHandler(options, ['admin', 'viewer'], false),
  }, async (req, reply) => {
    const body = req.body ?? {} as CommandNavigateBody;
    if (!body.url) return reply.code(400).send({ error: 'url is required' });

    let scopePageId: string | undefined;
    if (body.page_id || body.page) {
      const res = body.page_id
        ? await pool.query('SELECT id FROM pages WHERE id = $1', [body.page_id])
        : await pool.query('SELECT id FROM pages WHERE LOWER(name) = LOWER($1)', [body.page]);
      scopePageId = res.rows[0]?.id;
    }

    let panel: { id: string } | null = null;
    if (body.panel_id) {
      const res = await pool.query('SELECT id FROM page_panels WHERE id = $1', [body.panel_id]);
      panel = res.rows[0] ?? null;
    } else if (body.panel) {
      if (scopePageId) {
        const res = await pool.query(
          'SELECT id FROM page_panels WHERE page_id = $1 AND LOWER(name) = LOWER($2)',
          [scopePageId, body.panel],
        );
        panel = res.rows[0] ?? null;
      } else {
        const res = await pool.query(
          'SELECT id FROM page_panels WHERE LOWER(name) = LOWER($1)',
          [body.panel],
        );
        panel = res.rows[0] ?? null;
      }
    }
    if (!panel) return reply.code(404).send({ error: 'Panel not found' });

    const devices = options.connectedDeviceIds?.() ?? [];
    let delivered = 0;
    if (options.onDisplayPage && devices.length) {
      for (const deviceId of devices) {
        await pool.query(
          `INSERT INTO device_panel_state (device_id, panel_id, content, visible, updated_at)
           VALUES ($1, $2, $3::jsonb, null, now())
           ON CONFLICT (device_id, panel_id) DO UPDATE SET content = excluded.content, updated_at = now()`,
          [deviceId, panel.id, JSON.stringify({ type: 'url', url: body.url })],
        );
        const active = await pool.query('SELECT active_page_id FROM device_page_state WHERE device_id = $1', [deviceId]);
        const page = active.rows[0]?.active_page_id
          ? await getPageWithPanels(pool, String(active.rows[0].active_page_id))
          : null;
        if (page) {
          await options.onDisplayPage(page, deviceId);
          delivered += 1;
        }
      }
    } else {
      broadcast({
        type: 'command',
        action: 'navigate_panel',
        payload: { panel_id: panel.id, url: body.url },
      }, 'browser');
    }
    return { success: true, panel_id: panel.id, url: body.url, delivered };
  });

  // POST /api/commands/panel — change any panel on a specific device.
  fastify.post<{ Body: CommandPanelBody }>('/api/commands/panel', {
    preHandler: adminPreHandler(options, ['admin', 'viewer'], false),
  }, async (req, reply) => {
    const body = req.body ?? {};
    if (!body.device_id) return reply.code(400).send({ error: 'device_id is required' });
    if (!body.panel_id && !body.panel) return reply.code(400).send({ error: 'panel_id or panel is required' });
    if (body.content_type === 'url' && (!body.url || !/^https?:\/\//i.test(body.url))) {
      return reply.code(400).send({ error: 'URL content requires an http:// or https:// URL' });
    }
    if (body.content_type === 'scene' && !body.scene_id) {
      return reply.code(400).send({ error: 'Scene content requires scene_id' });
    }
    if (body.scene_id) {
      const scene = await pool.query(
        `SELECT 1 FROM scenes WHERE id = $1 AND status = 'published'`,
        [body.scene_id],
      );
      if (scene.rowCount === 0) return reply.code(404).send({ error: 'Published scene not found' });
    }

    let scopePageId = body.page_id;
    if (!scopePageId && body.page) {
      const scope = await pool.query('SELECT id FROM pages WHERE LOWER(name) = LOWER($1)', [body.page]);
      scopePageId = scope.rows[0]?.id;
      if (!scopePageId) return reply.code(404).send({ error: 'Page not found' });
    }
    if (!scopePageId) {
      const active = await pool.query(
        'SELECT active_page_id FROM device_page_state WHERE device_id = $1',
        [body.device_id],
      );
      scopePageId = active.rows[0]?.active_page_id as string | undefined;
    }
    let panelResult;
    if (body.panel_id) {
      panelResult = await pool.query(
        `SELECT * FROM page_panels WHERE id = $1${scopePageId ? ' AND page_id = $2' : ''}`,
        scopePageId ? [body.panel_id, scopePageId] : [body.panel_id],
      );
    } else if (scopePageId) {
      panelResult = await pool.query(
        'SELECT * FROM page_panels WHERE page_id = $1 AND LOWER(name) = LOWER($2)',
        [scopePageId, body.panel],
      );
    } else {
      panelResult = await pool.query(
        'SELECT * FROM page_panels WHERE LOWER(name) = LOWER($1) ORDER BY position LIMIT 2',
        [body.panel],
      );
      if ((panelResult.rowCount ?? 0) > 1) {
        return reply.code(409).send({ error: 'Panel name is ambiguous; supply page or panel_id' });
      }
    }
    const panel = panelResult.rows[0];
    if (!panel) return reply.code(404).send({ error: 'Panel not found' });

    const content = body.content_type === 'url'
      ? { type: 'url', url: body.url }
      : body.content_type === 'scene'
        ? { type: 'scene', scene_id: body.scene_id }
        : null;
    await pool.query(
      `INSERT INTO device_panel_state (device_id, panel_id, content, visible, updated_at)
       VALUES ($1, $2, $3::jsonb, COALESCE($4, true), now())
       ON CONFLICT (device_id, panel_id) DO UPDATE SET
         content = COALESCE(excluded.content, device_panel_state.content),
         visible = COALESCE(excluded.visible, device_panel_state.visible),
         updated_at = now()`,
      [body.device_id, panel.id, content ? JSON.stringify(content) : null, body.visible ?? null],
    );
    const active = await pool.query(
      'SELECT active_page_id FROM device_page_state WHERE device_id = $1',
      [body.device_id],
    );
    const activePageId = String(active.rows[0]?.active_page_id ?? '');
    if (!activePageId) return reply.code(409).send({ error: 'Device has no active page' });
    if (panel.page_id !== activePageId) {
      return {
        success: true,
        delivered: false,
        queued: true,
        device_id: body.device_id,
        page_id: panel.page_id,
        active_page_id: activePageId,
        panel_id: panel.id,
        content,
        visible: body.visible,
      };
    }
    const activePage = await getPageWithPanels(pool, activePageId);
    if (!activePage) return reply.code(409).send({ error: 'Active page no longer exists' });
    try {
      const delivered = await deliverPage(activePage, body.device_id);
      return {
        success: true,
        delivered,
        device_id: body.device_id,
        page_id: activePageId,
        panel_id: panel.id,
        content,
        visible: body.visible,
        reloaded: body.reload === true,
      };
    } catch (error) {
      return reply.code(409).send({
        success: false,
        delivered: false,
        error: 'panel_delivery_failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /api/commands/reload
  fastify.post('/api/commands/reload', {
    preHandler: adminPreHandler(options, ['admin', 'viewer'], false),
  }, async () => {
    const devices = options.connectedDeviceIds?.() ?? [];
    let delivered = 0;
    if (options.onDisplayPage && devices.length) {
      for (const deviceId of devices) {
        const active = await pool.query('SELECT active_page_id FROM device_page_state WHERE device_id = $1', [deviceId]);
        const page = active.rows[0]?.active_page_id
          ? await getPageWithPanels(pool, String(active.rows[0].active_page_id))
          : null;
        if (page) {
          await options.onDisplayPage(page, deviceId);
          delivered += 1;
        }
      }
    } else {
      broadcast({ type: 'command', action: 'reload', payload: {} }, 'browser');
    }
    return { success: true, delivered };
  });

  // POST /api/commands/quit
  fastify.post('/api/commands/quit', {
    preHandler: adminPreHandler(options, ['admin', 'viewer'], false),
  }, async () => {
    broadcast({ type: 'command', action: 'show_quit_dialog', payload: {} }, 'browser');
    return { success: true };
  });

  // POST /api/commands/screen_on
  fastify.post('/api/commands/screen_on', {
    preHandler: adminPreHandler(options, ['admin', 'viewer'], false),
  }, async () => {
    broadcast({ type: 'screen_on' }, 'browser');
    return { success: true };
  });

  // POST /api/commands/screen_off
  fastify.post('/api/commands/screen_off', {
    preHandler: adminPreHandler(options, ['admin', 'viewer'], false),
  }, async () => {
    broadcast({ type: 'screen_off' }, 'browser');
    return { success: true };
  });

  // ═══ WebSocket hub (/ws) ══════════════════════════════════════════════════

  registerLegacyWebSocket(fastify, pool);
}

// ─── WebSocket registration ──────────────────────────────────────────────────

function registerLegacyWebSocket(fastify: FastifyInstance, pool: Pool): void {
  const wss = new WebSocketServer({ noServer: true });

  fastify.server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '', 'http://localhost');
    if (url.pathname !== '/ws') {
      return; // Not our path — let other handlers (device gateway, voice) handle it.
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws: WebSocket, req) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const role = (url.searchParams.get('role') as ClientType | null) ?? 'api';
    const deviceId = url.searchParams.get('deviceId') ?? undefined;

    const client: ConnectedClient = {
      ws,
      clientType: role,
      deviceId,
      remoteAddress: req.socket?.remoteAddress,
      connectedAt: new Date(),
    };
    clients.set(ws, client);
    console.log(`[core][legacy-ws] ${role} connected${deviceId ? ` (device=${deviceId})` : ''}`);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleWsMessage(pool, ws, msg).catch((err) =>
          console.error('[core][legacy-ws] message handler error:', err),
        );
      } catch {
        console.warn('[core][legacy-ws] invalid JSON');
      }
    });

    ws.on('close', () => {
      const c = clients.get(ws);
      clients.delete(ws);
      if (c?.deviceId) {
        for (const [requestId, pending] of pendingDeviceRequests) {
          if (pending.deviceId !== c.deviceId) continue;
          clearTimeout(pending.timer);
          pendingDeviceRequests.delete(requestId);
          pending.reject(new Error(`device ${c.deviceId} disconnected`));
        }
        broadcast({ type: 'device_offline', device_id: c.deviceId }, 'editor');
      }
    });

    ws.on('error', (err) => {
      console.error('[core][legacy-ws] error:', err.message);
      clients.delete(ws);
    });
  });

  // Heartbeat — prune dead connections every 30s.
  setInterval(() => {
    for (const [ws, client] of clients) {
      if (ws.readyState === ws.OPEN) {
        ws.ping();
      } else {
        clients.delete(ws);
      }
    }
  }, 30_000).unref();

  console.log('[core][legacy-ws] listening on /ws');
}

async function handleWsMessage(pool: Pool, ws: WebSocket, msg: any): Promise<void> {
  switch (msg?.type) {
    case 'hello': {
      const client = clients.get(ws);
      if (!client) return;
      client.clientType = (msg.client_type as ClientType) ?? 'api';
      client.deviceId = msg.device_id ?? client.deviceId;
      send(ws, { type: 'hello_ack', server_version: '0.1.0' });

      // For browser clients, prefer its assigned page, then fall back to the global active page.
      if (client.clientType === 'browser') {
        try {
          let pageId: string | null = null;
          if (client.deviceId) {
            const assignmentRes = await pool.query(
              'SELECT page_id FROM device_page_assignments WHERE device_id = $1',
              [client.deviceId],
            );
            pageId = assignmentRes.rows[0]?.page_id ?? null;
          }
          pageId ??= await getSetting(pool, 'active_page_id');
          if (pageId) {
            const page = await getPageWithPanels(pool, pageId);
            if (page) {
              send(ws, { type: 'load_page', page_id: pageId, page_data: page });
            }
          }
        } catch (err) {
          console.warn('[core][legacy-ws] failed to push active page on hello:', err);
        }
      }
      break;
    }
    case 'device_status': {
      const client = clients.get(ws);
      if (client && msg.device_id) client.deviceId = msg.device_id;
      broadcast(msg, 'editor');
      break;
    }
    case 'command_ack': {
      broadcast({ type: 'command_ack', command_id: msg.command_id, device_id: msg.device_id }, 'editor');
      break;
    }
    case 'device_response': {
      const requestId = typeof msg.request_id === 'string' ? msg.request_id : '';
      const pending = pendingDeviceRequests.get(requestId);
      if (!pending) break;
      const client = clients.get(ws);
      if (!client?.deviceId || client.deviceId !== pending.deviceId) break;
      clearTimeout(pending.timer);
      pendingDeviceRequests.delete(requestId);
      if (msg.ok) {
        pending.resolve(msg.result);
      } else {
        pending.reject(new Error(typeof msg.error === 'string' ? msg.error : 'Device action failed'));
      }
      break;
    }
    case 'ping': {
      send(ws, { type: 'pong' });
      break;
    }
    default:
      console.warn(`[core][legacy-ws] unknown message type: ${msg?.type}`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clampVolume(level: number): number {
  return Math.max(0, Math.min(100, level));
}
