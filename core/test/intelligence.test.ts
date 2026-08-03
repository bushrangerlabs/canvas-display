import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIntelligence } from '../src/intelligence.js';
import { OpenAiCompatibleLlm, DegradedLlm } from '../src/providers/llm.js';
import { WhisperTranscription } from '../src/providers/asr.js';
import { PiperSpeech } from '../src/providers/tts.js';
import { HttpJsonRpcMcpClient } from '../src/providers/mcp.js';
import { mockFetch, jsonResponse, fakeSocketFactory } from './helpers.js';
import type { FetchImpl } from '../src/providers/llm.js';
import type { CoreConfig } from '../src/config.js';

const baseConfig: CoreConfig = {
  port: 3100,
  host: '0.0.0.0',
  databaseUrl: 'postgresql://x',
  gatewayPath: '/gateway/v1',
  logLevel: 'info',
};

test('runVoicePipeline chains ASR -> LLM -> TTS with all three mocked', async () => {
  const asrFetch: FetchImpl = mockFetch(() => jsonResponse({ text: 'what is the weather' }));
  const llmFetch: FetchImpl = mockFetch((_url, init) => {
    const body = JSON.parse((init?.body as string) ?? '{}');
    assert.equal(body.messages.at(-1).content, 'what is the weather');
    return jsonResponse({ choices: [{ message: { content: 'It is sunny.' } }] });
  });
  const SAMPLE = Buffer.from([0xaa, 0xbb]);
  const intel = createIntelligence(baseConfig, {
    asr: new WhisperTranscription({ baseUrl: 'http://whisper', fetchImpl: asrFetch }),
    llm: new OpenAiCompatibleLlm({ baseUrl: 'http://llm/v1', fetchImpl: llmFetch }),
    tts: new PiperSpeech({ host: 'fake', port: 1, socketFactory: fakeSocketFactory(SAMPLE) }),
  });

  const result = await intel.runVoicePipeline({ audio: Buffer.from('RIFF') });
  assert.equal(result.transcript, 'what is the weather');
  assert.equal(result.reply, 'It is sunny.');
  assert.equal(result.audioBase64, SAMPLE.toString('base64'));
  assert.equal(result.degraded, false);
});

test('runVoicePipeline accepts a pre-transcribed transcript and skips ASR', async () => {
  const llmFetch: FetchImpl = mockFetch(() => jsonResponse({ choices: [{ message: { content: 'Hi there.' } }] }));
  const intel = createIntelligence(baseConfig, {
    llm: new OpenAiCompatibleLlm({ baseUrl: 'http://llm/v1', fetchImpl: llmFetch }),
    tts: new PiperSpeech({ host: 'fake', port: 1, socketFactory: fakeSocketFactory(Buffer.from([1])) }),
  });
  const result = await intel.runVoicePipeline({ transcript: 'hello', skipTts: true });
  assert.equal(result.transcript, 'hello');
  assert.equal(result.reply, 'Hi there.');
  assert.equal(result.audioBase64, undefined);
});

test('runVoicePipeline uses degraded LLM when no llmBaseUrl configured', async () => {
  const intel = createIntelligence({ ...baseConfig }); // no llmBaseUrl -> DegradedLlm
  assert.ok(intel.providers.llm instanceof DegradedLlm);
  const result = await intel.runVoicePipeline({ transcript: 'are you there', skipTts: true });
  assert.equal(result.degraded, true);
  assert.match(result.reply, /degraded/i);
});

test('health() aggregates every configured provider', async () => {
  const intel = createIntelligence(baseConfig, {
    asr: new WhisperTranscription({ baseUrl: 'http://whisper', fetchImpl: mockFetch(() => new Response('OK')) }),
    llm: new OpenAiCompatibleLlm({ baseUrl: 'http://llm/v1', fetchImpl: mockFetch(() => jsonResponse({ object: 'list' })) }),
    tts: new PiperSpeech({ host: 'fake', port: 1, socketFactory: fakeSocketFactory(Buffer.from([1])) }),
    mcp: new HttpJsonRpcMcpClient({ baseUrl: 'http://mcp', fetchImpl: mockFetch(() => jsonResponse({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'x' } } })) }),
  });
  const statuses = await intel.health();
  const names = statuses.map((s) => s.name).sort();
  assert.deepEqual(names, ['asr', 'llm', 'mcp', 'tts']);
});

test('intelligent voice pipeline sends YouTube playback to the originating device', async () => {
  let ttsCalls = 0;
  const intel = createIntelligence(baseConfig, {
    llm: new DegradedLlm(),
    tts: {
      name: 'tts-test',
      async synthesize() {
        ttsCalls += 1;
        return Buffer.from('should-not-play');
      },
      async healthCheck() {
        return { name: 'tts-test', healthy: true };
      },
    },
    loadRegistryFromEnv: false,
  });
  const calls: Array<{ query: string; source: string; deviceId?: string }> = [];
  intel.setToolContext({
    playMedia: async (query, source, deviceId) => {
      calls.push({ query, source, deviceId });
      return { ok: true, message: `Playing "${query}" on YouTube.` };
    },
  });

  const result = await intel.runIntelligentPipeline({
    transcript: 'Play Bohemian Rhapsody official video on YouTube',
    originDeviceId: 'pi-lounge',
  });

  assert.equal(result.intent.intent, 'media_play');
  assert.equal(result.toolResult?.ok, true);
  assert.deepEqual(calls, [{
    query: 'Bohemian Rhapsody official video',
    source: 'youtube',
    deviceId: 'pi-lounge',
  }]);
  assert.equal(result.audioBase64, undefined);
  assert.equal(ttsCalls, 0);
});

test('intelligent voice pipeline does not broadcast YouTube playback when origin is missing', async () => {
  const intel = createIntelligence(baseConfig, {
    llm: new DegradedLlm(),
    loadRegistryFromEnv: false,
  });
  let dispatched = false;
  intel.setToolContext({
    playMedia: async () => {
      dispatched = true;
      return { ok: true, message: 'unexpected' };
    },
  });

  const result = await intel.runIntelligentPipeline({
    transcript: 'Play Bluey Dance Mode on YouTube',
    skipTts: true,
  });

  assert.equal(result.toolResult?.ok, false);
  assert.equal(dispatched, false);
});

test('intelligent voice pipeline treats empty ASR as no intent without LLM or TTS', async () => {
  let llmCalls = 0;
  let ttsCalls = 0;
  const intel = createIntelligence(baseConfig, {
    asr: {
      name: 'asr-empty',
      async transcribe() { return ''; },
      async healthCheck() { return { name: 'asr-empty', healthy: true }; },
    },
    llm: {
      name: 'llm-test',
      async chat() { llmCalls += 1; return 'should not run'; },
      async healthCheck() { return { name: 'llm-test', healthy: true }; },
    },
    tts: {
      name: 'tts-test',
      async synthesize() { ttsCalls += 1; return Buffer.from('should not run'); },
      async healthCheck() { return { name: 'tts-test', healthy: true }; },
    },
    loadRegistryFromEnv: false,
  });

  const result = await intel.runIntelligentPipeline({ audio: Buffer.from('RIFF') });

  assert.equal(result.transcript, '');
  assert.equal(result.reply, '');
  assert.equal(result.intent.intent, 'unknown');
  assert.equal(result.audioBase64, undefined);
  assert.equal(llmCalls, 0);
  assert.equal(ttsCalls, 0);
});

test('time questions bypass AI classification and conversation planning', async () => {
  let llmCalls = 0;
  const intel = createIntelligence(baseConfig, {
    llm: {
      name: 'llm-test',
      async chat() { llmCalls += 1; return 'should not run'; },
      async healthCheck() { return { name: 'llm-test', healthy: true }; },
    },
    loadRegistryFromEnv: false,
  });

  const result = await intel.runIntelligentPipeline({ transcript: 'What time is it?', skipTts: true });

  assert.equal(result.intent.intent, 'time_query');
  assert.match(result.reply, /^It is /);
  assert.equal(llmCalls, 0);
  assert.ok((result.timings?.routingMs ?? 10_000) < 100);
});

test('natural time-question variants stay on the deterministic fast path', async () => {
  let llmCalls = 0;
  const intel = createIntelligence(baseConfig, {
    llm: {
      name: 'llm-test',
      async chat() { llmCalls += 1; return 'should not run'; },
      async healthCheck() { return { name: 'llm-test', healthy: true }; },
    },
    loadRegistryFromEnv: false,
  });

  const result = await intel.runIntelligentPipeline({ transcript: 'What would the time be?', skipTts: true });

  assert.equal(result.intent.intent, 'time_query');
  assert.match(result.reply, /^It is /);
  assert.equal(llmCalls, 0);
});
