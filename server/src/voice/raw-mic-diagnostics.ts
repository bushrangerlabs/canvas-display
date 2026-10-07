import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WriteStream } from 'node:fs';

const SAMPLE_RATE = 16_000;
const CHANNELS = 8;
const FRAME_BYTES = 5_120;
const WAV_HEADER_BYTES = 44;
const CHANNEL_LABELS = [
  'D0 L (mic0)', 'D0 R (mic1)', 'D1 L (mic2)', 'D1 R (mic3)',
  'D2 L (mic4)', 'D2 R (mic5)', 'D3 L (unused)', 'D3 R (centre mic)',
];

function wavHeader(dataBytes: number): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * CHANNELS * 2, 28);
  header.writeUInt16LE(CHANNELS * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/** Opt-in, bounded raw 8-channel WAV tap. Does not open another Pico socket. */
export class RawMicDiagnostics {
  readonly wavPath: string;
  readonly metadataPath: string;
  private readonly stream: WriteStream;
  private readonly startedAt = new Date();
  private readonly maxFrames: number;
  private frames = 0;
  private dataBytes = 0;
  private finished = false;
  private finishing: Promise<void> | null = null;
  private failure?: string;

  constructor(directory = '/tmp', durationSeconds = 180) {
    const seconds = Math.max(1, Math.min(300, Math.floor(durationSeconds)));
    const stem = `canvas-audio-raw-${this.startedAt.toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    this.wavPath = path.join(directory, `${stem}.wav`);
    this.metadataPath = path.join(directory, `${stem}.json`);
    this.maxFrames = seconds * SAMPLE_RATE / 320;
    this.stream = createWriteStream(this.wavPath, { flags: 'wx' });
    this.stream.on('error', error => { this.failure = error.message; void this.finish(); });
    this.stream.write(wavHeader(0));
    console.log(`[audio-diagnostics] raw 8-channel capture enabled path=${this.wavPath} max_seconds=${seconds}`);
  }

  write(frame: Buffer): void {
    if (this.finished) return;
    if (frame.length !== FRAME_BYTES) {
      this.failure = `invalid_frame_length:${frame.length}`;
      void this.finish();
      return;
    }
    this.stream.write(frame);
    this.frames++;
    this.dataBytes += frame.length;
    if (this.frames >= this.maxFrames) void this.finish();
  }

  finish(): Promise<void> {
    if (this.finishing) return this.finishing;
    if (this.finished) return Promise.resolve();
    this.finished = true;
    this.finishing = this.finalize();
    return this.finishing;
  }

  private async finalize(): Promise<void> {
    await new Promise<void>(resolve => this.stream.end(resolve));
    try {
      const handle = await fs.open(this.wavPath, 'r+');
      try { await handle.write(wavHeader(this.dataBytes), 0, WAV_HEADER_BYTES, 0); }
      finally { await handle.close(); }
      const metadata = {
        format: 'pcm16-s16le', sampleRateHz: SAMPLE_RATE, channels: CHANNELS,
        samplesPerChannel: this.frames * 320, frameDurationMs: 20,
        startedAt: this.startedAt.toISOString(), endedAt: new Date().toISOString(),
        frameCount: this.frames, durationSeconds: this.frames * 0.02,
        labels: CHANNEL_LABELS, error: this.failure,
      };
      await fs.writeFile(this.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx' });
      console.log(`[audio-diagnostics] capture complete frames=${this.frames} duration_seconds=${(this.frames * 0.02).toFixed(2)} metadata=${this.metadataPath}`);
    } catch (error) {
      console.warn('[audio-diagnostics] could not finalize capture:', error instanceof Error ? error.message : String(error));
    }
  }
}
