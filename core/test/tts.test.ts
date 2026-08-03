import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PiperSpeech } from '../src/providers/tts.js';
import { fakeSocketFactory } from './helpers.js';
import type { Socket } from 'node:net';

const SAMPLE_WAV = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);

/** A trivial fake net.Socket that emits a chosen event on the next tick. */
class EmitSocket extends EventEmitter {
  setTimeout(): void {}
  write(): void {}
  end(): void {
    this.emit('close');
  }
  destroy(): void {
    this.emit('close');
  }
}

test('PiperSpeech.synthesize returns concatenated audio bytes over Wyoming TCP', async () => {
  const tts = new PiperSpeech({
    host: 'fake',
    port: 1,
    socketFactory: fakeSocketFactory(SAMPLE_WAV),
  });
  const out = await tts.synthesize('hello');
  assert.ok(Buffer.isBuffer(out));
  assert.deepEqual(out, SAMPLE_WAV);
});

test('PiperSpeech.healthCheck reports healthy on connect', async () => {
  const factory = (() => {
    const s = new EmitSocket();
    queueMicrotask(() => s.emit('connect'));
    return s as unknown as Socket;
  }) as (p: number, h: string) => Socket;
  const tts = new PiperSpeech({ host: 'fake', port: 1, socketFactory: factory });
  const h = await tts.healthCheck();
  assert.equal(h.healthy, true);
});

test('PiperSpeech.healthCheck reports unhealthy on socket error', async () => {
  const factory = (() => {
    const s = new EmitSocket();
    queueMicrotask(() => s.emit('error', new Error('ECONNREFUSED')));
    return s as unknown as Socket;
  }) as (p: number, h: string) => Socket;
  const tts = new PiperSpeech({ host: 'fake', port: 1, socketFactory: factory });
  const h = await tts.healthCheck();
  assert.equal(h.healthy, false);
  assert.match(h.detail ?? '', /ECONNREFUSED/);
});
