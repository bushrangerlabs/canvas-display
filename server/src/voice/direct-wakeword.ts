import { spawn } from 'child_process';
import { existsSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import path from 'path';
import { getDb } from '../db/index';
import { config } from '../config';
import { MicCapture } from './mic';
import { RemoteEndpoint } from './remote-endpoint';
import { decodeRemoteAudio } from './remote-audio-output';
import { getEdgeDeviceId } from './edge-identity';
import { WakeWordDetector } from './wakeword-local';
import { runVoiceTurn } from '../services/voice';
import { buildMpvAudioArgs } from './audio-utils.js';
import { EndOfSpeechDetector } from './end-of-speech';
import {
  setVoiceStateListening,
  setVoiceStateProcessing,
  setVoiceStateDone,
  setVoiceStateError,
} from '../routes/voice-state.js';

/** Read Core bridge URL + token from server_settings DB, falling back to env vars. */
export function getCoreBridgeConfig(): { baseUrl: string; token: string } {
  try {
    const db = getDb();
    const dbUrl = (db.prepare('SELECT value FROM server_settings WHERE key = ?').get('canvas_core_url') as { value: string } | undefined)?.value ?? '';
    const dbToken = (db.prepare('SELECT value FROM server_settings WHERE key = ?').get('edge_voice_token') as { value: string } | undefined)?.value ?? '';
    return {
      baseUrl: (dbUrl || process.env.CANVAS_CORE_URL || '').replace(/\/+$/, ''),
      token:   dbToken || process.env.CANVAS_EDGE_VOICE_TOKEN || '',
    };
  } catch {
    return {
      baseUrl: (process.env.CANVAS_CORE_URL || '').replace(/\/+$/, ''),
      token:   process.env.CANVAS_EDGE_VOICE_TOKEN || '',
    };
  }
}

export interface DirectWakewordSettings {
  enabled: boolean;
  micDevice: string;
  wakeWord: string;
  wakeThreshold: number;
  wakeAckEnabled: boolean;
  wakeAckSound: string;
  goodIntentEnabled: boolean;
  goodIntentSound: string;
  noIntentEnabled: boolean;
  noIntentSound: string;
}

export interface DirectWakewordState {
  status: 'disabled' | 'starting' | 'running' | 'processing' | 'error' | 'stopped';
  enabled: boolean;
  wakeWord: string;
  wakeThreshold: number;
  micDevice: string;
  remoteAudio?: ReturnType<RemoteEndpoint['getDiagnostics']>;
  lastDetectionAt?: string;
  lastError?: string;
}

const BUILTIN_WAKE_ACK_SOUNDS = new Set([
  'soft_chime',
  'glass_ping',
  'ready_up',
  'wood_tap',
  'digital_pop',
  'confirm_tone',
]);

let mic: MicCapture | RemoteEndpoint | null = null;
let outputAbort = new AbortController();
let turnAbort = new AbortController();
let detector: WakeWordDetector | null = null;
let state: DirectWakewordState = {
  status: 'stopped',
  enabled: true,
  wakeWord: 'hey_jarvis',
  wakeThreshold: 0.35,
  micDevice: 'default',
};
let activeSettings: DirectWakewordSettings = {
  enabled: true,
  micDevice: 'default',
  wakeWord: 'hey_jarvis',
  wakeThreshold: 0.35,
  wakeAckEnabled: false,
  wakeAckSound: '',
  goodIntentEnabled: true,
  goodIntentSound: '',
  noIntentEnabled: true,
  noIntentSound: '',
};

let captureChunks: Buffer[] = [];
let captureActive = false;
let captureTimer: NodeJS.Timeout | null = null;
let endOfSpeech: EndOfSpeechDetector | null = null;
let captureDecision: 'continue' | 'speech-ended' | 'no-speech' | 'maximum' = 'continue';
let captureFinishing = false;
let processing = false;
let ttsPlaying = false;
let ttsPlaybackStartedAt = 0;
let activeTurnId = 0;
let wakeAckProc: ReturnType<typeof spawn> | null = null;
let ttsProc: ReturnType<typeof spawn> | null = null;
let outputMutedForCapture = false;
let restartTimer: NodeJS.Timeout | null = null;
let restartBackoffMs = 2000;
let ignoreDetectionsUntil = 0;
const turnStartedAt = new Map<number, number>();

function audioEndpointControl(key: 'playback_volume' | 'treble_db' | 'mic_capture_gain' | 'mic_preemphasis', fallback: number): number {
  try {
    const controls = JSON.parse(dbGet('audio_endpoint_controls', '{}')) as Record<string, unknown>;
    const value = controls[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  } catch { return fallback; }
}

function dbGet(key: string, fallback: string): string {
  try {
    const row = getDb().prepare('SELECT value FROM server_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? fallback;
  } catch {
    return fallback;
  }
}

function resolveWakeAckSound(raw: string): string {
  const value = (raw ?? '').trim();
  if (value.startsWith('custom:')) {
    const fileName = value.slice('custom:'.length);
    return /^[a-f0-9]{64}\.(wav|mp3|ogg|flac)$/.test(fileName)
      ? path.join(config.dataDir, 'voice-cues', fileName)
      : '';
  }
  if (!value.startsWith('builtin:')) return value;

  const preset = value.slice('builtin:'.length).trim();
  if (!BUILTIN_WAKE_ACK_SOUNDS.has(preset)) return '';

  const fileName = `${preset}.wav`;
  const packagedPath = path.join(config.staticDir, 'audio', 'wake-ack', fileName);
  if (existsSync(packagedPath)) return packagedPath;

  const repoPublicPath = path.join(process.cwd(), '..', 'web', 'public', 'audio', 'wake-ack', fileName);
  if (existsSync(repoPublicPath)) return repoPublicPath;

  return packagedPath;
}

/**
 * ASR front-end enhancement for the raw centre-mic capture.
 *
 * Baseline finding (2026-10-06): the Sipeed array + Pico path captures the
 * user's speech with only ~2-3% of energy above 1 kHz (vs ~12% for normal
 * speech), so Whisper loses final consonants ("Big Ben" -> "big bend").
 * Pre-emphasis (y[n] = x[n] - k*x[n-1]) is the standard speech front-end that
 * compensates for the mic's high-frequency rolloff; the peak normalization
 * brings the quiet raw capture (-20 dBFS) up to a healthy ASR level.
 */
function enhanceCapture(pcm: Buffer, captureGain = 1, preemphasis = 0.95): Buffer {
  if (process.env.CANVAS_VOICE_ENHANCE === '0') return pcm;
  const envCoefficient = process.env.CANVAS_VOICE_PREEMPHASIS;
  const coefficient = envCoefficient === undefined ? preemphasis : Number(envCoefficient);
  const k = Number.isFinite(coefficient) ? Math.max(0, Math.min(0.99, coefficient)) : 0.95;
  const samples = pcm.length / 2;
  const floats = new Float32Array(samples);
  let prev = 0;
  let peak = 0;
  for (let i = 0; i < samples; i++) {
    const value = pcm.readInt16LE(i * 2);
    const emphasized = value - k * prev;
    floats[i] = emphasized;
    peak = Math.max(peak, Math.abs(emphasized));
    prev = value;
  }
  const targetPeak = Math.min(32000, 25000 * Math.max(0.5, Math.min(8, captureGain)));
  const gain = peak > 0 ? Math.min(10, targetPeak / peak) : 1;
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < samples; i++) {
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(floats[i] * gain))), i * 2);
  }
  return out;
}

function pcm16ToWav(pcm: Buffer, sampleRate = 16000, channels = 1): Buffer {
  const bitsPerSample = 16;
  const blockAlign = channels * bitsPerSample / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcm.copy(buffer, 44);
  return buffer;
}

function stopWakeAckPlayback(): void {
  if (!wakeAckProc) return;
  try {
    wakeAckProc.kill();
  } catch {
    // ignore
  }
  wakeAckProc = null;
}

function playCueSound(soundPath: string): Promise<void> {
  if (!soundPath) return Promise.resolve();
  if (mic instanceof RemoteEndpoint) {
    const endpoint = mic;
    const signal = outputAbort.signal;
    return decodeRemoteAudio(soundPath, signal).then(pcm => {
      signal.throwIfAborted();
      // Cues are confirmations, not speech: keep them quiet so their echo does
      // not drown out the user's command before AEC is implemented.
      return endpoint.play(pcm, 22050, 40);
    });
  }
  stopWakeAckPlayback();
  return new Promise(resolve => {
    let settled = false;
    let watchdog: NodeJS.Timeout | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      wakeAckProc = null;
      resolve();
    };
    try {
    wakeAckProc = spawn('mpv', buildMpvAudioArgs(100, soundPath), {
      stdio: 'ignore',
      detached: false,
    });
    const cueProc = wakeAckProc;
    wakeAckProc.once('close', finish);
    wakeAckProc.once('error', finish);
    watchdog = setTimeout(() => {
      console.warn('[wakeword:direct] Voice cue playback timed out');
      try { cueProc.kill('SIGKILL'); } catch { /* ignore */ }
      finish();
    }, 5_000);
  } catch (err) {
      console.warn('[wakeword:direct] Failed to play voice cue:', (err as Error).message);
      finish();
    }
  });
}

function setEndpointVoiceState(value: 'ready' | 'listening' | 'processing' | 'error'): void {
  if (mic instanceof RemoteEndpoint) mic.setVoiceState(value);
}

function builtinCue(name: string): string {
  return resolveWakeAckSound(`builtin:${name}`);
}

function containsLikelySpeech(pcm: Buffer): boolean {
  if (pcm.length < 8_000) return false;
  let sumSquares = 0;
  let peak = 0;
  let samples = 0;
  // Sampling every fourth PCM value keeps this inexpensive while covering the
  // complete utterance window.
  for (let offset = 0; offset + 1 < pcm.length; offset += 8) {
    const value = Math.abs(pcm.readInt16LE(offset));
    peak = Math.max(peak, value);
    sumSquares += value * value;
    samples++;
  }
  const rms = samples > 0 ? Math.sqrt(sumSquares / samples) : 0;
  console.log(`[wakeword:direct] Capture activity rms=${Math.round(rms)} peak=${peak}`);
  return peak >= 1_200 && rms >= 120;
}

function stopTtsPlayback(): void {
  outputAbort.abort();
  outputAbort = new AbortController();
  if (mic instanceof RemoteEndpoint) mic.cancelPlayback();
  ttsPlaying = false;
  ttsPlaybackStartedAt = 0;
  if (!ttsProc) return;
  try {
    ttsProc.kill();
  } catch {
    // ignore
  }
  ttsProc = null;
}

function setSystemOutputMuted(muted: boolean): Promise<void> {
  // Prefer PulseAudio/PipeWire mute control, fall back to ALSA master mute.
  const cmd = muted
    ? `pactl set-sink-mute @DEFAULT_SINK@ 1 || amixer -q set Master mute`
    : `pactl set-sink-mute @DEFAULT_SINK@ 0 || amixer -q set Master unmute`;
  return new Promise(resolve => {
    const child = spawn('sh', ['-lc', cmd], { stdio: 'ignore', detached: false });
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  });
}

async function muteOutputForCapture(): Promise<void> {
  if (mic instanceof RemoteEndpoint) return;
  if (outputMutedForCapture) return;
  outputMutedForCapture = true;
  await setSystemOutputMuted(true);
}

async function unmuteOutputAfterCapture(): Promise<void> {
  if (!outputMutedForCapture) return;
  outputMutedForCapture = false;
  await setSystemOutputMuted(false);
}

function playCorePcm(pcm: Buffer, rate: number): Promise<void> {
  if (!(mic instanceof RemoteEndpoint)) return playTtsAudioBuffer(pcm16ToWav(pcm, rate));
  const signal = outputAbort.signal;
  ttsPlaying = true;
  ttsPlaybackStartedAt = Date.now();
  return mic.play(pcm, rate, audioEndpointControl('playback_volume', Number(dbGet('voice_tts_volume', '80'))))
    .finally(() => { if (signal === outputAbort.signal) ttsPlaying = false; });
}

function playTtsAudioBuffer(audio: Buffer): Promise<void> {
  if (!audio.length) return Promise.resolve();
  if (mic instanceof RemoteEndpoint) {
    const endpoint = mic;
    const signal = outputAbort.signal;
    const volume = audioEndpointControl('playback_volume', Number(dbGet('voice_tts_volume', '80')));
    ttsPlaying = true;
    ttsPlaybackStartedAt = Date.now();
    return decodeRemoteAudio(audio, signal).then(pcm => {
      signal.throwIfAborted();
      return endpoint.play(pcm, 22050, volume);
    })
      .finally(() => { if (signal === outputAbort.signal) ttsPlaying = false; });
  }
  stopTtsPlayback();

  const tmpFile = path.join('/tmp', `canvas-display-tts-${Date.now()}.wav`);
  const volume = Math.max(0, Math.min(100, Number.parseInt(dbGet('voice_tts_volume', '80'), 10) || 80));

  return new Promise(resolve => {
    let settled = false;
    let playbackProc: ReturnType<typeof spawn> | null = null;
    let watchdog: NodeJS.Timeout | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      if (ttsProc === playbackProc) {
        ttsProc = null;
      }
      ttsPlaying = false;
      try {
        unlinkSync(tmpFile);
      } catch {
        // ignore temp cleanup errors
      }
      resolve();
    };

    try {
      writeFileSync(tmpFile, audio);
      ttsProc = spawn('mpv', buildMpvAudioArgs(volume, tmpFile), {
        stdio: 'ignore',
        detached: false,
      });
      playbackProc = ttsProc;
      ttsPlaying = true;
      ttsPlaybackStartedAt = Date.now();
      ttsProc.once('close', finish);
      ttsProc.once('error', (err) => {
        console.warn('[wakeword:direct] Failed to play TTS audio:', err.message);
        finish();
      });
      // mpv normally exits on drain. This watchdog guarantees a wedged audio
      // backend cannot hold the voice state machine in processing forever.
      const bytesPerSecond = 22_050 * 2;
      const estimatedMs = Math.max(1_000, Math.round(audio.length / bytesPerSecond * 1_000));
      watchdog = setTimeout(() => {
        console.warn('[wakeword:direct] TTS playback timed out; returning to wake-word listening');
        try { playbackProc?.kill('SIGKILL'); } catch { /* ignore */ }
        finish();
      }, Math.min(120_000, estimatedMs + 8_000));
    } catch (err) {
      console.warn('[wakeword:direct] Failed to play TTS audio:', (err as Error).message);
      finish();
    }
  });
}

async function runCoreVoiceTurn(wav: Buffer, turnId: string): Promise<{
  transcript: string;
  reply: string;
  audioBase64?: string;
  timings?: { asrMs: number; routingMs: number; planningMs: number; ttsMs: number; totalMs: number };
  intent?: { intent?: string };
  show_url?: string;
  knowledge_card?: { title: string; body: string; source_url?: string; source_label?: string; image_url?: string; show_url?: string };
}> {
  const { baseUrl, token } = getCoreBridgeConfig();
  if (!baseUrl || !token) {
    throw new Error('Core voice bridge is not configured');
  }
  const response = await fetch(`${baseUrl}/api/edge/voice/turn`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      audioBase64: wav.toString('base64'),
      deviceId: getEdgeDeviceId(),
      turnId,
    }),
    signal: AbortSignal.any([turnAbort.signal, AbortSignal.timeout(120_000)]),
  });
  const result = await response.json() as {
    transcript?: string;
    reply?: string;
    audioBase64?: string;
    detail?: string;
    error?: string;
    timings?: { asrMs: number; routingMs: number; planningMs: number; ttsMs: number; totalMs: number };
    intent?: { intent?: string };
    knowledge_card?: { title: string; body: string; source_url?: string; source_label?: string; image_url?: string; show_url?: string };
    show_url?: string;
  };
  if (!response.ok) {
    throw new Error(result.detail ?? result.error ?? `Core voice returned HTTP ${response.status}`);
  }
  // If Core included a knowledge card, store it in the local display server
  if (result.knowledge_card?.title && result.knowledge_card?.body) {
    const localPort = process.env.PORT ?? '3100';
    void fetch(`http://127.0.0.1:${localPort}/api/knowledge-card`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(result.knowledge_card),
    }).catch(() => undefined);
  }
  return {
    transcript: result.transcript ?? '',
    reply: result.reply ?? '',
    audioBase64: result.audioBase64,
    timings: result.timings,
    intent: result.intent,
    knowledge_card: result.knowledge_card,
    show_url: result.show_url ?? result.knowledge_card?.show_url,
  };
}

type CoreTurnResult = Awaited<ReturnType<typeof runCoreVoiceTurn>>;
type StreamPlayback = { firstPlaybackMs: number; playbackMs: number; ttsMs: number };

async function runCoreVoiceTurnStream(
  wav: Buffer,
  turnId: string,
  wakeStartedAt: number,
): Promise<CoreTurnResult & { streamed: StreamPlayback }> {
  const { baseUrl, token } = getCoreBridgeConfig();
  const signal = AbortSignal.any([turnAbort.signal, AbortSignal.timeout(120_000)]);
  const response = await fetch(`${baseUrl}/api/edge/voice/turn-stream`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ audioBase64: wav.toString('base64'), turnId,
      deviceId: getEdgeDeviceId() }),
    signal,
  });
  if (!response.ok || !response.body) throw new Error(`Core streaming voice returned HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let meta: CoreTurnResult = { transcript: '', reply: '' };
  let firstPlaybackMs = -1;
  let playbackMs = 0;
  let ttsMs = 0;
  let goodCuePlayed = false;
  for (;;) {
    const { value, done } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    signal.throwIfAborted();
    if (done && pending && !pending.endsWith('\n')) pending += '\n';
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      signal.throwIfAborted();
      if (!line.trim()) continue;
      const event = JSON.parse(line) as Record<string, any>;
      if (event.type === 'error') throw new Error(String(event.error ?? 'streaming voice failed'));
      if (event.type === 'transcript' && typeof event.transcript === 'string') {
        meta.transcript = event.transcript;
        if (meta.transcript.trim() && activeSettings.goodIntentEnabled && !goodCuePlayed) {
          await playCueSound(activeSettings.goodIntentSound);
          goodCuePlayed = true;
        }
      }
      if (event.type === 'meta') {
        const kc = event.knowledge_card as { title: string; body: string; source_url?: string; source_label?: string; image_url?: string; show_url?: string } | null | undefined;
        meta = {
          transcript: String(event.transcript ?? ''),
          reply: String(event.reply ?? ''),
          intent: event.intent,
          timings: event.timings,
          show_url: event.show_url ?? kc?.show_url,
          knowledge_card: kc ?? undefined,
        };
        // Push knowledge card to local display server immediately on receipt
        if (kc?.title && kc?.body) {
          const localPort = process.env.PORT ?? '3100';
          void fetch(`http://127.0.0.1:${localPort}/api/knowledge-card`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(kc),
          }).catch(() => undefined);
        }
        if (meta.transcript.trim() && activeSettings.goodIntentEnabled && !goodCuePlayed) {
          await playCueSound(activeSettings.goodIntentSound);
          goodCuePlayed = true;
        }
      } else if (event.type === 'audio' && typeof event.audioBase64 === 'string') {
        const raw = Buffer.from(event.audioBase64, 'base64');
        const rate = Number.parseInt(process.env.CANVAS_CORE_TTS_SAMPLE_RATE ?? '22050', 10) || 22_050;
        if (firstPlaybackMs < 0) firstPlaybackMs = Math.round(performance.now() - wakeStartedAt);
        const started = performance.now();
        await playCorePcm(raw, rate);
        playbackMs += performance.now() - started;
      } else if (event.type === 'end') ttsMs = Number(event.ttsMs) || 0;
    }
    if (done) break;
  }
  return { ...meta, streamed: { firstPlaybackMs, playbackMs: Math.round(playbackMs), ttsMs } };
}

async function reportVoiceMetrics(metrics: Record<string, unknown>): Promise<void> {
  const { baseUrl, token } = getCoreBridgeConfig();
  if (!baseUrl || !token) return;
  try {
    await fetch(`${baseUrl}/api/edge/voice/metrics`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...metrics,
        deviceId: getEdgeDeviceId(),
      }),
    });
  } catch (error) {
    console.warn('[wakeword:direct] Failed to report voice metrics:', (error as Error).message);
  }
}

function clearCaptureTimer(): void {
  if (!captureTimer) return;
  clearTimeout(captureTimer);
  captureTimer = null;
}

function clearRestartTimer(): void {
  if (!restartTimer) return;
  clearTimeout(restartTimer);
  restartTimer = null;
}

function resetRestartBackoff(): void {
  restartBackoffMs = 2000;
}

function scheduleRestart(reason: string): void {
  if (!state.enabled || restartTimer) return;

  const delay = restartBackoffMs;
  restartBackoffMs = Math.min(restartBackoffMs * 2, 30_000);
  state.status = 'starting';
  state.lastError = reason;

  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (!state.enabled) return;
    void stopDirectWakeword()
      .then(() => startDirectWakeword())
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        state.status = 'error';
        state.lastError = message;
        scheduleRestart(message);
      });
  }, delay);
}

function loadSettingsFromDb(): DirectWakewordSettings {
  const wakeThresholdRaw = dbGet('voice_integration_wake_threshold', '0.35');
  const wakeThresholdParsed = Number(wakeThresholdRaw);
  const wakeThreshold = Number.isFinite(wakeThresholdParsed)
    ? Math.max(0, Math.min(1, wakeThresholdParsed))
    : 0.35;

  // DB setting `voice_integration_wake_enabled` takes explicit priority:
  // if the user has explicitly enabled wake-word in settings, honour it even
  // when the Tauri binary passes CANVAS_DISABLE_DIRECT_WAKEWORD=1 (old binaries
  // set this env var unconditionally).
  const dbWakeEnabled = dbGet('voice_integration_wake_enabled', '1');
  const envDisabled = process.env.CANVAS_DISABLE_DIRECT_WAKEWORD === '1';
  const wakeEnabled = dbWakeEnabled === '1' ? true : (envDisabled ? false : dbWakeEnabled !== '0');

  return {
    enabled: wakeEnabled,
    micDevice: dbGet('voice_mic_device', 'default'),
    wakeWord: dbGet('voice_integration_wake_word', dbGet('voice_wake_word', 'hey_jarvis')),
    wakeThreshold,
    wakeAckEnabled: dbGet('voice_wake_ack_enabled', '0') === '1',
    wakeAckSound: resolveWakeAckSound(dbGet('voice_wake_ack_sound', '')),
    goodIntentEnabled: dbGet('voice_good_intent_enabled', '1') === '1',
    goodIntentSound: resolveWakeAckSound(dbGet('voice_good_intent_sound', 'builtin:digital_pop')),
    noIntentEnabled: dbGet('voice_no_intent_enabled', '1') === '1',
    noIntentSound: resolveWakeAckSound(dbGet('voice_no_intent_sound', 'builtin:wood_tap')),
  };
}

async function finishCaptureAndRunTurn(turnId: number): Promise<void> {
  if (captureFinishing) return;
  captureFinishing = true;
  const correlationId = randomUUID();
  const wakeStartedAt = turnStartedAt.get(turnId) ?? performance.now();
  turnStartedAt.delete(turnId);
  clearCaptureTimer();
  const captureMs = endOfSpeech?.durationMs ?? 0;
  const pcm = Buffer.concat(captureChunks);
  captureChunks = [];
  captureActive = false;
  endOfSpeech = null;
  await unmuteOutputAfterCapture();
  if (turnId !== activeTurnId) return;

  if (process.env.CANVAS_VOICE_SAVE_CAPTURE === '1') {
    try {
      const file = path.join('/tmp', `canvas-capture-${correlationId}.wav`);
      writeFileSync(file, pcm16ToWav(pcm));
      console.log(`[wakeword:direct] Saved capture to ${file} bytes=${pcm.length}`);
    } catch (error) {
      console.warn('[wakeword:direct] Failed to save capture:', (error as Error).message);
    }
  }

  if (captureDecision === 'no-speech' || !containsLikelySpeech(pcm)) {
    if (activeSettings.noIntentEnabled) {
      await playCueSound(activeSettings.noIntentSound).catch(() => undefined);
    }
    if (turnId !== activeTurnId) return;
    processing = false;
    state.status = 'running';
    setEndpointVoiceState('ready');
    detector?.restart();
    ignoreDetectionsUntil = Date.now() + 1_500;
    captureFinishing = false;
    console.warn('[wakeword:direct] No speech received after wake-word trigger');
    return;
  }

  try {
    setEndpointVoiceState('processing');
    const enhanced = enhanceCapture(pcm, audioEndpointControl('mic_capture_gain', 1), audioEndpointControl('mic_preemphasis', 0.95));
    const wav = pcm16ToWav(enhanced);
    if (process.env.CANVAS_VOICE_SAVE_CAPTURE === '1') {
      try {
        const file = path.join('/tmp', `canvas-capture-enhanced-${correlationId}.wav`);
        writeFileSync(file, wav);
      } catch { /* diagnostic only */ }
    }
    console.log('[wakeword:direct] Captured audio, running direct voice turn');
    const coreBridgeConfigured = Boolean(
      (() => { const { baseUrl, token } = getCoreBridgeConfig(); return baseUrl && token; })(),
    );
    const coreRequestStartedAt = performance.now();
    const streamingEnabled = coreBridgeConfigured && process.env.CANVAS_CORE_STREAMING_TTS !== '0';
    setVoiceStateProcessing(correlationId);
    const result = streamingEnabled
      ? await runCoreVoiceTurnStream(wav, correlationId, wakeStartedAt)
      : coreBridgeConfigured
        ? await runCoreVoiceTurn(wav, correlationId)
      : await runVoiceTurn({
          audio: wav,
          filename: 'wakeword.wav',
          contentType: 'audio/wav',
          speak: true,
        });
    const coreRoundTripMs = Math.round(performance.now() - coreRequestStartedAt);
    if (turnId !== activeTurnId) return;
    const transcript = typeof result.transcript === 'string' ? result.transcript : '';
    if (!transcript.trim()) {
      if (activeSettings.noIntentEnabled) {
        await playCueSound(activeSettings.noIntentSound);
      }
      state.status = 'running';
      state.lastError = undefined;
      console.warn('[wakeword:direct] Core returned an empty transcript');
      return;
    }

    // A good-intent cue means ASR actually produced usable text, not merely
    // that the microphone crossed its energy threshold.
    if (!('streamed' in result) && activeSettings.goodIntentEnabled) {
      await playCueSound(activeSettings.goodIntentSound);
    }
    if (turnId !== activeTurnId) return;
    const hermesResult = 'hermesResult' in result
      ? result.hermesResult as { speech?: string; text?: string } | undefined
      : undefined;
    const piperResult = 'piperResult' in result
      ? result.piperResult as { audioBase64?: string } | undefined
      : undefined;
    const coreAudio = 'audioBase64' in result && typeof result.audioBase64 === 'string'
      ? result.audioBase64
      : undefined;

    if ('streamed' in result) {
      const streamResult = result as CoreTurnResult & { streamed: StreamPlayback };
      const totalMs = Math.round(performance.now() - wakeStartedAt);
      const timings = streamResult.timings;
      console.log(
        `[wakeword:direct] Voice latency turn=${correlationId} capture_ms=${captureMs} ` +
        `core_round_trip_ms=${coreRoundTripMs} first_playback_ms=${streamResult.streamed.firstPlaybackMs} ` +
        `playback_ms=${streamResult.streamed.playbackMs} total_ms=${totalMs} streaming=1`,
      );
      void reportVoiceMetrics({ turnId: correlationId, intent: streamResult.intent?.intent, captureMs,
        asrMs: timings?.asrMs, routingMs: timings?.routingMs, planningMs: timings?.planningMs,
        ttsMs: streamResult.streamed.ttsMs, coreRoundTripMs, firstPlaybackMs: streamResult.streamed.firstPlaybackMs,
        playbackMs: streamResult.streamed.playbackMs, totalMs });
    }

    if (piperResult?.audioBase64 || coreAudio) {
      try {
        const audioBuffer = Buffer.from(piperResult?.audioBase64 ?? coreAudio ?? '', 'base64');
        // Core's Wyoming Piper provider currently transports raw mono PCM. Piper
        // voices normally emit 22.05 kHz; wrapping it as microphone-rate 16 kHz
        // stretches the response and makes speech noticeably slow/low-pitched.
        const configuredTtsRate = Number.parseInt(
          process.env.CANVAS_CORE_TTS_SAMPLE_RATE ?? '22050',
          10,
        );
        const ttsRate = Number.isFinite(configuredTtsRate) && configuredTtsRate >= 8_000
          ? configuredTtsRate
          : 22_050;
        const playable = coreAudio ? pcm16ToWav(audioBuffer, ttsRate) : audioBuffer;
        // The wake detector remains active during playback to support barge-in.
        // Capture itself still has exclusive access to microphone audio.
        const playbackStartedAt = performance.now();
        const firstPlaybackMs = Math.round(playbackStartedAt - wakeStartedAt);
        if (coreAudio) await playCorePcm(audioBuffer, ttsRate);
        else await playTtsAudioBuffer(playable);
        const playbackMs = Math.round(performance.now() - playbackStartedAt);
        const totalMs = Math.round(performance.now() - wakeStartedAt);
        const coreTimings = 'timings' in result
          ? result.timings as { asrMs?: number; routingMs?: number; planningMs?: number; ttsMs?: number } | undefined
          : undefined;
        console.log(
          `[wakeword:direct] Voice latency turn=${correlationId} ` +
          `wake_to_core_request_ms=${Math.round(coreRequestStartedAt - wakeStartedAt)} ` +
          `core_round_trip_ms=${coreRoundTripMs} first_playback_ms=${firstPlaybackMs} ` +
          `playback_ms=${playbackMs} total_ms=${totalMs} ` +
          `core_asr_ms=${coreTimings?.asrMs ?? -1} core_routing_ms=${coreTimings?.routingMs ?? -1} ` +
          `core_planning_ms=${coreTimings?.planningMs ?? -1} core_tts_ms=${coreTimings?.ttsMs ?? -1}`,
        );
        void reportVoiceMetrics({
          turnId: correlationId,
          intent: 'intent' in result
            ? (result.intent as { intent?: string } | undefined)?.intent
            : undefined,
          captureMs,
          asrMs: coreTimings?.asrMs,
          routingMs: coreTimings?.routingMs,
          planningMs: coreTimings?.planningMs,
          ttsMs: coreTimings?.ttsMs,
          coreRoundTripMs,
          firstPlaybackMs,
          playbackMs,
          totalMs,
        });
      } catch (err) {
        if (mic instanceof RemoteEndpoint) throw err;
        console.warn('[wakeword:direct] Failed to decode TTS audio:', (err as Error).message);
      }
    }

    console.log('[wakeword:direct] Transcript:', transcript || '(empty)');
    console.log('[wakeword:direct] Core reply:', 'reply' in result ? result.reply : (hermesResult?.speech ?? hermesResult?.text ?? '(no response)'));
    const finalReply = 'reply' in result ? (result.reply as string ?? '') : (hermesResult?.speech ?? hermesResult?.text ?? '');
    const show_url = 'show_url' in result ? (result.show_url as string | undefined) : undefined;
    setVoiceStateDone(correlationId, transcript, finalReply, show_url);

    // If the intent was timer_set, push the timer command to the local display server
    const intentStr = 'intent' in result ? (result.intent as { intent?: string } | undefined)?.intent : undefined;
    if (intentStr === 'timer_set') {
      const toolArgs = 'intent' in result
        ? (result.intent as { tool_calls?: Array<{ arguments?: { duration_minutes?: number } }> } | undefined)?.tool_calls?.[0]?.arguments
        : undefined;
      const durationMinutes = toolArgs?.duration_minutes;
      if (durationMinutes && durationMinutes > 0) {
        const localPort = process.env.PORT ?? '3100';
        void fetch(`http://127.0.0.1:${localPort}/api/commands/timer`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ duration_seconds: Math.round(durationMinutes * 60), label: 'Timer' }),
        }).catch((err: Error) => console.warn('[wakeword:direct] Failed to set timer command:', err.message));
      }
    }

    state.status = 'running';
    state.lastError = undefined;
  } catch (err) {
    if (turnId !== activeTurnId || turnAbort.signal.aborted) return;
    const message = err instanceof Error ? err.message : String(err);
    state.status = 'error';
    state.lastError = message;
    setVoiceStateError(message);
    setEndpointVoiceState('error');
    console.error('[wakeword:direct] Voice turn failed:', message);
    if (activeSettings.noIntentEnabled) {
      await playCueSound(activeSettings.noIntentSound).catch(() => undefined);
    }
  } finally {
    if (turnId !== activeTurnId) return;
    // The detector subprocess can retain PCM in its stdin pipe while inference
    // catches up. Restart it after every turn to discard stale speaker/capture
    // audio and reset model state instead of allowing a delayed false wake.
    detector?.restart();
    // Also avoid feeding the immediate acoustic tail while the new model loads.
    ignoreDetectionsUntil = Date.now() + 1_500;
    processing = false;
    captureFinishing = false;
    if (state.status !== 'error') {
      state.status = 'running';
    }
    setEndpointVoiceState(state.status === 'error' ? 'error' : 'ready');
  }
}

async function handleWakewordDetected(): Promise<void> {
  if (!activeSettings.enabled || (processing && !ttsPlaying)) {
    return;
  }

  // A detector result can already be queued when TTS playback begins. Do not
  // treat that stale result as intentional barge-in and immediately cut off a
  // fresh response. Genuine barge-in remains available after this short guard.
  if (ttsPlaying && Date.now() - ttsPlaybackStartedAt < 1_000) {
    console.log('[wakeword:direct] Ignored queued wake-word detection at TTS playback start');
    return;
  }

  const interruptedTts = ttsPlaying;
  turnAbort.abort();
  turnAbort = new AbortController();
  const turnId = ++activeTurnId;
  turnStartedAt.set(turnId, performance.now());
  for (const staleTurnId of turnStartedAt.keys()) {
    if (staleTurnId < turnId) turnStartedAt.delete(staleTurnId);
  }
  if (interruptedTts) {
    console.log('[wakeword:direct] Wake word interrupted active TTS playback');
    stopTtsPlayback();
  }

  processing = true;
  state.status = 'processing';
  state.lastDetectionAt = new Date().toISOString();
  setEndpointVoiceState('listening');
  console.log('[wakeword:direct] Wake triggered; endpoint indicator=listening');
  setVoiceStateListening();
  captureChunks = [];
  captureDecision = 'continue';
  captureActive = false;
  captureFinishing = false;
  await unmuteOutputAfterCapture();
  if (turnId !== activeTurnId || turnAbort.signal.aborted) return;

  const wakeCue = activeSettings.wakeAckEnabled ? activeSettings.wakeAckSound : '';
  try { await playCueSound(wakeCue); } catch (error) {
    if (turnId !== activeTurnId) return;
    console.warn('[wakeword:direct] Remote cue failed:', (error as Error).message);
  }
  if (turnId !== activeTurnId || turnAbort.signal.aborted) return;

  // Capture a short utterance window after wake word trigger.
  await muteOutputForCapture();
  if (turnId !== activeTurnId || turnAbort.signal.aborted) return;
  endOfSpeech = new EndOfSpeechDetector({
    // Baseline tuning (2026-10-06): the previous 1.2 s wait-to-start and 650 ms
    // trailing silence closed the window mid-utterance for longer commands.
    // Keep the 8 s hard cap; revisit after repeated-turn acceptance.
    noSpeechTimeoutMs: 4000,
    trailingSilenceMs: 1000,
    minimumSpeechMs: 120,
    thresholdFloor: 120,
    noiseMultiplier: 1.5,
    thresholdOffset: 50,
  });
  captureActive = true;
  captureTimer = setTimeout(() => {
    void finishCaptureAndRunTurn(turnId);
  }, 8_100);
}

function attachMicAndDetector(): void {
  if (mic || detector) return;

  const host = dbGet('audio_endpoint_host', process.env.AUDIO_ENDPOINT_HOST ?? '').trim();
  mic = host ? new RemoteEndpoint({
    host,
    port: Number(dbGet('audio_endpoint_port', process.env.AUDIO_ENDPOINT_PORT ?? '8090')),
    token: dbGet('audio_endpoint_token', process.env.AUDIO_ENDPOINT_TOKEN ?? ''),
    deviceId: getEdgeDeviceId(),
    playbackTrebleDb: audioEndpointControl('treble_db', 6),
  }) : new MicCapture(activeSettings.micDevice);
  console.log(`[wakeword:direct] audio source=${host ? 'remote-pico' : 'local'}`);
  if (mic instanceof RemoteEndpoint) mic.on('status', status => {
    console.log('[wakeword:direct] endpoint', status);
    if (status === 'mic-disconnected') {
      activeTurnId++;
      turnAbort.abort();
      stopTtsPlayback();
      captureFinishing = false;
      clearCaptureTimer();
      captureActive = false;
      captureChunks = [];
      endOfSpeech = null;
      processing = false;
      state.status = 'starting';
      setEndpointVoiceState('ready');
    } else if (status === 'playback-disconnected') {
      stopTtsPlayback();
    } else if (status === 'mic-ready') {
      turnAbort = new AbortController();
      detector?.restart();
      state.status = 'running';
      setEndpointVoiceState('ready');
    }
  });
  detector = new WakeWordDetector(activeSettings.wakeWord, activeSettings.wakeThreshold);

  mic.on('data', (chunk: Buffer) => {
    // Wake-word path consumes the DSP output (gate/AGC) unchanged.
    if (processing) {
      if (ttsPlaying) detector?.feed(chunk);
      return;
    }
    if (Date.now() < ignoreDetectionsUntil) return;
    detector?.feed(chunk);
  });

  // Capture path consumes the raw centre mic (ch7), bypassing the gate/AGC
  // that can attenuate consonants and amplify room noise between words.
  mic.on('rawdata', (chunk: Buffer) => {
    if (processing && captureActive) {
      captureChunks.push(chunk);
      const decision = endOfSpeech?.push(chunk) ?? 'continue';
      if (decision !== 'continue') {
        captureDecision = decision;
        const diagnostics = endOfSpeech?.diagnostics;
        console.log(`[wakeword:direct] Capture completed reason=${decision} duration_ms=${endOfSpeech?.durationMs ?? 0} rms=${diagnostics?.rms ?? 0} noise_floor=${diagnostics?.noiseFloor ?? 0} speech_threshold=${diagnostics?.speechThreshold ?? 0}`);
        void finishCaptureAndRunTurn(activeTurnId);
      }
    }
  });

  mic.on('error', (err: Error) => {
    state.status = 'error';
    state.lastError = err.message;
    setEndpointVoiceState('error');
    console.error('[wakeword:direct] Microphone error:', err.message);
    if (!(mic instanceof RemoteEndpoint)) scheduleRestart(`Microphone error: ${err.message}`);
  });

  mic.on('close', (code) => {
    if (state.enabled) {
      state.status = 'error';
      state.lastError = `Microphone process exited (${code ?? 'signal'})`;
      console.error('[wakeword:direct] Microphone process closed unexpectedly:', code);
      scheduleRestart(state.lastError);
    }
  });

  detector.on('ready', (activeModel: string) => {
    clearRestartTimer();
    resetRestartBackoff();
    if (activeModel) {
      state.wakeWord = activeModel;
    }
    state.status = 'running';
    state.lastError = undefined;
    console.log('[wakeword:direct] Listening for wake word:', activeModel || activeSettings.wakeWord);
  });

  detector.on('detected', (score: number) => {
    // Speaker leakage can be classified as a near-perfect wake-word match.
    // Without acoustic echo cancellation, never let playback stop itself.
    if (ttsPlaying) {
      console.log(`[wakeword:direct] Ignored wake-word match during TTS score=${score.toFixed(3)}`);
      return;
    }
    console.log(`[wakeword:direct] Wake word detected score=${score.toFixed(3)}`);
    void handleWakewordDetected();
  });

  detector.on('error', (err: Error) => {
    const message = err.message;
    if (message.includes('model') && message.includes('not found') && activeSettings.wakeWord !== 'hey_jarvis') {
      console.warn('[wakeword:direct] Selected wake word model is unavailable; falling back to hey_jarvis');
      updateDirectWakewordSettings({ wakeWord: 'hey_jarvis' });
      state.wakeWord = 'hey_jarvis';
      state.lastError = 'Selected wake word model unavailable; using hey_jarvis fallback.';
      state.status = 'starting';
      setTimeout(() => {
        void stopDirectWakeword().then(() => {
          // Keep the in-memory fallback for this process. Calling startDirectWakeword() here
          // would immediately reload the unavailable persisted model and create a restart loop.
          updateDirectWakewordSettings({ wakeWord: 'hey_jarvis' });
          state.status = 'starting';
          attachMicAndDetector();
        });
      }, 300);
      return;
    }

    state.status = 'error';
    state.lastError = message;
    console.error('[wakeword:direct] Detector error:', message);
    scheduleRestart(`Detector error: ${message}`);
  });

  detector.on('close', (code) => {
    if (state.enabled) {
      state.status = 'error';
      state.lastError = `Wake-word detector exited (${code ?? 'signal'})`;
      console.error('[wakeword:direct] Detector process closed unexpectedly:', code);
      scheduleRestart(state.lastError);
    }
  });

  mic.start();
  detector.start();
}

async function detachMicAndDetector(): Promise<void> {
  turnAbort.abort();
  activeTurnId++;
  clearCaptureTimer();
  stopWakeAckPlayback();
  stopTtsPlayback();
  await unmuteOutputAfterCapture();
  captureChunks = [];
  captureActive = false;
  endOfSpeech = null;
  captureFinishing = false;
  processing = false;
  ttsPlaying = false;
  ttsPlaybackStartedAt = 0;

  if (detector) {
    detector.removeAllListeners();
    detector.stop();
    detector = null;
  }

  if (mic) {
    const m = mic;
    mic = null;
    m.removeAllListeners();
    await m.stop();
  }
}

export function isDirectWakewordEnabled(): boolean {
  return dbGet('voice_integration_wake_enabled', '1') === '1';
}

export function getDirectWakewordState(): DirectWakewordState {
  return { ...state, ...(mic instanceof RemoteEndpoint ? { remoteAudio: mic.getDiagnostics() } : {}) };
}

export function updateDirectWakewordSettings(settings: Partial<DirectWakewordSettings>): void {
  const nextThresholdRaw = settings.wakeThreshold ?? activeSettings.wakeThreshold;
  const nextThreshold = Number.isFinite(nextThresholdRaw)
    ? Math.max(0, Math.min(1, nextThresholdRaw))
    : activeSettings.wakeThreshold;

  activeSettings = {
    ...activeSettings,
    ...settings,
    wakeThreshold: nextThreshold,
    wakeAckSound: settings.wakeAckSound !== undefined ? resolveWakeAckSound(settings.wakeAckSound) : activeSettings.wakeAckSound,
    goodIntentSound: settings.goodIntentSound !== undefined ? resolveWakeAckSound(settings.goodIntentSound) : activeSettings.goodIntentSound,
    noIntentSound: settings.noIntentSound !== undefined ? resolveWakeAckSound(settings.noIntentSound) : activeSettings.noIntentSound,
  };
  state.enabled = activeSettings.enabled;
  state.micDevice = activeSettings.micDevice;
  state.wakeWord = activeSettings.wakeWord;
  state.wakeThreshold = activeSettings.wakeThreshold;
}

export async function startDirectWakeword(): Promise<void> {
  const loaded = loadSettingsFromDb();
  updateDirectWakewordSettings(loaded);
  clearRestartTimer();

  if (!loaded.enabled) {
    state.status = 'disabled';
    resetRestartBackoff();
    return;
  }

  if (mic || detector) return;

  turnAbort = new AbortController();
  state.status = 'starting';
  state.enabled = true;
  state.micDevice = loaded.micDevice;
  state.wakeWord = loaded.wakeWord;
  state.wakeThreshold = loaded.wakeThreshold;
  console.log('[wakeword:direct] Starting local wake-word service');
  attachMicAndDetector();
}

export async function stopDirectWakeword(): Promise<void> {
  clearRestartTimer();
  resetRestartBackoff();
  state.enabled = false;
  state.status = 'stopped';
  await detachMicAndDetector();
  console.log('[wakeword:direct] Local wake-word service stopped');
}
