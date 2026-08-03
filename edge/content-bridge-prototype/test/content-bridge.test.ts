import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { ContentBridgePrototype, type PlayerEvent } from '../server.js';

function rawStatus(url: URL, hostHeader: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'GET',
      headers: { Host: hostHeader },
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    request.once('error', reject);
    request.end();
  });
}

test('loopback player uses one-use fragment claim and scoped event token', async (context) => {
  const bridge = new ContentBridgePrototype();
  await bridge.start();
  context.after(async () => bridge.stop());

  assert.equal(bridge.address.address, '127.0.0.1');
  const created = bridge.createYouTubeSession({
    videoIds: ['3_TvpBwSZDM', 'vTSRa6QFk8Q'],
    playbackId: 'phase0-test',
  });
  const playerUrl = new URL(created.url);
  const claimToken = new URLSearchParams(playerUrl.hash.slice(1)).get('claim');
  assert(claimToken);
  assert.equal(playerUrl.search, '');

  const playerResponse = await fetch(playerUrl);
  assert.equal(playerResponse.status, 200);
  assert.equal(playerResponse.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(playerResponse.headers.get('x-content-type-options'), 'nosniff');
  const csp = playerResponse.headers.get('content-security-policy') ?? '';
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self' https:\/\/www\.youtube\.com https:\/\/s\.ytimg\.com/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  const html = await playerResponse.text();
  assert.match(html, /\/assets\/youtube-player\.js/);
  assert.doesNotMatch(html, /3_TvpBwSZDM|vTSRa6QFk8Q/);
  assert.doesNotMatch(html, new RegExp(claimToken));

  const invalidHostStatus = await rawStatus(playerUrl, 'localhost:43121');
  assert.equal(invalidHostStatus, 421);

  const claimPath = `${bridge.origin}${playerUrl.pathname}/claim`;
  const wrongOrigin = await fetch(claimPath, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${claimToken}`,
      'Content-Type': 'application/json',
      Origin: 'https://attacker.invalid',
    },
    body: '{}',
  });
  assert.equal(wrongOrigin.status, 403);

  const claimResponse = await fetch(claimPath, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${claimToken}`,
      'Content-Type': 'application/json',
      Origin: bridge.origin,
    },
    body: '{}',
  });
  assert.equal(claimResponse.status, 200);
  const claim = await claimResponse.json() as {
    playback_id: string;
    video_ids: string[];
    event_token: string;
  };
  assert.deepEqual(claim.video_ids, ['3_TvpBwSZDM', 'vTSRa6QFk8Q']);
  assert.equal(claim.playback_id, 'phase0-test');
  assert(claim.event_token.length >= 40);

  const replayClaim = await fetch(claimPath, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${claimToken}`,
      'Content-Type': 'application/json',
      Origin: bridge.origin,
    },
    body: '{}',
  });
  assert.equal(replayClaim.status, 409);

  const event: PlayerEvent = {
    playback_id: 'phase0-test',
    event: 'playing',
    video_id: '3_TvpBwSZDM',
    candidate_index: 0,
    candidate_count: 2,
  };
  const eventsPath = `${bridge.origin}${playerUrl.pathname}/events`;
  const forgedEvent = await fetch(eventsPath, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer wrong-token',
      'Content-Type': 'application/json',
      Origin: bridge.origin,
    },
    body: JSON.stringify(event),
  });
  assert.equal(forgedEvent.status, 401);

  const acceptedEvent = await fetch(eventsPath, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${claim.event_token}`,
      'Content-Type': 'application/json',
      Origin: bridge.origin,
    },
    body: JSON.stringify(event),
  });
  assert.equal(acceptedEvent.status, 200);
  assert.deepEqual(bridge.getSessionEvents(created.sessionId), [event]);

  const scriptResponse = await fetch(`${bridge.origin}/assets/youtube-player.js`);
  const script = await scriptResponse.text();
  assert.match(script, /window\.history\.replaceState/);
  assert.match(script, /origin: window\.location\.origin/);
  assert.match(script, /enablejsapi: 1/);
  assert.match(script, /strict-origin-when-cross-origin/);
  assert.doesNotMatch(script, new RegExp(claimToken));
});

test('expired sessions and non-loopback bind attempts fail closed', async () => {
  assert.throws(() => new ContentBridgePrototype({ host: '0.0.0.0' }), /must bind to 127\.0\.0\.1/);

  let now = 1000;
  const bridge = new ContentBridgePrototype({ now: () => now });
  await bridge.start();
  try {
    const created = bridge.createYouTubeSession({ videoIds: ['3_TvpBwSZDM'], ttlMs: 100 });
    now += 101;
    const response = await fetch(created.url);
    assert.equal(response.status, 404);
  } finally {
    await bridge.stop();
  }
});
