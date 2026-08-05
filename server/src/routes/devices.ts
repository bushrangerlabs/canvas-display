import { FastifyInstance } from 'fastify';
import { randomBytes } from 'crypto';
const nanoid = (n: number) => randomBytes(Math.ceil(n * 3 / 4)).toString('base64url').slice(0, n);
import { getDb } from '../db/index';
import { broadcast, sendCommand, getConnectedDeviceIds } from '../ws/index';
import { publishDeviceState } from '../mqtt/index';
import { guardAdmin } from './admin-gate';

export async function deviceRoutes(app: FastifyInstance) {

  // GET /api/devices
  app.get('/devices', async () => {
    const db = getDb();
    const devices = db.prepare('SELECT * FROM devices ORDER BY name').all() as any[];
    const connected = new Set(getConnectedDeviceIds());
    return devices.map(d => ({ ...d, online: connected.has(d.id) }));
  });

  // GET /api/devices/:id
  app.get<{ Params: { id: string } }>('/devices/:id', async (req, reply) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
    if (!row) return reply.code(404).send({ error: 'Device not found' });
    const connected = new Set(getConnectedDeviceIds());
    return { ...row as any, online: connected.has(req.params.id) };
  });

  // POST /api/devices/register  (called by browser / Tauri kiosk on first boot)
  app.post<{ Body: any }>('/devices/register', async (req, reply) => {
    const db = getDb();
    const body = req.body as any;
    const id = body.id ?? nanoid(10);
    const now = new Date().toISOString();
    const existing = db.prepare('SELECT id FROM devices WHERE id = ?').get(id);
    if (existing) {
      db.prepare(`
        UPDATE devices SET last_seen=?, ip_address=?, app_version=?, platform=?,
          screen_width=COALESCE(?, screen_width),
          screen_height=COALESCE(?, screen_height),
          pixel_ratio=COALESCE(?, pixel_ratio)
        WHERE id=?
      `).run(now, body.ip_address ?? null, body.app_version ?? null,
             body.platform ?? 'unknown',
             body.screen_width ?? null, body.screen_height ?? null,
             body.pixel_ratio ?? null, id);
      return db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
    }
    db.prepare(`
      INSERT INTO devices
        (id, name, platform, description, assigned_page_id, last_seen, ip_address,
         app_version, created_at, slug, screen_width, screen_height, pixel_ratio)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      body.name ?? id,
      body.platform ?? 'unknown',
      body.description ?? null,
      null,          // no page assigned yet
      now,
      body.ip_address ?? null,
      body.app_version ?? null,
      now,
      body.slug ?? null,
      body.screen_width ?? null,
      body.screen_height ?? null,
      body.pixel_ratio ?? null,
    );
    broadcast({ type: 'device_registered', device_id: id }, 'editor');
    reply.code(201);
    return db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
  });

  // PATCH /api/devices/:id  { name?, description?, assigned_page_id?, slug? }
  app.patch<{ Params: { id: string }; Body: any }>('/devices/:id', async (req, reply) => {
    if (!guardAdmin(reply)) return;
    const db = getDb();
    const body = req.body as any;
    if (!db.prepare('SELECT id FROM devices WHERE id = ?').get(req.params.id))
      return reply.code(404).send({ error: 'Device not found' });

    const fields: string[] = [];
    const vals: any[] = [];
    for (const f of ['name', 'description', 'assigned_page_id', 'slug', 'platform']) {
      if (body[f] !== undefined) { fields.push(`${f}=?`); vals.push(body[f]); }
    }
    if (fields.length) {
      vals.push(req.params.id);
      db.prepare(`UPDATE devices SET ${fields.join(', ')} WHERE id=?`).run(...vals);

      // If assigned page changed, push load_page to the device immediately
      if (body.assigned_page_id) {
        const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(body.assigned_page_id) as any;
        if (page) {
          const panels = db.prepare('SELECT * FROM page_panels WHERE page_id=? ORDER BY position, id').all(body.assigned_page_id);
          const pageData = { ...page, floating_config: page.floating_config ? JSON.parse(page.floating_config) : null, panels };
          sendCommand(req.params.id, { type: 'load_page', page_id: body.assigned_page_id, page_data: pageData });
        }
        publishDeviceState(req.params.id);
      }
    }
    return db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  });

  // DELETE /api/devices/:id
  app.delete<{ Params: { id: string } }>('/devices/:id', async (req, reply) => {
    if (!guardAdmin(reply)) return;
    const db = getDb();
    if (!db.prepare('SELECT id FROM devices WHERE id = ?').get(req.params.id))
      return reply.code(404).send({ error: 'Device not found' });
    db.prepare('DELETE FROM devices WHERE id = ?').run(req.params.id);
    return { success: true };
  });

  // POST /api/devices/:id/command  (single device)
  app.post<{ Params: { id: string }; Body: any }>('/devices/:id/command', async (req, reply) => {
    if (!guardAdmin(reply)) return;
    const db = getDb();
    const body = req.body as any;
    if (req.params.id !== '*' && !db.prepare('SELECT id FROM devices WHERE id = ?').get(req.params.id))
      return reply.code(404).send({ error: 'Device not found' });
    const now = new Date().toISOString();
    const cmdId = db.prepare(
      'INSERT INTO commands (device_id, action, payload, source, sent_at) VALUES (?, ?, ?, ?, ?)'
    ).run(req.params.id, body.action, JSON.stringify(body.payload ?? {}), body.source ?? 'api', now).lastInsertRowid;
    sendCommand(req.params.id, {
      type: 'command', id: cmdId, device_id: req.params.id,
      action: body.action, payload: body.payload ?? {},
    });
    reply.code(202);
    return { command_id: cmdId };
  });

  // POST /api/devices/command  (broadcast to all)
  app.post<{ Body: any }>('/devices/command', async (req, reply) => {
    if (!guardAdmin(reply)) return;
    const db = getDb();
    const body = req.body as any;
    const now = new Date().toISOString();
    const cmdId = db.prepare(
      'INSERT INTO commands (device_id, action, payload, source, sent_at) VALUES (?, ?, ?, ?, ?)'
    ).run('*', body.action, JSON.stringify(body.payload ?? {}), body.source ?? 'api', now).lastInsertRowid;
    sendCommand('*', {
      type: 'command', id: cmdId, device_id: '*',
      action: body.action, payload: body.payload ?? {},
    });
    reply.code(202);
    return { command_id: cmdId };
  });
}
