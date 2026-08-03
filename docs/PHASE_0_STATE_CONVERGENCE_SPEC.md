# Phase 0 state convergence and authority specification

| Field | Value |
|---|---|
| Status | Normative convergence reference plus executable model |
| Runtime scope | Implemented in current Core/Edge code; model remains isolated |
| Executable model | `tests/state-model/phase0-state-model.ts` |
| Tests | `tests/state-model/phase0-state-model.test.ts` |
| Last reviewed | 2026-07-31 |
| Platform | TypeScript, Node 20 built-ins, `node:test` |

## 1. Purpose and limits

This specification defines an isolated convergence model for one Core desired-state authority and one Edge replica. It proves ordering, fencing, application reporting, local override, cutover, and rollback invariants before those rules are introduced into a production Core, protocol, database, or Edge Agent.

The model deliberately does not implement networking, persistence, authentication, retries, transport ACKs, hardware adapters, or production APIs. Explicit integer timestamps stand in for a trusted monotonic model clock, and in-memory copy-on-write values stand in for durable records.

## 2. State domains

The executable model uses a fixed, ordered set of representative device domains:

1. `scene`
2. `display`
3. `audio`
4. `media`
5. `voice`
6. `schedule`
7. `update`

The ordering is part of deterministic digest and report generation. Production contracts may refine domain schemas, but must preserve the authority and convergence invariants below.

## 3. Core desired authority

### 3.1 Single active authority epoch

`CoreDesiredAuthority` has exactly one active `authorityEpoch`. It may retain used epoch IDs only to prevent reuse. A cutover installs a different epoch and a full desired snapshot; it does not make both epochs active.

Within an epoch:

- revisions are positive safe integers;
- every newly published revision must be strictly greater than the current revision;
- a partial update identifies its `baseRevision` and `baseDigest`;
- a full snapshot explicitly represents every known domain as `desired` or `absent`;
- omitted domains in a partial update retain their prior desired value and per-domain revision;
- an explicit `absent` partial directive removes Core desire for that domain.

Revision numbers may restart in a new authority epoch because the epoch fences the revision namespace.

### 3.2 Canonical desired digest

Desired state is normalized as JSON with lexically sorted object keys and fixed domain ordering. Its digest is SHA-256 over that canonical materialized state.

The digest is a content commitment, not evidence that the Edge applied anything. Core desired state and Edge application truth remain separate.

### 3.3 Edge desired-message acceptance

For the active epoch, the Edge applies these checks in order:

1. A retired epoch is rejected as `stale_authority_epoch`.
2. Any other non-active epoch is rejected as `unexpected_authority_epoch`; only the explicit cutover operation may install a new epoch.
3. A lower revision is rejected as `stale_revision`.
4. The current revision with a different digest is rejected as `revision_digest_conflict`.
5. The current revision with the same digest is an idempotent `duplicate`.
6. A newer partial update must match the Edge's current base revision and digest or is rejected as `base_revision_conflict` / `base_digest_conflict`.
7. The Edge materializes the candidate and recomputes its digest. A mismatch is rejected as `invalid_state_digest`.
8. Only after all checks pass does the accepted global revision advance.

A delayed message from an epoch retired by cutover can never modify desired, application, observation, or lease state.

## 4. Per-domain convergence state

Every reported domain contains three independent records.

### 4.1 Desired record

| Status | Meaning |
|---|---|
| `desired` | Core currently specifies a state, with the domain's desired revision and value digest. |
| `absent` | Core intentionally has no desired value for this domain. |

A partial update changes only included domains. Therefore different domains may legitimately reference different desired revisions while the authority has one later global revision.

### 4.2 Application record

| Status | Meaning |
|---|---|
| `not_requested` | The domain has no Core desired value. |
| `pending` | A Core desired value exists but the Edge has not reported it applied. |
| `applied` | The Edge observed the exact desired value digest for that domain and revision. |
| `diverged` | The Edge observed a different actual value and supplied a typed divergence reason. |
| `failed` | The Edge could not apply/evaluate the desired value and supplied a typed failure reason. |
| `overridden` | An active local override lease has precedence for this domain. |

Application state records the current target and the last successfully applied revision/digest separately. A newer partial desired update can put one domain back into `pending` without rewriting another domain's `applied`, `diverged`, or `failed` result.

### 4.3 Typed reasons

Divergence reasons are a discriminated union:

- `constraint_clamped`
- `unsupported`
- `observed_state_mismatch`

Application failure reasons are a discriminated union:

- `dependency_unavailable`
- `adapter_error`

An active local lease uses the typed `local_override_active` reason with lease ID, source, and expiry. Arbitrary untyped reason strings are not application status.

### 4.4 Edge-observed truth

Observed state is independently reported as `unknown` or `observed`, with:

- canonical actual JSON state;
- actual-state digest;
- observation timestamp;
- adapter/renderer/agent/local-override source.

Core desired acceptance never fabricates observed state. An `applied` report is rejected if its actual-state digest differs from the target digest; the Edge must instead report `diverged`. A later observation that differs from a previously applied target changes application status to `diverged` with `observed_state_mismatch` while preserving the truthful observation.

## 5. Partial application

Application is per-domain and non-transactional across domains. For example, one desired revision may truthfully report:

- `scene`: `applied` by the renderer;
- `display`: `diverged` because brightness was clamped;
- `audio`: `failed` because the sink dependency was unavailable;
- `update`: `not_requested` because no desired update policy exists.

Core must not collapse this into one optimistic device-level `applied` boolean.

## 6. Local override leases

A lease contains:

- unique `leaseId`;
- typed source: `physical_control`, `local_admin`, or `safety_policy`;
- inclusive start time;
- exclusive expiry time;
- non-empty, unique allowed-domain set;
- actual state for exactly those allowed domains.

Phase 0 permits one active lease in the model. A newer lease with a strictly later start supersedes the active lease as a whole. This makes precedence unambiguous:

1. While active (`startsAtMs <= now < expiresAtMs`), the lease owns its allowed domains.
2. Core application reports for those domains are rejected as `local_override_active`.
3. Domains not allowed by the active lease continue to use Core desired state.
4. A superseded lease is terminal and never resumes after the newer lease expires.
5. At exact expiry, the lease becomes `expired`, affected desired domains become `pending`, and Core desired state is again the effective target.
6. The last local actual observation remains truthful until a later Edge observation/application replaces it.

Lease history records `active`, `expired`, and `superseded` lifecycle states, including deterministic end time and superseding lease ID.

## 7. Authority modes and write fencing

The complete authority-mode type is:

| Mode | Legacy writable | Core writable |
|---|---:|---:|
| `legacy` | Yes | No |
| `shadow` | Yes | No |
| `core` | No | Yes |
| `rollback_pending` | No | No |

There is no `dual_write` value and no mode in which both sides are writable. `shadow` lets Core prepare/compare a candidate snapshot but does not grant Core authoritative writes.

The executable migration path is:

```text
legacy -> shadow -> core -> rollback_pending
```

### 7.1 Cutover

A `shadow -> core` cutover is accepted only when:

- the candidate is a full snapshot;
- its authority epoch differs from the Edge's active and retired epochs;
- every domain is represented;
- its materialized desired digest is valid;
- the Edge durably accepting the snapshot is modeled as successful.

Only then does the write fence move to `core`. The previous epoch is retired. Application history from the old epoch is not treated as application of the new epoch, although the last Edge observation remains truthful.

### 7.2 Rollback fencing

Entering `rollback_pending` from `core` freezes both authoritative sides. Neither a legacy callback nor a Core callback is executed. This model intentionally provides no direct transition from `rollback_pending` back to a writable mode: reconciliation and creation of a new rollback authority epoch must be designed and approved separately.

## 8. Deterministic reported snapshots

A report contains:

- schema identifier and explicit report time;
- active epoch, accepted global revision/digest, acceptance time, and sorted retired epochs;
- every domain in fixed order with desired, application, and observed records;
- active lease ID and deterministically ordered lease history;
- `reportDigest`, calculated over the canonical report body without the digest field itself.

All incoming JSON is normalized. Equivalent states produce byte-identical `JSON.stringify` output and the same report digest regardless of object key order, domain operation order at equal timestamps, or lease allowed-domain input order.

## 9. Executable evidence

From the repository root, run exactly:

```bash
./node_modules/.bin/tsx --test tests/state-model/*.test.ts
```

The suite covers:

- strict Core revision monotonicity and epoch replacement;
- mandatory full-snapshot cutover;
- delayed messages from retired epochs;
- stale revision and same-revision/different-digest rejection;
- independent applied/diverged/failed domain outcomes;
- partial desired updates and explicit desired removal;
- active, expired, and superseded local override leases;
- Core precedence at exact lease expiry;
- no dual-write mode;
- `rollback_pending` with neither side writable;
- deterministic reported snapshots and report digests.
