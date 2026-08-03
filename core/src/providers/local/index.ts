/**
 * Local (self-hosted) provider adapters (multi-provider registry, D-010 extension).
 *
 * These wrap or re-export the existing local provider implementations so the
 * registry can resolve `kind: 'llama-cpp' | 'ollama' | 'vllm' | 'whisper' | 'piper'`
 * to concrete adapter classes.
 *
 * - `llama-cpp` and `vllm` are OpenAI-compatible → re-export `OpenAiCompatibleLlm`.
 * - `ollama` is OpenAI-compatible with Ollama defaults → `OllamaLlm`.
 * - `whisper` and `piper` are already local providers in `../asr.ts` and `../tts.ts`.
 */
export { OllamaLlm, type OllamaLlmOptions } from './ollama.js';
export { OpenAiCompatibleLlm, type OpenAiCompatibleLlmOptions } from './llama-cpp.js';
