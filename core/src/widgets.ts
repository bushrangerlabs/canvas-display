/**
 * Widget entity resolution and typed action dispatch — the "filtered Core/Edge state"
 * layer that replaces direct HA token access from Canvas-native widgets (Phase 4).
 *
 * ## What this provides
 *
 * 1. **`resolveWidgetEntities(widgetConfig, haState)`** — given a widget config and the
 *    full HA entity cache, returns only the entities that widget actually needs (based on
 *    its `requiresEntity` flag and `entity` field values in its config).
 * 2. **`dispatchWidgetAction(haClient, widgetConfig, action)`** — executes a typed action
 *    (toggle, set_value, navigate, etc.) on behalf of a widget, routing through the HA
 *    facade instead of letting the renderer call HA directly.
 * 3. **REST endpoints** — `POST /api/admin/widgets/resolve-entities` and
 *    `POST /api/admin/widgets/typed-action`.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { HomeAssistantClient, HaEntity } from './providers/ha.js';
import type { WidgetAction, WidgetActionResult, WidgetActionType } from './widget-actions.js';
import { mapActionToHaService } from './widget-actions.js';
import { controlEntity } from './facade.js';

// ── Types ───────────────────────────────────────────────────────────────────

/** A resolved entity with its current state and attributes. */
export interface ResolvedEntity {
  id: string;
  state: string;
  attributes: Record<string, unknown>;
  domain: string;
  friendlyName?: string;
  available: boolean;
}

/** Result of widget entity resolution. */
export interface WidgetEntityResolution {
  entities: ResolvedEntity[];
  /** The widget type that was resolved. */
  widgetType: string;
}

// ── Entity resolution ───────────────────────────────────────────────────────

/**
 * Extract entity IDs from a widget config by scanning its `config` object for
 * fields whose metadata type is `'entity'` (or fields named `entity_id`).
 *
 * Widgets can reference entities in several ways:
 * - A single `entity_id` field in config (most common: value, gauge, icon, etc.)
 * - Multiple entity fields (e.g. a graph widget might reference multiple sensors)
 * - The widget may not require entities at all (e.g. text, clock, shape)
 */
export function extractEntityIdsFromWidgetConfig(
  widgetConfig: Record<string, unknown>,
): string[] {
  const ids: string[] = [];
  const config = widgetConfig.config ?? widgetConfig;

  // Helper to add an entity ID if non-empty.
  const addIfEntity = (value: unknown) => {
    if (typeof value === 'string' && value.includes('.')) {
      ids.push(value);
    }
  };

  // Check common entity field names.
  addIfEntity((config as Record<string, unknown>).entity_id);
  addIfEntity((config as Record<string, unknown>).entityId);

  // Also check for secondary_entity_id (graph widgets with multiple series).
  addIfEntity((config as Record<string, unknown>).secondary_entity_id);
  addIfEntity((config as Record<string, unknown>).secondaryEntityId);

  // Check for entity fields in nested objects (e.g. series arrays).
  const series = (config as Record<string, unknown>).series;
  if (Array.isArray(series)) {
    for (const s of series) {
      if (typeof s === 'object' && s !== null) {
        addIfEntity((s as Record<string, unknown>).entity_id);
        addIfEntity((s as Record<string, unknown>).entityId);
      }
    }
  }

  // Deduplicate while preserving order.
  return [...new Set(ids)];
}

/**
 * Given a widget config and the full HA entity cache, returns only the entities
 * that widget actually needs.
 *
 * @param widgetConfig - The widget's config object (typically `WidgetConfig.config`).
 * @param haEntities - All cached HA entities (from `haClient.getEntities()`).
 * @returns Resolved entities filtered to what this widget needs.
 */
export function resolveWidgetEntities(
  widgetConfig: Record<string, unknown>,
  haEntities: HaEntity[],
): WidgetEntityResolution {
  const widgetType = (widgetConfig.type as string) ?? 'unknown';
  const entityIds = extractEntityIdsFromWidgetConfig(widgetConfig);

  // Build a lookup map from the HA cache.
  const haMap = new Map<string, HaEntity>();
  for (const e of haEntities) {
    haMap.set(e.entityId, e);
  }

  const entities: ResolvedEntity[] = entityIds.map((id) => {
    const haEntity = haMap.get(id);
    const domain = id.split('.')[0] ?? '';
    return {
      id,
      state: haEntity?.state ?? 'unavailable',
      attributes: haEntity?.attributes ?? {},
      domain,
      friendlyName: typeof haEntity?.attributes?.friendly_name === 'string'
        ? haEntity.attributes.friendly_name as string
        : undefined,
      available: haEntity !== undefined,
    };
  });

  return { entities, widgetType };
}

// ── Typed action dispatch ───────────────────────────────────────────────────

/**
 * Execute a typed action on behalf of a widget.
 *
 * This replaces the renderer calling HA's `callService` directly. The action is
 * routed through the facade's `controlEntity` function, which is the single gate
 * for all HA service calls.
 *
 * @param haClient - The HA client (may be null if HA is not configured).
 * @param widgetConfig - The widget's config (used to extract entity_id, domain, etc.).
 * @param action - The typed action to execute.
 * @returns The action result.
 */
export async function dispatchWidgetAction(
  haClient: HomeAssistantClient | null,
  widgetConfig: Record<string, unknown>,
  action: WidgetAction,
): Promise<WidgetActionResult> {
  const config = widgetConfig.config ?? widgetConfig;
  const targetEntityId = (config as Record<string, unknown>).entity_id as string
    ?? (config as Record<string, unknown>).entityId as string
    ?? action.payload.entity_id as string
    ?? action.payload.entityId as string
    ?? '';

  // Handle Canvas-internal actions.
  if (action.type === 'navigate') {
    const target = action.payload.target as string
      ?? action.payload.view as string
      ?? (config as Record<string, unknown>).targetView as string
      ?? '';
    return {
      ok: true,
      message: `Navigate to: ${target}`,
      navigationTarget: target,
    };
  }

  // Map the action type to an HA service call.
  const haService = mapActionToHaService(action.type, targetEntityId || undefined, action.payload);
  if (!haService) {
    return {
      ok: false,
      message: `Unknown action type: ${action.type}`,
    };
  }

  if (!haService.service) {
    return {
      ok: false,
      message: `No service mapped for action type: ${action.type}`,
    };
  }

  // Build service data from the action payload, excluding meta fields.
  const { entity_id: _entityId, entityId: _entityId2, domain: _domain, service: _service, ...restPayload } = action.payload;
  const serviceData: Record<string, unknown> = { ...restPayload };

  try {
    const affected = await controlEntity(
      haClient,
      targetEntityId,
      haService.domain,
      haService.service,
      serviceData,
    );
    return {
      ok: true,
      message: `Called ${haService.domain}.${haService.service} on ${targetEntityId || 'unknown'}`,
      affected: affected.map((e: HaEntity) => e.entityId),
    };
  } catch (err) {
    return {
      ok: false,
      message: (err as Error).message,
    };
  }
}

// ── HTTP routes ─────────────────────────────────────────────────────────────

export interface WidgetsPluginOptions {
  haClient: HomeAssistantClient | null;
  requireAdmin: (opts?: { roles?: ('admin' | 'viewer')[]; csrf?: boolean }) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

/**
 * Registers the widget entity resolution and typed action routes:
 *
 *   POST /api/admin/widgets/resolve-entities  — resolve entities for a widget config
 *   POST /api/admin/widgets/typed-action      — execute a typed action
 */
export async function registerWidgetRoutes(
  fastify: FastifyInstance,
  options: WidgetsPluginOptions,
): Promise<void> {
  const { haClient, requireAdmin } = options;

  // POST /api/admin/widgets/resolve-entities
  // Accepts { widgetConfig, sceneContext? } and returns { entities: ResolvedEntity[] }.
  fastify.post(
    '/api/admin/widgets/resolve-entities',
    { preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }) },
    async (request, reply) => {
      const body = request.body as {
        widgetConfig?: Record<string, unknown>;
        sceneContext?: string;
      } | undefined;

      if (!body || !body.widgetConfig) {
        reply.code(400);
        return { error: 'widgetConfig is required' };
      }

      const haEntities = haClient ? haClient.getEntities() : [];
      const resolution = resolveWidgetEntities(body.widgetConfig, haEntities);
      return resolution;
    },
  );

  // POST /api/admin/widgets/typed-action
  // Accepts { widgetConfig, action: { type, payload } } and returns the action result.
  fastify.post(
    '/api/admin/widgets/typed-action',
    { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) },
    async (request, reply) => {
      const body = request.body as {
        widgetConfig?: Record<string, unknown>;
        action?: WidgetAction;
      } | undefined;

      if (!body || !body.widgetConfig || !body.action) {
        reply.code(400);
        return { error: 'widgetConfig and action are required' };
      }

      const result = await dispatchWidgetAction(haClient, body.widgetConfig, body.action);
      if (!result.ok) {
        reply.code(400);
      }
      return result;
    },
  );
}
