/**
 * Intercom Poller
 *
 * Polls Canvas Core's /api/edge/intercom/pending endpoint for audio messages
 * from other devices or admin broadcasts. When audio is received, it plays
 * it through the local audio output via POST /api/audio/play.
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
    const res = await fetch(
      `${baseUrl}/api/edge/intercom/pending?deviceId=${encodeURIComponent(deviceId)}`,
      {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!res.ok) return;
    const data = await res.json() as { empty?: boolean; audioBase64?: string; from?: string; timestamp?: string };
    if (data.empty || !data.audioBase64) return;

    console.log(`[intercom] received audio from=${data.from ?? 'unknown'}`);

    // Play audio via the local audio endpoint
    await fetch(`http://127.0.0.1:${localPort}/api/audio/play`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioBase64: data.audioBase64, source: 'intercom' }),
      signal: AbortSignal.timeout(4_000),
    });
  } catch {
    // silently ignore — Core may not be reachable
  }
}

export function startIntercomPoller(localPort = 8099): void {
  if (pollTimer) return;
  destroyed = false;
  const interval = Number(process.env.INTERCOM_POLL_MS ?? 3_000);
  pollTimer = setInterval(() => {
    if (!destroyed) void pollPending(localPort);
  }, Math.max(2_000, interval));
  console.log('[intercom] poller started');
}

export function stopIntercomPoller(): void {
  destroyed = true;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
