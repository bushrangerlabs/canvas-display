/**
 * Anthropic cloud LLM adapter (multi-provider registry, D-010 extension).
 *
 * Anthropic's Messages API has a different shape from OpenAI's:
 *   POST https://api.anthropic.com/v1/messages
 *   Headers: x-api-key, anthropic-version: 2023-06-01
 *   Body: { model, max_tokens, system?, messages: [{role, content}] }
 *   Response: { content: [{ type: "text", text: "..." }] }
 *
 * System messages are NOT allowed in the `messages` array — they go in a
 * top-level `system` field. We split them out before sending.
 *
 * Config: `apiKey`, `model` (e.g. "claude-3-5-sonnet-20241022"), optional
 * `baseUrl`, `maxTokens`, `temperature`, `timeoutMs`.
 */
import type { ChatMessage, ChatWithToolsResult, HealthStatus } from '../types.js';
import type { FetchImpl, LlmProvider, ToolDefinition } from '../llm.js';

export interface AnthropicLlmOptions {
  /** Anthropic API key (sk-ant-...). */
  apiKey: string;
  /** Model id, e.g. "claude-3-5-sonnet-20241022". */
  model: string;
  /** Override base URL (defaults to public Anthropic endpoint). */
  baseUrl?: string;
  /** Max output tokens (Anthropic requires this). Default 1024. */
  maxTokens?: number;
  /** Optional temperature override. */
  temperature?: number;
  /** Optional request timeout in ms. */
  timeoutMs?: number;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: FetchImpl;
  /** Label used in health reports. */
  name?: string;
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';

export class AnthropicLlm implements LlmProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchImpl;
  private readonly name: string;

  constructor(opts: AnthropicLlmOptions) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.maxTokens = opts.maxTokens ?? 1024;
    this.temperature = opts.temperature ?? 0.7;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.name = opts.name ?? 'anthropic';
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const url = `${this.baseUrl}/messages`;
    // Anthropic requires system messages to be hoisted out of the messages array.
    const systemText = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const convo = messages.filter((m) => m.role !== 'system');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const body: Record<string, unknown> = {
        model: this.model,
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        messages: convo,
      };
      if (systemText.length > 0) body.system = systemText;

      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Anthropic ${res.status}: ${text.slice(0, 200)}`);
      }
      const json = (await res.json()) as {
        content?: Array<{ type: string; text?: string }>;
      };
      const textBlock = json.content?.find((b) => b.type === 'text');
      if (typeof textBlock?.text !== 'string') {
        throw new Error('Anthropic response missing content[].text');
      }
      return textBlock.text;
    } finally {
      clearTimeout(timer);
    }
  }

  async chatWithTools(_messages: ChatMessage[], _tools: ToolDefinition[]): Promise<ChatWithToolsResult> {
    // Anthropic's Messages API uses a different tool-calling shape (tools block,
    // tool_use content blocks). Full Anthropic tool support is a future concern;
    // for now fall through to plain chat and return no tool calls.
    const content = await this.chat(_messages);
    return { content, toolCalls: [] };
  }

  async healthCheck(): Promise<HealthStatus> {
    // Anthropic has no public /models endpoint; do a minimal 1-token chat probe.
    const start = Date.now();
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      const ok = res.ok;
      const detail = ok
        ? `messages ok (${Date.now() - start}ms)`
        : `status ${res.status}`;
      return { name: this.name, kind: 'AnthropicLlm', healthy: ok, detail };
    } catch (err) {
      return {
        name: this.name,
        kind: 'AnthropicLlm',
        healthy: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
