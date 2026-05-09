/**
 * Voice satellite lifecycle — start/stop the ESPHome API server.
 *
 * Settings are persisted in the server_settings DB table (managed via the
 * Settings UI).  Env vars are used as fallbacks when no DB row exists yet.
 */

import { EspHomeServer, EspHomeServerSettings } from './esphome-server.js';
import { getDb } from '../db/index.js';

function dbGet(key: string, fallback: string): string {
  try {
    const row = getDb().prepare('SELECT value FROM server_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? fallback;
  } catch {
    return fallback;
  }
}

/** Load current settings from DB (with env-var fallbacks). */
export function loadSettingsFromDb(): EspHomeServerSettings {
  return {
    port:         parseInt(dbGet('voice_port',          process.env.VOICE_PORT          ?? '6053')),
    micDevice:    dbGet('voice_mic_device',              process.env.VOICE_MIC_DEVICE    ?? 'default'),
    friendlyName: dbGet('voice_friendly_name',           process.env.VOICE_FRIENDLY_NAME ?? 'Canvas Display'),
    wakeWord:     dbGet('voice_wake_word',               process.env.VOICE_WAKE_WORD     ?? 'okay_nabu'),
    ttsVolume:    parseInt(dbGet('voice_tts_volume',     process.env.VOICE_TTS_VOLUME    ?? '80')),
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
  port: number;
  micDevice: string;
  friendlyName: string;
}

let _server: EspHomeServer | null = null;
let _status: VoiceStatus = 'disabled';

// Runtime settings — loaded from DB on first start, overrideable at runtime
let _settings: EspHomeServerSettings = {
  port:         6053,
  micDevice:    'default',
  friendlyName: 'Canvas Display',
  wakeWord:     'okay_nabu',
  ttsVolume:    80,
};

export async function startVoiceServer(): Promise<void> {
  if (_server) return; // already running

  // Always reload from DB before starting so UI changes take effect on reboot
  _settings = loadSettingsFromDb();
  _status = 'starting';

  try {
    _server = new EspHomeServer(_settings);
    _server.on('error', (err: Error) => {
      console.error('[voice] Fatal server error:', err.message);
      _status = 'error';
      _server = null;
    });
    _server.on('voiceEvent', (event) => {
      // Forward voice events to WebSocket clients for UI indicators
      import('../ws/index.js').then(m => {
        m.broadcast({ type: 'voice_event', ...event });
      }).catch(() => {});
    });

    await _server.start();
    _status = 'running';

    console.log(`[voice] Voice satellite started — listening for HA on port ${_settings.port}`);
    console.log(`[voice] Mic device: ${_settings.micDevice} | Wake word: ${_settings.wakeWord}`);
  } catch (err) {
    console.error('[voice] Failed to start voice satellite:', err);
    _status = 'error';
    _server = null;
    throw err;
  }
}

export async function stopVoiceServer(): Promise<void> {
  if (!_server) return;
  await _server.stop();
  _server = null;
  _status = 'stopped';
  console.log('[voice] Voice satellite stopped');
}

export function getVoiceState(): VoiceState {
  return {
    status:       _status,
    port:         _settings.port,
    micDevice:    _settings.micDevice,
    friendlyName: _settings.friendlyName,
  };
}

/** Update settings at runtime (e.g. from settings API) */
export function updateVoiceSettings(settings: Partial<EspHomeServerSettings>): void {
  Object.assign(_settings, settings);
  if (_server) {
    _server.updateSettings(settings);
  }
}


