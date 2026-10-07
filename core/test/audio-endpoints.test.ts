import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createTestDb } from './db-helpers.js';
import { registerAudioEndpointRoutes, assignedEndpointForDevice, parseAudioEndpointSettings, DEFAULT_AUDIO_ENDPOINT_SETTINGS } from '../src/audio-endpoints.js';

function buildServer() {
  const { pool } = createTestDb();
  const fastify = Fastify({ logger: false });
  // No auth in tests: the preHandler factory returns undefined.
  const requireAdmin = (() => undefined) as unknown as Parameters<typeof registerAudioEndpointRoutes>[2];
  registerAudioEndpointRoutes(fastify, pool, {
    requireAdmin,
    setDesiredState: async () => 1,
    resolveEdgeVoiceToken: async () => 'edge-token',
    checkEdgeVoiceAuth: (expected, presented) => Boolean(expected && expected === presented),
  });
  return { fastify, pool };
}

test('per-endpoint audio controls validate supported ranges and preserve defaults', () => {
  assert.deepEqual(parseAudioEndpointSettings(DEFAULT_AUDIO_ENDPOINT_SETTINGS), DEFAULT_AUDIO_ENDPOINT_SETTINGS);
  assert.deepEqual(parseAudioEndpointSettings({ playback_volume: 35, treble_db: -2, mic_capture_gain: 2, mic_preemphasis: 0.8 }), {
    playback_volume: 35, treble_db: -2, mic_capture_gain: 2, mic_preemphasis: 0.8,
  });
  assert.throws(() => parseAudioEndpointSettings({ playback_volume: 101, treble_db: 0, mic_capture_gain: 1, mic_preemphasis: 0.9 }));
  assert.throws(() => parseAudioEndpointSettings({ playback_volume: 20, treble_db: 0, mic_capture_gain: 1, mic_preemphasis: 'high' }));
});

test('audio endpoint registers, receives a token, and can heartbeat', async () => {
  process.env.CANVAS_CORE_AUDIO_ENDPOINT_SECRET = 'test-secret';
  const { fastify } = buildServer();
  await fastify.ready();

  const reg = await fastify.inject({
    method: 'POST',
    url: '/api/edge/audio-endpoints/register',
    headers: { 'x-enrollment-secret': 'test-secret' },
    payload: { id: 'ae-abc', name: 'Kitchen', port: 8090, firmware: '1' },
  });
  assert.equal(reg.statusCode, 200, reg.body);
  const token = reg.json().token as string;
  assert.ok(token && token.length > 10);

  const hb = await fastify.inject({
    method: 'POST',
    url: '/api/edge/audio-endpoints/heartbeat',
    headers: { authorization: `Bearer ${token}` },
    payload: { id: 'ae-abc' },
  });
  assert.equal(hb.statusCode, 200, hb.body);

  const list = await fastify.inject({ method: 'GET', url: '/api/admin/audio-endpoints' });
  assert.equal(list.statusCode, 200);
  const endpoints = list.json().endpoints as Array<{ id: string; online: boolean }>;
  assert.equal(endpoints.length, 1);
  assert.equal(endpoints[0].id, 'ae-abc');
  assert.equal(endpoints[0].online, true);
});

test('registration rejects a bad enrollment secret', async () => {
  process.env.CANVAS_CORE_AUDIO_ENDPOINT_SECRET = 'test-secret';
  const { fastify } = buildServer();
  await fastify.ready();
  const reg = await fastify.inject({
    method: 'POST',
    url: '/api/edge/audio-endpoints/register',
    headers: { 'x-enrollment-secret': 'wrong' },
    payload: { id: 'ae-x' },
  });
  assert.equal(reg.statusCode, 401);
});

test('assigning an endpoint to a device is retrievable for desired state', async () => {
  process.env.CANVAS_CORE_AUDIO_ENDPOINT_SECRET = 'test-secret';
  const { fastify, pool } = buildServer();
  await fastify.ready();
  await pool.query("INSERT INTO devices (id, name, architecture) VALUES ('dev-1','Kitchen','arm64')");
  await fastify.inject({
    method: 'POST',
    url: '/api/edge/audio-endpoints/register',
    headers: { 'x-enrollment-secret': 'test-secret' },
    payload: { id: 'ae-1', port: 8090 },
  });
  const assign = await fastify.inject({
    method: 'PUT',
    url: '/api/admin/audio-endpoints/ae-1/assign',
    payload: { deviceId: 'dev-1' },
  });
  assert.equal(assign.statusCode, 200, assign.body);

  const ep = await assignedEndpointForDevice(pool, 'dev-1');
  assert.ok(ep);
  assert.equal(ep!.id, 'ae-1');
  assert.ok(ep!.token);
});

test('assignment pushes desired state and the edge route returns it', async () => {
  process.env.CANVAS_CORE_AUDIO_ENDPOINT_SECRET = 'test-secret';
  const pushed: Array<{ deviceId: string; domain: string; state: unknown }> = [];
  const { pool } = createTestDb();
  const fastify = Fastify({ logger: false });
  const requireAdmin = (() => undefined) as unknown as Parameters<typeof registerAudioEndpointRoutes>[2];
  registerAudioEndpointRoutes(fastify, pool, {
    requireAdmin,
    setDesiredState: async (deviceId, domain, state) => {
      pushed.push({ deviceId, domain, state });
      return 1;
    },
    resolveEdgeVoiceToken: async () => 'edge-token',
    checkEdgeVoiceAuth: (expected, presented) => Boolean(expected && expected === presented),
  });
  await fastify.ready();
  await pool.query("INSERT INTO devices (id, name, architecture) VALUES ('dev-2','Office','arm64')");
  await fastify.inject({
    method: 'POST',
    url: '/api/edge/audio-endpoints/register',
    headers: { 'x-enrollment-secret': 'test-secret' },
    payload: { id: 'ae-2', port: 8090 },
  });

  const assign = await fastify.inject({
    method: 'PUT',
    url: '/api/admin/audio-endpoints/ae-2/assign',
    payload: { deviceId: 'dev-2' },
  });
  assert.equal(assign.statusCode, 200, assign.body);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].deviceId, 'dev-2');
  assert.equal(pushed[0].domain, 'audio');
  const state = pushed[0].state as { endpoint_id: string; address: string; port: number; token: string };
  assert.equal(state.endpoint_id, 'ae-2');
  assert.ok(state.address);
  assert.ok(state.token);

  // The edge-facing route returns the same assignment.
  const edge = await fastify.inject({
    method: 'GET',
    url: '/api/edge/audio/assignment?deviceId=dev-2',
    headers: { authorization: 'Bearer edge-token' },
  });
  assert.equal(edge.statusCode, 200, edge.body);
  const body = edge.json();
  assert.equal(body.id, 'ae-2');
  assert.equal(body.port, 8090);
  assert.ok(body.token);

  // Unassigning clears the desired state for the previous device.
  const unassign = await fastify.inject({
    method: 'PUT',
    url: '/api/admin/audio-endpoints/ae-2/assign',
    payload: { deviceId: null },
  });
  assert.equal(unassign.statusCode, 200, unassign.body);
  assert.equal(pushed.length, 2);
  assert.equal(pushed[1].deviceId, 'dev-2');
  assert.equal((pushed[1].state as { endpoint_id: string | null }).endpoint_id, null);

  const edgeEmpty = await fastify.inject({
    method: 'GET',
    url: '/api/edge/audio/assignment?deviceId=dev-2',
    headers: { authorization: 'Bearer edge-token' },
  });
  assert.equal(edgeEmpty.statusCode, 200, edgeEmpty.body);
  assert.equal(edgeEmpty.json().empty, true);
});

test('saving endpoint controls persists them and pushes them to the assigned edge', async () => {
  process.env.CANVAS_CORE_AUDIO_ENDPOINT_SECRET = 'test-secret';
  const pushed: Array<{ deviceId: string; domain: string; state: unknown }> = [];
  const { pool } = createTestDb();
  const fastify = Fastify({ logger: false });
  const requireAdmin = (() => undefined) as unknown as Parameters<typeof registerAudioEndpointRoutes>[2];
  registerAudioEndpointRoutes(fastify, pool, {
    requireAdmin,
    setDesiredState: async (deviceId, domain, state) => { pushed.push({ deviceId, domain, state }); return 1; },
    resolveEdgeVoiceToken: async () => 'edge-token',
    checkEdgeVoiceAuth: (expected, presented) => Boolean(expected && expected === presented),
  });
  await fastify.ready();
  await pool.query("INSERT INTO devices (id, name, architecture) VALUES ('dev-audio','Kitchen','arm64')");
  await fastify.inject({ method: 'POST', url: '/api/edge/audio-endpoints/register', headers: { 'x-enrollment-secret': 'test-secret' }, payload: { id: 'ae-settings' } });
  await fastify.inject({ method: 'PUT', url: '/api/admin/audio-endpoints/ae-settings/assign', payload: { deviceId: 'dev-audio' } });
  const settings = { playback_volume: 42, treble_db: 3, mic_capture_gain: 1.5, mic_preemphasis: 0.8 };
  const saved = await fastify.inject({ method: 'PUT', url: '/api/admin/audio-endpoints/ae-settings/settings', payload: { settings } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual((pushed.at(-1)?.state as { settings: unknown }).settings, settings);
  const list = await fastify.inject({ method: 'GET', url: '/api/admin/audio-endpoints' });
  assert.deepEqual(list.json().endpoints[0].settings, settings);
  await fastify.close();
});

test('edge assignment route rejects a bad credential', async () => {
  const { fastify } = buildServer();
  await fastify.ready();
  const res = await fastify.inject({
    method: 'GET',
    url: '/api/edge/audio/assignment?deviceId=dev-1',
    headers: { authorization: 'Bearer wrong' },
  });
  assert.equal(res.statusCode, 401);
});

test('test-mic reports per-channel RMS from the endpoint', async () => {
  process.env.CANVAS_CORE_AUDIO_ENDPOINT_SECRET = 'test-secret';
  const { fastify, pool } = buildServer();
  await fastify.ready();

  // Mock endpoint: answers HELLO_ACK, then streams 3 mic frames of a known tone
  // on channel 0 (silence elsewhere).
  const net = await import('node:net');
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    const send = (type: number, payload: Buffer) => {
      const total = payload.length + 1;
      const hdr = Buffer.alloc(3);
      hdr.writeUInt16LE(total, 0);
      hdr.writeUInt8(type, 2);
      sock.write(Buffer.concat([hdr, payload]));
    };
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 3) {
        const total = buf.readUInt16LE(0);
        if (buf.length < 2 + total) return;
        const type = buf.readUInt8(2);
        buf = buf.subarray(2 + total);
        if (type === 1) { // HELLO
          send(2, Buffer.from([1, 0])); // HELLO_ACK ok
          const meta = Buffer.alloc(8);
          const pcm = Buffer.alloc(320 * 8 * 2);
          for (let s = 0; s < 320; s++) {
            pcm.writeInt16LE(Math.round(1000 * Math.sin(s / 10)), s * 8 * 2); // ch0 tone
          }
          for (let i = 0; i < 3; i++) {
            send(4, Buffer.concat([meta, pcm]));
          }
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;

  await pool.query("INSERT INTO audio_endpoints (id, name, address, port, token, token_hash) VALUES ('ae-t1','T1','127.0.0.1',$1,'tok','hash')", [port]);
  const res = await fastify.inject({ method: 'POST', url: '/api/admin/audio-endpoints/ae-t1/test-mic' });
  server.close();
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.ok(body.rms[0] > 500, `channel 0 should be loud, got ${body.rms[0]}`);
  assert.ok(body.rms[1] < 50, `channel 1 should be silent, got ${body.rms[1]}`);
});
