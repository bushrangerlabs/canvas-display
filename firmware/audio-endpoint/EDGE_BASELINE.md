# Linux native edge remote-audio baseline

## Milestone and scope

Transport/lifecycle is accepted as stable; see TCP_DIAGNOSIS.md. Keep assertions,
watchdog, raw-API synchronization and close ownership handling. Do not change
firmware transport, buffers, clocks, packet dimensions or protocol during this
milestone. Full AEC and seven-mic/beamforming improvements are deferred.

2026-10-06 explicit user exception: LED-only voice-state control via authenticated
MIC-owner message 8 is built; updated Linux sidecar 0.1.2 deployed. Pico flash and
visible LED acceptance pending. Audio/DSP/lwIP lifecycle behavior unchanged by
this extension. See PROJECT_STATUS.md for successful spoken turns and timings;
older pending phase notes below describe the earlier 2026-10-05 measurements.

Target chain: Pico array -> TCP -> Linux RemoteEndpoint -> unchanged RemoteMicDsp
-> local wake word -> local capture/VAD -> Core ASR/conversation/TTS services
-> paced edge PCM output -> TCP -> Pico/UDA1334A/speaker. The native edge owns
capture, wake-word detection, VAD and output orchestration; existing ASR/LLM/TTS
providers are on Core, not secretly moved onto the Pico.

## Actual deployment

Live endpoint IDs, LAN addresses, hostnames and local database paths are omitted from this public handoff. Query the enrolled endpoint and edge assignments from the authenticated local control plane.

## Implementation gaps corrected before acceptance

Earlier remote integration applied to the HA satellite only; Core-configured
Linux installations select direct-wakeword.ts. The selected direct owner now
uses the remote source and output, without local microphone or local audio sink
fallback in assigned mode.

- Authenticated TCP readiness for both sockets, bounded framing, fragmented /
  coalesced message parsing, reconnect with fresh state, stale-socket guards.
- TypeScript RemoteMicDsp preserves original NumPy weighted sum/noise gate/AGC;
  golden vectors cover parity. Channels/weights unchanged (0,1,3,4,7; ch7 2x).
- Paced 20-ms aligned PCM output, bounded serialized queue and cancellation;
  cues/container audio decode through ffmpeg; Core raw PCM keeps its stream rate.
- Assignment polling runs in the embedded direct owner as well as the system
  device-services process, with their distinct DBs. Credentials are redacted;
  assignments validated/atomically applied; the active owner is restarted.
- Canonical enrolled identity precedes legacy SQLite device_id fallback.
- Stale-turn guards/cancellation and bounded Core requests; final NDJSON
  fragments without newline are handled.

## Incremental results

### Phase 1: edge transport — partial PASS

Observed automatic assignment application, source=remote-pico, mic-ready and
playback-ready on the actual embedded process. ss showed two established Pico
sockets belonging to that process. No parec/arecord process remained.

A subsequent edge service restart started directly from persisted remote
assignment and authenticated both sockets automatically. No local fallback
was seen on that restart. Physical Pico reboot recovery is NOT yet tested.
The source can reconnect in automated TCP tests, but that is not hardware
reboot acceptance.

### Phase 2: remote PCM — format/ambient data observed

The edge validates 5128-byte AUDIO payloads: 8 bytes metadata plus 5120 bytes
PCM16, 320 samples/channel, 8 interleaved channels, nominal 16 kHz / 20 ms.
Metadata and per-channel statistics are exposed through remoteAudio diagnostics.
Ch6 is consistently zero; ch7 carries nonzero data, consistent with D3-right
centre microphone. Physical localization/channel identity still requires an
acoustic check; object labels alone are not proof.

Latest saved ambient snapshot: channel RMS [29,36,224,30,82,29,0,21].
Both sockets stayed ready; zero reconnect events occurred in the saved window.
There were 500 inferred skipped application sequence numbers over 16278 received
frames. These are application-level gaps, NOT proof of TCP packet loss. Firmware
already increments sequence before its send-space check. Record this baseline;
do not change transport speculatively. Nominal sample rate is the configured
format, not an independently measured hardware clock rate.

### Phase 3: unchanged DSP — running; speech acceptance pending

In the 340-second saved interval (35 diagnostic snapshots), DSP mean elapsed was
about 0.0806 ms/frame, max 2.0434 ms. Raw and output clipping counters stayed zero.
Maximum sampled raw/output RMS was 804/853. Quiet-room noise is sometimes gated
to zero; this does NOT establish that normal speech is preserved. The existing
channel set and DSP parameters remain unchanged.

### Phase 4: wake word / VAD / ASR — not accepted yet

Pi loaded hey_jarvis_v0.1.onnx and listens at existing threshold 0.63.
A requested human near-array test was monitored, but no confirmed human stimulus
or wake-word event was captured. A separate controlled synthetic 'Hey Jarvis'
then 'What time is it?' was synthesized through existing Piper and played on
this development host's default USB speaker at mpv volume 70. No wake event
was observed. Audibility and distance from that speaker to the Pico were not
verified, so this is NOT a wake-word failure diagnosis or human acceptance.
Do not adjust model threshold/DSP to make this unverified stimulus pass.

### Phase 5: actual assistant TTS -> Pico — pending

Remote output code and mocked direct-owner tests pass, but no real captured
utterance produced an assistant response in this window. Therefore audible
UDA1334A/speaker output, uninterrupted mic streaming during TTS, and real TTS
startup/buffering latency are NOT verified. Earlier Core tone diagnostics are
not a substitute for actual edge conversation playback.

Protocol v1 offers no explicit DAC drain acknowledgement or flush. Output
completion uses sample pacing plus an estimated tail; never call socket-write
completion proof of audible playback. Cancellation stops further sends but
already delivered PCM can remain audible.

### Phase 6: complete repeated interactions — pending

Need human quiet-room, several-metre, speaker-playing-TTS and repeated-turn
acceptance, followed by Pico reboot and edge restart with complete turns.
Baseline remains half duplex: the mic stream/DSP keep running while TTS plays,
but the existing direct pipeline ignores wake-word matches during TTS. No AEC
or barge-in implementation is added in this milestone.

## Measurements and evidence

- artifacts/audio-endpoint-baseline/edge-observations.json: 35 sanitized raw /
  DSP / relative-frame timing snapshots plus direct-source event observations.
- Synthetic stimulus WAVs are in that artifact directory; they contain only
  generated test phrases, not microphone recordings.
- Independent provider synthesis timings: wake phrase cold request 2376 ms;
  command warm request 179 ms. These are standalone Piper timings, NOT complete
  conversation TTS startup timings.
- Per-frame endpoint timestamp and receive interval are relative clocks.
  Latest sampled receive interval 15.03 ms and endpoint interval 21 ms;
  coalesced frames may share a receive timestamp. Absolute mic/network latency
  cannot be calculated without a calibrated shared-clock/acoustic measurement.
- Existing direct turn telemetry records capture, Core/ASR/provider timing,
  first playback, and total/playback estimates once a real turn completes.
  Wake-word/acoustic onset and DAC buffering latency remain unmeasured.

## Local validation

- server npm run type-check: PASS.
- Focused remote endpoint/DSP/direct-owner/poller, VAD and startup tests: PASS
  (remote tests expanded to 14, plus existing VAD/startup cases).
- server npm test now includes remote-audio, VAD and startup regressions:
  **76/76 PASS**. Before adding them to the normal script, the older default
  suite also passed 49/49.
- Pi native TypeScript, esbuild and pkg build: PASS; installed services active.
- Logging-only Pico firmware rebuild: PASS, NOT flashed.

## Next operator-assisted steps

1. Say 'Hey Jarvis', pause, then 'What time is it?' near the array while logs
   are monitored. Confirm speech was actually delivered and whether reply sounds
   on the Pico speaker. Record wake/capture/transcription/TTS events and RMS.
2. If no wake, first correlate delivered speech with raw/DSP input/output and
   model feed; do not begin changing beamforming or AEC.
3. Repeat farther away, during TTS and several times. Confirm capture continuity
   and the intentional ignored-detection policy during output.
4. Power-cycle the Pico (not BOOTSEL) and verify the active edge automatically
   reconnects, then perform another full turn. Test edge restart similarly.
5. Only after full baseline acceptance revisit all-seven-mic validation, improved
   beamforming, and then playback-reference AEC as separate milestones.

Do not run standalone Core mic diagnostics concurrently with an assigned edge:
firmware permits one mic owner and one playback owner, so diagnostics can replace
those active sessions. Use the edge's observations for this baseline.

Known inspection complication: Pi nftables OUTPUT redirects destination port
3100 to 8099 (except Core .108). A loopback curl to 3100 therefore reports the
system process, NOT necessarily the embedded voice owner. Use embedded kiosk
logs and socket/process evidence; do not claim stopped system direct state is
the active voice pipeline.
