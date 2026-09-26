import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from './config.js';
import { getPool, migrate } from './db.js';

const execFileAsync = promisify(execFile);
import { registerGateway } from './gateway.js';
import { createIntelligence, type Intelligence, type CloudUsageEntry } from './intelligence.js';
import { parseContentAsToolCalls, type LlmProvider } from './providers/llm.js';
import { createHomeAssistantClient, type HomeAssistantClient } from './providers/ha.js';
import {
  registerAuth,
  bootstrapAdmin,
  PgAuthRepository,
} from './auth.js';
import {
  registerDeviceRoutes,
  PgDeviceRepository,
  recordDeviceHello,
} from './devices.js';
import {
  registerStateRoutes,
  PgStateRepository,
  reportState,
  setDesiredState,
  type ReportedStatus,
} from './state.js';
import {
  registerSceneRoutes,
  PgSceneRepository,
} from './scenes.js';
import {
  registerFacadeRoutes,
  PgFacadeRepository,
  watchHaEntityChanges,
  type SceneStaleState,
} from './facade.js';
import {
  registerAssetRoutes,
  PgAssetRepository,
} from './assets.js';
import { registerIconRoutes, PgIconRepository } from './icons.js';
import { MqttNavigationService } from './mqtt-navigation.js';
import {
  registerScheduleRoutes,
  PgScheduleRepository,
  SchedulerService,
} from './schedules.js';
import {
  registerGcRoutes,
  PgGcRepository,
  DEFAULT_QUOTA_BYTES,
  DEFAULT_RESERVED_BYTES,
} from './gc.js';
import {
  registerEnrollmentRoutes,
  createCoreEnrollmentSigner,
} from './enrollment.js';
import { VoiceSessionManager } from './voice-session.js';
import { ContainerHealthChecker, type ProviderContainerConfig } from './providers/container.js';
import { InMemoryPrivacyRepository, registerPrivacyRoutes, PrivacyFilter } from './privacy.js';
import { ShadowModeRunner } from './shadow-mode.js';
import { RolloutStrategy, InMemoryRolloutRepository, registerRolloutRoutes } from './rollout-strategy.js';
import { createHermesClient } from './hermes-client.js';
import { loadCorpus } from './hermes-corpus.js';
import { registerLegacyRoutes, requestDeviceAction, sendCommand, getDeviceIp } from './legacy-routes.js';
import { registerAiProviderRoutes, syncRegistryFromDb } from './ai-providers.js';
import { registerMcpServerRoutes, loadMcpServerConfigs, buildMultiMcpFromDb, seedMcpServersFromEnv } from './mcp-servers.js';
import { installLogger, setLevel, getLevel } from './logger.js';
import type { LogLevel } from './logger.js';
import { registerLogRoutes } from './log-routes.js';
import { registerAiLogRoutes } from './ai-log.js';
import { resolveYouTubeWatchUrl, resolveYouTubeQueue, buildYouTubePlaylistUrl, resolveYouTubeStreams as resolveYouTubeStreamsFn, type YouTubeSearchOptions } from './youtube.js';
import { policyFromSettings } from './request-routing.js';
import { confirmationDigest, mcpCallRequiresConfirmation, normalizeToolArguments, resolveToolName, selectToolsForRequest } from './mcp-policy.js';
import { FlowRepository, FlowExecutor, registerFlowRoutes } from './flows.js';
import { migrateFlowAiDraftsTable, runAutomationGapDetection } from './flow-ai-drafts.js';
import { advertiseCore } from './discovery.js';
import { BroadcastStore, extensionForMime, type BroadcastClip } from './broadcast.js';
import { CORE_VERSION } from './version.js';

/**
 * Canvas Core — centralized control plane and AI brain (plan doc §20.5, D-009..D-013).
 *
 * This is the single hub every Edge device connects to. Phase 2 bootstrap: boots a
 * Fastify server, connects to PostgreSQL, exposes a health route + admin API stub, and
 * accepts Edge devices on the Device Gateway WSS endpoint (protocol v1).
 *
 * The AI brain (Canvas Intelligence) is scaffolded in `intelligence.ts`: it wires the
 * ASR/LLM/TTS/MCP provider clients and exposes a voice pipeline + provider-health
 * endpoint. This is Phase2/early scaffolding (D-010 pluggable providers), not the full
 * Phase5/6 intent router/tool-registry behavior.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  installLogger(config.logLevel);
  const fastify = Fastify({ logger: { level: config.logLevel } });

  await fastify.register(cors, { origin: true });

  // Serve the web UI from the `public/` directory.
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const publicDir = path.join(__dirname, '..', 'public');
  await fastify.register(fastifyStatic, {
    root: publicDir,
    prefix: '/',
    wildcard: true,
  });

  // Serve index.html for the root path.
  fastify.get('/', (request, reply) => {
    reply.sendFile('index.html');
  });

  // SPA fallback: serve index.html for all unknown non-API routes.
  fastify.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/gateway/') || request.url.startsWith('/ws')) {
      reply.code(404).send({ message: `Route ${request.method}:${request.url} not found`, error: 'Not Found', statusCode: 404 });
      return;
    }
    reply.sendFile('index.html');
  });

  // --- Phase 5 privacy controls (plan doc §14.4, §25 Phase 5 checklist) ---
  const privacyRepo = new InMemoryPrivacyRepository();
  const privacyFilter = new PrivacyFilter();

  // Cloud-AI usage logging is wired once the DB pool exists (below). The sink is
  // only invoked when a cloud provider is actually used.
  let cloudUsageSink: ((entry: CloudUsageEntry) => void) | null = null;
  const logCloudUsage = (entry: CloudUsageEntry): void => { cloudUsageSink?.(entry); };

  // Cloud-AI policy is read live from Core settings (admin UI toggle); the env
  // values are only the initial defaults.
  let cloudPolicyCache = { enabled: config.cloudAiEnabled, providerId: config.cloudAiProviderId };
  const cloudPolicy = () => cloudPolicyCache;

  // Canvas Intelligence — wire provider clients from config (degraded mode if unset).
  const intelligence: Intelligence = createIntelligence(config, {
    privacyRepo,
    privacyFilter,
    knowledgeSearchUrl: config.searxngPublicUrl,
    cloudPolicy,
    cloudUsageLogger: logCloudUsage,
  });

  // D-012 Home Assistant integration (Core is the primary HA integration point).
  // Optional: only present when CANVAS_CORE_HA_URL + CANVAS_CORE_HA_TOKEN are set.
  // Degraded mode: if HA is down, Core stays up and the cache stays empty (§20.4).
  const ha: HomeAssistantClient | null = createHomeAssistantClient(config);
  if (ha) {
    ha.connect().catch((err) => {
      console.warn('[core][ha] connection deferred (degraded mode):', (err as Error).message);
    });
  } else {
    console.log('[core][ha] not configured (set CANVAS_CORE_HA_URL + CANVAS_CORE_HA_TOKEN to enable)');
  }

  // Connect to PostgreSQL and apply bootstrap migrations BEFORE registering auth /
  // device-registry routes (they need the pool). Fail closed if Postgres is down.
  const pool = getPool(config);
  const refreshCloudPolicy = async () => {
    try {
      const rows = await pool.query(
        "SELECT key, value FROM settings WHERE key IN ('cloud_ai_enabled','cloud_ai_provider')",
      );
      const values = Object.fromEntries(rows.rows.map(row => [String(row.key), String(row.value)]));
      cloudPolicyCache = {
        enabled: values.cloud_ai_enabled === '1',
        providerId: values.cloud_ai_provider ?? '',
      };
    } catch { /* keep last known policy */ }
  };
  await refreshCloudPolicy();
  cloudUsageSink = (entry) => {
    void pool.query(
      `INSERT INTO cloud_ai_usage
         (id, purpose, provider_id, model, device_id, operation, ok, latency_ms, error, prompt, response)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        randomUUID(), entry.purpose, entry.providerId, entry.model ?? null, entry.deviceId ?? null,
        entry.operation ?? null, entry.ok, entry.latencyMs ?? null, entry.error ?? null,
        entry.prompt ?? null, entry.response ?? null,
      ],
    ).catch(err => console.warn('[core][cloud-ai] failed to log usage:', err instanceof Error ? err.message : err));
  };
  try {
    await pool.query('SELECT 1');
    await migrate(pool);
    console.log('[core] PostgreSQL connected');
  } catch (err) {
    console.error('[core] PostgreSQL connection failed:', (err as Error).message);
    process.exitCode = 1;
    return;
  }

  const reloadRequestRoutingPolicy = async () => {
    const rows = await pool.query("SELECT key, value FROM settings WHERE key LIKE 'request_routing_%'");
    const settings = Object.fromEntries(rows.rows.map(row => [String(row.key), String(row.value)]));
    intelligence.intentRouter.setPolicy(policyFromSettings(settings));
  };
  await reloadRequestRoutingPolicy();
  let flowExecutor: FlowExecutor | null = null;

  const cacheHaEntity = async (entity: {
    entityId: string;
    state: string;
    attributes: Record<string, unknown>;
    lastChanged?: string;
    lastUpdated?: string;
  }): Promise<void> => {
    const friendlyName = typeof entity.attributes.friendly_name === 'string'
      ? entity.attributes.friendly_name
      : null;
    await pool.query(
      `INSERT INTO ha_entities
         (entity_id, domain, friendly_name, state, attributes, last_changed, last_updated, cached_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, now())
       ON CONFLICT (entity_id) DO UPDATE SET
         domain = EXCLUDED.domain,
         friendly_name = EXCLUDED.friendly_name,
         state = EXCLUDED.state,
         attributes = EXCLUDED.attributes,
         last_changed = EXCLUDED.last_changed,
         last_updated = EXCLUDED.last_updated,
         cached_at = now()`,
      [
        entity.entityId,
        entity.entityId.split('.')[0] ?? '',
        friendlyName,
        entity.state,
        JSON.stringify(entity.attributes),
        entity.lastChanged ?? null,
        entity.lastUpdated ?? null,
      ],
    );
  };

  const normalizeVoicePhrase = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  const rebuildVoiceCommandIndex = async (): Promise<number> => {
    const templates = await pool.query<{
      id: string; domain: string; action: string; phrase_template: string; service: string | null;
      priority: number; requires_confirmation: boolean;
    }>('SELECT id, domain, action, phrase_template, service, priority, requires_confirmation FROM voice_command_templates WHERE enabled=true');
    const entities = await pool.query<{ entity_id: string; domain: string; friendly_name: string | null }>(
      'SELECT entity_id, domain, friendly_name FROM ha_entities WHERE friendly_name IS NOT NULL AND btrim(friendly_name) <> \'\'',
    );
    const aliases = await pool.query<{ entity_id: string; alias: string }>('SELECT entity_id, alias FROM voice_entity_aliases');
    const namesByEntity = new Map<string, string[]>();
    for (const entity of entities.rows) namesByEntity.set(entity.entity_id, [entity.friendly_name!]);
    for (const alias of aliases.rows) namesByEntity.set(alias.entity_id, [...(namesByEntity.get(alias.entity_id) ?? []), alias.alias]);
    const rows: Array<[string, string, string, string, string, string | null, number, boolean]> = [];
    for (const template of templates.rows) {
      for (const entity of entities.rows) {
        if (entity.domain !== template.domain) continue;
        for (const name of namesByEntity.get(entity.entity_id) ?? []) {
          const phrase = normalizeVoicePhrase(template.phrase_template.replaceAll('{name}', name));
          if (phrase) rows.push([phrase, template.id, entity.entity_id, entity.domain, template.action, template.service, template.priority, template.requires_confirmation]);
        }
      }
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM voice_command_index');
      for (const row of rows) {
        await client.query(
          `INSERT INTO voice_command_index(phrase, template_id, entity_id, domain, action, service, priority, requires_confirmation)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, row,
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return rows.length;
  };

  const reconcileHaEntityCache = async (): Promise<number> => {
    if (!ha) return 0;
    const entities = await ha.refreshEntities();
    await Promise.all(entities.map((entity) => cacheHaEntity(entity)));
    const ids = entities.map((entity) => entity.entityId);
    if (ids.length > 0) {
      await pool.query('DELETE FROM ha_entities WHERE NOT (entity_id = ANY($1::text[]))', [ids]);
    }
    await rebuildVoiceCommandIndex();
    return entities.length;
  };

  const reconcileHaRegistryCache = async (): Promise<{ areas: number; devices: number; entities: number }> => {
    if (!ha) return { areas: 0, devices: 0, entities: 0 };
    const snapshot = await ha.refreshRegistries();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const area of snapshot.areas) {
        await client.query(
          `INSERT INTO ha_areas (area_id, name, floor_id, aliases, cached_at)
           VALUES ($1, $2, $3, $4::jsonb, now())
           ON CONFLICT (area_id) DO UPDATE SET name=EXCLUDED.name, floor_id=EXCLUDED.floor_id,
             aliases=EXCLUDED.aliases, cached_at=now()`,
          [area.areaId, area.name, area.floorId ?? null, JSON.stringify(area.aliases)],
        );
      }
      for (const device of snapshot.devices) {
        await client.query(
          `INSERT INTO ha_devices
             (device_id, name, name_by_user, area_id, manufacturer, model, cached_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())
           ON CONFLICT (device_id) DO UPDATE SET name=EXCLUDED.name, name_by_user=EXCLUDED.name_by_user,
             area_id=EXCLUDED.area_id, manufacturer=EXCLUDED.manufacturer, model=EXCLUDED.model, cached_at=now()`,
          [device.deviceId, device.name ?? null, device.nameByUser ?? null, device.areaId ?? null,
            device.manufacturer ?? null, device.model ?? null],
        );
      }
      for (const entity of snapshot.entities) {
        await client.query(
          `INSERT INTO ha_entity_registry
             (entity_id, device_id, area_id, name, original_name, platform, disabled_by, cached_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now())
           ON CONFLICT (entity_id) DO UPDATE SET device_id=EXCLUDED.device_id, area_id=EXCLUDED.area_id,
             name=EXCLUDED.name, original_name=EXCLUDED.original_name, platform=EXCLUDED.platform,
             disabled_by=EXCLUDED.disabled_by, cached_at=now()`,
          [entity.entityId, entity.deviceId ?? null, entity.areaId ?? null, entity.name ?? null,
            entity.originalName ?? null, entity.platform ?? null, entity.disabledBy ?? null],
        );
      }
      if (snapshot.areas.length) await client.query('DELETE FROM ha_areas WHERE NOT (area_id = ANY($1::text[]))', [snapshot.areas.map(v => v.areaId)]);
      if (snapshot.devices.length) await client.query('DELETE FROM ha_devices WHERE NOT (device_id = ANY($1::text[]))', [snapshot.devices.map(v => v.deviceId)]);
      if (snapshot.entities.length) await client.query('DELETE FROM ha_entity_registry WHERE NOT (entity_id = ANY($1::text[]))', [snapshot.entities.map(v => v.entityId)]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return { areas: snapshot.areas.length, devices: snapshot.devices.length, entities: snapshot.entities.length };
  };

  if (ha) {
    ha.onEntityChange((entityId, entity) => {
      void cacheHaEntity(entity).catch((err) => {
        console.warn('[core][ha] failed to persist entity cache update:', (err as Error).message);
      });
      // Fire any trigger_ha_state flows that match this entity+state
      if (flowExecutor) {
        void flowExecutor.onHaEntityChange(entityId, String(entity.state ?? '')).catch(err =>
          console.warn('[core][ha] ha_state flow trigger error:', (err as Error).message)
        );
      }
    });
    // WebSocket pushes handle normal changes; this periodic full pass catches
    // removals and anything missed during reconnects.
    const haReconcileTimer = setInterval(() => {
      void Promise.all([reconcileHaEntityCache(), reconcileHaRegistryCache()]).catch((err) => {
        console.warn('[core][ha] periodic entity reconciliation failed:', (err as Error).message);
      });
    }, 5 * 60_000);
    void reconcileHaRegistryCache()
      .then(counts => console.log(`[core][ha] registry cached: ${counts.areas} areas, ${counts.devices} devices, ${counts.entities} entities`))
      .catch(err => console.warn('[core][ha] initial registry reconciliation failed:', (err as Error).message));
    haReconcileTimer.unref();
    void reconcileHaEntityCache().catch((err) => {
      console.warn('[core][ha] initial entity reconciliation deferred:', (err as Error).message);
    });
  }

  // --- Phase 2 admin auth scaffold (plan doc §13.5) -------------------------
  const authRepo = new PgAuthRepository(pool);
  await bootstrapAdmin(config, authRepo);
  const { requireAdmin } = await registerAuth(fastify, { config, repo: authRepo });

  fastify.get('/api/admin/request-routing', {
    preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }),
  }, async () => ({ policy: intelligence.intentRouter.getPolicy() }));

  fastify.post<{ Body: { transcript?: string } }>('/api/admin/request-routing/test', {
    preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }),
  }, async (request, reply) => {
    const transcript = request.body?.transcript?.trim() ?? '';
    if (!transcript) return reply.code(400).send({ error: 'transcript_required' });
    return { transcript, classification: await intelligence.intentRouter.classify(transcript) };
  });
  await registerLogRoutes(fastify, requireAdmin);
  await registerAiLogRoutes(fastify, requireAdmin);

  // MCP server registry — load from DB and wire into the intelligence providers.
  // After loading, replace the env-var-based MCP client with a DB-backed MultiMcpManager.
  let mcpManager: import('./providers/multi-mcp.js').MultiMcpManager | undefined;
  // Seed any env-var-defined MCP servers into the DB so they appear in the settings UI.
  await seedMcpServersFromEnv(pool);
  const dbMcpConfigs = await loadMcpServerConfigs(pool);
  if (dbMcpConfigs.length > 0) {
    mcpManager = new (await import('./providers/multi-mcp.js')).MultiMcpManager(dbMcpConfigs);
    // Replace the intelligence MCP client so the tool registry picks up DB servers.
    intelligence.providers.mcp = mcpManager;
    // Re-register MCP tools from the DB-backed client (the initial registration
    // only picked up env-var-based servers).
    await intelligence.reloadMcpTools();
    console.log(`[core][mcp] loaded ${dbMcpConfigs.length} MCP server(s) from database`);
  }
  registerMcpServerRoutes(
    fastify,
    pool,
    requireAdmin,
    () => mcpManager,
    async (m) => {
      mcpManager = m;
      intelligence.providers.mcp = m;
      await intelligence.reloadMcpTools().catch((err) =>
        console.error('[core][mcp] failed to re-register tools:', err instanceof Error ? err.message : err),
      );
    },
  );

  // AI provider registry — sync from DB and expose admin CRUD routes.
  // The registry is created inside createIntelligence; we wire it to Postgres here.
  if (intelligence.registry) {
    await syncRegistryFromDb(pool, intelligence.registry);
    registerAiProviderRoutes(fastify, pool, intelligence.registry, requireAdmin);
  }

  // --- Phase 2 device registry + pairing invitations (plan doc §12.3/§26.5) ---
  const deviceRepo = new PgDeviceRepository(pool);

  // --- P-003 device-identity gate: Core enrollment key + device-facing pairing routes --
  const enrollmentSeed = process.env.CANVAS_CORE_ENROLLMENT_SEED
    ? Uint8Array.from(Buffer.from(process.env.CANVAS_CORE_ENROLLMENT_SEED, 'hex'))
    : undefined;
  const enrollmentSigner = createCoreEnrollmentSigner(enrollmentSeed);
  await registerEnrollmentRoutes(fastify, { repo: deviceRepo, signer: enrollmentSigner, securityEpoch: config.securityEpoch });
  const gateway = registerGateway(fastify, config, enrollmentSigner);

  await registerDeviceRoutes(fastify, { repo: deviceRepo, requireAdmin, gateway });

  // --- Phase 2 per-device desired/reported state (plan doc §10.2, §12.6) ---
  const stateRepo = new PgStateRepository(pool);
  await registerStateRoutes(fastify, { repo: stateRepo, requireAdmin });

  // --- Phase 4 content-addressed asset storage (plan doc §18.1) ------------
  const assetStoragePath = process.env.ASSET_STORAGE_PATH || './data/assets/';
  const assetRepo = new PgAssetRepository(pool);
  const assetQuotaBytes = process.env.CANVAS_CORE_ASSET_QUOTA_BYTES
    ? Number(process.env.CANVAS_CORE_ASSET_QUOTA_BYTES)
    : DEFAULT_QUOTA_BYTES;
  await registerAssetRoutes(fastify, { repo: assetRepo, storagePath: assetStoragePath, requireAdmin, quotaBytes: assetQuotaBytes });

  // --- Custom icon storage (server-persisted so every browser/kiosk sees the same icons) ---
  const iconRepo = new PgIconRepository(pool);
  await registerIconRoutes(fastify, { repo: iconRepo, requireAdmin });

  // --- Phase 4 garbage collection routes (plan doc §25 Phase 4 checklist) ---
  const gcRepo = new PgGcRepository(pool);
  const gcConfig = {
    quotaBytes: assetQuotaBytes,
    reservedKnownGoodBytes: DEFAULT_RESERVED_BYTES,
  };
  await registerGcRoutes(fastify, { repo: gcRepo, storagePath: assetStoragePath, gcConfig, requireAdmin });

  // --- Phase 4 schedules + offline boot (plan doc §18.3, §25 Phase 4 checklist) ---
  const scheduleRepo = new PgScheduleRepository(pool);
  await registerScheduleRoutes(fastify, { repo: scheduleRepo, requireAdmin });

  // Start the scheduler service.
  const scheduler = new SchedulerService({ repo: scheduleRepo });
  scheduler.start();

  // Graceful shutdown: stop scheduler on SIGINT/SIGTERM.
  const shutdown = () => {
    scheduler.stop();
    fastify.close().catch(() => {});
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // --- Phase 2 scene revisions/manifests scaffold (plan doc §10.2, §18.1) ---
  const sceneRepo = new PgSceneRepository(pool);
  await registerSceneRoutes(fastify, {
    repo: sceneRepo,
    assetRepo,
    requireAdmin,
    onAssign: async (scene, deviceId) => {
      const manifest = scene.manifest as Record<string, unknown> | null;
      const legacyPageId = manifest?.legacyPageId;
      const hasWidgetManifest = Array.isArray(manifest?.widgets);
      if ((typeof legacyPageId !== 'string' || legacyPageId.length === 0) && !hasWidgetManifest) {
        throw new Error('scene manifest is neither a visual-editor widget scene nor a legacy page reference');
      }
      const revisionId = typeof legacyPageId === 'string' && legacyPageId.length > 0 ? legacyPageId : scene.id;
      const visualScenePage = hasWidgetManifest ? {
        id: `scene-${scene.id}`,
        name: scene.name,
        panels: [{
          id: `scene-panel-${scene.id}`,
          page_id: `scene-${scene.id}`,
          name: scene.name,
          x: 0, y: 0, w: 100, h: 100,
          content_type: 'scene',
          url: null,
          scene_id: scene.id,
          z_index: 0,
          visible: true,
          opacity: 1,
          position: 0,
        }],
        floating_config: null,
      } : undefined;
      const revision = await setDesiredState(
        stateRepo,
        deviceId,
        'scene',
        { sceneId: scene.id, sceneRevision: scene.revision, revisionId },
        { authorityMode: 'core', provenance: 'core' },
      );
      const result = await gateway.issueSceneState(deviceId, revision, revisionId, visualScenePage);
      const application = (result.payload.application as Record<string, unknown> | undefined)?.scene as
        | { status?: unknown }
        | undefined;
      const rawStatus = application?.status;
      const status: ReportedStatus =
        rawStatus === 'applied' || rawStatus === 'diverged' || rawStatus === 'failed' || rawStatus === 'pending'
          ? rawStatus
          : 'failed';
      await reportState(
        stateRepo,
        deviceId,
        'scene',
        (result.payload.state as Record<string, unknown> | undefined)?.scene ?? { revision_id: revisionId },
        status,
        revision,
      );
      if (status !== 'applied' && status !== 'pending') {
        throw new Error(`Edge reported scene status ${String(rawStatus)}`);
      }
      return { revision, application, result };
    },
  });

  // --- Phase 4 HA entity facade (plan doc §25 Phase 4 checklist) -----------
  const facadeRepo = new PgFacadeRepository(pool);
  const sceneStale: SceneStaleState = ha
    ? watchHaEntityChanges(ha, facadeRepo)
    : { stale: new Set() };
  await registerFacadeRoutes(fastify, {
    repo: facadeRepo,
    haClient: ha,
    sceneStale,
    requireAdmin,
  });

  // API overview at /api (the web UI is served at / by the static file server).
  fastify.get('/api', async () => ({
    status: 'ok',
    role: 'canvas-core',
    version: CORE_VERSION,
    docs: '/health',
    endpoints: {
      health: '/health',
      providers: '/api/providers',
      admin: {
        login: 'POST /api/admin/login',
        devices: '/api/admin/devices',
        scenes: '/api/admin/scenes',
        'audio-focus': '/api/admin/audio-focus',
        shadow: '/api/admin/shadow-mode/status',
        privacy: '/api/admin/privacy',
        storage: '/api/admin/storage/status',
        schedules: '/api/admin/schedules',
        rollout: 'POST /api/admin/rollout/create',
        authority: '/api/admin/authority/status',
        'ai-providers': '/api/admin/ai-providers',
        'mcp-servers': '/api/admin/mcp-servers',
      },
      ha: {
        entities: '/api/ha/entities',
      },
      pairing: {
        begin: 'POST /api/pairing/begin',
        complete: 'POST /api/pairing/complete',
      },
      voice: '/ws/voice',
      device_gateway: '/gateway/v1',
    },
  }));

  // Health + topology self-description (useful for the reverse proxy and ops).
  fastify.get('/health', async () => ({
    status: 'ok',
    role: 'canvas-core',
    version: CORE_VERSION,
    gatewayPath: config.gatewayPath,
  }));

  // --- Phase 5 container health checker (plan doc §14.6, §25 Phase 5 checklist) ---
  const containerConfigs: ProviderContainerConfig[] = [];
  if (config.whisperUrl) {
    containerConfigs.push({
      name: 'asr',
      url: config.whisperUrl,
      healthEndpoint: '/health',
      timeout: 10_000,
      maxRetries: 2,
      containerName: 'localcut-whisper',
    });
  }
  if (config.llmBaseUrl) {
    containerConfigs.push({
      name: 'llm',
      url: config.llmBaseUrl.replace(/\/v1$/, ''),
      healthEndpoint: '/health',
      timeout: 10_000,
      maxRetries: 2,
      containerName: 'llama.cpp',
    });
  }
  if (config.mcpUrl) {
    containerConfigs.push({
      name: 'mcp',
      url: config.mcpUrl,
      healthEndpoint: '/health',
      timeout: 10_000,
      maxRetries: 2,
      containerName: 'mcp-server',
    });
  }
  const containerHealth = new ContainerHealthChecker(containerConfigs);
  containerHealth.start();

  // Provider availability for ops (plan §20.4: inference failure must not crash Core).
  fastify.get('/api/providers', async () => {
    // Run all health checks in parallel; use cached container results (updated every 30s).
    const [providers, haHealth] = await Promise.all([
      intelligence.health(),
      ha ? ha.healthCheck() : Promise.resolve(null),
    ]);
    if (haHealth) providers.push(haHealth);

    // Use cached container results — ContainerHealthChecker polls every 30s in background.
    const containerMap = new Map(
      containerHealth.getCachedResults().map((r) => [r.provider, r]),
    );

    const enhanced = providers.map((p) => {
      const cr = containerMap.get(p.name as 'asr' | 'llm' | 'mcp');
      return {
        ...p,
        latencyMs: cr?.latencyMs ?? undefined,
        lastError: cr?.lastError ?? undefined,
        uptimeMs: cr?.uptimeMs ?? 0,
      };
    });

    return {
      providers: enhanced,
      summary: enhanced.reduce<Record<string, boolean>>((acc, p) => {
        acc[p.name] = p.healthy;
        return acc;
      }, {}),
    };
  });

  // --- Phase 5 privacy routes (plan doc §14.4) ---
  registerPrivacyRoutes(fastify, { repo: privacyRepo, requireAdmin });

  // --- Phase 5 audio-focus status (plan doc §14.5) ---
  fastify.get('/api/admin/audio-focus', { preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }) }, async () => {
    return {
      state: intelligence.audioFocus.getState(),
      duckLevel: intelligence.audioFocus.getDuckLevel(),
    };
  });

  // Voice pipeline scaffold (ASR -> LLM -> TTS). Clearly labeled as early scaffolding.
  // Accepts { audioBase64 } or { transcript }; returns { transcript, reply, audioBase64 }.
  const runVoicePipelineRequest = async (
    request: { body: unknown },
    reply: { code: (statusCode: number) => unknown },
  ) => {
    const body = request.body as
      | { audioBase64?: string; transcript?: string; systemPrompt?: string; language?: string; skipTts?: boolean }
      | undefined;
    if (!body || (typeof body.audioBase64 !== 'string' && typeof body.transcript !== 'string')) {
      reply.code(400);
      return { error: 'Provide audioBase64 or transcript' };
    }
    try {
      const audio = typeof body.audioBase64 === 'string' ? Buffer.from(body.audioBase64, 'base64') : undefined;
      const result = await intelligence.runVoicePipeline({
        audio,
        transcript: typeof body.transcript === 'string' ? body.transcript : undefined,
        systemPrompt: body.systemPrompt,
        language: body.language,
        skipTts: body.skipTts,
      });
      return result;
    } catch (err) {
      reply.code(502);
      return { error: 'voice pipeline failed', detail: (err as Error).message };
    }
  };

  fastify.post(
    '/api/voice/pipeline',
    { preHandler: requireAdmin({ roles: ['admin', 'voice'], csrf: false }) },
    runVoicePipelineRequest,
  );

  // --- Edge voice token management -------------------------------------------
  // If CANVAS_CORE_EDGE_VOICE_TOKEN is set in env, it's always used.
  // Otherwise the core auto-provisions the token from the FIRST connecting edge
  // device and persists it in the settings table. This zero-config approach
  // means you don't need to manually sync tokens between core and edge devices.
  async function resolveEdgeVoiceToken(presented: string): Promise<string | null> {
    // Env var overrides everything
    if (config.edgeVoiceToken) return config.edgeVoiceToken;
    // Check DB for a previously stored token
    const row = await pool.query<{ value: string }>(
      'SELECT value FROM settings WHERE key = $1', ['edge_voice_token'],
    );
    if (row.rowCount && row.rows[0]?.value) return row.rows[0].value;
    // No token configured — auto-capture from first connecting edge device
    if (presented && presented.length >= 16) {
      await pool.query(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()',
        ['edge_voice_token', presented],
      );
      console.log(`[core][voice] Auto-provisioned edge voice token from first connecting edge device (prefix: ${presented.slice(0, 8)}...)`);
      return presented;
    }
    return null;
  }

  function checkEdgeVoiceAuth(expected: string | null, presented: string): boolean {
    if (!expected || !presented) return false;
    if (presented.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
  }

  // Admin endpoint to view/reset the edge voice bridge token
  fastify.get('/api/admin/voice-bridge', {
    preHandler: requireAdmin({ roles: ['admin'] }),
  }, async () => {
    const envToken = config.edgeVoiceToken;
    const row = await pool.query<{ value: string }>(
      'SELECT value FROM settings WHERE key = $1', ['edge_voice_token'],
    );
    const dbToken = row.rows[0]?.value ?? null;
    const active = envToken ?? dbToken;
    return {
      configured: Boolean(active),
      source: envToken ? 'env' : dbToken ? 'db' : 'none',
      token: active ?? null,
      coreUrl: `http://${fastify.server.address() ? (fastify.server.address() as import('net').AddressInfo).address : 'localhost'}:${config.port}`,
    };
  });

  // --- YouTube login cookies (Netscape format) for an authenticated / ad-free session.Authoritative
  //     value comes from the DB so it can be set at runtime; env `YOUTUBE_COOKIES` is the bootstrap. ---
  const getYoutubeCookies = async (): Promise<string> => {
    const row = await pool.query<{ value: string }>(
      'SELECT value FROM settings WHERE key = $1', ['youtube_cookies'],
    );
    const db = row.rows[0]?.value ?? '';
    return db || config.youtubeCookies || '';
  };

  fastify.get('/api/admin/youtube/cookies', {
    preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }),
  }, async () => ({ cookies: await getYoutubeCookies() }));

  fastify.put('/api/admin/youtube/cookies', {
    preHandler: requireAdmin({ roles: ['admin'], csrf: true }),
  }, async (request) => {
    const body = request.body as { cookies?: string } | undefined;
    const cookies = (body?.cookies ?? '').trim();
    await pool.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()',
      ['youtube_cookies', cookies],
    );
    return { ok: true, stored: cookies.length > 0 };
  });

  // --- Piper TTS voice selection (per-request Wyoming voice) ---
  const PIPER_VOICES = [
    'en_US-lessac-medium', 'en_US-ryan-medium', 'en_US-norman-medium', 'en_US-bryce-medium',
    'en_GB-alan-low', 'en_GB-cori-medium', 'en_US-ljspeech-medium', 'jarvis-high',
  ];

  const getPiperVoice = async (): Promise<string> => {
    const row = await pool.query<{ value: string }>(
      'SELECT value FROM settings WHERE key = $1', ['piper_voice'],
    );
    const db = row.rows[0]?.value ?? '';
    return db || config.piperVoice || 'en_US-lessac-medium';
  };

  fastify.get('/api/admin/piper/voice', {
    preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }),
  }, async () => {
    let voices = PIPER_VOICES;
    try {
      const discovered = await intelligence.providers.tts?.listVoices?.();
      if (discovered && discovered.length > 0) voices = [...discovered].sort();
    } catch { /* keep the curated fallback list */ }
    return { voice: await getPiperVoice(), voices };
  });

  fastify.put('/api/admin/piper/voice', {
    preHandler: requireAdmin({ roles: ['admin'], csrf: true }),
  }, async (request) => {
    const body = request.body as { voice?: string } | undefined;
    const voice = (body?.voice ?? '').trim();
    await pool.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()',
      ['piper_voice', voice],
    );
    intelligence.providers.tts?.setVoice?.(voice || undefined);
    return { ok: true, voice: voice || null };
  });

  // --- Per-device page roles (home / weather / news / custom) used by the voice assistant ---
  fastify.get('/api/admin/devices/:id/page-roles', {
    preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }),
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await pool.query('SELECT page_roles FROM devices WHERE id = $1', [id]);
    if (row.rowCount === 0) {
      reply.code(404);
      return { error: 'device_not_found' };
    }
    return { deviceId: id, pageRoles: row.rows[0]?.page_roles ?? {} };
  });

  fastify.put('/api/admin/devices/:id/page-roles', {
    preHandler: requireAdmin({ roles: ['admin'], csrf: true }),
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { pageRoles?: Record<string, string> } | undefined;
    const roles = body?.pageRoles ?? {};
    const exists = await pool.query('SELECT 1 FROM devices WHERE id = $1', [id]);
    if (exists.rowCount === 0) {
      reply.code(404);
      return { error: 'device_not_found' };
    }
    await pool.query('UPDATE devices SET page_roles = $2 WHERE id = $1', [id, JSON.stringify(roles)]);
    return { ok: true, deviceId: id, pageRoles: roles };
  });

  // --- Remotely show / hide / restart an edge app (Android or Linux) ---
  fastify.post('/api/admin/devices/:id/app', {
    preHandler: requireAdmin({ roles: ['admin'], csrf: true }),
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { action?: string } | undefined;
    const action = body?.action;
    if (action !== 'show' && action !== 'hide' && action !== 'restart') {
      reply.code(400);
      return { error: "action must be 'show', 'hide' or 'restart'" };
    }
    const archRow = await pool.query('SELECT architecture FROM devices WHERE id = $1', [id]);
    if (archRow.rowCount === 0) {
      reply.code(404);
      return { error: 'device_not_found' };
    }
    const architecture = String(archRow.rows[0]?.architecture ?? '').toLowerCase();
    let result: unknown;
    if (gateway.isConnected(id)) {
      result = await gateway.requestAction(id, `app.${action}`, {});
    } else {
      result = await requestDeviceAction(id, 'device_http', {
        path: `/api/app/${action}`,
        http_method: 'POST',
        body: {},
      }, 15_000);
    }
    // Log the device's own report so the Core log shows what the edge app did (or
    // whether it timed out), not just that the HTTP request arrived.
    if (result && typeof result === 'object' && 'ok' in result && (result as { ok?: unknown }).ok !== true) {
      reply.code(409);
      return { ok: false, deviceId: id, action, result };
    }
    request.log.info({ deviceId: id, architecture, action, result }, 'edge app action completed');
    return { ok: true, deviceId: id, action, result };
  });

  // --- Knowledge/search page display timeout (auto-dismiss on the originating edge device) ---
  const getKnowledgeDisplaySeconds = async (): Promise<number> => {
    const row = await pool.query<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'knowledge_display_seconds'",
    );
    const raw = row.rows[0]?.value;
    const db = raw != null && raw !== '' ? Number(raw) : NaN;
    return Number.isFinite(db) && db >= 0 ? db : config.knowledgeDisplaySeconds;
  };

  fastify.get('/api/admin/knowledge-display', {
    preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }),
  }, async () => ({ seconds: await getKnowledgeDisplaySeconds() }));

  fastify.put('/api/admin/knowledge-display', {
    preHandler: requireAdmin({ roles: ['admin'], csrf: true }),
  }, async (request) => {
    const body = request.body as { seconds?: number } | undefined;
    const seconds = Math.max(0, Math.round(body?.seconds ?? 0));
    await pool.query(
      "INSERT INTO settings (key, value) VALUES ('knowledge_display_seconds', $1) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=now()",
      [String(seconds)],
    );
    return { ok: true, seconds };
  });

  // --- Ad-free YouTube player: core resolves direct streams (yt-dlp + Premium cookies)
  //     and serves one shared HTML5 <video> player page for every edge device. ---
  const YOUTUBE_PLAYER_PAGE =
    '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>body{margin:0;background:#000}video{width:100vw;height:100vh;object-fit:contain}</style></head>' +
    '<body><video id="v" controls autoplay playsinline></video>' +
    '<script>var u=__URLS__;var i=0;var v=document.getElementById("v");' +
    'function n(){if(i<u.length){v.src=u[i];v.play().catch(function(){});i++;}}v.onended=n;n();</script>' +
    '</body></html>';

  type YouTubeStreamEntry = { urls: string[]; expiresAt: number };
  const youtubeStreamEntries = new Map<string, YouTubeStreamEntry>();

  function storeYouTubeStreams(urls: string[]): string {
    const id = randomUUID().slice(0, 12);
    youtubeStreamEntries.set(id, { urls, expiresAt: Date.now() + 6 * 60 * 60_000 });
    return id;
  }

  async function writeYoutubeCookiesFile(cookies: string): Promise<string> {
    const file = `/tmp/youtube-cookies-${process.pid}.txt`;
    await import('node:fs/promises').then((fs) => fs.writeFile(file, cookies, { mode: 0o600 }));
    return file;
  }

  fastify.get('/media/youtube/player/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const entry = youtubeStreamEntries.get(id);
    if (!entry || entry.expiresAt < Date.now()) {
      reply.type('text/html').send(
        '<!doctype html><html><body style="background:#000;color:#fff;font-family:sans-serif;display:grid;place-items:center;height:100vh">This video stream expired.</body></html>',
      );
      return;
    }
    reply.type('text/html').send(YOUTUBE_PLAYER_PAGE.replace('__URLS__', JSON.stringify(entry.urls)));
  });

  // Device-facing voice config (public, no admin session — an Edge device only knows its
  // own id). Lets any Edge (e.g. the Android native client) fetch its wake-word settings
  // and the shared voice bridge token entirely from Core, instead of configuring them
  // locally on-device. Mirrors the admin-editable `devices.voice_config`/`audio_config`
  // columns set by `PUT /api/admin/devices/:id/voice`.
  fastify.get<{ Params: { id: string } }>('/api/devices/:id/voice-config', async (request, reply) => {
    const { id } = request.params;
    const res = await pool.query<{ voice_config: Record<string, unknown> | null; audio_config: Record<string, unknown> | null }>(
      'SELECT voice_config, audio_config FROM devices WHERE id = $1', [id],
    );
    if (res.rowCount === 0) {
      reply.code(404);
      return { error: 'device_not_found' };
    }
    const voice = res.rows[0].voice_config ?? {};
    const audio = res.rows[0].audio_config ?? {};
    const token = await resolveEdgeVoiceToken('');
    return {
      wake_word: voice.wake_word ?? 'hey_jarvis',
      wake_threshold: voice.wake_threshold ?? 0.5,
      wake_enabled: voice.wake_enabled ?? false,
      wake_ack_enabled: voice.wake_ack_enabled ?? true,
      wake_ack_sound: voice.wake_ack_sound ?? 'builtin:ready_up',
      good_intent_enabled: voice.good_intent_enabled ?? true,
      good_intent_sound: voice.good_intent_sound ?? 'builtin:digital_pop',
      no_intent_enabled: voice.no_intent_enabled ?? true,
      no_intent_sound: voice.no_intent_sound ?? 'builtin:wood_tap',
      mic_device: audio.mic_device ?? 'default',
      edge_voice_token: token,
    };
  });

  // Broadcast (record → store → fan-out). The store + pending map live here so
  // the voice-turn endpoint can use them; the fan-out itself is wired after the
  // gateway/MQTT services exist (below).
  const broadcastStore = new BroadcastStore();
  const pendingBroadcasts = new Map<string, number>();
  let broadcastFanOutRef: ((clip: BroadcastClip) => Promise<{ edges: number; ha: number }>) | null = null;

  fastify.post('/api/edge/voice/turn', async (request, reply) => {
    const header = request.headers.authorization;
    const presented = header?.startsWith('Bearer ') ? header.slice(7) : '';
    const expected = await resolveEdgeVoiceToken(presented);
    if (!checkEdgeVoiceAuth(expected, presented)) {
      reply.code(401);
      return { error: 'invalid_edge_voice_credential' };
    }
    const body = request.body as
      | {
          audioBase64?: string;
          transcript?: string;
          systemPrompt?: string;
          language?: string;
          skipTts?: boolean;
          deviceId?: string;
          turnId?: string;
        }
      | undefined;
    if (!body || (typeof body.audioBase64 !== 'string' && typeof body.transcript !== 'string')) {
      reply.code(400);
      return { error: 'Provide audioBase64 or transcript' };
    }
    const deviceId = typeof body.deviceId === 'string' && body.deviceId.trim()
      ? body.deviceId.trim()
      : 'unknown';
    const turnId = typeof body.turnId === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(body.turnId)
      ? body.turnId
      : 'untracked';
    try {
      console.log(`[core][voice:${deviceId}] turn received turn=${turnId}`);
      // Broadcast: "broadcast" arms a recording; the next turn's audio is stored
      // and fanned out to every display + media player instead of transcribed.
      const armedAt = pendingBroadcasts.get(deviceId);
      if (armedAt && Date.now() - armedAt < 60_000 && typeof body.audioBase64 === 'string') {
        pendingBroadcasts.delete(deviceId);
        const buffer = Buffer.from(body.audioBase64, 'base64');
        const clip = broadcastStore.add(buffer, 'audio/wav', `Broadcast from ${deviceId}`);
        const fanout = broadcastFanOutRef ? await broadcastFanOutRef(clip) : { edges: 0, ha: 0 };
        const replyText = `Broadcast sent to ${fanout.edges} display${fanout.edges === 1 ? '' : 's'} and ${fanout.ha} media player${fanout.ha === 1 ? '' : 's'}.`;
        return {
          transcript: '', reply: replyText, degraded: false,
          intent: { intent: 'broadcast_sent', confidence: 1, entities: [], tool_calls: [], clarification_needed: false, response: replyText },
          deviceId, turnId,
        };
      }
      if (typeof body.transcript === 'string' && /^\s*(?:hey\s+\w+\s+)?broadcast\b/i.test(body.transcript)) {
        pendingBroadcasts.set(deviceId, Date.now());
        const replyText = 'What do you want to broadcast?';
        return {
          transcript: body.transcript, reply: replyText, degraded: false,
          intent: { intent: 'broadcast_start', confidence: 1, entities: [], tool_calls: [], clarification_needed: false, response: replyText },
          deviceId, turnId,
        };
      }
      // Load last 5 turns for conversational context
      const historyRows = await pool.query<{ transcript: string; reply: string }>(
        `SELECT transcript, reply FROM voice_turns WHERE device_id=$1 AND transcript IS NOT NULL AND reply IS NOT NULL ORDER BY created_at DESC LIMIT 5`,
        [deviceId],
      );
      const conversationHistory = historyRows.rows.reverse();
      const result = await intelligence.runIntelligentPipeline({
        audio: typeof body.audioBase64 === 'string' ? Buffer.from(body.audioBase64, 'base64') : undefined,
        transcript: typeof body.transcript === 'string' ? body.transcript : undefined,
        systemPrompt: body.systemPrompt,
        language: body.language,
        skipTts: body.skipTts,
        originDeviceId: deviceId,
        conversationHistory,
      });
      console.log(
        `[core][voice:${deviceId}] turn complete turn=${turnId} intent=${result.intent.intent} ` +
        `asr_ms=${result.timings?.asrMs ?? -1} routing_ms=${result.timings?.routingMs ?? -1} ` +
        `planning_ms=${result.timings?.planningMs ?? -1} tts_ms=${result.timings?.ttsMs ?? -1} ` +
        `total_ms=${result.timings?.totalMs ?? -1}`,
      );
      return { ...result, deviceId, turnId };
    } catch (err) {
      console.error(`[core][voice:${deviceId}] turn failed turn=${turnId}:`, err);
      reply.code(502);
      return { error: 'voice pipeline failed', detail: (err as Error).message, deviceId };
    }
  });

  fastify.post('/api/edge/voice/metrics', async (request, reply) => {
    const header = request.headers.authorization;
    const presented = header?.startsWith('Bearer ') ? header.slice(7) : '';
    const expected = await resolveEdgeVoiceToken(presented);
    if (!checkEdgeVoiceAuth(expected, presented)) {
      reply.code(401);
      return { error: 'invalid_edge_voice_credential' };
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const turnId = typeof body.turnId === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(body.turnId) ? body.turnId : '';
    const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
    if (!turnId || !deviceId) { reply.code(400); return { error: 'invalid_voice_metrics' }; }
    const exists = await pool.query('SELECT 1 FROM devices WHERE id=$1', [deviceId]);
    if (!exists.rowCount) { reply.code(404); return { error: 'device_not_found' }; }
    const metric = (name: string): number | null => {
      const value = Number(body[name]);
      return Number.isFinite(value) ? Math.max(0, Math.min(600_000, Math.round(value))) : null;
    };
    await pool.query(
      `INSERT INTO voice_turn_metrics
       (turn_id,device_id,intent,capture_ms,asr_ms,routing_ms,planning_ms,tts_ms,core_round_trip_ms,first_playback_ms,playback_ms,total_ms)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT(turn_id) DO UPDATE SET
       capture_ms=EXCLUDED.capture_ms,asr_ms=EXCLUDED.asr_ms,routing_ms=EXCLUDED.routing_ms,
       planning_ms=EXCLUDED.planning_ms,tts_ms=EXCLUDED.tts_ms,core_round_trip_ms=EXCLUDED.core_round_trip_ms,
       first_playback_ms=EXCLUDED.first_playback_ms,playback_ms=EXCLUDED.playback_ms,total_ms=EXCLUDED.total_ms`,
      [turnId, deviceId, typeof body.intent === 'string' ? body.intent.slice(0, 80) : null,
        metric('captureMs'), metric('asrMs'), metric('routingMs'), metric('planningMs'), metric('ttsMs'),
        metric('coreRoundTripMs'), metric('firstPlaybackMs'), metric('playbackMs'), metric('totalMs')],
    );
    return { ok: true };
  });

  fastify.post('/api/edge/voice/turn-stream', async (request, reply) => {
    const header = request.headers.authorization;
    const presented = header?.startsWith('Bearer ') ? header.slice(7) : '';
    const expected = await resolveEdgeVoiceToken(presented);
    if (!checkEdgeVoiceAuth(expected, presented)) {
      reply.code(401); return { error: 'invalid_edge_voice_credential' };
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const deviceId = typeof body.deviceId === 'string' && body.deviceId.trim() ? body.deviceId.trim() : 'unknown';
    const turnId = typeof body.turnId === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(body.turnId) ? body.turnId : 'untracked';
    if (typeof body.audioBase64 !== 'string' && typeof body.transcript !== 'string') {
      reply.code(400); return { error: 'Provide audioBase64 or transcript' };
    }
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'transfer-encoding': 'chunked' });
    const emit = (value: object) => reply.raw.write(`${JSON.stringify(value)}\n`);
    try {
      console.log(`[core][voice:${deviceId}] streaming turn received turn=${turnId}`);
      let streamedChunks = 0;
      let streamedTtsMs = 0;
      const speech = intelligence.providers.tts;
      // Load last 5 turns for conversational context
      const historyRows = await pool.query<{ transcript: string; reply: string }>(
        `SELECT transcript, reply FROM voice_turns WHERE device_id=$1 AND transcript IS NOT NULL AND reply IS NOT NULL ORDER BY created_at DESC LIMIT 5`,
        [deviceId],
      );
      const conversationHistory = historyRows.rows.reverse();
      const result = await intelligence.runIntelligentPipeline({
        audio: typeof body.audioBase64 === 'string' ? Buffer.from(body.audioBase64, 'base64') : undefined,
        transcript: typeof body.transcript === 'string' ? body.transcript : undefined,
        originDeviceId: deviceId,
        skipTts: true,
        conversationHistory,
        onTranscript: (transcript) => { emit({ type: 'transcript', transcript }); },
        onReplyChunk: speech ? async (text) => {
          const started = performance.now();
          const audio = await speech.synthesize(text);
          streamedTtsMs += performance.now() - started;
          emit({ type: 'audio', index: streamedChunks++, audioBase64: audio.toString('base64') });
        } : undefined,
      });
      emit({ type: 'meta', turnId, transcript: result.transcript, reply: result.reply, intent: result.intent, timings: result.timings, knowledge_card: result.knowledge_card ?? null, show_url: result.knowledge_card?.show_url ?? null });
      // Save full voice turn asynchronously
      void pool.query(
        `INSERT INTO voice_turns (turn_id, device_id, transcript, reply, intent, knowledge_card)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT(turn_id) DO NOTHING`,
        [turnId, deviceId, result.transcript ?? null, result.reply ?? null,
         result.intent?.intent ?? null,
         result.knowledge_card ? JSON.stringify(result.knowledge_card) : null],
      ).catch((err: Error) => console.warn('[core][voice] Failed to save voice turn:', err.message));
      const mediaStarted = ['media_play', 'media_select', 'media_resume', 'media_next'].includes(result.intent.intent)
        && result.toolResult?.ok === true;
      let ttsMs = streamedTtsMs;
      if (speech && result.reply && !mediaStarted && streamedChunks === 0) {
        const chunks = result.reply.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map(part => part.trim()).filter(Boolean) ?? [result.reply];
        for (let index = 0; index < chunks.length; index++) {
          const started = performance.now();
          const audio = await speech.synthesize(chunks[index]);
          ttsMs += performance.now() - started;
          emit({ type: 'audio', index, audioBase64: audio.toString('base64') });
        }
      }
      emit({ type: 'end', ttsMs: Math.round(ttsMs) });
      console.log(`[core][voice:${deviceId}] streaming turn complete turn=${turnId} intent=${result.intent.intent} chunks_tts_ms=${Math.round(ttsMs)}`);
    } catch (error) {
      emit({ type: 'error', error: error instanceof Error ? error.message : String(error) });
    } finally {
      reply.raw.end();
    }
  });

  // --- TTS Broadcast (multi-room audio) ------------------------------------
  // Core synthesizes TTS and stores it per-device. Display devices poll
  // GET /api/edge/tts/pending to pick up and play queued audio.
  // Exposed to the flow executor via closure.
  let flowEnqueueTts: ((text: string, deviceId?: string) => Promise<void>) | null = null;
  let flowBroadcastAlert: ((title: string, message: string, type?: string, deviceIds?: string[]) => void) | null = null;
  {
    const pendingTts = new Map<string, { audioBase64?: string; text: string; timestamp: string }>();
    const ALL_DEVICES = '__all__';

    // Expose TTS queue to flow executor
    flowEnqueueTts = async (text: string, deviceId?: string) => {
      const speech = intelligence.providers.tts;
      const key = deviceId ?? ALL_DEVICES;
      if (speech) {
        // Core has a TTS provider — synthesize and queue audio
        const audio = await speech.synthesize(text.trim());
        pendingTts.set(key, { audioBase64: audio.toString('base64'), text: text.trim(), timestamp: new Date().toISOString() });
      } else {
        // No Core TTS — queue text only; the sidecar will synthesize locally via Piper
        pendingTts.set(key, { text: text.trim(), timestamp: new Date().toISOString() });
      }
    };

    fastify.post<{ Body: { text?: string; deviceIds?: string[] } }>(
      '/api/edge/tts/broadcast',
      async (request, reply) => {
        const header = request.headers.authorization;
        const presented = header?.startsWith('Bearer ') ? header.slice(7) : '';
        const expected = await resolveEdgeVoiceToken(presented);
        if (!checkEdgeVoiceAuth(expected, presented)) {
          return reply.code(401).send({ error: 'invalid_edge_voice_credential' });
        }
        const { text, deviceIds } = request.body ?? {};
        if (!text?.trim()) {
          return reply.code(400).send({ error: 'text is required' });
        }
        const speech = intelligence.providers.tts;
        if (!speech) {
          return reply.code(503).send({ error: 'TTS provider not configured' });
        }
        const audio = await speech.synthesize(text.trim());
        const audioBase64 = audio.toString('base64');
        const timestamp = new Date().toISOString();
        const targets = deviceIds?.length ? deviceIds : [ALL_DEVICES];
        for (const id of targets) {
          pendingTts.set(id, { audioBase64, text: text.trim(), timestamp });
        }
        console.log(`[core][tts-broadcast] queued "${text.trim().slice(0, 60)}" for ${targets.join(',')}`);
        return reply.send({ ok: true, targets, timestamp });
      },
    );

    fastify.get<{ Querystring: { deviceId?: string } }>(
      '/api/edge/tts/pending',
      async (request, reply) => {
        const header = request.headers.authorization;
        const presented = header?.startsWith('Bearer ') ? header.slice(7) : '';
        const expected = await resolveEdgeVoiceToken(presented);
        if (!checkEdgeVoiceAuth(expected, presented)) {
          return reply.code(401).send({ error: 'invalid_edge_voice_credential' });
        }
        const deviceId = request.query.deviceId ?? 'unknown';
        const entry = pendingTts.get(deviceId) ?? pendingTts.get(ALL_DEVICES);
        if (!entry) return reply.send({ empty: true });
        pendingTts.delete(deviceId);
        if (pendingTts.get(ALL_DEVICES) === entry) pendingTts.delete(ALL_DEVICES);
        return reply.send(entry);
      },
    );
  }

  // --- Voice turns: interaction memory + feedback --------------------------

  // POST /api/voice/feedback — record user rating for a voice turn
  fastify.post<{ Body: { turnId?: string; deviceId?: string; rating?: number } }>(
    '/api/voice/feedback',
    async (request, reply) => {
      const header = request.headers.authorization;
      const presented = header?.startsWith('Bearer ') ? header.slice(7) : '';
      const expected = await resolveEdgeVoiceToken(presented);
      if (!checkEdgeVoiceAuth(expected, presented)) {
        return reply.code(401).send({ error: 'invalid_edge_voice_credential' });
      }
      const { turnId, rating } = request.body ?? {};
      if (!turnId || (rating !== 1 && rating !== -1)) {
        return reply.code(400).send({ error: 'Provide turnId and rating (1 or -1)' });
      }
      await pool.query(
        `UPDATE voice_turns SET feedback=$1, feedback_at=now() WHERE turn_id=$2`,
        [rating, turnId],
      );
      console.log(`[core][voice] Feedback turn=${turnId} rating=${rating}`);
      return { ok: true };
    },
  );

  // GET /api/voice/turns — recent voice turns (admin)
  fastify.get<{ Querystring: { deviceId?: string; limit?: string } }>(
    '/api/voice/turns',
    { preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }) },
    async (request) => {
      const deviceId = request.query.deviceId;
      const limit = Math.min(200, Math.max(1, parseInt(request.query.limit ?? '50', 10) || 50));
      const result = deviceId
        ? await pool.query(
            `SELECT turn_id, device_id, transcript, reply, intent, knowledge_card, feedback, feedback_at, created_at
             FROM voice_turns WHERE device_id=$1 ORDER BY created_at DESC LIMIT $2`,
            [deviceId, limit],
          )
        : await pool.query(
            `SELECT turn_id, device_id, transcript, reply, intent, knowledge_card, feedback, feedback_at, created_at
             FROM voice_turns ORDER BY created_at DESC LIMIT $1`,
            [limit],
          );
      return { turns: result.rows, total: result.rowCount ?? 0 };
    },
  );

  // GET /api/knowledge-card/latest - latest AI knowledge card for display polling.
  fastify.get('/api/knowledge-card/latest', async (_request, reply) => {
    const result = await pool.query<{ knowledge_card: unknown; created_at: Date }>(
      `SELECT knowledge_card, created_at
       FROM voice_turns
       WHERE knowledge_card IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 1`,
    );
    const row = result.rows[0];
    if (!row) return reply.send({ empty: true });

    const raw = row.knowledge_card;
    let parsed: Record<string, unknown> | null = null;
    if (raw && typeof raw === 'object') {
      parsed = raw as Record<string, unknown>;
    } else if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }
    if (!parsed) return reply.send({ empty: true });

    const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
    const body = typeof parsed.body === 'string' ? parsed.body.trim() : '';
    if (!title || !body) return reply.send({ empty: true });

    const timestamp = row.created_at instanceof Date
      ? row.created_at.toISOString()
      : new Date(row.created_at).toISOString();
    const age = Date.now() - new Date(timestamp).getTime();
    if (!Number.isFinite(age) || age > 90_000) return reply.send({ empty: true });

    return reply.send({
      title,
      body,
      source_url: typeof parsed.source_url === 'string' ? parsed.source_url : undefined,
      source_label: typeof parsed.source_label === 'string' ? parsed.source_label : undefined,
      image_url: typeof parsed.image_url === 'string' ? parsed.image_url : undefined,
      show_url: typeof parsed.show_url === 'string' ? parsed.show_url : undefined,
      timestamp,
    });
  });

  // --- Alert Broadcast (push overlays to display devices) -------------------
  // Display devices poll GET /api/edge/alert/pending, display shows AnnouncementWidget alert.
  {
    type PendingAlert = { title: string; message: string; type: string; camera_entity?: string; timestamp: string };
    const pendingAlerts = new Map<string, PendingAlert>();
    const ALL_ALERT_DEVICES = '__all__';

    flowBroadcastAlert = (title, message, type = 'info', deviceIds) => {
      const timestamp = new Date().toISOString();
      const alert: PendingAlert = { title, message, type, timestamp };
      const targets = deviceIds?.length ? deviceIds : [ALL_ALERT_DEVICES];
      for (const id of targets) pendingAlerts.set(id, alert);
      console.log(`[core][alert-broadcast] flow queued "${message.slice(0, 60)}" for ${targets.join(',')}`);
    };

    fastify.post<{ Body: { title?: string; message?: string; type?: string; camera_entity?: string; deviceIds?: string[] } }>(
      '/api/edge/alert/broadcast',
      async (request, reply) => {
        const header = request.headers.authorization;
        const presented = header?.startsWith('Bearer ') ? header.slice(7) : '';
        const expected = await resolveEdgeVoiceToken(presented);
        if (!checkEdgeVoiceAuth(expected, presented)) {
          return reply.code(401).send({ error: 'invalid_edge_voice_credential' });
        }
        const { title = 'Alert', message = '', type = 'info', camera_entity, deviceIds } = request.body ?? {};
        if (!message) return reply.code(400).send({ error: 'message is required' });
        const timestamp = new Date().toISOString();
        const alert: PendingAlert = { title, message, type, camera_entity, timestamp };
        const targets = deviceIds?.length ? deviceIds : [ALL_ALERT_DEVICES];
        for (const id of targets) pendingAlerts.set(id, alert);
        console.log(`[core][alert-broadcast] queued "${message.slice(0, 60)}" for ${targets.join(',')}`);
        return reply.send({ ok: true, targets, timestamp });
      },
    );

    fastify.get<{ Querystring: { deviceId?: string } }>(
      '/api/edge/alert/pending',
      async (request, reply) => {
        const header = request.headers.authorization;
        const presented = header?.startsWith('Bearer ') ? header.slice(7) : '';
        const expected = await resolveEdgeVoiceToken(presented);
        if (!checkEdgeVoiceAuth(expected, presented)) {
          return reply.code(401).send({ error: 'invalid_edge_voice_credential' });
        }
        const deviceId = request.query.deviceId ?? 'unknown';
        const entry = pendingAlerts.get(deviceId) ?? pendingAlerts.get(ALL_ALERT_DEVICES);
        if (!entry) return reply.send({ empty: true });
        pendingAlerts.delete(deviceId);
        if (pendingAlerts.get(ALL_ALERT_DEVICES) === entry) pendingAlerts.delete(ALL_ALERT_DEVICES);
        return reply.send(entry);
      },
    );

    // Doorbell automation: when a HA binary_sensor with device_class=doorbell
    // transitions to 'on', broadcast TTS + alert to all connected display devices.
    if (ha) {
      const doorbellCooldownMs = 10_000;
      const lastDoorbellFire = new Map<string, number>();
      let lastAnyDoorbellFire = 0;
      ha.onEntityChange((entityId, entity) => {
        const attrs = entity.attributes as Record<string, unknown> | undefined ?? {};
        const lowerEntityId = entityId.toLowerCase();
        const hasDoorbellClass = attrs.device_class === 'doorbell';
        const isDoorbellBinarySensor =
          lowerEntityId.startsWith('binary_sensor.') && lowerEntityId.includes('doorbell');
        const isDoorbellEntity = (hasDoorbellClass || isDoorbellBinarySensor) && entity.state === 'on';
        if (!isDoorbellEntity) return;
        const now = Date.now();
        if (now - lastAnyDoorbellFire < doorbellCooldownMs) return; // global debounce across related entities
        const lastFire = lastDoorbellFire.get(entityId) ?? 0;
        if (now - lastFire < doorbellCooldownMs) return; // debounce
        lastAnyDoorbellFire = now;
        lastDoorbellFire.set(entityId, now);

        const friendlyName = (attrs.friendly_name as string | undefined) ?? entityId;
        const title = 'Doorbell';
        const message = `${friendlyName} — someone is at the door`;
        const timestamp = new Date().toISOString();
        const alert: PendingAlert = { title, message, type: 'warning', timestamp };
        pendingAlerts.set(ALL_ALERT_DEVICES, alert);
        console.log(`[core][doorbell] Detected: ${entityId}, broadcasting alert`);

        // Also broadcast TTS
        const speech = intelligence.providers.tts;
        if (speech) {
          void (async () => {
            try {
              const port = config.port ?? 3100;
              const token = await resolveEdgeVoiceToken('');
              if (!token) return;
              await fetch(`http://127.0.0.1:${port}/api/edge/tts/broadcast`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ text: 'Someone is at the door' }),
              });
            } catch (err) {
              console.warn('[core][doorbell] TTS broadcast failed:', (err as Error).message);
            }
          })();
        }
      });
    }
  }

  // --- Device-to-device Intercom -------------------------------------------
  // Any device (or admin) can broadcast audio to one or all display devices.
  {
    type PendingIntercom = { audioBase64: string; from: string; timestamp: string };
    const pendingIntercom = new Map<string, PendingIntercom>();
    const ALL_INTERCOM = '__all__';

    fastify.post<{ Body: { audioBase64?: string; text?: string; from?: string; targetDeviceIds?: string[] } }>(
      '/api/edge/intercom/broadcast',
      async (request, reply) => {
        const header = request.headers.authorization;
        const presented = header?.startsWith('Bearer ') ? header.slice(7) : '';
        const expected = await resolveEdgeVoiceToken(presented);
        if (!checkEdgeVoiceAuth(expected, presented)) {
          return reply.code(401).send({ error: 'invalid_edge_voice_credential' });
        }
        const { audioBase64, text, from = 'system', targetDeviceIds } = request.body ?? {};
        let audio = audioBase64;
        if (!audio && text) {
          const speech = intelligence.providers.tts;
          if (!speech) return reply.code(503).send({ error: 'TTS not configured' });
          const buf = await speech.synthesize(text);
          audio = buf.toString('base64');
        }
        if (!audio) return reply.code(400).send({ error: 'audioBase64 or text required' });
        const timestamp = new Date().toISOString();
        const entry: PendingIntercom = { audioBase64: audio, from, timestamp };
        const targets = targetDeviceIds?.length ? targetDeviceIds : [ALL_INTERCOM];
        for (const id of targets) pendingIntercom.set(id, entry);
        console.log(`[core][intercom] queued audio from=${from} targets=${targets.join(',')}`);
        return reply.send({ ok: true, targets, timestamp });
      },
    );

    fastify.get<{ Querystring: { deviceId?: string } }>(
      '/api/edge/intercom/pending',
      async (request, reply) => {
        const header = request.headers.authorization;
        const presented = header?.startsWith('Bearer ') ? header.slice(7) : '';
        const expected = await resolveEdgeVoiceToken(presented);
        if (!checkEdgeVoiceAuth(expected, presented)) {
          return reply.code(401).send({ error: 'invalid_edge_voice_credential' });
        }
        const deviceId = request.query.deviceId ?? 'unknown';
        const entry = pendingIntercom.get(deviceId) ?? pendingIntercom.get(ALL_INTERCOM);
        if (!entry) return reply.send({ empty: true });
        pendingIntercom.delete(deviceId);
        if (pendingIntercom.get(ALL_INTERCOM) === entry) pendingIntercom.delete(ALL_INTERCOM);
        return reply.send(entry);
      },
    );
  }

  // --- Skill suggestions (pattern-based self-learning) ---------------------
  fastify.get<{ Querystring: { limit?: string } }>(
    '/api/skills/suggestions',
    { preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }) },
    async (request) => {
      const limit = Math.min(20, Math.max(1, parseInt(request.query.limit ?? '10', 10) || 10));
      // Find intents that appear >= 3 times with no matching enabled skill
      const result = await pool.query(`
        SELECT intent, COUNT(*) AS count,
               MAX(created_at) AS last_seen,
               AVG(CASE WHEN feedback = 1 THEN 1 WHEN feedback = -1 THEN -1 ELSE 0 END) AS avg_feedback
        FROM voice_turns
        WHERE intent IS NOT NULL
          AND intent NOT IN ('none', 'confirm', 'cancel', 'unknown', '')
          AND intent NOT IN (
            SELECT LOWER(name) FROM skills WHERE status = 'enabled'
          )
        GROUP BY intent
        HAVING COUNT(*) >= 2
        ORDER BY count DESC, last_seen DESC
        LIMIT $1
      `, [limit]);
      return { suggestions: result.rows };
    },
  );
  // Edge. Reads are open to any authenticated admin; service calls are admin-only.
  fastify.get('/api/ha/entities', { preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }) }, async (_request, reply) => {
    const result = await pool.query(
      `SELECT entity_id, domain, friendly_name, state, attributes,
              last_changed, last_updated, cached_at
       FROM ha_entities
       ORDER BY domain, COALESCE(friendly_name, entity_id), entity_id`,
    );
    return {
      entities: result.rows,
      configured: Boolean(ha),
      connected: ha?.isConnected() ?? false,
      cached: true,
      count: result.rowCount ?? 0,
    };
  });

  fastify.get('/api/ha/catalog', { preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }) }, async () => {
    const [areas, devices, entities] = await Promise.all([
      pool.query('SELECT area_id, name, floor_id, aliases, cached_at FROM ha_areas ORDER BY name'),
      pool.query(`SELECT d.device_id, COALESCE(d.name_by_user, d.name) AS name, d.name AS original_name,
                         d.area_id, a.name AS area_name, d.manufacturer, d.model, d.cached_at
                  FROM ha_devices d LEFT JOIN ha_areas a ON a.area_id=d.area_id
                  ORDER BY COALESCE(d.name_by_user, d.name, d.device_id)`),
      pool.query(`SELECT r.entity_id, r.device_id, COALESCE(r.area_id, d.area_id) AS area_id,
                         a.name AS area_name, COALESCE(d.name_by_user, d.name) AS device_name,
                         r.name, r.original_name, r.platform, r.disabled_by, r.cached_at
                  FROM ha_entity_registry r
                  LEFT JOIN ha_devices d ON d.device_id=r.device_id
                  LEFT JOIN ha_areas a ON a.area_id=COALESCE(r.area_id, d.area_id)
                  ORDER BY r.entity_id`),
    ]);
    return {
      configured: Boolean(ha), connected: ha?.isConnected() ?? false, cached: true,
      counts: { areas: areas.rowCount ?? 0, devices: devices.rowCount ?? 0, entities: entities.rowCount ?? 0 },
      areas: areas.rows, devices: devices.rows, entities: entities.rows,
    };
  });

  fastify.post('/api/ha/entities/refresh', { preHandler: requireAdmin({ roles: ['admin'] }) }, async (_request, reply) => {
    if (!ha) {
      reply.code(503);
      return { error: 'ha_not_configured' };
    }
    try {
      const [count, registries] = await Promise.all([reconcileHaEntityCache(), reconcileHaRegistryCache()]);
      return { ok: true, count, registries, refreshedAt: new Date().toISOString() };
    } catch (err) {
      reply.code(502);
      return { error: 'ha_entity_refresh_failed', detail: (err as Error).message };
    }
  });

  fastify.get('/api/admin/ha/entity-aliases', { preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }) }, async () => {
    const result = await pool.query(
      `SELECT a.alias, a.entity_id, e.friendly_name, a.created_at
       FROM voice_entity_aliases a JOIN ha_entities e ON e.entity_id=a.entity_id
       ORDER BY a.alias`,
    );
    return { aliases: result.rows };
  });

  fastify.get('/api/admin/voice-command-templates', { preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }) }, async () => {
    const [templates, index] = await Promise.all([
      pool.query('SELECT id, domain, action, phrase_template, service, priority, enabled, requires_confirmation, created_at, updated_at FROM voice_command_templates ORDER BY domain, priority DESC, id'),
      pool.query(`SELECT domain, COUNT(*)::integer AS commands,
                         COUNT(DISTINCT phrase)::integer AS phrases,
                         COUNT(*) FILTER (WHERE phrase IN (SELECT phrase FROM voice_command_index GROUP BY phrase HAVING COUNT(DISTINCT entity_id) > 1))::integer AS ambiguous
                  FROM voice_command_index GROUP BY domain ORDER BY domain`),
    ]);
    return { templates: templates.rows, index: index.rows };
  });

  fastify.post('/api/admin/voice-command-templates/rebuild', { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) }, async () => {
    return { ok: true, commands: await rebuildVoiceCommandIndex() };
  });

  fastify.put('/api/admin/voice-command-templates/:id', { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) }, async (request, reply) => {
    const id = String((request.params as { id: string }).id ?? '').trim();
    const body = (request.body ?? {}) as Record<string, unknown>;
    const domain = String(body.domain ?? '').trim().toLowerCase();
    const action = String(body.action ?? '').trim().toLowerCase();
    const phraseTemplate = String(body.phrase_template ?? '').trim().toLowerCase();
    const service = body.service == null || body.service === '' ? null : String(body.service).trim().toLowerCase();
    const priority = Math.max(0, Math.min(10_000, Math.round(Number(body.priority ?? 100))));
    if (!/^[a-z0-9][a-z0-9_-]{1,79}$/.test(id) || !/^[a-z0-9_]+$/.test(domain) || !/^[a-z0-9_]+$/.test(action)
      || !phraseTemplate.includes('{name}') || phraseTemplate.length > 160) {
      return reply.code(400).send({ error: 'invalid_voice_command_template' });
    }
    await pool.query(
      `INSERT INTO voice_command_templates(id, domain, action, phrase_template, service, priority, enabled, requires_confirmation, updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,now())
       ON CONFLICT(id) DO UPDATE SET domain=EXCLUDED.domain, action=EXCLUDED.action, phrase_template=EXCLUDED.phrase_template,
         service=EXCLUDED.service, priority=EXCLUDED.priority, enabled=EXCLUDED.enabled,
         requires_confirmation=EXCLUDED.requires_confirmation, updated_at=now()`,
      [id, domain, action, phraseTemplate, service, priority, body.enabled !== false, body.requires_confirmation === true],
    );
    return { ok: true, commands: await rebuildVoiceCommandIndex() };
  });

  fastify.delete('/api/admin/voice-command-templates/:id', { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) }, async (request, reply) => {
    const id = String((request.params as { id: string }).id ?? '').trim();
    const result = await pool.query('DELETE FROM voice_command_templates WHERE id=$1', [id]);
    if (!result.rowCount) return reply.code(404).send({ error: 'unknown_voice_command_template' });
    return { ok: true, commands: await rebuildVoiceCommandIndex() };
  });

  fastify.put('/api/admin/ha/entity-aliases/:alias', { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) }, async (request, reply) => {
    const alias = String((request.params as { alias: string }).alias ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
    const entityId = String((request.body as { entity_id?: string } | undefined)?.entity_id ?? '').trim();
    if (!/^[a-z0-9][a-z0-9 -]{1,79}$/.test(alias) || !/^[a-z_]+\.[a-z0-9_]+$/.test(entityId)) {
      return reply.code(400).send({ error: 'invalid_alias_or_entity_id' });
    }
    const entity = await pool.query('SELECT 1 FROM ha_entities WHERE entity_id=$1', [entityId]);
    if (!entity.rowCount) return reply.code(404).send({ error: 'unknown_entity' });
    await pool.query(
      `INSERT INTO voice_entity_aliases(alias, entity_id) VALUES($1, $2)
       ON CONFLICT(alias) DO UPDATE SET entity_id=EXCLUDED.entity_id`,
      [alias, entityId],
    );
    return { ok: true, alias, entity_id: entityId };
  });

  fastify.delete('/api/admin/ha/entity-aliases/:alias', { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) }, async (request, reply) => {
    const alias = String((request.params as { alias: string }).alias ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
    const result = await pool.query('DELETE FROM voice_entity_aliases WHERE alias=$1', [alias]);
    if (!result.rowCount) return reply.code(404).send({ error: 'unknown_alias' });
    return { ok: true };
  });

  fastify.get('/api/ha/entities/:entityId', { preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }) }, async (request, reply) => {
    if (!ha) {
      reply.code(503);
      return { error: 'ha_not_configured' };
    }
    const { entityId } = request.params as { entityId: string };
    const entity = ha.getEntity(entityId);
    if (!entity) {
      reply.code(404);
      return { error: 'unknown_entity' };
    }
    return { entity };
  });

  // Admin-only command surface: call an HA service. Body { domain, service, serviceData }.
  fastify.post('/api/ha/services', { preHandler: requireAdmin({ roles: ['admin'] }) }, async (request, reply) => {
    if (!ha) {
      reply.code(503);
      return { error: 'ha_not_configured' };
    }
    const body = request.body as { domain?: unknown; service?: unknown; serviceData?: unknown } | undefined;
    if (typeof body?.domain !== 'string' || typeof body?.service !== 'string') {
      reply.code(400);
      return { error: 'domain and service are required strings' };
    }
    const serviceData = (body.serviceData && typeof body.serviceData === 'object' ? body.serviceData : {}) as Record<string, unknown>;
    try {
      const affected = await ha.callService(body.domain, body.service, serviceData);
      return { ok: true, affected: affected.length };
    } catch (err) {
      reply.code(502);
      return { error: 'ha_service_failed', detail: (err as Error).message };
    }
  });

  // Same command surface in RESTful form: POST /api/ha/services/:domain/:service
  // with the request body as the service data. This is the shape the widget layer
  // (and the HTML widget's CanvasHermes bridge) calls, so both variants must exist
  // or every entity control silently 404s.
  fastify.post('/api/ha/services/:domain/:service', { preHandler: requireAdmin({ roles: ['admin'] }) }, async (request, reply) => {
    if (!ha) {
      reply.code(503);
      return { error: 'ha_not_configured' };
    }
    const { domain, service } = request.params as { domain?: string; service?: string };
    if (typeof domain !== 'string' || !domain || typeof service !== 'string' || !service) {
      reply.code(400);
      return { error: 'domain and service are required path segments' };
    }
    const raw = request.body as unknown;
    const serviceData = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    try {
      const affected = await ha.callService(domain, service, serviceData);
      return { ok: true, affected: affected.length };
    } catch (err) {
      reply.code(502);
      return { error: 'ha_service_failed', detail: (err as Error).message };
    }
  });

  // Minimal admin API stub — Phase 2 expands this (auth, devices, scenes, commands).
  // Compatibility registration for the existing Android/Linux browser clients.
  // Their legacy /ws hello establishes a socket but does not create a row in the
  // PostgreSQL device registry used by the Core Devices page.
  fastify.post<{ Body: {
    id?: string;
    name?: string;
    platform?: string;
    app_version?: string;
    invitation_token?: string;
    screen_width?: number;
    screen_height?: number;
  } }>('/api/devices/register', async (request, reply) => {
    const body = request.body ?? {};
    const deviceId = body.id?.trim() || `browser-${randomUUID()}`;
    const device = await recordDeviceHello(deviceRepo, {
      deviceId,
      name: body.name?.trim() || deviceId,
      architecture: body.platform?.trim() || 'browser',
      protocolVersion: body.app_version?.trim() || 'legacy-browser',
      capabilities: ['browser'],
      // Tauri browser clients use the legacy authenticated local WebSocket
      // channel and cannot complete the native Ed25519 enrollment handshake.
      // Treat their explicit registration as the pairing event; native Edge
      // agents continue to use invitation-backed enrollment on /gateway/v1.
      paired: body.platform?.trim() === 'android' || body.platform?.trim() === 'linux',
      invitationToken: body.invitation_token?.trim() || undefined,
    });
    await pool.query(
      `UPDATE devices SET display_width = COALESCE($2, display_width),
        display_height = COALESCE($3, display_height)
       WHERE id = $1`,
      [deviceId, body.screen_width ?? null, body.screen_height ?? null],
    );
    reply.code(200);
    return device;
  });

  fastify.get('/api/devices', async () => {
    const pool = getPool(config);
    const result = await pool.query(
      'SELECT id, name, architecture, status, last_seen, audio_config, voice_config, display_width, display_height FROM devices ORDER BY last_seen DESC',
    );
    return { devices: result.rows };
  });

  // Device Gateway (protocol v1 WSS). Pass the enrollment signer so the auth gate can verify
  // presented Phase 0 credentials when open pairing is disabled (fail-closed).
  // First real Core→Edge command vertical slice. diagnostics.echo is deliberately
  // side-effect-free; it proves authenticated dispatch, protocol sequencing, Edge execution,
  // and correlated completion before hardware commands are exposed.
  fastify.post(
    '/api/admin/devices/:deviceId/diagnostics/echo',
    { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) },
    async (request, reply) => {
      const { deviceId } = request.params as { deviceId: string };
      const body = request.body as { message?: unknown } | undefined;
      if (typeof body?.message !== 'string' || body.message.length < 1 || body.message.length > 256) {
        reply.code(400);
        return { error: 'message_must_be_1_to_256_characters' };
      }
      try {
        const result = await gateway.issueDiagnosticsEcho(deviceId, body.message);
        if (result.type !== 'command.completed') {
          reply.code(409);
          return { ok: false, result };
        }
        return { ok: true, result };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        reply.code(detail.includes('not connected') ? 409 : 504);
        return { ok: false, error: 'command_delivery_failed', detail };
      }
    },
  );

  fastify.put(
    '/api/admin/devices/:deviceId/display',
    { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) },
    async (request, reply) => {
      const { deviceId } = request.params as { deviceId: string };
      const body = request.body as { power?: unknown; brightness?: unknown } | undefined;
      const power = body?.power;
      const brightness = body?.brightness;
      if (
        (power === undefined && brightness === undefined) ||
        (power !== undefined && power !== 'on' && power !== 'off') ||
        (brightness !== undefined &&
          (!Number.isInteger(brightness) || Number(brightness) < 0 || Number(brightness) > 100))
      ) {
        reply.code(400);
        return { error: 'display_requires_power_on_or_off_and_or_integer_brightness_0_to_100' };
      }

      const display: { power?: 'on' | 'off'; brightness?: number } = {};
      if (power === 'on' || power === 'off') display.power = power;
      if (typeof brightness === 'number') display.brightness = brightness;

      try {
        const revision = await setDesiredState(stateRepo, deviceId, 'display', display, {
          authorityMode: 'core',
          provenance: 'core',
        });
        const result = await gateway.issueDisplayState(deviceId, revision, display);
        const application = (result.payload.application as Record<string, unknown> | undefined)?.display as
          | { status?: unknown; reason?: unknown }
          | undefined;
        const rawStatus = application?.status;
        const status: ReportedStatus =
          rawStatus === 'applied' || rawStatus === 'diverged' || rawStatus === 'failed' || rawStatus === 'pending'
            ? rawStatus
            : 'failed';
        const reportedDisplay =
          ((result.payload.state as Record<string, unknown> | undefined)?.display as unknown) ?? display;
        await reportState(stateRepo, deviceId, 'display', reportedDisplay, status, revision);

        const ok = status === 'applied';
        if (!ok) reply.code(409);
        return { ok, revision, application, result };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        reply.code(detail.includes('not connected') ? 409 : 504);
        return { ok: false, error: 'display_delivery_failed', detail };
      }
    },
  );

  // --- Legacy sidecar API compatibility routes (pages/settings/audio/commands + /ws) ---
  // Re-implements the per-Pi sidecar REST surface the web UI was built against, backed
  // by Core's Postgres. The /ws WebSocket here is the browser/editor channel (separate
  // from the device gateway at /gateway/v1 and the voice session at /ws/voice).
  const deliverPageToDevice = async (page: import('./legacy-routes.js').PageRow, deviceId: string) => {
      const deviceRow = await pool.query(
        'SELECT architecture, protocol_version FROM devices WHERE id = $1',
        [deviceId],
      );
      const architecture = String(deviceRow.rows[0]?.architecture ?? '').toLowerCase();
      const gatewayConnected = gateway.isConnected(deviceId);
      const overrides = await pool.query(
        `SELECT panel_id, content, visible
         FROM device_panel_state
         WHERE device_id = $1 AND panel_id = ANY($2::text[])`,
        [deviceId, page.panels.map(panel => panel.id)],
      );
      const byPanel = new Map(overrides.rows.map(row => [String(row.panel_id), row]));
      const effectivePage = {
        ...page,
        panels: page.panels.map(panel => {
          const override = byPanel.get(panel.id);
          const content = override?.content as { type?: string; url?: string; scene_id?: string } | undefined;
          return {
            ...panel,
            ...(content?.type === 'url'
              ? { content_type: 'url', url: content.url ?? null, scene_id: null }
              : content?.type === 'scene'
                ? { content_type: 'scene', scene_id: content.scene_id ?? null, url: null }
                : {}),
            ...(typeof override?.visible === 'boolean' ? { visible: override.visible } : {}),
          };
        }),
      };
      // A live Gateway v1 session is authoritative regardless of the registry's
      // historical architecture/protocol labels. Only disconnected legacy clients
      // receive the browser command path.
      if (!gatewayConnected) {
        sendCommand(deviceId, {
          type: 'load_page',
          page_id: page.id,
          page_data: effectivePage,
        });
      }
      // Android/Linux Tauri clients use the legacy browser WebSocket and do
      // not connect to the native Edge gateway or report scene state there.
      // The command above is the complete delivery path for those clients.
      if (!gatewayConnected && (architecture === 'android' || architecture === 'linux' || architecture === 'browser')) {
        return {
          revision: 0,
          application: { scene: { status: 'applied', reason: 'legacy_browser_websocket' } },
          result: { type: 'legacy_browser_delivery' },
        };
      }
      const revision = await setDesiredState(
        stateRepo,
        deviceId,
        'scene',
        { revisionId: page.id, pageId: page.id },
        { authorityMode: 'core', provenance: 'core' },
      );
      const result = await gateway.issueSceneState(
        deviceId,
        revision,
        page.id,
        effectivePage as unknown as Record<string, unknown>,
      );
      const application = (result.payload.application as Record<string, unknown> | undefined)?.scene as
        | { status?: unknown; reason?: unknown }
        | undefined;
      if (application?.status !== 'applied' && application?.status !== 'pending') {
        throw new Error(`Edge reported page status ${String(application?.status ?? 'unknown')}`);
      }
      await reportState(
        stateRepo,
        deviceId,
        'scene',
        { revision_id: page.id },
        application.status === 'pending' ? 'pending' : 'applied',
        revision,
      );
      return { revision, application, result };
  };
  const controlDeviceMedia = async (
    deviceId: string,
    action: 'pause' | 'resume' | 'stop' | 'next',
    source = 'youtube',
  ) => requestDeviceAction(deviceId, 'device_http', {
    path: '/api/media/control',
    http_method: 'POST',
    body: { source, action },
  }, 10_000);
  const getPlaylistSelectionPage = async (): Promise<{
    layout: Array<Record<string, unknown>>;
    page: import('./legacy-routes.js').PageRow | null;
  }> => {
    const setting = await pool.query("SELECT value FROM settings WHERE key = 'playlist_selection_page_id' LIMIT 1");
    const pageId = String(setting.rows[0]?.value ?? '');
    if (!pageId) return { layout: [], page: null };
    const pageRows = await pool.query('SELECT * FROM pages WHERE id = $1', [pageId]);
    const pagePanels = await pool.query('SELECT * FROM page_panels WHERE page_id = $1 ORDER BY position, id', [pageId]);
    const page = pageRows.rows[0]
      ? { ...pageRows.rows[0], panels: pagePanels.rows } as import('./legacy-routes.js').PageRow
      : null;
    const panels = await pool.query(
      `SELECT p.x, p.y, p.w, p.h, p.visible, s.manifest_json
       FROM page_panels p
       JOIN scenes s ON s.id = p.scene_id
       WHERE p.page_id = $1 AND p.content_type = 'scene' AND p.visible = true AND s.status = 'published'
       ORDER BY p.position, p.id`,
      [pageId],
    );
    const bySlot = new Map<number, Record<string, unknown>>();
    for (const panel of panels.rows) {
      const manifest = (panel.manifest_json ?? {}) as { widgets?: Array<Record<string, unknown>> };
      for (const widget of manifest.widgets ?? []) {
        if (widget.type !== 'playlistresult' || widget.hidden === true) continue;
        const config = (widget.config ?? {}) as Record<string, unknown>;
        const slot = Math.max(1, Math.min(8, Math.trunc(Number(config.resultSlot ?? 1))));
        if (bySlot.has(slot)) continue;
        // Scene editor manifests use the editor's fixed 800 x 480 design canvas.
        // Convert that geometry to percentages within the containing page panel.
        const x = Number(panel.x) + (Number(widget.x ?? 0) / 800) * Number(panel.w);
        const y = Number(panel.y) + (Number(widget.y ?? 0) / 480) * Number(panel.h);
        const w = (Number(widget.w ?? 220) / 800) * Number(panel.w);
        const h = (Number(widget.h ?? 180) / 480) * Number(panel.h);
        bySlot.set(slot, {
          slot, x, y, w, h,
          layout: config.layout,
          backgroundColor: config.backgroundColor, textColor: config.textColor,
          metadataColor: config.metadataColor, accentColor: config.accentColor,
          borderColor: config.borderColor, borderWidth: config.borderWidth,
          borderRadius: config.borderRadius, titleWeight: config.titleWeight,
          showChannel: config.showChannel, showItemCount: config.showItemCount,
        });
      }
    }
    const layouts = [...bySlot.values()].sort((a, b) => Number(a.slot) - Number(b.slot));
    const validLayout = layouts.every((layout, index) => Number(layout.slot) === index + 1) ? layouts : [];
    console.log(`[core][playlist] page=${pageId} slots=${validLayout.length}`);
    return { layout: validLayout, page: validLayout.length > 0 ? page : null };
  };
  const mqttNavigation = new MqttNavigationService(pool, deliverPageToDevice, controlDeviceMedia);
  await mqttNavigation.start();

  // --- Audio broadcast (record → store → fan-out) ---------------------------
  // A recorded clip is stored and served at a public URL, then fanned out to
  // every connected edge device and every HA media_player entity. Store-and-
  // forward by design — no SIP or WebRTC.
  const broadcastUrl = (clip: BroadcastClip): string =>
    `${config.publicUrl.replace(/\/$/, '')}/api/broadcast/${clip.id}.${extensionForMime(clip.mimeType)}`;
  const broadcastFanOut = async (clip: BroadcastClip): Promise<{ edges: number; ha: number }> => {
    const url = broadcastUrl(clip);
    const deviceIds = gateway.connectedDeviceIds();
    console.log(`[core][broadcast] fan-out gateway devices: ${JSON.stringify(deviceIds)}`);
    const edgeResults = await Promise.allSettled(deviceIds.map(async (deviceId) => {
      const archRow = await pool.query('SELECT architecture FROM devices WHERE id = $1', [deviceId]);
      const architecture = String(archRow.rows[0]?.architecture ?? '').toLowerCase();
      console.log(`[core][broadcast] -> ${deviceId} (arch=${architecture || 'unknown'})`);
      if (architecture === 'android') {
        await gateway.requestAction(deviceId, 'media.play', { source: 'direct_audio', url, title: clip.title }, 20_000);
      } else {
        await requestDeviceAction(deviceId, 'device_http', {
          path: '/api/media/play',
          http_method: 'POST',
          body: { source: 'direct_audio', url, title: clip.title },
        }, 20_000);
      }
      mqttNavigation.updateMediaState(deviceId, { state: 'playing', title: clip.title, url });
    }));
    for (const [index, result] of edgeResults.entries()) {
      if (result.status === 'rejected') {
        console.warn(`[core][broadcast] edge ${deviceIds[index]} failed:`, result.reason instanceof Error ? result.reason.message : result.reason);
      }
    }
    const edges = edgeResults.filter(result => result.status === 'fulfilled').length;
    let haCount = 0;
    if (ha) {
      const players = ha.getEntities().filter(entity => entity.entityId.startsWith('media_player.'));
      const haResults = await Promise.allSettled(players.map(player => ha.callService('media_player', 'play_media', {
        entity_id: player.entityId,
        media_content_id: url,
        media_content_type: 'music',
      })));
      haCount = haResults.filter(result => result.status === 'fulfilled').length;
    }
    return { edges, ha: haCount };
  };
  broadcastFanOutRef = broadcastFanOut;

  fastify.post<{ Body: { audioBase64?: string; mimeType?: string; title?: string; from?: string } }>(
    '/api/edge/broadcast',
    async (request, reply) => {
      const header = request.headers.authorization;
      const presented = header?.startsWith('Bearer ') ? header.slice(7) : '';
      const expected = await resolveEdgeVoiceToken(presented);
      if (!checkEdgeVoiceAuth(expected, presented)) {
        return reply.code(401).send({ error: 'invalid_edge_voice_credential' });
      }
      const { audioBase64, mimeType, title, from } = request.body ?? {};
      if (!audioBase64) return reply.code(400).send({ error: 'audioBase64 is required' });
      const buffer = Buffer.from(audioBase64, 'base64');
      if (buffer.length === 0) return reply.code(400).send({ error: 'empty audio' });
      const clip = broadcastStore.add(buffer, mimeType ?? 'audio/wav', title ?? `Broadcast from ${from ?? 'unknown'}`);
      const result = await broadcastFanOut(clip);
      console.log(`[core][broadcast] ${clip.id} (${buffer.length}B) -> edges=${result.edges} ha=${result.ha}`);
      return reply.send({ ok: true, id: clip.id, url: broadcastUrl(clip), ...result });
    },
  );

  fastify.get<{ Params: { id: string } }>('/api/broadcast/:id', async (request, reply) => {
    const id = request.params.id.replace(/\.[a-z0-9]+$/i, '');
    const clip = broadcastStore.get(id);
    if (!clip) return reply.code(404).send({ error: 'broadcast not found' });
    reply.header('Cache-Control', 'no-store');
    reply.type(clip.mimeType);
    return reply.send(clip.buffer);
  });
  intelligence.setToolContext({
    haClient: ha,
    parseHaIntent: async (transcript) => {
      const [entities, aliases, areas] = await Promise.all([
        pool.query<{ friendly_name: string }>('SELECT friendly_name FROM ha_entities WHERE friendly_name IS NOT NULL AND btrim(friendly_name) <> \'\''),
        pool.query<{ alias: string }>('SELECT alias FROM voice_entity_aliases'),
        pool.query<{ name: string }>('SELECT name FROM ha_areas'),
      ]);
      const names = [...entities.rows.map(row => row.friendly_name), ...aliases.rows.map(row => row.alias)];
      const areaNames = areas.rows.map(row => row.name);
      try {
        const { stdout } = await execFileAsync('python3', [
          path.join(process.cwd(), 'ha_intents_stdio.py'), transcript, JSON.stringify(names), JSON.stringify(areaNames),
        ], { timeout: 2_000, maxBuffer: 128 * 1024 });
        const result = JSON.parse(stdout) as { matched?: boolean; intent?: string; slots?: Record<string, unknown> };
        return result.matched && result.intent ? { intent: result.intent, slots: result.slots ?? {} } : null;
      } catch (error) {
        console.warn('[intel][ha-grammar] parse failed:', error instanceof Error ? error.message : error);
        return null;
      }
    },
    resolveVoiceCommands: async (phrase) => {
      const result = await pool.query(
        `SELECT i.entity_id, i.domain, i.action, i.service, i.priority, i.requires_confirmation,
                e.friendly_name, e.state
         FROM voice_command_index i JOIN ha_entities e ON e.entity_id=i.entity_id
         WHERE i.phrase=$1 ORDER BY i.priority DESC, i.entity_id`,
        [normalizeVoicePhrase(phrase)],
      );
      return result.rows.map(row => ({
        entityId: String(row.entity_id), domain: String(row.domain), action: String(row.action),
        service: row.service ? String(row.service) : undefined, priority: Number(row.priority),
        requiresConfirmation: Boolean(row.requires_confirmation), friendlyName: row.friendly_name ? String(row.friendly_name) : undefined,
        state: String(row.state),
      }));
    },
    resolveHaEntities: async (query, options = {}) => {
      if (options.exact) {
        const target = normalizeVoicePhrase(query);
        if (!target) return [];
        const domainClause = options.domains?.length ? 'AND e.domain = ANY($2::text[])' : '';
        const params: unknown[] = options.domains?.length ? [target, options.domains] : [target];
        const result = await pool.query(
          `SELECT e.entity_id, e.friendly_name, e.domain, e.state,
             COALESCE(d.name_by_user, d.name) AS device_name, a.name AS area_name,
             COALESCE(array_agg(DISTINCT aa.alias) FILTER (WHERE aa.alias IS NOT NULL), '{}') AS aliases
           FROM ha_entities e
           LEFT JOIN ha_entity_registry r ON r.entity_id=e.entity_id
           LEFT JOIN ha_devices d ON d.device_id=r.device_id
           LEFT JOIN ha_areas a ON a.area_id=COALESCE(r.area_id, d.area_id)
           LEFT JOIN voice_entity_aliases aa ON aa.entity_id=e.entity_id
           WHERE (
             regexp_replace(lower(COALESCE(e.friendly_name, '')), '[^a-z0-9]+', ' ', 'g') = $1
             OR EXISTS (
               SELECT 1 FROM voice_entity_aliases exact_alias
               WHERE exact_alias.entity_id=e.entity_id
                 AND regexp_replace(lower(exact_alias.alias), '[^a-z0-9]+', ' ', 'g') = $1
             )
           ) ${domainClause}
           GROUP BY e.entity_id, e.friendly_name, e.domain, e.state, d.name_by_user, d.name, a.name
           ORDER BY e.entity_id`,
          params,
        );
        return result.rows.map(row => ({
          entityId: String(row.entity_id),
          friendlyName: row.friendly_name ? String(row.friendly_name) : undefined,
          domain: String(row.domain),
          state: String(row.state),
          deviceName: row.device_name ? String(row.device_name) : undefined,
          areaName: row.area_name ? String(row.area_name) : undefined,
          aliases: Array.isArray(row.aliases) ? row.aliases.map(String) : [],
        }));
      }
      const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(term => term.length >= 3).slice(0, 8);
      if (terms.length === 0) return [];
      const patterns = terms.map(term => `%${term}%`);
      const result = await pool.query(
        `SELECT e.entity_id, e.friendly_name, e.domain, e.state,
           COALESCE(d.name_by_user, d.name) AS device_name, a.name AS area_name,
           COALESCE(array_agg(DISTINCT aa.alias) FILTER (WHERE aa.alias IS NOT NULL), '{}') AS aliases
         FROM ha_entities e
         LEFT JOIN ha_entity_registry r ON r.entity_id=e.entity_id
         LEFT JOIN ha_devices d ON d.device_id=r.device_id
         LEFT JOIN ha_areas a ON a.area_id=COALESCE(r.area_id, d.area_id)
          LEFT JOIN voice_entity_aliases aa ON aa.entity_id=e.entity_id
         WHERE EXISTS (
           SELECT 1 FROM unnest($1::text[]) pattern
           WHERE lower(e.entity_id) LIKE pattern OR lower(COALESCE(e.friendly_name, '')) LIKE pattern
              OR lower(COALESCE(d.name_by_user, d.name, '')) LIKE pattern
              OR lower(COALESCE(a.name, '')) LIKE pattern
            OR lower(COALESCE(aa.alias, '')) LIKE pattern
         )
          GROUP BY e.entity_id, e.friendly_name, e.domain, e.state, d.name_by_user, d.name, a.name
         ORDER BY e.friendly_name NULLS LAST, e.entity_id
          LIMIT 30`,
        [patterns],
      );
      return result.rows.map(row => ({
        entityId: String(row.entity_id),
        friendlyName: row.friendly_name ? String(row.friendly_name) : undefined,
        domain: String(row.domain),
        state: String(row.state),
        deviceName: row.device_name ? String(row.device_name) : undefined,
        areaName: row.area_name ? String(row.area_name) : undefined,
        aliases: Array.isArray(row.aliases) ? row.aliases.map(String) : [],
      }));
    },
    playMedia: async (query, source, deviceId, mediaKind) => {
      if (!deviceId || deviceId === 'unknown') {
        return { ok: false, message: 'I could not identify which display requested playback.' };
      }
      if (source === 'music_assistant') {
        // Music Assistant playback is resolved by the device's local Display server
        // (which talks to HA/Music Assistant). Android has no local server, so it is
        // not supported there yet — see the HA media_player workstream item.
        try {
          const archRow = await pool.query('SELECT architecture FROM devices WHERE id = $1', [deviceId]);
          if (String(archRow.rows[0]?.architecture ?? '').toLowerCase() === 'android') {
            return { ok: false, message: 'Music Assistant playback is not supported on Android yet.' };
          }
          const result = await requestDeviceAction(deviceId, 'device_http', {
            path: '/api/media/play',
            http_method: 'POST',
            body: { source: 'music_assistant', url: query, title: query },
          }, 20_000);
          return {
            ok: true,
            message: `Playing "${query}" from Music Assistant.`,
            data: { device_id: deviceId, source, result, playback_started: true },
          };
        } catch (error) {
          return {
            ok: false,
            message: `I could not play "${query}" from Music Assistant: ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
        }
      }
      if (source === 'direct_audio') {
        // Play a direct stream URL (e.g. a Dispatcharr IPTV channel) on the device.
        try {
          const archRow = await pool.query('SELECT architecture FROM devices WHERE id = $1', [deviceId]);
          if (String(archRow.rows[0]?.architecture ?? '').toLowerCase() === 'android') {
            await gateway.requestAction(
              deviceId, 'media.play', { source: 'direct_audio', url: query, title: query }, 20_000,
            );
          } else {
            await requestDeviceAction(deviceId, 'device_http', {
              path: '/api/media/play',
              http_method: 'POST',
              body: { source: 'direct_audio', url: query, title: query },
            }, 20_000);
          }
          mqttNavigation.updateMediaState(deviceId, { state: 'playing', title: query, url: query });
          return {
            ok: true,
            message: `Playing "${query}".`,
            data: { device_id: deviceId, source, playback_started: true },
          };
        } catch (error) {
          return {
            ok: false,
            message: `I could not play that stream: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }
      if (source !== 'youtube') {
        return { ok: false, message: `Media source "${source}" is not supported on the device yet.` };
      }
      try {
        const archRow = await pool.query('SELECT architecture FROM devices WHERE id = $1', [deviceId]);
        if (String(archRow.rows[0]?.architecture ?? '').toLowerCase() === 'android') {
          const wantsPlaylist =
            ['artist', 'album', 'playlist', 'music'].includes(mediaKind ?? '') || /\bplaylist\b/i.test(query);
          const ytOptions: YouTubeSearchOptions = {
            apiKey: config.youtubeApiKey,
            regionCode: config.youtubeRegionCode,
            relevanceLanguage: config.youtubeRelevanceLanguage,
            safeSearch: config.youtubeSafeSearch,
            allowYtDlpFallback: true,
          };
          let url: string;
          let message: string;
          let playlist = wantsPlaylist;
          try {
            const cookies = await getYoutubeCookies();
            const cookiesFile = cookies ? await writeYoutubeCookiesFile(cookies) : undefined;
            const streams = await resolveYouTubeStreamsFn(query, '', { ...ytOptions, cookiesFile });
            const id = storeYouTubeStreams(streams.urls);
            url = `${config.youtubePlayerOrigin}/media/youtube/player/${id}`;
            playlist = streams.playlist;
            message = streams.playlist
              ? `Playing the YouTube playlist for "${query}".`
              : `Playing "${query}" on YouTube.`;
          } catch {
            if (wantsPlaylist) {
              const queue = await resolveYouTubeQueue(query, '', ytOptions).catch(() => null);
              if (queue?.playlistId) {
                url = buildYouTubePlaylistUrl(queue.playlistId);
                message = `Playing the YouTube playlist for "${query}".`;
              } else {
                url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
                message = `I couldn't find a "${query}" playlist, so I opened YouTube search.`;
              }
            } else {
              const resolved = await resolveYouTubeWatchUrl(query, '', ytOptions).catch(() => null);
              if (resolved) {
                url = resolved;
                message = `Playing "${query}" on YouTube.`;
              } else {
                url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
                message = `I couldn't auto-pick a result for "${query}", so I opened YouTube search.`;
              }
            }
          }
          const result = await gateway.requestAction(
            deviceId, 'media.play', { source: 'youtube', query, url, playlist }, 20_000,
          );
          mqttNavigation.updateMediaState(deviceId, { state: 'playing', title: query, url });
          return {
            ok: true,
            message,
            data: { device_id: deviceId, source, result, url, playlist, playback_started: true },
          };
        }
        const playlistSelection = ['artist', 'album', 'playlist', 'music'].includes(mediaKind ?? '')
          ? await getPlaylistSelectionPage()
          : { layout: [], page: null };
        const playlistLayout = playlistSelection.layout;
        const playlistSceneId = playlistSelection.page?.panels.find(
          panel => panel.content_type === 'scene' && panel.scene_id,
        )?.scene_id ?? undefined;
        const result = await requestDeviceAction(deviceId, 'device_http', {
          path: '/api/media/play',
          http_method: 'POST',
          body: {
            source: 'youtube',
            url: query,
            title: query,
            choose_playlist: ['artist', 'album', 'playlist', 'music'].includes(mediaKind ?? ''),
            playlist_layout: playlistLayout,
            playlist_scene_id: playlistSceneId,
          },
        }, 20_000);
        const deviceResult = result as Record<string, unknown>;
        const selectionRequired = deviceResult.selection_required === true;
        if (selectionRequired && playlistSelection.page && typeof deviceResult.selection_id === 'string') {
          const runtimeQuery = `playlist_selection_id=${encodeURIComponent(deviceResult.selection_id)}`;
          const selectionUrl = typeof deviceResult.url === 'string' ? deviceResult.url : '';
          const deviceOrigin = selectionUrl ? new URL(selectionUrl).origin : '';
          const runtimePage = {
            ...playlistSelection.page,
            panels: playlistSelection.page.panels.map(panel => panel.content_type === 'scene' && panel.scene_id && deviceOrigin
              ? {
                  ...panel,
                  content_type: 'url',
                  url: `${deviceOrigin}/display/scenes/${encodeURIComponent(panel.scene_id)}?${runtimeQuery}`,
                }
              : panel),
          } as import('./legacy-routes.js').PageRow;
          await deliverPageToDevice(runtimePage, deviceId);
        }
        const selectionChoices = Array.isArray(deviceResult.choices) ? deviceResult.choices.length : 0;
        const spokenChoiceCount = selectionChoices || playlistLayout.length || 3;
        if (!selectionRequired) {
          mqttNavigation.updateMediaState(deviceId, { state: 'playing', title: query });
        }
        return {
          ok: true,
          message: selectionRequired
            ? `I found ${spokenChoiceCount} playlist choices. Tap one on the screen, or say its number.`
            : `Playing "${query}" on YouTube.`,
          data: { device_id: deviceId, source, result, playback_started: !selectionRequired },
        };
      } catch (error) {
        return {
          ok: false,
          message: `I could not play "${query}" on YouTube: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
    broadcastTts: async (message) => {
      const text = message.trim();
      if (!text) return { ok: false, message: 'A message is required.' };
      if (!flowEnqueueTts) return { ok: false, message: 'TTS broadcast is not available.' };
      await flowEnqueueTts(text);
      return { ok: true, message: `Announcing: ${text}`, data: { text } };
    },
    playDab: async (station, deviceId) => {
      if (!deviceId || deviceId === 'unknown') {
        return { ok: false, message: 'I could not identify which display requested playback.' };
      }
      const name = station.trim();
      if (!name) return { ok: false, message: 'A DAB+ station name is required.' };
      try {
        const base = config.sdrRadioUrl.replace(/\/$/, '');
        const res = await fetch(`${base}/api/stations`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) {
          return { ok: false, message: `SDR radio returned HTTP ${res.status}.` };
        }
        const data = (await res.json()) as { dab?: Array<{ id?: string; name?: string }> };
        const dab = data.dab ?? [];
        const needle = name.toLowerCase();
        const match = dab.find(s => (s.name ?? '').toLowerCase() === needle)
          ?? dab.find(s => (s.id ?? '').toLowerCase() === needle)
          ?? dab.find(s => (s.name ?? '').toLowerCase().includes(needle));
        if (!match?.id) {
          return { ok: false, message: `I could not find the DAB+ station "${name}".` };
        }
        const tune = await fetch(`${base}/api/tuners/${config.sdrRadioTuner}/play`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ station: `dab:${match.id}` }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!tune.ok) {
          const detail = await tune.text().catch(() => '');
          return {
            ok: false,
            message: `I could not tune to ${match.name ?? name}: ${detail || `HTTP ${tune.status}`}`,
          };
        }
        const streamUrl = config.sdrRadioStreamUrl;
        const archRow = await pool.query('SELECT architecture FROM devices WHERE id = $1', [deviceId]);
        if (String(archRow.rows[0]?.architecture ?? '').toLowerCase() === 'android') {
          await gateway.requestAction(
            deviceId, 'media.play', { source: 'direct_audio', url: streamUrl, title: match.name }, 20_000,
          );
        } else {
          await requestDeviceAction(deviceId, 'device_http', {
            path: '/api/media/play',
            http_method: 'POST',
            body: { source: 'direct_audio', url: streamUrl, title: match.name },
          }, 20_000);
        }
        mqttNavigation.updateMediaState(deviceId, { state: 'playing', title: match.name ?? name, url: streamUrl });
        return {
          ok: true,
          message: `Tuning to ${match.name ?? name} on digital radio.`,
          data: { device_id: deviceId, station: match.name, url: streamUrl, playback_started: true },
        };
      } catch (error) {
        return {
          ok: false,
          message: `I could not tune to "${name}": ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
    playDispatcharr: async (channel, deviceId) => {
      if (!deviceId || deviceId === 'unknown') {
        return { ok: false, message: 'I could not identify which display requested playback.' };
      }
      const name = channel.trim();
      if (!name) return { ok: false, message: 'A channel name is required.' };
      try {
        const base = config.dispatcharrUrl.replace(/\/$/, '');
        const res = await fetch(`${base}/api/hdhr/lineup.json`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) {
          return { ok: false, message: `Dispatcharr lineup returned HTTP ${res.status}.` };
        }
        const lineup = (await res.json()) as Array<{ GuideName?: string; URL?: string }>;
        const needle = name.toLowerCase();
        const match = lineup.find(entry => (entry.GuideName ?? '').toLowerCase() === needle)
          ?? lineup.find(entry => (entry.GuideName ?? '').toLowerCase().includes(needle));
        if (!match?.URL) {
          return { ok: false, message: `I could not find the channel "${name}" in Dispatcharr.` };
        }
        const archRow = await pool.query('SELECT architecture FROM devices WHERE id = $1', [deviceId]);
        if (String(archRow.rows[0]?.architecture ?? '').toLowerCase() === 'android') {
          await gateway.requestAction(
            deviceId, 'media.play', { source: 'direct_audio', url: match.URL, title: match.GuideName }, 20_000,
          );
        } else {
          await requestDeviceAction(deviceId, 'device_http', {
            path: '/api/media/play',
            http_method: 'POST',
            body: { source: 'direct_audio', url: match.URL, title: match.GuideName },
          }, 20_000);
        }
        mqttNavigation.updateMediaState(deviceId, { state: 'playing', title: match.GuideName ?? name, url: match.URL });
        return {
          ok: true,
          message: `Tuning to ${match.GuideName ?? name}.`,
          data: { device_id: deviceId, channel: match.GuideName, url: match.URL, playback_started: true },
        };
      } catch (error) {
        return {
          ok: false,
          message: `I could not tune to "${name}": ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
    selectMedia: async (selection, deviceId) => {
      if (!deviceId || deviceId === 'unknown') {
        return { ok: false, message: 'I could not identify which display has the playlist choices.' };
      }
      try {
        const result = selection.action === 'cancel'
          ? await controlDeviceMedia(deviceId, 'stop', 'youtube') as Record<string, unknown>
          : await requestDeviceAction(deviceId, 'device_http', {
            path: '/api/media/play',
            http_method: 'POST',
            body: selection.action === 'more'
              ? { source: 'youtube', selection_action: 'more' }
              : { source: 'youtube', selection_position: selection.position },
          }, 20_000) as Record<string, unknown>;
        const playbackStarted = !selection.action;
        const visibleCount = Number((result as Record<string, unknown>).visible_count ?? 0) || 3;
        return {
          ok: true,
          message: selection.action === 'more'
            ? `Showing ${visibleCount} more playlist choices.`
            : selection.action === 'cancel'
              ? 'Playlist selection cancelled.'
              : `Playing the ${['first', 'second', 'third'][selection.position ?? 0] ?? 'selected'} playlist.`,
          data: { device_id: deviceId, result, playback_started: playbackStarted },
        };
      } catch (error) {
        return {
          ok: false,
          message: `I could not apply that playlist choice: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
    controlMedia: async (action, source, deviceId) => {
      if (!deviceId || deviceId === 'unknown') {
        return { ok: false, message: 'I could not identify which display requested media control.' };
      }
      if (source === 'music_assistant') {
        try {
          const archRow = await pool.query('SELECT architecture FROM devices WHERE id = $1', [deviceId]);
          if (String(archRow.rows[0]?.architecture ?? '').toLowerCase() === 'android') {
            return { ok: false, message: 'Music Assistant control is not supported on Android yet.' };
          }
          const result = await requestDeviceAction(deviceId, 'device_http', {
            path: '/api/media/control',
            http_method: 'POST',
            body: { source: 'music_assistant', action },
          }, 10_000);
          const verb = {
            pause: 'Paused Music Assistant playback',
            resume: 'Resumed Music Assistant playback',
            stop: 'Stopped Music Assistant playback',
            next: 'Skipped to the next Music Assistant track',
          }[action] ?? 'Updated Music Assistant playback';
          return { ok: true, message: `${verb}.`, data: { device_id: deviceId, source, action, result } };
        } catch (error) {
          return {
            ok: false,
            message: `I could not control Music Assistant playback: ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
        }
      }
      if (source !== 'youtube') {
        return { ok: false, message: `Media source "${source}" is not supported on the device yet.` };
      }
      try {
        const archRow = await pool.query('SELECT architecture FROM devices WHERE id = $1', [deviceId]);
        if (String(archRow.rows[0]?.architecture ?? '').toLowerCase() === 'android') {
          const result = await gateway.requestAction(
            deviceId, 'media.control', { source, action }, 10_000,
          );
          const verb = {
            pause: 'Paused YouTube playback',
            resume: 'Resumed YouTube playback',
            stop: 'Stopped YouTube playback',
            next: 'Skipped to the next YouTube result',
          }[action];
          mqttNavigation.updateMediaState(deviceId, {
            state: action === 'pause' ? 'paused' : action === 'stop' ? 'idle' : 'playing',
          });
          return { ok: true, message: `${verb}.`, data: { device_id: deviceId, source, action, result } };
        }
        const result = await controlDeviceMedia(deviceId, action, source);
        const verb = {
          pause: 'Paused YouTube playback',
          resume: 'Resumed YouTube playback',
          stop: 'Stopped YouTube playback',
          next: 'Skipped to the next YouTube result',
        }[action];
        mqttNavigation.updateMediaState(deviceId, {
          state: action === 'pause' ? 'paused' : action === 'stop' ? 'idle' : 'playing',
        });
        return {
          ok: true,
          message: `${verb}.`,
          data: { device_id: deviceId, source, action, result },
        };
      } catch (error) {
        return {
          ok: false,
          message: `I could not ${action} YouTube playback: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
    navigateTo: async pageRef => {
      const pageResult = await pool.query(
        `SELECT id FROM pages WHERE id = $1 OR LOWER(name) = LOWER($1) LIMIT 1`,
        [pageRef],
      );
      const pageId = pageResult.rows[0]?.id as string | undefined;
      if (!pageId) return { ok: false, message: `Page "${pageRef}" was not found.` };
      const page = await (async () => {
        const response = await pool.query('SELECT * FROM pages WHERE id = $1', [pageId]);
        const panels = await pool.query('SELECT * FROM page_panels WHERE page_id = $1 ORDER BY position, id', [pageId]);
        return { ...response.rows[0], panels: panels.rows } as import('./legacy-routes.js').PageRow;
      })();
      const devices = gateway.connectedDeviceIds();
      const results = await Promise.allSettled(devices.map(deviceId => deliverPageToDevice(page, deviceId)));
      const delivered = results.filter(result => result.status === 'fulfilled').length;
      return {
        ok: delivered > 0,
        message: delivered
          ? `Displayed "${page.name}" on ${delivered} device${delivered === 1 ? '' : 's'}.`
          : 'No connected device accepted the page.',
        data: { page_id: pageId, delivered },
      };
    },
    goHome: async deviceId => {
      if (!deviceId || deviceId === 'unknown') {
        return { ok: false, message: 'I could not identify which display to navigate.' };
      }
      try {
        const archRow = await pool.query('SELECT architecture FROM devices WHERE id = $1', [deviceId]);
        const nativeAndroid = String(archRow.rows[0]?.architecture ?? '').toLowerCase() === 'android';
        if (nativeAndroid) {
          await gateway.requestAction(deviceId, 'navigate.home', {}, 10_000);
          return { ok: true, message: 'Returned to the home screen.' };
        }
        // Legacy kiosk (no home action): stop media so the sidecar returns to its scene.
        await requestDeviceAction(deviceId, 'device_http', {
          path: '/api/media/control',
          http_method: 'POST',
          body: { source: 'youtube', action: 'stop' },
        }, 10_000);
        return { ok: true, message: 'Returned to the home screen.' };
      } catch (error) {
        return { ok: false, message: `I could not return to the home screen: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
    navigateRole: async (role, deviceId) => {
      if (!deviceId || deviceId === 'unknown') {
        return { ok: false, message: 'I could not identify which display to navigate.' };
      }
      try {
        const devRow = await pool.query('SELECT page_roles FROM devices WHERE id = $1', [deviceId]);
        const pageRoles = (devRow.rows[0]?.page_roles ?? {}) as Record<string, string>;
        const pageId = pageRoles[role];
        if (!pageId) {
          return { ok: false, message: `No "${role}" page is configured for this display.` };
        }
        const pageRes = await pool.query('SELECT * FROM pages WHERE id = $1', [pageId]);
        if (pageRes.rowCount === 0) {
          return { ok: false, message: `The "${role}" page no longer exists.` };
        }
        const panels = await pool.query('SELECT * FROM page_panels WHERE page_id = $1 ORDER BY position, id', [pageId]);
        const page = { ...pageRes.rows[0], panels: panels.rows } as import('./legacy-routes.js').PageRow;
        await deliverPageToDevice(page, deviceId);
        return { ok: true, message: `Displayed the ${role} page.` };
      } catch (error) {
        return { ok: false, message: `I could not open the ${role} page: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
    openUrl: async (url, deviceId, opts) => {
      if (!deviceId || deviceId === 'unknown') {
        return { ok: false, message: 'I could not identify which display to navigate.' };
      }
      if (!/^https?:\/\//i.test(url)) {
        return { ok: false, message: 'Invalid URL.' };
      }
      try {
        const archRow = await pool.query('SELECT architecture FROM devices WHERE id = $1', [deviceId]);
        const nativeAndroid = String(archRow.rows[0]?.architecture ?? '').toLowerCase() === 'android';
        const seconds = await getKnowledgeDisplaySeconds();
        const revertAfterMs = opts?.revertAfterMs ?? (seconds > 0 ? seconds * 1000 : 0);
        if (nativeAndroid) {
          await gateway.requestAction(deviceId, 'navigate.search', { url, revert_after_ms: revertAfterMs }, 10_000);
          return { ok: true, message: 'Opened the page on the display.' };
        }
        // Legacy Linux kiosk: open via its local sidecar's /api/media/open (floating overlay).
        await requestDeviceAction(deviceId, 'device_http', {
          path: '/api/media/open',
          http_method: 'POST',
          body: { url, revert_after_ms: revertAfterMs },
        }, 10_000);
        return { ok: true, message: 'Opened the page on the display.' };
      } catch (error) {
        return { ok: false, message: `I could not open that page: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
    setPanel: async command => {
      if (command.contentType === 'url' && (!command.url || !/^https?:\/\//i.test(command.url))) {
        return { ok: false, message: 'A panel URL must use http:// or https://.' };
      }
      if (command.contentType === 'scene') {
        if (!command.sceneId) return { ok: false, message: 'scene_id is required.' };
        const scene = await pool.query(
          `SELECT 1 FROM scenes WHERE id = $1 AND status = 'published'`,
          [command.sceneId],
        );
        if (scene.rowCount === 0) return { ok: false, message: 'Published scene was not found.' };
      }
      let delivered = 0;
      for (const deviceId of gateway.connectedDeviceIds()) {
        const active = await pool.query(
          'SELECT active_page_id FROM device_page_state WHERE device_id = $1',
          [deviceId],
        );
        const pageId = String(active.rows[0]?.active_page_id ?? '');
        if (!pageId) continue;
        const panel = await pool.query(
          `SELECT id FROM page_panels
           WHERE page_id = $1 AND (id = $2 OR LOWER(name) = LOWER($2))
           LIMIT 1`,
          [pageId, command.panel],
        );
        const panelId = panel.rows[0]?.id as string | undefined;
        if (!panelId) continue;
        const content = command.contentType === 'url'
          ? { type: 'url', url: command.url }
          : command.contentType === 'scene'
            ? { type: 'scene', scene_id: command.sceneId }
            : null;
        await pool.query(
          `INSERT INTO device_panel_state (device_id, panel_id, content, visible, updated_at)
           VALUES ($1, $2, $3::jsonb, COALESCE($4, true), now())
           ON CONFLICT (device_id, panel_id) DO UPDATE SET
             content = COALESCE(excluded.content, device_panel_state.content),
             visible = COALESCE(excluded.visible, device_panel_state.visible),
             updated_at = now()`,
          [deviceId, panelId, content ? JSON.stringify(content) : null, command.visible ?? null],
        );
        const pageRow = await pool.query('SELECT * FROM pages WHERE id = $1', [pageId]);
        const panels = await pool.query('SELECT * FROM page_panels WHERE page_id = $1 ORDER BY position, id', [pageId]);
        await deliverPageToDevice(
          { ...pageRow.rows[0], panels: panels.rows } as import('./legacy-routes.js').PageRow,
          deviceId,
        );
        delivered += 1;
      }
      return {
        ok: delivered > 0,
        message: delivered
          ? `Updated panel "${command.panel}" on ${delivered} device${delivered === 1 ? '' : 's'}.`
          : `Panel "${command.panel}" was not found on a connected device's active page.`,
        data: { delivered },
      };
    },
  });

  // ── Visual Automation Flows (Node-RED style) ──────────────────────────────
  const flowRepo = new FlowRepository(pool);
  flowExecutor = new FlowExecutor(flowRepo, {
    pool,
    callHaService: async (domain, service, data) => {
      if (!ha) throw new Error('HA not configured');
      await ha.callService(domain, service, data as Record<string, unknown>);
    },
    speakTts: async (text, deviceId) => {
      // Directly ask each target device to speak via its own Piper TTS endpoint.
      const targets = deviceId
        ? [deviceId]
        : (await pool.query<{ id: string }>(`SELECT id FROM devices WHERE status='connected' AND paired=true`)).rows.map(r => r.id);
      for (const dId of targets) {
        // Try 1: call the sidecar REST API directly if we know the device IP
        const ip = getDeviceIp(dId)?.replace(/^::ffff:/, '');
        if (ip) {
          try {
            const res = await fetch(`http://${ip}:3100/api/voice/speak`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ text: text.trim() }),
              signal: AbortSignal.timeout(10_000),
            });
            if (res.ok) continue;
          } catch (err) {
            console.warn(`[flows] speakTts direct call failed for ${dId} (${ip}):`, (err as Error).message);
          }
        }
        // Try 2: relay through kiosk device_http (requires kiosk v0.2.51+)
        try {
          await requestDeviceAction(dId, 'device_http', {
            path: '/api/voice/speak',
            http_method: 'POST',
            body: { text: text.trim() },
          });
        } catch (err) {
          // Try 3: broadcast-poller fallback
          console.warn(`[flows] speakTts device_http failed for ${dId}, using broadcast fallback:`, (err as Error).message);
          if (flowEnqueueTts) await flowEnqueueTts(text, dId);
        }
      }
    },
    switchScene: async (sceneName, deviceId) => {
      const r = await pool.query<{ id: string }>(
        `SELECT id FROM scenes WHERE lower(name) = lower($1) AND status='published' LIMIT 1`,
        [sceneName]
      );
      if (!r.rows[0]) {
        console.warn(`[flows] switchScene: no published scene named "${sceneName}"`);
        return;
      }
      const url = `/display/scenes/${encodeURIComponent(r.rows[0].id)}`;
      const targets = deviceId
        ? [deviceId]
        : (await pool.query<{ id: string }>(`SELECT id FROM devices WHERE status='connected' AND paired=true`)).rows.map(row => row.id);
      for (const dId of targets) {
        await requestDeviceAction(dId, 'navigate_scene', { url })
          .catch(err => console.warn(`[flows] switchScene failed for ${dId}:`, (err as Error).message));
      }
    },
    askAi: async (prompt) => {
      const result = await intelligence.runIntelligentPipeline({
        transcript: prompt,
        skipTts: true,
      });
      return result.reply ?? '';
    },
    runIntentPipeline: async (text) => {
      const result = await intelligence.runIntelligentPipeline({
        transcript: text,
        skipTts: true,
      });
      // Build a simple slots map from entities + tool_call params
      const slots: Record<string, unknown> = {};
      for (const entity of result.intent?.entities ?? []) {
        slots[entity.id] = entity.name;
      }
      for (const tc of result.intent?.tool_calls ?? []) {
        Object.assign(slots, tc.arguments ?? {});
      }
      return {
        intent: String(result.intent?.intent ?? 'unknown'),
        reply: result.reply ?? '',
        slots,
      };
    },
    navigateDeviceToUrl: async (url, deviceId) => {
      const targets = deviceId
        ? [deviceId]
        : (await pool.query<{ id: string }>(`SELECT id FROM devices WHERE status='connected' AND paired=true`)).rows.map(r => r.id);
      for (const dId of targets) {
        await requestDeviceAction(dId, 'navigate_scene', { url })
          .catch(err => console.warn(`[flows] navigateDeviceToUrl failed for ${dId}:`, (err as Error).message));
      }
    },
    pushKnowledgeCard: async (card, deviceId) => {
      const targets = deviceId
        ? [deviceId]
        : (await pool.query<{ id: string }>(`SELECT id FROM devices WHERE status='connected' AND paired=true`)).rows.map(row => row.id);
      for (const dId of targets) {
        await requestDeviceAction(dId, 'device_http', {
          path: '/api/knowledge-card',
          http_method: 'POST',
          body: { title: card.title, body: card.body, source_label: card.source_label },
        }).catch(err => console.warn(`[flows] pushKnowledgeCard failed for ${dId}:`, (err as Error).message));
      }
    },
    sendDeviceCommand: async (deviceId, command, payload) => {
      const devices = deviceId
        ? [deviceId]
        : (await pool.query<{ id: string }>(`SELECT id FROM devices WHERE status='connected' AND paired=true`)).rows.map(r => r.id);
      for (const dId of devices) {
        await requestDeviceAction(dId, command, payload as Record<string, unknown> | undefined)
          .catch(err => console.warn(`[flows] device command "${command}" failed for ${dId}:`, (err as Error).message));
      }
    },
    broadcastAlert: async (title, message, type = 'info', deviceIds) => {
      if (flowBroadcastAlert) flowBroadcastAlert(title, message, type, deviceIds);
    },
    broadcastIntercom: async (deviceId, durationSeconds = 8) => {
      const targets = deviceId
        ? [deviceId]
        : (await pool.query<{ id: string }>(`SELECT id FROM devices WHERE status='connected' AND paired=true`)).rows.map(r => r.id);
      for (const dId of targets) {
        const ip = getDeviceIp(dId)?.replace(/^::ffff:/, '');
        if (ip) {
          try {
            const res = await fetch(`http://${ip}:3100/api/voice/broadcast`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ duration: durationSeconds }),
              signal: AbortSignal.timeout(5_000),
            });
            if (res.ok) continue;
          } catch { /* fall through to device_http relay */ }
        }
        await requestDeviceAction(dId, 'device_http', {
          path: '/api/voice/broadcast',
          http_method: 'POST',
          body: { duration: durationSeconds },
        }).catch(err => console.warn(`[flows] broadcastIntercom trigger failed for ${dId}:`, (err as Error).message));
      }
    },
    broadcastAnnounce: async (message) => {
      const text = message.trim();
      if (!text) return;
      const speech = intelligence.providers.tts;
      if (!speech) {
        console.warn('[flows] broadcastAnnounce: no TTS provider configured');
        return;
      }
      const audio = await speech.synthesize(text);
      const clip = broadcastStore.add(audio, 'audio/wav', text);
      await broadcastFanOut(clip);
    },
    switchPage: async (pageName, deviceId) => {
      // Resolve page by name or ID
      const pageIdRow = await pool.query<{ id: string }>(
        `SELECT id FROM pages WHERE LOWER(name) = LOWER($1) OR id = $1 LIMIT 1`,
        [pageName]
      );
      if (!pageIdRow.rows[0]) {
        console.warn(`[flows] switchPage: page not found: "${pageName}"`);
        return;
      }
      const pageId = pageIdRow.rows[0].id;
      const pageRow = await pool.query(`SELECT * FROM pages WHERE id = $1`, [pageId]);
      const panelsRow = await pool.query(
        `SELECT * FROM page_panels WHERE page_id = $1 ORDER BY position, id`,
        [pageId]
      );
      const page: import('./legacy-routes.js').PageRow = {
        id: pageId,
        name: String(pageRow.rows[0]?.name ?? pageName),
        floating_config: (pageRow.rows[0]?.floating_config as import('./legacy-routes.js').PageRow['floating_config']) ?? null,
        panels: panelsRow.rows.map(r => ({
          id: String(r.id),
          page_id: pageId,
          name: r.name ? String(r.name) : '',
          x: Number(r.x ?? 0),
          y: Number(r.y ?? 0),
          w: Number(r.w ?? 0),
          h: Number(r.h ?? 0),
          view_id: r.view_id ? String(r.view_id) : null,
          content_type: (r.content_type as 'url' | 'scene') ?? 'url',
          url: r.url ? String(r.url) : null,
          scene_id: r.scene_id ? String(r.scene_id) : null,
          z_index: Number(r.z_index ?? 0),
          visible: Boolean(r.visible ?? true),
          opacity: Number(r.opacity ?? 1),
          position: Number(r.position ?? 0),
        })),
        assigned_device_ids: [],
        created_at: String(pageRow.rows[0]?.created_at ?? ''),
        updated_at: String(pageRow.rows[0]?.updated_at ?? ''),
      };
      const targets = deviceId
        ? [deviceId]
        : (await pool.query<{ id: string }>(`SELECT id FROM devices WHERE status='connected' AND paired=true`)).rows.map(r => r.id);
      for (const dId of targets) {
        sendCommand(dId, { type: 'load_page', page_id: page.id, page_data: page });
      }
    },
  });
  registerFlowRoutes(fastify, flowRepo, flowExecutor, requireAdmin);
  // Start cron scheduler for trigger_schedule nodes
  void flowExecutor.startScheduler().catch(err =>
    console.warn('[flows] scheduler startup error:', (err as Error).message)
  );
  // Periodically look for recurring AI-fallback requests with no matching flow
  // and ask the conversation model to draft one (always created disabled — an
  // administrator must review and enable it from the Flow editor).
  await migrateFlowAiDraftsTable(pool);
  const AUTOMATION_GAP_INTERVAL_MS = 30 * 60_000;
  const checkAutomationGaps = () => {
    // Coding / HA-automation drafting may use the cloud model directly when the
    // operator has enabled cloud AI; otherwise it uses the local conversation model.
    const cloudProvider = config.cloudAiEnabled && intelligence.registry
      ? (config.cloudAiProviderId
          ? intelligence.registry.getLlmProviderById(config.cloudAiProviderId)
          : undefined)
        ?? intelligence.registry.getLlmCandidates('conversation').find(c => !c.capabilities.local)?.instance
      : undefined;
    const conversationProvider = cloudProvider
      ?? intelligence.registry?.getLlmProvider('conversation')
      ?? intelligence.providers.llm;
    if (!conversationProvider) return;
    if (cloudProvider) {
      logCloudUsage({
        purpose: 'ha_automation',
        providerId: config.cloudAiProviderId || 'cloud',
        operation: 'flow_draft',
        ok: true,
      });
    }
    runAutomationGapDetection(pool, flowRepo, conversationProvider).catch(err =>
      console.warn('[core][auto-flow] gap detection failed:', (err as Error).message)
    );
  };
  setInterval(checkAutomationGaps, AUTOMATION_GAP_INTERVAL_MS);
  setTimeout(checkAutomationGaps, 60_000);
  intelligence.setToolContext({
    invokeVoiceFlow: async (transcript, deviceId) => {
      if (!flowExecutor) return { matched: false };
      const flow = await flowExecutor.matchVoiceTrigger(transcript);
      if (!flow) return { matched: false };
      const executionId = await flowExecutor.execute(flow.id, { transcript, deviceId });
      return { matched: true, flowName: flow.name, executionId };
    },
    invokeIntentFlows: async (intent, deviceId, slots) => {
      if (!flowExecutor) return;
      const matches = await flowExecutor.matchIntentTriggers(intent, slots);
      for (const { flow, triggerData } of matches) {
        void flowExecutor.execute(flow.id, { ...triggerData, deviceId }).catch(err =>
          console.warn(`[flows] intent trigger "${flow.name}" failed:`, (err as Error).message)
        );
      }
    },
  });

  await registerLegacyRoutes(fastify, {
    pool,
    requireAdmin,
    onDisplayPage: deliverPageToDevice,
    getMqttStatus: () => ({ ...mqttNavigation.getStatus() }),
    reconnectMqtt: async () => ({ ...await mqttNavigation.start() }),
    disconnectMqtt: () => mqttNavigation.stop(),
    settingsChanged: async updatedKeys => {
      if (updatedKeys.some(key => key.startsWith('mqtt_'))) await mqttNavigation.start();
      if (updatedKeys.some(key => key.startsWith('cloud_ai_'))) await refreshCloudPolicy();
      if (updatedKeys.some(key => key.startsWith('request_routing_'))) await reloadRequestRoutingPolicy();
      const voiceCueKeys = [
        'voice_wake_ack_enabled', 'voice_wake_ack_sound',
        'voice_good_intent_enabled', 'voice_good_intent_sound',
        'voice_no_intent_enabled', 'voice_no_intent_sound',
      ];
      if (updatedKeys.some(key => voiceCueKeys.includes(key))) {
        const values = await pool.query<{ key: string; value: string }>(
          'SELECT key, value FROM settings WHERE key = ANY($1::text[])',
          [voiceCueKeys],
        );
        const setting = Object.fromEntries(values.rows.map(row => [row.key, row.value]));
        const cueConfig = {
          wake_ack_enabled: setting.voice_wake_ack_enabled !== '0',
          wake_ack_sound: setting.voice_wake_ack_sound || 'builtin:ready_up',
          good_intent_enabled: setting.voice_good_intent_enabled !== '0',
          good_intent_sound: setting.voice_good_intent_sound || 'builtin:digital_pop',
          no_intent_enabled: setting.voice_no_intent_enabled !== '0',
          no_intent_sound: setting.voice_no_intent_sound || 'builtin:wood_tap',
        };
        const devices = await pool.query<{ id: string }>('SELECT id FROM devices WHERE revoked_at IS NULL');
        await pool.query(
          `UPDATE devices SET voice_config = COALESCE(voice_config, '{}'::jsonb) || $1::jsonb WHERE revoked_at IS NULL`,
          [JSON.stringify(cueConfig)],
        );
        await Promise.allSettled(devices.rows.flatMap(({ id }) => [
          gateway.requestAction(id, 'voice.reload_config'),
          requestDeviceAction(id, 'device_http', {
            path: '/api/settings',
            http_method: 'PUT',
            body: Object.fromEntries(voiceCueKeys.map(key => [key, setting[key] ?? ''])),
          }).then(() => requestDeviceAction(id, 'device_http', {
            path: '/api/settings/voice/restart',
            http_method: 'POST',
          }, 15_000)),
        ]));
      }
    },
    connectedDeviceIds: () => gateway.connectedDeviceIds(),
  });
  fastify.addHook('onClose', async () => mqttNavigation.stop());

  // Phase 5: Authenticated voice session WSS (separate from device gateway, plan doc §14).
  const voiceSessionManager = new VoiceSessionManager({ config, intelligence });
  voiceSessionManager.register(fastify);

  // ── Phase 8: Authority cutover (plan doc §26.5, §26.6) ────────────────
  const authorityRepo = new (await import('./authority.js')).PgAuthorityRepository(pool);
  await (await import('./authority.js')).migrateAuthority(pool);
  await (await import('./authority.js')).registerAuthorityRoutes(fastify, { repo: authorityRepo, requireAdmin });

  // ── Phase 6: Shadow mode (Hermes-disablement gate, plan doc §15.6) ─----
  const hermesUrl = process.env.CANVAS_CORE_HERMES_URL;
  const hermesClient = createHermesClient(hermesUrl);
  const shadowMode = new ShadowModeRunner({ hermesClient });

  if (hermesClient) {
    console.log(`[core][shadow] Hermes client configured at ${hermesUrl}`);
  } else {
    console.log('[core][shadow] Hermes not configured (set CANVAS_CORE_HERMES_URL to enable shadow comparison)');
  }

  // Shadow mode status (GET, no CSRF — read-only)
  fastify.get('/api/admin/shadow-mode/status', {
    preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }),
  }, async () => {
    return shadowMode.getStatus();
  });

  // Run full corpus comparison (POST, admin-only, CSRF-protected)
  fastify.post('/api/admin/shadow-mode/run', {
    preHandler: requireAdmin({ roles: ['admin'] }),
  }, async () => {
    const report = await shadowMode.runCorpus();
    return report;
  });

  // Run single transcript (POST, admin-only, CSRF-protected)
  fastify.post('/api/admin/shadow-mode/run-single', {
    preHandler: requireAdmin({ roles: ['admin'] }),
  }, async (request) => {
    const body = request.body as { transcript?: unknown } | undefined;
    if (typeof body?.transcript !== 'string' || body.transcript.length === 0) {
      return { error: 'transcript is required' };
    }
    const result = await shadowMode.runSingle(body.transcript);
    return result;
  });

  // Get last shadow report (GET, no CSRF — read-only)
  // ── Phase 7: Canary / Staged Rollout (plan doc §21.3) ─────────────────
  const rolloutRepo = new InMemoryRolloutRepository();
  const rolloutStrategy = new RolloutStrategy(rolloutRepo);
  registerRolloutRoutes(fastify, { strategy: rolloutStrategy, requireAdmin });

  fastify.get('/api/admin/shadow-mode/report', {
    preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }),
  }, async () => {
    const report = shadowMode.getLastReport();
    if (!report) {
      return { error: 'no_report', message: 'No shadow report has been generated yet. Run POST /api/admin/shadow-mode/run first.' };
    }
    return report;
  });

  // ── Log level control ────────────────────────────────────────────────
  fastify.get('/api/admin/log-level', {
    preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }),
  }, async () => {
    return { level: getLevel() };
  });

  fastify.put('/api/admin/log-level', {
    preHandler: requireAdmin({ roles: ['admin'] }),
  }, async (request, reply) => {
    const body = request.body as { level?: unknown } | undefined;
    if (typeof body?.level !== 'string' || !['error', 'warn', 'info', 'debug'].includes(body.level)) {
      reply.code(400);
      return { error: 'level must be one of: error, warn, info, debug' };
    }
    const level = body.level as LogLevel;
    setLevel(level);
    fastify.log.level = level;
    return { level: getLevel() };
  });

  // ── AI Chat endpoint (POST /api/admin/ai/chat) ─────────────────────────
  // Admin-only, CSRF-protected. Accepts a conversation history and optional
  // providerId; returns the LLM reply. Supports tool-calling: the LLM can
  // discover and invoke MCP tools registered in the tool registry.
  const pendingAdminMcp = new Map<string, {
    tool: string; params: Record<string, unknown>; digest: string; expiresAt: number;
  }>();

  fastify.post('/api/admin/ai/chat', {
    preHandler: requireAdmin({ roles: ['admin'] }),
  }, async (request, reply) => {
    const body = request.body as
      | { messages?: unknown; providerId?: string; options?: { disableThinking?: boolean; maxTokens?: number; noTools?: boolean } }
      | undefined;
    if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
      reply.code(400);
      return { error: 'messages array is required' };
    }

    // Validate each message has the right shape.
    for (const m of body.messages) {
      if (typeof m !== 'object' || m === null) {
        reply.code(400);
        return { error: 'each message must be an object' };
      }
      const msg = m as { role?: unknown; content?: unknown };
      if (!['user', 'assistant', 'system', 'tool'].includes(msg.role as string)) {
        reply.code(400);
        return { error: 'message role must be user, assistant, system, or tool' };
      }
      if (typeof msg.content !== 'string') {
        reply.code(400);
        return { error: 'message content must be a string' };
      }
    }

    const messages = body.messages as Array<{ role: 'user' | 'assistant' | 'system' | 'tool'; content: string }>;

    // Resolve the LLM provider.
    let llmProvider: LlmProvider;
    let providerId: string;
    let model: string | undefined;

    if (body.providerId && intelligence.registry) {
      const fromRegistry = intelligence.registry.getLlmProviderById(body.providerId);
      if (!fromRegistry) {
        reply.code(400);
        return { error: `LLM provider '${body.providerId}' not found` };
      }
      llmProvider = fromRegistry;
      providerId = body.providerId;
    } else {
      const assigned = intelligence.registry?.getProvider('conversation');
      llmProvider = intelligence.registry?.getLlmProvider('conversation') ?? intelligence.providers.llm;
      providerId = assigned?.id ?? 'default';
    }

    // Try to extract the model name from the provider config.
    if (intelligence.registry) {
      const providers = intelligence.registry.listProviders();
      const match = providers.find((p) => p.id === providerId);
      if (match?.config?.model) {
        model = String(match.config.model);
      }
    }

    // ── Build tool definitions ────────────────────────────────────────────
    // Gather tools from the native tool registry only. MCP tools are already
    // registered there by intelligence.ts with the `mcp.<server>.<tool>` prefix.
    // Duplicating them from the MCP client directly would confuse the LLM.
    // Rebuilt every loop iteration so MCP tools that appear mid-conversation
    // (e.g. after a tool-list refresh) become available to the model.
    const latestUserMessage = [...messages].reverse().find(message => message.role === 'user')?.content ?? '';

    const buildToolDefinitions = (): import('./providers/llm.js').ToolDefinition[] => {
      const nativeTools = body.options?.noTools
        ? []
        : selectToolsForRequest(intelligence.toolRegistry.listTools('admin'), latestUserMessage);
      return nativeTools.map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.schema as Record<string, unknown>,
        },
      }));
    };

    // MCP servers can change their exposed tool set at runtime (e.g. HA-MCP
    // only exposes write tools after read-only mode is disabled). Refresh the
    // registry when the cached list is older than the TTL so the model always
    // sees the current tool surface.
    const MCP_TOOLS_TTL_MS = 60_000;
    if (!body.options?.noTools && Date.now() - intelligence.getMcpToolsLastRefreshAt() > MCP_TOOLS_TTL_MS) {
      try {
        await intelligence.reloadMcpTools();
        console.log('[core][ai-chat] refreshed MCP tool registry (stale)');
      } catch (err) {
        console.error('[core][ai-chat] MCP tool refresh failed:', err instanceof Error ? err.message : err);
      }
    }
    let toolDefinitions = buildToolDefinitions();

    const mcpClient = intelligence.providers.mcp;

    // ── Chat loop with tool execution ─────────────────────────────────────
    // Up to 5 iterations to handle chains of tool calls.
    const MAX_ITERATIONS = 8;
    let currentMessages: import('./providers/types.js').ChatMessage[] = messages;
    let finalContent = '';
    let mcpRefreshedInConversation = false;

    // Tool-discipline system prompt. The chat has broad access to MCP tools —
    // including mutating ones (HA config writes, Node-RED flow edits, service
    // calls) — so set explicit expectations for when tools may be used.
    const toolSystemPrompt = [
      'You are the Canvas Core smart-home assistant. You have tools for Home Assistant (ha-mcp), Node-RED flow editing (node-red mcp), weather, sport and web search.',
      'Tool discipline:',
      '- Questions, reviews, analyses and "report/tell me/show me/what needs fixing" style requests are answered IN CHAT. Inspect with read-only tools (get/list/search) and reply — do NOT create notifications, issues or reports anywhere.',
      '- ha_report_issue ONLY generates a bug-report template for the ha-mcp server itself. Use it only when the user explicitly asks to file an issue/bug report.',
      '- Mutating tools (create/set/update/delete/deploy/inject/call_service/…) are used only when the user explicitly asks you to make that change. Changing things the user did not ask to change is a failure.',
      '- Node-RED edits are staged on the server; call the deploy tool to make them live and tell the user you did.',
      '- If a tool call fails with "not available", the MCP tool list was refreshed — retry once using an exact function name from the provided list.',
      '- Prefer the fewest tool calls that answer the request, and summarise tool output in your reply instead of dumping it.',
      '- Use only the exact function names provided in the tool definitions. Never invent aliases such as ha-get-state, get-height, or search-wikipedia.',
      '- For Home Assistant, entity_id must be a full ID such as light.desk or sun.sun; use the supplied entity candidates and do not guess friendly names.',
      '- Answer stable general-knowledge questions from your own knowledge when you know the answer. Use lookup tools for current, changing, local, or explicitly researched information.',
    ].join('\n');

    try {
      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        // Prepend the tool-discipline system prompt on EVERY turn so it is
        // never lost mid-conversation.
        const messagesForLlm: import('./providers/types.js').ChatMessage[] = [
          { role: 'system', content: toolSystemPrompt },
          ...currentMessages,
        ];
        const result = await llmProvider.chatWithTools(messagesForLlm, toolDefinitions, {
          // Sensible floor so long multi-part reports don't truncate when the
          // client sends no explicit cap.
          maxTokens: body.options?.maxTokens ?? 4000,
          disableThinking: body.options?.disableThinking,
        });
        if ((!result.toolCalls || result.toolCalls.length === 0) && result.content) {
          const recovered = parseContentAsToolCalls(result.content);
          if (recovered) {
            result.toolCalls = recovered;
            result.content = '';
          }
        }

        // Accumulate assistant content.
        if (result.content) {
          finalContent = finalContent
            ? finalContent + '\n' + result.content
            : result.content;
        }

        // If no tool calls, we're done.
        if (!result.toolCalls || result.toolCalls.length === 0) {
          break;
        }

        // Build the assistant message with tool_calls.
        const assistantMsg: import('./providers/types.js').ChatMessage = {
          role: 'assistant',
          content: result.content || '',
          tool_calls: result.toolCalls,
        };
        currentMessages.push(assistantMsg);

        // Execute each tool call.
        for (const tc of result.toolCalls) {
          let toolResult: string;
          try {
            const rawParams = JSON.parse(tc.function.arguments);
            const canonicalToolName = resolveToolName(
              tc.function.name,
              intelligence.toolRegistry.listTools('admin'),
            ) ?? tc.function.name;
            const params = normalizeToolArguments(canonicalToolName, rawParams);
            const resolveEntityId = async (value: unknown): Promise<unknown> => {
              if (typeof value !== 'string') return value;
              if (value.includes('.') && ha?.getEntity(value)) return value;
              const searchValue = value.includes('.') ? value.replace(/^[^.]+\./, '').replace(/_/g, ' ') : value;
              const resolver = intelligence.getToolContext().resolveHaEntities;
              if (!resolver) return value;
              const exact = await resolver(searchValue, { exact: true });
              if (exact.length === 1) return exact[0].entityId;
              const fuzzy = await resolver(searchValue);
              return fuzzy.length === 1 ? fuzzy[0].entityId : value;
            };
            if ('entity_id' in params) params.entity_id = await resolveEntityId(params.entity_id);

            // Check if this is an MCP tool (namespaced as mcp.<name> or just <name> from MCP).
            const nativeTool = intelligence.toolRegistry.getTool(canonicalToolName);
            if (nativeTool) {
              if (mcpCallRequiresConfirmation(nativeTool.name, params)) {
                const token = randomUUID();
                const digest = confirmationDigest(nativeTool.name, params);
                pendingAdminMcp.set(token, {
                  tool: nativeTool.name,
                  params,
                  digest,
                  expiresAt: Date.now() + 60_000,
                });

                return {
                  reply: `Confirmation required before running ${nativeTool.name}.`,
                  providerId,
                  model,
                  pendingConfirmation: { token, tool: nativeTool.name, params, expiresAt: new Date(Date.now() + 60_000).toISOString() },
                };
              }
              // Execute via native tool registry.
              const execResult = await intelligence.toolRegistry.executeTool(
                nativeTool.name,
                params,
                {
                  ...intelligence.getToolContext(),
                  principal: 'admin',
                  role: 'admin',
                  haClient: ha,
                  intelligence,
                  mcp: mcpClient,
                },
              );
              if (nativeTool.name.endsWith('.ha_get_camera_image') && execResult.ok) {
                const blocks = Array.isArray(execResult.data) ? execResult.data as Array<Record<string, unknown>> : [];
                const image = blocks.find(block => block.type === 'image' && typeof block.data === 'string');
                if (image) {
                  const visionProviderId = intelligence.registry?.getAssignments().vision;
                  const visionProvider = visionProviderId
                    ? intelligence.registry?.getLlmProviderById(visionProviderId)
                    : undefined;
                  if (!visionProviderId || !visionProvider?.analyzeImage) {
                    return {
                      reply: 'The camera image was retrieved, but no vision-capable AI provider is assigned. Configure Camera Vision under Settings, AI Providers.',
                      providerId,
                      model,
                    };
                  }
                  const mimeType = typeof image.mimeType === 'string' ? image.mimeType : 'image/jpeg';
                  const answer = await visionProvider.analyzeImage(
                    `Answer this request using only what is visibly supported by the current camera image: ${latestUserMessage}. State uncertainty clearly and do not infer a person's identity.`,
                    image.data as string,
                    mimeType,
                  );
                  return { reply: answer, providerId: visionProviderId, model };
                }
              }
              toolResult = JSON.stringify(execResult);
            } else {
              // The model may reference a tool that only appeared after the
              // cached MCP tool list was built (e.g. HA-MCP starts exposing
              // write tools when read-only mode is disabled). Force one tool
              // registry refresh; the next loop iteration re-runs with the
              // updated tool definitions so the model can retry with the
              // correct current function names.
              if (/^mcp[._-]/i.test(tc.function.name) && !mcpRefreshedInConversation) {
                mcpRefreshedInConversation = true;
                try {
                  await intelligence.reloadMcpTools();
                  toolDefinitions = buildToolDefinitions();
                  console.log('[core][ai-chat] refreshed MCP tool registry (unknown tool requested)');
                  toolResult = JSON.stringify({
                    ok: false,
                    message: `Tool '${tc.function.name}' is not available. The MCP tool list has just been refreshed — if this capability now exists, call it again using one of the exact function names provided.`,
                  });
                } catch (refreshErr) {
                  console.error('[core][ai-chat] MCP tool refresh failed:', refreshErr instanceof Error ? refreshErr.message : refreshErr);
                  toolResult = JSON.stringify({ ok: false, message: `Tool '${tc.function.name}' not found` });
                }
              } else {
                toolResult = JSON.stringify({ ok: false, message: `Tool '${tc.function.name}' not found` });
              }
            }
          } catch (err) {
            toolResult = JSON.stringify({
              ok: false,
              message: err instanceof Error ? err.message : String(err),
            });
          }

          currentMessages.push({
            role: 'tool',
            content: toolResult,
            tool_call_id: tc.id,
          });
        }
      }

      // If the loop ran out of turns while the model was still working (last
      // message is a tool result), or it produced no prose at all, force one
      // final no-tools call so the user gets the actual findings instead of a
      // mid-investigation narration or silence.
      const lastMessage = currentMessages[currentMessages.length - 1];
      const loopExhausted = lastMessage?.role === 'tool';
      if (loopExhausted || !finalContent.trim()) {
        currentMessages.push({
          role: 'system',
          content: loopExhausted
            ? 'Your tool-calling turns are exhausted. Using the tool results already gathered, write your FINAL report to the user now in plain prose. Do not request more tools. If some checks could not be completed, state that explicitly in the report.'
            : 'You have used all available tool-calling turns. Answer the user now in plain prose using only the tool results already gathered. Do not request more tools.',
        });
        const final = await llmProvider.chatWithTools(
          [{ role: 'system', content: toolSystemPrompt }, ...currentMessages],
          [],
          {
            maxTokens: body.options?.maxTokens,
            disableThinking: body.options?.disableThinking,
          },
        );
        if (final.content && final.content.trim()) {
          finalContent = final.content;
        }
      }
      if (!finalContent.trim()) {
        finalContent = 'I ran out of tool-calling turns before producing an answer. Please try again or narrow the request.';
      }
      return { reply: finalContent, providerId, model };
    } catch (err) {
      reply.code(502);
      return { error: 'chat failed', detail: (err as Error).message };
    }
  });

  fastify.post('/api/admin/ai/chat/confirm', {
    preHandler: requireAdmin({ roles: ['admin'] }),
  }, async (request, reply) => {
    const token = (request.body as { token?: string } | undefined)?.token;
    if (!token) return reply.code(400).send({ error: 'confirmation token is required' });
    const pending = pendingAdminMcp.get(token);
    pendingAdminMcp.delete(token);
    if (!pending || pending.expiresAt <= Date.now()) {
      return reply.code(410).send({ error: 'confirmation expired or was already used' });
    }
    const result = await intelligence.toolRegistry.executeTool(pending.tool, pending.params, {
      ...intelligence.getToolContext(),
      principal: 'admin',
      role: 'admin',
      haClient: ha,
      intelligence,
      mcp: intelligence.providers.mcp,
    }, pending.digest);
    // Include the tool's own output in the reply so the confirmation turn
    // actually shows what happened, instead of a bare "executed" line.
    let confirmationReply = result.message;
    if (Array.isArray(result.data) && result.data.length > 0) {
      const text = result.data
        .map((block: Record<string, unknown>) => (block.type === 'text' ? String(block.text ?? '') : `[${block.type}]`))
        .join('\n')
        .trim();
      if (text) confirmationReply += '\n\n' + text.slice(0, 2000);
    } else if (typeof result.data === 'string' && result.data.trim()) {
      confirmationReply += '\n\n' + result.data.slice(0, 2000);
    }
    return { reply: confirmationReply, toolResult: result };
  });

  const discovery = advertiseCore(config);
  fastify.addHook('onClose', async () => discovery.stop());
  await fastify.listen({ host: config.host, port: config.port });
  console.log(`[core] listening on http://${config.host}:${config.port}`);

  // Log provider availability at startup (D-010 degraded mode: never crash Core).
  try {
    const statuses = await intelligence.health();
    if (ha) statuses.push(await ha.healthCheck());
    for (const s of statuses) {
      const tag = s.healthy ? 'UP  ' : 'DOWN';
      console.log(`[core][providers] ${tag} ${s.name} (${s.kind})${s.detail ? ' — ' + s.detail : ''}`);
    }
  } catch (err) {
    console.warn('[core][providers] health probe failed:', (err as Error).message);
  }

  // Log initial privacy settings.
  const initialPrivacy = await privacyRepo.getSettings();
  console.log(`[core][privacy] retain_transcripts=${initialPrivacy.retain_transcripts}, retain_audio=${initialPrivacy.retain_audio}, transcript_log=${initialPrivacy.transcript_log_level}`);

  // Log shadow mode status.
  let corpusSize = 0;
  try {
    corpusSize = loadCorpus().length;
    console.log(`[core][shadow] Hermes corpus loaded: ${corpusSize} test cases`);
  } catch (err) {
    console.warn('[core][shadow] Could not load Hermes corpus:', (err as Error).message);
  }
}

main().catch((err) => {
  console.error('[core] fatal:', err);
  process.exit(1);
});
