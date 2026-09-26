import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRequest, DEFAULT_REQUEST_ROUTING_POLICY, type RequestClassification } from '../src/request-routing.js';
import type { RouterResult } from '../src/intent-router.js';
import type { LlmProvider } from '../src/providers/llm.js';

const deterministicUnknown: RouterResult = {
  intent: 'unknown', confidence: 0, entities: [], tool_calls: [], clarification_needed: false, response: '',
};

function fakeLlm(reply: string, opts?: { requireDisableThinking?: boolean }): LlmProvider {
  return {
    name: 'test',
    chat: async () => { throw new Error('classifyRequest must not call plain chat() \u2014 it breaks reasoning models'); },
    chatWithTools: async (_messages, _tools, callOpts) => {
      if (opts?.requireDisableThinking && !callOpts?.disableThinking) {
        throw new Error('expected disableThinking: true to be passed');
      }
      return { content: reply, toolCalls: [] };
    },
    healthCheck: async () => ({ name: 'test', healthy: true }),
  };
}

test('classifyRequest uses chatWithTools with disableThinking so reasoning models still return usable JSON', async () => {
  const reply = JSON.stringify({ domain: 'home_automation', intent: 'turn_on_light', confidence: 0.9, needs_clarification: false });
  const llm = fakeLlm(reply, { requireDisableThinking: true });
  const result: RequestClassification = await classifyRequest('turn on the kitchen light', deterministicUnknown, DEFAULT_REQUEST_ROUTING_POLICY, llm);
  assert.equal(result.classifier, 'ai');
  assert.equal(result.domain, 'home_automation');
});

test('classifyRequest falls back cleanly if the AI reply is not valid JSON (e.g. leftover reasoning text)', async () => {
  const llm = fakeLlm('Okay, the user wants me to reply with JSON, let me think...');
  const result = await classifyRequest('turn on the kitchen light', deterministicUnknown, DEFAULT_REQUEST_ROUTING_POLICY, llm);
  assert.equal(result.classifier, 'fallback');
});
