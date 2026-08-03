# ADR 0005: Device Protocol v1

- Status: Accepted
- Date: 2026-07-18
- Decision IDs: P-004, O-012, O-014

## Context

The legacy `/ws` protocol has an unauthenticated hello, decorative version field, open-ended commands, optimistic delivery, no replay, and no desired/reported state. It is also shared with admin clients and must not be silently redefined.

## Decision

- JSON Schema Draft 2020-12 under `contracts/device/v1/` is the wire-contract source of truth.
- Generate and commit TypeScript and Rust types; CI regenerates and rejects drift.
- Device Protocol v1 uses a separate `/device/v1/control` boundary. Legacy `/ws` is not Protocol v1.
- Durable messages carry message ID, protocol/payload version, stream epoch, monotonic sequence, timestamp, and correlation where applicable.
- Handshake, heartbeat, and stream ACK are not recursively acknowledged.
- Core owns desired state; Edge owns applied/reported state. Authority epochs and per-domain status prevent stale or partial state from appearing successful.
- Delivery is at least once with durable deduplication. Command kinds declare replay-safe, state-reconcilable, externally idempotent, or non-repeatable semantics.
- Non-repeatable crash windows produce `unknown_outcome`; they are never automatically retried.
- Version 1 begins with the side-effect-free `diagnostics.echo` command as a conformance slice.

## Consequences

- Schema and fixture changes are reviewed API changes.
- Existing clients remain on explicitly labeled legacy paths during coexistence.
- Generated types do not replace runtime schema and semantic validation.
- A production Agent needs durable inbox/outbox/receipts before acknowledging work.

## Validation gates

- Positive/negative fixtures pass AJV and Rust Draft 2020-12 validation.
- Generated TypeScript and Rust are deterministic and drift checked.
- Simulator proves hello/welcome, resume, state convergence, duplicate delivery, command replay, digest conflict, contiguous sequence, and ACK cursors.
- At least 100 concurrent simulated Edges pass before protocol freeze.
