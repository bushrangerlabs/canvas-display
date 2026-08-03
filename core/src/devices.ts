import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { GatewayController } from './gateway.js';

/**
 * Device registry + pairing-invitation scaffold (Phase 2 checklist: "device registry,
 * pairing invitations, groups, capabilities, certificate metadata, rotation, clone
 * handling, active revocation, and restore safeguards"; plan doc §12.3, §26.5; aligns
 * with `docs/PHASE_0_PKI_BOOTSTRAP_SPEC.md`).
 *
 * PRAGMATIC FIRST CUT (PKI/mTLS is P-003, later):
 *   - Pairing invitations are simple one-time tokens. Core stores only a SHA-256 hash
 *     of the token (the spec mandates hash-only storage of secrets at rest).
 *   - The `devices` table already records any `edge.hello` (the proven, open bootstrap
 *     path the real Rust agent depends on). Invitation support is ADDED alongside it:
 *     if a hello carries a valid, unused invitation token, the device is marked
 *     `paired = true` and bound to the invitation; plain hello still works untouched.
 *   - Certificate metadata columns (`cert_fingerprint`, `cert_issued_at`,
 *     `cert_expires_at`, `revoked_at`) exist now so P-003 can fill them without a
 *     migration. `authority_mode` defaults to `legacy` per §26.5.
 *
 * The repository is injected so unit tests can run against an in-memory Postgres.
 */

export type AuthorityMode = 'legacy' | 'shadow' | 'core' | 'rollback_pending';

export interface DeviceRow {
  id: string;
  name: string;
  architecture: string;
  protocol_version: string;
  group_name: string;
  capabilities: string;
  authority_mode: AuthorityMode;
  paired: boolean;
  status: string;
  last_seen: string;
  revoked_at: string | null;
  /** P-003: Phase 0 public-key fingerprint (SHA-256 hex of the raw Ed25519 public key) for
   * enrolled devices; null for legacy/open-paired devices. */
  cert_fingerprint: string | null;
  /** Per-device audio configuration (mic_device, speaker_device, mic_volume, speaker_volume). */
  audio_config?: Record<string, any>;
  /** Per-device voice configuration (wake_word, wake_threshold, wake_enabled, language, pipeline). */
  voice_config?: Record<string, any>;
}

export interface InvitationRecord {
  id: string;
  scope: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  used_by_device_id: string | null;
}

export interface AuthRepositoryLike {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

/** Storage abstraction so tests can swap in an in-memory Postgres (`pg-mem`). */
export interface DeviceRepository {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export class PgDeviceRepository implements DeviceRepository {
  constructor(private readonly pool: Pool) {}
  query(text: string, params?: unknown[]) {
    return this.pool.query(text, params as unknown[]) as unknown as Promise<{ rows: any[]; rowCount: number | null }>;
  }
}

// --- invitation token hashing (SHA-256, hash-only at rest) ------------------

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export const DEFAULT_INVITATION_TTL_SECONDS = 60 * 60 * 24; // 24h

export interface CreateInvitationResult {
  id: string;
  token: string; // returned ONCE to the admin; never stored
  scope: string;
  expires_at: string;
}

/**
 * Creates a one-time pairing invitation. Returns the plaintext token exactly once;
 * only its hash is persisted.
 */
export async function createInvitation(
  repo: DeviceRepository,
  options: { scope?: string; createdBy?: string; ttlSeconds?: number },
): Promise<CreateInvitationResult> {
  const id = randomUUID();
  const token = randomBytes(32).toString('hex');
  const scope = options.scope ?? '';
  const createdBy = options.createdBy ?? '';
  const ttl = options.ttlSeconds ?? DEFAULT_INVITATION_TTL_SECONDS;
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  await repo.query(
    `INSERT INTO device_invitations (id, token_hash, scope, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, hashToken(token), scope, createdBy, expiresAt],
  );
  return { id, token, scope, expires_at: expiresAt };
}

export interface ConsumeInvitationResult {
  ok: boolean;
  id?: string;
  scope?: string;
}

/**
 * Atomically consumes a one-time invitation: marks it used and returns its metadata,
 * or `ok: false` if unknown / already used / expired. Uses a single UPDATE ... WHERE
 * to serialize concurrent consumers (the spec's "exactly one winner" requirement).
 */
export async function consumeInvitation(
  repo: DeviceRepository,
  token: string,
): Promise<ConsumeInvitationResult> {
  const tokenHash = hashToken(token);
  const res = await repo.query(
    `UPDATE device_invitations
     SET used_at = now(), used_by_device_id = $2
     WHERE token_hash = $1
       AND used_at IS NULL
       AND challenge_issued_at IS NULL
       AND expires_at > now()
     RETURNING id, scope`,
    [tokenHash, 'pending'],
  );
  if (res.rowCount === 0 || !res.rows[0]) return { ok: false };
  return { ok: true, id: res.rows[0].id, scope: res.rows[0].scope };
}

/**
 * Records a device on `edge.hello`. Preserves the existing open behavior (any hello is
 * recorded), and ADDS invitation binding: if `invitationToken` is provided and valid,
 * the device is marked `paired = true` and linked to the invitation. Returns the
 * resulting device row.
 */
export async function recordDeviceHello(
  repo: DeviceRepository,
  params: {
    deviceId: string;
    name: string;
    architecture: string;
    protocolVersion: string;
    capabilities?: string[];
    invitationToken?: string;
    /** P-003: explicitly mark the device paired (e.g. a completed enrollment). Overrides the
     * invitation-token binding path. */
    paired?: boolean;
  },
): Promise<DeviceRow> {
  let invitationId: string | null = null;
  let paired = params.paired ?? false;
  if (!paired && params.invitationToken && params.invitationToken.length > 0) {
    const consumed = await consumeInvitation(repo, params.invitationToken);
    if (consumed.ok && consumed.id) {
      invitationId = consumed.id;
      paired = true;
    }
  }

  const capabilitiesJson = JSON.stringify(params.capabilities ?? []);
  await repo.query(
    `INSERT INTO devices (id, name, architecture, protocol_version, capabilities, paired, invitation_id, last_seen, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), 'connected')
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       architecture = EXCLUDED.architecture,
       protocol_version = EXCLUDED.protocol_version,
       capabilities = EXCLUDED.capabilities,
       paired = CASE WHEN EXCLUDED.paired THEN true ELSE devices.paired END,
       invitation_id = COALESCE(EXCLUDED.invitation_id, devices.invitation_id),
       last_seen = now(),
       status = 'connected'`,
    [params.deviceId, params.name, params.architecture, params.protocolVersion, capabilitiesJson, paired, invitationId],
  );

  const res = await repo.query('SELECT * FROM devices WHERE id = $1', [params.deviceId]);
  return rowToDevice(res.rows[0]);
}

export async function listDevices(repo: DeviceRepository): Promise<DeviceRow[]> {
  const res = await repo.query(
    `SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY last_seen DESC`,
  );
  return res.rows.map(rowToDevice);
}

export async function revokeDevice(repo: DeviceRepository, id: string): Promise<DeviceRow | null> {
  const res = await repo.query(
    `UPDATE devices SET revoked_at = now(), status = 'revoked' WHERE id = $1 RETURNING *`,
    [id],
  );
  if (res.rowCount === 0 || !res.rows[0]) return null;
  return rowToDevice(res.rows[0]);
}

export async function listInvitations(repo: DeviceRepository): Promise<InvitationRecord[]> {
  const res = await repo.query(
    `SELECT id, scope, created_by, created_at, expires_at, used_at, used_by_device_id FROM device_invitations ORDER BY created_at DESC`,
  );
  return res.rows.map((r) => ({
    id: r.id,
    scope: r.scope,
    created_by: r.created_by,
    created_at: r.created_at,
    expires_at: r.expires_at,
    used_at: r.used_at ?? null,
    used_by_device_id: r.used_by_device_id ?? null,
  }));
}

function rowToDevice(row: any): DeviceRow {
  return {
    id: row.id,
    name: row.name,
    architecture: row.architecture,
    protocol_version: row.protocol_version,
    group_name: row.group_name ?? '',
    capabilities: row.capabilities ?? '',
    authority_mode: (row.authority_mode ?? 'legacy') as AuthorityMode,
    paired: Boolean(row.paired),
    status: row.status,
    last_seen: row.last_seen,
    revoked_at: row.revoked_at ?? null,
    cert_fingerprint: row.cert_fingerprint ?? null,
    audio_config: row.audio_config ?? undefined,
    voice_config: row.voice_config ?? undefined,
  };
}

// --- HTTP routes -------------------------------------------------------------

export interface DevicesPluginOptions {
  repo: DeviceRepository;
  requireAdmin: (opts?: { roles?: ('admin' | 'viewer')[]; csrf?: boolean }) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  gateway?: GatewayController;
  deviceAction?: (
    deviceId: string,
    action: string,
    payload?: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<unknown>;
}

const VOICE_CUE_PRESETS = new Set([
  'builtin:soft_chime',
  'builtin:glass_ping',
  'builtin:ready_up',
  'builtin:wood_tap',
  'builtin:digital_pop',
  'builtin:confirm_tone',
]);

function isVoiceCueReference(value: unknown): value is string {
  return typeof value === 'string' && (
    value === ''
    || VOICE_CUE_PRESETS.has(value)
    || /^custom:[a-f0-9]{64}\.(wav|mp3|ogg|flac)$/.test(value)
  );
}

/**
 * Registers the admin device-registry routes. All are admin-only; mutations require
 * CSRF (double-submit). `/health` and `/api/providers` remain open (ops visibility).
 */
export async function registerDeviceRoutes(
  fastify: FastifyInstance,
  options: DevicesPluginOptions,
): Promise<void> {
  const { repo, requireAdmin, gateway } = options;
  const requestDeviceAction = options.deviceAction ?? (async (...args) => {
    const legacy = await import('./legacy-routes.js');
    return legacy.requestDeviceAction(...args);
  });

  // Create a one-time pairing invitation (admin-only, CSRF-protected).
  fastify.post(
    '/api/admin/devices/invitations',
    { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) },
    async (request) => {
      const body = request.body as { scope?: string; ttlSeconds?: number } | undefined;
      const createdBy = (request.user as { username?: string })?.username ?? '';
      const result = await createInvitation(repo, {
        scope: body?.scope,
        createdBy,
        ttlSeconds: body?.ttlSeconds,
      });
      // The plaintext token is returned exactly once and never stored/logged.
      return {
        id: result.id,
        token: result.token,
        scope: result.scope,
        expires_at: result.expires_at,
      };
    },
  );

  // List registered devices with status/invitation state (admin-only, read => no CSRF).
  fastify.get(
    '/api/admin/devices',
    { preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }) },
    async () => {
      const devices = await listDevices(repo);
      const invitations = await listInvitations(repo);
      return { devices, invitations };
    },
  );

  fastify.get(
    '/api/admin/devices/:id/voice/metrics',
    { preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const exists = await repo.query('SELECT 1 FROM devices WHERE id=$1', [id]);
      if (!exists.rowCount) { reply.code(404); return { error: 'device_not_found' }; }
      const summary = await repo.query(
        `SELECT count(*)::int AS turns,
          round(avg(capture_ms))::int AS capture_avg_ms,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY first_playback_ms)::int AS first_playback_p50_ms,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY first_playback_ms)::int AS first_playback_p95_ms,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms)::int AS total_p50_ms,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms)::int AS total_p95_ms
         FROM voice_turn_metrics WHERE device_id=$1 AND created_at >= now() - interval '7 days'`, [id],
      );
      const recent = await repo.query(
        `SELECT turn_id,intent,capture_ms,asr_ms,routing_ms,planning_ms,tts_ms,
          core_round_trip_ms,first_playback_ms,playback_ms,total_ms,created_at
         FROM voice_turn_metrics WHERE device_id=$1 ORDER BY created_at DESC LIMIT 20`, [id],
      );
      return { device_id: id, window: '7d', summary: summary.rows[0], recent: recent.rows };
    },
  );

  // Revoke a device (admin-only, CSRF-protected).
  fastify.post(
    '/api/admin/devices/:id/revoke',
    { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) },
    async (request, reply) => {
      const id = (request.params as { id: string }).id;
      const device = await revokeDevice(repo, id);
      if (!device) {
        reply.code(404);
        return { error: 'device_not_found' };
      }
      return { ok: true, device };
    },
  );

  // ─── Audio / Voice config routes ─────────────────────────────────────────

  // GET /api/admin/devices/:id/audio — return device audio + voice config
  fastify.get(
    '/api/admin/devices/:id/audio',
    { preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const res = await repo.query('SELECT audio_config, voice_config FROM devices WHERE id = $1', [id]);
      if (res.rowCount === 0 || !res.rows[0]) {
        reply.code(404);
        return { error: 'device_not_found' };
      }
      return {
        audio_config: res.rows[0].audio_config ?? null,
        voice_config: res.rows[0].voice_config ?? null,
      };
    },
  );

  // PUT /api/admin/devices/:id/audio — update audio config
  fastify.put(
    '/api/admin/devices/:id/audio',
    { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as Record<string, unknown> | undefined;

      // Validate device exists
      const exists = await repo.query('SELECT 1 FROM devices WHERE id = $1', [id]);
      if (exists.rowCount === 0) {
        reply.code(404);
        return { error: 'device_not_found' };
      }

      const audioConfig: Record<string, any> = {};
      if (body?.mic_device !== undefined) audioConfig.mic_device = body.mic_device;
      if (body?.speaker_device !== undefined) audioConfig.speaker_device = body.speaker_device;
      if (body?.mic_volume !== undefined) audioConfig.mic_volume = body.mic_volume;
      if (body?.speaker_volume !== undefined) audioConfig.speaker_volume = body.speaker_volume;

      await repo.query(
        `UPDATE devices SET audio_config = $1::jsonb WHERE id = $2`,
        [JSON.stringify(audioConfig), id],
      );

      try {
        await requestDeviceAction(id, 'device_http', {
          path: '/api/settings',
          http_method: 'PUT',
          body: {
            voice_mic_device: String(audioConfig.mic_device ?? 'default'),
            audio_speaker_device: String(audioConfig.speaker_device ?? 'default'),
            audio_mic_volume: String(audioConfig.mic_volume ?? 80),
            voice_tts_volume: String(audioConfig.speaker_volume ?? 90),
          },
        });
        return { ok: true, applied: true, audio_config: audioConfig, note: 'Audio selection saved and applied.' };
      } catch (error) {
        reply.code(502);
        return {
          ok: false,
          applied: false,
          audio_config: audioConfig,
          error: 'audio_apply_failed',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  // PUT /api/admin/devices/:id/voice — update voice config
  fastify.put(
    '/api/admin/devices/:id/voice',
    { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as Record<string, unknown> | undefined;

      const exists = await repo.query('SELECT 1 FROM devices WHERE id = $1', [id]);
      if (exists.rowCount === 0) {
        reply.code(404);
        return { error: 'device_not_found' };
      }

      const voiceConfig: Record<string, any> = {};
      if (body?.wake_word !== undefined) voiceConfig.wake_word = body.wake_word;
      if (body?.wake_threshold !== undefined) voiceConfig.wake_threshold = body.wake_threshold;
      if (body?.wake_enabled !== undefined) voiceConfig.wake_enabled = body.wake_enabled;
      if (body?.language !== undefined) voiceConfig.language = body.language;
      if (body?.pipeline !== undefined) voiceConfig.pipeline = body.pipeline;
      for (const key of ['wake_ack_enabled', 'good_intent_enabled', 'no_intent_enabled'] as const) {
        if (body?.[key] !== undefined) voiceConfig[key] = Boolean(body[key]);
      }
      for (const key of ['wake_ack_sound', 'good_intent_sound', 'no_intent_sound'] as const) {
        if (body?.[key] !== undefined) {
          if (!isVoiceCueReference(body[key])) {
            reply.code(400);
            return { error: 'invalid_voice_cue', field: key };
          }
          voiceConfig[key] = body[key];
        }
      }

      await repo.query(
        `UPDATE devices SET voice_config = $1::jsonb WHERE id = $2`,
        [JSON.stringify(voiceConfig), id],
      );

      try {
        const audioRes = await repo.query('SELECT audio_config FROM devices WHERE id = $1', [id]);
        const audioConfig = audioRes.rows[0]?.audio_config as Record<string, unknown> | undefined;
        await requestDeviceAction(id, 'device_http', {
          path: '/api/settings',
          http_method: 'PUT',
          body: {
            voice_enabled: voiceConfig.wake_enabled ? '1' : '0',
            voice_mic_device: String(audioConfig?.mic_device ?? 'default'),
            voice_wake_word: String(voiceConfig.wake_word ?? 'hey_jarvis'),
            voice_integration_wake_enabled: voiceConfig.wake_enabled ? '1' : '0',
            voice_integration_wake_word: String(voiceConfig.wake_word ?? 'hey_jarvis'),
            voice_integration_wake_threshold: String(voiceConfig.wake_threshold ?? 0.5),
            voice_pipeline_id: String(voiceConfig.pipeline ?? ''),
            voice_wake_ack_enabled: voiceConfig.wake_ack_enabled ? '1' : '0',
            voice_wake_ack_sound: String(voiceConfig.wake_ack_sound ?? ''),
            voice_good_intent_enabled: voiceConfig.good_intent_enabled ? '1' : '0',
            voice_good_intent_sound: String(voiceConfig.good_intent_sound ?? ''),
            voice_no_intent_enabled: voiceConfig.no_intent_enabled ? '1' : '0',
            voice_no_intent_sound: String(voiceConfig.no_intent_sound ?? ''),
          },
        });
        await requestDeviceAction(id, 'device_http', {
          path: '/api/settings/voice/restart',
          http_method: 'POST',
        }, 15_000);
        return { ok: true, applied: true, voice_config: voiceConfig, note: 'Voice settings saved and applied.' };
      } catch (error) {
        reply.code(502);
        return {
          ok: false,
          applied: false,
          voice_config: voiceConfig,
          error: 'voice_apply_failed',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  fastify.post(
    '/api/admin/devices/:id/voice/cue-upload',
    { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const exists = await repo.query('SELECT 1 FROM devices WHERE id = $1', [id]);
      if (exists.rowCount === 0) {
        reply.code(404);
        return { error: 'device_not_found' };
      }
      const body = (request.body as {
        data_base64?: string;
        content_type?: string;
        filename?: string;
      } | undefined) ?? {};
      if (!body.data_base64 || body.data_base64.length > 3_000_000) {
        reply.code(413);
        return { error: 'voice_cue_too_large' };
      }
      try {
        return await requestDeviceAction(id, 'device_http', {
          path: '/api/settings/voice/cue-upload',
          http_method: 'POST',
          body,
        }, 15_000);
      } catch (error) {
        reply.code(502);
        return {
          ok: false,
          error: 'voice_cue_upload_failed',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  fastify.post(
    '/api/admin/devices/:id/voice/test-cue',
    { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body as { sound?: unknown; volume?: number } | undefined) ?? {};
      if (!isVoiceCueReference(body.sound) || !body.sound) {
        reply.code(400);
        return { error: 'invalid_voice_cue' };
      }
      try {
        const result = await requestDeviceAction(id, 'device_http', {
          path: '/api/audio/test-cue',
          http_method: 'POST',
          body: { sound: body.sound, volume: body.volume },
        }, 10_000);
        return { ok: true, result };
      } catch (error) {
        reply.code(502);
        return {
          ok: false,
          error: 'voice_cue_test_failed',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  // GET /api/admin/devices/:id/audio/devices — list real devices from the Edge daemon.
  fastify.get(
    '/api/admin/devices/:id/audio/devices',
    { preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const exists = await repo.query('SELECT 1 FROM devices WHERE id = $1', [id]);
      if (exists.rowCount === 0) {
        reply.code(404);
        return { error: 'device_not_found' };
      }

      try {
        const [audioDevices, wakeWords] = await Promise.all([
          requestDeviceAction(id, 'device_http', {
            path: '/api/settings/audio/devices',
            http_method: 'GET',
          }) as Promise<Record<string, unknown>>,
          requestDeviceAction(id, 'device_http', {
            path: '/api/settings/voice/wakewords',
            http_method: 'GET',
          }) as Promise<Record<string, unknown>>,
        ]);
        return { ...audioDevices, wake_words: wakeWords.wake_words ?? [] };
      } catch (error) {
        console.error(`[core][device:${id}] audio inventory failed:`, error);
        reply.code(503);
        return {
          error: 'audio_devices_unavailable',
          message: error instanceof Error ? error.message : String(error),
          microphones: [],
          speakers: [],
        };
      }
    },
  );

  // POST /api/admin/devices/:id/audio/test-mic — test microphone capture
  // Sends a command to the Edge agent to record audio via `parec`/`arecord` and return the sample.
  fastify.post(
    '/api/admin/devices/:id/audio/test-mic',
    { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const exists = await repo.query('SELECT 1 FROM devices WHERE id = $1', [id]);
      if (exists.rowCount === 0) {
        reply.code(404);
        return { error: 'device_not_found' };
      }

      const body = (request.body as { device?: string; duration_ms?: number } | undefined) ?? {};
      const configRes = await repo.query('SELECT audio_config FROM devices WHERE id = $1', [id]);
      const audioConfig = configRes.rows[0]?.audio_config as Record<string, unknown> | undefined;
      const micDevice = body.device?.trim() || (audioConfig?.mic_device as string) || 'default';
      const durationMs = Math.max(500, Math.min(5000, Math.round(body.duration_ms ?? 3000)));

      try {
        const result = await requestDeviceAction(id, 'device_http', {
          path: '/api/audio/test-mic',
          http_method: 'POST',
          body: {
            device: micDevice,
            duration_ms: durationMs,
            playback: true,
            speaker_device: (audioConfig?.speaker_device as string) || 'default',
            volume: Number(audioConfig?.speaker_volume ?? 90),
          },
        }, durationMs + 5_000) as Record<string, unknown>;
        return { ok: true, device_id: id, mic_device: micDevice, ...result, note: 'Microphone capture completed.' };
      } catch (error) {
        console.error(`[core][device:${id}] microphone test failed:`, error);
        reply.code(502);
        return { ok: false, error: 'mic_test_failed', message: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  // POST /api/admin/devices/:id/audio/test-speaker — play a test tone via the Edge agent
  // Sends a command to play a test audio URL through the device's configured speaker.
  fastify.post(
    '/api/admin/devices/:id/audio/test-speaker',
    { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const exists = await repo.query('SELECT 1 FROM devices WHERE id = $1', [id]);
      if (exists.rowCount === 0) {
        reply.code(404);
        return { error: 'device_not_found' };
      }

      const body = (request.body as { device?: string; volume?: number } | undefined) ?? {};
      const configRes = await repo.query('SELECT audio_config FROM devices WHERE id = $1', [id]);
      const audioConfig = configRes.rows[0]?.audio_config as Record<string, unknown> | undefined;
      const speakerDevice = body.device?.trim() || (audioConfig?.speaker_device as string) || 'default';
      const volume = Math.max(0, Math.min(100, Math.round(body.volume ?? Number(audioConfig?.speaker_volume ?? 90))));
      try {
        const result = await requestDeviceAction(id, 'device_http', {
          path: '/api/audio/test-speaker',
          http_method: 'POST',
          body: { device: speakerDevice, volume },
        }, 10_000);
        return { ok: true, device_id: id, speaker_device: speakerDevice, volume, result, note: 'Speaker test tone played.' };
      } catch (error) {
        console.error(`[core][device:${id}] speaker test failed:`, error);
        reply.code(502);
        return { ok: false, error: 'speaker_test_failed', message: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  // POST /api/admin/devices/:id/voice/test-wakeword — test wake word detection
  fastify.post(
    '/api/admin/devices/:id/voice/test-wakeword',
    { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body as {
        wake_word?: string;
        wake_threshold?: number;
        mic_device?: string;
        timeout_ms?: number;
      } | undefined) ?? {};
      const res = await repo.query('SELECT voice_config, audio_config FROM devices WHERE id = $1', [id]);
      if (res.rowCount === 0 || !res.rows[0]) {
        reply.code(404);
        return { error: 'device_not_found' };
      }

      const voiceConfig = res.rows[0].voice_config as Record<string, any> | null;
      const audioConfig = res.rows[0].audio_config as Record<string, any> | null;
      const wakeWord = body.wake_word?.trim() || voiceConfig?.wake_word || 'hey_jarvis';
      const threshold = Math.max(0.1, Math.min(0.9, body.wake_threshold ?? voiceConfig?.wake_threshold ?? 0.5));
      const micDevice = body.mic_device?.trim() || audioConfig?.mic_device || 'default';
      const timeoutMs = Math.max(2_000, Math.min(30_000, Math.round(body.timeout_ms ?? 15_000)));

      try {
        const result = await requestDeviceAction(id, 'device_http', {
          path: '/api/voice/wakeword-test',
          http_method: 'POST',
          body: {
            device: micDevice,
            wake_word: wakeWord,
            threshold,
            timeout_ms: timeoutMs,
          },
        }, timeoutMs + 5_000) as Record<string, unknown>;
        return {
          ...result,
          device_id: id,
          mic_device: micDevice,
          note: result.detected
            ? `Detected “${String(result.wake_word ?? wakeWord)}”.`
            : `No “${String(result.wake_word ?? wakeWord)}” detection before timeout.`,
        };
      } catch (error) {
        console.error(`[core][device:${id}] wake-word test failed:`, error);
        reply.code(502);
        return {
          ok: false,
          detected: false,
          error: 'wakeword_test_failed',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
}
