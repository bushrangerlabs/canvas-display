import { newDb, type Db } from 'pg-mem';
import { Pool } from 'pg';

/**
 * Spins up an in-memory PostgreSQL (`pg-mem`) with the full Core Phase 2 schema so the
 * auth + device-registry unit tests run without a network or Docker. We use pg-mem's
 * `pg` adapter so the returned `Pool` matches the real `pg.Pool` API exactly — including
 * `$1` parameter binding, which `db.public.query` does not emulate the same way.
 */
export function createTestDb(): { db: Db; pool: Pool } {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  db.public.none(`
    CREATE TABLE IF NOT EXISTS devices (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL DEFAULT '',
      architecture    TEXT NOT NULL DEFAULT 'unknown',
      protocol_version TEXT NOT NULL DEFAULT '1',
      paired_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen       TIMESTAMPTZ NOT NULL DEFAULT now(),
      status          TEXT NOT NULL DEFAULT 'connected',
      group_name      TEXT NOT NULL DEFAULT '',
      capabilities    TEXT NOT NULL DEFAULT '',
      authority_mode  TEXT NOT NULL DEFAULT 'legacy',
      authority_epoch  TEXT NOT NULL DEFAULT 'epoch-0',
      cert_fingerprint TEXT,
      cert_issued_at  TIMESTAMPTZ,
      cert_expires_at TIMESTAMPTZ,
      revoked_at      TIMESTAMPTZ,
      paired          BOOLEAN NOT NULL DEFAULT false,
      invitation_id   TEXT,
      audio_config    JSONB,
      voice_config    JSONB,
      challenge_issued_at TIMESTAMPTZ,
      challenge_id    TEXT
    );
    CREATE TABLE IF NOT EXISTS pending_enrollment_challenges (
      challenge_id    TEXT PRIMARY KEY,
      invitation_id   TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      public_key_hex  TEXT NOT NULL,
      nonce_hex       TEXT NOT NULL,
      expires_at      TIMESTAMPTZ NOT NULL
    );
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
    CREATE TABLE IF NOT EXISTS device_invitations (
      id           TEXT PRIMARY KEY,
      token_hash   TEXT NOT NULL UNIQUE,
      scope        TEXT NOT NULL DEFAULT '',
      created_by   TEXT NOT NULL DEFAULT '',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at   TIMESTAMPTZ NOT NULL,
      used_at      TIMESTAMPTZ,
      used_by_device_id TEXT,
      challenge_issued_at TIMESTAMPTZ,
      challenge_id TEXT
    );
    CREATE TABLE IF NOT EXISTS admin_users (
      id            TEXT PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'viewer',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
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
    CREATE TABLE IF NOT EXISTS device_reported_state (
      device_id   TEXT NOT NULL,
      domain      TEXT NOT NULL,
      revision    BIGINT NOT NULL,
      state_json  JSONB NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (device_id, domain)
    );
    CREATE TABLE IF NOT EXISTS scenes (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      revision      BIGINT NOT NULL DEFAULT 1,
      manifest_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      status        TEXT NOT NULL DEFAULT 'staged',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      published_at  TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS scene_revisions (
      id            TEXT PRIMARY KEY,
      scene_id      TEXT NOT NULL,
      revision      BIGINT NOT NULL,
      manifest_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      status        TEXT NOT NULL DEFAULT 'staged',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS scene_assignments (
      scene_id    TEXT NOT NULL,
      device_id   TEXT NOT NULL,
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (scene_id, device_id)
    );
    CREATE TABLE IF NOT EXISTS assets (
      id         TEXT PRIMARY KEY,
      size       BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS scene_entity_subscriptions (
      scene_id  TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      required  BOOLEAN NOT NULL DEFAULT true,
      filters   JSONB,
      PRIMARY KEY (scene_id, entity_id)
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id            TEXT PRIMARY KEY,
      scene_id      TEXT NOT NULL,
      domain        TEXT NOT NULL DEFAULT 'display',
      schedule_type TEXT NOT NULL,
      config_json   TEXT NOT NULL DEFAULT '{}',
      timezone      TEXT NOT NULL DEFAULT 'UTC',
      active        BOOLEAN NOT NULL DEFAULT true,
      max_lateness_ms BIGINT NOT NULL DEFAULT 300000,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS schedule_occurrences (
      id            TEXT PRIMARY KEY,
      schedule_id   TEXT NOT NULL,
      scheduled_for TIMESTAMPTZ NOT NULL,
      executed_at   TIMESTAMPTZ,
      status        TEXT NOT NULL DEFAULT 'pending',
      durable_id    UUID NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_so_schedule_id ON schedule_occurrences (schedule_id);
    CREATE INDEX IF NOT EXISTS idx_so_status_scheduled_for ON schedule_occurrences (status, scheduled_for) WHERE status = 'pending';

    -- Legacy sidecar compatibility tables (pages/panels/settings)
    CREATE TABLE IF NOT EXISTS pages (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL DEFAULT '',
      floating_config JSONB,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS page_panels (
      id            TEXT PRIMARY KEY,
      page_id       TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      name          TEXT NOT NULL DEFAULT '',
      x             DOUBLE PRECISION NOT NULL DEFAULT 0,
      y             DOUBLE PRECISION NOT NULL DEFAULT 0,
      w             DOUBLE PRECISION NOT NULL DEFAULT 100,
      h             DOUBLE PRECISION NOT NULL DEFAULT 100,
      view_id       TEXT,
      content_type  TEXT NOT NULL DEFAULT 'url',
      url           TEXT,
      scene_id      TEXT,
      position      INTEGER NOT NULL DEFAULT 0,
      z_index       INTEGER NOT NULL DEFAULT 0,
      visible       BOOLEAN NOT NULL DEFAULT true,
      opacity       DOUBLE PRECISION NOT NULL DEFAULT 1,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_page_panels_page_id ON page_panels (page_id);
    CREATE TABLE IF NOT EXISTS device_page_assignments (
      device_id     TEXT PRIMARY KEY,
      page_id       TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      assigned_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_device_page_assignments_page_id ON device_page_assignments (page_id);
    CREATE TABLE IF NOT EXISTS device_page_library (
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      sync_status TEXT NOT NULL DEFAULT 'pending',
      cached_revision BIGINT NOT NULL DEFAULT 0,
      bytes BIGINT NOT NULL DEFAULT 0,
      last_error TEXT,
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      synced_at TIMESTAMPTZ,
      PRIMARY KEY (device_id, page_id)
    );
    CREATE TABLE IF NOT EXISTS device_page_state (
      device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
      active_page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
      default_page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
      fallback_page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
      history JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS device_panel_state (
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      panel_id TEXT NOT NULL REFERENCES page_panels(id) ON DELETE CASCADE,
      content JSONB,
      visible BOOLEAN NOT NULL DEFAULT true,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (device_id, panel_id)
    );
    CREATE TABLE IF NOT EXISTS settings (
      key           TEXT PRIMARY KEY,
      value         TEXT NOT NULL DEFAULT '',
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Phase 8: authority migration tables
    CREATE TABLE IF NOT EXISTS authority_watermark (
      id          TEXT PRIMARY KEY,
      watermark   TIMESTAMPTZ NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by  TEXT NOT NULL DEFAULT 'system'
    );
    CREATE TABLE IF NOT EXISTS authority_epoch_log (
      id              TEXT PRIMARY KEY,
      device_id       TEXT NOT NULL,
      from_mode       TEXT NOT NULL,
      to_mode         TEXT NOT NULL,
      epoch           TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by      TEXT NOT NULL DEFAULT 'system'
    );
  `);

  const pg = db.adapters.createPg();
  const pool = new pg.Pool() as unknown as Pool;
  return { db, pool };
}
