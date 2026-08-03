# Phase 0 command and capability catalog

## Status and boundary

**Normative reference; reviewed 2026-07-31.** The machine-readable sources below are
authoritative over prose.

The machine-readable sources are:

- `contracts/device/v1/capability-registry.json`
- `contracts/command/v1/command-catalog.json`
- `contracts/command/v1/fixtures/request-digest/`

Only `diagnostics.echo` is active in the current Device Protocol v1 schema. Every other catalog entry is a planned contract boundary, not an implemented or authorized command. Adding one to the wire still requires a versioned parameter/result schema, positive/negative fixtures, policy review, Agent adapter, conformance tests, and rollback behavior.

Android remains frozen. The registry covers Linux `amd64` and `arm64` only.

## Capability rules

1. Registry presence means the token is named and its semantics are frozen; it does not mean every Edge supports it.
2. Edge advertises only capabilities installed, enabled, and healthy for the current authenticated session.
3. Core gates command, desired-state, content, media, and voice behavior on the exact category/token pair.
4. Absence means unsupported. Core never infers support from architecture, package version, IP address, another device, or an earlier session.
5. Unknown tokens do not grant behavior. A required missing token rejects or reports unsupported before side effects.
6. An incompatible semantic change creates a new token; an old token is not silently redefined.
7. The current legacy/prototype status is inventory evidence, not a production security claim.

## Desired state versus commands

Long-lived convergent intent belongs in desired state, including scene assignment, display power/brightness, audio volume, voice policy, and update channel. Commands are bounded imperative operations with an explicit lifecycle. A command must not be invented merely to bypass desired-state convergence.

The planned catalog intentionally excludes arbitrary URL navigation, shell commands, package paths, credentials, Home Assistant bearer operations, and generic service calls. Those would violate the Edge and Core trust boundaries.

## Execution classes

- `replay_safe`: intrinsically safe to rerun and yields the same logical result.
- `state_reconcilable`: after interruption, observe the postcondition; complete only when proven and never blindly repeat.
- `externally_idempotent`: reserved for a Core integration whose external API contractually deduplicates the same Canvas key. It is not currently assigned to an Edge command.
- `non_repeatable`: after execution may have started, never retry automatically; persist/report `unknown_outcome` unless an authoritative observation proves the result.

The class is fixed by `(kind, semantic_version)` in the catalog/schema. A caller cannot request a weaker class.

## Canonical request digest v1

`request_digest` commits to one logical request and is encoded as lowercase `sha256:<64 lowercase hex>`.

1. Strictly parse I-JSON; reject duplicate decoded member names, invalid Unicode, floats, and integers outside the JavaScript safe range.
2. Construct exactly four top-level fields: `kind`, positive `semantic_version`, object `parameters`, and object `preconditions` (empty when absent).
3. Serialize with RFC 8785 JCS. Object keys are UTF-16 code-unit ordered and array order is significant.
4. SHA-256 hash the canonical UTF-8 bytes.

Excluded transport/audit fields include command/message IDs, idempotency key, stream epoch/sequence, sent/created/not-before/expiry times, clock uncertainty, correlation, requested actor, retry count, and delivery attempt. Those may differ across transport attempts without changing the logical operation.

Changing kind, semantic version, any parameter, any precondition, object value, or array order changes the digest. Reusing an idempotency key with a different digest is `idempotency_conflict` and never replays or executes the unrelated request.

Shared Node/Rust vectors prove key-order/whitespace invariance, mutation sensitivity, array ordering, Unicode, and strict invalid-input rejection. The active `diagnostics.echo` lifecycle fixtures use the frozen real digest rather than placeholders.

## Remaining implementation gates

- Planned command parameter/result schemas and protocol fixtures.
- Core authorization, confirmation, expiry, capability, and precondition policy.
- Durable Core/Edge journals and real Agent adapters.
- Hardware/media/updater postcondition reconciliation on PC and Pi.
- Explicit cancellation and progress schemas for long-running work.
- Production support-bundle/privacy review for any future diagnostics command.
