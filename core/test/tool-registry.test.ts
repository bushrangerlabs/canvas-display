/**
 * Tests for the tool registry.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkToolPolicyBatch,
  ToolRegistry,
} from '../src/tool-registry.js';

describe('Tool registry', () => {
  test('listTools returns all registered tools', () => {
    const tools = new ToolRegistry().listTools();
    assert.ok(tools.length >= 8);
  });

  test('listTools returns the built-in tool names', () => {
    const names = new ToolRegistry().listTools().map((tool) => tool.name);
    assert.ok(names.includes('ha.toggle'));
    assert.ok(names.includes('ha.set_value'));
    assert.ok(names.includes('media.play'));
    assert.ok(names.includes('media.pause'));
    assert.ok(names.includes('brightness.set'));
    assert.ok(names.includes('scene.activate'));
    assert.ok(names.includes('navigate.page'));
    assert.ok(names.includes('query.status'));
  });

  test('getTool returns a tool by name', () => {
    const def = new ToolRegistry().getTool('ha.toggle');
    assert.ok(def);
    assert.equal(def?.name, 'ha.toggle');
    assert.equal(def?.requiredRole, 'voice');
  });

  test('getTool returns undefined for unknown tool', () => {
    const def = new ToolRegistry().getTool('nonexistent');
    assert.equal(def, undefined);
  });

  test('media.play dispatches to the originating device', async () => {
    const calls: Array<{ query: string; source: string; deviceId?: string }> = [];
    const result = await new ToolRegistry().executeTool(
      'media.play',
      { query: 'Bohemian Rhapsody', source: 'youtube' },
      {
        principal: 'voice_user',
        role: 'voice',
        deviceId: 'pi-kitchen',
        playMedia: async (query, source, deviceId) => {
          calls.push({ query, source, deviceId });
          return { ok: true, message: 'started' };
        },
      },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [{
      query: 'Bohemian Rhapsody',
      source: 'youtube',
      deviceId: 'pi-kitchen',
    }]);
  });

  test('media.play refuses playback without an originating device', async () => {
    let dispatched = false;
    const result = await new ToolRegistry().executeTool(
      'media.play',
      { query: 'Bohemian Rhapsody', source: 'youtube' },
      {
        principal: 'voice_user',
        role: 'voice',
        playMedia: async () => {
          dispatched = true;
          return { ok: true, message: 'unexpected' };
        },
      },
    );
    assert.equal(result.ok, false);
    assert.match(result.message, /which display/i);
    assert.equal(dispatched, false);
  });

  test('media controls dispatch each action to the originating device', async () => {
    const calls: string[] = [];
    const registry = new ToolRegistry();
    const context = {
      principal: 'voice_user',
      role: 'voice' as const,
      deviceId: 'pi-lounge',
      controlMedia: async (action: 'pause' | 'resume' | 'stop' | 'next', source: string, deviceId?: string) => {
        calls.push(`${action}:${source}:${deviceId}`);
        return { ok: true, message: action };
      },
    };
    for (const tool of ['media.pause', 'media.resume', 'media.stop', 'media.next']) {
      const result = await registry.executeTool(tool, {}, context);
      assert.equal(result.ok, true);
    }
    assert.deepEqual(calls, [
      'pause:youtube:pi-lounge',
      'resume:youtube:pi-lounge',
      'stop:youtube:pi-lounge',
      'next:youtube:pi-lounge',
    ]);
  });

  test('checkToolPolicyBatch passes for read tools with no_mutations constraint', () => {
    const results = checkToolPolicyBatch(
      [{ tool: 'ha.get_state', arguments: { entity_id: 'sensor.temperature' } }],
      { no_mutations: true },
    );
    assert.equal(results[0].passed, true);
  });

  test('checkToolPolicyBatch blocks write tools with no_mutations constraint', () => {
    const results = checkToolPolicyBatch(
      [{ tool: 'ha.call_service', arguments: { domain: 'light', service: 'turn_on', service_data: { entity_id: 'light.kitchen' } } }],
      { no_mutations: true },
    );
    assert.equal(results[0].passed, false);
    assert.ok(results[0].reason?.includes('mutating'));
  });

  test('checkToolPolicyBatch blocks unknown tools (empty name)', () => {
    const results = checkToolPolicyBatch(
      [{ tool: '', arguments: {} }],
    );
    assert.equal(results[0].passed, false);
  });

  test('checkToolPolicyBatch enforces domain allowlist', () => {
    const results = checkToolPolicyBatch(
      [{ tool: 'ha.call_service', arguments: { domain: 'lock', service: 'unlock', service_data: { entity_id: 'lock.door' } } }],
      { entity_allowlist: ['light.*', 'switch.*'] },
    );
    assert.equal(results[0].passed, false);
    assert.ok(results[0].reason?.includes('allowlist'));
  });

  test('checkToolPolicyBatch enforces max intensity', () => {
    const results = checkToolPolicyBatch(
      [{ tool: 'ha.call_service', arguments: { domain: 'light', service: 'turn_on', service_data: { entity_id: 'light.kitchen', brightness_pct: 200 } } }],
      { max_intensity: 100 },
    );
    assert.equal(results[0].passed, false);
    assert.ok(results[0].reason?.includes('exceeds'));
  });

  test('checkToolPolicyBatch handles temperature range', () => {
    const results = checkToolPolicyBatch(
      [{ tool: 'ha.call_service', arguments: { domain: 'climate', service: 'set_temperature', service_data: { entity_id: 'climate.thermostat', temperature: 100 } } }],
      { temperature_range: [60, 90] },
    );
    assert.equal(results[0].passed, false);
    assert.ok(results[0].reason?.includes('outside'));
  });

  test('checkToolPolicyBatch checks multiple tool calls', () => {
    const results = checkToolPolicyBatch(
      [
        { tool: 'ha.get_state', arguments: { entity_id: 'sensor.temp' } },
        { tool: 'ha.call_service', arguments: { domain: 'light', service: 'turn_on', service_data: { entity_id: 'light.kitchen' } } },
      ],
      { no_mutations: true },
    );
    assert.equal(results.length, 2);
    assert.equal(results[0].passed, true);
    assert.equal(results[1].passed, false);
  });

  test('registry exposes confirmation requirements', () => {
    const registry = new ToolRegistry();
    assert.equal(registry.requiresConfirmation('mcp.call'), true);
    assert.equal(registry.requiresConfirmation('ha.toggle'), false);
  });
});
