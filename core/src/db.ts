import pg from 'pg';
import type { CoreConfig } from './config.js';

/**
 * PostgreSQL connection pool — Core's authoritative datastore (P-001, plan doc §10).
 * Edge devices use SQLite only; Core uses Postgres. The pool is created lazily and
 * shared across the process.
 */
let pool: pg.Pool | null = null;

export function getPool(config: CoreConfig): pg.Pool {
  if (pool) return pool;
  pool = new pg.Pool({ connectionString: config.databaseUrl });
  pool.on('error', (err) => {
    // A client-level error that isn't caught by a query should not crash Core.
    console.error('[core][db] pool client error:', err.message);
  });
  return pool;
}

/**
 * Conditionally adds a column, tolerating both fresh installs and already-migrated
 * databases. Works against real PostgreSQL and `pg-mem` (both expose `information_schema`).
 */
async function addColumnIfNotExists(
  pool: pg.Pool,
  table: string,
  column: string,
  definition: string,
): Promise<void> {
  const result = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = $1 AND column_name = $2 LIMIT 1`,
    [table, column],
  );
  if (result.rowCount === 0) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/**
 * Runs the Core schema. This is the Phase 2 bootstrap schema: it keeps the original
 * `devices` table (created by the gateway bootstrap) and extends it with the device
 * registry fields required by the Phase 2 checklist (plan doc §25 Phase 2 checklist,
 * §26.5 authority modes, and `docs/PHASE_0_PKI_BOOTSTRAP_SPEC.md`):
 *
 *   - device registry: groups, capabilities, certificate metadata, authority_mode,
 *     clone/revocation tracking
 *   - pairing invitations (`device_invitations`): one-time token, expiry, usage
 *   - admin users (`admin_users`): id, username, password_hash, role, timestamps
 *   - per-device desired/reported state (Phase2 state-ownership core):
 *       `device_desired_state` (per-device/domain monotonic revision, authority_mode,
 *       provenance, state payload) and `device_reported_state` (per-device/domain
 *       reported revision, per-domain status, state payload)
 *   - scene revisions/manifests scaffold (Phase2): `scenes` (monotonic revision,
 *       manifest_json, status) and `scene_assignments` (scene -> device)
 *
 * Migrations are additive so an already-running Core keeps its recorded devices. The
 * full migration framework (Phase 2 checklist) replaces this later; for now we create
 * what the auth + device-registry + state + scene scaffolds need.
 */
export async function migrate(pool: pg.Pool): Promise<void> {
  // --- devices: keep existing columns, add registry fields -------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS devices (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL DEFAULT '',
      architecture    TEXT NOT NULL DEFAULT 'unknown',
      protocol_version TEXT NOT NULL DEFAULT '1',
      paired_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen       TIMESTAMPTZ NOT NULL DEFAULT now(),
      status          TEXT NOT NULL DEFAULT 'connected'
    );
  `);

  await addColumnIfNotExists(pool, 'devices', 'group_name', "TEXT NOT NULL DEFAULT ''");
  await addColumnIfNotExists(pool, 'devices', 'capabilities', 'TEXT NOT NULL DEFAULT \'\'');
  await addColumnIfNotExists(pool, 'devices', 'authority_mode', "TEXT NOT NULL DEFAULT 'legacy'");
  await addColumnIfNotExists(pool, 'devices', 'cert_fingerprint', 'TEXT');
  await addColumnIfNotExists(pool, 'devices', 'cert_issued_at', 'TIMESTAMPTZ');
  await addColumnIfNotExists(pool, 'devices', 'cert_expires_at', 'TIMESTAMPTZ');
  await addColumnIfNotExists(pool, 'devices', 'revoked_at', 'TIMESTAMPTZ');
  await addColumnIfNotExists(pool, 'devices', 'paired', "BOOLEAN NOT NULL DEFAULT false");
  await addColumnIfNotExists(pool, 'devices', 'invitation_id', 'TEXT');
  await addColumnIfNotExists(pool, 'devices', 'audio_config', 'JSONB');
  await addColumnIfNotExists(pool, 'devices', 'voice_config', 'JSONB');

  // --- device_invitations: one-time pairing tokens (P-003 bootstrap) ---------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS device_invitations (
      id           TEXT PRIMARY KEY,
      token_hash   TEXT NOT NULL UNIQUE,
      scope        TEXT NOT NULL DEFAULT '',
      created_by   TEXT NOT NULL DEFAULT '',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at   TIMESTAMPTZ NOT NULL,
      used_at      TIMESTAMPTZ,
      used_by_device_id TEXT
    );
  `);
  // P-003 enrollment gate: track challenge issuance so an invitation cannot be reserved twice
  // before proof (fail-closed), and bind the issued challenge id for re-lookup.
  await addColumnIfNotExists(pool, 'device_invitations', 'challenge_issued_at', 'TIMESTAMPTZ');
  await addColumnIfNotExists(pool, 'device_invitations', 'challenge_id', 'TEXT');

  // --- pending_enrollment_challenges: P-003 proof-of-possession gate ---------
  // One row per in-flight enrollment challenge. The challenge is removed on the first
  // completion attempt (success or failure) so it can never be replayed, and a failed proof
  // permanently burns the invitation (fail-closed).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_enrollment_challenges (
      challenge_id    TEXT PRIMARY KEY,
      invitation_id   TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      public_key_hex  TEXT NOT NULL,
      nonce_hex       TEXT NOT NULL,
      expires_at      TIMESTAMPTZ NOT NULL
    );
  `);

  // --- device_credentials: P-003 issued Phase 0 signed credentials ----------
  // Phase 0 model: a Core-signed JSON credential (NOT X.509/mTLS yet — that is P-013). The
  // public_key_fingerprint is recomputed server-side from public_key_hex and is the authoritative
  // device identity Core enforces at the gateway.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS device_credentials (
      id                     TEXT PRIMARY KEY,
      device_id             TEXT NOT NULL,
      installation_id       TEXT NOT NULL,
      public_key_fingerprint TEXT NOT NULL,
      public_key_hex        TEXT NOT NULL,
      credential_json       JSONB NOT NULL,
      signature_hex         TEXT NOT NULL,
      signer_public_key_hex TEXT NOT NULL,
      issued_at             TIMESTAMPTZ NOT NULL,
      expires_at            TIMESTAMPTZ NOT NULL,
      revoked_at            TIMESTAMPTZ
    );
  `);
  await addColumnIfNotExists(pool, 'device_credentials', 'revoked_at', 'TIMESTAMPTZ');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id            TEXT PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'viewer',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // --- device_desired_state: per-device/domain desired state (Phase2) ------
  // One row per (device, domain). `revision` is a single monotonic counter per device
  // (MAX across domains); the contract's `StateDesired.payload.revision` is the value.
  // `authority_mode` + `provenance` support the spec's write-fence and provenance.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS device_desired_state (
      device_id     TEXT NOT NULL,
      domain        TEXT NOT NULL,
      revision      BIGINT NOT NULL,
      state_json    JSONB NOT NULL,
      authority_mode TEXT NOT NULL DEFAULT 'legacy',
      provenance    TEXT NOT NULL DEFAULT 'core',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (device_id, domain)
    );
  `);

  // --- device_reported_state: per-device/domain reported state (Phase2) ----
  // One row per (device, domain). `status` is the per-domain application status
  // (applied/diverged/failed/pending) from the state-convergence spec.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS device_reported_state (
      device_id   TEXT NOT NULL,
      domain      TEXT NOT NULL,
      revision    BIGINT NOT NULL,
      state_json  JSONB NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (device_id, domain)
    );
  `);

  // --- scenes: scene revisions/manifests scaffold (Phase2) ----------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scenes (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      revision      BIGINT NOT NULL DEFAULT 1,
      manifest_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      status        TEXT NOT NULL DEFAULT 'staged',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      published_at  TIMESTAMPTZ
    );
  `);

  // --- scene_revisions: immutable revision log (Phase4 staged publication) --
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scene_revisions (
      id            TEXT PRIMARY KEY,
      scene_id      TEXT NOT NULL,
      revision      BIGINT NOT NULL,
      manifest_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      status        TEXT NOT NULL DEFAULT 'staged',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_scene_revisions_scene_id ON scene_revisions (scene_id);
  `);

  // --- scene_assignments: scene -> device (Phase2 scaffold) ---------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scene_assignments (
      scene_id    TEXT NOT NULL,
      device_id   TEXT NOT NULL,
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (scene_id, device_id)
    );
  `);

  // --- scene_entity_subscriptions: per-scene HA entity declarations (Phase 4 facade) ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scene_entity_subscriptions (
      scene_id  TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      required  BOOLEAN NOT NULL DEFAULT true,
      filters   JSONB,
      PRIMARY KEY (scene_id, entity_id)
    );
  `);

  // --- MCP servers: D-011 multi-MCP manager (Phase 6) ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mcp_servers (
      name TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Phase 6+: stdio transport support — url is empty string for stdio servers
  await addColumnIfNotExists(pool, 'mcp_servers', 'type', "TEXT NOT NULL DEFAULT 'http'");
  await addColumnIfNotExists(pool, 'mcp_servers', 'command', 'TEXT');
  await addColumnIfNotExists(pool, 'mcp_servers', 'args', 'TEXT');
  await addColumnIfNotExists(pool, 'mcp_servers', 'server_env', 'TEXT');

  console.log('[core][db] migrations applied');
  // --- assets: content-addressed asset metadata (Phase4 staged publication) --
  await pool.query(
    `
    CREATE TABLE IF NOT EXISTS assets (
      id         TEXT PRIMARY KEY,
      size       BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // --- schedules: Phase4 offline boot + durable schedules (plan doc §18.3) ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schedules (
      id            TEXT PRIMARY KEY,
      scene_id      TEXT NOT NULL,
      domain        TEXT NOT NULL DEFAULT 'display',
      schedule_type TEXT NOT NULL CHECK (schedule_type IN ('cron','once','daily','interval')),
      config_json   TEXT NOT NULL DEFAULT '{}',
      timezone      TEXT NOT NULL DEFAULT 'UTC',
      active        BOOLEAN NOT NULL DEFAULT true,
      max_lateness_ms BIGINT NOT NULL DEFAULT 300000,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schedule_occurrences (
      id            TEXT PRIMARY KEY,
      schedule_id   TEXT NOT NULL,
      scheduled_for TIMESTAMPTZ NOT NULL,
      executed_at   TIMESTAMPTZ,
      status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','dispatched','failed','missed')),
      durable_id    UUID NOT NULL
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_schedule_occurrences_schedule_id
    ON schedule_occurrences (schedule_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_schedule_occurrences_status_scheduled_for
    ON schedule_occurrences (status, scheduled_for)
    WHERE status = 'pending';
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_occurrences_durable_id
    ON schedule_occurrences (durable_id);
  `);

  // --- Legacy sidecar compatibility tables --------------------------------
  // These back the legacy REST API routes (pages/panels/settings) the web UI still
  // calls. They live in Core's Postgres so the web UI works against Core directly
  // instead of each Pi's local SQLite. See `legacy-routes.ts`.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pages (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL DEFAULT '',
      floating_config JSONB,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS page_panels (
      id            TEXT PRIMARY KEY,
      page_id       TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      name          TEXT NOT NULL DEFAULT '',
      x             DOUBLE PRECISION NOT NULL DEFAULT 0,
      y             DOUBLE PRECISION NOT NULL DEFAULT 0,
      w             DOUBLE PRECISION NOT NULL DEFAULT 100,
      h             DOUBLE PRECISION NOT NULL DEFAULT 100,
      view_id       TEXT,
      url           TEXT,
      position      INTEGER NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_page_panels_page_id ON page_panels (page_id);
  `);
  await pool.query(`
    ALTER TABLE page_panels
      ADD COLUMN IF NOT EXISTS content_type TEXT NOT NULL DEFAULT 'url',
      ADD COLUMN IF NOT EXISTS scene_id TEXT,
      ADD COLUMN IF NOT EXISTS z_index INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS visible BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS opacity DOUBLE PRECISION NOT NULL DEFAULT 1;
  `);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE page_panels ADD CONSTRAINT page_panels_content_type_check
        CHECK (content_type IN ('url', 'scene'));
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE page_panels ADD CONSTRAINT page_panels_opacity_check
        CHECK (opacity >= 0 AND opacity <= 1);
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS device_page_assignments (
      device_id     TEXT PRIMARY KEY,
      page_id       TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      assigned_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_device_page_assignments_page_id
    ON device_page_assignments (page_id);
  `);

  // A device owns a library of any number of cached pages. The older
  // device_page_assignments table remains as the compatibility default-page pointer.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS device_page_library (
      device_id       TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      page_id         TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      sync_status     TEXT NOT NULL DEFAULT 'pending',
      cached_revision BIGINT NOT NULL DEFAULT 0,
      bytes           BIGINT NOT NULL DEFAULT 0,
      last_error      TEXT,
      assigned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      synced_at       TIMESTAMPTZ,
      PRIMARY KEY (device_id, page_id)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS device_page_state (
      device_id       TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
      active_page_id  TEXT REFERENCES pages(id) ON DELETE SET NULL,
      default_page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
      fallback_page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
      history         JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS device_panel_state (
      device_id   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      panel_id    TEXT NOT NULL REFERENCES page_panels(id) ON DELETE CASCADE,
      content     JSONB,
      visible     BOOLEAN NOT NULL DEFAULT true,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (device_id, panel_id)
    );
  `);
  await pool.query(`
    INSERT INTO device_page_library (device_id, page_id, sync_status, assigned_at)
    SELECT device_id, page_id, 'pending', assigned_at
    FROM device_page_assignments
    ON CONFLICT (device_id, page_id) DO NOTHING;
  `);
  await pool.query(`
    INSERT INTO device_page_state (device_id, default_page_id, updated_at)
    SELECT device_id, page_id, now()
    FROM device_page_assignments
    ON CONFLICT (device_id) DO NOTHING;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key           TEXT PRIMARY KEY,
      value         TEXT NOT NULL DEFAULT '',
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS voice_turn_metrics (
      turn_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      intent TEXT,
      capture_ms INTEGER,
      asr_ms INTEGER,
      routing_ms INTEGER,
      planning_ms INTEGER,
      tts_ms INTEGER,
      core_round_trip_ms INTEGER,
      first_playback_ms INTEGER,
      playback_ms INTEGER,
      total_ms INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_voice_turn_metrics_device_time
      ON voice_turn_metrics (device_id, created_at DESC);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS voice_turns (
      turn_id     TEXT PRIMARY KEY,
      device_id   TEXT NOT NULL,
      transcript  TEXT,
      reply       TEXT,
      intent      TEXT,
      tool_calls  JSONB,
      knowledge_card JSONB,
      feedback    SMALLINT CHECK (feedback IN (-1, 1)),
      feedback_at TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_voice_turns_device_time
      ON voice_turns (device_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_voice_turns_created
      ON voice_turns (created_at DESC);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS skills (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','enabled','disabled','archived')),
      active_revision_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS skill_revisions (
      id UUID PRIMARY KEY,
      skill_id UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      definition JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      creation_source TEXT NOT NULL DEFAULT 'user',
      validation_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      enabled_at TIMESTAMPTZ,
      UNIQUE(skill_id, revision)
    );
    ALTER TABLE skills DROP CONSTRAINT IF EXISTS skills_active_revision_id_fkey;
    ALTER TABLE skills ADD CONSTRAINT skills_active_revision_id_fkey
      FOREIGN KEY (active_revision_id) REFERENCES skill_revisions(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_skills_status ON skills(status);
  `);

  // Durable Home Assistant entity catalogue. Live state remains in the HA
  // client's memory cache; this table lets editor pickers start instantly and
  // continue operating while HA is temporarily unavailable.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ha_entities (
      entity_id     TEXT PRIMARY KEY,
      domain        TEXT NOT NULL,
      friendly_name TEXT,
      state         TEXT NOT NULL DEFAULT 'unknown',
      attributes    JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_changed  TIMESTAMPTZ,
      last_updated  TIMESTAMPTZ,
      cached_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ha_entities_domain
    ON ha_entities (domain, friendly_name, entity_id);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ha_areas (
      area_id TEXT PRIMARY KEY, name TEXT NOT NULL, floor_id TEXT,
      aliases JSONB NOT NULL DEFAULT '[]'::jsonb, cached_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS ha_devices (
      device_id TEXT PRIMARY KEY, name TEXT, name_by_user TEXT, area_id TEXT,
      manufacturer TEXT, model TEXT, cached_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS ha_entity_registry (
      entity_id TEXT PRIMARY KEY, device_id TEXT, area_id TEXT, name TEXT,
      original_name TEXT, platform TEXT, disabled_by TEXT,
      cached_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_ha_devices_area ON ha_devices (area_id);
    CREATE INDEX IF NOT EXISTS idx_ha_entity_registry_device ON ha_entity_registry (device_id, area_id);
  `);

  // --- AI providers: multi-provider model registry (D-010 extension) ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_providers (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      kind TEXT NOT NULL,
      config JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_task_assignments (
      task TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL
    );
  `);

  // Canvas Routines: definitions are immutable revisions. Phase 1 deliberately
  // stores lifecycle data only; execution is added after policy/audit plumbing.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS routines (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      owner TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      active_revision_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS routine_revisions (
      id TEXT PRIMARY KEY,
      routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      definition JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      creation_source TEXT NOT NULL DEFAULT 'user',
      provider_provenance JSONB,
      validation_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      enabled_at TIMESTAMPTZ,
      UNIQUE (routine_id, revision)
    );
    CREATE INDEX IF NOT EXISTS idx_routine_revisions_routine ON routine_revisions (routine_id, revision DESC);
    CREATE TABLE IF NOT EXISTS routine_executions (
      id TEXT PRIMARY KEY,
      routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
      revision_id TEXT NOT NULL REFERENCES routine_revisions(id),
      correlation_id TEXT NOT NULL,
      idempotency_key TEXT UNIQUE,
      origin TEXT NOT NULL DEFAULT 'admin',
      origin_device_id TEXT,
      principal TEXT NOT NULL,
      status TEXT NOT NULL,
      dry_run BOOLEAN NOT NULL DEFAULT false,
      inputs JSONB NOT NULL DEFAULT '{}'::jsonb,
      result JSONB,
      error TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ,
      cancel_requested_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS routine_step_results (
      id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL REFERENCES routine_executions(id) ON DELETE CASCADE,
      step_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      kind TEXT NOT NULL,
      tool_name TEXT,
      status TEXT NOT NULL,
      input JSONB,
      output JSONB,
      error TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ,
      duration_ms INTEGER,
      UNIQUE (execution_id, step_index)
    );
    CREATE INDEX IF NOT EXISTS idx_routine_executions_routine ON routine_executions (routine_id, started_at DESC);
    CREATE TABLE IF NOT EXISTS routine_plan_learning (
      signature TEXT PRIMARY KEY,
      normalized_phrase TEXT NOT NULL,
      plan JSONB NOT NULL,
      success_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'observed',
      routine_id TEXT,
      fast_path_hits INTEGER NOT NULL DEFAULT 0,
      last_fast_path_ms INTEGER,
      origin_devices JSONB NOT NULL DEFAULT '[]'::jsonb,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE routine_plan_learning ADD COLUMN IF NOT EXISTS routine_id TEXT;
    ALTER TABLE routine_plan_learning ADD COLUMN IF NOT EXISTS fast_path_hits INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE routine_plan_learning ADD COLUMN IF NOT EXISTS last_fast_path_ms INTEGER;
  `);
  console.log('[core][db] migrations applied');
}
