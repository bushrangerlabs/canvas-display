# Phase 0 scene staging/restore/GC model

This directory is a self-contained executable model for scene-content lifecycle invariants. It uses TypeScript, Node 20 built-ins, SHA-256 from `node:crypto`, and `node:test`. It imports no Canvas Display application code and performs no filesystem, network, PostgreSQL, or WebKit I/O.

## Modeled guarantees

- Manifest authentication is an explicit upstream trust input; `authenticated: false` is rejected before metadata is created.
- Every supplied object is checked against the manifest's actual byte length and SHA-256 digest.
- Aggregate logical bytes across live staging/ready revisions are bounded; shared digests count once.
- Readiness is all-or-nothing, and activation requires a successful process-local renderer preload over a fully revalidated bundle.
- Activation updates the current and previous known-good pointers in one copy-on-write metadata transaction.
- Crash injection covers immediately before and after that activation commit. A new runtime loses renderer state/preload tokens but retains the injected metadata and object stores.
- Objects are content-addressed and deduplicated. LRU GC can remove only objects unreachable from every live stage and the current/previous pointers.
- Restore recomputes size and SHA-256 from actual bytes. It restores current when valid, atomically falls back to valid previous, or activates nothing when both fail.

## Boundary of this model

`InMemorySceneDatabase` is only a copy-on-write stand-in for an atomic PostgreSQL transaction. `InMemoryContentAddressedObjectStore` is only a byte map, not a filesystem durability model. A `RendererPreloader` callback is only a deterministic stand-in for WebKit preload and visible-view swapping.

Therefore these tests do **not** prove SQL isolation/locking, temp-file and rename discipline, `fsync`/power-loss durability, multi-process races, authenticated transport/signature verification, WebKit process crashes, or a genuinely atomic DB/filesystem/renderer handoff. Those remain integration gates; see `docs/PHASE_0_SCENE_STAGING_SPEC.md`.

## Run

From the repository root:

```bash
npx tsc -p tests/scene-store/tsconfig.json && npx tsx --test tests/scene-store/*.test.ts
```
