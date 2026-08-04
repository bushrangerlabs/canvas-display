/**
 * Visual Automation Flows
 *
 * A Node-RED/Blockly-style flow engine for Canvas Core.
 * Users build flows visually in the web UI; Core executes them.
 *
 * Each flow is a directed acyclic graph (DAG) of nodes connected by edges.
 * Execution starts at trigger nodes and walks connected action/logic nodes.
 *
 * Node types
 * ----------
 * TRIGGERS (entry points):
 *   voice         — phrase or keyword match on any voice turn
 *   schedule      — cron expression
 *   ha_state      — HA entity state change
 *   webhook       — POST /api/flows/webhook/:flowId
 *   manual        — explicit API call only
 *
 * ACTIONS (side effects):
 *   ha_service    — call a HA service (domain, service, entity_id, data)
 *   tts           — speak text on a device (or all devices)
 *   scene         — switch a display device to a named scene
 *   delay         — wait N seconds
 *   http          — HTTP GET/POST to an external URL
 *   set_variable  — store a value in the flow execution context
 *   ai_reply      — ask the AI a question; result stored in a variable
 *   knowledge_card— push a knowledge card to a display device
 *
 * LOGIC (routing):
 *   if_else       — evaluate a condition expression; branch true/false
 *   switch        — multi-branch on a variable value
 *   for_each      — iterate over an array variable
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type NodeType =
  // triggers
  | 'trigger_voice' | 'trigger_schedule' | 'trigger_ha_state'
  | 'trigger_webhook' | 'trigger_manual'
  // actions
  | 'action_ha_service' | 'action_tts' | 'action_scene'
  | 'action_delay' | 'action_http' | 'action_set_variable'
  | 'action_ai_reply' | 'action_knowledge_card'
  | 'action_device_command' | 'action_log'
  // logic
  | 'logic_if_else' | 'logic_switch' | 'logic_for_each';

export interface FlowNodePosition { x: number; y: number; }

export interface FlowNode {
  id: string;
  type: NodeType;
  position: FlowNodePosition;
  label?: string;
  config: Record<string, unknown>;
}

export interface FlowEdge {
  id: string;
  source: string;
  sourceHandle?: string;   // for multi-output nodes: 'true' | 'false' | branch key
  target: string;
}

export interface FlowDefinition {
  schemaVersion: 1;
  name: string;
  description?: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface FlowRow {
  id: string;
  name: string;
  description: string | null;
  definition: FlowDefinition;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// DB schema migration (called from db.ts bootstrap)
// ─────────────────────────────────────────────────────────────────────────────

export async function migrateFlowsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS flows (
      id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      name        TEXT NOT NULL,
      description TEXT,
      definition  JSONB NOT NULL DEFAULT '{}',
      enabled     BOOLEAN NOT NULL DEFAULT false,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_flows_enabled ON flows (enabled);
  `);
  // Execution log
  await pool.query(`
    CREATE TABLE IF NOT EXISTS flow_executions (
      id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      flow_id     TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
      trigger_data JSONB,
      status      TEXT NOT NULL DEFAULT 'running',
      error       TEXT,
      started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_flow_executions_flow ON flow_executions (flow_id, started_at DESC);
  `);
}

// ─────────────────────────────────────────────────────────────────────────────
// Flow Repository (CRUD)
// ─────────────────────────────────────────────────────────────────────────────

export class FlowRepository {
  constructor(private pool: Pool) {}

  async list(): Promise<FlowRow[]> {
    const r = await this.pool.query(
      `SELECT id, name, description, definition, enabled, created_at, updated_at
       FROM flows ORDER BY name ASC`
    );
    return r.rows;
  }

  async get(id: string): Promise<FlowRow | null> {
    const r = await this.pool.query(
      `SELECT id, name, description, definition, enabled, created_at, updated_at
       FROM flows WHERE id = $1`,
      [id]
    );
    return r.rows[0] ?? null;
  }

  async create(def: FlowDefinition): Promise<FlowRow> {
    const id = randomUUID();
    const r = await this.pool.query(
      `INSERT INTO flows (id, name, description, definition, enabled)
       VALUES ($1, $2, $3, $4, false)
       RETURNING id, name, description, definition, enabled, created_at, updated_at`,
      [id, def.name, def.description ?? null, JSON.stringify(def)]
    );
    return r.rows[0];
  }

  async update(id: string, def: FlowDefinition): Promise<FlowRow | null> {
    const r = await this.pool.query(
      `UPDATE flows
       SET name=$2, description=$3, definition=$4, updated_at=now()
       WHERE id=$1
       RETURNING id, name, description, definition, enabled, created_at, updated_at`,
      [id, def.name, def.description ?? null, JSON.stringify(def)]
    );
    return r.rows[0] ?? null;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE flows SET enabled=$2, updated_at=now() WHERE id=$1`,
      [id, enabled]
    );
  }

  async delete(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM flows WHERE id=$1`, [id]);
  }

  async listEnabled(): Promise<FlowRow[]> {
    const r = await this.pool.query(
      `SELECT id, name, description, definition, enabled, created_at, updated_at
       FROM flows WHERE enabled=true`
    );
    return r.rows;
  }

  async recentExecutions(flowId: string, limit = 20) {
    const r = await this.pool.query(
      `SELECT id, flow_id, trigger_data, status, error, started_at, finished_at
       FROM flow_executions
       WHERE flow_id=$1
       ORDER BY started_at DESC LIMIT $2`,
      [flowId, limit]
    );
    return r.rows;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Flow Executor
// ─────────────────────────────────────────────────────────────────────────────

export interface FlowExecutorDeps {
  pool: Pool;
  /** POST to HA supervisor */
  callHaService: (domain: string, service: string, data?: unknown) => Promise<void>;
  /** Speak text on device (or all if deviceId omitted) */
  speakTts: (text: string, deviceId?: string) => Promise<void>;
  /** Switch a display device to a scene by name */
  switchScene: (sceneName: string, deviceId?: string) => Promise<void>;
  /** Ask the AI for a plain text reply */
  askAi: (prompt: string) => Promise<string>;
  /** Push a knowledge card to a display device */
  pushKnowledgeCard: (card: { title: string; body: string; source_label?: string }, deviceId?: string) => Promise<void>;
  /** Send a command to a display device (navigate, overlay, media, etc.) */
  sendDeviceCommand?: (deviceId: string | undefined, command: string, payload?: unknown) => Promise<void>;
}

type FlowContext = Record<string, unknown>;

export class FlowExecutor {
  constructor(private repo: FlowRepository, private deps: FlowExecutorDeps) {}

  /** Find flows whose voice trigger matches the transcript. Returns first match. */
  async matchVoiceTrigger(transcript: string): Promise<FlowRow | null> {
    const flows = await this.repo.listEnabled();
    const lower = transcript.toLowerCase();
    for (const flow of flows) {
      for (const node of flow.definition.nodes) {
        if (node.type !== 'trigger_voice') continue;
        const phrases: string[] = (node.config.phrases as string[] | undefined) ?? [];
        const keywords: string[] = (node.config.keywords as string[] | undefined) ?? [];
        if (phrases.some(p => lower.includes(p.toLowerCase()))) return flow;
        if (keywords.length > 0 && keywords.every(k => lower.includes(k.toLowerCase()))) return flow;
      }
    }
    return null;
  }

  /** Execute a flow by ID, returning the execution ID. */
  async execute(flowId: string, triggerData: Record<string, unknown> = {}): Promise<string> {
    const flow = await this.repo.get(flowId);
    if (!flow) throw new Error(`Flow not found: ${flowId}`);

    const execId = randomUUID();
    await this.deps.pool.query(
      `INSERT INTO flow_executions (id, flow_id, trigger_data, status) VALUES ($1,$2,$3,'running')`,
      [execId, flowId, JSON.stringify(triggerData)]
    );

    // Run async, don't await
    this._run(execId, flow, triggerData).catch(err => {
      console.error(`[flows] execution ${execId} failed:`, err);
      void this.deps.pool.query(
        `UPDATE flow_executions SET status='error', error=$2, finished_at=now() WHERE id=$1`,
        [execId, String(err)]
      );
    });

    return execId;
  }

  private async _run(execId: string, flow: FlowRow, triggerData: Record<string, unknown>) {
    const ctx: FlowContext = { ...triggerData };
    const def = flow.definition;

    // Build adjacency: nodeId → outgoing edges
    const outEdges = new Map<string, FlowEdge[]>();
    for (const edge of def.edges) {
      if (!outEdges.has(edge.source)) outEdges.set(edge.source, []);
      outEdges.get(edge.source)!.push(edge);
    }

    // Start from trigger nodes
    const triggerNodes = def.nodes.filter(n => n.type.startsWith('trigger_'));
    const queue: Array<{ nodeId: string; handle?: string }> = triggerNodes.map(n => ({ nodeId: n.id }));
    const visited = new Set<string>();

    while (queue.length > 0) {
      const { nodeId, handle } = queue.shift()!;
      const visitKey = `${nodeId}:${handle ?? ''}`;
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);

      const node = def.nodes.find(n => n.id === nodeId);
      if (!node) continue;

      const nextHandle = await this._executeNode(node, ctx, handle);

      // Handle for_each fan-out: execute child subgraph once per item
      if (nextHandle.startsWith('for_each:')) {
        const nodeId2 = nextHandle.slice('for_each:'.length);
        const items = ctx[`__for_each_items__${nodeId2}`] as unknown[] ?? [];
        const itemVar = String(ctx[`__for_each_item_var__${nodeId2}`] ?? 'item');
        const edges = outEdges.get(nodeId) ?? [];
        for (const item of items) {
          const itemCtx = { ...ctx, [itemVar]: item };
          for (const edge of edges) {
            // Run sub-walk with item context (shallow — modifies don't propagate back)
            await this._runSubgraph(edge.target, outEdges, def, itemCtx);
          }
        }
        continue;
      }

      // Enqueue children that match the output handle (or unconditional)
      const edges = outEdges.get(nodeId) ?? [];
      for (const edge of edges) {
        if (!edge.sourceHandle || edge.sourceHandle === nextHandle || nextHandle === 'any') {
          queue.push({ nodeId: edge.target, handle: undefined });
        }
      }
    }

    await this.deps.pool.query(
      `UPDATE flow_executions SET status='completed', finished_at=now() WHERE id=$1`,
      [execId]
    );
  }

  /** Run a sub-graph starting from a given node (used by for_each iteration) */
  private async _runSubgraph(
    startNodeId: string,
    outEdges: Map<string, FlowEdge[]>,
    def: FlowDefinition,
    ctx: FlowContext,
  ): Promise<void> {
    const queue: string[] = [startNodeId];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      const node = def.nodes.find(n => n.id === nodeId);
      if (!node) continue;
      const handle = await this._executeNode(node, ctx);
      for (const edge of outEdges.get(nodeId) ?? []) {
        if (!edge.sourceHandle || edge.sourceHandle === handle || handle === 'any') {
          queue.push(edge.target);
        }
      }
    }
  }

  /** Execute one node, return the output handle name for routing ('any', 'true', 'false', branch key) */
  private async _executeNode(node: FlowNode, ctx: FlowContext, _inHandle?: string): Promise<string> {
    const cfg = node.config;

    switch (node.type) {
      case 'trigger_voice':
      case 'trigger_schedule':
      case 'trigger_ha_state':
      case 'trigger_webhook':
      case 'trigger_manual':
        return 'any';

      case 'action_ha_service': {
        const domain = String(cfg.domain ?? '');
        const service = String(cfg.service ?? '');
        const entity_id = this._resolve(cfg.entity_id, ctx);
        await this.deps.callHaService(domain, service, { entity_id, ...(cfg.data as object ?? {}) });
        return 'any';
      }

      case 'action_tts': {
        const text = String(this._resolve(cfg.text, ctx) ?? '');
        const deviceId = cfg.device_id ? String(cfg.device_id) : undefined;
        await this.deps.speakTts(text, deviceId);
        return 'any';
      }

      case 'action_scene': {
        const sceneName = String(cfg.scene ?? '');
        const deviceId = cfg.device_id ? String(cfg.device_id) : undefined;
        await this.deps.switchScene(sceneName, deviceId);
        return 'any';
      }

      case 'action_delay': {
        const seconds = Number(cfg.seconds ?? 1);
        await new Promise(r => setTimeout(r, Math.min(seconds, 300) * 1000));
        return 'any';
      }

      case 'action_http': {
        const url = String(this._resolve(cfg.url, ctx) ?? '');
        const method = String(cfg.method ?? 'GET').toUpperCase();
        const body = cfg.body ? JSON.stringify(this._resolve(cfg.body, ctx)) : undefined;
        await fetch(url, { method, body, headers: { 'Content-Type': 'application/json' } });
        return 'any';
      }

      case 'action_set_variable': {
        const varName = String(cfg.variable ?? '');
        ctx[varName] = this._resolve(cfg.value, ctx);
        return 'any';
      }

      case 'action_ai_reply': {
        const prompt = String(this._resolve(cfg.prompt, ctx) ?? '');
        const varName = String(cfg.result_variable ?? 'ai_reply');
        ctx[varName] = await this.deps.askAi(prompt);
        return 'any';
      }

      case 'action_knowledge_card': {
        const title = String(this._resolve(cfg.title, ctx) ?? '');
        const body = String(this._resolve(cfg.body, ctx) ?? '');
        const deviceId = cfg.device_id ? String(cfg.device_id) : undefined;
        await this.deps.pushKnowledgeCard({ title, body, source_label: 'Flow' }, deviceId);
        return 'any';
      }

      case 'action_device_command': {
        const deviceId = cfg.device_id ? String(this._resolve(cfg.device_id, ctx)) : undefined;
        const command = String(cfg.command ?? '');
        const payload = cfg.payload ? this._resolve(cfg.payload, ctx) : undefined;
        if (this.deps.sendDeviceCommand) {
          await this.deps.sendDeviceCommand(deviceId, command, payload);
        }
        return 'any';
      }

      case 'action_log': {
        const message = String(this._resolve(cfg.message, ctx) ?? '');
        const level = String(cfg.level ?? 'info');
        console.log(`[flow:log][${level}] ${message}`);
        return 'any';
      }

      case 'logic_if_else': {
        const condition = this._evalCondition(String(cfg.condition ?? ''), ctx);
        return condition ? 'true' : 'false';
      }

      case 'logic_switch': {
        const varName = String(cfg.variable ?? '');
        return String(ctx[varName] ?? '');
      }

      case 'logic_for_each': {
        // Store iterator state so the walk loop can fan out
        const arrVar = String(cfg.array_variable ?? '');
        const itemVar = String(cfg.item_variable ?? 'item');
        const arr = ctx[arrVar];
        const items: unknown[] = Array.isArray(arr) ? arr : typeof arr === 'string' ? arr.split(',').map(s => s.trim()) : [];
        // We encode iteration items into ctx so the walk loop can see them
        ctx[`__for_each_items__${node.id}`] = items;
        ctx[`__for_each_item_var__${node.id}`] = itemVar;
        // Return 'any' — the walk will process children once per item via _runForEach
        return `for_each:${node.id}`;
      }

      default:
        return 'any';
    }
  }

  /** Resolve a config value — if it starts with {{ and ends with }}, look up in ctx */
  private _resolve(value: unknown, ctx: FlowContext): unknown {
    if (typeof value !== 'string') return value;
    const m = value.match(/^\{\{\s*(\w+)\s*\}\}$/);
    if (m) return ctx[m[1]] ?? value;
    // Also replace inline {{ var }} occurrences in strings
    return value.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => String(ctx[k] ?? ''));
  }

  /** Evaluate a simple condition string: "var == value", "var != value", "var > N" */
  private _evalCondition(condition: string, ctx: FlowContext): boolean {
    // Supported: <var> == <value>, <var> != <value>, <var> > <N>, <var> < <N>
    const ops = [' == ', ' != ', ' >= ', ' <= ', ' > ', ' < '];
    for (const op of ops) {
      const idx = condition.indexOf(op);
      if (idx === -1) continue;
      const lhs = condition.slice(0, idx).trim();
      const rhs = condition.slice(idx + op.length).trim();
      const left = ctx[lhs] ?? lhs;
      const right: unknown = isNaN(Number(rhs)) ? rhs.replace(/^["']|["']$/g, '') : Number(rhs);
      switch (op.trim()) {
        case '==': return String(left) === String(right);
        case '!=': return String(left) !== String(right);
        case '>': return Number(left) > Number(right);
        case '<': return Number(left) < Number(right);
        case '>=': return Number(left) >= Number(right);
        case '<=': return Number(left) <= Number(right);
      }
    }
    // Truthy check
    return Boolean(ctx[condition.trim()]);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Route registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerFlowRoutes(
  fastify: FastifyInstance,
  repo: FlowRepository,
  executor: FlowExecutor,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requireAdmin: (opts?: any) => any,
): void {
  const auth = { preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }) };
  const authWrite = { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) };

  fastify.get('/api/flows', auth, async () => ({ flows: await repo.list() }));

  fastify.get<{ Params: { id: string } }>('/api/flows/:id', auth, async (req, reply) => {
    const flow = await repo.get(req.params.id);
    if (!flow) return reply.code(404).send({ error: 'not_found' });
    return flow;
  });

  fastify.post<{ Body: { definition: FlowDefinition } }>(
    '/api/flows', authWrite, async (req, reply) => {
      const def = req.body?.definition;
      if (!def?.name || !Array.isArray(def.nodes)) return reply.code(400).send({ error: 'invalid_definition' });
      const flow = await repo.create({ ...def, schemaVersion: 1 });
      return reply.code(201).send(flow);
    }
  );

  fastify.put<{ Params: { id: string }; Body: { definition: FlowDefinition } }>(
    '/api/flows/:id', authWrite, async (req, reply) => {
      const def = req.body?.definition;
      if (!def?.name) return reply.code(400).send({ error: 'invalid_definition' });
      const flow = await repo.update(req.params.id, { ...def, schemaVersion: 1 });
      if (!flow) return reply.code(404).send({ error: 'not_found' });
      return flow;
    }
  );

  fastify.patch<{ Params: { id: string }; Body: { enabled: boolean } }>(
    '/api/flows/:id/enabled', authWrite, async (req, reply) => {
      await repo.setEnabled(req.params.id, Boolean(req.body?.enabled));
      return { ok: true };
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/api/flows/:id', authWrite, async (req, reply) => {
      await repo.delete(req.params.id);
      return { ok: true };
    }
  );

  fastify.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/flows/:id/execute', authWrite, async (req, reply) => {
      const execId = await executor.execute(req.params.id, req.body ?? {});
      return { ok: true, executionId: execId };
    }
  );

  fastify.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/flows/webhook/:id', async (req, reply) => {
      const flow = await repo.get(req.params.id);
      if (!flow || !flow.enabled) return reply.code(404).send({ error: 'not_found' });
      const execId = await executor.execute(req.params.id, req.body ?? {});
      return { ok: true, executionId: execId };
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/api/flows/:id/executions', auth, async (req) => {
      return { executions: await repo.recentExecutions(req.params.id) };
    }
  );
}
