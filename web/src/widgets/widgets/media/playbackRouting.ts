import { useCallback, useEffect, useState } from 'react';
import { targetDeviceId } from './mediaSource';

export type PlaybackMediaType = 'dab' | 'dispatcharr' | 'music_assistant' | 'youtube' | 'youtube_music';
export type PlaybackDestinationKind = 'canvas' | 'music_assistant' | 'dlna' | 'media_player';
export interface PlaybackDestination {
  kind: PlaybackDestinationKind;
  id: string;
  name: string;
  available: boolean;
  compatible: boolean;
  reason?: string;
}
export interface PlaybackSelection { kind: PlaybackDestination['kind']; id: string; name?: string }

const CORE_TOKEN = (import.meta.env as { VITE_CORE_AUTOMATION_TOKEN?: string }).VITE_CORE_AUTOMATION_TOKEN;
const authHeaders = (): Record<string, string> => CORE_TOKEN ? { Authorization: `Bearer ${CORE_TOKEN}` } : {};

export function usePlaybackRouting(mediaType: PlaybackMediaType, pollMs = 5000) {
  const controllerDeviceId = targetDeviceId() ?? '';
  const [destinations, setDestinations] = useState<PlaybackDestination[]>([]);
  const [current, setCurrent] = useState<PlaybackSelection | null>(null);
  const [temporary, setTemporary] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!controllerDeviceId) return;
    try {
      const response = await fetch(`/api/media/destinations?controllerDeviceId=${encodeURIComponent(controllerDeviceId)}&mediaType=${encodeURIComponent(mediaType)}`, { cache: 'no-store' });
      const data = await response.json() as { destinations?: PlaybackDestination[]; current?: PlaybackSelection; temporary?: boolean; error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      const nextDestinations = data.destinations ?? [];
      setDestinations(nextDestinations);
      const selected = data.current;
      setCurrent(selected ? { ...selected, name: selected.name || nextDestinations.find(item => item.kind === selected.kind && item.id === selected.id)?.name } : null);
      setTemporary(!!data.temporary);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [controllerDeviceId, mediaType]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(load, pollMs);
    return () => window.clearInterval(timer);
  }, [load, pollMs]);

  const select = useCallback(async (target: PlaybackSelection) => {
    if (!controllerDeviceId) return false;
    const response = await fetch(`/api/media/routing/${encodeURIComponent(controllerDeviceId)}/select`, {
      method: 'POST', credentials: 'include',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaType, target }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: string };
      setError(data.error || `HTTP ${response.status}`);
      return false;
    }
    await load();
    return true;
  }, [controllerDeviceId, load, mediaType]);

  const reset = useCallback(async () => {
    if (!controllerDeviceId) return false;
    const response = await fetch(`/api/media/routing/${encodeURIComponent(controllerDeviceId)}/select/${encodeURIComponent(mediaType)}`, {
      method: 'DELETE', credentials: 'include', headers: authHeaders(),
    });
    if (!response.ok) return false;
    await load();
    return true;
  }, [controllerDeviceId, load, mediaType]);

  return { controllerDeviceId, destinations, current, temporary, error, select, reset };
}

export const mediaTypeOptions = [
  { value: 'dab', label: 'DAB+' },
  { value: 'dispatcharr', label: 'Dispatcharr' },
  { value: 'music_assistant', label: 'Music Assistant' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'youtube_music', label: 'YouTube Music' },
];

/** Short glyph for a destination kind (used by the routing widgets). */
export const destinationIcon = (kind: PlaybackDestinationKind): string =>
  kind === 'canvas' ? '▣' : kind === 'music_assistant' ? '♪' : kind === 'dlna' ? '📶' : '🏠';

/** Human-readable destination kind label. */
export const destinationKindLabel = (kind: PlaybackDestinationKind): string =>
  kind === 'canvas'
    ? 'Canvas display'
    : kind === 'music_assistant'
      ? 'Music Assistant player'
      : kind === 'dlna'
        ? 'DLNA renderer'
        : 'Home Assistant media player';
