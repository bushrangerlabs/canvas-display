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
import { listMicrophones } from '../voice/mic';

// Keys that exist and their defaults
const SETTING_DEFAULTS: Record<string, string> = {
  device_name:          'Canvas UI Device',
  server_port:          '3100',
  mqtt_enabled:         '0',
  mqtt_broker_url:      'mqtt://localhost:1883',
  mqtt_username:        '',
  mqtt_password:        '',
  voice_enabled:        '0',
  voice_mic_device:     'default',
  voice_wake_word:      'okay_nabu',
  voice_tts_volume:     '80',
  voice_wake_ack_enabled: '0',
  voice_wake_ack_sound:   '',
  voice_port:           '6053',
  voice_friendly_name:  'Canvas Display',
  voice_ha_url:         'http://homeassistant.local:8123',
  voice_ha_token:       '',
  voice_pipeline_id:    '',
};

const REDACTED_KEYS = new Set(['mqtt_password', 'voice_ha_token']);

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
      await stopVoiceServer();
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
    });
    await stopVoiceServer();
    await startVoiceServer();
    reply.code(202);
    return { ok: true, status: getVoiceState().status };
  });

  // GET /api/settings/voice/microphones — list available ALSA capture devices
  app.get('/settings/voice/microphones', async () => {
    return listMicrophones();
  });
}
