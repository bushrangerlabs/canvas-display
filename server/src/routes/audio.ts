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
import { acquireSink, releaseSink, getSinkOwner, registerSinkReleaser } from '../audio/arbiter';
import { getSnapcastStatus, startSnapclient, stopSnapclient } from '../audio/snapcast';

// ─── In-memory audio state ────────────────────────────────────────────────────

export type AudioPlayState = 'idle' | 'playing' | 'paused';

export interface AudioState {
  state:    AudioPlayState;
  title:    string;
  url:      string;
  volume:   number; // 0–100
  muted:    boolean;
  artwork?: string;
  /** Logical source of the current playback (e.g. 'dab', 'dispatcharr'). */
  source?:  string;
}

let _state: AudioState = {
  state:  'idle',
  title:  '',
  url:    '',
  volume: 75,
  muted:  false,
};

let _mpv: ChildProcess | null = null;
let _mpvUrl = '';
let _mpvVolume = 75;
let _intentionalStop = false;
let _retryCount = 0;
let _mpvGen = 0;
let _playbackWaiter: {
  gen: number;
  started: boolean;
  onStarted?: () => Promise<void> | void;
  resolve: () => void;
  reject: (error: Error) => void;
} | null = null;
const MAX_AUDIO_RETRIES = 5;
const AUDIO_RETRY_DELAY_MS = 1500;

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

function killMpv(opts?: { intentional?: boolean }) {
  if (opts?.intentional) {
    _intentionalStop = true;
    // Cancel any pending retry timer from a prior spawn.
    _mpvGen += 1;
  }
  if (_mpv) {
    try { _mpv.kill('SIGTERM'); } catch { /* already dead */ }
    _mpv = null;
  }
  if (opts?.intentional && _playbackWaiter) {
    _playbackWaiter.reject(new Error('playback interrupted'));
    _playbackWaiter = null;
  }
  // Remove stale socket
  try { require('fs').unlinkSync(MPV_SOCK); } catch { /* doesn't exist */ }
}

function spawnMpv(url: string, volume: number): number {
  const nextGen = _mpvGen + 1;
  if (_playbackWaiter && _playbackWaiter.gen !== nextGen) {
    _playbackWaiter.reject(new Error('playback superseded'));
    _playbackWaiter = null;
  }
  _mpvGen = nextGen;
  _mpvUrl = url;
  _mpvVolume = volume;
  _intentionalStop = false;
  _retryCount = 0;
  killMpv();
  startMpv(_mpvGen);
  return _mpvGen;
}

function startMpv(gen: number) {
  const args = [
    '--no-video',
    '--really-quiet',
    `--input-ipc-server=${MPV_SOCK}`,
    `--volume=${_mpvVolume}`,
    _mpvUrl,
  ];

  const mpv = spawn('mpv', args, { detached: false, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderrBuf = '';
  if (mpv.stderr) {
    mpv.stderr.setEncoding('utf8');
    mpv.stderr.on('data', (chunk: string) => {
      stderrBuf += chunk;
      if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
    });
  }

  _mpv = mpv;

  mpv.on('spawn', () => {
    if (_playbackWaiter?.gen !== gen || _playbackWaiter.started) return;
    _playbackWaiter.started = true;
    void Promise.resolve(_playbackWaiter.onStarted?.()).catch(error => {
      console.warn('[audio] playback start acknowledgement failed:', error instanceof Error ? error.message : error);
    });
  });

  mpv.on('error', (err: Error) => {
    console.error('[audio] mpv spawn error:', err.message);
    if (_playbackWaiter?.gen === gen) {
      _playbackWaiter.reject(err);
      _playbackWaiter = null;
    }
  });

  mpv.on('exit', (code) => {
    // A newer spawn superseded this process; ignore its exit.
    if (gen !== _mpvGen) return;

    _mpv = null;
    const tail = stderrBuf.trim().split('\n').slice(-8).join(' │ ');
    console.log(`[audio] mpv exited (code=${code})${tail ? ' :: ' + tail : ''}`);

    if (_intentionalStop) return;

    // Exit 0 is normal completion for finite clips. The previous implementation
    // treated it as a crash and replayed announcements up to five times.
    if (code === 0) {
      _state.state = 'idle';
      _state.url = '';
      _state.title = '';
      _state.source = undefined;
      if (_playbackWaiter?.gen === gen) {
        _playbackWaiter.resolve();
        _playbackWaiter = null;
      }
      void releaseSink('mpv');
      import('../mqtt/index').then(m => m.publishAudioState()).catch(() => {});
      return;
    }

    // Unexpected exit (crash, network drop, stream reset): retry a few
    // times before giving up, so a transient hiccup doesn't kill playback.
    if (_retryCount < MAX_AUDIO_RETRIES) {
      _retryCount += 1;
      console.log(`[audio] mpv exited unexpectedly; retry ${_retryCount}/${MAX_AUDIO_RETRIES} in ${AUDIO_RETRY_DELAY_MS}ms`);
      setTimeout(() => {
        if (gen === _mpvGen) startMpv(gen);
      }, AUDIO_RETRY_DELAY_MS);
      return;
    }

    console.log('[audio] mpv retries exhausted; marking idle');
    _state.state = 'idle';
    _state.url   = '';
    _state.title = '';
    _state.source = undefined;
    // Notify MQTT of state change (dynamic import avoids circular dep)
    import('../mqtt/index').then(m => m.publishAudioState()).catch(() => {});
    if (_playbackWaiter?.gen === gen) {
      _playbackWaiter.reject(new Error(`mpv exited with code ${code}; retries exhausted`));
      _playbackWaiter = null;
    }
    void releaseSink('mpv');
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

export async function playAudio(input: { url: string; title?: string; volume?: number; source?: string }): Promise<AudioState> {
  // Local mpv playback takes the audio sink; this stops the Snapcast client if
  // it currently owns the output so the two never play over each other.
  await acquireSink('mpv');
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
    source: input.source,
  };
  return getAudioState();
}

/** Play a finite clip and resolve only after mpv exits successfully. */
export async function playAudioToCompletion(
  input: { url: string; title?: string; volume?: number },
  onStarted?: () => Promise<void> | void,
): Promise<void> {
  await acquireSink('mpv');
  const volume = Math.max(0, Math.min(100, input.volume ?? _state.volume));
  setSystemVolume(volume);
  const promise = new Promise<void>((resolve, reject) => {
    // The generation is assigned synchronously by spawnMpv immediately below.
    _playbackWaiter = { gen: _mpvGen + 1, started: false, onStarted, resolve, reject };
  });
  const gen = spawnMpv(input.url, volume);
  if (_playbackWaiter) _playbackWaiter.gen = gen;
  _state = { ..._state, state: 'playing', url: input.url, title: input.title ?? input.url, volume, muted: false };
  await promise;
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
  killMpv({ intentional: true });
  _state.state = 'idle';
  _state.url = '';
  _state.title = '';
  _state.source = undefined;
  await releaseSink('mpv');
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

/** Seek the current mpv stream to an absolute position (seconds). */
export async function seekAudio(seconds: number): Promise<AudioState> {
  const target = Math.max(0, Number(seconds));
  if (!Number.isFinite(target)) throw new Error('Invalid seek target');
  await mpvIpc({ command: ['seek', target, 'absolute'] });
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
    _state.source = undefined;

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
    killMpv({ intentional: true });
    _state.state = 'idle';
    _state.url   = '';
    _state.title = '';
    _state.source = undefined;
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

  // POST /api/media/cast  { url, title?, volume? }
  // Alias for /audio/play — used by HA services and Music Assistant integrations.
  app.post<{ Body: { url?: string; media_content_id?: string; title?: string; media_title?: string; volume?: number } }>(
    '/media/cast',
    async (req, reply) => {
      const url = req.body?.url ?? req.body?.media_content_id ?? '';
      const title = req.body?.title ?? req.body?.media_title ?? url;
      if (!url) return reply.code(400).send({ error: 'url or media_content_id is required' });
      const state = await playAudio({ url, title, volume: req.body?.volume });
      import('../mqtt/index').then(m => m.publishAudioState()).catch(() => {});
      return state;
    },
  );

  // ─── Snapcast (multi-room sync) ─────────────────────────────────────────────

  // GET /api/audio/snapcast → { enabled, service, running, owner }
  app.get('/audio/snapcast', async () => ({ ...(await getSnapcastStatus()), owner: getSinkOwner() }));

  // POST /api/audio/snapcast  { action: 'start' | 'stop' }
  app.post<{ Body: { action?: 'start' | 'stop' } }>('/audio/snapcast', async (req, reply) => {
    const action = req.body?.action;
    if (action !== 'start' && action !== 'stop') {
      return reply.code(400).send({ error: "action must be 'start' or 'stop'" });
    }
    if (action === 'start') {
      // Snapcast takes the sink; this stops local mpv playback first.
      await acquireSink('snapcast');
      return startSnapclient();
    }
    const status = await stopSnapclient();
    await releaseSink('snapcast');
    return status;
  });
}
