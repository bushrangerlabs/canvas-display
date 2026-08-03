/**
 * vLLM local LLM adapter (multi-provider registry, D-010 extension).
 *
 * vLLM is OpenAI-compatible at `/v1`, so we re-export the existing
 * `OpenAiCompatibleLlm` directly. This file exists so the registry can
 * reference `kind: 'vllm'` and resolve to a concrete adapter.
 */
export { OpenAiCompatibleLlm, type OpenAiCompatibleLlmOptions } from '../llm.js';
