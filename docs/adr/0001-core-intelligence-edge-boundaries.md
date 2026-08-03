# ADR 0001: Core, Intelligence, and resilient Edge boundaries

- Status: Accepted
- Date: 2026-07-18
- Decision IDs: D-001 through D-006, P-008, P-010, P-011

## Context

Every Linux display currently carries a full Fastify server, SQLite database, administration assets, integrations, voice orchestration, media routes, and hardware execution. Multiple instances can disagree about state and duplicate work.

## Decision

- Canvas Core is the single fleet-wide authority for users, devices, desired state, scenes, commands, integrations, audit, and orchestration.
- Canvas Intelligence is the native intent, policy, model-provider, and typed-tool layer within the Core platform. Hermes is transitional.
- Canvas Edge remains resilient and owns rendering, hardware, playback, local wake word, cache, applied state, and offline continuity.
- Home Assistant remains the home-integration and automation authority.
- Start with one Docker Compose Core deployment and explicit service boundaries; do not claim high availability yet.
- MQTT terminates at Core and enters the same state/action journal. It is not an independent Edge command path.
- Linux `amd64` and `arm64` are active. Android remains frozen.

## Consequences

- Edge is neither a full server nor a dumb browser.
- Core outages must not blank active content or stop already-running media.
- The current sidecar remains during coexistence and is removed only after all replacement and rollback gates pass.
- All fleet mutations need one authoritative path and an auditable actor/action ID.

## Validation gates

- Two simulated devices maintain independent desired/reported state.
- Core process restart reconstructs pending work from durable storage.
- Edge boots its last-known-good scene while Core is unavailable.
- No unauthenticated central compatibility endpoint is introduced.
