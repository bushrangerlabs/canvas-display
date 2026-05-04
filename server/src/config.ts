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
  get isHaAddon(): boolean { return !!this.haSupervisorToken; },
};
