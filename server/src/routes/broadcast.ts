/**
 * Broadcast proxy route.
 *
 * The Broadcast widget runs in the display WebView and records via MediaRecorder.
 * It uploads here; this route forwards the clip to Core's authenticated
 * `/api/edge/broadcast`, which stores it and fans it out to every edge device
 * and every HA media_player entity.
 */
import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.js';

function getCoreBridge(): { baseUrl: string; token: string; deviceId: string } {
  try {
    const db = getDb();
    const get = (key: string) =>
      (db.prepare('SELECT value FROM server_settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? '';
    return {
      baseUrl: (get('canvas_core_url') || process.env.CANVAS_CORE_URL || '').replace(/\/+$/, ''),
      token: get('edge_voice_token') || process.env.CANVAS_EDGE_VOICE_TOKEN || '',
      deviceId: get('edge_device_id') || get('device_id') || process.env.CANVAS_EDGE_DEVICE_ID || 'unknown',
    };
  } catch {
    return {
      baseUrl: (process.env.CANVAS_CORE_URL || '').replace(/\/+$/, ''),
      token: process.env.CANVAS_EDGE_VOICE_TOKEN || '',
      deviceId: process.env.CANVAS_EDGE_DEVICE_ID ?? 'unknown',
    };
  }
}

export async function broadcastRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { audioBase64?: string; mimeType?: string; title?: string } }>(
    '/broadcast',
    async (req, reply) => {
      const { audioBase64, mimeType, title } = req.body ?? {};
      if (!audioBase64) return reply.code(400).send({ error: 'audioBase64 is required' });
      const { baseUrl, token, deviceId } = getCoreBridge();
      if (!baseUrl || !token) {
        return reply.code(503).send({ error: 'Core bridge is not configured (canvas_core_url / edge_voice_token)' });
      }
      try {
        const res = await fetch(`${baseUrl}/api/edge/broadcast`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ audioBase64, mimeType, title, from: deviceId }),
          signal: AbortSignal.timeout(30_000),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) return reply.code(res.status).send(body);
        return body;
      } catch (err) {
        return reply.code(502).send({
          error: `Broadcast failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  );
}
