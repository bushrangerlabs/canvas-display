/**
 * Google Gemini cloud LLM adapter (multi-provider registry, D-010 extension).
 *
 * Uses Google's Generative Language API:
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={apiKey}
 *   Body: { contents: [{ role, parts: [{ text }] }], systemInstruction?: { parts: [{ text }] } }
 *   Response: { candidates: [{ content: { parts: [{ text }] } }] }
 *
 * Roles are "user" and "model" (not "assistant"). System messages are hoisted
 * into `systemInstruction`.
 *
 * Config: `apiKey`, `model` (e.g. "gemini-1.5-pro"), optional `baseUrl`,
 * `temperature`, `timeoutMs`.
 */
import type { ChatMessage, ChatWithToolsResult, HealthStatus } from '../types.js';
import type { FetchImpl, LlmProvider, ToolDefinition } from '../llm.js';

export interface GeminiLlmOptions {
  /** Google AI Studio API key. */
  apiKey: string;
  /** Model id, e.g. "gemini-1.5-pro", "gemini-1.5-flash". */
  model: string;
  /** Override base URL (defaults to public Google endpoint). */
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

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiLlm implements LlmProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchImpl;
  private readonly name: string;

  constructor(opts: GeminiLlmOptions) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.temperature = opts.temperature ?? 0.7;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.name = opts.name ?? 'gemini';
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const url = `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    // System messages go into systemInstruction; user/assistant map to user/model.
    const systemText = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const convo = messages.filter((m) => m.role !== 'system');
    const contents = convo.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const body: Record<string, unknown> = {
      contents,
      generationConfig: { temperature: this.temperature },
    };
    if (systemText.length > 0) {
      body.systemInstruction = { parts: [{ text: systemText }] };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Gemini ${res.status}: ${text.slice(0, 200)}`);
      }
      const json = (await res.json()) as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
        }>;
      };
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof text !== 'string') {
        throw new Error('Gemini response missing candidates[0].content.parts[0].text');
      }
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  async chatWithTools(_messages: ChatMessage[], _tools: ToolDefinition[]): Promise<ChatWithToolsResult> {
    // Gemini's API uses a different tool-calling shape (tools declaration,
    // functionCall response parts). Full Gemini tool support is a future concern;
    // for now fall through to plain chat and return no tool calls.
    const content = await this.chat(_messages);
    return { content, toolCalls: [] };
  }

  async healthCheck(): Promise<HealthStatus> {
    // List models for this key — cheap and validates the API key.
    const start = Date.now();
    try {
      const res = await this.fetchImpl(
        `${this.baseUrl}/models?key=${encodeURIComponent(this.apiKey)}`,
        { method: 'GET' },
      );
      const ok = res.ok;
      const detail = ok
        ? `models ok (${Date.now() - start}ms)`
        : `status ${res.status}`;
      return { name: this.name, kind: 'GeminiLlm', healthy: ok, detail };
    } catch (err) {
      return {
        name: this.name,
        kind: 'GeminiLlm',
        healthy: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
