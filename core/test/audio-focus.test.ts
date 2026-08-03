import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioFocusManager, FakeFocusManager } from '../src/audio-focus.js';
import type { FocusState, FocusType, FocusGrant } from '../src/audio-focus.js';

// ---------------------------------------------------------------------------
// AudioFocusManager — state machine transitions
// ---------------------------------------------------------------------------

test('idle → active_voice on requestFocus("voice")', () => {
  const mgr = new AudioFocusManager();
  const result = mgr.requestFocus('voice');
  assert.equal(result.granted, true);
  assert.equal(result.currentState, 'active_voice');
  assert.equal(result.duckLevel, undefined);
  assert.equal(mgr.getState(), 'active_voice');
});

test('idle → active_media on requestFocus("media")', () => {
  const mgr = new AudioFocusManager();
  const result = mgr.requestFocus('media');
  assert.equal(result.granted, true);
  assert.equal(result.currentState, 'active_media');
  assert.equal(mgr.getState(), 'active_media');
});

test('active_media → ducking_media on requestFocus("voice") with duck level', () => {
  const mgr = new AudioFocusManager({ duckVolumePercent: 25 });
  mgr.requestFocus('media');
  const result = mgr.requestFocus('voice');
  assert.equal(result.granted, true);
  assert.equal(result.currentState, 'ducking_media');
  assert.equal(result.duckLevel, 25);
});

test('active_media → ducking_media on requestFocus("barge_in")', () => {
  const mgr = new AudioFocusManager();
  mgr.requestFocus('media');
  const result = mgr.requestFocus('barge_in');
  assert.equal(result.granted, true);
  assert.equal(result.currentState, 'ducking_media');
  assert.equal(result.duckLevel, 30);
});

test('active_voice → barge_in on requestFocus("barge_in")', () => {
  const mgr = new AudioFocusManager();
  mgr.requestFocus('voice');
  const result = mgr.requestFocus('barge_in');
  assert.equal(result.granted, true);
  assert.equal(result.currentState, 'barge_in');
});

test('ducking_media → active_voice on requestFocus("voice")', () => {
  const mgr = new AudioFocusManager();
  mgr.requestFocus('media');
  mgr.requestFocus('voice'); // → ducking_media
  const result = mgr.requestFocus('voice'); // voice preempts another voice
  assert.equal(result.granted, true);
  assert.equal(result.currentState, 'active_voice');
});

test('barge_in → active_voice on requestFocus("voice")', () => {
  const mgr = new AudioFocusManager();
  mgr.requestFocus('media');
  mgr.requestFocus('barge_in'); // → ducking_media
  const result = mgr.requestFocus('voice');
  assert.equal(result.granted, true);
  assert.equal(result.currentState, 'active_voice');
});

test('releaseFocus("voice") from active_voice with media → ducking_media', () => {
  const mgr = new AudioFocusManager();
  mgr.requestFocus('media');
  mgr.requestFocus('voice'); // → ducking_media (media_was_playing = true), actually active_voice
  // Wait — need to trace this more carefully
  
  // Alternative: start media, then voice ducks it
  const mgr2 = new AudioFocusManager();
  mgr2.requestFocus('media');
  mgr2.requestFocus('voice'); // ducking_media
  // release voice while media was playing
  const result = mgr2.releaseFocus('voice');
  // Should restore to active_media
  assert.equal(result.granted, true);
  assert.equal(result.currentState, 'active_media');
});

test('releaseFocus("voice") from active_voice without media → idle', () => {
  const mgr = new AudioFocusManager();
  mgr.requestFocus('voice');
  const result = mgr.releaseFocus('voice');
  assert.equal(result.granted, true);
  assert.equal(result.currentState, 'idle');
});

test('media request denied when voice is active', () => {
  const mgr = new AudioFocusManager();
  mgr.requestFocus('voice');
  const result = mgr.requestFocus('media');
  assert.equal(result.granted, false);
  assert.equal(result.currentState, 'active_voice');
});

test('default duck level is 30%', () => {
  const mgr = new AudioFocusManager();
  assert.equal(mgr.getDuckLevel(), 30);
});

test('custom duck level is respected', () => {
  const mgr = new AudioFocusManager({ duckVolumePercent: 15 });
  assert.equal(mgr.getDuckLevel(), 15);
});

test('reset returns to idle', () => {
  const mgr = new AudioFocusManager();
  mgr.requestFocus('voice');
  mgr.reset();
  assert.equal(mgr.getState(), 'idle');
});

test('full cycle: media → voice ducks → voice releases → media restored', () => {
  const mgr = new AudioFocusManager({ duckVolumePercent: 20 });

  // Start media
  let r = mgr.requestFocus('media');
  assert.equal(r.currentState, 'active_media');

  // Voice ducks media
  r = mgr.requestFocus('voice');
  assert.equal(r.currentState, 'ducking_media');
  assert.equal(r.duckLevel, 20);

  // Voice ends
  r = mgr.releaseFocus('voice');
  assert.equal(r.currentState, 'active_media');
  assert.equal(r.duckLevel, undefined);

  // Media ends
  r = mgr.releaseFocus('media');
  assert.equal(r.currentState, 'idle');
});

test('barge-in preempts voice then releases back to voice', () => {
  const mgr = new AudioFocusManager();

  mgr.requestFocus('media');
  mgr.requestFocus('voice'); // ducking media
  assert.equal(mgr.getState(), 'ducking_media');

  // Barge-in preempts voice
  mgr.requestFocus('barge_in');
  assert.equal(mgr.getState(), 'barge_in');

  // Barge-in ends — should go back to active_voice (media still ducked)
  const r = mgr.releaseFocus('barge_in');
  assert.equal(r.currentState, 'active_voice');
});

// ---------------------------------------------------------------------------
// FakeFocusManager
// ---------------------------------------------------------------------------

test('FakeFocusManager records calls', () => {
  const fake = new FakeFocusManager();
  fake.requestFocus('voice');
  fake.releaseFocus('voice');
  fake.getState();
  fake.getDuckLevel();

  assert.equal(fake.calls.length, 4);
  assert.deepEqual(fake.calls[0], { method: 'requestFocus', args: ['voice'] });
  assert.deepEqual(fake.calls[1], { method: 'releaseFocus', args: ['voice'] });
});

test('FakeFocusManager returns nextGrant when set', () => {
  const fake = new FakeFocusManager();
  fake.nextGrant = { granted: false, currentState: 'active_media' };
  const result = fake.requestFocus('voice');
  assert.equal(result.granted, false);
  assert.equal(result.currentState, 'active_media');
  // nextGrant should be consumed
  const result2 = fake.requestFocus('voice');
  assert.equal(result2.granted, true);
});