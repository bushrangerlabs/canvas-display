/**
 * Provider configuration loader (multi-provider registry, D-010 extension).
 *
 * Parses provider configuration from environment variables and constructs the
 * concrete provider instances. Two modes:
 *
 *   - **Simple mode** (backward compat): individual env vars configure one
 *     provider per type:
 *       CANVAS_CORE_LLM_BASE_URL, CANVAS_CORE_LLM_API_KEY, CANVAS_CORE_LLM_MODEL
 *       CANVAS_CORE_WHISPER_URL, CANVAS_CORE_WHISPER_MODEL
 *       CANVAS_CORE_PIPER_URL (or CANVAS_CORE_PIPER_HOST + CANVAS_CORE_PIPER_PORT)
 *
 *   - **Advanced mode**: a single JSON env var configures multiple providers
 *     and task assignments:
 *       CANVAS_CORE_AI_PROVIDERS='{"providers":[...],"assignments":{...}}'
 *
 * Advanced mode takes precedence over simple mode when both are set.
 */
import type { ProviderConfig, ProviderKind, ProviderType, TaskAssignments } from './registry.js';
import type { LlmProvider } from './llm.js';
import type { TranscriptionProvider } from './asr.js';
import type { SpeechProvider } from './tts.js';
import { OpenAiCompatibleLlm, type FetchImpl } from './llm.js';
import { WhisperTranscription } from './asr.js';
import { PiperSpeech } from './tts.js';
import { OpenAiLlm } from './cloud/openai.js';
import { OpenRouterLlm } from './cloud/openrouter.js';
import { AnthropicLlm } from './cloud/anthropic.js';
import { GeminiLlm } from './cloud/gemini.js';
import { GroqLlm } from './cloud/groq.js';
import { AzureOpenAiLlm } from './cloud/azure.js';
import { OllamaLlm } from './local/ollama.js';

/** A raw provider config entry as it appears in the JSON env var. */
export interface RawProviderConfig {
  id: string;
  type: ProviderType;
  kind: ProviderKind;
  config: ProviderConfig;
}

/** The full JSON shape of `CANVAS_CORE_AI_PROVIDERS`. */
export interface AiProvidersJsonConfig {
  providers: RawProviderConfig[];
  assignments?: TaskAssignments;
}

export interface LoadProvidersResult {
  /** Constructed providers ready to register. */
  providers: Array<{
    id: string;
    type: ProviderType;
    kind: ProviderKind;
    config: ProviderConfig;
    instance: ReturnType<typeof buildProviderInstance>;
  }>;
  /** Task → provider id assignments. */
  assignments: TaskAssignments;
  /** True if the JSON advanced-mode config was used. */
  advancedMode: boolean;
}

/** Injectable fetch used when constructing providers (tests). */
export interface LoadProvidersOptions {
  fetchImpl?: FetchImpl;
}

/**
 * Parse the JSON config from `CANVAS_CORE_AI_PROVIDERS`. Returns `null` if the
 * env var is unset or invalid JSON (logs a warning).
 */
export function parseAiProvidersJson(raw: string | undefined): AiProvidersJsonConfig | null {
  if (!raw || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as AiProvidersJsonConfig;
    if (!parsed || !Array.isArray(parsed.providers)) {
      console.warn('[core][ai-registry] CANVAS_CORE_AI_PROVIDERS JSON missing "providers" array — ignoring');
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn(
      '[core][ai-registry] CANVAS_CORE_AI_PROVIDERS is not valid JSON — ignoring:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Construct a concrete provider instance from a raw config entry. Throws on
 * unknown kinds or missing required fields — the registry should fail fast at
 * startup if the config is wrong.
 */
export function buildProviderInstance(
  type: ProviderType,
  kind: ProviderKind,
  config: ProviderConfig,
  opts: LoadProvidersOptions = {},
): LlmProviderLike {
  const fetchImpl = opts.fetchImpl;
  switch (type) {
    case 'llm':
      return buildLlmProvider(kind, config, fetchImpl);
    case 'asr':
      return buildAsrProvider(kind, config, fetchImpl);
    case 'tts':
      return buildTtsProvider(kind, config);
  }
}

/** Union of the three provider interfaces (for typing convenience). */
type LlmProviderLike = LlmProvider | TranscriptionProvider | SpeechProvider;

function buildLlmProvider(
  kind: ProviderKind,
  config: ProviderConfig,
  fetchImpl?: FetchImpl,
) {
  switch (kind) {
    case 'openai':
      return new OpenAiLlm({
        apiKey: String(config.apiKey ?? ''),
        model: String(config.model ?? 'gpt-4o-mini'),
        baseUrl: config.baseUrl ? String(config.baseUrl) : undefined,
        temperature: typeof config.temperature === 'number' ? config.temperature : undefined,
        timeoutMs: typeof config.timeoutMs === 'number' ? config.timeoutMs : undefined,
        fetchImpl,
        name: typeof config.name === 'string' ? config.name : undefined,
      });
    case 'openrouter':
      return new OpenRouterLlm({
        apiKey: String(config.apiKey ?? ''),
        model: String(config.model ?? ''),
        baseUrl: config.baseUrl ? String(config.baseUrl) : undefined,
        referer: typeof config.referer === 'string' ? config.referer : undefined,
        title: typeof config.title === 'string' ? config.title : undefined,
        temperature: typeof config.temperature === 'number' ? config.temperature : undefined,
        timeoutMs: typeof config.timeoutMs === 'number' ? config.timeoutMs : undefined,
        fetchImpl,
        name: typeof config.name === 'string' ? config.name : undefined,
      });
    case 'anthropic':
      return new AnthropicLlm({
        apiKey: String(config.apiKey ?? ''),
        model: String(config.model ?? ''),
        baseUrl: config.baseUrl ? String(config.baseUrl) : undefined,
        maxTokens: typeof config.maxTokens === 'number' ? config.maxTokens : undefined,
        temperature: typeof config.temperature === 'number' ? config.temperature : undefined,
        timeoutMs: typeof config.timeoutMs === 'number' ? config.timeoutMs : undefined,
        fetchImpl,
        name: typeof config.name === 'string' ? config.name : undefined,
      });
    case 'gemini':
      return new GeminiLlm({
        apiKey: String(config.apiKey ?? ''),
        model: String(config.model ?? ''),
        baseUrl: config.baseUrl ? String(config.baseUrl) : undefined,
        temperature: typeof config.temperature === 'number' ? config.temperature : undefined,
        timeoutMs: typeof config.timeoutMs === 'number' ? config.timeoutMs : undefined,
        fetchImpl,
        name: typeof config.name === 'string' ? config.name : undefined,
      });
    case 'groq':
      return new GroqLlm({
        apiKey: String(config.apiKey ?? ''),
        model: String(config.model ?? ''),
        baseUrl: config.baseUrl ? String(config.baseUrl) : undefined,
        temperature: typeof config.temperature === 'number' ? config.temperature : undefined,
        timeoutMs: typeof config.timeoutMs === 'number' ? config.timeoutMs : undefined,
        fetchImpl,
        name: typeof config.name === 'string' ? config.name : undefined,
      });
    case 'azure':
      return new AzureOpenAiLlm({
        apiKey: String(config.apiKey ?? ''),
        resource: String(config.resource ?? ''),
        deployment: String(config.deployment ?? ''),
        apiVersion: typeof config.apiVersion === 'string' ? config.apiVersion : undefined,
        baseUrl: config.baseUrl ? String(config.baseUrl) : undefined,
        temperature: typeof config.temperature === 'number' ? config.temperature : undefined,
        timeoutMs: typeof config.timeoutMs === 'number' ? config.timeoutMs : undefined,
        fetchImpl,
        name: typeof config.name === 'string' ? config.name : undefined,
      });
    case 'llama-cpp':
    case 'vllm':
      return new OpenAiCompatibleLlm({
        baseUrl: String(config.baseUrl ?? ''),
        model: typeof config.model === 'string' ? config.model : undefined,
        temperature: typeof config.temperature === 'number' ? config.temperature : undefined,
        timeoutMs: typeof config.timeoutMs === 'number' ? config.timeoutMs : undefined,
        fetchImpl,
        name: typeof config.name === 'string' ? config.name : undefined,
      });
    case 'ollama':
      return new OllamaLlm({
        baseUrl: config.baseUrl ? String(config.baseUrl) : undefined,
        model: typeof config.model === 'string' ? config.model : undefined,
        temperature: typeof config.temperature === 'number' ? config.temperature : undefined,
        timeoutMs: typeof config.timeoutMs === 'number' ? config.timeoutMs : undefined,
        fetchImpl,
        name: typeof config.name === 'string' ? config.name : undefined,
      });
    default:
      throw new Error(`Cannot build LLM provider: unsupported kind '${kind}'`);
  }
}

function buildAsrProvider(
  kind: ProviderKind,
  config: ProviderConfig,
  fetchImpl?: FetchImpl,
) {
  switch (kind) {
    case 'whisper':
      return new WhisperTranscription({
        baseUrl: String(config.baseUrl ?? ''),
        model: typeof config.model === 'string' ? config.model : undefined,
        language: typeof config.language === 'string' ? config.language : undefined,
        responseFormat:
          typeof config.responseFormat === 'string'
            ? (config.responseFormat as 'json' | 'text' | 'verbose_json')
            : undefined,
        timeoutMs: typeof config.timeoutMs === 'number' ? config.timeoutMs : undefined,
        fetchImpl,
        name: typeof config.name === 'string' ? config.name : undefined,
      });
    default:
      throw new Error(`Cannot build ASR provider: unsupported kind '${kind}'`);
  }
}

function buildTtsProvider(kind: ProviderKind, config: ProviderConfig) {
  switch (kind) {
    case 'piper':
      return new PiperSpeech({
        host: typeof config.host === 'string' ? config.host : undefined,
        port: typeof config.port === 'number' ? config.port : undefined,
        voice: typeof config.voice === 'string' ? config.voice : undefined,
        speaker: typeof config.speaker === 'number' ? config.speaker : undefined,
        lengthScale: typeof config.lengthScale === 'number' ? config.lengthScale : undefined,
        noiseScale: typeof config.noiseScale === 'number' ? config.noiseScale : undefined,
        noiseW: typeof config.noiseW === 'number' ? config.noiseW : undefined,
        timeoutMs: typeof config.timeoutMs === 'number' ? config.timeoutMs : undefined,
        name: typeof config.name === 'string' ? config.name : undefined,
      });
    default:
      throw new Error(`Cannot build TTS provider: unsupported kind '${kind}'`);
  }
}

/**
 * Load provider configuration from the environment. Advanced mode (JSON env
 * var) takes precedence over simple mode (individual env vars).
 *
 * Simple-mode env vars (backward compat with the original Core config):
 *   CANVAS_CORE_LLM_BASE_URL, CANVAS_CORE_LLM_API_KEY, CANVAS_CORE_LLM_MODEL
 *   CANVAS_CORE_WHISPER_URL, CANVAS_CORE_WHISPER_MODEL
 *   CANVAS_CORE_PIPER_URL (or CANVAS_CORE_PIPER_HOST + CANVAS_CORE_PIPER_PORT)
 *
 * Advanced-mode env vars:
 *   CANVAS_CORE_AI_PROVIDERS (JSON: { providers: [...], assignments: {...} })
 *   CANVAS_CORE_AI_TASK_ASSIGNMENTS (JSON: { intent_routing: "local-llm", ... })
 */
export function loadProvidersFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: LoadProvidersOptions = {},
): LoadProvidersResult {
  // --- Advanced mode: JSON config ---
  const jsonConfig = parseAiProvidersJson(env.CANVAS_CORE_AI_PROVIDERS);
  if (jsonConfig) {
    const providers = jsonConfig.providers.map((raw) => ({
      id: raw.id,
      type: raw.type,
      kind: raw.kind,
      config: raw.config,
      instance: buildProviderInstance(raw.type, raw.kind, raw.config, opts),
    }));

    // Task assignments can come from the JSON config OR a separate env var.
    let assignments: TaskAssignments = jsonConfig.assignments ?? {};
    const assignmentsEnv = env.CANVAS_CORE_AI_TASK_ASSIGNMENTS;
    if (assignmentsEnv) {
      try {
        const parsed = JSON.parse(assignmentsEnv) as TaskAssignments;
        assignments = { ...assignments, ...parsed };
      } catch (err) {
        console.warn(
          '[core][ai-registry] CANVAS_CORE_AI_TASK_ASSIGNMENTS is not valid JSON — ignoring:',
          err instanceof Error ? err.message : err,
        );
      }
    }

    return { providers, assignments, advancedMode: true };
  }

  // --- Simple mode: individual env vars (backward compat) ---
  const providers: LoadProvidersResult['providers'] = [];

  const llmBaseUrl = env.CANVAS_CORE_LLM_BASE_URL;
  const llmApiKey = env.CANVAS_CORE_LLM_API_KEY;
  const llmModel = env.CANVAS_CORE_LLM_MODEL;
  if (llmBaseUrl) {
    // If an API key is set, we still use OpenAiCompatibleLlm (llama.cpp / vLLM
    // accept a bearer token but don't require one). The key is passed via the
    // config so the registry can surface it; the OpenAiCompatibleLlm client
    // itself doesn't send auth headers (local servers don't need it).
    providers.push({
      id: 'local-llm',
      type: 'llm',
      kind: 'llama-cpp',
      config: {
        baseUrl: llmBaseUrl,
        model: llmModel,
        ...(llmApiKey ? { apiKey: llmApiKey } : {}),
      },
      instance: new OpenAiCompatibleLlm({
        baseUrl: llmBaseUrl,
        model: llmModel,
        fetchImpl: opts.fetchImpl,
        name: 'local-llm',
      }),
    });
  }

  const whisperUrl = env.CANVAS_CORE_WHISPER_URL;
  const whisperModel = env.CANVAS_CORE_WHISPER_MODEL;
  if (whisperUrl) {
    providers.push({
      id: 'local-asr',
      type: 'asr',
      kind: 'whisper',
      config: { baseUrl: whisperUrl, model: whisperModel },
      instance: new WhisperTranscription({
        baseUrl: whisperUrl,
        model: whisperModel,
        fetchImpl: opts.fetchImpl,
        name: 'local-asr',
      }),
    });
  }

  const piperUrl = env.CANVAS_CORE_PIPER_URL;
  const piperHost = env.CANVAS_CORE_PIPER_HOST;
  const piperPort = env.CANVAS_CORE_PIPER_PORT;
  if (piperUrl || piperHost) {
    const host = piperHost ?? hostFromUrl(piperUrl) ?? 'host.docker.internal';
    const port = piperPort ? Number(piperPort) : portFromUrl(piperUrl, 10200);
    providers.push({
      id: 'local-tts',
      type: 'tts',
      kind: 'piper',
      config: { host, port },
      instance: new PiperSpeech({ host, port, name: 'local-tts' }),
    });
  }

  // In simple mode, task assignments are implicit: each task maps to the
  // single configured provider of its type. We still return an empty
  // assignments map — the registry's fallback handles it.
  return { providers, assignments: {}, advancedMode: false };
}

function hostFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function portFromUrl(url: string | undefined, fallback: number): number {
  if (!url) return fallback;
  try {
    const p = new URL(url).port;
    return p ? Number(p) : fallback;
  } catch {
    return fallback;
  }
}
