/**
 * Tests for AI provider DB sync (`syncRegistryFromDb`).
 *
 * The DB is the runtime source of truth for provider config: a row may override
 * an env-bootstrapped provider of the same id (so a model/voice selected in the
 * UI survives a restart), and task assignments pointing at it must be preserved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiProviderRegistry } from '../src/providers/registry.js';
import { WhisperTranscription } from '../src/providers/asr.js';
import { syncRegistryFromDb } from '../src/ai-providers.js';
import { createTestDb } from './db-helpers.js';

test('syncRegistryFromDb: DB row overrides an env-bootstrapped provider of the same id', async () => {
  const { pool } = createTestDb();
  const registry = new AiProviderRegistry();
  // Simulate the env bootstrap: `local-asr` built from simple-mode env vars.
  registry.addProvider(
    'local-asr',
    'asr',
    'whisper',
    { baseUrl: 'http://whisper', model: 'Systran/faster-whisper-base.en' },
    new WhisperTranscription({ baseUrl: 'http://whisper', model: 'Systran/faster-whisper-base.en' }),
  );
  registry.assignTask('asr', 'local-asr');

  // The DB holds the runtime-edited model.
  await pool.query(
    'INSERT INTO ai_providers (id, type, kind, config) VALUES ($1, $2, $3, $4)',
    ['local-asr', 'asr', 'whisper', JSON.stringify({ baseUrl: 'http://whisper', model: 'Systran/faster-whisper-small.en' })],
  );

  await syncRegistryFromDb(pool, registry);

  const info = registry.getProviderInfo('local-asr');
  assert.equal(info?.config.model, 'Systran/faster-whisper-small.en');
  assert.equal(registry.getInstance('local-asr') instanceof WhisperTranscription, true);
  // The env assignment survives the replace.
  assert.equal(registry.getAssignments().asr, 'local-asr');
});

test('syncRegistryFromDb: adds DB-only providers and loads assignments', async () => {
  const { pool } = createTestDb();
  const registry = new AiProviderRegistry();
  await pool.query(
    'INSERT INTO ai_providers (id, type, kind, config) VALUES ($1, $2, $3, $4)',
    ['cloud-llm', 'llm', 'openrouter', JSON.stringify({ apiKey: 'sk', model: 'x' })],
  );
  await pool.query(
    'INSERT INTO ai_task_assignments (task, provider_id) VALUES ($1, $2)',
    ['conversation', 'cloud-llm'],
  );

  await syncRegistryFromDb(pool, registry);

  assert.equal(registry.getProviderInfo('cloud-llm')?.kind, 'openrouter');
  assert.equal(registry.getAssignments().conversation, 'cloud-llm');
});

test('syncRegistryFromDb: a bad row is skipped without aborting the rest', async () => {
  const { pool } = createTestDb();
  const registry = new AiProviderRegistry();
  await pool.query(
    'INSERT INTO ai_providers (id, type, kind, config) VALUES ($1, $2, $3, $4)',
    ['bad', 'llm', 'not-a-kind', JSON.stringify({})],
  );
  await pool.query(
    'INSERT INTO ai_providers (id, type, kind, config) VALUES ($1, $2, $3, $4)',
    ['good', 'asr', 'whisper', JSON.stringify({ baseUrl: 'http://whisper' })],
  );

  await syncRegistryFromDb(pool, registry);

  assert.equal(registry.getProviderInfo('bad'), undefined);
  assert.equal(registry.getProviderInfo('good')?.kind, 'whisper');
});
