/**
 * Voice assistant lifecycle — start/stop the ESPHome voice satellite.
 *
 * Settings are persisted in the server_settings DB table (managed via the
 * Settings UI).  Env vars are used as fallbacks when no DB row exists yet.
 *
 * Architecture (OHF-Voice/linux-voice-assistant method):
 *   - Python satellite listens on TCP port 6053 (ESPHome native API protocol)
 *   - HA connects TO the satellite (reverse of the old WebSocket client)
 *   - Local OWW wake word detection → VoiceAssistantRequest → HA STT pipeline
 *   - Audio streams to HA via VoiceAssistantAudio protobuf frames
 *   - TTS plays locally via mpv
 *
 * In HA: Settings → Devices & Services → ESPHome → Add → <this IP>:6053
 */

import { VoiceSatelliteProcess, SatelliteSettings } from './satellite.js';
import { getDb } from '../db/index.js';
import { hostname } from 'os';
import path from 'path';
import { existsSync } from 'fs';
import { config } from '../config.js';

const BUILTIN_WAKE_ACK_SOUNDS = new Set([
  'soft_chime',
  'glass_ping',
  'ready_up',
  'wood_tap',
  'digital_pop',
  'confirm_tone',
]);

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

  // Dev fallback when running server directly from the repo root.
  const repoPublicPath = path.join(process.cwd(), '..', 'web', 'public', 'audio', 'wake-ack', fileName);
  if (existsSync(repoPublicPath)) return repoPublicPath;

  return packagedPath;
}

function dbGet(key: string, fallback: string): string {
  try {
    const row = getDb().prepare('SELECT value FROM server_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? fallback;
  } catch {
    return fallback;
  }
}

/** Load current satellite settings from DB (with env-var / hostname fallbacks). */
export function loadSettingsFromDb(): SatelliteSettings {
  const defaultName = hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'canvas-display';
  return {
    port:         parseInt(dbGet('voice_port',          process.env.VOICE_PORT          ?? '6053')),
    name:         dbGet('voice_friendly_name', process.env.VOICE_FRIENDLY_NAME ?? defaultName)
                    .toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-') || defaultName,
    friendlyName: dbGet('voice_friendly_name', process.env.VOICE_FRIENDLY_NAME ?? 'Canvas Display'),
    micDevice:    dbGet('voice_mic_device',    process.env.VOICE_MIC_DEVICE    ?? 'default'),
    wakeWord:     dbGet('voice_wake_word',     process.env.VOICE_WAKE_WORD     ?? 'okay_nabu'),
    ttsVolume:    parseInt(dbGet('voice_tts_volume', process.env.VOICE_TTS_VOLUME ?? '80')),
    wakeAckEnabled: dbGet('voice_wake_ack_enabled', process.env.VOICE_WAKE_ACK_ENABLED ?? '0') === '1',
    wakeAckSound: resolveWakeAckSound(dbGet('voice_wake_ack_sound', process.env.VOICE_WAKE_ACK_SOUND ?? '')),
    goodIntentEnabled: dbGet('voice_good_intent_enabled', '1') === '1',
    goodIntentSound: resolveWakeAckSound(dbGet('voice_good_intent_sound', 'builtin:digital_pop')),
    noIntentEnabled: dbGet('voice_no_intent_enabled', '1') === '1',
    noIntentSound: resolveWakeAckSound(dbGet('voice_no_intent_sound', 'builtin:wood_tap')),
  };
}

/** Returns true if voice is enabled in DB or via VOICE_ENABLED env var. */
export function isVoiceEnabled(): boolean {
  const dbVal = dbGet('voice_enabled', '');
  if (dbVal !== '') return dbVal === '1';
  return process.env.VOICE_ENABLED === 'true';
}

export type VoiceStatus = 'disabled' | 'starting' | 'running' | 'stopped' | 'error';

export interface VoiceState {
  status: VoiceStatus;
  micDevice: string;
  port: number;
}

let _satellite: VoiceSatelliteProcess | null = null;
let _status: VoiceStatus = 'disabled';

// Runtime settings — reloaded from DB on each start
let _settings: SatelliteSettings = {
  port:         6053,
  name:         'canvas-display',
  friendlyName: 'Canvas Display',
  micDevice:    'default',
  wakeWord:     'okay_nabu',
  ttsVolume:    80,
  wakeAckEnabled: false,
  wakeAckSound: '',
  goodIntentEnabled: true,
  goodIntentSound: '',
  noIntentEnabled: true,
  noIntentSound: '',
};

export async function startVoiceServer(): Promise<void> {
  if (_satellite) return; // already running

  // Always reload from DB before starting so UI changes take effect on reboot
  _settings = loadSettingsFromDb();
  _status = 'starting';

  try {
    _satellite = new VoiceSatelliteProcess(_settings);

    _satellite.on('ready', () => {
      _status = 'running';
    });

    _satellite.start();
    _status = 'running';

    console.log(`[voice] ESPHome satellite started — port ${_settings.port}`);
    console.log(`[voice] Mic: ${_settings.micDevice} | Wake word: ${_settings.wakeWord}`);
    console.log(`[voice] Add in HA: Settings → Devices & Services → ESPHome → <this IP>:${_settings.port}`);
  } catch (err) {
    console.error('[voice] Failed to start voice satellite:', err);
    _status = 'error';
    _satellite = null;
    throw err;
  }
}

export async function stopVoiceServer(): Promise<void> {
  if (!_satellite) return;
  await _satellite.stop();
  _satellite = null;
  _status = 'stopped';
  console.log('[voice] Voice satellite stopped');
}

export function getVoiceState(): VoiceState {
  return {
    status:    _status,
    micDevice: _settings.micDevice,
    port:      _settings.port,
  };
}

/** Update settings at runtime (e.g. from settings API). Restart required. */
export function updateVoiceSettings(settings: Partial<SatelliteSettings>): void {
  const next = { ...settings };
  if (typeof next.wakeAckSound === 'string') {
    next.wakeAckSound = resolveWakeAckSound(next.wakeAckSound);
  }
  Object.assign(_settings, next);
  if (_satellite) {
    _satellite.updateSettings(next);
  }
}
