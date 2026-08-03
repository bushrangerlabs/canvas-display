/**
 * Audio routes — controls audio playback on the display device.
 *
 * Audio playback is handled by mpv (must be installed on the device).
 * System volume is controlled via pactl (PulseAudio/PipeWire-pulse).
 *
 *   GET  /api/audio/state          → { state, title, volume, muted }
 *   POST /api/audio/play           { url, title?, volume? }
 *   POST /api/audio/pause          {}
 *   POST /api/audio/resume         {}
 *   POST /api/audio/stop           {}
 *   POST /api/audio/volume         { level: 0–100 }
 *   POST /api/audio/mute           { muted: boolean }
 */

import type { FastifyInstance }     from 'fastify';
import { spawn, execSync, ChildProcess } from 'child_process';
import net                           from 'net';

// ─── In-memory audio state ────────────────────────────────────────────────────

export type AudioPlayState = 'idle' | 'playing' | 'paused';

export interface AudioState {
  state:    AudioPlayState;
  title:    string;
  url:      string;
  volume:   number; // 0–100
  muted:    boolean;
  artwork?: string;
}

let _state: AudioState = {
  state:  'idle',
  title:  '',
  url:    '',
  volume: 75,
  muted:  false,
};

let _mpv: ChildProcess | null = null;

/** Returns a copy of the current audio state. */
export function getAudioState(): AudioState {
  return { ..._state };
}

/** Direct state mutation (used by MQTT/WS handlers). */
export function setAudioStateField<K extends keyof AudioState>(key: K, value: AudioState[K]) {
  (_state as any)[key] = value;
}

// ─── mpv management ──────────────────────────────────────────────────────────

const MPV_SOCK = '/tmp/mpv-canvas.sock';

function killMpv() {
  if (_mpv) {
    try { _mpv.kill('SIGTERM'); } catch { /* already dead */ }
    _mpv = null;
  }
  // Remove stale socket
  try { require('fs').unlinkSync(MPV_SOCK); } catch { /* doesn't exist */ }
}

function spawnMpv(url: string, volume: number) {
  killMpv();

  const args = [
    '--no-video',
    '--really-quiet',
    `--input-ipc-server=${MPV_SOCK}`,
    `--volume=${volume}`,
    url,
  ];

  _mpv = spawn('mpv', args, { detached: false, stdio: 'ignore' });

  _mpv.on('exit', (code) => {
    console.log(`[audio] mpv exited (code=${code})`);
    _mpv = null;
    _state.state = 'idle';
    _state.url   = '';
    _state.title = '';
    // Notify MQTT of state change (dynamic import avoids circular dep)
    import('../mqtt/index').then(m => m.publishAudioState()).catch(() => {});
  });

  _mpv.on('error', (err) => {
    console.error('[audio] mpv error:', err.message);
    _mpv    = null;
    _state.state = 'idle';
  });
}

/** Send a JSON command to mpv via its IPC socket. */
function mpvIpc(cmd: object): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(MPV_SOCK, () => {
      sock.write(JSON.stringify(cmd) + '\n');
      sock.end();
      resolve();
    });
    sock.on('error', (err) => {
      reject(new Error(`mpv IPC unavailable: ${err.message}`));
    });
    sock.setTimeout(1000);
    sock.on('timeout', () => { sock.destroy(); reject(new Error('mpv IPC timeout')); });
  });
}

// ─── System volume via pactl ─────────────────────────────────────────────────

function getSystemVolume(): number {
  try {
    const out = execSync('pactl get-sink-volume @DEFAULT_SINK@', { timeout: 2000 }).toString();
    // "Volume: front-left: 49152 /  75% / -7.97 dB, ..."
    const match = out.match(/\/\s*(\d+)%/);
    if (match) return parseInt(match[1], 10);
  } catch { /* pactl not available */ }
  return _state.volume;
}

function setSystemVolume(level: number): void {
  const clamped = Math.max(0, Math.min(100, level));
  try {
    execSync(`pactl set-sink-volume @DEFAULT_SINK@ ${clamped}%`, { timeout: 2000 });
  } catch (err: any) {
    console.warn('[audio] pactl set-volume failed:', err.message);
  }
}

function setSystemMute(muted: boolean): void {
  try {
    execSync(`pactl set-sink-mute @DEFAULT_SINK@ ${muted ? '1' : '0'}`, { timeout: 2000 });
  } catch (err: any) {
    console.warn('[audio] pactl set-mute failed:', err.message);
  }
}

export async function playAudio(input: { url: string; title?: string; volume?: number }): Promise<AudioState> {
  const volume = Math.max(0, Math.min(100, input.volume ?? _state.volume));
  setSystemVolume(volume);
  spawnMpv(input.url, volume);
  _state = {
    ..._state,
    state: 'playing',
    url: input.url,
    title: input.title ?? input.url,
    volume,
    muted: false,
  };
  return getAudioState();
}

export async function pauseAudio(): Promise<AudioState> {
  if (_state.state !== 'playing') throw new Error('Not playing');
  await mpvIpc({ command: ['set_property', 'pause', true] });
  _state.state = 'paused';
  return getAudioState();
}

export async function resumeAudio(): Promise<AudioState> {
  if (_state.state !== 'paused') throw new Error('Not paused');
  await mpvIpc({ command: ['set_property', 'pause', false] });
  _state.state = 'playing';
  return getAudioState();
}

export async function stopAudio(): Promise<AudioState> {
  killMpv();
  _state.state = 'idle';
  _state.url = '';
  _state.title = '';
  return getAudioState();
}

export async function setAudioVolume(level: number): Promise<AudioState> {
  const clamped = Math.max(0, Math.min(100, Number(level)));
  setSystemVolume(clamped);
  _state.volume = clamped;
  _state.muted = false;
  await mpvIpc({ command: ['set_property', 'volume', clamped] }).catch(() => undefined);
  return getAudioState();
}

export async function setAudioMute(muted: boolean): Promise<AudioState> {
  setSystemMute(muted);
  _state.muted = muted;
  return getAudioState();
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function audioRoutes(app: FastifyInstance) {

  // GET /api/audio/state
  app.get('/audio/state', async () => {
    // Sync volume from system on each poll so HA always sees current value
    _state.volume = getSystemVolume();
    return getAudioState();
  });

  // POST /api/audio/play  { url, title?, volume? }
  app.post<{ Body: { url: string; title?: string; volume?: number } }>('/audio/play', async (req, reply) => {
    const { url, title, volume } = req.body ?? {};
    if (!url) return reply.code(400).send({ error: 'url is required' });

    const vol = volume !== undefined ? Math.max(0, Math.min(100, volume)) : _state.volume;

    setSystemVolume(vol);
    spawnMpv(url, vol);

    _state.state  = 'playing';
    _state.url    = url;
    _state.title  = title ?? url;
    _state.volume = vol;
    _state.muted  = false;

    import('../mqtt/index').then(m => m.publishAudioState()).catch(() => {});
    return getAudioState();
  });

  // POST /api/audio/pause
  app.post('/audio/pause', async (_req, reply) => {
    if (_state.state !== 'playing') return reply.code(409).send({ error: 'Not playing' });
    try {
      await mpvIpc({ command: ['set_property', 'pause', true] });
      _state.state = 'paused';
      import('../mqtt/index').then(m => m.publishAudioState()).catch(() => {});
      return getAudioState();
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // POST /api/audio/resume
  app.post('/audio/resume', async (_req, reply) => {
    if (_state.state !== 'paused') return reply.code(409).send({ error: 'Not paused' });
    try {
      await mpvIpc({ command: ['set_property', 'pause', false] });
      _state.state = 'playing';
      import('../mqtt/index').then(m => m.publishAudioState()).catch(() => {});
      return getAudioState();
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // POST /api/audio/stop
  app.post('/audio/stop', async () => {
    killMpv();
    _state.state = 'idle';
    _state.url   = '';
    _state.title = '';
    import('../mqtt/index').then(m => m.publishAudioState()).catch(() => {});
    return getAudioState();
  });

  // POST /api/audio/volume  { level: 0–100 }
  app.post<{ Body: { level: number } }>('/audio/volume', async (req, reply) => {
    const level = req.body?.level;
    if (level === undefined || level === null) return reply.code(400).send({ error: 'level is required' });
    const clamped = Math.max(0, Math.min(100, Number(level)));
    setSystemVolume(clamped);
    _state.volume = clamped;
    _state.muted  = false;
    // If mpv is running, update its volume too
    mpvIpc({ command: ['set_property', 'volume', clamped] }).catch(() => {});
    import('../mqtt/index').then(m => m.publishAudioState()).catch(() => {});
    return getAudioState();
  });

  // POST /api/audio/mute  { muted: boolean }
  app.post<{ Body: { muted: boolean } }>('/audio/mute', async (req, reply) => {
    const muted = req.body?.muted;
    if (muted === undefined) return reply.code(400).send({ error: 'muted is required' });
    setSystemMute(!!muted);
    _state.muted = !!muted;
    import('../mqtt/index').then(m => m.publishAudioState()).catch(() => {});
    return getAudioState();
  });
}
