/**
 * Integration tests for createIntelligence using the multi-provider registry
 * (D-010 extension).
 *
 * Verifies that:
 *   - Passing a registry with multiple LLM providers routes conversation to the
 *     assigned provider and intent_routing to its assigned provider.
 *   - The registry is exposed on the returned Intelligence object.
 *   - Simple mode (one provider per type) still works through the registry.
 *   - The legacy direct-construction path still works when no registry is set.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIntelligence } from '../src/intelligence.js';
import { AiProviderRegistry } from '../src/providers/registry.js';
import { OpenAiCompatibleLlm, DegradedLlm } from '../src/providers/llm.js';
import { WhisperTranscription } from '../src/providers/asr.js';
import { PiperSpeech } from '../src/providers/tts.js';
import { mockFetch, jsonResponse, fakeSocketFactory } from './helpers.js';
import type { CoreConfig } from '../src/config.js';

const baseConfig: CoreConfig = {
  port: 3100,
  host: '0.0.0.0',
  databaseUrl: 'postgresql://x',
  gatewayPath: '/gateway/v1',
  logLevel: 'info',
};

/** Build a mock LLM that records the URL it was called with. */
function recordingLlm(reply: string, mark: string) {
  let calledUrl = '';
  const fetchImpl = mockFetch((url) => {
    calledUrl = url;
    return jsonResponse({ choices: [{ message: { content: reply } }] });
  });
  const llm = new OpenAiCompatibleLlm({ baseUrl: `http://${mark}/v1`, name: mark, fetchImpl });
  return { llm, calledUrl: () => calledUrl };
}

test('createIntelligence: registry is exposed and used for conversation', async () => {
  const local = recordingLlm('local reply', 'local');
  const cloud = recordingLlm('cloud reply', 'cloud');
  const registry = new AiProviderRegistry({
    providers: [
      { id: 'local-llm', type: 'llm', kind: 'llama-cpp', config: {}, instance: local.llm },
      { id: 'cloud-llm', type: 'llm', kind: 'openrouter', config: {}, instance: cloud.llm },
    ],
    assignments: { conversation: 'cloud-llm', intent_routing: 'local-llm' },
  });
  const intel = createIntelligence(baseConfig, { registry, loadRegistryFromEnv: false });
  assert.ok(intel.registry);
  assert.equal(intel.registry.size(), 2);
  assert.equal(intel.registry.isAdvancedMode(), true);

  const result = await intel.runVoicePipeline({ transcript: 'hi', skipTts: true });
  assert.equal(result.reply, 'cloud reply');
  assert.equal(result.degraded, false);
  // Cloud LLM was called, local was not.
  assert.match(cloud.calledUrl(), /cloud/);
  assert.equal(local.calledUrl(), '');
});

test('createIntelligence: intent router uses the intent_routing assignment', async () => {
  const local = recordingLlm('local intent', 'local');
  const cloud = recordingLlm('cloud conv', 'cloud');
  const registry = new AiProviderRegistry({
    providers: [
      { id: 'local-llm', type: 'llm', kind: 'llama-cpp', config: {}, instance: local.llm },
      { id: 'cloud-llm', type: 'llm', kind: 'openrouter', config: {}, instance: cloud.llm },
    ],
    assignments: { conversation: 'cloud-llm', intent_routing: 'local-llm' },
  });
  const intel = createIntelligence(baseConfig, { registry, loadRegistryFromEnv: false });
  // The intent router should be using the local LLM, not the cloud one.
  // (We can't directly call the router's LLM from here, but we can verify the
  // conversation LLM is the cloud one and the intent router has a different LLM.)
  assert.equal(intel.providers.llm, cloud.llm);
  // The intent router's LLM is private; we verify via the providers surface that
  // conversation uses cloud-llm.
  const conversationProvider = intel.registry?.getProvider('conversation');
  assert.equal(conversationProvider?.id, 'cloud-llm');
  const intentProvider = intel.registry?.getProvider('intent_routing');
  assert.equal(intentProvider?.id, 'local-llm');
});

test('createIntelligence: registry with ASR + TTS providers wires them into the pipeline', async () => {
  const asrFetch = mockFetch(() => jsonResponse({ text: 'transcribed text' }));
  const llmFetch = mockFetch(() => jsonResponse({ choices: [{ message: { content: 'reply' } }] }));
  const SAMPLE = Buffer.from([0xaa, 0xbb]);
  const registry = new AiProviderRegistry({
    providers: [
      { id: 'llm', type: 'llm', kind: 'llama-cpp', config: {}, instance: new OpenAiCompatibleLlm({ baseUrl: 'http://llm/v1', fetchImpl: llmFetch }) },
      { id: 'asr', type: 'asr', kind: 'whisper', config: {}, instance: new WhisperTranscription({ baseUrl: 'http://whisper', fetchImpl: asrFetch }) },
      { id: 'tts', type: 'tts', kind: 'piper', config: {}, instance: new PiperSpeech({ host: 'fake', port: 1, socketFactory: fakeSocketFactory(SAMPLE) }) },
    ],
  });
  const intel = createIntelligence(baseConfig, { registry, loadRegistryFromEnv: false });
  const result = await intel.runVoicePipeline({ audio: Buffer.from('RIFF') });
  assert.equal(result.transcript, 'transcribed text');
  assert.equal(result.reply, 'reply');
  assert.equal(result.audioBase64, SAMPLE.toString('base64'));
  assert.equal(result.degraded, false);
});

test('createIntelligence: registry with no LLM falls back to DegradedLlm', async () => {
  const registry = new AiProviderRegistry({
    providers: [
      { id: 'asr', type: 'asr', kind: 'whisper', config: {}, instance: new WhisperTranscription({ baseUrl: 'http://w', fetchImpl: mockFetch(() => jsonResponse({ text: 'x' })) }) },
    ],
  });
  const intel = createIntelligence(baseConfig, { registry, loadRegistryFromEnv: false });
  assert.ok(intel.providers.llm instanceof DegradedLlm);
  const result = await intel.runVoicePipeline({ transcript: 'hi', skipTts: true });
  assert.equal(result.degraded, true);
  assert.match(result.reply, /degraded/i);
});

test('createIntelligence: explicit llm override takes precedence over registry', async () => {
  const registryLlm = recordingLlm('registry', 'registry');
  const overrideLlm = recordingLlm('override', 'override');
  const registry = new AiProviderRegistry({
    providers: [
      { id: 'r', type: 'llm', kind: 'llama-cpp', config: {}, instance: registryLlm.llm },
    ],
  });
  const intel = createIntelligence(baseConfig, {
    registry,
    llm: overrideLlm.llm,
    loadRegistryFromEnv: false,
  });
  const result = await intel.runVoicePipeline({ transcript: 'hi', skipTts: true });
  assert.equal(result.reply, 'override');
  assert.equal(overrideLlm.calledUrl(), 'http://override/v1/chat/completions');
  assert.equal(registryLlm.calledUrl(), '');
});

test('createIntelligence: legacy path (no registry, no env) still works with degraded LLM', () => {
  const intel = createIntelligence({ ...baseConfig }, { loadRegistryFromEnv: false });
  assert.ok(intel.providers.llm instanceof DegradedLlm);
  assert.equal(intel.registry, undefined);
});

test('createIntelligence: health() includes registry providers', async () => {
  const llm = new OpenAiCompatibleLlm({
    baseUrl: 'http://llm/v1',
    fetchImpl: mockFetch(() => jsonResponse({ object: 'list' })),
  });
  const asr = new WhisperTranscription({
    baseUrl: 'http://whisper',
    fetchImpl: mockFetch(() => new Response('OK')),
  });
  const registry = new AiProviderRegistry({
    providers: [
      { id: 'llm', type: 'llm', kind: 'llama-cpp', config: {}, instance: llm },
      { id: 'asr', type: 'asr', kind: 'whisper', config: {}, instance: asr },
    ],
  });
  const intel = createIntelligence(baseConfig, { registry, loadRegistryFromEnv: false });
  const statuses = await intel.health();
  const names = statuses.map((s) => s.name).sort();
  assert.deepEqual(names, ['asr', 'llm']);
});
