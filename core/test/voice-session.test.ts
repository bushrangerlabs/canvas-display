/**
 * Tests for the authenticated voice session WSS and Opus audio pipeline
 * (Phase 5, plan doc §14, checklists: "Implement separate authenticated voice
 * session WSS" and "Add Opus streaming, reviewed wake pre-roll, VAD, ...").
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { WebSocket } from 'ws';
import { createHmac } from 'node:crypto';
import { VoiceSessionManager } from '../src/voice-session.js';
import { OpusStreamProcessor, StreamBuffer, EnergyVad, OpusCodec, pcm16MonoToWav } from '../src/voice-audio.js';
import type { CoreConfig } from '../src/config.js';
import type { Intelligence } from '../src/intelligence.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<CoreConfig> = {}): CoreConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    databaseUrl: 'postgresql://x',
    gatewayPath: '/gateway/v1',
    logLevel: 'info',
    jwtSecret: 'test-secret',
    cookieSecure: false,
    adminUser: 'admin',
    adminPassword: 'changeme',
    allowOpenPairing: false,
    voiceMaxSessionsPerUser: 3,
    voiceMaxSessionsGlobal: 10,
    voiceIdleTimeoutMs: 60_000,
    voiceMaxSessionDurationMs: 30_000,
    voiceVadThreshold: 500,
    voiceVadSilenceMs: 3_000,
    voiceVadContinueTimeoutMs: 2_000,
    ...overrides,
  };
}

/**
 * Create a JWT token with the given claims, signed with the test secret.
 */
function makeToken(overrides: Partial<{ sub: string; username: string; role: string; exp: number }> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: 'user-1',
    username: 'testuser',
    role: 'admin',
    csrf: 'test-csrf',
    iat: Math.floor(Date.now() / 1000) - 60,
    ...overrides,
  })).toString('base64url');
  const signature = createHmac('sha256', 'test-secret')
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/** Create a mock Intelligence that returns canned results. */
function makeMockIntelligence(overrides: Partial<Intelligence> = {}): Intelligence {
  const base: Intelligence = {
    runVoicePipeline: async () => ({
      transcript: 'test transcript',
      reply: 'test reply',
      audioBase64: Buffer.from('fake-tts-audio').toString('base64'),
      degraded: false,
    }),
    health: async () => [],
    providers: { llm: {} as any, asr: undefined, tts: undefined, mcp: undefined },
    checkAudioAllowed: async () => ({ allowed: true }),
    applyTranscriptPrivacy: async () => ({ displayTranscript: 'test', redactedCount: 0 }),
    discardAudioBuffer: () => {},
    audioFocus: {
      requestFocus: () => ({ currentState: 'voice' as const, duckLevel: undefined }),
      releaseFocus: () => ({ currentState: 'idle' as const, duckLevel: undefined }),
      getState: () => 'idle' as const,
      getDuckLevel: () => undefined,
      setDuckLevel: () => {},
    },
  };
  return { ...base, ...overrides };
}

/** Build a Fastify server with the voice session manager registered and listening. */
async function buildServer(config: CoreConfig, intelligence: Intelligence) {
  const fastify = Fastify({ logger: false });
  const manager = new VoiceSessionManager({ config, intelligence });
  manager.register(fastify);
  await fastify.listen({ port: 0, host: '127.0.0.1' });
  const addr = fastify.server.address() as { port: number };
  return { fastify, manager, port: addr.port };
}

/**
 * Connect to a voice session and return the WebSocket plus any messages received.
 * Connection is resolved when the WebSocket opens OR when it closes (for rejected
 * connections, we get the messages from the close event).
 */
async function connectVoiceSession(port: number, token: string): Promise<{ ws: WebSocket; messages: any[] }> {
  return new Promise((resolve) => {
    const url = token ? `ws://127.0.0.1:${port}/ws/voice?token=${token}` : `ws://127.0.0.1:${port}/ws/voice`;
    const ws = new WebSocket(url);
    const messages: any[] = [];
    const timer = setTimeout(() => {
      resolve({ ws, messages });
    }, 3000);

    ws.on('message', (data) => {
      try {
        messages.push(JSON.parse(data.toString()));
      } catch {}
    });

    ws.on('open', () => {
      clearTimeout(timer);
      resolve({ ws, messages });
    });

    ws.on('error', () => {
      clearTimeout(timer);
      resolve({ ws, messages });
    });

    ws.on('close', () => {
      clearTimeout(timer);
      resolve({ ws, messages });
    });
  });
}

/** Generate a fake Opus frame (20ms of encoded silence at 16kHz). */
function makeFakeOpusFrame(): Buffer {
  const codec = new OpusCodec();
  return codec.encode(Buffer.alloc(640));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VoiceSession auth', () => {
  let port: number;
  let closeServer: () => Promise<void>;

  before(async () => {
    const config = makeConfig();
    const intel = makeMockIntelligence();
    const built = await buildServer(config, intel);
    port = built.port;
    closeServer = () => built.fastify.close();
  });

  after(async () => closeServer());

  test('valid admin token connects successfully', async () => {
    const token = makeToken({ role: 'admin' });
    const { ws, messages } = await connectVoiceSession(port, token);
    assert.equal(ws.readyState, WebSocket.OPEN);
    const authMsg = messages.find((m) => m.code === 'auth_ok');
    assert.ok(authMsg, 'Expected auth_ok message, got: ' + JSON.stringify(messages));
    assert.ok(authMsg.session_id);
    ws.close();
  });

  test('valid voice role token connects successfully', async () => {
    const token = makeToken({ role: 'voice' });
    const { ws, messages } = await connectVoiceSession(port, token);
    assert.equal(ws.readyState, WebSocket.OPEN);
    const authMsg = messages.find((m) => m.code === 'auth_ok');
    assert.ok(authMsg, 'Expected auth_ok message, got: ' + JSON.stringify(messages));
    ws.close();
  });

  test('invalid token is rejected (connection closes with error message)', async () => {
    const token = 'invalid.token.here';
    const { ws, messages } = await connectVoiceSession(port, token);
    // The server should have sent an error then closed
    assert.ok(messages.length > 0, 'Expected at least one message');
    const errMsg = messages.find((m) => m.type === 'error');
    assert.ok(errMsg, 'Expected an error message');
    ws.close();
  });

  test('viewer role token is rejected (insufficient role)', async () => {
    const token = makeToken({ role: 'viewer' });
    const { ws, messages } = await connectVoiceSession(port, token);
    assert.ok(messages.length > 0, 'Expected at least one message');
    const errMsg = messages.find((m) => m.type === 'error');
    assert.ok(errMsg, 'Expected an error message');
    ws.close();
  });

  test('missing token is rejected', async () => {
    const { ws, messages } = await connectVoiceSession(port, '');
    assert.ok(messages.length > 0, 'Expected at least one message');
    const errMsg = messages.find((m) => m.type === 'error');
    assert.ok(errMsg, 'Expected an error message');
    ws.close();
  });

  test('expired token is rejected', async () => {
    const token = makeToken({ exp: Math.floor(Date.now() / 1000) - 3600 });
    const { ws, messages } = await connectVoiceSession(port, token);
    assert.ok(messages.length > 0, 'Expected at least one message');
    const errMsg = messages.find((m) => m.type === 'error');
    assert.ok(errMsg, 'Expected an error message');
    ws.close();
  });
});

describe('VoiceSession rate limiting', () => {
  let port: number;
  let closeServer: () => Promise<void>;

  before(async () => {
    const config = makeConfig({ voiceMaxSessionsPerUser: 2, voiceMaxSessionsGlobal: 10 });
    const intel = makeMockIntelligence();
    const built = await buildServer(config, intel);
    port = built.port;
    closeServer = () => built.fastify.close();
  });

  after(async () => closeServer());

  test('rate limiting: max concurrent sessions per user is enforced', async () => {
    const token = makeToken({ role: 'admin', sub: 'rate-user' });
    // Connect two sessions (per-user limit is 2)
    const { ws: ws1 } = await connectVoiceSession(port, token);
    assert.equal(ws1.readyState, WebSocket.OPEN);

    const { ws: ws2 } = await connectVoiceSession(port, token);
    assert.equal(ws2.readyState, WebSocket.OPEN);

    // Third should be rejected
    const { ws: ws3, messages } = await connectVoiceSession(port, token);
    const errMsg = messages.find((m) => m.type === 'error');
    assert.ok(errMsg, 'Expected third connection to be rejected with error');

    ws1.close();
    ws2.close();
    ws3.close();
  });
});

describe('Opus stream processing', () => {
  test('pcm16MonoToWav emits a valid 16kHz mono PCM WAV container', () => {
    const pcm = Buffer.alloc(640, 1);
    const wav = pcm16MonoToWav(pcm);
    assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(24), 16_000);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.readUInt32LE(40), pcm.length);
    assert.deepEqual(wav.subarray(44), pcm);
  });

  test('StreamBuffer accumulates PCM and returns concatenated buffer', () => {
    const buf = new StreamBuffer({ maxBytes: 64000 });
    buf.append(Buffer.from([0x00, 0x01]));
    buf.append(Buffer.from([0x02, 0x03]));
    assert.equal(buf.byteLength, 4);
    assert.deepEqual(buf.toBuffer(), Buffer.from([0x00, 0x01, 0x02, 0x03]));
  });

  test('StreamBuffer drops oldest bytes when over maxBytes', () => {
    const buf = new StreamBuffer({ maxBytes: 6 });
    buf.append(Buffer.from([0x00, 0x01, 0x02]));
    buf.append(Buffer.from([0x03, 0x04, 0x05]));
    buf.append(Buffer.from([0x06, 0x07, 0x08]));
    assert.equal(buf.byteLength, 6);
    assert.deepEqual(buf.toBuffer(), Buffer.from([0x03, 0x04, 0x05, 0x06, 0x07, 0x08]));
  });

  test('OpusCodec encodes and decodes a PCM frame', () => {
    const codec = new OpusCodec();
    const pcm = Buffer.alloc(640);
    const opus = codec.encode(pcm);
    assert.ok(opus.length > 0);
    if (codec.isNative) {
      assert.ok(opus.length < pcm.length);
    } else {
      assert.deepEqual(opus, pcm, 'PCM fallback should pass bytes through unchanged');
    }
    const decoded = codec.decode(opus);
    assert.equal(decoded.length, 640);
  });

  test('OpusStreamProcessor handles audio_start -> audio_frame -> audio_end lifecycle', () => {
    const processor = new OpusStreamProcessor();
    const messages: any[] = [];
    processor.onMessage = (msg) => messages.push(msg);

    processor.handleMessage({ type: 'audio_start', session_id: 'test-1' });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'audio_start_ack');
    assert.ok(processor.started);

    const opusFrame = makeFakeOpusFrame();
    processor.handleMessage({ type: 'audio_frame', payload: opusFrame.toString('base64') });

    processor.handleMessage({ type: 'audio_end' });
    assert.equal(processor.ended, true);
    assert.equal(messages.length, 2);
    assert.equal(messages[1].type, 'audio_end_ack');
  });

  test('post-session frame rejection after audio_end', () => {
    const processor = new OpusStreamProcessor();
    const messages: any[] = [];
    processor.onMessage = (msg) => messages.push(msg);

    processor.handleMessage({ type: 'audio_start' });
    processor.handleMessage({ type: 'audio_end' });
    messages.length = 0;

    processor.handleMessage({ type: 'audio_frame', payload: 'AAAA' });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'error');
    assert.equal(messages[0].code, 'session_closed');
  });

  test('OpusStreamProcessor.runPipeline calls intelligence and returns result', async () => {
    const intel = makeMockIntelligence();
    const processor = new OpusStreamProcessor();

    processor.handleMessage({ type: 'audio_start' });
    const opusFrame = makeFakeOpusFrame();
    processor.handleMessage({ type: 'audio_frame', payload: opusFrame.toString('base64') });
    processor.handleMessage({ type: 'audio_end' });

    const result = await processor.runPipeline(intel);
    assert.equal(result.transcript, 'test transcript');
    assert.equal(result.reply, 'test reply');
    assert.ok(result.ttsAudio);
    assert.equal(result.ttsAudio!.toString('base64'), Buffer.from('fake-tts-audio').toString('base64'));
  });

  test('streamTts sends Opus frames and tts_end', () => {
    const processor = new OpusStreamProcessor();
    const messages: any[] = [];
    processor.onMessage = (msg) => messages.push(msg);

    const pcm = Buffer.alloc(640 * 3 + 100);
    const frames = processor.streamTts(pcm);
    assert.ok(frames >= 4);
    const ttsEnd = messages[messages.length - 1];
    assert.equal(ttsEnd.type, 'tts_end');
    const ttsFrames = messages.filter((m) => m.type === 'tts_frame');
    assert.ok(ttsFrames.length >= 3);
    ttsFrames.forEach((f) => assert.ok(f.payload));
  });
});

describe('VAD (voice activity detection)', () => {
  test('EnergyVad detects speech above threshold', () => {
    const vad = new EnergyVad({ threshold: 500, silenceMs: 3000 });
    const loudPcm = Buffer.alloc(640);
    for (let i = 0; i < 320; i++) {
      loudPcm.writeInt16LE(32767, i * 2);
    }
    const result = vad.feed(loudPcm);
    assert.equal(result.isSpeech, true);
    assert.equal(result.isSilenceTimeout, false);
    assert.ok(result.rms >= 500);
  });

  test('EnergyVad triggers silence timeout after consecutive silence', () => {
    const vad = new EnergyVad({ threshold: 500, silenceMs: 100 });
    const silentPcm = Buffer.alloc(640);

    for (let i = 0; i < 5; i++) {
      const result = vad.feed(silentPcm);
      if (i < 4) assert.equal(result.isSilenceTimeout, false);
    }
    const result = vad.feed(silentPcm);
    assert.equal(result.isSilenceTimeout, true);
  });

  test('EnergyVad resets on vad_continue', () => {
    const vad = new EnergyVad({ threshold: 500, silenceMs: 100 });
    const silentPcm = Buffer.alloc(640);

    for (let i = 0; i < 6; i++) vad.feed(silentPcm);

    vad.reset();
    assert.equal(vad.feed(silentPcm).isSilenceTimeout, false);
  });

  test('VAD sends vad_silence event via processor', () => {
    const processor = new OpusStreamProcessor({ vadThreshold: 500, vadSilenceMs: 100 });
    const messages: any[] = [];
    processor.onMessage = (msg) => messages.push(msg);

    processor.handleMessage({ type: 'audio_start' });

    const codec = processor.getCodec();
    const silentPcm = Buffer.alloc(640);
    const silentOpus = codec.encode(silentPcm);

    for (let i = 0; i < 10; i++) {
      processor.handleMessage({ type: 'audio_frame', payload: silentOpus.toString('base64') });
    }

    const vadSilence = messages.find((m) => m.type === 'vad_silence');
    assert.ok(vadSilence, 'Expected vad_silence event');
  });

  test('vad_continue keeps session alive', () => {
    const processor = new OpusStreamProcessor({ vadThreshold: 500, vadSilenceMs: 100 });
    const messages: any[] = [];
    processor.onMessage = (msg) => messages.push(msg);

    processor.handleMessage({ type: 'audio_start' });

    const codec = processor.getCodec();
    const silentPcm = Buffer.alloc(640);
    const silentOpus = codec.encode(silentPcm);

    for (let i = 0; i < 10; i++) {
      processor.handleMessage({ type: 'audio_frame', payload: silentOpus.toString('base64') });
    }

    const vadSilence = messages.find((m) => m.type === 'vad_silence');
    assert.ok(vadSilence);

    processor.handleMessage({ type: 'vad_continue' });

    for (let i = 0; i < 10; i++) {
      processor.handleMessage({ type: 'audio_frame', payload: silentOpus.toString('base64') });
    }

    const vadSilence2 = messages.filter((m) => m.type === 'vad_silence');
    assert.ok(vadSilence2.length >= 2, 'Expected at least 2 vad_silence events');
  });
});

describe('Voice session idle timeout', () => {
  test('idle timeout closes session after no frames', async () => {
    const config = makeConfig({ voiceIdleTimeoutMs: 100 });
    const intel = makeMockIntelligence();
    const { fastify, port } = await buildServer(config, intel);

    try {
      const token = makeToken({ role: 'admin' });
      const { ws } = await connectVoiceSession(port, token);
      assert.equal(ws.readyState, WebSocket.OPEN);

      // Wait for idle timeout
      const msg = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timeout waiting for idle close')), 3000);
        ws.on('message', (data) => {
          clearTimeout(timer);
          try { resolve(JSON.parse(data.toString())); } catch { resolve({}); }
        });
      });
      assert.equal(msg.type, 'session_closed');
      assert.equal(msg.code, 'idle_timeout');
      ws.close();
    } finally {
      await fastify.close();
    }
  });
});
