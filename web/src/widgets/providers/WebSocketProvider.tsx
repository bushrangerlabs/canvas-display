import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { EntityState, HassConnection } from '../types/index';

interface WebSocketContextType {
  connected: boolean;
  authenticated: boolean;
  hass: HassConnection | null;
  entities: Record<string, EntityState>;
  error: string | null;
  callService: (domain: string, service: string, data?: unknown) => Promise<any>;
}

const EMPTY_CONTEXT: WebSocketContextType = {
  connected: false,
  authenticated: false,
  hass: null,
  entities: {},
  error: null,
  callService: async () => {
    throw new Error('WebSocket not connected');
  },
};

const WebSocketContext = createContext<WebSocketContextType>(EMPTY_CONTEXT);

export const useWebSocket = () => useContext(WebSocketContext);

// Trusted-local-client bearer token (VITE_CORE_AUTOMATION_TOKEN). Core's
// requireAdmin accepts it to grant the display device HA access without a
// browser session/CSRF — see core/src/auth.ts.
const HA_TOKEN = (import.meta.env as any).VITE_CORE_AUTOMATION_TOKEN as string | undefined;

/**
 * Poll interval while the push socket is healthy. Entity state is pushed over
 * Core's WebSocket (`ha_state_update`), so this slow poll only resynchronises
 * the full set after a reconnect — it no longer drives latency.
 */
const ENTITY_POLL_MS = 15_000;

/**
 * Poll interval while the push socket is down. Falls back to the previous
 * behaviour so a blocked/failed WebSocket can never make updates slower than
 * the old always-poll implementation.
 */
const FALLBACK_POLL_MS = 2_000;

/** Coalesce bursts of pushed entity updates into a single render. */
const PUSH_FLUSH_MS = 120;

interface CoreEntityPayload {
  entity_id?: string;
  state?: string;
  attributes?: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
}

function extractEntityValues(payload: unknown): unknown[] {
  return Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { entities?: unknown[] } | null)?.entities)
      ? (payload as { entities: unknown[] }).entities
      : Object.values(((payload as { entities?: Record<string, unknown> } | null)?.entities ?? {}) as Record<string, unknown>);
}

function normalizeEntity(entity: CoreEntityPayload): EntityState {
  return {
    entity_id: entity.entity_id as string,
    state: String(entity.state ?? 'unknown'),
    attributes: entity.attributes ?? {},
    last_changed: entity.last_changed ?? new Date().toISOString(),
    last_updated: entity.last_updated ?? new Date().toISOString(),
  };
}

function normalizeEntities(payload: unknown): Record<string, EntityState> {
  const entities: Record<string, EntityState> = {};
  for (const raw of extractEntityValues(payload)) {
    const entity = raw as CoreEntityPayload;
    if (!entity.entity_id) continue;
    entities[entity.entity_id] = normalizeEntity(entity);
  }
  return entities;
}

/**
 * Cheap change key for an entity map. The display receives both pushed updates
 * and periodic full snapshots; without this every snapshot produced a brand-new
 * `entities` object and re-rendered every widget (and re-ran every binding /
 * visibility effect) even when nothing had changed. `last_updated` changes on
 * attribute updates too, so this catches more than just `state` transitions.
 * Keys are sorted so a pushed map and a polled snapshot produce the same key.
 */
function signatureOfMap(entities: Record<string, EntityState>): string {
  const ids = Object.keys(entities).sort();
  const parts = new Array<string>(ids.length);
  for (let i = 0; i < ids.length; i++) {
    const entity = entities[ids[i]];
    parts[i] = `${ids[i]}\u0000${entity.state}\u0000${entity.last_updated}`;
  }
  return parts.join('\u0001');
}

/**
 * Canvas UI compatibility provider backed by Canvas Core's HA facade.
 * Widgets remain unchanged; only their transport boundary differs from the
 * Home Assistant panel version.
 */
export const WebSocketProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [entities, setEntities] = useState<Record<string, EntityState>>({});
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether the push socket is currently open; drives the fallback poll rate.
  const [socketOpen, setSocketOpen] = useState(false);

  const entitiesRef = useRef<Record<string, EntityState>>({});
  const lastSignatureRef = useRef('');
  const dirtyRef = useRef(false);
  const flushTimerRef = useRef<number | null>(null);

  // Swap the entity map only when its contents actually changed. Both the push
  // channel and the fallback poll funnel through here.
  const commit = useCallback((next: Record<string, EntityState>) => {
    const signature = signatureOfMap(next);
    if (signature === lastSignatureRef.current) return;
    lastSignatureRef.current = signature;
    entitiesRef.current = next;
    setEntities(next);
  }, []);

  const refreshEntities = useCallback(async () => {
    try {
      const headers: Record<string, string> = {};
      if (HA_TOKEN) headers['Authorization'] = `Bearer ${HA_TOKEN}`;
      const response = await fetch('/api/ha/entities', { credentials: 'include', headers });
      if (!response.ok) throw new Error(`Core HA facade returned ${response.status}`);
      const payload = await response.json() as {
        entities?: EntityState[];
        configured?: boolean;
        connected?: boolean;
      };
      commit(normalizeEntities(payload));
      setConnected(payload.connected ?? true);
      setError(null);
    } catch (err) {
      setConnected(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [commit]);

  // Apply a single pushed entity update, coalescing bursts into one render.
  const applyPush = useCallback((entity: EntityState) => {
    entitiesRef.current = { ...entitiesRef.current, [entity.entity_id]: entity };
    dirtyRef.current = true;
    if (flushTimerRef.current !== null) return;
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      commit(entitiesRef.current);
    }, PUSH_FLUSH_MS);
  }, [commit]);

  // Primary transport: Core pushes `ha_state_update` frames over /ws.
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retryDelay = 1000;
    let retryTimer: number | undefined;

    const connect = () => {
      if (closed) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      try {
        ws = new WebSocket(`${protocol}//${window.location.host}/ws?role=display`);
      } catch {
        retryTimer = window.setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
        return;
      }
      ws.onopen = () => {
        retryDelay = 1000;
        // Resync the full set after a (re)connect in case updates were missed.
        // The poll effect re-runs on this state change and fetches immediately.
        setSocketOpen(true);
      };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg?.type === 'ha_state_update' && msg.entity?.entity_id) {
            applyPush(normalizeEntity(msg.entity as CoreEntityPayload));
          }
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        if (closed) return;
        setSocketOpen(false);
        retryTimer = window.setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
      };
      ws.onerror = () => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.close();
      };
    };

    connect();
    return () => {
      closed = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      try { ws?.close(); } catch { /* ignore */ }
    };
  }, [applyPush]);

  // Fallback: a full snapshot keeps the display correct if the socket is blocked
  // or briefly drops. Polls slowly while push is healthy, quickly when it is not.
  useEffect(() => {
    void refreshEntities();
    const timer = window.setInterval(refreshEntities, socketOpen ? ENTITY_POLL_MS : FALLBACK_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refreshEntities, socketOpen]);

  const callService = useCallback(async (domain: string, service: string, data?: unknown) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (HA_TOKEN) headers['Authorization'] = `Bearer ${HA_TOKEN}`;
    const response = await fetch(`/api/ha/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(data ?? {}),
    });
    if (!response.ok) throw new Error(`Core HA service call returned ${response.status}`);
    return response.json();
  }, []);

  const hass = useMemo<HassConnection>(() => ({
    callService,
    subscribeEntities: (callback) => {
      callback(entities);
      return () => undefined;
    },
    getStates: async () => Object.values(entities),
    states: entities,
    sendMessage: async () => {
      throw new Error('Raw Home Assistant WebSocket access is not exposed to Canvas Edge widgets');
    },
  }), [callService, entities]);

  const value = useMemo<WebSocketContextType>(() => ({
    connected,
    authenticated: connected,
    hass,
    entities,
    error,
    callService,
  }), [connected, entities, error, hass, callService]);

  return <WebSocketContext.Provider value={value}>{children}</WebSocketContext.Provider>;
};
