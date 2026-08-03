/**
 * Provider container health-check layer (plan doc §14.6, Phase 5).
 *
 * `ContainerHealthChecker` periodically polls each provider's health endpoint
 * and reports status without crashing Core when a provider is down (D-010
 * degraded mode). This is the production isolation layer for Whisper, Piper,
 * LLM, and MCP containers — each is health-checked independently.
 *
 * PHASE SCOPE: Phase 5 — "Isolate Whisper and Piper behind health-checked
 * provider adapters/containers with no default raw-audio persistence."
 */
import type { FetchImpl } from './llm.js';

export type ProviderName = 'asr' | 'tts' | 'llm' | 'mcp';

export interface ProviderContainerConfig {
  /** Stable provider key, e.g. 'asr', 'tts', 'llm', 'mcp'. */
  name: ProviderName;
  /** Base URL of the provider container, e.g. "http://whisper:10301". */
  url: string;
  /** Health endpoint path, e.g. "/health". */
  healthEndpoint: string;
  /** Request timeout in ms. */
  timeout: number;
  /** Max retries for a single health check cycle. */
  maxRetries: number;
  /** Human-readable container name for logging. */
  containerName: string;
  /** Optional custom health check function (for non-HTTP providers like TTS). */
  healthCheckFn?: () => Promise<{
    healthy: boolean;
    latencyMs: number;
    error: string | null;
  }>;
}

export interface ProviderHealthResult {
  provider: ProviderName;
  healthy: boolean;
  latencyMs: number;
  lastError: string | null;
  /** ISO timestamp of the last check. */
  lastChecked: string;
  /** Milliseconds since the provider was first seen as healthy (0 if unhealthy). */
  uptimeMs: number;
}

const DEFAULT_CHECK_INTERVAL_MS = 30_000;

/**
 * Periodically health-checks every configured provider container and reports
 * status. Never throws — provider failures are recorded as results and logged,
 * not propagated (D-010 degraded mode).
 */
export class ContainerHealthChecker {
  private readonly configs: Map<ProviderName, ProviderContainerConfig>;
  private readonly results: Map<ProviderName, ProviderHealthResult>;
  private readonly fetchImpl: FetchImpl;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private readonly startedAt: Date;
  private readonly healthySince: Map<ProviderName, Date>;

  constructor(
    configs: ProviderContainerConfig[],
    fetchImpl?: FetchImpl,
  ) {
    this.configs = new Map();
    this.results = new Map();
    this.healthySince = new Map();
    this.startedAt = new Date();
    this.fetchImpl = fetchImpl ?? fetch;

    for (const cfg of configs) {
      this.configs.set(cfg.name, cfg);
      this.results.set(cfg.name, {
        provider: cfg.name,
        healthy: false,
        latencyMs: 0,
        lastError: 'not yet checked',
        lastChecked: this.startedAt.toISOString(),
        uptimeMs: 0,
      });
    }
  }

  /** Start periodic health checks every `intervalMs` (default 30s). */
  start(intervalMs: number = DEFAULT_CHECK_INTERVAL_MS): void {
    if (this.intervalId) return;
    // Run an immediate check, then poll.
    this.checkAll().catch((err) => {
      console.error('[container-health] initial check failed:', (err as Error).message);
    });
    this.intervalId = setInterval(() => {
      this.checkAll().catch((err) => {
        console.error('[container-health] periodic check failed:', (err as Error).message);
      });
    }, intervalMs);
  }

  /** Stop periodic checks. */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** Run a single check against every provider. Returns current results. */
  async checkAll(): Promise<ProviderHealthResult[]> {
    const promises: Promise<ProviderHealthResult>[] = [];
    for (const [name, cfg] of this.configs) {
      promises.push(this.checkProvider(cfg));
    }
    const results = await Promise.allSettled(promises);
    const finalResults: ProviderHealthResult[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        finalResults.push(result.value);
      }
      // If a check itself throws (shouldn't happen), keep the last known result.
    }
    // If any provider was missed due to a rejected promise, preserve the old result.
    for (const [name, old] of this.results) {
      if (!finalResults.find((r) => r.provider === name)) {
        finalResults.push(old);
      }
    }
    return finalResults;
  }

  /** Returns providers whose last health check failed. */
  getUnhealthyProviders(): ProviderHealthResult[] {
    const unhealthy: ProviderHealthResult[] = [];
    for (const result of this.results.values()) {
      if (!result.healthy) {
        unhealthy.push(result);
      }
    }
    return unhealthy;
  }

  /** Get the last known result for a specific provider. */
  getLastResult(name: ProviderName): ProviderHealthResult | undefined {
    return this.results.get(name);
  }

  /** Returns all cached results without triggering new checks. */
  getCachedResults(): ProviderHealthResult[] {
    return Array.from(this.results.values());
  }

  /** Check a single provider, update internal state, and return the result. */
  private async checkProvider(
    cfg: ProviderContainerConfig,
  ): Promise<ProviderHealthResult> {
    const start = Date.now();
    let lastError: string | null = null;
    let healthy = false;

    try {
      if (cfg.healthCheckFn) {
        // Custom health check (e.g. TCP socket for TTS).
        const custom = await cfg.healthCheckFn();
        healthy = custom.healthy;
        lastError = custom.error;
      } else {
        // Default: HTTP GET to health endpoint.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), cfg.timeout);

        let lastErr: Error | null = null;
        for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
          try {
            const res = await this.fetchImpl(
              `${cfg.url.replace(/\/+$/, '')}/${cfg.healthEndpoint.replace(/^\/+/, '')}`,
              { method: 'GET', signal: controller.signal },
            );
            if (res.ok) {
              healthy = true;
              lastError = null;
              break;
            }
            lastErr = new Error(`HTTP ${res.status}`);
            if (attempt < cfg.maxRetries) {
              // Brief delay before retry (exponential backoff would be better,
              // but a simple short wait is fine for tests and prod).
              await new Promise((r) => setTimeout(r, 100));
            }
          } catch (err) {
            lastErr = err instanceof Error ? err : new Error(String(err));
            if (attempt < cfg.maxRetries) {
              await new Promise((r) => setTimeout(r, 100));
            }
          }
        }
        clearTimeout(timer);
        if (!healthy && lastErr) {
          lastError = lastErr.message;
        }
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      healthy = false;
    }

    const latencyMs = Date.now() - start;

    // Track healthy-since for uptime calculation.
    if (healthy) {
      if (!this.healthySince.has(cfg.name)) {
        this.healthySince.set(cfg.name, new Date());
      }
    } else {
      this.healthySince.delete(cfg.name);
    }

    const since = this.healthySince.get(cfg.name);
    const uptimeMs = since ? Date.now() - since.getTime() : 0;

    const result: ProviderHealthResult = {
      provider: cfg.name,
      healthy,
      latencyMs,
      lastError,
      lastChecked: new Date().toISOString(),
      uptimeMs,
    };

    this.results.set(cfg.name, result);

    // Log status changes.
    const prev = this.results.get(cfg.name);
    if (!prev || prev.healthy !== healthy) {
      if (healthy) {
        console.log(
          `[container-health] ${cfg.containerName} (${cfg.name}) is UP (${latencyMs}ms)`,
        );
      } else {
        console.warn(
          `[container-health] ${cfg.containerName} (${cfg.name}) is DOWN: ${lastError}`,
        );
      }
    }

    return result;
  }
}