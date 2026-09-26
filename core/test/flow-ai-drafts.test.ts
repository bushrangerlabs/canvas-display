import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { FlowRepository, migrateFlowsTable } from '../src/flows.js';
import { migrateFlowAiDraftsTable, runAutomationGapDetection, validateAiFlowDefinition } from '../src/flow-ai-drafts.js';
import type { LlmProvider } from '../src/providers/llm.js';

async function setup() {
  const db = newDb();
  db.public.registerFunction({ name: 'gen_random_uuid', returns: 'uuid' as never, implementation: () => randomUUID() });
  db.public.registerFunction({
    name: 'regexp_replace',
    args: ['text' as never, 'text' as never, 'text' as never, 'text' as never],
    returns: 'text' as never,
    implementation: (source: string, pattern: string, replacement: string, flags: string) =>
      source.replace(new RegExp(pattern, flags.includes('g') ? 'g' : ''), replacement),
  });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool() as unknown as Pool;
  await pool.query(`
    CREATE TABLE voice_turns (
      turn_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, transcript TEXT, reply TEXT,
      intent TEXT, tool_calls JSONB, knowledge_card JSONB,
      feedback SMALLINT, feedback_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await migrateFlowsTable(pool);
  await migrateFlowAiDraftsTable(pool);
  return { pool, flowRepo: new FlowRepository(pool) };
}

function fakeLlm(reply: string): LlmProvider {
  return {
    name: 'test',
    chat: async () => reply,
    chatWithTools: async () => ({ content: '', toolCalls: [] }),
    healthCheck: async () => ({ name: 'test', healthy: true }),
  };
}

const validFlowJson = JSON.stringify({
  name: 'Movie night lights',
  description: 'Dims the lounge lights when asked for movie night',
  nodes: [
    { id: 'n1', type: 'trigger_voice', position: { x: 0, y: 0 }, config: { phrases: ['movie night lights'] } },
    { id: 'n2', type: 'action_ha_service', position: { x: 200, y: 0 }, config: { domain: 'light', service: 'turn_on', entity_id: 'light.lounge', data: { brightness_pct: 10 } } },
  ],
  edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
});

test('validateAiFlowDefinition rejects invented node types', () => {
  const result = validateAiFlowDefinition({
    name: 'Bad', nodes: [{ id: 'n1', type: 'shell_exec', config: {} }], edges: [],
  });
  assert.equal(result.ok, false);
});

test('validateAiFlowDefinition rejects flows with no trigger node', () => {
  const result = validateAiFlowDefinition({
    name: 'Bad', nodes: [{ id: 'n1', type: 'action_log', config: {} }], edges: [],
  });
  assert.equal(result.ok, false);
});

test('validateAiFlowDefinition accepts a well-formed flow', () => {
  const result = validateAiFlowDefinition(JSON.parse(validFlowJson));
  assert.equal(result.ok, true);
});

test('gap detection drafts a disabled flow for a recurring AI-fallback transcript, and never redrafts it', async () => {
  const { pool, flowRepo } = await setup();
  for (let i = 0; i < 3; i++) {
    await pool.query(
      `INSERT INTO voice_turns (turn_id, device_id, transcript, reply, intent, tool_calls)
       VALUES ($1, 'dev', 'movie night lights please', 'ok', 'unknown', $2::jsonb)`,
      [`turn-${i}`, JSON.stringify([{ tool: 'ha.call_service', arguments: { domain: 'light', service: 'turn_on' } }])],
    );
  }

  const results = await runAutomationGapDetection(pool, flowRepo, fakeLlm(`\`\`\`json\n${validFlowJson}\n\`\`\``));
  assert.equal(results.length, 1);
  assert.equal(results[0].drafted, true);

  const flows = await flowRepo.list();
  assert.equal(flows.length, 1);
  assert.equal(flows[0].enabled, false);

  // Running again must not create a second draft for the same pattern.
  const secondPass = await runAutomationGapDetection(pool, flowRepo, fakeLlm(validFlowJson));
  assert.equal(secondPass.length, 0);
  assert.equal((await flowRepo.list()).length, 1);
});

test('gap detection gives up after repeated invalid drafts instead of retrying forever', async () => {
  const { pool, flowRepo } = await setup();
  for (let i = 0; i < 3; i++) {
    await pool.query(
      `INSERT INTO voice_turns (turn_id, device_id, transcript, reply, intent, tool_calls)
       VALUES ($1, 'dev', 'do the thing', 'ok', 'unknown', $2::jsonb)`,
      [`turn-bad-${i}`, JSON.stringify([{ tool: 'ha.call_service' }])],
    );
  }
  const badLlm = fakeLlm('not valid json at all');
  for (let attempt = 0; attempt < 4; attempt++) {
    await runAutomationGapDetection(pool, flowRepo, badLlm);
  }
  assert.equal((await flowRepo.list()).length, 0);
  const attemptsRow = await pool.query('SELECT attempts, drafted_flow_id FROM flow_ai_draft_attempts');
  assert.equal(attemptsRow.rows[0].drafted_flow_id, null);
  assert.ok(attemptsRow.rows[0].attempts >= 3);
});
