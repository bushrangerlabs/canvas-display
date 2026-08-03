export interface EndOfSpeechOptions {
  sampleRate?: number;
  minimumCaptureMs?: number;
  trailingSilenceMs?: number;
  noSpeechTimeoutMs?: number;
  maximumCaptureMs?: number;
  minimumSpeechMs?: number;
  calibrationMs?: number;
}

export type CaptureDecision = 'continue' | 'speech-ended' | 'no-speech' | 'maximum';

/** Lightweight adaptive PCM16 voice activity detector for edge capture bounds. */
export class EndOfSpeechDetector {
  private readonly sampleRate: number;
  private readonly minimumCaptureMs: number;
  private readonly trailingSilenceMs: number;
  private readonly noSpeechTimeoutMs: number;
  private readonly maximumCaptureMs: number;
  private readonly minimumSpeechMs: number;
  private readonly calibrationMs: number;
  private elapsedMs = 0;
  private speechMs = 0;
  private silenceAfterSpeechMs = 0;
  private noiseFloor: number | null = null;
  private lastRms = 0;
  private lastThreshold = 0;
  private speechStarted = false;

  constructor(options: EndOfSpeechOptions = {}) {
    this.sampleRate = options.sampleRate ?? 16_000;
    this.minimumCaptureMs = options.minimumCaptureMs ?? 700;
    this.trailingSilenceMs = options.trailingSilenceMs ?? 650;
    this.noSpeechTimeoutMs = options.noSpeechTimeoutMs ?? 3_500;
    this.maximumCaptureMs = options.maximumCaptureMs ?? 8_000;
    this.minimumSpeechMs = options.minimumSpeechMs ?? 240;
    this.calibrationMs = options.calibrationMs ?? 320;
  }

  push(chunk: Buffer): CaptureDecision {
    const chunkMs = chunk.length / 2 / this.sampleRate * 1_000;
    this.elapsedMs += chunkMs;
    const rms = pcmRms(chunk);
    this.lastRms = rms;

    // The Pi microphone can have a high, constant hardware noise floor. Learn it
    // before accepting speech; otherwise that noise starts an eight-second turn.
    if (this.elapsedMs <= this.calibrationMs) {
      this.noiseFloor = this.noiseFloor === null
        ? rms
        : this.noiseFloor * 0.7 + rms * 0.3;
      this.lastThreshold = this.threshold();
      return this.elapsedMs >= this.maximumCaptureMs ? 'maximum' : 'continue';
    }

    const speechThreshold = this.threshold();
    this.lastThreshold = speechThreshold;
    const active = rms >= speechThreshold;

    if (!this.speechStarted && !active) {
      this.noiseFloor = (this.noiseFloor ?? rms) * 0.97 + rms * 0.03;
    }
    if (active) {
      this.speechMs += chunkMs;
      this.silenceAfterSpeechMs = 0;
      if (this.speechMs >= this.minimumSpeechMs) this.speechStarted = true;
    } else if (this.speechStarted) {
      this.silenceAfterSpeechMs += chunkMs;
    } else {
      // Require minimumSpeechMs of contiguous activity so isolated clicks and
      // level spikes do not arm the trailing-silence timer.
      this.speechMs = 0;
    }

    if (this.elapsedMs >= this.maximumCaptureMs) return 'maximum';
    if (!this.speechStarted && this.elapsedMs >= this.noSpeechTimeoutMs) return 'no-speech';
    if (this.speechStarted
        && this.elapsedMs >= this.minimumCaptureMs
        && this.silenceAfterSpeechMs >= this.trailingSilenceMs) return 'speech-ended';
    return 'continue';
  }

  get durationMs(): number { return Math.round(this.elapsedMs); }
  get detectedSpeech(): boolean { return this.speechStarted; }
  get diagnostics(): { rms: number; noiseFloor: number; speechThreshold: number } {
    return {
      rms: Math.round(this.lastRms),
      noiseFloor: Math.round(this.noiseFloor ?? 0),
      speechThreshold: Math.round(this.lastThreshold),
    };
  }

  private threshold(): number {
    return Math.max(350, (this.noiseFloor ?? 0) * 1.8 + 120);
  }
}

export function pcmRms(chunk: Buffer): number {
  if (chunk.length < 2) return 0;
  let sumSquares = 0;
  let samples = 0;
  for (let offset = 0; offset + 1 < chunk.length; offset += 2) {
    const value = chunk.readInt16LE(offset);
    sumSquares += value * value;
    samples++;
  }
  return samples ? Math.sqrt(sumSquares / samples) : 0;
}
