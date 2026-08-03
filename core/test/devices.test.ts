import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createTestDb } from './db-helpers.js';
import { PgDeviceRepository, registerDeviceRoutes, createInvitation, consumeInvitation, recordDeviceHello, listDevices, revokeDevice } from '../src/devices.js';
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

async function buildServer(config: CoreConfig, deviceRepo: PgDeviceRepository, authRepo: PgAuthRepository) {
  const fastify = Fastify({ logger: false });
  const { requireAdmin } = await registerAuth(fastify, { config, repo: authRepo });
  await registerDeviceRoutes(fastify, { repo: deviceRepo, requireAdmin });
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

test('createInvitation returns a one-time token and stores only its hash', async () => {
  const { pool } = createTestDb();
  const repo = new PgDeviceRepository(pool);
  const result = await createInvitation(repo, { scope: 'site-a' });
  assert.equal(typeof result.token, 'string');
  assert.equal(result.token.length, 64); // 32 bytes hex
  // The plaintext token must NOT be in the DB; only its hash.
  const rows = (await pool.query('SELECT token_hash FROM device_invitations WHERE id = $1', [result.id])).rows;
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, result.token);
  assert.equal(rows[0].token_hash.length, 64);
});

test('hello with valid invitation marks device paired; plain hello does not', async () => {
  const { pool } = createTestDb();
  const repo = new PgDeviceRepository(pool);

  // Plain hello -> recorded but not paired.
  const plain = await recordDeviceHello(repo, { deviceId: 'dev-plain', name: 'v1', architecture: 'arm64', protocolVersion: '1' });
  assert.equal(plain.paired, false);
  assert.equal(plain.authority_mode, 'legacy');

  // Invitation hello -> paired.
  const inv = await createInvitation(repo, {});
  const paired = await recordDeviceHello(repo, {
    deviceId: 'dev-paired',
    name: 'v1',
    architecture: 'arm64',
    protocolVersion: '1',
    capabilities: ['renderer:web', 'media:video'],
    invitationToken: inv.token,
  });
  assert.equal(paired.paired, true);
  assert.ok(paired.id === 'dev-paired');
  assert.equal(JSON.parse(paired.capabilities).length, 2);

  // Token is now consumed and cannot be reused.
  const reuse = await consumeInvitation(repo, inv.token);
  assert.equal(reuse.ok, false);
});

test('expired/unknown invitation is rejected', async () => {
  const { pool } = createTestDb();
  const repo = new PgDeviceRepository(pool);
  const res = await consumeInvitation(repo, 'does-not-exist');
  assert.equal(res.ok, false);
});

test('revokeDevice marks the device revoked', async () => {
  const { pool } = createTestDb();
  const repo = new PgDeviceRepository(pool);
  await recordDeviceHello(repo, { deviceId: 'dev-1', name: 'v1', architecture: 'amd64', protocolVersion: '1' });
  const revoked = await revokeDevice(repo, 'dev-1');
  assert.ok(revoked);
  assert.equal(revoked!.status, 'revoked');
  assert.ok(revoked!.revoked_at);
  const missing = await revokeDevice(repo, 'nope');
  assert.equal(missing, null);
});

test('admin device routes: create invitation, list, revoke (CSRF-protected)', async () => {
  const { pool } = createTestDb();
  const config = makeConfig();
  const deviceRepo = new PgDeviceRepository(pool);
  const authRepo = new PgAuthRepository(pool);
  const fastify = await buildServer(config, deviceRepo, authRepo);
  const { cookies, csrf } = await adminSession(fastify, config, authRepo);

  // Create invitation (mutation -> needs CSRF).
  const createRes = await fastify.inject({
    method: 'POST',
    url: '/api/admin/devices/invitations',
    headers: { cookie: cookies, 'x-csrf-token': csrf },
    payload: { scope: 'site-a' },
  });
  assert.equal(createRes.statusCode, 200);
  const inv = createRes.json();
  assert.equal(typeof inv.token, 'string');

  // Record a device via the repository using that token, then list.
  await recordDeviceHello(deviceRepo, {
    deviceId: 'dev-x',
    name: 'v1',
    architecture: 'arm64',
    protocolVersion: '1',
    invitationToken: inv.token,
  });

  const listRes = await fastify.inject({ method: 'GET', url: '/api/admin/devices', headers: { cookie: cookies } });
  assert.equal(listRes.statusCode, 200);
  const list = listRes.json();
  assert.equal(list.devices.length, 1);
  assert.equal(list.devices[0].paired, true);
  assert.equal(list.invitations.length, 1);

  // Revoke (mutation -> needs CSRF).
  const revokeRes = await fastify.inject({
    method: 'POST',
    url: '/api/admin/devices/dev-x/revoke',
    headers: { cookie: cookies, 'x-csrf-token': csrf },
    payload: {},
  });
  assert.equal(revokeRes.statusCode, 200);
  assert.equal(revokeRes.json().device.status, 'revoked');
});

test('admin device routes reject unauthenticated requests', async () => {
  const { pool } = createTestDb();
  const config = makeConfig();
  const deviceRepo = new PgDeviceRepository(pool);
  const authRepo = new PgAuthRepository(pool);
  const fastify = await buildServer(config, deviceRepo, authRepo);

  const res = await fastify.inject({ method: 'GET', url: '/api/admin/devices' });
  assert.equal(res.statusCode, 401);
});
