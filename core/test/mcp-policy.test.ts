import assert from 'node:assert/strict';
import test from 'node:test';
import { mcpCallRequiresConfirmation, mcpToolRequiresConfirmation, selectToolsForRequest } from '../src/mcp-policy.js';
import type { ToolDefinition } from '../src/tool-registry.js';

const tool = (name: string, description: string): ToolDefinition => ({
  name, description, schema: { type: 'object', properties: {} }, requiredRole: 'voice',
  requiresConfirmation: mcpToolRequiresConfirmation(name),
  executor: async () => ({ ok: true, message: 'ok' }),
});

test('ordinary light controls do not prompt but risky HA services do', () => {
  assert.equal(mcpCallRequiresConfirmation('mcp.ha-mcp.ha_call_service', { domain: 'light', service: 'turn_on', entity_id: 'light.kitchen' }), false);
  assert.equal(mcpCallRequiresConfirmation('mcp.ha-mcp.ha_call_service', { domain: 'lock', service: 'unlock', entity_id: 'lock.front_door' }), true);
  assert.equal(mcpCallRequiresConfirmation('mcp.ha-mcp.ha_restart', { confirm: true }), true);
});

test('MCP mutation policy distinguishes reads from changes', () => {
  assert.equal(mcpToolRequiresConfirmation('ha-mcp.ha_get_state'), false);
  assert.equal(mcpToolRequiresConfirmation('ha-mcp.ha_search'), false);
  assert.equal(mcpToolRequiresConfirmation('ha-mcp.ha_call_service'), true);
  assert.equal(mcpToolRequiresConfirmation('ha-mcp.ha_restart'), true);
  assert.equal(mcpToolRequiresConfirmation('ha-mcp.ha_config_set_scene'), true);
});

test('MCP selection returns relevant tools and excludes unrelated schemas', () => {
  const tools = [
    tool('mcp.afl-mcp.get_afl_teams', 'List AFL teams'),
    tool('mcp.ha-mcp.ha_get_state', 'Read Home Assistant entity state'),
    tool('mcp.ha-mcp.ha_restart', 'Restart Home Assistant'),
  ];
  const selected = selectToolsForRequest(tools, 'How many AFL teams are there?');
  assert.deepEqual(selected.map(item => item.name), ['mcp.afl-mcp.get_afl_teams']);
});

test('Australian weather requests strongly select BOM weather tools', () => {
  const tools = [
    tool('mcp.au-weather.get_weather_for_location', 'Get comprehensive Australian weather for a suburb or postcode'),
    tool('mcp.ha-mcp.ha_get_state', 'Read Home Assistant entity state'),
    tool('mcp.afl-mcp.get_afl_teams', 'List AFL teams'),
  ];
  const selected = selectToolsForRequest(tools, 'What is the weather forecast for Parkdale?');
  assert.equal(selected[0]?.name, 'mcp.au-weather.get_weather_for_location');
  assert.equal(selected.some(item => item.name === 'mcp.afl-mcp.get_afl_teams'), false);
});
