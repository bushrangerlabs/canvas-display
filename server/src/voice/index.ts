/**
 * Voice assistant lifecycle — start/stop the HA Assist Pipeline client.
 *
 * Settings are persisted in the server_settings DB table (managed via the
 * Settings UI).  Env vars are used as fallbacks when no DB row exists yet.
 *
 * Architecture (Phase 2):
 *   - No local TCP server — we connect outbound to HA's WebSocket API
 *   - HA's OWW add-on handles wake word detection
 *   - HA's STT/TTS pipelines handle the rest
 *   - TTS audio is played locally via mpv
 */

import { HAPipeline, HAPipelineSettings } from './ha-pipeline.js';
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
export function loadSettingsFromDb(): HAPipelineSettings {
  return {
    haUrl:      dbGet('voice_ha_url',      process.env.VOICE_HA_URL      ?? 'http://homeassistant.local:8123'),
    haToken:    dbGet('voice_ha_token',    process.env.VOICE_HA_TOKEN    ?? ''),
    micDevice:  dbGet('voice_mic_device',  process.env.VOICE_MIC_DEVICE  ?? 'default'),
    wakeWord:   dbGet('voice_wake_word',   process.env.VOICE_WAKE_WORD   ?? 'okay_nabu'),
    ttsVolume:  parseInt(dbGet('voice_tts_volume', process.env.VOICE_TTS_VOLUME ?? '80')),
    pipelineId: dbGet('voice_pipeline_id', process.env.VOICE_PIPELINE_ID ?? ''),
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
  haUrl: string;
}

let _pipeline: HAPipeline | null = null;
let _status: VoiceStatus = 'disabled';

// Runtime settings — loaded from DB on first start, overrideable at runtime
let _settings: HAPipelineSettings = {
  haUrl:      'http://homeassistant.local:8123',
  haToken:    '',
  micDevice:  'default',
  wakeWord:   'okay_nabu',
  ttsVolume:  80,
  pipelineId: '',
};

export async function startVoiceServer(): Promise<void> {
  if (_pipeline) return; // already running

  // Always reload from DB before starting so UI changes take effect on reboot
  _settings = loadSettingsFromDb();
  _status = 'starting';

  if (!_settings.haToken) {
    console.warn('[voice] No HA token configured — voice assistant disabled');
    _status = 'error';
    return;
  }

  try {
    _pipeline = new HAPipeline(_settings);

    _pipeline.on('voiceEvent', (event) => {
      // Forward voice events to WebSocket clients for UI indicators
      import('../ws/index.js').then(m => {
        m.broadcast({ type: 'voice_event', ...event });
      }).catch(() => {});
    });

    _pipeline.start();
    _status = 'running';

    console.log(`[voice] Voice assistant started — HA: ${_settings.haUrl}`);
    console.log(`[voice] Mic device: ${_settings.micDevice} | Wake word: ${_settings.wakeWord}`);
  } catch (err) {
    console.error('[voice] Failed to start voice assistant:', err);
    _status = 'error';
    _pipeline = null;
    throw err;
  }
}

export async function stopVoiceServer(): Promise<void> {
  if (!_pipeline) return;
  await _pipeline.stop(); // waits for arecord to fully release the audio device
  _pipeline = null;
  _status = 'stopped';
  console.log('[voice] Voice assistant stopped');
}

export function getVoiceState(): VoiceState {
  return {
    status:    _status,
    micDevice: _settings.micDevice,
    haUrl:     _settings.haUrl,
  };
}

/** Update settings at runtime (e.g. from settings API) */
export function updateVoiceSettings(settings: Partial<HAPipelineSettings>): void {
  Object.assign(_settings, settings);
  if (_pipeline) {
    _pipeline.updateSettings(settings);
  }
}


