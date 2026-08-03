/**
 * Tests for the Hermes HTTP API client.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HermesHttpClient, FakeHermesClient, createHermesClient } from '../src/hermes-client.js';
import { mockFetch, jsonResponse } from './helpers.js';

describe('HermesHttpClient', () => {
  test('sendQuery sends POST to /query and returns parsed response', async () => {
    const cannedResponse = {
      intent: 'light_set',
      entities: ['light.kitchen'],
      tool_calls: [{ tool: 'ha.call_service', arguments: { domain: 'light', service: 'turn_on', service_data: { entity_id: 'light.kitchen' } } }],
      clarification_needed: false,
      response: 'Turning on the kitchen light.',
      confidence: 1.0,
    };

    const fetchImpl = mockFetch((url, init) => {
      assert.equal(url, 'http://hermes:8080/query');
      assert.equal(init?.method, 'POST');
      assert.equal((init?.headers as Record<string, string>)?.['content-type'], 'application/json');
      const body = JSON.parse((init?.body as string) ?? '{}');
      assert.equal(body.transcript, 'turn on the kitchen light');
      return jsonResponse(cannedResponse);
    });

    const client = new HermesHttpClient({ baseUrl: 'http://hermes:8080', fetchImpl });
    const result = await client.sendQuery('turn on the kitchen light');
    assert.equal(result.intent, 'light_set');
    assert.deepEqual(result.entities, ['light.kitchen']);
    assert.equal(result.response, 'Turning on the kitchen light.');
  });

  test('sendQuery passes context when provided', async () => {
    const fetchImpl = mockFetch((_url, init) => {
      const body = JSON.parse((init?.body as string) ?? '{}');
      assert.deepEqual(body.context, { room: 'kitchen' });
      return jsonResponse({ intent: 'unknown', entities: [], tool_calls: [], clarification_needed: false, response: 'ok' });
    });

    const client = new HermesHttpClient({ baseUrl: 'http://hermes:8080', fetchImpl });
    await client.sendQuery('test', { room: 'kitchen' });
  });

  test('sendQuery throws on non-200 response', async () => {
    const fetchImpl = mockFetch(() => new Response('Internal Server Error', { status: 500 }));
    const client = new HermesHttpClient({ baseUrl: 'http://hermes:8080', fetchImpl });
    await assert.rejects(() => client.sendQuery('test'), /Hermes HTTP 500/);
  });

  test('healthCheck returns healthy status', async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ healthy: true, version: '1.0.0', uptime_seconds: 3600 }));
    const client = new HermesHttpClient({ baseUrl: 'http://hermes:8080', fetchImpl });
    const status = await client.healthCheck();
    assert.equal(status.healthy, true);
    assert.equal(status.version, '1.0.0');
  });

  test('healthCheck returns unhealthy on HTTP error', async () => {
    const fetchImpl = mockFetch(() => new Response('', { status: 503 }));
    const client = new HermesHttpClient({ baseUrl: 'http://hermes:8080', fetchImpl });
    const status = await client.healthCheck();
    assert.equal(status.healthy, false);
  });

  test('healthCheck returns unhealthy on network error', async () => {
    const fetchImpl = mockFetch(() => { throw new Error('ECONNREFUSED'); });
    const client = new HermesHttpClient({ baseUrl: 'http://hermes:8080', fetchImpl });
    const status = await client.healthCheck();
    assert.equal(status.healthy, false);
    assert.ok(status.detail?.includes('ECONNREFUSED'));
  });
});

describe('FakeHermesClient', () => {
  test('returns canned response', async () => {
    const client = new FakeHermesClient({
      queryResponse: {
        intent: 'light_set',
        entities: ['light.kitchen'],
        tool_calls: [],
        clarification_needed: false,
        response: 'OK',
        confidence: 1.0,
      },
    });
    const result = await client.sendQuery('test');
    assert.equal(result.intent, 'light_set');
  });

  test('throws when shouldFail is true', async () => {
    const client = new FakeHermesClient({ shouldFail: true, failMessage: 'simulated failure' });
    await assert.rejects(() => client.sendQuery('test'), /simulated failure/);
  });

  test('healthCheck returns canned status', async () => {
    const client = new FakeHermesClient({ healthStatus: { healthy: false, detail: 'down' } });
    const status = await client.healthCheck();
    assert.equal(status.healthy, false);
    assert.equal(status.detail, 'down');
  });
});

describe('createHermesClient', () => {
  test('returns null when no URL provided', () => {
    const client = createHermesClient(undefined);
    assert.equal(client, null);
  });

  test('returns HermesHttpClient when URL provided', () => {
    const client = createHermesClient('http://hermes:8080');
    assert.ok(client instanceof HermesHttpClient);
  });
});
