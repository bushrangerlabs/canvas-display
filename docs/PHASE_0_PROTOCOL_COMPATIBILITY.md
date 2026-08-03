# Phase 0 Core/Edge protocol compatibility policy

| Field | Value |
|---|---|
| Status | Normative compatibility baseline |
| Applies to | Authenticated Canvas Core ↔ Canvas Edge Device Protocol control sessions |
| Current production protocol | **v1** |
| Previous production protocol | **None** |
| Last reviewed | 2026-07-31 |
| Test-only previous fixture | Synthetic **v0**, used only by `tests/compatibility/` |
| Legacy boundary | `/ws` remains a separate legacy protocol and is never a negotiation fallback |

## 1. Scope and invariants

This policy defines how Core and Edge negotiate and coexist across rolling releases. It refines
ADR 0005; it does not change any runtime contract.

The following are non-negotiable:

1. Device Protocol v1 is the current production contract at `/device/v1/control`.
2. There is no production Device Protocol v0 schema, implementation, endpoint, support promise, or downgrade target. Synthetic v0 exists only to exercise generic N/N-1 negotiation tests.
3. Protocol authentication and device authorization happen before version negotiation. A mutually supported version never overrides an invalid, expired, revoked, cloned, or unauthorized device identity.
4. The selected version is fixed for one control session. A peer cannot switch versions in place.
5. Core and Edge validate and serialize the selected version's actual contract. They must not validate only the newest schema and label the result as an older version.
6. Version overlap is necessary but not sufficient. Capabilities, downgrade floors, local data compatibility, stream epochs, and authority epochs can still prevent resume or connection.
7. A compatibility failure never falls back to legacy `/ws`, an unauthenticated endpoint, or a best-effort interpretation of a message.

## 2. Version terminology and support window

For a future current version **N**:

- **current** means N;
- **previous** means N-1, but only if N-1 was a released production contract;
- **normal rolling window** means the period in which supported Core N and Edge N packages implement both N and N-1;
- **downgrade floor** means the lowest version a peer and the Core device record are permitted to select, even if lower code remains installed.

### 2.1 Production state in Phase 0

The production support set is currently `{1}`. Core and Edge therefore advertise v1-only ranges and use a floor of 1. The range `{0,1}` and v0-only peers in `tests/compatibility/` are synthetic fixtures; they demonstrate the future N/N-1 algorithm without creating a v0 production contract.

### 2.2 Required N/N-1 window for future releases

Before the first deployable N package is promoted:

- Core N must accept and correctly serve N and N-1.
- Edge N must connect correctly to Core N and Core N-1 by supporting N and N-1.
- Core N-1 and Edge N-1 continue to use N-1.
- Version-specific validators, serializers, fixtures, and conformance tests must exist for every advertised production version.
- Database and local-cache migrations must remain compatible with the approved package rollback path.

The window starts before the first Core or Edge N rollout. It ends only when all of these are true:

1. telemetry and inventory show that no supported online or recoverable installation still requires N-1;
2. current and cached rollback packages no longer require N-1 interoperability;
3. N-only features and data have an approved downgrade/retirement disposition;
4. Core and Edge rollback drills pass without selecting below the proposed new floor;
5. operators explicitly raise the per-device/fleet downgrade floor to N; and
6. removal of N-1 validators and serializers is reviewed as a breaking compatibility change.

Elapsed time alone does not close the window. N-2 and older versions are unsupported unless a separately approved emergency extension names the exact versions, duration, owners, and rollback plan.

### 2.3 Expected rolling matrix

| Core package | Edge package | Selected protocol during the window |
|---|---|---|
| N | N | N (highest overlap) |
| N | N-1 | N-1 |
| N-1 | N | N-1 |
| N-1 | N-1 | N-1 |
| N | N-2 | Refuse: no supported overlap |

This matrix is abstract. In Phase 0, N is v1 and there is no production N-1 row.

## 3. Negotiation

### 3.1 Inputs

After mTLS identity and registry checks succeed, Edge sends `edge.hello` with:

- an inclusive, contiguous `protocol.minimum` and `protocol.maximum` range;
- Agent/build information for diagnostics, never as proof of compatibility;
- advertised capabilities;
- any durable resume cursor and stream epochs.

Core has its own supported range, local minimum, and a persisted downgrade floor for that device or rollout. Core also knows which capabilities, if any, are mandatory for a safe baseline session.

A version range is malformed if either endpoint is absent, not an integer, below the production protocol minimum, outside the implementation's bounded numeric range, or if `minimum > maximum`. The executable model permits zero solely for its synthetic v0 fixture; production v1 validation still requires values of at least 1.

### 3.2 Selection algorithm

For valid ranges:

```text
raw_min = max(core.minimum, edge.minimum)
raw_max = min(core.maximum, edge.maximum)
effective_floor = max(core.floor, edge.floor, persisted_device.floor)
```

Core applies these rules in order:

1. If `raw_min > raw_max`, refuse with `no_protocol_overlap`.
2. If `raw_max < effective_floor`, refuse with `downgrade_below_floor`.
3. Otherwise select `raw_max`, the highest mutually supported version.
4. Compute enabled capabilities as the exact intersection of capabilities understood by Core and advertised by Edge.
5. If a required baseline capability is not enabled, refuse with `missing_required_capability`.
6. Evaluate resume separately. Exact compatible epochs and cursors may resume; otherwise establish fresh streams and perform full state reconciliation.
7. Return the one selected version in `core.welcome`. Every post-handshake message must use it.

Selecting the highest overlap prevents an attacker or stale configuration from silently forcing N-1 when both peers support N. A downgrade floor is raised only through an explicit rollout decision; it is not automatically raised merely because N was once negotiated, because doing so would destroy the approved N-1 rollback window. Once raised, ordinary package rollback or reconnect cannot lower it.

If the hello is parseable, Core should return a bounded typed refusal before closing. It must not disclose sensitive registry or certificate details in the refusal.

### 3.3 Session and resume binding

The selected protocol, authenticated device principal, enabled capabilities, Core stream epoch, Edge stream epoch, and authority epoch form the compatibility context for a session.

- A selected protocol cannot change until reconnect.
- A reconnect selecting the same protocol may resume only when all cursor and epoch checks pass.
- A reconnect selecting a different protocol starts fresh directional stream epochs and a full reconciliation. Logical command IDs, idempotency keys, and results are reconciled; old wire messages are not blindly re-encoded or replayed.
- Negotiation success does not imply resume success. An epoch mismatch normally refuses resume while allowing a fresh authenticated v1 session.

## 4. Schema evolution policy

### 4.1 Additive changes

A change is additive within an existing protocol or payload version only when an older conforming receiver remains correct and safe if it ignores the change. Examples include:

- adding an optional field with an explicitly documented absence/default meaning;
- adding optional diagnostic metadata that does not affect identity, authorization, ordering, expiry, digests, idempotency, or execution class;
- adding a capability token that activates nothing unless both peers enable it; or
- widening a documented extension object whose unknown fields are already permitted and safely ignored.

An additive sender must continue to work when the field or capability is absent. It may not require the old receiver to preserve, echo, sign, hash, authorize from, or act on an unknown field.

A new message type is not automatically additive. It may remain within a version only when it is an optional, capability-gated feature and old peers are never sent that type. Otherwise it requires a new payload/protocol version as appropriate.

### 4.2 Breaking changes

The following are breaking unless isolated behind an already-defined version/capability mechanism:

- removing or renaming a field or message type;
- making an optional field required;
- changing a field's type, units, normalization, default, bounds, or meaning;
- narrowing accepted values or adding an enum/discriminator value where old receivers reject unknown values;
- changing envelope, handshake, ordering, ACK, replay, expiry, stream, authority, digest, idempotency, or side-effect semantics;
- adding a mandatory baseline capability;
- changing canonical serialization or request-digest inputs;
- sending a new message or payload version to a peer that did not advertise support; or
- changing an ignored field into an authorization or execution input.

A message-local incompatible payload generally requires a new `payload_version` plus explicit gating. A handshake, common-envelope, transport, stream, authority, or cross-message semantic change requires a new protocol version. During N/N-1 support, each version retains its own validator and serializer; translation occurs through typed internal domain models, not by mutating an N message until it passes an N-1 schema.

### 4.3 Review rule

Every schema change must be classified additive or breaking in review and include fixtures for:

- the selected current version;
- the previous version while its window is open;
- unknown optional fields where permitted;
- rejected unknown required semantics; and
- capability-present and capability-absent behavior.

When classification is uncertain, treat the change as breaking.

## 5. Capability gating

Capabilities refine a selected protocol; they do not replace version negotiation.

1. Capability identifiers are stable, exact, versioned tokens such as `media.youtube-iframe-v1`. Prefix similarity does not enable a capability.
2. Absence means unsupported. Core must not infer support from Agent version, platform, architecture, a prior session, or another device.
3. Core sends capability-dependent desired fields, command kinds, payload versions, content, and voice/media behavior only to an Edge that advertised the required capability in the current session.
4. Unknown capability tokens are retained only as bounded telemetry if useful; they are not enabled and do not fail the whole session unless a declared baseline requirement is missing.
5. Missing optional capability degrades only that feature. Core records it as unsupported and avoids dispatch.
6. If a capability is mandatory for safe baseline operation, its absence is an explicit handshake refusal. Mandatory baseline changes are breaking and require a protocol/support-window review.
7. Edge independently validates capability-dependent work. If Core violates the gate, Edge rejects it with a typed `unsupported_capability`/`unsupported_payload` result and performs no side effect.
8. Capability changes take effect on a new session. Revocation of a safety-sensitive capability may force reconnect; it is never assumed from stale registry data.

## 6. Rolling upgrade and downgrade rules

### 6.1 Common rules

- Either Core or Edge may be upgraded first only after the N/N-1 matrix passes in both directions.
- A package advertises a version or capability only after that implementation and its required data migration are healthy.
- N-only behavior remains disabled per device until that device negotiated N and advertised every required capability.
- Protocol choice is per session, not fleet-wide, but Core authority remains singular. Mixed versions do not create mixed write authority.
- Deployment telemetry records package version, advertised range, selected protocol, downgrade floor, capabilities, resume outcome, and refusal code without credentials.

### 6.2 Core upgrade

1. Deploy expand/backward-compatible storage changes before N-only writers.
2. Start Core N with both N and N-1 validators/serializers active.
3. Existing Edge N-1 sessions may continue or reconnect on N-1. Core must not send them N-only fields, payloads, or commands.
4. Edge N sessions select N on reconnect. No in-place version switch occurs.
5. Contract storage/removal and floor raising happen only after the support-window exit gates pass.

A clean Core binary restart or rollback that does not restore data and does not change authority may preserve authority and stream epochs if the same selected protocol and durable cursor state remain valid. A protocol change starts fresh streams. Any database restore follows Section 8 instead.

### 6.3 Edge upgrade

1. The updater verifies signature, architecture, data compatibility, and available rollback before activation.
2. Edge N retains N-1 support for the full window, reconnects, and advertises only capabilities that passed local health checks.
3. If Core is still N-1, the Edge selects N-1. If Core is N, it selects N.
4. Existing durable receipts and logical results survive the package change. A new binary must not re-execute work merely because its wire serializer changed.

### 6.4 Core downgrade

Core may downgrade from N to N-1 only when:

- the effective downgrade floor permits N-1;
- Core data and migrations are backward compatible without restoring an older authoritative database;
- no active supported Edge requires N-only connectivity;
- N-only desired fields/features are disabled or have an approved representation;
- pending commands can be represented safely at N-1; and
- uncertain/non-repeatable operations are reconciled rather than replayed.

If any condition fails, downgrade is refused and Core remains on the current known-good package or enters controlled maintenance. Restoring an older database to force a downgrade is a disaster restore, not an ordinary rollback.

### 6.5 Edge downgrade

Edge may downgrade from N to N-1 only through the signed, authorized rollback path and only when:

- all effective downgrade floors permit N-1;
- the local database/cache is backward compatible;
- durable command receipts, outcomes, and known-good content remain interpretable; and
- Core still supports N-1.

After downgrade, Edge reconnects and advertises its reduced range/capabilities truthfully. Removed capabilities are gated immediately. If local state was restored or cursor continuity is uncertain, Edge creates a new outbound stream epoch and requests full reconciliation. An ordinary downgrade never erases a known side effect or converts an uncertain outcome into a retry.

There is no production v1→v0 downgrade path.

## 7. Unknown messages, versions, fields, and values

| Input | Required behavior |
|---|---|
| Unknown optional field allowed by the selected schema's extension point | Ignore it safely. Do not use it for identity, authorization, ordering, digest, expiry, idempotency, or execution. Do not require it to be echoed. |
| Unknown field in a schema object that is closed | Reject that message as schema-invalid. |
| Unknown capability token | Do not enable it. Optionally record bounded telemetry; continue if no required baseline capability is missing. |
| Unknown enum/discriminator value with no defined fallback | Reject the message. Never map it to a privileged/default action. |
| Unsupported `payload_version` | Reject with a typed protocol error/result and perform no side effect. |
| Message `protocol` differs from the session's selected version | Reject as a session protocol violation. |
| Unknown message `type` | Treat as unknown required semantics: persist/audit a bounded error, send a typed protocol error when safe, do not execute, do not advance the durable ACK/application cursor past it, and close the incompatible session. |
| Duplicate known message with same epoch/sequence but different content | Refuse/reset the stream; never choose either body silently. |

A sender is responsible for capability/version gating before transmission. Receiver tolerance for optional fields is not permission to probe it with unknown actions.

## 8. Stream and authority epochs across restart and restore

### 8.1 Meanings

- Each durable direction has a sender-owned **stream epoch** and a contiguous monotonic sequence within that epoch.
- The Core-owned **authority epoch** identifies one coherent desired-state authority history. Desired revisions are comparable only inside one authority epoch.
- Epoch identifiers are opaque and never reused after their history may have diverged or rolled back.

### 8.2 Ordinary restart/reconnect

A process restart with intact, current durable storage is not a restore. It may preserve epochs and resume only if both peers present the exact expected stream epochs, the selected protocol is unchanged, cursors are valid/contiguous, and retained history can satisfy replay. Otherwise resume is refused and fresh streams/full reconciliation are required.

### 8.3 Core backup restore or ambiguous Core history

Before accepting authoritative traffic after restoring Core data:

1. Core enters maintenance/degraded mode and validates security, object, command, and state continuity.
2. Core mints a new outbound Core stream epoch. It never continues a restored sequence under an epoch whose later values may already have been observed.
3. Core invalidates ambiguous saved Edge inbound cursors and requires each Edge to establish a new outbound Edge stream epoch before new reports/results are accepted as current.
4. Core mints a new authority epoch before publishing desired state. Revisions may restart within the new epoch and are never numerically compared with the old epoch.
5. Resume against pre-restore stream or authority epochs is refused. An otherwise authenticated/version-compatible connection may continue only as a fresh session.
6. Core sends a full desired snapshot under the new authority epoch; deltas alone are insufficient.
7. Edge may keep displaying its last-known-good scene, but labels/reports it as stale until it evaluates the new full snapshot.
8. Edge-held outbox records and command results are reconciled by stable logical IDs/digests. Core must not invent lost intent, and non-repeatable ambiguous effects become/remain `unknown_outcome` rather than being retried.

If Core knows a restore occurred but cannot prove fresh stream and authority epochs, it must refuse authoritative sessions/writes rather than risk replay or split brain.

### 8.4 Edge restore or ambiguous Edge history

After restoring Edge local data, Edge:

1. keeps its authenticated device identity only if key/certificate continuity is valid;
2. mints a new outbound Edge stream epoch and does not claim a cursor from the discarded future;
3. treats the Core stream cursor and command-receipt history as uncertain and requests full reconciliation;
4. does not mint or select the Core authority epoch;
5. reports actual locally visible/applied state truthfully after reconnect; and
6. never re-executes non-repeatable work solely because a receipt was lost in the restore.

Core responds with its current stream and authority context and a full desired snapshot. Lost receipt ambiguity is handled through command-specific reconciliation or `unknown_outcome`.

### 8.5 Epoch mismatch handling

An epoch mismatch is a **resume refusal**, not automatically a device-authentication or version refusal. The safe result is `resume.accepted = false`, fresh directional streams as required, and full desired/reported reconciliation. Any peer that continues sending old-epoch messages, reuses an epoch with conflicting content, or applies old-authority desired state is refused at the message/session boundary.

## 9. Explicit refusal conditions

### 9.1 Refuse the connection

Core refuses or closes the connection when any of these apply:

- mTLS identity, registry status, certificate validity/revocation, clone policy, or authorization fails;
- hello/range/capability data is malformed, oversized, duplicated where uniqueness is required, or semantically invalid;
- supported ranges have no overlap;
- the highest overlap is below an effective downgrade floor;
- a safe baseline capability is absent;
- Core cannot load the exact validator/serializer for the selected version;
- local Core/Edge data is incompatible with the selected version and cannot safely migrate/roll back;
- a peer attempts to change protocol in-session or sends a different envelope protocol;
- an unknown required message/payload semantic prevents safe ordered processing;
- a capability-gated side effect is attempted without the capability;
- stream sequence/epoch content conflicts indicate replay, corruption, or required reset and the peer does not reset; or
- restore continuity is ambiguous and fresh stream/authority epochs have not been established.

### 9.2 Refuse only resume and start fresh

When identity, version, and baseline capabilities remain valid, Core refuses resume rather than the whole connection for:

- missing resume state on a fresh installation;
- stream or authority epoch mismatch;
- cursor ahead of durable history, non-contiguous cursor, or truncated replay history;
- selected protocol differing from the protocol bound to the saved cursor; or
- a validated restart/restore that intentionally rotated epochs.

Resume refusal discards no known command outcome and authorizes no old-epoch replay. If full reconciliation cannot be completed safely, the session then fails closed.

### 9.3 Refusal response

Use stable, typed, bounded reason codes; audit the authenticated device and server-side detail; expose only enough detail for remediation. Close after handshake/session refusal as appropriate. Never retry negotiation at `/ws`, lower a floor automatically, reinterpret malformed JSON, or select an unadvertised version.

## 10. Executable policy model

`tests/compatibility/negotiation-model.ts` is a pure test model, not runtime code. It exercises highest-overlap selection, downgrade floors, capability intersection, and exact epoch matching. Its zero-valued synthetic previous version exists only to test the future N/N-1 policy.

Run from the repository root:

```bash
node --import tsx --test tests/compatibility/*.test.ts
```

The suite covers:

- current v1 ↔ current v1;
- current ↔ synthetic previous in both Core-first and Edge-first rolling order;
- no overlap;
- malformed range;
- downgrade-floor refusal;
- restore epoch mismatch and full-resync behavior; and
- capability intersection and required-capability refusal.
