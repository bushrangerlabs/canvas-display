import './pkg-native-patch'; // MUST be first — extracts better_sqlite3.node from pkg snapshot
import './logs';             // intercept console output BEFORE anything else logs
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
import { audioRoutes }   from './routes/audio';
import { logRoutes }     from './routes/logs';
import { mediaRoutes }   from './routes/media';
import { sceneRoutes }   from './routes/scenes';
import { knowledgeCardRoutes } from './routes/knowledge-card';
import { alertRoutes } from './routes/alert';
import { voiceStateRoutes } from './routes/voice-state';
import { connectMqtt, disconnectMqtt } from './mqtt/index';
import { startVoiceServer, stopVoiceServer, isVoiceEnabled } from './voice/index';
import { startDirectWakeword, stopDirectWakeword } from './voice/direct-wakeword';
import { claimVoiceOwnership, releaseVoiceOwnership } from './voice/ownership';
import { startTtsBroadcastPoller, stopTtsBroadcastPoller } from './voice/tts-broadcast-poller';

function useDirectCoreVoice(): boolean {
  return process.env.CANVAS_DISABLE_DIRECT_WAKEWORD !== '1'
    && Boolean(process.env.CANVAS_CORE_URL && process.env.CANVAS_EDGE_VOICE_TOKEN);
}

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
  await app.register(audioRoutes,    { prefix: '/api' });
  await app.register(mediaRoutes,    { prefix: '/api' });
  await app.register(sceneRoutes,    { prefix: '/api' });
  await app.register(knowledgeCardRoutes, { prefix: '/api' });
  await app.register(alertRoutes, { prefix: '/api' });
  await app.register(voiceStateRoutes, { prefix: '/api' });
  await app.register(logRoutes,      { prefix: '/api' });

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

    // A Core-enrolled Edge owns its complete wake -> Core -> local TTS loop.
    // The ESPHome satellite is the fallback for HA-owned installations. Never
    // start both because they would compete for the same microphone.
    if (isVoiceEnabled()) {
      const direct = useDirectCoreVoice();
      const owner = claimVoiceOwnership(direct ? 'core-direct' : 'ha-satellite');
      if (!owner.owned || owner.pid !== process.pid) {
        console.error(`[voice] Microphone ownership denied: ${owner.error ?? 'owned by another process'}`);
      } else if (direct) await startDirectWakeword();
      else await startVoiceServer();
    }
    // Start TTS broadcast poller if Core URL is configured (polls for server-pushed TTS)
    startTtsBroadcastPoller();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

process.on('SIGTERM', async () => { await stopDirectWakeword(); await stopVoiceServer(); stopTtsBroadcastPoller(); releaseVoiceOwnership(); disconnectMqtt(); process.exit(0); });
process.on('SIGINT',  async () => { await stopDirectWakeword(); await stopVoiceServer(); stopTtsBroadcastPoller(); releaseVoiceOwnership(); disconnectMqtt(); process.exit(0); });

process.on('uncaughtException', (err) => {
  console.error('[canvas-ui] Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[canvas-ui] Unhandled rejection:', reason);
  process.exit(1);
});

main();
