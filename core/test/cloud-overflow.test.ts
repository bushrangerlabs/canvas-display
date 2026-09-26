import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIntelligence } from '../src/intelligence.js';
import { AiProviderRegistry } from '../src/providers/registry.js';
import type { LlmProvider } from '../src/providers/llm.js';
import type { CoreConfig } from '../src/config.js';

const baseConfig: CoreConfig = {
  port: 3100,
  host: '0.0.0.0',
  databaseUrl: 'postgresql://x',
  gatewayPath: '/gateway/v1',
  logLevel: 'info',
};

function fakeLlm(name: string, reply: string): LlmProvider {
  return {
    name,
    chat: async () => reply,
    chatWithTools: async () => ({ content: reply, toolCalls: [] }),
    healthCheck: async () => ({ name, healthy: true }),
  };
}

// Regression guard: voice must always stay on the 'conversation'-assigned provider,
// even when other (e.g. cloud) providers exist in the registry. Cloud access is only
// ever reachable via the separate AI Chat UI and HTML widget AI builder, never voice.
test('voice pipeline never uses any provider other than the one assigned to conversation', async () => {
  const local = fakeLlm('local', 'LOCAL REPLY');
  const other = fakeLlm('other', 'OTHER REPLY');
  const registry = new AiProviderRegistry({
    providers: [
      { id: 'local', type: 'llm', kind: 'llama-cpp', config: {}, instance: local },
      { id: 'other', type: 'llm', kind: 'openai', config: {}, instance: other },
    ],
    assignments: { conversation: 'local' },
  });
  const intel = createIntelligence(baseConfig, { registry, loadRegistryFromEnv: false });

  const result = await intel.runIntelligentPipeline({ transcript: 'What is the capital of France?', skipTts: true });
  assert.equal(result.reply, 'LOCAL REPLY');
});

test('voice pipeline stays local for HA/MCP tool requests regardless of other registered providers', async () => {
  const local = fakeLlm('local', 'LOCAL REPLY');
  const other = fakeLlm('other', 'OTHER REPLY');
  const registry = new AiProviderRegistry({
    providers: [
      { id: 'local', type: 'llm', kind: 'llama-cpp', config: {}, instance: local },
      { id: 'other', type: 'llm', kind: 'openai', config: {}, instance: other },
    ],
    assignments: { conversation: 'local' },
  });
  const intel = createIntelligence(baseConfig, { registry, loadRegistryFromEnv: false });
  intel.toolRegistry.register({
    name: 'mcp.ha-mcp.turn_on_light',
    description: 'Turn on a light',
    schema: { type: 'object', properties: {} },
    requiredRole: 'voice',
    requiresConfirmation: false,
    executor: async () => ({ ok: true, message: 'done' }),
  });

  const result = await intel.runIntelligentPipeline({ transcript: 'turn on the light please and do stuff', skipTts: true });
  assert.notEqual(result.reply, 'OTHER REPLY');
});
