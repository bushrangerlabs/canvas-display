import assert from 'node:assert/strict';
import test from 'node:test';
import { mcpCallRequiresConfirmation, mcpToolRequiresConfirmation, normalizeToolArguments, requiresExternalLookup, resolveToolName, selectToolsForRequest } from '../src/mcp-policy.js';
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

test('generic questions with common stopwords (is/it/what) do not spuriously match unrelated tools', () => {
  // Regression: "what time is it" was matching dozens of unrelated ha-mcp tools
  // purely because "is"/"it"/"what" appear in their descriptions, bloating the
  // prompt sent to small-context local models with irrelevant tool schemas.
  const tools = [
    tool('mcp.ha-mcp.ha_get_state', 'Read whether a Home Assistant entity is currently on or off'),
    tool('mcp.ha-mcp.ha_call_service', 'Call a Home Assistant service to control a device'),
    tool('mcp.ha-mcp.ha_search', 'Search for it in the entity catalogue by name'),
    tool('mcp.afl-mcp.get_afl_teams', 'List AFL teams'),
  ];
  const selected = selectToolsForRequest(tools, 'what time is it');
  assert.equal(selected.length, 0);
});

test('tool selection stays within a strict small-model budget for generic prompts', () => {
  const tools = Array.from({ length: 30 }, (_, index) => tool(
    `mcp.ha-mcp.tool_${index}`,
    'Read or control the bedroom fan and related smart-home state',
  ));

  const selected = selectToolsForRequest(tools, 'turn on the bedroom fan');
  assert.ok(selected.length <= 8, `expected <= 8 selected tools, got ${selected.length}`);
});

test('tool selection budgets serialized schemas, not only tool count', () => {
  const largeSchema = {
    type: 'object',
    properties: { payload: { type: 'string', description: 'x'.repeat(9_000) } },
  };
  const tools = Array.from({ length: 3 }, (_, index) => ({
    ...tool(`mcp.ha-mcp.fan_tool_${index}`, 'Control the bedroom fan'),
    schema: largeSchema,
  }));

  const selected = selectToolsForRequest(tools, 'control the bedroom fan');
  assert.equal(selected.length, 0);
});

test('tool aliases resolve to the unique canonical MCP name', () => {
  const tools = [
    tool('mcp.ha-mcp.ha_get_state', 'Read Home Assistant state'),
    tool('mcp.ha-mcp.ha_search', 'Search Home Assistant entities'),
  ];
  assert.equal(resolveToolName('ha-get-state', tools), 'mcp.ha-mcp.ha_get_state');
  assert.equal(resolveToolName('mcp.ha-mcp.ha_search', tools), 'mcp.ha-mcp.ha_search');
  assert.equal(resolveToolName('get-state', tools), undefined);
});

test('status questions select read-only state tools instead of service calls', () => {
  const tools = [
    tool('mcp.ha-mcp.ha_call_service', 'Call a Home Assistant service to control a light'),
    tool('mcp.ha-mcp.ha_get_state', 'Read the current state of a Home Assistant light or entity'),
  ];
  const selected = selectToolsForRequest(tools, 'is the desk light on');
  assert.deepEqual(selected.map(item => item.name), ['mcp.ha-mcp.ha_get_state']);
});

test('normalizes xLAM HA argument shapes before execution', () => {
  assert.deepEqual(
    normalizeToolArguments('mcp.ha-mcp.ha_call_service', {
      domain: 'light', service: 'turn_off', service_data: { entity_id: 'light.desk' },
    }),
    { domain: 'light', service: 'turn_off', entity_id: 'light.desk' },
  );
  assert.deepEqual(
    normalizeToolArguments('mcp.ha-mcp.ha_get_state', { entity_id: 'sun' }),
    { entity_id: 'sun.sun' },
  );
});

test('stable factual questions stay with the model', () => {
  const tools = [
    tool('mcp.web.web_search', 'Search the web for current information'),
    tool('mcp.web.wikipedia_lookup', 'Look up an encyclopedic topic on Wikipedia'),
    tool('mcp.ha-mcp.ha_get_state', 'Read Home Assistant entity state'),
  ];
  const selected = selectToolsForRequest(tools, 'how tall is Big Ben');
  assert.deepEqual(selected.map(item => item.name), []);
  assert.equal(requiresExternalLookup('how tall is Big Ben'), false);
});

test('explicit current lookup requests expose web and Wikipedia tools', () => {
  const tools = [
    tool('mcp.web.web_search', 'Search the web for current information'),
    tool('mcp.web.wikipedia_lookup', 'Look up an encyclopedic topic on Wikipedia'),
    tool('mcp.ha-mcp.ha_get_state', 'Read Home Assistant entity state'),
  ];
  const selected = selectToolsForRequest(tools, 'search online for the latest Big Ben height');
  assert.deepEqual(selected.map(item => item.name), ['mcp.web.wikipedia_lookup', 'mcp.web.web_search']);
});
