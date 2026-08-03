/**
 * Native tool registry (plan doc §15.3, Phase 6 checklist).
 *
 * Every tool declares:
 *   - Stable name and description
 *   - JSON input schema
 *   - Required role (admin, viewer, voice)
 *   - Confirmation policy
 *   - executor function
 *
 * DESIGN PRINCIPLE (§15.1): No general shell, arbitrary URL fetch, raw SQL,
 * or unrestricted HA service-call tool is exposed to models.
 */
import type { LlmProvider } from './providers/llm.js';
import type { HomeAssistantClient } from './providers/ha.js';
import type { McpClient } from './providers/mcp.js';
import type { Intelligence } from './intelligence.js';
import type { IntentRouter } from './intent-router.js';

// ── Types ───────────────────────────────────────────────────────────────────

export type ToolRole = 'admin' | 'viewer' | 'voice';

/** A tool call invocation for the shadow mode comparison harness. */
export interface ToolCall {
  /** The tool name (e.g. "ha.call_service", "canvas.timer.create"). */
  tool: string;
  /** Arguments passed to the tool. */
  arguments: Record<string, unknown>;
}

export interface ToolDefinition {
  /** Canonical dotted name, e.g. "ha.toggle", "media.play". */
  name: string;
  /** Human-readable description for LLM tool selection. */
  description: string;
  /** JSON Schema for the tool's parameters. */
  schema: Record<string, unknown>;
  /** Minimum role required to execute this tool. */
  requiredRole: ToolRole;
  /** Whether the tool needs explicit user confirmation before execution. */
  requiresConfirmation: boolean;
  /** The actual execution function. */
  executor: (params: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
}

export interface ToolContext {
  /** Authenticated user or device principal. */
  principal?: string;
  /** Principal's role assignment. */
  role?: ToolRole;
  /** HA client for entity operations. */
  haClient?: HomeAssistantClient | null;
  /** Fast candidate lookup backed by Core's durable HA entity catalogue. */
  resolveHaEntities?: (query: string) => Promise<Array<{
    entityId: string; friendlyName?: string; domain: string; state: string;
    deviceName?: string; areaName?: string;
  }>>;
  invokeVoiceRoutine?: (transcript: string, deviceId?: string) => Promise<{ matched: boolean; ambiguous?: string[]; reply?: string; result?: unknown }>;
  invokeVoiceSkill?: (transcript: string, deviceId?: string) => Promise<{ matched: boolean; ambiguous?: string[]; reply?: string; result?: unknown }>;
  recordSuccessfulPlan?: (transcript:string,calls:Array<{tool:string;args:Record<string,unknown>}>,deviceId?:string)=>Promise<unknown>;
  /** Intelligence instance for media operations. */
  intelligence?: Intelligence;
  /** Device that originated the current request. Never infer this from a browser session. */
  deviceId?: string;
  /** Intent router for query resolution. */
  intentRouter?: IntentRouter;
  /** MCP client for external tool calls. */
  mcp?: McpClient;
  /** Brightness set callback (dispatches to Edge Agent via device gateway). */
  setBrightness?: (level: number, deviceId?: string) => Promise<ToolResult>;
  /** Scene activation callback. */
  activateScene?: (scene: string) => Promise<ToolResult>;
  /** Navigation callback. */
  navigateTo?: (page: string) => Promise<ToolResult>;
  /** Media playback callback (dispatches to the originating Edge display). */
  playMedia?: (query: string, source: string, deviceId?: string, mediaKind?: string) => Promise<ToolResult>;
  /** Select or page a pending playlist choice on the originating display. */
  selectMedia?: (selection: { position?: number; action?: 'more' | 'cancel' }, deviceId?: string) => Promise<ToolResult>;
  /** Media control callback (dispatches to the originating Edge display). */
  controlMedia?: (
    action: 'pause' | 'resume' | 'stop' | 'next',
    source: string,
    deviceId?: string,
  ) => Promise<ToolResult>;
  /** Change one panel's URL/scene/visibility on connected displays. */
  setPanel?: (command: {
    panel: string;
    contentType?: 'url' | 'scene';
    url?: string;
    sceneId?: string;
    visible?: boolean;
  }) => Promise<ToolResult>;
}

export interface ToolResult {
  ok: boolean;
  message: string;
  /** Structured data returned by the tool (optional). */
  data?: unknown;
  /** Affected entity IDs (when applicable). */
  affected?: string[];
}

export interface AuditEntry {
  timestamp: string;
  tool: string;
  params: Record<string, unknown>;
  principal: string;
  role: ToolRole;
  result: ToolResult;
  digest?: string;
  confirmed: boolean;
}

// ── Tool Registry ───────────────────────────────────────────────────────────

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly auditLog: AuditEntry[] = [];
  private readonly maxAuditEntries: number;

  constructor(maxAuditEntries = 1000) {
    this.maxAuditEntries = maxAuditEntries;
    this.registerBuiltins();
  }

  /** Register a single tool definition. Replaces any existing tool with the same name. */
  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Execute a tool by name with the given parameters and context.
   *
   * Steps:
   *   1. Look up the tool definition.
   *   2. Validate params against the tool's JSON schema.
   *   3. Check that the principal's role satisfies the required role.
   *   4. Call the executor.
   *   5. Log the audit entry.
   */
  async executeTool(
    name: string,
    params: Record<string, unknown>,
    context: ToolContext,
    digest?: string,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, message: `tool_not_found: "${name}"` };
    }

    // Validate params against schema
    const validation = this.validateParams(tool.schema, params);
    if (!validation.valid) {
      const result: ToolResult = {
        ok: false,
        message: `invalid_params: ${validation.errors?.join(', ')}`,
      };
      this.audit(name, params, context, result, digest, false);
      return result;
    }

    // Role enforcement
    const principalRole = context.role ?? 'voice';
    if (!this.roleSatisfies(principalRole, tool.requiredRole)) {
      const result: ToolResult = {
        ok: false,
        message: `role_denied: "${principalRole}" cannot execute "${name}" (requires "${tool.requiredRole}")`,
      };
      this.audit(name, params, context, result, digest, false);
      return result;
    }

    // Execute
    try {
      const result = await tool.executor(validation.params, context);
      this.audit(name, params, context, result, digest, !result.ok);
      return result;
    } catch (err) {
      const result: ToolResult = {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
      this.audit(name, params, context, result, digest, false);
      return result;
    }
  }

  /** List tools accessible to a given role (defaults to all). */
  listTools(role?: ToolRole): ToolDefinition[] {
    const all = Array.from(this.tools.values());
    if (!role) return all;
    return all.filter((t) => this.roleSatisfies(role, t.requiredRole));
  }

  /** Get a single tool definition by name. */
  getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** Remove all MCP tools (those with names starting with 'mcp.'). */
  clearMcpTools(): void {
    for (const key of this.tools.keys()) {
      if (key.startsWith('mcp.')) this.tools.delete(key);
    }
  }

  /** Check whether a tool requires confirmation. */
  requiresConfirmation(name: string): boolean {
    return this.tools.get(name)?.requiresConfirmation ?? false;
  }

  /** Validate a prospective call without executing it. Used by routine simulation. */
  validateToolCall(name: string, params: Record<string, unknown>, role: ToolRole = 'admin'):
    { valid: boolean; errors: string[]; requiresConfirmation: boolean; requiredRole?: ToolRole } {
    const tool = this.tools.get(name);
    if (!tool) return { valid: false, errors: [`tool_not_found: "${name}"`], requiresConfirmation: false };
    const checked = this.validateParams(tool.schema, { ...params });
    const errors = checked.errors ? [...checked.errors] : [];
    if (!this.roleSatisfies(role, tool.requiredRole)) errors.push(`role_denied: requires "${tool.requiredRole}"`);
    return { valid: errors.length === 0, errors, requiresConfirmation: tool.requiresConfirmation, requiredRole: tool.requiredRole };
  }

  /** Return the audit log (read-only snapshot). */
  getAuditLog(): readonly AuditEntry[] {
    return this.auditLog.slice();
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  /**
   * Validate parameters against a minimal JSON Schema.
   * Supports `type`, `properties`, `required`, `description` at the top level.
   */
  private validateParams(
    schema: Record<string, unknown>,
    params: Record<string, unknown>,
  ): { valid: boolean; params: Record<string, unknown>; errors?: string[] } {
    const errors: string[] = [];
    const properties = (schema.properties ?? {}) as Record<string, unknown>;
    const required = (schema.required ?? []) as string[];

    // Check required params
    for (const key of required) {
      if (params[key] === undefined || params[key] === null || params[key] === '') {
        errors.push(`missing required parameter "${key}"`);
      }
    }

    // Validate types for known properties
    for (const [key, propSchema] of Object.entries(properties)) {
      if (params[key] === undefined || params[key] === null) continue;

      const ps = propSchema as Record<string, unknown>;
      const expectedType = ps.type as string | undefined;

      if (expectedType === 'string' && typeof params[key] !== 'string') {
        errors.push(`parameter "${key}" must be a string`);
      } else if (expectedType === 'number' && typeof params[key] !== 'number') {
        // Allow numeric strings
        if (typeof params[key] === 'string' && /^-?\d+(\.\d+)?$/.test(params[key] as string)) {
          params[key] = Number(params[key]);
        } else {
          errors.push(`parameter "${key}" must be a number`);
        }
      } else if (expectedType === 'boolean' && typeof params[key] !== 'boolean') {
        errors.push(`parameter "${key}" must be a boolean`);
      } else if (expectedType === 'integer' && !Number.isInteger(params[key])) {
        if (typeof params[key] === 'number' && Number.isInteger(params[key])) {
          // ok
        } else {
          errors.push(`parameter "${key}" must be an integer`);
        }
      }
    }

    if (errors.length > 0) {
      return { valid: false, params, errors };
    }

    return { valid: true, params };
  }

  /**
   * Check whether `actual` role satisfies the `required` role.
   * Hierarchy: admin > viewer > voice.
   */
  private roleSatisfies(actual: ToolRole, required: ToolRole): boolean {
    const hierarchy: ToolRole[] = ['voice', 'viewer', 'admin'];
    return hierarchy.indexOf(actual) >= hierarchy.indexOf(required);
  }

  /** Append an audit entry, trimming oldest entries when over the limit. */
  private audit(
    tool: string,
    params: Record<string, unknown>,
    context: ToolContext,
    result: ToolResult,
    digest?: string,
    confirmed = true,
  ): void {
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      tool,
      params,
      principal: context.principal ?? 'anonymous',
      role: context.role ?? 'voice',
      result,
      digest,
      confirmed,
    });
    if (this.auditLog.length > this.maxAuditEntries) {
      this.auditLog.splice(0, this.auditLog.length - this.maxAuditEntries);
    }
  }

  // ── Built-in tool definitions ────────────────────────────────────────────

  private registerBuiltins(): void {
    // ha.toggle — toggle or set an HA entity on/off
    this.register({
      name: 'ha.toggle',
      description: 'Toggle an HA entity on or off, or toggle its state',
      schema: {
        type: 'object',
        properties: {
          entity_id: { type: 'string', description: 'Full entity ID, e.g. light.kitchen' },
          domain: { type: 'string', description: 'HA domain, e.g. light, switch, fan' },
          state: {
            type: 'string',
            description: 'Target state: on, off, or toggle (default toggle)',
          },
        },
        required: ['entity_id'],
      },
      requiredRole: 'voice',
      requiresConfirmation: false,
      executor: async (params, ctx) => {
        const entityId = params.entity_id as string;
        const domain = (params.domain as string) ?? entityId.split('.')[0] ?? '';
        const state = (params.state as string) ?? 'toggle';

        if (!ctx.haClient) {
          return { ok: false, message: 'HA client not available (ha_not_configured)' };
        }

        // Determine the service
        let service: string;
        if (state === 'toggle') {
          service = 'toggle';
        } else if (state === 'on') {
          service = 'turn_on';
        } else if (state === 'off') {
          service = 'turn_off';
        } else {
          service = state;
        }

        try {
          const { controlEntity } = await import('./facade.js');
          const entities = await controlEntity(ctx.haClient, entityId, domain, service, {});
          return {
            ok: true,
            message: `Entity "${entityId}" set to ${state}`,
            affected: entities.map((e) => e.entityId),
          };
        } catch (err) {
          return {
            ok: false,
            message: `ha.toggle failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    });

    // ha.set_value — set a numeric value on an HA entity
    this.register({
      name: 'ha.set_value',
      description: 'Set a numeric value on an HA entity (e.g. thermostat temperature, light brightness)',
      schema: {
        type: 'object',
        properties: {
          entity_id: { type: 'string', description: 'Full entity ID, e.g. climate.thermostat' },
          value: { type: 'number', description: 'Numeric value to set' },
          domain: { type: 'string', description: 'HA domain override' },
          service: { type: 'string', description: 'HA service override (default set_value)' },
        },
        required: ['entity_id', 'value'],
      },
      requiredRole: 'voice',
      requiresConfirmation: false,
      executor: async (params, ctx) => {
        const entityId = params.entity_id as string;
        const value = params.value as number;
        const domain = (params.domain as string) ?? entityId.split('.')[0] ?? '';
        const service = (params.service as string) ?? 'set_value';

        if (!ctx.haClient) {
          return { ok: false, message: 'HA client not available (ha_not_configured)' };
        }

        try {
          const { controlEntity } = await import('./facade.js');
          const entities = await controlEntity(ctx.haClient, entityId, domain, service, {
            value,
          });
          return {
            ok: true,
            message: `Entity "${entityId}" set to ${value}`,
            affected: entities.map((e) => e.entityId),
          };
        } catch (err) {
          return {
            ok: false,
            message: `ha.set_value failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    });

    // media.play — play media via the intelligence pipeline
    this.register({
      name: 'media.play',
      description: 'Play audio or video media (music, YouTube, etc.)',
      schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Media search query or URL' },
          source: {
            type: 'string',
            description: 'Media source (youtube, local, etc.)',
          },
        },
        required: ['query'],
      },
      requiredRole: 'voice',
      requiresConfirmation: false,
      executor: async (params, ctx) => {
        const query = String(params.query ?? '').trim();
        const source = String(params.source ?? 'youtube').trim().toLowerCase();
        if (!query) return { ok: false, message: 'A media title or URL is required.' };
        if (!ctx.deviceId) {
          return { ok: false, message: 'I could not identify which display requested playback.' };
        }
        if (!ctx.playMedia) {
          return { ok: false, message: 'Device media playback is not configured.' };
        }
        return ctx.playMedia(query, source, ctx.deviceId, String(params.media_kind ?? ''));
      },
    });

    this.register({
      name: 'media.select',
      description: 'Choose, page, or cancel a pending media selection on this display',
      schema: {
        type: 'object',
        properties: { position: { type: 'number' }, action: { type: 'string' } },
        required: [],
      },
      requiredRole: 'voice',
      requiresConfirmation: false,
      executor: async (params, ctx) => ctx.selectMedia
        ? ctx.selectMedia({
          position: typeof params.position === 'number' ? params.position : undefined,
          action: params.action === 'more' || params.action === 'cancel' ? params.action : undefined,
        }, ctx.deviceId)
        : { ok: false, message: 'There is no playlist selection available.' },
    });

    // media.pause — pause media playback
    this.register({
      name: 'media.pause',
      description: 'Pause currently playing media',
      schema: {
        type: 'object',
        properties: {},
        required: [],
      },
      requiredRole: 'voice',
      requiresConfirmation: false,
      executor: async (_params, ctx) => ctx.controlMedia
        ? ctx.controlMedia('pause', 'youtube', ctx.deviceId)
        : { ok: false, message: 'Device media control is not configured.' },
    });

    // media.resume — resume paused media
    this.register({
      name: 'media.resume',
      description: 'Resume paused media',
      schema: {
        type: 'object',
        properties: {},
        required: [],
      },
      requiredRole: 'voice',
      requiresConfirmation: false,
      executor: async (_params, ctx) => ctx.controlMedia
        ? ctx.controlMedia('resume', 'youtube', ctx.deviceId)
        : { ok: false, message: 'Device media control is not configured.' },
    });

    // media.stop — stop media playback
    this.register({
      name: 'media.stop',
      description: 'Stop media playback entirely',
      schema: {
        type: 'object',
        properties: {},
        required: [],
      },
      requiredRole: 'voice',
      requiresConfirmation: false,
      executor: async (_params, ctx) => ctx.controlMedia
        ? ctx.controlMedia('stop', 'youtube', ctx.deviceId)
        : { ok: false, message: 'Device media control is not configured.' },
    });

    this.register({
      name: 'media.next',
      description: 'Skip to the next media item or YouTube candidate',
      schema: { type: 'object', properties: {}, required: [] },
      requiredRole: 'voice',
      requiresConfirmation: false,
      executor: async (_params, ctx) => ctx.controlMedia
        ? ctx.controlMedia('next', 'youtube', ctx.deviceId)
        : { ok: false, message: 'Device media control is not configured.' },
    });

    // brightness.set — set display brightness
    this.register({
      name: 'brightness.set',
      description: 'Set the display brightness level (0–100)',
      schema: {
        type: 'object',
        properties: {
          level: { type: 'number', description: 'Brightness level 0–100' },
          device_id: { type: 'string', description: 'Target device identifier (optional)' },
        },
        required: ['level'],
      },
      requiredRole: 'voice',
      requiresConfirmation: false,
      executor: async (params, ctx) => {
        const level = params.level as number;
        if (typeof level !== 'number' || level < 0 || level > 100) {
          return { ok: false, message: 'Brightness level must be a number between 0 and 100' };
        }
        if (ctx.setBrightness) {
          return ctx.setBrightness(level, params.device_id as string | undefined);
        }
        return {
          ok: true,
          message: `Brightness set to ${level} (no Edge Agent callback configured)`,
        };
      },
    });

    // scene.activate — activate a scene
    this.register({
      name: 'scene.activate',
      description: 'Activate or switch to a scene by name or ID',
      schema: {
        type: 'object',
        properties: {
          scene: { type: 'string', description: 'Scene name or ID to activate' },
        },
        required: ['scene'],
      },
      requiredRole: 'voice',
      requiresConfirmation: false,
      executor: async (params, ctx) => {
        const scene = params.scene as string;
        if (ctx.activateScene) {
          return ctx.activateScene(scene);
        }
        return {
          ok: true,
          message: `Scene "${scene}" activated (no scene callback configured)`,
        };
      },
    });

    // navigate.page — navigate to a page in the renderer
    this.register({
      name: 'navigate.page',
      description: 'Navigate to a specific page or view in the display renderer',
      schema: {
        type: 'object',
        properties: {
          page: { type: 'string', description: 'Target page or route identifier' },
        },
        required: ['page'],
      },
      requiredRole: 'voice',
      requiresConfirmation: false,
      executor: async (params, ctx) => {
        const page = params.page as string;
        if (ctx.navigateTo) {
          return ctx.navigateTo(page);
        }
        return {
          ok: true,
          message: `Navigating to "${page}" (no navigation callback configured)`,
        };
      },
    });

    this.register({
      name: 'navigate.panel',
      description: 'Change a display panel to a URL or published scene, or show/hide it',
      schema: {
        type: 'object',
        properties: {
          panel: { type: 'string', description: 'Panel ID or name on the active page' },
          content_type: { type: 'string', enum: ['url', 'scene'] },
          url: { type: 'string', description: 'HTTP(S) URL when content_type is url' },
          scene_id: { type: 'string', description: 'Published scene ID when content_type is scene' },
          visible: { type: 'boolean' },
        },
        required: ['panel'],
      },
      requiredRole: 'voice',
      requiresConfirmation: false,
      executor: async (params, ctx) => {
        if (!ctx.setPanel) {
          return { ok: false, message: 'Panel navigation is not connected to the device gateway.' };
        }
        return ctx.setPanel({
          panel: String(params.panel),
          contentType: params.content_type as 'url' | 'scene' | undefined,
          url: params.url as string | undefined,
          sceneId: params.scene_id as string | undefined,
          visible: params.visible as boolean | undefined,
        });
      },
    });

    // query.status — query HA entity state
    this.register({
      name: 'query.status',
      description: 'Query the current state of an HA entity or domain from the cache',
      schema: {
        type: 'object',
        properties: {
          entity_id: { type: 'string', description: 'Full or partial entity ID to query' },
          domain: { type: 'string', description: 'HA domain to query (e.g. sensor, light)' },
        },
        required: [],
      },
      requiredRole: 'voice',
      requiresConfirmation: false,
      executor: async (params, ctx) => {
        const entityId = params.entity_id as string | undefined;
        const domain = params.domain as string | undefined;

        if (!ctx.haClient) {
          return { ok: false, message: 'HA client not available (ha_not_configured)' };
        }

        try {
          if (entityId) {
            const entity = ctx.haClient.getEntity(entityId);
            if (!entity) {
              return { ok: false, message: `Entity "${entityId}" not found` };
            }
            return {
              ok: true,
              message: `${entity.entityId}: ${entity.state}`,
              data: { entity },
              affected: [entity.entityId],
            };
          }

          if (domain) {
            const allEntities = ctx.haClient.getEntities();
            const filtered = allEntities.filter((e) => e.entityId.startsWith(domain + '.'));
            return {
              ok: true,
              message: `Found ${filtered.length} entities in domain "${domain}"`,
              data: { entities: filtered },
              affected: filtered.map((e) => e.entityId),
            };
          }

          // Return all entity summaries
          const all = ctx.haClient.getEntities();
          return {
            ok: true,
            message: `HA has ${all.length} cached entities`,
            data: { entityCount: all.length },
          };
        } catch (err) {
          return {
            ok: false,
            message: `query.status failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    });

    // mcp.call — call an MCP tool via the MCP client
    this.register({
      name: 'mcp.call',
      description: 'Call a tool on the configured MCP server',
      schema: {
        type: 'object',
        properties: {
          mcp_tool: { type: 'string', description: 'The MCP tool name to call' },
          args: { type: 'object', description: 'Arguments to pass to the MCP tool' },
        },
        required: ['mcp_tool'],
      },
      requiredRole: 'admin',
      requiresConfirmation: true,
      executor: async (params, ctx) => {
        const tool = params.mcp_tool as string;
        const args = (params.args as Record<string, unknown>) ?? {};

        if (!ctx.mcp) {
          return { ok: false, message: 'MCP client not available' };
        }

        try {
          const result = await ctx.mcp.callTool(tool, args);
          return {
            ok: !result.isError,
            message: `MCP tool "${tool}" executed`,
            data: result.content,
          };
        } catch (err) {
          return {
            ok: false,
            message: `mcp.call failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    });
  }
}

// ── Policy helpers (used by shadow-mode.ts) ─────────────────────────────────

/**
 * Check if a tool call passes safety constraints.
 * This is a simplified policy check for the shadow mode harness.
 */
export function checkToolPolicyBatch(
  toolCalls: ToolCall[],
  constraints?: Partial<{
    no_mutations: boolean;
    entity_allowlist: string[];
    max_intensity: number | null;
    temperature_range: [number, number];
    require_confirmation: boolean;
  }>,
): { passed: boolean; reason?: string; requires_clarification: boolean; sanitized_arguments: Record<string, unknown> }[] {
  return toolCalls.map((tc) => {
    const sanitized: Record<string, unknown> = { ...tc.arguments };

    // Unknown tool check
    if (!tc.tool) {
      return { passed: false, reason: 'Empty tool name', requires_clarification: true, sanitized_arguments: sanitized };
    }

    // Mutation check
    if (constraints?.no_mutations) {
      const mutationTools = ['ha.call_service', 'media.play', 'canvas.timer.create'];
      if (mutationTools.includes(tc.tool)) {
        return { passed: false, reason: `Tool '${tc.tool}' is a mutating operation`, requires_clarification: true, sanitized_arguments: sanitized };
      }
    }

    // Entity allowlist check
    if (constraints?.entity_allowlist && constraints.entity_allowlist.length > 0) {
      const args = tc.arguments as Record<string, unknown>;
      const serviceData = args.service_data as Record<string, unknown> | undefined;
      const entityId = (serviceData?.entity_id ?? args.entity_id) as string | undefined;
      if (entityId) {
        const allowed = constraints.entity_allowlist.some((pattern) => {
          if (pattern.endsWith('.*')) {
            return entityId.startsWith(pattern.slice(0, -1));
          }
          return entityId === pattern;
        });
        if (!allowed) {
          return { passed: false, reason: `Entity '${entityId}' not in allowlist`, requires_clarification: true, sanitized_arguments: sanitized };
        }
      }
    }

    // Max intensity check
    if (constraints?.max_intensity !== null && constraints?.max_intensity !== undefined) {
      const args = tc.arguments as Record<string, unknown>;
      const serviceData = args.service_data as Record<string, unknown> | undefined;
      const brightness = serviceData?.brightness_pct ?? args.brightness_pct;
      if (typeof brightness === 'number' && brightness > constraints.max_intensity) {
        return { passed: false, reason: `Brightness ${brightness}% exceeds max ${constraints.max_intensity}%`, requires_clarification: true, sanitized_arguments: sanitized };
      }
    }

    // Temperature range check
    if (constraints?.temperature_range) {
      const args = tc.arguments as Record<string, unknown>;
      const serviceData = args.service_data as Record<string, unknown> | undefined;
      const temperature = serviceData?.temperature ?? args.temperature;
      const [minimum, maximum] = constraints.temperature_range;
      if (
        typeof temperature === 'number'
        && (temperature < minimum || temperature > maximum)
      ) {
        return {
          passed: false,
          reason: `Temperature ${temperature} outside allowed range ${minimum}-${maximum}`,
          requires_clarification: true,
          sanitized_arguments: sanitized,
        };
      }
    }

    return { passed: true, requires_clarification: false, sanitized_arguments: sanitized };
  });
}
