/**
 * DLNA status routes.
 *
 *   GET /api/dlna/state  → current renderer transport state + advertised URLs
 *
 * The renderer itself is started by the composition root; these routes only
 * report what it is doing so the editor and support tooling can see it.
 */
import type { FastifyInstance } from 'fastify';
import { getDlnaHandle } from '../dlna/index';

export async function dlnaRoutes(app: FastifyInstance): Promise<void> {
  app.get('/dlna/state', async () => {
    const handle = getDlnaHandle();
    if (!handle) return { enabled: false };
    return {
      enabled: true,
      base_url: handle.baseUrl,
      port: handle.port,
      description_url: `${handle.baseUrl}/description.xml`,
      ...handle.renderer.getState(),
    };
  });
}