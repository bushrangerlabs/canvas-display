import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createTestDb } from './db-helpers.js';
import { PgDeviceRepository, registerDeviceRoutes, recordDeviceHello } from '../src/devices.js';
import { PgAuthRepository, bootstrapAdmin, registerAuth } from '../src/auth.js';
import type { CoreConfig } from '../src/config.js';

function makeConfig(): CoreConfig {
  return {
    port: 3100,
    host: '0.0.0.0',
    databaseUrl: 'postgresql://x',
    gatewayPath: '/gateway/v1',
    logLevel: 'info',
    jwtSecret: 'test-secret',
    cookieSecure: false,
    adminUser: 'admin',
    adminPassword: 'changeme',
  };
}

async function buildServer(config: CoreConfig, deviceRepo: PgDeviceRepository, authRepo: PgAuthRepository) {
  const fastify = Fastify({ logger: false });
  const { requireAdmin } = await registerAuth(fastify, { config, repo: authRepo });
  await registerDeviceRoutes(fastify, {
    repo: deviceRepo,
    requireAdmin,
    deviceAction: async (_deviceId, action, payload) => {
      if (action === 'device_http' && payload?.path === '/api/voice/wakeword-test') {
        return { ok: true, detected: false };
      }
      if (action === 'device_http' && payload?.path === '/api/settings/voice/wakewords') {
        return { wake_words: [{ id: 'okay_nabu', name: 'okay nabu' }] };
      }
      if (action === 'device_http' && payload?.path === '/api/settings/audio/devices') {
        return {
          microphones: [{ id: 'default', name: 'Default microphone' }],
          speakers: [{ id: 'default', name: 'Default speaker' }],
        };
      }
      if (action === 'device_http' && payload?.path === '/api/audio/test-mic') {
        return { sample: 'base64:captured-wav', format: 'wav', duration_ms: 3000 };
      }
      return { ok: true };
    },
  });
  await fastify.ready();
  return fastify;
}

function cookieHeader(setCookie: string[]): string {
  return setCookie.map((c) => c.split(';')[0]).join('; ');
}

async function adminSession(fastify: Fastify, config: CoreConfig, authRepo: PgAuthRepository) {
  await bootstrapAdmin(config, authRepo);
  const login = await fastify.inject({
    method: 'POST',
    url: '/api/admin/login',
    payload: { username: 'admin', password: 'changeme' },
  });
  const setCookie = login.headers['set-cookie'] as unknown as string[];
  const cookies = cookieHeader(setCookie);
  const csrf = setCookie.find((c) => c.startsWith('csrf_token='))!.split(';')[0].replace('csrf_token=', '');
  return { cookies, csrf };
}

test('GET /api/admin/devices/:id/audio returns 404 for unknown device', async () => {
  const { pool } = createTestDb();
  const config = makeConfig();
  const deviceRepo = new PgDeviceRepository(pool);
  const authRepo = new PgAuthRepository(pool);
  const fastify = await buildServer(config, deviceRepo, authRepo);
  const { cookies } = await adminSession(fastify, config, authRepo);

  const res = await fastify.inject({
    method: 'GET',
    url: '/api/admin/devices/nonexistent/audio',
    headers: { cookie: cookies },
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'device_not_found');
});

test('GET /api/admin/devices/:id/audio returns null configs when not set', async () => {
  const { pool } = createTestDb();
  const config = makeConfig();
  const deviceRepo = new PgDeviceRepository(pool);
  const authRepo = new PgAuthRepository(pool);
  const fastify = await buildServer(config, deviceRepo, authRepo);
  const { cookies } = await adminSession(fastify, config, authRepo);

  await recordDeviceHello(deviceRepo, { deviceId: 'dev-1', name: 'v1', architecture: 'arm64', protocolVersion: '1' });

  const res = await fastify.inject({
    method: 'GET',
    url: '/api/admin/devices/dev-1/audio',
    headers: { cookie: cookies },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.audio_config, null);
  assert.equal(body.voice_config, null);
});

test('PUT /api/admin/devices/:id/audio updates audio config', async () => {
  const { pool } = createTestDb();
  const config = makeConfig();
  const deviceRepo = new PgDeviceRepository(pool);
  const authRepo = new PgAuthRepository(pool);
  const fastify = await buildServer(config, deviceRepo, authRepo);
  const { cookies, csrf } = await adminSession(fastify, config, authRepo);

  await recordDeviceHello(deviceRepo, { deviceId: 'dev-1', name: 'v1', architecture: 'arm64', protocolVersion: '1' });

  const putRes = await fastify.inject({
    method: 'PUT',
    url: '/api/admin/devices/dev-1/audio',
    headers: { cookie: cookies, 'x-csrf-token': csrf },
    payload: { mic_device: 'hw:0,0', speaker_device: 'hw:0,0', mic_volume: 80, speaker_volume: 90 },
  });
  assert.equal(putRes.statusCode, 200);
  const putBody = putRes.json();
  assert.equal(putBody.ok, true);
  assert.equal(putBody.audio_config.mic_device, 'hw:0,0');
  assert.equal(putBody.audio_config.speaker_device, 'hw:0,0');
  assert.equal(putBody.audio_config.mic_volume, 80);
  assert.equal(putBody.audio_config.speaker_volume, 90);

  // Verify via GET
  const getRes = await fastify.inject({
    method: 'GET',
    url: '/api/admin/devices/dev-1/audio',
    headers: { cookie: cookies },
  });
  assert.equal(getRes.statusCode, 200);
  const getBody = getRes.json();
  assert.equal(getBody.audio_config.mic_device, 'hw:0,0');
  assert.equal(getBody.audio_config.speaker_volume, 90);
});

test('PUT /api/admin/devices/:id/audio returns 404 for unknown device', async () => {
  const { pool } = createTestDb();
  const config = makeConfig();
  const deviceRepo = new PgDeviceRepository(pool);
  const authRepo = new PgAuthRepository(pool);
  const fastify = await buildServer(config, deviceRepo, authRepo);
  const { cookies, csrf } = await adminSession(fastify, config, authRepo);

  const res = await fastify.inject({
    method: 'PUT',
    url: '/api/admin/devices/nope/audio',
    headers: { cookie: cookies, 'x-csrf-token': csrf },
    payload: { mic_device: 'hw:0,0' },
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'device_not_found');
});

test('PUT /api/admin/devices/:id/audio requires CSRF', async () => {
  const { pool } = createTestDb();
  const config = makeConfig();
  const deviceRepo = new PgDeviceRepository(pool);
  const authRepo = new PgAuthRepository(pool);
  const fastify = await buildServer(config, deviceRepo, authRepo);
  const { cookies } = await adminSession(fastify, config, authRepo);

  const res = await fastify.inject({
    method: 'PUT',
    url: '/api/admin/devices/dev-1/audio',
    headers: { cookie: cookies },
    payload: { mic_device: 'hw:0,0' },
  });
  assert.equal(res.statusCode, 403);
});

test('PUT /api/admin/devices/:id/voice updates voice config', async () => {
  const { pool } = createTestDb();
  const config = makeConfig();
  const deviceRepo = new PgDeviceRepository(pool);
  const authRepo = new PgAuthRepository(pool);
  const fastify = await buildServer(config, deviceRepo, authRepo);
  const { cookies, csrf } = await adminSession(fastify, config, authRepo);

  await recordDeviceHello(deviceRepo, { deviceId: 'dev-1', name: 'v1', architecture: 'arm64', protocolVersion: '1' });

  const putRes = await fastify.inject({
    method: 'PUT',
    url: '/api/admin/devices/dev-1/voice',
    headers: { cookie: cookies, 'x-csrf-token': csrf },
    payload: {
      wake_word: 'hey_canvas',
      wake_threshold: 0.5,
      wake_enabled: true,
      language: 'en',
      pipeline: 'default',
      wake_ack_enabled: true,
      wake_ack_sound: 'builtin:ready_up',
      good_intent_enabled: true,
      good_intent_sound: 'builtin:digital_pop',
      no_intent_enabled: false,
      no_intent_sound: 'builtin:wood_tap',
    },
  });
  assert.equal(putRes.statusCode, 200);
  const putBody = putRes.json();
  assert.equal(putBody.ok, true);
  assert.equal(putBody.voice_config.wake_word, 'hey_canvas');
  assert.equal(putBody.voice_config.wake_threshold, 0.5);
  assert.equal(putBody.voice_config.wake_enabled, true);
  assert.equal(putBody.voice_config.language, 'en');
  assert.equal(putBody.voice_config.pipeline, 'default');
  assert.equal(putBody.voice_config.wake_ack_enabled, true);
  assert.equal(putBody.voice_config.wake_ack_sound, 'builtin:ready_up');
  assert.equal(putBody.voice_config.good_intent_sound, 'builtin:digital_pop');
  assert.equal(putBody.voice_config.no_intent_enabled, false);

  // Verify via GET
  const getRes = await fastify.inject({
    method: 'GET',
    url: '/api/admin/devices/dev-1/audio',
    headers: { cookie: cookies },
  });
  assert.equal(getRes.statusCode, 200);
  assert.equal(getRes.json().voice_config.wake_word, 'hey_canvas');
});

test('PUT /api/admin/devices/:id/voice returns 404 for unknown device', async () => {
  const { pool } = createTestDb();
  const config = makeConfig();
  const deviceRepo = new PgDeviceRepository(pool);
  const authRepo = new PgAuthRepository(pool);
  const fastify = await buildServer(config, deviceRepo, authRepo);
  const { cookies, csrf } = await adminSession(fastify, config, authRepo);

  const res = await fastify.inject({
    method: 'PUT',
    url: '/api/admin/devices/nope/voice',
    headers: { cookie: cookies, 'x-csrf-token': csrf },
    payload: { wake_word: 'hey_canvas' },
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'device_not_found');
});

test('GET /api/admin/devices/:id/audio/devices returns the Edge device inventory', async () => {
  const { pool } = createTestDb();
  const config = makeConfig();
  const deviceRepo = new PgDeviceRepository(pool);
  const authRepo = new PgAuthRepository(pool);
  const fastify = await buildServer(config, deviceRepo, authRepo);
  const { cookies } = await adminSession(fastify, config, authRepo);
  await recordDeviceHello(deviceRepo, { deviceId: 'dev-1', name: 'v1', architecture: 'arm64', protocolVersion: '1' });

  const res = await fastify.inject({
    method: 'GET',
    url: '/api/admin/devices/dev-1/audio/devices',
    headers: { cookie: cookies },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    microphones: [{ id: 'default', name: 'Default microphone' }],
    speakers: [{ id: 'default', name: 'Default speaker' }],
    wake_words: [{ id: 'okay_nabu', name: 'okay nabu' }],
  });
});

test('POST /api/admin/devices/:id/audio/test-mic returns captured device audio', async () => {
  const { pool } = createTestDb();
  const config = makeConfig();
  const deviceRepo = new PgDeviceRepository(pool);
  const authRepo = new PgAuthRepository(pool);
  const fastify = await buildServer(config, deviceRepo, authRepo);
  const { cookies, csrf } = await adminSession(fastify, config, authRepo);

  await recordDeviceHello(deviceRepo, { deviceId: 'dev-1', name: 'v1', architecture: 'arm64', protocolVersion: '1' });

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/admin/devices/dev-1/audio/test-mic',
    headers: { cookie: cookies, 'x-csrf-token': csrf },
    payload: {},
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.device_id, 'dev-1');
  assert.equal(body.sample, 'base64:captured-wav');
  assert.equal(body.format, 'wav');
  assert.equal(typeof body.duration_ms, 'number');
  assert.equal(typeof body.note, 'string');
});

test('POST /api/admin/devices/:id/audio/test-mic returns 404 for unknown device', async () => {
  const { pool } = createTestDb();
  const config = makeConfig();
  const deviceRepo = new PgDeviceRepository(pool);
  const authRepo = new PgAuthRepository(pool);
  const fastify = await buildServer(config, deviceRepo, authRepo);
  const { cookies, csrf } = await adminSession(fastify, config, authRepo);

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/admin/devices/nope/audio/test-mic',
    headers: { cookie: cookies, 'x-csrf-token': csrf },
    payload: {},
  });
  assert.equal(res.statusCode, 404);
});

test('POST /api/admin/devices/:id/audio/test-speaker returns the device result', async () => {
  const { pool } = createTestDb();
  const config = makeConfig();
  const deviceRepo = new PgDeviceRepository(pool);
  const authRepo = new PgAuthRepository(pool);
  const fastify = await buildServer(config, deviceRepo, authRepo);
  const { cookies, csrf } = await adminSession(fastify, config, authRepo);

  await recordDeviceHello(deviceRepo, { deviceId: 'dev-1', name: 'v1', architecture: 'arm64', protocolVersion: '1' });

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/admin/devices/dev-1/audio/test-speaker',
    headers: { cookie: cookies, 'x-csrf-token': csrf },
    payload: {},
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.device_id, 'dev-1');
  assert.equal(typeof body.note, 'string');
});

test('POST /api/admin/devices/:id/voice/test-wakeword returns the one-shot detector result', async () => {
  const { pool } = createTestDb();
  const config = makeConfig();
  const deviceRepo = new PgDeviceRepository(pool);
  const authRepo = new PgAuthRepository(pool);
  const fastify = await buildServer(config, deviceRepo, authRepo);
  const { cookies, csrf } = await adminSession(fastify, config, authRepo);

  await recordDeviceHello(deviceRepo, { deviceId: 'dev-1', name: 'v1', architecture: 'arm64', protocolVersion: '1' });

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/admin/devices/dev-1/voice/test-wakeword',
    headers: { cookie: cookies, 'x-csrf-token': csrf },
    payload: {},
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.device_id, 'dev-1');
  assert.equal(body.detected, false);
  assert.equal(typeof body.note, 'string');
});

test('DeviceRow includes audio_config and voice_config after update', async () => {
  const { pool } = createTestDb();
  const config = makeConfig();
  const deviceRepo = new PgDeviceRepository(pool);
  const authRepo = new PgAuthRepository(pool);
  const fastify = await buildServer(config, deviceRepo, authRepo);
  const { cookies, csrf } = await adminSession(fastify, config, authRepo);

  await recordDeviceHello(deviceRepo, { deviceId: 'dev-1', name: 'v1', architecture: 'arm64', protocolVersion: '1' });

  // Set audio config
  await fastify.inject({
    method: 'PUT',
    url: '/api/admin/devices/dev-1/audio',
    headers: { cookie: cookies, 'x-csrf-token': csrf },
    payload: { mic_device: 'hw:0,0', speaker_device: 'hw:1,0', mic_volume: 75, speaker_volume: 85 },
  });

  // Set voice config
  await fastify.inject({
    method: 'PUT',
    url: '/api/admin/devices/dev-1/voice',
    headers: { cookie: cookies, 'x-csrf-token': csrf },
    payload: { wake_word: 'alexa', wake_enabled: true, language: 'en-US', pipeline: 'ha_pipeline' },
  });

  // Verify via device list
  const listRes = await fastify.inject({ method: 'GET', url: '/api/admin/devices', headers: { cookie: cookies } });
  assert.equal(listRes.statusCode, 200);
  const list = listRes.json();
  assert.equal(list.devices.length, 1);
  const device = list.devices[0];
  assert.equal(device.audio_config.mic_device, 'hw:0,0');
  assert.equal(device.audio_config.speaker_volume, 85);
  assert.equal(device.voice_config.wake_word, 'alexa');
  assert.equal(device.voice_config.wake_enabled, true);
  assert.equal(device.voice_config.language, 'en-US');
});

test('audio/voice routes reject unauthenticated requests', async () => {
  const { pool } = createTestDb();
  const config = makeConfig();
  const deviceRepo = new PgDeviceRepository(pool);
  const authRepo = new PgAuthRepository(pool);
  const fastify = await buildServer(config, deviceRepo, authRepo);

  // GET without auth
  const getRes = await fastify.inject({ method: 'GET', url: '/api/admin/devices/dev-1/audio' });
  assert.equal(getRes.statusCode, 401);

  // PUT without auth
  const putRes = await fastify.inject({ method: 'PUT', url: '/api/admin/devices/dev-1/audio', payload: {} });
  assert.equal(putRes.statusCode, 401);

  // POST test-mic without auth
  const micRes = await fastify.inject({ method: 'POST', url: '/api/admin/devices/dev-1/audio/test-mic', payload: {} });
  assert.equal(micRes.statusCode, 401);
});
