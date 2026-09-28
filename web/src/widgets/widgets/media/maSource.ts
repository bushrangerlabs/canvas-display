/**
 * Shared Music Assistant helpers for the MA widget family.
 *
 * MA widgets target a Music Assistant *player* (configured per widget) and use
 * Core's `/api/ma/*` endpoints, which talk to the MA server's HTTP command
 * API directly. This turns a Canvas display into a wall-panel remote for the
 * whole-home music system — including the DAB+ radio stations exposed by the
 * user's SDR provider plugin.
 */

import { useCallback, useEffect, useState } from 'react';
import { targetDeviceId } from './mediaSource';

export interface MaPlayer {
  id: string;
  name: string;
  /** idle | playing | paused | stopped | standby */
  state: string;
  volume: number; // 0–100
  muted: boolean;
  powered: boolean;
  available: boolean;
  title: string;
  artist: string;
  artwork?: string;
  elapsedSeconds: number;
  durationSeconds: number;
}

export interface MaRadio {
  uri: string;
  name: string;
  artwork?: string;
}

export interface MaPlaylist {
  uri: string;
  name: string;
  artwork?: string;
  trackCount: number;
}

export interface MaSearchResults {
  tracks: { uri: string; name: string; artist: string; artwork?: string }[];
  albums: { uri: string; name: string; artist: string; artwork?: string }[];
  artists: { uri: string; name: string; artwork?: string }[];
  radios: MaRadio[];
  playlists: MaPlaylist[];
}

export const MA_ACCENT = '#ab47bc';

// Trusted-local-client bearer token (VITE_CORE_AUTOMATION_TOKEN). Core's
// requireAdmin accepts it so a display device can drive media playback without
// a browser session/CSRF — see core/src/auth.ts.
const CORE_TOKEN = (import.meta.env as { VITE_CORE_AUTOMATION_TOKEN?: string }).VITE_CORE_AUTOMATION_TOKEN;

/** Auth header for Core mutations when the display has no session cookie. */
function authHeaders(): Record<string, string> {
  return CORE_TOKEN ? { Authorization: `Bearer ${CORE_TOKEN}` } : {};
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

/**
 * Resolve the widget's target player id. An explicit `playerId` config wins;
 * otherwise the first available player is used (single-speaker setups).
 */
export function useMaPlayerId(playerId: string | undefined, pollMs: number): string {
  const explicit = (playerId ?? '').trim();
  const [firstPlayer, setFirstPlayer] = useState('');

  useEffect(() => {
    if (explicit) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/ma/players', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { players?: MaPlayer[] };
        if (cancelled) return;
        const first = (data.players ?? []).find((player) => player.available) ?? (data.players ?? [])[0];
        setFirstPlayer(first?.id ?? '');
      } catch {
        /* transient — keep the last good id */
      }
    };
    void load();
    const id = window.setInterval(load, Math.max(pollMs, 10_000));
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [explicit, pollMs]);

  // Display scenes use Core's shared playback routing when no fixed legacy
  // player is configured. Editor previews have no controller device, so retain
  // the old first-player fallback there.
  return explicit || (targetDeviceId() ? '' : firstPlayer);
}

/** Poll the MA player list (for the player picker widget). */
export function useMaPlayers(pollMs: number, enabled = true) {
  const [players, setPlayers] = useState<MaPlayer[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/ma/players', { cache: 'no-store' });
        if (!res.ok) {
          const detail = (await res.json().catch(() => ({}))) as { error?: string };
          if (!cancelled) setError(detail.error ?? `HTTP ${res.status}`);
          return;
        }
        const data = (await res.json()) as { players?: MaPlayer[] };
        if (cancelled) return;
        setPlayers(data.players ?? []);
        setError('');
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
  }, [pollMs, enabled]);

  return { players, error };
}

/** Poll a single MA player's state (now-playing / controls / volume widgets). */
export function useMaPlayerState(playerId: string, pollMs: number, enabled = true, mediaType: 'music_assistant' | 'youtube_music' = 'music_assistant') {
  const [player, setPlayer] = useState<MaPlayer | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!enabled || (!playerId && !targetDeviceId())) return;
    let cancelled = false;
    const load = async () => {
      try {
        const controllerDeviceId = targetDeviceId();
        const params = new URLSearchParams();
        if (playerId) params.set('playerId', playerId);
        if (controllerDeviceId) params.set('controllerDeviceId', controllerDeviceId);
        params.set('mediaType', mediaType);
        const res = await fetch(`/api/ma/state?${params}`, { cache: 'no-store' });
        if (!res.ok) {
          const detail = (await res.json().catch(() => ({}))) as { error?: string };
          if (!cancelled) setError(detail.error ?? `HTTP ${res.status}`);
          return;
        }
        const data = (await res.json()) as { player?: MaPlayer };
        if (cancelled) return;
        setPlayer(data.player ?? null);
        setError('');
      } catch {
        /* transient — keep the last good state */
      }
    };
    void load();
    const id = window.setInterval(load, pollMs);
    window.addEventListener('canvas:ma-state-changed', load);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener('canvas:ma-state-changed', load);
    };
  }, [playerId, pollMs, enabled, mediaType]);

  return { player, error };
}

/** Transport + volume helpers for a target player. Each action accepts an
 * optional playerId override (used by the player picker to act on the tapped
 * player instead of the widget's configured target). */
export function useMaControl(playerId: string, mediaType: 'music_assistant' | 'youtube_music' = 'music_assistant') {
  const [error, setError] = useState('');

  const run = useCallback(
    async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
      const result = await fn();
      setError(result.ok ? '' : result.error ?? 'Command failed');
      if (result.ok) window.dispatchEvent(new Event('canvas:ma-state-changed'));
      return result.ok;
    },
    [],
  );

  const control = useCallback(
    (action: string, extra: Record<string, unknown> = {}, targetId?: string) => {
      const controllerDeviceId = targetDeviceId();
      return run(() => postJson('/api/ma/control', { action, playerId: targetId || playerId, mediaType, ...(controllerDeviceId ? { controllerDeviceId } : {}), ...extra }));
    },
    [run, playerId, mediaType],
  );

  const play = useCallback(
    (uri: string, option = 'replace', targetId?: string) => {
      const controllerDeviceId = targetDeviceId();
      return run(() => postJson('/api/ma/play', { uri, playerId: targetId || playerId, mediaType, ...(controllerDeviceId ? { controllerDeviceId } : {}), option }));
    },
    [run, playerId, mediaType],
  );

  const playPause = useCallback((targetId?: string) => control('play_pause', {}, targetId), [control]);
  const pause = useCallback((targetId?: string) => control('pause', {}, targetId), [control]);
  const resume = useCallback((targetId?: string) => control('play', {}, targetId), [control]);
  const stop = useCallback((targetId?: string) => control('stop', {}, targetId), [control]);
  const next = useCallback((targetId?: string) => control('next', {}, targetId), [control]);
  const previous = useCallback((targetId?: string) => control('previous', {}, targetId), [control]);
  const setMuted = useCallback(
    (muted: boolean, targetId?: string) => control('mute', { muted }, targetId),
    [control],
  );
  const setVolume = useCallback(
    (level: number, targetId?: string) => control('volume', { level: Math.round(level) }, targetId),
    [control],
  );

  return { error, play, playPause, pause, resume, stop, next, previous, setMuted, setVolume };
}

/** Poll the MA radio station list (includes the DAB+ SDR provider). */
export function useMaRadios(pollMs: number, enabled = true) {
  const [radios, setRadios] = useState<MaRadio[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/ma/radios', { cache: 'no-store' });
        if (!res.ok) {
          const detail = (await res.json().catch(() => ({}))) as { error?: string };
          if (!cancelled) setError(detail.error ?? `HTTP ${res.status}`);
          return;
        }
        const data = (await res.json()) as { radios?: MaRadio[] };
        if (cancelled) return;
        setRadios(data.radios ?? []);
        setError('');
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
  }, [pollMs, enabled]);

  return { radios, error };
}

/** Poll the MA playlist list. */
export function useMaPlaylists(pollMs: number, enabled = true) {
  const [playlists, setPlaylists] = useState<MaPlaylist[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/ma/playlists', { cache: 'no-store' });
        if (!res.ok) {
          const detail = (await res.json().catch(() => ({}))) as { error?: string };
          if (!cancelled) setError(detail.error ?? `HTTP ${res.status}`);
          return;
        }
        const data = (await res.json()) as { playlists?: MaPlaylist[] };
        if (cancelled) return;
        setPlaylists(data.playlists ?? []);
        setError('');
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
  }, [pollMs, enabled]);

  return { playlists, error };
}

/** One-shot MA library search. */
export async function maSearch(query: string, limit = 20): Promise<MaSearchResults> {
  const res = await fetch(`/api/ma/search?q=${encodeURIComponent(query)}&limit=${limit}`, { cache: 'no-store' });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as MaSearchResults;
}

/** Format seconds as m:ss / h:mm:ss. */
export function formatSeconds(total: number): string {
  const seconds = Math.max(0, Math.floor(total));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}
