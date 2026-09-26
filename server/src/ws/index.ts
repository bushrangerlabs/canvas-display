import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { getDb } from '../db/index';
import { publishDeviceState } from '../mqtt/index';
import { randomUUID } from 'node:crypto';

export type ClientType = 'browser' | 'editor' | 'api';

// ─── HA state broadcaster ────────────────────────────────────────────────────
// Phase 4 (D-012): Core is the primary HA integration point. The sidecar's HA
// state poller is a legacy feature not started by the current composition root.
// Set CANVAS_SIDECAR_HA_STATE_POLLER_ENABLED=false to opt out explicitly.
const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;
const HA_API = 'http://supervisor/core/api';
const HA_POLL_MS = 10_000;
let _prevStates: Record<string, string> = {};

const haStatePollerEnabled =
  (process.env.CANVAS_SIDECAR_HA_STATE_POLLER_ENABLED ?? 'true').toLowerCase() !== 'false';

async function pollAndBroadcastHAStates() {
  if (!SUPERVISOR_TOKEN) return;
  try {
    const res = await fetch(`${HA_API}/states`, {
      headers: { Authorization: `Bearer ${SUPERVISOR_TOKEN}` },
    });
    if (!res.ok) return;
    const states: Array<{ entity_id: string; state: string; attributes: Record<string, unknown>; last_updated?: string; last_changed?: string }> = await res.json();
    for (const entity of states) {
      if (_prevStates[entity.entity_id] !== entity.state) {
        _prevStates[entity.entity_id] = entity.state;
        broadcast({
          type: 'ha_state_update',
          entity_id: entity.entity_id,
          state: entity.state,
          attributes: entity.attributes,
          last_updated: entity.last_updated,
          last_changed: entity.last_changed,
        }, 'all');
      }
    }
  } catch {
    // Silently fail — HA may not be available
  }
}

/** Start the periodic HA state poller. Call once after initWss(). */
export function startHAStatePoller() {
  if (!SUPERVISOR_TOKEN) {
    console.log('[ws] HA state poller disabled — no SUPERVISOR_TOKEN (running outside add-on)');
    return;
  }
  if (!haStatePollerEnabled) {
    console.log('[ws] HA state poller disabled (CANVAS_SIDECAR_HA_STATE_POLLER_ENABLED=false)');
    return;
  }
  pollAndBroadcastHAStates(); // immediate first fetch
  setInterval(pollAndBroadcastHAStates, HA_POLL_MS);
}

interface ConnectedClient {
  ws: WebSocket;
  clientType: ClientType;
  deviceId?: string;        // set for 'browser' clients
  connectedAt: Date;
}

const clients = new Map<WebSocket, ConnectedClient>();
const pendingRenderRequests = new Map<string, {
  resolve: (result: RenderResult) => void;
  timer: NodeJS.Timeout;
}>();
const pendingLocalActions = new Map<string, {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}>();
let wss: WebSocketServer;

export interface RenderResult {
  ok: boolean;
  page_id: string;
  phase: 'rendered' | 'failed';
  error?: string;
}

export function initWss(server: any): WebSocketServer {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    console.log(`[ws] Client connected from ${ip}`);

    // Temporarily store as unknown until hello received
    clients.set(ws, {
      ws,
      clientType: 'api',
      connectedAt: new Date(),
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleMessage(ws, msg);
      } catch {
        console.warn('[ws] Invalid JSON received');
      }
    });

    ws.on('close', () => {
      const client = clients.get(ws);
      if (client?.deviceId) {
        console.log(`[ws] Device ${client.deviceId} disconnected`);
        broadcast({ type: 'device_offline', device_id: client.deviceId }, 'editor');
        publishDeviceState(client.deviceId);
      }
      clients.delete(ws);
    });

    ws.on('error', (err) => {
      console.error('[ws] Error:', err.message);
      clients.delete(ws);
    });
  });

  // Heartbeat — remove dead connections every 30s
  setInterval(() => {
    clients.forEach((client, ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      } else {
        clients.delete(ws);
      }
    });
  }, 30_000);

  return wss;
}

function handleMessage(ws: WebSocket, msg: any): void {
  switch (msg.type) {
    case 'hello': {
      const client = clients.get(ws)!;
      client.clientType = msg.client_type ?? 'api';
      client.deviceId = msg.device_id;
      console.log(`[ws] Hello from ${client.clientType}${client.deviceId ? ` (${client.deviceId})` : ''}`);
      send(ws, { type: 'hello_ack', server_version: '0.1.0' });

      // For browser clients, push the currently active page immediately
      if (client.clientType === 'browser') {
        try {
          const db = getDb();
          const row = db.prepare(`SELECT value FROM server_settings WHERE key = 'active_page_id'`).get() as any;
          const activePageId = row?.value;
          if (activePageId) {
            const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(activePageId) as any;
            if (page) {
              const panels = db.prepare('SELECT * FROM page_panels WHERE page_id=? ORDER BY position, id').all(activePageId);
              const pageData = { ...page, floating_config: page.floating_config ? JSON.parse(page.floating_config) : null, panels };
              send(ws, { type: 'load_page', page_id: activePageId, page_data: pageData });
            }
          }
        } catch (err) {
          console.warn('[ws] Failed to push active page on hello:', err);
        }
        // Publish updated device state to MQTT
        publishDeviceState(client.deviceId ?? 'local');
      }
      break;
    }

    case 'device_status': {
      const client = clients.get(ws);
      if (client) client.deviceId = msg.device_id;
      // Forward to all editor clients
      broadcast(msg, 'editor');
      break;
    }

    case 'command_ack': {
      broadcast({ type: 'command_ack', command_id: msg.command_id, device_id: msg.device_id }, 'editor');
      break;
    }

    case 'ping': {
      send(ws, { type: 'pong' });
      break;
    }

    case 'render_result': {
      const requestId = typeof msg.request_id === 'string' ? msg.request_id : '';
      const waiting = pendingRenderRequests.get(requestId);
      if (!waiting) break;
      clearTimeout(waiting.timer);
      pendingRenderRequests.delete(requestId);
      waiting.resolve({
        ok: msg.ok === true,
        page_id: String(msg.page_id ?? ''),
        phase: msg.ok === true ? 'rendered' : 'failed',
        ...(typeof msg.error === 'string' ? { error: msg.error } : {}),
      });
      break;
    }

    case 'local_action_result': {
      const requestId = typeof msg.request_id === 'string' ? msg.request_id : '';
      const waiting = pendingLocalActions.get(requestId);
      if (!waiting) break;
      clearTimeout(waiting.timer);
      pendingLocalActions.delete(requestId);
      if (msg.ok === true) waiting.resolve((msg.result as Record<string, unknown>) ?? {});
      else waiting.reject(new Error(typeof msg.error === 'string' ? msg.error : 'kiosk action failed'));
      break;
    }

    default:
      console.warn(`[ws] Unknown message type: ${msg.type}`);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Send a message to a specific WebSocket */
export function send(ws: WebSocket, msg: object): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

export function requestPageRender(
  pageId: string,
  pageData: Record<string, unknown>,
  timeoutMs = 75_000,
): Promise<RenderResult> {
  const browserClients = [...clients.values()].filter(
    client => client.clientType === 'browser' && client.ws.readyState === WebSocket.OPEN,
  );
  if (browserClients.length === 0) {
    return Promise.reject(new Error('no kiosk renderer is connected'));
  }
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRenderRequests.delete(requestId);
      reject(new Error(`renderer did not finish page ${pageId} within ${timeoutMs}ms`));
    }, timeoutMs);
    pendingRenderRequests.set(requestId, { resolve, timer });
    for (const client of browserClients) {
      send(client.ws, { type: 'load_page', request_id: requestId, page_id: pageId, page_data: pageData });
    }
  });
}

export function requestLocalAction(action: 'show' | 'hide', timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const browser = [...clients.values()].find(
    client => client.clientType === 'browser' && client.ws.readyState === WebSocket.OPEN,
  );
  if (!browser) return Promise.reject(new Error('no kiosk renderer is connected'));
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingLocalActions.delete(requestId);
      reject(new Error(`kiosk did not complete app.${action} within ${timeoutMs}ms`));
    }, timeoutMs);
    pendingLocalActions.set(requestId, { resolve, reject, timer });
    send(browser.ws, { type: 'local_action', request_id: requestId, action });
  });
}

/** Broadcast to all clients of a given type, or to a specific device */
export function broadcast(msg: object, target: ClientType | 'all' | string = 'all'): void {
  clients.forEach((client) => {
    if (client.ws.readyState !== WebSocket.OPEN) return;

    const shouldSend =
      target === 'all' ||
      client.clientType === target ||
      client.deviceId === target;

    if (shouldSend) {
      client.ws.send(JSON.stringify(msg));
    }
  });
}

/** Send a command to a specific device or all devices ('*') */
export function sendCommand(deviceId: string, command: object): void {
  if (deviceId === '*') {
    broadcast(command, 'browser');
  } else {
    clients.forEach((client) => {
      if (client.deviceId === deviceId) {
        send(client.ws, command);
      }
    });
  }
}

/** Get count of currently connected devices */
export function getConnectedDeviceIds(): string[] {
  const ids: string[] = [];
  clients.forEach((client) => {
    if (client.clientType === 'browser' && client.deviceId) {
      ids.push(client.deviceId);
    }
  });
  return ids;
}
