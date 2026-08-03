/**
 * Audio-focus state machine (§14.5 of the architecture plan).
 *
 * Manages competing audio sources (voice, media, barge-in) so that:
 * - Voice sessions duck media playback.
 * - Barge-in preempts an active voice turn.
 * - Media volume is restored when the competing source releases focus.
 *
 * The manager is injectable (interface + real/fake) so tests and the voice
 * pipeline can use it without coupling to a concrete implementation.
 */

export type FocusType = 'voice' | 'media' | 'barge_in';

export type FocusState =
  | 'idle'
  | 'active_voice'
  | 'active_media'
  | 'ducking_media'
  | 'barge_in';

export interface FocusGrant {
  /** Whether the focus request was granted. */
  granted: boolean;
  /** The state after processing the request. */
  currentState: FocusState;
  /**
   * When media is ducked, the volume level (0-100) it should be reduced to.
   * `undefined` when no ducking applies.
   */
  duckLevel?: number;
}

export interface FocusManager {
  /** Request focus for a given type. */
  requestFocus(type: FocusType): FocusGrant;
  /** Release focus for a given type. */
  releaseFocus(type: FocusType): FocusGrant;
  /** Read the current state without mutating. */
  getState(): FocusState;
  /** Get the current duck volume percentage (0-100). Only meaningful when ducking. */
  getDuckLevel(): number;
  /** Reset to idle (used in tests / reconnection). */
  reset(): void;
}

export interface FocusManagerOptions {
  /** Volume percentage (0-100) media is reduced to when ducked. Default 30. */
  duckVolumePercent?: number;
}

/**
 * Real audio-focus state machine.
 *
 * State machine:
 * ```
 * idle ──request('voice')──→ active_voice
 * idle ──request('media')──→ active_media
 * active_voice ──release('voice')──→ ducking_media  (if media was playing)
 * active_voice ──release('voice')──→ idle            (if no media)
 * active_media ──request('barge_in')──→ ducking_media
 * ducking_media ──release('barge_in')──→ active_media
 * ducking_media ──release('voice')──→ active_media   (voice ended, restore media)
 * barge_in ──request('voice')──→ active_voice        (barge-in preempted by new voice)
 * barge_in ──release('barge_in')──→ ducking_media    (barge-in ends, media still ducked)
 * ```
 *
 * The manager tracks which focus type(s) are currently holding focus so that
 * releasing one type correctly restores the previous holder.
 */
export class AudioFocusManager implements FocusManager {
  private state: FocusState = 'idle';
  private duckVolumePercent: number;
  /** Stack of holders — the last entry is the current focus holder. */
  private holders: FocusType[] = [];
  /** Whether media was playing before ducking (so we know to restore). */
  private mediaWasPlaying = false;

  constructor(opts: FocusManagerOptions = {}) {
    this.duckVolumePercent = opts.duckVolumePercent ?? 30;
  }

  getState(): FocusState {
    return this.state;
  }

  getDuckLevel(): number {
    return this.duckVolumePercent;
  }

  reset(): void {
    this.state = 'idle';
    this.holders = [];
    this.mediaWasPlaying = false;
  }

  requestFocus(type: FocusType): FocusGrant {
    switch (this.state) {
      case 'idle': {
        if (type === 'voice' || type === 'media') {
          this.state = type === 'voice' ? 'active_voice' : 'active_media';
          this.holders.push(type);
          return { granted: true, currentState: this.state };
        }
        // barge_in from idle — unlikely but valid
        this.state = 'barge_in';
        this.holders.push(type);
        return { granted: true, currentState: this.state };
      }

      case 'active_voice': {
        if (type === 'voice') {
          // Already holding voice — redundant but harmless
          return { granted: true, currentState: this.state };
        }
        if (type === 'barge_in') {
          // Barge-in preempts voice
          this.state = 'barge_in';
          this.holders.push(type);
          return { granted: true, currentState: this.state };
        }
        // media request while voice is active — denied
        return { granted: false, currentState: this.state };
      }

      case 'active_media': {
        if (type === 'media') {
          // Already holding media
          return { granted: true, currentState: this.state };
        }
        if (type === 'voice' || type === 'barge_in') {
          // Voice or barge-in ducks media
          this.mediaWasPlaying = true;
          this.state = 'ducking_media';
          this.holders.push(type);
          return {
            granted: true,
            currentState: this.state,
            duckLevel: this.duckVolumePercent,
          };
        }
        return { granted: false, currentState: this.state };
      }

      case 'ducking_media': {
        if (type === 'voice') {
          // Voice request while media is already ducked — push voice on top
          this.holders.push(type);
          this.state = 'active_voice';
          return { granted: true, currentState: this.state, duckLevel: this.duckVolumePercent };
        }
        if (type === 'barge_in') {
          // Barge-in while already ducked
          this.holders.push(type);
          this.state = 'barge_in';
          return { granted: true, currentState: this.state, duckLevel: this.duckVolumePercent };
        }
        // media request while ducked — denied (media is already ducked)
        return { granted: false, currentState: this.state };
      }

      case 'barge_in': {
        if (type === 'barge_in') {
          return { granted: true, currentState: this.state };
        }
        if (type === 'voice') {
          // Voice preempts barge-in
          this.holders.push(type);
          this.state = 'active_voice';
          return { granted: true, currentState: this.state, duckLevel: this.duckVolumePercent };
        }
        // media request while barge-in active — denied
        return { granted: false, currentState: this.state };
      }

      default:
        return { granted: false, currentState: this.state };
    }
  }

  releaseFocus(type: FocusType): FocusGrant {
    // Remove the last occurrence of `type` from the holders stack
    const idx = this.holders.lastIndexOf(type);
    if (idx !== -1) {
      this.holders.splice(idx, 1);
    }

    // Determine what (if anything) is left
    if (this.holders.length === 0) {
      // Nothing left holding focus
      if (this.state === 'active_voice' || this.state === 'barge_in') {
        if (this.mediaWasPlaying) {
          this.state = 'ducking_media';
          // But nobody is holding — transition to idle
          this.state = 'idle';
          this.mediaWasPlaying = false;
          return { granted: true, currentState: 'idle' };
        }
        this.state = 'idle';
        return { granted: true, currentState: 'idle' };
      }
      if (this.state === 'ducking_media') {
        this.state = 'idle';
        this.mediaWasPlaying = false;
        return { granted: true, currentState: 'idle' };
      }
      this.state = 'idle';
      return { granted: true, currentState: 'idle' };
    }

    const remaining = this.holders[this.holders.length - 1];

    switch (this.state) {
      case 'active_voice': {
        if (type === 'voice') {
          if (this.mediaWasPlaying) {
            this.state = 'ducking_media';
            return { granted: true, currentState: 'ducking_media', duckLevel: this.duckVolumePercent };
          }
          this.state = 'idle';
          this.mediaWasPlaying = false;
          return { granted: true, currentState: 'idle' };
        }
        return { granted: true, currentState: this.state };
      }

      case 'ducking_media': {
        if (type === 'voice' || type === 'barge_in') {
          // The thing that was ducking media released — restore media
          if (remaining === 'media') {
            this.state = 'active_media';
            this.mediaWasPlaying = false;
            return { granted: true, currentState: 'active_media' };
          }
          // Something else is still holding
          this.state = remaining === 'voice' ? 'active_voice' : 'barge_in';
          return { granted: true, currentState: this.state, duckLevel: this.duckVolumePercent };
        }
        return { granted: true, currentState: this.state, duckLevel: this.duckVolumePercent };
      }

      case 'barge_in': {
        if (type === 'barge_in') {
          if (remaining === 'voice') {
            this.state = 'active_voice';
            return { granted: true, currentState: 'active_voice', duckLevel: this.duckVolumePercent };
          }
          if (this.mediaWasPlaying) {
            this.state = 'ducking_media';
            return { granted: true, currentState: 'ducking_media', duckLevel: this.duckVolumePercent };
          }
          this.state = 'idle';
          this.mediaWasPlaying = false;
          return { granted: true, currentState: 'idle' };
        }
        return { granted: true, currentState: this.state };
      }

      default:
        return { granted: true, currentState: this.state };
    }
  }
}

/**
 * Fake focus manager for tests — records calls and returns canned results.
 */
export class FakeFocusManager implements FocusManager {
  public calls: { method: string; args: unknown[] }[] = [];
  private state: FocusState = 'idle';
  private duckLevel = 30;
  /** If set, returned by the next requestFocus call. */
  public nextGrant?: FocusGrant;

  getState(): FocusState {
    this.calls.push({ method: 'getState', args: [] });
    return this.state;
  }

  getDuckLevel(): number {
    this.calls.push({ method: 'getDuckLevel', args: [] });
    return this.duckLevel;
  }

  reset(): void {
    this.calls.push({ method: 'reset', args: [] });
    this.state = 'idle';
  }

  requestFocus(type: FocusType): FocusGrant {
    this.calls.push({ method: 'requestFocus', args: [type] });
    if (this.nextGrant) {
      const g = this.nextGrant;
      this.nextGrant = undefined;
      return g;
    }
    return { granted: true, currentState: 'active_voice' };
  }

  releaseFocus(type: FocusType): FocusGrant {
    this.calls.push({ method: 'releaseFocus', args: [type] });
    return { granted: true, currentState: 'idle' };
  }

  /** Set the state directly (for test setup). */
  setState(s: FocusState): void {
    this.state = s;
  }

  setDuckLevel(v: number): void {
    this.duckLevel = v;
  }
}
