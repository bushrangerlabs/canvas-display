import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createTestDb } from './db-helpers.js';
import { PgAuthRepository, bootstrapAdmin, registerAuth, type AdminRole } from '../src/auth.js';
import type { CoreConfig } from '../src/config.js';

function makeConfig(overrides: Partial<CoreConfig> = {}): CoreConfig {
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
    ...overrides,
  };
}

async function buildServer(config: CoreConfig, repo: PgAuthRepository) {
  const fastify = Fastify({ logger: false });
  const { requireAdmin } = await registerAuth(fastify, { config, repo });
  // A protected mutation route exercising role + CSRF enforcement.
  fastify.post(
    '/api/admin/secret',
    { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) },
    async () => ({ ok: true }),
  );
  // A protected read route (no CSRF required).
  fastify.get(
    '/api/admin/secret',
    { preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }) },
    async (request) => ({ user: (request.user as { username: string }).username }),
  );
  await fastify.ready();
  return fastify;
}

function cookieHeader(setCookie: string[]): string {
  return setCookie.map((c) => c.split(';')[0]).join('; ');
}

test('bootstrapAdmin creates a default admin when table empty', async () => {
  const { pool } = createTestDb();
  const repo = new PgAuthRepository(pool);
  const config = makeConfig();
  await bootstrapAdmin(config, repo);
  const count = await repo.countAdmins();
  assert.equal(count, 1);
  const user = await repo.findAdminByUsername('admin');
  assert.ok(user);
  assert.equal(user.role, 'admin');
});

test('login with seeded admin returns session + csrf cookies', async () => {
  const { pool } = createTestDb();
  const repo = new PgAuthRepository(pool);
  await bootstrapAdmin(makeConfig(), repo);
  const fastify = await buildServer(makeConfig(), repo);

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/admin/login',
    payload: { username: 'admin', password: 'changeme' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.role, 'admin');
  const setCookie = res.headers['set-cookie'] as unknown as string[];
  assert.ok(setCookie.some((c) => c.startsWith('canvas_core_session=')));
  assert.ok(setCookie.some((c) => c.startsWith('csrf_token=')));
});

test('login rejects wrong password with 401', async () => {
  const { pool } = createTestDb();
  const repo = new PgAuthRepository(pool);
  await bootstrapAdmin(makeConfig(), repo);
  const fastify = await buildServer(makeConfig(), repo);

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/admin/login',
    payload: { username: 'admin', password: 'wrong' },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'invalid_credentials');
});

test('protected route rejects unauthenticated requests with 401', async () => {
  const { pool } = createTestDb();
  const repo = new PgAuthRepository(pool);
  await bootstrapAdmin(makeConfig(), repo);
  const fastify = await buildServer(makeConfig(), repo);

  const res = await fastify.inject({ method: 'GET', url: '/api/admin/secret' });
  assert.equal(res.statusCode, 401);
});

test('protected route accepts valid session cookie', async () => {
  const { pool } = createTestDb();
  const repo = new PgAuthRepository(pool);
  await bootstrapAdmin(makeConfig(), repo);
  const fastify = await buildServer(makeConfig(), repo);

  const login = await fastify.inject({
    method: 'POST',
    url: '/api/admin/login',
    payload: { username: 'admin', password: 'changeme' },
  });
  const cookies = cookieHeader(login.headers['set-cookie'] as unknown as string[]);
  const res = await fastify.inject({ method: 'GET', url: '/api/admin/secret', headers: { cookie: cookies } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().user, 'admin');
});

test('state-changing route requires matching CSRF token', async () => {
  const { pool } = createTestDb();
  const repo = new PgAuthRepository(pool);
  await bootstrapAdmin(makeConfig(), repo);
  const fastify = await buildServer(makeConfig(), repo);

  const login = await fastify.inject({
    method: 'POST',
    url: '/api/admin/login',
    payload: { username: 'admin', password: 'changeme' },
  });
  const setCookie = login.headers['set-cookie'] as unknown as string[];
  const cookies = cookieHeader(setCookie);
  const csrf = setCookie.find((c) => c.startsWith('csrf_token='))!.split(';')[0].replace('csrf_token=', '');

  // No CSRF header -> rejected.
  const noCsrf = await fastify.inject({ method: 'POST', url: '/api/admin/secret', headers: { cookie: cookies }, payload: {} });
  assert.equal(noCsrf.statusCode, 403);
  assert.equal(noCsrf.json().error, 'csrf_mismatch');

  // Correct CSRF header -> accepted.
  const ok = await fastify.inject({
    method: 'POST',
    url: '/api/admin/secret',
    headers: { cookie: cookies, 'x-csrf-token': csrf },
    payload: {},
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().ok, true);
});

test('automation bearer token authorizes protected mutations without session CSRF', async () => {
  const { pool } = createTestDb();
  const repo = new PgAuthRepository(pool);
  const config = makeConfig({ automationToken: 'automation-test-secret' });
  await bootstrapAdmin(config, repo);
  const fastify = await buildServer(config, repo);
  const accepted = await fastify.inject({
    method: 'POST',
    url: '/api/admin/secret',
    headers: { authorization: 'Bearer automation-test-secret' },
    payload: {},
  });
  assert.equal(accepted.statusCode, 200);
  const rejected = await fastify.inject({
    method: 'POST',
    url: '/api/admin/secret',
    headers: { authorization: 'Bearer wrong-token' },
    payload: {},
  });
  assert.equal(rejected.statusCode, 401);
});

test('logout clears session cookies', async () => {
  const { pool } = createTestDb();
  const repo = new PgAuthRepository(pool);
  await bootstrapAdmin(makeConfig(), repo);
  const fastify = await buildServer(makeConfig(), repo);

  const login = await fastify.inject({
    method: 'POST',
    url: '/api/admin/login',
    payload: { username: 'admin', password: 'changeme' },
  });
  const cookies = cookieHeader(login.headers['set-cookie'] as unknown as string[]);
  const res = await fastify.inject({ method: 'POST', url: '/api/admin/logout', headers: { cookie: cookies } });
  assert.equal(res.statusCode, 200);
  const setCookie = res.headers['set-cookie'] as unknown as string[];
  assert.ok(setCookie.some((c) => c.startsWith('canvas_core_session=;')));
});
