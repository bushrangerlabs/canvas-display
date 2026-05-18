/**
 * Microphone capture — uses parec (PulseAudio/PipeWire) or arecord (bare ALSA).
 *
 * When PipeWire/PulseAudio is running it holds ALSA devices exclusively, so
 * arecord -D plughw:X,Y fails with "Device or resource busy".  Using parec
 * goes through the PipeWire/PA layer and works correctly.
 *
 * Device selection:
 *   - PulseAudio source name (e.g. alsa_input.usb-046d_...analog-stereo) → parec
 *   - 'default' → parec (PA default source)
 *   - 'plughw:X,Y' or 'hw:X,Y' → arecord (bare ALSA, no PipeWire)
 *
 * Emits:
 *   'data'  (chunk: Buffer) — raw S16LE 16kHz mono PCM chunks
 *   'error' (err: Error)    — stderr lines or spawn failure
 *   'close' ()              — process exited
 */

import { EventEmitter } from 'events';
import { spawn, ChildProcess, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface MicrophoneDevice {
  id: string;
  label: string;
}

/**
 * Lists available capture devices.
 * Prefers PulseAudio/PipeWire source names (via pactl) — these work even when
 * PipeWire holds ALSA devices exclusively.  Falls back to arecord -l.
 */
export async function listMicrophones(): Promise<MicrophoneDevice[]> {
  const devices: MicrophoneDevice[] = [{ id: 'default', label: 'Default' }];

  // Try PipeWire/PulseAudio sources first
  try {
    const { stdout } = await execAsync('pactl list short sources');
    for (const line of stdout.trim().split('\n')) {
      const parts = line.split('\t');
      if (parts.length < 2) continue;
      const name = parts[1].trim();
      if (!name || name.endsWith('.monitor') || name === 'auto_null') continue;
      // Human-readable label: strip alsa_input. prefix and codec suffixes
      const label = name
        .replace(/^alsa_input\./, '')
        .replace(/\.analog-stereo$|\.analog-mono$|\.stereo-fallback$|\.mono-fallback$/, '')
        .replace(/_/g, ' ');
      devices.push({ id: name, label });
    }
    if (devices.length > 1) return devices;
  } catch {
    // pactl not available — fall through to arecord
  }

  // Fall back to bare ALSA (systems without PipeWire/PulseAudio)
  try {
    const { stdout } = await execAsync('arecord -l');
    const re = /^card (\d+):\s+\S+\s+\[([^\]]+)\],\s+device (\d+):/gm;
    let match: RegExpExecArray | null;
    while ((match = re.exec(stdout)) !== null) {
      const id = `plughw:${match[1]},${match[3]}`;
      devices.push({ id, label: `${match[2]} (${id})` });
    }
  } catch {
    // arecord not available either — return just "default"
  }

  return devices;
}

export class MicCapture extends EventEmitter {
  private device: string;
  private proc: ChildProcess | null = null;
  private running = false;

  /**
   * @param device  'default' or a PulseAudio source name (PA/PipeWire path),
   *                or 'plughw:X,Y'/'hw:X,Y' (bare ALSA — only when no PipeWire).
   */
  constructor(device = 'default') {
    super();
    // hw: → plughw: enables the ALSA plug layer for bare-ALSA users
    this.device = device.startsWith('hw:') ? device.replace('hw:', 'plughw:') : device;
  }

  /** Returns true if the device should use parec (PipeWire/PulseAudio path). */
  private get usePulse(): boolean {
    return !this.device.startsWith('plughw:') && !this.device.startsWith('hw:');
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;

    let cmd: string;
    let args: string[];

    if (this.usePulse) {
      // PipeWire/PulseAudio path — works even when PipeWire holds ALSA devices
      cmd = 'parec';
      args = [
        '--format=s16le',
        '--rate=16000',
        '--channels=1',
        '--latency-msec=32',  // ~512 samples — matches OWW sliding window needs
      ];
      if (this.device !== 'default') {
        args.push(`--device=${this.device}`);
      }
    } else {
      // Bare ALSA path — only works when PipeWire is NOT running
      cmd = 'arecord';
      args = [
        '-D', this.device,
        '-f', 'S16_LE',
        '-r', '16000',
        '-c', '1',
        '-t', 'raw',
        '--period-size=512',
        '--buffer-size=4096',
      ];
    }

    this.proc = spawn(cmd, args);
    this.running = true;

    this.proc.stdout?.on('data', (chunk: Buffer) => {
      this.emit('data', chunk);
    });

    this.proc.stderr?.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      // Ignore normal informational lines from arecord/parec
      if (msg &&
          !msg.startsWith('Recording WAVE') &&
          !msg.startsWith('Recording raw data') &&
          !msg.startsWith('connected to')) {
        this.emit('error', new Error(`${this.usePulse ? 'parec' : 'arecord'}: ${msg}`));
      }
    });

    this.proc.on('close', (code) => {
      this.running = false;
      this.proc = null;
      this.emit('close', code);
    });

    this.proc.on('error', (err) => {
      this.running = false;
      this.proc = null;
      this.emit('error', err);
    });
  }

  stop(): Promise<void> {
    if (!this.proc) return Promise.resolve();
    this.running = false;
    const proc = this.proc;
    this.proc = null;

    return new Promise<void>((resolve) => {
      // Safety net: force-kill after 500ms if SIGTERM doesn't work
      const killTimer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      }, 500);

      proc.once('close', () => {
        clearTimeout(killTimer);
        resolve();
      });

      // Also resolve immediately if process is already dead
      if (proc.exitCode !== null) {
        clearTimeout(killTimer);
        resolve();
        return;
      }

      try {
        proc.kill('SIGTERM');
      } catch {
        clearTimeout(killTimer);
        resolve();
      }
    });
  }
}
