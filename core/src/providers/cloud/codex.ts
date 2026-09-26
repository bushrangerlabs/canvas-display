/**
 * OpenAI Responses API LLM adapter.
 *
 * Talks to the OpenAI Responses API at `POST /v1/responses` instead of the
 * Chat Completions endpoint. It supports OpenAI's current general-purpose and
 * Codex models through one wire format.
 *
 * The Responses API uses a different wire format:
 *   - `instructions` replaces system messages
 *   - `input` is a flat list of typed items (not a messages array)
 *   - Tool definitions use `type: 'function'` with `strict: true` by default
 *   - Tool results are sent as `function_call_output` input items
 *   - Responses contain typed `output` items instead of `choices`
 *
 * We translate between the internal ChatMessage/ToolDefinition format and
 * the Responses API format transparently, so the rest of Canvas Core doesn't
 * need to know about the API difference.
 *
 * Config: `apiKey`, `model` (for example, "gpt-5" or "codex-mini-latest"),
 * optional `baseUrl`, `temperature`, `maxTokens`, `timeoutMs`.
 */
import type { ChatMessage, ChatWithToolsResult, HealthStatus } from '../types.js';
import type { ChatWithToolsOptions, FetchImpl, LlmProvider, ToolDefinition } from '../llm.js';

export interface CodexLlmOptions {
  /** OpenAI API key (sk-...). Required. */
  apiKey: string;
  /** Model id, e.g. "codex-mini-latest", "GPT-5.3-Codex". */
  model: string;
  /** Override base URL (defaults to public OpenAI endpoint). */
  baseUrl?: string;
  /** Optional temperature override. Note: GPT-5+ models may ignore this. */
  temperature?: number;
  /** Max output tokens (Responses API parameter). Default 4096. */
  maxTokens?: number;
  /** Optional request timeout in ms. */
  timeoutMs?: number;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: FetchImpl;
  /** Label used in health reports. */
  name?: string;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export class CodexLlm implements LlmProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly temperature: number | undefined;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchImpl;
  private readonly name: string;

  constructor(opts: CodexLlmOptions) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.temperature = opts.temperature;
    this.maxTokens = opts.maxTokens ?? 4096;
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.name = opts.name ?? 'codex';
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const url = `${this.baseUrl}/responses`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const { instructions, input } = this.toResponsesInput(messages);
      const body: Record<string, unknown> = {
        model: this.model,
        input,
      };
      if (instructions) body.instructions = instructions;
      if (this.temperature !== undefined) body.temperature = this.temperature;
      body.max_output_tokens = this.maxTokens;

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
        throw new Error(`Codex ${res.status}: ${text.slice(0, 200)}`);
      }
      return this.extractText(await res.json());
    } finally {
      clearTimeout(timer);
    }
  }

  async chatWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    opts?: ChatWithToolsOptions,
  ): Promise<ChatWithToolsResult> {
    const url = `${this.baseUrl}/responses`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const { instructions, input } = this.toResponsesInput(messages);
      const body: Record<string, unknown> = {
        model: this.model,
        input,
      };
      if (instructions) body.instructions = instructions;
      if (this.temperature !== undefined) body.temperature = this.temperature;
      body.max_output_tokens = opts?.maxTokens ?? this.maxTokens;
      if (opts?.responseSchema) {
        body.text = {
          format: {
            type: 'json_schema', name: opts.responseSchema.name,
            strict: true, schema: opts.responseSchema.schema,
          },
        };
      }
      if (tools.length > 0) body.tools = this.toResponsesTools(tools);

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
        throw new Error(`Codex ${res.status}: ${text.slice(0, 200)}`);
      }
      return this.parseToolResponse(await res.json());
    } finally {
      clearTimeout(timer);
    }
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
      return { name: this.name, kind: 'CodexLlm', healthy: ok, detail };
    } catch (err) {
      return {
        name: this.name,
        kind: 'CodexLlm',
        healthy: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async analyzeImage(prompt: string, imageBase64: string, mimeType: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          max_output_tokens: this.maxTokens,
          input: [{
            type: 'message', role: 'user', content: [
              { type: 'input_text', text: prompt },
              { type: 'input_image', image_url: `data:${mimeType};base64,${imageBase64}` },
            ],
          }],
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`OpenAI vision ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return this.extractText(await res.json());
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Message translation ──────────────────────────────────────────────────

  /**
   * Convert a ChatMessage array into Responses API `instructions` + `input`.
   *
   * System messages become `instructions`; messages, function calls, and tool
   * results retain their native Responses API item types. This keeps tool-call
   * identity intact across orchestration iterations.
   */
  private toResponsesInput(messages: ChatMessage[]): {
    instructions: string;
    input: Array<Record<string, unknown>>;
  } {
    let instructions = '';
    const input: Array<Record<string, unknown>> = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        instructions = instructions ? `${instructions}\n\n${msg.content}` : msg.content;
      } else if (msg.role === 'user') {
        input.push({ type: 'message', role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        if (msg.content) input.push({ type: 'message', role: 'assistant', content: msg.content });
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          for (const call of msg.tool_calls) {
            input.push({
              type: 'function_call', call_id: call.id,
              name: call.function.name, arguments: call.function.arguments,
            });
          }
        }
      } else if (msg.role === 'tool') {
        input.push({ type: 'function_call_output', call_id: msg.tool_call_id ?? 'unknown', output: msg.content });
      }
    }

    return {
      instructions,
      input,
    };
  }

  /**
   * Convert internal ToolDefinition array into Responses API tool format.
   * The Responses API uses `strict: true` by default and a slightly
   * different wrapping (same JSON Schema shape for parameters).
   */
  private toResponsesTools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
    return tools.map((t) => ({
      type: 'function',
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
      strict: true,
    }));
  }

  // ── Response parsing ─────────────────────────────────────────────────────

  /** Extract text content from a Responses API response. */
  private extractText(json: Record<string, unknown>): string {
    const output = json.output as Array<Record<string, unknown>> | undefined;
    if (!output) {
      throw new Error('Codex response missing output array');
    }
    const parts: string[] = [];
    for (const item of output) {
      if (item.type === 'message') {
        const content = item.content as Array<Record<string, unknown>> | undefined;
        if (content) {
          for (const c of content) {
            if (c.type === 'output_text' && typeof c.text === 'string') {
              parts.push(c.text);
            }
          }
        }
      }
    }
    const text = parts.join('');
    if (!text) {
      throw new Error('Codex response contained no text output');
    }
    return text;
  }

  /** Parse tool calls from a Responses API response. */
  private parseToolResponse(json: Record<string, unknown>): ChatWithToolsResult {
    const output = json.output as Array<Record<string, unknown>> | undefined;
    if (!output) {
      throw new Error('Codex response missing output array');
    }

    let content = '';
    const toolCalls: ChatWithToolsResult['toolCalls'] = [];

    for (const item of output) {
      if (item.type === 'message') {
        const messageContent = item.content as Array<Record<string, unknown>> | undefined;
        if (messageContent) {
          for (const c of messageContent) {
            if (c.type === 'output_text' && typeof c.text === 'string') {
              content += c.text;
            }
          }
        }
      } else if (item.type === 'function_call') {
        toolCalls.push({
          id: String(item.call_id ?? item.id ?? ''),
          type: 'function',
          function: {
            name: String(item.name ?? ''),
            arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
          },
        });
      }
    }

    return { content, toolCalls };
  }
}
