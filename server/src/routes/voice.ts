import type { FastifyInstance } from 'fastify';
import { getVoiceEndpoints, runVoiceTurn, speakWithPiper, transcribeWithWhisper } from '../services/voice';
import { probeHermesConnection } from '../services/hermes';
import { getDirectWakewordState } from '../voice/direct-wakeword';
import { testMicCapture } from '../voice/mic';

export async function voiceRoutes(app: FastifyInstance) {
  app.get('/voice/status', async () => {
    const endpoints = getVoiceEndpoints();
    const hermesConnection = await probeHermesConnection({ hermesWsUrl: endpoints.hermesWsUrl }).catch((err: Error) => ({
      connected: false,
      wsUrl: endpoints.hermesWsUrl,
      error: err.message,
    }));
    return {
      ok: true,
      whisperUrl: endpoints.whisperUrl,
      piperUrl: endpoints.piperUrl,
      piperVoice: endpoints.piperVoice,
      hermesWsUrl: endpoints.hermesWsUrl,
      hermesConnected: hermesConnection.connected,
      hermesConnectionError: hermesConnection.error,
      directWakeword: getDirectWakewordState(),
    };
  });

  app.post('/voice/transcribe', async (req, reply) => {
    const multipartRequest = req as typeof req & {
      isMultipart?: () => boolean;
      file?: () => Promise<{ toBuffer(): Promise<Buffer>; filename: string; mimetype: string } | undefined>;
    };
    if (!multipartRequest.isMultipart?.()) {
      reply.code(400);
      return { ok: false, error: 'multipart audio upload is required' };
    }

    const part = await multipartRequest.file?.();
    if (!part) {
      reply.code(400);
      return { ok: false, error: 'audio file is required' };
    }

    const buffer = await part.toBuffer();
    const result = await transcribeWithWhisper({
      audio: buffer,
      filename: part.filename,
      contentType: part.mimetype,
      language: typeof req.query === 'object' && req.query && 'language' in req.query ? String((req.query as Record<string, unknown>).language ?? '') : undefined,
    });

    return { ok: true, ...result };
  });

  app.post('/voice/speak', async (req, reply) => {
    const body = req.body as { text?: string; voice?: string; payload?: Record<string, unknown> } | undefined;
    if (!body?.text?.trim() && !body?.payload) {
      reply.code(400);
      return { ok: false, error: 'text is required' };
    }

    const result = await speakWithPiper({
      text: body.text ?? '',
      voice: body.voice,
      payload: body.payload,
    });

    if (result.audioBase64) {
      return { ok: true, audioBase64: result.audioBase64, contentType: result.contentType };
    }

    return { ok: true, ...result };
  });

  app.post('/voice/mic-test', async (req, reply) => {
    const body = (req.body as { device?: string; duration_ms?: number } | undefined) ?? {};
    const device = typeof body.device === 'string' && body.device.trim() ? body.device.trim() : 'default';
    const durationMsRaw = typeof body.duration_ms === 'number' ? body.duration_ms : 1000;
    const durationMs = Math.max(250, Math.min(5000, Math.round(durationMsRaw)));

    const result = await testMicCapture(device, durationMs);
    if (!result.ok) {
      reply.code(400);
    }
    return result;
  });

  app.post('/voice/turn', async (req, reply) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (body?.audio_base64 && typeof body.audio_base64 === 'string') {
      const result = await runVoiceTurn({
        audio: Buffer.from(body.audio_base64, 'base64'),
        filename: typeof body.filename === 'string' ? body.filename : undefined,
        contentType: typeof body.content_type === 'string' ? body.content_type : undefined,
        language: typeof body.language === 'string' ? body.language : undefined,
        deviceId: typeof body.device_id === 'string' ? body.device_id : undefined,
        canvasAction: typeof body.canvas_action === 'string' ? body.canvas_action as any : undefined,
        canvasPanelId: typeof body.canvas_panel_id === 'string' ? body.canvas_panel_id : undefined,
        canvasUrl: typeof body.canvas_url === 'string' ? body.canvas_url : undefined,
        hermesWsUrl: typeof body.hermes_ws_url === 'string' ? body.hermes_ws_url : undefined,
        hermesWsToken: typeof body.hermes_ws_token === 'string' ? body.hermes_ws_token : undefined,
        canvasApiUrl: typeof body.canvas_api_url === 'string' ? body.canvas_api_url : undefined,
        timeoutMs: typeof body.timeout_ms === 'number' ? body.timeout_ms : undefined,
        whisperUrl: typeof body.whisper_url === 'string' ? body.whisper_url : undefined,
        piperUrl: typeof body.piper_url === 'string' ? body.piper_url : undefined,
        piperVoice: typeof body.piper_voice === 'string' ? body.piper_voice : undefined,
        speak: body.speak !== false,
      });
      return { ok: true, ...result };
    }

    if (!body?.text || typeof body.text !== 'string' || !body.text.trim()) {
      reply.code(400);
      return { ok: false, error: 'text or audio_base64 is required' };
    }

    const result = await runVoiceTurn({
      text: body.text,
      language: typeof body.language === 'string' ? body.language : undefined,
      deviceId: typeof body.device_id === 'string' ? body.device_id : undefined,
      canvasAction: typeof body.canvas_action === 'string' ? body.canvas_action as any : undefined,
      canvasPanelId: typeof body.canvas_panel_id === 'string' ? body.canvas_panel_id : undefined,
      canvasUrl: typeof body.canvas_url === 'string' ? body.canvas_url : undefined,
      hermesWsUrl: typeof body.hermes_ws_url === 'string' ? body.hermes_ws_url : undefined,
      hermesWsToken: typeof body.hermes_ws_token === 'string' ? body.hermes_ws_token : undefined,
      canvasApiUrl: typeof body.canvas_api_url === 'string' ? body.canvas_api_url : undefined,
      timeoutMs: typeof body.timeout_ms === 'number' ? body.timeout_ms : undefined,
      whisperUrl: typeof body.whisper_url === 'string' ? body.whisper_url : undefined,
      piperUrl: typeof body.piper_url === 'string' ? body.piper_url : undefined,
      piperVoice: typeof body.piper_voice === 'string' ? body.piper_voice : undefined,
      speak: body.speak !== false,
    });

    return { ok: true, ...result };
  });
}
