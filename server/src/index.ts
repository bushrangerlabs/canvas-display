import './pkg-native-patch'; // MUST be first — extracts better_sqlite3.node from pkg snapshot
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import staticFiles from '@fastify/static';
import path from 'path';
import { config } from './config';
import { initDb } from './db/index';
import { initWss } from './ws/index';
import { haRoutes } from './routes/ha';
import { pageRoutes } from './routes/pages';
import { settingsRoutes } from './routes/settings';
import { commandRoutes } from './routes/commands';
import { connectMqtt, disconnectMqtt } from './mqtt/index';

async function main() {
  // ── Database ──────────────────────────────────────────────────────────────
  initDb();

  // ── Fastify ───────────────────────────────────────────────────────────────
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'warn' },
    ignoreTrailingSlash: true,
  });

  await app.register(cors, { origin: config.corsOrigins });
  await app.register(jwt, { secret: config.jwtSecret });

  // ── Routes ────────────────────────────────────────────────────────────────
  await app.register(haRoutes,       { prefix: '/api' });
  await app.register(pageRoutes,     { prefix: '/api' });
  await app.register(settingsRoutes, { prefix: '/api' });
  await app.register(commandRoutes,  { prefix: '/api' });

  // ── Serve web SPA (editor + display) ─────────────────────────────────────
  // config.staticDir resolves to: STATIC_DIR env (set by Tauri), or
  // public/ beside the binary (standalone pkg), or ./public (dev).
  const webRoot = config.staticDir;
  await app.register(staticFiles, {
    root: webRoot,
    prefix: '/',
    index: 'index.html',
  });

  // Never cache index.html — ensures fresh asset hashes after updates
  app.addHook('onSend', async (request, reply) => {
    if (request.url === '/' || request.url.endsWith('/index.html')) {
      reply.header('Cache-Control', 'no-store');
    }
  });

  // SPA fallback — all non-API routes serve index.html
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api') || request.url.startsWith('/ws')) {
      reply.code(404).send({ error: 'Not Found', statusCode: 404 });
      return;
    }
    reply.header('Cache-Control', 'no-store');
    return reply.sendFile('index.html', webRoot);
  });

  // Health check (no prefix)
  app.get('/health', async () => ({ ok: true }));

  // ── HTTP server + WebSocket ───────────────────────────────────────────────
  await app.ready();
  initWss(app.server);

  // ── Start ─────────────────────────────────────────────────────────────────
  try {
    await app.listen({ port: config.port, host: config.host });
    const host = config.host === '0.0.0.0' ? 'localhost' : config.host;
    console.log(`\n  Canvas UI Platform server`);
    console.log(`  Mode  →  ${config.isHaAddon ? 'HA add-on' : 'standalone'}`);
    console.log(`  API   →  http://${host}:${config.port}/api`);
    console.log(`  WS    →  ws://${host}:${config.port}/ws`);
    console.log(`  DB    →  ${config.dbPath}\n`);

    // Start MQTT client if configured
    await connectMqtt();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

process.on('SIGTERM', () => { disconnectMqtt(); process.exit(0); });
process.on('SIGINT',  () => { disconnectMqtt(); process.exit(0); });

process.on('uncaughtException', (err) => {
  console.error('[canvas-ui] Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[canvas-ui] Unhandled rejection:', reason);
  process.exit(1);
});

main();
