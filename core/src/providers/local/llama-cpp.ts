/**
 * llama.cpp local LLM adapter (multi-provider registry, D-010 extension).
 *
 * llama.cpp's server is OpenAI-compatible at `/v1`, so we re-export the
 * existing `OpenAiCompatibleLlm` directly. This file exists so the registry
 * can reference `kind: 'llama-cpp'` and resolve to a concrete adapter.
 */
export { OpenAiCompatibleLlm, type OpenAiCompatibleLlmOptions } from '../llm.js';
