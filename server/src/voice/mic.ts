/**
 * USB/default microphone capture via arecord.
 *
 * Spawns: arecord -D <device> -f S16_LE -r 16000 -c 1 -t raw
 *
 * Emits:
 *   'data'  (chunk: Buffer) — raw PCM chunks as they arrive (~every 100ms)
 *   'error' (err: Error)    — arecord stderr / spawn failure
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
 * Lists available ALSA capture devices via `arecord -l`.
 * Always includes "default" as the first entry.
 */
export async function listMicrophones(): Promise<MicrophoneDevice[]> {
  const devices: MicrophoneDevice[] = [{ id: 'default', label: 'Default' }];
  try {
    const { stdout } = await execAsync('arecord -l');
    // Lines look like: card 1: USB [USB Audio Device], device 0: USB Audio [USB Audio]
    const re = /^card (\d+):\s+\S+\s+\[([^\]]+)\],\s+device (\d+):/gm;
    let match: RegExpExecArray | null;
    while ((match = re.exec(stdout)) !== null) {
      const cardNum = match[1];
      const cardName = match[2];
      const deviceNum = match[3];
      const id = `plughw:${cardNum},${deviceNum}`;
      devices.push({ id, label: `${cardName} (${id})` });
    }
  } catch {
    // arecord not available or no capture devices — return just "default"
  }
  return devices;
}

export class MicCapture extends EventEmitter {
  private device: string;
  private proc: ChildProcess | null = null;
  private running = false;

  /** @param device ALSA device name, e.g. 'default' or 'hw:1,0' */
  constructor(device = 'default') {
    super();
    // Use plughw: for hw: devices — enables ALSA's plug layer for automatic
    // channel/format/rate conversion (e.g. stereo-only mics → mono 16kHz)
    this.device = device.startsWith('hw:') ? device.replace('hw:', 'plughw:') : device;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;

    const args = [
      '-D', this.device,
      '-f', 'S16_LE',
      '-r', '16000',
      '-c', '1',
      '-t', 'raw',
    ];

    this.proc = spawn('arecord', args);
    this.running = true;

    this.proc.stdout?.on('data', (chunk: Buffer) => {
      this.emit('data', chunk);
    });

    this.proc.stderr?.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      // arecord prints informational lines to stderr — ignore them
      if (msg && !msg.startsWith('Recording WAVE') && !msg.startsWith('Recording raw data')) {
        this.emit('error', new Error(`arecord: ${msg}`));
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

  stop(): void {
    if (!this.proc) return;
    this.running = false;
    try {
      this.proc.kill('SIGTERM');
    } catch {
      // already dead
    }
    this.proc = null;
  }
}
