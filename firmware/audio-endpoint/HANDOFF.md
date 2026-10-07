# Audio Endpoint — Handoff

**Last updated:** 2026-10-05
**Status:** Pico network sound-card development is in progress. Core assignment
and diagnostic tests exist; full edge integration and AEC are not yet verified
end-to-end. Assertions are ENABLED and the watchdog remains enabled.

## Latest TCP findings — supersedes earlier speculative diagnoses

The send-queue corruption was caused by application-context raw lwIP calls
without `cyw43_arch_lwip_begin()/end()` while using
`pico_cyw43_arch_lwip_threadsafe_background`. The synchronization-only build
completed **101/101 authenticated audio connection lifecycles** with no queue
corruption and assertions enabled. Preserve `sync-diagnostics.log` as evidence.

The isolated `conn_close()` ownership/retry correction is built and flashed.
**101/101 normal tests plus 30/30 outstanding-audio teardown tests passed**;
no panics, observed resets, aborts, transmit ERR_MEM, or leaked context slots.
All close calls returned ERR_OK, so the returned-ERR_MEM retry branch was not
exercised. See **`TCP_DIAGNOSIS.md`**, `close-diagnostics.log`,
`close-single.log`, and `close-test-results.json` for the exact evidence.
Earlier claims of an upstream lwIP bug or disabling assertions as a production
fix are withdrawn; missing synchronization was the confirmed root cause.

---

## Goal

A dumb WiFi **sound card** (Pico 2 W + Sipeed 7-mic array + UDA1334A DAC) that
can be assigned to any Canvas edge device as its **speaker and AEC/beamforming
mic**. All intelligence (wake word, VAD, AEC/beamforming, ASR/TTS) stays on the
edge and Core. Audio flows directly between the endpoint and the edge on the
LAN; Core is only the registry/assignment control plane.

### Architecture (read this first)

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
- **Core** is the control plane: an admin assigns (mates) a Pico to an edge
  device in the Core UI, and can **test** each Pico's mic and speaker from the
  UI. Core pushes the assignment to the edge's `audio` desired-state domain;
  the edge polls it and connects automatically.

---

## Hardware (IMPORTANT)

- **The board is an RP2350 (Pico 2 / Pico 2 W), NOT an RP2040.** The bootloader
  reports `Model: Raspberry Pi RP2350`. Build with `PICO_BOARD=pico2_w`.
- Mic array: Sipeed 7-mic array (6 ring + 1 centre), 4 stereo I²S data lines
  (D0..D3), sharing MIC_WS/MIC_CK. **The array is an I²S slave** — the Pico must
  drive CK/WS (`AE_MIC_I2S_MASTER=1`).
- DAC: UDA1334A, I²S slave, Pico generates BCLK/LRCK.

### Wiring

| Sipeed mic array | Pico W | | UDA1334A DAC | Pico W |
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

USB stdio only (GPIO 0–8 are all used by I²S).

---

## Build / flash environment

Installed to `<local-home>/pico-tools` (no sudo needed):

- ARM toolchain: `<local-home>/pico-tools/arm-gnu-toolchain-13.2.Rel1-x86_64-arm-none-eabi`
- Pico SDK: `<local-home>/pico-tools/pico-sdk`

### Build

```bash
cd "Canvas Display Hermes/firmware/audio-endpoint"
env PATH=<local-home>/pico-tools/arm-gnu-toolchain-13.2.Rel1-x86_64-arm-none-eabi/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  PICO_SDK_PATH=<local-home>/pico-tools/pico-sdk \
  cmake -S . -B build -DPICO_BOARD=pico2_w -DCMAKE_BUILD_TYPE=Release
env PATH=<local-home>/pico-tools/arm-gnu-toolchain-13.2.Rel1-x86_64-arm-none-eabi/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  make -C build -j4
```

Output: `build/canvas_audio_endpoint.uf2`

### Flash

1. Put the board in BOOTSEL mode (hold BOOTSEL while plugging in USB). It mounts
   at `/media/spetchal/RP2350`.
2. `cp build/canvas_audio_endpoint.uf2 /media/spetchal/RP2350/`
3. The board reboots and runs. **It leaves BOOTSEL mode**, so to reflash you must
   re-enter BOOTSEL.

### Serial console

`/dev/ttyACM0` (USB CDC). Read with `timeout 12 cat /dev/ttyACM0`.
The firmware logs boot, WiFi, audio/net init, connection, and a status line
every 5s: `status mic= play= raw= frames= ck= ws= pws= pdma=`
(`pws` = play samples written to ring, `pdma` = output DMA words consumed).

---

## Current live state

Deployment-specific endpoint IDs, LAN addresses, network names, credentials and tokens are intentionally omitted. Retrieve current values from the authenticated local control plane; do not commit them.

### Mic test

`firmware/audio-endpoint/mic-test.mjs` connects to the endpoint, authenticates,
and prints per-channel RMS. Run: `node firmware/audio-endpoint/mic-test.mjs`.

Last result (real audio, not saturated):
```
frame 1: rms=[5301, 6986, 194, 6767, 6829, 155, 0, 6254]
```

---

## What works

- Firmware builds and flashes; boots; USB serial logs.
- WiFi connects; registers with Core; heartbeats.
- TCP server on 8090; token auth (HELLO/HELLO_ACK).
- **7-mic array → 4-lane I²S → PIO → de-interleave → TCP → client**, with real
  audio levels.
- **Playback: edge → TCP → play ring → output PIO/DMA → UDA1334A DAC**
  (acoustically verified: clean 440 Hz tone with correct start/stop after the
  wiring, I2S-format and silence-fill fixes in Remaining work §2).

## Bugs already fixed (do not reintroduce)

1. Use the intended Core registry: production is `.108`; earlier tests used
   `.182` and therefore registered in a different database.
2. `AE_MIC_I2S_MASTER` must be `1` (array is a slave; Pico drives CK/WS).
3. `ae_audio_pump` used `s_mic_tail` as both a ring index and a monotonic
   counter → added `s_raw_frames_consumed`.
4. lwIP buffers too small: the 5120-byte frame `tcp_write` returned `ERR_MEM`.
   Raised `PBUF_POOL_SIZE` 24→48, `MEM_SIZE` 4000→16000, `MEMP_NUM_TCP_SEG` 32→64
   in `src/lwipopts.h`.
5. PIO `in` shift direction was right; `lane_byte` assumes left → set
   `sm_config_set_in_shift(&c_in, false, true, 32)`.
6. PIO labels `left`/`right` are reserved keywords → renamed `lslot`/`rslot`.
7. SDK does not ship `lwipopts.h`; the app must provide one.
8. `ae_audio_write_play` rejected everything: ring occupancy came from an
   aliased monotonic DMA counter → underflow. Now uses the DMA's exact ring
   position (see Remaining work §2).
9. `remote-endpoint.ts` selected ch 6 (unused D3 slot, reads ~0) as the centre
   mic → the centre mic is ch 7 (D3 right slot).

---

## Remaining work

### 1. Channel mapping (resolved — centre mic is ch 7)
Verified against the Sipeed R6+1 wiki + schematic: D0 = mic0+mic1, D1 =
mic2+mic3, D2 = mic4+mic5, D3 = **centre mic only** (on the RIGHT slot, ch 7;
ch 6 is the unused slot and reads ~0).

- Fixed: `remote-endpoint.ts` selected ch 6 (dead) as the centre mic → now ch 7.
- Note: an early mic-test showed ch 2 (mic2) and ch 5 (mic5) at ~150-200 RMS
  while others read 5-7k, suggesting two silent mics. A later Core test-mic in
  a quiet room showed all channels comparable (117-398), so mics 2/5 may be
  fine and the earlier reading was a near-field/directional effect. The
  beamformer currently uses channels 0, 1, 3, 4, 7 (centre weighted); revisit
  if a loud-source test shows all 7 mics live.

### 2. Playback path (acoustically verified 2026-10-06)
Edge → endpoint → DAC now produces clean audio with correct start/stop. Three
issues were found and fixed:

1. **Wiring**: `WSEL/LRCK` (GPIO7) and `DIN` (GPIO8) were physically swapped,
   so the DAC read word-select as data and vice versa → pure hiss. Corrected on
   the board; the firmware pin map (`BCLK`=6, `LRCK`=7, `DIN`=8) was already
   right.
2. **I2S format**: the UDA1334A uses I2S-bus (MSB delayed one BCLK after WS),
   but the output PIO presented the MSB at the WS transition (left-justified),
   so the DAC read every sample shifted one bit and lost the sign bit. Fixed by
   placing each 16-bit sample in bits 15..30 (`<< 15` instead of `<< 16`).
3. **No stop**: the output DMA is a continuous ring, so when playback data
   ended it looped the last ~93 ms of audio forever. Fixed with
   `ae_audio_fill_silence()` (called from the main loop under the lwIP lock)
   which keeps ~2 ms of silence queued ahead of the DMA read pointer.

Also corrected the PIO clock divider for the actual 126-cycle frame
(`rate * 126` instead of `rate * 128`).

Fixed bug: `ae_audio_write_play` computed ring occupancy from an aliased
monotonic DMA counter (`play_dma_words()` undercounts because the 4k-word ring
wraps ~every 93 ms) → `used` underflowed and every write was rejected (`pws`
stuck at 0). Now uses the DMA's exact ring position. Status line also gained
`pws=`/`pdma=` counters.

### 2b. Watchdog and accepted transport baseline
The original apparent hangs were lwIP assertions caused by unsynchronized
application raw-API access, not a proven CYW43 driver fault. The synchronization
fix and lifecycle handling are accepted as stable: 101/101 baseline sessions,
then 131/131 lifecycle sessions including 30/30 closes with queued audio.
No assertions, panics, observed resets, transmit ERR_MEM, unexpected stalls,
or leaked context slots occurred. Queue lengths stayed bounded and send-buffer
availability never exceeded 11680 bytes. See `TCP_DIAGNOSIS.md` for evidence.

The returned-ERR_MEM graceful-close retry path is IMPLEMENTED but NOT
LIVE-EXERCISED. Do not induce memory pressure merely to cover it.
Assertions remain ENABLED and the 5 s watchdog remains enabled.

Logging-only source change: `AE_TCP_VERBOSE_DIAGNOSTICS` defaults to 0, disabling
per-ACK and repeated idle-wait prints while preserving lifecycle, close/retry,
errors, and periodic send diagnostics. This build passes compilation but has
NOT been flashed; the device still runs the accepted lifecycle-test firmware.
Do not change transport behavior unless end-to-end evidence reveals a problem.

### 3. Linux native edge baseline (deployed; acoustic acceptance pending)
See `EDGE_BASELINE.md` for phase-by-phase results and next steps.
- Native edge: Pi `.216`, enrolled as `pi5-living-room`; Core is `.108`.
- The active voice owner is the kiosk's embedded sidecar, with device services
  disabled; the system sidecar is a separate process/DB and does not own voice.
- Earlier remote code was wired only to the HA satellite. The actual Core-direct
  path now uses the TypeScript `RemoteEndpoint` plus `RemoteMicDsp` port, then
  the existing edge wake-word/VAD and Core ASR/conversation/TTS services.
- Assignment polling works in the embedded voice owner. Canonical enrolled
  environment identity outranks a legacy SQLite device id.
- Both TCP sockets authenticate automatically after edge restart; no local
  `parec`/`arecord` remains. Raw input/DSP measurements are recorded.
- Remote output is paced, serialized and bounded; decoding uses ffmpeg without
  a local sink. Hardware/DAC drain is not acknowledged by protocol v1.
- Human wake-word/utterance, near/far-room, audible output, full conversations,
  and physical Pico reboot acceptance are still pending. Do not claim completion.
- Android code compiled previously but is outside this Linux milestone and
  remains unverified on-device.

### 4. Core UI + desired-state (done, deployed)
- `core/src/audio-endpoints.ts` — assign pushes `{endpoint_id, address, port,
  token}` to the device's `audio` desired-state domain (and clears on unassign);
  edge route `GET /api/edge/audio/assignment?deviceId=` (Bearer auth).
- `core/src/audio-endpoint-test.ts` — Core-side diagnostics: `testEndpointMic`
  (reads frames, reports per-channel RMS) and `testEndpointSpeaker` (sends a
  440 Hz tone). Routes: `POST /api/admin/audio-endpoints/:id/test-mic` and
  `.../test-speaker`.
- `core/src/index.ts` — `/api/devices/:id/voice-config` now includes
  `audio_endpoint` (assignment) for the Android/edge config fetch.
- Web UI: Settings → **Audio endpoints** tab (list, online/offline, assign to
  device, **Mic/Speaker test buttons**, delete). Built → `core/public/`.
- Core rebuilt + redeployed to **both** .182 (dev host) and .108 (mainserver);
  6 audio-endpoint tests pass; assignment flow verified live (assign → desired
  state → edge route → unassign clears).

### 5. DSP baseline; AEC explicitly deferred
The Linux direct path preserves the existing weighted sum over channels
0, 1, 3, 4, 7 (centre weighted 2x), noise gate and slow AGC. This is not a
steered/delay-estimating beamformer. Channels 2/5 are NOT proven dead; all-seven
microphone validation and improvements follow complete baseline acceptance.
The TypeScript DSP has golden parity fixtures against the original NumPy math.
Ambient input is sometimes gated to zero; speech preservation needs testing.
Full playback-reference AEC is NOT started. During TTS, capture continues but
wake-word matches are deliberately ignored in the existing half-duplex policy.

---

## Core changes already made (built + deployed)

- `core/src/audio-endpoints.ts` — registry, register/heartbeat, admin list/assign/
  delete, `assignedEndpointForDevice()`, desired-state push on assign, edge
  assignment route.
- `core/src/db.ts` — `audio_endpoints` table.
- `core/src/index.ts` — route registration + options wiring.
- `core/test/audio-endpoints.test.ts` — 5 tests (pass).
- Core was rebuilt (`npm run build` → `dist/`) and redeployed via
  `docker compose up -d --build canvas-core` from `core/` with
  `CANVAS_CORE_TLS_DIR="<local-home>/Code/Canvas Display Hermes/core/tls"`.
  Note: the `tls-proxy` service fails on a missing `core/tls/ca.crt`; only the
  `canvas-core` service was rebuilt/started.
  Production `.108` Core was subsequently rebuilt with assignment/test routes.
  Its canonical Compose working directory is `<local-home>/canvas-core`.

---

## Quick restart checklist

1. Is the board running? `lsusb | grep 2e8a` and `timeout 12 cat /dev/ttyACM0`.
2. Is Core up with the routes? `curl -s -o /dev/null -w '%{http_code}' http://<LAN_IP>:3101/api/admin/audio-endpoints` → `401` means the route exists.
3. Is the endpoint registered? `docker exec postgresql psql -U casaos -d canvas_core -c "SELECT id, address, last_seen FROM audio_endpoints;"`
4. Mic working? Set AE_HOST and AE_TOKEN in the local shell, then run the mic test script; do not store endpoint credentials in the repository.
