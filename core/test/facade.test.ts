import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createTestDb } from './db-helpers.js';
import {
  PgFacadeRepository,
  setSceneEntitySubscriptions,
  getSceneEntitySubscriptions,
  getWidgetEntityState,
  watchHaEntityChanges,
  clearSceneStale,
  isSceneStale,
  controlEntity,
  registerFacadeRoutes,
  type SceneStaleState,
} from '../src/facade.js';
import { HomeAssistantClient, type HaEntity, type HaWebSocketFactory, type FetchImpl } from '../src/providers/ha.js';
import { PgAuthRepository, bootstrapAdmin, registerAuth } from '../src/auth.js';
import { createScene, PgSceneRepository } from '../src/scenes.js';
import type { CoreConfig } from '../src/config.js';

// --- Fake HA client helpers -------------------------------------------------

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

/**
 * Build a fake HA client with a pre-populated entity cache. No WS or network needed.
 */
function createFakeHaClient(entities: HaEntity[]): HomeAssistantClient {
  // Create a minimal client with a fake WS that never connects.
  const fakeWsFactory: HaWebSocketFactory = () => {
    return {
      on: () => fakeWsFactory('') as any,
      send: () => {},
      close: () => {},
      readyState: 1,
    } as any;
  };
  const fakeFetch: FetchImpl = (() => Promise.resolve(new Response('{}', { status: 200 }))) as FetchImpl;
  const client = new HomeAssistantClient({
    baseUrl: 'http://fake-ha:8123',
    token: 'fake-token',
    fetchImpl: fakeFetch,
    wsFactory: fakeWsFactory,
    autoReconnect: false,
  });
  // Manually seed the cache.
  for (const e of entities) {
    (client as any).cache.set(e.entityId, e);
  }
  return client;
}

function createEmptyHaClient(): HomeAssistantClient {
  return createFakeHaClient([]);
}

// --- Tests ------------------------------------------------------------------

test('setSceneEntitySubscriptions stores and replaces subscriptions', async () => {
  const { pool } = createTestDb();
  const repo = new PgFacadeRepository(pool);

  // Set subscriptions for scene-1.
  await setSceneEntitySubscriptions(repo, 'scene-1', [
    { entityId: 'light.kitchen', required: true },
    { entityId: 'sensor.temp', required: false, filters: { unit: '°C' } },
  ]);

  // Read back via raw query.
  const res = await repo.query(
    'SELECT * FROM scene_entity_subscriptions WHERE scene_id = $1 ORDER BY entity_id',
    ['scene-1'],
  );
  assert.equal(res.rows.length, 2);
  assert.equal(res.rows[0].entity_id, 'light.kitchen');
  assert.equal(res.rows[0].required, true);
  assert.equal(res.rows[1].entity_id, 'sensor.temp');
  assert.equal(res.rows[1].required, false);
  assert.deepEqual(res.rows[1].filters, { unit: '°C' });

  // Replace with a different set.
  await setSceneEntitySubscriptions(repo, 'scene-1', [
    { entityId: 'switch.garage', required: true },
  ]);
  const res2 = await repo.query(
    'SELECT * FROM scene_entity_subscriptions WHERE scene_id = $1',
    ['scene-1'],
  );
  assert.equal(res2.rows.length, 1);
  assert.equal(res2.rows[0].entity_id, 'switch.garage');
});

test('getSceneEntitySubscriptions merges HA state', async () => {
  const { pool } = createTestDb();
  const repo = new PgFacadeRepository(pool);
  const haClient = createFakeHaClient([
    {
      entityId: 'light.kitchen',
      state: 'on',
      attributes: { friendly_name: 'Kitchen Light', brightness: 255 },
    },
    {
      entityId: 'sensor.temp',
      state: '22.5',
      attributes: { friendly_name: 'Temperature', unit_of_measurement: '°C' },
    },
  ]);

  await setSceneEntitySubscriptions(repo, 'scene-1', [
    { entityId: 'light.kitchen', required: true },
    { entityId: 'sensor.temp', required: false },
    { entityId: 'switch.nonexistent', required: true },
  ]);

  const entities = await getSceneEntitySubscriptions(repo, 'scene-1', haClient);

  assert.equal(entities.length, 3);

  // Known entity with merged state.
  const light = entities.find((e) => e.entityId === 'light.kitchen')!;
  assert.equal(light.state, 'on');
  assert.equal(light.friendlyName, 'Kitchen Light');
  assert.equal(light.available, true);

  // Another known entity.
  const temp = entities.find((e) => e.entityId === 'sensor.temp')!;
  assert.equal(temp.state, '22.5');
  assert.equal(temp.available, true);

  // Unknown entity (not in HA cache) -> unavailable.
  const missing = entities.find((e) => e.entityId === 'switch.nonexistent')!;
  assert.equal(missing.state, 'unavailable');
  assert.equal(missing.available, false);
});

test('getWidgetEntityState returns filtered state for a widget config', async () => {
  const { pool } = createTestDb();
  const repo = new PgFacadeRepository(pool);
  const haClient = createFakeHaClient([
    {
      entityId: 'light.kitchen',
      state: 'on',
      attributes: { friendly_name: 'Kitchen Light', brightness: 200 },
    },
  ]);

  await setSceneEntitySubscriptions(repo, 'scene-1', [
    { entityId: 'light.kitchen', required: true },
  ]);

  // Widget config with entityId field.
  const result = await getWidgetEntityState(repo, 'scene-1', { entityId: 'light.kitchen', type: 'light' }, haClient);
  assert.ok(result);
  assert.equal(result!.entityId, 'light.kitchen');
  assert.equal(result!.state, 'on');
  assert.equal(result!.available, true);

  // Widget config with no entityId -> null.
  const noEntity = await getWidgetEntityState(repo, 'scene-1', { type: 'text' }, haClient);
  assert.equal(noEntity, null);
});

test('watchHaEntityChanges marks scenes stale on entity change', async () => {
  const { pool } = createTestDb();
  const repo = new PgFacadeRepository(pool);
  const haClient = createEmptyHaClient();

  // Set up subscriptions.
  await setSceneEntitySubscriptions(repo, 'scene-1', [
    { entityId: 'light.kitchen', required: true },
  ]);
  await setSceneEntitySubscriptions(repo, 'scene-2', [
    { entityId: 'light.kitchen', required: true },
    { entityId: 'sensor.temp', required: false },
  ]);

  // Start watching.
  const tracker = watchHaEntityChanges(haClient, repo);

  // Simulate an entity change via the HA client's entity change listeners.
  const changeEvent = new Map<string, HaEntity>();
  changeEvent.set('light.kitchen', {
    entityId: 'light.kitchen',
    state: 'off',
    attributes: {},
  });

  // Manually trigger the listeners (simulating a WS push).
  for (const listener of (haClient as any).entityChangeListeners as Array<(entityId: string, entity: HaEntity) => void>) {
    await listener('light.kitchen', {
      entityId: 'light.kitchen',
      state: 'off',
      attributes: {},
    });
  }

  // Both scenes should be stale.
  assert.ok(isSceneStale(tracker, 'scene-1'));
  assert.ok(isSceneStale(tracker, 'scene-2'));

  // Clear one scene.
  clearSceneStale(tracker, 'scene-1');
  assert.equal(isSceneStale(tracker, 'scene-1'), false);
  assert.ok(isSceneStale(tracker, 'scene-2'));
});

test('controlEntity calls HA service and returns result', async () => {
  // Create a fake HA client that records callService args.
  let calledDomain = '';
  let calledService = '';
  let calledData: Record<string, unknown> = {};
  const fakeHaClient = new HomeAssistantClient({
    baseUrl: 'http://fake-ha:8123',
    token: 'fake-token',
    fetchImpl: (async (url: string, init?: RequestInit) => {
      // Parse the URL for domain/service
      const match = url.match(/\/services\/([^/]+)\/([^/]+)/);
      if (match) {
        calledDomain = match[1];
        calledService = match[2];
        calledData = JSON.parse((init?.body as string) ?? '{}');
      }
      return new Response(JSON.stringify([
        { entity_id: 'light.living_room', state: 'on', attributes: {} },
      ]), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as FetchImpl,
    wsFactory: (() => ({
      on: () => undefined as any,
      send: () => {},
      close: () => {},
      readyState: 1,
    })) as HaWebSocketFactory,
    autoReconnect: false,
  });

  const result = await controlEntity(fakeHaClient, 'light.living_room', 'light', 'turn_on', { brightness: 128 });
  assert.equal(calledDomain, 'light');
  assert.equal(calledService, 'turn_on');
  assert.equal(calledData.entity_id, 'light.living_room');
  assert.equal(calledData.brightness, 128);
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 1);
});

test('controlEntity throws when HA is not configured', async () => {
  await assert.rejects(
    () => controlEntity(null, 'light.kitchen', 'light', 'turn_on'),
    /ha_not_configured/,
  );
});

test('admin facade routes: batch-set and list entities', async () => {
  const { pool } = createTestDb();
  const config = makeConfig();
  const facadeRepo = new PgFacadeRepository(pool);
  const authRepo = new PgAuthRepository(pool);
  const haClient = createFakeHaClient([
    {
      entityId: 'light.kitchen',
      state: 'on',
      attributes: { friendly_name: 'Kitchen Light' },
    },
  ]);
  const sceneStale: SceneStaleState = { stale: new Set() };

  // Create a scene first (needed for FK/consistency in the test).
  const sceneRepo = new PgSceneRepository(pool);
  const scene = await createScene(sceneRepo, 'Test Scene', { widgets: [] });

  const fastify = Fastify({ logger: false });
  const { requireAdmin } = await registerAuth(fastify, { config, repo: authRepo });
  await registerFacadeRoutes(fastify, { repo: facadeRepo, haClient, sceneStale, requireAdmin });
  await fastify.ready();

  // Login as admin.
  await bootstrapAdmin(config, authRepo);
  const login = await fastify.inject({
    method: 'POST',
    url: '/api/admin/login',
    payload: { username: 'admin', password: 'changeme' },
  });
  const setCookie = login.headers['set-cookie'] as unknown as string[];
  const cookies = setCookie.map((c: string) => c.split(';')[0]).join('; ');
  const csrf = setCookie.find((c: string) => c.startsWith('csrf_token='))!.split(';')[0].replace('csrf_token=', '');

  // POST batch-set entities.
  const post = await fastify.inject({
    method: 'POST',
    url: `/api/admin/scenes/${scene.id}/entities`,
    headers: { cookie: cookies, 'x-csrf-token': csrf },
    payload: {
      entities: [
        { entityId: 'light.kitchen', required: true },
        { entityId: 'sensor.temp', required: false },
      ],
    },
  });
  assert.equal(post.statusCode, 200);
  assert.equal(post.json().count, 2);

  // GET list entities with merged HA state.
  const get = await fastify.inject({
    method: 'GET',
    url: `/api/admin/scenes/${scene.id}/entities`,
    headers: { cookie: cookies },
  });
  assert.equal(get.statusCode, 200);
  const body = get.json();
  assert.equal(body.sceneId, scene.id);
  assert.equal(body.entities.length, 2);
  const light = body.entities.find((e: any) => e.entityId === 'light.kitchen');
  assert.ok(light);
  assert.equal(light.state, 'on');
  assert.equal(light.available, true);
  const temp = body.entities.find((e: any) => e.entityId === 'sensor.temp');
  assert.ok(temp);
  assert.equal(temp.state, 'unavailable');
  assert.equal(temp.available, false);
  // stale should be false (cleared on read).
  assert.equal(body.stale, false);
});

test('admin facade routes reject unauthenticated requests', async () => {
  const { pool } = createTestDb();
  const config = makeConfig();
  const facadeRepo = new PgFacadeRepository(pool);
  const authRepo = new PgAuthRepository(pool);
  const haClient = createEmptyHaClient();
  const sceneStale: SceneStaleState = { stale: new Set() };

  const fastify = Fastify({ logger: false });
  const { requireAdmin } = await registerAuth(fastify, { config, repo: authRepo });
  await registerFacadeRoutes(fastify, { repo: facadeRepo, haClient, sceneStale, requireAdmin });
  await fastify.ready();

  // POST without auth -> 401.
  const post = await fastify.inject({
    method: 'POST',
    url: '/api/admin/scenes/fake-id/entities',
    payload: { entities: [] },
  });
  assert.equal(post.statusCode, 401);

  // GET without auth -> 401.
  const get = await fastify.inject({
    method: 'GET',
    url: '/api/admin/scenes/fake-id/entities',
  });
  assert.equal(get.statusCode, 401);
});