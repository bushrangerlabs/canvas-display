import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { YOUTUBE_PLAYER_CSS, YOUTUBE_PLAYER_HTML, YOUTUBE_PLAYER_JS } from './assets.js';

export interface YouTubePrototypeSessionInput {
  videoIds: string[];
  playbackId?: string;
  ttlMs?: number;
}

export interface PlayerEvent {
  playback_id: string;
  event: string;
  video_id: string;
  candidate_index: number;
  candidate_count: number;
  error_code?: number;
  previous_error_code?: number;
}

interface SessionRecord {
  claimToken: string;
  eventToken?: string;
  claimed: boolean;
  expiresAt: number;
  playbackId: string;
  videoIds: string[];
  events: PlayerEvent[];
}

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const PLAYBACK_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const ALLOWED_EVENTS = new Set([
  'ready',
  'playing',
  'ended',
  'candidate_error',
  'candidate_switch',
  'exhausted',
  'identity_error',
  'player_error',
  'autoplay_blocked',
]);

export class ContentBridgePrototype {
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly now: () => number;
  private readonly sessions = new Map<string, SessionRecord>();
  private server?: Server;
  private activePort?: number;

  constructor(options: { host?: string; port?: number; now?: () => number } = {}) {
    this.host = options.host ?? '127.0.0.1';
    if (this.host !== '127.0.0.1') throw new Error('Content Bridge prototype must bind to 127.0.0.1');
    this.requestedPort = options.port ?? 0;
    this.now = options.now ?? Date.now;
  }

  get origin(): string {
    if (!this.activePort) throw new Error('Content Bridge prototype is not running');
    return `http://${this.host}:${this.activePort}`;
  }

  get address(): AddressInfo {
    const address = this.server?.address();
    if (!address || typeof address === 'string') throw new Error('Content Bridge prototype is not running');
    return address;
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer((request, response) => {
      void this.handleRequest(request, response).catch((error: unknown) => {
        console.error('[content-bridge-prototype] request failed:', error);
        if (!response.headersSent) this.sendJson(response, 500, { error: 'internal_error' });
        else response.destroy();
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.requestedPort, this.host, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
    this.activePort = this.address.port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.activePort = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  createYouTubeSession(input: YouTubePrototypeSessionInput): { sessionId: string; url: string } {
    if (!this.server) throw new Error('Content Bridge prototype must be started before creating a session');
    const videoIds = [...new Set(input.videoIds.filter((value) => VIDEO_ID_PATTERN.test(value)))].slice(0, 5);
    if (videoIds.length === 0) throw new Error('At least one valid YouTube video ID is required');

    const sessionId = randomBytes(24).toString('base64url');
    const claimToken = randomBytes(32).toString('base64url');
    const playbackId = input.playbackId && PLAYBACK_ID_PATTERN.test(input.playbackId)
      ? input.playbackId
      : randomUUID();
    this.sessions.set(sessionId, {
      claimToken,
      claimed: false,
      expiresAt: this.now() + (input.ttlMs ?? 10 * 60_000),
      playbackId,
      videoIds,
      events: [],
    });

    return {
      sessionId,
      url: `${this.origin}/v1/youtube/${encodeURIComponent(sessionId)}#claim=${encodeURIComponent(claimToken)}`,
    };
  }

  getSessionEvents(sessionId: string): readonly PlayerEvent[] {
    return this.sessions.get(sessionId)?.events ?? [];
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.isLoopbackPeer(request.socket.remoteAddress)) {
      this.sendJson(response, 403, { error: 'loopback_required' });
      return;
    }
    if (request.headers.host !== `${this.host}:${this.activePort}`) {
      this.sendJson(response, 421, { error: 'invalid_host' });
      return;
    }

    this.pruneExpiredSessions();
    const url = new URL(request.url ?? '/', this.origin);

    if (request.method === 'GET' && url.pathname === '/assets/youtube-player.css') {
      this.sendAsset(response, 'text/css; charset=utf-8', YOUTUBE_PLAYER_CSS);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/assets/youtube-player.js') {
      this.sendAsset(response, 'text/javascript; charset=utf-8', YOUTUBE_PLAYER_JS);
      return;
    }

    const match = /^\/v1\/youtube\/([A-Za-z0-9_-]{32})\/?(claim|events)?$/.exec(url.pathname);
    if (!match) {
      this.sendJson(response, 404, { error: 'not_found' });
      return;
    }

    const session = this.sessions.get(match[1]);
    if (!session || session.expiresAt <= this.now()) {
      this.sendJson(response, 404, { error: 'session_not_found' });
      return;
    }

    if (!match[2] && request.method === 'GET') {
      this.sendPlayer(response);
      return;
    }

    if (request.headers.origin !== this.origin) {
      this.sendJson(response, 403, { error: 'invalid_origin' });
      return;
    }

    if (match[2] === 'claim' && request.method === 'POST') {
      await this.readJsonBody(request);
      if (session.claimed) {
        this.sendJson(response, 409, { error: 'session_already_claimed' });
        return;
      }
      if (!this.hasBearer(request, session.claimToken)) {
        this.sendJson(response, 401, { error: 'invalid_claim' });
        return;
      }
      session.claimed = true;
      session.claimToken = '';
      session.eventToken = randomBytes(32).toString('base64url');
      this.sendJson(response, 200, {
        playback_id: session.playbackId,
        video_ids: session.videoIds,
        event_token: session.eventToken,
      });
      return;
    }

    if (match[2] === 'events' && request.method === 'POST') {
      if (!session.claimed || !session.eventToken || !this.hasBearer(request, session.eventToken)) {
        this.sendJson(response, 401, { error: 'invalid_event_token' });
        return;
      }
      const body = await this.readJsonBody(request) as Partial<PlayerEvent>;
      if (!this.isValidEvent(body, session)) {
        this.sendJson(response, 400, { error: 'invalid_player_event' });
        return;
      }
      session.events.push(body as PlayerEvent);
      this.sendJson(response, 200, { ok: true });
      return;
    }

    this.sendJson(response, 405, { error: 'method_not_allowed' });
  }

  private sendPlayer(response: ServerResponse): void {
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': [
        "default-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'self'",
        "script-src 'self' https://www.youtube.com https://s.ytimg.com",
        "style-src 'self'",
        "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
        "connect-src 'self' https://www.youtube.com",
        "img-src 'self' data: https://i.ytimg.com https://*.googleusercontent.com",
      ].join('; '),
      'Content-Type': 'text/html; charset=utf-8',
      'Permissions-Policy': 'autoplay=(self "https://www.youtube.com")',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(YOUTUBE_PLAYER_HTML);
  }

  private sendAsset(response: ServerResponse, contentType: string, body: string): void {
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': contentType,
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(body);
  }

  private sendJson(response: ServerResponse, status: number, body: object): void {
    response.writeHead(status, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(JSON.stringify(body));
  }

  private hasBearer(request: IncomingMessage, expected: string): boolean {
    const authorization = request.headers.authorization ?? '';
    const provided = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const providedBuffer = Buffer.from(provided);
    const expectedBuffer = Buffer.from(expected);
    return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
  }

  private async readJsonBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 8 * 1024) throw new Error('request body exceeds 8 KiB');
      chunks.push(buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) as unknown : {};
  }

  private isValidEvent(body: Partial<PlayerEvent>, session: SessionRecord): boolean {
    return body.playback_id === session.playbackId
      && typeof body.event === 'string'
      && ALLOWED_EVENTS.has(body.event)
      && typeof body.video_id === 'string'
      && Number.isInteger(body.candidate_index)
      && Number.isInteger(body.candidate_count)
      && body.candidate_count === session.videoIds.length
      && (body.candidate_index ?? -1) >= 0
      && (body.candidate_index ?? session.videoIds.length) < session.videoIds.length
      && session.videoIds[body.candidate_index ?? -1] === body.video_id;
  }

  private isLoopbackPeer(address: string | undefined): boolean {
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  }

  private pruneExpiredSessions(): void {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }
}
