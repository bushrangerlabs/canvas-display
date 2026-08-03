/**
 * Shared provider types for Canvas Core's AI brain (plan doc §15.4 model-provider
 * abstraction, D-010). Every external inference dependency is hidden behind one of
 * these interfaces so the rest of Core talks in typed internal contracts, not
 * provider-specific wire formats.
 *
 * IMPORTANT — Phase scope:
 *   This module is Phase 2/early scaffolding for the model-provider abstraction.
 *   It is real, injectable, and unit-tested against mocked I/O, but the production
 *   behaviors described in §15 (deterministic intent router, tool registry, memory,
 *   circuit breakers, streaming) are NOT implemented here yet. Those land in
 *   Phase 5/6. The interfaces are designed so that later work extends, not rewrites,
 *   this file.
 *
 * Every provider exposes a `healthCheck()` so Core can report availability without
 * crashing (plan §20.4: inference failure must not disconnect devices).
 */

/** A chat message exchanged with an LLM provider (OpenAI-compatible shape). */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Tool calls from the assistant (present when the LLM requests tool execution). */
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  /** ID of the tool call this message is responding to (present on role: 'tool'). */
  tool_call_id?: string;
}

/** A tool call returned by the LLM in a chat-with-tools response. */
export interface LlmToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** Result of a chatWithTools call. */
export interface ChatWithToolsResult {
  /** The text content of the assistant's reply (may be empty if only tool calls). */
  content: string;
  /** Any tool calls the LLM made. */
  toolCalls: LlmToolCall[];
}

/** Result of a provider availability probe. */
export interface HealthStatus {
  /** Stable provider key, e.g. "llm", "asr", "tts", "mcp". */
  name: string;
  /** Human-readable implementation, e.g. "OpenAiCompatibleLlm". */
  kind: string;
  /** True when the provider responded to a lightweight probe. */
  healthy: boolean;
  /** Optional detail (latency, error message, model id). */
  detail?: string;
}
