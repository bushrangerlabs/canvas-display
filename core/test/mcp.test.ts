import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { HttpJsonRpcMcpClient, StdioMcpClient } from '../src/providers/mcp.js';
import { mockFetch, jsonResponse } from './helpers.js';
import type { FetchImpl } from '../src/providers/llm.js';

test('McpClient.listTools returns tools from a mocked tools/list', async () => {
  const fetchImpl: FetchImpl = mockFetch((_url, init) => {
    const body = JSON.parse((init?.body as string) ?? '{}');
    if (body.method === 'initialize') {
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'afl-mcp' } } });
    }
    assert.equal(body.method, 'tools/list');
    return jsonResponse({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        tools: [
          { name: 'get_afl_teams', description: 'AFL teams', inputSchema: { type: 'object', properties: {} } },
        ],
      },
    });
  });
  const mcp = new HttpJsonRpcMcpClient({ baseUrl: 'http://mcp', fetchImpl });
  const tools = await mcp.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'get_afl_teams');
});

test('McpClient.callTool invokes tools/call and returns content', async () => {
  const fetchImpl: FetchImpl = mockFetch((_url, init) => {
    const body = JSON.parse((init?.body as string) ?? '{}');
    if (body.method === 'initialize') {
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'afl-mcp' } } });
    }
    assert.equal(body.method, 'tools/call');
    assert.equal(body.params.name, 'get_afl_teams');
    return jsonResponse({
      jsonrpc: '2.0',
      id: body.id,
      result: { content: [{ type: 'text', text: 'Adelaide' }] },
    });
  });
  const mcp = new HttpJsonRpcMcpClient({ baseUrl: 'http://mcp', fetchImpl });
  const res = await mcp.callTool('get_afl_teams', {});
  assert.equal(res.content[0].text, 'Adelaide');
});

test('McpClient.healthCheck initializes and reports server info', async () => {
  const fetchImpl: FetchImpl = mockFetch((_url, init) => {
    const body = JSON.parse((init?.body as string) ?? '{}');
    return jsonResponse({
      jsonrpc: '2.0',
      id: body.id,
      result: { protocolVersion: '2025-03-26', serverInfo: { name: 'afl-mcp', version: '1.0.0' } },
    });
  });
  const mcp = new HttpJsonRpcMcpClient({ baseUrl: 'http://mcp', fetchImpl });
  const h = await mcp.healthCheck();
  assert.equal(h.healthy, true);
  assert.match(h.detail ?? '', /afl-mcp/);
});

test('McpClient surfaces JSON-RPC errors', async () => {
  const fetchImpl: FetchImpl = mockFetch((_url, init) => {
    const body = JSON.parse((init?.body as string) ?? '{}');
    return jsonResponse({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'boom' } });
  });
  const mcp = new HttpJsonRpcMcpClient({ baseUrl: 'http://mcp', fetchImpl });
  await assert.rejects(() => mcp.listTools());
});

// ---------------------------------------------------------------------------
// StdioMcpClient tests
//
// We use the injectable `spawnImpl` option so tests can supply a fake process
// without needing to monkey-patch node:child_process.
// ---------------------------------------------------------------------------

import type { spawn as SpawnFn } from 'node:child_process';

/** Minimal fake ChildProcess for testing StdioMcpClient. */
class FakeChildProcess extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  pid = 9999;
  killed = false;

  constructor(
    private readonly handler: (line: string) => string | null,
  ) {
    super();
    const self = this;

    this.stdin = new Writable({
      write(chunk: Buffer | string, _enc, cb) {
        const text = chunk.toString();
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const response = self.handler(trimmed);
          if (response !== null) {
            queueMicrotask(() => self.stdout.emit('data', response + '\n'));
          }
        }
        cb();
      },
    });

    this.stdout = new Readable({ read() {} });
    this.stderr = new Readable({ read() {} });
  }

  kill(_signal?: string): boolean {
    this.killed = true;
    return true;
  }
}

function makeSpawnImpl(handler: (line: string) => string | null): typeof SpawnFn {
  return ((() => new FakeChildProcess(handler)) as unknown) as typeof SpawnFn;
}

/** A canned JSON-RPC handler that serves tools/list and tools/call. */
function makeStdioHandler(toolName: string): (line: string) => string | null {
  return (line: string) => {
    let msg: { jsonrpc: string; id?: number; method: string; params: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      return null;
    }
    if (msg.id == null) return null; // notification — no response

    if (msg.method === 'initialize') {
      return JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'test-mcp' } } });
    }
    if (msg.method === 'tools/list') {
      return JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: toolName, description: 'A test tool' }] } });
    }
    if (msg.method === 'tools/call') {
      return JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'result-ok' }] } });
    }
    return JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
  };
}

test('StdioMcpClient.listTools returns tools from a mocked child process', async () => {
  const client = new StdioMcpClient({
    command: 'fake-mcp',
    name: 'test',
    autoRestart: false,
    spawnImpl: makeSpawnImpl(makeStdioHandler('my_tool')),
  });
  try {
    const tools = await client.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'my_tool');
  } finally {
    client.destroy();
  }
});

test('StdioMcpClient.callTool returns content from a mocked child process', async () => {
  const client = new StdioMcpClient({
    command: 'fake-mcp',
    name: 'test',
    autoRestart: false,
    spawnImpl: makeSpawnImpl(makeStdioHandler('my_tool')),
  });
  try {
    const res = await client.callTool('my_tool', { x: 1 });
    assert.equal((res.content[0] as { text: string }).text, 'result-ok');
  } finally {
    client.destroy();
  }
});

test('StdioMcpClient.healthCheck reports server info from a mocked child process', async () => {
  const client = new StdioMcpClient({
    command: 'fake-mcp',
    name: 'test',
    autoRestart: false,
    spawnImpl: makeSpawnImpl(makeStdioHandler('my_tool')),
  });
  try {
    const h = await client.healthCheck();
    assert.equal(h.healthy, true);
    assert.match(h.detail ?? '', /test-mcp/);
  } finally {
    client.destroy();
  }
});

test('StdioMcpClient rejects on JSON-RPC error response', async () => {
  const spawnImpl = makeSpawnImpl((line: string) => {
    const msg = JSON.parse(line) as { id?: number; method: string };
    if (msg.id == null) return null;
    if (msg.method === 'initialize') {
      return JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'err-mcp' } } });
    }
    return JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'boom' } });
  });
  const client = new StdioMcpClient({ command: 'fake-mcp', name: 'test', autoRestart: false, spawnImpl });
  try {
    await assert.rejects(() => client.listTools(), /boom/);
  } finally {
    client.destroy();
  }
});
