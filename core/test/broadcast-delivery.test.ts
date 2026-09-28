import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BroadcastDeliveryService } from '../src/broadcast-delivery.js';

test('DLNA refresh ages discovered renderers without disabling manual registrations', async () => {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const pool = {
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      return { rows: [], rowCount: 0 };
    },
  };
  const service = new BroadcastDeliveryService(pool as never);

  await service.markDiscoveredDlnaOffline();

  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /route_type='dlna'/);
  assert.match(calls[0].text, /route_key NOT LIKE 'manual:%'/);
});
