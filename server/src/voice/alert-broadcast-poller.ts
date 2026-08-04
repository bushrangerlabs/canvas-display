/**
 * Alert Broadcast Poller
 *
 * Polls Canvas Core's /api/edge/alert/pending endpoint for pushed alerts
 * (e.g. doorbell notifications, admin-broadcast messages).
 * When an alert is received, it is injected into the local display server
 * via POST /api/alert so the AnnouncementWidget shows it.
 */

import { getDb } from '../db/index.js';

let pollTimer: NodeJS.Timeout | null = null;
let destroyed = false;

function getCoreBridgeConfig(): { baseUrl: string; token: string; deviceId: string } {
  try {
    const db = getDb();
    const dbUrl = (db.prepare('SELECT value FROM server_settings WHERE key = ?').get('canvas_core_url') as { value: string } | undefined)?.value ?? '';
    const dbToken = (db.prepare('SELECT value FROM server_settings WHERE key = ?').get('edge_voice_token') as { value: string } | undefined)?.value ?? '';
    const deviceId = (db.prepare('SELECT value FROM server_settings WHERE key = ?').get('device_id') as { value: string } | undefined)?.value ?? '';
    return {
      baseUrl: (dbUrl || process.env.CANVAS_CORE_URL || '').replace(/\/+$/, ''),
      token: dbToken || process.env.CANVAS_EDGE_VOICE_TOKEN || '',
      deviceId: (deviceId || process.env.CANVAS_EDGE_DEVICE_ID) ?? 'unknown',
    };
  } catch {
    return {
      baseUrl: (process.env.CANVAS_CORE_URL || '').replace(/\/+$/, ''),
      token: process.env.CANVAS_EDGE_VOICE_TOKEN || '',
      deviceId: process.env.CANVAS_EDGE_DEVICE_ID ?? 'unknown',
    };
  }
}

async function pollPending(localPort: number): Promise<void> {
  const { baseUrl, token, deviceId } = getCoreBridgeConfig();
  if (!baseUrl || !token) return;
  try {
    const res = await fetch(`${baseUrl}/api/edge/alert/pending?deviceId=${encodeURIComponent(deviceId)}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return;
    const data = await res.json() as {
      empty?: boolean;
      title?: string;
      message?: string;
      type?: string;
      camera_entity?: string;
      timestamp?: string;
    };
    if (data.empty || !data.message) return;

    console.log(`[alert-broadcast] received alert: "${data.message.slice(0, 60)}"`);

    // Inject into local display server alert API
    await fetch(`http://127.0.0.1:${localPort}/api/alert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: data.title ?? 'Alert',
        message: data.message,
        type: data.type ?? 'info',
        camera_entity: data.camera_entity,
        duration: 15,
      }),
      signal: AbortSignal.timeout(4_000),
    });
  } catch {
    // silently ignore — Core may not be reachable
  }
}

export function startAlertBroadcastPoller(localPort = 8099): void {
  if (pollTimer) return;
  destroyed = false;
  const interval = Number(process.env.ALERT_BROADCAST_POLL_MS ?? 4_000);
  pollTimer = setInterval(() => {
    if (!destroyed) void pollPending(localPort);
  }, Math.max(2_000, interval));
  console.log('[alert-broadcast] poller started');
}

export function stopAlertBroadcastPoller(): void {
  destroyed = true;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
