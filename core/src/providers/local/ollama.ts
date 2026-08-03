/**
 * Ollama local LLM adapter (multi-provider registry, D-010 extension).
 *
 * Ollama exposes an OpenAI-compatible API at `http://localhost:11434/v1` (since
 * Ollama 0.1.x). We extend `OpenAiCompatibleLlm` to default the base URL and
 * model so the registry can reference `kind: 'ollama'` with minimal config.
 *
 * Config: `baseUrl` (defaults to `http://localhost:11434/v1`), `model`
 * (e.g. "llama3.1", "qwen2.5"), optional `temperature`, `timeoutMs`.
 */
import { OpenAiCompatibleLlm, type OpenAiCompatibleLlmOptions, type FetchImpl } from '../llm.js';

export interface OllamaLlmOptions {
  /** Base URL, defaults to "http://localhost:11434/v1". */
  baseUrl?: string;
  /** Model id, e.g. "llama3.1", "qwen2.5". */
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

const DEFAULT_BASE_URL = 'http://localhost:11434/v1';
const DEFAULT_MODEL = 'llama3.1';

/**
 * `OllamaLlm` is a thin specialization of `OpenAiCompatibleLlm` with Ollama
 * defaults. It is exported as a class so the registry can `instanceof`-check
 * it, but it inherits all behavior from `OpenAiCompatibleLlm`.
 */
export class OllamaLlm extends OpenAiCompatibleLlm {
  constructor(opts: OllamaLlmOptions = {}) {
    super({
      baseUrl: opts.baseUrl ?? DEFAULT_BASE_URL,
      model: opts.model ?? DEFAULT_MODEL,
      temperature: opts.temperature,
      timeoutMs: opts.timeoutMs,
      fetchImpl: opts.fetchImpl,
      name: opts.name ?? 'ollama',
    });
  }
}
