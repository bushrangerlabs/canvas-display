import type { Pool } from 'pg';

export const MEDIA_TYPES = ['dab', 'dispatcharr', 'music_assistant', 'youtube', 'youtube_music'] as const;
export type MediaType = typeof MEDIA_TYPES[number];
export type PlaybackTargetKind = 'canvas' | 'music_assistant' | 'dlna' | 'media_player';

export const PLAYBACK_TARGET_KINDS: readonly PlaybackTargetKind[] = ['canvas', 'music_assistant', 'dlna', 'media_player'];

export interface PlaybackTarget {
  kind: PlaybackTargetKind;
  id: string;
  name?: string;
}

const temporarySelections = new Map<string, Map<MediaType, PlaybackTarget>>();

export function isMediaType(value: unknown): value is MediaType {
  return typeof value === 'string' && (MEDIA_TYPES as readonly string[]).includes(value);
}

export function isPlaybackTargetKind(value: unknown): value is PlaybackTargetKind {
  return typeof value === 'string' && (PLAYBACK_TARGET_KINDS as readonly string[]).includes(value);
}

/**
 * Destination kinds that can play a given media type, in preference order. The
 * first entry is the default when the operator has not chosen one. Direct
 * audio sources (DAB+, Dispatcharr) can play on a Canvas display, a LAN DLNA
 * renderer, or any Home Assistant `media_player`; Music Assistant sources play
 * through Music Assistant or a Home Assistant media player.
 */
export function compatibleTargetKinds(mediaType: MediaType): PlaybackTargetKind[] {
  if (mediaType === 'music_assistant' || mediaType === 'youtube_music') {
    return ['music_assistant', 'media_player', 'dlna'];
  }
  // YouTube renders in the display's player overlay, so it stays Canvas-only.
  if (mediaType === 'youtube') return ['canvas'];
  return ['canvas', 'dlna', 'media_player'];
}

/** The preferred (default) destination kind for a media type. */
export function compatibleTargetKind(mediaType: MediaType): PlaybackTargetKind {
  return compatibleTargetKinds(mediaType)[0];
}

export function setTemporaryPlaybackTarget(deviceId: string, mediaType: MediaType, target: PlaybackTarget): void {
  const selections = temporarySelections.get(deviceId) ?? new Map<MediaType, PlaybackTarget>();
  selections.set(mediaType, target);
  temporarySelections.set(deviceId, selections);
}

export function clearTemporaryPlaybackTarget(deviceId: string, mediaType?: MediaType): void {
  if (!mediaType) {
    temporarySelections.delete(deviceId);
    return;
  }
  const selections = temporarySelections.get(deviceId);
  selections?.delete(mediaType);
  if (selections?.size === 0) temporarySelections.delete(deviceId);
}

export function temporaryPlaybackTarget(deviceId: string, mediaType: MediaType): PlaybackTarget | null {
  return temporarySelections.get(deviceId)?.get(mediaType) ?? null;
}

export async function savedPlaybackTargets(pool: Pool, deviceId: string): Promise<Partial<Record<MediaType, PlaybackTarget>>> {
  const result = await pool.query(
    'SELECT media_type, target_kind, target_id FROM device_media_defaults WHERE device_id = $1',
    [deviceId],
  );
  return Object.fromEntries(result.rows.filter(row => isMediaType(row.media_type)).map(row => [
    row.media_type,
    { kind: row.target_kind as PlaybackTargetKind, id: String(row.target_id) },
  ]));
}

export async function savePlaybackTargets(
  pool: Pool,
  deviceId: string,
  targets: Partial<Record<MediaType, PlaybackTarget | null>>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const mediaType of MEDIA_TYPES) {
      if (!(mediaType in targets)) continue;
      const target = targets[mediaType];
      if (!target) {
        await client.query('DELETE FROM device_media_defaults WHERE device_id=$1 AND media_type=$2', [deviceId, mediaType]);
        continue;
      }
      await client.query(
        `INSERT INTO device_media_defaults(device_id, media_type, target_kind, target_id, updated_at)
         VALUES($1,$2,$3,$4,now())
         ON CONFLICT(device_id, media_type) DO UPDATE SET target_kind=excluded.target_kind, target_id=excluded.target_id, updated_at=now()`,
        [deviceId, mediaType, target.kind, target.id],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function effectivePlaybackTarget(
  pool: Pool,
  controllerDeviceId: string,
  mediaType: MediaType,
  firstMaPlayerId = '',
): Promise<{ target: PlaybackTarget; temporary: boolean }> {
  const temporary = temporaryPlaybackTarget(controllerDeviceId, mediaType);
  if (temporary) return { target: temporary, temporary: true };
  const saved = (await savedPlaybackTargets(pool, controllerDeviceId))[mediaType];
  if (saved) return { target: saved, temporary: false };
  return {
    target: compatibleTargetKind(mediaType) === 'canvas'
      ? { kind: 'canvas', id: controllerDeviceId }
      : { kind: 'music_assistant', id: firstMaPlayerId },
    temporary: false,
  };
}
