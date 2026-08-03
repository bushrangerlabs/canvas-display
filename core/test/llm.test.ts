import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OpenAiCompatibleLlm,
  DegradedLlm,
} from '../src/providers/llm.js';
import { mockFetch, jsonResponse } from './helpers.js';
import type { FetchImpl } from '../src/providers/llm.js';

test('OpenAiCompatibleLlm.chat returns assistant text from /v1/chat/completions', async () => {
  const fetchImpl: FetchImpl = mockFetch((url) => {
    assert.ok(url.includes('/chat/completions'), 'called chat completions');
    return jsonResponse({
      choices: [{ message: { role: 'assistant', content: 'Hello from the model' } }],
    });
  });
  const llm = new OpenAiCompatibleLlm({ baseUrl: 'http://example/v1', fetchImpl });
  const out = await llm.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(out, 'Hello from the model');
});

test('OpenAiCompatibleLlm.chat throws on non-ok status', async () => {
  const fetchImpl = mockFetch(() => jsonResponse({ error: 'boom' }, 500));
  const llm = new OpenAiCompatibleLlm({ baseUrl: 'http://example/v1', fetchImpl });
  await assert.rejects(() => llm.chat([{ role: 'user', content: 'hi' }]));
});

test('OpenAiCompatibleLlm.analyzeImage sends a multimodal data URL', async () => {
  const fetchImpl: FetchImpl = mockFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: Array<Record<string, any>> }> };
    assert.equal(body.messages[0].content[0].type, 'text');
    assert.equal(body.messages[0].content[1].image_url.url, 'data:image/jpeg;base64,AQID');
    return jsonResponse({ choices: [{ message: { content: 'A driveway is visible.' } }] });
  });
  const llm = new OpenAiCompatibleLlm({ baseUrl: 'http://example/v1', fetchImpl });
  assert.equal(await llm.analyzeImage('What is visible?', 'AQID', 'image/jpeg'), 'A driveway is visible.');
});

test('OpenAiCompatibleLlm.healthCheck reports healthy from /models', async () => {
  const fetchImpl = mockFetch(() => jsonResponse({ object: 'list', data: [] }));
  const llm = new OpenAiCompatibleLlm({ baseUrl: 'http://example/v1', fetchImpl });
  const h = await llm.healthCheck();
  assert.equal(h.healthy, true);
  assert.equal(h.kind, 'OpenAiCompatibleLlm');
});

test('OpenAiCompatibleLlm.healthCheck reports unhealthy on network error', async () => {
  const fetchImpl = (() => Promise.reject(new Error('ECONNREFUSED'))) as FetchImpl;
  const llm = new OpenAiCompatibleLlm({ baseUrl: 'http://example/v1', fetchImpl });
  const h = await llm.healthCheck();
  assert.equal(h.healthy, false);
  assert.match(h.detail ?? '', /ECONNREFUSED/);
});

test('DegradedLlm returns canned deterministic text and is always healthy', async () => {
  const llm = new DegradedLlm({ fallback: 'DEGRADED' });
  const out = await llm.chat([{ role: 'user', content: 'anything' }]);
  assert.equal(out, 'DEGRADED');
  const h = await llm.healthCheck();
  assert.equal(h.healthy, true);
  assert.equal(h.kind, 'DegradedLlm');
});
