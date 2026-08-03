import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EndOfSpeechDetector } from '../src/voice/end-of-speech';

function pcm(amplitude: number, milliseconds = 80): Buffer {
  const samples = 16_000 * milliseconds / 1_000;
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) out.writeInt16LE(i % 2 ? amplitude : -amplitude, i * 2);
  return out;
}

function pushFor(detector: EndOfSpeechDetector, amplitude: number, milliseconds: number) {
  let decision = detector.push(Buffer.alloc(0));
  for (let elapsed = 0; elapsed < milliseconds && decision === 'continue'; elapsed += 80) {
    decision = detector.push(pcm(amplitude));
  }
  return decision;
}

test('ends a short utterance after bounded trailing silence', () => {
  const detector = new EndOfSpeechDetector();
  assert.equal(pushFor(detector, 40, 240), 'continue');
  assert.equal(pushFor(detector, 2_000, 480), 'continue');
  assert.equal(pushFor(detector, 40, 800), 'speech-ended');
  assert.ok(detector.durationMs < 2_000);
});

test('allows a long utterance while speech remains active', () => {
  const detector = new EndOfSpeechDetector();
  assert.equal(pushFor(detector, 40, 400), 'continue');
  assert.equal(pushFor(detector, 1_600, 5_000), 'continue');
  assert.equal(pushFor(detector, 30, 800), 'speech-ended');
});

test('quiet input returns no-speech instead of waiting for maximum', () => {
  const detector = new EndOfSpeechDetector();
  assert.equal(pushFor(detector, 30, 4_000), 'no-speech');
  assert.ok(detector.durationMs >= 3_500 && detector.durationMs < 4_000);
});

test('steady background noise adapts without becoming speech', () => {
  const detector = new EndOfSpeechDetector();
  assert.equal(pushFor(detector, 1_500, 4_000), 'no-speech');
});

test('detects speech above a loud calibrated microphone noise floor', () => {
  const detector = new EndOfSpeechDetector();
  assert.equal(pushFor(detector, 1_500, 480), 'continue');
  assert.equal(pushFor(detector, 5_000, 560), 'continue');
  assert.equal(pushFor(detector, 1_500, 800), 'speech-ended');
});

test('hard maximum bounds continuous loud input', () => {
  const detector = new EndOfSpeechDetector();
  assert.equal(pushFor(detector, 40, 400), 'continue');
  assert.equal(pushFor(detector, 2_000, 9_000), 'maximum');
  assert.ok(detector.durationMs >= 8_000 && detector.durationMs < 8_100);
});
