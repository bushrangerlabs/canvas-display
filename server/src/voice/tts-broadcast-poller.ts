/**
 * TTS Broadcast Poller
 *
 * Polls Canvas Core's /api/edge/tts/pending endpoint for queued TTS audio
 * pushed by Core (e.g. via POST /api/edge/tts/broadcast).
 * When audio is found, plays it immediately via mpv (same mechanism as the
 * voice turn TTS playback in direct-wakeword.ts).
 */

import { spawn, type ChildProcess } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import path from 'path';
import { getDb } from '../db/index.js';

let pollTimer: NodeJS.Timeout | null = null;
let broadcastProc: ChildProcess | null = null;
let destroyed = false;

function getCoreBridgeConfig(): { baseUrl: string; token: string; deviceId: string } {
  try {
    const db = getDb();
    const dbUrl = (db.prepare('SELECT value FROM server_settings WHERE key = ?').get('canvas_core_url') as { value: string } | undefined)?.value ?? '';
    const dbToken = (db.prepare('SELECT value FROM server_settings WHERE key = ?').get('edge_voice_token') as { value: string } | undefined)?.value ?? '';
    return {
      baseUrl: (dbUrl || process.env.CANVAS_CORE_URL || '').replace(/\/+$/, ''),
      token: dbToken || process.env.CANVAS_EDGE_VOICE_TOKEN || '',
      deviceId: process.env.CANVAS_EDGE_DEVICE_ID ?? process.env.CANVAS_DEVICE_ID ?? 'unknown',
    };
  } catch {
    return {
      baseUrl: (process.env.CANVAS_CORE_URL || '').replace(/\/+$/, ''),
      token: process.env.CANVAS_EDGE_VOICE_TOKEN || '',
      deviceId: process.env.CANVAS_EDGE_DEVICE_ID ?? process.env.CANVAS_DEVICE_ID ?? 'unknown',
    };
  }
}

function playBroadcastAudio(audioBase64: string): void {
  if (broadcastProc && !broadcastProc.killed) {
    try { broadcastProc.kill('SIGTERM'); } catch { /* ignore */ }
    broadcastProc = null;
  }
  const tmpFile = path.join('/tmp', `canvas-broadcast-tts-${Date.now()}.wav`);
  const buffer = Buffer.from(audioBase64, 'base64');
  try {
    writeFileSync(tmpFile, buffer);
    const volume = Number(process.env.CANVAS_TTS_VOLUME ?? process.env.TTS_VOLUME ?? 85);
    const proc = spawn('mpv', ['--no-video', '--really-quiet', `--volume=${volume}`, tmpFile], {
      detached: false,
      stdio: 'ignore',
    });
    broadcastProc = proc;
    proc.on('exit', () => {
      if (broadcastProc === proc) broadcastProc = null;
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
    });
    proc.on('error', (err) => {
      console.error('[tts-broadcast] mpv error:', err.message);
      if (broadcastProc === proc) broadcastProc = null;
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
    });
  } catch (err) {
    console.error('[tts-broadcast] failed to play audio:', (err as Error).message);
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

async function pollPending(): Promise<void> {
  const { baseUrl, token, deviceId } = getCoreBridgeConfig();
  if (!baseUrl || !token) return;
  try {
    const res = await fetch(`${baseUrl}/api/edge/tts/pending?deviceId=${encodeURIComponent(deviceId)}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return;
    const data = await res.json() as { empty?: boolean; audioBase64?: string; text?: string };
    if (data.empty || !data.audioBase64) return;
    console.log(`[tts-broadcast] playing queued TTS: "${(data.text ?? '').slice(0, 60)}"`);
    playBroadcastAudio(data.audioBase64);
  } catch {
    // silently ignore — Core may not be reachable
  }
}

export function startTtsBroadcastPoller(): void {
  if (pollTimer) return;
  destroyed = false;
  const interval = Number(process.env.TTS_BROADCAST_POLL_MS ?? 5_000);
  pollTimer = setInterval(() => {
    if (!destroyed) void pollPending();
  }, Math.max(2_000, interval));
  console.log('[tts-broadcast] poller started');
}

export function stopTtsBroadcastPoller(): void {
  destroyed = true;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (broadcastProc && !broadcastProc.killed) {
    try { broadcastProc.kill('SIGTERM'); } catch { /* ignore */ }
    broadcastProc = null;
  }
}
