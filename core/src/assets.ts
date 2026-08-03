import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isOverQuota, DEFAULT_QUOTA_BYTES } from './gc.js';

/**
 * Content-addressed asset storage (Phase 4 checklist: "Add asset download, hash
 * verification, preload, atomic activation, previous-revision rollback, and
 * missing-object recovery"; plan doc §18.1 Scene package).
 *
 * Assets are stored on disk keyed by SHA-256 content hash. The `assets` table
 * tracks metadata (id = "sha256:<hash>", size, created_at). The filesystem path
 * is injected from env `ASSET_STORAGE_PATH` (default `./data/assets/`) and is
 * overridable in tests.
 *
 * The repository is injected so unit tests can run against an in-memory Postgres
 * (`pg-mem`) without a network.
 */

export interface AssetRecord {
  id: string; // "sha256:<hex>"
  size: number;
  createdAt: string;
}

/** Storage abstraction so tests can swap in an in-memory Postgres (`pg-mem`). */
export interface AssetRepositoryLike {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export class PgAssetRepository implements AssetRepositoryLike {
  constructor(private readonly pool: any) {}
  query(text: string, params?: unknown[]) {
    return this.pool.query(text, params as unknown[]) as unknown as Promise<{ rows: any[]; rowCount: number | null }>;
  }
}

// --- core operations -----------------------------------------------------------

/**
 * Store a buffer as a content-addressed asset. Computes SHA-256, writes to disk,
 * records metadata in the `assets` table. Idempotent: if the hash already exists
 * the existing record is returned and no duplicate write occurs.
 */
export async function storeAsset(
  repo: AssetRepositoryLike,
  storagePath: string,
  bytes: Buffer,
): Promise<AssetRecord> {
  const hash = createHash('sha256').update(bytes).digest('hex');
  const assetId = `sha256:${hash}`;

  // Check if already stored.
  const existing = await repo.query('SELECT * FROM assets WHERE id = $1', [assetId]);
  if (existing.rows.length > 0) {
    return rowToAsset(existing.rows[0]);
  }

  // Write to disk — ensure directory exists.
  if (!existsSync(storagePath)) {
    await mkdir(storagePath, { recursive: true });
  }
  await writeFile(join(storagePath, hash), bytes);

  // Record metadata.
  const res = await repo.query(
    `INSERT INTO assets (id, size, created_at)
     VALUES ($1, $2, now())
     RETURNING *`,
    [assetId, bytes.length],
  );
  return rowToAsset(res.rows[0]);
}

/**
 * Read asset bytes from disk. Returns `null` when the asset record does not
 * exist or the file is missing.
 */
export async function readAssetBytes(
  repo: AssetRepositoryLike,
  storagePath: string,
  assetId: string,
): Promise<{ bytes: Buffer; record: AssetRecord } | null> {
  const res = await repo.query('SELECT * FROM assets WHERE id = $1', [assetId]);
  if (res.rows.length === 0) return null;
  const record = rowToAsset(res.rows[0]);
  const hash = assetId.replace('sha256:', '');
  const filePath = join(storagePath, hash);
  try {
    const bytes = await readFile(filePath);
    return { bytes, record };
  } catch {
    return null;
  }
}

/**
 * Validate that all `sha256:<hex>` string values in a manifest JSON tree
 * reference existing assets. Returns the list of missing asset IDs (empty
 * when all are present).
 */
export function extractAssetReferences(manifest: unknown): string[] {
  const refs = new Set<string>();
  const SHA256_RE = /^sha256:[0-9a-f]{64}$/i;
  function walk(value: unknown): void {
    if (typeof value === 'string') {
      if (SHA256_RE.test(value)) {
        refs.add(value);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else if (value !== null && typeof value === 'object') {
      for (const val of Object.values(value as Record<string, unknown>)) walk(val);
    }
  }
  walk(manifest);
  return [...refs];
}

export async function validateAssetReferences(
  repo: AssetRepositoryLike,
  manifest: unknown,
): Promise<string[]> {
  const refs = extractAssetReferences(manifest);
  if (refs.length === 0) return [];
  const missing: string[] = [];
  for (const ref of refs) {
    const res = await repo.query('SELECT 1 FROM assets WHERE id = $1', [ref]);
    if (res.rows.length === 0) {
      missing.push(ref);
    }
  }
  return missing;
}

// --- row mapping ---------------------------------------------------------------

function rowToAsset(row: any): AssetRecord {
  return {
    id: row.id,
    size: Number(row.size),
    createdAt: row.created_at,
  };
}

// --- HTTP routes ---------------------------------------------------------------

export interface AssetPluginOptions {
  repo: AssetRepositoryLike;
  storagePath: string;
  requireAdmin: (opts?: { roles?: ('admin' | 'viewer')[]; csrf?: boolean }) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** Asset quota in bytes. Default 1GB. */
  quotaBytes?: number;
}

export async function registerAssetRoutes(
  fastify: FastifyInstance,
  options: AssetPluginOptions,
): Promise<void> {
  const { repo, storagePath, requireAdmin, quotaBytes } = options;
  const effectiveQuota = quotaBytes ?? DEFAULT_QUOTA_BYTES;

  // Register a raw-buffer parser for octet-stream so the upload route can
  // receive binary payloads without @fastify/multipart.
  fastify.addContentTypeParser<Buffer>(
    'application/octet-stream',
    { parseAs: 'buffer' },
    async (_req: FastifyRequest, body: Buffer) => body,
  );

  // Upload an asset (admin-only, CSRF-protected).
  fastify.post(
    '/api/admin/assets',
    { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const bytes = request.body;
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        reply.code(400);
        return { error: 'body must be a non-empty binary payload with Content-Type application/octet-stream' };
      }
      // Check quota before accepting.
      try {
        const over = await isOverQuota(repo, bytes.length, effectiveQuota);
        if (over) {
          reply.code(429);
          return { error: 'Quota Exceeded', detail: 'Asset storage quota exceeded. Run GC to free space.' };
        }
      } catch (quotaErr) {
        console.error('[core][assets] quota check failed:', quotaErr);
        // Proceed in degraded mode if quota check fails.
      }
      const asset = await storeAsset(repo, storagePath, bytes);
      return { asset_id: asset.id, size: asset.size };
    },
  );

  // Serve an asset by its content-hash id (read => no CSRF, admin/viewer).
  fastify.get(
    '/api/admin/assets/:id',
    { preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }) },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const id = (request.params as { id: string }).id;
      const result = await readAssetBytes(repo, storagePath, id);
      if (!result) {
        reply.code(404);
        return { error: 'asset_not_found' };
      }
      reply.header('Content-Type', 'application/octet-stream');
      return reply.send(result.bytes);
    },
  );
}