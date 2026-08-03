/**
 * LLM provider (plan doc §15.4, D-010).
 *
 * `OpenAiCompatibleLlm` talks to any OpenAI-compatible `/v1/chat/completions`
 * endpoint — verified against the running `qwen36-mtp` llama.cpp server on the
 * main server (OpenAI-compatible API at `/v1`, `GET /v1/models` returns the
 * loaded GGUF). The base URL and `fetch` are injectable so unit tests stub the
 * network entirely.
 *
 * `DegradedLlm` is the deterministic fallback required by D-010: when the real
 * provider is unavailable, Core still returns a canned, predictable response
 * instead of failing the whole voice turn (plan §14.6 / §20.4).
 *
 * PHASE SCOPE: this is the model-provider abstraction scaffold (Phase 2/early).
 * Streaming, token accounting, and circuit breakers are later (Phase 5/6)
 * concerns and are intentionally not here yet. Tool-calling support was added
 * early (Phase 2.5) so the AI chat endpoint can surface MCP tools.
 */
import type { ChatMessage, ChatWithToolsResult, HealthStatus } from './types.js';

/**
 * An LLM-compatible tool definition (OpenAI `tools` parameter shape).
 * The LLM uses this to decide when to invoke a tool.
 */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Minimal subset of the global `fetch` we depend on (keeps tests easy to stub). */
export type FetchImpl = typeof fetch;

export interface LlmProvider {
  /** Return the assistant text for a chat exchange. */
  chat(messages: ChatMessage[]): Promise<string>;
  streamChat?(messages: ChatMessage[]): AsyncIterable<string>;
  /**
   * Send a chat exchange with tool definitions. The LLM may respond with
   * text, tool calls, or both. The caller is responsible for executing
   * tool calls and looping back with results.
   */
  chatWithTools(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatWithToolsResult>;
  /** Analyze a base64 image when the backing model supports multimodal input. */
  analyzeImage?(prompt: string, imageBase64: string, mimeType: string): Promise<string>;
  /** Lightweight availability probe. */
  healthCheck(): Promise<HealthStatus>;
}

export interface OpenAiCompatibleLlmOptions {
  /** Base URL, e.g. "http://host.docker.internal:8089/v1". */
  baseUrl: string;
  /** Model id sent in the request body. */
  model?: string;
  /** Optional temperature override. */
  temperature?: number;
  /** Optional request timeout in ms. */
  timeoutMs?: number;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: FetchImpl;
  /** Label used in health reports. */
  name?: string;
}

const DEFAULT_MODEL = 'local';

export class OpenAiCompatibleLlm implements LlmProvider {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchImpl;
  private readonly name: string;

  constructor(opts: OpenAiCompatibleLlmOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.model = opts.model ?? DEFAULT_MODEL;
    this.temperature = opts.temperature ?? 0.7;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.name = opts.name ?? 'llm';
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const url = `${this.baseUrl}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: this.temperature,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`LLM ${res.status}: ${text.slice(0, 200)}`);
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new Error('LLM response missing choices[0].message.content');
      }
      return content;
    } finally {
      clearTimeout(timer);
    }
  }

  async *streamChat(messages: ChatMessage[]): AsyncIterable<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, messages, temperature: this.temperature, stream: true }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`LLM streaming request failed: ${res.status}`);
      const reader = res.body.getReader(); const decoder = new TextDecoder(); let pending = '';
      for (;;) {
        const { value, done } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        const lines = pending.split('\n'); pending = lines.pop() ?? '';
        for (const line of lines) {
          const data = line.trim().replace(/^data:\s*/, '');
          if (!data || data === '[DONE]') continue;
          const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        }
        if (done) break;
      }
    } finally { clearTimeout(timer); }
  }

  async chatWithTools(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatWithToolsResult> {
    const url = `${this.baseUrl}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const body: Record<string, unknown> = {
        model: this.model,
        messages,
        temperature: this.temperature,
      };
      if (tools.length > 0) {
        body.tools = tools;
      }
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`LLM ${res.status}: ${text.slice(0, 200)}`);
      }
      const json = (await res.json()) as {
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: Array<{
              id: string;
              type: 'function';
              function: { name: string; arguments: string };
            }>;
          };
        }>;
      };
      const message = json.choices?.[0]?.message;
      if (!message) {
        throw new Error('LLM response missing choices[0].message');
      }
      return {
        content: message.content ?? '',
        toolCalls: (message.tool_calls ?? []).map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        })),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async analyzeImage(prompt: string, imageBase64: string, mimeType: string): Promise<string> {
    const url = `${this.baseUrl}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
            ],
          }],
          temperature: this.temperature,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Vision LLM ${res.status}: ${text.slice(0, 200)}`);
      }
      const json = await res.json() as { choices?: Array<{ message?: { content?: string | null } }> };
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('Vision LLM response missing content');
      return content;
    } finally {
      clearTimeout(timer);
    }
  }

  async healthCheck(): Promise<HealthStatus> {
    const start = Date.now();
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/models`, {
        method: 'GET',
      });
      const ok = res.ok;
      const detail = ok ? `models ok (${Date.now() - start}ms)` : `status ${res.status}`;
      return { name: this.name, kind: 'OpenAiCompatibleLlm', healthy: ok, detail };
    } catch (err) {
      return {
        name: this.name,
        kind: 'OpenAiCompatibleLlm',
        healthy: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export interface DegradedLlmOptions {
  /** Canned reply returned when the real provider is down. */
  fallback?: string;
  name?: string;
}

/**
 * Deterministic degraded LLM (D-010). Always "healthy" from Core's perspective
 * (it never fails to answer) and returns a stable canned response. This keeps a
 * voice turn from hard-failing when the GPU/llama.cpp container is offline.
 */
export class DegradedLlm implements LlmProvider {
  private readonly fallback: string;
  private readonly name: string;

  constructor(opts: DegradedLlmOptions = {}) {
    this.fallback =
      opts.fallback ??
      "I'm running in degraded mode: the language model is unavailable right now, " +
        'but I received your message. Please try again shortly.';
    this.name = opts.name ?? 'llm';
  }

  async chat(_messages: ChatMessage[]): Promise<string> {
    return this.fallback;
  }

  async chatWithTools(_messages: ChatMessage[], _tools: ToolDefinition[]): Promise<ChatWithToolsResult> {
    return { content: this.fallback, toolCalls: [] };
  }

  async healthCheck(): Promise<HealthStatus> {
    return {
      name: this.name,
      kind: 'DegradedLlm',
      healthy: true,
      detail: 'deterministic fallback (real provider offline)',
    };
  }
}
