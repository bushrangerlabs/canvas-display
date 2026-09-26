/**
 * Some models (e.g. Salesforce xLAM) emit function calls as a plain JSON array
 * in message content (`[{"name": "...", "arguments": {...}}]`) rather than the
 * OpenAI `tool_calls` field. OpenAiCompatibleLlm.chatWithTools() must detect and
 * normalize that shape so callers get a consistent ChatWithToolsResult regardless
 * of which native tool-call format the underlying model uses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiCompatibleLlm, type ToolDefinition } from '../src/providers/llm.js';
import { mockFetch, jsonResponse } from './helpers.js';
import type { FetchImpl } from '../src/providers/llm.js';

const tools: ToolDefinition[] = [{
  type: 'function',
  function: { name: 'ha_call_service', description: 'x', parameters: { type: 'object', properties: {} } },
}];

test('parses a JSON-array-in-content tool call (xLAM native format) into toolCalls', async () => {
  const fetchImpl: FetchImpl = mockFetch(() => jsonResponse({
    choices: [{ message: {
      content: '[{"name": "ha_call_service", "arguments": {"domain": "light", "service": "turn_on", "entity_id": "light.kitchen_light"}}]',
    } }],
  }));
  const llm = new OpenAiCompatibleLlm({ baseUrl: 'http://x/v1', fetchImpl });
  const result = await llm.chatWithTools([{ role: 'user', content: 'turn on the kitchen light' }], tools);
  assert.equal(result.content, '');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'ha_call_service');
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), {
    domain: 'light', service: 'turn_on', entity_id: 'light.kitchen_light',
  });
});

test('leaves normal structured tool_calls untouched when the model already emits them', async () => {
  const fetchImpl: FetchImpl = mockFetch(() => jsonResponse({
    choices: [{ message: {
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'ha_call_service', arguments: '{"domain":"light"}' } }],
    } }],
  }));
  const llm = new OpenAiCompatibleLlm({ baseUrl: 'http://x/v1', fetchImpl });
  const result = await llm.chatWithTools([{ role: 'user', content: 'hi' }], tools);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].id, 'call_1');
});

test('does not misinterpret plain conversational content as tool calls', async () => {
  const fetchImpl: FetchImpl = mockFetch(() => jsonResponse({
    choices: [{ message: { content: 'The kitchen light is currently off.' } }],
  }));
  const llm = new OpenAiCompatibleLlm({ baseUrl: 'http://x/v1', fetchImpl });
  const result = await llm.chatWithTools([{ role: 'user', content: 'is the kitchen light on?' }], tools);
  assert.equal(result.content, 'The kitchen light is currently off.');
  assert.equal(result.toolCalls.length, 0);
});

test('does not misinterpret a JSON array that is not a tool-call shape', async () => {
  const fetchImpl: FetchImpl = mockFetch(() => jsonResponse({
    choices: [{ message: { content: '[1, 2, 3]' } }],
  }));
  const llm = new OpenAiCompatibleLlm({ baseUrl: 'http://x/v1', fetchImpl });
  const result = await llm.chatWithTools([{ role: 'user', content: 'list some numbers' }], tools);
  assert.equal(result.content, '[1, 2, 3]');
  assert.equal(result.toolCalls.length, 0);
});

test('does not apply the content fallback when no tools were offered', async () => {
  const fetchImpl: FetchImpl = mockFetch(() => jsonResponse({
    choices: [{ message: { content: '[{"name": "x", "arguments": {}}]' } }],
  }));
  const llm = new OpenAiCompatibleLlm({ baseUrl: 'http://x/v1', fetchImpl });
  const result = await llm.chatWithTools([{ role: 'user', content: 'hi' }], []);
  assert.equal(result.toolCalls.length, 0);
  assert.equal(result.content, '[{"name": "x", "arguments": {}}]');
});
