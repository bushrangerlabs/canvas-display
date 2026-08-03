import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  HomeAssistantClient,
  type HaWebSocket,
  type HaWebSocketFactory,
  type RawData,
} from '../src/providers/ha.js';
import { mockFetch, jsonResponse } from './helpers.js';
import type { FetchImpl } from '../src/providers/llm.js';

/**
 * A scriptable fake HA WebSocket. It performs the real HA auth handshake:
 *   - emits `auth_required` on open
 *   - when it receives an `auth` message, either emits `auth_ok` (good token) or
 *     `auth_invalid` (bad token)
 *   - after auth, it can be told to deliver a `subscribe_entities` initial dump and
 *     `state_changed` pushes via `pushStates()` / `pushStateChanged()`.
 */
class FakeHaWs extends EventEmitter implements HaWebSocket {
  readonly readyState = 1; // OPEN
  private authenticated = false;
  private sent: unknown[] = [];

  constructor(private readonly tokenOk: boolean) {
    super();
    // HA sends `auth_required` immediately after the socket opens.
    queueMicrotask(() => this.emit('open'));
    queueMicrotask(() => this.emit('message', JSON.stringify({ type: 'auth_required' })));
  }

  send(data: string): void {
    const msg = JSON.parse(data) as { id?: number; type: string; access_token?: string };
    this.sent.push(msg);
    if (msg.type === 'auth') {
      if (this.tokenOk) {
        this.authenticated = true;
        this.emit('message', JSON.stringify({ type: 'auth_ok', ha_version: '2024.1.0' }));
      } else {
        this.emit('message', JSON.stringify({ type: 'auth_invalid', message: 'invalid token' }));
      }
    }
    // Echo subscribe_entities result.
    if (msg.type === 'subscribe_entities') {
      this.emit('message', JSON.stringify({ id: msg.id, type: 'result', success: true, result: null }));
      // Initial full dump for subscribe_entities.
      this.emit('message', JSON.stringify({
        id: msg.id,
        type: 'event',
        event: {
          event_type: 'subscribe_entities',
          a: {
            'light.kitchen': { state: 'on', attributes: { friendly_name: 'Kitchen Light' } },
            'sensor.temp': { state: '21.5', attributes: { friendly_name: 'Temp', unit_of_measurement: '°C' } },
          },
        },
      }));
    }
    const registryResults: Record<string, unknown[]> = {
      'config/area_registry/list': [{ area_id: 'living_room', name: 'Living Room', aliases: ['Lounge'] }],
      'config/device_registry/list': [{ id: 'device-1', name: 'Ceiling Controller', area_id: 'living_room', manufacturer: 'Canvas' }],
      'config/entity_registry/list': [{ entity_id: 'light.living', device_id: 'device-1', platform: 'mqtt' }],
    };
    if (msg.id && registryResults[msg.type]) {
      this.emit('message', JSON.stringify({ id: msg.id, type: 'result', success: true, result: registryResults[msg.type] }));
    }
  }

  /** Simulate HA pushing a state_changed event. */
  pushStateChanged(entityId: string, state: string, attributes: Record<string, unknown> = {}): void {
    if (!this.authenticated) throw new Error('not authenticated');
    this.emit('message', JSON.stringify({
      id: 1,
      type: 'event',
      event: {
        event_type: 'state_changed',
        a: { entity_id: entityId, old_state: null },
        d: { entity_id: entityId, state, attributes },
      },
    }));
  }

  close(): void {
    this.emit('close', 1000, 'test');
  }

  get lastSent(): unknown[] {
    return this.sent;
  }
}

function makeWsFactory(tokenOk: boolean): HaWebSocketFactory {
  return (() => new FakeHaWs(tokenOk) as unknown as HaWebSocket) as HaWebSocketFactory;
}

const SAMPLE_STATES = [
  { entity_id: 'light.kitchen', state: 'on', attributes: { friendly_name: 'Kitchen Light' } },
  { entity_id: 'sensor.temp', state: '21.5', attributes: { friendly_name: 'Temp' } },
];

test('HA client authenticates over WS and populates entity cache from subscribe_entities', async () => {
  const ha = new HomeAssistantClient({
    baseUrl: 'http://ha',
    token: 'good-token',
    wsFactory: makeWsFactory(true),
    fetchImpl: mockFetch(() => jsonResponse(SAMPLE_STATES)),
    autoReconnect: false,
  });
  await ha.connect();
  assert.equal(ha.isConnected(), true);
  const entities = ha.getEntities();
  assert.equal(entities.length, 2);
  const kitchen = ha.getEntity('light.kitchen');
  assert.ok(kitchen);
  assert.equal(kitchen.state, 'on');
  assert.equal(kitchen.attributes.friendly_name, 'Kitchen Light');
});

test('HA client receives state_changed pushes into the cache', async () => {
  const ws = new FakeHaWs(true);
  const ha = new HomeAssistantClient({
    baseUrl: 'http://ha',
    token: 'good-token',
    wsFactory: (() => ws as unknown as HaWebSocket) as HaWebSocketFactory,
    fetchImpl: mockFetch(() => jsonResponse([])),
    autoReconnect: false,
  });
  await ha.connect();
  ws.pushStateChanged('light.living', 'off', { friendly_name: 'Living Light' });
  const living = ha.getEntity('light.living');
  assert.ok(living);
  assert.equal(living.state, 'off');
  assert.equal(living.attributes.friendly_name, 'Living Light');
});

test('HA client reports unhealthy and surfaces auth_invalid on bad token', async () => {
  const ha = new HomeAssistantClient({
    baseUrl: 'http://ha',
    token: 'bad-token',
    wsFactory: makeWsFactory(false),
    fetchImpl: mockFetch((url) => {
      // After auth failure the client is not connected, so healthCheck probes
      // REST /api/config — make that fail to exercise the unhealthy path.
      if (url.includes('/api/config')) return new Response('unauthorized', { status: 401 });
      return jsonResponse({});
    }),
    autoReconnect: false,
  });
  await assert.rejects(() => ha.connect(), /auth invalid/i);
  assert.equal(ha.isConnected(), false);
  const h = await ha.healthCheck();
  assert.equal(h.healthy, false);
});

test('HA client callService posts to the correct REST path with the token and merges results', async () => {
  let capturedUrl = '';
  let capturedAuth = '';
  let capturedBody = '';
  const fetchImpl: FetchImpl = mockFetch((url, init) => {
    capturedUrl = url;
    capturedAuth = (init?.headers as Record<string, string> | undefined)?.authorization ?? '';
    capturedBody = (init?.body as string) ?? '';
    return jsonResponse([
      { entity_id: 'light.kitchen', state: 'on', attributes: { friendly_name: 'Kitchen Light' } },
    ]);
  });
  const ha = new HomeAssistantClient({
    baseUrl: 'http://ha',
    token: 'good-token',
    wsFactory: makeWsFactory(true),
    fetchImpl,
    autoReconnect: false,
  });
  await ha.connect();
  const affected = await ha.callService('light', 'turn_on', { entity_id: 'light.kitchen' });
  assert.equal(capturedUrl, 'http://ha/api/services/light/turn_on');
  assert.equal(capturedAuth, 'Bearer good-token');
  assert.equal(capturedBody, JSON.stringify({ entity_id: 'light.kitchen' }));
  assert.equal(affected.length, 1);
  assert.equal(ha.getEntity('light.kitchen')?.state, 'on');
});

test('HA client getEntitySummaries adds domain and friendlyName', async () => {
  const ha = new HomeAssistantClient({
    baseUrl: 'http://ha',
    token: 'good-token',
    wsFactory: makeWsFactory(true),
    fetchImpl: mockFetch(() => jsonResponse(SAMPLE_STATES)),
    autoReconnect: false,
  });
  await ha.connect();
  const summaries = ha.getEntitySummaries();
  const kitchen = summaries.find((s) => s.entityId === 'light.kitchen');
  assert.ok(kitchen);
  assert.equal(kitchen.domain, 'light');
  assert.equal(kitchen.friendlyName, 'Kitchen Light');
});

test('HA client fetches and normalizes area, device and entity registries', async () => {
  const ha = new HomeAssistantClient({
    baseUrl: 'http://ha', token: 'good-token', wsFactory: makeWsFactory(true),
    fetchImpl: mockFetch(() => jsonResponse(SAMPLE_STATES)), autoReconnect: false,
  });
  await ha.connect();
  const snapshot = await ha.refreshRegistries();
  assert.deepEqual(snapshot.areas[0], { areaId: 'living_room', name: 'Living Room', aliases: ['Lounge'], floorId: undefined });
  assert.equal(snapshot.devices[0]?.deviceId, 'device-1');
  assert.equal(snapshot.devices[0]?.areaId, 'living_room');
  assert.equal(snapshot.entities[0]?.entityId, 'light.living');
  assert.equal(snapshot.entities[0]?.deviceId, 'device-1');
});

test('HA client healthCheck reports reachable via REST /api/config when WS not subscribed', async () => {
  const ha = new HomeAssistantClient({
    baseUrl: 'http://ha',
    token: 'good-token',
    // No WS connection attempted; healthCheck probes REST /api/config.
    fetchImpl: mockFetch((url) => {
      if (url.includes('/api/config')) return jsonResponse({ version: '2024.1.0' });
      return jsonResponse([]);
    }),
    autoReconnect: false,
  });
  const h = await ha.healthCheck();
  assert.equal(h.healthy, true);
  assert.match(h.detail ?? '', /reachable/);
});

test('HA client healthCheck reports unhealthy when REST probe fails', async () => {
  const ha = new HomeAssistantClient({
    baseUrl: 'http://ha',
    token: 'good-token',
    fetchImpl: mockFetch(() => {
      throw new Error('ECONNREFUSED');
    }),
    autoReconnect: false,
  });
  const h = await ha.healthCheck();
  assert.equal(h.healthy, false);
  assert.match(h.detail ?? '', /ECONNREFUSED/);
});
