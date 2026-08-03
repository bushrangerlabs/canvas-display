/**
 * Hermes HTTP API client — injectable interface + real + fake implementations
 * for calling the legacy Hermes agent on the main server (plan doc §15.6).
 *
 * Hermes is the agent running on the main server at 192.168.1.108. During
 * shadow mode (Phase 6), both Hermes and Canvas Intelligence evaluate the same
 * input so we can compare their structured outcomes.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface HermesQueryRequest {
  /** The user's voice transcript / query text. */
  transcript: string;
  /** Optional conversational context (previous turns, device info, etc.). */
  context?: Record<string, unknown>;
}

export interface HermesToolCall {
  tool: string;
  arguments: Record<string, unknown>;
}

export interface HermesQueryResponse {
  /** The structured intent name (e.g. "light_set", "unknown"). */
  intent: string;
  /** Entity IDs the agent resolved from the transcript. */
  entities: string[];
  /** Tool calls the agent decided to execute. */
  tool_calls: HermesToolCall[];
  /** Whether the agent determined clarification is needed. */
  clarification_needed: boolean;
  /** The natural language response text. */
  response: string;
  /** Confidence score (0-1). */
  confidence?: number;
  /** Raw response body for debugging. */
  raw?: unknown;
}

export interface HermesHealthStatus {
  healthy: boolean;
  version?: string;
  uptime_seconds?: number;
  detail?: string;
}

// ── Injectable interface ─────────────────────────────────────────────────────

export interface HermesClient {
  /** Send a query/transcript to Hermes and return the parsed response. */
  sendQuery(transcript: string, context?: Record<string, unknown>): Promise<HermesQueryResponse>;
  /** Ping the Hermes health endpoint. */
  healthCheck(): Promise<HermesHealthStatus>;
}

// ── Real HTTP client ─────────────────────────────────────────────────────────

export interface HermesHttpClientOptions {
  /** Base URL of the Hermes HTTP API (e.g. "http://192.168.1.108:3100/hermes"). */
  baseUrl: string;
  /** Optional timeout in milliseconds for each request (default 10_000). */
  timeoutMs?: number;
  /** Optional fetch implementation override (for tests). */
  fetchImpl?: typeof globalThis.fetch;
}

export class HermesHttpClient implements HermesClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(opts: HermesHttpClientOptions) {
    // Strip trailing slash for consistent URL construction.
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async sendQuery(transcript: string, context?: Record<string, unknown>): Promise<HermesQueryResponse> {
    const url = `${this.baseUrl}/query`;
    const body: HermesQueryRequest = { transcript, context };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Hermes HTTP ${response.status}: ${text}`);
      }

      const data = (await response.json()) as HermesQueryResponse;
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async healthCheck(): Promise<HermesHealthStatus> {
    const url = `${this.baseUrl}/health`;
    try {
      const response = await this.fetchImpl(url, { method: 'GET' });
      if (!response.ok) {
        return { healthy: false, detail: `HTTP ${response.status}` };
      }
      const data = (await response.json()) as HermesHealthStatus;
      return { ...data, healthy: true };
    } catch (err) {
      return {
        healthy: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// ── Fake/mock client for tests ───────────────────────────────────────────────

export interface FakeHermesClientOptions {
  /** Canned response returned by `sendQuery`. */
  queryResponse?: HermesQueryResponse;
  /** Canned health status returned by `healthCheck`. */
  healthStatus?: HermesHealthStatus;
  /** If true, `sendQuery` will throw an error. */
  shouldFail?: boolean;
  /** Error message when `shouldFail` is true. */
  failMessage?: string;
}

export class FakeHermesClient implements HermesClient {
  private readonly opts: FakeHermesClientOptions;

  constructor(opts: FakeHermesClientOptions = {}) {
    this.opts = opts;
  }

  async sendQuery(_transcript: string, _context?: Record<string, unknown>): Promise<HermesQueryResponse> {
    if (this.opts.shouldFail) {
      throw new Error(this.opts.failMessage ?? 'Hermes client simulated failure');
    }
    return this.opts.queryResponse ?? {
      intent: 'unknown',
      entities: [],
      tool_calls: [],
      clarification_needed: false,
      response: 'Mock Hermes response',
      confidence: 1.0,
    };
  }

  async healthCheck(): Promise<HermesHealthStatus> {
    return this.opts.healthStatus ?? { healthy: true, version: '0.0.0-test', uptime_seconds: 0 };
  }
}

/**
 * Helper to create a Hermes client from an environment variable.
 * If `CANVAS_CORE_HERMES_URL` is not set, returns `null` (shadow mode
 * will skip Hermes comparisons).
 *
 * @param baseUrl - The Hermes URL from config/env.
 * @param fetchImpl - Optional fetch override (for tests).
 */
export function createHermesClient(
  baseUrl?: string,
  fetchImpl?: typeof globalThis.fetch,
): HermesClient | null {
  if (!baseUrl) return null;
  return new HermesHttpClient({ baseUrl, fetchImpl });
}