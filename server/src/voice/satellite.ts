/**
 * Voice Satellite Process — ESPHome-compatible satellite for HA voice assistant.
 *
 * Spawns a Python process that listens on TCP port 6053 using the ESPHome
 * native API protocol.  HA connects TO the satellite (reverse of the old
 * WebSocket-client approach).
 *
 * Architecture (OHF-Voice/linux-voice-assistant method):
 *   HA ──ESPHome TCP──> Satellite (port 6053)
 *   Satellite runs local OWW wake word detection
 *   On wake: satellite sends VoiceAssistantRequest → HA starts STT pipeline
 *   Satellite streams VoiceAssistantAudio → HA handles STT / intent / TTS
 *   HA sends VoiceAssistantEventResponse back (tts_end with URL)
 *   Satellite plays TTS via mpv
 *
 * In HA: Settings → Devices & Services → Add Integration → ESPHome
 *   Host: <this machine's IP>   Port: 6053
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { existsSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

export interface SatelliteSettings {
  port: number;
  name: string;
  friendlyName: string;
  micDevice: string;
  wakeWord: string;
  ttsVolume: number;
}

/** Prefer the canvas-display OWW venv if present, fall back to system python3. */
function findPython3(): string {
  const venvPy = join(homedir(), '.venv', 'oww', 'bin', 'python3');
  if (existsSync(venvPy)) return venvPy;
  return 'python3';
}

// ---------------------------------------------------------------------------
// Embedded Python satellite script.
// Implements the ESPHome native API protocol (server side) with:
//   - Local wake word detection via openWakeWord
//   - Audio streaming via VoiceAssistantAudio protobuf messages
//   - TTS playback via mpv
// ---------------------------------------------------------------------------
const SATELLITE_PY = `
#!/usr/bin/env python3
"""
Canvas Display Voice Satellite
ESPHome-compatible TCP server for HA voice assistant integration.
HA connects to this satellite using the ESPHome native API protocol.
"""

import argparse
import asyncio
import glob
import logging
import os
import subprocess
import sys
import threading
import time
from typing import Optional

import numpy as np

# ── openWakeWord ──────────────────────────────────────────────────────────────
try:
    import openwakeword
    from openwakeword.model import Model as OWWModel
    _OWW_OK = True
except ImportError:
    _OWW_OK = False
    OWWModel = None

# ── aioesphomeapi (protobuf types + MESSAGE_TYPE_TO_PROTO mapping) ─────────────
try:
    from aioesphomeapi.api_pb2 import (  # type: ignore[attr-defined]
        AuthenticationRequest, AuthenticationResponse,
        DeviceInfoRequest, DeviceInfoResponse,
        DisconnectRequest, DisconnectResponse,
        HelloRequest, HelloResponse,
        ListEntitiesDoneResponse, ListEntitiesRequest,
        PingRequest, PingResponse,
        SubscribeHomeAssistantStatesRequest,
        VoiceAssistantAnnounceFinished, VoiceAssistantAnnounceRequest,
        VoiceAssistantAudio,
        VoiceAssistantConfigurationRequest, VoiceAssistantConfigurationResponse,
        VoiceAssistantEventResponse,
        VoiceAssistantRequest, VoiceAssistantSetConfiguration,
        VoiceAssistantWakeWord,
    )
    from aioesphomeapi.core import MESSAGE_TYPE_TO_PROTO  # type: ignore[attr-defined]
    _ESPHOME_OK = True
except ImportError as _imp_err:
    print(f"error: aioesphomeapi not installed ({_imp_err}). "
          "Run: ~/.venv/oww/bin/pip install aioesphomeapi", file=sys.stderr, flush=True)
    sys.exit(2)

_LOGGER = logging.getLogger(__name__)

# Reverse map: proto class → message type integer
PROTO_TO_MSG_TYPE = {v: k for k, v in MESSAGE_TYPE_TO_PROTO.items()}

# ── ESPHome feature flags (bitmask in DeviceInfoResponse) ─────────────────────
# VOICE_ASSISTANT=1, API_AUDIO=4, ANNOUNCE=16
# API_AUDIO is critical: audio streams over the API connection (not UDP)
try:
    from aioesphomeapi.model import VoiceAssistantFeature  # type: ignore[attr-defined]
    _FEATURES = int(
        VoiceAssistantFeature.VOICE_ASSISTANT
        | VoiceAssistantFeature.API_AUDIO
        | VoiceAssistantFeature.ANNOUNCE
    )
except (ImportError, AttributeError):
    _FEATURES = 1 | 4 | 16  # hardcoded fallback

# ── VoiceAssistantEventType integer values (from ESPHome api.proto) ───────────
_EVT_ERROR        = 0
_EVT_RUN_START    = 1
_EVT_RUN_END      = 2
_EVT_STT_START    = 3
_EVT_STT_END      = 4
_EVT_INTENT_START = 5
_EVT_INTENT_END   = 6
_EVT_TTS_START    = 7
_EVT_TTS_END      = 8
_EVT_STT_VAD_END  = 12
_EVT_TIMED_OUT    = 98

# ── Audio constants ────────────────────────────────────────────────────────────
_SAMPLE_RATE   = 16000
_CHANNELS      = 1
_SAMPLE_WIDTH  = 2       # int16 = 2 bytes
_CHUNK_SAMPLES = 1280    # 80 ms @ 16 kHz — OWW recommended window
_CHUNK_BYTES   = _CHUNK_SAMPLES * _CHANNELS * _SAMPLE_WIDTH

# ── ESPHome framing helpers ───────────────────────────────────────────────────

def _enc_varuint(value: int) -> bytes:
    buf = bytearray()
    while True:
        b = value & 0x7F
        value >>= 7
        if value:
            buf.append(b | 0x80)
        else:
            buf.append(b)
            break
    return bytes(buf)


def _make_frame(msg_type: int, data: bytes) -> bytes:
    return b"\\x00" + _enc_varuint(len(data)) + _enc_varuint(msg_type) + data


def _dec_varuint(buf: bytes, pos: int) -> "tuple[int, int]":
    """Returns (value, new_pos). Returns (-1, pos) if not enough data."""
    result, shift = 0, 0
    while pos < len(buf):
        b = buf[pos]
        result |= (b & 0x7F) << shift
        pos += 1
        if not (b & 0x80):
            return result, pos
        shift += 7
    return -1, pos

# ── Wake word model helpers ────────────────────────────────────────────────────

def _find_model(name: str) -> "Optional[str]":
    """Locate an OWW .tflite / .onnx model file by wake-word name."""
    try:
        res = os.path.join(os.path.dirname(openwakeword.__file__), "resources", "models")
    except Exception:
        return None
    # Also try the ok_nabu alias for okay_nabu
    for candidate in (name, name.replace("okay_", "ok_")):
        for ext in (".tflite", ".onnx"):
            p = os.path.join(res, candidate + ext)
            if os.path.exists(p):
                return p
            for p in sorted(glob.glob(os.path.join(res, candidate + "_v*" + ext)), reverse=True):
                return p
    return None

# ── Voice satellite protocol ───────────────────────────────────────────────────

class VoiceSatellite(asyncio.Protocol):
    """One instance per HA TCP connection."""

    def __init__(self, config: argparse.Namespace) -> None:
        self.config = config
        self._transport: Optional[asyncio.Transport] = None
        self._buf = bytearray()
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._loop_tid: Optional[int] = None

        # Voice state (asyncio loop thread only)
        self._streaming       = False   # True → mic thread sends VoiceAssistantAudio
        self._pipeline_active = False   # True → ignore new wake words
        self._tts_proc: Optional[subprocess.Popen] = None

        # Mic / wake word (background thread)
        self._mic_proc:        Optional[subprocess.Popen]  = None
        self._mic_thread:      Optional[threading.Thread]  = None
        self._oww:             Optional[OWWModel]           = None
        self._wake_word_active = True
        self._active_wake_word = config.wake_word

    # ── asyncio.Protocol ───────────────────────────────────────────────────────

    def connection_made(self, transport: asyncio.Transport) -> None:  # type: ignore[override]
        self._transport = transport
        self._loop     = asyncio.get_running_loop()
        self._loop_tid = threading.get_ident()
        peer = transport.get_extra_info("peername", "?")
        _LOGGER.info("HA connected from %s", peer)
        self._mic_thread = threading.Thread(target=self._mic_loop, daemon=True, name="mic-oww")
        self._mic_thread.start()

    def data_received(self, data: bytes) -> None:
        self._buf.extend(data)
        self._parse()

    def connection_lost(self, exc: Optional[Exception]) -> None:
        if exc:
            _LOGGER.warning("HA disconnected: %s", exc)
        else:
            _LOGGER.info("HA disconnected")
        self._transport        = None
        self._streaming        = False
        self._pipeline_active  = False
        self._wake_word_active = False  # signals mic thread to exit
        if self._mic_proc:
            try:
                self._mic_proc.kill()
            except Exception:
                pass
            self._mic_proc = None
        if self._tts_proc:
            try:
                self._tts_proc.kill()
            except Exception:
                pass
            self._tts_proc = None

    # ── ESPHome framing ────────────────────────────────────────────────────────

    def _parse(self) -> None:
        while len(self._buf) >= 3:
            if self._buf[0] != 0x00:
                _LOGGER.error("Bad ESPHome preamble: 0x%02x", self._buf[0])
                self._buf.clear()
                return
            pos = 1
            length, pos = _dec_varuint(self._buf, pos)
            if length == -1:
                return
            msg_type, pos = _dec_varuint(self._buf, pos)
            if msg_type == -1:
                return
            if len(self._buf) < pos + length:
                return
            packet = bytes(self._buf[pos: pos + length])
            del self._buf[: pos + length]
            self._dispatch(msg_type, packet)

    def _send(self, msg) -> None:
        if self._transport is None:
            return
        mt = PROTO_TO_MSG_TYPE.get(msg.__class__)
        if mt is None:
            return
        frame = _make_frame(mt, msg.SerializeToString())
        if threading.get_ident() != self._loop_tid and self._loop:
            self._loop.call_soon_threadsafe(self._transport.write, frame)
        else:
            self._transport.write(frame)

    def _send_from_thread(self, msg) -> None:
        """Thread-safe send from outside the asyncio loop."""
        if self._transport is None or self._loop is None:
            return
        mt = PROTO_TO_MSG_TYPE.get(msg.__class__)
        if mt is None:
            return
        frame = _make_frame(mt, msg.SerializeToString())
        self._loop.call_soon_threadsafe(self._transport.write, frame)

    # ── Message dispatch ───────────────────────────────────────────────────────

    def _dispatch(self, msg_type: int, data: bytes) -> None:
        cls = MESSAGE_TYPE_TO_PROTO.get(msg_type)
        if cls is None:
            _LOGGER.debug("Unknown msg_type=%d — ignoring", msg_type)
            return
        msg = cls.FromString(data)

        if isinstance(msg, HelloRequest):
            self._send(HelloResponse(api_version_major=1, api_version_minor=10, name=self.config.name))

        elif isinstance(msg, AuthenticationRequest):
            self._send(AuthenticationResponse())
            _LOGGER.info("Authenticated — satellite ready")

        elif isinstance(msg, DisconnectRequest):
            self._send(DisconnectResponse())
            if self._transport:
                self._transport.close()

        elif isinstance(msg, PingRequest):
            self._send(PingResponse())

        elif isinstance(msg, DeviceInfoRequest):
            self._send(DeviceInfoResponse(
                uses_password=False,
                name=self.config.name,
                friendly_name=self.config.friendly_name,
                project_name="Canvas Display.Voice Satellite",
                project_version="1.0.0",
                esphome_version="2024.6.0",
                mac_address=self.config.mac,
                manufacturer="Canvas Display",
                model="Voice Satellite",
                voice_assistant_feature_flags=_FEATURES,
            ))

        elif isinstance(msg, (ListEntitiesRequest, SubscribeHomeAssistantStatesRequest)):
            self._send(ListEntitiesDoneResponse())

        elif isinstance(msg, VoiceAssistantConfigurationRequest):
            _LOGGER.info("VoiceAssistantConfigurationRequest — sending config")
            ww_id = self._active_wake_word
            self._send(VoiceAssistantConfigurationResponse(
                available_wake_words=[VoiceAssistantWakeWord(
                    id=ww_id,
                    wake_word=ww_id.replace("_", " "),
                    trained_languages=["en"],
                )],
                active_wake_words=[ww_id],
                max_active_wake_words=1,
            ))
            _LOGGER.info("Configuration handshake complete — satellite active")

        elif isinstance(msg, VoiceAssistantSetConfiguration):
            if msg.active_wake_words:
                self._active_wake_word = msg.active_wake_words[0]
                _LOGGER.info("Active wake word: %s", self._active_wake_word)

        elif isinstance(msg, VoiceAssistantEventResponse):
            self._handle_voice_event(msg)

        elif isinstance(msg, VoiceAssistantAnnounceRequest):
            self._handle_announce(msg)

    # ── HA pipeline events ─────────────────────────────────────────────────────

    def _handle_voice_event(self, msg: VoiceAssistantEventResponse) -> None:
        et = msg.event_type
        data = {item.name: item.value for item in msg.data}
        _LOGGER.debug("Pipeline event: type=%d data=%s", et, data)

        if et in (_EVT_STT_VAD_END, _EVT_STT_END):
            # Speech ended — stop streaming mic audio
            self._streaming = False
            _LOGGER.debug("Speech ended — audio stream stopped")

        elif et == _EVT_TTS_END:
            url = data.get("url", "")
            if url:
                _LOGGER.info("TTS -> %s", url)
                self._play_tts(url)

        elif et == _EVT_RUN_END:
            self._streaming = False
            self._pipeline_active = False
            self._wake_word_active = True
            _LOGGER.info("Pipeline ended — wake word detection active")

        elif et == _EVT_TIMED_OUT:
            self._streaming = False
            self._pipeline_active = False
            self._wake_word_active = True
            _LOGGER.warning("Pipeline timed out — resuming wake word detection")

        elif et == _EVT_ERROR:
            code = data.get("code", "?")
            message = data.get("message", "")
            _LOGGER.error("Pipeline error [%s]: %s", code, message)
            self._streaming = False
            self._pipeline_active = False
            self._wake_word_active = True

    def _handle_announce(self, msg: VoiceAssistantAnnounceRequest) -> None:
        urls = [u for u in (msg.preannounce_media_id, msg.media_id) if u]
        _LOGGER.info("Announce: %s", urls)

        def _play() -> None:
            vol = self.config.tts_volume
            for url in urls:
                p = subprocess.Popen(
                    ["mpv", "--no-video", "--really-quiet", f"--volume={vol}", url],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
                p.wait()
            if self._loop:
                self._loop.call_soon_threadsafe(lambda: self._send(VoiceAssistantAnnounceFinished()))

        threading.Thread(target=_play, daemon=True).start()

    # ── Mic + wake word (background thread) ────────────────────────────────────

    def _mic_loop(self) -> None:
        """Mic capture + OWW inference running in a background thread."""
        if not _OWW_OK:
            _LOGGER.error("openwakeword not available — wake word detection disabled")
            return

        # Load OWW model
        model_path = _find_model(self.config.wake_word)
        if not model_path:
            _LOGGER.error("Wake word model not found: %s", self.config.wake_word)
            return

        framework = "tflite" if model_path.endswith(".tflite") else "onnx"
        _LOGGER.info("Loading OWW model: %s (%s)", os.path.basename(model_path), framework)
        try:
            oww = OWWModel(wakeword_model_paths=[model_path], inference_framework=framework)
            self._oww = oww
        except Exception as e:
            _LOGGER.error("Failed to load OWW: %s", e)
            return

        _LOGGER.info("OWW loaded — starting mic capture")

        # Start mic subprocess
        mic_cmd = self._mic_cmd()
        _LOGGER.info("Mic: %s", " ".join(mic_cmd))
        try:
            mic = subprocess.Popen(mic_cmd, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, bufsize=0)
            self._mic_proc = mic
        except Exception as e:
            _LOGGER.error("Failed to start mic: %s", e)
            return

        _LOGGER.info("Listening for wake word: %s", self.config.wake_word)

        while mic.poll() is None and (self._wake_word_active or self._streaming):
            raw = mic.stdout.read(_CHUNK_BYTES)
            if not raw or len(raw) < _CHUNK_BYTES:
                break

            # Stream audio to HA while in STT phase
            if self._streaming:
                self._send_from_thread(VoiceAssistantAudio(data=raw))

            # Run OWW inference when waiting for wake word
            if self._wake_word_active and not self._pipeline_active:
                try:
                    audio = np.frombuffer(raw, dtype=np.int16)
                    preds = oww.predict(audio)
                    for ww_name, score in preds.items():
                        if score >= 0.5:
                            _LOGGER.info("Wake word detected: %s (%.3f)", ww_name, score)
                            oww.reset()
                            self._on_wake_word(ww_name)
                            break
                except Exception as e:
                    _LOGGER.debug("OWW predict error: %s", e)

        _LOGGER.info("Mic loop exited")

    def _on_wake_word(self, ww_name: str) -> None:
        """Called from mic thread — triggers the HA pipeline."""
        if self._pipeline_active or self._transport is None:
            return
        self._pipeline_active  = True
        self._wake_word_active = False

        # Normalise: "ok_nabu_v0.1" → "okay nabu"
        phrase = ww_name.split("_v")[0]               # strip version suffix
        phrase = phrase.replace("ok_", "okay_")       # ok_ → okay_
        phrase = phrase.replace("_", " ")             # underscores → spaces

        _LOGGER.info("Starting pipeline with phrase: '%s'", phrase)

        def _start() -> None:
            self._send(VoiceAssistantRequest(start=True, wake_word_phrase=phrase))
            self._streaming = True

        if self._loop:
            self._loop.call_soon_threadsafe(_start)

    def _mic_cmd(self) -> list:
        dev = self.config.mic_device
        if dev.startswith("hw:") or dev.startswith("plughw:"):
            return ["arecord", "-D", dev, "-f", "S16_LE", "-r", "16000", "-c", "1", "-"]
        cmd = ["parec", "--format=s16le", "--rate=16000", "--channels=1"]
        if dev and dev != "default":
            cmd += ["--device", dev]
        return cmd

    # ── TTS playback ───────────────────────────────────────────────────────────

    def _play_tts(self, url: str) -> None:
        vol = self.config.tts_volume

        def _play() -> None:
            if self._tts_proc:
                try:
                    self._tts_proc.kill()
                except Exception:
                    pass
            p = subprocess.Popen(
                ["mpv", "--no-video", "--really-quiet", f"--volume={vol}", url],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            self._tts_proc = p
            p.wait()
            self._tts_proc = None

        threading.Thread(target=_play, daemon=True).start()


# ── Server entry point ─────────────────────────────────────────────────────────

def _get_mac() -> str:
    try:
        import uuid
        mac = uuid.getnode()
        return ":".join(f"{(mac >> (8 * i)) & 0xFF:02x}" for i in range(5, -1, -1))
    except Exception:
        return "aa:bb:cc:dd:ee:ff"


async def _serve(config: argparse.Namespace) -> None:
    loop = asyncio.get_running_loop()
    server = await loop.create_server(
        lambda: VoiceSatellite(config),
        host="0.0.0.0",
        port=config.port,
        reuse_address=True,
    )
    _LOGGER.info("Voice satellite listening on port %d  name=%s", config.port, config.name)
    print("ready", flush=True)  # Node.js watches for this
    async with server:
        await server.serve_forever()


def main() -> None:
    # Ask the kernel to send SIGKILL to this process when the parent (Node) dies,
    # regardless of how the parent terminates (clean exit, SIGTERM, SIGKILL, crash).
    # This prevents orphaned satellite processes holding the TCP port open.
    try:
        import ctypes as _ct
        _ct.CDLL("libc.so.6").prctl(1, 9)  # PR_SET_PDEATHSIG=1, SIGKILL=9
    except Exception:
        pass

    ap = argparse.ArgumentParser(description="Canvas Display Voice Satellite")
    ap.add_argument("--port",          type=int, default=6053)
    ap.add_argument("--name",          default="canvas-display")
    ap.add_argument("--friendly-name", default="Canvas Display")
    ap.add_argument("--mac",           default="")
    ap.add_argument("--mic-device",    default="default")
    ap.add_argument("--wake-word",     default="okay_nabu")
    ap.add_argument("--tts-volume",    type=int, default=80)
    ap.add_argument("--log-level",     default="INFO")
    cfg = ap.parse_args()

    if not cfg.mac:
        cfg.mac = _get_mac()

    logging.basicConfig(
        level=getattr(logging, cfg.log_level.upper(), logging.INFO),
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        stream=sys.stderr,
    )

    try:
        asyncio.run(_serve(cfg))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
`;

// ---------------------------------------------------------------------------
// VoiceSatelliteProcess — manages the Python satellite subprocess lifecycle
// ---------------------------------------------------------------------------

export class VoiceSatelliteProcess extends EventEmitter {
  private settings: SatelliteSettings;
  private proc: ChildProcess | null = null;
  private scriptPath: string;
  private destroyed = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartDelay = 2000;

  constructor(settings: SatelliteSettings) {
    super();
    this.settings = { ...settings };
    this.scriptPath = join(tmpdir(), 'canvas-display-satellite.py');
    this._writeScript();
  }

  private _writeScript(): void {
    try {
      writeFileSync(this.scriptPath, SATELLITE_PY.trimStart(), { mode: 0o644 });
    } catch (e) {
      console.error('[satellite] Failed to write Python script:', (e as Error).message);
    }
  }

  start(): void {
    this.destroyed = false;
    this.restartDelay = 2000;
    this._spawn();
  }

  async stop(): Promise<void> {
    this.destroyed = true;
    this._clearRestart();
    if (this.proc) {
      const p = this.proc;
      this.proc = null;
      p.removeAllListeners();
      try { process.kill(p.pid!, 'SIGKILL'); } catch { /* already dead */ }
    }
  }

  updateSettings(settings: Partial<SatelliteSettings>): void {
    Object.assign(this.settings, settings);
  }

  private _spawn(): void {
    if (this.destroyed) return;

    const python = findPython3();
    const s = this.settings;

    // Sanitise name: lowercase, replace spaces/special chars with hyphens
    const safeName = s.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');

    const args = [
      this.scriptPath,
      '--port',          String(s.port),
      '--name',          safeName,
      '--friendly-name', s.friendlyName || safeName,
      '--mic-device',    s.micDevice,
      '--wake-word',     s.wakeWord,
      '--tts-volume',    String(s.ttsVolume),
      '--log-level',     'INFO',
    ];

    console.log(`[satellite] Spawning: ${python} --port ${s.port} --wake-word ${s.wakeWord}`);

    const proc = spawn(python, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;

    // Belt-and-suspenders orphan prevention (primary guard is prctl in Python):
    // If Node exits or receives a signal, SIGKILL the child first.
    const _killChild = () => { try { process.kill(proc.pid!, 'SIGKILL'); } catch { /* already dead */ } };
    const _onExit    = () => _killChild();
    const _onSig     = () => { _killChild(); };
    process.once('exit',    _onExit);
    process.once('SIGTERM', _onSig);
    process.once('SIGINT',  _onSig);
    proc.once('close', () => {
      process.removeListener('exit',    _onExit);
      process.removeListener('SIGTERM', _onSig);
      process.removeListener('SIGINT',  _onSig);
    });

    proc.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        const t = line.trim();
        if (!t) continue;
        if (t === 'ready') {
          console.log(`[satellite] Voice satellite ready on port ${s.port}`);
          this.emit('ready');
        } else {
          console.log('[satellite]', t);
        }
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        for (const line of text.split('\n')) {
          const t = line.trim();
          if (t) console.log('[satellite:py]', t);
        }
      }
    });

    proc.on('close', (code) => {
      if (this.proc === proc) this.proc = null;
      if (this.destroyed) return;
      console.warn(`[satellite] Python exited (code ${code}) — restarting in ${this.restartDelay}ms`);
      this._scheduleRestart();
    });

    proc.on('error', (err) => {
      console.error('[satellite] Process error:', err.message);
    });
  }

  private _scheduleRestart(): void {
    if (this.destroyed) return;
    this._clearRestart();
    this.restartTimer = setTimeout(() => {
      this.restartDelay = Math.min(this.restartDelay * 1.5, 30_000);
      this._spawn();
    }, this.restartDelay);
  }

  private _clearRestart(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }
}
