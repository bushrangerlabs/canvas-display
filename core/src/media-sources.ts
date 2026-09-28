/**
 * DAB+ (SDR radio) and Dispatcharr (IPTV) media sources.
 *
 * Backs the DAB+ / Dispatcharr editor widgets and the voice media tools:
 *   • DAB+      — station list from the SDR REST API; tuning + Icecast stream.
 *   • Dispatcharr — IPTV channel list from the HDHomeRun lineup; direct stream URL.
 *
 * The list endpoints can hold tens of thousands of channels, so results are cached
 * briefly. This keeps the widgets' polling and next/previous stepping from
 * re-fetching the full lineup on every request.
 *
 * This module is transport-agnostic: it resolves *what* to play (title + stream
 * URL). The caller (legacy-routes) owns the audio state and dispatch.
 */

export interface DabStation {
  id?: string;
  name?: string;
  city?: string;
  image_url?: string;
  module?: string;
}

export interface DispatcharrChannel {
  number?: string;
  name?: string;
  url?: string;
  logo?: string;
}

const LIST_CACHE_TTL_MS = 10_000;

interface CacheEntry<T> {
  at: number;
  data: T;
}

const dabCache = new Map<string, CacheEntry<DabStation[]>>();
let dispatcharrCache: CacheEntry<DispatcharrChannel[]> | null = null;

/** Drop cached lists so a settings change takes effect immediately. */
export function clearMediaCaches(): void {
  dabCache.clear();
  dispatcharrCache = null;
}

function trimBase(url: string): string {
  return url.replace(/\/+$/, '');
}

async function fetchJson(url: string, timeoutMs = 8000, headers?: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Fetch the DAB+ station list from the SDR REST API (`/api/stations`). */
export async function fetchDabStations(base: string): Promise<DabStation[]> {
  const now = Date.now();
  const key = trimBase(base);
  const cached = dabCache.get(key);
  if (cached && now - cached.at < LIST_CACHE_TTL_MS) return cached.data;
  const data = (await fetchJson(`${key}/api/stations`)) as { dab?: DabStation[] } | DabStation[];
  const stations = Array.isArray(data) ? data.filter((station) => station?.id && station?.name)
    : Array.isArray(data?.dab) ? data.dab : [];
  dabCache.set(key, { at: now, data: stations });
  return stations;
}

/** Fetch the Dispatcharr channel lineup (`/api/hdhr/lineup.json`). */
export async function fetchDispatcharrChannels(base: string, apiKey?: string): Promise<DispatcharrChannel[]> {
  const now = Date.now();
  if (dispatcharrCache && now - dispatcharrCache.at < LIST_CACHE_TTL_MS) return dispatcharrCache.data;
  const headers = apiKey ? { 'X-API-Key': apiKey } : undefined;
  const raw = (await fetchJson(`${trimBase(base)}/api/hdhr/lineup.json`, 8000, headers)) as Array<{
    GuideNumber?: string;
    GuideName?: string;
    URL?: string;
  }>;
  const channels: DispatcharrChannel[] = Array.isArray(raw)
    ? raw.map((entry) => ({ number: entry.GuideNumber, name: entry.GuideName, url: entry.URL }))
    : [];
  if (apiKey && channels.length > 0) {
    try {
      const summary = (await fetchJson(
        `${trimBase(base)}/api/channels/channels/summary/`,
        8000,
        headers,
      )) as Array<{ name?: string; channel_number?: string | number; logo_id?: string | number }>;
      const logos = new Map<string, string>();
      for (const entry of Array.isArray(summary) ? summary : []) {
        if (entry.logo_id == null) continue;
        const number = entry.channel_number == null ? '' : String(entry.channel_number);
        logos.set(`${number}\n${entry.name ?? ''}`.toLowerCase(), String(entry.logo_id));
        if (entry.name) logos.set(`\n${entry.name}`.toLowerCase(), String(entry.logo_id));
      }
      for (const channel of channels) {
        const logoId = logos.get(`${channel.number ?? ''}\n${channel.name ?? ''}`.toLowerCase())
          ?? logos.get(`\n${channel.name ?? ''}`.toLowerCase());
        if (logoId) channel.logo = `/api/dispatcharr/logos/${encodeURIComponent(logoId)}`;
      }
    } catch {
      // The public lineup remains useful when the authenticated summary is unavailable.
    }
  }
  dispatcharrCache = { at: now, data: channels };
  return channels;
}

/**
 * Tune a DAB+ station on the SDR tuner. Returns the tuned station name (as
 * reported by the tuner, falling back to the requested name).
 */
export async function tuneDabStation(base: string, tuner: string, station: string, streamUrl?: string): Promise<string> {
  const res = await fetch(`${trimBase(base)}/api/tuners/${encodeURIComponent(tuner)}/play`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ station: station.includes(':') ? station : `dab:${station}` }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(detail || `SDR tune failed: HTTP ${res.status}`);
  }
  const tuned = (await res.json().catch(() => ({}))) as { station_name?: string; state?: string };
  if (tuned.state === 'starting') await waitForTunerReady(base, tuner);
  if (streamUrl) await waitForStreamReady(streamUrl);
  return tuned.station_name ?? station;
}

/** Wait for the SDR worker to finish replacing the previous station pipeline. */
export async function waitForTunerReady(base: string, tuner: string, timeoutMs = 20_000, retryMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastState = 'starting';
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    try {
      const res = await fetch(`${trimBase(base)}/api/tuners/${encodeURIComponent(tuner)}/status`, {
        signal: AbortSignal.timeout(Math.min(4_000, remaining)),
      });
      if (res.ok) {
        const status = (await res.json().catch(() => ({}))) as { state?: string; error?: string };
        lastState = status.state ?? lastState;
        if (status.state === 'playing') return;
        if (status.state === 'error') throw new Error(status.error || 'SDR playback pipeline failed');
      }
    } catch (error) {
      if (error instanceof Error && error.message !== 'The operation was aborted due to timeout') {
        if (/SDR playback pipeline failed|playback pipeline/.test(error.message)) throw error;
      }
    }
    const remainingAfterRequest = deadline - Date.now();
    if (remainingAfterRequest > 0) await new Promise(resolve => setTimeout(resolve, Math.min(retryMs, remainingAfterRequest)));
  }
  throw new Error(`SDR tuner did not become ready (last state: ${lastState})`);
}

/** Wait for a newly tuned Icecast mount before dispatching it to one-shot players. */
export async function waitForStreamReady(url: string, timeoutMs = 20_000, retryMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: number | undefined;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const remaining = Math.max(1, deadline - Date.now());
      const res = await fetch(url, {
        headers: { range: 'bytes=0-0', 'icy-metadata': '0' },
        signal: AbortSignal.timeout(Math.min(4_000, remaining)),
      });
      lastStatus = res.status;
      await res.body?.cancel().catch(() => undefined);
      if (res.ok) return;
    } catch (error) {
      lastError = error;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(retryMs, remaining)));
  }
  const detail = lastStatus ? `HTTP ${lastStatus}` : lastError instanceof Error ? lastError.message : 'unreachable';
  throw new Error(`SDR stream did not become ready: ${detail}`);
}

/**
 * Resolve a Dispatcharr channel to a playable stream URL. When the caller already
 * has the URL (the widget passes it through) it is used directly; otherwise the
 * channel is matched against the lineup by exact name, then substring.
 */
export function resolveDispatcharrChannel(
  channels: DispatcharrChannel[],
  name: string,
  url?: string,
): { name: string; url: string } {
  let streamUrl = (url ?? '').trim();
  if (!streamUrl) {
    if (!name) throw new Error('channel or url is required');
    const needle = name.toLowerCase();
    const match =
      channels.find((channel) => (channel.name ?? '').toLowerCase() === needle) ??
      channels.find((channel) => (channel.name ?? '').toLowerCase().includes(needle));
    if (!match?.url) throw new Error(`Channel "${name}" not found`);
    streamUrl = match.url;
  }
  return { name: name || streamUrl, url: streamUrl };
}

/**
 * Resolve the next/previous item index for a list, wrapping around. The current
 * item is matched against the playing title (exact, then substring). When nothing
 * is playing, "next" starts at the top and "previous" at the bottom.
 */
export function stepTargetIndex(items: { name: string }[], currentTitle: string, direction: 1 | -1): number {
  if (items.length === 0) throw new Error('No items available');
  const current = currentTitle.trim().toLowerCase();
  let index = current ? items.findIndex((item) => item.name.trim().toLowerCase() === current) : -1;
  if (index === -1 && current) {
    index = items.findIndex((item) => {
      const name = item.name.trim().toLowerCase();
      return name.includes(current) || current.includes(name);
    });
  }
  return index === -1 ? (direction === 1 ? 0 : items.length - 1) : (index + direction + items.length) % items.length;
}
