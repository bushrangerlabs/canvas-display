/**
 * Audio privacy controls (plan doc §14.4, §25 Phase 5 checklist).
 *
 * Provides:
 *   - `audio_privacy_settings` SQLite-independent row store (Postgres-backed).
 *   - `GET/PUT /api/admin/privacy` — read/update privacy settings.
 *   - `POST /api/admin/privacy/purge` — purge all stored transcripts and audio.
 *   - `PrivacyFilter` — replaces known entity patterns with `[REDACTED]`.
 *
 * All privacy settings are checked before sending audio to ASR, logging
 * transcripts, or retaining audio buffers. The default is privacy-preserving:
 * no retention, anonymized transcripts, all providers allowed.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { AdminRole } from './auth.js';

// --- Types ----------------------------------------------------------------

export interface PrivacySettings {
  /** Retain transcripts after processing (default false). */
  retain_transcripts: boolean;
  /** Retain raw audio after processing (default false). */
  retain_audio: boolean;
  /** Days before retained data is eligible for automatic deletion (0 = no retention). */
  retention_days: number;
  /** Allowed provider IDs. Empty array = all allowed. */
  providers_allowed: string[];
  /** How transcripts are logged. */
  transcript_log_level: 'none' | 'anonymized' | 'full';
}

export const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  retain_transcripts: false,
  retain_audio: false,
  retention_days: 0,
  providers_allowed: [],
  transcript_log_level: 'anonymized',
};

// --- Storage --------------------------------------------------------------

export interface PrivacyRepository {
  getSettings(): Promise<PrivacySettings>;
  updateSettings(settings: Partial<PrivacySettings>): Promise<PrivacySettings>;
  purgeAll(): Promise<{ purgedTranscripts: number; purgedAudio: number }>;
}

/**
 * In-memory privacy repository — no persistence (suitable for tests and early
 * development before the DB-backed version is needed). A separate DB-backed
 * implementation can be added when production persistence is required.
 */
export class InMemoryPrivacyRepository implements PrivacyRepository {
  private settings: PrivacySettings = { ...DEFAULT_PRIVACY_SETTINGS };
  private storedTranscripts: Array<{ id: string; text: string; timestamp: Date }> = [];
  private storedAudio: Array<{ id: string; size: number; timestamp: Date }> = [];

  async getSettings(): Promise<PrivacySettings> {
    return { ...this.settings };
  }

  async updateSettings(partial: Partial<PrivacySettings>): Promise<PrivacySettings> {
    this.settings = {
      ...this.settings,
      ...partial,
    };
    return { ...this.settings };
  }

  async purgeAll(): Promise<{ purgedTranscripts: number; purgedAudio: number }> {
    const purgedTranscripts = this.storedTranscripts.length;
    const purgedAudio = this.storedAudio.length;
    this.storedTranscripts = [];
    this.storedAudio = [];
    return { purgedTranscripts, purgedAudio };
  }

  /** For use by the pipeline — store a transcript if retention is enabled. */
  async storeTranscript(text: string): Promise<void> {
    if (this.settings.retain_transcripts) {
      this.storedTranscripts.push({
        id: crypto.randomUUID(),
        text,
        timestamp: new Date(),
      });
    }
  }

  /** For use by the pipeline — store audio size if retention is enabled. */
  async storeAudio(size: number): Promise<void> {
    if (this.settings.retain_audio) {
      this.storedAudio.push({
        id: crypto.randomUUID(),
        size,
        timestamp: new Date(),
      });
    }
  }
}

// --- Privacy filter -------------------------------------------------------

/**
 * Anonymizes transcript text by replacing known entity patterns with
 * `[REDACTED]`. Covers common Home Assistant entity IDs, email addresses,
 * phone numbers, and IP addresses. Additional patterns can be added as the
 * system evolves.
 */
export class PrivacyFilter {
  private readonly patterns: RegExp[];

  constructor(extraPatterns?: RegExp[]) {
    this.patterns = [
      // Home Assistant entity IDs: sensor.*, light.*, switch.*, etc.
      /\b(?:sensor|binary_sensor|light|switch|cover|climate|fan|lock|media_player|scene|group|automation|script|input_boolean|input_number|input_select|input_text|timer|counter|person|zone)\.[a-z0-9_]+/gi,
      // Email addresses.
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
      // Phone numbers (basic).
      /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{2,4}[-.\s]?\d{2,4}\b/g,
      // IP addresses.
      /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
      // HA api tokens (long alphanumeric strings typical of tokens).
      /\b[a-fA-F0-9]{32,}\b/g,
      // Anything that looks like a bearer token or JWT.
      /\b(?:eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)\b/g,
      // Device IDs (UUID-like).
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    ];
    if (extraPatterns) {
      this.patterns.push(...extraPatterns);
    }
  }

  /**
   * Apply the filter to a transcript. Returns the anonymized text and
   * a count of how many replacements were made.
   */
  apply(text: string): { anonymized: string; redactedCount: number } {
    let anonymized = text;
    let redactedCount = 0;

    for (const pattern of this.patterns) {
      const matches = anonymized.match(pattern);
      if (matches) {
        redactedCount += matches.length;
        anonymized = anonymized.replace(pattern, '[REDACTED]');
      }
    }

    return { anonymized, redactedCount };
  }
}

// --- Routes ---------------------------------------------------------------

export interface PrivacyPluginOptions {
  repo: PrivacyRepository;
  /** Factory to create preHandler middleware (from auth.ts). */
  requireAdmin: (opts?: { roles?: AdminRole[]; csrf?: boolean }) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

export function registerPrivacyRoutes(
  fastify: FastifyInstance,
  opts: PrivacyPluginOptions,
): void {
  const { repo, requireAdmin } = opts;

  // GET /api/admin/privacy — read current settings.
  fastify.get(
    '/api/admin/privacy',
    { preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }) },
    async () => {
      const settings = await repo.getSettings();
      return { settings };
    },
  );

  // PUT /api/admin/privacy — update settings (admin-only, CSRF-protected).
  fastify.put(
    '/api/admin/privacy',
    { preHandler: requireAdmin({ roles: ['admin'] }) },
    async (request, reply) => {
      const body = request.body as Partial<PrivacySettings> | undefined;
      if (!body || typeof body !== 'object') {
        reply.code(400);
        return { error: 'request body required' };
      }

      const validated: Partial<PrivacySettings> = {};

      if (body.retain_transcripts !== undefined) {
        if (typeof body.retain_transcripts !== 'boolean') {
          reply.code(400);
          return { error: 'retain_transcripts must be boolean' };
        }
        validated.retain_transcripts = body.retain_transcripts;
      }

      if (body.retain_audio !== undefined) {
        if (typeof body.retain_audio !== 'boolean') {
          reply.code(400);
          return { error: 'retain_audio must be boolean' };
        }
        validated.retain_audio = body.retain_audio;
      }

      if (body.retention_days !== undefined) {
        if (!Number.isInteger(body.retention_days) || body.retention_days < 0) {
          reply.code(400);
          return { error: 'retention_days must be a non-negative integer' };
        }
        validated.retention_days = body.retention_days;
      }

      if (body.providers_allowed !== undefined) {
        if (!Array.isArray(body.providers_allowed)) {
          reply.code(400);
          return { error: 'providers_allowed must be an array of strings' };
        }
        validated.providers_allowed = body.providers_allowed;
      }

      if (body.transcript_log_level !== undefined) {
        if (!['none', 'anonymized', 'full'].includes(body.transcript_log_level)) {
          reply.code(400);
          return { error: 'transcript_log_level must be none, anonymized, or full' };
        }
        validated.transcript_log_level = body.transcript_log_level;
      }

      const updated = await repo.updateSettings(validated);
      return { settings: updated };
    },
  );

  // POST /api/admin/privacy/purge — immediately purge all stored data.
  fastify.post(
    '/api/admin/privacy/purge',
    { preHandler: requireAdmin({ roles: ['admin'] }) },
    async () => {
      const result = await repo.purgeAll();
      console.log(
        `[privacy] Purge completed: ${result.purgedTranscripts} transcripts, ${result.purgedAudio} audio buffers removed.`,
      );
      return {
        ok: true,
        purgedTranscripts: result.purgedTranscripts,
        purgedAudio: result.purgedAudio,
      };
    },
  );
}
