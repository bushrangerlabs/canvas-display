import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ChatMessage, LlmToolCall } from './providers/types.js';

/**
 * Structured AI round-trip trace log.
 *
 * The text logger (`logger.ts`) captures console lines, but AI debugging needs
 * structured access to the full data of each LLM round trip: the exact messages
 * sent, the tool definitions offered, the model's response (content + tool
 * calls), and every tool execution (arguments + result). This module keeps a
 * bounded in-memory ring buffer of those records and exposes admin routes to
 * read and stream them — the structured counterpart to `log-routes.ts`.
 *
 * Records are produced from `intelligence.ts` at the LLM + tool-call boundaries:
 *   - `provider_attempt` — one provider candidate invocation (id, kind, model,
 *     latency, success/error, degraded fallback). Recorded for every LLM call
 *     that goes through `withConversationFailover`, including the tool loop.
 *   - `round_trip` — one LLM chat/chat-with-tools call with the full request
 *     messages, offered tools, response content and tool calls.
 *   - `tool_execution` — one tool-call execution (requested + canonical name,
 *     normalized arguments, result payload, confirmation status).
 *
 * `turnId` groups the records of one utterance; `iteration` identifies the tool
 * loop iteration within a turn (the loop can run up to 3 iterations).
 *
 * PRIVACY NOTE: records include raw user transcripts and tool results. The
 * endpoints below are admin/viewer-gated (same as the existing logs), and the
 * buffer is in-memory only (bounded, lost on restart). Keep this surface away
 * from unauthenticated or third-party sinks.
 */

type RequireAdmin = (opts?: {
  roles?: ('admin' | 'viewer')[];
  csrf?: boolean;
}) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export type AiLogKind = 'provider_attempt' | 'round_trip' | 'tool_execution';

export interface AiLogEntry {
  id: string;
  ts: string;
  kind: AiLogKind;
  /** Groups all records from one utterance/turn. */
  turnId?: string;
  /** Operation label passed to `withConversationFailover` (e.g. 'conversation', 'conversation_tools'). */
  operation?: string;
  /** Originating device id (when known). */
  deviceId?: string;
  /** Tool-loop iteration index within the turn (0-based). */
  iteration?: number;

  // provider_attempt
  providerId?: string;
  providerKind?: string;
  model?: string;
  latencyMs?: number;
  ok?: boolean;
  error?: string;
  degradedFallback?: boolean;

  // round_trip
  messages?: ChatMessage[];
  tools?: Array<{
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>;
  responseContent?: string;
  toolCalls?: LlmToolCall[];

  // tool_execution
  /** The tool_call id the model emitted (correlates with round_trip.toolCalls). */
  callId?: string;
  /** Tool name as requested by the model (pre-resolution). */
  requestedName?: string;
  /** Canonical tool name (post `resolveToolName`). */
  name?: string;
  /** Normalized arguments (post `normalizeToolArguments`). */
  args?: Record<string, unknown>;
  /** Human-readable execution message. */
  message?: string;
  /** Structured result payload returned by the tool. */
  result?: unknown;
  /** True when the tool required (and awaited) user confirmation. */
  requiresConfirmation?: boolean;
}

const MAX_ENTRIES = 500;
const entries: AiLogEntry[] = [];
export const aiLogEmitter = new EventEmitter();
aiLogEmitter.setMaxListeners(100);

function append(entry: Omit<AiLogEntry, 'id' | 'ts'>): AiLogEntry {
  const full: AiLogEntry = { id: randomUUID(), ts: new Date().toISOString(), ...entry };
  entries.push(full);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  aiLogEmitter.emit('entry', full);
  return full;
}

/** Record a provider candidate invocation (success, failure, or degraded fallback). */
export function recordAiProviderAttempt(fields: Omit<AiLogEntry, 'id' | 'ts' | 'kind'> & { kind: 'provider_attempt' }): AiLogEntry {
  return append(fields);
}

/** Record one LLM chat/chat-with-tools round trip with full request + response payloads. */
export function recordAiRoundTrip(fields: Omit<AiLogEntry, 'id' | 'ts' | 'kind'> & { kind: 'round_trip' }): AiLogEntry {
  return append(fields);
}

/** Record one tool-call execution, including its resolved name, arguments and result. */
export function recordAiToolExecution(fields: Omit<AiLogEntry, 'id' | 'ts' | 'kind'> & { kind: 'tool_execution' }): AiLogEntry {
  return append(fields);
}

/** Return all recorded entries in chronological (append) order. */
export function getAiLog(): AiLogEntry[] {
  return [...entries];
}

/** Return a single record by id, or undefined. */
export function getAiLogEntry(id: string): AiLogEntry | undefined {
  return entries.find((entry) => entry.id === id);
}

/** Drop all recorded entries. */
export function clearAiLog(): void {
  entries.length = 0;
}

export async function registerAiLogRoutes(
  fastify: FastifyInstance,
  requireAdmin: RequireAdmin,
): Promise<void> {
  fastify.get('/api/admin/ai-log', {
    preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }),
  }, async (request) => {
    const q = (request.query ?? {}) as Record<string, unknown>;
    const kind = typeof q.kind === 'string' ? q.kind : undefined;
    const deviceId = typeof q.deviceId === 'string' ? q.deviceId : undefined;
    const operation = typeof q.operation === 'string' ? q.operation : undefined;
    const limit = typeof q.limit === 'string' ? Number.parseInt(q.limit, 10) : undefined;

    let result = entries.filter((entry) => {
      if (kind && entry.kind !== kind) return false;
      if (deviceId && entry.deviceId !== deviceId) return false;
      if (operation && entry.operation !== operation) return false;
      return true;
    });

    // Newest first for convenient viewing.
    result = [...result].reverse();
    if (limit && Number.isFinite(limit) && limit > 0) result = result.slice(0, limit);

    return {
      count: result.length,
      total: entries.length,
      entries: result,
    };
  });

  fastify.get('/api/admin/ai-log/:id', {
    preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }),
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const entry = getAiLogEntry(id);
    if (!entry) {
      reply.code(404);
      return { error: 'entry_not_found' };
    }
    return { entry };
  });

  fastify.delete('/api/admin/ai-log', {
    preHandler: requireAdmin({ roles: ['admin'], csrf: true }),
  }, async () => {
    clearAiLog();
    return { ok: true };
  });

  fastify.get('/api/admin/ai-log/stream', {
    preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }),
  }, async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');

    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n');
    }, 15_000);
    heartbeat.unref();

    const onEntry = (entry: AiLogEntry) => {
      if (!reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(entry)}\n\n`);
    };
    aiLogEmitter.on('entry', onEntry);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      aiLogEmitter.off('entry', onEntry);
    });
  });
}