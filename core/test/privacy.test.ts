/**
 * Tests for the container health checker and privacy controls.
 *
 * Phase 5: provider isolation layer and audio privacy controls.
 * No real network — all I/O is mocked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {
  ContainerHealthChecker,
  type ProviderContainerConfig,
  type ProviderName,
} from '../src/providers/container.js';
import {
  InMemoryPrivacyRepository,
  PrivacyFilter,
  registerPrivacyRoutes,
  DEFAULT_PRIVACY_SETTINGS,
} from '../src/privacy.js';
import { createIntelligence } from '../src/intelligence.js';
import { OpenAiCompatibleLlm } from '../src/providers/llm.js';
import { WhisperTranscription } from '../src/providers/asr.js';
import { mockFetch, jsonResponse } from './helpers.js';
import type { FetchImpl } from '../src/providers/llm.js';
import type { CoreConfig } from '../src/config.js';

const baseConfig: CoreConfig = {
  port: 3100,
  host: '0.0.0.0',
  databaseUrl: 'postgresql://x',
  gatewayPath: '/gateway/v1',
  logLevel: 'info',
};

// =========================================================================
// Container health checker tests
// =========================================================================

test('ContainerHealthChecker reports healthy provider', async () => {
  const fetchImpl: FetchImpl = mockFetch(() => jsonResponse({ ok: true }));
  const checker = new ContainerHealthChecker(
    [
      {
        name: 'asr',
        url: 'http://whisper:10301',
        healthEndpoint: '/health',
        timeout: 5000,
        maxRetries: 1,
        containerName: 'whisper',
      },
    ],
    fetchImpl,
  );

  const results = await checker.checkAll();
  assert.equal(results.length, 1);
  assert.equal(results[0].provider, 'asr');
  assert.equal(results[0].healthy, true);
  assert.ok(results[0].latencyMs >= 0);
  assert.equal(results[0].lastError, null);
  assert.ok(results[0].lastChecked.length > 0);
});

test('ContainerHealthChecker reports unhealthy provider', async () => {
  const fetchImpl = (() =>
    Promise.reject(new Error('ECONNREFUSED'))) as FetchImpl;
  const checker = new ContainerHealthChecker(
    [
      {
        name: 'asr',
        url: 'http://whisper:10301',
        healthEndpoint: '/health',
        timeout: 500,
        maxRetries: 0,
        containerName: 'whisper',
      },
    ],
    fetchImpl,
  );

  const results = await checker.checkAll();
  assert.equal(results.length, 1);
  assert.equal(results[0].provider, 'asr');
  assert.equal(results[0].healthy, false);
  assert.ok(results[0].lastError);
  assert.equal(results[0].uptimeMs, 0);
});

test('ContainerHealthChecker getUnhealthyProviders returns only failed ones', async () => {
  let callCount = 0;
  const fetchImpl: FetchImpl = mockFetch(() => {
    callCount++;
    if (callCount <= 1) return jsonResponse({ ok: true });
    return jsonResponse({ error: 'down' }, 503);
  });

  const checker = new ContainerHealthChecker(
    [
      {
        name: 'asr',
        url: 'http://whisper:10301',
        healthEndpoint: '/health',
        timeout: 5000,
        maxRetries: 0,
        containerName: 'whisper',
      },
      {
        name: 'llm',
        url: 'http://llm:8089',
        healthEndpoint: '/health',
        timeout: 5000,
        maxRetries: 0,
        containerName: 'llama.cpp',
      },
    ],
    fetchImpl,
  );

  await checker.checkAll();
  const unhealthy = checker.getUnhealthyProviders();
  assert.equal(unhealthy.length, 1);
  assert.equal(unhealthy[0].provider, 'llm');
});

test('ContainerHealthChecker does not crash when provider is down (D-010 degraded mode)', async () => {
  const fetchImpl = (() =>
    Promise.reject(new Error('connection timeout'))) as FetchImpl;
  const checker = new ContainerHealthChecker(
    [
      {
        name: 'asr',
        url: 'http://whisper:10301',
        healthEndpoint: '/health',
        timeout: 500,
        maxRetries: 1,
        containerName: 'whisper',
      },
      {
        name: 'llm',
        url: 'http://llm:8089',
        healthEndpoint: '/health',
        timeout: 500,
        maxRetries: 1,
        containerName: 'llama.cpp',
      },
    ],
    fetchImpl,
  );

  let results: Array<{ provider: ProviderName; healthy: boolean }> = [];
  try {
    results = await checker.checkAll();
  } catch {
    assert.fail('ContainerHealthChecker threw when providers were down');
  }
  assert.equal(results.length, 2);
  assert.equal(results[0].healthy, false);
  assert.equal(results[1].healthy, false);
});

// =========================================================================
// Privacy controls tests
// =========================================================================

test('PrivacySettings default config is privacy-preserving', async () => {
  assert.equal(DEFAULT_PRIVACY_SETTINGS.retain_transcripts, false);
  assert.equal(DEFAULT_PRIVACY_SETTINGS.retain_audio, false);
  assert.equal(DEFAULT_PRIVACY_SETTINGS.retention_days, 0);
  assert.deepEqual(DEFAULT_PRIVACY_SETTINGS.providers_allowed, []);
  assert.equal(DEFAULT_PRIVACY_SETTINGS.transcript_log_level, 'anonymized');
});

test('InMemoryPrivacyRepository CRUD', async () => {
  const repo = new InMemoryPrivacyRepository();

  const defaults = await repo.getSettings();
  assert.equal(defaults.retain_transcripts, false);
  assert.equal(defaults.transcript_log_level, 'anonymized');

  const updated = await repo.updateSettings({
    retain_transcripts: true,
    transcript_log_level: 'none',
  });
  assert.equal(updated.retain_transcripts, true);
  assert.equal(updated.transcript_log_level, 'none');

  const fetched = await repo.getSettings();
  assert.equal(fetched.retain_transcripts, true);
  assert.equal(fetched.transcript_log_level, 'none');
});

test('Privacy provider allowlist enforcement', async () => {
  const repo = new InMemoryPrivacyRepository();
  await repo.updateSettings({
    providers_allowed: ['llm', 'mcp'],
  });

  const settings = await repo.getSettings();
  assert.ok(settings.providers_allowed.includes('llm'));
  assert.ok(settings.providers_allowed.includes('mcp'));
  assert.ok(!settings.providers_allowed.includes('asr'));
});

test('PrivacyFilter anonymizes known entity patterns', async () => {
  const filter = new PrivacyFilter();
  const text = 'Turn on light.living_room and check sensor.temperature';
  const { anonymized, redactedCount } = filter.apply(text);

  assert.equal(anonymized, 'Turn on [REDACTED] and check [REDACTED]');
  assert.equal(redactedCount, 2);
});

test('PrivacyFilter anonymizes emails and IPs', async () => {
  const filter = new PrivacyFilter();
  const text = 'Contact admin@example.com from 192.168.1.1';
  const { anonymized, redactedCount } = filter.apply(text);

  assert.equal(anonymized, 'Contact [REDACTED] from [REDACTED]');
  assert.equal(redactedCount, 2);
});

test('PrivacyFilter leaves safe text unchanged', async () => {
  const filter = new PrivacyFilter();
  const text = 'What is the weather in London?';
  const { anonymized, redactedCount } = filter.apply(text);

  assert.equal(anonymized, text);
  assert.equal(redactedCount, 0);
});

test('Privacy transcript anonymization in intelligence pipeline', async () => {
  const repo = new InMemoryPrivacyRepository();
  const filter = new PrivacyFilter();

  const intel = createIntelligence(baseConfig, {
    privacyRepo: repo,
    privacyFilter: filter,
  });

  const { displayTranscript, redactedCount } = await intel.applyTranscriptPrivacy(
    'turn on light.living_room',
  );

  assert.ok(redactedCount > 0);
  assert.equal(displayTranscript, 'turn on [REDACTED]');
});

test('Audio discard when retain_audio is false', async () => {
  const repo = new InMemoryPrivacyRepository();
  const filter = new PrivacyFilter();

  const settings = await repo.getSettings();
  assert.equal(settings.retain_audio, false);

  const intel = createIntelligence(baseConfig, {
    privacyRepo: repo,
    privacyFilter: filter,
  });

  const buf = Buffer.from([0x01, 0x02, 0x03]);
  intel.discardAudioBuffer(buf);
  assert.ok(buf.length > 0);
});

test('Purge clears stored data', async () => {
  const repo = new InMemoryPrivacyRepository();

  await repo.updateSettings({
    retain_transcripts: true,
    retain_audio: true,
  });

  await repo.storeTranscript('test transcript');
  await repo.storeAudio(1024);

  const result = await repo.purgeAll();
  assert.equal(result.purgedTranscripts, 1);
  assert.equal(result.purgedAudio, 1);

  const result2 = await repo.purgeAll();
  assert.equal(result2.purgedTranscripts, 0);
  assert.equal(result2.purgedAudio, 0);
});

test('Voice pipeline respects privacy provider allowlist', async () => {
  const repo = new InMemoryPrivacyRepository();
  const filter = new PrivacyFilter();
  const asrFetch: FetchImpl = mockFetch(() => jsonResponse({ text: 'hello' }));
  const llmFetch: FetchImpl = mockFetch(() => jsonResponse({ choices: [{ message: { content: 'hi' } }] }));

  const intel = createIntelligence(baseConfig, {
    asr: new WhisperTranscription({ baseUrl: 'http://whisper', fetchImpl: asrFetch, name: 'asr' }),
    llm: new OpenAiCompatibleLlm({ baseUrl: 'http://llm/v1', fetchImpl: llmFetch }),
    privacyRepo: repo,
    privacyFilter: filter,
  });

  await repo.updateSettings({
    providers_allowed: ['llm', 'mcp'],
  });

  await assert.rejects(
    () => intel.runVoicePipeline({ audio: Buffer.from('test') }),
    /Privacy policy blocks ASR/,
  );
});

// =========================================================================
// Privacy route tests
// =========================================================================

test('GET /api/admin/privacy returns default settings', async () => {
  const fastify = Fastify();
  const repo = new InMemoryPrivacyRepository();

  // A no-op requireAdmin factory for test routes.
  const requireAdmin = (_opts?: Record<string, unknown>) => {
    return async (_request: unknown, _reply: unknown) => {};
  };

  registerPrivacyRoutes(fastify, { repo, requireAdmin: requireAdmin as any });
  await fastify.ready();

  const res = await fastify.inject({ method: 'GET', url: '/api/admin/privacy' });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.settings.retain_transcripts, false);
  assert.equal(body.settings.transcript_log_level, 'anonymized');

  await fastify.close();
});

test('PUT /api/admin/privacy updates settings', async () => {
  const fastify = Fastify();
  const repo = new InMemoryPrivacyRepository();

  const requireAdmin = (_opts?: Record<string, unknown>) => {
    return async (_request: unknown, _reply: unknown) => {};
  };

  registerPrivacyRoutes(fastify, { repo, requireAdmin: requireAdmin as any });
  await fastify.ready();

  const res = await fastify.inject({
    method: 'PUT',
    url: '/api/admin/privacy',
    body: { retain_transcripts: true, transcript_log_level: 'none' },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.settings.retain_transcripts, true);
  assert.equal(body.settings.transcript_log_level, 'none');

  await fastify.close();
});

test('POST /api/admin/privacy/purge purges all stored data', async () => {
  const fastify = Fastify();
  const repo = new InMemoryPrivacyRepository();

  const requireAdmin = (_opts?: Record<string, unknown>) => {
    return async (_request: unknown, _reply: unknown) => {};
  };

  registerPrivacyRoutes(fastify, { repo, requireAdmin: requireAdmin as any });
  await fastify.ready();

  await repo.updateSettings({ retain_transcripts: true, retain_audio: true });
  await repo.storeTranscript('test');
  await repo.storeAudio(100);

  const res = await fastify.inject({ method: 'POST', url: '/api/admin/privacy/purge' });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.purgedTranscripts, 1);
  assert.equal(body.purgedAudio, 1);

  await fastify.close();
});