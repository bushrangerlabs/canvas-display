import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

/**
 * Scene revisions / manifests scaffold (Phase2 checklist: "Add scene revisions,
 * staged object publication, manifests, content-addressed assets, and assignments";
 * plan doc §10.2 Scenes tables, §18.1 immutable revisions; aligns with
 * `docs/PHASE_0_SCENE_STAGING_SPEC.md`).
 *
 * SCOPE OF THIS SCAFFOLD:
 *   - `scenes` holds one row per scene with a monotonic `revision`, a `manifest_json`
 *     payload (widgets/layout/assignments), and a `status` (staged/published/
 *     rolled_back).
 *   - `scene_assignments` maps a published scene to a device (or device group, later).
 *   - `createScene` -> `publishScene` (bumps revision, sets published) -> `assignScene`.
 *
 * DEFERRED (later phases, per spec/plan):
 *   - Content-addressed asset storage and per-asset SHA-256 verification (the spec's
 *     `InMemoryContentAddressedObjectStore`).
 *   - Bounded concurrent staging, renderer preload tokens, atomic activation/rollback
 *     (the spec's `SceneStoreRuntime`); `publishScene` here is a simple status flip,
 *     not the staged-ready-activate flow.
 *   - `scene_revisions` / `assets` / `scene_assets` normalized tables; this scaffold
 *     keeps the manifest inline in `scenes` so the schema is ready to split later.
 *   The columns chosen here are forward-compatible with those later tables.
 *
 * The repository is injected so unit tests can run against an in-memory Postgres
 * (`pg-mem`) without a network.
 */

export type SceneStatus = 'staged' | 'published' | 'rolled_back';

export interface SceneRecord {
  id: string;
  name: string;
  revision: number;
  manifest: unknown;
  status: SceneStatus;
  createdAt: string;
  publishedAt: string | null;
}

export interface SceneRevisionRecord {
  id: string;
  sceneId: string;
  revision: number;
  manifest: unknown;
  status: SceneStatus;
  createdAt: string;
}

export interface SceneAssignment {
  sceneId: string;
  deviceId: string;
  assignedAt: string;
}

/** Storage abstraction so tests can swap in an in-memory Postgres (`pg-mem`). */
export interface SceneRepositoryLike {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export class PgSceneRepository implements SceneRepositoryLike {
  constructor(private readonly pool: Pool) {}
  query(text: string, params?: unknown[]) {
    return this.pool.query(text, params as unknown[]) as unknown as Promise<{ rows: any[]; rowCount: number | null }>;
  }
}

/** Creates a scene in `staged` status with revision 1. Returns the new record. */
export async function createScene(
  repo: SceneRepositoryLike,
  name: string,
  manifest: unknown,
): Promise<SceneRecord> {
  const id = randomUUID();
  const manifestJson = JSON.stringify(manifest);
  const res = await repo.query(
    `INSERT INTO scenes (id, name, revision, manifest_json, status, created_at)
     VALUES ($1, $2, 1, $3, 'staged', now())
     RETURNING *`,
    [id, name, manifestJson],
  );
  // Also insert a row into scene_revisions for the initial revision.
  const revId = randomUUID();
  await repo.query(
    `INSERT INTO scene_revisions (id, scene_id, revision, manifest_json, status, created_at)
     VALUES ($1, $2, 1, $3, 'staged', now())`,
    [revId, id, manifestJson],
  );
  return rowToScene(res.rows[0]);
}

// --- staged publication lifecycle ---------------------------------------------

/**
 * Stages a new revision for a scene. All `sha256:<hex>` asset references in the
 * manifest must exist in the `assets` table (caller should validate before calling).
 * Allocates the next revision number and sets status to `staged`.
 * The existing published scene is NOT modified.
 */
export async function stageSceneRevision(
  repo: SceneRepositoryLike,
  sceneId: string,
  manifest: unknown,
): Promise<SceneRevisionRecord> {
  // Get the current max revision from scene_revisions.
  const maxRes = await repo.query(
    'SELECT COALESCE(MAX(revision), 0) AS m FROM scene_revisions WHERE scene_id = $1',
    [sceneId],
  );
  const currentMax = Number(maxRes.rows[0]?.m ?? 0);
  const nextRevision = currentMax + 1;
  const revId = randomUUID();
  const manifestJson = JSON.stringify(manifest);

  // Update the scenes row to point at the new staged revision.
  const updateRes = await repo.query(
    `UPDATE scenes
       SET revision = $2,
           manifest_json = $3,
           status = 'staged',
           published_at = NULL
     WHERE id = $1
     RETURNING *`,
    [sceneId, nextRevision, manifestJson],
  );
  if (updateRes.rowCount === 0 || !updateRes.rows[0]) {
    throw new Error(`scene_not_found: ${sceneId}`);
  }

  // Insert into scene_revisions.
  await repo.query(
    `INSERT INTO scene_revisions (id, scene_id, revision, manifest_json, status, created_at)
     VALUES ($1, $2, $3, $4, 'staged', now())`,
    [revId, sceneId, nextRevision, manifestJson],
  );

  return {
    id: revId,
    sceneId,
    revision: nextRevision,
    manifest,
    status: 'staged',
    createdAt: new Date().toISOString(),
  };
}

/**
 * Publishes a scene: atomically activates the current staged revision.
 * Transactionally:
 *   1. Reads the current scene row (old published revision).
 *   2. Flips status to `published` and records `published_at`.
 *   3. The old published revision is preserved in `scene_revisions` for rollback.
 * Returns the updated scene record.
 */
export async function publishScene(
  repo: SceneRepositoryLike,
  id: string,
): Promise<SceneRecord> {
  // Use a transaction for atomicity.
  const res = await repo.query(
    `UPDATE scenes
       SET status = 'published',
           published_at = now()
     WHERE id = $1
       AND status = 'staged'
     RETURNING *`,
    [id],
  );
  if (res.rowCount === 0 || !res.rows[0]) {
    // Check if the scene exists at all.
    const exists = await repo.query('SELECT id, status FROM scenes WHERE id = $1', [id]);
    if (exists.rows.length === 0) {
      throw new Error(`scene_not_found: ${id}`);
    }
    throw new Error(`scene_not_staged: ${id} is currently ${exists.rows[0].status}`);
  }

  // Update the corresponding scene_revisions row to published.
  await repo.query(
    `UPDATE scene_revisions
       SET status = 'published'
     WHERE scene_id = $1 AND revision = $2`,
    [id, res.rows[0].revision],
  );

  return rowToScene(res.rows[0]);
}

/**
 * Rolls back a published scene to its previous published revision.
 * Transactionally:
 *   1. Finds the current published revision.
 *   2. Finds the most recent previous published revision (strictly lower number).
 *   3. If none exists, throws an error.
 *   4. Marks the current revision as `rolled_back`.
 *   5. Restores the scenes row to the previous revision's manifest, with status `published`.
 * Returns the updated scene record.
 */
export async function rollbackScene(
  repo: SceneRepositoryLike,
  id: string,
): Promise<SceneRecord> {
  // Get current scene.
  const sceneRes = await repo.query('SELECT * FROM scenes WHERE id = $1', [id]);
  if (sceneRes.rows.length === 0) {
    throw new Error(`scene_not_found: ${id}`);
  }
  const current = rowToScene(sceneRes.rows[0]);
  if (current.status !== 'published') {
    throw new Error(`scene_not_published: ${id} is currently ${current.status}`);
  }

  // Find the most recent previous published revision (strictly lower revision number).
  const prevRes = await repo.query(
    `SELECT * FROM scene_revisions
     WHERE scene_id = $1 AND revision < $2 AND status = 'published'
     ORDER BY revision DESC
     LIMIT 1`,
    [id, current.revision],
  );

  // If no previous published revision, look for any revision (staged) that was the
  // one before publishing — the first revision that was ever published.
  let prevRevision: any;
  if (prevRes.rows.length === 0) {
    // Try the first revision ever created (revision 1) as a fallback.
    const fallbackRes = await repo.query(
      `SELECT * FROM scene_revisions
       WHERE scene_id = $1 AND revision < $2
       ORDER BY revision DESC
       LIMIT 1`,
      [id, current.revision],
    );
    if (fallbackRes.rows.length === 0) {
      throw new Error(`no_previous_revision: scene ${id} has no prior revision to roll back to`);
    }
    prevRevision = fallbackRes.rows[0];
  } else {
    prevRevision = prevRes.rows[0];
  }

  // Mark current revision as rolled_back.
  await repo.query(
    `UPDATE scene_revisions
     SET status = 'rolled_back'
     WHERE scene_id = $1 AND revision = $2`,
    [id, current.revision],
  );

  // Restore scenes row to the previous revision.
  const restoreRes = await repo.query(
    `UPDATE scenes
       SET manifest_json = $2,
           revision = $3,
           status = 'published',
           published_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, JSON.stringify(parseJson(prevRevision.manifest_json)), Number(prevRevision.revision)],
  );

  return rowToScene(restoreRes.rows[0]);
}

/**
 * Lists all revisions for a scene ordered by revision descending.
 */
export async function listSceneRevisions(
  repo: SceneRepositoryLike,
  sceneId: string,
): Promise<SceneRevisionRecord[]> {
  const res = await repo.query(
    'SELECT * FROM scene_revisions WHERE scene_id = $1 ORDER BY revision DESC',
    [sceneId],
  );
  return res.rows.map(rowToRevision);
}

export async function getScene(
  repo: SceneRepositoryLike,
  id: string,
): Promise<SceneRecord | null> {
  const res = await repo.query('SELECT * FROM scenes WHERE id = $1', [id]);
  return res.rows[0] ? rowToScene(res.rows[0]) : null;
}

export async function listScenes(repo: SceneRepositoryLike): Promise<SceneRecord[]> {
  const res = await repo.query('SELECT * FROM scenes ORDER BY created_at DESC');
  return res.rows.map(rowToScene);
}

export async function deleteScene(
  repo: SceneRepositoryLike,
  id: string,
  force = false,
): Promise<{ assignmentsRemoved: number; panelReferencesCleared: number }> {
  const scene = await getScene(repo, id);
  if (!scene) throw new Error(`scene_not_found: ${id}`);
  const assignments = await repo.query('SELECT 1 FROM scene_assignments WHERE scene_id = $1', [id]);
  const panelReferences = await repo.query('SELECT 1 FROM page_panels WHERE scene_id = $1', [id]);
  if (!force && ((assignments.rowCount ?? 0) > 0 || (panelReferences.rowCount ?? 0) > 0)) {
    throw new Error(
      `scene_in_use: assignments=${assignments.rowCount ?? 0}, panels=${panelReferences.rowCount ?? 0}`,
    );
  }
  if (force) {
    await repo.query('DELETE FROM scene_assignments WHERE scene_id = $1', [id]);
    await repo.query(
      `UPDATE page_panels
       SET content_type = 'url', scene_id = NULL, url = NULL
       WHERE scene_id = $1`,
      [id],
    );
  }
  await repo.query('DELETE FROM scene_revisions WHERE scene_id = $1', [id]);
  await repo.query('DELETE FROM scenes WHERE id = $1', [id]);
  return {
    assignmentsRemoved: assignments.rowCount ?? 0,
    panelReferencesCleared: panelReferences.rowCount ?? 0,
  };
}

/** Assigns a scene to a device. Idempotent: re-assigning does not duplicate. */
export async function assignScene(
  repo: SceneRepositoryLike,
  sceneId: string,
  deviceId: string,
): Promise<SceneAssignment> {
  const res = await repo.query(
    `INSERT INTO scene_assignments (scene_id, device_id, assigned_at)
     VALUES ($1, $2, now())
     ON CONFLICT (scene_id, device_id) DO UPDATE SET assigned_at = now()
     RETURNING *`,
    [sceneId, deviceId],
  );
  return rowToAssignment(res.rows[0]);
}

export async function listAssignments(
  repo: SceneRepositoryLike,
  sceneId: string,
): Promise<SceneAssignment[]> {
  const res = await repo.query(
    'SELECT * FROM scene_assignments WHERE scene_id = $1 ORDER BY assigned_at DESC',
    [sceneId],
  );
  return res.rows.map(rowToAssignment);
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

function rowToScene(row: any): SceneRecord {
  return {
    id: row.id,
    name: row.name,
    revision: Number(row.revision),
    manifest: parseJson(row.manifest_json),
    status: (row.status ?? 'staged') as SceneStatus,
    createdAt: row.created_at,
    publishedAt: row.published_at ?? null,
  };
}

function rowToRevision(row: any): SceneRevisionRecord {
  return {
    id: row.id,
    sceneId: row.scene_id,
    revision: Number(row.revision),
    manifest: parseJson(row.manifest_json),
    status: (row.status ?? 'staged') as SceneStatus,
    createdAt: row.created_at,
  };
}

function rowToAssignment(row: any): SceneAssignment {
  return {
    sceneId: row.scene_id,
    deviceId: row.device_id,
    assignedAt: row.assigned_at,
  };
}

// --- HTTP routes --------------------------------------------------------------

export interface ScenesPluginOptions {
  repo: SceneRepositoryLike;
  assetRepo: { query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> };
  requireAdmin: (opts?: { roles?: ('admin' | 'viewer')[]; csrf?: boolean }) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  onAssign?: (scene: SceneRecord, deviceId: string) => Promise<unknown>;
}

/**
 * Registers the admin scene routes. Reads are admin/viewer (no CSRF); mutations are
 * admin-only and CSRF-protected.
 */
export async function registerSceneRoutes(
  fastify: FastifyInstance,
  options: ScenesPluginOptions,
): Promise<void> {
  const { repo, assetRepo, requireAdmin, onAssign } = options;

  // Published scene documents are display content, not administrative metadata.
  // This read-only route lets kiosk panels render them without an admin session.
  fastify.get('/api/scenes/:id/published', async (request, reply) => {
    const { id } = request.params as { id: string };
    const scene = await getScene(repo, id);
    if (!scene || scene.status !== 'published') {
      reply.code(404);
      return { error: 'published_scene_not_found' };
    }
    return { scene };
  });

  // List scenes (read => no CSRF).
  fastify.get(
    '/api/admin/scenes',
    { preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }) },
    async () => {
      const scenes = await listScenes(repo);
      return { scenes };
    },
  );

  // Create a scene (admin-only, CSRF-protected).
  fastify.post(
    '/api/admin/scenes',
    { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) },
    async (request, reply) => {
      const body = request.body as
        | { name?: unknown; manifest?: unknown }
        | undefined;
      if (typeof body?.name !== 'string' || body.name.length === 0) {
        reply.code(400);
        return { error: 'name (non-empty string) is required' };
      }
      const manifest = body?.manifest ?? {};
      const scene = await createScene(repo, body.name, manifest);
      return { ok: true, scene };
    },
  );

  fastify.delete(
    '/api/admin/scenes/:id',
    { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const force = (request.query as { force?: string } | undefined)?.force === 'true';
      try {
        const removed = await deleteScene(repo, id, force);
        return { ok: true, id, ...removed };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        reply.code(detail.startsWith('scene_not_found') ? 404 : 409);
        return { ok: false, error: detail.startsWith('scene_in_use') ? 'scene_in_use' : 'scene_delete_failed', detail };
      }
    },
  );

  // Stage a new revision (admin-only, CSRF-protected).
  fastify.post(
    '/api/admin/scenes/:id/stage',
    { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) },
    async (request, reply) => {
      const id = (request.params as { id: string }).id;
      const body = request.body as { manifest?: unknown } | undefined;
      if (body?.manifest === undefined) {
        reply.code(400);
        return { error: 'manifest is required' };
      }
      const manifest = body.manifest;
      try {
        const revision = await stageSceneRevision(repo, id, manifest);
        return { ok: true, revision };
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.startsWith('scene_not_found')) {
          reply.code(404);
          return { error: msg };
        }
        throw err;
      }
    },
  );

  // Publish a scene (admin-only, CSRF-protected).
  fastify.post(
    '/api/admin/scenes/:id/publish',
    { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) },
    async (request, reply) => {
      const id = (request.params as { id: string }).id;
      try {
        const scene = await publishScene(repo, id);
        return { ok: true, scene };
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.startsWith('scene_not_found') || msg.startsWith('scene_not_staged')) {
          reply.code(409);
          return { error: msg };
        }
        throw err;
      }
    },
  );

  // Rollback a scene (admin-only, CSRF-protected).
  fastify.post(
    '/api/admin/scenes/:id/rollback',
    { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) },
    async (request, reply) => {
      const id = (request.params as { id: string }).id;
      try {
        const scene = await rollbackScene(repo, id);
        return { ok: true, scene };
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.startsWith('scene_not_found') || msg.startsWith('scene_not_published') || msg.startsWith('no_previous_revision')) {
          reply.code(409);
          return { error: msg };
        }
        throw err;
      }
    },
  );

  // List revisions (read => no CSRF).
  fastify.get(
    '/api/admin/scenes/:id/revisions',
    { preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }) },
    async (request, reply) => {
      const id = (request.params as { id: string }).id;
      const revisions = await listSceneRevisions(repo, id);
      if (revisions.length === 0) {
        const scene = await getScene(repo, id);
        if (!scene) {
          reply.code(404);
          return { error: `scene_not_found: ${id}` };
        }
      }
      return { sceneId: id, revisions };
    },
  );

  // Assign a scene to a device (admin-only, CSRF-protected).
  fastify.post(
    '/api/admin/scenes/:id/assign',
    { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) },
    async (request, reply) => {
      const id = (request.params as { id: string }).id;
      const body = request.body as { deviceId?: unknown } | undefined;
      if (typeof body?.deviceId !== 'string' || body.deviceId.length === 0) {
        reply.code(400);
        return { error: 'deviceId (non-empty string) is required' };
      }
      const scene = await getScene(repo, id);
      if (!scene || scene.status !== 'published') {
        reply.code(409);
        return { error: 'scene_must_be_published_before_assignment' };
      }
      const assignment = await assignScene(repo, id, body.deviceId);
      try {
        const delivery = onAssign ? await onAssign(scene, body.deviceId) : undefined;
        return { ok: true, assignment, delivery };
      } catch (error) {
        // Assignment and delivery are one user operation. Do not retain an
        // assignment that the target device never successfully applied.
        await repo.query('DELETE FROM scene_assignments WHERE scene_id = $1 AND device_id = $2', [id, body.deviceId]);
        reply.code(409);
        return {
          ok: false,
          assignment,
          error: 'scene_delivery_failed',
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
}
