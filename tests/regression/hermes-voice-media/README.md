# Hermes / voice / media Phase 0 regression harness

This isolated harness freezes structured intent, action, safety, transport, and playback outcomes for later Canvas Intelligence parity work. It does not import or invoke the current server, Hermes, Home Assistant, a browser, or an Edge runtime, and it performs no network requests.

## Files

- `../../fixtures/hermes-voice-media/corpus.v1.json` — versioned stimuli and expected canonical outcomes.
- `../../fixtures/hermes-voice-media/reference-observations.v1.json` — sanitized adapter-neutral observations representing the reference behavior boundary.
- `types.ts` — fixture and observation contracts.
- `fixtures.ts` — strict built-in JSON loader and basic shape/uniqueness checks.
- `evaluator.ts` — deterministic canonicalization, policy invariants, evidence-derived result evaluation, and corpus summaries.
- `hermes-voice-media.test.ts` — `node:test` corpus, negative mutation, hygiene, and shadow-safety tests.

## Run

From the project root with Node 20 and the already-installed root development tools:

```sh
npm run test:regression
```

The suite is also included in the root `npm run test:contracts` CI gate.

## Adapter-neutral observation contract

An adapter maps a Hermes turn, Canvas Intelligence shadow turn, or captured Edge trace to `AdapterObservation`:

- `intent` is the canonical semantic intent.
- `actions` contain typed action identity and normalized inputs, not provider prose.
- `status: planned` means a shadow prediction that must not execute.
- `status: proposed` means held for confirmation.
- `status: issued` means the authoritative executor issued the action.
- `safety` records the policy decision and risk level.
- `events` carry correlated navigation, tool, audio-focus, and actual Edge media evidence.
- `transport` records transport kinds and outcomes without endpoint URLs or credentials.

`baseline` mode checks the complete expected result, including transport fallback and correlated execution evidence. `shadow` mode compares intent/action/safety and no-action/clarification outcomes, ignores executor-only success for planned actions, and fails if an action is issued or side-effect evidence appears.

For YouTube playback, `edge.webview.opened` and `edge.media.state: ready` are not success. Only a correlated `edge.media.state: playing` event completes a `media.play` action.

## Deliberate limitations

- The committed observations are sanitized, deterministic representatives; they are not raw production logs or audio.
- The harness does not call ASR, Hermes, YouTube, Home Assistant, WebKitGTK, or real Edge hardware.
- URL normalization covers the current representative YouTube forms, not every future YouTube URL variant.
- It evaluates structured response mode (answer, clarification, no action) but not natural-language factuality, TTS quality, or subjective response quality.
- It does not measure latency, resource use, real error 153 behavior, PC/Pi platform differences, or actual audio-focus hardware behavior.
- Future systems need a small adapter that emits `AdapterObservation`; this harness intentionally does not bind to a Hermes or Canvas Intelligence wire format.
