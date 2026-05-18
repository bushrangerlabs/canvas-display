/**
 * Local wake word detection using Python openWakeWord.
 *
 * Spawns a Python3 subprocess that reads raw S16LE 16kHz mono PCM from stdin
 * and prints "detected:<model>" to stdout when the wake word fires.
 *
 * Requires:  pip3 install openwakeword
 *
 * Usage:
 *   const wwd = new WakeWordDetector('okay_nabu');
 *   wwd.on('detected', () => { ... start HA pipeline at stt stage ... });
 *   wwd.on('error',    (err) => console.error(err));
 *   wwd.start();
 *   // feed PCM chunks from MicCapture:
 *   mic.on('data', (chunk) => wwd.feed(chunk));
 *   // to stop:
 *   wwd.stop();
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Python script written to /tmp at startup.
// Reads 80ms PCM chunks from stdin, runs OWW inference, prints "detected:<model>"
const PYTHON_SCRIPT = `
import sys
import numpy as np

def main():
    if len(sys.argv) < 2:
        print("error: no wake word specified", file=sys.stderr, flush=True)
        sys.exit(1)

    model_name  = sys.argv[1]
    threshold   = float(sys.argv[2]) if len(sys.argv) > 2 else 0.5
    chunk_size  = 1280   # 80ms at 16kHz — OWW recommended window

    try:
        import openwakeword
        from openwakeword.model import Model
    except ImportError:
        print("error: openwakeword not installed — run: pip3 install openwakeword", file=sys.stderr, flush=True)
        sys.exit(2)

    # Download the model weights on first run (cached in ~/.cache/openwakeword)
    try:
        openwakeword.utils.download_models([model_name])
    except Exception as e:
        print(f"warning: model download failed ({e}); trying cached copy", file=sys.stderr, flush=True)

    try:
        oww = Model(wakeword_models=[model_name], inference_framework='tflite')
    except Exception as e:
        print(f"error: failed to load model '{model_name}': {e}", file=sys.stderr, flush=True)
        sys.exit(3)

    print("ready", flush=True)

    chunk_bytes = chunk_size * 2   # int16 = 2 bytes per sample
    buf = b""

    while True:
        data = sys.stdin.buffer.read(chunk_bytes - len(buf))
        if not data:
            break
        buf += data
        if len(buf) < chunk_bytes:
            continue
        audio = np.frombuffer(buf, dtype=np.int16)
        buf = b""
        prediction = oww.predict(audio)
        for ww, score in prediction.items():
            if score >= threshold:
                print(f"detected:{ww}", flush=True)
                oww.reset()
                break

if __name__ == "__main__":
    main()
`;

export class WakeWordDetector extends EventEmitter {
  private wakeWord: string;
  private scriptPath: string;
  private proc: ChildProcess | null = null;
  private _ready = false;

  constructor(wakeWord: string) {
    super();
    this.wakeWord = wakeWord;
    this.scriptPath = join(tmpdir(), 'canvas-display-wakeword.py');
    try {
      writeFileSync(this.scriptPath, PYTHON_SCRIPT.trimStart(), { mode: 0o644 });
    } catch (e) {
      console.error('[wakeword] Failed to write Python script:', (e as Error).message);
    }
  }

  get isReady(): boolean { return this._ready; }

  /** Spawn the Python OWW process and begin listening for the wake word. */
  start(): void {
    if (this.proc) return;

    const modelName = this.wakeWord.replace(/ /g, '_');
    this.proc = spawn('python3', [this.scriptPath, modelName], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        const msg = line.trim();
        if (msg === 'ready') {
          this._ready = true;
          this.emit('ready');
        } else if (msg.startsWith('detected:')) {
          this.emit('detected');
        }
      }
    });

    this.proc.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (!msg) return;
      if (msg.startsWith('error:')) {
        console.error('[wakeword]', msg);
        this.emit('error', new Error(msg));
      } else {
        // Log everything so startup failures are visible in the server logs
        console.log('[wakeword]', msg);
      }
    });

    this.proc.on('close', (code) => {
      const wasReady = this._ready;
      this._ready = false;
      this.proc = null;
      if (!wasReady && code !== 0) {
        // Died on startup — likely openwakeword not installed
        this.emit('error', new Error(
          code === 2
            ? 'openwakeword not installed — run: pip3 install openwakeword'
            : 'Wake word process failed to start (exit code ' + code + ')'
        ));
      } else {
        this.emit('close', code);
      }
    });

    this.proc.on('error', (err) => {
      this._ready = false;
      this.proc = null;
      console.error('[wakeword] Failed to spawn python3:', err.message);
      this.emit('error', err);
    });
  }

  /** Feed a PCM chunk (S16LE 16kHz mono) to the wake word detector. */
  feed(chunk: Buffer): void {
    if (this._ready && this.proc?.stdin?.writable) {
      this.proc.stdin.write(chunk);
    }
  }

  /** Gracefully shut down the detector. */
  stop(): void {
    this._ready = false;
    if (this.proc) {
      try { this.proc.stdin?.end(); } catch { /* ignore */ }
      try { this.proc.kill('SIGTERM'); } catch { /* ignore */ }
      this.proc = null;
    }
  }
}
