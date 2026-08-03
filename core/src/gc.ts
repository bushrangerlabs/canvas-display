import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';

/**
 * Garbage collection for content-addressed assets and old data (Phase 4 checklist:
 * "Add cache quota, reserved known-good/update space, and race-safe garbage
 * collection"; plan doc §20.3 Storage).
 *
 * The GC:
 *   - Finds assets not referenced by ANY scene revision (past, present, or staged).
 *   - Deletes unreferenced on-disk files + DB rows.
 *   - Respects a configurable quota: when total asset bytes exceeds the quota,
 *     new uploads are blocked.
 *   - Respects a reserved_known_good_bytes floor: never delete below this
 *     threshold of known-good content.
 *
 * The repository is injected so unit tests can run against an in-memory Postgres
 * (`pg-mem`) without a network.
 */

// --- Types -------------------------------------------------------------------

export interface StorageStatus {
  assetCount: number;
  assetTotalBytes: number;
  sceneCount: number;
  scheduleCount: number;
  unreferencedAssetCount: number;
}

export interface GcConfig {
  /** Maximum total bytes for assets. Default: 1GB */
  quotaBytes: number;
  /** Reserved bytes that GC will never delete below. Default: 100MB */
  reservedKnownGoodBytes: number;
}

export const DEFAULT_QUOTA_BYTES = 1_073_741_824; // 1 GB
export const DEFAULT_RESERVED_BYTES = 104_857_600; // 100 MB

/** Storage abstraction so tests can swap in an in-memory Postgres (`pg-mem`). */
export interface GcRepositoryLike {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export class PgGcRepository implements GcRepositoryLike {
  constructor(private readonly pool: any) {}
  query(text: string, params?: unknown[]) {
    return this.pool.query(text, params as unknown[]) as unknown as Promise<{ rows: any[]; rowCount: number | null }>;
  }
}

// --- Core operations ---------------------------------------------------------

/**
 * Returns the storage status summary.
 * Uses a two-step approach for pg-mem compatibility (correlated subqueries with
 * column references to the outer table are not supported by pg-mem).
 */
export async function getStorageStatus(
  repo: GcRepositoryLike,
): Promise<StorageStatus> {
  const assetRes = await repo.query(
    `SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS total_bytes FROM assets`,
  );
  const assetCount = Number(assetRes.rows[0]?.count ?? 0);
  const assetTotalBytes = Number(assetRes.rows[0]?.total_bytes ?? 0);

  const sceneRes = await repo.query('SELECT COUNT(*) AS count FROM scenes');
  const sceneCount = Number(sceneRes.rows[0]?.count ?? 0);

  const schedRes = await repo.query('SELECT COUNT(*) AS count FROM schedules');
  const scheduleCount = Number(schedRes.rows[0]?.count ?? 0);

  // Count unreferenced assets: assets not appearing in any scene_revision manifest_json.
  // We do this in two steps to avoid pg-mem's correlated subquery limitations.
  const [allAssets, allRevisions] = await Promise.all([
    repo.query('SELECT id, size FROM assets'),
    repo.query('SELECT manifest_json::text AS manifest FROM scene_revisions'),
  ]);

  const revisionTexts = allRevisions.rows.map((r: any) => r.manifest);
  let unreferencedAssetCount = 0;
  for (const asset of allAssets.rows) {
    const referenced = revisionTexts.some((text: string) => text.includes(asset.id));
    if (!referenced) unreferencedAssetCount++;
  }

  return { assetCount, assetTotalBytes, sceneCount, scheduleCount, unreferencedAssetCount };
}

/**
 * Check if the asset storage is over quota. Returns true if a new upload of
 * `additionalBytes` would exceed the quota.
 */
export async function isOverQuota(
  repo: GcRepositoryLike,
  additionalBytes: number,
  quotaBytes: number,
): Promise<boolean> {
  const status = await getStorageStatus(repo);
  return status.assetTotalBytes + additionalBytes > quotaBytes;
}

/**
 * Run garbage collection: find unreferenced assets and delete them.
 *
 * An asset is considered unreferenced if NO row in `scene_revisions` (past,
 * present, or staged) references it in its `manifest_json`.
 *
 * The GC will stop deleting once the remaining bytes would fall below
 * `reservedKnownGoodBytes`.
 *
 * Returns { deletedCount: number; freedBytes: number; remainingBytes: number }.
 */
export async function runGarbageCollection(
  repo: GcRepositoryLike,
  storagePath: string,
  gcConfig: GcConfig,
): Promise<{ deletedCount: number; freedBytes: number; remainingBytes: number }> {
  // Get all assets and all revision manifest texts in two steps (pg-mem
  // compat: correlated subqueries with outer table column references fail).
  const [allAssets, allRevisions] = await Promise.all([
    repo.query('SELECT id, size, created_at FROM assets ORDER BY created_at ASC'),
    repo.query('SELECT manifest_json::text AS manifest FROM scene_revisions'),
  ]);

  const revisionTexts = allRevisions.rows.map((r: any) => r.manifest);

  // Get current total bytes.
  const totalRes = await repo.query(
    `SELECT COALESCE(SUM(size), 0) AS total_bytes FROM assets`,
  );
  let remainingBytes = Number(totalRes.rows[0]?.total_bytes ?? 0);

  let deletedCount = 0;
  let freedBytes = 0;

  for (const asset of allAssets.rows) {
    const assetId: string = asset.id;
    const size = Number(asset.size);

    // Check if this asset is referenced by any revision.
    const referenced = revisionTexts.some((text: string) => text.includes(assetId));
    if (referenced) continue;

    // Check if deleting this asset would leave us below the reserved floor.
    if (remainingBytes - freedBytes - size < gcConfig.reservedKnownGoodBytes) {
      break;
    }

    // Delete the on-disk file.
    const hash = assetId.replace('sha256:', '');
    const filePath = join(storagePath, hash);
    try {
      if (existsSync(filePath)) {
        await unlink(filePath);
      }
    } catch {
      // File may already be missing; continue.
    }

    // Delete the DB row.
    await repo.query('DELETE FROM assets WHERE id = $1', [assetId]);
    deletedCount++;
    freedBytes += size;
  }

  return {
    deletedCount,
    freedBytes,
    remainingBytes: remainingBytes - freedBytes,
  };
}

// --- HTTP routes -------------------------------------------------------------

export interface GcPluginOptions {
  repo: GcRepositoryLike;
  storagePath: string;
  gcConfig: GcConfig;
  requireAdmin: (opts?: { roles?: ('admin' | 'viewer')[]; csrf?: boolean }) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

export async function registerGcRoutes(
  fastify: FastifyInstance,
  options: GcPluginOptions,
): Promise<void> {
  const { repo, storagePath, gcConfig, requireAdmin } = options;

  // Storage status (read => no CSRF).
  fastify.get(
    '/api/admin/storage/status',
    { preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }) },
    async () => {
      return getStorageStatus(repo);
    },
  );

  // Run garbage collection (admin-only, CSRF-protected).
  fastify.post(
    '/api/admin/storage/gc',
    { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) },
    async () => {
      const result = await runGarbageCollection(repo, storagePath, gcConfig);
      return { ok: true, ...result };
    },
  );
}