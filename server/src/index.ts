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
import { radioRoutes } from './routes/radio';
import { broadcastRoutes } from './routes/broadcast';
import { voiceStateRoutes } from './routes/voice-state';
import { voiceRoutes } from './routes/voice';
import { iconRoutes } from './routes/icons';
import { appRoutes } from './routes/app';
import { dlnaRoutes } from './routes/dlna';
import { connectMqtt, disconnectMqtt } from './mqtt/index';
import { broadcast } from './ws/index';
import { startDlna, stopDlna, videoWrapperUrl } from './dlna/index';
import type { DlnaPlaybackAdapter } from './dlna/renderer';
import { registerSinkReleaser } from './audio/arbiter';
import { stopSnapclient } from './audio/snapcast';
import {
  getAudioState,
  pauseAudio,
  playAudio,
  resumeAudio,
  seekAudio,
  setAudioMute,
  setAudioVolume,
  stopAudio,
} from './routes/audio';
import { getDb } from './db/index';
import os from 'os';
import { randomUUID } from 'crypto';
import { startVoiceServer, stopVoiceServer, isVoiceEnabled } from './voice/index';
import { getCoreBridgeConfig, startDirectWakeword, stopDirectWakeword } from './voice/direct-wakeword';
import { claimVoiceOwnership, releaseVoiceOwnership } from './voice/ownership';
import { startTtsBroadcastPoller, stopTtsBroadcastPoller } from './voice/tts-broadcast-poller';
import { startAlertBroadcastPoller, stopAlertBroadcastPoller } from './voice/alert-broadcast-poller';
import { startIntercomPoller, stopIntercomPoller } from './voice/intercom-poller';

function useDirectCoreVoice(): boolean {
  const { baseUrl, token } = getCoreBridgeConfig();
  return process.env.CANVAS_DISABLE_DIRECT_WAKEWORD !== '1' && Boolean(baseUrl && token);
}

// ─── Audio sink arbiter ───────────────────────────────────────────────────────

/**
 * Wire the two subsystems that compete for the single audio output. When one
 * takes the sink the other is released first, so mpv playback and the Snapcast
 * client never play over each other.
 */
function initAudioArbiter(): void {
  registerSinkReleaser('mpv', async () => { await stopAudio(); });
  registerSinkReleaser('snapcast', async () => { await stopSnapclient(); });
}

// ─── DLNA MediaRenderer ───────────────────────────────────────────────────────

let dlnaBaseUrl = '';

function readSetting(key: string): string {
  try {
    const row = getDb().prepare('SELECT value FROM server_settings WHERE key = ?').get(key) as
      | { value?: string }
      | undefined;
    return row?.value ?? '';
  } catch {
    return '';
  }
}

function writeSetting(key: string, value: string): void {
  try {
    getDb()
      .prepare(
        'INSERT INTO server_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  } catch {
    // Settings table may not be ready yet; the UUID is regenerated next boot.
  }
}

/** Stable per-device DLNA UUID: env → persisted setting → freshly generated. */
function resolveDlnaUuid(): string {
  const configured = config.dlnaUuid || readSetting('dlna_uuid');
  if (configured) return configured;
  const generated = randomUUID();
  writeSetting('dlna_uuid', generated);
  return generated;
}

function resolveDlnaFriendlyName(): string {
  return (
    config.dlnaFriendlyName ||
    readSetting('device_name') ||
    `Canvas Display (${os.hostname()})`
  );
}

async function startDlnaRenderer(): Promise<void> {
  const adapter: DlnaPlaybackAdapter = {
    playAudio: async (input) => { await playAudio(input); },
    pauseAudio: async () => { await pauseAudio(); },
    resumeAudio: async () => { await resumeAudio(); },
    stopAudio: async () => { await stopAudio(); },
    seekAudio: async (seconds) => { await seekAudio(seconds); },
    setVolume: async (level) => { await setAudioVolume(level); },
    setMute: async (muted) => { await setAudioMute(muted); },
    getVolume: () => getAudioState().volume,
    getMuted: () => getAudioState().muted,
    // Video is rendered by the kiosk's floating WebView; the wrapper page gives
    // it a full-screen <video> element with native controls.
    playVideo: (url, title) => {
      if (!dlnaBaseUrl) return;
      broadcast(
        { type: 'command', action: 'show_floating', payload: { url: videoWrapperUrl(dlnaBaseUrl, url, title) } },
        'browser',
      );
    },
    stopVideo: () => {
      broadcast({ type: 'command', action: 'hide_floating', payload: {} }, 'browser');
    },
  };

  try {
    const handle = await startDlna({
      enabled: config.dlnaEnabled,
      port: config.dlnaPort,
      uuid: resolveDlnaUuid(),
      friendlyName: resolveDlnaFriendlyName(),
      manufacturer: 'Canvas Display',
      modelName: 'Canvas Display',
      modelNumber: '0.3.1',
      host: config.dlnaHost || undefined,
      adapter,
    });
    if (handle) dlnaBaseUrl = handle.baseUrl;
  } catch (err) {
    console.warn('[dlna] failed to start renderer:', err instanceof Error ? err.message : err);
  }
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
  await app.register(radioRoutes, { prefix: '/api' });
  await app.register(broadcastRoutes, { prefix: '/api' });
  await app.register(voiceStateRoutes, { prefix: '/api' });
  await app.register(voiceRoutes,      { prefix: '/api' });
  await app.register(iconRoutes,       { prefix: '/api' });
  await app.register(appRoutes,        { prefix: '/api' });
  await app.register(dlnaRoutes,       { prefix: '/api' });
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
    // Start alert broadcast poller (polls Core for doorbell/admin alerts)
    startAlertBroadcastPoller(config.port);
    // Start intercom poller (polls Core for device-to-device audio messages)
    startIntercomPoller();

    // Arbitrate the single audio sink between mpv and the Snapcast client.
    initAudioArbiter();

    // Expose the display as a UPnP/DLNA MediaRenderer so Home Assistant
    // (dlna_dmr) and Music Assistant can push audio and video to it.
    await startDlnaRenderer();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

process.on('SIGTERM', async () => { stopDlna(); await stopDirectWakeword(); await stopVoiceServer(); stopTtsBroadcastPoller(); stopAlertBroadcastPoller(); stopIntercomPoller(); releaseVoiceOwnership(); disconnectMqtt(); process.exit(0); });
process.on('SIGINT',  async () => { stopDlna(); await stopDirectWakeword(); await stopVoiceServer(); stopTtsBroadcastPoller(); stopAlertBroadcastPoller(); stopIntercomPoller(); releaseVoiceOwnership(); disconnectMqtt(); process.exit(0); });

process.on('uncaughtException', (err) => {
  console.error('[canvas-ui] Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[canvas-ui] Unhandled rejection:', reason);
  process.exit(1);
});

main();
