/**
 * Audio sink arbiter.
 *
 * The display has a single physical audio output. Several subsystems can want
 * it at once — local mpv playback (voice TTS, radio, DLNA pushes) and the
 * Snapcast client used for multi-room sync. Without arbitration they all hold
 * PulseAudio streams simultaneously and the result is overlapping audio.
 *
 * The arbiter tracks which subsystem currently owns the sink and releases the
 * previous owner before a new one starts. Releasers are injected so this module
 * has no dependency on the audio routes or the Snapcast controller.
 */

export type AudioSinkOwner = 'idle' | 'mpv' | 'snapcast';

type Releaser = () => Promise<void>;

const releasers = new Map<AudioSinkOwner, Releaser>();
let currentOwner: AudioSinkOwner = 'idle';

/** Register how to release the sink when another owner takes over. */
export function registerSinkReleaser(owner: AudioSinkOwner, release: Releaser): void {
  releasers.set(owner, release);
}

export function getSinkOwner(): AudioSinkOwner {
  return currentOwner;
}

/**
 * Take ownership of the audio sink, releasing whichever subsystem held it
 * before. Releasing the incoming owner is skipped (it is about to play).
 */
export async function acquireSink(owner: AudioSinkOwner): Promise<void> {
  const previous = currentOwner;
  currentOwner = owner;
  if (previous === owner || previous === 'idle') return;

  const release = releasers.get(previous);
  if (!release) return;
  try {
    await release();
  } catch (err) {
    console.warn(
      `[audio][arbiter] failed to release sink from ${previous}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** Release the sink, but only if `owner` still holds it. */
export async function releaseSink(owner: AudioSinkOwner): Promise<void> {
  if (currentOwner !== owner) return;
  currentOwner = 'idle';
}

/** Test helper — reset the arbiter to a clean state. */
export function resetArbiter(): void {
  releasers.clear();
  currentOwner = 'idle';
}