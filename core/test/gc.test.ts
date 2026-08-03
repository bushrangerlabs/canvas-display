import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createTestDb } from './db-helpers.js';
import {
  PgGcRepository,
  getStorageStatus,
  runGarbageCollection,
  isOverQuota,
  DEFAULT_QUOTA_BYTES,
  DEFAULT_RESERVED_BYTES,
} from '../src/gc.js';
import { PgAssetRepository, storeAsset } from '../src/assets.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'gc-test-'));
}

// --- Unit tests ---------------------------------------------------------------

test('getStorageStatus returns correct counts', async () => {
  const { pool } = createTestDb();
  const repo = new PgGcRepository(pool);

  // Insert some assets.
  const assetRepo = new PgAssetRepository(pool);
  const storagePath = makeTempDir();
  await storeAsset(assetRepo, storagePath, Buffer.from('asset one'));
  await storeAsset(assetRepo, storagePath, Buffer.from('asset two'));

  const status = await getStorageStatus(repo);
  assert.equal(status.assetCount, 2);
  assert.ok(status.assetTotalBytes > 0);
  assert.equal(status.sceneCount, 0);
  assert.equal(status.scheduleCount, 0);
  assert.equal(status.unreferencedAssetCount, 2);
});

test('isOverQuota returns true when quota exceeded', async () => {
  const { pool } = createTestDb();
  const repo = new PgGcRepository(pool);

  // With no assets, 10 bytes should be under quota.
  const under = await isOverQuota(repo, 10, DEFAULT_QUOTA_BYTES);
  assert.equal(under, false);

  // With tiny quota, trigger over.
  const assetRepo = new PgAssetRepository(pool);
  const storagePath = makeTempDir();
  await storeAsset(assetRepo, storagePath, Buffer.from('some data'));

  // Set quota to 1 byte.
  const over = await isOverQuota(repo, 0, 1);
  assert.equal(over, true);
});

test('GC deletes unreferenced assets but preserves referenced ones', async () => {
  const { pool } = createTestDb();
  const gcRepo = new PgGcRepository(pool);
  const assetRepo = new PgAssetRepository(pool);
  const storagePath = makeTempDir();

  // Store two assets.
  const asset1 = await storeAsset(assetRepo, storagePath, Buffer.from('asset one'));
  const asset2 = await storeAsset(assetRepo, storagePath, Buffer.from('asset two'));

  // Reference asset1 in a scene revision.
  const manifestJson = JSON.stringify({ widget: { src: asset1.id } });
  await pool.query(
    `INSERT INTO scene_revisions (id, scene_id, revision, manifest_json, status, created_at)
     VALUES ($1, $2, $3, $4, 'staged', now())`,
    ['rev-1', 'scene-1', 1, manifestJson],
  );

  // Run GC.
  const result = await runGarbageCollection(gcRepo, storagePath, {
    quotaBytes: DEFAULT_QUOTA_BYTES,
    reservedKnownGoodBytes: 0, // Allow deleting everything unreferenced.
  });

  // asset2 should be deleted (unreferenced), asset1 should remain.
  assert.equal(result.deletedCount, 1);
  assert.ok(result.freedBytes > 0);

  // Verify asset1 still exists in DB.
  const check = await pool.query('SELECT * FROM assets WHERE id = $1', [asset1.id]);
  assert.equal(check.rows.length, 1);

  // Verify asset2 is gone from DB.
  const check2 = await pool.query('SELECT * FROM assets WHERE id = $1', [asset2.id]);
  assert.equal(check2.rows.length, 0);

  // Verify asset2 file is gone from disk.
  const hash2 = asset2.id.replace('sha256:', '');
  assert.equal(existsSync(join(storagePath, hash2)), false);
});

test('quota enforcement blocks upload when over limit', async () => {
  const { pool } = createTestDb();
  const assetRepo = new PgAssetRepository(pool);
  const storagePath = makeTempDir();

  // Store a small amount of data.
  await storeAsset(assetRepo, storagePath, Buffer.from('some data'));

  // With a tiny quota, isOverQuota should return true.
  const over = await isOverQuota(assetRepo, 0, 1);
  assert.equal(over, true);
});

test('reserved byte floor prevents GC from deleting too much', async () => {
  const { pool } = createTestDb();
  const gcRepo = new PgGcRepository(pool);
  const assetRepo = new PgAssetRepository(pool);
  const storagePath = makeTempDir();

  // Store two assets.
  const asset1 = await storeAsset(assetRepo, storagePath, Buffer.from('some data for asset one'));
  const asset2 = await storeAsset(assetRepo, storagePath, Buffer.from('some data for asset two'));

  // Both are unreferenced. Set reservedKnownGoodBytes to be larger than one asset
  // but smaller than total, so only one gets deleted.
  const totalRes = await pool.query('SELECT COALESCE(SUM(size), 0)::bigint AS total FROM assets');
  const totalBytes = Number(totalRes.rows[0].total);
  const halfBytes = Math.floor(totalBytes / 2);

  const result = await runGarbageCollection(gcRepo, storagePath, {
    quotaBytes: DEFAULT_QUOTA_BYTES,
    reservedKnownGoodBytes: halfBytes,
  });

  // Should have deleted at least one asset but not all.
  assert.ok(result.deletedCount >= 1);
  // At least one asset should remain.
  const remaining = await pool.query('SELECT COUNT(*)::bigint AS count FROM assets');
  assert.ok(Number(remaining.rows[0].count) >= 1);
  // Remaining bytes should be >= reservedKnownGoodBytes.
  assert.ok(result.remainingBytes >= halfBytes);
});

test('GC is safe with active scene publications (staged revisions)', async () => {
  const { pool } = createTestDb();
  const gcRepo = new PgGcRepository(pool);
  const assetRepo = new PgAssetRepository(pool);
  const storagePath = makeTempDir();

  // Store an asset referenced by a staged revision.
  const asset = await storeAsset(assetRepo, storagePath, Buffer.from('staged asset'));
  const manifestJson = JSON.stringify({ ref: asset.id });
  await pool.query(
    `INSERT INTO scene_revisions (id, scene_id, revision, manifest_json, status, created_at)
     VALUES ($1, $2, $3, $4, 'staged', now())`,
    ['rev-staged', 'scene-1', 1, manifestJson],
  );

  // Store an unreferenced asset.
  const unreferenced = await storeAsset(assetRepo, storagePath, Buffer.from('unreferenced'));

  // Run GC.
  const result = await runGarbageCollection(gcRepo, storagePath, {
    quotaBytes: DEFAULT_QUOTA_BYTES,
    reservedKnownGoodBytes: 0,
  });

  // Only the unreferenced asset should be deleted.
  assert.equal(result.deletedCount, 1);
  // The staged-revision-referenced asset should remain.
  const check = await pool.query('SELECT * FROM assets WHERE id = $1', [asset.id]);
  assert.equal(check.rows.length, 1);
});