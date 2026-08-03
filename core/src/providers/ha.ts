/**
 * Home Assistant integration service (plan doc §16, D-012).
 *
 * `HomeAssistantClient` is the D-012 foundation: Core is the PRIMARY Home Assistant
 * integration point. It connects to a real HA instance over HA's WebSocket API for
 * live state subscription (the standard HA integration pattern) and exposes REST
 * helpers for service calls and one-off state reads. Edge devices never touch HA and
 * hold no HA credentials (D-009/D-012).
 *
 * WIRING / AUTH FLOW
 *   - WebSocket: connect to `${homeAssistantUrl}/api/websocket`, then perform the HA
 *     auth handshake: receive `auth_required`, send `auth` with `access_token`, expect
 *     `auth_ok` (or `auth_invalid`). See `authenticate()` for the exact flow.
 *   - After auth, we `subscribe_entities` (HA's compact full-state subscription) and
 *     keep an in-memory cache of every entity's state + attributes, updated by
 *     `state_changed` events delivered through the subscription. We also do an initial
 *     `get_states` REST pull so the cache is populated even before the first push.
 *   - REST: `POST /api/services/<domain>/<service>` to call a service (e.g. turn on a
 *     light), `GET /api/states/<entity_id>` to read one entity.
 *
 * DEGRADED MODE (plan §20.4: integration failure must not disconnect devices or crash
 * Core). If HA is unreachable or auth fails, `healthCheck()` reports unhealthy and the
 * cache stays empty — but Core keeps running. The WebSocket layer auto-reconnects with
 * backoff so it recovers when HA comes back.
 *
 * TESTABILITY. Both the WebSocket constructor and `fetch` are injectable so unit tests
 * stub the entire network (see `test/ha.test.ts`): a fake `ws` that speaks the auth
 * handshake, and a mock `fetch` for REST/service calls. No real network is required.
 *
 * CREDENTIAL HANDLING (honest Phase 2 status). Per §16.2 and `docs/PHASE_0_*.md`, the
 * HA long-lived token lives ONLY in Core (env / `.env`, never committed, never sent to
 * Edge, never logged in full). A fully encrypted-at-rest secret store is a later gate
 * (Phase 4 / plan §16.2 "encrypted"); this module reads the token from config and never
 * persists it. The token is passed only to HA over TLS (https recommended for HA) and
 * is redacted in any diagnostic output.
 *
 * PHASE SCOPE: this is the D-012 scaffold — real, injectable, and unit-tested. It does
 * NOT yet implement entity allowlists/subscriptions scoped to active scenes (§16.2),
 * the typed allowlisted service tool registry (§15.3), or command journaling/audit
 * (those land with the Canvas Intelligence tool registry in Phase 5/6). The interface
 * is designed so later work extends, not rewrites, this file.
 */
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { HealthStatus } from './types.js';
import type { FetchImpl } from './llm.js';

/** Minimal subset of the `ws` `WebSocket` shape we depend on (keeps tests easy to stub). */
export interface HaWebSocket {
  on(event: 'open', listener: () => void): this;
  on(event: 'message', listener: (data: RawData) => void): this;
  on(event: 'close', listener: (code?: number, reason?: string) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  send(data: string): void;
  close(): void;
  readonly readyState: number;
}

/** What `ws` hands our `message` listener (Buffer / string / ArrayBuffer-ish). */
export type RawData = Buffer | string | ArrayBuffer | Buffer[];

/** Constructor for a HA WebSocket; injectable so tests supply a fake. */
export type HaWebSocketFactory = (url: string) => HaWebSocket;

/** A normalized Home Assistant entity as surfaced by Core. */
export interface HaEntity {
  entityId: string;
  state: string;
  attributes: Record<string, unknown>;
  /** Last-changed / last-updated ISO timestamps from HA, when present. */
  lastChanged?: string;
  lastUpdated?: string;
}

/** A compact summary suitable for admin/ops listings (no huge attribute blobs). */
export interface HaEntitySummary extends HaEntity {
  friendlyName?: string;
  domain: string;
}

export interface HaAreaRegistryEntry {
  areaId: string;
  name: string;
  floorId?: string;
  aliases: string[];
}

export interface HaDeviceRegistryEntry {
  deviceId: string;
  name?: string;
  nameByUser?: string;
  areaId?: string;
  manufacturer?: string;
  model?: string;
}

export interface HaEntityRegistryEntry {
  entityId: string;
  deviceId?: string;
  areaId?: string;
  name?: string;
  originalName?: string;
  platform?: string;
  disabledBy?: string;
}

export interface HaRegistrySnapshot {
  areas: HaAreaRegistryEntry[];
  devices: HaDeviceRegistryEntry[];
  entities: HaEntityRegistryEntry[];
}

export interface HomeAssistantClientOptions {
  /** Base URL, e.g. "http://homeassistant.local:8123" (no trailing slash). */
  baseUrl: string;
  /** Long-lived HA access token. Core-only; never sent to Edge. */
  token: string;
  /** Request timeout in ms for REST calls. */
  timeoutMs?: number;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: FetchImpl;
  /** Injectable WebSocket factory (tests). Defaults to the real `ws` client. */
  wsFactory?: HaWebSocketFactory;
  /** Label used in health reports. */
  name?: string;
  /** Auto-reconnect on close (default true). Disable in tests. */
  autoReconnect?: boolean;
  /** Base reconnect delay in ms (default 2000). */
  reconnectDelayMs?: number;
}

const WS_OPEN = 1;

interface HaWsMessage {
  type: string;
  id?: number;
  [key: string]: unknown;
}

/**
 * Core's Home Assistant integration client (D-012).
 *
 * Public surface used by routes / future tool registry:
 *   - `getEntities()` / `getEntity(id)` — read the live entity cache.
 *   - `callService(domain, service, serviceData)` — invoke an HA service (command).
 *   - `healthCheck()` — availability probe (never throws).
 *   - `connect()` / `disconnect()` — lifecycle (connect is idempotent).
 */
export class HomeAssistantClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchImpl;
  private readonly wsFactory: HaWebSocketFactory;
  private readonly name: string;
  private readonly autoReconnect: boolean;
  private readonly reconnectDelayMs: number;

  /** In-memory entity-state cache, keyed by entity_id. */
  private readonly cache = new Map<string, HaEntity>();
  private ws: HaWebSocket | null = null;
  private connected = false;
  private authenticated = false;
  /** Monotonic HA message id counter for request/response correlation. */
  private msgId = 1;
  /** Pending subscribe_entities result resolvers keyed by message id. */
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  /** Entity change listeners: called when the cache is updated via WS push. */
  private readonly entityChangeListeners: Array<(entityId: string, entity: HaEntity) => void> = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;

  constructor(opts: HomeAssistantClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.wsFactory = opts.wsFactory ?? defaultWsFactory;
    this.name = opts.name ?? 'ha';
    this.autoReconnect = opts.autoReconnect ?? true;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 2000;
  }

  /** True once the WS auth handshake completed. */
  isConnected(): boolean {
    return this.connected && this.authenticated;
  }

  /**
   * Open the WebSocket, authenticate, and subscribe to entity state. Idempotent:
   * safe to call if already connected. Resolves once subscribed (cache primed via
   * the initial `get_states` REST pull). Rejects if auth fails or WS errors before
   * subscription. Callers should still treat HA as optional (degraded mode).
   */
  async connect(): Promise<void> {
    this.closedByUser = false;
    if (this.ws && this.isConnected()) return;
    await this.openAndAuthenticate();
    await this.refreshStates();
    await this.subscribeEntities().catch(() => this.subscribeStateChanges());
  }

  /** Close the WebSocket and stop reconnecting. */
  disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connected = false;
    this.authenticated = false;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  /** Register a listener for entity state changes (called on every WS push update). */
  onEntityChange(listener: (entityId: string, entity: HaEntity) => void): void {
    this.entityChangeListeners.push(listener);
  }

  /** Remove a previously registered entity change listener. */
  offEntityChange(listener: (entityId: string, entity: HaEntity) => void): void {
    const idx = this.entityChangeListeners.indexOf(listener);
    if (idx >= 0) this.entityChangeListeners.splice(idx, 1);
  }

  /** Read all cached entities. */
  getEntities(): HaEntity[] {
    return [...this.cache.values()];
  }

  /** Read a single cached entity, or undefined if unknown/absent. */
  getEntity(entityId: string): HaEntity | undefined {
    return this.cache.get(entityId);
  }

  /** Compact summaries for admin/ops listings. */
  getEntitySummaries(): HaEntitySummary[] {
    return this.getEntities().map((e) => ({
      ...e,
      domain: e.entityId.split('.')[0] ?? '',
      friendlyName:
        (typeof e.attributes?.friendly_name === 'string'
          ? e.attributes.friendly_name
          : undefined),
    }));
  }

  /**
   * Force a full entity refresh from Home Assistant.
   *
   * Core normally stays current through the WebSocket subscription. This public
   * method backs the admin "Refresh entities" action and also provides a periodic
   * reconciliation path for missed/deleted entities.
   */
  async refreshEntities(): Promise<HaEntitySummary[]> {
    await this.refreshStates();
    return this.getEntitySummaries();
  }

  /** Fetch HA's structural registries over the authenticated WebSocket. */
  async refreshRegistries(): Promise<HaRegistrySnapshot> {
    if (!this.isConnected()) throw new Error('HA WebSocket is not connected');
    const [rawAreas, rawDevices, rawEntities] = await Promise.all([
      this.sendCommand('config/area_registry/list'),
      this.sendCommand('config/device_registry/list'),
      this.sendCommand('config/entity_registry/list'),
    ]);
    return {
      areas: Array.isArray(rawAreas) ? rawAreas.flatMap(normalizeAreaRegistryEntry) : [],
      devices: Array.isArray(rawDevices) ? rawDevices.flatMap(normalizeDeviceRegistryEntry) : [],
      entities: Array.isArray(rawEntities) ? rawEntities.flatMap(normalizeEntityRegistryEntry) : [],
    };
  }

  /**
   * Call an HA service (command), e.g. `callService('light', 'turn_on', { entity_id: 'light.kitchen' })`.
   * Returns the array of entity states HA echoes back (HA convention). Uses REST
   * `POST /api/services/<domain>/<service>`.
   */
  async callService(
    domain: string,
    service: string,
    serviceData: Record<string, unknown> = {},
  ): Promise<HaEntity[]> {
    const url = `${this.baseUrl}/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`;
    const res = await this.rest(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(serviceData),
    });
    const json = (await res.json().catch(() => [])) as unknown[];
    // HA returns the affected states as an array; merge into cache for freshness.
    for (const raw of json) {
      const e = normalizeState(raw);
      if (e) this.cache.set(e.entityId, e);
    }
    return json.map((raw) => normalizeState(raw)).filter((e): e is HaEntity => e !== null);
  }

  /** One-off REST read of a single entity (bypasses the cache). */
  async getState(entityId: string): Promise<HaEntity> {
    const url = `${this.baseUrl}/api/states/${encodeURIComponent(entityId)}`;
    const res = await this.rest(url, { method: 'GET' });
    const json = await res.json();
    const e = normalizeState(json);
    if (!e) throw new Error(`HA returned an unrecognized state shape for ${entityId}`);
    this.cache.set(e.entityId, e);
    return e;
  }

  /** Availability probe (plan §20.4). Never throws. */
  async healthCheck(): Promise<HealthStatus> {
    if (this.isConnected()) {
      return { name: this.name, kind: 'HomeAssistantClient', healthy: true, detail: `${this.cache.size} entities cached` };
    }
    // Probe via REST config endpoint (cheap, does not require WS auth to be live).
    try {
      const res = await this.rest(`${this.baseUrl}/api/config`, { method: 'GET' });
      if (res.ok) {
        return {
          name: this.name,
          kind: 'HomeAssistantClient',
          healthy: true,
          detail: 'reachable (WS not yet subscribed)',
        };
      }
      return {
        name: this.name,
        kind: 'HomeAssistantClient',
        healthy: false,
        detail: `api/config status ${res.status}`,
      };
    } catch (err) {
      return {
        name: this.name,
        kind: 'HomeAssistantClient',
        healthy: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // --- internal: WebSocket handshake + subscription -------------------------

  private openAndAuthenticate(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const wsUrl = `${this.baseUrl}/api/websocket`;
      let settled = false;
      const ws = this.wsFactory(wsUrl);
      this.ws = ws;

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        this.connected = false;
        this.authenticated = false;
        reject(err);
      };

      ws.on('open', () => {
        // Wait for HA's `auth_required` before sending our `auth` message.
      });

      ws.on('message', (data: RawData) => {
        const msg = parseMessage(data);
        if (!msg) return;
        if (msg.type === 'auth_required') {
          // Send auth with the long-lived token.
          ws.send(JSON.stringify({ type: 'auth', access_token: this.token }));
          return;
        }
        if (msg.type === 'auth_ok') {
          this.connected = true;
          this.authenticated = true;
          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }
        if (msg.type === 'auth_invalid') {
          fail(new Error(`HA auth invalid: ${String(msg.message ?? 'bad token')}`));
          return;
        }
        // Any other message after auth: route to subscription handling.
        this.handleMessage(msg);
      });

      ws.on('error', (err: Error) => {
        fail(err);
      });

      ws.on('close', () => {
        this.connected = false;
        this.authenticated = false;
        if (!settled) {
          fail(new Error('HA WebSocket closed before authentication'));
          return;
        }
        this.scheduleReconnect();
      });
    });
  }

  private subscribeEntities(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.ws) return reject(new Error('HA WebSocket not open'));
      const id = this.msgId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('HA subscribe_entities timed out'));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, type: 'subscribe_entities' }));
    });
  }

  private subscribeStateChanges(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.ws) return reject(new Error('HA WebSocket not open'));
      const id = this.msgId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('HA state_changed subscription timed out'));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.ws.send(JSON.stringify({
        id,
        type: 'subscribe_events',
        event_type: 'state_changed',
      }));
    });
  }

  private sendCommand(type: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.isConnected()) return reject(new Error('HA WebSocket not open'));
      const id = this.msgId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`HA ${type} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.ws.send(JSON.stringify({ id, type }));
    });
  }

  /** Handle post-auth WS messages (subscription results + state_changed pushes). */
  private handleMessage(msg: HaWsMessage): void {
    // Correlate subscribe result / event messages by id.
    if (typeof msg.id === 'number') {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        if (msg.type === 'result') {
          if (msg.success === true) {
            pending.resolve(msg.result);
          } else {
            const detail = typeof msg.error === 'object'
              ? JSON.stringify(msg.error)
              : String(msg.error ?? 'unknown');
            pending.reject(new Error(`HA command failed: ${detail}`));
          }
          return;
        }
      }
    }

    // `event` messages from subscribe_entities carry the full state map (initial)
    // and incremental `state_changed` updates.
    if (msg.type === 'event' && msg.event) {
      const event = msg.event as {
        event_type?: string;
        a?: unknown;
        d?: unknown;
        data?: { new_state?: unknown };
      };
      if (event.event_type === 'state_changed' && event.a && event.d) {
        const newState = normalizeState(event.d);
        if (newState) {
          this.cache.set(newState.entityId, newState);
          this.notifyEntityChange(newState.entityId, newState);
        }
      } else if (event.event_type === 'state_changed' && event.data?.new_state) {
        const newState = normalizeState(event.data.new_state);
        if (newState) {
          this.cache.set(newState.entityId, newState);
          this.notifyEntityChange(newState.entityId, newState);
        }
      } else if (event.event_type === 'subscribe_entities' && event.a) {
        // Initial full dump: `a` is the map of entity_id -> state.
        const map = event.a as Record<string, unknown>;
        for (const [entityId, raw] of Object.entries(map)) {
          const e = normalizeState({ entity_id: entityId, ...(raw as Record<string, unknown>) });
          if (e) {
            this.cache.set(e.entityId, e);
            this.notifyEntityChange(e.entityId, e);
          }
        }
      }
    }
  }

  private scheduleReconnect(): void {
    if (!this.autoReconnect || this.closedByUser) return;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openAndAuthenticate()
        .then(() => this.refreshStates())
        .then(() => this.subscribeEntities().catch(() => this.subscribeStateChanges()))
        .catch(() => this.scheduleReconnect());
    }, this.reconnectDelayMs);
  }

  /** Pull all states via REST to prime the cache. */
  private notifyEntityChange(entityId: string, entity: HaEntity): void {
    for (const listener of this.entityChangeListeners) {
      try {
        listener(entityId, entity);
      } catch {
        /* swallow listener errors */
      }
    }
  }

  private async refreshStates(): Promise<void> {
    const res = await this.rest(`${this.baseUrl}/api/states`, { method: 'GET' });
    const json = (await res.json()) as unknown[];
    for (const raw of json) {
      const e = normalizeState(raw);
      if (e) {
        this.cache.set(e.entityId, e);
        this.notifyEntityChange(e.entityId, e);
      }
    }
  }

  private async rest(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          authorization: `Bearer ${this.token}`,
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HA ${res.status}: ${text.slice(0, 200)}`);
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Normalize an HA state object into our `HaEntity` shape. Returns null if malformed. */
function normalizeState(raw: unknown): HaEntity | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.entity_id !== 'string') return null;
  const attributes = (o.attributes as Record<string, unknown>) ?? {};
  const entity: HaEntity = {
    entityId: o.entity_id,
    state: typeof o.state === 'string' ? o.state : String(o.state ?? ''),
    attributes,
  };
  if (typeof o.last_changed === 'string') entity.lastChanged = o.last_changed;
  if (typeof o.last_updated === 'string') entity.lastUpdated = o.last_updated;
  return entity;
}

function normalizeAreaRegistryEntry(raw: unknown): HaAreaRegistryEntry[] {
  if (!raw || typeof raw !== 'object') return [];
  const row = raw as Record<string, unknown>;
  if (typeof row.area_id !== 'string' || typeof row.name !== 'string') return [];
  return [{
    areaId: row.area_id,
    name: row.name,
    floorId: typeof row.floor_id === 'string' ? row.floor_id : undefined,
    aliases: Array.isArray(row.aliases) ? row.aliases.filter((v): v is string => typeof v === 'string') : [],
  }];
}

function normalizeDeviceRegistryEntry(raw: unknown): HaDeviceRegistryEntry[] {
  if (!raw || typeof raw !== 'object') return [];
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== 'string') return [];
  return [{
    deviceId: row.id,
    name: typeof row.name === 'string' ? row.name : undefined,
    nameByUser: typeof row.name_by_user === 'string' ? row.name_by_user : undefined,
    areaId: typeof row.area_id === 'string' ? row.area_id : undefined,
    manufacturer: typeof row.manufacturer === 'string' ? row.manufacturer : undefined,
    model: typeof row.model === 'string' ? row.model : undefined,
  }];
}

function normalizeEntityRegistryEntry(raw: unknown): HaEntityRegistryEntry[] {
  if (!raw || typeof raw !== 'object') return [];
  const row = raw as Record<string, unknown>;
  if (typeof row.entity_id !== 'string') return [];
  return [{
    entityId: row.entity_id,
    deviceId: typeof row.device_id === 'string' ? row.device_id : undefined,
    areaId: typeof row.area_id === 'string' ? row.area_id : undefined,
    name: typeof row.name === 'string' ? row.name : undefined,
    originalName: typeof row.original_name === 'string' ? row.original_name : undefined,
    platform: typeof row.platform === 'string' ? row.platform : undefined,
    disabledBy: typeof row.disabled_by === 'string' ? row.disabled_by : undefined,
  }];
}

function parseMessage(data: RawData): HaWsMessage | null {
  let text: string;
  if (Buffer.isBuffer(data)) text = data.toString('utf8');
  else if (typeof data === 'string') text = data;
  else if (Array.isArray(data)) text = Buffer.concat(data).toString('utf8');
  else text = String(data);
  try {
    return JSON.parse(text) as HaWsMessage;
  } catch {
    return null;
  }
}

/** Real `ws` client factory. Tests still replace this through `wsFactory`. */
function defaultWsFactory(url: string): HaWebSocket {
  const sock = new WebSocket(url) as unknown as HaWebSocket;
  return sock;
}

/** Build a HA client from Core config; returns null when HA is not configured. */
export function createHomeAssistantClient(
  config: { homeAssistantUrl?: string; homeAssistantToken?: string },
  opts: { fetchImpl?: FetchImpl; wsFactory?: HaWebSocketFactory; autoReconnect?: boolean } = {},
): HomeAssistantClient | null {
  if (!config.homeAssistantUrl || !config.homeAssistantToken) return null;
  return new HomeAssistantClient({
    baseUrl: config.homeAssistantUrl,
    token: config.homeAssistantToken,
    fetchImpl: opts.fetchImpl,
    wsFactory: opts.wsFactory,
    autoReconnect: opts.autoReconnect ?? true,
  });
}
