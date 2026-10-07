import { EventEmitter } from 'events';
import net from 'net';
import { setTimeout as sleep } from 'timers/promises';
import { RemoteMicDsp, pcmStats } from './remote-mic-dsp';
import { RawMicDiagnostics } from './raw-mic-diagnostics';

export type EndpointVoiceState = 'ready' | 'listening' | 'processing' | 'error';

/** RBJ high-shelf EQ for speech clarity; trebleDb=0 bypasses exactly. */
export function applyPlaybackTreble(pcm: Buffer, rate: number, trebleDb = 6, cutoffHz = 1800): Buffer {
  if (pcm.length % 2 || !Number.isFinite(trebleDb) || !Number.isFinite(cutoffHz)) throw new Error('Invalid playback EQ input');
  const gain = Math.max(-6, Math.min(9, trebleDb));
  if (gain === 0) return Buffer.from(pcm);
  const f0 = Math.max(500, Math.min(rate * 0.4, cutoffHz));
  const A = Math.pow(10, gain / 40);
  const w0 = 2 * Math.PI * f0 / rate;
  const cos = Math.cos(w0), sin = Math.sin(w0);
  const alpha = sin / 2 * Math.sqrt(2);
  const beta = 2 * Math.sqrt(A) * alpha;
  const b0 = A * ((A + 1) + (A - 1) * cos + beta);
  const b1 = -2 * A * ((A - 1) + (A + 1) * cos);
  const b2 = A * ((A + 1) + (A - 1) * cos - beta);
  const a0 = (A + 1) - (A - 1) * cos + beta;
  const a1 = 2 * ((A - 1) - (A + 1) * cos);
  const a2 = (A + 1) - (A - 1) * cos - beta;
  const out = Buffer.allocUnsafe(pcm.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < pcm.length; i += 2) {
    const x0 = pcm.readInt16LE(i);
    const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(y0))), i);
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return out;
}
const VOICE_STATE_CODES: Record<EndpointVoiceState, number> = { ready: 0, listening: 1, processing: 2, error: 3 };

export interface RemoteEndpointOptions {
  host: string;
  port: number;
  token: string;
  deviceId: string;
  playbackRate?: number;
  playbackTrebleDb?: number;
}

export function frame(type: number, payload: Buffer): Buffer {
  if (payload.length + 1 > 8192) throw new Error('Endpoint frame exceeds 8192 bytes');
  const header = Buffer.alloc(3);
  header.writeUInt16LE(payload.length + 1);
  header[2] = type;
  return Buffer.concat([header, payload]);
}

/** Incremental parser shared by both authenticated connections. */
export class EndpointParser {
  private buffer = Buffer.alloc(0);
  push(chunk: Buffer): Array<{ type: number; payload: Buffer }> {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages = [];
    while (this.buffer.length >= 2) {
      const length = this.buffer.readUInt16LE();
      if (length < 1 || length > 8192) throw new Error('Invalid endpoint frame length');
      if (this.buffer.length < length + 2) break;
      messages.push({ type: this.buffer[2], payload: this.buffer.subarray(3, length + 2) });
      this.buffer = this.buffer.subarray(length + 2);
    }
    return messages;
  }
}

/** Pico source compatible with MicCapture, plus a single bounded PCM output queue. */
export class RemoteEndpoint extends EventEmitter {
  private sockets: Array<net.Socket | null> = [null, null];
  private ready = [false, false];
  private timers: Array<NodeJS.Timeout | null> = [null, null];
  private running = false;
  private dsp = new RemoteMicDsp();
  private voiceState: EndpointVoiceState = 'ready';
  private readonly rawDiagnostics: RawMicDiagnostics | null;
  private playbackAbort = new AbortController();
  private queue: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private lastLog = 0;
  private previousMicFrame: { sequence: number; timestampMs: number; receivedAt: number } | null = null;
  private diagnostics = {
    inputFrames: 0, outputFrames: 0, inputRms: 0, outputRms: 0,
    inputClipped: 0, outputClipped: 0, playbackRms: 0, playbackClipped: 0,
    dspMs: 0, lastDspMs: 0, maxDspMs: 0,
    sequence: null as number | null,
    endpointTimestampMs: null as number | null,
    receiveIntervalMs: null as number | null,
    endpointTimestampIntervalMs: null as number | null,
    sequenceDiscontinuities: 0, droppedFrames: 0, duplicateFrames: 0, backwardFrames: 0,
    endpointTimestampDiscontinuities: 0,
    rawFormat: { format: 'pcm16-s16le', interleaved: true, sampleRateHz: 16000, channelCount: 8, samplesPerChannel: 320, frameDurationMs: 20 },
    rawChannels: [
      'D0 L (mic0)', 'D0 R (mic1)', 'D1 L (mic2)', 'D1 R (mic3)',
      'D2 L (mic4)', 'D2 R (mic5)', 'D3 L (unused)', 'D3 R (centre mic)',
    ].map((label, index) => ({ index, label, rms: 0, clipped: 0, clippedTotal: 0 })),
  };

  constructor(private opts: RemoteEndpointOptions) {
    super();
    let rawDiagnostics: RawMicDiagnostics | null = null;
    if (process.env.CANVAS_AUDIO_DIAGNOSTICS === '1') {
      try {
        rawDiagnostics = new RawMicDiagnostics(
          process.env.CANVAS_AUDIO_DIAGNOSTIC_DIR || '/tmp',
          Number(process.env.CANVAS_AUDIO_DIAGNOSTIC_SECONDS ?? 180),
        );
      } catch (error) {
        console.warn('[audio-diagnostics] could not start raw capture:', error instanceof Error ? error.message : String(error));
      }
    }
    this.rawDiagnostics = rawDiagnostics;
    for (const value of [opts.token, opts.deviceId]) {
      if (!value || Buffer.byteLength(value) > 255) throw new Error('Invalid endpoint identity/token length');
    }
    if (!opts.host || !Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) throw new Error('Invalid endpoint address');
  }
  get isRunning(): boolean { return this.running; }
  setVoiceState(state: EndpointVoiceState): void {
    this.voiceState = state;
    const socket = this.sockets[0];
    if (this.running && this.ready[0] && socket && !socket.destroyed) {
      socket.write(frame(8, Buffer.from([VOICE_STATE_CODES[state]])));
    }
  }
  getDiagnostics() {
    return {
      host: this.opts.host, port: this.opts.port, ...this.diagnostics,
      dspMeanMs: this.diagnostics.inputFrames ? this.diagnostics.dspMs / this.diagnostics.inputFrames : 0,
      rawFormat: { ...this.diagnostics.rawFormat },
      rawChannels: this.diagnostics.rawChannels.map(channel => ({ ...channel })),
      micReady: this.ready[0], playbackReady: this.ready[1], queuedBytes: this.queuedBytes,
      voiceState: this.voiceState,
    };
  }
  private inspectMicFrame(payload: Buffer, receivedAt: number): void {
    const sequence = payload.readUInt32LE(0);
    const timestampMs = payload.readUInt32LE(4);
    const previous = this.previousMicFrame;
    this.diagnostics.receiveIntervalMs = previous ? receivedAt - previous.receivedAt : null;
    this.diagnostics.endpointTimestampIntervalMs = null;
    if (previous) {
      // Serial-number arithmetic accepts uint32 wrap. Backward/reset/ambiguous
      // jumps are discontinuities, not billions of inferred dropped frames.
      const delta = (sequence - previous.sequence) >>> 0;
      if (delta !== 1) {
        this.diagnostics.sequenceDiscontinuities++;
        if (delta === 0) this.diagnostics.duplicateFrames++;
        else if (delta < 0x80000000) this.diagnostics.droppedFrames += delta - 1;
        else this.diagnostics.backwardFrames++;
      }
      const timestampDelta = (timestampMs - previous.timestampMs) >>> 0;
      if (timestampDelta < 0x80000000) this.diagnostics.endpointTimestampIntervalMs = timestampDelta;
      else this.diagnostics.endpointTimestampDiscontinuities++;
    }
    // These are independent relative clocks, never an absolute network latency.
    this.diagnostics.sequence = sequence;
    this.diagnostics.endpointTimestampMs = timestampMs;
    this.previousMicFrame = { sequence, timestampMs, receivedAt };
    for (const channel of this.diagnostics.rawChannels) {
      let squares = 0;
      let clipped = 0;
      for (let sample = 0; sample < 320; sample++) {
        const value = payload.readInt16LE(8 + (sample * 8 + channel.index) * 2);
        squares += value * value;
        if (value === -32768 || value === 32767) clipped++;
      }
      channel.rms = Math.round(Math.sqrt(squares / 320));
      channel.clipped = clipped;
      channel.clippedTotal += clipped;
    }
  }
  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect(0);
    this.connect(1);
  }
  stop(): Promise<void> {
    this.running = false;
    this.cancelPlayback();
    for (const timer of this.timers) if (timer) clearTimeout(timer);
    this.timers = [null, null];
    const sockets = this.sockets;
    this.sockets = [null, null];
    this.ready = [false, false];
    for (const socket of sockets) socket?.destroy();
    return this.rawDiagnostics?.finish() ?? Promise.resolve();
  }
  cancelPlayback(): void {
    // v1 has no flush command: already delivered PCM may still sound on the Pico.
    this.playbackAbort.abort();
    this.playbackAbort = new AbortController();
  }
  private log(): void {
    if (Date.now() - this.lastLog < 10000) return;
    this.lastLog = Date.now();
    console.log('[audio-endpoint] diagnostics', this.getDiagnostics());
  }
  private connect(role: number): void {
    if (!this.running || this.sockets[role]) return;
    const socket = net.connect(this.opts.port, this.opts.host);
    this.sockets[role] = socket;
    const parser = new EndpointParser();
    let authenticated = false;
    const deadline = setTimeout(() => socket.destroy(new Error('Endpoint authentication timeout')), 5000);
    socket.setNoDelay(true);
    socket.setTimeout(10000, () => socket.destroy(new Error('Endpoint stream stalled')));
    socket.on('connect', () => {
      const token = Buffer.from(this.opts.token);
      const identity = Buffer.from(this.opts.deviceId);
      socket.write(frame(1, Buffer.concat([Buffer.from([role, token.length]), token, Buffer.from([identity.length]), identity])));
    });
    socket.on('data', chunk => {
      if (this.sockets[role] !== socket || !this.running) return;
      // Coalesced frames share the socket receive time; no synthetic 20 ms pacing.
      const receivedAt = performance.now();
      try {
        for (const message of parser.push(chunk)) {
          if (message.type === 2) {
            if (authenticated || message.payload.length !== 2 || message.payload[0] !== 1 || message.payload[1] !== 0) throw new Error('Endpoint authentication rejected or invalid ACK');
            authenticated = true;
            clearTimeout(deadline);
            this.ready[role] = true;
            if (role === 0) {
              this.dsp = new RemoteMicDsp();
              this.previousMicFrame = null;
              this.diagnostics.sequence = null;
              this.diagnostics.endpointTimestampMs = null;
              this.diagnostics.receiveIntervalMs = null;
              this.diagnostics.endpointTimestampIntervalMs = null;
              this.setVoiceState(this.voiceState);
            }
            else {
              socket.setTimeout(0);
              this.configure(socket, this.opts.playbackRate ?? 22050);
            }
            this.emit('status', role === 0 ? 'mic-ready' : 'playback-ready');
          } else if (!authenticated) throw new Error('Endpoint message before authentication');
          else if (message.type === 7) throw new Error('Endpoint reported protocol error');
          else if (message.type === 5) socket.write(frame(6, message.payload));
          else if (message.type === 4 && role === 0) {
            if (message.payload.length !== 5128) throw new Error('Invalid endpoint microphone PCM frame');
            this.inspectMicFrame(message.payload, receivedAt);
            const input = message.payload.subarray(8);
            this.rawDiagnostics?.write(input);
            const started = performance.now();
            const output = this.dsp.process(input);
            // Raw centre mic (ch7) for the ASR capture path, bypassing the
            // gate/AGC that can attenuate consonants and amplify room noise.
            const rawCentre = Buffer.alloc(640);
            for (let sample = 0; sample < 320; sample++) {
              rawCentre.writeInt16LE(input.readInt16LE((sample * 8 + 7) * 2), sample * 2);
            }
            this.emit('rawdata', rawCentre);
            this.diagnostics.lastDspMs = performance.now() - started;
            this.diagnostics.dspMs += this.diagnostics.lastDspMs;
            this.diagnostics.maxDspMs = Math.max(this.diagnostics.maxDspMs, this.diagnostics.lastDspMs);
            const before = pcmStats(input), after = pcmStats(output);
            this.diagnostics.inputFrames++;
            this.diagnostics.inputRms = before.rms;
            this.diagnostics.outputRms = after.rms;
            this.diagnostics.inputClipped += before.clipped;
            this.diagnostics.outputClipped += after.clipped;
            this.log();
            this.emit('data', output);
          }
        }
      } catch (error) { socket.destroy(error as Error); }
    });
    socket.on('error', error => { if (this.running && this.sockets[role] === socket) this.emit('error', error); });
    socket.on('close', () => {
      clearTimeout(deadline);
      if (this.sockets[role] !== socket) return;
      this.sockets[role] = null;
      this.ready[role] = false;
      if (role === 1) this.cancelPlayback();
      this.emit('status', role === 0 ? 'mic-disconnected' : 'playback-disconnected');
      if (this.running) this.timers[role] = setTimeout(() => { this.timers[role] = null; this.connect(role); }, 2000);
    });
  }
  private configure(socket: net.Socket, rate: number): void {
    const config = Buffer.alloc(6);
    config.writeUInt32LE(rate);
    config[4] = 1;
    socket.write(frame(3, config));
  }
  play(pcm: Buffer, rate = 22050, volume = 100): Promise<void> {
    if (!pcm.length || pcm.length % 2 || !Number.isInteger(rate) || rate < 8000 || rate > 48000 || !Number.isFinite(volume)) return Promise.reject(new Error('Invalid playback PCM16/rate/volume'));
    if (this.queuedBytes + pcm.length > 4 * 1024 * 1024) return Promise.reject(new Error('Remote playback queue full'));
    const owned = Buffer.from(pcm);
    this.queuedBytes += owned.length;
    const signal = this.playbackAbort.signal;
    const task = this.queue.then(async () => {
      signal.throwIfAborted();
      const socket = this.sockets[1];
      if (!this.running || !this.ready[1] || !socket) throw new Error('Remote playback not authenticated');
      this.configure(socket, rate);
      const envTrebleDb = process.env.CANVAS_VOICE_TREBLE_DB;
      const trebleDb = envTrebleDb === undefined ? (this.opts.playbackTrebleDb ?? 6) : Number(envTrebleDb);
      const equalized = applyPlaybackTreble(owned, rate, Number.isFinite(trebleDb) ? trebleDb : 6);
      equalized.copy(owned);
      const gain = Math.max(0, Math.min(100, volume)) / 100;
      for (let i = 0; i < owned.length; i += 2) owned.writeInt16LE(Math.trunc(owned.readInt16LE(i) * gain), i);
      let deadline = performance.now();
      const chunkBytes = Math.floor(rate * 0.02) * 2;
      for (let offset = 0; offset < owned.length; offset += chunkBytes) {
        await sleep(Math.max(0, deadline - performance.now()), undefined, { signal });
        // Do not burst missed deadlines into the Pico's non-backpressured DAC ring.
        deadline = Math.max(deadline, performance.now());
        if (socket !== this.sockets[1] || !this.ready[1]) throw new Error('Remote playback disconnected');
        const chunk = owned.subarray(offset, Math.min(owned.length, offset + chunkBytes));
        await new Promise<void>((resolve, reject) => {
          const abort = () => { cleanup(); reject(new Error('Playback cancelled')); };
          const timeout = setTimeout(() => { cleanup(); reject(new Error('Playback write timeout')); socket.destroy(); }, 5000);
          const cleanup = () => { clearTimeout(timeout); signal.removeEventListener('abort', abort); };
          signal.addEventListener('abort', abort, { once: true });
          socket.write(frame(4, chunk), error => { cleanup(); if (error) reject(error); else resolve(); });
        });
        deadline += chunk.length / (rate * 2) * 1000;
        const stats = pcmStats(chunk);
        this.diagnostics.playbackRms = stats.rms;
        this.diagnostics.playbackClipped += stats.clipped;
        this.diagnostics.outputFrames++;
        this.log();
      }
      // Estimated tail only; TCP acknowledgement is not DAC drain confirmation.
      await sleep(Math.max(0, deadline + 40 - performance.now()), undefined, { signal });
    });
    this.queue = task.catch(() => undefined);
    return task.finally(() => { this.queuedBytes -= owned.length; });
  }
}
