/**
 * TTS (text-to-speech) provider (plan doc §15.4, D-010).
 *
 * `PiperSpeech` talks to the `piper-tts` container on the main server. IMPORTANT
 * discovery: that container does NOT expose an HTTP REST API — it runs
 * `wyoming_piper` and speaks the **Wyoming binary protocol over TCP** (verified:
 * `python3 -m wyoming_piper --uri tcp://0.0.0.0:10200`). The framing is:
 *
 *   <json-header>\n[<inline-json-data if data_length>][<binary-payload if payload_length>]
 *
 * For `synthesize` the server replies with one or more `audio-chunk` events
 * (each: json header with `payload_length`, then raw 16-bit PCM WAV-ish bytes)
 * followed by `audio-stop`. We concatenate the binary payloads and return them as
 * a Buffer (raw audio). The caller can base64 it for transport.
 *
 * Because Wyoming is a raw TCP socket (not HTTP), it is NOT injectable via
 * `fetch`. Instead the socket factory is injectable (`socketFactory`) so tests
 * can supply a fake duplex stream. Production uses `net.connect`.
 *
 * PHASE SCOPE: single-shot synthesize scaffold (Phase2/early). Streaming audio
 * back to Edge (plan §14.2) and voice selection land later (Phase5).
 */
import { connect, type Socket } from 'node:net';
import type { HealthStatus } from './types.js';

export interface SpeechProvider {
  /** Synthesize text to audio bytes (raw PCM/WAV container from piper). */
  synthesize(text: string): Promise<Buffer>;
  healthCheck(): Promise<HealthStatus>;
}

/** A Wyoming event: a JSON header plus optional inline JSON data and binary payload. */
interface WyomingEvent {
  type: string;
  [key: string]: unknown;
}

/** Injectable socket factory (real = net.connect, tests = in-memory stream). */
export type SocketFactory = (port: number, host: string) => Socket;

export interface PiperSpeechOptions {
  /** Host of the wyoming_piper service. */
  host?: string;
  /** TCP port of the wyoming_piper service. */
  port?: number;
  /** Optional voice/voice-key passed in the synthesize data. */
  voice?: string;
  /** Optional speaker id. */
  speaker?: number;
  /** Optional length/noise scales. */
  lengthScale?: number;
  noiseScale?: number;
  noiseW?: number;
  /** Connect + read timeout in ms. */
  timeoutMs?: number;
  /** Injectable socket factory (tests). Defaults to net.connect. */
  socketFactory?: SocketFactory;
  name?: string;
}

const DEFAULT_PORT = 10200;

export class PiperSpeech implements SpeechProvider {
  private readonly host: string;
  private readonly port: number;
  private readonly voice?: string;
  private readonly speaker?: number;
  private readonly lengthScale?: number;
  private readonly noiseScale?: number;
  private readonly noiseW?: number;
  private readonly timeoutMs: number;
  private readonly socketFactory: SocketFactory;
  private readonly name: string;

  constructor(opts: PiperSpeechOptions = {}) {
    this.host = opts.host ?? 'host.docker.internal';
    this.port = opts.port ?? DEFAULT_PORT;
    this.voice = opts.voice;
    this.speaker = opts.speaker;
    this.lengthScale = opts.lengthScale;
    this.noiseScale = opts.noiseScale;
    this.noiseW = opts.noiseW;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.socketFactory = opts.socketFactory ?? ((p, h) => connect(p, h));
    this.name = opts.name ?? 'tts';
  }

  async synthesize(text: string): Promise<Buffer> {
    const socket = this.socketFactory(this.port, this.host);
    socket.setTimeout(this.timeoutMs);

    const chunks: Buffer[] = [];
    let audioReceived = false;
    let stopped = false;

    const result = await new Promise<Buffer>((resolve, reject) => {
      let buf = Buffer.alloc(0);
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(err);
      };
      const done = (data: Buffer) => {
        if (settled) return;
        settled = true;
        socket.end();
        resolve(data);
      };

      socket.on('timeout', () => fail(new Error('TTS socket timeout')));
      socket.on('error', (err) => fail(err));

      socket.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        // Parse as many complete Wyoming events as the buffer holds.
        while (!settled) {
          const nl = buf.indexOf(0x0a); // '\n' terminates the JSON header
          if (nl === -1) break;
          let header: WyomingEvent;
          try {
            header = JSON.parse(buf.subarray(0, nl).toString('utf8')) as WyomingEvent;
          } catch {
            return fail(new Error('TTS: malformed Wyoming header'));
          }
          const dataLength = Number(header['data_length'] ?? 0);
          const payloadLength = Number(header['payload_length'] ?? 0);
          const consumed = nl + 1 + dataLength + payloadLength;
          if (buf.length < consumed) break; // wait for more bytes
          const payload = buf.subarray(nl + 1 + dataLength, consumed);
          buf = buf.subarray(consumed);

          if (header.type === 'audio-chunk') {
            audioReceived = true;
            chunks.push(Buffer.from(payload));
          } else if (header.type === 'audio-stop') {
            stopped = true;
            done(Buffer.concat(chunks));
            return;
          }
          // Ignore audio-start / info / other events.
        }
      });

      // Kick off the synthesize request once the socket is open.
      socket.on('connect', () => {
        const data: Record<string, unknown> = { text };
        if (this.voice !== undefined) data.voice = this.voice;
        if (this.speaker !== undefined) data.speaker = this.speaker;
        if (this.lengthScale !== undefined) data.length_scale = this.lengthScale;
        if (this.noiseScale !== undefined) data.noise_scale = this.noiseScale;
        if (this.noiseW !== undefined) data.noise_w = this.noiseW;
        const event = { type: 'synthesize', data, payload_length: 0 };
        socket.write(Buffer.from(JSON.stringify(event) + '\n', 'utf8'));
      });
    });

    if (!audioReceived && !stopped) {
      // Some servers send audio-stop with zero chunks for empty text; treat as ok.
      return result;
    }
    return result;
  }

  async healthCheck(): Promise<HealthStatus> {
    const socket = this.socketFactory(this.port, this.host);
    socket.setTimeout(this.timeoutMs);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => {
          socket.end();
          resolve();
        });
        socket.once('error', reject);
        socket.once('timeout', () => reject(new Error('TTS health timeout')));
      });
      return {
        name: this.name,
        kind: 'PiperSpeech',
        healthy: true,
        detail: `tcp ${this.host}:${this.port} connectable`,
      };
    } catch (err) {
      return {
        name: this.name,
        kind: 'PiperSpeech',
        healthy: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
