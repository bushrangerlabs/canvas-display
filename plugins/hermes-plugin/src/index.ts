import Fastify from 'fastify';
import cors from '@fastify/cors';
import { executeTool, getToolManifest } from './tools';

const host = process.env.HERMES_PLUGIN_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.HERMES_PLUGIN_PORT ?? '8787', 10);

async function buildServer() {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });

  app.get('/health', async () => ({
    ok: true,
    service: 'canvas-hermes-plugin',
    version: '0.1.0',
    canvasApiUrl: (process.env.CANVAS_API_URL ?? 'http://127.0.0.1:3100').replace(/\/$/, ''),
  }));

  app.get('/tools', async () => ({
    ok: true,
    tools: getToolManifest(),
  }));

  app.post('/tools/execute', async (req, reply) => {
    const result = await executeTool(req.body);
    if (!result.ok) reply.code(400);
    return result;
  });

  return app;
}

async function main() {
  const app = await buildServer();
  try {
    await app.listen({ host, port });
    app.log.info(`Hermes plugin listening on http://${host}:${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
