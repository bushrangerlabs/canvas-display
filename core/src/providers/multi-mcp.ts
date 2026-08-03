/**
 * Multi-MCP server manager (D-011). Core connects to multiple MCP servers
 * and aggregates their tools into a single tool surface for Canvas Intelligence.
 *
 * Each MCP server is configured via env vars:
 *   CANVAS_CORE_MCP_URLS=http://host.docker.internal:5020,http://host.docker.internal:5021
 * Or individually:
 *   CANVAS_CORE_MCP_URL_1=http://host.docker.internal:5020
 *   CANVAS_CORE_MCP_URL_2=http://host.docker.internal:5021
 *
 * Each server's tools are namespaced as `<server_name>.<tool_name>` to avoid collisions.
 */
import { HttpJsonRpcMcpClient, StdioMcpClient, type McpClient, type McpTool, type McpToolCallResult } from './mcp.js';
import type { HealthStatus } from './types.js';

export type McpServerConfig =
  | {
      type?: 'http'; // default when omitted for backward compat
      name: string;
      url: string;
    }
  | {
      type: 'stdio';
      name: string;
      /** The executable to spawn, e.g. "npx" or "python3". */
      command: string;
      /** Arguments for the command. */
      args?: string[];
      /** Extra environment variables for the child process. */
      env?: Record<string, string>;
    };

export interface AggregatedMcpTool extends McpTool {
  /** The MCP server that provides this tool. */
  serverName: string;
  /** The original tool name (without the server prefix). */
  originalName: string;
  /** The namespaced tool name: `<server_name>.<tool_name>`. */
  namespacedName: string;
}

export class MultiMcpManager implements McpClient {
  private readonly servers: Array<{ config: McpServerConfig; client: McpClient }>;
  private cachedTools: AggregatedMcpTool[] | null = null;

  constructor(configs: McpServerConfig[]) {
    this.servers = configs.map((c) => ({
      config: c,
      client: c.type === 'stdio'
        ? new StdioMcpClient({ command: c.command, args: c.args, env: c.env, name: c.name })
        : new HttpJsonRpcMcpClient({ baseUrl: c.url, name: c.name }),
    }));
  }

  /**
   * Lists all tools from all connected MCP servers, namespaced as
   * `<server_name>.<tool_name>`.
   */
  async listTools(): Promise<McpTool[]> {
    if (this.cachedTools) return this.cachedTools;

    const allTools: AggregatedMcpTool[] = [];
    for (const { config, client } of this.servers) {
      try {
        const tools = await client.listTools();
        for (const tool of tools) {
          allTools.push({
            ...tool,
            serverName: config.name,
            originalName: tool.name,
            namespacedName: `${config.name}.${tool.name}`,
            name: `${config.name}.${tool.name}`,
          });
        }
      } catch (err) {
        console.error(`[core][mcp] failed to list tools from ${config.name}:`, err instanceof Error ? err.message : err);
      }
    }
    this.cachedTools = allTools;
    return allTools;
  }

  /**
   * Calls a tool by its namespaced name (`<server_name>.<tool_name>`).
   * If the name doesn't contain a dot, tries each server in order.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const dotIndex = name.indexOf('.');
    if (dotIndex > 0) {
      const serverName = name.substring(0, dotIndex);
      const toolName = name.substring(dotIndex + 1);
      const server = this.servers.find((s) => s.config.name === serverName);
      if (!server) {
        throw new Error(`MCP server '${serverName}' not found for tool '${name}'`);
      }
      return server.client.callTool(toolName, args);
    }
    // No namespace — try each server
    for (const { client } of this.servers) {
      try {
        return await client.callTool(name, args);
      } catch {
        // Try next server
      }
    }
    throw new Error(`Tool '${name}' not found on any MCP server`);
  }

  async healthCheck(): Promise<HealthStatus> {
    if (this.servers.length === 0) {
      return {
        name: 'mcp',
        kind: 'MultiMcpManager',
        healthy: false,
        detail: 'no MCP servers configured',
      };
    }
    const results = await Promise.all(
      this.servers.map(async ({ config, client }) => {
        const health = await client.healthCheck();
        return { config, health };
      }),
    );
    const healthy = results.filter((r) => r.health.healthy);
    const unhealthy = results.filter((r) => !r.health.healthy);
    const detail = `${healthy.length}/${results.length} servers up` +
      (unhealthy.length > 0 ? ` (down: ${unhealthy.map((r) => r.config.name).join(', ')})` : '');
    return {
      name: 'mcp',
      kind: 'MultiMcpManager',
      healthy: healthy.length > 0,
      detail,
    };
  }

  /** Returns per-server health for the providers endpoint. */
  async perServerHealth(): Promise<HealthStatus[]> {
    return Promise.all(
      this.servers.map(async ({ config, client }) => {
        const health = await client.healthCheck();
        return { ...health, name: `mcp:${config.name}` };
      }),
    );
  }

  /** Returns the list of configured server names. */
  get serverNames(): string[] {
    return this.servers.map((s) => s.config.name);
  }

  /**
   * Returns health + tool info for each server using the already-running clients.
   * Much faster than spawning new processes for each GET request.
   */
  async getServerInfos(): Promise<Array<{
    name: string;
    type: 'http' | 'stdio';
    url?: string;
    command?: string;
    args?: string[];
    healthy: boolean;
    detail: string;
    tools: string[];
  }>> {
    return Promise.all(
      this.servers.map(async ({ config, client }) => {
        const base = config.type === 'stdio'
          ? { name: config.name, type: 'stdio' as const, command: config.command, args: config.args }
          : { name: config.name, type: 'http' as const, url: config.url };

        let healthy = false;
        let detail = 'unknown';
        let tools: string[] = [];
        try {
          const health = await client.healthCheck();
          healthy = health.healthy;
          detail = health.detail ?? 'ok';
          if (healthy) {
            const toolList = await client.listTools();
            tools = toolList.map((t) => t.name);
          }
        } catch (err) {
          detail = err instanceof Error ? err.message : String(err);
        }
        return { ...base, healthy, detail, tools };
      }),
    );
  }
}

/**
 * Parses MCP server configs from environment variables.
 *
 * HTTP servers (existing):
 *   CANVAS_CORE_MCP_URL=http://host.docker.internal:5020          (single, backward compat)
 *   CANVAS_CORE_MCP_URLS=http://...,http://...                    (comma-separated)
 *   CANVAS_CORE_MCP_URL_1=http://...  CANVAS_CORE_MCP_NAME_1=...  (indexed)
 *
 * Stdio servers (new):
 *   CANVAS_CORE_MCP_CMD_1=npx  CANVAS_CORE_MCP_ARGS_1=-y,@modelcontextprotocol/server-filesystem,/tmp
 *   CANVAS_CORE_MCP_NAME_1=fs-mcp  (optional, defaults to stdio-N)
 *   CANVAS_CORE_MCP_ENV_1=KEY=val,KEY2=val2  (optional extra env vars)
 *
 * Note: CANVAS_CORE_MCP_CMD_N and CANVAS_CORE_MCP_URL_N share the same index namespace.
 * If both are set for the same index, URL takes precedence.
 */
export function parseMcpServerConfigs(env: NodeJS.ProcessEnv): McpServerConfig[] {
  const configs: McpServerConfig[] = [];

  // Backward compat: single CANVAS_CORE_MCP_URL
  const singleUrl = env.CANVAS_CORE_MCP_URL;
  if (singleUrl) {
    configs.push({ name: 'mcp', url: singleUrl });
  }

  // Comma-separated list
  const urlsEnv = env.CANVAS_CORE_MCP_URLS;
  if (urlsEnv) {
    const urls = urlsEnv.split(',').map((u) => u.trim()).filter(Boolean);
    for (let i = 0; i < urls.length; i++) {
      configs.push({ name: `mcp-${i + 1}`, url: urls[i] });
    }
  }

  // Individual CANVAS_CORE_MCP_URL_N (http) or CANVAS_CORE_MCP_CMD_N (stdio)
  for (let i = 1; i <= 20; i++) {
    const url = env[`CANVAS_CORE_MCP_URL_${i}`];
    const cmd = env[`CANVAS_CORE_MCP_CMD_${i}`];
    if (url) {
      const name = env[`CANVAS_CORE_MCP_NAME_${i}`] || `mcp-${i}`;
      configs.push({ name, url });
    } else if (cmd) {
      const name = env[`CANVAS_CORE_MCP_NAME_${i}`] || `stdio-${i}`;
      const argsRaw = env[`CANVAS_CORE_MCP_ARGS_${i}`];
      const args = argsRaw ? argsRaw.split(',').map((a) => a.trim()) : [];
      const envRaw = env[`CANVAS_CORE_MCP_ENV_${i}`];
      const extraEnv: Record<string, string> = {};
      if (envRaw) {
        for (const pair of envRaw.split(',')) {
          const eqIdx = pair.indexOf('=');
          if (eqIdx > 0) extraEnv[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
        }
      }
      configs.push({ type: 'stdio', name, command: cmd, args, env: extraEnv });
    }
  }

  // Deduplicate: HTTP by URL, stdio by command+args
  const seen = new Set<string>();
  return configs.filter((c) => {
    const key = c.type === 'stdio' ? `stdio:${c.command}:${(c.args ?? []).join(',')}` : `http:${c.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
