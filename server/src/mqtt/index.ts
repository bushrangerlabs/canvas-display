/**
 * MQTT client for Canvas Display.
 *
 * Publishes device state and subscribes to command topics so any
 * automation platform (HA, ioBroker, Node-RED, etc.) can control
 * the kiosk without needing a custom integration.
 *
 * Topic schema:
 *   canvas_display/{device_id}/state              ← retained, published on connect/disconnect
 *   canvas_display/{device_id}/panel/{pos}/url    ← retained, published when panel URL changes
 *   canvas_display/{device_id}/cmd/page           ← subscribe { page_id }
 *   canvas_display/{device_id}/cmd/navigate       ← subscribe { panel_id, url }
 *   canvas_display/{device_id}/cmd/reload         ← subscribe {}
 *   canvas_display/{device_id}/cmd/quit           ← subscribe {}
 */

import * as mqttLib from 'mqtt';
import { getDb } from '../db/index';
import { broadcast, getConnectedDeviceIds } from '../ws/index';
import { getAudioState } from '../routes/audio';

let client: mqttLib.MqttClient | null = null;
let _enabled = false;

// ── Settings helpers ────────────────────────────────────────────────────

function getSetting(key: string): string | null {
  try {
    const row = getDb().prepare('SELECT value FROM server_settings WHERE key = ?').get(key) as any;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export function getMqttSettings() {
  return {
    enabled:  getSetting('mqtt_enabled') === '1',
    url:      getSetting('mqtt_broker_url') ?? 'mqtt://localhost:1883',
    username: getSetting('mqtt_username') ?? undefined,
    password: getSetting('mqtt_password') ?? undefined,
  };
}

// ── Connect / Disconnect ─────────────────────────────────────────────────

export async function connectMqtt(): Promise<void> {
  const settings = getMqttSettings();
  if (!settings.enabled) {
    console.log('[mqtt] Disabled — skipping connection');
    return;
  }

  if (client && client.connected) {
    console.log('[mqtt] Already connected');
    return;
  }

  console.log(`[mqtt] Connecting to ${settings.url}`);

  client = mqttLib.connect(settings.url, {
    username: settings.username,
    password: settings.password,
    clientId: `canvas-ui-platform-${Math.random().toString(16).slice(2, 8)}`,
    reconnectPeriod: 5000,
    connectTimeout: 10_000,
    will: {
      topic: 'canvas_display/server/state',
      payload: JSON.stringify({ online: false }),
      retain: true,
      qos: 1,
    },
  });

  _enabled = true;

  client.on('connect', () => {
    console.log('[mqtt] Connected');
    publishServerState(true);
    subscribeCommandTopics();
    publishAllDeviceStates();
  });

  client.on('message', handleCommandMessage);

  client.on('error', (err) => {
    console.error('[mqtt] Error:', err.message);
  });

  client.on('reconnect', () => {
    console.log('[mqtt] Reconnecting…');
  });

  client.on('offline', () => {
    console.warn('[mqtt] Client offline');
  });
}

export function disconnectMqtt(): void {
  if (client) {
    publishServerState(false);
    client.end(true);
    client = null;
    _enabled = false;
    console.log('[mqtt] Disconnected');
  }
}

/** Call this when MQTT settings change — reconnect with new config. */
export async function reconnectMqtt(): Promise<void> {
  disconnectMqtt();
  await connectMqtt();
}

// ── Publish helpers ──────────────────────────────────────────────────────

function publish(topic: string, payload: object, retain = false): void {
  if (!client?.connected) return;
  client.publish(topic, JSON.stringify(payload), { retain, qos: 1 });
}

function publishServerState(online: boolean): void {
  publish('canvas_display/server/state', { online }, true);
}

export function publishDeviceState(deviceId: string): void {
  if (!client?.connected) return;
  try {
    const db = getDb();

    // Use the settings-based device_id for MQTT topics
    const mqttDeviceId = getSetting('device_id') ?? deviceId;
    const deviceName  = getSetting('device_name') ?? 'Canvas Display';
    const activePageId = getSetting('active_page_id') ?? '';

    const page = activePageId
      ? db.prepare('SELECT id, name FROM pages WHERE id = ?').get(activePageId) as any
      : null;

    const connectedIds = getConnectedDeviceIds();
    const online = connectedIds.length > 0;

    publish(`canvas_display/${mqttDeviceId}/state`, {
      online,
      device_id: mqttDeviceId,
      name: deviceName,
      page_id: page?.id ?? null,
      page_name: page?.name ?? null,
    }, true);

    // Publish panel URLs for the active page
    if (page) {
      const panels = db.prepare(
        'SELECT * FROM page_panels WHERE page_id = ? ORDER BY position'
      ).all(page.id) as any[];

      for (const panel of panels) {
        if (panel.url) {
          publish(`canvas_display/${mqttDeviceId}/panel/${panel.position}/url`, { url: panel.url }, true);
        }
      }
    }
  } catch (err) {
    console.warn('[mqtt] publishDeviceState error:', err);
  }
}

export function publishPanelUrl(deviceId: string, panelPosition: number, url: string): void {
  publish(`canvas_display/${deviceId}/panel/${panelPosition}/url`, { url }, true);
}

function publishAllDeviceStates(): void {
  try {
    const mqttDeviceId = getSetting('device_id') ?? 'local';
    publishDeviceState(mqttDeviceId);
  } catch { /* db may not be ready */ }
}

// ── Subscribe & handle commands ──────────────────────────────────────────

function subscribeCommandTopics(): void {
  if (!client) return;
  client.subscribe('canvas_display/+/cmd/+', { qos: 1 }, (err) => {
    if (err) console.error('[mqtt] Subscribe error:', err.message);
    else console.log('[mqtt] Subscribed to canvas_display/+/cmd/+');
  });
}

/** Publish current audio state as a retained message. Called by audio routes after state changes. */
export function publishAudioState(): void {
  const mqttDeviceId = getSetting('device_id') ?? 'local';
  publish(`canvas_display/${mqttDeviceId}/audio/state`, getAudioState(), true);
}

function handleCommandMessage(topic: string, payload: Buffer): void {
  // topic: canvas_ui/{device_id_or_name}/cmd/{action}
  const parts = topic.split('/');
  if (parts.length !== 4 || parts[0] !== 'canvas_display' || parts[2] !== 'cmd') return;

  const topicDevice = parts[1];
  const action = parts[3];

  // Accept either device_id or device_name in the topic
  const myDeviceId   = getSetting('device_id')   ?? 'local';
  const myDeviceName = getSetting('device_name')  ?? '';
  if (topicDevice !== myDeviceId && topicDevice.toLowerCase() !== myDeviceName.toLowerCase()) {
    return; // not for us
  }

  let data: Record<string, any> = {};
  try {
    data = JSON.parse(payload.toString());
  } catch { /* empty payload is fine */ }

  console.log(`[mqtt] Command → device=${topicDevice} action=${action} data=${JSON.stringify(data)}`);

  // Helper: resolve a page by id or name
  function resolvePage(db: ReturnType<typeof getDb>): any | null {
    if (data.page_id) {
      return db.prepare('SELECT * FROM pages WHERE id = ?').get(data.page_id) as any ?? null;
    }
    if (data.page) {
      return db.prepare('SELECT * FROM pages WHERE LOWER(name) = LOWER(?)').get(data.page) as any ?? null;
    }
    return null;
  }

  // Helper: resolve a panel by id or name (optionally scoped to a page)
  function resolvePanel(db: ReturnType<typeof getDb>, pageId?: string): any | null {
    if (data.panel_id) {
      return db.prepare('SELECT * FROM page_panels WHERE id = ?').get(data.panel_id) as any ?? null;
    }
    if (data.panel) {
      if (pageId) {
        return db.prepare(
          'SELECT * FROM page_panels WHERE page_id = ? AND LOWER(name) = LOWER(?)'
        ).get(pageId, data.panel) as any ?? null;
      }
      return db.prepare(
        'SELECT * FROM page_panels WHERE LOWER(name) = LOWER(?)'
      ).get(data.panel) as any ?? null;
    }
    return null;
  }

  switch (action) {
    case 'page': {
      // Accepts: { page_id: "TcKt4uwqgn" }  OR  { page: "test2" }
      try {
        const db = getDb();
        const page = resolvePage(db);
        if (!page) {
          console.warn('[mqtt] page command: page not found', data);
          return;
        }
        db.prepare(`UPDATE server_settings SET value=?, updated_at=datetime('now') WHERE key='active_page_id'`).run(page.id);
        const panels = db.prepare(
          'SELECT * FROM page_panels WHERE page_id = ? ORDER BY position, id'
        ).all(page.id);
        const pageData = {
          ...page,
          floating_config: page.floating_config ? JSON.parse(page.floating_config) : null,
          panels,
        };
        broadcast({ type: 'load_page', page_id: page.id, page_data: pageData }, 'browser');
        publishDeviceState(myDeviceId);
      } catch (err) {
        console.error('[mqtt] page command error:', err);
      }
      break;
    }

    case 'navigate': {
      // Accepts: { panel_id: "0g-MsqRASv", url: "..." }
      //      OR: { panel: "a2", url: "..." }
      //      OR: { panel: "a2", page: "test2", url: "..." }  (disambiguate same name on different pages)
      if (!data.url) { console.warn('[mqtt] navigate: missing url'); return; }
      try {
        const db = getDb();
        // Resolve page scope if provided (for disambiguation)
        let scopePageId: string | undefined;
        if (data.page_id || data.page) {
          const scopePage = resolvePage(db);
          scopePageId = scopePage?.id;
        }
        const panel = resolvePanel(db, scopePageId);
        if (!panel) {
          console.warn('[mqtt] navigate command: panel not found', data);
          return;
        }
        broadcast({
          type: 'command',
          action: 'navigate_panel',
          payload: { panel_id: panel.id, url: data.url },
        }, 'browser');
      } catch (err) {
        console.error('[mqtt] navigate command error:', err);
      }
      break;
    }

    case 'reload':
      broadcast({ type: 'command', action: 'reload', payload: {} }, 'browser');
      break;

    case 'quit':
      broadcast({ type: 'command', action: 'show_quit_dialog', payload: {} }, 'browser');
      break;

    case 'audio': {
      // Accepts: { action: 'play', url: '...', title?: '...', volume?: 75 }
      //          { action: 'pause' | 'resume' | 'stop' }
      //          { action: 'volume', level: 75 }
      //          { action: 'mute', muted: true }
      const audioAction = data.action as string | undefined;
      if (!audioAction) { console.warn('[mqtt] audio cmd: missing action'); return; }
      // Delegate to the REST layer by running the same logic inline
      import('../routes/audio').then(async (audioMod) => {
        try {
          switch (audioAction) {
            case 'play': {
              if (!data.url) { console.warn('[mqtt] audio play: missing url'); return; }
              // Reuse server-side helpers via a lightweight fetch to our own API
              const { default: http } = await import('http');
              const body = JSON.stringify({ url: data.url, title: data.title, volume: data.volume });
              const req2 = http.request({ host: '127.0.0.1', port: 3100, path: '/api/audio/play', method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
              req2.write(body); req2.end();
              break;
            }
            case 'pause':  { const { default: http } = await import('http'); http.request({ host: '127.0.0.1', port: 3100, path: '/api/audio/pause',  method: 'POST' }).end(); break; }
            case 'resume': { const { default: http } = await import('http'); http.request({ host: '127.0.0.1', port: 3100, path: '/api/audio/resume', method: 'POST' }).end(); break; }
            case 'stop':   { const { default: http } = await import('http'); http.request({ host: '127.0.0.1', port: 3100, path: '/api/audio/stop',   method: 'POST' }).end(); break; }
            case 'volume': {
              const { default: http } = await import('http');
              const body = JSON.stringify({ level: data.level ?? 75 });
              const req2 = http.request({ host: '127.0.0.1', port: 3100, path: '/api/audio/volume', method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
              req2.write(body); req2.end();
              break;
            }
            case 'mute': {
              const { default: http } = await import('http');
              const body = JSON.stringify({ muted: data.muted ?? true });
              const req2 = http.request({ host: '127.0.0.1', port: 3100, path: '/api/audio/mute', method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
              req2.write(body); req2.end();
              break;
            }
            default:
              console.warn(`[mqtt] audio: unknown action: ${audioAction}`);
          }
        } catch (err) {
          console.error('[mqtt] audio command error:', err);
        }
      }).catch(err => console.error('[mqtt] audio import error:', err));
      break;
    }

    default:
      console.warn(`[mqtt] Unknown command action: ${action}`);
  }
}

export function isMqttConnected(): boolean {
  return client?.connected ?? false;
}
