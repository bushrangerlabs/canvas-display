import 'dotenv/config';
import path from 'path';

// When running as a Tauri sidecar, CANVAS_DATA_DIR is set by the Rust host
// to the app's data directory. Fall back to local ./data for standalone dev.
const dataDir = process.env.CANVAS_DATA_DIR ?? process.env.DATA_DIR ?? './data';

// Static web assets directory.
// Tauri sidecar sets STATIC_DIR = resource_dir/binaries/public.
// Standalone: falls back to public/ beside the binary, then ./public for dev.
function resolveStaticDir(): string {
  if (process.env.STATIC_DIR) return process.env.STATIC_DIR;
  const path = require('path') as typeof import('path');
  const fs = require('fs') as typeof import('fs');
  const besideBinary = path.join(path.dirname(process.execPath), 'public');
  if (fs.existsSync(besideBinary)) return besideBinary;
  return './public';
}

export const config = {
  port: parseInt(process.env.PORT ?? '3100'),
  host: process.env.HOST ?? '0.0.0.0',
  dbPath: process.env.DB_PATH ?? path.join(dataDir, 'canvas-ui.db'),
  dataDir,
  staticDir: resolveStaticDir(),
  imagesDir: process.env.IMAGES_DIR ?? path.join(dataDir, 'images'),
  jwtSecret: process.env.JWT_SECRET ?? 'canvas-ui-change-this-in-production',
  adminUser: process.env.ADMIN_USER ?? 'admin',
  adminPassword: process.env.ADMIN_PASSWORD ?? 'canvas-ui',
  corsOrigins: process.env.CORS_ORIGINS ?? '*',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  // Home Assistant Supervisor — set automatically when running as HA add-on
  haSupervisorToken: process.env.HA_SUPERVISOR_TOKEN ?? null,
  haSupervisorUrl: process.env.HA_SUPERVISOR_URL ?? 'http://supervisor/core',
  homeAssistantUrl: process.env.HOME_ASSISTANT_URL ?? process.env.HA_URL ?? 'http://homeassistant.local:8123',
  homeAssistantToken: process.env.HOME_ASSISTANT_TOKEN ?? process.env.HA_TOKEN ?? '',
  homeAssistantRefreshToken: process.env.HOME_ASSISTANT_REFRESH_TOKEN ?? '',
  homeAssistantClientId: process.env.HOME_ASSISTANT_CLIENT_ID ?? '',
  canvasMediaPlayerEntityId: process.env.CANVAS_MEDIA_PLAYER_ENTITY_ID ?? '',
  youtubeApiKey: process.env.YOUTUBE_API_KEY ?? '',
  youtubeRegionCode: process.env.YOUTUBE_REGION_CODE ?? 'AU',
  youtubeRelevanceLanguage: process.env.YOUTUBE_RELEVANCE_LANGUAGE ?? 'en',
  youtubeSafeSearch: process.env.YOUTUBE_SAFE_SEARCH ?? 'strict',
  youtubePlayerOrigin: process.env.YOUTUBE_PLAYER_ORIGIN ?? 'http://127.0.0.1:3100/',
  youtubeAllowRemoteSearch: (process.env.YOUTUBE_ALLOW_REMOTE_SEARCH ?? 'false').toLowerCase() === 'true',
  // SDR radio (DAB+/FM) — used by the DAB+ widget and voice playback.
  sdrRadioUrl: process.env.SDR_RADIO_URL ?? 'http://192.168.1.108:8088',
  sdrRadioTuner: process.env.SDR_RADIO_TUNER ?? 'tuner1',
  sdrRadioStreamUrl: process.env.SDR_RADIO_STREAM_URL ?? 'http://192.168.1.108:8001/tuner1.mp3',
  // Dispatcharr (IPTV) — used by the Dispatcharr widget and voice playback.
  dispatcharrUrl: process.env.DISPATCHARR_URL ?? 'http://theserver.localdomain:9191',
  // DLNA MediaRenderer — exposes the display as a UPnP/DLNA renderer so Home
  // Assistant (dlna_dmr) and Music Assistant can push audio and video to it.
  dlnaEnabled: (process.env.CANVAS_DLNA_ENABLED ?? 'true').toLowerCase() !== 'false',
  dlnaPort: parseInt(process.env.CANVAS_DLNA_PORT ?? '49500'),
  dlnaUuid: process.env.CANVAS_DLNA_UUID ?? '',
  dlnaFriendlyName: process.env.CANVAS_DLNA_FRIENDLY_NAME ?? '',
  dlnaHost: process.env.CANVAS_DLNA_HOST ?? '',
  // Snapcast client — multi-room synchronised audio. Managed as a systemd user
  // unit so the audio arbiter can hand the sink between Snapcast and mpv.
  snapclientEnabled: (process.env.CANVAS_SNAPCLIENT_ENABLED ?? 'true').toLowerCase() !== 'false',
  snapclientService: process.env.CANVAS_SNAPCLIENT_SERVICE ?? 'canvas-snapclient.service',
  get isHaAddon(): boolean { return !!this.haSupervisorToken; },
};
