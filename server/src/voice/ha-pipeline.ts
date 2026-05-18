/**
 * HA Assist Pipeline — connects outbound to HA's native WebSocket API and
 * runs the assist_pipeline starting at the wake_word stage.
 *
 * Replaces the ESPHome TCP satellite. We connect TO HA instead of waiting
 * for HA to connect to us.
 *
 * Cycle per invocation:
 *   1. WebSocket connect + auth to HA
 *   2. assist_pipeline/run { start_stage: 'wake_word', end_stage: 'tts' }
 *   3. run-start  → get stt_binary_handler_id → start mic → stream audio
 *   4. wake_word-end → wake word detected (optional chime)
 *   5. stt-end    → transcript received → stop mic
 *   6. tts-end    → TTS URL → play via mpv
 *   7. run-end    → back to step 2 (new pipeline run)
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { MicCapture } from './mic.js';

export interface HAPipelineSettings {
  haUrl: string;        // e.g. 'http://192.168.1.103:8123'
  haToken: string;      // long-lived access token
  micDevice: string;    // ALSA device  e.g. 'plughw:4,0' or 'default'
  wakeWord: string;     // informational — OWW on HA side handles it
  ttsVolume: number;    // 0-100
  pipelineId: string;   // optional — empty string uses HA default pipeline
}

type ConnState = 'idle' | 'connecting' | 'authenticating' | 'ready' | 'closed';

export class HAPipeline extends EventEmitter {
  private settings: HAPipelineSettings;
  private ws: WebSocket | null = null;
  private mic: MicCapture | null = null;
  private connState: ConnState = 'idle';
  private msgId = 1;
  private runId = 0;
  private binaryHandlerId = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = 2000;
  private destroyed = false;

  constructor(settings: HAPipelineSettings) {
    super();
    this.settings = { ...settings };
  }

  updateSettings(settings: Partial<HAPipelineSettings>): void {
    Object.assign(this.settings, settings);
  }

  start(): void {
    this.destroyed = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.destroyed = true;
    this.clearReconnect();
    await this.stopMic(); // wait for arecord to fully exit before returning
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connState = 'closed';
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private wsUrl(): string {
    // Convert http(s):// → ws(s)://  and append the HA WS path
    return this.settings.haUrl
      .replace(/\/$/, '')
      .replace(/^http/, 'ws') + '/api/websocket';
  }

  private sendJson(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    this.clearReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30_000);
      this.connect();
    }, this.reconnectDelay);
  }

  // ── WebSocket connection ───────────────────────────────────────────────────

  private connect(): void {
    if (this.destroyed) return;
    this.connState = 'connecting';
    console.log('[voice] Connecting to HA at', this.wsUrl());

    const ws = new WebSocket(this.wsUrl(), { rejectUnauthorized: false });
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectDelay = 2000; // reset backoff on successful connect
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return; // HA only sends JSON over the WS API
      try {
        this.handleMessage(JSON.parse(data.toString()));
      } catch (err) {
        console.error('[voice] WS message parse error:', err);
      }
    });

    ws.on('close', () => {
      if (this.connState === 'closed') return;
      console.log('[voice] HA WS disconnected — reconnecting in', this.reconnectDelay, 'ms');
      this.stopMic().catch(() => {}).finally(() => {
        this.ws = null;
        this.connState = 'idle';
        this.scheduleReconnect();
      });
    });

    ws.on('error', (err) => {
      console.error('[voice] HA WS error:', (err as Error).message);
    });
  }

  // ── Message handling ───────────────────────────────────────────────────────

  private handleMessage(msg: any): void {
    // Auth flow
    if (msg.type === 'auth_required') {
      this.connState = 'authenticating';
      this.sendJson({ type: 'auth', access_token: this.settings.haToken });
      return;
    }

    if (msg.type === 'auth_ok') {
      console.log('[voice] HA authenticated (core', msg.ha_version, ') — starting pipeline');
      this.connState = 'ready';
      this.runPipeline();
      return;
    }

    if (msg.type === 'auth_invalid') {
      console.error('[voice] HA auth failed — check the long-lived access token in Settings');
      // Don't reconnect immediately — bad token won't self-heal
      setTimeout(() => {
        if (!this.destroyed) this.scheduleReconnect();
      }, 30_000);
      return;
    }

    // Pipeline result (success/error for the initial run command)
    if (msg.type === 'result' && msg.id === this.runId) {
      if (!msg.success) {
        const code: string = msg.error?.code ?? 'unknown';
        const message: string = msg.error?.message ?? '';
        console.error('[voice] Pipeline start failed:', JSON.stringify(msg.error));
        // invalid_format = bad request we sent — don't retry instantly, back off
        const delay = code === 'invalid_format' ? 30_000 : 3000;
        setTimeout(() => { if (!this.destroyed) this.runPipeline(); }, delay);
      }
      return;
    }

    // Pipeline events
    if (msg.type === 'event' && msg.id === this.runId) {
      this.handlePipelineEvent(msg.event);
    }
  }

  // ── Pipeline run lifecycle ─────────────────────────────────────────────────

  private runPipeline(): void {
    if (this.destroyed || !this.ws || this.connState !== 'ready') return;
    this.runId = this.msgId++;
    this.binaryHandlerId = 0;
    // Stop mic first (await device release), then fire the pipeline command
    this.stopMic().then(() => {
      if (this.destroyed || !this.ws || this.connState !== 'ready') return;

      const input: Record<string, unknown> = {
          timeout: 3600,          // 1 hour — pipeline stays alive, auto-restarts on timeout
          sample_rate: 16000,
          noise_suppression_level: 2,
          auto_gain_dbfs: 15,
        };

      // Tell HA which wake word to listen for — phrase uses spaces not underscores
      if (this.settings.wakeWord) {
        input.wake_word_phrase = this.settings.wakeWord.replace(/_/g, ' ');
      }

      const msg: Record<string, unknown> = {
        id: this.runId,
        type: 'assist_pipeline/run',
        start_stage: 'wake_word',
        end_stage: 'tts',
        input,
      };

      if (this.settings.pipelineId) {
        msg.pipeline = this.settings.pipelineId;
      }

      this.sendJson(msg);
      console.log('[voice] Pipeline run', this.runId, 'started — waiting for wake word');
    }).catch(() => {});
  }

  private handlePipelineEvent(event: { type: string; data?: any }): void {
    const { type, data } = event;
    this.emit('voiceEvent', { type, data });

    switch (type) {
      case 'run-start': {
        // stt_binary_handler_id is under runner_data
        this.binaryHandlerId = data?.runner_data?.stt_binary_handler_id ?? 1;
        console.log('[voice] run-start, binary handler_id =', this.binaryHandlerId);
        this.startMic();
        break;
      }

      case 'wake_word-start':
        console.log('[voice] Wake word detection active...');
        break;

      case 'wake_word-end':
        console.log('[voice] Wake word detected! Listening for speech...');
        break;

      case 'stt-start':
        console.log('[voice] STT listening...');
        break;

      case 'stt-vad-start':
        console.log('[voice] Speech started');
        break;

      case 'stt-vad-end':
        // End of speech — HA has all audio it needs; stop mic to free resource
        console.log('[voice] Speech ended');
        this.stopMic().catch(() => {});
        break;

      case 'stt-end':
        console.log('[voice] Transcript:', data?.stt_output?.text ?? '(empty)');
        this.stopMic().catch(() => {});
        break;

      case 'intent-start':
        break;

      case 'intent-end':
        console.log('[voice] Intent:', data?.intent_output?.response?.speech?.plain?.speech ?? '(no speech)');
        break;

      case 'tts-start':
        break;

      case 'tts-end': {
        const url: string | undefined = data?.tts_output?.url;
        if (url) {
          const fullUrl = url.startsWith('http') ? url : this.settings.haUrl.replace(/\/$/, '') + url;
          console.log('[voice] TTS →', fullUrl);
          this.playTts(fullUrl);
        }
        break;
      }

      case 'run-end':
        console.log('[voice] Pipeline run ended — restarting');
        this.stopMic().then(() => { if (!this.destroyed) this.runPipeline(); }).catch(() => {});
        break;

      case 'error': {
        const code: string = data?.code ?? 'unknown';
        const message: string = data?.message ?? '';
        if (code === 'wake-word-timeout') {
          // Normal — no one spoke for `timeout` seconds; just restart
          console.log('[voice] Wake word timeout — restarting pipeline');
          this.stopMic().then(() => { if (!this.destroyed) this.runPipeline(); }).catch(() => {});
        } else {
          console.error(`[voice] Pipeline error [${code}]:`, message);
          this.stopMic().then(() => {
            if (!this.destroyed) setTimeout(() => this.runPipeline(), 3000);
          }).catch(() => {});
        }
        break;
      }

      default:
        break;
    }
  }

  // ── Mic streaming ──────────────────────────────────────────────────────────

  private startMic(): void {
    if (this.mic) return; // already running
    const mic = new MicCapture(this.settings.micDevice);
    this.mic = mic;

    mic.on('data', (chunk: Buffer) => {
      if (this.binaryHandlerId > 0 && this.ws?.readyState === WebSocket.OPEN) {
        // Prefix every chunk with the handler_id byte as required by HA's WS API
        const frame = Buffer.allocUnsafe(1 + chunk.length);
        frame[0] = this.binaryHandlerId;
        chunk.copy(frame, 1);
        this.ws.send(frame);
      }
    });

    mic.on('error', (err: Error) => {
      console.error('[voice] Mic error:', err.message);
    });

    mic.start();
    console.log('[voice] Mic streaming started (device:', this.settings.micDevice, ')');
  }

  private async stopMic(): Promise<void> {
    if (!this.mic) return;
    const mic = this.mic;
    this.mic = null;
    await mic.stop();
  }

  // ── TTS playback ───────────────────────────────────────────────────────────

  private playTts(url: string): void {
    const vol = Math.max(0, Math.min(100, this.settings.ttsVolume));
    const mpv = spawn('mpv', ['--no-video', '--really-quiet', `--volume=${vol}`, url], {
      stdio: 'ignore',
      detached: false,
    });
    mpv.on('error', (err) => console.error('[voice] mpv error:', err.message));
    mpv.on('exit', (code) => {
      if (code !== 0 && code !== null) console.error('[voice] mpv exited with code', code);
    });
  }
}
