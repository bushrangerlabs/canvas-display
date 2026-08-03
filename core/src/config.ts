import 'dotenv/config';

/**
 * Canvas Core runtime configuration.
 *
 * Core is the centralized control plane / AI brain (see plan doc §20.5 and
 * decisions D-009..D-013). These values are injected by the Docker Compose
 * stack; nothing here is a device secret. HA / provider credentials live in
 * Core secret storage, never in this file or the Compose file.
 */
export interface CoreConfig {
  port: number;
  host: string;
  /** PostgreSQL connection string. In Compose this points at the `postgres` service. */
  databaseUrl: string;
  /** Device Gateway WSS path (protocol v1, plan doc §12). */
  gatewayPath: string;
  /** External service endpoints Core orchestrates (the AI brain, D-009/D-010). */
  whisperUrl?: string;
  /** Whisper/ASR model id sent to speaches (must match an installed model). */
  whisperModel: string;
  piperUrl?: string;
  llmBaseUrl?: string;
  mcpUrl?: string;
  /** Multiple MCP server URLs (D-011: Core connects to multiple MCP servers). */
  mcpUrls?: string[];
  /** Home Assistant integration (D-012): direct API base + optional long-lived token. */
  homeAssistantUrl?: string;
  homeAssistantToken?: string;
  /** Scoped bearer token accepted only by the Edge voice-turn endpoint. */
  edgeVoiceToken?: string;
  /**
   * Multi-provider AI registry (D-010 extension). When set, Core loads multiple
   * LLM/ASR/TTS providers and routes tasks (intent_routing, conversation, asr,
   * tts, embedding) to assigned providers. Takes precedence over the legacy
   * single-provider env vars below.
   */
  aiProvidersJson?: string;
  /** Optional separate JSON env var for task→provider assignments. */
  aiTaskAssignmentsJson?: string;
  /** Log level. */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /**
   * Admin auth (Phase 2 scaffold, plan doc §13.5 + `docs/PHASE_0_ADMIN_SECURITY_SPEC.md`).
   * HMAC secret for the session JWT. MUST be overridden in any non-dev deployment.
   */
  jwtSecret: string;
  /** Whether session/CSRF cookies are marked `Secure` (requires HTTPS). Dev/LAN http = false. */
  cookieSecure: boolean;
  /** Bootstrap admin username created on first run when `admin_users` is empty. */
  adminUser: string;
  /** Bootstrap admin password created on first run when `admin_users` is empty. */
  adminPassword: string;
  /** Scoped bearer token for trusted local automation clients such as Home Assistant. */
  automationToken?: string;
  /**
   * P-003 device-identity gate: when true (default, dev), the gateway accepts any `edge.hello`
   * (bootstrap mode) so the proven Rust agent keeps connecting during transition. When false,
   * the gateway FAILS CLOSED and only accepts hellos that present a valid enrolled credential
   * or match a paired registry entry. PRODUCTION MUST SET THIS TO false.
   */
  allowOpenPairing: boolean;
  /** Monotonic credential generation retained independently from database backups. */
  securityEpoch?: number;

  // --- Voice session config (Phase 5, plan doc §14) ---
  /** Max concurrent voice sessions per user (default 3). */
  voiceMaxSessionsPerUser: number;
  /** Max concurrent voice sessions globally (default 10). */
  voiceMaxSessionsGlobal: number;
  /** Idle timeout (no frames received) in ms (default 60_000). */
  voiceIdleTimeoutMs: number;
  /** Max session duration in ms (default 30_000). */
  voiceMaxSessionDurationMs: number;
  /** VAD silence threshold: RMS energy below this is silence (default 500). */
  voiceVadThreshold: number;
  /** VAD silence duration before sending vad_silence event in ms (default 3000). */
  voiceVadSilenceMs: number;
  /** Time to wait for vad_continue after vad_silence in ms (default 2000). */
  voiceVadContinueTimeoutMs: number;
}

function str(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(): CoreConfig {
  return {
    host: str('CANVAS_CORE_HOST', '0.0.0.0'),
    port: int('CANVAS_CORE_PORT', 3100),
    databaseUrl: str(
      'CANVAS_CORE_DATABASE_URL',
      'postgresql://canvas:canvas@localhost:5432/canvas_core',
    ),
    gatewayPath: str('CANVAS_CORE_GATEWAY_PATH', '/gateway/v1'),
    whisperUrl: process.env.CANVAS_CORE_WHISPER_URL || undefined,
    whisperModel: str('CANVAS_CORE_WHISPER_MODEL', 'Systran/faster-whisper-base.en'),
    piperUrl: process.env.CANVAS_CORE_PIPER_URL || undefined,
    llmBaseUrl: process.env.CANVAS_CORE_LLM_BASE_URL || undefined,
    mcpUrl: process.env.CANVAS_CORE_MCP_URL || undefined,
    mcpUrls: process.env.CANVAS_CORE_MCP_URLS
      ? process.env.CANVAS_CORE_MCP_URLS.split(',').map((u) => u.trim()).filter(Boolean)
      : undefined,
    homeAssistantUrl: process.env.CANVAS_CORE_HA_URL || undefined,
    homeAssistantToken: process.env.CANVAS_CORE_HA_TOKEN || undefined,
    edgeVoiceToken: process.env.CANVAS_CORE_EDGE_VOICE_TOKEN || undefined,
    // Multi-provider AI registry (D-010 extension).
    aiProvidersJson: process.env.CANVAS_CORE_AI_PROVIDERS || undefined,
    aiTaskAssignmentsJson: process.env.CANVAS_CORE_AI_TASK_ASSIGNMENTS || undefined,
    logLevel: (str('CANVAS_CORE_LOG_LEVEL', 'warn') as CoreConfig['logLevel']),
    jwtSecret: str('CANVAS_CORE_JWT_SECRET', 'insecure-dev-secret-change-me'),
    cookieSecure: process.env.CANVAS_CORE_COOKIE_SECURE === 'true',
    adminUser: str('CANVAS_CORE_ADMIN_USER', 'admin'),
    adminPassword: str('CANVAS_CORE_ADMIN_PASSWORD', 'changeme'),
    automationToken: process.env.CANVAS_CORE_AUTOMATION_TOKEN || undefined,
    allowOpenPairing: process.env.CANVAS_CORE_ALLOW_OPEN_PAIRING !== 'false',
    securityEpoch: Math.max(1, int('CANVAS_CORE_SECURITY_EPOCH', 1)),

    // Voice session defaults (Phase 5)
    voiceMaxSessionsPerUser: int('CANVAS_CORE_VOICE_MAX_PER_USER', 3),
    voiceMaxSessionsGlobal: int('CANVAS_CORE_VOICE_MAX_GLOBAL', 10),
    voiceIdleTimeoutMs: int('CANVAS_CORE_VOICE_IDLE_TIMEOUT_MS', 60_000),
    voiceMaxSessionDurationMs: int('CANVAS_CORE_VOICE_MAX_SESSION_DURATION_MS', 30_000),
    voiceVadThreshold: int('CANVAS_CORE_VOICE_VAD_THRESHOLD', 500),
    voiceVadSilenceMs: int('CANVAS_CORE_VOICE_VAD_SILENCE_MS', 3_000),
    voiceVadContinueTimeoutMs: int('CANVAS_CORE_VOICE_VAD_CONTINUE_TIMEOUT_MS', 2_000),
  };
}
