/**
 * Shared media-source helpers for the DAB+ and Dispatcharr widget families.
 *
 * Both sources expose the same shape: a polled list of playable items plus the
 * device-wide audio state (title / state / volume / muted) from /api/media/state.
 * Keeping the polling and control logic here lets the individual widgets stay
 * thin and behave identically.
 */

import { useCallback, useEffect, useState } from 'react';

export type MediaKind = 'dab' | 'dispatcharr';

export interface MediaItem {
  id: string;
  name: string;
  subtitle?: string;
  url?: string;
  logo?: string;
}

export interface MediaAudioState {
  state: 'idle' | 'playing' | 'paused';
  title: string;
  url: string;
  volume: number; // 0–100
  muted: boolean;
  artwork?: string;
}

export const EMPTY_AUDIO: MediaAudioState = {
  state: 'idle',
  title: '',
  url: '',
  volume: 75,
  muted: false,
};

// Trusted-local-client bearer token (VITE_CORE_AUTOMATION_TOKEN). Core's
// requireAdmin accepts it so a display device can drive media playback without a
// browser session/CSRF — see core/src/auth.ts.
const CORE_TOKEN = (import.meta.env as { VITE_CORE_AUTOMATION_TOKEN?: string }).VITE_CORE_AUTOMATION_TOKEN;

/** Auth header for Core mutations when the display has no session cookie. */
function authHeaders(): Record<string, string> {
  return CORE_TOKEN ? { Authorization: `Bearer ${CORE_TOKEN}` } : {};
}

/**
 * The display this page is running on, injected by the kiosk as a `deviceId`
 * query parameter on the scene URL. When present, media play/control requests
 * target this one device instead of broadcasting to every display.
 */
export function targetDeviceId(): string | undefined {
  try {
    const id = new URLSearchParams(window.location.search).get('deviceId');
    if (id?.trim()) return id.trim();
    const injected = (window as Window & { __CANVAS_DEVICE_ID__?: string }).__CANVAS_DEVICE_ID__;
    return injected?.trim() || undefined;
  } catch {
    return undefined;
  }
}

interface SourceConfig {
  label: string;
  listUrl: string;
  listKey: string;
  playUrl: string;
  buildPlayBody: (item: MediaItem) => Record<string, unknown>;
  buildPlayBodyByName: (name: string) => Record<string, unknown>;
  normalize: (raw: any) => MediaItem;
}

const SOURCES: Record<MediaKind, SourceConfig> = {
  dab: {
    label: 'DAB+',
    listUrl: '/api/dab/stations',
    listKey: 'stations',
    playUrl: '/api/dab/play',
    buildPlayBody: (item) => ({ station: item.id }),
    buildPlayBodyByName: (name) => ({ station: name }),
    normalize: (raw) => ({
      id: String(raw?.id ?? raw?.name ?? ''),
      name: String(raw?.name ?? raw?.id ?? ''),
      subtitle: raw?.city ? String(raw.city) : undefined,
      logo: raw?.image_url ? String(raw.image_url) : undefined,
    }),
  },
  dispatcharr: {
    label: 'Dispatcharr',
    listUrl: '/api/dispatcharr/channels',
    listKey: 'channels',
    playUrl: '/api/dispatcharr/play',
    buildPlayBody: (item) => ({ channel: item.name, url: item.url }),
    buildPlayBodyByName: (name) => ({ channel: name }),
    normalize: (raw) => ({
      id: `${raw?.number ?? ''}-${raw?.name ?? ''}`,
      name: String(raw?.name ?? ''),
      subtitle: raw?.number ? String(raw.number) : undefined,
      url: raw?.url ? String(raw.url) : undefined,
      logo: raw?.logo ? String(raw.logo) : undefined,
    }),
  },
};

export function sourceLabel(kind: MediaKind): string {
  return SOURCES[kind].label;
}

/** Default accent colour used when a widget has no explicit accent. */
export function defaultAccent(kind: MediaKind): string {
  return kind === 'dab' ? '#4493f8' : '#39d353';
}

export function defaultPollSeconds(kind: MediaKind): number {
  return kind === 'dab' ? 5 : 10;
}

async function postJson(url: string, body?: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { ...authHeaders(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: detail.error ?? `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Play helpers for a source — no list polling. */
export function useMediaPlay(kind: MediaKind) {
  const [error, setError] = useState('');

  const play = useCallback(
    async (item: MediaItem) => {
      setError('');
      const controllerDeviceId = targetDeviceId();
      const result = await postJson(SOURCES[kind].playUrl, { ...SOURCES[kind].buildPlayBody(item), ...(controllerDeviceId ? { controllerDeviceId } : {}) });
      if (!result.ok) setError(result.error ?? 'Playback failed');
      else window.dispatchEvent(new Event('canvas:media-state-changed'));
      return result.ok;
    },
    [kind],
  );

  const playByName = useCallback(
    async (name: string) => {
      setError('');
      const controllerDeviceId = targetDeviceId();
      const result = await postJson(SOURCES[kind].playUrl, { ...SOURCES[kind].buildPlayBodyByName(name), ...(controllerDeviceId ? { controllerDeviceId } : {}) });
      if (!result.ok) setError(result.error ?? 'Playback failed');
      else window.dispatchEvent(new Event('canvas:media-state-changed'));
      return result.ok;
    },
    [kind],
  );

  return { error, play, playByName };
}

/**
 * Find the index of the item that is currently playing by matching its name
 * against the audio title. Falls back to a case-insensitive substring match so
 * minor differences (e.g. "BBC Radio 1" vs "BBC Radio 1 ") still resolve.
 * Returns -1 when nothing matches.
 */
export function findCurrentIndex(items: MediaItem[], title: string): number {
  const needle = (title ?? '').trim().toLowerCase();
  if (!needle) return -1;
  const exact = items.findIndex((item) => item.name.trim().toLowerCase() === needle);
  if (exact !== -1) return exact;
  return items.findIndex((item) => {
    const name = item.name.trim().toLowerCase();
    return name.includes(needle) || needle.includes(name);
  });
}

/**
 * Resolve the next/previous item index, wrapping around the list. When nothing
 * is currently playing, "next" starts at the top and "previous" at the bottom.
 * Returns -1 for an empty list.
 */
export function stepTargetIndex(items: MediaItem[], currentIndex: number, direction: 1 | -1): number {
  if (items.length === 0) return -1;
  if (currentIndex === -1) return direction === 1 ? 0 : items.length - 1;
  return (currentIndex + direction + items.length) % items.length;
}

/**
 * Poll the playable item list for a source and expose play helpers.
 * Pass `enabled = false` to skip polling entirely (e.g. when a widget does not
 * need the list, such as the volume-only widgets).
 */
export function useMediaItems(
  kind: MediaKind,
  pollMs: number,
  enabled = true,
  options: { search?: string; limit?: number } = {},
) {
  const [items, setItems] = useState<MediaItem[]>([]);
  const search = (options.search ?? '').trim();
  const limit = options.limit;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const cfg = SOURCES[kind];
    // The Dispatcharr lineup can hold tens of thousands of channels, so the
    // filter and visible-item cap are pushed to the server to keep the polled
    // payload small.
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (limit && limit > 0) params.set('limit', String(limit));
    const url = params.toString() ? `${cfg.listUrl}?${params.toString()}` : cfg.listUrl;
    const load = async () => {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as Record<string, unknown>;
        const list = Array.isArray(data?.[cfg.listKey]) ? (data[cfg.listKey] as unknown[]) : [];
        if (!cancelled) setItems(list.map(cfg.normalize));
      } catch {
        /* transient — keep the last good list */
      }
    };
    void load();
    const id = window.setInterval(load, pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [kind, pollMs, enabled, search, limit]);

  const { error, play, playByName } = useMediaPlay(kind);

  return { items, error, play, playByName };
}

/** Poll the device-wide audio state and expose transport / volume helpers. */
export function useMediaAudio(pollMs: number, enabled = true) {
  const [audio, setAudio] = useState<MediaAudioState>(EMPTY_AUDIO);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/media/state', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { audio?: Partial<MediaAudioState> };
        if (cancelled || !data.audio) return;
        setAudio({
          state: (data.audio.state as MediaAudioState['state']) ?? 'idle',
          title: data.audio.title ?? '',
          url: data.audio.url ?? '',
          volume: typeof data.audio.volume === 'number' ? data.audio.volume : 75,
          muted: !!data.audio.muted,
          artwork: data.audio.artwork,
        });
      } catch {
        /* ignore */
      }
    };
    void poll();
    const id = window.setInterval(poll, pollMs);
    window.addEventListener('canvas:media-state-changed', poll);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener('canvas:media-state-changed', poll);
    };
  }, [pollMs, enabled]);

  const run = useCallback(async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    const result = await fn();
    setError(result.ok ? '' : result.error ?? 'Command failed');
    if (result.ok) window.dispatchEvent(new Event('canvas:media-state-changed'));
    return result.ok;
  }, []);

  // Every transport / volume command goes through the device-targeted
  // /api/media/control route. When this page was opened with a `deviceId`
  // (the kiosk injects one), the command is dispatched to that one display's
  // local server; without one it falls back to a broadcast, matching the old
  // /api/audio/* behaviour. This keeps a wall panel's controls from moving
  // every other display in the house.
  const control = useCallback(
    (action: string, extra: Record<string, unknown> = {}) => {
      const controllerDeviceId = targetDeviceId();
      return run(() => postJson('/api/media/control', { action, ...(controllerDeviceId ? { controllerDeviceId } : {}), ...extra }));
    },
    [run],
  );

  const pause = useCallback(() => control('pause'), [control]);
  const resume = useCallback(() => control('resume'), [control]);
  const stop = useCallback(() => control('stop'), [control]);
  const setMuted = useCallback((muted: boolean) => control('mute', { muted }), [control]);
  const setVolume = useCallback((level: number) => control('volume', { level: Math.round(level) }), [control]);
  // Next/previous is resolved server-side from the source's station/channel list,
  // so the widget does not need to poll the list itself.
  const step = useCallback(
    (direction: 1 | -1, source?: MediaKind) => control(direction === 1 ? 'next' : 'previous', { source }),
    [control],
  );

  return { audio, error, pause, resume, stop, setMuted, setVolume, step };
}
