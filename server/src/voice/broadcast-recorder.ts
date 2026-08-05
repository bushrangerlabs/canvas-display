/**
 * Broadcast Recorder
 *
 * Records audio from the local microphone and uploads it to Core as an
 * intercom broadcast.  All connected edge devices (including this one) will
 * receive and play the audio via their intercom pollers.
 *
 * Trigger via:
 *   POST /api/voice/broadcast          { duration?: number (seconds, default 8) }
 *   POST /api/voice/broadcast/stop     (stop early)
 *   Voice intent: "broadcast"
 */

import { getDb } from '../db/index.js';
import { MicCapture } from './mic.js';
import { ensureWav } from './audio-utils.js';

export type BroadcastState = 'idle' | 'recording' | 'uploading';

let state: BroadcastState = 'idle';
let activeMic: MicCapture | null = null;
let stopEarly: (() => void) | null = null;

export function getBroadcastState(): BroadcastState {
  return state;
}

export function isBroadcasting(): boolean {
  return state !== 'idle';
}

function getConfig(): { coreUrl: string; token: string; deviceId: string; micDevice: string } {
  try {
    const db = getDb();
    const get = (key: string) =>
      (db.prepare('SELECT value FROM server_settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? '';
    return {
      coreUrl: (get('canvas_core_url') || process.env.CANVAS_CORE_URL || '').replace(/\/+$/, ''),
      token: get('edge_voice_token') || process.env.CANVAS_EDGE_VOICE_TOKEN || '',
      deviceId: get('edge_device_id') || get('device_id') || process.env.CANVAS_EDGE_DEVICE_ID || 'unknown',
      micDevice: get('audio_mic_device') || process.env.CANVAS_MIC_DEVICE || 'default',
    };
  } catch {
    return {
      coreUrl: (process.env.CANVAS_CORE_URL || '').replace(/\/+$/, ''),
      token: process.env.CANVAS_EDGE_VOICE_TOKEN || '',
      deviceId: process.env.CANVAS_EDGE_DEVICE_ID || 'unknown',
      micDevice: process.env.CANVAS_MIC_DEVICE || 'default',
    };
  }
}

async function uploadAudio(wav: Buffer, from: string, coreUrl: string, token: string): Promise<void> {
  const res = await fetch(`${coreUrl}/api/edge/intercom/broadcast`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      audioBase64: wav.toString('base64'),
      from,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Core returned ${res.status}: ${body}`);
  }
}

/**
 * Start recording a broadcast.
 * Returns once the audio is uploaded (or an error occurs).
 *
 * @param durationMs  Maximum recording duration in milliseconds (default 8 s)
 */
export async function startBroadcast(durationMs = 8_000): Promise<{ ok: boolean; error?: string }> {
  if (state !== 'idle') return { ok: false, error: 'Already recording or uploading' };

  const cfg = getConfig();
  if (!cfg.coreUrl || !cfg.token) {
    return { ok: false, error: 'Core URL or voice token not configured' };
  }

  const bounded = Math.max(1_000, Math.min(30_000, durationMs));
  const mic = new MicCapture(cfg.micDevice);
  const chunks: Buffer[] = [];
  activeMic = mic;
  state = 'recording';

  console.log(`[broadcast] recording for up to ${bounded / 1000}s on device=${cfg.micDevice}`);

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, bounded);

      stopEarly = () => {
        clearTimeout(timer);
        resolve();
      };

      mic.on('data', (chunk: Buffer) => chunks.push(chunk));
      mic.once('error', (err: Error) => {
        clearTimeout(timer);
        stopEarly = null;
        reject(err);
      });
      mic.start();
    });
  } catch (err) {
    state = 'idle';
    activeMic = null;
    stopEarly = null;
    await mic.stop().catch(() => {});
    return { ok: false, error: (err as Error).message };
  }

  stopEarly = null;
  await mic.stop().catch(() => {});
  activeMic = null;

  const pcm = Buffer.concat(chunks);
  if (!pcm.length) {
    state = 'idle';
    return { ok: false, error: 'No audio captured from microphone' };
  }

  // Mic captures 16 kHz mono S16LE
  const wav = ensureWav(pcm, 16_000, 1);
  state = 'uploading';

  console.log(`[broadcast] uploading ${Math.round(wav.length / 1024)} KB of audio`);

  try {
    await uploadAudio(wav, cfg.deviceId, cfg.coreUrl, cfg.token);
    console.log('[broadcast] uploaded — relayed to all devices');
    state = 'idle';
    return { ok: true };
  } catch (err) {
    console.error('[broadcast] upload failed:', (err as Error).message);
    state = 'idle';
    return { ok: false, error: (err as Error).message };
  }
}

/** Stop recording early and immediately trigger the upload with whatever was captured. */
export function stopBroadcast(): void {
  if (stopEarly) {
    stopEarly();
    stopEarly = null;
  }
}
