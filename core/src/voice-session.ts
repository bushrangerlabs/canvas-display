/**
 * Authenticated voice session WSS (Phase 5, plan doc §14).
 *
 * A separate WebSocket endpoint `/ws/voice` (not the device gateway) for
 * bidirectional Opus audio exchange. Every connection requires a valid Core JWT
 * (from `/api/admin/login`) in the query string (`?token=...`).
 *
 * Session lifecycle:
 *   auth_required -> auth_ok -> audio_start -> audio_start_ack ->
 *   bidirectional Opus frames -> audio_end -> pipeline -> tts_frame* ->
 *   tts_end -> audio_end_ack -> cleanup
 *
 * Rate limiting: max 3 concurrent sessions per user, max 10 globally
 * (configurable via env vars).
 *
 * Timeouts: 60s idle (no frames), 30s max session duration.
 * Post-session frame rejection: after audio_end, any frames are rejected.
 */

import { createHmac } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { CoreConfig } from './config.js';
import type { SessionClaims } from './auth.js';
import type { Intelligence } from './intelligence.js';
import { OpusStreamProcessor, type VoiceSessionMessage } from './voice-audio.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VoiceSessionOptions {
  config: CoreConfig;
  intelligence: Intelligence;
  /** Optional override for the JWT secret (defaults to config.jwtSecret). */
  jwtSecret?: string;
}

export interface SessionRecord {
  id: string;
  userId: string;
  username: string;
  role: string;
  ws: WebSocket;
  processor: OpusStreamProcessor;
  createdAt: number;
  lastFrameAt: number;
  idleTimer: ReturnType<typeof setTimeout>;
  durationTimer: ReturnType<typeof setTimeout>;
  vadSilenceTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

// ---------------------------------------------------------------------------
// Session manager
// ---------------------------------------------------------------------------

export class VoiceSessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly config: CoreConfig;
  private readonly intelligence: Intelligence;
  private readonly jwtSecret: string;

  constructor(opts: VoiceSessionOptions) {
    this.config = opts.config;
    this.intelligence = opts.intelligence;
    this.jwtSecret = opts.jwtSecret ?? opts.config.jwtSecret;
  }

  /** Register the `/ws/voice` endpoint on the Fastify server. */
  register(fastify: FastifyInstance): void {
    const wss = new WebSocketServer({ noServer: true });

    fastify.server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '', 'http://localhost');
      if (url.pathname !== '/ws/voice') {
        return; // Not a voice path — let other handlers (e.g. device gateway) handle it
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    });

    wss.on('connection', (ws: WebSocket, request) => {
      this.handleConnection(ws, request);
    });

    console.log('[voice-session] listening on /ws/voice');
  }

  /** Handle a new WebSocket connection. */
  private handleConnection(ws: WebSocket, request: import('http').IncomingMessage): void {
    const url = new URL(request.url ?? '', 'http://localhost');
    const token = url.searchParams.get('token');

    // Step 1: Authenticate
    if (!token) {
      this.reject(ws, '401', 'Missing token');
      return;
    }

    let claims: SessionClaims;
    try {
      claims = this.verifyToken(token);
    } catch {
      this.reject(ws, '401', 'Invalid or expired token');
      return;
    }

    // Step 2: Authorize role
    if (claims.role !== 'admin' && claims.role !== 'voice') {
      this.reject(ws, '403', 'Insufficient role; requires admin or voice');
      return;
    }

    // Step 3: Rate limit
    const perUserLimit = this.config.voiceMaxSessionsPerUser;
    const globalLimit = this.config.voiceMaxSessionsGlobal;
    const userSessions = this.countUserSessions(claims.sub);
    const globalSessions = this.sessions.size;

    if (userSessions >= perUserLimit) {
      this.reject(ws, '429', `Rate limit: max ${perUserLimit} sessions per user`);
      return;
    }
    if (globalSessions >= globalLimit) {
      this.reject(ws, '429', `Rate limit: max ${globalLimit} global sessions`);
      return;
    }

    // Step 4: Create session
    const sessionId = crypto.randomUUID();
    const processor = new OpusStreamProcessor({
      maxBufferBytes: this.config.voiceMaxSessionDurationMs / 1000 * 16000 * 2,
      vadThreshold: this.config.voiceVadThreshold,
      vadSilenceMs: this.config.voiceVadSilenceMs,
    });

    const record: SessionRecord = {
      id: sessionId,
      userId: claims.sub,
      username: claims.username,
      role: claims.role,
      ws,
      processor,
      createdAt: Date.now(),
      lastFrameAt: Date.now(),
      idleTimer: setTimeout(() => this.handleIdleTimeout(sessionId), this.config.voiceIdleTimeoutMs),
      durationTimer: setTimeout(() => this.handleDurationTimeout(sessionId), this.config.voiceMaxSessionDurationMs),
      vadSilenceTimer: null,
      closed: false,
    };

    this.sessions.set(sessionId, record);

    // Send auth_ok
    this.send(ws, { type: 'audio_start_ack', session_id: sessionId, code: 'auth_ok' });

    // Wire processor output -> WebSocket
    processor.onMessage = (msg) => {
      if (!record.closed) {
        this.send(ws, msg);
      }
    };

    processor.onVadSilence = () => {
      // Start a timer: if no vad_continue within the timeout, close the session
      if (record.vadSilenceTimer) clearTimeout(record.vadSilenceTimer);
      record.vadSilenceTimer = setTimeout(() => {
        this.closeSession(sessionId, 'vad_timeout', 'No vad_continue received');
      }, this.config.voiceVadContinueTimeoutMs);
    };

    // Handle incoming messages
    ws.on('message', (raw) => {
      if (record.closed) return;

      let msg: VoiceSessionMessage;
      try {
        msg = JSON.parse(raw.toString()) as VoiceSessionMessage;
      } catch {
        this.send(ws, { type: 'error', code: 'invalid_json' });
        return;
      }

      // Post-session frame rejection
      if (processor.ended && msg.type === 'audio_frame') {
        this.send(ws, { type: 'error', code: 'session_closed', reason: 'Session already ended' });
        return;
      }

      // Reset idle timer on any message
      clearTimeout(record.idleTimer);
      record.lastFrameAt = Date.now();
      record.idleTimer = setTimeout(() => this.handleIdleTimeout(sessionId), this.config.voiceIdleTimeoutMs);

      // Handle audio_end specially — run the pipeline
      if (msg.type === 'audio_end') {
        processor.handleMessage(msg);
        this.runPipelineAndStream(record).catch((err) => {
          console.error(`[voice-session] pipeline failed for ${sessionId}:`, (err as Error).message);
          this.send(ws, { type: 'error', code: 'pipeline_error', reason: (err as Error).message });
          this.closeSession(sessionId, 'pipeline_error');
        });
        return;
      }

      // Handle vad_continue — cancel the silence timer
      if (msg.type === 'vad_continue') {
        if (record.vadSilenceTimer) {
          clearTimeout(record.vadSilenceTimer);
          record.vadSilenceTimer = null;
        }
      }

      processor.handleMessage(msg);
    });

    // Handle close
    ws.on('close', () => {
      this.cleanupSession(sessionId);
    });

    ws.on('error', () => {
      this.cleanupSession(sessionId);
    });

    console.log(`[voice-session] session ${sessionId} opened for user ${claims.username} (${claims.role})`);
  }

  /** Run the intelligence pipeline and stream TTS back. */
  private async runPipelineAndStream(record: SessionRecord): Promise<void> {
    const result = await record.processor.runPipeline(this.intelligence);

    // Log for audit
    console.log(
      `[voice-session] pipeline complete for ${record.id}: ` +
      `transcript="${result.transcript.slice(0, 100)}" reply="${result.reply.slice(0, 100)}"`,
    );

    // Send transcript and reply as metadata
    this.send(record.ws, {
      type: 'audio_end_ack',
      session_id: record.id,
      transcript: result.transcript,
      reply: result.reply,
    });

    // Stream TTS audio back
    if (result.ttsAudio) {
      const frames = record.processor.streamTts(result.ttsAudio);
      console.log(`[voice-session] streamed ${frames} TTS frames to ${record.id}`);
    } else {
      this.send(record.ws, { type: 'tts_end', session_id: record.id });
    }

    // Clean up after a short delay to allow TTS to complete
    setTimeout(() => {
      this.closeSession(record.id, 'completed', 'Session completed');
    }, 1000);
  }

  /** Verify a JWT token and return the claims. */
  private verifyToken(token: string): SessionClaims {
    // Simple JWT verification without @fastify/jwt dependency.
    // We parse the payload and verify the signature using HMAC-SHA256.
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Malformed token');

    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as { alg?: string };
    if (header.alg !== 'HS256') throw new Error('Unsupported algorithm');

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;

    // Verify signature
    const signature = createHmac('sha256', this.jwtSecret)
      .update(`${parts[0]}.${parts[1]}`)
      .digest('base64url');
    if (signature !== parts[2]) throw new Error('Invalid signature');

    // Check expiry
    if (payload.exp && typeof payload.exp === 'number' && Date.now() / 1000 > payload.exp) {
      throw new Error('Token expired');
    }

    return {
      sub: String(payload.sub ?? ''),
      username: String(payload.username ?? ''),
      role: String(payload.role ?? '') as SessionClaims['role'],
      csrf: String(payload.csrf ?? ''),
    };
  }

  /** Reject a connection and close it immediately. */
  private reject(ws: WebSocket, code: string, reason: string): void {
    this.send(ws, { type: 'error', code, reason });
    ws.close(4001, reason);
    console.warn(`[voice-session] rejected connection: ${code} ${reason}`);
  }

  /** Send a JSON message to the client. */
  private send(ws: WebSocket, msg: VoiceSessionMessage): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  /** Handle idle timeout (no frames received). */
  private handleIdleTimeout(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (!record || record.closed) return;
    this.closeSession(sessionId, 'idle_timeout', 'No frames received for 60s');
  }

  /** Handle max session duration timeout. */
  private handleDurationTimeout(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (!record || record.closed) return;
    this.closeSession(sessionId, 'duration_timeout', 'Max session duration exceeded');
  }

  /** Close a session with a reason. */
  private closeSession(sessionId: string, code: string, reason?: string): void {
    const record = this.sessions.get(sessionId);
    if (!record || record.closed) return;

    this.send(record.ws, { type: 'session_closed', code, reason });
    record.ws.close(4000, reason ?? code);
    this.cleanupSession(sessionId);
  }

  /** Clean up session resources. */
  private cleanupSession(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (!record) return;
    if (record.closed) return;
    record.closed = true;

    clearTimeout(record.idleTimer);
    clearTimeout(record.durationTimer);
    if (record.vadSilenceTimer) clearTimeout(record.vadSilenceTimer);

    this.sessions.delete(sessionId);
    console.log(`[voice-session] session ${sessionId} cleaned up`);
  }

  /** Count sessions for a given user. */
  private countUserSessions(userId: string): number {
    let count = 0;
    for (const record of this.sessions.values()) {
      if (record.userId === userId && !record.closed) count++;
    }
    return count;
  }

  /** Get current session count. */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /** Get active sessions (for diagnostics). */
  getActiveSessions(): Array<{ id: string; username: string; role: string; createdAt: number; lastFrameAt: number }> {
    const result: Array<{ id: string; username: string; role: string; createdAt: number; lastFrameAt: number }> = [];
    for (const record of this.sessions.values()) {
      if (!record.closed) {
        result.push({
          id: record.id,
          username: record.username,
          role: record.role,
          createdAt: record.createdAt,
          lastFrameAt: record.lastFrameAt,
        });
      }
    }
    return result;
  }
}
