import { FastifyInstance } from 'fastify';
import { randomBytes } from 'crypto';
const nanoid = (n: number) => randomBytes(Math.ceil(n * 3 / 4)).toString('base64url').slice(0, n);
import { getDb } from '../db/index';
import { broadcast } from '../ws/index';
import { guardAdmin } from './admin-gate';

// ─── Helper ───────────────────────────────────────────────────────────────────

function getPageWithPanels(db: ReturnType<typeof getDb>, id: string) {
  const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(id) as any;
  if (!page) return null;
  const panels = db
    .prepare('SELECT * FROM page_panels WHERE page_id = ? ORDER BY position, id')
    .all(id);
  return {
    ...page,
    floating_config: page.floating_config ? JSON.parse(page.floating_config) : null,
    panels,
  };
}

/**
 * Pages — named display layouts, each with one or more panels (webviews).
 *
 * Each panel occupies a region of the screen (x/y/w/h as % 0-100) and
 * points to either a canvas-ui-hacs view (canvas_view_id) or a raw URL.
 *
 * On push the kiosk receives:
 *   { type: 'load_page', page_id, page_data: { panels, ... } }
 * and opens one native WebviewWindow per panel.
 */
export async function pageRoutes(app: FastifyInstance) {

  // GET /api/pages  — list all pages with their panels
  app.get('/pages', async () => {
    const db = getDb();
    const pages = db.prepare('SELECT * FROM pages ORDER BY name').all() as any[];
    return pages.map(p => ({
      ...p,
      floating_config: p.floating_config ? JSON.parse(p.floating_config) : null,
      panels: db.prepare('SELECT * FROM page_panels WHERE page_id = ? ORDER BY position, id').all(p.id),
    }));
  });

  // GET /api/pages/:id  — single page with panels
  app.get<{ Params: { id: string } }>('/pages/:id', async (req, reply) => {
    const page = getPageWithPanels(getDb(), req.params.id);
    if (!page) return reply.code(404).send({ error: 'Page not found' });
    return page;
  });

  // POST /api/pages  { name, panels?: [...] }
  app.post<{ Body: any }>('/pages', async (req, reply) => {
    if (!guardAdmin(reply)) return;
    const db = getDb();
    const { name = 'New Page', panels = [] } = req.body as any;
    const id = nanoid(10);
    const now = new Date().toISOString();

    db.transaction(() => {
      db.prepare(`
        INSERT INTO pages (id, name, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(id, name, now, now);

      for (let i = 0; i < panels.length; i++) {
        const p = panels[i];
        db.prepare(`
          INSERT INTO page_panels (id, page_id, name, x, y, w, h, view_id, url, position)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          nanoid(10), id,
          p.name ?? `Panel ${i + 1}`,
          p.x ?? 0, p.y ?? 0, p.w ?? 100, p.h ?? 100,
          p.view_id ?? null, p.url ?? null,
          p.position ?? i,
        );
      }
    })();

    reply.code(201);
    return getPageWithPanels(db, id);
  });

  // PATCH /api/pages/:id  { name? }
  app.patch<{ Params: { id: string }; Body: any }>('/pages/:id', async (req, reply) => {
    if (!guardAdmin(reply)) return;
    const db = getDb();
    const { id } = req.params;
    if (!db.prepare('SELECT id FROM pages WHERE id = ?').get(id))
      return reply.code(404).send({ error: 'Page not found' });

    const fields: string[] = [];
    const vals: any[] = [];
    for (const f of ['name']) {
      if ((req.body as any)[f] !== undefined) {
        fields.push(`${f}=?`);
        vals.push((req.body as any)[f]);
      }
    }
    if (fields.length) {
      fields.push('updated_at=?');
      vals.push(new Date().toISOString(), id);
      db.prepare(`UPDATE pages SET ${fields.join(', ')} WHERE id=?`).run(...vals);
    }
    return getPageWithPanels(db, id);
  });

  // DELETE /api/pages/:id
  app.delete<{ Params: { id: string } }>('/pages/:id', async (req, reply) => {
    if (!guardAdmin(reply)) return;
    const db = getDb();
    if (!db.prepare('SELECT id FROM pages WHERE id = ?').get(req.params.id))
      return reply.code(404).send({ error: 'Page not found' });
    db.prepare('DELETE FROM pages WHERE id = ?').run(req.params.id);
    return { success: true };
  });

  // POST /api/pages/:id/push  — push load_page to all connected browser clients
  // Gated as admin: this is an editor-initiated dispatch. The canonical
  // command path remains POST /api/commands/page (not gated here).
  app.post<{ Params: { id: string } }>('/pages/:id/push', async (req, reply) => {
    if (!guardAdmin(reply)) return;
    const db = getDb();
    const page = getPageWithPanels(db, req.params.id);
    if (!page) return reply.code(404).send({ error: 'Page not found' });
    // Store as active page in settings
    db.prepare(`UPDATE server_settings SET value=?, updated_at=datetime('now') WHERE key='active_page_id'`).run(page.id);
    broadcast({ type: 'load_page', page_id: page.id, page_data: page }, 'browser');
    return { pushed_to: 1 };
  });

  // ── Panel sub-routes ──────────────────────────────────────────────────────

  // POST /api/pages/:id/panels  { name, x, y, w, h, canvas_view_id?, url? }
  app.post<{ Params: { id: string }; Body: any }>('/pages/:id/panels', async (req, reply) => {
    if (!guardAdmin(reply)) return;
    const db = getDb();
    if (!db.prepare('SELECT id FROM pages WHERE id = ?').get(req.params.id))
      return reply.code(404).send({ error: 'Page not found' });

    const b = req.body as any;
    const panelId = nanoid(10);
    const maxPos = (db.prepare(
      'SELECT COALESCE(MAX(position), -1) as m FROM page_panels WHERE page_id=?'
    ).get(req.params.id) as any).m;

    db.prepare(`
      INSERT INTO page_panels (id, page_id, name, x, y, w, h, view_id, url, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      panelId, req.params.id,
      b.name ?? 'New Panel',
      b.x ?? 0, b.y ?? 0, b.w ?? 100, b.h ?? 100,
      b.view_id ?? null, b.url ?? null,
      maxPos + 1,
    );
    db.prepare('UPDATE pages SET updated_at=? WHERE id=?').run(new Date().toISOString(), req.params.id);

    reply.code(201);
    return db.prepare('SELECT * FROM page_panels WHERE id = ?').get(panelId);
  });

  // PATCH /api/pages/:id/panels/:panelId
  app.patch<{ Params: { id: string; panelId: string }; Body: any }>(
    '/pages/:id/panels/:panelId', async (req, reply) => {
      if (!guardAdmin(reply)) return;
      const db = getDb();
      if (!db.prepare('SELECT id FROM page_panels WHERE id=? AND page_id=?').get(req.params.panelId, req.params.id))
        return reply.code(404).send({ error: 'Panel not found' });

      const b = req.body as any;
      const fields: string[] = [];
      const vals: any[] = [];
      for (const f of ['name', 'x', 'y', 'w', 'h', 'view_id', 'url', 'position']) {
        if (b[f] !== undefined) { fields.push(`${f}=?`); vals.push(b[f]); }
      }
      if (fields.length) {
        vals.push(req.params.panelId);
        db.prepare(`UPDATE page_panels SET ${fields.join(', ')} WHERE id=?`).run(...vals);
        db.prepare('UPDATE pages SET updated_at=? WHERE id=?').run(new Date().toISOString(), req.params.id);
      }
      return db.prepare('SELECT * FROM page_panels WHERE id = ?').get(req.params.panelId);
    }
  );

  // DELETE /api/pages/:id/panels/:panelId
  app.delete<{ Params: { id: string; panelId: string } }>(
    '/pages/:id/panels/:panelId', async (req, reply) => {
      if (!guardAdmin(reply)) return;
      const db = getDb();
      if (!db.prepare('SELECT id FROM page_panels WHERE id=? AND page_id=?').get(req.params.panelId, req.params.id))
        return reply.code(404).send({ error: 'Panel not found' });
      db.prepare('DELETE FROM page_panels WHERE id = ?').run(req.params.panelId);
      db.prepare('UPDATE pages SET updated_at=? WHERE id=?').run(new Date().toISOString(), req.params.id);
      return { success: true };
    }
  );
}
