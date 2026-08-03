import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createTestDb } from './db-helpers.js';
import {
  PgSceneRepository,
  registerSceneRoutes,
  createScene,
  publishScene,
  getScene,
  listScenes,
  assignScene,
  listAssignments,
  stageSceneRevision,
  rollbackScene,
  listSceneRevisions,
  deleteScene,
} from '../src/scenes.js';
import { PgAssetRepository } from '../src/assets.js';
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

async function buildServer(config: CoreConfig, sceneRepo: PgSceneRepository, assetRepo: PgAssetRepository, authRepo: PgAuthRepository) {
  const fastify = Fastify({ logger: false });
  const { requireAdmin } = await registerAuth(fastify, { config, repo: authRepo });
  await registerSceneRoutes(fastify, { repo: sceneRepo, assetRepo, requireAdmin });
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

// --- Existing tests (preserved) -----------------------------------------------

test('createScene starts staged at revision 1; publish bumps revision and sets published', async () => {
  const { pool } = createTestDb();
  const repo = new PgSceneRepository(pool);

  const created = await createScene(repo, 'Lobby', { widgets: [] });
  assert.equal(created.status, 'staged');
  assert.equal(created.revision, 1);
  assert.deepEqual(created.manifest, { widgets: [] });

  const published = await publishScene(repo, created.id);
  assert.equal(published.status, 'published');
  assert.equal(published.revision, 1);
  assert.ok(published.publishedAt);

  const fetched = await getScene(repo, created.id);
  assert.equal(fetched!.status, 'published');
  assert.equal(fetched!.revision, 1);
});

test('deleteScene removes revisions and force-clears panel references', async () => {
  const { pool } = createTestDb();
  const repo = new PgSceneRepository(pool);
  const scene = await createScene(repo, 'Disposable', { widgets: [] });
  await pool.query(`INSERT INTO pages (id, name) VALUES ('delete-page', 'Delete page')`);
  await pool.query(
    `INSERT INTO page_panels (id, page_id, name, content_type, scene_id)
     VALUES ('delete-panel', 'delete-page', 'Scene panel', 'scene', $1)`,
    [scene.id],
  );
  await assert.rejects(() => deleteScene(repo, scene.id), /scene_in_use/);
  const removed = await deleteScene(repo, scene.id, true);
  assert.equal(removed.panelReferencesCleared, 1);
  assert.equal(await getScene(repo, scene.id), null);
  const panel = await pool.query('SELECT content_type, scene_id FROM page_panels WHERE id = $1', ['delete-panel']);
  assert.equal(panel.rows[0].content_type, 'url');
  assert.equal(panel.rows[0].scene_id, null);
});

test('publishScene throws for an unknown scene', async () => {
  const { pool } = createTestDb();
  const repo = new PgSceneRepository(pool);
  await assert.rejects(() => publishScene(repo, 'does-not-exist'), /scene_not_found/);
});

test('assignScene to a device then listScenes shows it', async () => {
  const { pool } = createTestDb();
  const repo = new PgSceneRepository(pool);

  const scene = await createScene(repo, 'Lobby', { widgets: [] });
  await publishScene(repo, scene.id);
  await assignScene(repo, scene.id, 'dev-1');

  const assignments = await listAssignments(repo, scene.id);
  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].deviceId, 'dev-1');

  const scenes = await listScenes(repo);
  assert.equal(scenes.length, 1);
  assert.equal(scenes[0].id, scene.id);
  assert.equal(scenes[0].status, 'published');
});

test('admin scene routes: create, publish, assign, list', async () => {
  const { pool } = createTestDb();
  const config = makeConfig();
  const sceneRepo = new PgSceneRepository(pool);
  const assetRepo = new PgAssetRepository(pool);
  const authRepo = new PgAuthRepository(pool);
  const fastify = await buildServer(config, sceneRepo, assetRepo, authRepo);
  const { cookies, csrf } = await adminSession(fastify, config, authRepo);

  // Create (mutation -> CSRF).
  const create = await fastify.inject({
    method: 'POST',
    url: '/api/admin/scenes',
    headers: { cookie: cookies, 'x-csrf-token': csrf },
    payload: { name: 'Lobby', manifest: { widgets: [] } },
  });
  assert.equal(create.statusCode, 200);
  const sceneId = create.json().scene.id;
  assert.equal(create.json().scene.status, 'staged');

  // Publish (mutation -> CSRF).
  const publish = await fastify.inject({
    method: 'POST',
    url: `/api/admin/scenes/${sceneId}/publish`,
    headers: { cookie: cookies, 'x-csrf-token': csrf },
    payload: {},
  });
  assert.equal(publish.statusCode, 200);
  assert.equal(publish.json().scene.status, 'published');

  // Assign (mutation -> CSRF).
  const assign = await fastify.inject({
    method: 'POST',
    url: `/api/admin/scenes/${sceneId}/assign`,
    headers: { cookie: cookies, 'x-csrf-token': csrf },
    payload: { deviceId: 'dev-1' },
  });
  assert.equal(assign.statusCode, 200);
  assert.equal(assign.json().assignment.deviceId, 'dev-1');

  // List (read -> no CSRF).
  const list = await fastify.inject({ method: 'GET', url: '/api/admin/scenes', headers: { cookie: cookies } });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().scenes.length, 1);
  assert.equal(list.json().scenes[0].id, sceneId);
});

test('admin scene routes reject unauthenticated requests', async () => {
  const { pool } = createTestDb();
  const config = makeConfig();
  const sceneRepo = new PgSceneRepository(pool);
  const assetRepo = new PgAssetRepository(pool);
  const authRepo = new PgAuthRepository(pool);
  const fastify = await buildServer(config, sceneRepo, assetRepo, authRepo);

  const res = await fastify.inject({ method: 'GET', url: '/api/admin/scenes' });
  assert.equal(res.statusCode, 401);
});

// --- Phase 4 staged publication tests -----------------------------------------

test('stageSceneRevision creates a new revision with incremented number', async () => {
  const { pool } = createTestDb();
  const repo = new PgSceneRepository(pool);

  const scene = await createScene(repo, 'Test', { widgets: [] });
  assert.equal(scene.revision, 1);

  const staged = await stageSceneRevision(repo, scene.id, { widgets: [{ type: 'text' }] });
  assert.equal(staged.revision, 2);
  assert.equal(staged.status, 'staged');
  assert.equal(staged.sceneId, scene.id);

  // The scene row should be updated.
  const updated = await getScene(repo, scene.id);
  assert.equal(updated!.revision, 2);
  assert.equal(updated!.status, 'staged');
});

test('publishScene requires staged status', async () => {
  const { pool } = createTestDb();
  const repo = new PgSceneRepository(pool);

  const scene = await createScene(repo, 'Test', { widgets: [] });
  // First publish works.
  await publishScene(repo, scene.id);

  // Second publish should fail because it's already published, not staged.
  await assert.rejects(() => publishScene(repo, scene.id), /scene_not_staged/);
});

test('publishScene atomicity: only staged scenes can be published', async () => {
  const { pool } = createTestDb();
  const repo = new PgSceneRepository(pool);

  const scene = await createScene(repo, 'Atomic', { widgets: [] });

  // Publish directly (skips explicit stage, since createScene already sets staged).
  const published = await publishScene(repo, scene.id);
  assert.equal(published.status, 'published');

  // Verify the scene_revisions row is also marked published.
  const revisions = await listSceneRevisions(repo, scene.id);
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].status, 'published');
});

test('rollbackScene restores previous published revision', async () => {
  const { pool } = createTestDb();
  const repo = new PgSceneRepository(pool);

  // Create scene with manifest v1.
  const scene = await createScene(repo, 'Rollback', { version: 1, widgets: [] });
  await publishScene(repo, scene.id);

  // Stage a new revision v2.
  const staged = await stageSceneRevision(repo, scene.id, { version: 2, widgets: [{ type: 'text' }] });
  assert.equal(staged.revision, 2);

  // Publish v2.
  await publishScene(repo, scene.id);

  // Verify v2 is published.
  const afterPublish = await getScene(repo, scene.id);
  assert.deepEqual(afterPublish!.manifest, { version: 2, widgets: [{ type: 'text' }] });

  // Rollback to v1.
  const rolled = await rollbackScene(repo, scene.id);
  assert.equal(rolled.status, 'published');
  assert.deepEqual(rolled.manifest, { version: 1, widgets: [] });

  // Verify revisions: v1 is published, v2 is rolled_back.
  const revisions = await listSceneRevisions(repo, scene.id);
  const v1 = revisions.find(r => r.revision === 1);
  const v2 = revisions.find(r => r.revision === 2);
  assert.ok(v1);
  assert.ok(v2);
  assert.equal(v1!.status, 'published');
  assert.equal(v2!.status, 'rolled_back');
});

test('rollbackScene throws for non-published scene', async () => {
  const { pool } = createTestDb();
  const repo = new PgSceneRepository(pool);

  const scene = await createScene(repo, 'NeverPublished', { widgets: [] });
  await assert.rejects(() => rollbackScene(repo, scene.id), /scene_not_published/);
});

test('rollbackScene throws when no previous revision exists', async () => {
  const { pool } = createTestDb();
  const repo = new PgSceneRepository(pool);

  const scene = await createScene(repo, 'FirstRev', { widgets: [] });
  await publishScene(repo, scene.id);
  // Only one revision — no previous to roll back to.
  await assert.rejects(() => rollbackScene(repo, scene.id), /no_previous_revision/);
});

test('listSceneRevisions returns all revisions in order', async () => {
  const { pool } = createTestDb();
  const repo = new PgSceneRepository(pool);

  const scene = await createScene(repo, 'Revisions', { v: 1 });
  await stageSceneRevision(repo, scene.id, { v: 2 });
  await stageSceneRevision(repo, scene.id, { v: 3 });

  const revisions = await listSceneRevisions(repo, scene.id);
  assert.equal(revisions.length, 3);
  assert.equal(revisions[0].revision, 3); // DESC
  assert.equal(revisions[1].revision, 2);
  assert.equal(revisions[2].revision, 1);
});

test('stage -> publish -> rollback lifecycle via HTTP routes', async () => {
  const { pool } = createTestDb();
  const config = makeConfig();
  const sceneRepo = new PgSceneRepository(pool);
  const assetRepo = new PgAssetRepository(pool);
  const authRepo = new PgAuthRepository(pool);
  const fastify = await buildServer(config, sceneRepo, assetRepo, authRepo);
  const { cookies, csrf } = await adminSession(fastify, config, authRepo);

  // Create.
  const create = await fastify.inject({
    method: 'POST',
    url: '/api/admin/scenes',
    headers: { cookie: cookies, 'x-csrf-token': csrf },
    payload: { name: 'Lifecycle', manifest: { v: 1 } },
  });
  assert.equal(create.statusCode, 200);
  const sceneId = create.json().scene.id;

  // Publish v1.
  const pub1 = await fastify.inject({
    method: 'POST',
    url: `/api/admin/scenes/${sceneId}/publish`,
    headers: { cookie: cookies, 'x-csrf-token': csrf },
    payload: {},
  });
  assert.equal(pub1.statusCode, 200);
  assert.equal(pub1.json().scene.status, 'published');

  // Stage v2.
  const stage = await fastify.inject({
    method: 'POST',
    url: `/api/admin/scenes/${sceneId}/stage`,
    headers: { cookie: cookies, 'x-csrf-token': csrf },
    payload: { manifest: { v: 2 } },
  });
  assert.equal(stage.statusCode, 200);
  assert.equal(stage.json().revision.revision, 2);

  // Publish v2.
  const pub2 = await fastify.inject({
    method: 'POST',
    url: `/api/admin/scenes/${sceneId}/publish`,
    headers: { cookie: cookies, 'x-csrf-token': csrf },
    payload: {},
  });
  assert.equal(pub2.statusCode, 200);
  assert.deepEqual(pub2.json().scene.manifest, { v: 2 });

  // Rollback to v1.
  const roll = await fastify.inject({
    method: 'POST',
    url: `/api/admin/scenes/${sceneId}/rollback`,
    headers: { cookie: cookies, 'x-csrf-token': csrf },
    payload: {},
  });
  assert.equal(roll.statusCode, 200);
  assert.deepEqual(roll.json().scene.manifest, { v: 1 });

  // List revisions — should have 2 revisions.
  const revs = await fastify.inject({
    method: 'GET',
    url: `/api/admin/scenes/${sceneId}/revisions`,
    headers: { cookie: cookies },
  });
  assert.equal(revs.statusCode, 200);
  assert.equal(revs.json().revisions.length, 2);
});

test('publishScene rejects for non-existent scene via HTTP', async () => {
  const { pool } = createTestDb();
  const config = makeConfig();
  const sceneRepo = new PgSceneRepository(pool);
  const assetRepo = new PgAssetRepository(pool);
  const authRepo = new PgAuthRepository(pool);
  const fastify = await buildServer(config, sceneRepo, assetRepo, authRepo);
  const { cookies, csrf } = await adminSession(fastify, config, authRepo);

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/admin/scenes/nonexistent/publish',
    headers: { cookie: cookies, 'x-csrf-token': csrf },
    payload: {},
  });
  assert.equal(res.statusCode, 409);
  assert.ok(res.json().error.includes('scene_not_found'));
});
