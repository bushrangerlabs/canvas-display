# ADR 0006: Voice and Canvas Intelligence boundary

- Status: Accepted
- Date: 2026-07-18
- Decision IDs: D-004, D-008, P-005, O-010, O-011, O-017

## Context

Voice currently mixes local wake word, microphone processes, remote ASR/TTS, Hermes orchestration, model output, media focus, and hardware playback in the server package.

## Decision

- Wake word, PTT, microphone capture, VAD/AEC, pre-roll buffer, audio focus, speaker playback, and barge-in remain on Edge.
- No microphone bytes leave Edge before a valid wake/PTT trigger.
- Wake sessions use a 1-second pre-roll default and 2-second maximum after trigger. PTT has no pre-press audio by default.
- Use a separate authenticated WSS audio session with Opus first; evaluate WebRTC later.
- Whisper, Piper, model providers, conversation state, policy, and typed tools run centrally.
- Raw audio is not retained by default in Core, inference containers, logs, temporary files, or support bundles.
- An unauthenticated voice turn acts as a constrained device/room principal. Sensitive mutations require stronger authentication or confirmation.
- Canvas Intelligence shadows Hermes without mutating credentials, then replaces intents behind gates. Never fall back to another executor after an uncertain mutation.
- Defer offline local voice intents until the central path is stable.

## Consequences

- Voice can use central GPUs without creating a continuous surveillance stream.
- Inference failures must not disconnect device control or Home Assistant.
- Hermes remains until structured outcome and safety parity are measured.

## Validation gates

- Packet tests prove no pre-trigger transmission, bounded pre-roll, PTT policy, mute, and no post-session frames.
- Provider failures restore audio focus and leave existing media usable.
- Every mutating tool is typed, authorized, journaled, and uncertainty-aware.
- Hermes remains removable only after the defined corpus and stable-release gates pass.
