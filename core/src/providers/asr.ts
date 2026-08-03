/**
 * ASR (speech-to-text) provider (plan doc §15.4, D-010).
 *
 * `WhisperTranscription` calls the speaches/whisper OpenAI-compatible API that is
 * running on the main server as `localcut-whisper` (verified: it exposes
 * `POST /v1/audio/transcriptions` and `POST /v1/audio/translations`, plus
 * `GET /v1/audio/models` and `GET /health` — same surface as OpenAI's Whisper).
 *
 * NOTE (discovered during wiring): the running container had NO audio model
 * installed locally (`GET /v1/audio/models` -> []), so a real transcription
 * returns an error until a model is downloaded via `POST /v1/models`. The client
 * below is correct for the API shape; it just needs a model present to succeed.
 * The base URL and `fetch` are injectable for tests.
 *
 * PHASE SCOPE: batch (non-streaming) transcription scaffold (Phase2/early).
 * Streaming partial/final transcripts (plan §14.2) land later (Phase5).
 */
import type { HealthStatus } from './types.js';
import type { FetchImpl } from './llm.js';

export interface TranscriptionProvider {
  /** Transcribe audio bytes; returns the transcript text. */
  transcribe(audio: Buffer, mimeType?: string): Promise<string>;
  healthCheck(): Promise<HealthStatus>;
}

export interface WhisperTranscriptionOptions {
  /** Base URL of the speaches/whisper service, e.g. "http://host.docker.internal:10301". */
  baseUrl: string;
  /** Model id sent in the form field. */
  model?: string;
  /** Optional language hint (e.g. "en"). */
  language?: string;
  /** Optional response format; defaults to "json". */
  responseFormat?: 'json' | 'text' | 'verbose_json';
  /** Request timeout in ms. */
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
  name?: string;
}

const DEFAULT_MODEL = 'Systran/faster-whisper-base.en';

export class WhisperTranscription implements TranscriptionProvider {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly language?: string;
  private readonly responseFormat: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchImpl;
  private readonly name: string;

  constructor(opts: WhisperTranscriptionOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.model = opts.model ?? DEFAULT_MODEL;
    this.language = opts.language;
    this.responseFormat = opts.responseFormat ?? 'json';
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.name = opts.name ?? 'asr';
  }

  async transcribe(audio: Buffer, mimeType = 'audio/wav'): Promise<string> {
    const form = new FormData();
    // Node 20 global FormData accepts a Blob with a filename + type.
    form.append(
      'file',
      new Blob([new Uint8Array(audio)], { type: mimeType }),
      'audio.wav',
    );
    form.append('model', this.model);
    form.append('response_format', this.responseFormat);
    if (this.language) form.append('language', this.language);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(
        `${this.baseUrl}/v1/audio/transcriptions`,
        { method: 'POST', body: form, signal: controller.signal },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`ASR ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as { text?: string };
      if (typeof data.text !== 'string') {
        throw new Error('ASR response missing "text"');
      }
      return data.text;
    } finally {
      clearTimeout(timer);
    }
  }

  async healthCheck(): Promise<HealthStatus> {
    const start = Date.now();
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/health`, { method: 'GET' });
      const ok = res.ok;
      return {
        name: this.name,
        kind: 'WhisperTranscription',
        healthy: ok,
        detail: ok ? `health ok (${Date.now() - start}ms)` : `status ${res.status}`,
      };
    } catch (err) {
      return {
        name: this.name,
        kind: 'WhisperTranscription',
        healthy: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
