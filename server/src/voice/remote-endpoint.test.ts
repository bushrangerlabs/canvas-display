import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { decodeRemoteAudio } from './remote-audio-output';
import { config } from '../config';
import { initDb } from '../db/index';
import { getEdgeDeviceId } from './edge-identity';
import { WakeWordDetector } from './wakeword-local';
import { MicCapture } from './mic';
import { startDirectWakeword, stopDirectWakeword, getDirectWakewordState } from './direct-wakeword';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { EndpointParser, RemoteEndpoint, applyPlaybackTreble, frame } from './remote-endpoint';
import { RemoteMicDsp } from './remote-mic-dsp';
import { validateAssignment, startAudioEndpointPoller, stopAudioEndpointPoller } from './audio-endpoint-poller';

test('playback treble EQ leaves bypass unchanged and boosts speech band without clipping', () => {
  const rate = 22050;
  const tone = (hz: number) => {
    const pcm = Buffer.alloc(rate * 2);
    for (let i = 0; i < rate; i++) pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * hz * i / rate) * 4000), i * 2);
    return pcm;
  };
  const original = tone(3000);
  assert.deepEqual(applyPlaybackTreble(original, rate, 0), original);
  const rms = (pcm: Buffer) => {
    let sum = 0;
    for (let i = rate / 10 * 2; i < pcm.length; i += 2) { const v = pcm.readInt16LE(i); sum += v * v; }
    return Math.sqrt(sum / (pcm.length / 2 - rate / 10));
  };
  const before = rms(original);
  const after = applyPlaybackTreble(original, rate, 6);
  assert.ok(rms(after) > before * 1.5, `expected treble boost, before=${before}, after=${rms(after)}`);
  for (let i = 0; i < after.length; i += 2) assert.ok(Math.abs(after.readInt16LE(i)) <= 32767);
  assert.throws(() => applyPlaybackTreble(original, rate, Number.NaN));
});

test('parser handles fragmented/coalesced ACK and audio and rejects invalid lengths', () => {
  const parser = new EndpointParser();
  const bytes = Buffer.concat([frame(2, Buffer.from([1, 0])), frame(4, Buffer.alloc(5128))]);
  assert.deepEqual(parser.push(bytes.subarray(0, 1)), []);
  assert.deepEqual(parser.push(bytes.subarray(1, 4)), []);
  assert.deepEqual(parser.push(bytes.subarray(4)).map(m => m.type), [2, 4]);
  assert.throws(() => new EndpointParser().push(Buffer.from([0, 0])));
  assert.throws(() => frame(4, Buffer.alloc(8192)));
});

test('DSP golden constant vectors preserve centre-mic beam, state and PCM alignment', () => {
  const dsp = new RemoteMicDsp();
  assert.deepEqual(dsp.process(Buffer.alloc(5120)), Buffer.alloc(640));
  const input = Buffer.alloc(5120);
  for (let i = 0; i < 320; i++) for (let ch = 0; ch < 8; ch++) input.writeInt16LE(ch === 2 || ch === 5 || ch === 6 ? 30000 : 1000, (i * 8 + ch) * 2);
  // Centre-mic baseline: beam = ch7 = 1000; gate=1; gain starts at 1 and moves 5% toward 2.4.
  const first = dsp.process(input);
  assert.equal(first.length, 640);
  for (let i = 0; i < 320; i++) assert.equal(first.readInt16LE(i * 2), 1070);
  assert.equal(dsp.process(input).readInt16LE(0), 1136);
  assert.throws(() => dsp.process(Buffer.alloc(16)));
});

test('DSP matches centre-mic baseline golden vectors', () => {
  const dsp = new RemoteMicDsp();
  const expected = [
    [-2796, -2699, -2602, -2505, -2407, -2310, -2213, -2116, -2018, -1921, -1824, -1726, -1629, -1532, -1435, -1337],
    [-2491, -2393, -2295, -2198, -2100, -2003, -1905, -1808, -1710, -1613, -1515, -1418, -1320, -1223, -1125, -1028],
    [-2182, -2085, -1987, -1889, -1791, -1694, -1596, -1498, -1401, -1303, -1205, -1107, -1010, -912, -814, -717],
  ];
  const sums = [26473, 30073, 25618];
  const hashes = [
    '3c0838fd07c6ecb5bb39680f95cb8c5eaa0343b3cdf930663b2ea734a33ee703',
    'b464dca933e6227a378020e7190e2851c44e4701f85fe87572e05c5a143d642f',
    '42b063a10f1b22c6dbb38cfa04f32e69776cba5b5d9099f06fa1c9bb0398927a',
  ];
  for (let f = 0; f < 3; f++) {
    const input = Buffer.alloc(5120);
    for (let i = 0; i < 320; i++) for (let ch = 0; ch < 8; ch++) input.writeInt16LE(((i * 97 + ch * 173 + f * 311) % 8000) - 4000, (i * 8 + ch) * 2);
    const output = dsp.process(input);
    assert.deepEqual(expected[f].map((_, i) => output.readInt16LE(i * 2)), expected[f]);
    let sum = 0;
    for (let i = 0; i < 320; i++) sum += output.readInt16LE(i * 2);
    assert.equal(sum, sums[f]);
    assert.equal(createHash('sha256').update(output).digest('hex'), hashes[f]);
  }
});

test('remote WAV decode returns PCM without opening a local output and honours cancellation', async () => {
  const wav = Buffer.alloc(44 + 8820);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(22050, 24); wav.writeUInt32LE(44100, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(8820, 40);
  assert.deepEqual(await decodeRemoteAudio(wav, new AbortController().signal), wav.subarray(44));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(decodeRemoteAudio(wav, abort.signal), /cancelled/);
});

test('edge identity canonical env beats legacy DB while canonical DB still wins', () => {
  const oldDb = config.dbPath, oldImages = config.imagesDir;
  const oldCanonicalEnv = process.env.CANVAS_EDGE_DEVICE_ID;
  const oldLegacyEnv = process.env.CANVAS_DEVICE_ID;
  config.dbPath = ':memory:';
  config.imagesDir = '.';
  const db = initDb();
  try {
    db.prepare("DELETE FROM server_settings WHERE key IN ('edge_device_id', 'device_id')").run();
    db.prepare('INSERT INTO server_settings(key,value) VALUES (?,?)').run('device_id', 'legacy-db-device');
    process.env.CANVAS_EDGE_DEVICE_ID = 'canonical-env-device';
    process.env.CANVAS_DEVICE_ID = 'legacy-env-device';
    assert.equal(getEdgeDeviceId(), 'canonical-env-device');

    db.prepare('INSERT INTO server_settings(key,value) VALUES (?,?)').run('edge_device_id', 'canonical-db-device');
    assert.equal(getEdgeDeviceId(), 'canonical-db-device');
  } finally {
    db.close();
    config.dbPath = oldDb;
    config.imagesDir = oldImages;
    if (oldCanonicalEnv === undefined) delete process.env.CANVAS_EDGE_DEVICE_ID;
    else process.env.CANVAS_EDGE_DEVICE_ID = oldCanonicalEnv;
    if (oldLegacyEnv === undefined) delete process.env.CANVAS_DEVICE_ID;
    else process.env.CANVAS_DEVICE_ID = oldLegacyEnv;
  }
});

test('assignment validates explicit clear, per-endpoint controls, and rejects invalid fields', () => {
  assert.deepEqual(validateAssignment({ empty: true }), { empty: true });
  const assignment = validateAssignment({ address: ' pico ', token: 'secret', settings: { playback_volume: 42, treble_db: 3, mic_capture_gain: 1.5, mic_preemphasis: 0.8 } });
  assert.equal(assignment.port, 8090);
  assert.deepEqual(assignment.settings, { playback_volume: 42, treble_db: 3, mic_capture_gain: 1.5, mic_preemphasis: 0.8 });
  assert.throws(() => validateAssignment({ address: 'pico', port: 0, token: 'secret' }));
  assert.throws(() => validateAssignment({ address: 'pico', token: 'secret', settings: { playback_volume: 120, treble_db: 3, mic_capture_gain: 1, mic_preemphasis: 0.8 } }));
  assert.throws(() => validateAssignment({ address: 'pico' }));
});

async function fixture(reject = false, initialMicFrame = Buffer.alloc(5128)) {
  const connections: net.Socket[] = [];
  const audio: Array<{ at: number; payload: Buffer }> = [];
  const voiceStates: Array<{ role: number; state: number }> = [];
  const server = net.createServer(socket => {
    connections.push(socket);
    const parser = new EndpointParser();
    let role = -1;
    socket.on('error', () => undefined);
    socket.on('data', bytes => {
      for (const message of parser.push(bytes)) {
        if (message.type === 1) {
          role = message.payload[0];
          if (reject) { socket.write(frame(2, Buffer.from([1, 1]))); continue; }
          if (message.payload[0] === 0) {
            const ack = frame(2, Buffer.from([1, 0]));
            socket.write(ack.subarray(0, 1));
            socket.write(Buffer.concat([ack.subarray(1), frame(4, initialMicFrame)]));
          } else socket.write(frame(2, Buffer.from([1, 0])));
        } else if (message.type === 4) audio.push({ at: performance.now(), payload: message.payload });
        else if (message.type === 8) {
          assert.equal(message.payload.length, 1);
          voiceStates.push({ role, state: message.payload[0] });
        }
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as net.AddressInfo;
  const client = new RemoteEndpoint({ host: '127.0.0.1', port: address.port, token: 'secret', deviceId: 'edge' });
  return { client, audio, voiceStates, connections, port: address.port, close: async () => { client.stop(); for (const socket of connections) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('voice indicator sends states only on authenticated mic socket and restores on reconnect', async t => {
  t.mock.method(console, 'log', () => undefined);
  const f = await fixture();
  f.client.on('error', () => undefined);
  try {
    f.client.setVoiceState('listening');
    assert.equal(f.voiceStates.length, 0);
    const data = once(f.client, 'data');
    f.client.start();
    await data;
    await sleep(30);
    assert.deepEqual(f.voiceStates, [{ role: 0, state: 1 }]);
    for (const state of ['processing', 'error', 'ready'] as const) f.client.setVoiceState(state);
    await sleep(30);
    assert.deepEqual(f.voiceStates.map(item => item.state), [1, 2, 3, 0]);
    assert.ok(f.voiceStates.every(item => item.role === 0));
    f.client.setVoiceState('listening');
    await sleep(30);
    const reconnect = once(f.client, 'data');
    f.connections[0].destroy();
    await reconnect;
    await sleep(30);
    assert.deepEqual(f.voiceStates.at(-1), { role: 0, state: 1 });
  } finally { await f.close(); }
});

test('rawdata emits the raw centre mic (ch7) alongside the DSP output', async t => {
  t.mock.method(console, 'log', () => undefined);
  const payload = Buffer.alloc(5128);
  for (let sample = 0; sample < 320; sample++) for (let ch = 0; ch < 8; ch++) payload.writeInt16LE(ch === 7 ? 1234 : 0, 8 + (sample * 8 + ch) * 2);
  const f = await fixture(false, payload);
  try {
    f.client.on('error', error => assert.fail(error.message));
    const raw = once(f.client, 'rawdata');
    f.client.start();
    const chunk = (await raw)[0];
    assert.equal(chunk.length, 640);
    for (let sample = 0; sample < 320; sample++) assert.equal(chunk.readInt16LE(sample * 2), 1234);
  } finally { await f.close(); }
});

test('raw channel diagnostics identify format and levels without altering DSP output', async t => {
  const log = t.mock.method(console, 'log', () => undefined);
  const payload = Buffer.alloc(5128);
  const levels = [0, 100, -200, 300, -400, 32767, -32768, 700];
  payload.writeUInt32LE(123, 0);
  payload.writeUInt32LE(456, 4);
  for (let sample = 0; sample < 320; sample++) for (let ch = 0; ch < 8; ch++) payload.writeInt16LE(levels[ch], 8 + (sample * 8 + ch) * 2);
  const f = await fixture(false, payload);
  try {
    f.client.on('error', error => assert.fail(error.message));
    const data = once(f.client, 'data');
    f.client.start();
    assert.deepEqual((await data)[0], new RemoteMicDsp().process(payload.subarray(8)));
    const stats = f.client.getDiagnostics();
    assert.deepEqual(stats.rawFormat, { format: 'pcm16-s16le', interleaved: true, sampleRateHz: 16000, channelCount: 8, samplesPerChannel: 320, frameDurationMs: 20 });
    assert.deepEqual(stats.rawChannels.map(channel => channel.index), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(stats.rawChannels.map(channel => channel.rms), levels.map(Math.abs));
    assert.deepEqual(stats.rawChannels.map(channel => channel.clipped), [0, 0, 0, 0, 0, 320, 320, 0]);
    assert.deepEqual(stats.rawChannels.map(channel => channel.clippedTotal), [0, 0, 0, 0, 0, 320, 320, 0]);
    assert.equal(stats.rawChannels[7].label, 'D3 R (centre mic)');
    assert.equal(stats.sequence, 123);
    assert.equal(stats.endpointTimestampMs, 456);
    assert.equal(stats.receiveIntervalMs, null);
    assert.equal(stats.endpointTimestampIntervalMs, null);
    assert.equal(stats.maxDspMs, stats.lastDspMs);
    assert.equal(stats.dspMeanMs, stats.dspMs);
    stats.rawChannels[0].rms = 999;
    stats.rawFormat.sampleRateHz = 1;
    assert.equal(f.client.getDiagnostics().rawChannels[0].rms, 0);
    assert.equal(f.client.getDiagnostics().rawFormat.sampleRateHz, 16000);
    payload.writeUInt32LE(124, 0);
    payload.writeUInt32LE(476, 4);
    const next = once(f.client, 'data');
    f.connections[0].write(frame(4, payload));
    await next;
    assert.deepEqual(f.client.getDiagnostics().rawChannels.map(channel => channel.clippedTotal), [0, 0, 0, 0, 0, 640, 640, 0]);
    assert.equal(log.mock.callCount(), 1, 'frames inside the 10-second window must not log again');
  } finally { await f.close(); }
});

test('mic sequence and endpoint timestamp intervals accept wrap and distinguish gaps, duplicates and resets', async () => {
  const initial = Buffer.alloc(5128);
  initial.writeUInt32LE(0xfffffffe, 0);
  initial.writeUInt32LE(0xfffffff0, 4);
  const f = await fixture(false, initial);
  try {
    f.client.on('error', error => assert.fail(error.message));
    const first = once(f.client, 'data');
    f.client.start();
    await first;
    const send = async (sequence: number, timestamp: number) => {
      const payload = Buffer.alloc(5128);
      payload.writeUInt32LE(sequence, 0);
      payload.writeUInt32LE(timestamp, 4);
      const next = once(f.client, 'data');
      f.connections[0].write(frame(4, payload));
      await next;
      return f.client.getDiagnostics();
    };
    let stats = await send(0xffffffff, 4);
    assert.equal(stats.endpointTimestampIntervalMs, 20);
    assert.ok(stats.receiveIntervalMs !== null && stats.receiveIntervalMs >= 0);
    stats = await send(0, 24);
    assert.equal(stats.sequenceDiscontinuities, 0);
    assert.equal(stats.droppedFrames, 0);
    assert.equal(stats.endpointTimestampIntervalMs, 20);
    stats = await send(3, 84);
    assert.equal(stats.sequenceDiscontinuities, 1);
    assert.equal(stats.droppedFrames, 2);
    assert.equal(stats.endpointTimestampIntervalMs, 60);
    stats = await send(3, 84);
    assert.equal(stats.duplicateFrames, 1);
    assert.equal(stats.endpointTimestampIntervalMs, 0);
    stats = await send(1, 64);
    assert.equal(stats.backwardFrames, 1);
    assert.equal(stats.endpointTimestampIntervalMs, null);
    assert.equal(stats.endpointTimestampDiscontinuities, 1);
    stats = await send(2, 84);
    assert.equal(stats.sequenceDiscontinuities, 3);
    assert.equal(stats.droppedFrames, 2);
    assert.equal(stats.endpointTimestampIntervalMs, 20);
    assert.equal(stats.inputFrames, 7);
    assert.equal(stats.dspMeanMs, stats.dspMs / 7);
    assert.ok(stats.maxDspMs >= stats.lastDspMs);

    // A new authenticated session has no cross-session timing/drop inference.
    f.client.stop();
    const restarted = once(f.client, 'data');
    f.client.start();
    await restarted;
    stats = f.client.getDiagnostics();
    assert.equal(stats.receiveIntervalMs, null);
    assert.equal(stats.endpointTimestampIntervalMs, null);
    assert.equal(stats.sequenceDiscontinuities, 3);
    assert.equal(stats.droppedFrames, 2);
  } finally { await f.close(); }
});

test('authenticated remote source emits DSP mono; playback is paced, aligned and serialized', async () => {
  const f = await fixture();
  try {
    f.client.on('error', error => assert.fail(error.message));
    const data = once(f.client, 'data');
    f.client.start();
    assert.equal((await data)[0].length, 640);
    await sleep(30);
    const pcm = Buffer.alloc(22050 * 2 / 5);
    await Promise.all([f.client.play(pcm), f.client.play(pcm)]);
    assert.equal(f.audio.reduce((sum, item) => sum + item.payload.length, 0), pcm.length * 2);
    assert.ok(f.audio.every(item => item.payload.length % 2 === 0 && item.payload.length + 1 <= 8192));
    assert.ok(f.audio.at(-1)!.at - f.audio[0].at >= 350);
    await assert.rejects(f.client.play(Buffer.alloc(3)));
  } finally { await f.close(); }
});

test('rejected authentication never exposes ready or audio', async () => {
  const f = await fixture(true);
  try {
    const errors: Error[] = [];
    f.client.on('error', error => errors.push(error));
    f.client.start();
    await sleep(100);
    assert.ok(errors.length >= 1);
    assert.equal(f.client.getDiagnostics().micReady, false);
    await assert.rejects(f.client.play(Buffer.alloc(640)));
  } finally { await f.close(); }
});

test('cancel stops queued playback without claiming a hardware flush', async () => {
  const f = await fixture();
  try {
    f.client.on('error', () => undefined);
    f.client.start();
    await sleep(50);
    const first = f.client.play(Buffer.alloc(44100));
    const second = f.client.play(Buffer.alloc(44100));
    const settled = Promise.allSettled([first, second]);
    await sleep(60);
    f.client.cancelPlayback();
    assert.ok((await settled).every(result => result.status === 'rejected'));
    const count = f.audio.length;
    await sleep(80);
    assert.equal(f.audio.length, count);
    assert.equal(f.client.getDiagnostics().queuedBytes, 0);
  } finally { await f.close(); }
});

test('mic reconnect authenticates a fresh session after peer disconnect', async () => {
  const f = await fixture();
  try {
    f.client.on('error', () => undefined);
    f.client.start();
    await sleep(50);
    const next = once(f.client, 'data');
    f.connections[0].destroy();
    await next;
    assert.equal(f.client.getDiagnostics().micReady, true);
    assert.ok(f.client.getDiagnostics().inputFrames >= 2);
  } finally { await f.close(); }
});

test('actual direct owner routes Pico DSP/VAD to Core and PCM back to Pico in both modes', async t => {
  const oldDb = config.dbPath, oldImages = config.imagesDir;
  config.dbPath = ':memory:';
  config.imagesDir = '.';
  const db = initDb();
  let detector: WakeWordDetector | undefined;
  t.mock.method(WakeWordDetector.prototype, 'start', function(this: WakeWordDetector) { detector = this; this.emit('ready', 'hey_jarvis'); });
  t.mock.method(WakeWordDetector.prototype, 'restart', () => undefined);
  t.mock.method(WakeWordDetector.prototype, 'stop', () => undefined);
  t.mock.method(WakeWordDetector.prototype, 'feed', () => undefined);
  t.mock.method(MicCapture.prototype, 'start', () => assert.fail('Remote direct mode must not start local capture'));
  const oldStreaming = process.env.CANVAS_CORE_STREAMING_TTS;
  let calls = 0;
  let assignedPort = 0;
  let releaseAssignment: (() => void) | undefined;
  let delayAssignment = false;
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    if (String(url).includes('/audio/assignment?')) {
      assert.ok(String(url).endsWith('deviceId=persisted-edge'));
      if (delayAssignment) await new Promise<void>(resolve => { releaseAssignment = resolve; });
      return Response.json({ address: '127.0.0.1', port: assignedPort, token: 'secret', id: 'assigned-pico' });
    }
    if (String(url).endsWith('/metrics')) return new Response('{}');
    calls++;
    assert.match(String(url), /\/api\/edge\/voice\/turn(?:-stream)?$/);
    assert.equal((options.headers as Record<string, string>).authorization, 'Bearer core-secret');
    const body = JSON.parse(String(options.body));
    assert.equal(body.deviceId, 'persisted-edge');
    const wav = Buffer.from(body.audioBase64, 'base64');
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt32LE(24), 16000);
    const audioBase64 = Buffer.alloc(8820).toString('base64');
    if (String(url).endsWith('turn-stream')) return new Response([
      JSON.stringify({ type: 'meta', transcript: 'hello', reply: 'hi' }),
      JSON.stringify({ type: 'audio', audioBase64 }),
      JSON.stringify({ type: 'end', ttsMs: 10 }),
    ].join('\n'));
    return Response.json({ transcript: 'hello', reply: 'hi', audioBase64 });
  });
  try {
    for (const streaming of ['0', '1']) {
      process.env.CANVAS_CORE_STREAMING_TTS = streaming;
      const f = await fixture();
      try {
        const address = f.connections; // Populated once the actual direct owner connects.
        const settings: Record<string, string> = {
          voice_integration_wake_enabled: '1', audio_endpoint_host: '127.0.0.1',
          audio_endpoint_port: String(f.port), audio_endpoint_token: 'secret',
          edge_device_id: 'persisted-edge', canvas_core_url: 'http://core.test', edge_voice_token: 'core-secret',
          voice_wake_ack_enabled: '0', voice_good_intent_enabled: '0', voice_no_intent_enabled: '0',
        };
        for (const [key, value] of Object.entries(settings)) db.prepare('INSERT INTO server_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
        await startDirectWakeword();
        await sleep(80);
        assert.equal(getDirectWakewordState().remoteAudio?.playbackReady, true);
        detector!.emit('detected', 0.8);
        await sleep(30);
        const speech = Buffer.alloc(5128);
        for (let i = 0; i < 320; i++) for (let ch = 0; ch < 8; ch++) speech.writeInt16LE(i % 2 ? 2000 : -2000, 8 + (i * 8 + ch) * 2);
        for (let i = 0; i < 16; i++) address[0].write(frame(4, Buffer.alloc(5128)));
        for (let i = 0; i < 25; i++) address[0].write(frame(4, speech));
        // 56 silent frames = 1120 ms, exceeding the 1000 ms trailing-silence window.
        for (let i = 0; i < 56; i++) address[0].write(frame(4, Buffer.alloc(5128)));
        const deadline = Date.now() + 3000;
        while ((!f.audio.length || getDirectWakewordState().status !== 'running') && Date.now() < deadline) await sleep(20);
        assert.equal(f.audio.reduce((sum, item) => sum + item.payload.length, 0), 8820);
        assert.equal(getDirectWakewordState().status, 'running');
      } finally { await stopDirectWakeword(); await f.close(); }
    }
    assert.equal(calls, 2);
    const original = await fixture(), replacement = await fixture();
    try {
      db.prepare("UPDATE server_settings SET value=? WHERE key='audio_endpoint_port'").run(String(original.port));
      await startDirectWakeword();
      await sleep(80);
      assignedPort = replacement.port;
      startAudioEndpointPoller();
      const deadline = Date.now() + 3000;
      while (replacement.connections.length < 2 && Date.now() < deadline) await sleep(20);
      await sleep(50);
      assert.equal(replacement.connections.length, 2);
      assert.equal(getDirectWakewordState().remoteAudio?.micReady, true);
      assert.equal((db.prepare("SELECT value FROM server_settings WHERE key='audio_endpoint_id'").get() as { value: string }).value, 'assigned-pico');
      stopAudioEndpointPoller();
      assignedPort = original.port;
      delayAssignment = true;
      startAudioEndpointPoller();
      await sleep(20);
      stopAudioEndpointPoller();
      releaseAssignment!();
      await sleep(30);
      assert.equal((db.prepare("SELECT value FROM server_settings WHERE key='audio_endpoint_port'").get() as { value: string }).value, String(replacement.port));
    } finally {
      stopAudioEndpointPoller();
      await stopDirectWakeword();
      await original.close(); await replacement.close();
    }
  } finally {
    stopAudioEndpointPoller();
    await stopDirectWakeword();
    db.close();
    config.dbPath = oldDb; config.imagesDir = oldImages;
    if (oldStreaming === undefined) delete process.env.CANVAS_CORE_STREAMING_TTS;
    else process.env.CANVAS_CORE_STREAMING_TTS = oldStreaming;
  }
});

test('stop/start ignores stale socket closes and uses fresh parser/session', async () => {
  const f = await fixture();
  try {
    f.client.on('error', () => undefined);
    f.client.start();
    await sleep(50);
    f.client.stop();
    const next = once(f.client, 'data');
    f.client.start();
    await next;
    await sleep(50);
    assert.equal(f.client.getDiagnostics().micReady, true);
    assert.equal(f.client.getDiagnostics().playbackReady, true);
  } finally { await f.close(); }
});
