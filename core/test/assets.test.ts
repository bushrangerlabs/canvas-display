import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { createTestDb } from './db-helpers.js';
import {
  PgAssetRepository,
  registerAssetRoutes,
  storeAsset,
  readAssetBytes,
  validateAssetReferences,
  extractAssetReferences,
} from '../src/assets.js';
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

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'assets-test-'));
  return dir;
}

function removeDir(dir: string): void {
  // Clean up temp files — simplest approach: node:fs.rmSync would be ideal but
  // we use readdirSync + unlinkSync in a loop.
  try {
    const entries = readFileSync(dir) && true;
    // We can't easily remove non-empty dirs without extra imports, so just
    // leave the temp dirs for the OS to clean up.
  } catch {
    // ignore
  }
}

async function buildServer(config: CoreConfig, assetRepo: PgAssetRepository, authRepo: PgAuthRepository, storagePath: string) {
  const fastify = Fastify({ logger: false });
  const { requireAdmin } = await registerAuth(fastify, { config, repo: authRepo });
  await registerAssetRoutes(fastify, { repo: assetRepo, storagePath, requireAdmin });
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

// --- Unit tests ---------------------------------------------------------------

test('storeAsset writes file to disk and returns SHA-256 id', async () => {
  const { pool } = createTestDb();
  const repo = new PgAssetRepository(pool);
  const storagePath = makeTempDir();

  const bytes = Buffer.from('hello canvas core');
  const asset = await storeAsset(repo, storagePath, bytes);

  const expectedHash = createHash('sha256').update(bytes).digest('hex');
  assert.equal(asset.id, `sha256:${expectedHash}`);
  assert.equal(asset.size, bytes.length);
  assert.ok(asset.createdAt);

  // Verify the file exists on disk.
  const filePath = join(storagePath, expectedHash);
  assert.ok(existsSync(filePath));
  assert.deepEqual(readFileSync(filePath), bytes);
});

test('storeAsset is idempotent (same bytes return same record)', async () => {
  const { pool } = createTestDb();
  const repo = new PgAssetRepository(pool);
  const storagePath = makeTempDir();

  const bytes = Buffer.from('idempotent test');
  const a1 = await storeAsset(repo, storagePath, bytes);
  const a2 = await storeAsset(repo, storagePath, bytes);

  assert.equal(a1.id, a2.id);
  assert.equal(a1.size, a2.size);
});

test('readAssetBytes returns stored asset bytes', async () => {
  const { pool } = createTestDb();
  const repo = new PgAssetRepository(pool);
  const storagePath = makeTempDir();

  const bytes = Buffer.from('read me');
  const stored = await storeAsset(repo, storagePath, bytes);
  const result = await readAssetBytes(repo, storagePath, stored.id);

  assert.ok(result);
  assert.deepEqual(result.bytes, bytes);
  assert.equal(result.record.id, stored.id);
});

test('readAssetBytes returns null for unknown asset', async () => {
  const { pool } = createTestDb();
  const repo = new PgAssetRepository(pool);
  const storagePath = makeTempDir();

  const result = await readAssetBytes(repo, storagePath, 'sha256:nonexistent');
  assert.equal(result, null);
});

test('extractAssetReferences finds all sha256 references in a manifest', () => {
  const manifest = {
    background: {
      image: 'sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    },
    widgets: [
      {
        url: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        data: { src: 'sha256:1111111111111111111111111111111111111111111111111111111111111111' },
      },
    ],
    title: 'just a string',
  };

  const refs = extractAssetReferences(manifest);
  assert.equal(refs.length, 3);
  assert.ok(refs.includes('sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'));
  assert.ok(refs.includes('sha256:0000000000000000000000000000000000000000000000000000000000000000'));
  assert.ok(refs.includes('sha256:1111111111111111111111111111111111111111111111111111111111111111'));
});

test('extractAssetReferences returns empty array for manifest with no references', () => {
  const manifest = { widgets: [{ type: 'text', content: 'hello' }], layout: { w: 100, h: 200 } };
  assert.deepEqual(extractAssetReferences(manifest), []);
});

test('validateAssetReferences returns missing assets', async () => {
  const { pool } = createTestDb();
  const repo = new PgAssetRepository(pool);
  const storagePath = makeTempDir();

  // Store one asset.
  const bytes = Buffer.from('existing asset');
  const stored = await storeAsset(repo, storagePath, bytes);

  const manifest = {
    background: { image: stored.id },
    widget: { icon: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' },
  };

  const missing = await validateAssetReferences(repo, manifest);
  assert.equal(missing.length, 1);
  assert.equal(missing[0], 'sha256:0000000000000000000000000000000000000000000000000000000000000000');
});

test('validateAssetReferences returns empty when all assets exist', async () => {
  const { pool } = createTestDb();
  const repo = new PgAssetRepository(pool);
  const storagePath = makeTempDir();

  const a = await storeAsset(repo, storagePath, Buffer.from('a'));
  const b = await storeAsset(repo, storagePath, Buffer.from('b'));

  const manifest = { bg: { src: a.id }, fg: { src: b.id } };
  const missing = await validateAssetReferences(repo, manifest);
  assert.deepEqual(missing, []);
});

// --- HTTP route tests ---------------------------------------------------------

test('POST /api/admin/assets stores binary and returns asset_id', async () => {
  const { pool } = createTestDb();
  const config = makeConfig();
  const assetRepo = new PgAssetRepository(pool);
  const authRepo = new PgAuthRepository(pool);
  const storagePath = makeTempDir();
  const fastify = await buildServer(config, assetRepo, authRepo, storagePath);
  const { cookies, csrf } = await adminSession(fastify, config, authRepo);

  const bytes = Buffer.from('hello from http upload');
  const res = await fastify.inject({
    method: 'POST',
    url: '/api/admin/assets',
    headers: {
      cookie: cookies,
      'x-csrf-token': csrf,
      'content-type': 'application/octet-stream',
    },
    payload: bytes,
  });

  assert.equal(res.statusCode, 200, `body: ${res.body}`);
  const body = res.json();
  assert.ok(body.asset_id.startsWith('sha256:'));
  assert.equal(body.size, bytes.length);
});

test('GET /api/admin/assets/:id returns stored bytes', async () => {
  const { pool } = createTestDb();
  const config = makeConfig();
  const assetRepo = new PgAssetRepository(pool);
  const authRepo = new PgAuthRepository(pool);
  const storagePath = makeTempDir();
  const fastify = await buildServer(config, assetRepo, authRepo, storagePath);
  const { cookies, csrf } = await adminSession(fastify, config, authRepo);

  const bytes = Buffer.from('serve me');
  const stored = await storeAsset(assetRepo, storagePath, bytes);

  const res = await fastify.inject({
    method: 'GET',
    url: `/api/admin/assets/${stored.id}`,
    headers: { cookie: cookies },
  });

  assert.equal(res.statusCode, 200, `body: ${res.body}`);
  assert.deepEqual(res.rawPayload, bytes);
});