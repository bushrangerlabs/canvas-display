/**
 * Custom icon routes — server-persisted store for user-uploaded SVG icons.
 *
 * Custom icons used to live only in the editor browser's localStorage, so any
 * other browser/kiosk (including edge display devices) rendering a scene with
 * a `custom:` icon would just show nothing. Persisting them here means every
 * client that loads the app — editor or edge device — sees the same icon set.
 *
 * GET    /api/icons        → list all custom icons
 * PUT    /api/icons/:name  → create/update an icon { svg }
 * DELETE /api/icons/:name  → remove an icon
 */

import { FastifyInstance } from 'fastify';
import { getDb } from '../db/index';
import { guardAdmin } from './admin-gate';

const MAX_SVG_BYTES = 512 * 1024; // 512KB — generous for an icon, prevents abuse

export async function iconRoutes(app: FastifyInstance) {
  // GET /api/icons
  app.get('/icons', async () => {
    const db = getDb();
    return db.prepare('SELECT name, svg, created_at, updated_at FROM custom_icons ORDER BY name').all();
  });

  // PUT /api/icons/:name  { svg }
  app.put<{ Params: { name: string }; Body: { svg?: string } }>('/icons/:name', async (req, reply) => {
    if (!guardAdmin(reply)) return;
    const name = req.params.name?.trim();
    const svg = req.body?.svg;
    if (!name) return reply.code(400).send({ error: 'Icon name is required' });
    if (!svg || typeof svg !== 'string' || !svg.includes('<svg'))
      return reply.code(400).send({ error: 'svg must be a non-empty SVG markup string' });
    if (Buffer.byteLength(svg, 'utf8') > MAX_SVG_BYTES)
      return reply.code(413).send({ error: 'Icon SVG too large' });

    const db = getDb();
    db.prepare(`
      INSERT INTO custom_icons (name, svg, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(name) DO UPDATE SET svg = excluded.svg, updated_at = excluded.updated_at
    `).run(name, svg);

    return db.prepare('SELECT name, svg, created_at, updated_at FROM custom_icons WHERE name = ?').get(name);
  });

  // DELETE /api/icons/:name
  app.delete<{ Params: { name: string } }>('/icons/:name', async (req, reply) => {
    if (!guardAdmin(reply)) return;
    const db = getDb();
    if (!db.prepare('SELECT name FROM custom_icons WHERE name = ?').get(req.params.name))
      return reply.code(404).send({ error: 'Icon not found' });
    db.prepare('DELETE FROM custom_icons WHERE name = ?').run(req.params.name);
    return { success: true };
  });
}
