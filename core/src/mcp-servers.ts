/**
 * MCP Servers CRUD — store and manage MCP server configurations in PostgreSQL.
 *
 * Servers can be added/removed/updated at runtime via the admin API.
 * After every mutation the MultiMcpManager is reloaded from the database.
 *
 * Supports two transport types:
 *   - http  (default): JSON-RPC over HTTP POST. Requires `url`.
 *   - stdio: JSON-RPC over stdin/stdout. Requires `command`; `args` and `env` are optional.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { MultiMcpManager, parseMcpServerConfigs, type McpServerConfig } from './providers/multi-mcp.js';
import { HttpJsonRpcMcpClient, StdioMcpClient } from './providers/mcp.js';
import type { AdminRole } from './auth.js';

/** Minimal requireAdmin signature matching what auth.ts returns. */
type RequireAdmin = (opts?: {
  roles?: AdminRole[];
  csrf?: boolean;
}) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface McpServerRow {
  name: string;
  type: 'http' | 'stdio';
  url: string;
  command: string | null;
  args: string | null;        // JSON array stored as text
  server_env: string | null;  // JSON object stored as text
  created_at: string;
}

export interface McpServerInfo {
  name: string;
  type: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  healthy: boolean;
  detail: string;
  tools: string[];
}

/**
 * Seeds MCP server configs parsed from environment variables into the database.
 * Uses ON CONFLICT DO NOTHING so it only runs once — subsequent restarts won't
 * overwrite any edits the user has made in the settings UI.
 *
 * Called at startup so env-var-defined servers (e.g. bowling, au-weather) are
 * visible in the settings UI immediately without manual DB inserts.
 */
export async function seedMcpServersFromEnv(pool: Pool): Promise<void> {
  const configs = parseMcpServerConfigs(process.env);
  if (configs.length === 0) return;

  for (const cfg of configs) {
    const type = cfg.type === 'stdio' ? 'stdio' : 'http';
    const url = cfg.type !== 'stdio' ? cfg.url : '';
    const command = cfg.type === 'stdio' ? cfg.command : null;
    const args = cfg.type === 'stdio' && cfg.args?.length ? JSON.stringify(cfg.args) : null;
    const env = cfg.type === 'stdio' && cfg.env && Object.keys(cfg.env).length
      ? JSON.stringify(cfg.env)
      : null;

    await pool.query(
      `INSERT INTO mcp_servers (name, url, type, command, args, server_env)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (name) DO NOTHING`,
      [cfg.name, url, type, command, args, env],
    );
  }
  console.log(`[core][mcp] seeded ${configs.length} env-var MCP server(s) into database`);
}

/**
 * Loads all MCP servers from the database and returns their configs.
 */
export async function loadMcpServerConfigs(pool: Pool): Promise<McpServerConfig[]> {
  const res = await pool.query<McpServerRow>(
    'SELECT name, type, url, command, args, server_env FROM mcp_servers ORDER BY created_at ASC',
  );
  return res.rows.map((r): McpServerConfig => {
    if (r.type === 'stdio') {
      return {
        type: 'stdio',
        name: r.name,
        command: r.command ?? '',
        args: r.args ? (JSON.parse(r.args) as string[]) : [],
        env: r.server_env ? (JSON.parse(r.server_env) as Record<string, string>) : {},
      };
    }
    return { type: 'http', name: r.name, url: r.url };
  });
}

/**
 * Builds a MultiMcpManager from database configs, or returns undefined if none.
 */
export async function buildMultiMcpFromDb(pool: Pool): Promise<MultiMcpManager | undefined> {
  const configs = await loadMcpServerConfigs(pool);
  if (configs.length === 0) return undefined;
  return new MultiMcpManager(configs);
}

/**
 * Gathers detailed info about each MCP server, including health and tool list.
 */
async function getMcpServerInfos(configs: McpServerConfig[]): Promise<McpServerInfo[]> {
  return Promise.all(
    configs.map(async (cfg): Promise<McpServerInfo> => {
      const client = cfg.type === 'stdio'
        ? new StdioMcpClient({ command: cfg.command, args: cfg.args, env: cfg.env, name: cfg.name, timeoutMs: 5_000 })
        : new HttpJsonRpcMcpClient({ baseUrl: cfg.url, name: cfg.name, timeoutMs: 5_000 });

      const base: Omit<McpServerInfo, 'healthy' | 'detail' | 'tools'> = cfg.type === 'stdio'
        ? { name: cfg.name, type: 'stdio', command: cfg.command, args: cfg.args }
        : { name: cfg.name, type: 'http', url: cfg.url };

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
      } finally {
        // Stdio clients hold a child process — clean up after the info check
        if (cfg.type === 'stdio' && client instanceof StdioMcpClient) {
          client.destroy();
        }
      }
      return { ...base, healthy, detail, tools };
    }),
  );
}

/**
 * Registers admin CRUD routes for MCP servers.
 */
export function registerMcpServerRoutes(
  fastify: FastifyInstance,
  pool: Pool,
  requireAdmin: RequireAdmin,
  getManager: () => MultiMcpManager | undefined,
  setManager: (m: MultiMcpManager | undefined) => void,
): void {
  // GET /api/admin/mcp-servers — list all configured MCP servers + health + tools
  fastify.get('/api/admin/mcp-servers', {
    preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }),
  }, async () => {
    const manager = getManager();
    if (manager) {
      // Fast path: use already-running clients — no process spawning
      const infos = await manager.getServerInfos();
      return { servers: infos };
    }
    // Fallback: spawn-and-destroy (no manager loaded yet)
    const configs = await loadMcpServerConfigs(pool);
    const infos = await getMcpServerInfos(configs);
    return { servers: infos };
  });

  // POST /api/admin/mcp-servers — add a new MCP server
  fastify.post('/api/admin/mcp-servers', {
    preHandler: requireAdmin({ roles: ['admin'], csrf: true }),
  }, async (request, reply) => {
    const body = request.body as {
      name?: string;
      type?: string;
      url?: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
    } | undefined;

    if (!body?.name) {
      return reply.code(400).send({ error: 'name is required' });
    }
    const type = body.type === 'stdio' ? 'stdio' : 'http';
    if (type === 'http' && !body.url) {
      return reply.code(400).send({ error: 'url is required for http servers' });
    }
    if (type === 'stdio' && !body.command) {
      return reply.code(400).send({ error: 'command is required for stdio servers' });
    }

    try {
      await pool.query(
        `INSERT INTO mcp_servers (name, url, type, command, args, server_env)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (name) DO UPDATE
           SET url = EXCLUDED.url,
               type = EXCLUDED.type,
               command = EXCLUDED.command,
               args = EXCLUDED.args,
               server_env = EXCLUDED.server_env`,
        [
          body.name,
          body.url ?? '',
          type,
          body.command ?? null,
          body.args ? JSON.stringify(body.args) : null,
          body.env ? JSON.stringify(body.env) : null,
        ],
      );
      setManager(await buildMultiMcpFromDb(pool));
      return reply.code(201).send({ ok: true, name: body.name });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // PUT /api/admin/mcp-servers/:name — update an MCP server
  fastify.put('/api/admin/mcp-servers/:name', {
    preHandler: requireAdmin({ roles: ['admin'], csrf: true }),
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const body = request.body as {
      type?: string;
      url?: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
    } | undefined;

    const type = body?.type === 'stdio' ? 'stdio' : 'http';
    if (type === 'http' && !body?.url) {
      return reply.code(400).send({ error: 'url is required for http servers' });
    }
    if (type === 'stdio' && !body?.command) {
      return reply.code(400).send({ error: 'command is required for stdio servers' });
    }

    const res = await pool.query(
      `UPDATE mcp_servers
          SET url = $1, type = $2, command = $3, args = $4, server_env = $5
        WHERE name = $6`,
      [
        body?.url ?? '',
        type,
        body?.command ?? null,
        body?.args ? JSON.stringify(body.args) : null,
        body?.env ? JSON.stringify(body.env) : null,
        name,
      ],
    );
    if (res.rowCount === 0) {
      return reply.code(404).send({ error: `MCP server '${name}' not found` });
    }
    setManager(await buildMultiMcpFromDb(pool));
    return { ok: true, name };
  });

  // DELETE /api/admin/mcp-servers/:name — delete an MCP server
  fastify.delete('/api/admin/mcp-servers/:name', {
    preHandler: requireAdmin({ roles: ['admin'], csrf: true }),
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const res = await pool.query('DELETE FROM mcp_servers WHERE name = $1', [name]);
    if (res.rowCount === 0) {
      return reply.code(404).send({ error: `MCP server '${name}' not found` });
    }
    // Reload the MultiMcpManager from DB
    setManager(await buildMultiMcpFromDb(pool));
    return { ok: true };
  });
}