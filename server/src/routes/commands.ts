/**
 * Command routes — REST equivalents of the MQTT command topics.
 *
 *   POST /api/commands/page      { page_id?, page? }
 *   POST /api/commands/navigate  { panel_id?, panel?, page_id?, page?, url }
 *   POST /api/commands/reload    {}
 *   POST /api/commands/quit      {}
 *
 * These are the same actions available over MQTT, exposed as simple HTTP
 * endpoints so the Home Assistant integration (and any other REST client)
 * can control the display without needing a broker.
 */
import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/index';
import { broadcast } from '../ws/index';

function getPageWithPanels(db: ReturnType<typeof getDb>, pageId: string) {
  const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(pageId) as any;
  if (!page) return null;
  const panels = db
    .prepare('SELECT * FROM page_panels WHERE page_id = ? ORDER BY position, id')
    .all(pageId);
  return {
    ...page,
    floating_config: page.floating_config ? JSON.parse(page.floating_config) : null,
    panels,
  };
}

function resolvePage(db: ReturnType<typeof getDb>, data: any) {
  if (data.page_id) {
    return db.prepare('SELECT * FROM pages WHERE id = ?').get(data.page_id) as any ?? null;
  }
  if (data.page) {
    return db.prepare('SELECT * FROM pages WHERE LOWER(name) = LOWER(?)').get(data.page) as any ?? null;
  }
  return null;
}

function resolvePanel(db: ReturnType<typeof getDb>, data: any, scopePageId?: string) {
  if (data.panel_id) {
    return db.prepare('SELECT * FROM page_panels WHERE id = ?').get(data.panel_id) as any ?? null;
  }
  if (data.panel) {
    if (scopePageId) {
      return db.prepare(
        'SELECT * FROM page_panels WHERE page_id = ? AND LOWER(name) = LOWER(?)',
      ).get(scopePageId, data.panel) as any ?? null;
    }
    return db.prepare(
      'SELECT * FROM page_panels WHERE LOWER(name) = LOWER(?)',
    ).get(data.panel) as any ?? null;
  }
  return null;
}

export async function commandRoutes(app: FastifyInstance) {

  // POST /api/commands/page — push a page to the display (by id or name)
  app.post<{ Body: any }>('/commands/page', async (req, reply) => {
    const db = getDb();
    const page = resolvePage(db, req.body ?? {});
    if (!page) return reply.code(404).send({ error: 'Page not found' });

    db.prepare(
      `UPDATE server_settings SET value=?, updated_at=datetime('now') WHERE key='active_page_id'`,
    ).run(page.id);

    const pageWithPanels = getPageWithPanels(db, page.id)!;
    broadcast({ type: 'load_page', page_id: page.id, page_data: pageWithPanels }, 'browser');
    return { success: true, page_id: page.id, page_name: page.name };
  });

  // POST /api/commands/navigate — send a URL to a specific panel (by id or name)
  app.post<{ Body: any }>('/commands/navigate', async (req, reply) => {
    const body: Record<string, any> = req.body ?? {};
    if (!body.url) return reply.code(400).send({ error: 'url is required' });

    const db = getDb();

    // Optionally scope panel resolution to a specific page (for disambiguation)
    let scopePageId: string | undefined;
    if (body.page_id || body.page) {
      const scopePage = resolvePage(db, body);
      scopePageId = scopePage?.id;
    }

    const panel = resolvePanel(db, body, scopePageId);
    if (!panel) return reply.code(404).send({ error: 'Panel not found' });

    broadcast({
      type: 'command',
      action: 'navigate_panel',
      payload: { panel_id: panel.id, url: body.url },
    }, 'browser');

    return { success: true, panel_id: panel.id, url: body.url };
  });

  // POST /api/commands/reload — reload the browser display
  app.post('/commands/reload', async (_req, reply) => {
    broadcast({ type: 'command', action: 'reload', payload: {} }, 'browser');
    return { success: true };
  });

  // POST /api/commands/quit — show the quit dialog on the display
  app.post('/commands/quit', async (_req, reply) => {
    broadcast({ type: 'command', action: 'show_quit_dialog', payload: {} }, 'browser');
    return { success: true };
  });
}
