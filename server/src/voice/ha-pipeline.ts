/**
 * HA Assist Pipeline — connects outbound to HA's native WebSocket API.
 *
 * Wake word detection runs LOCALLY via Python openWakeWord (wakeword-local.ts).
 * Once the wake word fires, the pipeline starts at the 'stt' stage on HA.
 * HA only needs faster-whisper + piper — no openWakeWord add-on required.
 *
 * Audio flow:
 *   Mic (parec/arecord, runs continuously)
 *     wake_word state: mic audio -> Python OWW process (local detection)
 *     stt state:       mic audio -> HA WebSocket binary frames
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { MicCapture } from './mic.js';
import { WakeWordDetector } from './wakeword-local.js';

export interface HAPipelineSettings {
  haUrl: string;
  haToken: string;
  micDevice: string;
  wakeWord: string;
  ttsVolume: number;
  pipelineId: string;
}

type ConnState = 'idle' | 'connecting' | 'authenticating' | 'ready' | 'closed';
type VoiceState = 'wake_word' | 'stt';

export class HAPipeline extends EventEmitter {
  private settings: HAPipelineSettings;
  private ws: WebSocket | null = null;
  private mic: MicCapture | null = null;
  private wwd: WakeWordDetector | null = null;
  private connState: ConnState = 'idle';
  private voiceState: VoiceState = 'wake_word';
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
    this.stopWakeWord();
    await this.stopMic();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connState = 'closed';
  }

  private wsUrl(): string {
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

  private connect(): void {
    if (this.destroyed) return;
    this.connState = 'connecting';
    console.log('[voice] Connecting to HA at', this.wsUrl());

    const ws = new WebSocket(this.wsUrl(), { rejectUnauthorized: false });
    this.ws = ws;

    ws.on('open', () => { this.reconnectDelay = 2000; });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      try {
        this.handleMessage(JSON.parse(data.toString()));
      } catch (err) {
        console.error('[voice] WS message parse error:', err);
      }
    });

    ws.on('close', () => {
      if (this.connState === 'closed') return;
      console.log('[voice] HA WS disconnected — reconnecting in', this.reconnectDelay, 'ms');
      this.stopWakeWord();
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

  private handleMessage(msg: any): void {
    if (msg.type === 'auth_required') {
      this.connState = 'authenticating';
      this.sendJson({ type: 'auth', access_token: this.settings.haToken });
      return;
    }

    if (msg.type === 'auth_ok') {
      console.log('[voice] HA authenticated (core', msg.ha_version, ')');
      this.connState = 'ready';
      console.log('[voice] Voice assistant started — HA:', this.settings.haUrl);
      console.log('[voice] Mic:', this.settings.micDevice, '| Wake word:', this.settings.wakeWord);
      this.startWakeWordPhase();
      return;
    }

    if (msg.type === 'auth_invalid') {
      console.error('[voice] HA auth failed — check token in Settings');
      setTimeout(() => { if (!this.destroyed) this.scheduleReconnect(); }, 30_000);
      return;
    }

    if (msg.type === 'result' && msg.id === this.runId) {
      if (!msg.success) {
        const code: string = msg.error?.code ?? 'unknown';
        console.error('[voice] Pipeline start failed:', JSON.stringify(msg.error));
        const delay = code === 'invalid_format' ? 30_000 : 3000;
        setTimeout(() => { if (!this.destroyed) this.startWakeWordPhase(); }, delay);
      }
      return;
    }

    if (msg.type === 'event' && msg.id === this.runId) {
      this.handlePipelineEvent(msg.event);
    }
  }

  // ── Wake word phase: mic audio -> local Python OWW ─────────────────────────

  private startWakeWordPhase(): void {
    if (this.destroyed) return;
    this.voiceState = 'wake_word';
    this.binaryHandlerId = 0;

    // Mic runs continuously for the lifetime of the pipeline
    if (!this.mic) {
      const mic = new MicCapture(this.settings.micDevice);
      this.mic = mic;
      mic.on('data',  (chunk: Buffer) => this.onMicData(chunk));
      mic.on('error', (err: Error)    => console.error('[voice] Mic error:', err.message));
      mic.on('close', (code: number | null) => {
        if (!this.destroyed && this.mic === mic) {
          console.warn('[voice] Mic closed unexpectedly (code', code, ')');
          this.mic = null;
          this.stopWakeWord();
          setTimeout(() => { if (!this.destroyed) this.startWakeWordPhase(); }, 2000);
        }
      });
      mic.start();
    }

    this.stopWakeWord();
    const wwd = new WakeWordDetector(this.settings.wakeWord);
    this.wwd = wwd;

    wwd.on('ready', () => {
      console.log('[voice] Wake word detection active (local OWW)...');
    });

    wwd.on('detected', () => {
      console.log('[voice] Wake word detected! Starting STT pipeline...');
      this.stopWakeWord();
      this.runSttPipeline();
    });

    wwd.on('error', (err: Error) => {
      const msg = err.message ?? '';
      console.error('[voice] Wake word error:', msg);
      const delay = msg.includes('not installed') ? 60_000 : 5000;
      setTimeout(() => { if (!this.destroyed) this.startWakeWordPhase(); }, delay);
    });

    wwd.on('close', (code: number | null) => {
      if (!this.destroyed && this.wwd === wwd && this.voiceState === 'wake_word') {
        console.warn('[voice] Wake word process closed (code', code, ') — restarting...');
        this.wwd = null;
        setTimeout(() => { if (!this.destroyed) this.startWakeWordPhase(); }, 2000);
      }
    });

    wwd.start();
  }

  private stopWakeWord(): void {
    if (this.wwd) {
      this.wwd.removeAllListeners();
      this.wwd.stop();
      this.wwd = null;
    }
  }

  // ── STT pipeline phase: mic audio -> HA WebSocket ─────────────────────────

  private runSttPipeline(): void {
    if (this.destroyed || !this.ws || this.connState !== 'ready') return;
    this.voiceState = 'stt';
    this.runId = this.msgId++;
    this.binaryHandlerId = 0;

    const msg: Record<string, unknown> = {
      id:          this.runId,
      type:        'assist_pipeline/run',
      start_stage: 'stt',
      end_stage:   'tts',
      input: { sample_rate: 16000 },
    };

    if (this.settings.pipelineId) {
      msg.pipeline = this.settings.pipelineId;
    }

    this.sendJson(msg);
    console.log('[voice] Pipeline run', this.runId, 'started at STT stage');
  }

  // ── Mic data router ────────────────────────────────────────────────────────

  private onMicData(chunk: Buffer): void {
    if (this.voiceState === 'wake_word' && this.wwd) {
      this.wwd.feed(chunk);
    } else if (this.voiceState === 'stt' && this.binaryHandlerId > 0 && this.ws?.readyState === WebSocket.OPEN) {
      const frame = Buffer.allocUnsafe(1 + chunk.length);
      frame[0] = this.binaryHandlerId;
      chunk.copy(frame, 1);
      this.ws.send(frame);
    }
  }

  // ── Pipeline event handling ────────────────────────────────────────────────

  private handlePipelineEvent(event: { type: string; data?: any }): void {
    const { type, data } = event;
    this.emit('voiceEvent', { type, data });

    switch (type) {
      case 'run-start':
        this.binaryHandlerId = data?.runner_data?.stt_binary_handler_id ?? 1;
        console.log('[voice] run-start, binary handler_id =', this.binaryHandlerId, '— streaming to HA STT');
        break;

      case 'stt-start':
        console.log('[voice] STT listening...');
        break;

      case 'stt-vad-start':
        console.log('[voice] Speech started');
        break;

      case 'stt-vad-end':
        console.log('[voice] Speech ended');
        break;

      case 'stt-end':
        console.log('[voice] Transcript:', data?.stt_output?.text ?? '(empty)');
        break;

      case 'intent-end':
        console.log('[voice] Intent:', data?.intent_output?.response?.speech?.plain?.speech ?? '(no speech)');
        break;

      case 'tts-end': {
        const url: string | undefined = data?.tts_output?.url;
        if (url) {
          const fullUrl = url.startsWith('http') ? url : this.settings.haUrl.replace(/\/$/, '') + url;
          console.log('[voice] TTS ->', fullUrl);
          this.playTts(fullUrl);
        }
        break;
      }

      case 'run-end':
        console.log('[voice] Pipeline run ended — returning to wake word detection');
        this.startWakeWordPhase();
        break;

      case 'error': {
        const code: string = data?.code ?? 'unknown';
        const message: string = data?.message ?? '';
        console.error('[voice] Pipeline error [' + code + ']:', message);
        setTimeout(() => {
          if (!this.destroyed) this.startWakeWordPhase();
        }, code === 'stt-no-text-recognized' ? 500 : 2000);
        break;
      }

      default:
        break;
    }
  }

  // ── Mic stop ───────────────────────────────────────────────────────────────

  private async stopMic(): Promise<void> {
    if (!this.mic) return;
    const mic = this.mic;
    this.mic = null;
    await mic.stop();
  }

  // ── TTS playback ───────────────────────────────────────────────────────────

  private playTts(url: string): void {
    const vol = Math.max(0, Math.min(100, this.settings.ttsVolume));
    const mpv = spawn('mpv', ['--no-video', '--really-quiet', '--volume=' + vol, url], {
      stdio: 'ignore',
      detached: false,
    });
    mpv.on('error', (err) => console.error('[voice] mpv error:', err.message));
    mpv.on('exit',  (code) => {
      if (code !== 0 && code !== null) console.error('[voice] mpv exited with code', code);
    });
  }
}
