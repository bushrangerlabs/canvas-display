import type { LlmProvider } from './providers/llm.js';
import type { RouterResult } from './intent-router.js';

export type RequestDomain =
  | 'general_knowledge'
  | 'home_automation'
  | 'music_audio'
  | 'video'
  | 'display_navigation'
  | 'device_control'
  | 'unknown';

export interface RequestRoutingPolicy {
  enabled: boolean;
  useAi: boolean;
  preferDeterministic: boolean;
  confidenceThreshold: number;
  clarifyBelowThreshold: boolean;
  useConversationContext: boolean;
  fallback: 'clarify' | 'general_knowledge';
  debugLogging: boolean;
  domains: Record<Exclude<RequestDomain, 'unknown'>, boolean>;
}

export interface RequestClassification {
  domain: RequestDomain;
  intent: string;
  confidence: number;
  needs_clarification: boolean;
  media_type?: 'video' | 'music' | 'audio' | 'playlist';
  source?: string;
  query?: string;
  reasoning?: string;
  classifier: 'deterministic' | 'ai' | 'fallback';
}

export const DEFAULT_REQUEST_ROUTING_POLICY: RequestRoutingPolicy = {
  enabled: true,
  useAi: true,
  preferDeterministic: true,
  confidenceThreshold: 0.72,
  clarifyBelowThreshold: true,
  useConversationContext: true,
  fallback: 'clarify',
  debugLogging: true,
  domains: {
    general_knowledge: true,
    home_automation: true,
    music_audio: true,
    video: true,
    display_navigation: true,
    device_control: true,
  },
};

export function policyFromSettings(settings: Record<string, string | undefined>): RequestRoutingPolicy {
  const bool = (key: string, fallback: boolean) => settings[key] === undefined ? fallback : settings[key] === '1';
  const rawThreshold = Number(settings.request_routing_confidence_threshold);
  return {
    enabled: bool('request_routing_enabled', true),
    useAi: bool('request_routing_use_ai', true),
    preferDeterministic: bool('request_routing_prefer_deterministic', true),
    confidenceThreshold: Number.isFinite(rawThreshold) ? Math.max(0, Math.min(1, rawThreshold)) : 0.72,
    clarifyBelowThreshold: bool('request_routing_clarify_below_threshold', true),
    useConversationContext: bool('request_routing_use_context', true),
    fallback: settings.request_routing_fallback === 'general_knowledge' ? 'general_knowledge' : 'clarify',
    debugLogging: bool('request_routing_debug_logging', true),
    domains: {
      general_knowledge: bool('request_routing_domain_general_knowledge', true),
      home_automation: bool('request_routing_domain_home_automation', true),
      music_audio: bool('request_routing_domain_music_audio', true),
      video: bool('request_routing_domain_video', true),
      display_navigation: bool('request_routing_domain_display_navigation', true),
      device_control: bool('request_routing_domain_device_control', true),
    },
  };
}

function deterministicDomain(result: RouterResult): RequestDomain {
  const tool = result.tool_calls[0]?.tool ?? '';
  if (tool.startsWith('ha.')) return 'home_automation';
  if (tool === 'media.play') {
    const kind = String(result.tool_calls[0]?.arguments.media_kind ?? '');
    return kind === 'video' ? 'video' : 'music_audio';
  }
  if (tool === 'media.control' || result.intent.startsWith('media_')) return 'device_control';
  if (/page|panel|navigate|display/i.test(result.intent) || tool.startsWith('canvas.')) return 'display_navigation';
  return result.intent === 'unknown' ? 'unknown' : 'general_knowledge';
}

function stripJsonFence(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}

export async function classifyRequest(
  transcript: string,
  deterministic: RouterResult,
  policy: RequestRoutingPolicy,
  llm?: LlmProvider,
): Promise<RequestClassification> {
  const deterministicClassification: RequestClassification = {
    domain: deterministicDomain(deterministic),
    intent: deterministic.intent,
    confidence: deterministic.confidence,
    needs_clarification: deterministic.clarification_needed,
    classifier: 'deterministic',
  };
  if (!policy.enabled) return deterministicClassification;

  const deterministicEnabled = deterministicClassification.domain === 'unknown'
    || policy.domains[deterministicClassification.domain];
  if (policy.preferDeterministic && deterministic.intent !== 'unknown'
      && deterministic.confidence >= policy.confidenceThreshold && deterministicEnabled) {
    return deterministicClassification;
  }

  if (policy.useAi && llm) {
    try {
      const reply = await llm.chat([
        {
          role: 'system',
          content: `Classify the user's request. Return JSON only with: domain, intent, confidence, needs_clarification, media_type, source, query, reasoning. Allowed domains: general_knowledge, home_automation, music_audio, video, display_navigation, device_control, unknown. Distinguish questions about media from requests to play it. Use video only for visual playback, music_audio for songs/albums/playlists/radio. Confidence is 0 to 1. Keep query as the requested subject without command words.`,
        },
        { role: 'user', content: transcript },
      ]);
      const parsed = JSON.parse(stripJsonFence(reply)) as Partial<RequestClassification>;
      const allowed = new Set<RequestDomain>([
        'general_knowledge', 'home_automation', 'music_audio', 'video',
        'display_navigation', 'device_control', 'unknown',
      ]);
      const domain = allowed.has(parsed.domain as RequestDomain) ? parsed.domain as RequestDomain : 'unknown';
      const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
      const enabled = domain === 'unknown' || policy.domains[domain];
      const belowThreshold = confidence < policy.confidenceThreshold;
      return {
        domain: enabled ? domain : 'unknown',
        intent: String(parsed.intent ?? (enabled ? domain : 'disabled_domain')),
        confidence,
        needs_clarification: !enabled || Boolean(parsed.needs_clarification)
          || (policy.clarifyBelowThreshold && belowThreshold),
        media_type: parsed.media_type,
        source: parsed.source,
        query: parsed.query,
        reasoning: !enabled ? `${domain} requests are disabled by policy` : parsed.reasoning,
        classifier: 'ai',
      };
    } catch (error) {
      if (policy.debugLogging) console.warn('[intel][routing] AI classification failed:', error instanceof Error ? error.message : error);
    }
  }

  if (deterministicClassification.domain !== 'unknown' && deterministicEnabled) return deterministicClassification;
  return {
    domain: policy.fallback === 'general_knowledge' ? 'general_knowledge' : 'unknown',
    intent: policy.fallback === 'general_knowledge' ? 'general_knowledge' : 'unknown',
    confidence: 0,
    needs_clarification: policy.fallback === 'clarify',
    classifier: 'fallback',
  };
}
