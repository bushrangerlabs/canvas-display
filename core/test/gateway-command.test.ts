import assert from 'node:assert/strict';
import test from 'node:test';
import { commandRequestDigest, GatewayController } from '../src/gateway.js';

test('diagnostics.echo request digest matches the frozen cross-language fixture', () => {
  assert.equal(
    commandRequestDigest('diagnostics.echo', 1, { message: 'hello edge' }),
    'sha256:14936abe504f227d7748780024d679125eadb53c069397bcd5f61fca698c1c4f',
  );
});

test('device action results are bound to the authenticated device connection', async () => {
  const controller = new GatewayController();
  let sent = '';
  const socket = {
    OPEN: 1,
    readyState: 1,
    send(value: string, callback?: (error?: Error) => void) {
      sent = value;
      callback?.();
    },
  };
  controller.attach('device-a', {
    ws: socket as never,
    coreStreamEpoch: 'core-1',
    authorityEpoch: 'authority-1',
    nextCoreSequence: 1,
  });

  const pending = controller.requestAction('device-a', 'app.hide', {}, 1_000);
  const requestId = JSON.parse(sent).request_id as string;
  const result = { type: 'device.action_result', request_id: requestId, payload: { ok: true } };

  assert.equal(controller.observe(result, 'device-b'), false);
  assert.equal(controller.observe(result, 'device-a'), true);
  assert.deepEqual(await pending, { ok: true });
});
