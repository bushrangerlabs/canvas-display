import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const serverDir = fileURLToPath(new URL('../', import.meta.url));

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reservePort() {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  assert(address && typeof address === 'object');
  const port = address.port;
  listener.close();
  await once(listener, 'close');
  return port;
}

async function requestJson(baseUrl, path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  assert.equal(response.ok, true, `${init?.method ?? 'GET'} ${path} failed (${response.status}): ${text}`);
  return text ? JSON.parse(text) : undefined;
}

async function waitForServer(baseUrl, child, output) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited before becoming healthy (${child.exitCode})\n${output()}`);
    }
    try {
      const health = await requestJson(baseUrl, '/health');
      if (health?.ok === true) return;
    } catch {
      // Server startup races are expected while SQLite migrations run.
    }
    await delay(100);
  }
  throw new Error(`Server did not become healthy\n${output()}`);
}

function waitForOpen(ws, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for WebSocket open')), timeoutMs);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForMessage(ws, predicate, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('Timed out waiting for WebSocket message'));
    }, timeoutMs);

    function onMessage(data) {
      try {
        const message = JSON.parse(data.toString());
        if (!predicate(message)) return;
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(message);
      } catch (err) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        reject(err);
      }
    }

    ws.on('message', onMessage);
  });
}

async function waitForDeviceOffline(baseUrl, deviceId) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const devices = await requestJson(baseUrl, '/api/devices');
    const device = devices.find((entry) => entry.id === deviceId);
    if (device && device.online === false) return;
    await delay(50);
  }
  throw new Error(`Device ${deviceId} remained online after its socket closed`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const result = await Promise.race([exited, delay(5_000).then(() => null)]);
  if (result === null && child.exitCode === null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}

const tempDir = await mkdtemp(join(tmpdir(), 'canvas-display-smoke-'));
const port = await reservePort();
const baseUrl = `http://127.0.0.1:${port}`;
let output = '';
let ws;

const child = spawn(process.execPath, ['dist/bundle.js'], {
  cwd: serverDir,
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    DB_PATH: join(tempDir, 'canvas-display.db'),
    DATA_DIR: tempDir,
    IMAGES_DIR: join(tempDir, 'images'),
    STATIC_DIR: join(serverDir, 'public'),
    YOUTUBE_PLAYER_ORIGIN: baseUrl,
    LOG_LEVEL: 'error',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.stdout.on('data', (chunk) => { output += chunk.toString(); });
child.stderr.on('data', (chunk) => { output += chunk.toString(); });

try {
  await waitForServer(baseUrl, child, () => output);

  const pages = await requestJson(baseUrl, '/api/pages');
  assert(Array.isArray(pages), 'GET /api/pages must return an array');

  await requestJson(baseUrl, '/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ youtube_api_key: 'smoke-secret-key' }),
  });
  const maskedSettings = await requestJson(baseUrl, '/api/settings');
  assert.equal(maskedSettings.youtube_api_key, '••••••••');
  await requestJson(baseUrl, '/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ youtube_api_key: '' }),
  });
  const clearedSettings = await requestJson(baseUrl, '/api/settings');
  assert.equal(clearedSettings.youtube_api_key, '');

  const initialDevices = await requestJson(baseUrl, '/api/devices');
  assert.deepEqual(initialDevices, []);

  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await waitForOpen(ws);

  const helloAckPromise = waitForMessage(ws, (message) => message.type === 'hello_ack');
  ws.send(JSON.stringify({
    type: 'hello',
    protocol_version: 1,
    client_type: 'browser',
    device_id: 'smoke-linux-device',
    device_name: 'Smoke Linux Display',
    platform: 'linux',
    app_version: '0.2.23-smoke',
    screen_width: 1920,
    screen_height: 1080,
    pixel_ratio: 1,
  }));

  const helloAck = await helloAckPromise;
  assert.equal(helloAck.protocol_version, 1);
  assert.equal(helloAck.device_id, 'smoke-linux-device');
  assert.equal(helloAck.registered, true);

  const devices = await requestJson(baseUrl, '/api/devices');
  assert.equal(devices.length, 1);
  assert.equal(devices[0].id, 'smoke-linux-device');
  assert.equal(devices[0].name, 'Smoke Linux Display');
  assert.equal(devices[0].platform, 'linux');
  assert.equal(devices[0].app_version, '0.2.23-smoke');
  assert.equal(devices[0].screen_width, 1920);
  assert.equal(devices[0].screen_height, 1080);
  assert.equal(devices[0].online, true);

  const youtubeCommandPromise = waitForMessage(
    ws,
    (message) => message.type === 'command' && message.action === 'show_floating',
  );
  const youtubePlayback = await requestJson(baseUrl, '/api/media/play', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Host: 'attacker.invalid' },
    body: JSON.stringify({ source: 'youtube', url: '3_TvpBwSZDM' }),
  });
  assert.equal(youtubePlayback.video_id, '3_TvpBwSZDM');
  assert.equal(youtubePlayback.video_url, 'https://www.youtube.com/watch?v=3_TvpBwSZDM');
  assert.equal(youtubePlayback.candidate_count, 1);
  assert.match(youtubePlayback.url, /\/api\/media\/youtube\/player\/3_TvpBwSZDM\?/);
  assert.equal(new URL(youtubePlayback.url).origin, baseUrl);
  assert.equal(new URL(youtubePlayback.url).searchParams.get('playback_id'), youtubePlayback.playback_id);

  const youtubeCommand = await youtubeCommandPromise;
  assert.equal(youtubeCommand.payload.url, youtubePlayback.url);

  const playerResponse = await fetch(youtubePlayback.url);
  assert.equal(playerResponse.ok, true);
  assert.equal(playerResponse.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  const playerHtml = await playerResponse.text();
  assert.match(playerHtml, /origin: window\.location\.origin/);
  assert.match(playerHtml, /youtube\.com\/iframe_api/);
  assert.match(playerHtml, /candidate_switch/);

  await requestJson(baseUrl, '/api/media/youtube/player-event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      playback_id: youtubePlayback.playback_id,
      event: 'playing',
      video_id: youtubePlayback.video_id,
      candidate_index: 0,
      candidate_count: 1,
    }),
  });
  const youtubeStatusResponse = await fetch(`${baseUrl}/api/media/youtube/status`);
  assert.equal(youtubeStatusResponse.headers.get('cache-control'), 'no-store');
  const youtubeStatus = await youtubeStatusResponse.json();
  assert.equal(youtubeStatus.status, 'playing');
  assert.equal(youtubeStatus.video_id, '3_TvpBwSZDM');

  const stopYoutubePromise = waitForMessage(
    ws,
    (message) => message.type === 'command' && message.action === 'stop_youtube',
  );
  const hideFloatingPromise = waitForMessage(
    ws,
    (message) => message.type === 'command' && message.action === 'hide_floating',
  );
  await requestJson(baseUrl, '/api/media/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'youtube', action: 'stop' }),
  });
  await Promise.all([stopYoutubePromise, hideFloatingPromise]);

  await requestJson(baseUrl, '/api/media/youtube/player-event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      playback_id: youtubePlayback.playback_id,
      event: 'playing',
      video_id: youtubePlayback.video_id,
      candidate_index: 0,
      candidate_count: 1,
    }),
  });
  const stoppedYoutubeStatus = await requestJson(baseUrl, '/api/media/youtube/status');
  assert.equal(stoppedYoutubeStatus.status, 'stopped');
  assert.equal(stoppedYoutubeStatus.playback_id, '');

  const commandPromise = waitForMessage(ws, (message) => message.type === 'command');
  const accepted = await requestJson(baseUrl, '/api/devices/smoke-linux-device/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'reload', payload: { reason: 'smoke-test' } }),
  });
  assert.equal(typeof accepted.command_id, 'number');

  const command = await commandPromise;
  assert.equal(command.device_id, 'smoke-linux-device');
  assert.equal(command.action, 'reload');
  assert.equal(command.payload.reason, 'smoke-test');

  const renamed = await requestJson(baseUrl, '/api/devices/smoke-linux-device', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Server Managed Display' }),
  });
  assert.equal(renamed.name, 'Server Managed Display');

  const firstClose = once(ws, 'close');
  ws.close();
  await firstClose;
  await waitForDeviceOffline(baseUrl, 'smoke-linux-device');

  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await waitForOpen(ws);
  const reconnectAckPromise = waitForMessage(ws, (message) => message.type === 'hello_ack');
  ws.send(JSON.stringify({
    type: 'hello',
    client_type: 'browser',
    device_id: 'smoke-linux-device',
    device_name: 'Client Name Must Not Overwrite Server Name',
    platform: 'linux',
    app_version: '0.2.24-smoke',
    screen_width: 1280,
    screen_height: 720,
    pixel_ratio: 2,
  }));

  const reconnectAck = await reconnectAckPromise;
  assert.equal(reconnectAck.registered, false);

  const reconnectedDevices = await requestJson(baseUrl, '/api/devices');
  assert.equal(reconnectedDevices[0].name, 'Server Managed Display');
  assert.equal(reconnectedDevices[0].app_version, '0.2.24-smoke');
  assert.equal(reconnectedDevices[0].screen_width, 1280);
  assert.equal(reconnectedDevices[0].online, true);

  const finalClose = once(ws, 'close');
  ws.close();
  await finalClose;
  await waitForDeviceOffline(baseUrl, 'smoke-linux-device');

  console.log('Server smoke test passed: health, pages, device persistence, reconnects, and WebSocket commands');
} catch (err) {
  console.error(output);
  throw err;
} finally {
  ws?.terminate();
  await stopChild(child);
  await rm(tempDir, { recursive: true, force: true });
}
