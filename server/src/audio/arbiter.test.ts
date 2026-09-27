import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import {
  acquireSink,
  getSinkOwner,
  registerSinkReleaser,
  releaseSink,
  resetArbiter,
} from './arbiter';

beforeEach(() => resetArbiter());

test('starts idle', () => {
  assert.equal(getSinkOwner(), 'idle');
});

test('acquiring the sink releases the previous owner', async () => {
  const released: string[] = [];
  registerSinkReleaser('snapcast', async () => { released.push('snapcast'); });
  registerSinkReleaser('mpv', async () => { released.push('mpv'); });

  await acquireSink('snapcast');
  assert.equal(getSinkOwner(), 'snapcast');

  await acquireSink('mpv');
  assert.equal(getSinkOwner(), 'mpv');
  assert.deepEqual(released, ['snapcast'], 'snapcast must be released when mpv takes over');

  await acquireSink('snapcast');
  assert.deepEqual(released, ['snapcast', 'mpv'], 'mpv must be released when snapcast takes over');
});

test('re-acquiring the same owner does not release it', async () => {
  let releases = 0;
  registerSinkReleaser('mpv', async () => { releases += 1; });

  await acquireSink('mpv');
  await acquireSink('mpv');
  assert.equal(releases, 0);
  assert.equal(getSinkOwner(), 'mpv');
});

test('releasing only takes effect for the current owner', async () => {
  await acquireSink('mpv');
  await releaseSink('snapcast');
  assert.equal(getSinkOwner(), 'mpv', 'a non-owner release must be ignored');

  await releaseSink('mpv');
  assert.equal(getSinkOwner(), 'idle');
});

test('a failing releaser does not block the new owner', async () => {
  registerSinkReleaser('snapcast', async () => { throw new Error('systemctl unavailable'); });
  await acquireSink('snapcast');
  await acquireSink('mpv');
  assert.equal(getSinkOwner(), 'mpv');
});

test('acquiring with no registered releaser still switches owner', async () => {
  await acquireSink('snapcast');
  await acquireSink('mpv');
  assert.equal(getSinkOwner(), 'mpv');
});