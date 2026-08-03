# Phase 0 durability and crash-window fault model

This directory is a self-contained, deterministic model of the Phase 0 Core-to-Edge durability rules. It imports no application code and performs no filesystem, network, clock, randomness, or database I/O. Runtime code uses TypeScript and Node 20 built-ins; tests use `node:test` and `node:assert/strict`.

## What is modeled

- **Coalescing before sequencing:** replaceable state/telemetry intents may be replaced only before a stream sequence is assigned. Assigned records remain immutable and contiguous.
- **Durable Core-to-Edge inbox:** message insertion, resulting state/command bookkeeping, and the contiguous receive cursor commit atomically before an ACK can be emitted. ACK loss causes safe replay from the durable inbox.
- **Command receipts:** `received → accepted → running → completed`, plus terminal `unknown_outcome` recovery for uncertain non-repeatable work. A stored terminal receipt is replayed without executing the command again.
- **External crash window:** `ExternalEffectProbe` represents an effect outside the Edge transaction. Injected crashes cover the durable marker before the effect, the window after the effect but before result commit, and the window after result/outbox commit but before publication.
- **Edge outbox retention:** sequenced events survive process restart and remain until an ACK cursor commits. ACKs from the wrong stream epoch cannot prune records.
- **Priority pressure:** low-priority telemetry is rejected before sequencing when possible. Already-sequenced telemetry is converted to a same-sequence tombstone before command/security results are denied, preserving stream continuity. Once only protected records remain, admission fails visibly as `storage_degraded`; protected records are never silently shed.
- **Restore fencing:** a restore/reset atomically rotates the Core stream and authority epochs, resets the inbound cursor, and requires a fresh desired snapshot. Messages from either stale epoch are rejected without cursor or ACK movement.

## Crash semantics

`EdgeDurableStore.commit` is a copy-on-write atomic transaction. Constructing a new `EdgeRuntime` over the same store simulates process restart: process-local emissions disappear, while committed inbox rows, cursors, command receipts, and outbox rows remain. `ExternalEffectProbe` is deliberately separate from that transaction so the model exposes the unavoidable post-effect/pre-result uncertainty window.

For `non_repeatable` commands, a durable `running` receipt means execution may have begun. Recovery therefore records `unknown_outcome` and never retries, even when the injected crash happened immediately before the probe call; persisted state cannot distinguish that point from a crash immediately after the effect. For replay-safe commands, duplicate delivery or replay of a committed terminal receipt returns the stored result without another execution. The broader execution-class rule still permits genuinely replay-safe work to rerun when a crash leaves only a nonterminal `running` receipt.

This model proves state-machine invariants only. **Actual SQLite transactions, WAL configuration/checkpoint behavior, filesystem flush guarantees, process-kill behavior, and real power-loss recovery are mandatory Phase 1 native-Agent implementation/exit gates** on supported Linux `amd64` and Raspberry Pi `arm64` hardware; they are not misrepresented as Phase 0 in-memory guarantees.

## Run

From the repository root:

```bash
npm run test:fault-model
```
