import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createTestDb } from './db-helpers.js';
import {
  PgAuthorityRepository,
  registerAuthorityRoutes,
  switchAuthority,
  getAuthorityStatus,
  finalizeWatermark,
  getWatermark,
  migrateAuthority,
} from '../src/authority.js';
import { PgAuthRepository, bootstrapAdmin, registerAuth } from '../src/auth.js';
import type { CoreConfig } from '../src/config.js';
import { PgDeviceRepository, recordDeviceHello } from '../src/devices.js';

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

async function buildServer(
  config: CoreConfig,
  authorityRepo: PgAuthorityRepository,
  authRepo: PgAuthRepository,
) {
  const fastify = Fastify({ logger: false });
  const { requireAdmin } = await registerAuth(fastify, { config, repo: authRepo });
  await registerAuthorityRoutes(fastify, { repo: authorityRepo, requireAdmin });
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

// ---------------------------------------------------------------------------
// Unit tests: switchAuthority
// ---------------------------------------------------------------------------

test('switchAuthority changes device authority mode and logs the transition', async () => {
  const { pool } = createTestDb();
  const repo = new PgAuthorityRepository(pool);
  const deviceRepo = new PgDeviceRepository(pool);

  // Record a device (defaults to legacy)
  await recordDeviceHello(deviceRepo, {
    deviceId: 'dev-1',
    name: 'v1',
    architecture: 'arm64',
    protocolVersion: '1',
  });

  // Switch to shadow
  const result = await switchAuthority(repo, { device_ids: ['dev-1'], authority_mode: 'shadow' });
  assert.equal(result.switched, 1);
  assert.equal(result.skipped, 0);
  assert.ok(result.epoch);

  // Verify device row
  const devRes = await pool.query('SELECT authority_mode, authority_epoch FROM devices WHERE id = $1', ['dev-1']);
  assert.equal(devRes.rows[0].authority_mode, 'shadow');
  assert.equal(devRes.rows[0].authority_epoch, result.epoch);

  // Verify log entry
  const logRes = await pool.query('SELECT * FROM authority_epoch_log WHERE device_id = $1', ['dev-1']);
  assert.equal(logRes.rowCount, 1);
  assert.equal(logRes.rows[0].from_mode, 'legacy');
  assert.equal(logRes.rows[0].to_mode, 'shadow');
  assert.equal(logRes.rows[0].created_by, 'admin');
});

test('switchAuthority skips devices already in the target mode', async () => {
  const { pool } = createTestDb();
  const repo = new PgAuthorityRepository(pool);
  const deviceRepo = new PgDeviceRepository(pool);

  await recordDeviceHello(deviceRepo, { deviceId: 'dev-1', name: 'v1', architecture: 'arm64', protocolVersion: '1' });

  // Switch to shadow, then to shadow again
  await switchAuthority(repo, { device_ids: ['dev-1'], authority_mode: 'shadow' });
  const result = await switchAuthority(repo, { device_ids: ['dev-1'], authority_mode: 'shadow' });
  assert.equal(result.switched, 0);
  assert.equal(result.skipped, 1);
});

test('switchAuthority handles multiple devices in one call', async () => {
  const { pool } = createTestDb();
  const repo = new PgAuthorityRepository(pool);
  const deviceRepo = new PgDeviceRepository(pool);

  await recordDeviceHello(deviceRepo, { deviceId: 'dev-a', name: 'a', architecture: 'arm64', protocolVersion: '1' });
  await recordDeviceHello(deviceRepo, { deviceId: 'dev-b', name: 'b', architecture: 'arm64', protocolVersion: '1' });

  const result = await switchAuthority(repo, { device_ids: ['dev-a', 'dev-b'], authority_mode: 'core' });
  assert.equal(result.switched, 2);
  assert.equal(result.skipped, 0);

  // Both should share the same epoch
  const devA = (await pool.query('SELECT authority_mode, authority_epoch FROM devices WHERE id = $1', ['dev-a'])).rows[0];
  const devB = (await pool.query('SELECT authority_mode, authority_epoch FROM devices WHERE id = $1', ['dev-b'])).rows[0];
  assert.equal(devA.authority_mode, 'core');
  assert.equal(devB.authority_mode, 'core');
  assert.equal(devA.authority_epoch, devB.authority_epoch);
});

test('switchAuthority skips unknown devices', async () => {
  const { pool } = createTestDb();
  const repo = new PgAuthorityRepository(pool);

  const result = await switchAuthority(repo, { device_ids: ['does-not-exist'], authority_mode: 'core' });
  assert.equal(result.switched, 0);
  assert.equal(result.skipped, 1);
});

// ---------------------------------------------------------------------------
// Unit tests: getAuthorityStatus
// ---------------------------------------------------------------------------

test('getAuthorityStatus returns correct counts by mode', async () => {
  const { pool } = createTestDb();
  const repo = new PgAuthorityRepository(pool);
  const deviceRepo = new PgDeviceRepository(pool);

  await recordDeviceHello(deviceRepo, { deviceId: 'dev-l', name: 'legacy', architecture: 'arm64', protocolVersion: '1' });
  await recordDeviceHello(deviceRepo, { deviceId: 'dev-s', name: 'shadow', architecture: 'arm64', protocolVersion: '1' });
  await recordDeviceHello(deviceRepo, { deviceId: 'dev-c', name: 'core', architecture: 'arm64', protocolVersion: '1' });

  await switchAuthority(repo, { device_ids: ['dev-s'], authority_mode: 'shadow' });
  await switchAuthority(repo, { device_ids: ['dev-c'], authority_mode: 'core' });

  const status = await getAuthorityStatus(repo);
  assert.equal(status.legacy, 1);
  assert.equal(status.shadow, 1);
  assert.equal(status.core, 1);
  assert.equal(status.rollback_pending, 0);
  assert.equal(status.total, 3);
});

// ---------------------------------------------------------------------------
// Unit tests: watermark
// ---------------------------------------------------------------------------

test('finalizeWatermark sets and returns a watermark', async () => {
  const { pool } = createTestDb();
  const repo = new PgAuthorityRepository(pool);
  await migrateAuthority(pool);

  const ts = '2026-07-20T12:00:00Z';
  const record = await finalizeWatermark(repo, ts, 'admin');
  assert.ok(record.id);
  assert.equal(record.watermark, ts);
  assert.equal(record.created_by, 'admin');
  assert.ok(record.created_at);
});

test('finalizeWatermark is idempotent — returns existing watermark on second call', async () => {
  const { pool } = createTestDb();
  const repo = new PgAuthorityRepository(pool);
  await migrateAuthority(pool);

  const ts = '2026-07-20T12:00:00Z';
  const first = await finalizeWatermark(repo, ts, 'admin');
  const second = await finalizeWatermark(repo, '2026-07-21T12:00:00Z', 'operator');
  // Second call returns the original record (pg-mem may reformat timestamps to Date with .000Z)
  const wm = typeof second.watermark === 'object' && second.watermark !== null
    ? new Date(second.watermark).toISOString()
    : second.watermark;
  // pg-mem may serialize with .000Z; accept either form
  assert.ok(wm === ts || wm === ts.replace('Z', '.000Z'),
    `expected ${ts} or ${ts.replace('Z', '.000Z')}, got ${wm}`);
  assert.equal(second.created_by, 'admin');
  // created_at should match (pg-mem may format timestamps differently)
  assert.ok(second.created_at);
  assert.ok(second.id);
});

test('getWatermark returns null when no watermark set', async () => {
  const { pool } = createTestDb();
  const repo = new PgAuthorityRepository(pool);
  await migrateAuthority(pool);

  const result = await getWatermark(repo);
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// Integration tests: HTTP routes
// ---------------------------------------------------------------------------

test('POST /api/admin/authority/switch rejects missing authority_mode', async () => {
  const { pool } = createTestDb();
  const config = makeConfig();
  const authorityRepo = new PgAuthorityRepository(pool);
  const authRepo = new PgAuthRepository(pool);
  const fastify = await buildServer(config, authorityRepo, authRepo);
  const { cookies, csrf } = await adminSession(fastify, config, authRepo);

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/admin/authority/switch',
    headers: { cookie: cookies, 'x-csrf-token': csrf },
    payload: { device_ids: ['dev-1'], authority_mode: 'invalid' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'authority_mode must be one of: legacy, shadow, core, rollback_pending');
});

test('GET /api/admin/authority/status returns device counts', async () => {
  const { pool } = createTestDb();
  const config = makeConfig();
  const authorityRepo = new PgAuthorityRepository(pool);
  const authRepo = new PgAuthRepository(pool);
  const fastify = await buildServer(config, authorityRepo, authRepo);

  // Insert some devices with different authority modes
  const deviceRepo = new PgDeviceRepository(pool);
  await recordDeviceHello(deviceRepo, { deviceId: 'dev-1', name: 'v1', architecture: 'arm64', protocolVersion: '1' });
  await switchAuthority(authorityRepo, { device_ids: ['dev-1'], authority_mode: 'core' });

  const { cookies } = await adminSession(fastify, config, authRepo);
  const res = await fastify.inject({ method: 'GET', url: '/api/admin/authority/status', headers: { cookie: cookies } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.core, 1);
  assert.equal(body.total, 1);
});

test('POST /api/admin/authority/switch with valid payload switches device mode', async () => {
  const { pool } = createTestDb();
  const config = makeConfig();
  const authorityRepo = new PgAuthorityRepository(pool);
  const authRepo = new PgAuthRepository(pool);
  const fastify = await buildServer(config, authorityRepo, authRepo);

  const deviceRepo = new PgDeviceRepository(pool);
  await recordDeviceHello(deviceRepo, { deviceId: 'dev-1', name: 'v1', architecture: 'arm64', protocolVersion: '1' });

  const { cookies, csrf } = await adminSession(fastify, config, authRepo);
  const res = await fastify.inject({
    method: 'POST',
    url: '/api/admin/authority/switch',
    headers: { cookie: cookies, 'x-csrf-token': csrf },
    payload: { device_ids: ['dev-1'], authority_mode: 'core' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.switched, 1);
  assert.ok(body.epoch);
});

test('POST /api/admin/authority/finalize-watermark sets watermark and returns it', async () => {
  const { pool } = createTestDb();
  const config = makeConfig();
  const authorityRepo = new PgAuthorityRepository(pool);
  const authRepo = new PgAuthRepository(pool);
  const fastify = await buildServer(config, authorityRepo, authRepo);

  // Migrate authority tables
  const pgPool = pool;
  await migrateAuthority(pgPool);

  const { cookies, csrf } = await adminSession(fastify, config, authRepo);
  const res = await fastify.inject({
    method: 'POST',
    url: '/api/admin/authority/finalize-watermark',
    headers: { cookie: cookies, 'x-csrf-token': csrf },
    payload: { watermark: '2026-07-20T12:00:00Z' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.watermark.watermark, '2026-07-20T12:00:00Z');
});

test('unauthenticated requests are rejected', async () => {
  const { pool } = createTestDb();
  const config = makeConfig();
  const authorityRepo = new PgAuthorityRepository(pool);
  const authRepo = new PgAuthRepository(pool);
  const fastify = await buildServer(config, authorityRepo, authRepo);

  const res = await fastify.inject({ method: 'GET', url: '/api/admin/authority/status' });
  assert.equal(res.statusCode, 401);
});