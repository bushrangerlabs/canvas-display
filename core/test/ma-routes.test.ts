/**
 * Tests for the Music Assistant routes.
 *
 * The Music Assistant HTTP calls are stubbed by replacing `globalThis.fetch`,
 * so these run without a network. Uses `pg-mem` for the settings store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createTestDb } from './db-helpers.js';
import { registerLegacyRoutes } from '../src/legacy-routes.js';
import { clearMaTokenCache, clearMaRadioCache } from '../src/music-assistant.js';
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
    voiceIdleTimeoutMs: 60_000,
    voiceMaxSessionDurationMs: 30_000,
    voiceVadThreshold: 500,
    voiceVadSilenceMs: 3_000,
    voiceVadContinueTimeoutMs: 2_000,
    sdrRadioUrl: 'http://sdr.test:8088',
    sdrRadioTuner: 'tuner1',
    sdrRadioStreamUrl: 'http://sdr.test:8001/tuner1.mp3',
    dispatcharrUrl: 'http://dispatcharr.test:9191',
    musicAssistantUrl: 'http://ma.test:8095',
    musicAssistantToken: 'long-lived-token',
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

/** Intercept MA POST /api commands; the handler receives the parsed body. */
function stubMaCommands(
  handler: (command: string, args: Record<string, unknown>) => unknown,
): () => void {
  return stubFetch((url, init) => {
    assert.match(url, /^http:\/\/ma\.test:8095\/api$/);
    const body = JSON.parse(String(init?.body ?? '{}')) as { command: string; args?: Record<string, unknown> };
    return jsonResponse(handler(body.command, body.args ?? {}));
  });
}

const samplePlayer = {
  player_id: 'player-1',
  name: 'Kitchen Speaker',
  state: 'playing',
  volume_level: 42,
  volume_muted: false,
  available: true,
  current_media: {
    title: 'Bohemian Rhapsody',
    artist: 'Queen',
    image_url: 'http://ma.test:8095/img/cover.jpg',
    duration: 355,
  },
  elapsed_time: 12,
};

// ─── Players ──────────────────────────────────────────────────────────────────

test('GET /api/ma/players returns the normalised player list', async () => {
  clearMaTokenCache();
  const { fastify } = await buildServer();
  const restore = stubMaCommands((command) => {
    assert.equal(command, 'players/all');
    return [samplePlayer];
  });
  try {
    const res = await fastify.inject({ method: 'GET', url: '/api/ma/players' });
    assert.equal(res.statusCode, 200);
    const players = res.json().players;
    assert.equal(players.length, 1);
    assert.equal(players[0].id, 'player-1');
    assert.equal(players[0].name, 'Kitchen Speaker');
    assert.equal(players[0].state, 'playing');
    assert.equal(players[0].volume, 42);
    assert.equal(players[0].muted, false);
    assert.equal(players[0].title, 'Bohemian Rhapsody');
    assert.equal(players[0].artist, 'Queen');
    assert.equal(players[0].artwork, 'http://ma.test:8095/img/cover.jpg');
    assert.equal(players[0].elapsedSeconds, 12);
    assert.equal(players[0].durationSeconds, 355);
  } finally {
    restore();
  }
});

test('GET /api/ma/players sends the configured bearer token', async () => {
  clearMaTokenCache();
  const { fastify } = await buildServer();
  let auth = '';
  const restore = stubFetch((url, init) => {
    assert.match(url, /^http:\/\/ma\.test:8095\/api$/);
    auth = String(init?.headers?.authorization ?? '');
    return jsonResponse([samplePlayer]);
  });
  try {
    const res = await fastify.inject({ method: 'GET', url: '/api/ma/players' });
    assert.equal(res.statusCode, 200);
    assert.equal(auth, 'Bearer long-lived-token');
  } finally {
    restore();
  }
});

test('GET /api/ma/players returns 503 when MA is not configured', async () => {
  clearMaTokenCache();
  const { fastify } = await buildServer(makeConfig({ musicAssistantUrl: '', musicAssistantToken: '' }));
  const res = await fastify.inject({ method: 'GET', url: '/api/ma/players' });
  assert.equal(res.statusCode, 503);
  assert.match(res.json().error, /not configured/);
});

test('GET /api/ma/players returns 503 when neither token nor credentials are set', async () => {
  clearMaTokenCache();
  const { fastify } = await buildServer(makeConfig({ musicAssistantToken: '' }));
  const res = await fastify.inject({ method: 'GET', url: '/api/ma/players' });
  assert.equal(res.statusCode, 503);
  assert.match(res.json().error, /token or a username and password/);
});

test('GET /api/ma/state returns a single player by id', async () => {
  clearMaTokenCache();
  const { fastify } = await buildServer();
  const restore = stubMaCommands(() => [samplePlayer, { player_id: 'player-2', name: 'Bedroom' }]);
  try {
    const res = await fastify.inject({ method: 'GET', url: '/api/ma/state?playerId=player-2' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().player.id, 'player-2');
    assert.equal(res.json().player.name, 'Bedroom');
  } finally {
    restore();
  }
});

test('GET /api/ma/state returns 404 for an unknown player', async () => {
  clearMaTokenCache();
  const { fastify } = await buildServer();
  const restore = stubMaCommands(() => [samplePlayer]);
  try {
    const res = await fastify.inject({ method: 'GET', url: '/api/ma/state?playerId=nope' });
    assert.equal(res.statusCode, 404);
  } finally {
    restore();
  }
});

// ─── Radios / playlists / search ──────────────────────────────────────────────

test('GET /api/ma/radios merges library and provider radios (DAB+ provider)', async () => {
  clearMaTokenCache();
  clearMaRadioCache();
  const { fastify } = await buildServer();
  const restore = stubMaCommands((command, args) => {
    if (command === 'music/radios/library_items') {
      return [
        { uri: 'library://radio/22', name: 'Triple M', image_url: 'http://ma.test:8095/logo.png' },
        { uri: 'library://radio/23', name: 'ABC Jazz' },
      ];
    }
    if (command === 'music/browse') {
      if (!args.path) {
        return [{ uri: 'sdrradio://', name: 'SDR Radio (DAB+)', media_type: 'folder', provider: 'sdrradio' }];
      }
      assert.equal(args.path, 'sdrradio://');
      return [
        // "Triple M" is already in the library, so it must be deduped.
        { uri: 'sdrradio://radio/dab:triplem', name: 'Triple M', media_type: 'radio', provider: 'sdrradio' },
        { uri: 'sdrradio://radio/dab:gold', name: 'GOLD 104.3', media_type: 'radio', provider: 'sdrradio' },
      ];
    }
    throw new Error(`unexpected command ${command}`);
  });
  try {
    const res = await fastify.inject({ method: 'GET', url: '/api/ma/radios?search=triple' });
    assert.equal(res.statusCode, 200);
    const radios = res.json().radios;
    assert.equal(radios.length, 1);
    assert.equal(radios[0].uri, 'library://radio/22');
    assert.equal(radios[0].name, 'Triple M');
    assert.equal(radios[0].artwork, 'http://ma.test:8095/logo.png');
  } finally {
    restore();
  }
});

test('GET /api/ma/radios includes provider-only stations', async () => {
  clearMaTokenCache();
  clearMaRadioCache();
  const { fastify } = await buildServer();
  const restore = stubMaCommands((command, args) => {
    if (command === 'music/radios/library_items') {
      return [{ uri: 'library://radio/22', name: 'Triple M' }];
    }
    if (command === 'music/browse') {
      if (!args.path) {
        return [{ uri: 'sdrradio://', name: 'SDR Radio (DAB+)', media_type: 'folder', provider: 'sdrradio' }];
      }
      return [
        { uri: 'sdrradio://radio/dab:triplem', name: 'Triple M', media_type: 'radio', provider: 'sdrradio' },
        { uri: 'sdrradio://radio/dab:gold', name: 'GOLD 104.3', media_type: 'radio', provider: 'sdrradio' },
      ];
    }
    throw new Error(`unexpected command ${command}`);
  });
  try {
    const res = await fastify.inject({ method: 'GET', url: '/api/ma/radios' });
    assert.equal(res.statusCode, 200);
    const radios = res.json().radios;
    assert.equal(radios.length, 2);
    assert.deepEqual(radios.map((r: { name: string }) => r.name), ['Triple M', 'GOLD 104.3']);
  } finally {
    restore();
  }
});

test('GET /api/ma/playlists returns playlists', async () => {
  clearMaTokenCache();
  const { fastify } = await buildServer();
  const restore = stubMaCommands((command) => {
    assert.equal(command, 'music/playlists/library_items');
    return [{ uri: 'spotify:playlist:abc', name: 'Road Trip', track_count: 42 }];
  });
  try {
    const res = await fastify.inject({ method: 'GET', url: '/api/ma/playlists' });
    assert.equal(res.statusCode, 200);
    const playlists = res.json().playlists;
    assert.equal(playlists.length, 1);
    assert.equal(playlists[0].name, 'Road Trip');
    assert.equal(playlists[0].trackCount, 42);
  } finally {
    restore();
  }
});

test('GET /api/ma/search searches the MA library', async () => {
  clearMaTokenCache();
  clearMaRadioCache();
  const { fastify } = await buildServer();
  const restore = stubMaCommands((command, args) => {
    if (command === 'music/search') {
      assert.equal(args.search_query, 'queen');
      return {
        tracks: [{ uri: 'ytmusic://track/1', name: 'Bohemian Rhapsody', artists: [{ name: 'Queen' }] }],
        radios: [],
        playlists: [],
      };
    }
    if (command === 'music/radios/library_items') return [];
    if (command === 'music/browse') return [];
    throw new Error(`unexpected command ${command}`);
  });
  try {
    const res = await fastify.inject({ method: 'GET', url: '/api/ma/search?q=queen' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.tracks.length, 1);
    assert.equal(body.tracks[0].artist, 'Queen');
  } finally {
    restore();
  }
});

test('GET /api/ma/search includes provider radios that MA search does not index', async () => {
  clearMaTokenCache();
  clearMaRadioCache();
  const { fastify } = await buildServer();
  const restore = stubMaCommands((command, args) => {
    if (command === 'music/search') return { tracks: [], radios: [], playlists: [] };
    if (command === 'music/radios/library_items') return [];
    if (command === 'music/browse') {
      if (!args.path) {
        return [{ uri: 'sdrradio://', name: 'SDR Radio (DAB+)', media_type: 'folder', provider: 'sdrradio' }];
      }
      return [
        { uri: 'sdrradio://radio/dab:abcclassic', name: 'ABC Classic', media_type: 'radio', provider: 'sdrradio' },
        { uri: 'sdrradio://radio/dab:gold', name: 'GOLD 104.3', media_type: 'radio', provider: 'sdrradio' },
      ];
    }
    throw new Error(`unexpected command ${command}`);
  });
  try {
    const res = await fastify.inject({ method: 'GET', url: '/api/ma/search?q=abc' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.radios.length, 1);
    assert.equal(body.radios[0].name, 'ABC Classic');
    assert.equal(body.radios[0].uri, 'sdrradio://radio/dab:abcclassic');
  } finally {
    restore();
  }
});

test('GET /api/ma/search requires a query', async () => {
  const { fastify } = await buildServer();
  const res = await fastify.inject({ method: 'GET', url: '/api/ma/search' });
  assert.equal(res.statusCode, 400);
});

// ─── Play + control ──────────────────────────────────────────────────────────

test('POST /api/ma/play sends play_media to the player queue', async () => {
  clearMaTokenCache();
  const { fastify } = await buildServer();
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  const restore = stubMaCommands((command, args) => {
    calls.push({ command, args });
    return null;
  });
  try {
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/ma/play',
      payload: { uri: 'library://radio/22', playerId: 'player-1' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().success, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'player_queues/play_media');
    assert.equal(calls[0].args.queue_id, 'player-1');
    assert.equal(calls[0].args.media, 'library://radio/22');
    assert.equal(calls[0].args.option, 'replace');
  } finally {
    restore();
  }
});

test('POST /api/ma/play validates uri and playerId', async () => {
  const { fastify } = await buildServer();
  assert.equal((await fastify.inject({ method: 'POST', url: '/api/ma/play', payload: {} })).statusCode, 400);
  assert.equal(
    (await fastify.inject({ method: 'POST', url: '/api/ma/play', payload: { uri: 'x' } })).statusCode,
    400,
  );
});

test('POST /api/ma/control maps actions to MA player commands', async () => {
  clearMaTokenCache();
  const { fastify } = await buildServer();
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  const restore = stubMaCommands((command, args) => {
    calls.push({ command, args });
    return null;
  });
  try {
    const send = (payload: Record<string, unknown>) =>
      fastify.inject({ method: 'POST', url: '/api/ma/control', payload });

    assert.equal((await send({ action: 'pause', playerId: 'p1' })).statusCode, 200);
    assert.equal((await send({ action: 'volume', playerId: 'p1', level: 55 })).statusCode, 200);
    assert.equal((await send({ action: 'mute', playerId: 'p1', muted: true })).statusCode, 200);
    assert.equal((await send({ action: 'next', playerId: 'p1' })).statusCode, 200);

    assert.deepEqual(
      calls.map((call) => [call.command, call.args]),
      [
        ['players/cmd/pause', { player_id: 'p1' }],
        ['players/cmd/volume_set', { player_id: 'p1', volume_level: 55 }],
        ['players/cmd/volume_mute', { player_id: 'p1', muted: true }],
        ['players/cmd/next', { player_id: 'p1' }],
      ],
    );
  } finally {
    restore();
  }
});

test('POST /api/ma/control rejects an unknown action', async () => {
  const { fastify } = await buildServer();
  const res = await fastify.inject({
    method: 'POST',
    url: '/api/ma/control',
    payload: { action: 'explode', playerId: 'p1' },
  });
  assert.equal(res.statusCode, 400);
});

// ─── Login flow ───────────────────────────────────────────────────────────────

test('MA client logs in with username/password when no token is configured', async () => {
  clearMaTokenCache();
  const { fastify } = await buildServer(
    makeConfig({ musicAssistantToken: '', musicAssistantUsername: 'admin', musicAssistantPassword: 'pw' }),
  );
  const requests: string[] = [];
  const restore = stubFetch((url, init) => {
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/auth/login')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { provider_id?: string; credentials?: Record<string, string> };
      assert.equal(body.provider_id, 'builtin');
      assert.equal(body.credentials?.username, 'admin');
      assert.equal(body.credentials?.password, 'pw');
      return jsonResponse({ success: true, token: 'fresh-login-token', user: { username: 'admin' } });
    }
    assert.match(url, /^http:\/\/ma\.test:8095\/api$/);
    assert.equal(String(init?.headers?.authorization ?? ''), 'Bearer fresh-login-token');
    return jsonResponse([samplePlayer]);
  });
  try {
    const res = await fastify.inject({ method: 'GET', url: '/api/ma/players' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().players.length, 1);
    assert.deepEqual(requests, [
      'POST http://ma.test:8095/auth/login',
      'POST http://ma.test:8095/api',
    ]);

    // The login token is cached: a second call goes straight to /api.
    requests.length = 0;
    await fastify.inject({ method: 'GET', url: '/api/ma/players' });
    assert.deepEqual(requests, ['POST http://ma.test:8095/api']);
  } finally {
    restore();
    clearMaTokenCache();
  }
});

test('MA command errors surface as 502 with the MA detail', async () => {
  clearMaTokenCache();
  const { fastify } = await buildServer();
  const restore = stubFetch(() => new Response('Invalid Command: nope', { status: 200 }));
  try {
    const res = await fastify.inject({ method: 'GET', url: '/api/ma/players' });
    assert.equal(res.statusCode, 502);
    assert.match(res.json().error, /Invalid Command: nope/);
  } finally {
    restore();
  }
});

// ─── Connection test (Settings → Media) ──────────────────────────────────────

test('GET /api/ma/test reports the player count', async () => {
  clearMaTokenCache();
  const { fastify } = await buildServer();
  const restore = stubMaCommands(() => [samplePlayer]);
  try {
    const res = await fastify.inject({ method: 'GET', url: '/api/ma/test' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);
    assert.match(res.json().detail, /1 player\b/);
  } finally {
    restore();
  }
});

test('GET /api/ma/test reports a failure without throwing', async () => {
  clearMaTokenCache();
  const { fastify } = await buildServer();
  const restore = stubFetch(() => new Response('Authentication required', { status: 200 }));
  try {
    const res = await fastify.inject({ method: 'GET', url: '/api/ma/test' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, false);
    assert.match(res.json().error, /Music Assistant unavailable/);
  } finally {
    restore();
  }
});

test('GET /api/ma/test reports an unconfigured source', async () => {
  clearMaTokenCache();
  const { fastify } = await buildServer(makeConfig({ musicAssistantUrl: '', musicAssistantToken: '' }));
  const res = await fastify.inject({ method: 'GET', url: '/api/ma/test' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, false);
  assert.match(res.json().error, /not configured/);
});

// ─── Settings ────────────────────────────────────────────────────────────────

test('GET /api/settings exposes the MA settings and redacts secrets', async () => {
  const { fastify } = await buildServer();
  const res = await fastify.inject({ method: 'GET', url: '/api/settings' });
  assert.equal(res.statusCode, 200);
  const settings = res.json();
  assert.equal(settings.music_assistant_url, 'http://ma.test:8095');
  assert.equal(settings.music_assistant_token, '••••••••');
  assert.ok('music_assistant_username' in settings);
  assert.ok('music_assistant_password' in settings);
});
