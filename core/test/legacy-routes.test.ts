/**
 * Tests for the legacy sidecar compatibility routes (pages/panels/settings/audio/commands).
 *
 * These back the web UI's PagesPage and SettingsPage against Core's Postgres
 * instead of each Pi's local SQLite. Uses `pg-mem` so the tests run without a
 * network or Docker.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createTestDb } from './db-helpers.js';
import {
  registerLegacyRoutes,
  getAudioState,
  setAudioStateField,
  resetAudioState,
  broadcast,
  getConnectedDeviceIds,
} from '../src/legacy-routes.js';
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
    allowOpenPairing: true,
    voiceMaxSessionsPerUser: 3,
    voiceMaxSessionsGlobal: 10,
    voiceIdleTimeoutMs: 60_000,
    voiceMaxSessionDurationMs: 30_000,
    voiceVadThreshold: 500,
    voiceVadSilenceMs: 3_000,
    voiceVadContinueTimeoutMs: 2_000,
  };
}

async function buildServer(opts: {
  withAuth?: boolean;
  onDisplayPage?: Parameters<typeof registerLegacyRoutes>[1]['onDisplayPage'];
  getMqttStatus?: Parameters<typeof registerLegacyRoutes>[1]['getMqttStatus'];
  reconnectMqtt?: Parameters<typeof registerLegacyRoutes>[1]['reconnectMqtt'];
  disconnectMqtt?: Parameters<typeof registerLegacyRoutes>[1]['disconnectMqtt'];
  settingsChanged?: Parameters<typeof registerLegacyRoutes>[1]['settingsChanged'];
} = {}) {
  const { pool } = createTestDb();
  const config = makeConfig();
  const fastify = Fastify({ logger: false });
  let cookies = '';
  let csrf = '';
  if (opts.withAuth) {
    const authRepo = new PgAuthRepository(pool);
    await bootstrapAdmin(config, authRepo);
    const { requireAdmin } = await registerAuth(fastify, { config, repo: authRepo });
    await registerLegacyRoutes(fastify, { pool, requireAdmin, ...opts });
    await fastify.ready();
    const login = await fastify.inject({
      method: 'POST',
      url: '/api/admin/login',
      payload: { username: 'admin', password: 'changeme' },
    });
    const setCookie = login.headers['set-cookie'] as unknown as string[];
    cookies = setCookie.map((c) => c.split(';')[0]).join('; ');
    const csrfCookie = setCookie.find((c) => c.startsWith('csrf_token='));
    csrf = csrfCookie ? csrfCookie.split(';')[0].replace('csrf_token=', '') : '';
  } else {
    await registerLegacyRoutes(fastify, { pool, ...opts });
    await fastify.ready();
  }
  return { fastify, pool, cookies, csrf };
}

function authHeaders(cookies: string, csrf: string): Record<string, string> {
  return { cookie: cookies, 'x-csrf-token': csrf };
}

// ─── Pages CRUD ──────────────────────────────────────────────────────────────

test('GET /api/pages returns empty list when no pages exist', async () => {
  const { fastify } = await buildServer();
  const res = await fastify.inject({ method: 'GET', url: '/api/pages' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), []);
});

test('POST /api/pages creates a page and GET /api/pages lists it', async () => {
  const { fastify } = await buildServer();
  const create = await fastify.inject({
    method: 'POST',
    url: '/api/pages',
    payload: { name: 'Lobby' },
  });
  assert.equal(create.statusCode, 201);
  const page = create.json();
  assert.equal(page.name, 'Lobby');
  assert.ok(page.id);
  assert.deepEqual(page.panels, []);

  const list = await fastify.inject({ method: 'GET', url: '/api/pages' });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().length, 1);
  assert.equal(list.json()[0].name, 'Lobby');
});

test('POST /api/pages with panels persists panels in order', async () => {
  const { fastify } = await buildServer();
  const create = await fastify.inject({
    method: 'POST',
    url: '/api/pages',
    payload: {
      name: 'Dashboard',
      panels: [
        { name: 'Top', x: 0, y: 0, w: 100, h: 50 },
        { name: 'Bottom', x: 0, y: 50, w: 100, h: 50, url: 'https://example.com' },
      ],
    },
  });
  assert.equal(create.statusCode, 201);
  const page = create.json();
  assert.equal(page.panels.length, 2);
  assert.equal(page.panels[0].name, 'Top');
  assert.equal(page.panels[0].position, 0);
  assert.equal(page.panels[1].name, 'Bottom');
  assert.equal(page.panels[1].url, 'https://example.com');
  assert.equal(page.panels[1].position, 1);
});

test('GET /api/pages/:id returns the page with panels; 404 when missing', async () => {
  const { fastify } = await buildServer();
  const create = await fastify.inject({
    method: 'POST',
    url: '/api/pages',
    payload: { name: 'P' },
  });
  const id = create.json().id;

  const got = await fastify.inject({ method: 'GET', url: `/api/pages/${id}` });
  assert.equal(got.statusCode, 200);
  assert.equal(got.json().id, id);

  const missing = await fastify.inject({ method: 'GET', url: '/api/pages/does-not-exist' });
  assert.equal(missing.statusCode, 404);
});

test('PATCH /api/pages/:id updates name and floating_config', async () => {
  const { fastify } = await buildServer();
  const create = await fastify.inject({
    method: 'POST',
    url: '/api/pages',
    payload: { name: 'Old' },
  });
  const id = create.json().id;

  const patch = await fastify.inject({
    method: 'PATCH',
    url: `/api/pages/${id}`,
    payload: { name: 'New', floating_config: { x: 1, y: 2, w: 3, h: 4, visible: true } },
  });
  assert.equal(patch.statusCode, 200);
  assert.equal(patch.json().name, 'New');
  assert.deepEqual(patch.json().floating_config, { x: 1, y: 2, w: 3, h: 4, visible: true });

  // Persisted.
  const got = await fastify.inject({ method: 'GET', url: `/api/pages/${id}` });
  assert.equal(got.json().name, 'New');
});

test('DELETE /api/pages/:id removes the page and its panels', async () => {
  const { fastify, pool } = await buildServer();
  const create = await fastify.inject({
    method: 'POST',
    url: '/api/pages',
    payload: { name: 'To Delete', panels: [{ name: 'P1' }] },
  });
  const id = create.json().id;

  const del = await fastify.inject({ method: 'DELETE', url: `/api/pages/${id}` });
  assert.equal(del.statusCode, 200);
  assert.equal(del.json().success, true);

  // Page gone.
  const got = await fastify.inject({ method: 'GET', url: `/api/pages/${id}` });
  assert.equal(got.statusCode, 404);

  // Panels gone (cascade).
  const panelRes = await pool.query('SELECT COUNT(*)::int AS n FROM page_panels WHERE page_id = $1', [id]);
  assert.equal(panelRes.rows[0].n, 0);

  // Second delete → 404.
  const del2 = await fastify.inject({ method: 'DELETE', url: `/api/pages/${id}` });
  assert.equal(del2.statusCode, 404);
});

// ─── Panels ───────────────────────────────────────────────────────────────────

test('POST /api/pages/:id/panels adds a panel; PATCH updates it; DELETE removes it', async () => {
  const { fastify } = await buildServer();
  const create = await fastify.inject({
    method: 'POST',
    url: '/api/pages',
    payload: { name: 'P' },
  });
  const pageId = create.json().id;

  // Add.
  const add = await fastify.inject({
    method: 'POST',
    url: `/api/pages/${pageId}/panels`,
    payload: { name: 'Main', x: 0, y: 0, w: 100, h: 100, url: 'https://ha.local' },
  });
  assert.equal(add.statusCode, 201);
  const panel = add.json();
  assert.equal(panel.name, 'Main');
  assert.equal(panel.url, 'https://ha.local');
  assert.equal(panel.position, 0);

  // Patch.
  const patch = await fastify.inject({
    method: 'PATCH',
    url: `/api/pages/${pageId}/panels/${panel.id}`,
    payload: { name: 'Renamed', w: 50 },
  });
  assert.equal(patch.statusCode, 200);
  assert.equal(patch.json().name, 'Renamed');
  assert.equal(patch.json().w, 50);
  // Untouched fields preserved.
  assert.equal(patch.json().h, 100);

  // Delete.
  const del = await fastify.inject({
    method: 'DELETE',
    url: `/api/pages/${pageId}/panels/${panel.id}`,
  });
  assert.equal(del.statusCode, 200);
  assert.equal(del.json().success, true);

  // Second delete → 404.
  const del2 = await fastify.inject({
    method: 'DELETE',
    url: `/api/pages/${pageId}/panels/${panel.id}`,
  });
  assert.equal(del2.statusCode, 404);
});

test('POST /api/pages/:id/panels returns 404 when page does not exist', async () => {
  const { fastify } = await buildServer();
  const res = await fastify.inject({
    method: 'POST',
    url: '/api/pages/no-such-page/panels',
    payload: { name: 'X' },
  });
  assert.equal(res.statusCode, 404);
});

test('pages enforce a maximum of five panels on creation and add', async () => {
  const { fastify } = await buildServer();
  const tooMany = await fastify.inject({
    method: 'POST',
    url: '/api/pages',
    payload: { panels: Array.from({ length: 6 }, (_, i) => ({ name: `P${i}` })) },
  });
  assert.equal(tooMany.statusCode, 400);
  assert.match(tooMany.json().error, /at most 5 panels\/WebViews/);

  const create = await fastify.inject({
    method: 'POST',
    url: '/api/pages',
    payload: { panels: Array.from({ length: 5 }, (_, i) => ({ name: `P${i}` })) },
  });
  assert.equal(create.statusCode, 201);
  const add = await fastify.inject({
    method: 'POST',
    url: `/api/pages/${create.json().id}/panels`,
    payload: { name: 'Sixth' },
  });
  assert.equal(add.statusCode, 400);
  assert.match(add.json().error, /at most 5 panels\/WebViews/);
});

test('panels support published scene content and layered presentation fields', async () => {
  const { fastify, pool } = await buildServer();
  await pool.query(
    `INSERT INTO scenes (id, name, revision, manifest_json, status)
     VALUES ('scene-weather', 'Weather', 1, '{}'::jsonb, 'published')`,
  );
  const page = await fastify.inject({ method: 'POST', url: '/api/pages', payload: { name: 'Layered' } });
  const panel = await fastify.inject({
    method: 'POST',
    url: `/api/pages/${page.json().id}/panels`,
    payload: {
      name: 'Weather overlay',
      content_type: 'scene',
      scene_id: 'scene-weather',
      x: 50, y: 0, w: 50, h: 50,
      z_index: 10, opacity: 0.8, visible: true,
    },
  });
  assert.equal(panel.statusCode, 201);
  assert.equal(panel.json().content_type, 'scene');
  assert.equal(panel.json().scene_id, 'scene-weather');
  assert.equal(panel.json().z_index, 10);
  assert.equal(panel.json().opacity, 0.8);
});

test('a device library stores multiple pages while one page is active', async () => {
  const { fastify, pool } = await buildServer();
  await pool.query(
    `INSERT INTO devices (id, name, architecture, status, last_seen)
     VALUES ('library-device', 'Library display', 'arm64', 'connected', now())`,
  );
  const first = (await fastify.inject({ method: 'POST', url: '/api/pages', payload: { name: 'First' } })).json();
  const second = (await fastify.inject({ method: 'POST', url: '/api/pages', payload: { name: 'Second' } })).json();
  for (const page of [first, second]) {
    const assigned = await fastify.inject({
      method: 'PUT',
      url: `/api/pages/${page.id}/assign`,
      payload: { device_id: 'library-device' },
    });
    assert.equal(assigned.statusCode, 200);
  }
  const display = await fastify.inject({
    method: 'POST',
    url: `/api/pages/${second.id}/display`,
    payload: { device_id: 'library-device' },
  });
  assert.equal(display.statusCode, 200);
  const library = await fastify.inject({ method: 'GET', url: '/api/devices/library-device/pages' });
  assert.equal(library.statusCode, 200);
  assert.equal(library.json().pages.length, 2);
  assert.equal(library.json().active_page_id, second.id);
});

test('page back, reload, and device panel changes use confirmed page delivery', async () => {
  const deliveries: Array<{ deviceId: string; pageId: string }> = [];
  const { fastify, pool } = await buildServer({
    onDisplayPage: async (page, deviceId) => {
      deliveries.push({ deviceId, pageId: page.id });
    },
  });
  await pool.query("INSERT INTO devices (id, name) VALUES ('edge-display', 'Edge display')");
  const first = (await fastify.inject({
    method: 'POST',
    url: '/api/pages',
    payload: { name: 'First', panels: [{ name: 'Main', url: 'https://one.example' }] },
  })).json();
  const second = (await fastify.inject({
    method: 'POST',
    url: '/api/pages',
    payload: { name: 'Second', panels: [{ name: 'Main', url: 'https://two.example' }] },
  })).json();
  await fastify.inject({ method: 'POST', url: `/api/pages/${first.id}/display`, payload: { device_id: 'edge-display' } });
  await fastify.inject({ method: 'POST', url: `/api/pages/${second.id}/display`, payload: { device_id: 'edge-display' } });

  const back = await fastify.inject({ method: 'POST', url: '/api/devices/edge-display/page/back' });
  assert.equal(back.statusCode, 200);
  assert.equal(back.json().delivered, true);
  const reload = await fastify.inject({ method: 'POST', url: '/api/devices/edge-display/page/reload' });
  assert.equal(reload.statusCode, 200);
  assert.equal(reload.json().delivered, true);
  const patch = await fastify.inject({
    method: 'PATCH',
    url: `/api/devices/edge-display/panels/${first.panels[0].id}`,
    payload: { content_type: 'url', url: 'https://override.example', visible: false },
  });
  assert.equal(patch.statusCode, 200);
  assert.equal(patch.json().delivered, true);
  const panelReload = await fastify.inject({
    method: 'POST',
    url: `/api/devices/edge-display/panels/${first.panels[0].id}/reload`,
  });
  assert.equal(panelReload.statusCode, 200);
  assert.equal(panelReload.json().delivered, true);
  await pool.query(
    'DELETE FROM device_panel_state WHERE device_id = $1 AND panel_id = $2',
    ['edge-display', first.panels[0].id],
  );
  const commandPanel = await fastify.inject({
    method: 'POST',
    url: '/api/commands/panel',
    payload: {
      device_id: 'edge-display',
      panel: 'Main',
      content_type: 'url',
      url: 'https://command.example',
    },
  });
  assert.equal(commandPanel.statusCode, 200);
  assert.equal(commandPanel.json().delivered, true);
  assert.equal(commandPanel.json().panel_id, first.panels[0].id);
  assert.deepEqual(deliveries.map(item => item.pageId), [
    first.id, second.id, first.id, first.id, first.id, first.id, first.id,
  ]);
});

test('panel geometry and URLs are validated on create, add, and patch', async () => {
  const { fastify } = await buildServer();
  for (const panel of [
    { x: -1 },
    { y: 101 },
    { w: 0 },
    { h: 101 },
    { x: 60, w: 50 },
    { y: 80, h: 21 },
    { url: 'javascript:alert(1)' },
  ]) {
    const result = await fastify.inject({ method: 'POST', url: '/api/pages', payload: { panels: [panel] } });
    assert.equal(result.statusCode, 400, JSON.stringify(panel));
  }

  const create = await fastify.inject({
    method: 'POST',
    url: '/api/pages',
    payload: { panels: [{ x: 10, y: 10, w: 80, h: 80, view_id: 'view-1', url: 'http://example.com' }] },
  });
  assert.equal(create.statusCode, 201);
  assert.equal(create.json().panels[0].view_id, 'view-1');
  const page = create.json();
  const patch = await fastify.inject({
    method: 'PATCH',
    url: `/api/pages/${page.id}/panels/${page.panels[0].id}`,
    payload: { x: 30 },
  });
  assert.equal(patch.statusCode, 400);
  assert.match(patch.json().error, /fit within page bounds/);
});

test('page assignment upserts per device, appears in page results, displays without mutation, and cascades', async () => {
  const { fastify, pool } = await buildServer();
  await pool.query("INSERT INTO devices (id, name) VALUES ('display-1', 'Display 1')");
  const first = await fastify.inject({ method: 'POST', url: '/api/pages', payload: { name: 'First' } });
  const second = await fastify.inject({ method: 'POST', url: '/api/pages', payload: { name: 'Second' } });

  const assign = await fastify.inject({
    method: 'PUT', url: `/api/pages/${first.json().id}/assign`, payload: { device_id: 'display-1' },
  });
  assert.equal(assign.statusCode, 200);
  assert.equal(assign.json().device_id, 'display-1');
  assert.equal(assign.json().page_id, first.json().id);
  assert.equal(assign.json().delivered, false);

  const reassign = await fastify.inject({
    method: 'PUT', url: `/api/pages/${second.json().id}/assign`, payload: { device_id: 'display-1' },
  });
  assert.equal(reassign.statusCode, 200);
  const got = await fastify.inject({ method: 'GET', url: `/api/pages/${second.json().id}` });
  assert.deepEqual(got.json().assigned_device_ids, ['display-1']);
  const list = await fastify.inject({ method: 'GET', url: '/api/pages' });
  assert.deepEqual(list.json().find((page: { id: string }) => page.id === second.json().id).assigned_device_ids, ['display-1']);

  const display = await fastify.inject({
    method: 'POST', url: `/api/pages/${first.json().id}/display`, payload: { device_id: 'display-1' },
  });
  assert.deepEqual(display.json(), { delivered: false });
  const assignment = await pool.query('SELECT page_id FROM device_page_assignments WHERE device_id = $1', ['display-1']);
  assert.equal(assignment.rows[0].page_id, second.json().id);

  await fastify.inject({ method: 'DELETE', url: `/api/pages/${second.json().id}` });
  const afterDelete = await pool.query('SELECT 1 FROM device_page_assignments WHERE device_id = $1', ['display-1']);
  assert.equal(afterDelete.rowCount, 0);
});

test('assignment routes verify page and device and support explicit removal', async () => {
  const { fastify, pool } = await buildServer();
  await pool.query("INSERT INTO devices (id, name) VALUES ('display-1', 'Display 1')");
  const page = await fastify.inject({ method: 'POST', url: '/api/pages', payload: {} });
  const missingDevice = await fastify.inject({
    method: 'PUT', url: `/api/pages/${page.json().id}/assign`, payload: { device_id: 'missing' },
  });
  assert.equal(missingDevice.statusCode, 404);
  await fastify.inject({
    method: 'PUT', url: `/api/pages/${page.json().id}/assign`, payload: { device_id: 'display-1' },
  });
  const remove = await fastify.inject({
    method: 'DELETE', url: `/api/pages/${page.json().id}/assign/display-1`,
  });
  assert.equal(remove.statusCode, 200);
  assert.equal(remove.json().success, true);
});

// ─── Settings ────────────────────────────────────────────────────────────────

test('GET /api/settings returns defaults with redacted secrets', async () => {
  const { fastify } = await buildServer();
  const res = await fastify.inject({ method: 'GET', url: '/api/settings' });
  assert.equal(res.statusCode, 200);
  const settings = res.json();
  assert.equal(settings.device_name, 'Canvas UI Device');
  assert.equal(settings.mqtt_enabled, '0');
  assert.equal(settings.voice_port, '6053');
  // mqtt_password default is '' so it stays empty (not redacted).
  assert.equal(settings.mqtt_password, '');
});

test('MQTT settings expose live status and apply lifecycle callbacks', async () => {
  const changes: string[][] = [];
  let reconnects = 0;
  let disconnects = 0;
  const { fastify } = await buildServer({
    getMqttStatus: () => ({ enabled: true, connected: true, url: 'mqtt://broker' }),
    reconnectMqtt: async () => {
      reconnects += 1;
      return { enabled: true, connected: true, url: 'mqtt://broker' };
    },
    disconnectMqtt: async () => { disconnects += 1; },
    settingsChanged: async keys => { changes.push(keys); },
  });
  const status = await fastify.inject({ method: 'GET', url: '/api/settings/mqtt' });
  assert.equal(status.json().connected, true);
  await fastify.inject({ method: 'PUT', url: '/api/settings', payload: { mqtt_enabled: '1' } });
  assert.deepEqual(changes, [['mqtt_enabled']]);
  await fastify.inject({ method: 'POST', url: '/api/settings/mqtt/reconnect' });
  await fastify.inject({ method: 'POST', url: '/api/settings/mqtt/disconnect' });
  assert.equal(reconnects, 1);
  assert.equal(disconnects, 1);
});

test('PUT /api/settings persists values and redacted placeholder does not overwrite', async () => {
  const { fastify, pool } = await buildServer();

  // First put a real password.
  const put1 = await fastify.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { device_name: 'Display 1', mqtt_password: 'hunter2' },
  });
  assert.equal(put1.statusCode, 200);
  assert.ok(put1.json().updated.includes('device_name'));
  assert.ok(put1.json().updated.includes('mqtt_password'));

  // Verify the raw DB row has the real password.
  const raw = await pool.query("SELECT value FROM settings WHERE key = 'mqtt_password'");
  assert.equal(raw.rows[0].value, 'hunter2');

  // GET redacts it.
  const get = await fastify.inject({ method: 'GET', url: '/api/settings' });
  assert.equal(get.json().mqtt_password, '••••••••');
  assert.equal(get.json().device_name, 'Display 1');

  // PUT with the redacted placeholder must NOT overwrite the real password.
  const put2 = await fastify.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { mqtt_password: '••••••••' },
  });
  assert.equal(put2.statusCode, 200);
  // mqtt_password should NOT be in the updated list (placeholder skipped).
  assert.ok(!put2.json().updated.includes('mqtt_password'));
  const raw2 = await pool.query("SELECT value FROM settings WHERE key = 'mqtt_password'");
  assert.equal(raw2.rows[0].value, 'hunter2');
});

test('PUT /api/settings ignores unknown keys', async () => {
  const { fastify, pool } = await buildServer();
  const put = await fastify.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { device_name: 'X', unknown_key: 'Y' },
  });
  assert.equal(put.statusCode, 200);
  assert.ok(put.json().updated.includes('device_name'));
  assert.ok(!put.json().updated.includes('unknown_key'));
  const raw = await pool.query("SELECT 1 FROM settings WHERE key = 'unknown_key'");
  assert.equal(raw.rowCount, 0);
});

// ─── Audio ───────────────────────────────────────────────────────────────────

test('GET /api/audio/state returns default idle state', async () => {
  resetAudioState();
  const { fastify } = await buildServer();
  const res = await fastify.inject({ method: 'GET', url: '/api/audio/state' });
  assert.equal(res.statusCode, 200);
  const state = res.json();
  assert.equal(state.state, 'idle');
  assert.equal(state.volume, 75);
  assert.equal(state.muted, false);
});

test('POST /api/audio/play sets state to playing; stop returns to idle', async () => {
  resetAudioState();
  const { fastify } = await buildServer();

  const play = await fastify.inject({
    method: 'POST',
    url: '/api/audio/play',
    payload: { url: 'https://example.com/stream.mp3', title: 'Stream', volume: 90 },
  });
  assert.equal(play.statusCode, 200);
  assert.equal(play.json().state, 'playing');
  assert.equal(play.json().url, 'https://example.com/stream.mp3');
  assert.equal(play.json().title, 'Stream');
  assert.equal(play.json().volume, 90);

  const stop = await fastify.inject({ method: 'POST', url: '/api/audio/stop' });
  assert.equal(stop.statusCode, 200);
  assert.equal(stop.json().state, 'idle');
});

test('POST /api/audio/play 400 when url missing; volume clamps to 0-100', async () => {
  resetAudioState();
  const { fastify } = await buildServer();
  const bad = await fastify.inject({
    method: 'POST',
    url: '/api/audio/play',
    payload: { title: 'No URL' },
  });
  assert.equal(bad.statusCode, 400);

  const over = await fastify.inject({
    method: 'POST',
    url: '/api/audio/play',
    payload: { url: 'x', volume: 999 },
  });
  assert.equal(over.json().volume, 100);

  resetAudioState();
  const under = await fastify.inject({
    method: 'POST',
    url: '/api/audio/play',
    payload: { url: 'x', volume: -50 },
  });
  assert.equal(under.json().volume, 0);
});

test('POST /api/audio/pause/resume enforce state transitions', async () => {
  resetAudioState();
  const { fastify } = await buildServer();

  // Pause from idle → 409.
  const pauseIdle = await fastify.inject({ method: 'POST', url: '/api/audio/pause' });
  assert.equal(pauseIdle.statusCode, 409);

  // Resume from idle → 409.
  const resumeIdle = await fastify.inject({ method: 'POST', url: '/api/audio/resume' });
  assert.equal(resumeIdle.statusCode, 409);

  // Play → pause → resume.
  await fastify.inject({
    method: 'POST',
    url: '/api/audio/play',
    payload: { url: 'x' },
  });
  const pause = await fastify.inject({ method: 'POST', url: '/api/audio/pause' });
  assert.equal(pause.statusCode, 200);
  assert.equal(pause.json().state, 'paused');

  const resume = await fastify.inject({ method: 'POST', url: '/api/audio/resume' });
  assert.equal(resume.statusCode, 200);
  assert.equal(resume.json().state, 'playing');
});

test('POST /api/audio/volume and /mute update state', async () => {
  resetAudioState();
  const { fastify } = await buildServer();

  const vol = await fastify.inject({
    method: 'POST',
    url: '/api/audio/volume',
    payload: { level: 42 },
  });
  assert.equal(vol.statusCode, 200);
  assert.equal(vol.json().volume, 42);
  assert.equal(vol.json().muted, false);

  const mute = await fastify.inject({
    method: 'POST',
    url: '/api/audio/mute',
    payload: { muted: true },
  });
  assert.equal(mute.statusCode, 200);
  assert.equal(mute.json().muted, true);

  // Volume 400 → 400 required.
  const noLevel = await fastify.inject({
    method: 'POST',
    url: '/api/audio/volume',
    payload: {},
  });
  assert.equal(noLevel.statusCode, 400);
});

// ─── Commands ─────────────────────────────────────────────────────────────────

test('POST /api/commands/page resolves by id and by name; 404 when missing', async () => {
  resetAudioState();
  const { fastify } = await buildServer();
  const create = await fastify.inject({
    method: 'POST',
    url: '/api/pages',
    payload: { name: 'Welcome' },
  });
  const id = create.json().id;

  const byId = await fastify.inject({
    method: 'POST',
    url: '/api/commands/page',
    payload: { page_id: id },
  });
  assert.equal(byId.statusCode, 200);
  assert.equal(byId.json().page_id, id);
  assert.equal(byId.json().page_name, 'Welcome');

  const byName = await fastify.inject({
    method: 'POST',
    url: '/api/commands/page',
    payload: { page: 'welcome' }, // case-insensitive
  });
  assert.equal(byName.statusCode, 200);
  assert.equal(byName.json().page_id, id);

  const missing = await fastify.inject({
    method: 'POST',
    url: '/api/commands/page',
    payload: { page: 'no-such-page' },
  });
  assert.equal(missing.statusCode, 404);
});

test('POST /api/commands/navigate requires url and resolves panel', async () => {
  const { fastify } = await buildServer();
  const create = await fastify.inject({
    method: 'POST',
    url: '/api/pages',
    payload: { name: 'P', panels: [{ name: 'Main' }] },
  });
  const page = create.json();
  const panelId = page.panels[0].id;

  // Missing url → 400.
  const noUrl = await fastify.inject({
    method: 'POST',
    url: '/api/commands/navigate',
    payload: { panel_id: panelId },
  });
  assert.equal(noUrl.statusCode, 400);

  // By panel_id.
  const ok = await fastify.inject({
    method: 'POST',
    url: '/api/commands/navigate',
    payload: { panel_id: panelId, url: 'https://example.com' },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().panel_id, panelId);
  assert.equal(ok.json().url, 'https://example.com');

  // Unknown panel → 404.
  const missing = await fastify.inject({
    method: 'POST',
    url: '/api/commands/navigate',
    payload: { panel_id: 'no-such-panel', url: 'x' },
  });
  assert.equal(missing.statusCode, 404);
});

test('POST /api/commands/reload, quit, screen_on, screen_off return success', async () => {
  const { fastify } = await buildServer();
  for (const action of ['reload', 'quit', 'screen_on', 'screen_off']) {
    const res = await fastify.inject({ method: 'POST', url: `/api/commands/${action}` });
    assert.equal(res.statusCode, 200, `${action} should be 200`);
    assert.equal(res.json().success, true);
  }
});

// ─── Page push ────────────────────────────────────────────────────────────────

test('POST /api/pages/:id/push records active_page_id and returns pushed_to:1; 404 when missing', async () => {
  const { fastify, pool } = await buildServer();
  const create = await fastify.inject({
    method: 'POST',
    url: '/api/pages',
    payload: { name: 'Push Me' },
  });
  const id = create.json().id;

  const push = await fastify.inject({ method: 'POST', url: `/api/pages/${id}/push` });
  assert.equal(push.statusCode, 200);
  assert.equal(push.json().pushed_to, 1);

  // active_page_id persisted in settings.
  const raw = await pool.query("SELECT value FROM settings WHERE key = 'active_page_id'");
  assert.equal(raw.rows[0].value, id);

  const missing = await fastify.inject({ method: 'POST', url: '/api/pages/no-such/push' });
  assert.equal(missing.statusCode, 404);
});

// ─── Auth gate (when requireAdmin is wired) ───────────────────────────────────

test('mutation routes are gated when requireAdmin is provided', async () => {
  const { fastify, cookies, csrf } = await buildServer({ withAuth: true });

  // Unauthenticated POST → 401.
  const unauth = await fastify.inject({
    method: 'POST',
    url: '/api/pages',
    payload: { name: 'X' },
  });
  assert.equal(unauth.statusCode, 401);

  // Authenticated POST with CSRF → 201.
  const authed = await fastify.inject({
    method: 'POST',
    url: '/api/pages',
    headers: authHeaders(cookies, csrf),
    payload: { name: 'Authed' },
  });
  assert.equal(authed.statusCode, 201);
  assert.equal(authed.json().name, 'Authed');

  // GET is open to viewers (no CSRF needed for reads).
  const list = await fastify.inject({
    method: 'GET',
    url: '/api/pages',
    headers: { cookie: cookies },
  });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().length, 1);
});

// ─── Module-level exports ─────────────────────────────────────────────────────

test('getAudioState / setAudioStateField / resetAudioState round-trip', () => {
  resetAudioState();
  assert.equal(getAudioState().state, 'idle');
  setAudioStateField('state', 'playing');
  setAudioStateField('volume', 50);
  assert.equal(getAudioState().state, 'playing');
  assert.equal(getAudioState().volume, 50);
  resetAudioState();
  assert.equal(getAudioState().volume, 75);
});

test('getConnectedDeviceIds starts empty and broadcast is a no-op', () => {
  assert.deepEqual(getConnectedDeviceIds(), []);
  // Should not throw.
  broadcast({ type: 'ping' }, 'all');
  broadcast({ type: 'ping' }, 'browser');
});
