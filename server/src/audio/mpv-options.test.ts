import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMpvArgs } from './mpv-options';

test('audio mpv stays headless', () => {
  const args = buildMpvArgs({ url: 'https://media.test/radio.mp3', volume: 70, socketPath: '/tmp/mpv.sock', video: false });
  assert.ok(args.includes('--no-video'));
  assert.ok(!args.includes('--fullscreen'));
});

test('video mpv opens fullscreen with the touch control script', () => {
  const args = buildMpvArgs({
    url: 'https://media.test/live.mp4', volume: 70, socketPath: '/tmp/mpv.sock', video: true,
    touchScriptPath: '/tmp/canvas-mpv-touch.lua',
  });
  assert.ok(args.includes('--fullscreen'));
  assert.ok(args.includes('--osc=yes'));
  assert.ok(args.includes('--script=/tmp/canvas-mpv-touch.lua'));
  assert.ok(!args.includes('--no-video'));
});
