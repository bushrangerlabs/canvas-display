/**
 * Shared audio playback helpers for the sidecar voice subsystem.
 */
import { getDb } from '../db/index.js';

/**
 * Returns the configured speaker device name, or 'default' if not set.
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

/**
 * Wrap raw s16le mono PCM in a RIFF/WAV container.
 * Core's Piper TTS provider returns raw PCM; the broadcast poller must add
 * the WAV header before passing the buffer to mpv.
 * If the buffer already has a RIFF header it is returned unchanged.
 */
export function ensureWav(pcm: Buffer, sampleRate = 22_050, channels = 1): Buffer {
  if (pcm.length >= 4 && pcm.slice(0, 4).toString('ascii') === 'RIFF') return pcm;
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
