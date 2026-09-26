/**
 * Automation gap detection + AI-authored flow drafting.
 *
 * Canvas Skill v1 (prompt-based, AI-drafted, admin-approved automations) was
 * removed in v0.2.37 in favor of the visual Flow engine (flows.ts). This module
 * restores the "AI notices a gap and proposes a fix" capability on top of that
 * engine instead of reviving the old Skills system.
 *
 * Signal: a normalized transcript that repeatedly required the full AI
 * tool-calling fallback (intent = 'unknown', but tool_calls is non-empty,
 * meaning the AI successfully handled it via MCP tools with no deterministic
 * route or existing flow). When the same pattern recurs, the AI is asked to
 * draft a Flow definition that would handle it directly next time.
 *
 * Safety: every draft is created via FlowRepository.create(), which always
 * inserts with enabled=false (see flows.ts). There is no AI-callable path to
 * enable a flow — an administrator must review and enable it from the Flow
 * editor, exactly like a manually authored flow.
 */
import type { Pool } from 'pg';
import type { LlmProvider } from './providers/llm.js';
import type { ChatMessage } from './providers/types.js';
import { type FlowDefinition, type NodeType, FlowRepository } from './flows.js';

const VALID_NODE_TYPES: ReadonlySet<NodeType> = new Set([
  'trigger_voice', 'trigger_schedule', 'trigger_ha_state', 'trigger_webhook', 'trigger_manual', 'trigger_intent',
  'action_ha_service', 'action_tts', 'action_scene', 'action_switch_page', 'action_delay', 'action_http',
  'action_set_variable', 'action_ai_reply', 'action_send_intent', 'action_load_url', 'action_knowledge_card',
  'action_broadcast_alert', 'action_broadcast_intercom', 'action_device_command', 'action_log',
  'logic_if_else', 'logic_switch', 'logic_for_each',
]);

const GAP_THRESHOLD = 3;
const MAX_ATTEMPTS = 3;
const LOOKBACK_DAYS = 14;

function normalizePattern(transcript: string): string {
  return transcript.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export async function migrateFlowAiDraftsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS flow_ai_draft_attempts (
      pattern         TEXT PRIMARY KEY,
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TIMESTAMPTZ,
      drafted_flow_id TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

/** Structural validation of an AI-produced flow definition. Rejects invented node types independent of what the model claims. */
export function validateAiFlowDefinition(raw: unknown): { ok: true; definition: FlowDefinition } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not_an_object' };
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== 'string' || !obj.name.trim()) return { ok: false, reason: 'missing_name' };
  if (!Array.isArray(obj.nodes) || obj.nodes.length === 0 || obj.nodes.length > 20) return { ok: false, reason: 'invalid_nodes' };
  if (!Array.isArray(obj.edges) || obj.edges.length > 40) return { ok: false, reason: 'invalid_edges' };
  const nodeIds = new Set<string>();
  for (const node of obj.nodes as Array<Record<string, unknown>>) {
    if (typeof node.id !== 'string' || !node.id) return { ok: false, reason: 'node_missing_id' };
    if (typeof node.type !== 'string' || !VALID_NODE_TYPES.has(node.type as NodeType)) {
      return { ok: false, reason: `invalid_node_type:${String(node.type)}` };
    }
    if (typeof node.config !== 'object' || node.config === null) return { ok: false, reason: 'node_missing_config' };
    nodeIds.add(node.id);
  }
  for (const edge of obj.edges as Array<Record<string, unknown>>) {
    if (typeof edge.source !== 'string' || typeof edge.target !== 'string') return { ok: false, reason: 'edge_missing_endpoints' };
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) return { ok: false, reason: 'edge_references_unknown_node' };
  }
  const hasTrigger = (obj.nodes as Array<{ type: string }>).some(node => node.type.startsWith('trigger_'));
  if (!hasTrigger) return { ok: false, reason: 'missing_trigger_node' };
  return {
    ok: true,
    definition: {
      schemaVersion: 1,
      name: obj.name.trim().slice(0, 120),
      description: typeof obj.description === 'string' ? obj.description.slice(0, 500) : undefined,
      nodes: obj.nodes as FlowDefinition['nodes'],
      edges: obj.edges as FlowDefinition['edges'],
    },
  };
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  return JSON.parse(candidate.trim());
}

const DRAFT_PROMPT = `You design Canvas Core automation flows. A flow is a JSON graph of nodes and edges.
Valid node "type" values — do not invent any other value:
${[...VALID_NODE_TYPES].join(', ')}

Respond with ONLY a JSON object shaped like:
{
  "name": "short descriptive name",
  "description": "one sentence",
  "nodes": [
    { "id": "n1", "type": "trigger_voice", "position": {"x":0,"y":0}, "config": { "phrases": ["..."] } },
    { "id": "n2", "type": "action_ha_service", "position": {"x":200,"y":0}, "config": { "domain": "...", "service": "...", "entity_id": "...", "data": {} } }
  ],
  "edges": [ { "id": "e1", "source": "n1", "target": "n2" } ]
}
The flow must start with exactly one trigger_* node. Use action_ha_service, action_tts, action_device_command,
action_log, or logic_* nodes for the rest, based only on what the sample tool calls below actually did.
Do not include any text outside the JSON object.`;

export interface AutomationGapDraftResult {
  pattern: string;
  drafted: boolean;
  flowId?: string;
  reason?: string;
}

/**
 * Scans recent voice turns for a transcript pattern that repeatedly needed the
 * full AI tool-calling fallback, and asks the conversation model to draft a
 * Flow that would handle it deterministically. Always persists disabled.
 */
export async function runAutomationGapDetection(
  pool: Pool,
  flowRepo: FlowRepository,
  llm: LlmProvider,
): Promise<AutomationGapDraftResult[]> {
  const gapRows = await pool.query<{ pattern: string; count: string; sample_transcript: string; sample_tool_calls: unknown }>(
    `SELECT pattern, count, sample_transcript, sample_tool_calls FROM (
       SELECT
         regexp_replace(lower(transcript), '[^a-z0-9]+', ' ', 'g') AS pattern,
         COUNT(*) AS count,
         MAX(transcript) AS sample_transcript,
         (array_agg(tool_calls ORDER BY created_at DESC))[1] AS sample_tool_calls
       FROM voice_turns
       WHERE intent = 'unknown'
         AND tool_calls IS NOT NULL
         AND tool_calls <> '[]'::jsonb
         AND transcript IS NOT NULL
         AND created_at > now() - $1::interval
       GROUP BY pattern
     ) gaps
     WHERE count >= ${GAP_THRESHOLD}
     ORDER BY count DESC
     LIMIT 10`,
    [`${LOOKBACK_DAYS} days`],
  );

  const results: AutomationGapDraftResult[] = [];
  for (const row of gapRows.rows) {
    const pattern = row.pattern.trim();
    if (!pattern) continue;

    const attemptRow = await pool.query<{ attempts: number; drafted_flow_id: string | null }>(
      `INSERT INTO flow_ai_draft_attempts (pattern, attempts, last_attempt_at)
       VALUES ($1, 0, now())
       ON CONFLICT (pattern) DO UPDATE SET last_attempt_at = now()
       RETURNING attempts, drafted_flow_id`,
      [pattern],
    );
    const attempt = attemptRow.rows[0];
    if (attempt.drafted_flow_id) continue; // already handled
    if (attempt.attempts >= MAX_ATTEMPTS) continue; // gave up

    try {
      const messages: ChatMessage[] = [
        { role: 'system', content: DRAFT_PROMPT },
        {
          role: 'user',
          content: `Recurring request (seen ${row.count} times): "${row.sample_transcript}"\n` +
            `Sample tool calls that successfully handled it: ${JSON.stringify(row.sample_tool_calls)}`,
        },
      ];
      const raw = await llm.chat(messages);
      const parsed = extractJson(raw);
      const validated = validateAiFlowDefinition(parsed);
      if (!validated.ok) {
        await pool.query(
          `UPDATE flow_ai_draft_attempts SET attempts = attempts + 1 WHERE pattern = $1`,
          [pattern],
        );
        console.warn(`[core][auto-flow] draft rejected pattern="${pattern}" reason=${validated.reason}`);
        results.push({ pattern, drafted: false, reason: validated.reason });
        continue;
      }
      const flow = await flowRepo.create(validated.definition);
      await pool.query(
        `UPDATE flow_ai_draft_attempts SET attempts = attempts + 1, drafted_flow_id = $2 WHERE pattern = $1`,
        [pattern, flow.id],
      );
      console.log(`[core][auto-flow] drafted disabled flow id=${flow.id} name="${flow.name}" pattern="${pattern}"`);
      results.push({ pattern, drafted: true, flowId: flow.id });
    } catch (error) {
      await pool.query(
        `UPDATE flow_ai_draft_attempts SET attempts = attempts + 1 WHERE pattern = $1`,
        [pattern],
      );
      console.warn(`[core][auto-flow] draft failed pattern="${pattern}":`, error instanceof Error ? error.message : error);
      results.push({ pattern, drafted: false, reason: 'exception' });
    }
  }
  return results;
}
