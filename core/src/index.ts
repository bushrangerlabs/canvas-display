import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { loadConfig } from './config.js';
import { getPool, migrate } from './db.js';
import { registerGateway } from './gateway.js';
import { createIntelligence, type Intelligence } from './intelligence.js';
import type { LlmProvider } from './providers/llm.js';
import { createHomeAssistantClient, type HomeAssistantClient } from './providers/ha.js';
import {
  registerAuth,
  bootstrapAdmin,
  PgAuthRepository,
} from './auth.js';
import {
  registerDeviceRoutes,
  PgDeviceRepository,
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
import { policyFromSettings } from './request-routing.js';
import { confirmationDigest, mcpCallRequiresConfirmation, selectToolsForRequest } from './mcp-policy.js';
import { FlowRepository, FlowExecutor, registerFlowRoutes } from './flows.js';

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

  // Canvas Intelligence — wire provider clients from config (degraded mode if unset).
  const intelligence: Intelligence = createIntelligence(config, {
    privacyRepo,
    privacyFilter,
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

  const reconcileHaEntityCache = async (): Promise<number> => {
    if (!ha) return 0;
    const entities = await ha.refreshEntities();
    await Promise.all(entities.map((entity) => cacheHaEntity(entity)));
    const ids = entities.map((entity) => entity.entityId);
    if (ids.length > 0) {
      await pool.query('DELETE FROM ha_entities WHERE NOT (entity_id = ANY($1::text[]))', [ids]);
    }
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
    version: '0.1.0',
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
  let flowBroadcastIntercom: ((text: string, from?: string, deviceIds?: string[]) => Promise<void>) | null = null;
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
      ha.onEntityChange((entityId, entity) => {
        const attrs = entity.attributes as Record<string, unknown> | undefined ?? {};
        const isDoorbellEntity =
          (attrs.device_class === 'doorbell' || entityId.toLowerCase().includes('doorbell'))
          && entity.state === 'on';
        if (!isDoorbellEntity) return;
        const now = Date.now();
        const lastFire = lastDoorbellFire.get(entityId) ?? 0;
        if (now - lastFire < doorbellCooldownMs) return; // debounce
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

    flowBroadcastIntercom = async (text, from = 'system', targetDeviceIds) => {
      const speech = intelligence.providers.tts;
      if (!speech) { console.warn('[core][intercom] TTS not configured for flow broadcast'); return; }
      const buf = await speech.synthesize(text);
      const audio = buf.toString('base64');
      const timestamp = new Date().toISOString();
      const entry: PendingIntercom = { audioBase64: audio, from, timestamp };
      const targets = targetDeviceIds?.length ? targetDeviceIds : [ALL_INTERCOM];
      for (const id of targets) pendingIntercom.set(id, entry);
      console.log(`[core][intercom] flow queued from=${from} targets=${targets.join(',')}`);
    };

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

  // Minimal admin API stub — Phase 2 expands this (auth, devices, scenes, commands).
  fastify.get('/api/devices', async () => {
    const pool = getPool(config);
    const result = await pool.query(
      'SELECT id, name, architecture, status, last_seen, audio_config, voice_config FROM devices ORDER BY last_seen DESC',
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
  intelligence.setToolContext({
    haClient: ha,
    resolveHaEntities: async (query) => {
      const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(term => term.length >= 3).slice(0, 8);
      if (terms.length === 0) return [];
      const patterns = terms.map(term => `%${term}%`);
      const result = await pool.query(
        `SELECT e.entity_id, e.friendly_name, e.domain, e.state,
                COALESCE(d.name_by_user, d.name) AS device_name, a.name AS area_name
         FROM ha_entities e
         LEFT JOIN ha_entity_registry r ON r.entity_id=e.entity_id
         LEFT JOIN ha_devices d ON d.device_id=r.device_id
         LEFT JOIN ha_areas a ON a.area_id=COALESCE(r.area_id, d.area_id)
         WHERE EXISTS (
           SELECT 1 FROM unnest($1::text[]) pattern
           WHERE lower(e.entity_id) LIKE pattern OR lower(COALESCE(e.friendly_name, '')) LIKE pattern
              OR lower(COALESCE(d.name_by_user, d.name, '')) LIKE pattern
              OR lower(COALESCE(a.name, '')) LIKE pattern
         )
         ORDER BY e.friendly_name NULLS LAST, e.entity_id
         LIMIT 12`,
        [patterns],
      );
      return result.rows.map(row => ({
        entityId: String(row.entity_id),
        friendlyName: row.friendly_name ? String(row.friendly_name) : undefined,
        domain: String(row.domain),
        state: String(row.state),
        deviceName: row.device_name ? String(row.device_name) : undefined,
        areaName: row.area_name ? String(row.area_name) : undefined,
      }));
    },
    playMedia: async (query, source, deviceId, mediaKind) => {
      if (!deviceId || deviceId === 'unknown') {
        return { ok: false, message: 'I could not identify which display requested playback.' };
      }
      if (source !== 'youtube') {
        return { ok: false, message: `Media source "${source}" is not supported on the device yet.` };
      }
      try {
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
      if (source !== 'youtube') {
        return { ok: false, message: `Media source "${source}" is not supported on the device yet.` };
      }
      try {
        const result = await controlDeviceMedia(deviceId, action, source);
        const verb = {
          pause: 'Paused YouTube playback',
          resume: 'Resumed YouTube playback',
          stop: 'Stopped YouTube playback',
          next: 'Skipped to the next YouTube result',
        }[action];
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
    broadcastIntercom: async (text, from = 'system', deviceIds) => {
      if (flowBroadcastIntercom) await flowBroadcastIntercom(text, from, deviceIds);
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
      if (updatedKeys.some(key => key.startsWith('request_routing_'))) await reloadRequestRoutingPolicy();
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
      | { messages?: unknown; providerId?: string }
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
    const toolDefinitions: import('./providers/llm.js').ToolDefinition[] = [];

    const latestUserMessage = [...messages].reverse().find(message => message.role === 'user')?.content ?? '';
    const nativeTools = selectToolsForRequest(intelligence.toolRegistry.listTools('admin'), latestUserMessage);
    for (const tool of nativeTools) {
      toolDefinitions.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.schema as Record<string, unknown>,
        },
      });
    }

    const mcpClient = intelligence.providers.mcp;

    // ── Chat loop with tool execution ─────────────────────────────────────
    // Up to 5 iterations to handle chains of tool calls.
    const MAX_ITERATIONS = 5;
    let currentMessages: import('./providers/types.js').ChatMessage[] = messages;
    let finalContent = '';

    try {
      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        const result = await llmProvider.chatWithTools(currentMessages, toolDefinitions);

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
            const params = JSON.parse(tc.function.arguments);

            // Check if this is an MCP tool (namespaced as mcp.<name> or just <name> from MCP).
            const nativeTool = intelligence.toolRegistry.getTool(tc.function.name);
            if (nativeTool) {
              if (mcpCallRequiresConfirmation(nativeTool.name, params)) {
                const token = randomUUID();
                const digest = confirmationDigest(tc.function.name, params);
                pendingAdminMcp.set(token, {
                  tool: tc.function.name,
                  params,
                  digest,
                  expiresAt: Date.now() + 60_000,
                });
                return {
                  reply: `Confirmation required before running ${tc.function.name}.`,
                  providerId,
                  model,
                  pendingConfirmation: { token, tool: tc.function.name, params, expiresAt: new Date(Date.now() + 60_000).toISOString() },
                };
              }
              // Execute via native tool registry.
              const execResult = await intelligence.toolRegistry.executeTool(
                tc.function.name,
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
              if (tc.function.name.endsWith('.ha_get_camera_image') && execResult.ok) {
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
              toolResult = JSON.stringify({ ok: false, message: `Tool '${tc.function.name}' not found` });
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
    return { reply: result.message, toolResult: result };
  });

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
