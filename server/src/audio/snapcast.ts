/**
 * Snapcast client lifecycle.
 *
 * The display can act as a Snapcast player for multi-room synchronised audio.
 * On the Pi the client runs as a systemd *user* unit (`canvas-snapclient.service`)
 * because it needs the user's PulseAudio session. This module starts/stops that
 * unit so the audio arbiter can hand the sink between Snapcast and local mpv.
 *
 * Everything is best-effort: if systemd or the unit is unavailable the calls
 * resolve without throwing so playback is never blocked by a missing service.
 */

import { execFile } from 'child_process';
import { config } from '../config';

export interface SnapcastStatus {
  enabled: boolean;
  service: string;
  running: boolean;
  lastError?: string;
}

let lastError: string | undefined;

function runSystemctl(action: 'start' | 'stop' | 'is-active'): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      'systemctl',
      ['--user', action, config.snapclientService],
      { timeout: 10_000 },
      (error, stdout) => {
        // `is-active` exits non-zero for inactive units — that is not an error.
        const ok = action === 'is-active' ? stdout.trim() === 'active' : !error;
        resolve({ ok, stdout: stdout.trim() });
      },
    );
  });
}

export function isSnapcastEnabled(): boolean {
  return config.snapclientEnabled;
}

export async function isSnapclientRunning(): Promise<boolean> {
  if (!config.snapclientEnabled) return false;
  const { ok } = await runSystemctl('is-active');
  return ok;
}

export async function startSnapclient(): Promise<SnapcastStatus> {
  if (!config.snapclientEnabled) {
    return { enabled: false, service: config.snapclientService, running: false };
  }
  const { ok } = await runSystemctl('start');
  if (!ok) {
    lastError = `failed to start ${config.snapclientService}`;
    console.warn(`[audio][snapcast] ${lastError}`);
  } else {
    lastError = undefined;
  }
  return { enabled: true, service: config.snapclientService, running: ok, lastError };
}

export async function stopSnapclient(): Promise<SnapcastStatus> {
  if (!config.snapclientEnabled) {
    return { enabled: false, service: config.snapclientService, running: false };
  }
  const { ok } = await runSystemctl('stop');
  if (!ok) {
    lastError = `failed to stop ${config.snapclientService}`;
    console.warn(`[audio][snapcast] ${lastError}`);
  } else {
    lastError = undefined;
  }
  return { enabled: true, service: config.snapclientService, running: false, lastError };
}

export async function getSnapcastStatus(): Promise<SnapcastStatus> {
  if (!config.snapclientEnabled) {
    return { enabled: false, service: config.snapclientService, running: false };
  }
  const running = await isSnapclientRunning();
  return { enabled: true, service: config.snapclientService, running, lastError };
}