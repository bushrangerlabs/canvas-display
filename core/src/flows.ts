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
import cron, { type ScheduledTask } from 'node-cron';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type NodeType =
  // triggers
  | 'trigger_voice' | 'trigger_schedule' | 'trigger_ha_state'
  | 'trigger_webhook' | 'trigger_manual' | 'trigger_intent'
  // actions
  | 'action_ha_service' | 'action_tts' | 'action_scene' | 'action_switch_page'
  | 'action_delay' | 'action_http' | 'action_set_variable'
  | 'action_ai_reply' | 'action_send_intent' | 'action_load_url'
  | 'action_knowledge_card' | 'action_broadcast_alert' | 'action_broadcast_intercom'
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
  /** Switch a display device to a legacy page by name or ID */
  switchPage: (pageName: string, deviceId?: string) => Promise<void>;
  /** Ask the AI for a plain text reply */
  askAi: (prompt: string) => Promise<string>;
  /** Run a phrase through the full AI intent pipeline; returns intent, reply, slots */
  runIntentPipeline: (text: string) => Promise<{ intent: string; reply: string; slots: Record<string, unknown> }>;
  /** Navigate a display's main webview to an arbitrary URL */
  navigateDeviceToUrl: (url: string, deviceId?: string) => Promise<void>;
  /** Push a knowledge card to a display device */
  pushKnowledgeCard: (card: { title: string; body: string; source_label?: string }, deviceId?: string) => Promise<void>;
  /** Broadcast an alert notification to devices */
  broadcastAlert?: (title: string, message: string, type?: string, deviceIds?: string[]) => Promise<void>;
  /** Trigger mic recording on a device and broadcast real audio to all devices */
  broadcastIntercom?: (deviceId?: string, durationSeconds?: number) => Promise<void>;
  /** Send a command to a display device (navigate, overlay, media, etc.) */
  sendDeviceCommand?: (deviceId: string | undefined, command: string, payload?: unknown) => Promise<void>;
}

type FlowContext = Record<string, unknown>;

export class FlowExecutor {
  private scheduledTasks = new Map<string, ScheduledTask>(); // key: `${flowId}:${nodeId}`

  constructor(private repo: FlowRepository, private deps: FlowExecutorDeps) {}

  /** Start cron scheduler — loads all enabled flows with trigger_schedule nodes. */
  async startScheduler(): Promise<void> {
    const flows = await this.repo.listEnabled();
    for (const flow of flows) {
      for (const node of flow.definition.nodes) {
        if (node.type !== 'trigger_schedule') continue;
        this._scheduleFlow(flow.id, node.id, String(node.config.cron ?? ''));
      }
    }
    console.log(`[flows] scheduler started — ${this.scheduledTasks.size} scheduled task(s)`);
  }

  /** Re-register schedules for a specific flow (call after flow save/enable/disable). */
  async refreshFlowSchedule(flowId: string): Promise<void> {
    // Remove existing tasks for this flow
    for (const [key, task] of this.scheduledTasks) {
      if (key.startsWith(`${flowId}:`)) {
        task.stop();
        this.scheduledTasks.delete(key);
      }
    }
    // Re-add if still enabled
    const flow = await this.repo.get(flowId);
    if (!flow?.enabled) return;
    for (const node of flow.definition.nodes) {
      if (node.type !== 'trigger_schedule') continue;
      this._scheduleFlow(flowId, node.id, String(node.config.cron ?? ''));
    }
  }

  private _scheduleFlow(flowId: string, nodeId: string, expression: string): void {
    if (!expression || !cron.validate(expression)) {
      console.warn(`[flows] invalid cron "${expression}" for flow ${flowId}`);
      return;
    }
    const key = `${flowId}:${nodeId}`;
    const task = cron.schedule(expression, () => {
      this.execute(flowId, { trigger: 'schedule', expression }).catch(err =>
        console.error(`[flows] scheduled flow ${flowId} error:`, err)
      );
    });
    this.scheduledTasks.set(key, task);
  }

  private _prevHaState = new Map<string, string>();

  /** Called by index.ts when an HA entity changes state. Fires matching flows. */
  async onHaEntityChange(entityId: string, newState: string): Promise<void> {
    const prevState = this._prevHaState.get(entityId);
    this._prevHaState.set(entityId, newState);
    const flows = await this.repo.listEnabled();
    for (const flow of flows) {
      for (const node of flow.definition.nodes) {
        if (node.type !== 'trigger_ha_state') continue;
        const watchEntity = String(node.config.entity_id ?? '').toLowerCase();
        const watchToState = String(node.config.to_state ?? '').trim();
        const watchFromState = String(node.config.from_state ?? '').trim();
        if (!watchEntity || watchEntity !== entityId.toLowerCase()) continue;
        if (watchToState && watchToState !== newState) continue;
        if (watchFromState && watchFromState !== (prevState ?? '')) continue;
        // Match — fire the flow
        this.execute(flow.id, {
          trigger: 'ha_state',
          entity_id: entityId,
          new_state: newState,
          old_state: prevState ?? '',
        }).catch(err => console.error(`[flows] ha_state flow ${flow.id} error:`, err));
        break;
      }
    }
  }

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

  /**
   * Find ALL flows whose intent trigger matches the resolved AI intent.
   * Returns every matching flow so they all run as side effects.
   */
  async matchIntentTriggers(
    intent: string,
    slots?: Record<string, unknown>,
  ): Promise<Array<{ flow: FlowRow; triggerData: Record<string, unknown> }>> {
    const flows = await this.repo.listEnabled();
    const results: Array<{ flow: FlowRow; triggerData: Record<string, unknown> }> = [];
    for (const flow of flows) {
      for (const node of flow.definition.nodes) {
        if (node.type !== 'trigger_intent') continue;

        // intents: comma or newline separated list of intent names to match
        const raw = String(node.config.intents ?? '');
        const allowed = raw
          .split(/[\n,]+/)
          .map(s => s.trim().toLowerCase())
          .filter(Boolean);

        // Empty list = match ANY intent; otherwise check membership
        const domainRaw = String(node.config.domains ?? '').trim();
        const domains = domainRaw
          ? domainRaw.split(/[\n,]+/).map(s => s.trim().toLowerCase()).filter(Boolean)
          : [];

        const intentLower = intent.toLowerCase();
        const intentMatches = allowed.length === 0 || allowed.includes(intentLower);
        // Domain matching: if domains specified, intent must start with one of them
        const domainMatches = domains.length === 0 || domains.some(d => intentLower.startsWith(d));

        if (intentMatches && domainMatches) {
          results.push({
            flow,
            triggerData: { intent, slots: slots ?? {} },
          });
          break; // one trigger_intent node per flow is enough
        }
      }
    }
    return results;
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
      case 'trigger_intent':
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

      case 'action_broadcast_alert': {
        const title = String(this._resolve(cfg.title, ctx) ?? 'Alert');
        const message = String(this._resolve(cfg.message, ctx) ?? '');
        const type = String(cfg.type ?? 'info');
        const deviceIds = Array.isArray(cfg.device_ids) ? cfg.device_ids.map(String) : undefined;
        if (this.deps.broadcastAlert) await this.deps.broadcastAlert(title, message, type, deviceIds);
        return 'any';
      }

      case 'action_broadcast_intercom': {
        const deviceId = cfg.device_id ? String(cfg.device_id) : undefined;
        const duration = cfg.duration ? Number(cfg.duration) : 8;
        if (this.deps.broadcastIntercom) await this.deps.broadcastIntercom(deviceId, duration);
        return 'any';
      }

      case 'action_scene': {
        const sceneName = String(cfg.scene ?? '');
        const deviceId = cfg.device_id ? String(cfg.device_id) : undefined;
        await this.deps.switchScene(sceneName, deviceId);
        return 'any';
      }

      case 'action_switch_page': {
        const pageName = String(this._resolve(cfg.page, ctx) ?? '');
        const deviceId = cfg.device_id ? String(cfg.device_id) : undefined;
        await this.deps.switchPage(pageName, deviceId);
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
        const varName = cfg.result_variable ? String(cfg.result_variable) : null;
        const headersRaw = cfg.headers ? this._resolve(cfg.headers, ctx) : undefined;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (headersRaw && typeof headersRaw === 'object') {
          Object.assign(headers, headersRaw);
        }
        const res = await fetch(url, { method, body, headers });
        const text = await res.text();
        if (varName) {
          try { ctx[varName] = JSON.parse(text); } catch { ctx[varName] = text; }
        }
        if (!res.ok) console.warn(`[flows] action_http ${method} ${url} → ${res.status}`);
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

      case 'action_send_intent': {
        const text = String(this._resolve(cfg.text, ctx) ?? '');
        const result = await this.deps.runIntentPipeline(text);
        const intentVar = String(cfg.intent_variable ?? 'intent');
        const replyVar = String(cfg.reply_variable ?? 'reply');
        const slotsVar = String(cfg.slots_variable ?? 'slots');
        ctx[intentVar] = result.intent;
        ctx[replyVar] = result.reply;
        ctx[slotsVar] = result.slots;
        return 'any';
      }

      case 'action_load_url': {
        const url = String(this._resolve(cfg.url, ctx) ?? '');
        const deviceId = cfg.device_id ? String(cfg.device_id) : undefined;
        if (url) await this.deps.navigateDeviceToUrl(url, deviceId);
        return 'any';
      }

      case 'action_knowledge_card': {
        const title = String(this._resolve(cfg.title, ctx) ?? '');
        const body = String(this._resolve(cfg.body, ctx) ?? '');
        const source_label = cfg.source_label ? String(this._resolve(cfg.source_label, ctx)) : 'Flow';
        const deviceId = cfg.device_id ? String(cfg.device_id) : undefined;
        await this.deps.pushKnowledgeCard({ title, body, source_label }, deviceId);
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
        const value = String(ctx[varName] ?? '');
        const cases: string[] = Array.isArray(cfg.cases) ? (cfg.cases as string[]) : [];
        // Return the value if it matches a defined case, otherwise __default__
        return cases.includes(value) ? value : '__default__';
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
      void executor.refreshFlowSchedule(req.params.id);
      return flow;
    }
  );

  fastify.patch<{ Params: { id: string }; Body: { enabled: boolean } }>(
    '/api/flows/:id/enabled', authWrite, async (req, reply) => {
      await repo.setEnabled(req.params.id, Boolean(req.body?.enabled));
      void executor.refreshFlowSchedule(req.params.id);
      return { ok: true };
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/api/flows/:id', authWrite, async (req, reply) => {
      void executor.refreshFlowSchedule(req.params.id); // stop any scheduled tasks
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
