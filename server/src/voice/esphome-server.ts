/**
 * ESPHome API TCP server — presents this device to Home Assistant as an
 * ESPHome voice satellite.
 *
 * HA connects on port 6053 (default), runs the ESPHome handshake, then
 * subscribes for voice assistant events.  We:
 *   1. Stream mic audio (via arecord) to HA for wake-word + STT processing
 *   2. Receive TTS audio streams back and play via mpv
 *   3. Handle announce requests (play a URL then ack)
 *
 * State machine per connection:
 *   INIT → HELLO → READY → SUBSCRIBED → STREAMING (continuous loop)
 */

import net from 'net';
import os from 'os';
import fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { FrameDecoder, encodeFrame } from './framing.js';
import { MicCapture } from './mic.js';
import {
  MSG,
  VA_FEATURE,
  VA_SUBSCRIBE_FLAG,
  VA_REQUEST_FLAG,
  VA_EVENT,
  decodeHelloRequest,
  decodeSubscribeVoiceAssistantRequest,
  decodeVoiceAssistantResponse,
  decodeVoiceAssistantEvent,
  decodeVoiceAssistantAudio,
  decodeVoiceAssistantAnnounceRequest,
  encodeHelloResponse,
  encodeDeviceInfoResponse,
  encodeEmpty,
  encodeVoiceAssistantRequest,
  encodeVoiceAssistantAudio,
  encodeVoiceAssistantAnnounceFinished,
  encodeVoiceAssistantConfigurationResponse,
} from './proto.js';

// ── Config ─────────────────────────────────────────────────────────────────

export interface EspHomeServerSettings {
  port: number;
  micDevice: string;
  friendlyName: string;  // shown in HA device UI
  wakeWord: string;      // e.g. 'hey_jarvis' or whatever is configured in HA
  ttsVolume: number;     // 0-100
}

// ── MAC address helper ─────────────────────────────────────────────────────

function getMacAddress(): string {
  for (const iface of ['eth0', 'wlan0', 'en0', 'enp3s0', 'wlp2s0']) {
    try {
      const mac = fs.readFileSync(`/sys/class/net/${iface}/address`, 'utf8').trim();
      if (mac && mac !== '00:00:00:00:00:00') return mac;
    } catch { /* try next */ }
  }
  // Fallback: use os.networkInterfaces
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const info of list ?? []) {
      if (!info.internal && info.mac && info.mac !== '00:00:00:00:00:00') {
        return info.mac;
      }
    }
  }
  return '00:00:00:00:00:01';
}

// ── TTS playback via mpv ───────────────────────────────────────────────────

function playUrl(url: string, volume: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const mpv = spawn('mpv', [
      '--no-video',
      '--really-quiet',
      `--volume=${volume}`,
      url,
    ], { stdio: 'ignore' });

    mpv.on('exit', (code) => {
      if (code === 0 || code === null) resolve();
      else reject(new Error(`mpv exited with code ${code}`));
    });
    mpv.on('error', reject);
  });
}

/** Write raw PCM S16_LE 16kHz mono to temp file and play via mpv */
function playPcmBuffer(pcm: Buffer, volume: number): Promise<void> {
  const tmp = `/tmp/canvas-tts-${Date.now()}.pcm`;
  fs.writeFileSync(tmp, pcm);
  return new Promise((resolve, reject) => {
    const mpv = spawn('mpv', [
      '--no-video',
      '--really-quiet',
      `--volume=${volume}`,
      '--demuxer=rawaudio',
      '--demuxer-rawaudio-format=s16le',
      '--demuxer-rawaudio-rate=16000',
      '--demuxer-rawaudio-channels=1',
      tmp,
    ], { stdio: 'ignore' });
    mpv.on('exit', (code) => {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      if (code === 0 || code === null) resolve();
      else reject(new Error(`mpv exited with code ${code}`));
    });
    mpv.on('error', (err) => {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      reject(err);
    });
  });
}

// ── Per-connection handler ─────────────────────────────────────────────────

type ConnState =
  | 'INIT'
  | 'HELLO'
  | 'READY'
  | 'SUBSCRIBED'
  | 'STREAMING'
  | 'ANNOUNCING'
  | 'CLOSED';

class VoiceConnection extends EventEmitter {
  private socket: net.Socket;
  private settings: EspHomeServerSettings;
  private decoder = new FrameDecoder();
  private state: ConnState = 'INIT';
  private mic: MicCapture | null = null;
  private ttsChunks: Buffer[] = [];
  private ttsUrlFromEvent: string | null = null;  // URL from TTS_END event (preferred over raw PCM)
  private mpvProc: ChildProcess | null = null;
  private conversationId = '';

  constructor(socket: net.Socket, settings: EspHomeServerSettings) {
    super();
    this.socket = socket;
    this.settings = settings;

    socket.on('data', (data) => this.decoder.push(data));
    socket.on('close', () => this.onClose());
    socket.on('error', (err) => {
      console.error('[voice] socket error:', err.message);
      this.onClose();
    });

    this.decoder.on('message', ({ msgType, payload }) => {
      this.handleMessage(msgType, payload);
    });
    this.decoder.on('error', (err) => {
      console.error('[voice] framing error:', err.message);
      socket.destroy();
    });
  }

  private send(msgType: number, protoBytes: Buffer): void {
    try {
      this.socket.write(encodeFrame(msgType, protoBytes));
    } catch (err) {
      console.error('[voice] send error:', err);
    }
  }

  private handleMessage(msgType: number, payload: Buffer): void {
    console.log(`[voice] → msgType=${msgType} state=${this.state}`);

    switch (msgType) {
      case MSG.HELLO_REQUEST: {
        const hello = decodeHelloRequest(payload);
        console.log(`[voice] Hello from HA: ${hello.clientInfo} v${hello.apiVersionMajor}.${hello.apiVersionMinor}`);
        const name = os.hostname();
        this.send(MSG.HELLO_RESPONSE, encodeHelloResponse('canvas-display 1.0', name));
        this.state = 'HELLO';
        break;
      }

      case MSG.DEVICE_INFO_REQUEST: {
        const mac = getMacAddress();
        this.send(MSG.DEVICE_INFO_RESPONSE, encodeDeviceInfoResponse({
          name: os.hostname(),
          macAddress: mac,
          friendlyName: this.settings.friendlyName,
          voiceAssistantFeatureFlags:
            VA_FEATURE.VOICE_ASSISTANT |   // 1 — basic VA support
            VA_FEATURE.API_AUDIO |         // 4 — audio via TCP
            VA_FEATURE.ANNOUNCE,           // 16 — triggers HA's _update_satellite_config() call
        }));
        this.state = 'READY';
        break;
      }

      case MSG.LIST_ENTITIES_REQUEST: {
        // We have no entities — immediately send done
        this.send(MSG.LIST_ENTITIES_DONE_RESPONSE, encodeEmpty());
        break;
      }

      case MSG.PING_REQUEST: {
        this.send(MSG.PING_RESPONSE, encodeEmpty());
        break;
      }

      case MSG.DISCONNECT_REQUEST: {
        this.send(MSG.DISCONNECT_RESPONSE, encodeEmpty());
        this.socket.end();
        break;
      }

      case MSG.SUBSCRIBE_STATES_REQUEST: {
        // Ignore — we have no state entities
        break;
      }

      case MSG.SUBSCRIBE_VOICE_ASSISTANT_REQUEST: {
        const sub = decodeSubscribeVoiceAssistantRequest(payload);
        if (!sub.subscribe) {
          this.stopMic();
          this.state = 'READY';
          return;
        }
        const wantsApiAudio = (sub.flags & VA_SUBSCRIBE_FLAG.API_AUDIO) !== 0;
        console.log(`[voice] SubscribeVoiceAssistant flags=${sub.flags} apiAudio=${wantsApiAudio}`);
        this.state = 'SUBSCRIBED';
        // Tell HA we want to start a voice pipeline using wake word + VAD
        this.startPipeline();
        break;
      }

      case MSG.VOICE_ASSISTANT_RESPONSE: {
        // HA acknowledges our VoiceAssistantRequest; port=0 means use TCP audio
        const resp = decodeVoiceAssistantResponse(payload);
        if (resp.error) {
          console.error('[voice] HA returned error on VoiceAssistantResponse — retrying in 5s');
          this.stopMic();
          setTimeout(() => {
            if (this.state !== 'CLOSED') this.startPipeline();
          }, 5000);
          return;
        }
        console.log(`[voice] Pipeline accepted by HA (port=${resp.port})`);
        this.state = 'STREAMING';
        this.startMic();
        break;
      }

      case MSG.VOICE_ASSISTANT_EVENT_RESPONSE: {
        const event = decodeVoiceAssistantEvent(payload);
        this.handleVoiceEvent(event.eventType, event.data);
        break;
      }

      case MSG.VOICE_ASSISTANT_AUDIO: {
        // TTS audio coming back from HA
        const audio = decodeVoiceAssistantAudio(payload);
        if (audio.data.length > 0) this.ttsChunks.push(audio.data);
        if (audio.end) {
          this.onTtsComplete();
        }
        break;
      }

      case MSG.VOICE_ASSISTANT_ANNOUNCE_REQUEST: {
        const ann = decodeVoiceAssistantAnnounceRequest(payload);
        this.handleAnnounce(ann.mediaId, ann.text, ann.startConversation);
        break;
      }

      case MSG.VOICE_ASSISTANT_CONFIGURATION_REQUEST: {
        const SUPPORTED_WAKE_WORDS: Array<{ id: string; label: string }> = [
          { id: 'okay_nabu',  label: 'Okay Nabu'  },
          { id: 'hey_jarvis', label: 'Hey Jarvis' },
        ];
        const active = this.settings.wakeWord || 'okay_nabu';
        this.send(MSG.VOICE_ASSISTANT_CONFIGURATION_RESPONSE, encodeVoiceAssistantConfigurationResponse({
          availableWakeWords: SUPPORTED_WAKE_WORDS.map(w => ({
            id: w.id,
            wakeWord: w.label,
            trainedLanguages: ['en'],
          })),
          activeWakeWords: [active],
          maxActiveWakeWords: 1,
        }));
        break;
      }

      default:
        console.log(`[voice] Unhandled msgType=${msgType}`);
    }
  }

  private startPipeline(): void {
    this.ttsChunks = [];
    this.ttsUrlFromEvent = null;
    this.conversationId = '';
    this.send(MSG.VOICE_ASSISTANT_REQUEST, encodeVoiceAssistantRequest({
      start: true,
      conversationId: '',
      flags: VA_REQUEST_FLAG.USE_WAKE_WORD | VA_REQUEST_FLAG.USE_VAD,
    }));
  }

  private startMic(): void {
    if (this.mic?.isRunning) return;
    this.mic = new MicCapture(this.settings.micDevice);
    this.mic.on('data', (chunk: Buffer) => {
      if (this.state === 'STREAMING') {
        this.send(MSG.VOICE_ASSISTANT_AUDIO, encodeVoiceAssistantAudio(chunk, false));
      }
    });
    this.mic.on('error', (err: Error) => {
      console.error('[voice] mic error:', err.message);
    });
    this.mic.on('close', () => {
      console.log('[voice] mic closed');
    });
    this.mic.start();
    console.log('[voice] Mic started, streaming to HA');
  }

  private stopMic(): void {
    if (this.mic) {
      this.mic.stop();
      this.mic = null;
    }
  }

  private handleVoiceEvent(eventType: number, data: Array<{name: string; value: string}>): void {
    const dataMap: Record<string, string> = {};
    for (const d of data) dataMap[d.name] = d.value;

    this.emit('voiceEvent', { eventType, data: dataMap });

    switch (eventType) {
      case VA_EVENT.WAKE_WORD_START:
        console.log('[voice] Wake word detection started');
        break;

      case VA_EVENT.WAKE_WORD_END:
        console.log('[voice] Wake word detected!');
        break;

      case VA_EVENT.STT_START:
        console.log('[voice] STT started — listening');
        // Stop sending mic audio? No — keep streaming; HA uses VAD to stop
        break;

      case VA_EVENT.STT_END:
        console.log('[voice] STT ended:', dataMap['text']);
        this.stopMic();
        break;

      case VA_EVENT.INTENT_START:
        console.log('[voice] Intent processing:', dataMap['intent_name']);
        break;

      case VA_EVENT.TTS_START:
        console.log('[voice] TTS started:', dataMap['tts_output']);
        this.ttsChunks = [];
        this.ttsUrlFromEvent = null;
        break;

      case VA_EVENT.TTS_STREAM_START:
        console.log('[voice] TTS audio stream starting');
        this.ttsChunks = [];
        this.ttsUrlFromEvent = null;
        break;

      case VA_EVENT.TTS_STREAM_END:
        // handled by VOICE_ASSISTANT_AUDIO with end=true
        break;

      case VA_EVENT.TTS_END: {
        // Some HA pipeline configurations send a media URL here instead of
        // streaming raw PCM via VoiceAssistantAudio
        const url = dataMap['url'];
        if (url) {
          console.log('[voice] TTS_END with URL — playing directly:', url);
          this.ttsUrlFromEvent = url;
          this.stopMic();
          playUrl(url, this.settings.ttsVolume)
            .catch(err => console.error('[voice] TTS URL playback error:', err))
            .finally(() => {
              if (this.state !== 'CLOSED') {
                this.state = 'SUBSCRIBED';
                this.startPipeline();
              }
            });
        }
        break;
      }

      case VA_EVENT.RUN_END:
        console.log('[voice] Pipeline run complete — restarting wake word');
        // Restart pipeline for next utterance
        setTimeout(() => {
          if (this.state !== 'CLOSED') {
            this.state = 'SUBSCRIBED';
            this.startPipeline();
          }
        }, 500);
        break;

      case VA_EVENT.ERROR:
        console.error('[voice] Pipeline error:', dataMap['code'], dataMap['message']);
        this.stopMic();
        setTimeout(() => {
          if (this.state !== 'CLOSED') {
            this.state = 'SUBSCRIBED';
            this.startPipeline();
          }
        }, 5000);
        break;
    }
  }

  private async onTtsComplete(): Promise<void> {
    // If HA already sent a URL via TTS_END and we played it, ignore any stray PCM
    if (this.ttsUrlFromEvent) return;
    if (this.ttsChunks.length === 0) return;
    const pcm = Buffer.concat(this.ttsChunks);
    this.ttsChunks = [];
    this.stopMic();

    console.log(`[voice] Playing TTS audio (${pcm.length} bytes PCM)`);
    try {
      await playPcmBuffer(pcm, this.settings.ttsVolume);
    } catch (err) {
      console.error('[voice] TTS playback error:', err);
    }
    // After TTS finishes, restart the pipeline
    if (this.state !== 'CLOSED') {
      this.state = 'SUBSCRIBED';
      this.startPipeline();
    }
  }

  private async handleAnnounce(mediaId: string, text: string, startConversation: boolean): Promise<void> {
    const prevState = this.state;
    this.state = 'ANNOUNCING';
    this.stopMic();
    console.log(`[voice] Announce: ${mediaId || text}`);

    try {
      if (mediaId) {
        await playUrl(mediaId, this.settings.ttsVolume);
      } else if (text) {
        // If only text provided, nothing to play (would need TTS synthesis)
        console.log('[voice] Announce text-only (no media_id) — skipping playback');
      }
      this.send(MSG.VOICE_ASSISTANT_ANNOUNCE_FINISHED, encodeVoiceAssistantAnnounceFinished(true));
    } catch (err) {
      console.error('[voice] Announce playback failed:', err);
      this.send(MSG.VOICE_ASSISTANT_ANNOUNCE_FINISHED, encodeVoiceAssistantAnnounceFinished(false));
    }

    if ((this.state as ConnState) !== 'CLOSED') {
      if (startConversation) {
        this.state = 'SUBSCRIBED';
        this.startPipeline();
      } else {
        this.state = prevState;
      }
    }
  }

  private onClose(): void {
    if (this.state === 'CLOSED') return;
    console.log('[voice] Connection closed');
    this.state = 'CLOSED';
    this.stopMic();
    this.emit('close');
  }

  destroy(): void {
    this.state = 'CLOSED';
    this.stopMic();
    try { this.socket.destroy(); } catch { /* ignore */ }
  }
}

// ── TCP server ─────────────────────────────────────────────────────────────

export class EspHomeServer extends EventEmitter {
  private server: net.Server | null = null;
  private connections = new Set<VoiceConnection>();
  private settings: EspHomeServerSettings;

  constructor(settings: EspHomeServerSettings) {
    super();
    this.settings = settings;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        console.log(`[voice] HA connected from ${socket.remoteAddress}`);
        const conn = new VoiceConnection(socket, this.settings);
        this.connections.add(conn);
        conn.on('close', () => this.connections.delete(conn));
        conn.on('voiceEvent', (event) => this.emit('voiceEvent', event));
      });

      this.server.on('error', (err) => {
        console.error('[voice] server error:', err);
        this.emit('error', err);
      });

      this.server.listen(this.settings.port, '0.0.0.0', () => {
        console.log(`[voice] ESPHome voice server listening on port ${this.settings.port}`);
        resolve();
      });

      (this.server as any).once('error', reject);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      for (const conn of this.connections) conn.destroy();
      this.connections.clear();
      if (this.server) {
        this.server.close(() => resolve());
        this.server = null;
      } else {
        resolve();
      }
    });
  }

  updateSettings(settings: Partial<EspHomeServerSettings>): void {
    Object.assign(this.settings, settings);
    console.log('[voice] Settings updated');
  }
}
