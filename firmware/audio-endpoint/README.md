# Canvas Audio Endpoint (Pico 2 W)

A dumb WiFi **sound card** for any Canvas edge device. It reads the Sipeed
7-mic array over 4-lane I²S, streams all 8 channels to the edge over TCP, and
plays whatever PCM the edge sends back out to a UDA1334A DAC. All intelligence
(wake word, VAD, AEC/beamforming, ASR/TTS) stays on the edge and Core.

## Architecture

```
┌──────────────┐   assign + test   ┌──────────────────┐
│  Core (UI)   │ ────────────────▶ │  audio_endpoints │  registry: which Pico
│  .108 / .182 │   desired state   │  (Postgres)      │  is the mic+speaker
└──────┬───────┘                   └────────┬─────────┘  for which edge
       │  GET /api/edge/audio/assignment    │
       ▼                                    │
┌──────────────────┐   TCP 8090 (LAN)   ┌──────────────────┐
│  Edge device     │ ◀─────────────────▶ │  Pico 2 W        │
│  (Linux/Android) │   mic PCM + TTS PCM │  (sound card)    │
│  wake word, ASR, │                     │  7-mic array +   │
│  TTS, AEC/beam   │                     │  UDA1334A DAC    │
└──────────────────┘                     └──────────────────┘
```

- The **Pico is a network sound card**: its 7-mic array is the mic, its DAC is
  the speaker. It has no intelligence of its own.
- The **edge device** does all the thinking: wake word, VAD, ASR, TTS, and
  (planned) AEC/beamforming over the 7 mics. It connects to its assigned Pico
  over TCP and streams audio both ways.
- **Core** is the control plane: an admin mates a Pico to an edge device in the
  Core UI (Settings → Audio endpoints) and can **test** each Pico's mic and
  speaker from the UI. Core pushes the assignment to the edge's `audio`
  desired-state domain; the edge polls it and connects automatically.

## Wiring

| Sipeed mic array | Pico 2 W | | UDA1334A DAC | Pico 2 W |
|---|---|---|---|---|
| VIN | 3V3 | | VIN | 3V3 |
| GND | GND | | GND | GND |
| MIC_D0 | GPIO 0 | | BCLK | GPIO 6 |
| MIC_D1 | GPIO 1 | | WSEL/LRCK | GPIO 7 |
| MIC_D2 | GPIO 2 | | DIN | GPIO 8 |
| MIC_D3 | GPIO 3 | | | |
| MIC_WS | GPIO 4 | | | |
| MIC_CK | GPIO 5 | | | |
| LED_CK | GPIO 10 | | | |
| LED_DA | GPIO 11 | | | |

USB stdio only — GPIO 0–8 are all used by I²S.

## Build

```bash
export PICO_SDK_PATH=/path/to/pico-sdk
mkdir build && cd build
cmake -DPICO_BOARD=pico2_w \
      -DAE_WIFI_SSID="<local-ssid>" \
      -DAE_WIFI_PASSWORD="<local-password>" \
      -DAE_CORE_URL="<local-core-url>" \
      -DAE_ENROLLMENT_SECRET="<local-enrollment-secret>" \
      ..
make -j4
```

Flash `canvas_audio_endpoint.uf2` by holding BOOTSEL and copying it to the
`RP2350` mass-storage device.

## Mic clocking

`AE_MIC_I2S_MASTER` (default 1) makes the Pico generate `MIC_CK`/`MIC_WS`. The
Sipeed wiki drives these from the host, but some carrier boards add an onboard
oscillator. If you get silence, rebuild with `-DAE_MIC_I2S_MASTER=0` and let the
array clock itself.

## Protocol

See `src/protocol.h`. Two TCP connections to port 8090:

- **mic** (endpoint → edge): 20 ms frames of 8-channel interleaved PCM16 @ 16 kHz
- **playback** (edge → endpoint): a `CONFIG` message then mono PCM16 frames

Every message is `[u16 len][u8 type][payload]`, little-endian.

## Status LED

The 12 SK9822 LEDs show blue during boot, cyan during WiFi setup, and red
on startup failure. After startup, the authenticated current **MIC owner** can
send additive protocol message `8` (`VOICE_STATE`) with exactly one payload byte:

| State | Meaning | Ring color |
|---|---|---|
| `0` | Ready / idle | Dim blue |
| `1` | Listening after wake | Green |
| `2` | Processing / speaking | Amber |
| `3` | Error | Red |

For example, listening is the complete frame `02 00 08 01` (length includes
the type byte). Unauthenticated clients, playback clients, non-owner MIC
clients, invalid lengths, and values outside `0..3` are ignored. The requested
state persists until the owner changes it; MIC disconnect or replacement resets
it to ready. Without a MIC owner the ring stays blue, and a connected playback
socket alone does not imply speaking. Existing clients that send no voice-state
messages therefore remain blue. Protocol version remains `1`.

Network callbacks only store state. The main loop snapshots it under the existing
lwIP lock and renders the ring outside that lock; audio processing and transport
lifecycle are unchanged.
