/**
 * Cloud LLM provider adapters (multi-provider registry, D-010 extension).
 *
 * Each adapter implements the existing `LlmProvider` interface from
 * `../llm.js` so the registry can swap them in transparently. All use
 * injectable `fetch` for tests — no SDK dependencies.
 */
export { OpenAiLlm, type OpenAiLlmOptions } from './openai.js';
export { OpenRouterLlm, type OpenRouterLlmOptions } from './openrouter.js';
export { AnthropicLlm, type AnthropicLlmOptions } from './anthropic.js';
export { GeminiLlm, type GeminiLlmOptions } from './gemini.js';
export { GroqLlm, type GroqLlmOptions } from './groq.js';
export { AzureOpenAiLlm, type AzureOpenAiLlmOptions } from './azure.js';
