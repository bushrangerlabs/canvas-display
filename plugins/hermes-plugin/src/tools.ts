import { z } from 'zod';

const toolNameSchema = z.enum([
  'web_search_to_url',
  'youtube_search_to_url',
  'canvas_set_page',
  'canvas_navigate_panel',
  'canvas_media_play',
  'canvas_media_control',
]);

const executeSchema = z.object({
  tool: toolNameSchema,
  input: z.record(z.unknown()).default({}),
});

export type ToolName = z.infer<typeof toolNameSchema>;
export type ExecuteRequest = z.infer<typeof executeSchema>;

interface ToolResult {
  ok: boolean;
  tool: ToolName;
  result?: Record<string, unknown>;
  error?: string;
}

const canvasApiUrl = (process.env.CANVAS_API_URL ?? 'http://127.0.0.1:3100').replace(/\/$/, '');

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function looksLikeWebUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return ['http:', 'https:'].includes(u.protocol);
  } catch {
    return false;
  }
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

const mediaSourceSchema = z.enum([
  'music_assistant',
  'radio_browser',
  'direct_audio',
  'youtube',
]);

const mediaActionSchema = z.enum(['pause', 'resume', 'stop', 'volume', 'mute']);

async function resolveWebQueryToUrl(query: string): Promise<string> {
  const trimmed = query.trim();
  if (!trimmed) return '';

  const searchEndpoints = [
    `https://duckduckgo.com/html/?q=${encodeURIComponent(trimmed)}`,
    `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(trimmed)}`,
  ];

  for (const endpoint of searchEndpoints) {
    try {
      const response = await fetch(endpoint, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) CanvasDisplay-HermesPlugin/1.0',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (!response.ok) continue;
      const html = await response.text();
      const linkPattern = new RegExp('href="([^"]*(?:uddg=|https?:\\/\\/)[^"]+)"', 'gi');
      const redirectMatches = Array.from(html.matchAll(linkPattern));

      for (const match of redirectMatches) {
        const href = decodeHtmlEntities(match[1] ?? '');
        if (!href) continue;

        if (href.includes('uddg=')) {
          try {
            const parsedHref = new URL(href, endpoint);
            const uddg = parsedHref.searchParams.get('uddg');
            if (uddg && looksLikeWebUrl(uddg)) return uddg;
          } catch {
            // ignore malformed redirect links
          }
        }

        if (looksLikeWebUrl(href)) return href;
      }
    } catch {
      // try next endpoint
    }
  }

  return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
}

async function callCanvas(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${canvasApiUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`Canvas API ${path} failed (${response.status}): ${text}`);
  }

  return (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : { value: parsed };
}

export function getToolManifest(): Array<Record<string, unknown>> {
  return [
    {
      name: 'web_search_to_url',
      description: 'Resolve a web query to a reliable URL with search fallback.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      },
    },
    {
      name: 'youtube_search_to_url',
      description: 'Create a YouTube search URL from query text.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      },
    },
    {
      name: 'canvas_set_page',
      description: 'Set active Canvas page by page_id or page name.',
      inputSchema: {
        type: 'object',
        properties: {
          page_id: { type: 'string' },
          page: { type: 'string' },
        },
      },
    },
    {
      name: 'canvas_navigate_panel',
      description: 'Navigate a Canvas panel to a URL by panel_id or panel name.',
      inputSchema: {
        type: 'object',
        properties: {
          panel_id: { type: 'string' },
          panel: { type: 'string' },
          page_id: { type: 'string' },
          page: { type: 'string' },
          url: { type: 'string' },
        },
        required: ['url'],
      },
    },
    {
      name: 'canvas_media_play',
      description: 'Play media via Canvas unified media API.',
      inputSchema: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            enum: ['music_assistant', 'radio_browser', 'direct_audio', 'youtube'],
          },
          url: { type: 'string' },
          title: { type: 'string' },
          volume: { type: 'number' },
          panel_id: { type: 'string' },
        },
        required: ['source', 'url'],
      },
    },
    {
      name: 'canvas_media_control',
      description: 'Control media playback via Canvas unified media API.',
      inputSchema: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            enum: ['music_assistant', 'radio_browser', 'direct_audio', 'youtube'],
          },
          action: {
            type: 'string',
            enum: ['pause', 'resume', 'stop', 'volume', 'mute'],
          },
          level: { type: 'number' },
          muted: { type: 'boolean' },
        },
        required: ['source', 'action'],
      },
    },
  ];
}

export async function executeTool(raw: unknown): Promise<ToolResult> {
  const parsed = executeSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      tool: 'web_search_to_url',
      error: parsed.error.flatten().formErrors.join('; ') || 'Invalid execute payload',
    };
  }

  const { tool, input } = parsed.data;

  try {
    if (tool === 'web_search_to_url') {
      const query = String(input.query ?? '').trim();
      if (!query) throw new Error('query is required');
      const url = await resolveWebQueryToUrl(query);
      return { ok: true, tool, result: { query, url } };
    }

    if (tool === 'youtube_search_to_url') {
      const query = String(input.query ?? '').trim();
      if (!query) throw new Error('query is required');
      const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
      return { ok: true, tool, result: { query, url } };
    }

    if (tool === 'canvas_set_page') {
      const page_id = typeof input.page_id === 'string' ? input.page_id.trim() : '';
      const page = typeof input.page === 'string' ? input.page.trim() : '';
      if (!page_id && !page) throw new Error('page_id or page is required');
      const result = await callCanvas('/api/commands/page', {
        ...(page_id ? { page_id } : {}),
        ...(page ? { page } : {}),
      });
      return { ok: true, tool, result };
    }

    if (tool === 'canvas_navigate_panel') {
      const panel_id = typeof input.panel_id === 'string' ? input.panel_id.trim() : '';
      const panel = typeof input.panel === 'string' ? input.panel.trim() : '';
      const page_id = typeof input.page_id === 'string' ? input.page_id.trim() : '';
      const page = typeof input.page === 'string' ? input.page.trim() : '';
      const rawUrl = typeof input.url === 'string' ? input.url.trim() : '';
      if (!rawUrl) throw new Error('url is required');
      const url = normalizeUrl(rawUrl);
      const result = await callCanvas('/api/commands/navigate', {
        ...(panel_id ? { panel_id } : {}),
        ...(panel ? { panel } : {}),
        ...(page_id ? { page_id } : {}),
        ...(page ? { page } : {}),
        url,
      });
      return { ok: true, tool, result: { ...result, url } };
    }

    if (tool === 'canvas_media_play') {
      const source = mediaSourceSchema.parse(String(input.source ?? '').trim());
      const rawUrl = String(input.url ?? '').trim();
      if (!rawUrl) throw new Error('url is required');

      const title = typeof input.title === 'string' ? input.title.trim() : '';
      const panel_id = typeof input.panel_id === 'string' ? input.panel_id.trim() : '';
      const volume = typeof input.volume === 'number' ? input.volume : undefined;

      const result = await callCanvas('/api/media/play', {
        source,
        url: source === 'youtube' ? rawUrl : normalizeUrl(rawUrl),
        ...(title ? { title } : {}),
        ...(panel_id ? { panel_id } : {}),
        ...(volume !== undefined ? { volume } : {}),
      });

      return { ok: true, tool, result };
    }

    if (tool === 'canvas_media_control') {
      const source = mediaSourceSchema.parse(String(input.source ?? '').trim());
      const action = mediaActionSchema.parse(String(input.action ?? '').trim());

      const payload: Record<string, unknown> = { source, action };
      if (typeof input.level === 'number') payload.level = input.level;
      if (typeof input.muted === 'boolean') payload.muted = input.muted;

      const result = await callCanvas('/api/media/control', payload);
      return { ok: true, tool, result };
    }

    return { ok: false, tool, error: `Unsupported tool: ${tool}` };
  } catch (err) {
    return { ok: false, tool, error: (err as Error).message };
  }
}
