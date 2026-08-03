import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index';

export interface HermesQueryOptions {
  hermesWsUrl?: string;
  hermesWsToken?: string;
  language?: string;
  timeoutMs?: number;
  conversationId?: string;
}

export interface HermesAssistResponse {
  type: 'assist_response';
  text: string;
  conversation_id: string;
  speech?: {
    plain?: {
      speech?: string;
      extra_data?: unknown;
    };
  };
  response_type?: string;
  [key: string]: unknown;
}

export interface HermesAssistResult {
  conversationId: string;
  text: string;
  speech: string;
  raw: HermesAssistResponse;
}

export interface HermesConnectionStatus {
  connected: boolean;
  wsUrl: string;
  error?: string;
}

export interface CanvasDeviceCommandOptions {
  canvasApiUrl?: string;
  deviceId: string;
  action: 'show_floating' | 'navigate_panel' | 'reload' | 'hide_floating';
  payload?: Record<string, unknown>;
}

interface HermesConnectionAttempt {
  wsUrl: string;
  headers: Record<string, string>;
}

interface OpenAIChatCompletionResponse {
  id?: string;
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}

const HERMES_WS_FAILURE_COOLDOWN_MS = 10 * 60 * 1000;
const wsSkipUntilByUrl = new Map<string, number>();

function normalizeHermesWsUrl(rawUrl?: string): string {
  const fallback = dbGet('hermes_ws_url', process.env.HERMES_WS_URL ?? process.env.HERMES_URL ?? 'http://127.0.0.1:7860');
  const value = (rawUrl ?? fallback).trim();
  if (!value) {
    return 'ws://127.0.0.1:7860/api/hermes/ws';
  }

  if (value.startsWith('ws://') || value.startsWith('wss://')) {
    return value.replace(/\/$/, '').replace(/\/(api\/hermes\/ws|ws)$/i, '/api/hermes/ws');
  }

  const base = value.replace(/\/$/, '').replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  if (base.endsWith('/api/hermes/ws')) return base;
  if (base.endsWith('/ws')) return `${base.replace(/\/ws$/, '')}/api/hermes/ws`;
  return `${base}/api/hermes/ws`;
}

function dbGet(key: string, fallback: string): string {
  try {
    const row = getDb().prepare('SELECT value FROM server_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? fallback;
  } catch {
    return fallback;
  }
}

function resolveHermesToken(token?: string): string {
  return (token ?? dbGet('hermes_ws_token', process.env.HERMES_WS_TOKEN ?? process.env.API_SERVER_KEY ?? process.env.HERMES_API_KEY ?? '')).trim();
}

function buildAuthHeaders(token?: string): Record<string, string> {
  const resolved = resolveHermesToken(token);
  if (!resolved) return {};
  return { Authorization: `Bearer ${resolved}` };
}

function withQueryParam(rawUrl: string, key: string, value: string): string {
  try {
    const u = new URL(rawUrl);
    u.searchParams.set(key, value);
    return u.toString();
  } catch {
    const joiner = rawUrl.includes('?') ? '&' : '?';
    return `${rawUrl}${joiner}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  }
}

function sanitizeWsUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.search = '';
    return u.toString();
  } catch {
    return rawUrl.split('?')[0] ?? rawUrl;
  }
}

function normalizeHermesApiBaseUrl(rawUrl?: string): string {
  const fallback = dbGet('hermes_ws_url', process.env.HERMES_WS_URL ?? process.env.HERMES_URL ?? 'http://127.0.0.1:7860');
  const value = (rawUrl ?? fallback).trim();
  if (!value) {
    return 'http://127.0.0.1:7860/v1';
  }

  const normalized = value
    .replace(/^ws:/i, 'http:')
    .replace(/^wss:/i, 'https:')
    .replace(/\/$/, '');

  if (normalized.endsWith('/v1')) return normalized;
  if (normalized.endsWith('/api/hermes/ws')) return normalized.replace(/\/api\/hermes\/ws$/, '/v1');
  if (normalized.endsWith('/ws')) return normalized.replace(/\/ws$/, '/v1');
  return `${normalized}/v1`;
}

function extractOpenAiMessageText(content: string | Array<{ type?: string; text?: string }> | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part?.type === 'text' || part?.type === 'output_text') ? (part.text ?? '') : '')
    .join('')
    .trim();
}

async function sendHermesApiServerQuery(
  text: string,
  options: HermesQueryOptions,
  conversationId: string,
): Promise<HermesAssistResult> {
  const baseUrl = normalizeHermesApiBaseUrl(options.hermesWsUrl);
  const url = `${baseUrl}/chat/completions`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...buildAuthHeaders(options.hermesWsToken),
  };

  console.log('[hermes] Trying HTTP API server fallback:', { url: baseUrl });

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'hermes-agent',
      messages: [{ role: 'user', content: text }],
    }),
  });

  const bodyText = await response.text();
  let parsed: OpenAIChatCompletionResponse | null = null;
  try {
    parsed = bodyText ? JSON.parse(bodyText) as OpenAIChatCompletionResponse : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    throw new Error(`Hermes API server request failed (${response.status}): ${bodyText}`);
  }

  const speech = extractOpenAiMessageText(parsed?.choices?.[0]?.message?.content);
  if (!speech) {
    throw new Error('Hermes API server response did not include assistant content');
  }

  return {
    conversationId: parsed?.id ?? conversationId,
    text: speech,
    speech,
    raw: {
      type: 'assist_response',
      text: speech,
      conversation_id: parsed?.id ?? conversationId,
      speech: { plain: { speech } },
      response_type: 'http_api_fallback',
    },
  };
}

function buildHermesConnectionAttempts(wsUrl: string, token?: string): HermesConnectionAttempt[] {
  const skipUntil = wsSkipUntilByUrl.get(sanitizeWsUrl(wsUrl)) ?? 0;
  if (skipUntil > Date.now()) {
    return [];
  }

  const resolvedToken = resolveHermesToken(token);
  const attempts: HermesConnectionAttempt[] = [
    { wsUrl, headers: buildAuthHeaders(token) },
  ];

  if (resolvedToken) {
    attempts.push(
      { wsUrl: withQueryParam(wsUrl, 'api_key', resolvedToken), headers: {} },
      { wsUrl: withQueryParam(wsUrl, 'token', resolvedToken), headers: {} },
      { wsUrl: withQueryParam(wsUrl, 'access_token', resolvedToken), headers: {} },
    );
  }

  const deduped = new Map<string, HermesConnectionAttempt>();
  for (const attempt of attempts) {
    const key = `${attempt.wsUrl}::${attempt.headers.Authorization ?? ''}`;
    if (!deduped.has(key)) {
      deduped.set(key, attempt);
    }
  }
  return Array.from(deduped.values());
}

export async function sendHermesAssistQuery(
  text: string,
  options: HermesQueryOptions = {},
): Promise<HermesAssistResult> {
  const conversationId = options.conversationId?.trim() || randomUUID();
  const wsUrl = normalizeHermesWsUrl(options.hermesWsUrl);
  const attempts = buildHermesConnectionAttempts(wsUrl, options.hermesWsToken);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const language = options.language ?? 'en';

  console.log('[hermes] Sending assist query:', { wsUrl: sanitizeWsUrl(wsUrl), conversationId, language, attempts: attempts.length });

  let lastError: unknown;
  for (const [index, attempt] of attempts.entries()) {
    try {
      return await new Promise<HermesAssistResult>((resolve, reject) => {
        const ws = new WebSocket(attempt.wsUrl, {
          headers: attempt.headers,
          rejectUnauthorized: false,
        });

        const cleanup = (): void => {
          clearTimeout(timeout);
          ws.removeAllListeners();
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            try {
              ws.close();
            } catch {
              // ignore close failures
            }
          }
        };

        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out waiting for Hermes response after ${timeoutMs}ms`));
        }, timeoutMs);

        ws.on('open', () => {
          if (index > 0) {
            console.log('[hermes] Connected using fallback auth strategy', { attempt: index + 1, wsUrl: sanitizeWsUrl(attempt.wsUrl) });
          } else {
            console.log('[hermes] WS connected, sending assist_query');
          }
          ws.send(JSON.stringify({
            type: 'assist_query',
            text,
            conversation_id: conversationId,
            language,
          }));
        });

        ws.on('message', (data) => {
          try {
            const message = JSON.parse(data.toString()) as Partial<HermesAssistResponse>;
            if (message.type !== 'assist_response' || message.conversation_id !== conversationId) {
              return;
            }

            const speech = message.speech?.plain?.speech ?? message.text ?? '';
            cleanup();
            console.log('[hermes] Received assist_response for conversation:', conversationId);
            resolve({
              conversationId,
              text: message.text ?? speech,
              speech,
              raw: message as HermesAssistResponse,
            });
          } catch (error) {
            cleanup();
            reject(error);
          }
        });

        ws.on('error', (error) => {
          cleanup();
          reject(error);
        });

        ws.on('close', () => {
          clearTimeout(timeout);
        });
      });
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.error('[hermes] WS error:', message);
      // Endpoint/path mismatch (404) is not an auth problem; skip extra WS retries.
      if (/404/.test(message)) {
        wsSkipUntilByUrl.set(sanitizeWsUrl(wsUrl), Date.now() + HERMES_WS_FAILURE_COOLDOWN_MS);
        console.warn('[hermes] Temporarily disabling WS attempts for endpoint after 404', {
          wsUrl: sanitizeWsUrl(wsUrl),
          cooldownMs: HERMES_WS_FAILURE_COOLDOWN_MS,
        });
        break;
      }
      const isForbidden = /403|401/i.test(message);
      if (!isForbidden || index === attempts.length - 1) {
        break;
      }
      console.warn('[hermes] Auth attempt failed, retrying with alternate auth strategy', { nextAttempt: index + 2 });
    }
  }

  try {
    return await sendHermesApiServerQuery(text, options, conversationId);
  } catch (httpError) {
    const message = httpError instanceof Error ? httpError.message : String(httpError);
    console.error('[hermes] HTTP API fallback failed:', message);
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Hermes connection failed'));
}

export async function probeHermesConnection(options: HermesQueryOptions = {}): Promise<HermesConnectionStatus> {
  const wsUrl = normalizeHermesWsUrl(options.hermesWsUrl);
  const attempts = buildHermesConnectionAttempts(wsUrl, options.hermesWsToken);
  const timeoutMs = options.timeoutMs ?? 5_000;

  let lastError = `Timed out after ${timeoutMs}ms`;
  for (const attempt of attempts) {
    const status = await new Promise<HermesConnectionStatus>((resolve) => {
      const ws = new WebSocket(attempt.wsUrl, {
        headers: attempt.headers,
        rejectUnauthorized: false,
      });

      let settled = false;
      const finish = (result: HermesConnectionStatus): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close();
          }
        } catch {
          // ignore
        }
        resolve(result);
      };

      const timeout = setTimeout(() => {
        finish({ connected: false, wsUrl: sanitizeWsUrl(attempt.wsUrl), error: `Timed out after ${timeoutMs}ms` });
      }, timeoutMs);

      ws.on('open', () => {
        finish({ connected: true, wsUrl: sanitizeWsUrl(attempt.wsUrl) });
      });

      ws.on('error', (error) => {
        finish({ connected: false, wsUrl: sanitizeWsUrl(attempt.wsUrl), error: (error as Error).message });
      });
    });

    if (status.connected) {
      return status;
    }
    lastError = status.error ?? lastError;
  }

  // Fallback probe for Hermes API server mode (HTTP bearer auth).
  try {
    const baseUrl = normalizeHermesApiBaseUrl(options.hermesWsUrl);
    const headers = buildAuthHeaders(options.hermesWsToken);
    const endpoints = [`${baseUrl}/health`, `${baseUrl.replace(/\/v1$/, '')}/health`];
    for (const endpoint of endpoints) {
      const response = await fetch(endpoint, { headers });
      if (response.ok) {
        return { connected: true, wsUrl: endpoint };
      }
    }
  } catch {
    // ignore and return ws probe failure
  }

  return { connected: false, wsUrl: sanitizeWsUrl(wsUrl), error: lastError };
}

export async function sendCanvasDeviceCommand(
  options: CanvasDeviceCommandOptions,
): Promise<unknown> {
  const baseUrl = (options.canvasApiUrl ?? dbGet('canvas_api_url', process.env.CANVAS_API_URL ?? 'http://127.0.0.1:3100')).trim().replace(/\/$/, '');
  const url = `${baseUrl}/api/devices/${encodeURIComponent(options.deviceId)}/command`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      action: options.action,
      payload: options.payload ?? {},
    }),
  });

  const bodyText = await response.text();
  let body: unknown = bodyText;
  try {
    body = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    // keep raw text if the response is not JSON
  }

  if (!response.ok) {
    throw new Error(`Canvas command failed (${response.status}): ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }

  return body;
}
