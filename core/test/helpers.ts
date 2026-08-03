/**
 * Test helpers — injectable I/O so provider unit tests need no network.
 * These build fake `fetch` implementations and fake Wyoming TCP sockets.
 */
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import type { FetchImpl } from '../src/providers/llm.js';

/** A fake fetch that returns a queued Response for each call. */
export function mockFetch(handler: (url: string, init?: RequestInit) => Response): FetchImpl {
  return ((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(url.toString(), init))) as FetchImpl;
}

/** Build a Response with JSON body. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A minimal fake Wyoming socket (extends EventEmitter, mimics net.Socket enough
 * for PiperSpeech). It parses the `synthesize` request written to it and emits a
 * canned audio-chunk / audio-stop sequence built from `audioBytes`.
 */
export class FakeWyomingSocket extends EventEmitter {
  private audioBytes: Buffer;
  private destroyed = false;

  constructor(audioBytes: Buffer) {
    super();
    this.audioBytes = audioBytes;
    // Mimic net.connect: emit 'connect' so the client writes its request.
    queueMicrotask(() => this.emit('connect'));
  }

  setTimeout(): void {
    /* no-op for tests */
  }

  write(data: Buffer): void {
    const text = data.toString('utf8');
    // When Core sends the synthesize request, reply with audio events.
    if (text.includes('"type": "synthesize"') || text.includes('"type":"synthesize"')) {
      queueMicrotask(() => this.emitSynthesis());
    }
  }

  private emitSynthesis(): void {
    // audio-start: header + inline JSON data concatenated (Wyoming framing).
    const startData = Buffer.from(JSON.stringify({ rate: 22050, width: 2, channels: 1, timestamp: null }));
    const startHeader = Buffer.from(JSON.stringify({ type: 'audio-start', version: '1.9.0', data_length: startData.length }) + '\n');
    this.emit('data', Buffer.concat([startHeader, startData]));
    // audio-chunk with the full canned payload (header + binary payload concatenated).
    const chunkHeader = Buffer.from(JSON.stringify({ type: 'audio-chunk', version: '1.9.0', data_length: 0, payload_length: this.audioBytes.length }) + '\n');
    this.emit('data', Buffer.concat([chunkHeader, this.audioBytes]));
    // audio-stop
    this.emit('data', Buffer.from(JSON.stringify({ type: 'audio-stop', version: '1.9.0' }) + '\n'));
  }

  end(): void {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit('close');
    }
  }

  destroy(): void {
    this.end();
  }

  // net.Socket shape used by PiperSpeech.socketFactory signature.
  on(event: string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
}

/** Socket factory that returns a FakeWyomingSocket (ignores host/port). */
export function fakeSocketFactory(audioBytes: Buffer): (port: number, host: string) => Socket {
  return (() => new FakeWyomingSocket(audioBytes) as unknown as Socket) as (port: number, host: string) => Socket;
}
