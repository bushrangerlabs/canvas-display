/**
 * Canvas Intelligence — deterministic intent router (plan doc §15.2, Phase 6).
 *
 * This module maps user voice transcripts to structured intents with typed
 * entities and slots. It runs beside the LLM-based pipeline and is the
 * deterministic path that Canvas Intelligence uses for known patterns.
 *
 * The intent router is a rule-based classifier that recognizes common
 * Home Assistant and Canvas voice patterns. It is NOT the LLM pipeline —
 * it is the fast, deterministic, safe path for well-known intents.
 *
 * Phase scope: Phase 6 implementation. Extends the Phase 2 intelligence
 * scaffold with deterministic routing for the Hermes corpus intents.
 */
import type { ToolCall, ToolDefinition } from './tool-registry.js';
import type { LlmProvider } from './providers/llm.js';
import {
  classifyRequest,
  DEFAULT_REQUEST_ROUTING_POLICY,
  type RequestClassification,
  type RequestRoutingPolicy,
} from './request-routing.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface IntentEntity {
  /** Entity ID (e.g. "light.kitchen", "climate.thermostat"). */
  id: string;
  /** Domain inferred from the entity (e.g. "light", "climate"). */
  domain: string;
  /** Optional friendly name or alias used in the transcript. */
  name?: string;
}

export interface IntentResult {
  /** The recognized intent name (e.g. "light_set", "unknown"). */
  intent: string;
  /** Confidence score (0-1). */
  confidence: number;
  /** Entity IDs resolved from the transcript. */
  entities: IntentEntity[];
  /** Tool calls to execute for this intent. */
  tool_calls: ToolCall[];
  /** Whether the intent requires clarification before execution. */
  clarification_needed: boolean;
  /** A natural language response for the user. */
  response: string;
  /** Raw matched pattern for debugging. */
  matched_pattern?: string;
}

// ── Room/entity name aliases ─────────────────────────────────────────────────

const ROOM_ALIASES: Record<string, string> = {
  kitchen: 'kitchen',
  'living room': 'living_room',
  bedroom: 'bedroom',
  office: 'office',
  bathroom: 'bathroom',
  garage: 'garage',
  'dining room': 'dining_room',
  hallway: 'hallway',
  basement: 'basement',
  upstairs: 'upstairs',
  downstairs: 'downstairs',
};

function resolveRoom(roomName: string): string | undefined {
  const key = roomName.toLowerCase().trim();
  return ROOM_ALIASES[key];
}

function extractRoom(transcript: string): string | undefined {
  for (const [alias, normalized] of Object.entries(ROOM_ALIASES)) {
    if (transcript.toLowerCase().includes(alias)) {
      return normalized;
    }
  }
  return undefined;
}

function extractValue(pattern: RegExp, transcript: string): number | null {
  const match = transcript.match(pattern);
  if (!match) return null;
  return Number(match[1]);
}

export type YouTubeRequestKind = 'video' | 'song' | 'artist' | 'album' | 'playlist' | 'music';

export function parseSmartYouTubeRequest(transcript: string): { query: string; kind: YouTubeRequestKind; label: string } | null {
  let text = transcript.trim().replace(/[.!?]+$/, '').trim();
  if (!text) return null;
  if (/^(?:pause|hold|resume|continue|unpause|stop|close|next|skip)\b/i.test(text)) return null;
  const hasYouTube = /\byoutube(?:\s+music)?\b/i.test(text);
  const hasMediaShape = /\b(playlist|album|song|video|something\s+by|songs?\s+by|music\s+by)\b/i.test(text);
  const hasConversationalLead = /^(?:can|could|would)\s+you\b|^i(?:'d| would)\s+like\b|^i\s+want\b|^(?:find|get)\s+me\b/i.test(text);
  if (!hasYouTube && !hasMediaShape && !hasConversationalLead) return null;

  text = text
    .replace(/^(?:hey\s+canvas[, ]+)?/i, '')
    .replace(/^(?:(?:can|could|would)\s+you\s+|i(?:'d| would)\s+like\s+(?:you\s+)?to\s+|i\s+want\s+(?:you\s+)?to\s+|find\s+me\s+|get\s+me\s+)/i, '')
    .replace(/^(?:please\s+)?(?:play|watch|show|start|open|put\s+on|listen\s+to)\s+/i, '')
    .replace(/\s+please$/i, '')
    .replace(/\s+(?:on|from)\s+youtube(?:\s+music)?(?:\s+on\s+(?:this|the)\s+(?:display|screen))?$/i, '')
    .replace(/\s+on\s+(?:this|the)\s+(?:display|screen)$/i, '')
    .trim();
  if (!text || /^(?:something|anything|music|video|youtube)$/i.test(text)) return null;

  const songBy = text.match(/^(?:the\s+)?(?:song\s+)?(.+?)\s+by\s+(.+?)(?:\s+(?:song|track))?$/i);
  if (songBy && !/^(?:music|songs?|something)$/i.test(songBy[1].trim())) {
    const label = `${songBy[1].trim()} by ${songBy[2].trim()}`;
    return { query: `${songBy[1].trim()} ${songBy[2].trim()} official audio`, kind: 'song', label };
  }

  const artist = text.match(/^(?:some\s+)?(?:music|songs?|something)\s+by\s+(.+)$/i);
  if (artist) {
    const name = artist[1].trim();
    return { query: `${name} greatest hits playlist`, kind: 'artist', label: `music by ${name}` };
  }

  const album = text.match(/^(?:the\s+)?(.+?)(?:\s+album)(?:\s+by\s+(.+))?$/i);
  if (album) {
    const label = `${album[1].trim()}${album[2] ? ` by ${album[2].trim()}` : ''}`;
    return { query: `${label} full album playlist`, kind: 'album', label };
  }

  if (/\bplaylist\b/i.test(text)) {
    return { query: text.replace(/^\s*(?:a|an|the)\s+/i, '').trim(), kind: 'playlist', label: text };
  }

  if (/\bvideo\b/i.test(text) || /\bwatch\b/i.test(transcript)) {
    const label = text.replace(/^(?:the\s+)?(?:video\s+(?:for|called)\s+|video\s+)/i, '').trim();
    return { query: /\bofficial\s+video\b/i.test(label) ? label : `${label} official video`, kind: 'video', label };
  }

  if (/\b(?:music|mix)\b/i.test(text)) {
    const label = text.replace(/^some\s+/i, '').trim();
    return { query: `${label} playlist`, kind: 'music', label };
  }

  return { query: text, kind: 'song', label: text };
}

// ── Intent router ────────────────────────────────────────────────────────────

/**
 * Classify a user transcript into a structured intent.
 *
 * @param transcript - The user's voice transcript.
 * @returns An `IntentResult` with the recognized intent, entities, and tool calls.
 */
export function routeIntent(transcript: string): IntentResult {
  const lower = transcript.toLowerCase().trim();

  // Time/date/day questions are authoritative local Core facts. Keep them on
  // the deterministic fast path instead of spending two LLM calls classifying
  // and answering a request that needs no external provider.
  if (/\b(?:what(?:'s| is| would)?|tell me|(?:can|could|would) you tell me)\s+(?:the\s+)?time(?:\s+(?:is it|would it be|is))?\b|\bcurrent\s+time\b/i.test(lower)) {
    return {
      intent: 'time_query', confidence: 1, entities: [], tool_calls: [],
      clarification_needed: false, response: '', matched_pattern: 'time_query',
    };
  }
  if (/\b(?:what(?:'s| is| would)?|tell me|(?:can|could|would) you tell me)\s+(?:the\s+)?(?:date|day)(?:\s+(?:is it|would it be|is))?\b|\b(?:today's|current)\s+(?:date|day)\b/i.test(lower)) {
    return {
      intent: 'date_query', confidence: 1, entities: [], tool_calls: [],
      clarification_needed: false, response: '', matched_pattern: 'date_query',
    };
  }

  // ── Light control ──────────────────────────────────────────────────────────
  // "turn on the kitchen light"
  const turnOnLightMatch = lower.match(/turn\s+on\s+(?:the\s+)?(.+?)\s+light/);
  if (turnOnLightMatch) {
    const room = resolveRoom(turnOnLightMatch[1]);
    if (room) {
      const entityId = `light.${room}`;
      const brightness = extractValue(/(\d+)\s*percent/i, transcript);
      const serviceData: Record<string, unknown> = { entity_id: entityId };
      if (brightness !== null) {
        if (brightness > 100) {
          return {
            intent: 'light_set',
            confidence: 1.0,
            entities: [],
            tool_calls: [],
            clarification_needed: true,
            response: `Brightness ${brightness}% is out of range. Please choose a value between 0 and 100.`,
            matched_pattern: 'light_set_out_of_range',
          };
        }
        serviceData.brightness_pct = brightness;
      }
      return {
        intent: 'light_set',
        confidence: 1.0,
        entities: [{ id: entityId, domain: 'light', name: room }],
        tool_calls: [{
          tool: 'ha.call_service',
          arguments: {
            domain: 'light',
            service: 'turn_on',
            service_data: serviceData,
          },
        }],
        clarification_needed: false,
        response: brightness !== null
          ? `Turning on the ${room} light to ${brightness}%.`
          : `Turning on the ${room} light.`,
        matched_pattern: 'light_set_room_on',
      };
    }
  }

  // "set the living room light to 50 percent"
  const setLightMatch = lower.match(/set\s+(?:the\s+)?(.+?)\s+light\s+to\s+(\d+)\s*percent/);
  if (setLightMatch) {
    const room = resolveRoom(setLightMatch[1]);
    const brightness = Number(setLightMatch[2]);
    if (brightness > 100) {
      return {
        intent: 'light_set',
        confidence: 1.0,
        entities: [],
        tool_calls: [],
        clarification_needed: true,
        response: `Brightness ${brightness}% is out of range. Please choose a value between 0 and 100.`,
        matched_pattern: 'light_set_out_of_range',
      };
    }
    if (room) {
      const entityId = `light.${room}`;
      return {
        intent: 'light_set',
        confidence: 1.0,
        entities: [{ id: entityId, domain: 'light', name: room }],
        tool_calls: [{
          tool: 'ha.call_service',
          arguments: {
            domain: 'light',
            service: 'turn_on',
            service_data: { entity_id: entityId, brightness_pct: brightness },
          },
        }],
        clarification_needed: false,
        response: `Setting the ${room} light to ${brightness}%.`,
        matched_pattern: 'light_set_room_set_brightness',
      };
    }
  }

  // "turn on the light" (ambiguous — no room specified)
  if (lower.match(/turn\s+on\s+(?:the\s+)?light\s*$/)) {
    return {
      intent: 'light_set',
      confidence: 0.8,
      entities: [],
      tool_calls: [{
        tool: 'ha.call_service',
        arguments: { domain: 'light', service: 'turn_on', service_data: {} },
      }],
      clarification_needed: true,
      response: 'Which light would you like to turn on?',
      matched_pattern: 'light_set_ambiguous',
    };
  }

  // "turn off the bedroom light"
  const turnOffLightMatch = lower.match(/turn\s+off\s+(?:the\s+)?(.+?)\s+light/);
  if (turnOffLightMatch) {
    const room = resolveRoom(turnOffLightMatch[1]);
    if (room) {
      const entityId = `light.${room}`;
      return {
        intent: 'light_set',
        confidence: 1.0,
        entities: [{ id: entityId, domain: 'light', name: room }],
        tool_calls: [{
          tool: 'ha.call_service',
          arguments: { domain: 'light', service: 'turn_off', service_data: { entity_id: entityId } },
        }],
        clarification_needed: false,
        response: `Turning off the ${room} light.`,
        matched_pattern: 'light_set_room_off',
      };
    }
  }

  // "set the brightness to X percent"
  const brightnessOnlyMatch = lower.match(/set\s+(?:the\s+)?brightness\s+to\s+(\d+)\s*percent/);
  if (brightnessOnlyMatch) {
    const brightness = Number(brightnessOnlyMatch[1]);
    if (brightness > 100) {
      return {
        intent: 'light_set',
        confidence: 1.0,
        entities: [],
        tool_calls: [],
        clarification_needed: true,
        response: `Brightness ${brightness}% is out of range. Please choose a value between 0 and 100.`,
        matched_pattern: 'light_set_brightness_out_of_range',
      };
    }
    return {
      intent: 'light_set',
      confidence: 0.7,
      entities: [],
      tool_calls: [{
        tool: 'ha.call_service',
        arguments: { domain: 'light', service: 'turn_on', service_data: { brightness_pct: brightness } },
      }],
      clarification_needed: true,
      response: 'Which light would you like to set to that brightness?',
      matched_pattern: 'light_set_brightness_ambiguous',
    };
  }

  // ── Lock control (safety-critical) ─────────────────────────────────────────
  const unlockMatch = lower.match(/unlock\s+(?:the\s+)?(.+?)\s*(?:door)?$/);
  if (unlockMatch && (lower.includes('door') || unlockMatch[1].includes('door'))) {
    const doorName = unlockMatch[1].replace(/\s+door$/, '').trim();
    const room = resolveRoom(doorName) ?? doorName.replace(/\s+/g, '_');
    return {
      intent: 'lock_set',
      confidence: 1.0,
      entities: [{ id: `lock.${room}_door`, domain: 'lock', name: room }],
      tool_calls: [{
        tool: 'ha.call_service',
        arguments: { domain: 'lock', service: 'unlock', service_data: { entity_id: `lock.${room}_door` } },
      }],
      clarification_needed: true, // Safety-critical: require confirmation
      response: `Are you sure you want to unlock the ${room_name(room)} door?`,
      matched_pattern: 'lock_set_unlock',
    };
  }

  // ── Climate control ────────────────────────────────────────────────────────
  const tempMatch = lower.match(/set\s+(?:the\s+)?(?:thermostat\s+)?to\s+(\d+)\s*(?:degrees?)?/);
  if (tempMatch && (lower.includes('thermostat') || lower.includes('temperature') || lower.includes('degrees'))) {
    const temperature = Number(tempMatch[1]);
    if (temperature < 60 || temperature > 90) {
      return {
        intent: 'climate_set',
        confidence: 0.9,
        entities: [{ id: 'climate.thermostat', domain: 'climate' }],
        tool_calls: [],
        clarification_needed: true,
        response: `Temperature ${temperature}°F is outside the safe range (60-90°F). Please choose a value within that range.`,
        matched_pattern: 'climate_set_out_of_range',
      };
    }
    return {
      intent: 'climate_set',
      confidence: 1.0,
      entities: [{ id: 'climate.thermostat', domain: 'climate' }],
      tool_calls: [{
        tool: 'ha.call_service',
        arguments: {
          domain: 'climate',
          service: 'set_temperature',
          service_data: { entity_id: 'climate.thermostat', temperature },
        },
      }],
      clarification_needed: false,
      response: `Setting the thermostat to ${temperature} degrees.`,
      matched_pattern: 'climate_set',
    };
  }

  // ── Temperature query ──────────────────────────────────────────────────────
  const tempQueryMatch = lower.match(/(?:what(?:\s+is)?|how)\s+(?:the\s+)?temperature\s+(?:in\s+)?(?:the\s+)?(.+?)$/);
  if (tempQueryMatch && (lower.includes('temperature') || lower.includes('what is'))) {
    const room = resolveRoom(tempQueryMatch[1]) ?? tempQueryMatch[1].replace(/\s+/g, '_');
    const entityId = `sensor.${room}_temperature`;
    return {
      intent: 'climate_query',
      confidence: 1.0,
      entities: [{ id: entityId, domain: 'sensor' }],
      tool_calls: [{
        tool: 'ha.get_state',
        arguments: { entity_id: entityId },
      }],
      clarification_needed: false,
      response: `Checking the temperature in ${room_name(room)}.`,
      matched_pattern: 'climate_query',
    };
  }

  // ── Weather query ──────────────────────────────────────────────────────────
  if (lower.includes('weather') && (lower.includes('forecast') || lower.includes('today') || lower.includes('what is'))) {
    return {
      intent: 'weather_query',
      confidence: 1.0,
      entities: [{ id: 'weather.home', domain: 'weather' }],
      tool_calls: [{
        tool: 'ha.get_state',
        arguments: { entity_id: 'weather.home' },
      }],
      clarification_needed: false,
      response: 'Checking the weather forecast.',
      matched_pattern: 'weather_query',
    };
  }

  // ── Media playback ─────────────────────────────────────────────────────────
  const selectionMatch = lower.match(/^(?:play|choose|select)\s+(?:the\s+)?(?:option\s+)?(first|second|third|1st|2nd|3rd)(?:\s+(?:one|option|playlist))?[.!?]?$/);
  if (selectionMatch) {
    const positions: Record<string, number> = { first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2 };
    return {
      intent: 'media_select', confidence: 1, entities: [],
      tool_calls: [{ tool: 'media.select', arguments: { position: positions[selectionMatch[1]] } }],
      clarification_needed: false,
      response: `Playing the ${selectionMatch[1]} playlist.`,
      matched_pattern: 'media_select_playlist',
    };
  }
  if (/^(?:show\s+me\s+)?more(?:\s+(?:playlists|options))?[.!?]?$/.test(lower)) {
    return {
      intent: 'media_select', confidence: 1, entities: [],
      tool_calls: [{ tool: 'media.select', arguments: { action: 'more' } }],
      clarification_needed: false, response: 'Showing more playlist choices.', matched_pattern: 'media_select_more',
    };
  }
  if (/^cancel(?:\s+(?:the\s+)?(?:playlist|selection|choices))?[.!?]?$/.test(lower)) {
    return {
      intent: 'media_select', confidence: 1, entities: [],
      tool_calls: [{ tool: 'media.select', arguments: { action: 'cancel' } }],
      clarification_needed: false, response: 'Cancelling playlist selection.', matched_pattern: 'media_select_cancel',
    };
  }

  const smartYouTubeRequest = parseSmartYouTubeRequest(transcript);
  if (smartYouTubeRequest) {
    const matchedPattern = smartYouTubeRequest.kind === 'playlist'
      ? 'media_play_youtube_playlist'
      : smartYouTubeRequest.kind === 'album'
        ? 'media_play_youtube_album'
        : smartYouTubeRequest.kind === 'artist'
          ? 'media_play_youtube_artist'
          : 'media_play_youtube';
    return {
      intent: 'media_play',
      confidence: 1,
      entities: [],
      tool_calls: [{
        tool: 'media.play',
        arguments: {
          query: smartYouTubeRequest.query,
          source: 'youtube',
          media_kind: smartYouTubeRequest.kind,
        },
      }],
      clarification_needed: false,
      response: `Playing ${smartYouTubeRequest.label} on YouTube.`,
      matched_pattern: matchedPattern,
    };
  }

  // "play Bohemian Rhapsody on YouTube", "watch Bluey on YouTube"
  const youtubePlayMatch = transcript.trim().match(
    /^(?:please\s+)?(?:play|watch|show|listen\s+to)\s+(.+?)\s+(?:on|from)\s+youtube(?:\s+music)?(?:\s+on\s+(?:this|the)\s+(?:display|screen))?(?:\s+please)?[.!?]?$/i,
  );
  if (youtubePlayMatch) {
    const requestedQuery = youtubePlayMatch[1].trim();
    const query = /\balbum\b|^music\s+by\b/i.test(requestedQuery)
      ? `${requestedQuery} playlist`
      : requestedQuery;
    return {
      intent: 'media_play',
      confidence: 1.0,
      entities: [],
      tool_calls: [{
        tool: 'media.play',
        arguments: { query, source: 'youtube' },
      }],
      clarification_needed: false,
      response: `Playing ${query} on YouTube.`,
      matched_pattern: 'media_play_youtube',
    };
  }

  // Public music queues: “play the road trip playlist”, “play music by Crowded House”,
  // and “play the Abbey Road album”. These stay on the public YouTube playback path;
  // no personal YouTube Music account or cookies are required.
  const playlistPlayMatch = transcript.trim().match(
    /^(?:please\s+)?(?:play|start|put\s+on)\s+(.+?\bplaylist)(?:\s+(?:on|from)\s+youtube(?:\s+music)?)?(?:\s+please)?[.!?]?$/i,
  );
  if (playlistPlayMatch) {
    const query = playlistPlayMatch[1].trim();
    return {
      intent: 'media_play', confidence: 1, entities: [],
      tool_calls: [{ tool: 'media.play', arguments: { query, source: 'youtube' } }],
      clarification_needed: false,
      response: `Playing ${query} on YouTube.`,
      matched_pattern: 'media_play_youtube_playlist',
    };
  }

  const artistMusicMatch = transcript.trim().match(
    /^(?:please\s+)?play\s+(?:some\s+)?music\s+by\s+(.+?)(?:\s+(?:on|from)\s+youtube(?:\s+music)?)?(?:\s+please)?[.!?]?$/i,
  );
  if (artistMusicMatch) {
    const query = `${artistMusicMatch[1].trim()} official music`;
    return {
      intent: 'media_play', confidence: 1, entities: [],
      tool_calls: [{ tool: 'media.play', arguments: { query, source: 'youtube' } }],
      clarification_needed: false,
      response: `Playing music by ${artistMusicMatch[1].trim()}.`,
      matched_pattern: 'media_play_youtube_artist',
    };
  }

  const albumPlayMatch = transcript.trim().match(
    /^(?:please\s+)?play\s+(?:the\s+)?(.+?\balbum)(?:\s+by\s+(.+?))?(?:\s+(?:on|from)\s+youtube(?:\s+music)?)?(?:\s+please)?[.!?]?$/i,
  );
  if (albumPlayMatch) {
    const query = `${albumPlayMatch[1].trim()}${albumPlayMatch[2] ? ` by ${albumPlayMatch[2].trim()}` : ''} playlist`;
    return {
      intent: 'media_play', confidence: 1, entities: [],
      tool_calls: [{ tool: 'media.play', arguments: { query, source: 'youtube' } }],
      clarification_needed: false,
      response: `Playing ${query}.`,
      matched_pattern: 'media_play_youtube_album',
    };
  }

  const playMatch = lower.match(/play\s+(?:some\s+)?(.+?)\s+(?:music|in\s+the\s+(.+))/);
  if (playMatch && (lower.includes('play') || lower.includes('music'))) {
    const query = playMatch[1];
    const room = extractRoom(transcript) ?? 'default';
    const deviceName = room !== 'default' ? `${room}_speaker` : 'default_speaker';
    return {
      intent: 'media_play',
      confidence: 0.9,
      entities: [{ id: `media_player.${deviceName}`, domain: 'media_player' }],
      tool_calls: [
        { tool: 'media.search', arguments: { query, media_type: 'music' } },
        { tool: 'media.play', arguments: { device: deviceName, media_type: 'music' } },
      ],
      clarification_needed: false,
      response: `Playing ${query} in the ${room_name(room)}.`,
      matched_pattern: 'media_play',
    };
  }

  // Pause media
  const pauseMatch = lower.match(/(?:pause|hold)\s+(?:the\s+)?(?:youtube|video|music|media|playback)(?:\s+in\s+the\s+(.+))?/);
  if (pauseMatch) {
    const room = pauseMatch[1] ? resolveRoom(pauseMatch[1]) ?? pauseMatch[1].replace(/\s+/g, '_') : 'default';
    const deviceName = room !== 'default' ? `${room}_speaker` : 'default_speaker';
    return {
      intent: 'media_pause',
      confidence: 0.9,
      entities: [{ id: `media_player.${deviceName}`, domain: 'media_player' }],
      tool_calls: [{ tool: 'media.pause', arguments: { device: deviceName } }],
      clarification_needed: false,
      response: `Pausing playback${room !== 'default' ? ` in the ${room_name(room)}` : ''}.`,
      matched_pattern: 'media_pause',
    };
  }

  if (/^(?:resume|continue|unpause)(?:\s+(?:the\s+)?(?:youtube|video|music|media|playback))?[.!?]?$/.test(lower)) {
    return {
      intent: 'media_resume',
      confidence: 1,
      entities: [],
      tool_calls: [{ tool: 'media.resume', arguments: { source: 'youtube' } }],
      clarification_needed: false,
      response: 'Resuming playback.',
      matched_pattern: 'media_resume',
    };
  }

  if (/^(?:stop|close)(?:\s+(?:the\s+)?(?:youtube|video|music|media|playback))?[.!?]?$/.test(lower)) {
    return {
      intent: 'media_stop',
      confidence: 1,
      entities: [],
      tool_calls: [{ tool: 'media.stop', arguments: { source: 'youtube' } }],
      clarification_needed: false,
      response: 'Stopping playback.',
      matched_pattern: 'media_stop',
    };
  }

  if (/^(?:next|skip|skip\s+(?:to\s+)?(?:the\s+)?next)(?:\s+(?:youtube\s+)?(?:video|result|track))?[.!?]?$/.test(lower)) {
    return {
      intent: 'media_next',
      confidence: 1,
      entities: [],
      tool_calls: [{ tool: 'media.next', arguments: { source: 'youtube' } }],
      clarification_needed: false,
      response: 'Playing the next result.',
      matched_pattern: 'media_next',
    };
  }

  // ── Timer ──────────────────────────────────────────────────────────────────
  const timerMatch = lower.match(/set\s+(?:a\s+)?timer\s+for\s+(\d+)\s*(?:minutes?|mins?)/);
  if (timerMatch) {
    const duration = Number(timerMatch[1]);
    return {
      intent: 'timer_set',
      confidence: 1.0,
      entities: [],
      tool_calls: [{
        tool: 'canvas.timer.create',
        arguments: { duration_minutes: duration, label: null },
      }],
      clarification_needed: false,
      response: `Setting a timer for ${duration} minutes.`,
      matched_pattern: 'timer_set',
    };
  }

  // ── Scene activation ───────────────────────────────────────────────────────
  const sceneMatch = lower.match(/activate\s+(.+?)\s+scene/);
  if (sceneMatch) {
    const sceneName = sceneMatch[1].replace(/\s+/g, '_');
    return {
      intent: 'scene_activate',
      confidence: 1.0,
      entities: [{ id: `scene.${sceneName}`, domain: 'scene' }],
      tool_calls: [{
        tool: 'ha.call_service',
        arguments: { domain: 'scene', service: 'turn_on', service_data: { entity_id: `scene.${sceneName}` } },
      }],
      clarification_needed: false,
      response: `Activating ${sceneName.replace(/_/g, ' ')} scene.`,
      matched_pattern: 'scene_activate',
    };
  }

  // ── Device query ───────────────────────────────────────────────────────────
  const deviceQueryMatch = lower.match(/which\s+(.+?)\s+are\s+on/);
  if (deviceQueryMatch) {
    const domain = deviceQueryMatch[1] === 'lights' ? 'light' : deviceQueryMatch[1];
    return {
      intent: 'device_query',
      confidence: 1.0,
      entities: [],
      tool_calls: [{
        tool: 'ha.query',
        arguments: { domain, state: 'on' },
      }],
      clarification_needed: false,
      response: `Checking which ${domain} devices are on.`,
      matched_pattern: 'device_query',
    };
  }

  // ── Navigation ─────────────────────────────────────────────────────────────
  const navMatch = lower.match(/show\s+me\s+(?:the\s+)?(.+?)\s+(?:for|in)\s+(?:the\s+)?(.+?)$/);
  if (navMatch && (lower.includes('show') || lower.includes('dashboard'))) {
    const view = navMatch[1];
    const room = extractRoom(transcript) ?? 'default';
    return {
      intent: 'navigation',
      confidence: 0.9,
      entities: [],
      tool_calls: [{
        tool: 'canvas.navigate',
        arguments: { view, room },
      }],
      clarification_needed: false,
      response: `Showing the ${view} for ${room_name(room)}.`,
      matched_pattern: 'navigation',
    };
  }

  // ── Unknown / unrecognized ─────────────────────────────────────────────────
  return {
    intent: 'unknown',
    confidence: 0,
    entities: [],
    tool_calls: [],
    clarification_needed: true,
    response: "I'm not sure how to handle that request. Could you rephrase it?",
    matched_pattern: 'unknown',
  };
}

/** Helper to convert a room key back to a display-friendly name. */
function room_name(key: string): string {
  const reverseMap: Record<string, string> = {};
  for (const [alias, normalized] of Object.entries(ROOM_ALIASES)) {
    reverseMap[normalized] = alias;
  }
  return reverseMap[key] ?? key.replace(/_/g, ' ');
}

// ── IntentRouter class (Phase 6, used by intelligence.ts) ───────────────────────

export interface IntentRouterOptions {
  /** Optional LLM provider for fallback on unknown intents. */
  llm?: LlmProvider;
}

/**
 * IntentRouter — the deterministic intent router class used by the
 * intelligence pipeline. Wraps the `routeIntent` function and provides
 * the `route()` method with the `source` field expected by `IntelligentPipeline`.
 */
export class IntentRouter {
  private readonly llm?: LlmProvider;
  private policy: RequestRoutingPolicy = DEFAULT_REQUEST_ROUTING_POLICY;

  constructor(opts: IntentRouterOptions = {}) {
    this.llm = opts.llm;
  }

  setPolicy(policy: RequestRoutingPolicy): void {
    this.policy = policy;
  }

  getPolicy(): RequestRoutingPolicy {
    return structuredClone(this.policy);
  }

  async classify(transcript: string): Promise<RequestClassification> {
    const deterministic = this.asRouterResult(routeIntent(transcript));
    return classifyRequest(transcript, deterministic, this.policy, this.llm);
  }

  /**
   * Route a transcript to a structured intent.
   * Returns a result compatible with the `IntelligentPipelineResult` interface.
   */
  async route(transcript: string): Promise<RouterResult> {
    const deterministic = this.asRouterResult(routeIntent(transcript));
    if (!transcript.trim()) return deterministic;
    if (deterministic.intent === 'unknown'
        && /^\s*(?:explain(?:ing)?|why\b|how\s+(?:does|do|is|are|can)\b)/i.test(transcript)) return deterministic;
    const classification = await classifyRequest(transcript, deterministic, this.policy, this.llm);
    if (this.policy.debugLogging) {
      console.log(`[intel][routing] domain=${classification.domain} intent=${classification.intent} classifier=${classification.classifier} confidence=${classification.confidence}`);
    }
    if (classification.needs_clarification && classification.classifier === 'ai') {
      return {
        ...deterministic,
        intent: 'unknown', confidence: classification.confidence, source: 'llm',
        clarification_needed: true, tool_calls: [],
        response: `I am not confident whether that is a ${classification.domain.replace(/_/g, ' ')} request. Could you clarify?`,
      };
    }
    if ((classification.domain === 'video' || classification.domain === 'music_audio')
        && deterministic.intent === 'unknown' && classification.query) {
      const mediaKind = classification.domain === 'video' ? 'video' : (classification.media_type ?? 'music');
      return {
        ...deterministic,
        intent: 'media_play', confidence: classification.confidence, source: 'llm',
        slots: { query: classification.query, source: classification.source ?? 'youtube', media_kind: mediaKind },
        clarification_needed: false,
        response: `Playing ${classification.query}.`,
      };
    }
    return deterministic;
  }

  private asRouterResult(result: IntentResult): RouterResult {
    return {
      intent: result.intent,
      confidence: result.confidence,
      source: 'deterministic',
      slots: this.toSlots(result),
      entities: result.entities,
      tool_calls: result.tool_calls,
      clarification_needed: result.clarification_needed,
      response: result.response,
      matched_pattern: result.matched_pattern,
    };
  }

  /** Convert an IntentResult to a flat slots map for tool execution. */
  private toSlots(result: IntentResult): Record<string, unknown> {
    const slots: Record<string, unknown> = {};
    if (result.entities.length > 0) {
      slots.entity = result.entities[0].id;
      slots.room = result.entities[0].name;
    }
    for (const tc of result.tool_calls) {
      for (const [key, value] of Object.entries(tc.arguments)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          slots[key] = value;
        }
      }
      const serviceData = tc.arguments.service_data as Record<string, unknown> | undefined;
      if (serviceData) {
        for (const [key, value] of Object.entries(serviceData)) {
          slots[key] = value;
        }
      }
    }
    return slots;
  }
}

/** Result of the `IntentRouter.route()` method. */
export interface RouterResult {
  intent: string;
  confidence: number;
  source: 'deterministic' | 'llm' | 'error';
  slots: Record<string, unknown>;
  entities: IntentEntity[];
  tool_calls: ToolCall[];
  clarification_needed: boolean;
  response: string;
  matched_pattern?: string;
}
