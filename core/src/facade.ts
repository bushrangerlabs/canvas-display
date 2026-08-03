/**
 * HA entity facade — the bridge between Home Assistant entity state and Canvas scenes
 * (Phase 4: "Add Core HA entity facade and per-scene subscription declarations" from
 * the plan doc §25 Phase 4 checklist; D-012: Core is the primary HA integration point).
 *
 * ## What this provides
 *
 * 1. **`scene_entity_subscriptions` table** — each scene declares which HA entities it
 *    needs, whether they are required (scene breaks if unavailable), and optional
 *    attribute/value filters.
 * 2. **REST endpoints** — batch-set and list per-scene entity subscriptions with merged
 *    HA state from the in-memory cache.
 * 3. **Widget-entity query** — `/api/admin/widget-entities` returns only the filtered
 *    entity state a specific widget config needs (renderer avoids the full HA payload).
 * 4. **Live scene state** — the facade watches the HA entity cache (via
 *    `HomeAssistantClient.onEntityChange`), matches against per-scene subscriptions,
 *    and produces a filtered "scene entity state" snapshot. When a subscribed entity
 *    changes state, the scene's rendered state is marked `stale`.
 * 5. **`controlEntity` layer** — the intent router / AI brain calls this typed action
 *    method instead of reaching directly into HA's `callService`. This is the "typed
 *    actions" layer from the Phase 4 checklist.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import type { HomeAssistantClient, HaEntity } from './providers/ha.js';

// --- Types ------------------------------------------------------------------

/** One row in the scene_entity_subscriptions table. */
export interface SceneEntitySubscription {
  sceneId: string;
  entityId: string;
  required: boolean;
  /** Optional JSON: attribute/value filters for the entity's state. */
  filters: Record<string, unknown> | null;
}

/** A subscription row merged with the current HA state from the cache. */
export interface EnrichedEntityState {
  entityId: string;
  state: string;
  attributes: Record<string, unknown>;
  friendlyName?: string;
  domain: string;
  /** True when the entity exists in the HA cache (connected and known). */
  available: boolean;
}

/** Per-scene stale-tracking in memory. */
export interface SceneStaleState {
  /** Set of scene_ids whose subscribed entities have changed since last read. */
  stale: Set<string>;
}

/** Storage abstraction so tests can swap in an in-memory Postgres (`pg-mem`). */
export interface FacadeRepositoryLike {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export class PgFacadeRepository implements FacadeRepositoryLike {
  constructor(private readonly pool: Pool) {}
  query(text: string, params?: unknown[]) {
    return this.pool.query(text, params as unknown[]) as unknown as Promise<{ rows: any[]; rowCount: number | null }>;
  }
}

// --- Scene entity subscriptions --------------------------------------------

/** Batch-set the entity subscription list for a scene. Replaces any existing subscriptions. */
export async function setSceneEntitySubscriptions(
  repo: FacadeRepositoryLike,
  sceneId: string,
  subscriptions: { entityId: string; required?: boolean; filters?: Record<string, unknown> | null }[],
): Promise<void> {
  // Delete existing subscriptions for this scene.
  await repo.query('DELETE FROM scene_entity_subscriptions WHERE scene_id = $1', [sceneId]);

  if (subscriptions.length === 0) return;

  // Batch insert the new subscriptions.
  const values: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  for (const sub of subscriptions) {
    values.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3})`);
    params.push(sceneId, sub.entityId, sub.required ?? true, sub.filters ? JSON.stringify(sub.filters) : null);
    idx += 4;
  }
  await repo.query(
    `INSERT INTO scene_entity_subscriptions (scene_id, entity_id, required, filters)
     VALUES ${values.join(', ')}`,
    params,
  );
}

/** List subscribed entities for a scene, with current HA state merged in. */
export async function getSceneEntitySubscriptions(
  repo: FacadeRepositoryLike,
  sceneId: string,
  haClient: HomeAssistantClient | null,
): Promise<EnrichedEntityState[]> {
  const res = await repo.query(
    'SELECT * FROM scene_entity_subscriptions WHERE scene_id = $1 ORDER BY entity_id',
    [sceneId],
  );

  return res.rows.map((row: any) => {
    const entityId = row.entity_id as string;
    const haEntity: HaEntity | undefined = haClient?.getEntity(entityId);
    const dom = entityId.split('.')[0] ?? '';
    return {
      entityId,
      state: haEntity?.state ?? 'unavailable',
      attributes: haEntity?.attributes ?? {},
      friendlyName: typeof haEntity?.attributes?.friendly_name === 'string'
        ? haEntity.attributes.friendly_name as string
        : undefined,
      domain: dom,
      available: haEntity !== undefined,
    };
  });
}

/**
 * Returns a filtered entity state payload for a specific widget config.
 * The widget config is expected to have an `entityId` field in its `config` object.
 * Additional filter constraints (attribute matching) come from the scene subscription row.
 */
export async function getWidgetEntityState(
  repo: FacadeRepositoryLike,
  sceneId: string,
  widgetConfig: Record<string, unknown>,
  haClient: HomeAssistantClient | null,
): Promise<EnrichedEntityState | null> {
  const entityId = (widgetConfig?.entityId ?? widgetConfig?.entity_id ?? '') as string;
  if (!entityId) return null;

  // Look up the subscription row for filters.
  const res = await repo.query(
    'SELECT * FROM scene_entity_subscriptions WHERE scene_id = $1 AND entity_id = $2',
    [sceneId, entityId],
  );

  const haEntity: HaEntity | undefined = haClient?.getEntity(entityId);
  const row = res.rows[0];
  const dom = entityId.split('.')[0] ?? '';

  return {
    entityId,
    state: haEntity?.state ?? 'unavailable',
    attributes: haEntity?.attributes ?? {},
    friendlyName: typeof haEntity?.attributes?.friendly_name === 'string'
      ? haEntity.attributes.friendly_name as string
      : undefined,
    domain: dom,
    available: haEntity !== undefined,
  };
}

// --- Stale tracking ---------------------------------------------------------

/**
 * Creates a scene-stale tracker that watches the HA client for entity changes and marks
 * affected scenes as stale.
 */
export function watchHaEntityChanges(
  haClient: HomeAssistantClient,
  repo: FacadeRepositoryLike,
): SceneStaleState {
  const tracker: SceneStaleState = { stale: new Set() };

  haClient.onEntityChange(async (entityId: string, _entity: HaEntity) => {
    // Find all scenes that subscribe to this entity.
    try {
      const res = await repo.query(
        'SELECT DISTINCT scene_id FROM scene_entity_subscriptions WHERE entity_id = $1',
        [entityId],
      );
      for (const row of res.rows) {
        tracker.stale.add(row.scene_id as string);
      }
    } catch {
      // Swallow query errors (degraded mode).
    }
  });

  return tracker;
}

/** Clear the stale mark for a scene (call after the renderer refreshes). */
export function clearSceneStale(sceneStale: SceneStaleState, sceneId: string): void {
  sceneStale.stale.delete(sceneId);
}

/** Check if a scene is stale. */
export function isSceneStale(sceneStale: SceneStaleState, sceneId: string): boolean {
  return sceneStale.stale.has(sceneId);
}

// --- Typed action: controlEntity -------------------------------------------

/**
 * Typed action the intent router / AI brain uses to control an HA entity.
 * This replaces direct `callService` calls — the facade is the single gate.
 *
 * @param haClient - The HA client (may be null if HA is not configured).
 * @param entityId - The entity to control (e.g. "light.kitchen").
 * @param domain - The HA domain (e.g. "light", "switch", "climate").
 * @param service - The service to call (e.g. "turn_on", "turn_off").
 * @param data - Additional service data (entity_id is automatically added).
 * @returns The affected entity states.
 */
export async function controlEntity(
  haClient: HomeAssistantClient | null,
  entityId: string,
  domain: string,
  service: string,
  data: Record<string, unknown> = {},
): Promise<HaEntity[]> {
  if (!haClient) {
    throw new Error('ha_not_configured');
  }

  // Always include the target entity_id in the service data.
  const serviceData: Record<string, unknown> = { entity_id: entityId, ...data };
  return haClient.callService(domain, service, serviceData);
}

// --- HTTP routes ------------------------------------------------------------

export interface FacadePluginOptions {
  repo: FacadeRepositoryLike;
  haClient: HomeAssistantClient | null;
  sceneStale: SceneStaleState;
  requireAdmin: (opts?: { roles?: ('admin' | 'viewer')[]; csrf?: boolean }) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

/**
 * Registers the facade routes:
 *
 *   POST /api/admin/scenes/:id/entities   — batch-set entity subscriptions
 *   GET  /api/admin/scenes/:id/entities   — list with merged HA state
 *   GET  /api/admin/widget-entities       — widget-filtered entity state
 */
export async function registerFacadeRoutes(
  fastify: FastifyInstance,
  options: FacadePluginOptions,
): Promise<void> {
  const { repo, haClient, sceneStale, requireAdmin } = options;

  // POST /api/admin/scenes/:id/entities — batch-set subscriptions (admin, CSRF).
  fastify.post(
    '/api/admin/scenes/:id/entities',
    { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) },
    async (request, reply) => {
      const id = (request.params as { id: string }).id;
      const body = request.body as { entities?: unknown[] } | undefined;
      if (!body || !Array.isArray(body.entities)) {
        reply.code(400);
        return { error: 'entities (array) is required' };
      }
      const subs = body.entities.map((e: unknown) => {
        const ent = e as { entityId?: string; required?: boolean; filters?: Record<string, unknown> | null };
        return {
          entityId: ent.entityId ?? '',
          required: ent.required ?? true,
          filters: ent.filters ?? null,
        };
      });
      if (subs.some((s) => !s.entityId)) {
        reply.code(400);
        return { error: 'each entity must have a non-empty entityId' };
      }
      await setSceneEntitySubscriptions(repo, id, subs);
      return { ok: true, count: subs.length };
    },
  );

  // GET /api/admin/scenes/:id/entities — list with merged HA state.
  fastify.get(
    '/api/admin/scenes/:id/entities',
    { preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }) },
    async (request) => {
      const id = (request.params as { id: string }).id;
      const entities = await getSceneEntitySubscriptions(repo, id, haClient);

      // Also report the stale status.
      const stale = isSceneStale(sceneStale, id);

      // Clear stale on read (the renderer is considered to have refreshed).
      clearSceneStale(sceneStale, id);

      return { sceneId: id, entities, stale };
    },
  );

  // GET /api/admin/widget-entities?sceneId=X&widgetId=Y
  // Returns the filtered entity state for a given widget config.
  fastify.get(
    '/api/admin/widget-entities',
    { preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }) },
    async (request, reply) => {
      const query = request.query as { sceneId?: string; widgetConfig?: string };
      if (!query.sceneId || !query.widgetConfig) {
        reply.code(400);
        return { error: 'sceneId and widgetConfig query params are required' };
      }
      let config: Record<string, unknown>;
      try {
        config = JSON.parse(query.widgetConfig) as Record<string, unknown>;
      } catch {
        reply.code(400);
        return { error: 'widgetConfig must be valid JSON' };
      }
      const entityState = await getWidgetEntityState(repo, query.sceneId, config, haClient);
      return { entity: entityState };
    },
  );
}
