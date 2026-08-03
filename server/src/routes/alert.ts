/**
 * Alert / Announcement API
 *
 * Stores the current timed alert pushed by Canvas Core or an automation.
 * The AnnouncementWidget polls GET /api/alert/current to display it.
 *
 * POST /api/alert          — Push a new alert (replaces current)
 * DELETE /api/alert        — Clear the current alert
 * GET /api/alert/current   — Widget polls for the active alert
 */

import type { FastifyInstance } from 'fastify';

export interface Alert {
  title: string;
  message: string;
  type: 'info' | 'warning' | 'danger' | 'success';
  icon?: string;
  /** Seconds until auto-dismiss (0 = never) */
  duration?: number;
  timestamp: string;
}

let currentAlert: Alert | null = null;

export async function alertRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/alert/current', async (_req, reply) => {
    if (!currentAlert) return reply.send({ empty: true });
    return reply.send(currentAlert);
  });

  fastify.post<{ Body: Partial<Alert> }>('/alert', async (req, reply) => {
    const { title, message, type, icon, duration } = req.body ?? {};
    if (!title || !message) {
      return reply.code(400).send({ error: 'title and message are required' });
    }
    currentAlert = {
      title,
      message,
      type: (type as Alert['type']) || 'info',
      icon,
      duration: duration ?? 10,
      timestamp: new Date().toISOString(),
    };
    // Auto-clear after duration if non-zero
    if (currentAlert.duration && currentAlert.duration > 0) {
      const snapshot = currentAlert.timestamp;
      setTimeout(() => {
        if (currentAlert?.timestamp === snapshot) currentAlert = null;
      }, currentAlert.duration * 1000);
    }
    return reply.send({ ok: true, timestamp: currentAlert.timestamp });
  });

  fastify.delete('/alert', async (_req, reply) => {
    currentAlert = null;
    return reply.send({ ok: true });
  });
}
