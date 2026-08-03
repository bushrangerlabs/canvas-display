import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { AuthorityMode } from './devices.js';

/**
 * Per-device desired/reported state model (Phase 2 checklist: "Add per-device
 * desired/reported state with per-domain status, provenance, local override leases,
 * and monotonic revisions"; plan doc §10.2 State tables, §12.6 desired/reported
 * messages; aligns with `docs/PHASE_0_STATE_CONVERGENCE_SPEC.md`).
 *
 * SCOPE OF THIS SCAFFOLD:
 *   - Desired state is stored per (device, domain) with a single monotonic revision
 *     per device (per the spec: "every newly published revision must be strictly
 *     greater than the current revision" within an authority epoch). The contract's
 *     `StateDesired.payload.revision` is the authoritative value; callers may omit it
 *     to let Core auto-assign the next revision (current max + 1).
 *   - Reported state is stored per (device, domain) with a per-domain status
 *     (applied/diverged/failed/pending) matching the spec's per-domain application
 *     record.
 *   - `authority_mode` and `provenance` are persisted so later phases can enforce
 *     the write-fence (legacy/shadow/core/rollback_pending) and provenance tracking.
 *
 * DEFERRED (later phases, per spec/plan):
 *   - authority_epoch fencing and cutover (the spec's single-active-epoch rule);
 *   - local override lease records and precedence resolution;
 *   - desired_digest storage and stale/digest-conflict rejection at the DB layer
 *     (the monotonic revision check here is the first half of replay-safety);
 *   - per-domain application/observed split and typed divergence reasons.
 *   The schema columns are chosen so these land without a migration.
 *
 * The repository is injected so unit tests can run against an in-memory Postgres
 * (`pg-mem`) without a network.
 */

export type Provenance = 'core' | 'shadow' | 'legacy' | 'local-override';
export type ReportedStatus = 'applied' | 'diverged' | 'failed' | 'pending';

export interface DesiredStateRecord {
  deviceId: string;
  domain: string;
  revision: number;
  state: unknown;
  authorityMode: AuthorityMode;
  provenance: Provenance;
  createdAt: string;
}

export interface ReportedStateRecord {
  deviceId: string;
  domain: string;
  revision: number;
  state: unknown;
  status: ReportedStatus;
  updatedAt: string;
}

/** Thrown when a desired-state write would violate monotonic revision ordering. */
export class MonotonicRevisionError extends Error {
  constructor(
    public readonly deviceId: string,
    public readonly attempted: number,
    public readonly current: number,
  ) {
    super(
      `desired-state revision ${attempted} for device ${deviceId} is not strictly ` +
        `greater than the current revision ${current} (replay-safety ordering rule)`,
    );
    this.name = 'MonotonicRevisionError';
  }
}

/** Storage abstraction so tests can swap in an in-memory Postgres (`pg-mem`). */
export interface StateRepositoryLike {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export class PgStateRepository implements StateRepositoryLike {
  constructor(private readonly pool: Pool) {}
  query(text: string, params?: unknown[]) {
    return this.pool.query(text, params as unknown[]) as unknown as Promise<{ rows: any[]; rowCount: number | null }>;
  }
}

// --- desired state ------------------------------------------------------------

/**
 * Returns the highest desired-state revision recorded for a device across all domains
 * (the spec's single per-device revision counter within an authority epoch). Returns
 * 0 when the device has no desired state yet.
 */
export async function getCurrentRevision(
  repo: StateRepositoryLike,
  deviceId: string,
): Promise<number> {
  const res = await repo.query(
    'SELECT COALESCE(MAX(revision), 0) AS m FROM device_desired_state WHERE device_id = $1',
    [deviceId],
  );
  const m = res.rows[0]?.m;
  return m == null ? 0 : Number(m);
}

export interface SetDesiredStateOptions {
  /** Contract `StateDesired.payload.revision`. When omitted, Core auto-assigns max+1. */
  revision?: number;
  authorityMode?: AuthorityMode;
  provenance?: Provenance;
}

/**
 * Records desired state for one domain of a device. Enforces the contract's
 * replay-safety rule: an explicit `revision` must be strictly greater than the
 * device's current revision, otherwise {@link MonotonicRevisionError} is thrown.
 * Returns the stored revision (the provided one, or the auto-assigned max+1).
 */
export async function setDesiredState(
  repo: StateRepositoryLike,
  deviceId: string,
  domain: string,
  state: unknown,
  options: SetDesiredStateOptions = {},
): Promise<number> {
  const authorityMode = options.authorityMode ?? 'legacy';
  const provenance = options.provenance ?? 'core';
  const current = await getCurrentRevision(repo, deviceId);

  let revision: number;
  if (options.revision != null) {
    if (options.revision <= current) {
      throw new MonotonicRevisionError(deviceId, options.revision, current);
    }
    revision = options.revision;
  } else {
    revision = current + 1;
  }

  await repo.query(
    `INSERT INTO device_desired_state (device_id, domain, revision, state_json, authority_mode, provenance, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (device_id, domain) DO UPDATE SET
       revision = EXCLUDED.revision,
       state_json = EXCLUDED.state_json,
       authority_mode = EXCLUDED.authority_mode,
       provenance = EXCLUDED.provenance,
       created_at = now()`,
    [deviceId, domain, revision, JSON.stringify(state), authorityMode, provenance],
  );
  return revision;
}

/** Returns all desired-state records for a device, ordered by domain. */
export async function getDesiredState(
  repo: StateRepositoryLike,
  deviceId: string,
): Promise<DesiredStateRecord[]> {
  const res = await repo.query(
    'SELECT * FROM device_desired_state WHERE device_id = $1 ORDER BY domain',
    [deviceId],
  );
  return res.rows.map(rowToDesired);
}

// --- reported state -----------------------------------------------------------

/**
 * Records reported state for one domain of a device. `revision` defaults to the
 * domain's last reported revision + 1 when omitted. `status` is the per-domain
 * application status (the spec's per-domain application record).
 */
export async function reportState(
  repo: StateRepositoryLike,
  deviceId: string,
  domain: string,
  state: unknown,
  status: ReportedStatus = 'applied',
  revision?: number,
): Promise<number> {
  let rev = revision;
  if (rev == null) {
    const res = await repo.query(
      'SELECT COALESCE(MAX(revision), 0) AS m FROM device_reported_state WHERE device_id = $1 AND domain = $2',
      [deviceId, domain],
    );
    const m = res.rows[0]?.m;
    rev = (m == null ? 0 : Number(m)) + 1;
  }

  await repo.query(
    `INSERT INTO device_reported_state (device_id, domain, revision, state_json, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (device_id, domain) DO UPDATE SET
       revision = EXCLUDED.revision,
       state_json = EXCLUDED.state_json,
       status = EXCLUDED.status,
       updated_at = now()`,
    [deviceId, domain, rev, JSON.stringify(state), status],
  );
  return rev;
}

/** Returns all reported-state records for a device, ordered by domain. */
export async function getReportedState(
  repo: StateRepositoryLike,
  deviceId: string,
): Promise<ReportedStateRecord[]> {
  const res = await repo.query(
    'SELECT * FROM device_reported_state WHERE device_id = $1 ORDER BY domain',
    [deviceId],
  );
  return res.rows.map(rowToReported);
}

// --- row mapping --------------------------------------------------------------

function parseJson(raw: unknown): unknown {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

function rowToDesired(row: any): DesiredStateRecord {
  return {
    deviceId: row.device_id,
    domain: row.domain,
    revision: Number(row.revision),
    state: parseJson(row.state_json),
    authorityMode: (row.authority_mode ?? 'legacy') as AuthorityMode,
    provenance: (row.provenance ?? 'core') as Provenance,
    createdAt: row.created_at,
  };
}

function rowToReported(row: any): ReportedStateRecord {
  return {
    deviceId: row.device_id,
    domain: row.domain,
    revision: Number(row.revision),
    state: parseJson(row.state_json),
    status: (row.status ?? 'pending') as ReportedStatus,
    updatedAt: row.updated_at,
  };
}

// --- HTTP routes --------------------------------------------------------------

export interface StatePluginOptions {
  repo: StateRepositoryLike;
  requireAdmin: (opts?: { roles?: ('admin' | 'viewer')[]; csrf?: boolean }) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

/**
 * Registers the admin desired/reported-state routes. Reads are admin/viewer (no
 * CSRF); the desired-state mutation is admin-only and CSRF-protected.
 */
export async function registerStateRoutes(
  fastify: FastifyInstance,
  options: StatePluginOptions,
): Promise<void> {
  const { repo, requireAdmin } = options;

  // GET desired state for a device (read => no CSRF).
  fastify.get(
    '/api/admin/devices/:id/desired-state',
    { preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }) },
    async (request) => {
      const id = (request.params as { id: string }).id;
      const domains = await getDesiredState(repo, id);
      return { deviceId: id, revision: await getCurrentRevision(repo, id), domains };
    },
  );

  // PUT desired state for one domain of a device (admin-only, CSRF-protected).
  fastify.put(
    '/api/admin/devices/:id/desired-state',
    { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) },
    async (request, reply) => {
      const id = (request.params as { id: string }).id;
      const body = request.body as
        | { domain?: unknown; state?: unknown; authorityMode?: AuthorityMode; provenance?: Provenance; revision?: number }
        | undefined;
      if (typeof body?.domain !== 'string' || body.domain.length === 0 || body?.state === undefined) {
        reply.code(400);
        return { error: 'domain (non-empty string) and state are required' };
      }
      try {
        const revision = await setDesiredState(repo, id, body.domain, body.state, {
          revision: typeof body.revision === 'number' ? body.revision : undefined,
          authorityMode: body.authorityMode,
          provenance: body.provenance,
        });
        return { ok: true, deviceId: id, domain: body.domain, revision };
      } catch (err) {
        if (err instanceof MonotonicRevisionError) {
          reply.code(409);
          return { error: 'monotonic_revision_conflict', message: err.message };
        }
        throw err;
      }
    },
  );

  // GET reported state for a device (read => no CSRF).
  fastify.get(
    '/api/admin/devices/:id/reported-state',
    { preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }) },
    async (request) => {
      const id = (request.params as { id: string }).id;
      const domains = await getReportedState(repo, id);
      return { deviceId: id, domains };
    },
  );
}

// Re-exported for the gateway's reported-state recording on `edge.hello`.
export { randomUUID };
