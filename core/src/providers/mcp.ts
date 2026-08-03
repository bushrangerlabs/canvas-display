/**
 * MCP client (plan doc §15.4, D-011). Core is an MCP *client* that consumes
 * external MCP servers to expose tools/integrations to Canvas Intelligence.
 *
 * Three client implementations:
 *
 * - `HttpJsonRpcMcpClient` — JSON-RPC 2.0 over HTTP POST. Handles both plain
 *   JSON responses and SSE-wrapped JSON-RPC responses (HA-MCP server style).
 *   Verified against `afl-mcp` (plain JSON) and `ha-mcp` (SSE-wrapped).
 *
 * - `SseMcpClient` — full MCP SSE transport. Opens a long-lived GET to the SSE
 *   endpoint, receives a session-specific POST URL via the `endpoint` event,
 *   then sends JSON-RPC via POST while receiving responses over the SSE stream.
 *
 * - `StdioMcpClient` — JSON-RPC 2.0 over stdio. Spawns a local child process
 *   (e.g. `npx @modelcontextprotocol/server-*` or a Python MCP server) and
 *   communicates via newline-delimited JSON on stdin/stdout. Restarts the
 *   process automatically on unexpected exits.
 *
 * PHASE SCOPE: tool discovery + invocation scaffold (Phase2/early). Capability
 * negotiation and `notifications/initialized` handshake are included.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { HealthStatus } from './types.js';
import type { FetchImpl } from './llm.js';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolCallResult {
  /** Raw tool result content (MCP returns an array of content blocks). */
  content: Array<Record<string, unknown>>;
  isError?: boolean;
}

export interface McpClient {
  /** List tools exposed by the server. */
  listTools(): Promise<McpTool[]>;
  /** Call a tool by name with arguments. */
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult>;
  healthCheck(): Promise<HealthStatus>;
}

export interface HttpJsonRpcMcpClientOptions {
  /** Base URL of the MCP server, e.g. "http://host.docker.internal:5020". */
  baseUrl: string;
  /** Optional client info reported in `initialize`. */
  clientInfo?: { name: string; version: string };
  /** Request timeout in ms. */
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
  name?: string;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Parse an SSE stream text and return the first `event: message` data JSON. */
function parseSseResponse(text: string): unknown {
  const lines = text.split('\n');
  let eventType = '';
  let dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('event: ')) {
      eventType = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      dataLines.push(line.slice(6));
    } else if (line === '' && eventType === 'message' && dataLines.length > 0) {
      return JSON.parse(dataLines.join('\n'));
    }
  }
  if (eventType === 'message' && dataLines.length > 0) {
    return JSON.parse(dataLines.join('\n'));
  }
  throw new Error('No SSE message event found in response');
}

export class HttpJsonRpcMcpClient implements McpClient {
  private readonly baseUrl: string;
  private readonly clientInfo: { name: string; version: string };
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchImpl;
  private readonly name: string;
  private initialized = false;

  constructor(opts: HttpJsonRpcMcpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.clientInfo = opts.clientInfo ?? { name: 'canvas-core', version: '0.1.0' };
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.name = opts.name ?? 'mcp';
  }

  private async rpc<T>(method: string, params: unknown): Promise<T> {
    if (method !== 'initialize' && !this.initialized) {
      await this.initialize();
    }
    const id = Math.floor(Math.random() * 1e9);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.baseUrl + '/', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`MCP ${res.status}: ${text.slice(0, 200)}`);
      }
      const contentType = res.headers.get('content-type') ?? '';
      const text = await res.text();
      let json: JsonRpcResponse;
      if (contentType.includes('text/event-stream') || text.trimStart().startsWith('event:')) {
        json = parseSseResponse(text) as JsonRpcResponse;
      } else {
        json = JSON.parse(text) as JsonRpcResponse;
      }
      if (json.error) {
        throw new Error(`MCP error ${json.error.code}: ${json.error.message}`);
      }
      return json.result as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async initialize(): Promise<void> {
    await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: this.clientInfo,
    });
    this.initialized = true;
  }

  async listTools(): Promise<McpTool[]> {
    const res = await this.rpc<{ tools?: McpTool[] }>('tools/list', {});
    return res.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const res = await this.rpc<McpToolCallResult>('tools/call', {
      name,
      arguments: args,
    });
    return res;
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      const res = await this.rpc<{ serverInfo?: { name?: string } }>('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: this.clientInfo,
      });
      this.initialized = true;
      return {
        name: this.name,
        kind: 'HttpJsonRpcMcpClient',
        healthy: true,
        detail: `server: ${res.serverInfo?.name ?? 'unknown'}`,
      };
    } catch (err) {
      return {
        name: this.name,
        kind: 'HttpJsonRpcMcpClient',
        healthy: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// StdioMcpClient
// ---------------------------------------------------------------------------

export interface StdioMcpClientOptions {
  /** The executable to spawn, e.g. "npx" or "python". */
  command: string;
  /** Arguments for the command, e.g. ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]. */
  args?: string[];
  /** Extra environment variables merged with process.env. */
  env?: Record<string, string>;
  /** Optional client info reported during `initialize`. */
  clientInfo?: { name: string; version: string };
  /** Per-request timeout in ms (default 15 000). */
  timeoutMs?: number;
  /** Friendly name for logging/health. */
  name?: string;
  /** When true, automatically restart the child process if it exits unexpectedly (default true). */
  autoRestart?: boolean;
  /** Maximum restart attempts before giving up (default 5). */
  maxRestarts?: number;
  /**
   * Injectable spawn implementation — for unit tests only.
   * Defaults to `child_process.spawn`.
   */
  spawnImpl?: typeof spawn;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * MCP client that communicates with a locally-spawned child process via
 * newline-delimited JSON-RPC 2.0 on stdin/stdout (the MCP stdio transport).
 *
 * The process is spawned lazily on first use and restarted automatically on
 * unexpected exits (up to `maxRestarts` times). Call `destroy()` to shut it
 * down gracefully.
 */
export class StdioMcpClient extends EventEmitter implements McpClient {
  private readonly opts: Required<StdioMcpClientOptions>;
  private readonly spawnImpl: typeof spawn;
  private proc: ChildProcess | null = null;
  private initialized = false;
  private pending = new Map<number | string, PendingRequest>();
  private nextId = 1;
  private restarts = 0;
  private destroyed = false;
  private lineBuffer = '';

  constructor(opts: StdioMcpClientOptions) {
    super();
    this.spawnImpl = opts.spawnImpl ?? spawn;
    this.opts = {
      command: opts.command,
      args: opts.args ?? [],
      env: opts.env ?? {},
      clientInfo: opts.clientInfo ?? { name: 'canvas-core', version: '0.1.0' },
      timeoutMs: opts.timeoutMs ?? 15_000,
      name: opts.name ?? 'stdio-mcp',
      autoRestart: opts.autoRestart ?? true,
      maxRestarts: opts.maxRestarts ?? 5,
      spawnImpl: opts.spawnImpl ?? spawn,
    };
  }

  // ---------- process lifecycle -------------------------------------------

  private ensureProcess(): ChildProcess {
    if (this.proc && !this.proc.killed) return this.proc;
    const { command, args, env } = this.opts;
    const child = this.spawnImpl(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    this.proc = child;
    this.lineBuffer = '';

    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => this.onData(chunk));

    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      console.warn(`[core][mcp:stdio:${this.opts.name}] stderr:`, chunk.trimEnd());
    });

    child.on('exit', (code, signal) => {
      console.warn(`[core][mcp:stdio:${this.opts.name}] process exited (code=${code} signal=${signal})`);
      this.initialized = false;
      this.proc = null;
      // Reject all pending requests
      for (const [, req] of this.pending) {
        clearTimeout(req.timer);
        req.reject(new Error(`MCP stdio process exited (code=${code})`));
      }
      this.pending.clear();
      // Auto-restart unless destroyed or limit reached
      if (!this.destroyed && this.opts.autoRestart && this.restarts < this.opts.maxRestarts) {
        this.restarts++;
        console.info(`[core][mcp:stdio:${this.opts.name}] restarting (attempt ${this.restarts}/${this.opts.maxRestarts})`);
        this.ensureProcess();
      } else if (!this.destroyed) {
        console.error(`[core][mcp:stdio:${this.opts.name}] max restarts reached — giving up`);
      }
    });

    return child;
  }

  private onData(chunk: string): void {
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split('\n');
    this.lineBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse;
        const pending = this.pending.get(msg.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
        } else {
          pending.resolve(msg.result);
        }
      } catch {
        // Non-JSON line from the process (e.g. startup banner) — ignore
      }
    }
  }

  // ---------- JSON-RPC send ------------------------------------------------

  private sendRpc<T>(method: string, params: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP stdio timeout calling ${method}`));
      }, this.opts.timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      const proc = this.ensureProcess();
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      proc.stdin!.write(msg, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error(`MCP stdio write error: ${err.message}`));
        }
      });
    });
  }

  private async rpc<T>(method: string, params: unknown): Promise<T> {
    if (method !== 'initialize' && !this.initialized) {
      await this.initialize();
    }
    return this.sendRpc<T>(method, params);
  }

  private async initialize(): Promise<void> {
    await this.sendRpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: this.opts.clientInfo,
    });
    // Send initialized notification (no response expected)
    const proc = this.ensureProcess();
    proc.stdin!.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n',
    );
    this.initialized = true;
  }

  // ---------- McpClient interface -----------------------------------------

  async listTools(): Promise<McpTool[]> {
    const res = await this.rpc<{ tools?: McpTool[] }>('tools/list', {});
    return res.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    return this.rpc<McpToolCallResult>('tools/call', { name, arguments: args });
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      const res = await this.rpc<{ serverInfo?: { name?: string } }>('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: this.opts.clientInfo,
      });
      this.initialized = true;
      return {
        name: this.opts.name,
        kind: 'StdioMcpClient',
        healthy: true,
        detail: `server: ${res.serverInfo?.name ?? 'unknown'} (pid: ${this.proc?.pid ?? 'none'})`,
      };
    } catch (err) {
      return {
        name: this.opts.name,
        kind: 'StdioMcpClient',
        healthy: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Terminate the child process and stop auto-restart. */
  destroy(): void {
    this.destroyed = true;
    if (this.proc && !this.proc.killed) {
      this.proc.stdin!.end();
      this.proc.kill('SIGTERM');
    }
    for (const [, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error('StdioMcpClient destroyed'));
    }
    this.pending.clear();
  }
}
