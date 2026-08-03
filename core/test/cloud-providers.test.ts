/**
 * Tests for the cloud LLM provider adapters (D-010 extension).
 *
 * Each test mocks `fetch` and verifies:
 *   - The correct URL is called.
 *   - The correct headers are sent (auth, provider-specific).
 *   - The request body has the right shape for the provider's API.
 *   - The response is parsed correctly into assistant text.
 *   - Health check probes the right endpoint.
 *
 * No real network is used — `fetch` is fully mocked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiLlm } from '../src/providers/cloud/openai.js';
import { OpenRouterLlm } from '../src/providers/cloud/openrouter.js';
import { AnthropicLlm } from '../src/providers/cloud/anthropic.js';
import { GeminiLlm } from '../src/providers/cloud/gemini.js';
import { GroqLlm } from '../src/providers/cloud/groq.js';
import { AzureOpenAiLlm } from '../src/providers/cloud/azure.js';
import { mockFetch, jsonResponse } from './helpers.js';
import type { FetchImpl } from '../src/providers/llm.js';

// ─── OpenAI ────────────────────────────────────────────────────────────────

test('OpenAiLlm.chat posts to /v1/chat/completions with Bearer auth', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const fetchImpl: FetchImpl = mockFetch((url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({ choices: [{ message: { content: 'Hello from OpenAI' } }] });
  });
  const llm = new OpenAiLlm({ apiKey: 'sk-test', model: 'gpt-4o', fetchImpl });
  const out = await llm.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(out, 'Hello from OpenAI');
  assert.ok(capturedUrl.endsWith('/v1/chat/completions'));
  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer sk-test');
  const body = JSON.parse(capturedInit?.body as string);
  assert.equal(body.model, 'gpt-4o');
  assert.equal(body.messages[0].content, 'hi');
});

test('OpenAiLlm.chat throws on non-ok status', async () => {
  const fetchImpl: FetchImpl = mockFetch(() => jsonResponse({ error: 'rate limited' }, 429));
  const llm = new OpenAiLlm({ apiKey: 'sk', model: 'gpt-4o', fetchImpl });
  await assert.rejects(() => llm.chat([{ role: 'user', content: 'hi' }]), /OpenAI 429/);
});

test('OpenAiLlm.healthCheck probes /v1/models', async () => {
  let capturedUrl = '';
  const fetchImpl: FetchImpl = mockFetch((url) => {
    capturedUrl = url;
    return jsonResponse({ object: 'list', data: [] });
  });
  const llm = new OpenAiLlm({ apiKey: 'sk', model: 'gpt-4o', fetchImpl });
  const h = await llm.healthCheck();
  assert.equal(h.healthy, true);
  assert.equal(h.kind, 'OpenAiLlm');
  assert.ok(capturedUrl.endsWith('/v1/models'));
});

// ─── OpenRouter ────────────────────────────────────────────────────────────

test('OpenRouterLlm.chat sends HTTP-Referer and X-Title headers', async () => {
  let capturedInit: RequestInit | undefined;
  const fetchImpl: FetchImpl = mockFetch((_url, init) => {
    capturedInit = init;
    return jsonResponse({ choices: [{ message: { content: 'from openrouter' } }] });
  });
  const llm = new OpenRouterLlm({
    apiKey: 'sk-or-test',
    model: 'anthropic/claude-3.5-sonnet',
    referer: 'https://canvas.example.com',
    title: 'Canvas Display',
    fetchImpl,
  });
  const out = await llm.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(out, 'from openrouter');
  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer sk-or-test');
  assert.equal(headers['HTTP-Referer'], 'https://canvas.example.com');
  assert.equal(headers['X-Title'], 'Canvas Display');
  const body = JSON.parse(capturedInit?.body as string);
  assert.equal(body.model, 'anthropic/claude-3.5-sonnet');
});

test('OpenRouterLlm.chat works without referer/title headers', async () => {
  const fetchImpl: FetchImpl = mockFetch(() => jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
  const llm = new OpenRouterLlm({ apiKey: 'sk-or', model: 'x/y', fetchImpl });
  const out = await llm.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(out, 'ok');
});

// ─── Anthropic ─────────────────────────────────────────────────────────────

test('AnthropicLlm.chat hoists system messages into the system field', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const fetchImpl: FetchImpl = mockFetch((url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({ content: [{ type: 'text', text: 'from claude' }] });
  });
  const llm = new AnthropicLlm({ apiKey: 'sk-ant', model: 'claude-3-5-sonnet-20241022', fetchImpl });
  const out = await llm.chat([
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'hi' },
  ]);
  assert.equal(out, 'from claude');
  assert.ok(capturedUrl.endsWith('/v1/messages'));
  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers['x-api-key'], 'sk-ant');
  assert.equal(headers['anthropic-version'], '2023-06-01');
  const body = JSON.parse(capturedInit?.body as string);
  assert.equal(body.model, 'claude-3-5-sonnet-20241022');
  assert.equal(body.system, 'You are helpful.');
  // System message must NOT appear in the messages array.
  assert.equal(body.messages.find((m: { role: string }) => m.role === 'system'), undefined);
  assert.equal(body.messages[0].role, 'user');
  assert.equal(body.max_tokens, 1024);
});

test('AnthropicLlm.chat throws when response has no text block', async () => {
  const fetchImpl: FetchImpl = mockFetch(() => jsonResponse({ content: [{ type: 'tool_use' }] }));
  const llm = new AnthropicLlm({ apiKey: 'sk-ant', model: 'claude', fetchImpl });
  await assert.rejects(() => llm.chat([{ role: 'user', content: 'hi' }]), /content\[\]\.text/);
});

test('AnthropicLlm.healthCheck posts a 1-token probe to /v1/messages', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const fetchImpl: FetchImpl = mockFetch((url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({ content: [{ type: 'text', text: 'x' }] });
  });
  const llm = new AnthropicLlm({ apiKey: 'sk-ant', model: 'claude', fetchImpl });
  const h = await llm.healthCheck();
  assert.equal(h.healthy, true);
  assert.ok(capturedUrl.endsWith('/v1/messages'));
  const body = JSON.parse(capturedInit?.body as string);
  assert.equal(body.max_tokens, 1);
});

// ─── Gemini ────────────────────────────────────────────────────────────────

test('GeminiLlm.chat posts to generateContent with key in query string', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const fetchImpl: FetchImpl = mockFetch((url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({
      candidates: [{ content: { parts: [{ text: 'from gemini' }] } }],
    });
  });
  const llm = new GeminiLlm({ apiKey: 'AIzaX', model: 'gemini-1.5-pro', fetchImpl });
  const out = await llm.chat([
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'bye' },
  ]);
  assert.equal(out, 'from gemini');
  // URL contains the model and the API key.
  assert.ok(capturedUrl.includes('/models/gemini-1.5-pro:generateContent'), `got ${capturedUrl}`);
  assert.ok(capturedUrl.includes('key=AIzaX'));
  const body = JSON.parse(capturedInit?.body as string);
  // System message hoisted into systemInstruction.
  assert.ok(body.systemInstruction);
  // Assistant role mapped to "model".
  assert.equal(body.contents[0].role, 'user');
  assert.equal(body.contents[1].role, 'model');
  assert.equal(body.contents[2].role, 'user');
});

test('GeminiLlm.chat throws when response has no candidates', async () => {
  const fetchImpl: FetchImpl = mockFetch(() => jsonResponse({}));
  const llm = new GeminiLlm({ apiKey: 'AIzaX', model: 'gemini-1.5-pro', fetchImpl });
  await assert.rejects(() => llm.chat([{ role: 'user', content: 'hi' }]), /candidates/);
});

test('GeminiLlm.healthCheck probes /models with key in query', async () => {
  let capturedUrl = '';
  const fetchImpl: FetchImpl = mockFetch((url) => {
    capturedUrl = url;
    return jsonResponse({ models: [] });
  });
  const llm = new GeminiLlm({ apiKey: 'AIzaX', model: 'gemini-1.5-pro', fetchImpl });
  const h = await llm.healthCheck();
  assert.equal(h.healthy, true);
  assert.ok(capturedUrl.includes('/models'));
  assert.ok(capturedUrl.includes('key=AIzaX'));
});

// ─── Groq ──────────────────────────────────────────────────────────────────

test('GroqLlm.chat posts to /openai/v1/chat/completions with Bearer auth', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const fetchImpl: FetchImpl = mockFetch((url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({ choices: [{ message: { content: 'from groq' } }] });
  });
  const llm = new GroqLlm({ apiKey: 'gsk_test', model: 'llama-3.3-70b-versatile', fetchImpl });
  const out = await llm.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(out, 'from groq');
  assert.ok(capturedUrl.includes('api.groq.com/openai/v1/chat/completions'));
  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer gsk_test');
  const body = JSON.parse(capturedInit?.body as string);
  assert.equal(body.model, 'llama-3.3-70b-versatile');
});

test('GroqLlm.healthCheck probes /openai/v1/models', async () => {
  let capturedUrl = '';
  const fetchImpl: FetchImpl = mockFetch((url) => {
    capturedUrl = url;
    return jsonResponse({ data: [] });
  });
  const llm = new GroqLlm({ apiKey: 'gsk', model: 'x', fetchImpl });
  const h = await llm.healthCheck();
  assert.equal(h.healthy, true);
  assert.ok(capturedUrl.includes('api.groq.com/openai/v1/models'));
});

// ─── Azure OpenAI ──────────────────────────────────────────────────────────

test('AzureOpenAiLlm.chat posts to /openai/deployments/{deployment}/chat/completions with api-key header', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const fetchImpl: FetchImpl = mockFetch((url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({ choices: [{ message: { content: 'from azure' } }] });
  });
  const llm = new AzureOpenAiLlm({
    apiKey: 'az-key',
    resource: 'my-org-openai',
    deployment: 'gpt-4o-deploy',
    fetchImpl,
  });
  const out = await llm.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(out, 'from azure');
  assert.ok(capturedUrl.includes('my-org-openai.cognitiveservices.azure.com'), `got ${capturedUrl}`);
  assert.ok(capturedUrl.includes('/openai/deployments/gpt-4o-deploy/chat/completions'));
  assert.ok(capturedUrl.includes('api-version='));
  const headers = capturedInit?.headers as Record<string, string>;
  // Azure uses api-key header, NOT Authorization Bearer.
  assert.equal(headers['api-key'], 'az-key');
  assert.equal(headers.authorization, undefined);
});

test('AzureOpenAiLlm.healthCheck posts a 1-token probe', async () => {
  let capturedInit: RequestInit | undefined;
  const fetchImpl: FetchImpl = mockFetch((_url, init) => {
    capturedInit = init;
    return jsonResponse({ choices: [{ message: { content: 'x' } }] });
  });
  const llm = new AzureOpenAiLlm({
    apiKey: 'az-key',
    resource: 'my-org',
    deployment: 'gpt-4o-deploy',
    fetchImpl,
  });
  const h = await llm.healthCheck();
  assert.equal(h.healthy, true);
  assert.equal(h.kind, 'AzureOpenAiLlm');
  const body = JSON.parse(capturedInit?.body as string);
  assert.equal(body.max_tokens, 1);
});

test('AzureOpenAiLlm supports custom baseUrl with {resource} placeholder', async () => {
  let capturedUrl = '';
  const fetchImpl: FetchImpl = mockFetch((url) => {
    capturedUrl = url;
    return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
  });
  const llm = new AzureOpenAiLlm({
    apiKey: 'k',
    resource: 'myorg',
    deployment: 'd',
    baseUrl: 'https://{resource}.example.com/openai',
    fetchImpl,
  });
  await llm.chat([{ role: 'user', content: 'hi' }]);
  assert.ok(capturedUrl.startsWith('https://myorg.example.com/openai/'), `got ${capturedUrl}`);
});

// ─── Cross-cutting: all cloud adapters implement LlmProvider ──────────────

test('All cloud adapters expose chat() and healthCheck() returning HealthStatus', async () => {
  const fetchImpl: FetchImpl = mockFetch(() => jsonResponse({
    choices: [{ message: { content: 'ok' } }],
    content: [{ type: 'text', text: 'ok' }],
    candidates: [{ content: { parts: [{ text: 'ok' }] } }],
  }));
  const adapters = [
    new OpenAiLlm({ apiKey: 'k', model: 'm', fetchImpl }),
    new OpenRouterLlm({ apiKey: 'k', model: 'm', fetchImpl }),
    new AnthropicLlm({ apiKey: 'k', model: 'm', fetchImpl }),
    new GeminiLlm({ apiKey: 'k', model: 'm', fetchImpl }),
    new GroqLlm({ apiKey: 'k', model: 'm', fetchImpl }),
    new AzureOpenAiLlm({ apiKey: 'k', resource: 'r', deployment: 'd', fetchImpl }),
  ];
  for (const a of adapters) {
    const reply = await a.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(reply, 'ok');
    const h = await a.healthCheck();
    assert.equal(typeof h.healthy, 'boolean');
    assert.equal(typeof h.kind, 'string');
  }
});
