/**
 * OpenAI cloud LLM adapter (multi-provider registry, D-010 extension).
 *
 * Talks directly to the OpenAI Chat Completions REST API at
 * `https://api.openai.com/v1/chat/completions` using `fetch`. No SDK dependency —
 * keeps the bundle small and the I/O injectable for tests.
 *
 * Config: `apiKey`, `model` (e.g. "gpt-4o", "gpt-4o-mini"), optional
 * `baseUrl` (defaults to the public OpenAI endpoint), `temperature`, `timeoutMs`.
 */
import type { ChatMessage, ChatWithToolsResult, HealthStatus } from '../types.js';
import type { FetchImpl, LlmProvider, ToolDefinition } from '../llm.js';

export interface OpenAiLlmOptions {
  /** API key (sk-...). Required. */
  apiKey: string;
  /** Model id, e.g. "gpt-4o", "gpt-4o-mini". */
  model: string;
  /** Override base URL (rare; defaults to public OpenAI endpoint). */
  baseUrl?: string;
  /** Optional temperature override. */
  temperature?: number;
  /** Optional request timeout in ms. */
  timeoutMs?: number;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: FetchImpl;
  /** Label used in health reports. */
  name?: string;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export class OpenAiLlm implements LlmProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchImpl;
  private readonly name: string;

  constructor(opts: OpenAiLlmOptions) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.temperature = opts.temperature ?? 0.7;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.name = opts.name ?? 'openai';
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const url = `${this.baseUrl}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: this.temperature,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`OpenAI ${res.status}: ${text.slice(0, 200)}`);
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string; tool_calls?: unknown } }>;
      };
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new Error('OpenAI response missing choices[0].message.content');
      }
      return content;
    } finally {
      clearTimeout(timer);
    }
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
      if (tools.length > 0) body.tools = tools;
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`OpenAI ${res.status}: ${text.slice(0, 200)}`);
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
        throw new Error('OpenAI response missing choices[0].message');
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, messages: [{ role: 'user', content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
        ] }], temperature: this.temperature }), signal: controller.signal,
      });
      if (!res.ok) throw new Error(`OpenAI vision ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('OpenAI vision response missing content');
      return content;
    } finally { clearTimeout(timer); }
  }

  async healthCheck(): Promise<HealthStatus> {
    const start = Date.now();
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: { authorization: `Bearer ${this.apiKey}` },
      });
      const ok = res.ok;
      const detail = ok
        ? `models ok (${Date.now() - start}ms)`
        : `status ${res.status}`;
      return { name: this.name, kind: 'OpenAiLlm', healthy: ok, detail };
    } catch (err) {
      return {
        name: this.name,
        kind: 'OpenAiLlm',
        healthy: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
