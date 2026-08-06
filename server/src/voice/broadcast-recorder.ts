/**
 * Broadcast Recorder
 *
 * Records audio from the local microphone and uploads it to Core as an
 * intercom broadcast.  All connected edge devices (including this one) will
 * receive and play the audio via their intercom pollers.
 *
 * Trigger via:
 *   POST /api/voice/broadcast   { duration?: number (seconds, default 8), prompt?: boolean | string }
 *   POST /api/voice/broadcast   { action: 'stop' }
 *   Voice intent: "broadcast"
 *
 * Default flow:
 *   1. Synthesise spoken prompt via Piper TTS → play via mpv
 *   2. Record mic for up to `duration` seconds
 *   3. Upload WAV to Core → relayed to all edge devices (including this one)
 */

import { writeFileSync, unlinkSync } from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import { getDb } from '../db/index.js';
import { MicCapture } from './mic.js';
import { ensureWav, buildMpvAudioArgs } from './audio-utils.js';
import { speakWithPiper } from '../services/voice.js';

export type BroadcastState = 'idle' | 'prompting' | 'recording' | 'uploading';

const DEFAULT_PROMPT = "What would you like to broadcast?";

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

/** Synthesise text via Piper and play via mpv. Resolves when playback finishes. */
async function playPrompt(text: string): Promise<void> {
  const volume = Number(process.env.CANVAS_TTS_VOLUME ?? process.env.TTS_VOLUME ?? 85);
  let tmpFile: string | null = null;
  try {
    const result = await speakWithPiper({ text });
    if (!result.audioBase64) {
      console.warn('[broadcast] TTS prompt returned no audio — skipping prompt');
      return;
    }
    tmpFile = path.join('/tmp', `canvas-broadcast-prompt-${Date.now()}.wav`);
    writeFileSync(tmpFile, ensureWav(Buffer.from(result.audioBase64, 'base64')));

    await new Promise<void>((resolve) => {
      const mpv = spawn('mpv', buildMpvAudioArgs(volume, tmpFile!), { stdio: 'ignore' });
      mpv.on('exit', () => resolve());
      mpv.on('error', (err) => { console.warn('[broadcast] mpv prompt error:', err.message); resolve(); });
    });
  } catch (err) {
    console.warn('[broadcast] prompt failed (continuing anyway):', (err as Error).message);
  } finally {
    if (tmpFile) try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

async function uploadAudio(wav: Buffer, from: string, coreUrl: string, token: string): Promise<void> {
  const res = await fetch(`${coreUrl}/api/edge/intercom/broadcast`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ audioBase64: wav.toString('base64'), from }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Core returned ${res.status}: ${await res.text().catch(() => '')}`);
}

export interface BroadcastOptions {
  /** Max recording duration in milliseconds (default 8 000) */
  durationMs?: number;
  /**
   * Spoken prompt played before recording starts.
   *   true (default)  → plays "What would you like to broadcast?"
   *   string          → plays a custom prompt
   *   false           → skip prompt, start recording immediately
   */
  prompt?: boolean | string;
}

/**
 * Start a broadcast: prompt → record → upload.
 * Back-compat: passing a plain number is treated as durationMs with default prompt.
 */
export async function startBroadcast(options: BroadcastOptions | number = {}): Promise<{ ok: boolean; error?: string }> {
  const opts: BroadcastOptions = typeof options === 'number' ? { durationMs: options } : options;
  const durationMs   = opts.durationMs ?? 8_000;
  const promptOption = opts.prompt ?? true;

  if (state !== 'idle') return { ok: false, error: 'Already recording or uploading' };

  const cfg = getConfig();
  if (!cfg.coreUrl || !cfg.token) return { ok: false, error: 'Core URL or voice token not configured' };

  const bounded = Math.max(1_000, Math.min(30_000, durationMs));

  // ── 1. Prompt ───────────────────────────────────────────────────────────────
  if (promptOption !== false) {
    state = 'prompting';
    const promptText = typeof promptOption === 'string' ? promptOption : DEFAULT_PROMPT;
    console.log(`[broadcast] prompting: "${promptText}"`);
    await playPrompt(promptText);
    await new Promise(r => setTimeout(r, 300)); // brief gap so mic doesn't catch TTS tail
  }

  // ── 2. Record ───────────────────────────────────────────────────────────────
  const mic = new MicCapture(cfg.micDevice);
  const chunks: Buffer[] = [];
  activeMic = mic;
  state = 'recording';
  console.log(`[broadcast] recording for up to ${bounded / 1000}s on device=${cfg.micDevice}`);

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, bounded);
      stopEarly = () => { clearTimeout(timer); resolve(); };
      mic.on('data', (chunk: Buffer) => chunks.push(chunk));
      mic.once('error', (err: Error) => { clearTimeout(timer); stopEarly = null; reject(err); });
      mic.start();
    });
  } catch (err) {
    state = 'idle'; activeMic = null; stopEarly = null;
    await mic.stop().catch(() => {});
    return { ok: false, error: (err as Error).message };
  }

  stopEarly = null;
  await mic.stop().catch(() => {});
  activeMic = null;

  const pcm = Buffer.concat(chunks);
  if (!pcm.length) { state = 'idle'; return { ok: false, error: 'No audio captured from microphone' }; }

  // ── 3. Upload ───────────────────────────────────────────────────────────────
  state = 'uploading';
  const wav = ensureWav(pcm, 16_000, 1);
  console.log(`[broadcast] uploading ${Math.round(wav.length / 1024)} KB`);

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

/** Stop recording early and immediately trigger upload with whatever was captured. */
export function stopBroadcast(): void {
  if (stopEarly) { stopEarly(); stopEarly = null; }
}
