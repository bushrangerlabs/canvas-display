import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sendCanvasDeviceCommand, sendHermesAssistQuery } from '../services/hermes';
import { getDb } from '../db/index';

function dbGet(key: string, fallback: string): string {
  try {
    const row = getDb().prepare('SELECT value FROM server_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? fallback;
  } catch {
    return fallback;
  }
}

const assistQuerySchema = z.object({
  text: z.string().min(1),
  language: z.string().optional(),
  hermes_ws_url: z.string().optional(),
  hermes_ws_token: z.string().optional(),
  timeout_ms: z.number().int().positive().optional(),
});

const canvasCommandSchema = z.object({
  device_id: z.string().min(1),
  action: z.enum(['show_floating', 'navigate_panel', 'reload', 'hide_floating']),
  canvas_api_url: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

const hermesTurnSchema = z.object({
  text: z.string().min(1),
  language: z.string().optional(),
  hermes_ws_url: z.string().optional(),
  hermes_ws_token: z.string().optional(),
  timeout_ms: z.number().int().positive().optional(),
  canvas_api_url: z.string().optional(),
  device_id: z.string().optional(),
  canvas_action: z.enum(['show_floating', 'navigate_panel', 'reload', 'hide_floating']).optional(),
  canvas_panel_id: z.string().optional(),
  canvas_url: z.string().optional(),
});

export async function hermesRoutes(app: FastifyInstance) {
  app.get('/hermes/status', async () => {
    return {
      ok: true,
      hermesWsUrl: dbGet('hermes_ws_url', process.env.HERMES_WS_URL ?? process.env.HERMES_URL ?? 'http://127.0.0.1:7860'),
      canvasApiUrl: dbGet('canvas_api_url', process.env.CANVAS_API_URL ?? 'http://127.0.0.1:3100'),
    };
  });

  app.post('/hermes/query', async (req, reply) => {
    const parsed = assistQuerySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: parsed.error.flatten() };
    }

    const result = await sendHermesAssistQuery(parsed.data.text, {
      hermesWsUrl: parsed.data.hermes_ws_url,
      hermesWsToken: parsed.data.hermes_ws_token,
      language: parsed.data.language,
      timeoutMs: parsed.data.timeout_ms,
    });

    return { ok: true, ...result };
  });

  app.post('/hermes/turn', async (req, reply) => {
    const parsed = hermesTurnSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: parsed.error.flatten() };
    }

    const result = await sendHermesAssistQuery(parsed.data.text, {
      hermesWsUrl: parsed.data.hermes_ws_url,
      hermesWsToken: parsed.data.hermes_ws_token,
      language: parsed.data.language,
      timeoutMs: parsed.data.timeout_ms,
    });

    let canvasResult: unknown = null;
    if (parsed.data.device_id && parsed.data.canvas_action) {
      const payload: Record<string, unknown> = {};
      if (parsed.data.canvas_action === 'show_floating') {
        payload.url = parsed.data.canvas_url ?? result.speech ?? result.text;
      } else if (parsed.data.canvas_action === 'navigate_panel') {
        payload.url = parsed.data.canvas_url ?? result.speech ?? result.text;
        if (parsed.data.canvas_panel_id) {
          payload.panel_id = parsed.data.canvas_panel_id;
        }
      }

      canvasResult = await sendCanvasDeviceCommand({
        canvasApiUrl: parsed.data.canvas_api_url,
        deviceId: parsed.data.device_id,
        action: parsed.data.canvas_action,
        payload,
      });
    }

    return {
      ok: true,
      ...result,
      canvasResult,
    };
  });

  app.post('/hermes/device-command', async (req, reply) => {
    const parsed = canvasCommandSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: parsed.error.flatten() };
    }

    const result = await sendCanvasDeviceCommand({
      canvasApiUrl: parsed.data.canvas_api_url,
      deviceId: parsed.data.device_id,
      action: parsed.data.action,
      payload: parsed.data.payload,
    });

    return { ok: true, result };
  });
}
