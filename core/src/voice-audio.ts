/**
 * Opus streaming audio pipeline (Phase 5, plan doc §14).
 *
 * `OpusStreamProcessor` handles the Opus frame exchange between Core and an
 * authenticated voice session client. It:
 *   - Receives Opus-encoded audio frames (raw Opus packets, not RTP).
 *   - Buffers them into a `StreamBuffer` (configurable max size).
 *   - On `audio_end`, sends the buffered audio to the ASR provider (Whisper)
 *     for transcription.
 *   - Receives the TTS response (Piper) and streams it back as Opus frames.
 *
 * Opus encode/decode uses `node-opus` (native addon). If unavailable at import,
 * the module falls back to raw PCM passthrough (documented).
 *
 * VAD (voice activity detection): simple energy-based silence detection.
 * Wake pre-roll: the client can include a `pre_roll_bytes` field in `audio_start`
 * indicating how many bytes before the wake word to include (default 0, max 8000).
 * PTT pre-roll: zero-default (no pre-roll for PTT).
 */

import { createRequire } from 'node:module';
import type { OpusEncoder as NodeOpusEncoder } from 'node-opus';
import type { TranscriptionProvider } from './providers/asr.js';
import type { SpeechProvider } from './providers/tts.js';
import type { Intelligence } from './intelligence.js';

// ---------------------------------------------------------------------------
// Opus codec wrapper
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 16_000; // 16 kHz
const CHANNELS = 1;         // mono
const FRAME_SIZE_MS = 20;   // 20ms frames
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_SIZE_MS) / 1000; // 320
const FRAME_BYTES = FRAME_SAMPLES * 2; // 16-bit PCM -> 640 bytes per frame
const require = createRequire(import.meta.url);

/** Wrap signed 16-bit little-endian mono PCM in a canonical WAV container. */
export function pcm16MonoToWav(
  pcm: Buffer,
  sampleRate = SAMPLE_RATE,
): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * CHANNELS * 2;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(CHANNELS * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Thin wrapper around node-opus OpusEncoder. Exposes encode (PCM -> Opus) and
 * decode (Opus -> PCM). Falls back to raw PCM passthrough if node-opus is
 * unavailable (documented fallback).
 */
export class OpusCodec {
  private encoder: NodeOpusEncoder | null = null;
  private fallback = false;

  constructor() {
    try {
      // `node-opus` is an optional native acceleration path. Loading it lazily
      // keeps an absent or ABI-incompatible addon from crashing Core before the
      // documented PCM fallback can be selected.
      const { OpusEncoder } = require('node-opus') as typeof import('node-opus');
      this.encoder = new OpusEncoder(SAMPLE_RATE, CHANNELS);
    } catch (error) {
      const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
      console.warn(`[voice-audio] node-opus unavailable (${reason}); falling back to raw PCM`);
      this.fallback = true;
    }
  }

  /** Encode a 16-bit PCM buffer into an Opus frame. Returns the Opus packet bytes. */
  encode(pcm: Buffer): Buffer {
    if (this.fallback || !this.encoder) return pcm;
    return this.encoder.encode(pcm);
  }

  /** Decode an Opus packet into 16-bit PCM. Returns the PCM buffer. */
  decode(opus: Buffer): Buffer {
    if (this.fallback || !this.encoder) return opus;
    return this.encoder.decode(opus);
  }

  /** True when node-opus is loaded and functional. */
  get isNative(): boolean {
    return !this.fallback && this.encoder !== null;
  }

  /** The expected PCM frame size in bytes (640 for 16kHz mono 20ms). */
  static get FRAME_BYTES(): number {
    return FRAME_BYTES;
  }

  static get SAMPLE_RATE(): number {
    return SAMPLE_RATE;
  }
}

// ---------------------------------------------------------------------------
// Stream buffer
// ---------------------------------------------------------------------------

export interface StreamBufferOptions {
  /** Max buffer size in bytes (default 10 seconds of 16kHz PCM = 320_000 bytes). */
  maxBytes?: number;
}

/**
 * Bounded buffer that accumulates decoded PCM audio frames.
 * On overflow, the oldest bytes are dropped (ring-buffer semantics).
 */
export class StreamBuffer {
  private chunks: Buffer[] = [];
  private _byteLength = 0;
  private readonly maxBytes: number;

  constructor(opts: StreamBufferOptions = {}) {
    this.maxBytes = opts.maxBytes ?? SAMPLE_RATE * 2 * 10; // 10s of 16kHz 16-bit
  }

  /** Append decoded PCM bytes. Drops oldest bytes if over maxBytes. */
  append(pcm: Buffer): void {
    this.chunks.push(pcm);
    this._byteLength += pcm.length;
    while (this._byteLength > this.maxBytes && this.chunks.length > 0) {
      const dropped = this.chunks.shift()!;
      this._byteLength -= dropped.length;
    }
  }

  /** Concatenate all buffered PCM bytes. */
  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }

  /** Clear the buffer. */
  clear(): void {
    this.chunks = [];
    this._byteLength = 0;
  }

  /** Current byte length. */
  get byteLength(): number {
    return this._byteLength;
  }
}

// ---------------------------------------------------------------------------
// VAD (voice activity detection)
// ---------------------------------------------------------------------------

export interface VadOptions {
  /** RMS threshold below which audio is considered silence (default 500). */
  threshold?: number;
  /** Silence duration in ms before triggering vad_silence (default 3000). */
  silenceMs?: number;
}

/**
 * Simple energy-based voice activity detector.
 * Computes RMS of each PCM frame and tracks consecutive silence duration.
 */
export class EnergyVad {
  private readonly threshold: number;
  private readonly silenceMs: number;
  private consecutiveSilenceMs = 0;
  private lastSpeechMs = 0;

  constructor(opts: VadOptions = {}) {
    this.threshold = opts.threshold ?? 500;
    this.silenceMs = opts.silenceMs ?? 3_000;
  }

  /**
   * Feed a PCM frame (16-bit mono) and return whether silence has been
   * detected for longer than the configured threshold.
   */
  feed(pcm: Buffer, frameDurationMs: number = FRAME_SIZE_MS): VadResult {
    const rms = this.computeRms(pcm);
    const isSpeech = rms >= this.threshold;

    if (isSpeech) {
      this.consecutiveSilenceMs = 0;
      this.lastSpeechMs = Date.now();
    } else {
      this.consecutiveSilenceMs += frameDurationMs;
    }

    return {
      isSpeech,
      rms,
      silenceDurationMs: this.consecutiveSilenceMs,
      isSilenceTimeout: this.consecutiveSilenceMs >= this.silenceMs,
    };
  }

  /** Reset VAD state (e.g. on vad_continue). */
  reset(): void {
    this.consecutiveSilenceMs = 0;
  }

  /** Time since last speech in ms. */
  get timeSinceLastSpeechMs(): number {
    return this.lastSpeechMs > 0 ? Date.now() - this.lastSpeechMs : 0;
  }

  private computeRms(pcm: Buffer): number {
    if (pcm.length < 2) return 0;
    let sumSq = 0;
    const len = Math.floor(pcm.length / 2);
    for (let i = 0; i < len; i++) {
      const sample = pcm.readInt16LE(i * 2);
      sumSq += sample * sample;
    }
    return Math.sqrt(sumSq / len);
  }
}

export interface VadResult {
  isSpeech: boolean;
  rms: number;
  silenceDurationMs: number;
  isSilenceTimeout: boolean;
}

// ---------------------------------------------------------------------------
// OpusStreamProcessor
// ---------------------------------------------------------------------------

export type VoiceSessionEventType =
  | 'audio_start'
  | 'audio_start_ack'
  | 'audio_frame'
  | 'audio_end'
  | 'audio_end_ack'
  | 'vad_silence'
  | 'vad_continue'
  | 'session_closed'
  | 'error'
  | 'tts_frame'
  | 'tts_end';

export interface VoiceSessionMessage {
  type: VoiceSessionEventType;
  /** Opus-encoded audio bytes (base64 for transport). */
  payload?: string;
  /** Number of pre-roll bytes to include (wake pre-roll). */
  pre_roll_bytes?: number;
  /** Error code / reason. */
  code?: string;
  reason?: string;
  /** Session id for correlation. */
  session_id?: string;
  /** Transcript result. */
  transcript?: string;
  /** TTS reply text. */
  reply?: string;
}

export interface OpusStreamProcessorOptions {
  /** Max buffer size in bytes (default 10s of 16kHz PCM). */
  maxBufferBytes?: number;
  /** VAD threshold (RMS). */
  vadThreshold?: number;
  /** VAD silence timeout in ms. */
  vadSilenceMs?: number;
  /** Max pre-roll bytes (default 8000 = 500ms of 16kHz PCM). */
  maxPreRollBytes?: number;
}

/**
 * Core Opus streaming processor. Manages the frame exchange lifecycle:
 *   audio_start -> audio_start_ack -> bidirectional Opus frames ->
 *   audio_end -> pipeline -> tts_frame* -> tts_end -> audio_end_ack
 */
export class OpusStreamProcessor {
  private readonly codec = new OpusCodec();
  private readonly buffer: StreamBuffer;
  private readonly vad: EnergyVad;
  private readonly maxPreRollBytes: number;
  private preRollBytes = 0;
  private preRollBuffer: Buffer[] = [];
  private preRollLength = 0;
  private _ended = false;
  private _started = false;

  /** Callback for outgoing messages (server -> client). */
  onMessage: ((msg: VoiceSessionMessage) => void) | null = null;
  /** Callback for VAD silence timeout. */
  onVadSilence: (() => void) | null = null;

  constructor(opts: OpusStreamProcessorOptions = {}) {
    this.buffer = new StreamBuffer({ maxBytes: opts.maxBufferBytes });
    this.vad = new EnergyVad({
      threshold: opts.vadThreshold,
      silenceMs: opts.vadSilenceMs,
    });
    this.maxPreRollBytes = opts.maxPreRollBytes ?? 8000;
  }

  /** Handle an incoming message from the client. */
  handleMessage(msg: VoiceSessionMessage): void {
    if (this._ended) {
      this.send({ type: 'error', code: 'session_closed', reason: 'Session already ended' });
      return;
    }

    switch (msg.type) {
      case 'audio_start':
        this.handleAudioStart(msg);
        break;
      case 'audio_frame':
        this.handleAudioFrame(msg);
        break;
      case 'audio_end':
        this.handleAudioEnd();
        break;
      case 'vad_continue':
        this.handleVadContinue();
        break;
      default:
        this.send({ type: 'error', code: 'unknown_message', reason: `Unknown type: ${msg.type}` });
    }
  }

  private handleAudioStart(msg: VoiceSessionMessage): void {
    if (this._started) {
      this.send({ type: 'error', code: 'already_started', reason: 'Session already started' });
      return;
    }
    this._started = true;

    // Configure pre-roll (wake word context)
    const requestedPreRoll = msg.pre_roll_bytes ?? 0;
    this.preRollBytes = Math.min(requestedPreRoll, this.maxPreRollBytes);

    this.send({ type: 'audio_start_ack', session_id: msg.session_id });
  }

  private handleAudioFrame(msg: VoiceSessionMessage): void {
    if (!msg.payload) {
      this.send({ type: 'error', code: 'missing_payload', reason: 'audio_frame requires payload' });
      return;
    }

    const opusBytes = Buffer.from(msg.payload, 'base64');
    let pcm: Buffer;

    try {
      pcm = this.codec.decode(opusBytes);
    } catch (err) {
      this.send({ type: 'error', code: 'decode_error', reason: `Opus decode failed: ${(err as Error).message}` });
      return;
    }

    // Accumulate pre-roll if within limit
    if (this.preRollBytes > 0 && this.preRollLength < this.preRollBytes) {
      this.preRollBuffer.push(pcm);
      this.preRollLength += pcm.length;
      // Trim oldest if over limit
      while (this.preRollLength > this.preRollBytes && this.preRollBuffer.length > 0) {
        const dropped = this.preRollBuffer.shift()!;
        this.preRollLength -= dropped.length;
      }
    }

    // Buffer for ASR
    this.buffer.append(pcm);

    // VAD check
    const vadResult = this.vad.feed(pcm);
    if (vadResult.isSilenceTimeout) {
      this.send({ type: 'vad_silence', reason: 'No speech detected' });
      this.onVadSilence?.();
    }
  }

  private handleAudioEnd(): void {
    this._ended = true;
    this.send({ type: 'audio_end_ack' });
  }

  private handleVadContinue(): void {
    this.vad.reset();
  }

  /**
   * Run the full voice pipeline on the accumulated buffer.
   * Returns the pipeline result (transcript, reply, TTS audio).
   */
  async runPipeline(intelligence: Intelligence, systemPrompt?: string): Promise<{
    transcript: string;
    reply: string;
    ttsAudio?: Buffer;
  }> {
    // Build the full PCM buffer including pre-roll
    const mainAudio = this.buffer.toBuffer();
    const preRoll = Buffer.concat(this.preRollBuffer);
    const fullAudio = Buffer.concat([preRoll, mainAudio]);

    // Run ASR -> LLM -> TTS
    const result = await intelligence.runVoicePipeline({
      audio: pcm16MonoToWav(fullAudio),
      systemPrompt,
    });

    let ttsAudio: Buffer | undefined;
    if (result.audioBase64) {
      ttsAudio = Buffer.from(result.audioBase64, 'base64');
    }

    return {
      transcript: result.transcript,
      reply: result.reply,
      ttsAudio,
    };
  }

  /**
   * Stream TTS audio back to the client as Opus frames.
   * The TTS audio is expected as raw PCM (16-bit mono 16kHz).
   * Returns the number of frames sent.
   */
  streamTts(pcmAudio: Buffer): number {
    let framesSent = 0;
    for (let offset = 0; offset + FRAME_BYTES <= pcmAudio.length; offset += FRAME_BYTES) {
      const frame = pcmAudio.subarray(offset, offset + FRAME_BYTES);
      const opus = this.codec.encode(frame);
      this.send({
        type: 'tts_frame',
        payload: opus.toString('base64'),
      });
      framesSent++;
    }
    // Send remaining partial frame (if any) as-is
    const remainder = pcmAudio.length % FRAME_BYTES;
    if (remainder > 0) {
      const frame = pcmAudio.subarray(pcmAudio.length - remainder);
      const opus = this.codec.encode(frame);
      this.send({
        type: 'tts_frame',
        payload: opus.toString('base64'),
      });
      framesSent++;
    }

    this.send({ type: 'tts_end' });
    return framesSent;
  }

  /** True when audio_end has been received. */
  get ended(): boolean {
    return this._ended;
  }

  /** True when audio_start has been received. */
  get started(): boolean {
    return this._started;
  }

  /** Access the codec (for tests). */
  getCodec(): OpusCodec {
    return this.codec;
  }

  private send(msg: VoiceSessionMessage): void {
    this.onMessage?.(msg);
  }
}
