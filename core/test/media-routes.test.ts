/**
 * Tests for the DAB+ / Dispatcharr media-source routes and the shared media state.
 *
 * The SDR radio and Dispatcharr HTTP calls are stubbed by replacing `globalThis.fetch`,
 * so these run without a network. Uses `pg-mem` for the settings store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createTestDb } from './db-helpers.js';
import { registerLegacyRoutes, getAudioState, resetAudioState } from '../src/legacy-routes.js';
import { clearMediaCaches } from '../src/media-sources.js';
import type { CoreConfig } from '../src/config.js';

function makeConfig(overrides: Partial<CoreConfig> = {}): CoreConfig {
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
    allowOpenPairing: true,
    voiceMaxSessionsPerUser: 3,
    voiceMaxSessionsGlobal: 10,
    voiceIdleTimeoutMs: 60_000,
    voiceMaxSessionDurationMs: 30_000,
    voiceVadThreshold: 500,
    voiceVadSilenceMs: 3_000,
    voiceVadContinueTimeoutMs: 2_000,
    sdrRadioUrl: 'http://sdr.test:8088',
    sdrRadioTuner: 'tuner1',
    sdrRadioStreamUrl: 'http://sdr.test:8001/tuner1.mp3',
    dispatcharrUrl: 'http://dispatcharr.test:9191',
    ...overrides,
  };
}

async function buildServer(config = makeConfig()) {
  const { pool } = createTestDb();
  const fastify = Fastify({ logger: false });
  await registerLegacyRoutes(fastify, { pool, config });
  await fastify.ready();
  return { fastify, pool };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Replace global fetch for the duration of a test; returns a restore function. */
function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) =>
    handler(typeof input === 'string' ? input : String(input), init)) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

// ─── DAB+ ────────────────────────────────────────────────────────────────────

test('GET /api/dab/stations returns the SDR station list', async () => {
  clearMediaCaches();
  const { fastify } = await buildServer();
  const restore = stubFetch((url) => {
    assert.match(url, /\/api\/stations$/);
    return jsonResponse({ dab: [{ id: 'abc', name: 'BBC Radio 1', city: 'London' }] });
  });
  try {
    const res = await fastify.inject({ method: 'GET', url: '/api/dab/stations' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().stations, [{ id: 'abc', name: 'BBC Radio 1', city: 'London' }]);
  } finally {
    restore();
  }
});

test('GET /api/dab/stations returns 503 when the SDR URL is not configured', async () => {
  clearMediaCaches();
  const { fastify } = await buildServer(makeConfig({ sdrRadioUrl: '' }));
  const res = await fastify.inject({ method: 'GET', url: '/api/dab/stations' });
  assert.equal(res.statusCode, 503);
});

test('POST /api/dab/play tunes the station and updates media state', async () => {
  clearMediaCaches();
  resetAudioState();
  const { fastify } = await buildServer();
  const calls: string[] = [];
  const restore = stubFetch((url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/api/tuners/tuner1/play')) return jsonResponse({ station_name: 'BBC Radio 1' });
    return jsonResponse({});
  });
  try {
    const res = await fastify.inject({ method: 'POST', url: '/api/dab/play', payload: { station: 'abc' } });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, true);
    assert.equal(body.station, 'BBC Radio 1');
    assert.equal(body.url, 'http://sdr.test:8001/tuner1.mp3');
    assert.equal(getAudioState().state, 'playing');
    assert.equal(getAudioState().title, 'BBC Radio 1');
    assert.equal(getAudioState().source, 'dab');
    assert.ok(calls.includes('POST http://sdr.test:8088/api/tuners/tuner1/play'));
  } finally {
    restore();
  }
});

test('POST /api/dab/play requires a station', async () => {
  const { fastify } = await buildServer();
  const res = await fastify.inject({ method: 'POST', url: '/api/dab/play', payload: {} });
  assert.equal(res.statusCode, 400);
});

// ─── Dispatcharr ─────────────────────────────────────────────────────────────

test('GET /api/dispatcharr/channels returns the HDHomeRun lineup', async () => {
  clearMediaCaches();
  const { fastify } = await buildServer();
  const restore = stubFetch((url) => {
    assert.match(url, /\/api\/hdhr\/lineup\.json$/);
    return jsonResponse([{ GuideNumber: '1', GuideName: 'Channel One', URL: 'http://stream/1' }]);
  });
  try {
    const res = await fastify.inject({ method: 'GET', url: '/api/dispatcharr/channels' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().channels, [{ number: '1', name: 'Channel One', url: 'http://stream/1' }]);
    assert.equal(res.json().total, 1);
  } finally {
    restore();
  }
});

test('GET /api/dispatcharr/channels applies the search and limit query parameters', async () => {
  clearMediaCaches();
  const { fastify } = await buildServer();
  const restore = stubFetch(() =>
    jsonResponse([
      { GuideNumber: '1', GuideName: 'News HD', URL: 'http://stream/1' },
      { GuideNumber: '2', GuideName: 'News SD', URL: 'http://stream/2' },
      { GuideNumber: '3', GuideName: 'Sports', URL: 'http://stream/3' },
    ]));
  try {
    const res = await fastify.inject({ method: 'GET', url: '/api/dispatcharr/channels?search=news&limit=1' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.total, 3);
    assert.deepEqual(body.channels, [{ number: '1', name: 'News HD', url: 'http://stream/1' }]);
  } finally {
    restore();
  }
});

test('GET /api/dab/stations applies the search and limit query parameters', async () => {
  clearMediaCaches();
  const { fastify } = await buildServer();
  const restore = stubFetch(() =>
    jsonResponse({ dab: [
      { id: 'a', name: 'Alpha One' },
      { id: 'b', name: 'Alpha Two' },
      { id: 'c', name: 'Bravo' },
    ] }));
  try {
    const res = await fastify.inject({ method: 'GET', url: '/api/dab/stations?search=alpha&limit=1' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.total, 3);
    assert.deepEqual(body.stations, [{ id: 'a', name: 'Alpha One' }]);
  } finally {
    restore();
  }
});

test('POST /api/dispatcharr/play resolves the channel URL and updates media state', async () => {
  clearMediaCaches();
  resetAudioState();
  const { fastify } = await buildServer();
  const restore = stubFetch(() =>
    jsonResponse([{ GuideNumber: '1', GuideName: 'Channel One', URL: 'http://stream/1' }]));
  try {
    const res = await fastify.inject({ method: 'POST', url: '/api/dispatcharr/play', payload: { channel: 'Channel One' } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().url, 'http://stream/1');
    assert.equal(getAudioState().source, 'dispatcharr');
    assert.equal(getAudioState().title, 'Channel One');
  } finally {
    restore();
  }
});

test('POST /api/dispatcharr/play accepts an explicit URL without the lineup', async () => {
  resetAudioState();
  const { fastify } = await buildServer();
  const restore = stubFetch(() => {
    throw new Error('lineup should not be fetched when a URL is supplied');
  });
  try {
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/dispatcharr/play',
      payload: { channel: 'Direct', url: 'http://stream/direct' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(getAudioState().url, 'http://stream/direct');
  } finally {
    restore();
  }
});

// ─── Connection tests (Settings → Media) ─────────────────────────────────────

test('GET /api/dab/test reports the station count', async () => {
  clearMediaCaches();
  const { fastify } = await buildServer();
  const restore = stubFetch(() =>
    jsonResponse({ dab: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Bravo' }] }));
  try {
    const res = await fastify.inject({ method: 'GET', url: '/api/dab/test' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);
    assert.match(res.json().detail, /2 DAB\+ stations/);
  } finally {
    restore();
  }
});

test('GET /api/dab/test reports a failure without throwing', async () => {
  clearMediaCaches();
  const { fastify } = await buildServer();
  const restore = stubFetch(() => new Response('nope', { status: 500 }));
  try {
    const res = await fastify.inject({ method: 'GET', url: '/api/dab/test' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, false);
    assert.match(res.json().error, /SDR radio unavailable/);
  } finally {
    restore();
  }
});

test('GET /api/dab/test reports an unconfigured source', async () => {
  const { fastify } = await buildServer(makeConfig({ sdrRadioUrl: '' }));
  const res = await fastify.inject({ method: 'GET', url: '/api/dab/test' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, false);
  assert.match(res.json().error, /not configured/);
});

test('GET /api/dispatcharr/test reports the channel count', async () => {
  clearMediaCaches();
  const { fastify } = await buildServer();
  const restore = stubFetch(() =>
    jsonResponse([{ GuideNumber: '1', GuideName: 'One', URL: 'http://s/1' }]));
  try {
    const res = await fastify.inject({ method: 'GET', url: '/api/dispatcharr/test' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);
    assert.match(res.json().detail, /1 channel\b/);
  } finally {
    restore();
  }
});

// ─── Shared media state + control ────────────────────────────────────────────

test('GET /api/media/state returns the current audio state', async () => {
  resetAudioState();
  const { fastify } = await buildServer();
  const res = await fastify.inject({ method: 'GET', url: '/api/media/state' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().audio.state, 'idle');
});

test('POST /api/media/control handles pause, resume, volume, mute and stop', async () => {
  resetAudioState();
  const { fastify } = await buildServer();
  await fastify.inject({ method: 'POST', url: '/api/audio/play', payload: { url: 'http://x', title: 'X' } });

  const pause = await fastify.inject({ method: 'POST', url: '/api/media/control', payload: { action: 'pause' } });
  assert.equal(pause.statusCode, 200);
  assert.equal(getAudioState().state, 'paused');

  const resume = await fastify.inject({ method: 'POST', url: '/api/media/control', payload: { action: 'resume' } });
  assert.equal(resume.statusCode, 200);
  assert.equal(getAudioState().state, 'playing');

  const vol = await fastify.inject({ method: 'POST', url: '/api/media/control', payload: { action: 'volume', level: 42 } });
  assert.equal(vol.statusCode, 200);
  assert.equal(getAudioState().volume, 42);

  const mute = await fastify.inject({ method: 'POST', url: '/api/media/control', payload: { action: 'mute', muted: true } });
  assert.equal(mute.statusCode, 200);
  assert.equal(getAudioState().muted, true);

  const stop = await fastify.inject({ method: 'POST', url: '/api/media/control', payload: { action: 'stop' } });
  assert.equal(stop.statusCode, 200);
  assert.equal(getAudioState().state, 'idle');
  assert.equal(getAudioState().source, undefined);
});

test('POST /api/media/control rejects an unknown action', async () => {
  const { fastify } = await buildServer();
  const res = await fastify.inject({ method: 'POST', url: '/api/media/control', payload: { action: 'explode' } });
  assert.equal(res.statusCode, 400);
});

test('POST /api/media/control next/previous steps through the DAB station list', async () => {
  clearMediaCaches();
  resetAudioState();
  const { fastify } = await buildServer();
  const restore = stubFetch((url, init) => {
    if (url.endsWith('/api/stations')) {
      return jsonResponse({ dab: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Bravo' }] });
    }
    if (url.includes('/api/tuners/')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { station?: string };
      return jsonResponse({ station_name: String(body.station ?? '').replace(/^dab:/, '') });
    }
    return jsonResponse({});
  });
  try {
    // Nothing playing → "next" starts at the top of the list.
    await fastify.inject({ method: 'POST', url: '/api/media/control', payload: { action: 'next', source: 'dab' } });
    assert.equal(getAudioState().title, 'Alpha');

    await fastify.inject({ method: 'POST', url: '/api/media/control', payload: { action: 'next', source: 'dab' } });
    assert.equal(getAudioState().title, 'Bravo');

    await fastify.inject({ method: 'POST', url: '/api/media/control', payload: { action: 'previous', source: 'dab' } });
    assert.equal(getAudioState().title, 'Alpha');
  } finally {
    restore();
  }
});

// ─── Settings ────────────────────────────────────────────────────────────────

test('GET /api/settings exposes media-source keys from the env config', async () => {
  const { fastify } = await buildServer();
  const res = await fastify.inject({ method: 'GET', url: '/api/settings' });
  assert.equal(res.statusCode, 200);
  const settings = res.json();
  assert.equal(settings.sdr_radio_url, 'http://sdr.test:8088');
  assert.equal(settings.dispatcharr_url, 'http://dispatcharr.test:9191');
  assert.ok('music_assistant_url' in settings);
});

test('PUT /api/settings persists a media-source override that wins over the env default', async () => {
  const { fastify } = await buildServer();
  const put = await fastify.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { dispatcharr_url: 'http://custom:9191' },
  });
  assert.equal(put.statusCode, 200);
  const res = await fastify.inject({ method: 'GET', url: '/api/settings' });
  assert.equal(res.json().dispatcharr_url, 'http://custom:9191');
});

test('GET /api/settings redacts the Dispatcharr API key', async () => {
  const { fastify } = await buildServer(makeConfig({ dispatcharrApiKey: 'secret-key' }));
  const res = await fastify.inject({ method: 'GET', url: '/api/settings' });
  assert.equal(res.json().dispatcharr_api_key, '••••••••');
});

// ─── Canvas Core bridge ──────────────────────────────────────────────────────

test('GET /api/settings/core-bridge reports the public URL and token status', async () => {
  const { fastify } = await buildServer(makeConfig({
    publicUrl: 'https://core.test:3100',
    edgeVoiceToken: 'env-token',
  }));
  const res = await fastify.inject({ method: 'GET', url: '/api/settings/core-bridge' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.url, 'https://core.test:3100');
  assert.equal(body.tokenSet, true);
  assert.equal(body.source, 'env');
});

test('GET /api/settings/core-bridge prefers a stored URL and token', async () => {
  const { fastify } = await buildServer(makeConfig({
    publicUrl: 'https://core.test:3100',
    edgeVoiceToken: 'env-token',
  }));
  await fastify.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { canvas_core_url: 'http://192.168.1.50:3101', edge_voice_token: 'db-token' },
  });
  const res = await fastify.inject({ method: 'GET', url: '/api/settings/core-bridge' });
  const body = res.json();
  assert.equal(body.url, 'http://192.168.1.50:3101');
  assert.equal(body.tokenSet, true);
  assert.equal(body.source, 'db');
});

test('GET /api/settings redacts the edge voice token', async () => {
  const { fastify } = await buildServer(makeConfig({ edgeVoiceToken: 'super-secret' }));
  const res = await fastify.inject({ method: 'GET', url: '/api/settings' });
  assert.equal(res.json().edge_voice_token, '••••••••');
});

test('POST /api/settings/core-bridge/test probes the local health endpoint', async () => {
  const { fastify } = await buildServer(makeConfig({ publicUrl: 'https://core.test:3100' }));
  const restore = stubFetch((url) => {
    assert.match(url, /127\.0\.0\.1:\d+\/health$/);
    return jsonResponse({ status: 'ok', role: 'canvas-core' });
  });
  try {
    const res = await fastify.inject({ method: 'POST', url: '/api/settings/core-bridge/test' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.url, 'https://core.test:3100');
    assert.equal(body.status.role, 'canvas-core');
  } finally {
    restore();
  }
});

test('POST /api/settings/core-bridge/test reports a failure without throwing', async () => {
  const { fastify } = await buildServer();
  const restore = stubFetch(() => new Response('down', { status: 503 }));
  try {
    const res = await fastify.inject({ method: 'POST', url: '/api/settings/core-bridge/test' });
    assert.equal(res.statusCode, 502);
    assert.equal(res.json().ok, false);
  } finally {
    restore();
  }
});
