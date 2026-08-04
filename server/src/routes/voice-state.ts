/**
 * Voice state API — exposes current voice turn state to the display browser
 * so an overlay can show listening/processing/done/error indicators and
 * collect 👍/👎 feedback from the user.
 *
 *   GET  /api/voice/state            → VoiceDisplayState
 *   POST /api/voice/feedback         { turnId, rating: 1|-1 }  → forwards to Core
 */

import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.js';

function getSetting(key: string): string | null {
  try {
    const db = getDb();
    const row = db.prepare('SELECT value FROM server_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type VoiceDisplayStatus = 'idle' | 'listening' | 'processing' | 'done' | 'error';

export interface VoiceDisplayState {
  status:      VoiceDisplayStatus;
  turnId?:     string;
  transcript?: string;
  reply?:      string;
  error?:      string;
  show_url?:   string;
  updatedAt:   string;
}

// ─── In-memory state ──────────────────────────────────────────────────────────

let _state: VoiceDisplayState = { status: 'idle', updatedAt: new Date().toISOString() };

let _idleTimer: NodeJS.Timeout | null = null;
let _errorTimer: NodeJS.Timeout | null = null;

function scheduleIdle(delayMs: number) {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => {
    _state = { status: 'idle', updatedAt: new Date().toISOString() };
    _idleTimer = null;
  }, delayMs);
}

// ─── Server-side mutators (called from direct-wakeword.ts) ────────────────────

export function setVoiceStateListening() {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  if (_errorTimer) { clearTimeout(_errorTimer); _errorTimer = null; }
  _state = { status: 'listening', updatedAt: new Date().toISOString() };
}

export function setVoiceStateProcessing(turnId: string) {
  _state = { status: 'processing', turnId, updatedAt: new Date().toISOString() };
}

export function setVoiceStateDone(turnId: string, transcript: string, reply: string, show_url?: string) {
  _state = { status: 'done', turnId, transcript, reply, show_url, updatedAt: new Date().toISOString() };
  // Auto-return to idle after 12s (user has time to tap feedback)
  scheduleIdle(12_000);
}

export function setVoiceStateError(error: string) {
  _state = { status: 'error', error, updatedAt: new Date().toISOString() };
  // Clear error after 6s
  if (_errorTimer) clearTimeout(_errorTimer);
  _errorTimer = setTimeout(() => {
    _state = { status: 'idle', updatedAt: new Date().toISOString() };
    _errorTimer = null;
  }, 6_000);
}

export function getVoiceDisplayState(): VoiceDisplayState {
  return { ..._state };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function voiceStateRoutes(app: FastifyInstance) {

  // GET /api/voice/state
  app.get('/voice/state', async () => {
    return _state;
  });

  // POST /api/voice/feedback — user rated the last voice turn
  app.post<{ Body: { turnId?: string; rating?: number } }>(
    '/voice/feedback',
    async (req, reply) => {
      const { turnId, rating } = req.body ?? {};
      if (!turnId || (rating !== 1 && rating !== -1)) {
        reply.code(400);
        return { error: 'Provide turnId and rating (1 or -1)' };
      }

      // Forward to Core
      try {
        const coreUrl = (getSetting('canvas_core_url') ?? process.env.CANVAS_CORE_URL ?? '').replace(/\/+$/, '');
        const coreToken = getSetting('edge_voice_token') ?? process.env.CANVAS_EDGE_VOICE_TOKEN ?? '';
        const deviceId = getSetting('device_id') ?? 'local';
        if (coreUrl && coreToken) {
          await fetch(`${coreUrl}/api/voice/feedback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${coreToken}` },
            body: JSON.stringify({ turnId, deviceId, rating }),
          });
        }
      } catch (err) {
        console.warn('[voice-state] Failed to forward feedback to Core:', (err as Error).message);
      }

      return { ok: true };
    },
  );
}
