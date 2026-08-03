import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createTestDb } from './db-helpers.js';
import {
  PgStateRepository,
  registerStateRoutes,
  setDesiredState,
  getDesiredState,
  getCurrentRevision,
  reportState,
  getReportedState,
  MonotonicRevisionError,
} from '../src/state.js';
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

async function buildServer(config: CoreConfig, stateRepo: PgStateRepository, authRepo: PgAuthRepository) {
  const fastify = Fastify({ logger: false });
  const { requireAdmin } = await registerAuth(fastify, { config, repo: authRepo });
  await registerStateRoutes(fastify, { repo: stateRepo, requireAdmin });
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

test('setDesiredState returns incrementing revision and getDesiredState returns stored state', async () => {
  const { pool } = createTestDb();
  const repo = new PgStateRepository(pool);

  const r1 = await setDesiredState(repo, 'dev-1', 'display', { power: 'on', brightness: 70 });
  const r2 = await setDesiredState(repo, 'dev-1', 'audio', { volume: 45 });

  assert.equal(r1, 1);
  assert.equal(r2, 2);
  assert.equal(await getCurrentRevision(repo, 'dev-1'), 2);

  const desired = await getDesiredState(repo, 'dev-1');
  assert.equal(desired.length, 2);
  const display = desired.find((d) => d.domain === 'display')!;
  assert.equal(display.revision, 1);
  assert.deepEqual(display.state, { power: 'on', brightness: 70 });
  assert.equal(display.authorityMode, 'legacy');
  assert.equal(display.provenance, 'core');
});

test('setDesiredState rejects a lower-or-equal explicit revision (monotonic ordering)', async () => {
  const { pool } = createTestDb();
  const repo = new PgStateRepository(pool);

  await setDesiredState(repo, 'dev-1', 'display', { power: 'on' }, { revision: 5 });
  assert.equal(await getCurrentRevision(repo, 'dev-1'), 5);

  // Equal revision is rejected.
  await assert.rejects(
    () => setDesiredState(repo, 'dev-1', 'display', { power: 'off' }, { revision: 5 }),
    (err: unknown) => err instanceof MonotonicRevisionError && err.current === 5 && err.attempted === 5,
  );

  // Lower revision is rejected.
  await assert.rejects(
    () => setDesiredState(repo, 'dev-1', 'display', { power: 'off' }, { revision: 4 }),
    (err: unknown) => err instanceof MonotonicRevisionError && err.current === 5 && err.attempted === 4,
  );

  // Higher revision is accepted.
  const r = await setDesiredState(repo, 'dev-1', 'display', { power: 'off' }, { revision: 6 });
  assert.equal(r, 6);
});

test('reportState records per-domain status and getReportedState returns it', async () => {
  const { pool } = createTestDb();
  const repo = new PgStateRepository(pool);

  await reportState(repo, 'dev-1', 'display', { power: 'on', brightness: 70 }, 'applied');
  await reportState(repo, 'dev-1', 'audio', { volume: 0 }, 'failed');

  const reported = await getReportedState(repo, 'dev-1');
  assert.equal(reported.length, 2);
  const display = reported.find((d) => d.domain === 'display')!;
  assert.equal(display.status, 'applied');
  assert.deepEqual(display.state, { power: 'on', brightness: 70 });
  const audio = reported.find((d) => d.domain === 'audio')!;
  assert.equal(audio.status, 'failed');
});

test('admin desired-state routes: get, put (monotonic), and reported get', async () => {
  const { pool } = createTestDb();
  const config = makeConfig();
  const stateRepo = new PgStateRepository(pool);
  const authRepo = new PgAuthRepository(pool);
  const fastify = await buildServer(config, stateRepo, authRepo);
  const { cookies, csrf } = await adminSession(fastify, config, authRepo);

  // PUT desired state (mutation -> CSRF).
  const put = await fastify.inject({
    method: 'PUT',
    url: '/api/admin/devices/dev-x/desired-state',
    headers: { cookie: cookies, 'x-csrf-token': csrf },
    payload: { domain: 'display', state: { power: 'on' }, provenance: 'core' },
  });
  assert.equal(put.statusCode, 200);
  assert.equal(put.json().revision, 1);

  // GET desired state.
  const get = await fastify.inject({ method: 'GET', url: '/api/admin/devices/dev-x/desired-state', headers: { cookie: cookies } });
  assert.equal(get.statusCode, 200);
  assert.equal(get.json().revision, 1);
  assert.equal(get.json().domains.length, 1);

  // PUT a lower-or-equal revision -> 409 conflict.
  const conflict = await fastify.inject({
    method: 'PUT',
    url: '/api/admin/devices/dev-x/desired-state',
    headers: { cookie: cookies, 'x-csrf-token': csrf },
    payload: { domain: 'display', state: { power: 'off' }, revision: 1 },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error, 'monotonic_revision_conflict');

  // GET reported state (none yet).
  const rep = await fastify.inject({ method: 'GET', url: '/api/admin/devices/dev-x/reported-state', headers: { cookie: cookies } });
  assert.equal(rep.statusCode, 200);
  assert.equal(rep.json().domains.length, 0);
});

test('admin desired-state routes reject unauthenticated requests', async () => {
  const { pool } = createTestDb();
  const config = makeConfig();
  const stateRepo = new PgStateRepository(pool);
  const authRepo = new PgAuthRepository(pool);
  const fastify = await buildServer(config, stateRepo, authRepo);

  const res = await fastify.inject({ method: 'GET', url: '/api/admin/devices/dev-x/desired-state' });
  assert.equal(res.statusCode, 401);
});
