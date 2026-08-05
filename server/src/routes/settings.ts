/**
 * Settings routes — manage server_settings key/value store.
 *
 * GET  /api/settings          → all settings (passwords redacted)
 * PUT  /api/settings          → bulk update { key: value, ... }
 * GET  /api/settings/mqtt     → MQTT connection status
 * POST /api/settings/mqtt/reconnect → apply new MQTT settings live
 */

import { FastifyInstance } from 'fastify';
import { getDb } from '../db/index';
import { connectMqtt, disconnectMqtt, reconnectMqtt, getMqttSettings, isMqttConnected } from '../mqtt/index';
import { startVoiceServer, stopVoiceServer, getVoiceState, updateVoiceSettings } from '../voice/index';
import {
  getDirectWakewordState,
  startDirectWakeword,
  stopDirectWakeword,
} from '../voice/direct-wakeword';
import { claimVoiceOwnership, getVoiceOwnerStatus, releaseVoiceOwnership } from '../voice/ownership';
import { listMicrophones } from '../voice/mic';
import { MicCapture } from '../voice/mic';
import { WakeWordDetector, listInstalledWakeWords } from '../voice/wakeword-local';
import { guardAdmin } from './admin-gate';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import { config } from '../config';

const execFileAsync = promisify(execFile);

// Keys that exist and their defaults
const SETTING_DEFAULTS: Record<string, string> = {
  device_name:          'Canvas UI Device',
  server_port:          '3100',
  canvas_core_url:      process.env.CANVAS_CORE_URL ?? '',
  edge_voice_token:     process.env.CANVAS_EDGE_VOICE_TOKEN ?? '',
  edge_device_id:       process.env.CANVAS_EDGE_DEVICE_ID ?? '',
  mqtt_enabled:         '0',
  mqtt_broker_url:      'mqtt://localhost:1883',
  mqtt_username:        '',
  mqtt_password:        '',
  voice_enabled:        '0',
  voice_mic_device:     'default',
  audio_speaker_device: 'default',
  audio_mic_volume:     '80',
  voice_wake_word:      'hey_jarvis',
  voice_integration_wake_enabled: '1',
  voice_integration_wake_word: 'hey_jarvis',
  voice_integration_wake_threshold: '0.5',
  voice_tts_volume:     '80',
  voice_wake_ack_enabled: '0',
  voice_wake_ack_sound:   '',
  voice_good_intent_enabled: '1',
  voice_good_intent_sound: 'builtin:digital_pop',
  voice_no_intent_enabled: '1',
  voice_no_intent_sound:   'builtin:wood_tap',
  voice_port:           '6053',
  voice_friendly_name:  'Canvas Display',
  voice_ha_url:         'http://homeassistant.local:8123',  // DEPRECATED (Phase 4): not used by the ESPHome satellite voice pipeline
  voice_ha_token:       '',                                    // DEPRECATED (Phase 4): not used by the ESPHome satellite voice pipeline
  voice_pipeline_id:    '',
  youtube_api_key:      '',
  youtube_region_code:  'AU',
  youtube_relevance_language: 'en',
  youtube_safe_search:  'strict',
};

const REDACTED_KEYS = new Set(['mqtt_password', 'voice_ha_token', 'youtube_api_key', 'edge_voice_token']);

function getAllSettings(): Record<string, string> {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM server_settings').all() as any[];
  const stored: Record<string, string> = {};
  for (const row of rows) stored[row.key] = row.value;

  // Merge with defaults for any missing keys
  const result: Record<string, string> = { ...SETTING_DEFAULTS, ...stored };

  // Redact sensitive values
  for (const key of REDACTED_KEYS) {
    if (result[key]) result[key] = '••••••••';
  }
  return result;
}

function setSetting(key: string, value: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO server_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value);
}

export async function settingsRoutes(app: FastifyInstance) {

  // GET /api/settings — all settings (passwords redacted)
  app.get('/settings', async () => {
    return getAllSettings();
  });

  // PUT /api/settings — update one or more settings
  app.put<{ Body: Record<string, string> }>('/settings', async (req, reply) => {
    if (!guardAdmin(reply)) return;
    const body = req.body as Record<string, string>;

    const allowed = new Set(Object.keys(SETTING_DEFAULTS));
    const updated: string[] = [];

    for (const [key, value] of Object.entries(body)) {
      if (!allowed.has(key)) continue;
      // Don't overwrite password if sent as redacted placeholder
      if (REDACTED_KEYS.has(key) && value === '••••••••') continue;
      setSetting(key, String(value));
      updated.push(key);
    }

    return { updated };
  });

  // GET /api/settings/mqtt — MQTT status
  app.get('/settings/mqtt', async () => {
    const settings = getMqttSettings();
    return {
      enabled: settings.enabled,
      url: settings.url,
      connected: isMqttConnected(),
    };
  });

  // POST /api/settings/mqtt/reconnect — apply new MQTT settings immediately
  // Not gated: local MQTT client management is an Edge Agent responsibility,
  // not a fleet/admin action.
  app.post('/settings/mqtt/reconnect', async (req, reply) => {
    await reconnectMqtt();
    reply.code(202);
    return { ok: true, connected: isMqttConnected() };
  });

  // POST /api/settings/mqtt/disconnect
  app.post('/settings/mqtt/disconnect', async (req, reply) => {
    disconnectMqtt();
    reply.code(202);
    return { ok: true };
  });

  // GET /api/settings/voice — voice satellite status
  app.get('/settings/voice', async () => {
    return getVoiceState();
  });

  // POST /api/settings/voice/restart — apply voice settings and (re)start
  app.post('/settings/voice/restart', async (req, reply) => {
    const s = getAllSettings();
    const enabled = s.voice_enabled === '1';
    if (!enabled) {
      await stopDirectWakeword();
      await stopVoiceServer();
      releaseVoiceOwnership();
      reply.code(202);
      return { ok: true, status: 'stopped' };
    }
    updateVoiceSettings({
      port:         parseInt(s.voice_port ?? '6053'),
      friendlyName: s.voice_friendly_name ?? '',
      micDevice:    s.voice_mic_device,
      wakeWord:     s.voice_wake_word,
      ttsVolume:    parseInt(s.voice_tts_volume),
      wakeAckEnabled: s.voice_wake_ack_enabled === '1',
      wakeAckSound: s.voice_wake_ack_sound ?? '',
      goodIntentEnabled: s.voice_good_intent_enabled === '1',
      goodIntentSound: s.voice_good_intent_sound ?? '',
      noIntentEnabled: s.voice_no_intent_enabled === '1',
      noIntentSound: s.voice_no_intent_sound ?? '',
    });
    const directCoreVoice = process.env.CANVAS_DISABLE_DIRECT_WAKEWORD !== '1'
      && Boolean((s.canvas_core_url || process.env.CANVAS_CORE_URL) && (s.edge_voice_token || process.env.CANVAS_EDGE_VOICE_TOKEN));
    await stopDirectWakeword();
    await stopVoiceServer();
    releaseVoiceOwnership();
    const mode = directCoreVoice ? 'core-direct' : 'ha-satellite';
    const owner = claimVoiceOwnership(mode);
    if (!owner.owned || owner.pid !== process.pid) {
      reply.code(409);
      return { ok: false, mode, status: 'ownership_conflict', owner };
    }
    if (directCoreVoice) await startDirectWakeword();
    else await startVoiceServer();
    reply.code(202);
    return {
      ok: true,
      mode: directCoreVoice ? 'core-direct' : 'ha-satellite',
      status: directCoreVoice ? getDirectWakewordState().status : getVoiceState().status,
      owner: getVoiceOwnerStatus(),
    };
  });

  // GET /api/settings/voice/microphones — list available ALSA capture devices
  app.get('/settings/voice/microphones', async () => {
    return listMicrophones();
  });

  // GET /api/settings/core-bridge — Canvas Core connection status (unredacted URL, token masked)
  app.get('/settings/core-bridge', async () => {
    const db = getDb();
    const dbUrl = (db.prepare('SELECT value FROM server_settings WHERE key = ?').get('canvas_core_url') as { value: string } | undefined)?.value ?? '';
    const dbToken = (db.prepare('SELECT value FROM server_settings WHERE key = ?').get('edge_voice_token') as { value: string } | undefined)?.value ?? '';
    const url = dbUrl || process.env.CANVAS_CORE_URL || '';
    const token = dbToken || process.env.CANVAS_EDGE_VOICE_TOKEN || '';
    const source = dbUrl || dbToken ? 'db' : (process.env.CANVAS_CORE_URL || process.env.CANVAS_EDGE_VOICE_TOKEN ? 'env' : 'none');
    return { url, tokenSet: Boolean(token), source };
  });

  // POST /api/settings/core-bridge/test — ping Core health endpoint
  app.post('/settings/core-bridge/test', async (req, reply) => {
    const db = getDb();
    const dbUrl = (db.prepare('SELECT value FROM server_settings WHERE key = ?').get('canvas_core_url') as { value: string } | undefined)?.value ?? '';
    const url = dbUrl || process.env.CANVAS_CORE_URL || '';
    if (!url) { reply.code(400); return { ok: false, error: 'No Core URL configured' }; }
    try {
      const res = await fetch(`${url.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) { reply.code(502); return { ok: false, error: `Core returned ${res.status}` }; }
      const body = await res.json() as Record<string, unknown>;
      return { ok: true, status: body };
    } catch (err) {
      reply.code(502);
      return { ok: false, error: (err as Error).message };
    }
  });

  // Audio diagnostics run in the display user's session. This is intentional:
  // PipeWire owns that session and the sandboxed Edge daemon must not borrow its
  // Pulse cookie/runtime directory.
  app.get('/settings/audio/devices', async () => {
    const microphones = (await listMicrophones()).map(({ id, label }) => ({ id, name: label }));
    const speakers: Array<{ id: string; name: string }> = [{ id: 'default', name: 'Default' }];
    try {
      const { stdout } = await execFileAsync('pactl', ['list', 'sinks', 'short']);
      for (const line of stdout.trim().split('\n')) {
        const id = line.split('\t')[1]?.trim();
        if (id && !speakers.some(item => item.id === id)) speakers.push({ id, name: id });
      }
    } catch { /* retain the default device */ }
    return { microphones, speakers };
  });

  app.post('/audio/test-mic', async (req, reply) => {
    const body = (req.body as {
      device?: string;
      duration_ms?: number;
      playback?: boolean;
      speaker_device?: string;
      volume?: number;
    } | undefined) ?? {};
    const durationMs = Math.max(500, Math.min(5_000, Math.round(body.duration_ms ?? 3_000)));
    const mic = new MicCapture(body.device?.trim() || 'default');
    const chunks: Buffer[] = [];
    const error = await new Promise<Error | null>(resolve => {
      let settled = false;
      const finish = (value: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void mic.stop();
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), durationMs);
      mic.on('data', (chunk: Buffer) => chunks.push(chunk));
      mic.once('error', (value: Error) => finish(value));
      mic.start();
    });
    if (error || chunks.length === 0) {
      return reply.code(500).send({ ok: false, error: error?.message || 'Microphone captured no audio' });
    }
    const pcm = Buffer.concat(chunks);
    const wav = Buffer.alloc(44 + pcm.length);
    wav.write('RIFF', 0); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16_000, 24); wav.writeUInt32LE(32_000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
    wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
    if (body.playback) {
      const path = join(tmpdir(), `canvas-mic-test-${randomUUID()}.wav`);
      await writeFile(path, wav);
      try {
        const args = ['--no-video', '--really-quiet', `--volume=${Math.max(0, Math.min(100, Math.round(body.volume ?? 90)))}`];
        if (body.speaker_device && body.speaker_device !== 'default') {
          args.push(`--audio-device=${body.speaker_device}`);
        }
        args.push(path);
        const code = await new Promise<number | null>((resolve, reject) => {
          const child = spawn('mpv', args, { stdio: 'ignore' });
          child.once('error', reject);
          child.once('close', resolve);
        });
        if (code !== 0) throw new Error(`edge microphone playback failed (mpv exited ${code})`);
      } finally {
        await unlink(path).catch(() => undefined);
      }
    }
    return {
      ok: true,
      format: 'wav',
      duration_ms: durationMs,
      sample: `base64:${wav.toString('base64')}`,
      played_on_device: Boolean(body.playback),
    };
  });

  app.post('/audio/test-speaker', async (req, reply) => {
    const body = (req.body as { device?: string; volume?: number } | undefined) ?? {};
    const device = body.device?.trim() || 'default';
    const volume = Math.max(0, Math.min(100, Math.round(body.volume ?? 90)));
    const url = 'http://127.0.0.1:3100/audio/wake-ack/confirm_tone.wav';
    const args = ['--no-video', '--really-quiet', `--volume=${volume}`];
    if (device !== 'default') args.push(`--audio-device=${device}`);
    args.push(url);
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn('mpv', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      child.once('error', reject);
      child.once('close', code => resolve({ code, stderr }));
    });
    if (result.code !== 0) {
      return reply.code(500).send({ ok: false, error: result.stderr.trim() || `mpv exited ${result.code}` });
    }
    return { ok: true, device, volume };
  });

  app.post('/settings/voice/cue-upload', async (req, reply) => {
    if (!guardAdmin(reply)) return;
    const body = (req.body as {
      data_base64?: string;
      content_type?: string;
      filename?: string;
    } | undefined) ?? {};
    const contentType = String(body.content_type ?? '').toLowerCase();
    const extensions: Record<string, string> = {
      'audio/wav': 'wav',
      'audio/x-wav': 'wav',
      'audio/mpeg': 'mp3',
      'audio/ogg': 'ogg',
      'audio/flac': 'flac',
    };
    const filenameExtension = String(body.filename ?? '').toLowerCase().match(/\.(wav|mp3|ogg|flac)$/)?.[1];
    const extension = extensions[contentType] ?? filenameExtension;
    if (!extension || !body.data_base64) {
      return reply.code(400).send({ ok: false, error: 'unsupported_audio_type' });
    }
    const bytes = Buffer.from(body.data_base64, 'base64');
    if (bytes.length === 0 || bytes.length > 2 * 1024 * 1024) {
      return reply.code(413).send({ ok: false, error: 'cue_must_be_between_1_byte_and_2mb' });
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    const cueDir = join(config.dataDir, 'voice-cues');
    const cuePath = join(cueDir, `${digest}.${extension}`);
    await mkdir(cueDir, { recursive: true });
    await writeFile(cuePath, bytes, { mode: 0o600 });
    return {
      ok: true,
      sound: `custom:${digest}.${extension}`,
      filename: String(body.filename ?? ''),
      size: bytes.length,
    };
  });

  app.post('/audio/test-cue', async (req, reply) => {
    const body = (req.body as { sound?: string; volume?: number } | undefined) ?? {};
    const raw = String(body.sound ?? '').trim();
    const sound = raw.startsWith('builtin:')
      ? join(config.staticDir, 'audio', 'wake-ack', `${raw.slice('builtin:'.length)}.wav`)
      : raw.startsWith('custom:')
        ? join(config.dataDir, 'voice-cues', raw.slice('custom:'.length))
        : '';
    const customCueDir = join(config.dataDir, 'voice-cues');
    const isBuiltin = sound.startsWith(join(config.staticDir, 'audio', 'wake-ack'));
    const isCustom = sound.startsWith(`${customCueDir}/`);
    if (!sound || (!isBuiltin && !isCustom)) {
      return reply.code(400).send({ ok: false, error: 'invalid_voice_cue' });
    }
    const volume = Math.max(0, Math.min(100, Math.round(body.volume ?? 90)));
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn('mpv', ['--no-video', '--really-quiet', `--volume=${volume}`, sound], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      child.once('error', reject);
      child.once('close', code => resolve({ code, stderr }));
    });
    if (result.code !== 0) {
      return reply.code(500).send({ ok: false, error: result.stderr.trim() || `mpv exited ${result.code}` });
    }
    return { ok: true };
  });

  app.get('/settings/voice/wakewords', async () => {
    return { wake_words: await listInstalledWakeWords() };
  });

  // One-shot hardware + model test used by Canvas Core's per-device diagnostics.
  app.post('/voice/wakeword-test', async (req, reply) => {
    const body = (req.body as {
      device?: string;
      wake_word?: string;
      threshold?: number;
      timeout_ms?: number;
    } | undefined) ?? {};
    const device = body.device?.trim() || 'default';
    const installed = await listInstalledWakeWords();
    const requestedWakeWord = body.wake_word?.trim() || 'hey_jarvis';
    const wakeWord = installed.some(model => model.id === requestedWakeWord)
      ? requestedWakeWord
      : (installed.find(model => model.id === 'hey_jarvis') ?? installed[0])?.id;
    if (!wakeWord) {
      return reply.code(503).send({
        ok: false,
        detected: false,
        error: 'No wake-word models are installed',
      });
    }
    const threshold = Math.max(0.1, Math.min(0.9, body.threshold ?? 0.5));
    const timeoutMs = Math.max(2_000, Math.min(30_000, Math.round(body.timeout_ms ?? 15_000)));
    const mic = new MicCapture(device);
    const detector = new WakeWordDetector(wakeWord, threshold);

    const result = await new Promise<{ detected: boolean; error?: string }>((resolve) => {
      let settled = false;
      const finish = (value: { detected: boolean; error?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        detector.stop();
        void mic.stop();
        resolve(value);
      };
      const timer = setTimeout(() => finish({ detected: false }), timeoutMs);
      detector.once('detected', () => finish({ detected: true }));
      detector.once('error', (error: Error) => finish({ detected: false, error: error.message }));
      mic.on('data', (chunk: Buffer) => detector.feed(chunk));
      mic.once('error', (error: Error) => finish({ detected: false, error: error.message }));
      detector.start();
      mic.start();
    });

    if (result.error) reply.code(400);
    return {
      ok: !result.error,
      detected: result.detected,
      wake_word: wakeWord,
      requested_wake_word: requestedWakeWord,
      fallback_used: wakeWord !== requestedWakeWord,
      threshold,
      timeout_ms: timeoutMs,
      error: result.error,
    };
  });
}
