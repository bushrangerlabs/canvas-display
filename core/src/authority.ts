import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { AuthorityMode } from './devices.js';

/**
 * Phase 8 — Authority epoch switch and write-fence endpoint.
 *
 * This module provides the administrative API for managing the authority cutover
 * from legacy/SQLite authority to Core/PostgreSQL authority (plan doc §26.5, §26.6).
 *
 * ## Authority modes (§26.5)
 *
 * | Mode | Writable authority | Rules |
 * |------|-------------------|-------|
 * | `legacy` | Selected legacy SQLite server | Core may import/read but cannot accept authoritative writes for that domain. |
 * | `shadow` | Selected legacy SQLite server | Core compares mirrored state/results but remains non-authoritative and side-effect free. |
 * | `core` | PostgreSQL/Core | Legacy admin/config routes are write-fenced; Edge accepts only the active Core authority epoch. |
 * | `rollback_pending` | Neither until reconciled | Freeze authoritative writes, export post-cutover Core changes, and require an explicit reconciliation decision before legacy can resume. |
 *
 * ## Authority epoch
 *
 * A new epoch is created each time authority transitions. Devices must present the
 * current authority epoch in their protocol messages; the gateway rejects messages
 * with a stale epoch.
 */

// --- Database helpers (designed for pg-mem compatibility) --------------------

async function addTableIfNotExists(pool: Pool, createSql: string, tableName: string): Promise<void> {
  const res = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = $1 LIMIT 1`,
    [tableName],
  );
  if (res.rowCount === 0) {
    await pool.query(createSql);
  }
}

/**
 * Installs the Phase 8 authority-migration tables.
 *
 * - `authority_watermark`: records the final import watermark timestamp. Once set,
 *   legacy writes are considered non-authoritative.
 * - `authority_epoch`: a log of authority epoch transitions. Each transition records
 *   source/destination epoch, actor, and reason.
 */
export async function migrateAuthority(pool: Pool): Promise<void> {
  await addTableIfNotExists(
    pool,
    `CREATE TABLE IF NOT EXISTS authority_watermark (
      id          TEXT PRIMARY KEY,
      watermark   TIMESTAMPTZ NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by  TEXT NOT NULL DEFAULT 'system'
    )`,
    'authority_watermark',
  );

  await addTableIfNotExists(
    pool,
    `CREATE TABLE IF NOT EXISTS authority_epoch_log (
      id              TEXT PRIMARY KEY,
      device_id       TEXT NOT NULL,
      from_mode       TEXT NOT NULL,
      to_mode         TEXT NOT NULL,
      epoch           TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by      TEXT NOT NULL DEFAULT 'system'
    )`,
    'authority_epoch_log',
  );

  // Add authority_epoch column to devices table if not present
  const colRes = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = 'devices' AND column_name = 'authority_epoch' LIMIT 1`,
  );
  if (colRes.rowCount === 0) {
    await pool.query(`ALTER TABLE devices ADD COLUMN authority_epoch TEXT NOT NULL DEFAULT 'epoch-0'`);
  }

  console.log('[core][authority] migrations applied');
}

// --- Storage helpers ----------------------------------------------------------

interface AuthorityRepositoryLike {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export class PgAuthorityRepository implements AuthorityRepositoryLike {
  constructor(private readonly pool: Pool) {}
  query(text: string, params?: unknown[]) {
    return this.pool.query(text, params as unknown[]) as unknown as Promise<{ rows: any[]; rowCount: number | null }>;
  }
}

// --- Authority switch logic ---------------------------------------------------

export interface AuthoritySwitchRequest {
  device_ids: string[];
  authority_mode: AuthorityMode;
}

export interface AuthorityStatusSummary {
  legacy: number;
  shadow: number;
  core: number;
  rollback_pending: number;
  total: number;
}

export interface WatermarkRecord {
  id: string;
  watermark: string;
  created_at: string;
  created_by: string;
}

/**
 * Changes the authority mode for a set of devices.
 *
 * This records the transition in the `authority_epoch_log` table and updates each
 * device's `authority_mode` and `authority_epoch` columns. The epoch is a new UUID
 * generated for each batch transition.
 *
 * If a device is already in the requested mode, it is skipped (idempotent).
 */
export async function switchAuthority(
  repo: AuthorityRepositoryLike,
  request: AuthoritySwitchRequest,
  actor: string = 'admin',
): Promise<{ switched: number; skipped: number; epoch: string }> {
  const { device_ids, authority_mode } = request;
  // The device-v1 contract types authority epochs as UUIDs. Keep the database
  // transition token wire-compatible so Edge can deserialize state.desired.
  const epoch = randomUUID();
  let switched = 0;
  let skipped = 0;

  for (const deviceId of device_ids) {
    // Check current mode
    const currentRes = await repo.query(
      `SELECT authority_mode FROM devices WHERE id = $1`,
      [deviceId],
    );
    if (currentRes.rowCount === 0) {
      skipped++;
      continue;
    }
    const currentMode = currentRes.rows[0].authority_mode as string;
    if (currentMode === authority_mode) {
      skipped++;
      continue;
    }

    // Update device
    await repo.query(
      `UPDATE devices SET authority_mode = $1, authority_epoch = $2 WHERE id = $3`,
      [authority_mode, epoch, deviceId],
    );

    // Log transition
    await repo.query(
      `INSERT INTO authority_epoch_log (id, device_id, from_mode, to_mode, epoch, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), deviceId, currentMode, authority_mode, epoch, actor],
    );

    switched++;
  }

  return { switched, skipped, epoch };
}

/**
 * Returns a summary of devices grouped by authority mode.
 */
export async function getAuthorityStatus(
  repo: AuthorityRepositoryLike,
): Promise<AuthorityStatusSummary> {
  const res = await repo.query(
    `SELECT authority_mode, COUNT(*)::int AS count
     FROM devices
     WHERE revoked_at IS NULL
     GROUP BY authority_mode`,
  );

  const counts: Record<string, number> = { legacy: 0, shadow: 0, core: 0, rollback_pending: 0 };
  for (const row of res.rows) {
    if (row.authority_mode in counts) {
      counts[row.authority_mode] = Number(row.count);
    }
  }

  const totalRes = await repo.query(
    `SELECT COUNT(*)::int AS total FROM devices WHERE revoked_at IS NULL`,
  );
  const total = Number(totalRes.rows[0]?.total ?? 0);

  return {
    legacy: counts.legacy,
    shadow: counts.shadow,
    core: counts.core,
    rollback_pending: counts.rollback_pending,
    total,
  };
}

/**
 * Records the final import watermark. Only one watermark may exist; subsequent
 * calls return the existing record.
 */
export async function finalizeWatermark(
  repo: AuthorityRepositoryLike,
  watermark: string,
  createdBy: string = 'system',
): Promise<WatermarkRecord> {
  // Check if a watermark already exists
  const existing = await repo.query(`SELECT * FROM authority_watermark ORDER BY created_at DESC LIMIT 1`);
  if (existing.rowCount && existing.rowCount > 0 && existing.rows[0]) {
    const row = existing.rows[0];
    return {
      id: row.id,
      watermark: row.watermark,
      created_at: row.created_at,
      created_by: row.created_by,
    };
  }

  const id = randomUUID();
  await repo.query(
    `INSERT INTO authority_watermark (id, watermark, created_by) VALUES ($1, $2, $3)`,
    [id, watermark, createdBy],
  );

  return { id, watermark, created_at: new Date().toISOString(), created_by: createdBy };
}

/**
 * Returns the current watermark, or null if none has been set.
 */
export async function getWatermark(
  repo: AuthorityRepositoryLike,
): Promise<WatermarkRecord | null> {
  const res = await repo.query(`SELECT * FROM authority_watermark ORDER BY created_at DESC LIMIT 1`);
  if (res.rowCount === 0 || !res.rows[0]) return null;
  const row = res.rows[0];
  return {
    id: row.id,
    watermark: row.watermark,
    created_at: row.created_at,
    created_by: row.created_by,
  };
}

// --- HTTP routes --------------------------------------------------------------

export interface AuthorityPluginOptions {
  repo: AuthorityRepositoryLike;
  requireAdmin: (opts?: { roles?: ('admin' | 'viewer')[]; csrf?: boolean }) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

/**
 * Registers the Phase 8 authority administration routes.
 *
 * Routes:
 * - `POST /api/admin/authority/switch` — switch device(s) to a new authority mode
 * - `GET  /api/admin/authority/status` — summary of devices by authority mode
 * - `POST /api/admin/authority/finalize-watermark` — record the final import watermark
 * - `GET  /api/admin/authority/watermark` — read the current watermark
 */
export async function registerAuthorityRoutes(
  fastify: FastifyInstance,
  options: AuthorityPluginOptions,
): Promise<void> {
  const { repo, requireAdmin } = options;

  // POST /api/admin/authority/switch — switch authority mode for devices
  fastify.post(
    '/api/admin/authority/switch',
    { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as Partial<AuthoritySwitchRequest>;
      if (!Array.isArray(body.device_ids) || body.device_ids.length === 0) {
        reply.code(400);
        return { error: 'device_ids must be a non-empty array' };
      }
      const validModes: AuthorityMode[] = ['legacy', 'shadow', 'core', 'rollback_pending'];
      if (!body.authority_mode || !validModes.includes(body.authority_mode)) {
        reply.code(400);
        return { error: 'authority_mode must be one of: legacy, shadow, core, rollback_pending' };
      }

      const actor = ((request as any).user?.username as string) ?? 'admin';
      const result = await switchAuthority(repo, {
        device_ids: body.device_ids,
        authority_mode: body.authority_mode,
      }, actor);

      return {
        ok: true,
        switched: result.switched,
        skipped: result.skipped,
        epoch: result.epoch,
      };
    },
  );

  // GET /api/admin/authority/status — summary of devices by authority mode
  fastify.get(
    '/api/admin/authority/status',
    { preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }) },
    async () => {
      const status = await getAuthorityStatus(repo);
      return status;
    },
  );

  // POST /api/admin/authority/finalize-watermark — record final import watermark
  fastify.post(
    '/api/admin/authority/finalize-watermark',
    { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as { watermark?: unknown } | undefined;
      if (typeof body?.watermark !== 'string' || body.watermark.length === 0) {
        reply.code(400);
        return { error: 'watermark must be a non-empty ISO-8601 timestamp string' };
      }

      const actor = ((request as any).user?.username) ?? 'system';
      const record = await finalizeWatermark(repo, body.watermark, actor);
      return { ok: true, watermark: record };
    },
  );

  // GET /api/admin/authority/watermark — read current watermark
  fastify.get(
    '/api/admin/authority/watermark',
    { preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }) },
    async () => {
      const record = await getWatermark(repo);
      if (!record) {
        return { watermark: null, message: 'No watermark has been set yet.' };
      }
      return { watermark: record };
    },
  );
}
