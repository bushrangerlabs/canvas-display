import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RawMicDiagnostics } from './raw-mic-diagnostics';
import { RemoteEndpoint } from './remote-endpoint';

test('opt-in raw microphone diagnostic writes a bounded 8-channel WAV and metadata', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'canvas-audio-diagnostic-test-'));
  try {
    const capture = new RawMicDiagnostics(directory, 1);
    const frame = Buffer.alloc(5120);
    for (let sample = 0; sample < 320; sample++) {
      for (let channel = 0; channel < 8; channel++) frame.writeInt16LE(channel * 100, (sample * 8 + channel) * 2);
    }
    for (let i = 0; i < 50; i++) capture.write(frame);
    await capture.finish();
    const wav = await readFile(capture.wavPath);
    const metadata = JSON.parse(await readFile(capture.metadataPath, 'utf8')) as { frameCount: number; durationSeconds: number; channels: number; sampleRateHz: number };
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt32LE(40), 50 * 5120);
    assert.equal(wav.readUInt16LE(22), 8);
    assert.equal(wav.readUInt32LE(24), 16000);
    assert.equal(metadata.frameCount, 50);
    assert.equal(metadata.durationSeconds, 1);
    assert.equal(metadata.channels, 8);
    assert.equal(metadata.sampleRateHz, 16000);
    assert.deepEqual((await readdir(directory)).sort(), [path.basename(capture.metadataPath), path.basename(capture.wavPath)].sort());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('RemoteEndpoint.stop awaits diagnostic WAV and metadata finalization', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'canvas-audio-stop-test-'));
  const previousEnabled = process.env.CANVAS_AUDIO_DIAGNOSTICS;
  const previousDirectory = process.env.CANVAS_AUDIO_DIAGNOSTIC_DIR;
  try {
    process.env.CANVAS_AUDIO_DIAGNOSTICS = '1';
    process.env.CANVAS_AUDIO_DIAGNOSTIC_DIR = directory;
    const endpoint = new RemoteEndpoint({ host: '127.0.0.1', port: 8090, token: 'test-token', deviceId: 'test-edge' });
    await endpoint.stop();
    const files = await readdir(directory);
    assert.equal(files.length, 2);
    const wav = await readFile(path.join(directory, files.find(f => f.endsWith('.wav'))!));
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    const metadata = JSON.parse(await readFile(path.join(directory, files.find(f => f.endsWith('.json'))!), 'utf8')) as { frameCount: number };
    assert.equal(metadata.frameCount, 0);
  } finally {
    if (previousEnabled === undefined) delete process.env.CANVAS_AUDIO_DIAGNOSTICS;
    else process.env.CANVAS_AUDIO_DIAGNOSTICS = previousEnabled;
    if (previousDirectory === undefined) delete process.env.CANVAS_AUDIO_DIAGNOSTIC_DIR;
    else process.env.CANVAS_AUDIO_DIAGNOSTIC_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});
