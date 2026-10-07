/**
 * Audio endpoints — network microphone + speaker peripherals (Pico W) that can
 * be assigned to an edge device. Core is the control plane: it holds the
 * registry, issues per-endpoint tokens, and records which device each endpoint
 * belongs to. Audio itself flows directly between the endpoint and the edge on
 * the LAN and never passes through Core.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { RequireAdminOptions } from './auth.js';
import { testEndpointMic, testEndpointSpeaker } from './audio-endpoint-test.js';

type RequireAdmin = (opts?: RequireAdminOptions) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface AudioEndpointSettings {
  playback_volume: number;
  treble_db: number;
  mic_capture_gain: number;
  mic_preemphasis: number;
}

export const DEFAULT_AUDIO_ENDPOINT_SETTINGS: AudioEndpointSettings = {
  playback_volume: 15,
  treble_db: 6,
  mic_capture_gain: 1,
  mic_preemphasis: 0.95,
};

export function parseAudioEndpointSettings(value: unknown): AudioEndpointSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('settings must be an object');
  const input = value as Record<string, unknown>;
  const result = { ...DEFAULT_AUDIO_ENDPOINT_SETTINGS };
  const bounds: Record<keyof AudioEndpointSettings, [number, number]> = {
    playback_volume: [0, 100], treble_db: [-6, 9], mic_capture_gain: [0.5, 8], mic_preemphasis: [0, 0.99],
  };
  for (const key of Object.keys(bounds) as Array<keyof AudioEndpointSettings>) {
    const v = input[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < bounds[key][0] || v > bounds[key][1]) {
      throw new Error(`${key} must be between ${bounds[key][0]} and ${bounds[key][1]}`);
    }
    result[key] = v;
  }
  return result;
}

export interface AudioEndpointRow {
  id: string;
  name: string;
  address: string | null;
  port: number;
  assigned_device_id: string | null;
  firmware_version: string | null;
  last_seen: string | null;
  created_at: string;
}

/** An endpoint is "online" if it has heart-beaten within this window. */
const ONLINE_WINDOW_MS = 45_000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}

function enrollmentSecret(): string {
  return process.env.CANVAS_CORE_AUDIO_ENDPOINT_SECRET || 'changeme-enrollment';
}

function isOnline(row: AudioEndpointRow): boolean {
  if (!row.last_seen) return false;
  return Date.now() - new Date(row.last_seen).getTime() < ONLINE_WINDOW_MS;
}

function publicEndpoint(row: AudioEndpointRow) {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    port: row.port,
    assignedDeviceId: row.assigned_device_id,
    firmwareVersion: row.firmware_version,
    lastSeen: row.last_seen,
    online: isOnline(row),
  };
}

/**
 * The endpoint assigned to a device, with the token the edge must present to it.
 * Used when Core pushes desired state to the edge.
 */
export async function assignedEndpointForDevice(
  pool: Pool,
  deviceId: string,
): Promise<{ id: string; address: string; port: number; token: string; settings: AudioEndpointSettings } | null> {
  const res = await pool.query<AudioEndpointRow & { token: string; settings: AudioEndpointSettings }>(
    'SELECT id, name, address, port, assigned_device_id, firmware_version, last_seen, created_at, token, settings FROM audio_endpoints WHERE assigned_device_id = $1 LIMIT 1',
    [deviceId],
  );
  const row = res.rows[0];
  if (!row || !row.address) return null;
  return { id: row.id, address: row.address, port: row.port, token: row.token, settings: row.settings ?? DEFAULT_AUDIO_ENDPOINT_SETTINGS };
}

export interface AudioEndpointRouteOptions {
  requireAdmin: RequireAdmin;
  /** Record the edge's `audio` desired-state domain (assignment push). */
  setDesiredState: (deviceId: string, domain: string, state: unknown) => Promise<number>;
  /** Edge-credential resolution + check (same pattern as other /api/edge routes). */
  resolveEdgeVoiceToken: (presented: string) => Promise<string | null>;
  checkEdgeVoiceAuth: (expected: string | null, presented: string) => boolean;
}

export function registerAudioEndpointRoutes(
  fastify: FastifyInstance,
  pool: Pool,
  options: AudioEndpointRouteOptions,
): void {
  const { requireAdmin, setDesiredState, resolveEdgeVoiceToken, checkEdgeVoiceAuth } = options;

  // GET /api/edge/audio/assignment — the edge polls this to learn which endpoint
  // it is mated to. Returns {id, address, port, token} or {empty: true}.
  fastify.get<{ Querystring: { deviceId?: string } }>(
    '/api/edge/audio/assignment',
    async (request, reply) => {
      const presented = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
      const expected = await resolveEdgeVoiceToken(presented);
      if (!checkEdgeVoiceAuth(expected, presented)) {
        return reply.code(401).send({ error: 'invalid_edge_voice_credential' });
      }
      const deviceId = request.query.deviceId?.trim();
      if (!deviceId) return reply.code(400).send({ error: 'deviceId is required' });
      const assignment = await assignedEndpointForDevice(pool, deviceId);
      return assignment ?? { empty: true };
    },
  );
  fastify.post('/api/edge/audio-endpoints/register', async (request, reply) => {
    const body = (request.body ?? {}) as { id?: string; name?: string; port?: number; firmware?: string };
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (!id || !/^[a-zA-Z0-9._-]{1,64}$/.test(id)) {
      return reply.code(400).send({ error: 'invalid_endpoint_id' });
    }
    const presented = String(request.headers['x-enrollment-secret'] ?? '');
    if (presented !== enrollmentSecret()) {
      return reply.code(401).send({ error: 'invalid_enrollment_secret' });
    }
    const address = request.ip;
    const port = Number.isFinite(body.port) ? Number(body.port) : 8090;
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : id;
    const firmware = typeof body.firmware === 'string' ? body.firmware : null;

    const existing = await pool.query<{ token: string }>('SELECT token FROM audio_endpoints WHERE id = $1', [id]);
    const token = existing.rows[0]?.token ?? randomBytes(24).toString('hex');

    await pool.query(
      `INSERT INTO audio_endpoints (id, name, address, port, token, token_hash, firmware_version, last_seen)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, address = EXCLUDED.address, port = EXCLUDED.port,
         firmware_version = EXCLUDED.firmware_version, last_seen = now()`,
      [id, name, address, port, token, hashToken(token), firmware],
    );
    return { ok: true, id, token };
  });

  // POST /api/edge/audio-endpoints/heartbeat — keep-alive.
  fastify.post('/api/edge/audio-endpoints/heartbeat', async (request, reply) => {
    const body = (request.body ?? {}) as { id?: string };
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    const header = request.headers.authorization;
    const presented = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (!id || !presented) return reply.code(401).send({ error: 'unauthorized' });
    const res = await pool.query<{ token_hash: string }>('SELECT token_hash FROM audio_endpoints WHERE id = $1', [id]);
    const row = res.rows[0];
    if (!row || !safeEqualHex(row.token_hash, hashToken(presented))) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    await pool.query('UPDATE audio_endpoints SET last_seen = now(), address = $2 WHERE id = $1', [id, request.ip]);
    return { ok: true };
  });

  // GET /api/admin/audio-endpoints — list.
  fastify.get('/api/admin/audio-endpoints', {
    preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }),
  }, async () => {
    const res = await pool.query<AudioEndpointRow>(
      'SELECT id, name, address, port, assigned_device_id, firmware_version, last_seen, created_at, settings FROM audio_endpoints ORDER BY created_at ASC',
    );
    return { endpoints: res.rows.map((row) => ({ ...publicEndpoint(row), settings: (row as AudioEndpointRow & { settings?: AudioEndpointSettings }).settings ?? DEFAULT_AUDIO_ENDPOINT_SETTINGS })) };
  });

  // PUT /api/admin/audio-endpoints/:id/assign — assign to a device (or clear).
  // Also pushes the assignment into the device's `audio` desired-state domain so
  // the edge connects automatically.
  fastify.put<{ Params: { id: string }; Body: { deviceId?: string | null } }>(
    '/api/admin/audio-endpoints/:id/assign',
    { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) },
    async (request, reply) => {
      const { id } = request.params;
      const deviceId = request.body?.deviceId ?? null;
      const exists = await pool.query('SELECT 1 FROM audio_endpoints WHERE id = $1', [id]);
      if (!exists.rowCount) return reply.code(404).send({ error: 'endpoint_not_found' });

      // Remember the previous assignment so we can clear its desired state.
      const prev = await pool.query<{ assigned_device_id: string | null }>(
        'SELECT assigned_device_id FROM audio_endpoints WHERE id = $1', [id],
      );
      const prevDeviceId = prev.rows[0]?.assigned_device_id ?? null;

      if (deviceId) {
        const device = await pool.query('SELECT 1 FROM devices WHERE id = $1', [deviceId]);
        if (!device.rowCount) return reply.code(404).send({ error: 'device_not_found' });
        // One endpoint per device: clear any other endpoint assigned to it.
        await pool.query('UPDATE audio_endpoints SET assigned_device_id = NULL WHERE assigned_device_id = $1 AND id <> $2', [deviceId, id]);
      }
      await pool.query('UPDATE audio_endpoints SET assigned_device_id = $2 WHERE id = $1', [id, deviceId]);

      // Push desired state: the assigned endpoint (with token) or a clear.
      if (deviceId) {
        const ep = await pool.query<{ id: string; address: string | null; port: number; token: string; settings: AudioEndpointSettings }>(
          'SELECT id, address, port, token, settings FROM audio_endpoints WHERE id = $1', [id],
        );
        const row = ep.rows[0];
        if (row?.address) {
          await setDesiredState(deviceId, 'audio', {
            endpoint_id: row.id,
            address: row.address,
            port: row.port,
            token: row.token,
            settings: row.settings ?? DEFAULT_AUDIO_ENDPOINT_SETTINGS,
          });
        }
      } else if (prevDeviceId) {
        await setDesiredState(prevDeviceId, 'audio', {
          endpoint_id: null,
          address: null,
          port: null,
          token: null,
        });
      }
      return { ok: true, id, deviceId };
    },
  );

  // PUT /api/admin/audio-endpoints/:id/settings — per-endpoint audio tuning.
  fastify.put<{ Params: { id: string }; Body: { settings?: unknown } }>('/api/admin/audio-endpoints/:id/settings', {
    preHandler: requireAdmin({ roles: ['admin'], csrf: true }),
  }, async (request, reply) => {
    const { id } = request.params;
    let settings: AudioEndpointSettings;
    try { settings = parseAudioEndpointSettings(request.body?.settings); }
    catch (error) { return reply.code(400).send({ error: 'invalid_audio_settings', detail: error instanceof Error ? error.message : String(error) }); }
    const updated = await pool.query<{ assigned_device_id: string | null; id: string; address: string | null; port: number; token: string }>(
      'UPDATE audio_endpoints SET settings=$2 WHERE id=$1 RETURNING assigned_device_id,id,address,port,token', [id, settings],
    );
    const row = updated.rows[0];
    if (!row) return reply.code(404).send({ error: 'endpoint_not_found' });
    if (row.assigned_device_id) {
      await setDesiredState(row.assigned_device_id, 'audio', row.address ? {
        endpoint_id: row.id, address: row.address, port: row.port, token: row.token, settings,
      } : { endpoint_id: null, address: null, port: null, token: null, settings });
    }
    return { ok: true, id, settings };
  });

  // DELETE /api/admin/audio-endpoints/:id
  fastify.delete<{ Params: { id: string } }>('/api/admin/audio-endpoints/:id', {
    preHandler: requireAdmin({ roles: ['admin'], csrf: true }),
  }, async (request) => {
    await pool.query('DELETE FROM audio_endpoints WHERE id = $1', [request.params.id]);
    return { ok: true };
  });

  // POST /api/admin/audio-endpoints/:id/test-mic — read a few frames and report
  // per-channel RMS so silent mics are obvious from the Core UI.
  fastify.post<{ Params: { id: string } }>('/api/admin/audio-endpoints/:id/test-mic', {
    preHandler: requireAdmin({ roles: ['admin'], csrf: true }),
  }, async (request, reply) => {
    const { id } = request.params;
    const res = await pool.query<{ address: string | null; port: number; token: string }>(
      'SELECT address, port, token FROM audio_endpoints WHERE id = $1', [id],
    );
    const row = res.rows[0];
    if (!row) return reply.code(404).send({ error: 'endpoint_not_found' });
    if (!row.address) return reply.code(409).send({ error: 'endpoint_offline', detail: 'endpoint has no recorded address' });
    try {
      return await testEndpointMic(row.address, row.port, row.token);
    } catch (err) {
      return reply.code(502).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/admin/audio-endpoints/:id/test-speaker — send a short tone to the DAC.
  fastify.post<{ Params: { id: string } }>('/api/admin/audio-endpoints/:id/test-speaker', {
    preHandler: requireAdmin({ roles: ['admin'], csrf: true }),
  }, async (request, reply) => {
    const { id } = request.params;
    const res = await pool.query<{ address: string | null; port: number; token: string }>(
      'SELECT address, port, token FROM audio_endpoints WHERE id = $1', [id],
    );
    const row = res.rows[0];
    if (!row) return reply.code(404).send({ error: 'endpoint_not_found' });
    if (!row.address) return reply.code(409).send({ error: 'endpoint_offline', detail: 'endpoint has no recorded address' });
    try {
      return await testEndpointSpeaker(row.address, row.port, row.token);
    } catch (err) {
      return reply.code(502).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
