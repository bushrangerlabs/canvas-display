/**
 * Audio broadcast store (record → store → fan-out).
 *
 * A recorded clip is held in memory and served at a public URL. Core then fans
 * it out to every connected edge device (via the gateway) and every HA
 * media_player entity (via `media_player.play_media`). This is deliberately
 * store-and-forward — no SIP or WebRTC is involved.
 */
import { randomUUID } from 'node:crypto';

export interface BroadcastClip {
  id: string;
  buffer: Buffer;
  mimeType: string;
  title: string;
  createdAt: number;
}

/** Map a mime type to a file extension for the served URL. */
export function extensionForMime(mimeType: string): string {
  const mime = mimeType.toLowerCase();
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('ogg') || mime.includes('opus')) return 'ogg';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return 'm4a';
  return 'bin';
}

export class BroadcastStore {
  private readonly clips = new Map<string, BroadcastClip>();

  constructor(private readonly ttlMs = 10 * 60_000) {}

  /** Store a clip and return it (with its generated id). */
  add(buffer: Buffer, mimeType: string, title: string): BroadcastClip {
    this.prune();
    const clip: BroadcastClip = {
      id: randomUUID(),
      buffer,
      mimeType: mimeType || 'audio/wav',
      title: title || 'Broadcast',
      createdAt: Date.now(),
    };
    this.clips.set(clip.id, clip);
    return clip;
  }

  /** Look up a clip by id (undefined if unknown or expired). */
  get(id: string): BroadcastClip | undefined {
    this.prune();
    return this.clips.get(id);
  }

  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, clip] of this.clips) {
      if (clip.createdAt < cutoff) this.clips.delete(id);
    }
  }
}
