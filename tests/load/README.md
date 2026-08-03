# Phase 0 semantic fleet-load test

`phase0-fleet-concurrency.test.ts` runs 128 in-process Linux Edge sessions concurrently through one-shot phase barriers:

- 64 `amd64` and 64 `arm64` simulated Edges
- hello/welcome negotiation and reconnect resume cursors
- desired-state convergence and duplicate desired delivery
- one replay-safe command execution per Edge, followed by duplicate delivery after reconnect
- Edge ACK persistence and contiguous per-stream cursors
- 16 controlled stale-revision and stream-reset paths, split evenly across architectures
- schema validation for every Core-to-Edge and Edge-to-Core message
- per-device state isolation while every device intentionally uses the same command idempotency key
- two complete runs with exact transcript, cursor, and final-state comparison

Elapsed time is emitted with `node:test` diagnostics only. There is no elapsed-time pass/fail threshold.

## Scope

This is a **semantic load/concurrency test**, not a real network or PostgreSQL capacity benchmark. It exercises deterministic in-process protocol state machines. It does not measure socket/WebSocket/TLS behavior, Fastify throughput, PostgreSQL connection or transaction capacity, cross-process scheduling, disk I/O, or production resource limits.

## Run

From the repository root with Node 20 and the existing dependencies installed:

```bash
npm run test:fleet-load
```

Optional focused type-check:

```bash
npm exec -- tsc -p tests/load/tsconfig.json --noEmit
```
