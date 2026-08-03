# Phase 0 scene content staging, activation, restore, and GC

## Status and scope

**Normative reference; reviewed 2026-07-31.** This document defines invariants exercised by the
isolated model in `tests/scene-store/`. Core now has PostgreSQL-backed scene revisions and asset
staging; the model remains a contract aid, while current source and integration tests determine
the deployed behavior.

The model has three deliberately separate parts:

1. `InMemorySceneDatabase`: copy-on-write metadata transactions.
2. `InMemoryContentAddressedObjectStore`: SHA-256-addressed byte objects with deterministic access order.
3. `SceneStoreRuntime`: process-local renderer preload tokens and the currently visible renderer revision.

Constructing a new runtime over the same two stores models a process restart. It drops all renderer state and successful preload tokens while preserving committed model metadata and object bytes.

## Trust and manifest acquisition

Manifest authentication is outside this model. Acquisition receives an explicit `{ authenticated: boolean }` trust decision from the hypothetical authenticated transport/signature/authorization layer. A false decision creates no revision metadata, reserves no staging budget, and cannot progress toward readiness or activation.

An authenticated manifest binds a globally unique `revisionId` to:

- a `sceneId`;
- a normalized relative entrypoint path;
- normalized relative logical paths;
- each object's lowercase SHA-256 digest; and
- each object's expected byte size.

Reusing a revision ID for different manifest content is rejected. The model hashes canonicalized manifest metadata with SHA-256 for identity, but this digest is not a signature and does not replace authenticated acquisition.

## Bounded staging and object verification

`maxStagingBytes` bounds the union of declared object bytes reachable from all revisions in `staging` or `ready`. A digest shared by paths or revisions counts once. This is a logical concurrent-staging bound, not a total disk quota; abandoned objects become unreachable and are reclaimed by GC.

Only objects named by a live staging manifest are accepted. Before insertion, the model computes and checks:

1. actual `Uint8Array.byteLength` equals the declared size; and
2. SHA-256 of the actual bytes equals the declared digest.

A matching object already present under that digest is reused without another physical copy. A corrupt object under the expected key may be repaired only by supplying bytes that pass both checks.

## Readiness and renderer preload

A revision moves from `staging` to `ready` only when every manifest object is present and a fresh read of every object has the expected actual size and SHA-256. There is no partial-ready state.

Renderer preload receives cloned, verified bytes for the complete logical bundle. Failure or exception creates no activation credential. Success creates a process-local token tied to the manifest and each referenced object's mutation generation. Activation revalidates all bytes and compares that token, so missing/corrupt/replaced bytes between preload and activation fail without changing current.

A preload token is intentionally not durable. After restart, even a still-`ready` revision must be preloaded again before ordinary activation.

## Atomic activation and rollback protection

Activation is eligible only for an authenticated `ready` revision with a current successful preload token. One metadata transaction then:

1. marks the candidate `known_good`;
2. moves the old `current` pointer to `previous`; and
3. moves `current` to the candidate.

The current and previous pointers may reference only distinct authenticated `known_good` revisions. The process-local visible renderer revision changes only on the successful activation path.

Crash injection defines two observable boundaries:

- `before_activation_commit`: no pointer or lifecycle change is committed;
- `after_activation_commit`: the complete current/previous update is committed, and restart must restore the new current after fresh validation/preload.

Rollback freshly validates and preloads `previous`, then swaps current and previous in one metadata transaction. Failed validation or preload leaves current unchanged.

## Restore

Restore never trusts DB reachability alone. It re-reads each object named by current's persisted manifest, verifies actual size and SHA-256, and requires renderer preload success.

- Valid current: restore current without pointer changes.
- Invalid/unloadable current and valid previous: preload previous, atomically make it current, and clear previous rather than retaining a revision that just failed recovery.
- Invalid/unloadable current and previous: activate no renderer revision and preserve metadata for diagnosis.

Thus a DB/object mismatch is fail-safe: a DB row or pointer cannot make missing, wrong-size, or wrong-hash bytes renderable.

## LRU garbage collection

The protected object set is the union of objects reachable from:

- every `staging` revision, including incomplete downloads;
- every `ready` revision;
- `current`; and
- `previous`.

GC never deletes a protected digest. Unprotected objects are ordered by last access, with digest order as a deterministic tie-breaker, and removed until the target is met or only protected bytes remain. A target smaller than protected physical bytes returns `quotaSatisfied: false`; it does not violate protection.

Old known-good revisions outside current/previous are not protected and may be reclaimed.

## Required production integration gates

The executable model does not establish the following production properties:

### Filesystem object store

- same-filesystem temp-write plus atomic rename;
- file and parent-directory `fsync` ordering;
- secure path/open semantics and permissions;
- startup cleanup of temp files;
- concurrent writer/deduplication races;
- disk-full and I/O-error handling;
- power-loss testing on Linux `amd64` and Raspberry Pi `arm64`.

### PostgreSQL metadata

- schema, constraints, and foreign-key/reachability representation;
- transaction isolation and row/advisory locking;
- activation/rollback compare-and-swap behavior across processes;
- object publication ordering relative to DB commit;
- backup/restore consistency and migrations.

### Authenticated acquisition

- TLS/session identity, signature or MAC verification, authorization, expiry, and replay prevention;
- canonical signed manifest encoding and key rotation;
- authenticated error/reporting behavior.

### WebKit renderer

- loading into a genuinely isolated/offscreen renderer;
- readiness criteria for HTML, scripts, fonts, media, and subresources;
- network denial/content-security policy during preload;
- atomic visible-view swap and old-view retention;
- renderer process crash, timeout, and rollback behavior.

### GC coordination

- a consistent reachability snapshot while staging/activation/rollback run concurrently;
- leases or locking preventing deletion between verification and renderer consumption;
- persistent access-time batching and crash-safe unlink/accounting behavior.

## Run the executable model

From the repository root:

```bash
npx tsc -p tests/scene-store/tsconfig.json && npx tsx --test tests/scene-store/*.test.ts
```
