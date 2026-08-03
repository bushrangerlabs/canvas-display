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
  wakeAckEnabled: boolean;
  wakeAckSound: string;
  goodIntentEnabled: boolean;
  goodIntentSound: string;
  noIntentEnabled: boolean;
  noIntentSound: string;
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

Follows the OHF-Voice/linux-voice-assistant reference architecture:
  - soundcard library for microphone capture (PulseAudio/PipeWire native)
  - pymicro_wakeword for MicroWakeWord models (okay_nabu etc.)
  - pyopen_wakeword for OpenWakeWord models (fallback)
  - Models auto-downloaded from OHF-Voice repo on first run
"""

import argparse
import asyncio
import json
import logging
import os
import re
import sys
import threading
import time
import urllib.request
from pathlib import Path
from typing import Optional, Union

import numpy as np

# ── soundcard (PulseAudio/PipeWire mic capture) ────────────────────────────────
try:
    import soundcard as sc
    _SC_OK = True
except ImportError:
    _SC_OK = False

# ── pymicro_wakeword (MicroWakeWord — preferred for okay_nabu) ─────────────────
try:
    from pymicro_wakeword import MicroWakeWord, MicroWakeWordFeatures  # type: ignore[import]
    _MWW_OK = True
except ImportError:
    _MWW_OK = False

# ── pyopen_wakeword (OpenWakeWord streaming API) ───────────────────────────────
try:
    from pyopen_wakeword import OpenWakeWord, OpenWakeWordFeatures  # type: ignore[import]
    _POWW_OK = True
except ImportError:
    _POWW_OK = False

_OWW_RAW_OK = False
# Fallback: raw openwakeword (if pyopen_wakeword not available)
if not _POWW_OK:
    try:
        import openwakeword as _oww_pkg
        from openwakeword.model import Model as _OWWRawModel
        _OWW_RAW_OK = True
    except ImportError:
        pass

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
_BLOCK_SAMPLES = 1280    # 80 ms @ 16 kHz
_BLOCK_BYTES   = _BLOCK_SAMPLES * _CHANNELS * _SAMPLE_WIDTH

# ── Wake word model management ─────────────────────────────────────────────────
# MicroWakeWord models are downloaded from OHF-Voice/linux-voice-assistant repo.
# This is the same model source that HA ships — probability_cutoff comes from .json.
_MWW_BASE_URL = "https://raw.githubusercontent.com/OHF-Voice/linux-voice-assistant/main/wakewords"
_MWW_KNOWN = {
    "okay_nabu", "hey_jarvis", "hey_mycroft", "hey_luna",
    "hey_home_assistant", "okay_computer", "alexa", "choo_choo_homie", "stop",
}
_MODEL_DIR = Path.home() / ".local" / "share" / "canvas-display" / "wakewords"

def _ensure_mww_model(name: str) -> "Optional[Path]":
    """Download MicroWakeWord model files if not already present.
    Returns path to the .json config, or None if unavailable."""
    if name not in _MWW_KNOWN:
        return None
    _MODEL_DIR.mkdir(parents=True, exist_ok=True)
    json_path  = _MODEL_DIR / f"{name}.json"
    tflite_path = _MODEL_DIR / f"{name}.tflite"
    missing = [p for p in (json_path, tflite_path) if not p.exists()]
    if missing:
        _LOGGER.info("Downloading MicroWakeWord model: %s", name)
        for ext in (".json", ".tflite"):
            dest = _MODEL_DIR / f"{name}{ext}"
            if not dest.exists():
                try:
                    url = f"{_MWW_BASE_URL}/{name}{ext}"
                    urllib.request.urlretrieve(url, dest)
                    _LOGGER.info("  Downloaded %s", dest.name)
                except Exception as e:
                    _LOGGER.warning("  Failed to download %s: %s", dest.name, e)
                    return None
    return json_path if json_path.exists() and tflite_path.exists() else None

def _find_oww_model(name: str) -> "Optional[str]":
    """Locate a raw OWW .tflite / .onnx model file by wake-word name."""
    try:
        import glob as _glob
        res = os.path.join(os.path.dirname(_oww_pkg.__file__), "resources", "models")
        for candidate in (name, name.replace("okay_", "ok_")):
            for ext in (".tflite", ".onnx"):
                p = os.path.join(res, candidate + ext)
                if os.path.exists(p):
                    return p
                matches = sorted(_glob.glob(os.path.join(res, candidate + "_v*" + ext)), reverse=True)
                if matches:
                    return matches[0]
    except Exception:
        pass
    return None

def _load_wake_model(name: str):
    """Load a wake word model. Returns (kind, model, features) or None.
    kind: 'micro' | 'oww_streaming' | 'oww_raw'
    """
    # 1) MicroWakeWord (preferred — okay_nabu, hey_jarvis, etc.)
    if _MWW_OK:
        config_path = _ensure_mww_model(name)
        if config_path:
            try:
                model    = MicroWakeWord.from_config(config_path)
                features = MicroWakeWordFeatures()
                # Cap at 0.85 — OHF-Voice ships hey_jarvis at 0.97 which is too
                # strict for a display mic that isn't right next to the speaker.
                _MAX_CUTOFF = 0.85
                if model.probability_cutoff > _MAX_CUTOFF:
                    _LOGGER.info("Capping cutoff %.2f → %.2f for %s",
                                 model.probability_cutoff, _MAX_CUTOFF, name)
                    model.probability_cutoff = _MAX_CUTOFF
                _LOGGER.info("Loaded MicroWakeWord model: %s (cutoff=%.2f)",
                             name, model.probability_cutoff)
                return ("micro", model, features)
            except Exception as e:
                _LOGGER.warning("Failed to load MWW %s: %s", name, e)

    # 2) pyopen_wakeword streaming API
    if _POWW_OK:
        try:
            import glob as _glob
            # Look for a .json config + .tflite pair
            res = _MODEL_DIR / f"{name}.tflite"
            if not res.exists():
                # also check openwakeword resources
                raw_path = _find_oww_model(name) if _OWW_RAW_OK else None
                if raw_path:
                    res = Path(raw_path)
            if res.exists():
                model    = OpenWakeWord.from_file(str(res))
                features = OpenWakeWordFeatures.from_builtin()
                _LOGGER.info("Loaded pyopen_wakeword model: %s", res.name)
                return ("oww_streaming", model, features)
        except Exception as e:
            _LOGGER.warning("Failed to load pyopen_wakeword %s: %s", name, e)

    # 3) Raw openwakeword fallback (batch predict API)
    if _OWW_RAW_OK:
        raw_path = _find_oww_model(name)
        if raw_path:
            try:
                model = _OWWRawModel(wakeword_models=[raw_path], inference_framework="tflite")
                _LOGGER.info("Loaded raw OWW model: %s", os.path.basename(raw_path))
                return ("oww_raw", model, None)
            except Exception as e:
                _LOGGER.error("Failed to load raw OWW %s: %s", name, e)

    _LOGGER.error("No wake word model found for: %s", name)
    return None

def _get_soundcard_mic(device_id: str):
    """Return a soundcard microphone matching device_id (PA source name or description).
    Falls back to default if not found or if device_id is a digital port."""
    if not _SC_OK:
        return None
    if not device_id or device_id == "default":
        return sc.default_microphone()
    if re.search(r"iec958|iec60958|spdif|hdmi", device_id, re.I):
        _LOGGER.warning("Device '%s' is a digital port — using default mic", device_id)
        return sc.default_microphone()
    dev_lower = device_id.lower()
    for m in sc.all_microphones(include_loopback=False):
        # m.id  = PulseAudio source name (exact match)
        # m.name = human-readable description (substring match)
        if getattr(m, "id", None) == device_id:
            return m
        if dev_lower in m.name.lower() or m.name.lower() in dev_lower:
            return m
    _LOGGER.warning("Mic '%s' not found in soundcard — using default", device_id)
    return sc.default_microphone()

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
        self._tts_proc = None
        self._wake_ack_proc = None
        self._intent_cue_played = False

        # Mic / wake word (background thread)
        self._mic_thread: Optional[threading.Thread] = None
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
        if self._tts_proc:
            try:
                self._tts_proc.kill()
            except Exception:
                pass
            self._tts_proc = None
        if self._wake_ack_proc:
            try:
                self._wake_ack_proc.kill()
            except Exception:
                pass
            self._wake_ack_proc = None

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

        if et == _EVT_INTENT_END:
            self._play_intent_cue(True)

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
            self._ensure_mic_running()

        elif et == _EVT_TIMED_OUT:
            self._play_intent_cue(False)
            self._streaming = False
            self._pipeline_active = False
            self._wake_word_active = True
            _LOGGER.warning("Pipeline timed out — resuming wake word detection")
            self._ensure_mic_running()

        elif et == _EVT_ERROR:
            self._play_intent_cue(False)
            code = data.get("code", "?")
            message = data.get("message", "")
            _LOGGER.error("Pipeline error [%s]: %s", code, message)
            self._streaming = False
            self._pipeline_active = False
            self._wake_word_active = True
            self._ensure_mic_running()

    def _play_intent_cue(self, good: bool) -> None:
        """Play one result cue at most once, before any queued TTS response."""
        import subprocess as _sp
        if self._intent_cue_played:
            return
        self._intent_cue_played = True
        enabled = self.config.good_intent_enabled if good else self.config.no_intent_enabled
        sound = self.config.good_intent_sound if good else self.config.no_intent_sound
        if not bool(enabled) or not sound:
            return
        try:
            _sp.run(
                ["mpv", "--no-video", "--really-quiet", "--volume=100", sound],
                stdout=_sp.DEVNULL,
                stderr=_sp.DEVNULL,
                check=False,
            )
        except Exception as e:
            _LOGGER.warning("Intent cue playback failed: %s", e)

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

    def _ensure_mic_running(self) -> None:
        """Restart the mic+wake-word thread if it has exited."""
        if self._mic_thread is None or not self._mic_thread.is_alive():
            _LOGGER.info("Restarting mic thread")
            self._mic_thread = threading.Thread(target=self._mic_loop, daemon=True, name="mic-oww")
            self._mic_thread.start()

    # ── Mic + wake word (background thread) ────────────────────────────────────

    def _mic_loop(self) -> None:
        """Mic capture + wake word inference running in a background thread.

        Uses soundcard library (PulseAudio/PipeWire native) for reliable audio
        capture, matching the OHF-Voice/linux-voice-assistant reference approach.
        Wake word detection priority: MicroWakeWord → pyopen_wakeword → raw OWW.
        """
        result = _load_wake_model(self.config.wake_word)
        if not result:
            _LOGGER.error("No wake word model available — voice detection disabled")
            return
        model_kind, model, features = result

        if not _SC_OK:
            _LOGGER.error("soundcard not installed — mic capture disabled. "
                          "Run: pip install soundcard")
            return

        mic_dev = _get_soundcard_mic(self.config.mic_device)
        _LOGGER.info("Mic device: %s (id=%s)", mic_dev.name, getattr(mic_dev, "id", "?"))
        _LOGGER.info("Listening for wake word: %s  [model=%s]",
                     self.config.wake_word, model_kind)

        chunk_count    = 0
        silence_warned = False

        try:
            with mic_dev.recorder(samplerate=_SAMPLE_RATE, channels=_CHANNELS,
                                   blocksize=_BLOCK_SAMPLES) as mic_in:
                while self._wake_word_active or self._streaming:
                    # Record one block — soundcard returns float32 in [-1, 1]
                    audio_f32   = mic_in.record(_BLOCK_SAMPLES).reshape(-1)
                    # Convert to S16LE bytes (same format HA expects)
                    audio_bytes = (np.clip(audio_f32, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
                    chunk_count += 1

                    # Silence diagnostic after ~2 s
                    if not silence_warned and chunk_count == 25:
                        amp = np.abs(np.frombuffer(audio_bytes, dtype="<i2")).max()
                        if amp < 5:
                            _LOGGER.error(
                                "Mic '%s' is silent (max_amp=%d). "
                                "Check PulseAudio/PipeWire source and input volume.",
                                mic_dev.name, amp
                            )
                            silence_warned = True

                    # Stream to HA during STT phase
                    if self._streaming:
                        self._send_from_thread(VoiceAssistantAudio(data=audio_bytes))

                    # Wake word detection
                    if not (self._wake_word_active and not self._pipeline_active):
                        continue

                    activated = False
                    try:
                        if model_kind == "micro":
                            micro_inputs = features.process_streaming(audio_bytes)
                            for micro_input in micro_inputs:
                                if model.process_streaming(micro_input):
                                    _LOGGER.info("Wake word detected: %s (MicroWakeWord)",
                                                 self.config.wake_word)
                                    activated = True
                                    break

                        elif model_kind == "oww_streaming":
                            oww_inputs = features.process_streaming(audio_bytes)
                            for oww_input in oww_inputs:
                                for prob in model.process_streaming(oww_input):
                                    if prob >= 0.35:
                                        _LOGGER.info("Wake word detected: %s (%.3f)",
                                                     self.config.wake_word, prob)
                                        activated = True
                                        break

                        else:  # oww_raw batch predict fallback
                            audio_i16 = np.frombuffer(audio_bytes, dtype=np.int16)
                            preds = model.predict(audio_i16)
                            if chunk_count % 200 == 0:
                                best = max(preds.values()) if preds else 0.0
                                _LOGGER.info("OWW chunk=%d best_score=%.3f",
                                             chunk_count, best)
                            for ww_name, score in preds.items():
                                if score >= 0.35:
                                    _LOGGER.info("Wake word detected: %s (%.3f)",
                                                 ww_name, score)
                                    model.reset()
                                    activated = True
                                    break

                    except Exception as e:
                        _LOGGER.warning("Wake word inference error: %s", e)

                    if activated:
                        self._on_wake_word(self.config.wake_word)

        except Exception as e:
            _LOGGER.error("Mic loop error: %s", e, exc_info=True)
        finally:
            _LOGGER.info("Mic loop exited (chunks=%d)", chunk_count)

    def _on_wake_word(self, ww_name: str) -> None:
        """Called from mic thread — triggers the HA pipeline."""
        if self._pipeline_active or self._transport is None:
            return
        self._pipeline_active  = True
        self._intent_cue_played = False
        self._wake_word_active = False
        # Set _streaming True synchronously so the mic loop condition stays True
        # while call_soon_threadsafe delivers the send to the event loop.
        self._streaming = True

        # Normalise: "ok_nabu" / "okay_nabu" → "okay nabu"
        phrase = re.sub(r"_v\d.*$", "", ww_name)      # strip version suffix
        phrase = phrase.replace("ok_", "okay_")        # ok_ → okay_
        phrase = phrase.replace("_", " ")              # underscores → spaces

        _LOGGER.info("Starting pipeline with phrase: '%s'", phrase)

        def _start() -> None:
            self._play_wake_ack()
            self._send(VoiceAssistantRequest(start=True, wake_word_phrase=phrase))

        if self._loop:
            self._loop.call_soon_threadsafe(_start)

    def _play_wake_ack(self) -> None:
        """Play a short acknowledgement sound when wake word is detected."""
        import subprocess as _sp

        if not bool(self.config.wake_ack_enabled):
            return

        sound = (self.config.wake_ack_sound or "").strip()
        if not sound:
            return

        def _play() -> None:
            if self._wake_ack_proc:
                try:
                    self._wake_ack_proc.kill()
                except Exception:
                    pass

            try:
                p = _sp.Popen(
                    ["mpv", "--no-video", "--really-quiet", "--volume=100", sound],
                    stdout=_sp.DEVNULL,
                    stderr=_sp.DEVNULL,
                )
                self._wake_ack_proc = p
                p.wait()
            except Exception as e:
                _LOGGER.warning("Wake ack sound playback failed: %s", e)
            finally:
                self._wake_ack_proc = None

        threading.Thread(target=_play, daemon=True).start()

    # ── TTS playback ───────────────────────────────────────────────────────────

    def _play_tts(self, url: str) -> None:
        import subprocess as _sp
        vol = self.config.tts_volume

        def _play() -> None:
            if self._tts_proc:
                try:
                    self._tts_proc.kill()
                except Exception:
                    pass
            p = _sp.Popen(
                ["mpv", "--no-video", "--really-quiet", f"--volume={vol}", url],
                stdout=_sp.DEVNULL, stderr=_sp.DEVNULL,
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
    ap.add_argument("--wake-ack-enabled", type=lambda v: str(v).lower() in ("1", "true", "yes", "on"), default=False)
    ap.add_argument("--wake-ack-sound", default="")
    ap.add_argument("--good-intent-enabled", type=lambda v: str(v).lower() in ("1", "true", "yes", "on"), default=True)
    ap.add_argument("--good-intent-sound", default="")
    ap.add_argument("--no-intent-enabled", type=lambda v: str(v).lower() in ("1", "true", "yes", "on"), default=True)
    ap.add_argument("--no-intent-sound", default="")
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
  // Single global exit handler — registered once, kills the current child.
  private _exitHandler: () => void;

  constructor(settings: SatelliteSettings) {
    super();
    this.settings = { ...settings };
    this.scriptPath = join(tmpdir(), 'canvas-display-satellite.py');
    this._exitHandler = () => {
      if (this.proc) try { process.kill(this.proc.pid!, 'SIGKILL'); } catch { /* already dead */ }
    };
    process.once('exit', this._exitHandler);
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
    process.removeListener('exit', this._exitHandler);
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
            '--wake-ack-enabled', s.wakeAckEnabled ? '1' : '0',
      '--wake-ack-sound', s.wakeAckSound,
      '--good-intent-enabled', s.goodIntentEnabled ? '1' : '0',
      '--good-intent-sound', s.goodIntentSound,
      '--no-intent-enabled', s.noIntentEnabled ? '1' : '0',
      '--no-intent-sound', s.noIntentSound,
      '--log-level',     'INFO',
    ];

    console.log(`[satellite] Spawning: ${python} --port ${s.port} --wake-word ${s.wakeWord}`);

    // Belt-and-suspenders orphan prevention (primary guard is prctl in Python):
    // The single global _exitHandler (registered in constructor) kills this.proc
    // on Node exit — no per-spawn listeners needed.
    const proc = spawn(python, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;

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
