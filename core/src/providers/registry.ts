/**
 * Multi-provider AI model registry (D-010 extension: pluggable providers).
 *
 * The registry holds multiple configured AI providers (LLM, ASR, TTS) and routes
 * each task type ('intent_routing', 'conversation', 'asr', 'tts', 'embedding')
 * to the provider assigned to it. This supports two operating modes:
 *
 *   - **Simple mode**: only one LLM/ASR/TTS provider is configured. All tasks
 *     of that type use it (current behavior, backward compatible).
 *   - **Advanced mode**: multiple providers of the same type are configured
 *     (e.g. a cloud LLM for conversation + a local LLM for intent routing).
 *     Each task can be assigned to a specific provider by ID.
 *
 * Providers are constructed by `config-loader.ts` from env vars or a JSON config
 * and registered here. The registry is the single source of truth for "which
 * provider handles which task" — `intelligence.ts` asks it for the provider
 * instead of constructing one directly.
 */
import type { LlmProvider } from './llm.js';
import type { TranscriptionProvider } from './asr.js';
import type { SpeechProvider } from './tts.js';
import type { HealthStatus } from './types.js';

/** The kind of inference a provider performs. */
export type ProviderType = 'llm' | 'asr' | 'tts';

/** Concrete vendor / implementation identifier. */
export type ProviderKind =
  | 'openai'
  | 'openrouter'
  | 'anthropic'
  | 'gemini'
  | 'groq'
  | 'azure'
  | 'llama-cpp'
  | 'ollama'
  | 'vllm'
  | 'whisper'
  | 'piper'
  | 'coqui';

/** Task types that can be routed to a specific provider. */
export type TaskType =
  | 'intent_routing'
  | 'conversation'
  | 'vision'
  | 'asr'
  | 'tts'
  | 'embedding';

/** Provider-specific configuration (baseUrl, apiKey, model, etc.). */
export type ProviderConfig = Record<string, unknown>;

/** A configured provider entry in the registry. */
export interface RegisteredProvider {
  /** Unique provider id (e.g. "local-llm", "cloud-llm"). */
  id: string;
  /** What this provider does: llm, asr, or tts. */
  type: ProviderType;
  /** Concrete vendor / implementation (e.g. "openai", "llama-cpp"). */
  kind: ProviderKind;
  /** Provider-specific config (baseUrl, apiKey, model, etc.). */
  config: ProviderConfig;
  /** Cached health status from the last `healthCheckAll()` run. */
  healthy: boolean | null;
  /** Cached detail from the last health check. */
  healthDetail?: string;
}

/** A provider entry plus its constructed instance (internal to the registry). */
interface ResolvedProvider extends RegisteredProvider {
  /** The live provider instance (LlmProvider / TranscriptionProvider / SpeechProvider). */
  instance: LlmProvider | TranscriptionProvider | SpeechProvider;
}

/** Public view of a provider returned by `listProviders()`. */
export interface ProviderInfo extends RegisteredProvider {
  /** The task types currently assigned to this provider. */
  assignedTasks: TaskType[];
}

/** Mapping of task type → provider id. */
export type TaskAssignments = Partial<Record<TaskType, string>>;

/** Result of `healthCheckAll()` for a single provider. */
export interface ProviderHealthResult {
  id: string;
  type: ProviderType;
  kind: ProviderKind;
  healthy: boolean;
  detail?: string;
}

export interface AiProviderRegistryOptions {
  /** Initial set of providers (already constructed). */
  providers?: Array<{
    id: string;
    type: ProviderType;
    kind: ProviderKind;
    config: ProviderConfig;
    instance: LlmProvider | TranscriptionProvider | SpeechProvider;
  }>;
  /** Initial task assignments. */
  assignments?: TaskAssignments;
}

/**
 * `AiProviderRegistry` — the multi-provider AI brain router.
 *
 * Holds providers keyed by id, plus a task→provider assignment map. When asked
 * for the provider for a task, it returns the assigned one, or falls back to
 * the first available provider of the matching type.
 *
 * Task → provider type mapping:
 *   - intent_routing → llm
 *   - conversation    → llm
 *   - asr             → asr
 *   - tts             → tts
 *   - embedding       → llm (no dedicated embedding provider type yet)
 */
export class AiProviderRegistry {
  private readonly providers = new Map<string, ResolvedProvider>();
  private readonly assignments: TaskAssignments = {};

  constructor(opts: AiProviderRegistryOptions = {}) {
    if (opts.providers) {
      for (const p of opts.providers) {
        this.addProvider(p.id, p.type, p.kind, p.config, p.instance);
      }
    }
    if (opts.assignments) {
      for (const [task, providerId] of Object.entries(opts.assignments)) {
        if (typeof providerId === 'string') {
          this.assignments[task as TaskType] = providerId;
        }
      }
    }
  }

  /** Register a constructed provider instance. */
  addProvider(
    id: string,
    type: ProviderType,
    kind: ProviderKind,
    config: ProviderConfig,
    instance: LlmProvider | TranscriptionProvider | SpeechProvider,
  ): void {
    if (this.providers.has(id)) {
      throw new Error(`AI provider '${id}' is already registered`);
    }
    this.providers.set(id, { id, type, kind, config, healthy: null, instance });
  }

  /** Remove a provider by id. Clears any task assignments pointing at it. */
  removeProvider(id: string): boolean {
    const existed = this.providers.delete(id);
    if (existed) {
      for (const [task, providerId] of Object.entries(this.assignments)) {
        if (providerId === id) {
          delete this.assignments[task as TaskType];
        }
      }
    }
    return existed;
  }

  /** Returns the provider type expected to handle a task. */
  static taskTypeToProviderType(task: TaskType): ProviderType {
    switch (task) {
      case 'intent_routing':
      case 'conversation':
      case 'vision':
      case 'embedding':
        return 'llm';
      case 'asr':
        return 'asr';
      case 'tts':
        return 'tts';
    }
  }

  /**
   * Returns the provider assigned to a task. Falls back to the first available
   * provider of the matching type if no assignment exists (simple mode).
   * Returns `undefined` if no provider of the required type is configured.
   */
  getProvider(task: TaskType): ResolvedProvider | undefined {
    const assignedId = this.assignments[task];
    if (assignedId) {
      const p = this.providers.get(assignedId);
      if (p) return p;
      // Stale assignment — clear and fall through to fallback.
      delete this.assignments[task];
    }
    const wantType = AiProviderRegistry.taskTypeToProviderType(task);
    // Fallback: first provider of the matching type.
    for (const p of this.providers.values()) {
      if (p.type === wantType) return p;
    }
    return undefined;
  }

  /** Returns the LLM provider for a task (throws if none configured). */
  getLlmProvider(task: TaskType = 'conversation'): LlmProvider | undefined {
    const p = this.getProvider(task);
    return p?.type === 'llm' ? (p.instance as LlmProvider) : undefined;
  }

  /** Returns an LLM provider by its registry id, or undefined if not found or not an LLM. */
  getLlmProviderById(id: string): LlmProvider | undefined {
    const p = this.providers.get(id);
    return p?.type === 'llm' ? (p.instance as LlmProvider) : undefined;
  }

  /** Returns the ASR provider for the 'asr' task. */
  getAsrProvider(): TranscriptionProvider | undefined {
    const p = this.getProvider('asr');
    return p?.type === 'asr' ? (p.instance as TranscriptionProvider) : undefined;
  }

  /** Returns the TTS provider for the 'tts' task. */
  getTtsProvider(): SpeechProvider | undefined {
    const p = this.getProvider('tts');
    return p?.type === 'tts' ? (p.instance as SpeechProvider) : undefined;
  }

  /** Assign a task to a specific provider by id. */
  assignTask(task: TaskType, providerId: string): void {
    const p = this.providers.get(providerId);
    if (!p) {
      throw new Error(`Cannot assign task '${task}': provider '${providerId}' not found`);
    }
    const wantType = AiProviderRegistry.taskTypeToProviderType(task);
    if (p.type !== wantType) {
      throw new Error(
        `Cannot assign task '${task}' (expects ${wantType}) to provider '${providerId}' (type ${p.type})`,
      );
    }
    this.assignments[task] = providerId;
  }

  /** Clear a task assignment (revert to fallback). */
  unassignTask(task: TaskType): void {
    delete this.assignments[task];
  }

  /** Returns the current task→provider assignments. */
  getAssignments(): TaskAssignments {
    return { ...this.assignments };
  }

  /** Returns all configured providers with health status and assigned tasks. */
  listProviders(): ProviderInfo[] {
    return Array.from(this.providers.values()).map((p) => ({
      id: p.id,
      type: p.type,
      kind: p.kind,
      config: p.config,
      healthy: p.healthy,
      healthDetail: p.healthDetail,
      assignedTasks: (Object.keys(this.assignments) as TaskType[]).filter(
        (t) => this.assignments[t] === p.id,
      ),
    }));
  }

  /** Returns true if more than one provider of a given type is configured. */
  isAdvancedMode(): boolean {
    const counts: Record<ProviderType, number> = { llm: 0, asr: 0, tts: 0 };
    for (const p of this.providers.values()) counts[p.type]++;
    return counts.llm > 1 || counts.asr > 1 || counts.tts > 1;
  }

  /** Returns the number of configured providers (optionally filtered by type). */
  size(type?: ProviderType): number {
    if (!type) return this.providers.size;
    let n = 0;
    for (const p of this.providers.values()) if (p.type === type) n++;
    return n;
  }

  /**
   * Probes every configured provider and caches the result. Returns the
   * per-provider health. Never throws — a failing provider is reported as
   * unhealthy (plan §20.4: inference failure must not crash Core).
   */
  async healthCheckAll(): Promise<ProviderHealthResult[]> {
    const entries = Array.from(this.providers.values());
    const results = await Promise.all(
      entries.map(async (p): Promise<ProviderHealthResult> => {
        try {
          const status: HealthStatus = await (p.instance as {
            healthCheck(): Promise<HealthStatus>;
          }).healthCheck();
          p.healthy = status.healthy;
          p.healthDetail = status.detail;
          return {
            id: p.id,
            type: p.type,
            kind: p.kind,
            healthy: status.healthy,
            detail: status.detail,
          };
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          p.healthy = false;
          p.healthDetail = detail;
          return { id: p.id, type: p.type, kind: p.kind, healthy: false, detail };
        }
      }),
    );
    return results;
  }
}
