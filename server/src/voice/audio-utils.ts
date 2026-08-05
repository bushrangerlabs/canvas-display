/**
 * Shared audio playback helpers for the sidecar voice subsystem.
 */
import { getDb } from '../db/index.js';

/**
 * Returns the configured speaker device name, or 'default' if not set.
 * Maps bare sink names to pulse/<sink> format for mpv.
 */
export function getSpeakerDevice(): string {
  try {
    const db = getDb();
    const val = (db.prepare('SELECT value FROM server_settings WHERE key = ?').get('audio_speaker_device') as { value: string } | undefined)?.value;
    return val || process.env.CANVAS_SPEAKER_DEVICE || 'default';
  } catch {
    return process.env.CANVAS_SPEAKER_DEVICE || 'default';
  }
}

/**
 * Returns mpv --audio-device arg value for the given device, or null for default.
 */
export function getMpvAudioDevice(speakerDevice?: string): string | null {
  const dev = speakerDevice ?? getSpeakerDevice();
  if (!dev || dev === 'default') return null;
  return dev.includes('/') ? dev : `pulse/${dev}`;
}

/**
 * Builds the mpv argument list for audio playback.
 */
export function buildMpvAudioArgs(volume: number, filePath: string, speakerDevice?: string): string[] {
  const args = ['--no-video', '--really-quiet', `--volume=${volume}`];
  const audioDevice = getMpvAudioDevice(speakerDevice);
  if (audioDevice) args.push(`--audio-device=${audioDevice}`);
  args.push(filePath);
  return args;
}
