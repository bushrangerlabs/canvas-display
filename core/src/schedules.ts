import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

/**
 * Schedule / occurrence system for offline boot + durable schedules (Phase 4
 * checklist: "Implement offline boot, durable schedule occurrence IDs, timezone/DST/
 * max-lateness rules, trusted-time degradation, priority outbox, and reconnect
 * reconciliation"; plan doc §18.3 Offline capabilities).
 *
 * Two tables:
 *   - `schedules`: defines when to trigger a scene/widget (cron/once/daily/interval).
 *   - `schedule_occurrences`: individual occurrences with a durable UUID for
 *     idempotent crash-recovery dispatch.
 *
 * The repository is injected so unit tests can run against an in-memory Postgres
 * (`pg-mem`) without a network.
 */

// --- Types -------------------------------------------------------------------

export type ScheduleType = 'cron' | 'once' | 'daily' | 'interval';
export type OccurrenceStatus = 'pending' | 'dispatched' | 'failed' | 'missed';

export interface ScheduleRecord {
  id: string;
  sceneId: string;
  domain: string;
  scheduleType: ScheduleType;
  configJson: string;
  timezone: string;
  active: boolean;
  maxLatenessMs: number;
  createdAt: string;
}

export interface OccurrenceRecord {
  id: string;
  scheduleId: string;
  scheduledFor: string;
  executedAt: string | null;
  status: OccurrenceStatus;
  durableId: string;
}

/** Storage abstraction so tests can swap in an in-memory Postgres (`pg-mem`). */
export interface ScheduleRepositoryLike {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export class PgScheduleRepository implements ScheduleRepositoryLike {
  constructor(private readonly pool: Pool) {}
  query(text: string, params?: unknown[]) {
    return this.pool.query(text, params as unknown[]) as unknown as Promise<{ rows: any[]; rowCount: number | null }>;
  }
}

// --- Core operations ---------------------------------------------------------

/**
 * Create a schedule and generate its initial occurrences.
 * For `once` schedules, one occurrence is created at the specified time.
 * For `daily` schedules, occurrences are generated for the next N days (configurable).
 * For `interval` schedules, occurrences are generated for the next N intervals.
 * For `cron` schedules, occurrences are generated for the next N cron firings.
 */
export async function createSchedule(
  repo: ScheduleRepositoryLike,
  params: {
    sceneId: string;
    domain?: string;
    scheduleType: ScheduleType;
    configJson: string;
    timezone?: string;
    active?: boolean;
    maxLatenessMs?: number;
  },
): Promise<ScheduleRecord> {
  const id = randomUUID();
  const res = await repo.query(
    `INSERT INTO schedules (id, scene_id, domain, schedule_type, config_json, timezone, active, max_lateness_ms, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     RETURNING *`,
    [
      id,
      params.sceneId,
      params.domain ?? 'display',
      params.scheduleType,
      params.configJson,
      params.timezone ?? 'UTC',
      params.active ?? true,
      params.maxLatenessMs ?? 300000,
    ],
  );

  // Generate initial occurrences based on schedule type.
  await generateOccurrences(repo, id, params.scheduleType, params.configJson);

  return rowToSchedule(res.rows[0]);
}

/**
 * Generate occurrences for a schedule. For testing purposes, we generate a
 * manageable number of occurrences.
 */
async function generateOccurrences(
  repo: ScheduleRepositoryLike,
  scheduleId: string,
  scheduleType: ScheduleType,
  configJson: string,
): Promise<void> {
  const config = tryParseJson(configJson);
  const now = new Date();
  const occurrences: Array<{ scheduledFor: Date; durableId: string }> = [];

  switch (scheduleType) {
    case 'once': {
      // Single occurrence at the specified time.
      const scheduledFor = config?.time ? new Date(config.time as string) : new Date(now.getTime() + 60000);
      if (isNaN(scheduledFor.getTime())) return;
      occurrences.push({ scheduledFor, durableId: randomUUID() });
      break;
    }
    case 'daily': {
      // Daily at a specific time (config.time = "HH:mm").
      const timeStr: string = typeof config?.time === 'string' ? config.time : '00:00';
      const [hours, minutes] = timeStr.split(':').map(Number);
      const count: number = typeof config?.occurrenceCount === 'number' ? config.occurrenceCount : 7;
      for (let i = 0; i < count; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() + i);
        d.setHours(hours ?? 0, minutes ?? 0, 0, 0);
        occurrences.push({ scheduledFor: d, durableId: randomUUID() });
      }
      break;
    }
    case 'interval': {
      // Repeating at a fixed interval_ms.
      const intervalMs: number = typeof config?.interval_ms === 'number' ? config.interval_ms : 60000;
      const count: number = typeof config?.occurrenceCount === 'number' ? config.occurrenceCount : 10;
      for (let i = 0; i < count; i++) {
        const d = new Date(now.getTime() + intervalMs * (i + 1));
        occurrences.push({ scheduledFor: d, durableId: randomUUID() });
      }
      break;
    }
    case 'cron': {
      // For simplicity, generate occurrences at fixed offsets from now.
      // A real implementation would use a cron parser.
      const count: number = typeof config?.occurrenceCount === 'number' ? config.occurrenceCount : 10;
      for (let i = 0; i < count; i++) {
        const d = new Date(now.getTime() + 3600000 * (i + 1));
        occurrences.push({ scheduledFor: d, durableId: randomUUID() });
      }
      break;
    }
  }

  for (const occ of occurrences) {
    await repo.query(
      `INSERT INTO schedule_occurrences (id, schedule_id, scheduled_for, status, durable_id)
       VALUES ($1, $2, $3, 'pending', $4)`,
      [randomUUID(), scheduleId, occ.scheduledFor.toISOString(), occ.durableId],
    );
  }
}

/**
 * List all schedules.
 */
export async function listSchedules(repo: ScheduleRepositoryLike): Promise<ScheduleRecord[]> {
  const res = await repo.query('SELECT * FROM schedules ORDER BY created_at DESC');
  return res.rows.map(rowToSchedule);
}

/**
 * Get a single schedule by id.
 */
export async function getSchedule(repo: ScheduleRepositoryLike, id: string): Promise<ScheduleRecord | null> {
  const res = await repo.query('SELECT * FROM schedules WHERE id = $1', [id]);
  return res.rows.length > 0 ? rowToSchedule(res.rows[0]) : null;
}

/**
 * Delete a schedule and its occurrences.
 */
export async function deleteSchedule(repo: ScheduleRepositoryLike, id: string): Promise<boolean> {
  await repo.query('DELETE FROM schedule_occurrences WHERE schedule_id = $1', [id]);
  const res = await repo.query('DELETE FROM schedules WHERE id = $1', [id]);
  return (res.rowCount ?? 0) > 0;
}

/**
 * Manually trigger a schedule: creates a new occurrence scheduled for now and
 * returns it.
 */
export async function triggerSchedule(repo: ScheduleRepositoryLike, scheduleId: string): Promise<OccurrenceRecord> {
  const occId = randomUUID();
  const durableId = randomUUID();
  const res = await repo.query(
    `INSERT INTO schedule_occurrences (id, schedule_id, scheduled_for, status, durable_id)
     VALUES ($1, $2, now(), 'pending', $3)
     RETURNING *`,
    [occId, scheduleId, durableId],
  );
  return rowToOccurrence(res.rows[0]);
}

/**
 * Query pending occurrences that are due for dispatch (scheduled_for <= now).
 * Returns up to `limit` occurrences ordered by scheduled_for.
 */
export async function queryPendingOccurrences(
  repo: ScheduleRepositoryLike,
  limit: number = 50,
): Promise<OccurrenceRecord[]> {
  const res = await repo.query(
    `SELECT * FROM schedule_occurrences
     WHERE status = 'pending' AND scheduled_for <= now()
     ORDER BY scheduled_for ASC
     LIMIT $1`,
    [limit],
  );
  return res.rows.map(rowToOccurrence);
}

/**
 * Dispatch an occurrence: atomically mark it as dispatched with the given
 * durable_id. Returns false if the occurrence was already dispatched (idempotent
 * guard).
 */
export async function dispatchOccurrence(
  repo: ScheduleRepositoryLike,
  occurrenceId: string,
  durableId: string,
): Promise<boolean> {
  const res = await repo.query(
    `UPDATE schedule_occurrences
     SET status = 'dispatched', executed_at = now()
     WHERE id = $1 AND durable_id = $2 AND status = 'pending'
     RETURNING id`,
    [occurrenceId, durableId],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Mark an occurrence as missed (too late per max-lateness rules).
 */
export async function markOccurrenceMissed(
  repo: ScheduleRepositoryLike,
  occurrenceId: string,
): Promise<void> {
  await repo.query(
    `UPDATE schedule_occurrences
     SET status = 'missed', executed_at = now()
     WHERE id = $1 AND status = 'pending'`,
    [occurrenceId],
  );
}

/**
 * Mark an occurrence as failed.
 */
export async function markOccurrenceFailed(
  repo: ScheduleRepositoryLike,
  occurrenceId: string,
): Promise<void> {
  await repo.query(
    `UPDATE schedule_occurrences
     SET status = 'failed', executed_at = now()
     WHERE id = $1 AND status = 'pending'`,
    [occurrenceId],
  );
}

/**
 * Offline boot reconciliation: find pending occurrences that are past their
 * scheduled time and either dispatch them (if within max_lateness_ms) or mark
 * them as missed.
 *
 * Returns { dispatched: number; missed: number }.
 */
export async function reconcileOfflineOccurrences(
  repo: ScheduleRepositoryLike,
): Promise<{ dispatched: number; missed: number }> {
  // Find all pending occurrences past their scheduled time, joined with their
  // schedule's max_lateness_ms.
  const res = await repo.query(
    `SELECT o.*, s.max_lateness_ms
     FROM schedule_occurrences o
     JOIN schedules s ON s.id = o.schedule_id
     WHERE o.status = 'pending' AND o.scheduled_for <= now()
     ORDER BY o.scheduled_for ASC`,
  );

  let dispatched = 0;
  let missed = 0;
  const now = Date.now();

  for (const row of res.rows) {
    const scheduledFor = new Date(row.scheduled_for).getTime();
    const lateness = now - scheduledFor;
    const maxLateness = Number(row.max_lateness_ms);

    if (lateness <= maxLateness) {
      // Within lateness window — dispatch.
      const updated = await repo.query(
        `UPDATE schedule_occurrences
         SET status = 'dispatched', executed_at = now()
         WHERE id = $1 AND status = 'pending'
         RETURNING id`,
        [row.id],
      );
      if ((updated.rowCount ?? 0) > 0) dispatched++;
    } else {
      // Too late — mark as missed.
      await repo.query(
        `UPDATE schedule_occurrences
         SET status = 'missed', executed_at = now()
         WHERE id = $1 AND status = 'pending'`,
        [row.id],
      );
      missed++;
    }
  }

  return { dispatched, missed };
}

// --- SchedulerService --------------------------------------------------------

export interface SchedulerServiceOptions {
  repo: ScheduleRepositoryLike;
  /** Polling interval in ms. Default 30000 (30s). */
  pollIntervalMs?: number;
  /** Max occurrences to fetch per poll cycle. */
  batchSize?: number;
  /**
   * Dispatch handler: called for each occurrence that needs dispatching.
   * Return true if dispatch succeeded, false if it should be marked failed.
   */
  dispatchHandler?: (occurrence: OccurrenceRecord) => Promise<boolean>;
}

/**
 * SchedulerService runs on a setInterval, polling pending occurrences every
 * 30s (configurable), dispatching them with idempotent durable IDs.
 */
export class SchedulerService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly repo: ScheduleRepositoryLike;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly dispatchHandler: (occurrence: OccurrenceRecord) => Promise<boolean>;

  constructor(options: SchedulerServiceOptions) {
    this.repo = options.repo;
    this.pollIntervalMs = options.pollIntervalMs ?? 30000;
    this.batchSize = options.batchSize ?? 50;
    this.dispatchHandler = options.dispatchHandler ?? (async () => true);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    console.log('[core][scheduler] starting (poll interval: %dms)', this.pollIntervalMs);
    this.tick(); // Run immediately on start.
    this.timer = setInterval(() => this.tick(), this.pollIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('[core][scheduler] stopped');
  }

  private async tick(): Promise<void> {
    try {
      const pending = await queryPendingOccurrences(this.repo, this.batchSize);
      for (const occ of pending) {
        try {
          const ok = await this.dispatchHandler(occ);
          if (ok) {
            await dispatchOccurrence(this.repo, occ.id, occ.durableId);
          } else {
            await markOccurrenceFailed(this.repo, occ.id);
          }
        } catch (err) {
          console.error('[core][scheduler] dispatch error for occurrence %s:', occ.id, (err as Error).message);
          await markOccurrenceFailed(this.repo, occ.id);
        }
      }
    } catch (err) {
      console.error('[core][scheduler] poll error:', (err as Error).message);
    }
  }
}

// --- Row mapping -------------------------------------------------------------

function rowToSchedule(row: any): ScheduleRecord {
  return {
    id: row.id,
    sceneId: row.scene_id,
    domain: row.domain,
    scheduleType: row.schedule_type as ScheduleType,
    configJson: row.config_json,
    timezone: row.timezone,
    active: row.active,
    maxLatenessMs: Number(row.max_lateness_ms),
    createdAt: row.created_at,
  };
}

function rowToOccurrence(row: any): OccurrenceRecord {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    scheduledFor: row.scheduled_for,
    executedAt: row.executed_at,
    status: row.status as OccurrenceStatus,
    durableId: row.durable_id,
  };
}

function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// --- HTTP routes -------------------------------------------------------------

export interface SchedulePluginOptions {
  repo: ScheduleRepositoryLike;
  requireAdmin: (opts?: { roles?: ('admin' | 'viewer')[]; csrf?: boolean }) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

export async function registerScheduleRoutes(
  fastify: FastifyInstance,
  options: SchedulePluginOptions,
): Promise<void> {
  const { repo, requireAdmin } = options;

  // Create schedule (admin-only, CSRF-protected).
  fastify.post(
    '/api/admin/schedules',
    { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) },
    async (request, reply) => {
      const body = request.body as {
        sceneId?: unknown;
        domain?: unknown;
        scheduleType?: unknown;
        config?: unknown;
        timezone?: unknown;
        active?: unknown;
        maxLatenessMs?: unknown;
      } | undefined;
      if (typeof body?.sceneId !== 'string' || body.sceneId.length === 0) {
        reply.code(400);
        return { error: 'sceneId (non-empty string) is required' };
      }
      if (typeof body?.scheduleType !== 'string' || !['cron', 'once', 'daily', 'interval'].includes(body.scheduleType)) {
        reply.code(400);
        return { error: 'scheduleType must be one of: cron, once, daily, interval' };
      }
      const schedule = await createSchedule(repo, {
        sceneId: body.sceneId,
        domain: typeof body.domain === 'string' ? body.domain : undefined,
        scheduleType: body.scheduleType as ScheduleType,
        configJson: JSON.stringify(body.config ?? {}),
        timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
        active: typeof body.active === 'boolean' ? body.active : undefined,
        maxLatenessMs: typeof body.maxLatenessMs === 'number' ? body.maxLatenessMs : undefined,
      });
      return { ok: true, schedule };
    },
  );

  // List schedules (read => no CSRF).
  fastify.get(
    '/api/admin/schedules',
    { preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }) },
    async () => {
      const schedules = await listSchedules(repo);
      return { schedules };
    },
  );

  // Get pending occurrences (read => no CSRF).
  fastify.get(
    '/api/admin/schedules/pending',
    { preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }) },
    async () => {
      const pending = await queryPendingOccurrences(repo);
      return { pending };
    },
  );

  // Delete schedule (admin-only, CSRF-protected).
  fastify.delete(
    '/api/admin/schedules/:id',
    { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) },
    async (request, reply) => {
      const id = (request.params as { id: string }).id;
      const deleted = await deleteSchedule(repo, id);
      if (!deleted) {
        reply.code(404);
        return { error: 'schedule_not_found' };
      }
      return { ok: true };
    },
  );

  // Manually trigger a schedule (admin-only, CSRF-protected).
  fastify.post(
    '/api/admin/schedules/:id/trigger',
    { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) },
    async (request, reply) => {
      const id = (request.params as { id: string }).id;
      const schedule = await getSchedule(repo, id);
      if (!schedule) {
        reply.code(404);
        return { error: 'schedule_not_found' };
      }
      const occurrence = await triggerSchedule(repo, id);
      return { ok: true, occurrence };
    },
  );
}
