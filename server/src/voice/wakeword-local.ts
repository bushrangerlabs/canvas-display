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
import { existsSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

/** Prefer the canvas-display venv if present, fall back to system python3. */
function findPython3(): string {
  const venvPy = join(homedir(), '.venv', 'oww', 'bin', 'python3');
  if (existsSync(venvPy)) return venvPy;
  return 'python3';
}

// Python script written to /tmp at startup.
// Reads 80ms PCM chunks from stdin, runs OWW inference, prints "detected:<model>"
const PYTHON_SCRIPT = `
import sys
import os
import glob
import numpy as np

def find_model_file(name):
    """Find a wake word model file by name, checking openwakeword's resources dir.
    Handles okay_nabu -> ok_nabu alias and versioned suffixes like _v0.1."""
    try:
        import openwakeword
        resources_dir = os.path.join(os.path.dirname(openwakeword.__file__), 'resources', 'models')
    except Exception:
        return None
    # Names to try (also handle okay_nabu -> ok_nabu alias)
    candidates = [name, name.replace('okay_', 'ok_')]
    for candidate in candidates:
        for ext in ['.tflite', '.onnx']:
            # Exact match
            p = os.path.join(resources_dir, candidate + ext)
            if os.path.exists(p):
                return p
            # Versioned match: name_v0.1.tflite
            for p in sorted(glob.glob(os.path.join(resources_dir, candidate + '_v*' + ext)), reverse=True):
                return p
    return None

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
        print("error: openwakeword not installed — run: ~/.venv/oww/bin/pip install openwakeword", file=sys.stderr, flush=True)
        sys.exit(2)

    model_path = find_model_file(model_name)
    if not model_path:
        # List available models for diagnostics
        try:
            resources_dir = os.path.join(os.path.dirname(openwakeword.__file__), 'resources', 'models')
            available = [os.path.splitext(f)[0] for f in os.listdir(resources_dir) if f.endswith(('.tflite', '.onnx'))]
        except Exception:
            available = []
        print(f"error: model '{model_name}' not found. Available: {available}", file=sys.stderr, flush=True)
        sys.exit(3)

    framework = 'tflite' if model_path.endswith('.tflite') else 'onnx'
    print(f"loading model: {os.path.basename(model_path)} ({framework})", file=sys.stderr, flush=True)

    try:
        oww = Model(wakeword_model_paths=[model_path], inference_framework=framework)
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
    const python = findPython3();
    console.log('[wakeword] Using Python:', python);
    this.proc = spawn(python, [this.scriptPath, modelName], {
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
        if (this.listenerCount('error') > 0) {
          this.emit('error', new Error(msg));
        }
      } else {
        // Log everything so startup failures are visible in the server logs
        console.log('[wakeword]', msg);
      }
    });

    this.proc.on('close', (code) => {
      const wasReady = this._ready;
      this._ready = false;
      this.proc = null;
      // code===null means killed by signal (our own stop() call) — not an error
      if (!wasReady && typeof code === 'number' && code !== 0) {
        // Died on startup with a real exit code — emit error only if someone is listening
        const err = new Error(
          code === 2
            ? 'openwakeword not installed — run: ~/.venv/oww/bin/pip install openwakeword'
            : 'Wake word process failed to start (exit code ' + code + ')'
        );
        if (this.listenerCount('error') > 0) {
          this.emit('error', err);
        } else {
          console.error('[wakeword]', err.message);
        }
      } else {
        this.emit('close', code);
      }
    });

    this.proc.on('error', (err) => {
      this._ready = false;
      this.proc = null;
      console.error('[wakeword] Failed to spawn Python (tried', findPython3() + '):', err.message);
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
