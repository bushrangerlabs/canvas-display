/**
 * Intercom Poller
 *
 * Polls Canvas Core's /api/edge/intercom/pending endpoint for audio messages
 * from other devices or admin broadcasts. When audio is received, it plays
 * it through the local audio output via POST /api/audio/play.
 */

import { getDb } from '../db/index.js';
import { writeFileSync, unlinkSync } from 'fs';
import path from 'path';
import { buildMpvAudioArgs, ensureWav } from './audio-utils.js';
import { spawn } from 'child_process';

let pollTimer: NodeJS.Timeout | null = null;
let destroyed = false;

function getCoreBridgeConfig(): { baseUrl: string; token: string; deviceId: string } {
  try {
    const db = getDb();
    const dbUrl = (db.prepare('SELECT value FROM server_settings WHERE key = ?').get('canvas_core_url') as { value: string } | undefined)?.value ?? '';
    const dbToken = (db.prepare('SELECT value FROM server_settings WHERE key = ?').get('edge_voice_token') as { value: string } | undefined)?.value ?? '';
    const edgeDeviceId = (db.prepare('SELECT value FROM server_settings WHERE key = ?').get('edge_device_id') as { value: string } | undefined)?.value ?? '';
    const fallbackId = (db.prepare('SELECT value FROM server_settings WHERE key = ?').get('device_id') as { value: string } | undefined)?.value ?? '';
    const deviceId = edgeDeviceId || fallbackId;
    return {
      baseUrl: (dbUrl || process.env.CANVAS_CORE_URL || '').replace(/\/+$/, ''),
      token: dbToken || process.env.CANVAS_EDGE_VOICE_TOKEN || '',
      deviceId: deviceId || process.env.CANVAS_EDGE_DEVICE_ID || 'unknown',
    };
  } catch {
    return {
      baseUrl: (process.env.CANVAS_CORE_URL || '').replace(/\/+$/, ''),
      token: process.env.CANVAS_EDGE_VOICE_TOKEN || '',
      deviceId: process.env.CANVAS_EDGE_DEVICE_ID ?? 'unknown',
    };
  }
}

async function pollPending(): Promise<void> {
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

    // Write to temp WAV file and play via mpv (same approach as TTS broadcast)
    const tmpFile = path.join('/tmp', `canvas-intercom-${Date.now()}.wav`);
    const ttsRate = Number.parseInt(process.env.CANVAS_CORE_TTS_SAMPLE_RATE ?? '22050', 10);
    const buffer = ensureWav(Buffer.from(data.audioBase64, 'base64'), Number.isFinite(ttsRate) ? ttsRate : 22_050);
    try {
      writeFileSync(tmpFile, buffer);
      const volume = Number(process.env.CANVAS_TTS_VOLUME ?? process.env.TTS_VOLUME ?? 85);
      const mpvArgs = buildMpvAudioArgs(volume, tmpFile);
      const proc = spawn('mpv', mpvArgs, { detached: false, stdio: 'ignore' });
      proc.on('exit', () => { try { unlinkSync(tmpFile); } catch { /* ignore */ } });
      proc.on('error', (err) => {
        console.error('[intercom] mpv error:', err.message);
        try { unlinkSync(tmpFile); } catch { /* ignore */ }
      });
    } catch (err) {
      console.error('[intercom] failed to play audio:', (err as Error).message);
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  } catch {
    // silently ignore — Core may not be reachable
  }
}

export function startIntercomPoller(): void {
  if (pollTimer) return;
  destroyed = false;
  const interval = Number(process.env.INTERCOM_POLL_MS ?? 3_000);
  pollTimer = setInterval(() => {
    if (!destroyed) void pollPending();
  }, Math.max(2_000, interval));
  console.log('[intercom] poller started');
}

export function stopIntercomPoller(): void {
  destroyed = true;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
