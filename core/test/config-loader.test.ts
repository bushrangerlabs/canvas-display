/**
 * Tests for the provider config loader (D-010 extension).
 *
 * Covers:
 *   - Parsing the advanced-mode JSON env var (CANVAS_CORE_AI_PROVIDERS).
 *   - Parsing the separate task-assignments env var.
 *   - Simple-mode fallback (legacy CANVAS_CORE_LLM_BASE_URL etc.).
 *   - Backward compat: simple mode produces the same provider ids as before.
 *   - Invalid JSON is ignored with a warning (does not throw).
 *   - buildProviderInstance constructs the right adapter class for each kind.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadProvidersFromEnv,
  parseAiProvidersJson,
  buildProviderInstance,
} from '../src/providers/config-loader.js';
import { OpenAiCompatibleLlm } from '../src/providers/llm.js';
import { WhisperTranscription } from '../src/providers/asr.js';
import { PiperSpeech } from '../src/providers/tts.js';
import { OpenAiLlm } from '../src/providers/cloud/openai.js';
import { OpenRouterLlm } from '../src/providers/cloud/openrouter.js';
import { AnthropicLlm } from '../src/providers/cloud/anthropic.js';
import { GeminiLlm } from '../src/providers/cloud/gemini.js';
import { GroqLlm } from '../src/providers/cloud/groq.js';
import { AzureOpenAiLlm } from '../src/providers/cloud/azure.js';
import { OllamaLlm } from '../src/providers/local/ollama.js';
import { mockFetch, jsonResponse } from './helpers.js';
import type { FetchImpl } from '../src/providers/llm.js';

const noopFetch: FetchImpl = mockFetch(() => jsonResponse({}));

test('parseAiProvidersJson returns null for empty input', () => {
  assert.equal(parseAiProvidersJson(undefined), null);
  assert.equal(parseAiProvidersJson(''), null);
  assert.equal(parseAiProvidersJson('   '), null);
});

test('parseAiProvidersJson returns null for invalid JSON', () => {
  assert.equal(parseAiProvidersJson('not json'), null);
  assert.equal(parseAiProvidersJson('{broken'), null);
});

test('parseAiProvidersJson returns null when providers array is missing', () => {
  assert.equal(parseAiProvidersJson('{"foo":"bar"}'), null);
});

test('parseAiProvidersJson parses a valid config', () => {
  const raw = JSON.stringify({
    providers: [
      { id: 'local-llm', type: 'llm', kind: 'llama-cpp', config: { baseUrl: 'http://x/v1' } },
    ],
    assignments: { conversation: 'local-llm' },
  });
  const parsed = parseAiProvidersJson(raw);
  assert.ok(parsed);
  assert.equal(parsed!.providers.length, 1);
  assert.equal(parsed!.providers[0].id, 'local-llm');
  assert.equal(parsed!.assignments.conversation, 'local-llm');
});

test('loadProvidersFromEnv: advanced mode loads multiple providers + assignments', () => {
  const raw = JSON.stringify({
    providers: [
      { id: 'local-llm', type: 'llm', kind: 'llama-cpp', config: { baseUrl: 'http://x/v1', model: 'qwen' } },
      { id: 'cloud-llm', type: 'llm', kind: 'openrouter', config: { apiKey: 'sk-or-x', model: 'anthropic/claude-3.5-sonnet' } },
      { id: 'local-asr', type: 'asr', kind: 'whisper', config: { baseUrl: 'http://whisper' } },
      { id: 'local-tts', type: 'tts', kind: 'piper', config: { host: 'h', port: 10200 } },
    ],
    assignments: { intent_routing: 'local-llm', conversation: 'cloud-llm', asr: 'local-asr', tts: 'local-tts' },
  });
  const result = loadProvidersFromEnv({ CANVAS_CORE_AI_PROVIDERS: raw }, { fetchImpl: noopFetch });
  assert.equal(result.advancedMode, true);
  assert.equal(result.providers.length, 4);
  const ids = result.providers.map((p) => p.id).sort();
  assert.deepEqual(ids, ['cloud-llm', 'local-asr', 'local-llm', 'local-tts']);
  assert.equal(result.assignments.conversation, 'cloud-llm');
  assert.equal(result.assignments.intent_routing, 'local-llm');
});

test('loadProvidersFromEnv: separate CANVAS_CORE_AI_TASK_ASSIGNMENTS env var is merged', () => {
  const raw = JSON.stringify({
    providers: [
      { id: 'a', type: 'llm', kind: 'llama-cpp', config: { baseUrl: 'http://x/v1' } },
      { id: 'b', type: 'llm', kind: 'llama-cpp', config: { baseUrl: 'http://y/v1' } },
    ],
    assignments: { conversation: 'a' },
  });
  const result = loadProvidersFromEnv({
    CANVAS_CORE_AI_PROVIDERS: raw,
    CANVAS_CORE_AI_TASK_ASSIGNMENTS: JSON.stringify({ intent_routing: 'b' }),
  }, { fetchImpl: noopFetch });
  assert.equal(result.assignments.conversation, 'a');
  assert.equal(result.assignments.intent_routing, 'b');
});

test('loadProvidersFromEnv: simple mode (legacy env vars) builds one provider per type', () => {
  const result = loadProvidersFromEnv({
    CANVAS_CORE_LLM_BASE_URL: 'http://llm/v1',
    CANVAS_CORE_LLM_MODEL: 'qwen',
    CANVAS_CORE_WHISPER_URL: 'http://whisper',
    CANVAS_CORE_WHISPER_MODEL: 'base',
    CANVAS_CORE_PIPER_HOST: 'piper-host',
    CANVAS_CORE_PIPER_PORT: '10200',
  }, { fetchImpl: noopFetch });
  assert.equal(result.advancedMode, false);
  assert.equal(result.providers.length, 3);
  const llm = result.providers.find((p) => p.type === 'llm');
  const asr = result.providers.find((p) => p.type === 'asr');
  const tts = result.providers.find((p) => p.type === 'tts');
  assert.equal(llm?.id, 'local-llm');
  assert.equal(llm?.kind, 'llama-cpp');
  assert.equal(asr?.id, 'local-asr');
  assert.equal(tts?.id, 'local-tts');
  // Simple mode has no explicit assignments (registry fallback handles routing).
  assert.deepEqual(result.assignments, {});
});

test('loadProvidersFromEnv: simple mode parses piper URL into host/port', () => {
  const result = loadProvidersFromEnv({
    CANVAS_CORE_PIPER_URL: 'http://host.docker.internal:10200',
  }, { fetchImpl: noopFetch });
  const tts = result.providers.find((p) => p.type === 'tts');
  assert.ok(tts);
  assert.equal(tts.config.host, 'host.docker.internal');
  assert.equal(tts.config.port, 10200);
});

test('loadProvidersFromEnv: simple mode with no env vars returns empty list', () => {
  const result = loadProvidersFromEnv({}, { fetchImpl: noopFetch });
  assert.equal(result.advancedMode, false);
  assert.equal(result.providers.length, 0);
});

test('loadProvidersFromEnv: advanced mode takes precedence over simple mode', () => {
  const raw = JSON.stringify({
    providers: [
      { id: 'cloud', type: 'llm', kind: 'openai', config: { apiKey: 'sk-x', model: 'gpt-4o' } },
    ],
  });
  const result = loadProvidersFromEnv({
    CANVAS_CORE_AI_PROVIDERS: raw,
    CANVAS_CORE_LLM_BASE_URL: 'http://legacy/v1',
  }, { fetchImpl: noopFetch });
  assert.equal(result.advancedMode, true);
  assert.equal(result.providers.length, 1);
  assert.equal(result.providers[0].id, 'cloud');
});

test('buildProviderInstance: builds OpenAiLlm for kind=openai', () => {
  const instance = buildProviderInstance('llm', 'openai', { apiKey: 'sk-x', model: 'gpt-4o' }, { fetchImpl: noopFetch });
  assert.ok(instance instanceof OpenAiLlm);
});

test('buildProviderInstance: builds OpenRouterLlm for kind=openrouter', () => {
  const instance = buildProviderInstance('llm', 'openrouter', { apiKey: 'sk-or', model: 'anthropic/claude-3.5-sonnet' }, { fetchImpl: noopFetch });
  assert.ok(instance instanceof OpenRouterLlm);
});

test('buildProviderInstance: builds AnthropicLlm for kind=anthropic', () => {
  const instance = buildProviderInstance('llm', 'anthropic', { apiKey: 'sk-ant', model: 'claude-3-5-sonnet-20241022' }, { fetchImpl: noopFetch });
  assert.ok(instance instanceof AnthropicLlm);
});

test('buildProviderInstance: builds GeminiLlm for kind=gemini', () => {
  const instance = buildProviderInstance('llm', 'gemini', { apiKey: 'AIzaX', model: 'gemini-1.5-pro' }, { fetchImpl: noopFetch });
  assert.ok(instance instanceof GeminiLlm);
});

test('buildProviderInstance: builds GroqLlm for kind=groq', () => {
  const instance = buildProviderInstance('llm', 'groq', { apiKey: 'gsk_x', model: 'llama-3.3-70b-versatile' }, { fetchImpl: noopFetch });
  assert.ok(instance instanceof GroqLlm);
});

test('buildProviderInstance: builds AzureOpenAiLlm for kind=azure', () => {
  const instance = buildProviderInstance('llm', 'azure', { apiKey: 'az-key', resource: 'my-org', deployment: 'gpt-4o-deploy' }, { fetchImpl: noopFetch });
  assert.ok(instance instanceof AzureOpenAiLlm);
});

test('buildProviderInstance: builds OllamaLlm for kind=ollama', () => {
  const instance = buildProviderInstance('llm', 'ollama', { model: 'llama3.1' }, { fetchImpl: noopFetch });
  assert.ok(instance instanceof OllamaLlm);
});

test('buildProviderInstance: builds OpenAiCompatibleLlm for kind=llama-cpp', () => {
  const instance = buildProviderInstance('llm', 'llama-cpp', { baseUrl: 'http://x/v1' }, { fetchImpl: noopFetch });
  assert.ok(instance instanceof OpenAiCompatibleLlm);
  assert.ok(!(instance instanceof OllamaLlm));
});

test('buildProviderInstance: builds OpenAiCompatibleLlm for kind=vllm', () => {
  const instance = buildProviderInstance('llm', 'vllm', { baseUrl: 'http://x/v1' }, { fetchImpl: noopFetch });
  assert.ok(instance instanceof OpenAiCompatibleLlm);
});

test('buildProviderInstance: builds WhisperTranscription for kind=whisper', () => {
  const instance = buildProviderInstance('asr', 'whisper', { baseUrl: 'http://whisper' }, { fetchImpl: noopFetch });
  assert.ok(instance instanceof WhisperTranscription);
});

test('buildProviderInstance: builds PiperSpeech for kind=piper', () => {
  const instance = buildProviderInstance('tts', 'piper', { host: 'h', port: 10200 });
  assert.ok(instance instanceof PiperSpeech);
});

test('buildProviderInstance: throws on unsupported kind', () => {
  assert.throws(() =>
    buildProviderInstance('llm', 'piper' as never, {}, { fetchImpl: noopFetch }),
  /unsupported kind/);
});
