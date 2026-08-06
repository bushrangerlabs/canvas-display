import { sendHermesAssistQuery, sendCanvasDeviceCommand } from './hermes';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index';
import { config } from '../config';
import { broadcast } from '../ws/index';
import {
  buildAudioFormatsForLog,
  extractPcmFromWav,
  formatWyomingTarget,
  isWyomingUrl,
  listWyomingVoices,
  parseWyomingTarget,
  synthesizeWithWyoming,
  transcribeWithWyoming,
} from './wyoming';
import {
  normalizeYouTubeQuery,
  resolveYouTubeWatchUrl as resolvePlayableYouTubeWatchUrl,
  type YouTubeSafeSearch,
} from './youtube';

export interface PiperVoiceOption {
  id: string;
  label: string;
}

const DEFAULT_PIPER_VOICES: PiperVoiceOption[] = [
  { id: 'en_US-lessac-medium', label: 'en_US-lessac-medium' },
  { id: 'en_US-lessac-low', label: 'en_US-lessac-low' },
  { id: 'en_US-lessac-high', label: 'en_US-lessac-high' },
  { id: 'en_US-amy-medium', label: 'en_US-amy-medium' },
  { id: 'en_US-ryan-medium', label: 'en_US-ryan-medium' },
  { id: 'en_GB-alan-medium', label: 'en_GB-alan-medium' },
  { id: 'en_GB-southern_english_female-low', label: 'en_GB-southern_english_female-low' },
  { id: 'en_AU-kylie-medium', label: 'en_AU-kylie-medium' },
];

export interface WhisperTranscribeOptions {
  whisperUrl?: string;
  whisperApiKey?: string;
  audio: Buffer;
  filename?: string;
  contentType?: string;
  language?: string;
}

export interface WhisperTranscribeResult {
  text: string;
  raw: unknown;
  contentType: string | null;
}

export interface PiperSpeakOptions {
  piperUrl?: string;
  text: string;
  voice?: string;
  payload?: Record<string, unknown>;
}

export interface PiperSpeakResult {
  contentType: string | null;
  raw: unknown;
  audioBase64?: string;
  text?: string;
}

export interface VoiceTurnOptions {
  text?: string;
  language?: string;
  audio?: Buffer;
  filename?: string;
  contentType?: string;
  deviceId?: string;
  canvasAction?: 'show_floating' | 'navigate_panel' | 'reload' | 'hide_floating';
  canvasPanelId?: string;
  canvasUrl?: string;
  hermesWsUrl?: string;
  hermesWsToken?: string;
  canvasApiUrl?: string;
  timeoutMs?: number;
  whisperUrl?: string;
  piperUrl?: string;
  piperVoice?: string;
  speak?: boolean;
}

type VoiceUiActionType =
  | 'set_page'
  | 'navigate_panel'
  | 'show_floating'
  | 'hide_floating'
  | 'youtube_search'
  | 'youtube_play'
  | 'stop_youtube'
  | 'media_play'
  | 'media_control';

type MediaSourceType = 'music_assistant' | 'radio_browser' | 'direct_audio' | 'youtube';
type MediaControlAction = 'pause' | 'resume' | 'stop' | 'volume' | 'mute';

interface VoiceUiAction {
  type: VoiceUiActionType;
  page?: string;
  page_id?: string;
  panel?: string;
  panel_id?: string;
  url?: string;
  search_query?: string;
  source?: MediaSourceType;
  title?: string;
  action?: MediaControlAction;
  level?: number;
  muted?: boolean;
}

interface VoiceAgentEnvelope {
  speech: string;
  actions: VoiceUiAction[];
  needs_confirmation?: boolean;
}

interface VoiceActionExecutionResult {
  type: VoiceUiActionType;
  success: boolean;
  detail: string;
  speechOverride?: string;
}

function isNavigationActionType(type: VoiceUiActionType): boolean {
  return type === 'navigate_panel' || type === 'youtube_search' || type === 'youtube_play';
}

function alignSpeechWithActionResults(speech: string, actionResults: VoiceActionExecutionResult[]): string {
  const text = speech.trim();
  if (!text) return speech;

  const navigated = actionResults.some((result) => result.success && isNavigationActionType(result.type));
  if (!navigated) return speech;

  const contradictionPattern = /(display|canvas|connection).*(unavailable|not available|could\s*not|unable|can\'t|cannot)|please navigate .* manually/i;
  if (!contradictionPattern.test(text)) return speech;

  return 'Opening that on the display now.';
}

type VoiceIntentBucket = 'home_assistant' | 'hermes_admin' | 'web_explicit' | 'control_or_page' | 'general';

interface NavigationDecisionEnvelope {
  should_navigate: boolean;
  url?: string;
  search_query?: string;
  reason?: string;
}

interface VoiceSessionTurn {
  role: 'user' | 'assistant';
  text: string;
}

interface VoiceSessionState {
  sessionId: string;
  conversationId: string;
  startedAt: number;
  lastActivityAt: number;
  awaitingClarification: boolean;
  turns: VoiceSessionTurn[];
}

const voiceSessions = new Map<string, VoiceSessionState>();
const DEFAULT_VOICE_SESSION_TIMEOUT_MS = 90_000;
const MAX_VOICE_SESSION_TURNS = 8;
let navigationReturnTimer: NodeJS.Timeout | null = null;

const VOICE_AGENT_SYSTEM_RULES = [
  'You are Canvas Display Voice Agent.',
  'Return only valid JSON matching this schema:',
  '{"speech":"string","needs_confirmation":false,"actions":[{"type":"set_page|navigate_panel|show_floating|hide_floating|youtube_search|youtube_play|stop_youtube|media_play|media_control","page":"optional","panel":"optional","url":"optional","search_query":"optional","source":"optional","title":"optional","action":"optional","level":"optional","muted":"optional"}]}',
  'Tool-first policy: when available, use canvas-display plugin tools to resolve URLs and navigation intent before composing final JSON.',
  'Relevant tools: web_search_to_url, youtube_search_to_url, canvas_media_play, canvas_media_control, canvas_set_page, canvas_navigate_panel.',
  'Rules:',
  '- Keep speech concise and natural for TTS.',
  '- Prefer actions only when user intent is clearly about navigation/display control.',
  '- Emit navigate/show actions immediately only for explicit web navigation requests (e.g. open/show/go to/find website).',
  '- Use media_play for music, radio, direct streams, and YouTube playback; set source to music_assistant, radio_browser, direct_audio, or youtube as appropriate.',
  '- For music_assistant and radio_browser requests, you may place the search phrase in url or title when no direct stream URL is known; the media API will resolve it.',
  '- Use media_control for pause, resume, stop, volume, and mute on media playback.',
  '- When the user explicitly asks for YouTube search results, use youtube_search; when they want to watch/play YouTube media, prefer media_play with source youtube.',
  '- For YouTube playback, use a direct watch URL only when verified. Otherwise put plain search text in title or search_query; never put a YouTube results URL in media_play.url.',
  '- Use stop_youtube only if the user explicitly wants YouTube stopped on a display panel; otherwise prefer media_control with source youtube and action stop.',
  '- For generic website requests, prefer resolving with web_search_to_url and include the resulting URL in navigate_panel.',
  '- For generic Q&A, return actions: [].',
  '- If clarification is required, set needs_confirmation=true and actions: [].',
  '- For website-opening requests, provide a verified working http(s) URL when you know it.',
  '- If you do not know the exact verified URL, do NOT invent or guess a domain. Leave url empty and set search_query to the best search phrase.',
  '- Never include markdown fences or extra text outside JSON.',
].join('\n');

export const DEFAULT_VOICE_AGENT_INSTRUCTIONS = [
  'When the user asks to open a website, prefer returning a navigate_panel action.',
  'When the user asks to play music, radio, or a stream, prefer returning a media_play action with the best source type.',
  'For music_assistant and radio_browser lookups, send the station or music name as the url or title value if you do not have a direct stream URL.',
  'When the user asks to pause, resume, stop, mute, or change volume, prefer returning a media_control action.',
  'Use the configured pages/panels when relevant.',
  'If the exact website is ambiguous, ask a clarification question instead of guessing.',
].join('\n');

function resolveUrl(rawUrl: string | undefined, fallback: string): string {
  const value = (rawUrl ?? fallback).trim();
  if (!value) return fallback;
  // Recover from previously mangled values like http://wyoming://host:10300
  if (value.startsWith('http://wyoming://') || value.startsWith('https://wyoming://')) {
    return value.replace(/^https?:\/\//, '').replace(/\/$/, '');
  }
  if (value.startsWith('http://tcp://') || value.startsWith('https://tcp://')) {
    return value.replace(/^https?:\/\//, '').replace(/\/$/, '');
  }
  // Preserve explicit schemes (wyoming://, tcp://, ws://, etc.)
  if (value.includes('://')) return value.replace(/\/$/, '');
  if (value.startsWith('http://') || value.startsWith('https://')) return value.replace(/\/$/, '');
  return `http://${value.replace(/\/$/, '')}`;
}

function shouldUseWyoming(rawUrl: string | undefined): boolean {
  const value = (rawUrl ?? '').trim();
  if (!value) return false;
  if (isWyomingUrl(value)) return true;

  // host:port shorthand (no scheme)
  if (!value.includes('://')) {
    const parts = value.split(':');
    if (parts.length === 2 && (parts[1] === '10300' || parts[1] === '10200')) {
      return true;
    }
  }

  // Convenience: treat HTTP endpoints on common Wyoming ports as Wyoming.
  if (value.startsWith('http://') || value.startsWith('https://')) {
    try {
      const u = new URL(value);
      return u.port === '10300' || u.port === '10200';
    } catch {
      return false;
    }
  }

  return false;
}

function dbGet(key: string, fallback: string): string {
  try {
    const row = getDb().prepare('SELECT value FROM server_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? fallback;
  } catch {
    return fallback;
  }
}

function getVoiceYouTubeSearchOptions() {
  const configuredSafeSearch = dbGet('youtube_safe_search', config.youtubeSafeSearch).trim();
  const safeSearch: YouTubeSafeSearch = configuredSafeSearch === 'none' || configuredSafeSearch === 'moderate'
    ? configuredSafeSearch
    : 'strict';

  return {
    apiKey: config.youtubeApiKey || dbGet('youtube_api_key', '').trim(),
    regionCode: dbGet('youtube_region_code', '').trim() || config.youtubeRegionCode,
    relevanceLanguage: dbGet('youtube_relevance_language', '').trim() || config.youtubeRelevanceLanguage,
    allowYtDlpFallback: true,
    safeSearch,
  };
}

function toBuffer(value: ArrayBuffer): Buffer {
  return Buffer.from(value);
}

function maybeJsonOrText(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

function dedupeVoices(voices: PiperVoiceOption[]): PiperVoiceOption[] {
  const map = new Map<string, PiperVoiceOption>();
  for (const voice of voices) {
    const id = voice.id?.trim();
    if (!id) continue;
    if (!map.has(id)) {
      map.set(id, { id, label: voice.label?.trim() || id });
    }
  }
  return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
}

function extractVoicesFromHttpPayload(payload: unknown): PiperVoiceOption[] {
  if (!payload) return [];

  if (Array.isArray(payload)) {
    return dedupeVoices(payload.flatMap((entry): PiperVoiceOption[] => {
      if (typeof entry === 'string') {
        return [{ id: entry, label: entry }];
      }
      if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>;
        const id = typeof record.id === 'string'
          ? record.id
          : (typeof record.name === 'string' ? record.name : '');
        const label = typeof record.label === 'string'
          ? record.label
          : (typeof record.display_name === 'string' ? record.display_name : id);
        return id ? [{ id, label: label || id }] : [];
      }
      return [];
    }));
  }

  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.voices)) {
      return extractVoicesFromHttpPayload(record.voices);
    }
    if (Array.isArray(record.models)) {
      return extractVoicesFromHttpPayload(record.models);
    }
  }

  return [];
}

export function getVoiceEndpoints() {
  return {
    whisperUrl: resolveUrl(dbGet('whisper_url', process.env.WHISPER_URL ?? 'http://127.0.0.1:9000/v1/audio/transcriptions'), 'http://127.0.0.1:9000/v1/audio/transcriptions'),
    whisperApiKey: dbGet('whisper_api_key', process.env.WHISPER_API_KEY ?? ''),
    piperUrl: resolveUrl(dbGet('piper_url', process.env.PIPER_URL ?? 'http://127.0.0.1:10200/speak'), 'http://127.0.0.1:10200/speak'),
    hermesWsUrl: dbGet('hermes_ws_url', process.env.HERMES_WS_URL ?? process.env.HERMES_URL ?? 'http://127.0.0.1:7860'),
    piperVoice: dbGet('piper_voice', process.env.PIPER_VOICE ?? 'en_US-lessac-medium'),
  };
}

export function getVoiceAgentInstructions(): string {
  return dbGet('voice_agent_instructions', DEFAULT_VOICE_AGENT_INSTRUCTIONS);
}

function getCanvasContextSummary(): string {
  try {
    const db = getDb();
    const pages = db.prepare('SELECT id, name FROM pages ORDER BY name').all() as Array<{ id: string; name: string }>;
    const activePageId = dbGet('active_page_id', '');

    const pageSummaries = pages.map((page) => {
      const panels = db
        .prepare('SELECT name FROM page_panels WHERE page_id = ? ORDER BY position, id')
        .all(page.id) as Array<{ name: string }>;
      const panelList = panels.map((panel) => panel.name).join(', ');
      const active = page.id === activePageId ? ' (active)' : '';
      return `- ${page.name}${active}${panelList ? ` | panels: ${panelList}` : ''}`;
    });

    return pageSummaries.length > 0
      ? `Available pages and panels:\n${pageSummaries.join('\n')}`
      : 'No pages are configured yet. Prefer actions: [].';
  } catch {
    return 'Canvas context unavailable. Prefer actions: [].';
  }
}

function getVoiceSessionTimeoutMs(): number {
  const raw = dbGet('voice_session_timeout_sec', '90').trim();
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_VOICE_SESSION_TIMEOUT_MS;
  return Math.max(15_000, parsed * 1000);
}

function getVoiceSessionKey(options: VoiceTurnOptions): string {
  const device = options.deviceId?.trim();
  if (device) return `device:${device}`;
  return 'device:direct';
}

function pruneVoiceSessions(now = Date.now()): void {
  const timeoutMs = getVoiceSessionTimeoutMs();
  for (const [key, session] of voiceSessions.entries()) {
    if ((now - session.lastActivityAt) > timeoutMs) {
      voiceSessions.delete(key);
    }
  }
}

function getOrCreateVoiceSession(options: VoiceTurnOptions): VoiceSessionState {
  const now = Date.now();
  const timeoutMs = getVoiceSessionTimeoutMs();
  pruneVoiceSessions(now);

  const key = getVoiceSessionKey(options);
  const existing = voiceSessions.get(key);
  if (existing && (now - existing.lastActivityAt) <= timeoutMs) {
    existing.lastActivityAt = now;
    return existing;
  }

  const created: VoiceSessionState = {
    sessionId: randomUUID(),
    conversationId: randomUUID(),
    startedAt: now,
    lastActivityAt: now,
    awaitingClarification: false,
    turns: [],
  };
  voiceSessions.set(key, created);
  return created;
}

function appendSessionTurn(session: VoiceSessionState, role: 'user' | 'assistant', text: string): void {
  const cleaned = text.trim();
  if (!cleaned) return;
  session.turns.push({ role, text: cleaned });
  if (session.turns.length > MAX_VOICE_SESSION_TURNS) {
    session.turns.splice(0, session.turns.length - MAX_VOICE_SESSION_TURNS);
  }
  session.lastActivityAt = Date.now();
}

function getSessionHistorySummary(session: VoiceSessionState): string {
  if (session.turns.length === 0) return 'No prior turns in this session.';
  const recent = session.turns.slice(-6).map((turn) => `${turn.role}: ${turn.text}`);
  return ['Recent session turns:', ...recent].join('\n');
}

function isSessionResetCommand(transcript: string): boolean {
  const t = transcript.trim().toLowerCase();
  if (!t) return false;
  return /^(cancel|never mind|nevermind|start over|reset|forget that)\b/.test(t);
}

function classifyVoiceIntent(transcript: string): VoiceIntentBucket {
  const text = transcript.toLowerCase();

  if (/\b(turn on|turn off|switch on|switch off|set|dim|brighten|is .* on\??|is .* off\??|status of)\b/.test(text)) {
    return 'control_or_page';
  }

  if (/\b(home screen|go to .*screen|go to .*page|open .*page|set page|change page|show dashboard|show main)\b/.test(text)) {
    return 'control_or_page';
  }

  if (/\b(home assistant|ha|hass)\b/.test(text)) {
    return 'home_assistant';
  }

  if (/\b(hermes|skill|skills|plugin|tool|debug|fix|error|issue|configure|configuration|prompt|instruction)\b/.test(text)) {
    return 'hermes_admin';
  }

  if (/\byoutube\b/.test(text) && /\b(search|find|browse|results)\b/.test(text)) {
    return 'web_explicit';
  }

  if (/\b(open|go to|navigate to|show|find)\b.*\b(website|site|web page|webpage|url)\b/.test(text)) {
    return 'web_explicit';
  }

  if (/\b(open|go to|navigate to)\s+https?:\/\//.test(text)) {
    return 'web_explicit';
  }

  return 'general';
}

function isKnowledgeStyleQuery(transcript: string): boolean {
  const text = transcript.trim().toLowerCase();
  if (!text) return false;

  return /\?|^(what|who|when|where|why|how)\b|\b(explain|define|tell me about|what is|who is|history of|about)\b/.test(text);
}

function buildNavigationDecisionPrompt(
  transcript: string,
  assistantSpeech: string,
  intentBucket: VoiceIntentBucket,
): string {
  return [
    'You are a navigation policy decider for Canvas Display.',
    'Return only valid JSON matching this schema:',
    '{"should_navigate":true,"url":"optional","search_query":"optional","reason":"optional"}',
    'Tool-first policy: when available, use canvas-display plugin tools (web_search_to_url, youtube_search_to_url) to resolve URL confidence.',
    'Rules:',
    `- Intent bucket: ${intentBucket}.`,
    '- For general knowledge Q&A, should_navigate should usually be true and include a useful reference URL.',
    '- Decide whether Canvas should navigate to a webpage after this assistant response.',
    '- If navigation is appropriate and you know a reliable URL, provide url.',
    '- If navigation is appropriate but URL is uncertain, leave url empty and provide search_query.',
    '- If this is Home Assistant or Hermes-admin/development context, should_navigate must be false.',
    '- Never invent unsupported protocol URLs.',
    '',
    `User request: ${transcript}`,
    `Assistant response: ${assistantSpeech}`,
  ].join('\n');
}

function parseNavigationDecisionEnvelope(raw: string): { ok: true; value: NavigationDecisionEnvelope } | { ok: false; error: string } {
  const candidate = extractJsonCandidate(raw);
  if (!candidate) return { ok: false, error: 'empty_response' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { ok: false, error: 'invalid_json' };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'not_an_object' };
  }

  const record = parsed as Record<string, unknown>;
  const shouldNavigate = record.should_navigate === true;
  return {
    ok: true,
    value: {
      should_navigate: shouldNavigate,
      url: typeof record.url === 'string' ? record.url.trim() : undefined,
      search_query: typeof record.search_query === 'string' ? record.search_query.trim() : undefined,
      reason: typeof record.reason === 'string' ? record.reason.trim() : undefined,
    },
  };
}

async function runNavigationDecisionPass(
  transcript: string,
  assistantSpeech: string,
  intentBucket: VoiceIntentBucket,
  session: VoiceSessionState,
  options: VoiceTurnOptions,
): Promise<NavigationDecisionEnvelope | null> {
  const prompt = buildNavigationDecisionPrompt(transcript, assistantSpeech, intentBucket);
  try {
    const result = await sendHermesAssistQuery(prompt, {
      hermesWsUrl: options.hermesWsUrl ?? getVoiceEndpoints().hermesWsUrl,
      hermesWsToken: options.hermesWsToken,
      language: options.language,
      timeoutMs: 10_000,
      conversationId: session.conversationId,
    });
    session.conversationId = result.conversationId || session.conversationId;
    const parsed = parseNavigationDecisionEnvelope(result.speech || result.text || '');
    if (parsed.ok) return parsed.value;
    console.warn('[voice] Navigation decision parse failed:', parsed.error);
  } catch (err) {
    console.warn('[voice] Navigation decision pass failed:', (err as Error).message);
  }
  return null;
}

function clearVoiceSession(options: VoiceTurnOptions): void {
  pruneVoiceSessions();
  voiceSessions.delete(getVoiceSessionKey(options));
}

function clearNavigationReturnTimer(reason: string): void {
  if (!navigationReturnTimer) return;
  clearTimeout(navigationReturnTimer);
  navigationReturnTimer = null;
  console.log('[voice] Cleared navigation return timer:', reason);
}

function getPanelPageId(panelId: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT page_id FROM page_panels WHERE id = ?').get(panelId) as { page_id: string } | undefined;
  return row?.page_id ?? null;
}

function scheduleReturnToDefaultPageIfNeeded(targetPageId: string, targetPanelId: string, source: string): void {
  const defaultNavPageId = dbGet('voice_default_page_id', '').trim();
  const defaultNavPanelId = dbGet('voice_default_panel_id', '').trim();
  const returnPageId = dbGet('voice_return_page_id', '').trim();
  const timeoutRaw = dbGet('voice_return_idle_seconds', '45').trim();
  const timeoutSeconds = Math.max(5, Math.min(3600, Number.parseInt(timeoutRaw, 10) || 45));
  const youtubePageId = dbGet('voice_youtube_page_id', '').trim();
  const youtubePanelId = dbGet('voice_youtube_panel_id', '').trim();
  const youtubeDisableAutoReturn = dbGet('voice_youtube_disable_auto_return', '1').trim() !== '0';

  const hasYoutubeTargetOverride = !!(youtubePageId || youtubePanelId);
  const youtubePageMatch = !youtubePageId || youtubePageId === targetPageId;
  const youtubePanelMatch = !youtubePanelId || youtubePanelId === targetPanelId;
  if (hasYoutubeTargetOverride && youtubeDisableAutoReturn && youtubePageMatch && youtubePanelMatch) {
    clearNavigationReturnTimer('youtube target configured to bypass auto-return');
    return;
  }

  if (!returnPageId) {
    clearNavigationReturnTimer('return page disabled');
    return;
  }

  const defaultPageMatch = !defaultNavPageId || defaultNavPageId === targetPageId;
  const defaultPanelMatch = !defaultNavPanelId || defaultNavPanelId === targetPanelId;
  const matchesDefaultNavigationTarget = defaultPageMatch && defaultPanelMatch;

  if (!matchesDefaultNavigationTarget) {
    clearNavigationReturnTimer('navigation target is not default navigation panel/page');
    return;
  }

  clearNavigationReturnTimer('rescheduling due to navigation panel interaction');
  navigationReturnTimer = setTimeout(() => {
    const activated = activatePage(returnPageId);
    if (activated) {
      console.log('[voice] Auto-returned to default page after navigation inactivity:', {
        returnPageId,
        returnPageName: activated.name,
        timeoutSeconds,
      });
    } else {
      console.warn('[voice] Failed to auto-return: return page not found', { returnPageId });
    }
    navigationReturnTimer = null;
  }, timeoutSeconds * 1000);

  console.log('[voice] Scheduled return-to-default-page timer:', {
    source,
    targetPageId,
    targetPanelId,
    returnPageId,
    timeoutSeconds,
  });
}

function buildVoiceAgentPrompt(transcript: string, session: VoiceSessionState): string {
  return [
    VOICE_AGENT_SYSTEM_RULES,
    '',
    getVoiceAgentInstructions(),
    '',
    getCanvasContextSummary(),
    '',
    getSessionHistorySummary(session),
    `Session status: ${session.awaitingClarification ? 'awaiting clarification' : 'normal'}`,
    '',
    `User request: ${transcript}`,
  ].join('\n');
}

function normalizeTranscriptForPlanning(transcript: string): string {
  return transcript
    .replace(/\bASPN\b/gi, 'ESPN')
    .replace(/\bSPN\b/gi, 'ESPN')
    .replace(/\bESPN Sport\b/gi, 'ESPN Sports');
}

function extractJsonCandidate(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  return trimmed;
}

function parseVoiceAgentEnvelope(raw: string): { ok: true; value: VoiceAgentEnvelope } | { ok: false; error: string } {
  const candidate = extractJsonCandidate(raw);
  if (!candidate) {
    return { ok: false, error: 'empty_response' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { ok: false, error: 'invalid_json' };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'not_an_object' };
  }

  const record = parsed as Record<string, unknown>;
  const speech = typeof record.speech === 'string' ? record.speech.trim() : '';
  const needsConfirmation = record.needs_confirmation === true;
  const actionsRaw = Array.isArray(record.actions) ? record.actions : [];

  const actions: VoiceUiAction[] = [];
  for (const action of actionsRaw) {
    if (!action || typeof action !== 'object') continue;
    const a = action as Record<string, unknown>;
    const type = typeof a.type === 'string' ? a.type : '';
    if (!['set_page', 'navigate_panel', 'show_floating', 'hide_floating', 'youtube_search', 'youtube_play', 'stop_youtube', 'media_play', 'media_control'].includes(type)) continue;
    actions.push({
      type: type as VoiceUiActionType,
      page: typeof a.page === 'string' ? a.page : undefined,
      page_id: typeof a.page_id === 'string' ? a.page_id : undefined,
      panel: typeof a.panel === 'string' ? a.panel : undefined,
      panel_id: typeof a.panel_id === 'string' ? a.panel_id : undefined,
      url: typeof a.url === 'string' ? a.url : undefined,
      search_query: typeof a.search_query === 'string' ? a.search_query : undefined,
      source: typeof a.source === 'string' ? a.source as MediaSourceType : undefined,
      title: typeof a.title === 'string' ? a.title : undefined,
      action: typeof a.action === 'string' ? a.action as MediaControlAction : undefined,
      level: typeof a.level === 'number' ? a.level : undefined,
      muted: typeof a.muted === 'boolean' ? a.muted : undefined,
    });
  }

  if (!speech) {
    return { ok: false, error: 'missing_speech' };
  }

  return { ok: true, value: { speech, actions, needs_confirmation: needsConfirmation } };
}

async function repairVoiceAgentEnvelope(
  transcript: string,
  raw: string,
  parseError: string,
  options: VoiceTurnOptions,
  conversationId?: string,
): Promise<VoiceAgentEnvelope | null> {
  const repairPrompt = [
    'Your previous response could not be parsed into required JSON.',
    `Parse error: ${parseError}`,
    'Return ONLY valid JSON matching this exact schema:',
    '{"speech":"string","needs_confirmation":false,"actions":[{"type":"set_page|navigate_panel|show_floating|hide_floating|youtube_search|youtube_play|stop_youtube|media_play|media_control","page":"optional","panel":"optional","url":"optional","search_query":"optional","source":"optional","title":"optional","action":"optional","level":"optional","muted":"optional"}]}',
    'For website requests, if the exact verified URL is unknown, leave url empty and set search_query instead.',
    'Do not include markdown code fences or extra text.',
    '',
    `User request: ${transcript}`,
    `Previous invalid response: ${raw}`,
  ].join('\n');

  try {
    const repaired = await sendHermesAssistQuery(repairPrompt, {
      hermesWsUrl: options.hermesWsUrl ?? getVoiceEndpoints().hermesWsUrl,
      hermesWsToken: options.hermesWsToken,
      language: options.language,
      timeoutMs: 10_000,
      conversationId,
    });
    const parsed = parseVoiceAgentEnvelope(repaired.speech || repaired.text || '');
    if (parsed.ok) return parsed.value;
  } catch (err) {
    console.warn('[voice] Structured repair failed:', (err as Error).message);
  }

  return null;
}

function normalizeUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  if (value.includes('://')) return value;
  return `https://${value}`;
}

type YouTubeActionMode = 'none' | 'search' | 'play';





function buildYouTubeSearchUrl(query: string): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query.trim())}`;
}



function isYouTubeIntentText(value: string): boolean {
  return /\b(youtube|youtu\.be)\b/i.test(value);
}



function detectYouTubeActionMode(action: VoiceUiAction, transcript: string): YouTubeActionMode {
  if (action.type === 'youtube_search') return 'search';
  if (action.type === 'youtube_play') return 'play';

  const combined = `${transcript} ${action.search_query ?? ''} ${action.url ?? ''}`.trim();
  if (!isYouTubeIntentText(combined)) return 'none';

  if (/\b(search|find|results|browse|look up)\b.*\b(youtube|youtu\.be)\b|\b(youtube|youtu\.be)\b.*\b(search|results|browse)\b/i.test(combined)) {
    return 'search';
  }

  if (/\b(play|watch|listen|start|put on)\b/i.test(combined)) {
    return 'play';
  }

  // Default YouTube intent to play so spoken commands like
  // "open X on YouTube" prefer immediate media playback.
  return 'play';
}

async function resolveYouTubeWatchUrl(query: string, explicitUrl?: string): Promise<string> {
  try {
    const resolved = await resolvePlayableYouTubeWatchUrl(
      explicitUrl?.trim() || query,
      query,
      getVoiceYouTubeSearchOptions(),
    );
    if (resolved) return resolved;
  } catch (err) {
    console.warn('[voice] YouTube URL lookup failed:', (err as Error).message);
  }

  const cleaned = normalizeYouTubeQuery(explicitUrl ?? '') || normalizeYouTubeQuery(query);
  return cleaned ? buildYouTubeSearchUrl(cleaned) : 'https://www.youtube.com/';
}

function isLikelyWebUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  const value = raw.trim();
  if (!value || /\s/.test(value)) return false;
  try {
    const parsed = new URL(normalizeUrl(value));
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    return parsed.hostname === 'localhost' || /^[0-9.]+$/.test(parsed.hostname) || parsed.hostname.includes('.');
  } catch {
    return false;
  }
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

function siteStemFromHost(host: string): string {
  const normalized = normalizeHost(host);
  return normalized
    .replace(/\.com\.au$/i, '')
    .replace(/\.com$/i, '');
}

function extractQueryTokens(query: string): string[] {
  const stopWords = new Set(['the', 'a', 'an', 'website', 'site', 'official', 'open', 'find']);
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !stopWords.has(token));
}

async function probeFinalUrl(candidateUrl: string): Promise<string> {
  try {
    const head = await fetch(candidateUrl, {
      method: 'HEAD',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) CanvasDisplay/1.0',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (head.ok && isLikelyWebUrl(head.url)) return normalizeUrl(head.url);
  } catch {
    // fallback to GET below
  }

  try {
    const get = await fetch(candidateUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) CanvasDisplay/1.0',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (get.ok && isLikelyWebUrl(get.url)) return normalizeUrl(get.url);
  } catch {
    // return original if probing fails
  }

  return normalizeUrl(candidateUrl);
}

function scoreCandidateUrl(
  candidateUrl: string,
  originalPosition: number,
  queryTokens: string[],
  preferredComStems: Set<string>,
): number {
  let score = 100 - Math.min(originalPosition, 99);

  let host = '';
  let path = '';
  try {
    const parsed = new URL(candidateUrl);
    host = normalizeHost(parsed.hostname);
    path = parsed.pathname.toLowerCase();
  } catch {
    return -1000;
  }

  if (host.endsWith('.com')) score += 30;
  if (host.endsWith('.com.au')) score += 8;

  const stem = siteStemFromHost(host);
  if (preferredComStems.has(stem)) {
    if (host.endsWith('.com')) score += 35;
    if (host.endsWith('.com.au')) score -= 25;
  }

  for (const token of queryTokens) {
    if (host.includes(token)) score += 9;
    if (path.includes(token)) score += 3;
  }

  return score;
}

function deriveSearchQuery(action: VoiceUiAction, transcript: string): string {
  const explicit = action.search_query?.trim();
  if (explicit) return explicit;

  return transcript
    .replace(/^\s*(open|find|show|go to|navigate to)\s+/i, '')
    .replace(/\b(on|in)\s+(the\s+)?(main|centre|center|top|bottom|left|right)\s+panel\b/gi, '')
    .replace(/\bwebsite\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function resolveSearchResultUrl(query: string): Promise<string | null> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return null;

  const endpoints = [
    `https://duckduckgo.com/html/?q=${encodeURIComponent(trimmedQuery)}`,
    `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(trimmedQuery)}`,
  ];

  const candidates: Array<{ url: string; position: number }> = [];
  let position = 0;

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) CanvasDisplay/1.0',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (!response.ok) continue;

      const html = await response.text();
      const redirectMatches = Array.from(html.matchAll(/href="([^"]*(?:uddg=|https?:\/\/)[^"]+)"/gi));
      for (const match of redirectMatches) {
        position += 1;
        const href = decodeHtmlEntities(match[1] ?? '');
        if (!href) continue;

        if (href.includes('uddg=')) {
          try {
            const parsedHref = new URL(href, endpoint);
            const uddg = parsedHref.searchParams.get('uddg');
            if (uddg && isLikelyWebUrl(uddg)) {
              candidates.push({ url: normalizeUrl(uddg), position });
            }
          } catch {
            // ignore bad redirect URLs
          }
        }

        if (isLikelyWebUrl(href)) {
          candidates.push({ url: normalizeUrl(href), position });
        }
      }
    } catch (err) {
      console.warn('[voice] Website search failed:', (err as Error).message);
    }
  }

  if (candidates.length === 0) return null;

  const deduped = new Map<string, number>();
  for (const candidate of candidates) {
    const existing = deduped.get(candidate.url);
    if (existing === undefined || candidate.position < existing) {
      deduped.set(candidate.url, candidate.position);
    }
  }

  const topCandidates = Array.from(deduped.entries())
    .sort((a, b) => a[1] - b[1])
    .slice(0, 8)
    .map(([url, firstPos]) => ({ url, firstPos }));

  const probedCandidates: Array<{ url: string; firstPos: number }> = [];
  for (const candidate of topCandidates) {
    const finalUrl = await probeFinalUrl(candidate.url);
    if (isLikelyWebUrl(finalUrl)) {
      probedCandidates.push({ url: finalUrl, firstPos: candidate.firstPos });
    }
  }

  const rankedInput = probedCandidates.length > 0 ? probedCandidates : topCandidates;
  const queryTokens = extractQueryTokens(trimmedQuery);

  const stemsWithCom = new Set<string>();
  const stemsWithComAu = new Set<string>();
  for (const candidate of rankedInput) {
    try {
      const host = normalizeHost(new URL(candidate.url).hostname);
      const stem = siteStemFromHost(host);
      if (host.endsWith('.com')) stemsWithCom.add(stem);
      if (host.endsWith('.com.au')) stemsWithComAu.add(stem);
    } catch {
      // skip invalid
    }
  }

  const preferredComStems = new Set<string>();
  for (const stem of stemsWithCom) {
    if (stemsWithComAu.has(stem)) preferredComStems.add(stem);
  }

  const ranked = rankedInput
    .map((candidate) => ({
      ...candidate,
      score: scoreCandidateUrl(candidate.url, candidate.firstPos, queryTokens, preferredComStems),
    }))
    .sort((a, b) => b.score - a.score);

  if (ranked.length > 0) {
    return ranked[0].url;
  }

  return null;
}

function buildSearchResultsUrl(query: string): string {
  return `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
}

async function resolveActionUrl(action: VoiceUiAction, transcript: string): Promise<string> {
  const youtubeMode = detectYouTubeActionMode(action, transcript);
  const query = deriveSearchQuery(action, transcript);

  if (youtubeMode === 'search') {
    const cleaned = normalizeYouTubeQuery(query || transcript);
    if (!cleaned) return 'https://www.youtube.com/';
    return buildYouTubeSearchUrl(cleaned);
  }

  if (youtubeMode === 'play') {
    return resolveYouTubeWatchUrl(query || transcript, action.url);
  }

  if (action.url && isLikelyWebUrl(action.url)) {
    return normalizeUrl(action.url);
  }

  if (!query) return '';

  const resolved = await resolveSearchResultUrl(query);
  if (resolved) {
    console.log('[voice] Resolved website URL via search:', { query, url: resolved });
    return resolved;
  }

  const fallbackSearchUrl = buildSearchResultsUrl(query);
  console.log('[voice] Falling back to search results URL:', { query, url: fallbackSearchUrl });
  return fallbackSearchUrl;
}

function validateActionShape(action: VoiceUiAction): { valid: boolean; reason?: string } {
  if (action.type === 'set_page') {
    if (!action.page && !action.page_id) return { valid: false, reason: 'Missing page/page_id' };
    return { valid: true };
  }

  if (action.type === 'navigate_panel' || action.type === 'youtube_search' || action.type === 'youtube_play') {
    return { valid: true };
  }

  if (action.type === 'stop_youtube') {
    return { valid: true };
  }

  if (action.type === 'media_play') {
    if (!action.source) return { valid: false, reason: 'Missing source' };
    const hasTarget = Boolean(action.url?.trim() || action.title?.trim() || action.search_query?.trim());
    if (!hasTarget) return { valid: false, reason: 'Missing url/title' };
    return { valid: true };
  }

  if (action.type === 'media_control') {
    if (!action.action) return { valid: false, reason: 'Missing action' };
    if ((action.action === 'volume' && typeof action.level !== 'number') || (action.action === 'mute' && typeof action.muted !== 'boolean')) {
      return { valid: false, reason: 'Missing control value' };
    }
    return { valid: true };
  }

  if (action.type === 'show_floating') {
    if (!action.url) return { valid: false, reason: 'Missing url' };
    return { valid: true };
  }

  return { valid: true };
}

function getPageWithPanels(pageId: string): (Record<string, unknown> & { panels: Record<string, unknown>[] }) | null {
  const db = getDb();
  const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(pageId) as Record<string, unknown> | undefined;
  if (!page) return null;
  const panels = db.prepare('SELECT * FROM page_panels WHERE page_id = ? ORDER BY position, id').all(pageId) as Record<string, unknown>[];
  return { ...page, panels };
}

function activatePage(pageId: string): { id: string; name: string } | null {
  const db = getDb();
  const page = db.prepare('SELECT id, name FROM pages WHERE id = ?').get(pageId) as { id: string; name: string } | undefined;
  if (!page) return null;
  db.prepare(`UPDATE server_settings SET value=?, updated_at=datetime('now') WHERE key='active_page_id'`).run(page.id);
  const pageData = getPageWithPanels(page.id);
  if (pageData) {
    broadcast({ type: 'load_page', page_id: page.id, page_data: pageData }, 'browser');
  }
  return page;
}

function resolvePage(action: VoiceUiAction): { id: string; name: string } | null {
  const db = getDb();
  if (action.page_id) {
    const page = db.prepare('SELECT id, name FROM pages WHERE id = ?').get(action.page_id) as { id: string; name: string } | undefined;
    return page ?? null;
  }
  if (action.page) {
    const page = db.prepare('SELECT id, name FROM pages WHERE LOWER(name) = LOWER(?)').get(action.page) as { id: string; name: string } | undefined;
    return page ?? null;
  }
  return null;
}

function getLocalApiBaseUrl(): string {
  return `http://127.0.0.1:${config.port}/api`;
}

async function postLocalApi<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${getLocalApiBaseUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (payload as { error?: string }).error ?? `API ${path} failed: ${res.status}`;
    throw new Error(message);
  }
  return payload as T;
}

function resolvePanel(action: VoiceUiAction, scopedPageId?: string): { id: string; name: string } | null {
  const db = getDb();
  if (action.panel_id) {
    const panel = db.prepare('SELECT id, name FROM page_panels WHERE id = ?').get(action.panel_id) as { id: string; name: string } | undefined;
    return panel ?? null;
  }
  if (action.panel) {
    if (scopedPageId) {
      const panel = db.prepare('SELECT id, name FROM page_panels WHERE page_id = ? AND LOWER(name) = LOWER(?)').get(scopedPageId, action.panel) as { id: string; name: string } | undefined;
      return panel ?? null;
    }
    const panel = db.prepare('SELECT id, name FROM page_panels WHERE LOWER(name) = LOWER(?)').get(action.panel) as { id: string; name: string } | undefined;
    return panel ?? null;
  }
  return null;
}

function normalizeMediaSource(source: string | undefined): MediaSourceType | null {
  const value = source?.trim().toLowerCase();
  if (!value) return null;
  if (value === 'music_assistant' || value === 'radio_browser' || value === 'direct_audio' || value === 'youtube') {
    return value;
  }
  return null;
}

function resolveDefaultPage(): { id: string; name: string } | null {
  const db = getDb();
  const defaultPageId = dbGet('voice_default_page_id', '').trim();
  if (!defaultPageId) return null;
  const page = db.prepare('SELECT id, name FROM pages WHERE id = ?').get(defaultPageId) as { id: string; name: string } | undefined;
  return page ?? null;
}

function resolveDefaultPanel(scopedPageId?: string): { id: string; name: string } | null {
  const db = getDb();
  const defaultPanelId = dbGet('voice_default_panel_id', '').trim();

  if (defaultPanelId && scopedPageId) {
    const scoped = db.prepare('SELECT id, name FROM page_panels WHERE id = ? AND page_id = ?').get(defaultPanelId, scopedPageId) as { id: string; name: string } | undefined;
    if (scoped) return scoped;
  }

  if (defaultPanelId && !scopedPageId) {
    const panel = db.prepare('SELECT id, name FROM page_panels WHERE id = ?').get(defaultPanelId) as { id: string; name: string } | undefined;
    if (panel) return panel;
  }

  if (scopedPageId) {
    const firstInPage = db.prepare('SELECT id, name FROM page_panels WHERE page_id = ? ORDER BY position, id LIMIT 1').get(scopedPageId) as { id: string; name: string } | undefined;
    if (firstInPage) return firstInPage;
  }

  const defaultPageId = dbGet('voice_default_page_id', '').trim();
  if (defaultPageId) {
    const firstInDefaultPage = db.prepare('SELECT id, name FROM page_panels WHERE page_id = ? ORDER BY position, id LIMIT 1').get(defaultPageId) as { id: string; name: string } | undefined;
    if (firstInDefaultPage) return firstInDefaultPage;
  }

  return null;
}

async function executeYouTubeVoicePlayback(
  action: VoiceUiAction,
  transcript: string,
): Promise<VoiceActionExecutionResult> {
  const configuredPageId = dbGet('voice_youtube_page_id', '').trim();
  const configuredPanelId = dbGet('voice_youtube_panel_id', '').trim();
  const page = (configuredPageId
    ? resolvePage({ type: 'set_page', page_id: configuredPageId })
    : null)
    ?? resolvePage(action)
    ?? resolveDefaultPage();

  if (page) {
    const activePageId = dbGet('active_page_id', '').trim();
    if (activePageId !== page.id) activatePage(page.id);
  }

  const panel = (configuredPanelId
    ? resolvePanel({ type: 'navigate_panel', panel_id: configuredPanelId }, page?.id)
    : null)
    ?? resolvePanel(action, page?.id)
    ?? (page ? resolveDefaultPanel(page.id) : null);
  const target = action.url?.trim()
    || action.title?.trim()
    || action.search_query?.trim()
    || transcript.trim();
  const title = action.title?.trim()
    || action.search_query?.trim()
    || normalizeYouTubeQuery(transcript)
    || transcript.trim();

  if (!target) {
    return {
      type: action.type,
      success: false,
      detail: 'Missing YouTube title or URL',
      speechOverride: 'I could not determine which YouTube video to play.',
    };
  }

  try {
    const response = await postLocalApi<{
      backend?: string;
      url?: string;
      video_url?: string;
      candidate_count?: number;
    }>('/media/play', {
      source: 'youtube',
      url: target,
      title,
      panel_id: panel?.id,
    });
    if (page && panel) {
      scheduleReturnToDefaultPageIfNeeded(page.id, panel.id, action.type);
    }
    const detailTarget = response.video_url ?? response.url ?? target;
    const backend = response.backend ? ` (${response.backend})` : '';
    const candidateDetail = response.candidate_count && response.candidate_count > 1
      ? `, ${response.candidate_count} candidates`
      : '';
    return {
      type: action.type,
      success: true,
      detail: `Playing youtube media -> ${detailTarget}${backend}${candidateDetail}`,
    };
  } catch (err) {
    return {
      type: action.type,
      success: false,
      detail: (err as Error).message,
      speechOverride: 'I could not play that YouTube video. Check the YouTube API key or try a different title.',
    };
  }
}

async function executeVoiceUiActions(actions: VoiceUiAction[], transcript: string): Promise<VoiceActionExecutionResult[]> {
  const results: VoiceActionExecutionResult[] = [];
  const db = getDb();

  for (const action of actions) {
    const validation = validateActionShape(action);
    if (!validation.valid) {
      results.push({ type: action.type, success: false, detail: `Skipped invalid action: ${validation.reason}` });
      continue;
    }

    try {
      if (action.type === 'set_page') {
        clearNavigationReturnTimer('set_page requested');
        const page = resolvePage(action);
        if (!page) {
          results.push({ type: action.type, success: false, detail: 'Page not found' });
          continue;
        }
        const activated = activatePage(page.id);
        if (!activated) {
          results.push({ type: action.type, success: false, detail: 'Page not found' });
          continue;
        }
        results.push({ type: action.type, success: true, detail: `Set page to ${activated.name}` });
        continue;
      }

      if (action.type === 'youtube_play') {
        results.push(await executeYouTubeVoicePlayback(action, transcript));
        continue;
      }

      if (action.type === 'navigate_panel' || action.type === 'youtube_search') {
        const isYoutubeAction = action.type === 'youtube_search' || detectYouTubeActionMode(action, transcript) !== 'none';
        const configuredYoutubePageId = dbGet('voice_youtube_page_id', '').trim();
        const configuredYoutubePanelId = dbGet('voice_youtube_panel_id', '').trim();

        const youtubePageAction: VoiceUiAction = { type: 'set_page', page_id: configuredYoutubePageId };
        const youtubePanelAction: VoiceUiAction = { type: 'navigate_panel', panel_id: configuredYoutubePanelId };

        const page = (isYoutubeAction && configuredYoutubePageId ? resolvePage(youtubePageAction) : null)
          ?? resolvePage(action)
          ?? resolveDefaultPage();
        if (page) {
          const activePageId = dbGet('active_page_id', '').trim();
          if (activePageId !== page.id) {
            activatePage(page.id);
          }
        }

        const url = await resolveActionUrl(action, transcript);
        if (!url) {
          if (page) {
            results.push({
              type: action.type,
              success: false,
              detail: `Could not resolve a reliable website URL for "${deriveSearchQuery(action, transcript) || transcript}"`,
              speechOverride: 'I could not find a reliable website for that request.',
            });
          } else {
            results.push({
              type: action.type,
              success: false,
              detail: 'Missing url and no target/default page configured',
              speechOverride: 'I could not find a reliable website for that request.',
            });
          }
          continue;
        }

        const panel = (isYoutubeAction && configuredYoutubePanelId
          ? resolvePanel(youtubePanelAction, page?.id)
          : null)
          ?? resolvePanel(action, page?.id)
          ?? resolveDefaultPanel(page?.id);
        if (!panel) {
          results.push({ type: action.type, success: false, detail: 'Panel not found and no default panel configured' });
          continue;
        }

        const targetPageId = page?.id ?? getPanelPageId(panel.id) ?? '';
        console.log('[voice] Sending navigation command:', {
          action: 'navigate_panel',
          panelId: panel.id,
          panelName: panel.name,
          pageId: targetPageId,
          url,
          transcript,
        });

        broadcast({ type: 'command', action: 'navigate_panel', payload: { panel_id: panel.id, url } }, 'browser');
        if (targetPageId) {
          scheduleReturnToDefaultPageIfNeeded(targetPageId, panel.id, action.type);
        }
        results.push({ type: action.type, success: true, detail: `Navigated panel ${panel.name} -> ${url}` });
        continue;
      }

      if (action.type === 'media_play') {
        const source = normalizeMediaSource(action.source);
        if (!source) {
          results.push({
            type: action.type,
            success: false,
            detail: 'Missing or invalid media source',
            speechOverride: 'I could not determine which audio source to use.',
          });
          continue;
        }

        if (source === 'youtube') {
          results.push(await executeYouTubeVoicePlayback(action, transcript));
          continue;
        }

        const target = action.url?.trim() || action.title?.trim() || action.search_query?.trim() || '';
        if (!target) {
          results.push({
            type: action.type,
            success: false,
            detail: 'Missing media url/title',
            speechOverride: 'I could not find a playable media target for that request.',
          });
          continue;
        }

        try {
          const response = await postLocalApi<{ backend?: string; url?: string; video_url?: string; query?: string }>('/media/play', {
            source,
            url: target,
            title: action.title,
          });
          const detailTarget = response.video_url ?? response.url ?? response.query ?? target;
          const backend = response.backend ? ` (${response.backend})` : '';
          results.push({ type: action.type, success: true, detail: `Playing ${source} media -> ${detailTarget}${backend}` });
        } catch (err) {
          results.push({
            type: action.type,
            success: false,
            detail: (err as Error).message,
            speechOverride: 'I could not play that station or stream. Please try a different station name.',
          });
        }
        continue;
      }

      if (action.type === 'media_control') {
        // If source is omitted by Hermes, default to direct_audio (mpv/radio path).
        const source = normalizeMediaSource(action.source) ?? 'direct_audio';
        const controlAction = action.action;
        if (!controlAction) {
          results.push({ type: action.type, success: false, detail: 'Missing media control action' });
          continue;
        }

        try {
          await postLocalApi('/media/control', {
            source,
            action: controlAction,
            level: action.level,
            muted: action.muted,
          });
          results.push({ type: action.type, success: true, detail: `Applied ${controlAction} to ${source}` });
        } catch (err) {
          results.push({ type: action.type, success: false, detail: (err as Error).message });
        }
        continue;
      }

      if (action.type === 'show_floating') {
        const url = await resolveActionUrl(action, transcript);
        if (!url) {
          results.push({
            type: action.type,
            success: false,
            detail: `Could not resolve a reliable website URL for "${deriveSearchQuery(action, transcript) || transcript}"`,
            speechOverride: 'I could not find a reliable website for that request.',
          });
          continue;
        }
        broadcast({ type: 'command', action: 'show_floating', payload: { url } }, 'browser');
        results.push({ type: action.type, success: true, detail: 'Showing floating panel' });
        continue;
      }

      if (action.type === 'hide_floating') {
        broadcast({ type: 'command', action: 'hide_floating', payload: {} }, 'browser');
        results.push({ type: action.type, success: true, detail: 'Hid floating panel' });
        continue;
      }

      if (action.type === 'stop_youtube') {
        const configuredYoutubePanelId = dbGet('voice_youtube_panel_id', '').trim();
        const targetPanel = resolvePanel(action)
          ?? (configuredYoutubePanelId ? resolvePanel({ type: 'navigate_panel', panel_id: configuredYoutubePanelId }) : null)
          ?? resolveDefaultPanel();

        if (targetPanel) {
          broadcast({ type: 'command', action: 'stop_youtube', payload: { panel_id: targetPanel.id } }, 'browser');
          results.push({ type: action.type, success: true, detail: `Stopped YouTube on panel ${targetPanel.name}` });
        } else {
          broadcast({ type: 'command', action: 'stop_youtube', payload: {} }, 'browser');
          results.push({ type: action.type, success: true, detail: 'Stopped YouTube on all panels' });
        }
      }
    } catch (err) {
      results.push({ type: action.type, success: false, detail: (err as Error).message });
    }
  }

  return results;
}

export async function listPiperVoices(piperUrlInput?: string): Promise<PiperVoiceOption[]> {
  const piperUrl = resolveUrl(piperUrlInput, getVoiceEndpoints().piperUrl);
  const voices: PiperVoiceOption[] = [];

  if (shouldUseWyoming(piperUrl)) {
    try {
      const target = parseWyomingTarget(piperUrl);
      const discovered = await listWyomingVoices(target);
      voices.push(...discovered.map((voice) => ({ id: voice.id, label: voice.label })));
    } catch (err) {
      console.warn('[voice] Failed to list Wyoming voices:', (err as Error).message);
    }
  } else {
    const candidates = new Set<string>();
    candidates.add(piperUrl);
    candidates.add(piperUrl.replace(/\/speak$/i, '/voices'));
    candidates.add(piperUrl.replace(/\/v1\/audio\/speak$/i, '/v1/voices'));
    candidates.add(`${piperUrl.replace(/\/$/, '')}/voices`);

    for (const endpoint of candidates) {
      try {
        const response = await fetch(endpoint, { method: 'GET' });
        if (!response.ok) continue;
        const bodyText = await response.text();
        const raw = maybeJsonOrText(bodyText);
        const parsed = extractVoicesFromHttpPayload(raw);
        if (parsed.length > 0) {
          voices.push(...parsed);
          break;
        }
      } catch {
        // try the next endpoint shape
      }
    }
  }

  voices.push(...DEFAULT_PIPER_VOICES);
  return dedupeVoices(voices);
}

export async function transcribeWithWhisper(options: WhisperTranscribeOptions): Promise<WhisperTranscribeResult> {
  const whisperUrl = resolveUrl(options.whisperUrl, getVoiceEndpoints().whisperUrl);
  const whisperApiKey = (options.whisperApiKey ?? getVoiceEndpoints().whisperApiKey ?? '').trim();

  if (shouldUseWyoming(whisperUrl)) {
    const target = parseWyomingTarget(whisperUrl);
    const pcmAudio = extractPcmFromWav(options.audio);
    console.log('[voice] Wyoming ASR request:', {
      target: formatWyomingTarget(target),
      language: options.language ?? 'auto',
      audio: buildAudioFormatsForLog(pcmAudio),
    });

    const result = await transcribeWithWyoming(target, pcmAudio, options.language);
    return {
      text: result.text,
      raw: {
        provider: 'wyoming',
        target: formatWyomingTarget(target),
      },
      contentType: 'application/json',
    };
  }

  console.log('[voice] Whisper request:', { whisperUrl, filename: options.filename ?? 'audio.wav', language: options.language ?? 'auto' });
  const buildForm = (): FormData => {
    const form = new FormData();
    const audioBuffer = options.audio.buffer.slice(options.audio.byteOffset, options.audio.byteOffset + options.audio.byteLength);
    const blob = new Blob([audioBuffer as BlobPart], { type: options.contentType ?? 'application/octet-stream' });
    form.append('file', blob, options.filename ?? 'audio.wav');
    if (options.language) {
      form.append('language', options.language);
    }
    return form;
  };

  const headers: Record<string, string> = {};
  if (whisperApiKey) {
    headers.Authorization = `Bearer ${whisperApiKey}`;
  }

  let response: Response;
  try {
    response = await fetch(whisperUrl, {
      method: 'POST',
      headers,
      body: buildForm(),
    });
  } catch (error) {
    const err = error as Error & { cause?: unknown };
    const cause = err.cause instanceof Error ? err.cause.message : (err.cause ? String(err.cause) : 'none');
    throw new Error(`Whisper transport failed (${whisperUrl}): ${err.message} (cause: ${cause})`);
  }

  // Open WebUI commonly exposes OpenAI-compatible STT at /openai/v1/audio/transcriptions.
  if ((response.status === 404 || response.status === 405) && whisperUrl.endsWith('/v1/audio/transcriptions')) {
    const fallbackUrl = whisperUrl.replace(/\/v1\/audio\/transcriptions$/, '/openai/v1/audio/transcriptions');
    console.warn('[voice] Whisper endpoint returned', response.status, 'retrying with Open WebUI route:', fallbackUrl);
    response = await fetch(fallbackUrl, {
      method: 'POST',
      headers,
      body: buildForm(),
    });
  }

  const contentType = response.headers.get('content-type');
  const bodyText = await response.text();
  const raw = maybeJsonOrText(bodyText);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Whisper request failed (${response.status}): authentication required by endpoint. Configure Whisper API key in Settings.`);
    }
    throw new Error(`Whisper request failed (${response.status}): ${typeof raw === 'string' ? raw : JSON.stringify(raw)}`);
  }

  let text = '';
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    text = String(record.text ?? record.transcript ?? record.result ?? '');
  } else {
    text = String(raw ?? '');
  }

  return { text, raw, contentType };
}

export async function speakWithPiper(options: PiperSpeakOptions): Promise<PiperSpeakResult> {
  const piperUrl = resolveUrl(options.piperUrl, getVoiceEndpoints().piperUrl);

  if (shouldUseWyoming(piperUrl)) {
    const target = parseWyomingTarget(piperUrl);
    console.log('[voice] Wyoming TTS request:', {
      target: formatWyomingTarget(target),
      voice: options.voice ?? getVoiceEndpoints().piperVoice,
      text: options.text,
    });

    const result = await synthesizeWithWyoming(target, options.text, options.voice ?? getVoiceEndpoints().piperVoice);
    return {
      contentType: result.contentType,
      raw: {
        provider: 'wyoming',
        target: formatWyomingTarget(target),
      },
      audioBase64: result.audio.toString('base64'),
    };
  }

  console.log('[voice] Piper TTS request:', { piperUrl, voice: options.voice ?? getVoiceEndpoints().piperVoice, text: options.text });
  const payload = options.payload ?? {
    text: options.text,
    voice: options.voice ?? getVoiceEndpoints().piperVoice,
  };

  let response: Response;
  try {
    response = await fetch(piperUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    const err = error as Error & { cause?: unknown };
    const cause = err.cause instanceof Error ? err.cause.message : (err.cause ? String(err.cause) : 'none');
    throw new Error(`Piper transport failed (${piperUrl}): ${err.message} (cause: ${cause})`);
  }

  const contentType = response.headers.get('content-type');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(`Piper request failed (${response.status}): ${buffer.toString('utf-8')}`);
  }

  if (contentType?.includes('application/json')) {
    const rawText = buffer.toString('utf-8');
    const raw = maybeJsonOrText(rawText);
    return { contentType, raw, text: typeof raw === 'string' ? raw : undefined };
  }

  return { contentType, raw: { bytes: buffer.length }, audioBase64: buffer.toString('base64') };
}

export async function runVoiceTurn(options: VoiceTurnOptions): Promise<Record<string, unknown>> {
  const endpoints = getVoiceEndpoints();
  const queryText = (options.text ?? '').trim();
  console.log('[voice] Turn start:', {
    hasText: Boolean(queryText),
    hasAudio: Boolean(options.audio),
    speak: options.speak !== false,
    deviceId: options.deviceId ?? null,
    canvasAction: options.canvasAction ?? null,
  });

  let transcript = queryText;
  let whisperResult: WhisperTranscribeResult | null = null;

  if (!transcript && options.audio) {
    whisperResult = await transcribeWithWhisper({
      whisperUrl: options.whisperUrl ?? endpoints.whisperUrl,
      whisperApiKey: endpoints.whisperApiKey,
      audio: options.audio,
      filename: options.filename,
      contentType: options.contentType,
      language: options.language,
    });
    transcript = whisperResult.text;
    console.log('[voice] Whisper transcript:', transcript || '(empty)');
  }

  if (!transcript) {
    const emptySpeech = 'I did not catch that. Please try again.';
    let piperResult: PiperSpeakResult | null = null;
    if (options.speak !== false) {
      piperResult = await speakWithPiper({
        piperUrl: options.piperUrl ?? endpoints.piperUrl,
        text: emptySpeech,
        voice: options.piperVoice,
      });
    }
    return {
      transcript: '',
      whisperResult,
      hermesResult: {
        conversationId: null,
        text: emptySpeech,
        speech: emptySpeech,
        structured: { speech: emptySpeech, actions: [], needs_confirmation: false },
        repaired: false,
        parseError: null,
        actionResults: [],
      },
      canvasResult: null,
      piperResult,
    };
  }

  if (isSessionResetCommand(transcript)) {
    clearVoiceSession(options);
    const resetSpeech = 'Okay, starting a new voice session.';
    let piperResult: PiperSpeakResult | null = null;
    if (options.speak !== false) {
      piperResult = await speakWithPiper({
        piperUrl: options.piperUrl ?? endpoints.piperUrl,
        text: resetSpeech,
        voice: options.piperVoice,
      });
      console.log('[voice] Session reset command handled');
    }
    return {
      transcript,
      whisperResult,
      hermesResult: {
        conversationId: null,
        text: resetSpeech,
        speech: resetSpeech,
        structured: { speech: resetSpeech, actions: [], needs_confirmation: false },
        repaired: false,
        parseError: null,
        actionResults: [],
      },
      canvasResult: null,
      piperResult,
    };
  }

  const normalizedTranscript = normalizeTranscriptForPlanning(transcript);
  const intentBucket = classifyVoiceIntent(normalizedTranscript);
  const session = getOrCreateVoiceSession(options);
  const agentPrompt = buildVoiceAgentPrompt(normalizedTranscript, session);
  const hermesResult = await sendHermesAssistQuery(agentPrompt, {
    hermesWsUrl: options.hermesWsUrl ?? endpoints.hermesWsUrl,
    hermesWsToken: options.hermesWsToken,
    language: options.language,
    timeoutMs: options.timeoutMs,
    conversationId: session.conversationId,
  });
  session.conversationId = hermesResult.conversationId || session.conversationId;
  const rawHermesText = hermesResult.speech || hermesResult.text || '';

  let envelopeParse = parseVoiceAgentEnvelope(rawHermesText);
  let repaired = false;
  if (!envelopeParse.ok) {
    const repairedEnvelope = await repairVoiceAgentEnvelope(
      transcript,
      rawHermesText,
      envelopeParse.error,
      options,
      session.conversationId,
    );
    if (repairedEnvelope) {
      envelopeParse = { ok: true, value: repairedEnvelope };
      repaired = true;
    }
  }

  const structuredEnvelope: VoiceAgentEnvelope = envelopeParse.ok
    ? envelopeParse.value
    : {
      speech: hermesResult.speech || hermesResult.text || 'Sorry, I could not process that request reliably.',
      actions: [],
      needs_confirmation: true,
    };

  if (!envelopeParse.ok) {
    console.warn('[voice] Structured response parse failed; actions skipped:', envelopeParse.error);
  } else if (repaired) {
    console.log('[voice] Structured response repaired successfully');
  }

  console.log('[voice] Hermes response:', structuredEnvelope.speech || '(empty)');

  const allowImmediateNavigation = intentBucket === 'web_explicit';
  if (!allowImmediateNavigation && structuredEnvelope.actions.length > 0) {
    structuredEnvelope.actions = structuredEnvelope.actions.filter(
      (action) => action.type !== 'navigate_panel'
        && action.type !== 'show_floating'
        && action.type !== 'youtube_search',
    );
  }

  const actionResults = structuredEnvelope.needs_confirmation
    ? []
    : await executeVoiceUiActions(structuredEnvelope.actions, normalizedTranscript);
  if (structuredEnvelope.needs_confirmation) {
    console.log('[voice] Skipped structured actions: clarification required');
  }
  if (actionResults.length > 0) {
    console.log('[voice] Executed structured actions:', actionResults);
  }

  const speechOverride = actionResults.find((result) => result.speechOverride)?.speechOverride;
  if (speechOverride) {
    structuredEnvelope.speech = speechOverride;
  }

  const shouldRunDecisionPass =
    !structuredEnvelope.needs_confirmation &&
    intentBucket === 'web_explicit' &&
    actionResults.length === 0;

  if (shouldRunDecisionPass) {
    const decision = await runNavigationDecisionPass(
      normalizedTranscript,
      structuredEnvelope.speech,
      intentBucket,
      session,
      options,
    );

    if (decision?.should_navigate) {
      const decisionAction: VoiceUiAction = {
        type: 'navigate_panel',
        url: decision.url,
        search_query: decision.search_query,
      };

      const decisionResults = await executeVoiceUiActions([decisionAction], normalizedTranscript);
      if (decisionResults.length > 0) {
        actionResults.push(...decisionResults);
        console.log('[voice] Executed decision-pass actions:', decisionResults);
      }

      const decisionSpeechOverride = decisionResults.find((result) => result.speechOverride)?.speechOverride;
      if (decisionSpeechOverride) {
        structuredEnvelope.speech = decisionSpeechOverride;
      }
    }
  }

  const shouldForceNavigationByPolicy =
    !structuredEnvelope.needs_confirmation &&
    intentBucket === 'web_explicit' &&
    !actionResults.some((result) => result.success && isNavigationActionType(result.type));

  if (shouldForceNavigationByPolicy) {
    const fallbackAction: VoiceUiAction = {
      type: 'navigate_panel',
      search_query: normalizedTranscript,
    };
    const forcedResults = await executeVoiceUiActions([fallbackAction], normalizedTranscript);
    if (forcedResults.length > 0) {
      actionResults.push(...forcedResults);
      console.log('[voice] Executed policy-forced navigation actions:', forcedResults);
    }

    const forcedSpeechOverride = forcedResults.find((result) => result.speechOverride)?.speechOverride;
    if (forcedSpeechOverride) {
      structuredEnvelope.speech = forcedSpeechOverride;
    }
  }

  structuredEnvelope.speech = alignSpeechWithActionResults(structuredEnvelope.speech, actionResults);

  appendSessionTurn(session, 'user', normalizedTranscript);
  appendSessionTurn(session, 'assistant', structuredEnvelope.speech || hermesResult.speech || hermesResult.text || '');
  session.awaitingClarification = structuredEnvelope.needs_confirmation === true;
  session.lastActivityAt = Date.now();

  let canvasResult: unknown = null;
  if (options.deviceId && options.canvasAction) {
    const payload: Record<string, unknown> = {};
    if (options.canvasAction === 'show_floating') {
      payload.url = options.canvasUrl ?? hermesResult.speech ?? hermesResult.text;
    } else if (options.canvasAction === 'navigate_panel') {
      payload.url = options.canvasUrl ?? hermesResult.speech ?? hermesResult.text;
      if (options.canvasPanelId) payload.panel_id = options.canvasPanelId;
    }

    canvasResult = await sendCanvasDeviceCommand({
      canvasApiUrl: options.canvasApiUrl,
      deviceId: options.deviceId,
      action: options.canvasAction,
      payload,
    });
    console.log('[voice] Canvas device command executed:', { deviceId: options.deviceId, action: options.canvasAction });
  }

  let piperResult: PiperSpeakResult | null = null;
  if (options.speak !== false && structuredEnvelope.speech) {
    console.log('[voice] TTS:', structuredEnvelope.speech);
    piperResult = await speakWithPiper({
      piperUrl: options.piperUrl ?? endpoints.piperUrl,
      text: structuredEnvelope.speech,
      voice: options.piperVoice,
    });
  }

  return {
    transcript,
    whisperResult,
    hermesResult: {
      ...hermesResult,
      text: structuredEnvelope.speech,
      speech: structuredEnvelope.speech,
      structured: structuredEnvelope,
      repaired,
      parseError: envelopeParse.ok ? null : envelopeParse.error,
      actionResults,
    },
    canvasResult,
    piperResult,
  };
}
