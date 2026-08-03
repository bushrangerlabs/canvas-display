/**
 * Azure OpenAI cloud LLM adapter (multi-provider registry, D-010 extension).
 *
 * Azure OpenAI uses a different URL shape than OpenAI:
 *   POST https://{resource}.cognitiveservices.azure.com/openai/deployments/{deployment}/chat/completions?api-version=2024-10-21
 *   Headers: api-key: {apiKey}  (NOT "Authorization: Bearer")
 *   Body: same as OpenAI (but no `model` field — the deployment name in the URL
 *   selects the model).
 *
 * Config: `apiKey`, `resource` (Azure resource name), `deployment` (deployment
 * id), optional `apiVersion`, `baseUrl`, `temperature`, `timeoutMs`.
 */
import type { ChatMessage, ChatWithToolsResult, HealthStatus } from '../types.js';
import type { FetchImpl, LlmProvider, ToolDefinition } from '../llm.js';

export interface AzureOpenAiLlmOptions {
  /** Azure OpenAI API key. */
  apiKey: string;
  /** Azure resource name, e.g. "my-org-openai". */
  resource: string;
  /** Deployment id, e.g. "gpt-4o-deployment". */
  deployment: string;
  /** API version, defaults to "2024-10-21". */
  apiVersion?: string;
  /** Override base URL (defaults to public Azure endpoint). */
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

const DEFAULT_API_VERSION = '2024-10-21';
const DEFAULT_BASE_URL_TEMPLATE = 'https://{resource}.cognitiveservices.azure.com/openai';

export class AzureOpenAiLlm implements LlmProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly deployment: string;
  private readonly apiVersion: string;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchImpl;
  private readonly name: string;

  constructor(opts: AzureOpenAiLlmOptions) {
    const baseTemplate = opts.baseUrl ?? DEFAULT_BASE_URL_TEMPLATE;
    this.baseUrl = baseTemplate.replace('{resource}', opts.resource).replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.deployment = opts.deployment;
    this.apiVersion = opts.apiVersion ?? DEFAULT_API_VERSION;
    this.temperature = opts.temperature ?? 0.7;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.name = opts.name ?? 'azure';
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const url =
      `${this.baseUrl}/deployments/${encodeURIComponent(this.deployment)}/chat/completions` +
      `?api-version=${encodeURIComponent(this.apiVersion)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'api-key': this.apiKey,
        },
        body: JSON.stringify({
          // Azure uses the deployment in the URL; `model` is optional but harmless.
          messages,
          temperature: this.temperature,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Azure OpenAI ${res.status}: ${text.slice(0, 200)}`);
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string; tool_calls?: unknown } }>;
      };
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new Error('Azure OpenAI response missing choices[0].message.content');
      }
      return content;
    } finally {
      clearTimeout(timer);
    }
  }

  async chatWithTools(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatWithToolsResult> {
    const url =
      `${this.baseUrl}/deployments/${encodeURIComponent(this.deployment)}/chat/completions` +
      `?api-version=${encodeURIComponent(this.apiVersion)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const body: Record<string, unknown> = {
        messages,
        temperature: this.temperature,
      };
      if (tools.length > 0) body.tools = tools;
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'api-key': this.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Azure OpenAI ${res.status}: ${text.slice(0, 200)}`);
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
        throw new Error('Azure OpenAI response missing choices[0].message');
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

  async healthCheck(): Promise<HealthStatus> {
    // Azure has no public /models endpoint; do a minimal 1-token chat probe.
    const start = Date.now();
    try {
      const url =
        `${this.baseUrl}/deployments/${encodeURIComponent(this.deployment)}/chat/completions` +
        `?api-version=${encodeURIComponent(this.apiVersion)}`;
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'api-key': this.apiKey,
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
      });
      const ok = res.ok;
      const detail = ok
        ? `deployment ok (${Date.now() - start}ms)`
        : `status ${res.status}`;
      return { name: this.name, kind: 'AzureOpenAiLlm', healthy: ok, detail };
    } catch (err) {
      return {
        name: this.name,
        kind: 'AzureOpenAiLlm',
        healthy: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
