import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
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

interface CoreEntityPayload {
  entity_id?: string;
  state?: string;
  attributes?: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
}

function normalizeEntities(payload: unknown): Record<string, EntityState> {
  const values = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { entities?: unknown[] } | null)?.entities)
      ? (payload as { entities: unknown[] }).entities
      : Object.values(((payload as { entities?: Record<string, unknown> } | null)?.entities ?? {}) as Record<string, unknown>);

  const entities: Record<string, EntityState> = {};
  for (const raw of values) {
    const entity = raw as CoreEntityPayload;
    if (!entity.entity_id) continue;
    entities[entity.entity_id] = {
      entity_id: entity.entity_id,
      state: String(entity.state ?? 'unknown'),
      attributes: entity.attributes ?? {},
      last_changed: entity.last_changed ?? new Date().toISOString(),
      last_updated: entity.last_updated ?? new Date().toISOString(),
    };
  }
  return entities;
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
      setEntities(normalizeEntities(payload));
      setConnected(payload.connected ?? true);
      setError(null);
    } catch (err) {
      setConnected(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refreshEntities();
    const timer = window.setInterval(refreshEntities, 5_000);
    return () => window.clearInterval(timer);
  }, [refreshEntities]);

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
