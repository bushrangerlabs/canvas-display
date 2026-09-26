import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

/**
 * Custom icon routes — server-persisted store for user-uploaded SVG icons.
 *
 * Custom icons used to live only in the editor browser's localStorage, so any
 * other browser/kiosk (including edge display devices) rendering a `custom:`
 * icon saw nothing. Persisting them here means every client — editor or edge —
 * sees the same set. GET is intentionally public (no auth), matching
 * `/api/scenes/:id/published`: kiosk displays render icons without a login
 * session. Writes are admin-gated since the SVG is injected via innerHTML.
 */

export interface IconRecord {
  name: string;
  svg: string;
  createdAt: string;
  updatedAt: string;
}

export interface IconRepositoryLike {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export class PgIconRepository implements IconRepositoryLike {
  constructor(private readonly pool: any) {}
  query(text: string, params?: unknown[]) {
    return this.pool.query(text, params as unknown[]) as unknown as Promise<{ rows: any[]; rowCount: number | null }>;
  }
}

const MAX_SVG_BYTES = 512 * 1024; // 512KB — generous for an icon, prevents abuse

function rowToIcon(row: any): IconRecord {
  return { name: row.name, svg: row.svg, createdAt: row.created_at, updatedAt: row.updated_at };
}

export interface IconPluginOptions {
  repo: IconRepositoryLike;
  requireAdmin: (opts?: { roles?: ('admin' | 'viewer')[]; csrf?: boolean }) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

export async function registerIconRoutes(fastify: FastifyInstance, options: IconPluginOptions): Promise<void> {
  const { repo, requireAdmin } = options;

  // GET /api/icons — public, no auth (kiosk/edge displays need this without a session).
  fastify.get('/api/icons', async () => {
    const res = await repo.query('SELECT name, svg, created_at, updated_at FROM custom_icons ORDER BY name');
    return res.rows.map(rowToIcon);
  });

  // PUT /api/icons/:name  { svg }
  fastify.put(
    '/api/icons/:name',
    { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const name = (request.params as { name: string }).name?.trim();
      const svg = (request.body as { svg?: string } | undefined)?.svg;
      if (!name) { reply.code(400); return { error: 'Icon name is required' }; }
      if (!svg || typeof svg !== 'string' || !svg.includes('<svg')) {
        reply.code(400);
        return { error: 'svg must be a non-empty SVG markup string' };
      }
      if (Buffer.byteLength(svg, 'utf8') > MAX_SVG_BYTES) {
        reply.code(413);
        return { error: 'Icon SVG too large' };
      }
      await repo.query(
        `INSERT INTO custom_icons (name, svg, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (name) DO UPDATE SET svg = excluded.svg, updated_at = excluded.updated_at`,
        [name, svg],
      );
      const res = await repo.query('SELECT name, svg, created_at, updated_at FROM custom_icons WHERE name = $1', [name]);
      return rowToIcon(res.rows[0]);
    },
  );

  // DELETE /api/icons/:name
  fastify.delete(
    '/api/icons/:name',
    { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const name = (request.params as { name: string }).name;
      const existing = await repo.query('SELECT name FROM custom_icons WHERE name = $1', [name]);
      if (existing.rows.length === 0) { reply.code(404); return { error: 'Icon not found' }; }
      await repo.query('DELETE FROM custom_icons WHERE name = $1', [name]);
      return { success: true };
    },
  );
}
