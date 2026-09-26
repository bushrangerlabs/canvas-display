import assert from 'node:assert/strict';
import test from 'node:test';
import { executeDirectHaPlan, handleDirectHaCommand, handleIndexedVoiceCommand, type HaEntityCandidate } from '../src/direct-ha-control.js';

const kitchenLight: HaEntityCandidate = {
  entityId: 'light.kitchen_lights',
  friendlyName: 'Kitchen Lights',
  domain: 'light',
  state: 'off',
  areaName: 'Kitchen',
  aliases: ['movie lamps'],
};

function fakeHa() {
  const calls: Array<{ domain: string; service: string; data: Record<string, unknown> }> = [];
  return {
    calls,
    client: {
      async callService(domain: string, service: string, data: Record<string, unknown>) {
        calls.push({ domain, service, data });
        return [{ entityId: String(data.entity_id), state: 'on', attributes: {} }];
      },
    },
  };
}

test('direct control resolves a cached custom alias and calls HA without an LLM', async () => {
  const ha = fakeHa();
  const result = await handleDirectHaCommand('turn on movie lamps', [kitchenLight], ha.client as any);

  assert.deepEqual(ha.calls, [{ domain: 'light', service: 'turn_on', data: { entity_id: 'light.kitchen_lights' } }]);
  assert.equal(result?.route, 'direct');
  assert.equal(result?.reply, 'Kitchen Lights on.');
});

test('a malformed transcript cannot execute direct control without a parsed command', async () => {
  const ha = fakeHa();
  const result = await handleDirectHaCommand('turn on the disc wire', [kitchenLight], ha.client as any);

  assert.equal(result, null);
  assert.equal(ha.calls.length, 0);
});

test('direct control prioritizes an exact entity name over a matching device name', async () => {
  const ha = fakeHa();
  const nearbyLight: HaEntityCandidate = {
    entityId: 'light.kitchen_bench', friendlyName: 'Bench Downlight', domain: 'light', state: 'off', deviceName: 'Kitchen Light',
  };
  const result = await handleDirectHaCommand('turn on kitchen light', [kitchenLight, nearbyLight], ha.client as any);

  assert.equal(result?.route, 'direct');
  assert.equal(ha.calls[0]?.data.entity_id, 'light.kitchen_lights');
});

test('direct control asks for clarification when cached candidates are ambiguous', async () => {
  const ha = fakeHa();
  const candidates: HaEntityCandidate[] = [
    { ...kitchenLight, entityId: 'light.kitchen_ceiling', friendlyName: 'Kitchen Lights Ceiling' },
    { ...kitchenLight, entityId: 'light.kitchen_bench', friendlyName: 'Kitchen Lights Bench' },
  ];
  const result = await handleDirectHaCommand('turn on kitchen lights', candidates, ha.client as any);

  assert.equal(result?.route, 'clarification');
  assert.equal(ha.calls.length, 0);
});

test('direct control requires confirmation for a sensitive garage cover', async () => {
  const ha = fakeHa();
  const garage: HaEntityCandidate = {
    entityId: 'cover.garage_door', friendlyName: 'Garage Door', domain: 'cover', state: 'closed', areaName: 'Garage',
  };
  const result = await handleDirectHaCommand('open garage door', [garage], ha.client as any);

  assert.equal(result?.requiresConfirmation, true);
  assert.equal(result?.route, 'clarification');
  assert.equal(ha.calls.length, 0);
});

test('a confirmed direct plan invokes only its original typed service', async () => {
  const ha = fakeHa();
  await executeDirectHaPlan({
    entityId: 'cover.garage_door', domain: 'cover', service: 'open_cover', data: {},
  }, ha.client as any);

  assert.deepEqual(ha.calls, [{ domain: 'cover', service: 'open_cover', data: { entity_id: 'cover.garage_door' } }]);
});

test('generated exact command executes its mapped typed service', async () => {
  const ha = fakeHa();
  const result = await handleIndexedVoiceCommand([{
    entityId: 'light.kitchen_lights', domain: 'light', action: 'turn_on', service: 'turn_on',
    priority: 100, requiresConfirmation: false, friendlyName: 'Kitchen Lights', state: 'off',
  }], ha.client as any);

  assert.equal(result?.route, 'direct');
  assert.deepEqual(ha.calls, [{ domain: 'light', service: 'turn_on', data: { entity_id: 'light.kitchen_lights' } }]);
});

test('generated command collisions require clarification without a service call', async () => {
  const ha = fakeHa();
  const result = await handleIndexedVoiceCommand([
    { entityId: 'light.kitchen_ceiling', domain: 'light', action: 'turn_on', service: 'turn_on', priority: 100, requiresConfirmation: false, state: 'off' },
    { entityId: 'light.kitchen_bench', domain: 'light', action: 'turn_on', service: 'turn_on', priority: 100, requiresConfirmation: false, state: 'off' },
  ], ha.client as any);

  assert.equal(result?.route, 'clarification');
  assert.equal(ha.calls.length, 0);
});