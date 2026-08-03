import type { FastifyInstance } from 'fastify';

export async function sceneRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/scenes/:id/published', async (request, reply) => {
    const coreUrl = (process.env.CANVAS_CORE_URL ?? '').replace(/\/+$/, '');
    if (!coreUrl) {
      return reply.code(503).send({ error: 'core_scene_bridge_not_configured' });
    }

    const response = await fetch(
      `${coreUrl}/api/scenes/${encodeURIComponent(request.params.id)}/published`,
      { headers: { accept: 'application/json' } },
    );
    const body = await response.text();
    reply.code(response.status);
    reply.header('Cache-Control', 'no-store');
    reply.type(response.headers.get('content-type') ?? 'application/json');
    return reply.send(body);
  });
}
