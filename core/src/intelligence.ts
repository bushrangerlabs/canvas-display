/**
 * Canvas Intelligence orchestration scaffold (plan doc §15, D-009/D-010/D-011).
 *
 * This module instantiates the provider clients from Core config and exposes the
 * voice pipeline (ASR -> LLM -> TTS) plus a provider-health aggregator. It is the
 * first concrete "AI brain" capability wired to the running inference stack.
 *
 * PHASE SCOPE: Phase2/early scaffolding. It runs the three providers in sequence
 * and returns the chained result. It does NOT yet implement the deterministic
 * intent router, tool registry, conversation memory, policy/confirmation engine,
 * or streaming (plan §15.2/§15.3) — those are Phase5/6. The interfaces here are
 * intentionally simple so later work extends them without rewrites.
 *
 * Degraded mode (D-010): if the LLM is unavailable we fall back to `DegradedLlm`
 * so a voice turn still returns a deterministic reply instead of failing. ASR/TTS
 * failures are surfaced as errors (they have no safe deterministic substitute for
 * arbitrary audio), but they never crash Core or disconnect devices (§20.4).
 */
import type { CoreConfig } from './config.js';
import { OpenAiCompatibleLlm, DegradedLlm, type LlmProvider } from './providers/llm.js';
import { WhisperTranscription, type TranscriptionProvider } from './providers/asr.js';
import { PiperSpeech, type SpeechProvider } from './providers/tts.js';
import { HttpJsonRpcMcpClient, type McpClient } from './providers/mcp.js';
import { MultiMcpManager, parseMcpServerConfigs } from './providers/multi-mcp.js';
import type { ChatMessage, HealthStatus } from './providers/types.js';
import type { PrivacyFilter } from './privacy.js';
import type { PrivacySettings } from './privacy.js';
import { AudioFocusManager, type FocusManager, type FocusState } from './audio-focus.js';
import { IntentRouter, type IntentResult } from './intent-router.js';
import { ToolRegistry, type ToolContext, type ToolResult } from './tool-registry.js';
import {
  AiProviderRegistry,
  type AiProviderRegistryOptions,
} from './providers/registry.js';
import { loadProvidersFromEnv } from './providers/config-loader.js';
import { confirmationDigest, mcpCallRequiresConfirmation, mcpToolRequiresConfirmation, selectToolsForRequest } from './mcp-policy.js';

const CORE_TIME_ZONE = process.env.CANVAS_CORE_TIMEZONE?.trim() || 'Australia/Melbourne';

function currentTimeSystemPrompt(userPrompt?: string): string {
  const now = new Date();
  const local = new Intl.DateTimeFormat('en-AU', {
    timeZone: CORE_TIME_ZONE,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'long',
  }).format(now);
  const temporalContext = `Current date and time: ${local}. IANA timezone: ${CORE_TIME_ZONE}. This timestamp is authoritative for date, day and time questions.`;
  return userPrompt ? `${userPrompt}\n\n${temporalContext}` : temporalContext;
}

function temporalReply(intent: 'time_query' | 'date_query'): string {
  const now = new Date();
  if (intent === 'time_query') {
    const time = new Intl.DateTimeFormat('en-AU', {
      timeZone: CORE_TIME_ZONE, hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(now);
    return `It is ${time}.`;
  }
  const date = new Intl.DateTimeFormat('en-AU', {
    timeZone: CORE_TIME_ZONE, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(now);
  return `Today is ${date}.`;
}

export interface Intelligence {
  /** Run the full ASR -> LLM -> TTS pipeline. */
  runVoicePipeline(input: VoicePipelineInput): Promise<VoicePipelineResult>;
  /** Run the deterministic intent router + tool pipeline (Phase 6). */
  runIntelligentPipeline(input: VoicePipelineInput): Promise<IntelligentPipelineResult>;
  /** Aggregate health of every provider. */
  health(): Promise<HealthStatus[]>;
  /** Expose the underlying providers (used by routes / future tool registry). */
  providers: {
    llm: LlmProvider;
    asr?: TranscriptionProvider;
    tts?: SpeechProvider;
    mcp?: McpClient;
  };
  /** Multi-provider AI registry (D-010 extension). Undefined in legacy single-provider mode. */
  registry?: AiProviderRegistry;
  /** Intent router (Phase 6). */
  intentRouter: IntentRouter;
  /** Tool registry (Phase 6). */
  toolRegistry: ToolRegistry;
  /** Check privacy settings before processing audio. */
  checkAudioAllowed(providerName: string): Promise<{ allowed: boolean; reason?: string }>;
  /** Apply privacy filter to transcript and log accordingly. */
  applyTranscriptPrivacy(transcript: string): Promise<{ displayTranscript: string; redactedCount: number }>;
  /** Discard audio buffer if retention policy says so. */
  discardAudioBuffer(audio: Buffer): void;
  /** Audio-focus manager for the voice pipeline. */
  audioFocus: FocusManager;
  /** Re-register MCP tools from the current MCP client into the tool registry. */
  reloadMcpTools(): Promise<void>;
  /** Runtime callbacks supplied after Core storage/gateway initialization. */
  setToolContext(context: Partial<ToolContext>): void;
  getToolContext(): Partial<ToolContext>;
}

export interface ConversationTurn {
  transcript: string;
  reply: string;
}

export interface VoicePipelineInput {
  /** Raw audio bytes (e.g. decoded from base64). */
  audio?: Buffer;
  /** OR a pre-transcribed transcript (skips ASR). */
  transcript?: string;
  /** Optional system prompt for the LLM. */
  systemPrompt?: string;
  /** Optional language hint for ASR. */
  language?: string;
  /** Skip TTS and return only text (default false). */
  skipTts?: boolean;
  /** Authenticated/validated device that originated this turn. */
  originDeviceId?: string;
  /** Recent conversation history for multi-turn context (max 5 turns). */
  conversationHistory?: ConversationTurn[];
  onTranscript?: (transcript: string) => void | Promise<void>;
  onReplyChunk?: (text: string) => void | Promise<void>;
}

export interface VoicePipelineResult {
  transcript: string;
  reply: string;
  /** Base64-encoded audio when TTS ran. */
  audioBase64?: string;
  /** True when the LLM degraded fallback was used. */
  degraded: boolean;
}

export interface IntelligentPipelineResult {
  transcript: string;
  reply: string;
  /** Base64-encoded audio when TTS ran. */
  audioBase64?: string;
  /** True when the LLM degraded fallback was used. */
  degraded: boolean;
  /** The resolved intent from the router. */
  intent: IntentResult;
  /** The tool result, if a tool was executed. */
  toolResult?: ToolResult;
  /** Whether the tool requires user confirmation before execution. */
  requiresConfirmation?: boolean;
  /** Confirmation digest for the user to approve. */
  confirmationDigest?: string;
  /** Millisecond stage durations for operational latency analysis. */
  timings?: VoicePipelineTimings;
  /** Knowledge card extracted from a web-search or wikipedia tool call, if any. */
  knowledge_card?: { title: string; body: string; source_url?: string; source_label?: string; show_url?: string };
}

export interface VoicePipelineTimings {
  asrMs: number;
  routingMs: number;
  planningMs: number;
  ttsMs: number;
  totalMs: number;
}

export interface IntelligenceOptions {
  /** Override the LLM provider (tests / cloud models). */
  llm?: LlmProvider;
  /** Override ASR. */
  asr?: TranscriptionProvider;
  /** Override TTS. */
  tts?: SpeechProvider;
  /** Override MCP. */
  mcp?: McpClient;
  /** Privacy repository for audio/transcript controls. */
  privacyRepo?: PrivacyRepository;
  /** Privacy filter for transcript anonymization. */
  privacyFilter?: PrivacyFilter;
  /** Audio-focus manager override (tests). */
  audioFocus?: FocusManager;
  /**
   * Multi-provider AI registry (D-010 extension). When set, the intelligence
   * pipeline pulls LLM/ASR/TTS providers from the registry instead of
   * constructing them directly from `config`. Per-task overrides (`llm`,
   * `asr`, `tts`) still take precedence over the registry.
   */
  registry?: AiProviderRegistry;
  /**
   * Build a registry from env vars if `registry` is not supplied. Defaults to
   * true. Set to false to skip env parsing entirely (tests).
   */
  loadRegistryFromEnv?: boolean;
}

/** Extended privacy repository interface used by the intelligence pipeline. */
export interface PrivacyRepository {
  getSettings(): Promise<PrivacySettings>;
  updateSettings(settings: Partial<PrivacySettings>): Promise<PrivacySettings>;
  purgeAll(): Promise<{ purgedTranscripts: number; purgedAudio: number }>;
  storeTranscript(text: string): Promise<void>;
  storeAudio(size: number): Promise<void>;
}

export function createIntelligence(
  config: CoreConfig,
  opts: IntelligenceOptions = {},
): Intelligence {
  // Multi-provider AI registry (D-010 extension). If the caller didn't supply
  // one, try to build it from env vars (advanced mode JSON or simple-mode
  // legacy env vars). This is skipped in tests that pass `loadRegistryFromEnv: false`.
  let registry: AiProviderRegistry | undefined = opts.registry;
  if (!registry && opts.loadRegistryFromEnv !== false) {
    const loaded = loadProvidersFromEnv(process.env);
    if (loaded.providers.length > 0) {
      registry = new AiProviderRegistry({
        providers: loaded.providers.map((p) => ({
          id: p.id,
          type: p.type,
          kind: p.kind,
          config: p.config,
          instance: p.instance,
        })),
        assignments: loaded.assignments,
      });
    }
  }

  // LLM: explicit override > registry > legacy single-provider config > degraded.
  let llm: LlmProvider;
  let usingDegraded: boolean;
  if (opts.llm) {
    llm = opts.llm;
    usingDegraded = llm instanceof DegradedLlm;
  } else if (registry) {
    const registryLlm = registry.getLlmProvider('conversation');
    if (registryLlm) {
      llm = registryLlm;
      usingDegraded = false;
    } else {
      llm = new DegradedLlm({ name: 'llm' });
      usingDegraded = true;
    }
  } else if (config.llmBaseUrl) {
    llm = new OpenAiCompatibleLlm({ baseUrl: config.llmBaseUrl, name: 'llm' });
    usingDegraded = false;
  } else {
    llm = new DegradedLlm({ name: 'llm' });
    usingDegraded = true;
  }

  // ASR: explicit override > registry > legacy single-provider config.
  let asr: TranscriptionProvider | undefined;
  if (opts.asr) {
    asr = opts.asr;
  } else if (registry) {
    asr = registry.getAsrProvider();
  } else if (config.whisperUrl) {
    asr = new WhisperTranscription({ baseUrl: config.whisperUrl, model: config.whisperModel, name: 'asr' });
  }

  // TTS: explicit override > registry > legacy single-provider config.
  let tts: SpeechProvider | undefined;
  if (opts.tts) {
    tts = opts.tts;
  } else if (registry) {
    tts = registry.getTtsProvider();
  } else if (config.piperUrl) {
    tts = new PiperSpeech({ name: 'tts', host: hostFromUrl(config.piperUrl), port: portFromUrl(config.piperUrl, 10200) });
  }

  // Privacy controls (Phase 5).
  const privacyRepo: PrivacyRepository | undefined = opts.privacyRepo;
  const privacyFilter: PrivacyFilter | undefined = opts.privacyFilter;

  // Audio-focus manager (Phase 5, architecture plan §14.5).
  const audioFocus: FocusManager = opts.audioFocus ?? new AudioFocusManager();

  // Phase 6: Intent router and tool registry.
  // Intent routing uses its own LLM assignment if the registry has one.
  const intentRouterLlm = usingDegraded
    ? undefined
    : (registry?.getLlmProvider('intent_routing') ?? llm);
  const intentRouter = new IntentRouter({ llm: intentRouterLlm });
  const toolRegistry = new ToolRegistry();
  let toolContext: Partial<ToolContext> = {};

  // Build the providers object early so inner functions (registerMcpTools) can
  // read the live `mcp` reference even after index.ts replaces it with the
  // DB-backed MultiMcpManager.
  const providers: {
    llm: LlmProvider; asr?: TranscriptionProvider; tts?: SpeechProvider; mcp?: McpClient;
  } = { llm, asr, tts, mcp: (() => {
    if (opts.mcp) return opts.mcp;
    const mcpConfigs = parseMcpServerConfigs(process.env);
    if (mcpConfigs.length === 0) return undefined;
    if (mcpConfigs.length === 1) return new MultiMcpManager(mcpConfigs);
    return new MultiMcpManager(mcpConfigs);
  })() };

  // Register all tools from the MultiMcpManager into the tool registry
  // as namespaced tools: mcp.<server_name>.<tool_name>
  // This lets the intent router and AI chat discover and use MCP tools.
  async function registerMcpTools(): Promise<void> {
    if (!(providers.mcp instanceof MultiMcpManager)) return;
    try {
      const tools = await providers.mcp.listTools();
      for (const tool of tools) {
        const aggregated = tool as import('./providers/multi-mcp.js').AggregatedMcpTool;
        const mcpName = `mcp.${aggregated.namespacedName}`;
        const needsConfirmation = mcpToolRequiresConfirmation(aggregated.namespacedName);
        toolRegistry.register({
          name: mcpName,
          description: aggregated.description ?? `MCP tool from ${aggregated.serverName}`,
          schema: (aggregated.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
          requiredRole: 'voice',
          requiresConfirmation: needsConfirmation,
          executor: async (params, ctx) => {
            if (!ctx.mcp) {
              return { ok: false, message: 'MCP client not available' };
            }
            try {
              const result = await ctx.mcp.callTool(aggregated.namespacedName, params);
              return {
                ok: !result.isError,
                message: `MCP tool "${aggregated.namespacedName}" executed`,
                data: result.content,
              };
            } catch (err) {
              return {
                ok: false,
                message: `${mcpName} failed: ${err instanceof Error ? err.message : String(err)}`,
              };
            }
          },
        });
      }
      console.log(`[core][mcp] registered ${tools.length} MCP tools into tool registry`);
    } catch (err) {
      console.error('[core][mcp] failed to register MCP tools:', err instanceof Error ? err.message : err);
    }
  }

  // Run initial MCP tool registration (non-blocking)
  registerMcpTools().catch((err) => {
    console.error('[core][mcp] async MCP tool registration failed:', err instanceof Error ? err.message : err);
  });

  const pendingVoiceConfirmations = new Map<string, {
    tool: string;
    params: Record<string, unknown>;
    digest: string;
    expiresAt: number;
  }>();

  const conversationLlm = (): LlmProvider => registry?.getLlmProvider('conversation') ?? llm;

  async function runToolAwareConversation(
    transcript: string,
    input: VoicePipelineInput,
  ): Promise<{ reply: string; toolResult?: ToolResult; requiresConfirmation?: boolean; confirmationDigest?: string; knowledge_card?: { title: string; body: string; source_url?: string; source_label?: string; show_url?: string } }> {
    const deviceKey = input.originDeviceId ?? 'unknown';
    const pending = pendingVoiceConfirmations.get(deviceKey);
    if (pending && pending.expiresAt <= Date.now()) pendingVoiceConfirmations.delete(deviceKey);

    if (/^(?:yes[,. ]*|confirm|do it|go ahead|please do)$/i.test(transcript.trim()) && pending && pending.expiresAt > Date.now()) {
      pendingVoiceConfirmations.delete(deviceKey);
      const result = await toolRegistry.executeTool(pending.tool, pending.params, {
        ...toolContext,
        principal: `device:${deviceKey}`,
        role: 'voice',
        deviceId: input.originDeviceId,
        intelligence: undefined,
        intentRouter,
        mcp: providers.mcp,
      }, pending.digest);
      return { reply: result.message, toolResult: result };
    }

    const candidates = selectToolsForRequest(toolRegistry.listTools('voice'), transcript);
    let mcpCandidates = candidates.filter(tool => tool.name.startsWith('mcp.'));
    // Build conversation history messages from recent turns
    const historyMessages: ChatMessage[] = (input.conversationHistory ?? []).flatMap(turn => ([
      { role: 'user' as const, content: turn.transcript },
      { role: 'assistant' as const, content: turn.reply },
    ]));

    // When keyword scoring found no MCP tools, inject web search/wikipedia tools so the LLM
    // can look up factual answers for general knowledge questions.
    if (mcpCandidates.length === 0) {
      const webSearchTools = toolRegistry.listTools('voice').filter(tool =>
        tool.name.startsWith('mcp.') &&
        /search|web|wiki|knowledge|lookup|fetch/i.test(tool.name + ' ' + (tool.description ?? '')),
      );
      if (webSearchTools.length > 0) {
        mcpCandidates = webSearchTools;
      }
    }

    if (mcpCandidates.length === 0) {
      // Pure LLM path — no MCP tools at all; generate reply and synthesize a knowledge card
      // from the transcript + reply so the display can show the answer.
      const messages: ChatMessage[] = [
        { role: 'system', content: currentTimeSystemPrompt(input.systemPrompt) },
        ...historyMessages,
        { role: 'user', content: transcript },
      ];
      const provider = conversationLlm();
      let reply = '';
      if (input.onReplyChunk && provider.streamChat) {
        let sentence = '';
        for await (const delta of provider.streamChat(messages)) {
          reply += delta; sentence += delta;
          for (;;) {
            const complete = sentence.match(/^([\s\S]*?[.!?](?:["']|\s|$))/);
            if (!complete) break;
            sentence = sentence.slice(complete[1].length);
            if (complete[1].trim()) await input.onReplyChunk(complete[1].trim());
          }
        }
        if (sentence.trim()) await input.onReplyChunk(sentence.trim());
      } else {
        reply = await provider.chat(messages);
      }
      // Synthesize knowledge card from Q&A when the reply is substantive (not a short command ack)
      const syntheticCard = reply.trim().length > 10
        ? { title: transcript.length > 80 ? transcript.slice(0, 77) + '…' : transcript, body: reply.trim(), source_label: 'AI' }
        : undefined;
      return { reply, ...(syntheticCard ? { knowledge_card: syntheticCard } : {}) };
    }

    const definitions = mcpCandidates.map(tool => ({
      type: 'function' as const,
      function: { name: tool.name, description: tool.description, parameters: tool.schema },
    }));
    const haCandidates = mcpCandidates.some(tool => tool.name.startsWith('mcp.ha-mcp.'))
      ? await toolContext.resolveHaEntities?.(transcript) ?? []
      : [];
    const entityContext = haCandidates.length > 0
      ? `\nCore's current Home Assistant entity candidates: ${JSON.stringify(haCandidates)}. Prefer these exact entity IDs when applicable.`
      : '';
    const messages: ChatMessage[] = [
      { role: 'system', content: `${currentTimeSystemPrompt(input.systemPrompt)}\nUse the provided MCP tools whenever they can answer or perform the request. You can access and control Home Assistant through these tools; never claim that you cannot access the smart home when an applicable tool is provided. Base factual answers on tool results.${entityContext}` },
      ...historyMessages,
      { role: 'user', content: transcript },
    ];
    let finalContent = '';
    const executedCalls:Array<{tool:string;args:Record<string,unknown>}>=[];
    let executionFailed=false;
    let knowledgeCard: { title: string; body: string; source_url?: string; source_label?: string; show_url?: string } | undefined;
    for (let iteration = 0; iteration < 3; iteration++) {
      const response = await conversationLlm().chatWithTools(messages, definitions);
      if (response.content) finalContent = response.content;
      if (response.toolCalls.length === 0) {
        // When LLM chose not to call any tools and gave a substantive reply,
        // synthesize a knowledge card so the display can show the answer.
        if (!knowledgeCard && finalContent.trim().length > 10 && executedCalls.length === 0) {
          knowledgeCard = {
            title: transcript.length > 80 ? transcript.slice(0, 77) + '…' : transcript,
            body: finalContent.trim(),
            source_label: 'AI',
          };
        }
        return { reply: finalContent, ...(knowledgeCard ? { knowledge_card: knowledgeCard } : {}) };
      }
      messages.push({ role: 'assistant', content: response.content, tool_calls: response.toolCalls });
      for (const call of response.toolCalls) {
        const tool = toolRegistry.getTool(call.function.name);
        const params = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
        if (!tool) {
          messages.push({ role: 'tool', content: JSON.stringify({ ok: false, message: 'tool_not_found' }), tool_call_id: call.id });
          continue;
        }
        if (mcpCallRequiresConfirmation(tool.name, params)) {
          const digest = confirmationDigest(tool.name, params);
          pendingVoiceConfirmations.set(deviceKey, { tool: tool.name, params, digest, expiresAt: Date.now() + 60_000 });
          return {
            reply: `This will run ${tool.name} and may change your system. Say confirm to continue.`,
            requiresConfirmation: true,
            confirmationDigest: digest,
          };
        }
        const result = await toolRegistry.executeTool(tool.name, params, {
          ...toolContext,
          principal: `device:${deviceKey}`,
          role: 'voice',
          deviceId: input.originDeviceId,
          intelligence: undefined,
          intentRouter,
          mcp: providers.mcp,
        });
        if(result.ok)executedCalls.push({tool:tool.name,args:params});else executionFailed=true;
        // Extract knowledge card from web-search or wikipedia tool calls
        if (result.ok && !knowledgeCard && Array.isArray(result.data)) {
          const toolBaseName = tool.name.split('.').pop() ?? '';
          if (toolBaseName === 'web_search' || toolBaseName === 'wikipedia_lookup') {
            const blocks = result.data as Array<Record<string, unknown>>;
            const textBlock = blocks.find(b => b.type === 'text' && typeof b.text === 'string');
            if (textBlock) {
              const text = String(textBlock.text);
              const titleArg = toolBaseName === 'wikipedia_lookup'
                ? String(params.topic ?? params.query ?? 'Wikipedia')
                : String(params.query ?? 'Web Search');
              // Try to extract a source URL from structured JSON results
              let show_url: string | undefined;
              if (toolBaseName === 'web_search') {
                try {
                  const parsed = JSON.parse(text) as { results?: Array<{ url?: string }> };
                  const firstUrl = parsed?.results?.[0]?.url;
                  if (firstUrl && /^https?:\/\//.test(firstUrl)) show_url = firstUrl;
                } catch { /* text wasn't JSON */ }
              }
              knowledgeCard = {
                title: titleArg.charAt(0).toUpperCase() + titleArg.slice(1),
                body: text.slice(0, 800),
                source_url: toolBaseName === 'wikipedia_lookup'
                  ? `https://en.wikipedia.org/wiki/${encodeURIComponent(String(params.topic ?? params.query ?? ''))}`
                  : show_url,
                source_label: toolBaseName === 'wikipedia_lookup' ? 'Wikipedia' : 'Web Search',
                show_url,
              };
            }
          }
        }
        if (tool.name.endsWith('.ha_get_camera_image') && result.ok) {
          const blocks = Array.isArray(result.data) ? result.data as Array<Record<string, unknown>> : [];
          const image = blocks.find(block => block.type === 'image' && typeof block.data === 'string');
          if (image) {
            const visionProviderId = registry?.getAssignments().vision;
            const visionProvider = visionProviderId ? registry?.getLlmProviderById(visionProviderId) : undefined;
            if (!visionProviderId || !visionProvider?.analyzeImage) {
              return { reply: 'I retrieved the camera image, but no vision-capable AI provider is assigned. Set Camera Vision under Settings, AI Providers.' };
            }
            const mimeType = typeof image.mimeType === 'string' ? image.mimeType : 'image/jpeg';
            const visionPrompt = `Answer the user's camera question from this current Home Assistant snapshot: ${transcript}\nDescribe only what is visibly supported by the image. State uncertainty clearly and do not infer a person's identity.`;
            const description = await visionProvider.analyzeImage(visionPrompt, image.data as string, mimeType);
            return { reply: description, toolResult: result };
          }
        }
        messages.push({ role: 'tool', content: JSON.stringify(result), tool_call_id: call.id });
      }
    }
    return { reply: finalContent || 'The MCP request did not complete.', ...(knowledgeCard ? { knowledge_card: knowledgeCard } : {}) };
  }

  async function runVoicePipeline(input: VoicePipelineInput): Promise<VoicePipelineResult> {
    // 0) Audio focus: request voice focus — media will duck if playing.
    // The returned duckLevel is sent to the device via the device gateway so it can
    // reduce media volume on the Edge.
    const focusGrant = audioFocus.requestFocus('voice');
    console.log(`[intel][focus] Voice session started, state=${focusGrant.currentState}${focusGrant.duckLevel !== undefined ? `, duckLevel=${focusGrant.duckLevel}` : ''}`);

    // 1) Privacy check: is ASR provider allowed?
    if (input.audio && asr && privacyRepo) {
      const { allowed, reason } = await checkAudioAllowed('asr');
      if (!allowed) {
        console.log(`[intel][privacy] ASR blocked: ${reason}`);
        throw new Error(`Privacy policy blocks ASR: ${reason}`);
      }
      console.log('[intel][privacy] ASR provider allowed, proceeding');
    }

    // 2) ASR
    let transcript: string;
    if (input.transcript && input.transcript.length > 0) {
      transcript = input.transcript;
    } else if (input.audio && asr) {
      transcript = await asr.transcribe(input.audio, 'audio/wav');
    } else if (input.audio && !asr) {
      throw new Error('ASR not configured but no transcript provided');
    } else {
      throw new Error('Voice pipeline requires audio or transcript');
    }

    // 3) Privacy: apply transcript anonymization and logging.
    const { displayTranscript, redactedCount } = await applyTranscriptPrivacy(transcript);
    await input.onTranscript?.(transcript);
    if (redactedCount > 0) {
      console.log(`[intel][privacy] Redacted ${redactedCount} entities from transcript`);
    }

    // 4) LLM (uses the display transcript for logging, but the real transcript for the LLM)
    const messages: ChatMessage[] = [];
    messages.push({ role: 'system', content: currentTimeSystemPrompt(input.systemPrompt) });
    messages.push({ role: 'user', content: transcript });
    const reply = await llm.chat(messages);

    // 5) TTS
    let audioBase64: string | undefined;
    let audioBuffer: Buffer | undefined;
    if (!input.skipTts && tts) {
      audioBuffer = await tts.synthesize(reply);
      audioBase64 = audioBuffer.toString('base64');
    }

    // 6) Privacy: store transcript if retention is enabled.
    if (privacyRepo) {
      await privacyRepo.storeTranscript(transcript);
      if (audioBuffer) {
        await privacyRepo.storeAudio(audioBuffer.length);
      }
    }

    // 7) Privacy: discard audio buffer if retention is off.
    discardAudioBuffer(audioBuffer);

    // 8) Audio focus: release voice focus — media volume is restored on the device.
    // The device gateway will pick up the duck/un-duck signal in a separate message.
    const focusRelease = audioFocus.releaseFocus('voice');
    console.log(`[intel][focus] Voice session ended, state=${focusRelease.currentState}${focusRelease.duckLevel !== undefined ? `, duckLevel=${focusRelease.duckLevel}` : ''}`);

    return { transcript, reply, audioBase64, degraded: usingDegraded };
  }

  async function checkAudioAllowed(providerName: string): Promise<{ allowed: boolean; reason?: string }> {
    if (!privacyRepo) {
      return { allowed: true };
    }
    const settings = await privacyRepo.getSettings();
    if (settings.providers_allowed.length > 0 && !settings.providers_allowed.includes(providerName)) {
      return { allowed: false, reason: `provider ${providerName} not in allowlist` };
    }
    return { allowed: true };
  }

  async function applyTranscriptPrivacy(transcript: string): Promise<{ displayTranscript: string; redactedCount: number }> {
    if (!privacyRepo) {
      return { displayTranscript: transcript, redactedCount: 0 };
    }
    const settings = await privacyRepo.getSettings();

    if (settings.transcript_log_level === 'none') {
      console.log('[intel][privacy] Transcript logging disabled');
      return { displayTranscript: '[TRANSCRIPT LOGGING DISABLED]', redactedCount: 0 };
    }

    if (settings.transcript_log_level === 'anonymized' && privacyFilter) {
      const { anonymized, redactedCount } = privacyFilter.apply(transcript);
      return { displayTranscript: anonymized, redactedCount };
    }

    // 'full' — log the raw transcript.
    return { displayTranscript: transcript, redactedCount: 0 };
  }

  function discardAudioBuffer(audio: Buffer | undefined): void {
    // If retain_audio is false, we simply don't hold a reference beyond the
    // pipeline — the Buffer will be GC'd. We log the intent for audit.
    if (audio) {
      console.log(`[intel][privacy] Audio buffer processed (${audio.length} bytes), will be discarded per policy`);
    }
  }

  async function health(): Promise<HealthStatus[]> {
    const checks: Promise<HealthStatus>[] = [llm.healthCheck()];
    if (asr) checks.push(asr.healthCheck());
    if (tts) checks.push(tts.healthCheck());
    if (providers.mcp) checks.push(providers.mcp.healthCheck());
    return Promise.all(checks);
  }

  async function runIntelligentPipeline(input: VoicePipelineInput): Promise<IntelligentPipelineResult> {
    const pipelineStartedAt = performance.now();
    // 0) Audio focus
    const focusGrant = audioFocus.requestFocus('voice');
    console.log(`[intel][focus] Voice session started, state=${focusGrant.currentState}`);

    // 1) Privacy check
    if (input.audio && asr && privacyRepo) {
      const { allowed, reason } = await checkAudioAllowed('asr');
      if (!allowed) {
        throw new Error(`Privacy policy blocks ASR: ${reason}`);
      }
    }

    // 2) ASR
    const asrStartedAt = performance.now();
    let transcript: string;
    if (input.transcript && input.transcript.length > 0) {
      transcript = input.transcript;
    } else if (input.audio && asr) {
      transcript = await asr.transcribe(input.audio, 'audio/wav');
    } else if (input.audio && !asr) {
      throw new Error('ASR not configured but no transcript provided');
    } else {
      throw new Error('Voice pipeline requires audio or transcript');
    }

    const asrMs = performance.now() - asrStartedAt;

    // 3) Privacy
    const { displayTranscript, redactedCount } = await applyTranscriptPrivacy(transcript);
    await input.onTranscript?.(transcript);
    if (redactedCount > 0) {
      console.log(`[intel][privacy] Redacted ${redactedCount} entities from transcript`);
    }

    // 4) Intent routing
    const routingStartedAt = performance.now();
    const intent = await intentRouter.route(transcript);
    const routingMs = performance.now() - routingStartedAt;
    console.log(`[intel][intent] Resolved intent=${intent.intent} source=${intent.source} confidence=${intent.confidence}`);

    // Empty ASR output is a no-intent turn. Do not ask the LLM to answer an
    // empty prompt or synthesize a long response the Edge will discard.
    if (!transcript.trim()) {
      audioFocus.releaseFocus('voice');
      return {
        transcript: '',
        reply: '',
        degraded: usingDegraded,
        intent,
        timings: {
          asrMs: Math.round(asrMs),
          routingMs: Math.round(routingMs),
          planningMs: 0,
          ttsMs: 0,
          totalMs: Math.round(performance.now() - pipelineStartedAt),
        },
      };
    }

    const planningStartedAt = performance.now();
    const flowMatch = await toolContext.invokeVoiceFlow?.(transcript, input.originDeviceId);

    // 5) Tool execution (if intent is known and actionable)
    let toolResult: ToolResult | undefined;
    let requiresConfirmation = false;
    let confirmationDigest: string | undefined;
    let reply: string;
    let knowledgeCard: { title: string; body: string; source_url?: string; source_label?: string; show_url?: string } | undefined;

    const homeAutomationIntents = new Set(['light_set', 'lock_set', 'climate_set', 'climate_query', 'device_query', 'weather_query']);
    if (flowMatch?.matched) {
      reply = `Running automation: ${flowMatch.flowName ?? 'flow'}.`;
      toolResult = { ok: true, message: reply, data: { executionId: flowMatch.executionId } };
    } else if (intent.intent === 'time_query' || intent.intent === 'date_query') {
      reply = temporalReply(intent.intent);
      toolResult = { ok: true, message: reply };
    } else if (intent.intent === 'timer_set') {
      // Timer is handled client-side via the display command endpoint; just confirm
      const minutes = (intent.slots?.duration_minutes as number | undefined) ?? 0;
      const toolCallArgs = intent.tool_calls?.[0]?.arguments as { duration_minutes?: number } | undefined;
      const durMin = toolCallArgs?.duration_minutes ?? minutes;
      reply = durMin > 0 ? `Setting a timer for ${durMin} minute${durMin !== 1 ? 's' : ''}.` : 'Starting your timer.';
      toolResult = { ok: true, message: reply };
    } else if (intent.intent === 'unknown' || intent.intent === 'error' || homeAutomationIntents.has(intent.intent)) {
      // Unknown deterministic intents may still be answerable through a
      // relevant read-only MCP tool. Mutating MCP calls pause for confirmation.
      const conversational = await runToolAwareConversation(transcript, input);
      reply = conversational.reply;
      toolResult = conversational.toolResult;
      requiresConfirmation = conversational.requiresConfirmation ?? false;
      confirmationDigest = conversational.confirmationDigest;
      if (conversational.knowledge_card) knowledgeCard = conversational.knowledge_card;
    } else {
      // Map intent to tool and execute
      const toolName = mapIntentToTool(intent.intent);
      const toolParams = mapIntentSlotsToToolParams(intent.intent, intent.slots);

      if (toolName && toolRegistry.getTool(toolName)) {
        requiresConfirmation = toolRegistry.requiresConfirmation(toolName);

        if (requiresConfirmation) {
          // Generate a confirmation digest; don't execute yet
          confirmationDigest = `confirm:${toolName}:${JSON.stringify(toolParams)}`;
          reply = `I need to confirm before executing ${toolName}. Please confirm.`;
        } else {
          // Execute the tool directly
          const toolCtx: ToolContext = {
            ...toolContext,
            principal: input.systemPrompt ? 'system' : 'voice_user',
            role: 'voice',
            deviceId: input.originDeviceId,
            haClient: toolContext.haClient ?? null,
            intelligence: undefined,
            intentRouter,
          };
          toolResult = await toolRegistry.executeTool(toolName, toolParams, toolCtx);
          reply = toolResult.message;
        }
      } else {
        // No matching tool — use LLM for reply
        const messages: ChatMessage[] = [];
        messages.push({ role: 'system', content: currentTimeSystemPrompt(input.systemPrompt) });
        (input.conversationHistory ?? []).forEach(turn => {
          messages.push({ role: 'user', content: turn.transcript });
          messages.push({ role: 'assistant', content: turn.reply });
        });
        messages.push({ role: 'user', content: transcript });
        reply = await conversationLlm().chat(messages);
      }
    }

    const planningMs = performance.now() - planningStartedAt;

    // 6) TTS
    const ttsStartedAt = performance.now();
    let audioBase64: string | undefined;
    let audioBuffer: Buffer | undefined;
    // Successful media playback starts audio on the originating device. Do not synthesize an
    // acknowledgement over the top of the requested video/music.
    const mediaPlaybackStarted = ['media_play', 'media_select', 'media_resume', 'media_next'].includes(intent.intent)
      && toolResult?.ok === true
      && (toolResult.data as { playback_started?: boolean } | undefined)?.playback_started !== false;
    if (!input.skipTts && tts && !mediaPlaybackStarted) {
      audioBuffer = await tts.synthesize(reply);
      audioBase64 = audioBuffer.toString('base64');
    }
    const ttsMs = performance.now() - ttsStartedAt;

    // 7) Privacy storage
    if (privacyRepo) {
      await privacyRepo.storeTranscript(transcript);
      if (audioBuffer) {
        await privacyRepo.storeAudio(audioBuffer.length);
      }
    }

    // 8) Discard audio buffer
    discardAudioBuffer(audioBuffer);

    // 9) Release audio focus
    audioFocus.releaseFocus('voice');

    return {
      transcript,
      reply,
      audioBase64,
      degraded: usingDegraded,
      intent,
      toolResult,
      requiresConfirmation,
      confirmationDigest,
      ...(knowledgeCard ? { knowledge_card: knowledgeCard } : {}),
      timings: {
        asrMs: Math.round(asrMs),
        routingMs: Math.round(routingMs),
        planningMs: Math.round(planningMs),
        ttsMs: Math.round(ttsMs),
        totalMs: Math.round(performance.now() - pipelineStartedAt),
      },
    };
  }

  return {
    runVoicePipeline,
    runIntelligentPipeline,
    health,
    providers,
    registry,
    intentRouter,
    toolRegistry,
    checkAudioAllowed,
    applyTranscriptPrivacy,
    discardAudioBuffer,
    audioFocus,
    reloadMcpTools: async (): Promise<void> => {
      toolRegistry.clearMcpTools();
      await registerMcpTools();
    },
    setToolContext: (context): void => { toolContext = { ...toolContext, ...context }; },
    getToolContext: (): Partial<ToolContext> => ({ ...toolContext }),
  };
}

/** Map an intent name to the canonical tool name. */
function mapIntentToTool(intent: string): string | undefined {
  const map: Record<string, string> = {
    media_play: 'media.play',
    media_pause: 'media.pause',
    media_resume: 'media.resume',
    media_stop: 'media.stop',
    media_next: 'media.next',
    media_select: 'media.select',
    brightness_set: 'brightness.set',
    scene_activate: 'scene.activate',
    ha_toggle: 'ha.toggle',
    ha_set_value: 'ha.set_value',
    navigate: 'navigate.page',
    query_status: 'query.status',
  };
  return map[intent];
}

/** Map intent slots to tool parameter names. */
function mapIntentSlotsToToolParams(
  intent: string,
  slots: Record<string, unknown>,
): Record<string, unknown> {
  switch (intent) {
    case 'media_play':
      return { query: slots.query ?? slots.title, source: slots.source ?? 'youtube', media_kind: slots.media_kind };
    case 'media_pause':
    case 'media_resume':
    case 'media_stop':
    case 'media_next':
      return {};
    case 'media_select':
      return { position: slots.position, action: slots.action };
    case 'brightness_set':
      return { level: slots.level, device_id: slots.device };
    case 'scene_activate':
      return { scene: slots.scene };
    case 'ha_toggle':
      return { entity_id: slots.entity, state: slots.state ?? 'toggle' };
    case 'ha_set_value':
      return { entity_id: slots.entity, value: slots.value };
    case 'navigate':
      return { page: slots.page };
    case 'query_status':
      return { entity_id: slots.entity, domain: slots.domain };
    default:
      return { ...slots };
  }
}

/** Parse host from a URL string, tolerating non-URL values. */
function hostFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** Parse port from a URL string, falling back to a default. */
function portFromUrl(url: string | undefined, fallback: number): number {
  if (!url) return fallback;
  try {
    const p = new URL(url).port;
    return p ? Number(p) : fallback;
  } catch {
    return fallback;
  }
}
