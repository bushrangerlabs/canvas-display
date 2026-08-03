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
 * Loads all providers from the database and registers them in the registry.
 * Also loads task assignments.
 */
export async function syncRegistryFromDb(pool: Pool, registry: AiProviderRegistry): Promise<void> {
  // Load providers
  const provRes = await pool.query<AiProviderRow>('SELECT id, type, kind, config, created_at FROM ai_providers ORDER BY created_at ASC');
  for (const row of provRes.rows) {
    try {
      const instance = buildProviderInstance(row.type, row.kind, row.config);
      registry.addProvider(row.id, row.type, row.kind, row.config, instance);
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
      registry.removeProvider(id);
      const instance = buildProviderInstance(body.type as ProviderType, body.kind as ProviderKind, config);
      registry.addProvider(id, body.type as ProviderType, body.kind as ProviderKind, config, instance);
      await pool.query(
        'UPDATE ai_providers SET type = $1, kind = $2, config = $3 WHERE id = $4',
        [body.type, body.kind, JSON.stringify(config), id],
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

  // POST /api/admin/ai-providers/health-check — trigger a fresh health probe
  fastify.post('/api/admin/ai-providers/health-check', {
    preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }),
  }, async () => {
    const results = await registry.healthCheckAll();
    return { providers: results };
  });
}
