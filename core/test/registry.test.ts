/**
 * Tests for the multi-provider AI registry (D-010 extension).
 *
 * Covers:
 *   - Adding providers and listing them.
 *   - Task assignment and routing (explicit assignment + fallback).
 *   - Simple mode (one provider per type) vs advanced mode (multiple).
 *   - Health check aggregation.
 *   - Error cases (duplicate id, assigning to wrong type, stale assignment).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AiProviderRegistry,
  type ProviderType,
  type TaskType,
} from '../src/providers/registry.js';
import { OpenAiCompatibleLlm, DegradedLlm } from '../src/providers/llm.js';
import { WhisperTranscription } from '../src/providers/asr.js';
import { PiperSpeech } from '../src/providers/tts.js';
import { mockFetch, jsonResponse, fakeSocketFactory } from './helpers.js';
import type { FetchImpl } from '../src/providers/llm.js';

/** Build a mock LLM that returns a canned reply. */
function mockLlm(reply: string, name = 'llm'): OpenAiCompatibleLlm {
  return new OpenAiCompatibleLlm({
    baseUrl: 'http://example/v1',
    name,
    fetchImpl: mockFetch(() => jsonResponse({ choices: [{ message: { content: reply } }] })),
  });
}

test('AiProviderRegistry: addProvider and listProviders', () => {
  const registry = new AiProviderRegistry();
  const llm = mockLlm('hi', 'local-llm');
  registry.addProvider('local-llm', 'llm', 'llama-cpp', { baseUrl: 'http://x' }, llm);
  const list = registry.listProviders();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'local-llm');
  assert.equal(list[0].type, 'llm');
  assert.equal(list[0].kind, 'llama-cpp');
  assert.equal(list[0].healthy, null);
  assert.deepEqual(list[0].assignedTasks, []);
});

test('AiProviderRegistry: addProvider rejects duplicate id', () => {
  const registry = new AiProviderRegistry();
  registry.addProvider('llm-1', 'llm', 'llama-cpp', {}, mockLlm('a'));
  assert.throws(() =>
    registry.addProvider('llm-1', 'llm', 'llama-cpp', {}, mockLlm('b')),
  /already registered/);
});

test('AiProviderRegistry: getProvider falls back to first of type when unassigned', () => {
  const registry = new AiProviderRegistry();
  const llm = mockLlm('hi');
  registry.addProvider('local-llm', 'llm', 'llama-cpp', {}, llm);
  const got = registry.getProvider('conversation');
  assert.equal(got?.id, 'local-llm');
  // Same provider is used for intent_routing in simple mode (no assignment).
  const got2 = registry.getProvider('intent_routing');
  assert.equal(got2?.id, 'local-llm');
});

test('AiProviderRegistry: assignTask routes to the assigned provider', () => {
  const registry = new AiProviderRegistry();
  const local = mockLlm('local', 'local-llm');
  const cloud = mockLlm('cloud', 'cloud-llm');
  registry.addProvider('local-llm', 'llm', 'llama-cpp', {}, local);
  registry.addProvider('cloud-llm', 'llm', 'openrouter', {}, cloud);

  // Without assignment, first provider wins (local-llm).
  assert.equal(registry.getProvider('conversation')?.id, 'local-llm');

  registry.assignTask('conversation', 'cloud-llm');
  assert.equal(registry.getProvider('conversation')?.id, 'cloud-llm');
  // intent_routing still falls back to first (local-llm).
  assert.equal(registry.getProvider('intent_routing')?.id, 'local-llm');

  const assignments = registry.getAssignments();
  assert.equal(assignments.conversation, 'cloud-llm');
  assert.equal(assignments.intent_routing, undefined);
});

test('AiProviderRegistry: assignTask rejects wrong provider type', () => {
  const registry = new AiProviderRegistry();
  registry.addProvider('local-asr', 'asr', 'whisper', {}, new WhisperTranscription({
    baseUrl: 'http://x', fetchImpl: mockFetch(() => jsonResponse({ text: 'x' })),
  }));
  assert.throws(() =>
    registry.assignTask('conversation', 'local-asr'),
  /expects llm/);
});

test('AiProviderRegistry: assignTask rejects unknown provider id', () => {
  const registry = new AiProviderRegistry();
  assert.throws(() =>
    registry.assignTask('conversation', 'nope'),
  /not found/);
});

test('AiProviderRegistry: getProvider clears stale assignment and falls back', () => {
  const registry = new AiProviderRegistry();
  const llm = mockLlm('hi');
  registry.addProvider('local-llm', 'llm', 'llama-cpp', {}, llm);
  registry.assignTask('conversation', 'local-llm');
  registry.removeProvider('local-llm');
  // Assignment was cleared by removeProvider; getProvider returns undefined.
  assert.equal(registry.getProvider('conversation'), undefined);
  assert.equal(registry.getAssignments().conversation, undefined);
});

test('AiProviderRegistry: isAdvancedMode detects multiple providers of a type', () => {
  const simple = new AiProviderRegistry();
  simple.addProvider('llm', 'llm', 'llama-cpp', {}, mockLlm('a'));
  assert.equal(simple.isAdvancedMode(), false);

  const advanced = new AiProviderRegistry();
  advanced.addProvider('local-llm', 'llm', 'llama-cpp', {}, mockLlm('a'));
  advanced.addProvider('cloud-llm', 'llm', 'openrouter', {}, mockLlm('b'));
  assert.equal(advanced.isAdvancedMode(), true);
});

test('AiProviderRegistry: listProviders reports assignedTasks', () => {
  const registry = new AiProviderRegistry();
  const local = mockLlm('a', 'local-llm');
  const cloud = mockLlm('b', 'cloud-llm');
  registry.addProvider('local-llm', 'llm', 'llama-cpp', {}, local);
  registry.addProvider('cloud-llm', 'llm', 'openrouter', {}, cloud);
  registry.assignTask('intent_routing', 'local-llm');
  registry.assignTask('conversation', 'cloud-llm');

  const list = registry.listProviders();
  const localEntry = list.find((p) => p.id === 'local-llm');
  const cloudEntry = list.find((p) => p.id === 'cloud-llm');
  assert.deepEqual(localEntry?.assignedTasks, ['intent_routing']);
  assert.deepEqual(cloudEntry?.assignedTasks, ['conversation']);
});

test('AiProviderRegistry: healthCheckAll caches and returns per-provider status', async () => {
  const registry = new AiProviderRegistry();
  const okLlm = new OpenAiCompatibleLlm({
    baseUrl: 'http://ok/v1',
    name: 'ok-llm',
    fetchImpl: mockFetch(() => jsonResponse({ object: 'list' })),
  });
  const downLlm = new OpenAiCompatibleLlm({
    baseUrl: 'http://down/v1',
    name: 'down-llm',
    fetchImpl: (() => Promise.reject(new Error('ECONNREFUSED'))) as FetchImpl,
  });
  registry.addProvider('ok-llm', 'llm', 'llama-cpp', {}, okLlm);
  registry.addProvider('down-llm', 'llm', 'llama-cpp', {}, downLlm);

  const results = await registry.healthCheckAll();
  assert.equal(results.length, 2);
  const ok = results.find((r) => r.id === 'ok-llm');
  const down = results.find((r) => r.id === 'down-llm');
  assert.equal(ok?.healthy, true);
  assert.equal(down?.healthy, false);
  assert.match(down?.detail ?? '', /ECONNREFUSED/);

  // Cached on the provider entry.
  const list = registry.listProviders();
  const okEntry = list.find((p) => p.id === 'ok-llm');
  const downEntry = list.find((p) => p.id === 'down-llm');
  assert.equal(okEntry?.healthy, true);
  assert.equal(downEntry?.healthy, false);
});

test('AiProviderRegistry: getLlmProvider / getAsrProvider / getTtsProvider type-narrow', () => {
  const registry = new AiProviderRegistry();
  const llm = mockLlm('hi');
  const asr = new WhisperTranscription({
    baseUrl: 'http://x',
    fetchImpl: mockFetch(() => jsonResponse({ text: 'x' })),
  });
  const tts = new PiperSpeech({
    host: 'fake', port: 1, socketFactory: fakeSocketFactory(Buffer.from([1])),
  });
  registry.addProvider('llm', 'llm', 'llama-cpp', {}, llm);
  registry.addProvider('asr', 'asr', 'whisper', {}, asr);
  registry.addProvider('tts', 'tts', 'piper', {}, tts);

  assert.equal(registry.getLlmProvider('conversation'), llm);
  assert.equal(registry.getAsrProvider(), asr);
  assert.equal(registry.getTtsProvider(), tts);
});

test('AiProviderRegistry: constructor accepts initial providers and assignments', () => {
  const llm = mockLlm('hi', 'local-llm');
  const cloud = mockLlm('cloud', 'cloud-llm');
  const registry = new AiProviderRegistry({
    providers: [
      { id: 'local-llm', type: 'llm', kind: 'llama-cpp', config: {}, instance: llm },
      { id: 'cloud-llm', type: 'llm', kind: 'openrouter', config: {}, instance: cloud },
    ],
    assignments: { conversation: 'cloud-llm' },
  });
  assert.equal(registry.size(), 2);
  assert.equal(registry.getProvider('conversation')?.id, 'cloud-llm');
  assert.equal(registry.getProvider('intent_routing')?.id, 'local-llm');
});

test('AiProviderRegistry: taskTypeToProviderType maps correctly', () => {
  const m = AiProviderRegistry.taskTypeToProviderType;
  assert.equal(m('intent_routing'), 'llm');
  assert.equal(m('conversation'), 'llm');
  assert.equal(m('embedding'), 'llm');
  assert.equal(m('asr'), 'asr');
  assert.equal(m('tts'), 'tts');
});

test('AiProviderRegistry: unassignTask reverts to fallback', () => {
  const registry = new AiProviderRegistry();
  const local = mockLlm('a', 'local-llm');
  const cloud = mockLlm('b', 'cloud-llm');
  registry.addProvider('local-llm', 'llm', 'llama-cpp', {}, local);
  registry.addProvider('cloud-llm', 'llm', 'openrouter', {}, cloud);
  registry.assignTask('conversation', 'cloud-llm');
  assert.equal(registry.getProvider('conversation')?.id, 'cloud-llm');
  registry.unassignTask('conversation');
  assert.equal(registry.getProvider('conversation')?.id, 'local-llm');
});

test('AiProviderRegistry: DegradedLlm can be registered as a fallback provider', async () => {
  const registry = new AiProviderRegistry();
  registry.addProvider('degraded', 'llm', 'llama-cpp', {}, new DegradedLlm({ name: 'degraded' }));
  const llm = registry.getLlmProvider('conversation');
  assert.ok(llm instanceof DegradedLlm);
  const reply = await llm!.chat([{ role: 'user', content: 'anything' }]);
  assert.match(reply, /degraded/i);
});
