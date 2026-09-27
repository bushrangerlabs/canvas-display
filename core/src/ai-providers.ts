/**
 * AI Providers CRUD — store and manage AI provider configurations in PostgreSQL.
 *
 * Providers can be added/removed/updated at runtime via the admin API, and
 * survive restarts (stored in the `ai_providers` table). The registry is
 * synced with the database on startup and on every change.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { AiProviderRegistry, type ProviderType, type ProviderKind, type ProviderConfig, type TaskType, type ProviderInfo } from './providers/registry.js';
import { buildProviderInstance } from './providers/config-loader.js';
import type { TranscriptionProvider } from './providers/asr.js';
import type { SpeechProvider } from './providers/tts.js';
import type { RequireAdminOptions } from './auth.js';

/** Minimal requireAdmin signature matching what auth.ts returns. */
type RequireAdmin = (opts?: RequireAdminOptions) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface AiProviderRow {
  id: string;
  type: ProviderType;
  kind: ProviderKind;
  config: ProviderConfig;
  created_at: string;
}

export interface AiAssignmentRow {
  task: string;
  provider_id: string;
}

/**
 * Persist a provider's config (upsert) without touching the registry instance.
 * Used for in-place changes (active model/voice) that must not break the running
 * pipeline's instance reference.
 */
async function persistProviderConfig(
  pool: Pool,
  id: string,
  type: ProviderType,
  kind: ProviderKind,
  config: ProviderConfig,
): Promise<void> {
  await pool.query(
    'INSERT INTO ai_providers (id, type, kind, config) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type, kind = EXCLUDED.kind, config = EXCLUDED.config',
    [id, type, kind, JSON.stringify(config)],
  );
}

/**
 * Persist a provider's config (upsert) and rebuild its registry instance,
 * preserving any task assignments that pointed at it. Used when the provider's
 * type/kind/base URL changes, which requires a fresh instance.
 */
async function persistAndRebuildProvider(
  pool: Pool,
  registry: AiProviderRegistry,
  id: string,
  type: ProviderType,
  kind: ProviderKind,
  config: ProviderConfig,
): Promise<void> {
  await pool.query(
    'INSERT INTO ai_providers (id, type, kind, config) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type, kind = EXCLUDED.kind, config = EXCLUDED.config',
    [id, type, kind, JSON.stringify(config)],
  );
  const priorAssignments = registry.getAssignments();
  registry.removeProvider(id);
  const instance = buildProviderInstance(type, kind, config);
  registry.addProvider(id, type, kind, config, instance);
  // removeProvider clears assignments pointing at this id — restore them.
  for (const [task, providerId] of Object.entries(priorAssignments)) {
    if (providerId === id) {
      try {
        registry.assignTask(task as TaskType, id);
      } catch {
        // Capability may have changed (e.g. tools no longer supported) — skip.
      }
    }
  }
}

/**
 * Loads all providers from the database and registers them in the registry.
 * Also loads task assignments.
 */
export async function syncRegistryFromDb(pool: Pool, registry: AiProviderRegistry): Promise<void> {
  // Load providers
  const provRes = await pool.query<AiProviderRow>('SELECT id, type, kind, config, created_at FROM ai_providers ORDER BY created_at ASC');
  for (const row of provRes.rows) {
    try {
      const instance = buildProviderInstance(row.type, row.kind, row.config);
      // A provider with this id may already exist from the env-based bootstrap
      // (simple/advanced mode). The DB row is authoritative — it holds any
      // runtime edits (e.g. the selected model/voice) — so replace the env one.
      const priorAssignments = registry.getAssignments();
      registry.removeProvider(row.id);
      registry.addProvider(row.id, row.type, row.kind, row.config, instance);
      // removeProvider clears assignments pointing at this id — restore them.
      for (const [task, providerId] of Object.entries(priorAssignments)) {
        if (providerId === row.id) {
          try {
            registry.assignTask(task as TaskType, row.id);
          } catch {
            // Capability changed (e.g. tools no longer supported) — skip.
          }
        }
      }
    } catch (err) {
      console.error(`[core][ai-providers] failed to build provider '${row.id}':`, err instanceof Error ? err.message : err);
    }
  }

  // Load assignments
  const assignRes = await pool.query<AiAssignmentRow>('SELECT task, provider_id FROM ai_task_assignments');
  for (const row of assignRes.rows) {
    try {
      registry.assignTask(row.task as TaskType, row.provider_id);
    } catch {
      // Provider may not exist yet — skip
    }
  }
}

/**
 * Registers admin CRUD routes for AI providers.
 */
export function registerAiProviderRoutes(
  fastify: FastifyInstance,
  pool: Pool,
  registry: AiProviderRegistry,
  requireAdmin: RequireAdmin,
): void {
  // GET /api/admin/ai-providers — list all providers + assignments
  fastify.get('/api/admin/ai-providers', {
    preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }),
  }, async () => {
    const providers = registry.listProviders();
    const assignments = registry.getAssignments();
    return { providers, assignments };
  });

  // POST /api/admin/ai-providers — add a new provider
  fastify.post('/api/admin/ai-providers', {
    preHandler: requireAdmin({ roles: ['admin'], csrf: true }),
  }, async (request, reply) => {
    const body = request.body as { id?: string; type?: string; kind?: string; config?: Record<string, unknown> } | undefined;
    if (!body?.id || !body?.type || !body?.kind) {
      return reply.code(400).send({ error: 'id, type, and kind are required' });
    }
    const config: ProviderConfig = body.config ?? {};
    try {
      const instance = buildProviderInstance(body.type as ProviderType, body.kind as ProviderKind, config);
      registry.addProvider(body.id, body.type as ProviderType, body.kind as ProviderKind, config, instance);
      await pool.query(
        'INSERT INTO ai_providers (id, type, kind, config) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type, kind = EXCLUDED.kind, config = EXCLUDED.config',
        [body.id, body.type, body.kind, JSON.stringify(config)],
      );
      return reply.code(201).send({ ok: true, id: body.id });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // PUT /api/admin/ai-providers/:id — update a provider's config
  fastify.put('/api/admin/ai-providers/:id', {
    preHandler: requireAdmin({ roles: ['admin'], csrf: true }),
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { type?: string; kind?: string; config?: Record<string, unknown> } | undefined;
    if (!body?.type || !body?.kind) {
      return reply.code(400).send({ error: 'type and kind are required' });
    }
    const config: ProviderConfig = body.config ?? {};
    try {
      await persistAndRebuildProvider(
        pool,
        registry,
        id,
        body.type as ProviderType,
        body.kind as ProviderKind,
        config,
      );
      return { ok: true, id };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // DELETE /api/admin/ai-providers/:id — remove a provider
  fastify.delete('/api/admin/ai-providers/:id', {
    preHandler: requireAdmin({ roles: ['admin'], csrf: true }),
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    registry.removeProvider(id);
    await pool.query('DELETE FROM ai_providers WHERE id = $1', [id]);
    await pool.query('DELETE FROM ai_task_assignments WHERE provider_id = $1', [id]);
    return { ok: true };
  });

  // PUT /api/admin/ai-providers/assign — assign a task to a provider
  fastify.put('/api/admin/ai-providers/assign', {
    preHandler: requireAdmin({ roles: ['admin'], csrf: true }),
  }, async (request, reply) => {
    const body = request.body as { task?: string; providerId?: string } | undefined;
    if (!body?.task) {
      return reply.code(400).send({ error: 'task is required' });
    }
    if (!body.providerId) {
      // Unassign
      registry.unassignTask(body.task as TaskType);
      await pool.query('DELETE FROM ai_task_assignments WHERE task = $1', [body.task]);
      return { ok: true, task: body.task, providerId: null };
    }
    try {
      registry.assignTask(body.task as TaskType, body.providerId);
      await pool.query(
        'INSERT INTO ai_task_assignments (task, provider_id) VALUES ($1, $2) ON CONFLICT (task) DO UPDATE SET provider_id = EXCLUDED.provider_id',
        [body.task, body.providerId],
      );
      return { ok: true, task: body.task, providerId: body.providerId };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/admin/ai-providers/:id/models — list selectable models (ASR) / voices (TTS)
  fastify.get('/api/admin/ai-providers/:id/models', {
    preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }),
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const info = registry.getProviderInfo(id);
    const instance = registry.getInstance(id);
    if (!info || !instance) {
      return reply.code(404).send({ error: `provider '${id}' not found` });
    }

    if (info.type === 'asr') {
      const asr = instance as TranscriptionProvider;
      let models: string[] = [];
      let error: string | undefined;
      try {
        models = (await asr.listModels?.()) ?? [];
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      const active = typeof info.config.model === 'string' ? info.config.model : null;
      if (active && !models.includes(active)) models = [active, ...models];
      return {
        kind: info.kind,
        models: Array.from(new Set(models)).sort(),
        active,
        canDownload: typeof asr.downloadModel === 'function',
        error,
      };
    }

    if (info.type === 'tts') {
      const tts = instance as SpeechProvider;
      const custom = Array.isArray(info.config.customVoices)
        ? info.config.customVoices.filter((v): v is string => typeof v === 'string')
        : [];
      let voices: string[] = [];
      let error: string | undefined;
      try {
        voices = (await tts.listVoices?.()) ?? [];
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      const merged = Array.from(new Set([...voices, ...custom]));
      const active = typeof info.config.voice === 'string' ? info.config.voice : null;
      if (active && !merged.includes(active)) merged.push(active);
      return { kind: info.kind, models: merged.sort(), active, canDownload: false, error };
    }

    return reply.code(400).send({ error: `provider '${id}' is type '${info.type}', not asr/tts` });
  });

  // POST /api/admin/ai-providers/:id/models — add a model (ASR download) / voice (TTS)
  fastify.post('/api/admin/ai-providers/:id/models', {
    preHandler: requireAdmin({ roles: ['admin'], csrf: true }),
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { model?: string } | undefined;
    const model = (body?.model ?? '').trim();
    if (!model) return reply.code(400).send({ error: 'model is required' });
    const info = registry.getProviderInfo(id);
    const instance = registry.getInstance(id);
    if (!info || !instance) {
      return reply.code(404).send({ error: `provider '${id}' not found` });
    }

    try {
      if (info.type === 'asr') {
        const asr = instance as TranscriptionProvider;
        if (!asr.downloadModel) {
          return reply.code(400).send({ error: `provider '${id}' does not support model downloads` });
        }
        await asr.downloadModel(model);
        return { ok: true, model, downloaded: true };
      }
      if (info.type === 'tts') {
        // Piper voices are installed in the container; "adding" one records a
        // custom voice name so it appears in the selector.
        const custom = Array.isArray(info.config.customVoices)
          ? info.config.customVoices.filter((v): v is string => typeof v === 'string')
          : [];
        if (!custom.includes(model)) custom.push(model);
        const config: ProviderConfig = { ...info.config, customVoices: custom };
        registry.updateProviderConfig(id, config);
        await persistProviderConfig(pool, id, info.type, info.kind, config);
        return { ok: true, model, downloaded: false };
      }
      return reply.code(400).send({ error: `provider '${id}' is type '${info.type}', not asr/tts` });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // PUT /api/admin/ai-providers/:id/model — set the active model (ASR) / voice (TTS)
  fastify.put('/api/admin/ai-providers/:id/model', {
    preHandler: requireAdmin({ roles: ['admin'], csrf: true }),
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { model?: string } | undefined;
    const model = (body?.model ?? '').trim();
    const info = registry.getProviderInfo(id);
    if (!info) return reply.code(404).send({ error: `provider '${id}' not found` });
    if (info.type !== 'asr' && info.type !== 'tts') {
      return reply.code(400).send({ error: `provider '${id}' is type '${info.type}', not asr/tts` });
    }
    const key = info.type === 'asr' ? 'model' : 'voice';
    const config: ProviderConfig = { ...info.config };
    if (model) config[key] = model;
    else delete config[key];
    try {
      // Apply to the live instance so the running pipeline picks it up immediately,
      // then persist so the choice survives a restart.
      const instance = registry.getInstance(id);
      if (info.type === 'asr') (instance as TranscriptionProvider | undefined)?.setModel?.(model || undefined);
      else (instance as SpeechProvider | undefined)?.setVoice?.(model || undefined);
      registry.updateProviderConfig(id, config);
      await persistProviderConfig(pool, id, info.type, info.kind, config);
      return { ok: true, model: model || null };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/admin/ai-providers/health-check — trigger a fresh health probe
  fastify.post('/api/admin/ai-providers/health-check', {
    preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }),
  }, async () => {
    const results = await registry.healthCheckAll();
    return { providers: results };
  });
}
