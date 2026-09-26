/**
 * Remote app lifecycle routes — requested by Canvas Core via the legacy
 * `device_http` bridge (`POST /api/admin/devices/:id/app`).
 *
 *   POST /api/app/restart  — exit non-zero so the systemd supervisor restarts the edge app
 *   POST /api/app/show     — acknowledged; the kiosk controller brings the app fullscreen
 *   POST /api/app/hide     — acknowledged; the kiosk controller backgrounds the app
 *
 * These run inside the Linux edge sidecar. Show/hide are actually performed by the
 * kiosk controller (KioskScreen) which owns the window and the Core WebSocket; only
 * restart is implemented here, because it needs the whole process (kiosk + sidecar)
 * to exit so systemd relaunches it.
 */
import type { FastifyInstance } from 'fastify';
import { requestLocalAction } from '../ws/index';

function exitForRestart() {
  // Give Fastify time to flush the response before terminating.
  setTimeout(() => process.exit(1), 120);
}

export async function appRoutes(app: FastifyInstance) {
  app.post('/app/restart', async (_req, reply) => {
    reply.send({ ok: true, action: 'restart' });
    exitForRestart();
  });

  app.post('/app/show', async (_req, reply) => {
    try {
      return { ok: true, action: 'show', result: await requestLocalAction('show') };
    } catch (error) {
      return reply.code(504).send({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/app/hide', async (_req, reply) => {
    try {
      return { ok: true, action: 'hide', result: await requestLocalAction('hide') };
    } catch (error) {
      return reply.code(504).send({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}
